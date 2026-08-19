import type { ServerResponse } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  type Account,
  type AccountStatus,
  type CatalogItem,
  type CatalogKind,
  type Company,
  type CompanySettings,
  type CompanyStatus,
  type Credential,
  type Db,
  type Group,
  type Invoice,
  type Machine,
  type PayStatus,
  type ModelRole,
  type OrderKind,
  type Plan,
  type PlanOrder,
  type PlanSku,
  type PlanPeriod,
  PLAN_PERIODS,
  type PlatformSettings,
  type ReleaseKind,
  type Role,
  type Scope,
  type SeatRuntime,
  type SessionIndex,
  type Topup,
  PRICE_MULTIPLIER_MAX,
  PRICE_MULTIPLIER_MIN,
  parsePriceMultiplier,
  releaseArch,
  sessionPageLimit,
} from './db.ts'
import {
  type MachineLoad,
  botBaseOf,
  companyMachineOf,
  deploySeat,
  desktopUrlOf,
  listSeatRuntime,
  machineLoadOf,
  machineLoads,
  machinePaired,
  managerHealth,
  MIN_MANAGER_PROTOCOL,
  managerRemoveSeat,
  normalizeTimezone,
  ownerMachine,
  publicMachine,
  publicSeatRuntime,
  sanitizeError,
  seatIdOf,
} from './deploy.ts'
import {
  openRelease,
  parseBotVersion,
  publicBotRelease,
  registerRemoteRelease,
  storeUploadedRelease,
} from './releases.ts'
import {
  hashPassword,
  INVITE_TTL,
  jwks,
  MIN_PASSWORD,
  signDesktopTicket,
  randomInviteToken,
  RESET_LINK_TTL,
  sha256Hex,
  signJwt,
  timingSafeToken,
  verifyJwt,
  verifyPassword,
  type JwtKeys,
  type JwtPayload,
} from './crypto.ts'
import { installScript } from './install.ts'
import { HttpError, bearer, json, type Req, type Router } from './http.ts'
import { createLlm } from './llm.ts'
import { CUSTOM_APIS, DefError, parseProviderDef, type CustomProviderDef } from './providers.ts'
import { attachV1 } from './v1.ts'

const JWT_TTL = Number(process.env.GATEWAY_JWT_TTL_SECONDS ?? 7 * 24 * 3600)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SLUG_RE = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/
const PHONE_RE = /^\+\d{1,4}[\s-]?[\d\s()-]{4,24}$/
const KIND: Record<string, CatalogKind> = { models: 'model', skills: 'skill', mcp: 'mcp', bots: 'bot' }
const LOGIN_DUMMY_HASH = hashPassword('satuwork-login-dummy')

function bodyOf(req: Req): Record<string, unknown> {
  if (req.body == null) return {}
  if (typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, '请求体必须是对象')
  return req.body as Record<string, unknown>
}

function deployOptsOf(req: Req): { botId: string; version?: string; update?: boolean; force?: boolean } {
  const body = bodyOf(req)
  const botId = strField(body, 'botId')
  const version = strField(body, 'version', false)
  // force 和 update 是两件事：update 是「换到最新版本」，force 是「版本不变也重铺一遍」。
  // 「重新部署」要的是后者——它想修的正是那些版本对、状态也 ready，但机器上就是不对的情况。
  return { botId, version: version || undefined, update: body.update === true, force: body.force === true }
}

function strField(body: Record<string, unknown>, key: string, required = true): string {
  const v = body[key]
  if (v == null || v === '') {
    if (required) throw new HttpError(400, `${key} 不能为空`)
    return ''
  }
  if (typeof v !== 'string') throw new HttpError(400, `${key} 必须是字符串`)
  return v.trim()
}

function intField(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key]
  if (v == null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new HttpError(400, `${key} 必须是数字`)
  return Math.trunc(n)
}

function seatsOf(v: unknown, fallback?: number): number {
  if (v == null) {
    if (fallback == null) throw new HttpError(400, 'seats 不能为空')
    return fallback
  }
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'seats 必须是正整数')
  return n
}

/**
 * 金额按「美元」进出接口，按「厘」（千分之一美元）存。0 是合法的（内部套餐、试用）。
 * 厘以下没有意义，直接拒掉——静默四舍五入会让人以为存进去了。
 */
function amountMilsOf(v: unknown, fallback?: number): number {
  if (v == null || v === '') {
    if (fallback == null) throw new HttpError(400, 'amount 不能为空')
    return fallback
  }
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, 'amount 必须是不小于 0 的数')
  // 先放大再取整：0.1*1000 在浮点里是 100.00000000000001，round 一下才干净。
  const mils = Math.round(n * 1000)
  if (Math.abs(n * 1000 - mils) > 1e-6) throw new HttpError(400, 'amount 最多到厘（小数点后 3 位）')
  if (!Number.isSafeInteger(mils)) throw new HttpError(400, 'amount 太大')
  return mils
}

/** 赠送额度。跟金额同一套：按美元进出，按厘存。 */
function bonusMilsOf(v: unknown, fallback?: number): number {
  if (v == null || v === '') return fallback ?? 0
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, '赠送额度必须是不小于 0 的数')
  const mils = Math.round(n * 1000)
  if (Math.abs(n * 1000 - mils) > 1e-6) throw new HttpError(400, '赠送额度最多到厘（小数点后 3 位）')
  if (!Number.isSafeInteger(mils)) throw new HttpError(400, '赠送额度太大')
  return mils
}

/** 周期只认三个枚举值。默认月包——不传就是月包，是产品定的默认。 */
function periodOf(v: unknown, fallback: PlanPeriod = 'month'): PlanPeriod {
  if (v == null || v === '') return fallback
  const s = String(v)
  if (!(PLAN_PERIODS as string[]).includes(s)) throw new HttpError(400, 'period 只能是 month、quarter 或 year')
  return s as PlanPeriod
}

/**
 * 按周期算到期时间。用 UTC 的年月加法，不是加固定天数——
 * 「一个月」在 1 月和 2 月不一样长，加 30 天会让续费日期慢慢漂走。
 */
function endOfPeriod(startAt: number, period: PlanPeriod): number {
  const d = new Date(startAt)
  const months = period === 'year' ? 12 : period === 'quarter' ? 3 : 1
  const day = d.getUTCDate()
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, day, d.getUTCHours(), d.getUTCMinutes()))
  // 1/31 + 1 个月没有 2/31，JS 会翻到 3/3；退回当月最后一天更符合直觉。
  if (end.getUTCDate() !== day) end.setUTCDate(0)
  return end.getTime()
}

/** 日期按 unix 毫秒收。前端传的是 YYYY-MM-DD，转成当天 UTC 零点。 */
function dateMsOf(v: unknown, fallback?: number): number {
  if (v == null || v === '') {
    if (fallback == null) throw new HttpError(400, 'startAt 不能为空')
    return fallback
  }
  if (typeof v === 'number') return v
  const s = String(v)
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const n = Number(s)
  if (Number.isFinite(n) && n > 0) return n
  throw new HttpError(400, '日期格式不对，用 YYYY-MM-DD')
}

/** 账单那几列是现成的字符串。金额从整数「厘」格式化，不让 /1000 的浮点误差跑出去。 */
function usd(mils: number): string {
  const a = Math.round(Math.abs(mils))
  const frac = a % 1000
  const dec = frac % 10 === 0 ? String(frac / 10).padStart(2, '0') : String(frac).padStart(3, '0')
  return `${mils < 0 ? '-' : ''}$${Math.floor(a / 1000).toLocaleString('en-US')}.${dec}`
}

function payStatusOf(v: unknown, fallback: PayStatus = 'unpaid'): PayStatus {
  if (v == null || v === '') return fallback
  if (v !== 'paid' && v !== 'unpaid') throw new HttpError(400, '付款状态只能是 paid 或 unpaid')
  return v
}

/**
 * 公司的两笔额度，分开算，永远不合并成一个数：
 *
 * - **套餐赠送**：来自当前生效（已付款且在期内）的那条订单，有效期跟着套餐走。
 *   套餐一到期就没有生效订单了，这个数当场归零——没用完也不结转。
 * - **单独充值**：`topups` 累加，不过期，用完为止。
 *
 * 消耗还没接：`llm_calls` 只记 token，不记钱，所以这里报的是「发下去多少」。
 * 等按量扣费落地，两个数各自减去自己承担的那部分即可，形状不用变。
 */
async function balanceOf(db: Db, companyId: string) {
  const active = await db.activePaidOrder(companyId)
  return {
    // 套餐赠送：跟着套餐有效期，到期清零。
    planBonusMils: active?.bonusMils ?? 0,
    planBonusExpiresAt: active?.endAt ?? null,
    // 充值：不过期。
    topupMils: await db.topupTotal(companyId),
  }
}

function publicTopup(v: Topup, company?: Company, by?: Account) {
  return {
    id: v.id,
    companyId: v.companyId,
    company: company ? { id: company.id, name: company.name, slug: company.slug } : null,
    amount: v.amountMils / 1000,
    amountMils: v.amountMils,
    note: v.note,
    createdBy: v.createdBy,
    createdByName: by ? by.name || by.email : null,
    createdAt: v.createdAt,
  }
}

function orderKindOf(v: unknown, fallback: OrderKind = 'plan'): OrderKind {
  if (v == null || v === '') return fallback
  if (v !== 'plan' && v !== 'topup') throw new HttpError(400, '订单类型只能是 plan 或 topup')
  return v
}

/**
 * 充值单 → 充值记录。**只有付了款才开记录**，余额也只认记录：
 * 未付款的充值单退回来什么都没有；已付款再改回未付款，记录撤掉，余额跟着掉回去。
 */
async function syncTopupOfOrder(db: Db, order: PlanOrder, actorId: string): Promise<Topup | undefined> {
  const cur = await db.topupByOrder(order.id)
  if (order.payStatus !== 'paid') {
    if (cur) await db.deleteTopup(cur.id)
    return undefined
  }
  if (!cur) {
    return db.insertTopup({
      companyId: order.companyId,
      orderId: order.id,
      amountMils: order.amountMils,
      note: order.note,
      createdBy: actorId,
    })
  }
  return db.updateTopup(cur.id, { companyId: order.companyId, amountMils: order.amountMils, note: order.note })
}

/** 一条订单一张账单。改订单是改这张，不是再开一张。 */
async function syncInvoiceOfOrder(db: Db, order: PlanOrder): Promise<Invoice> {
  const fields = {
    companyId: order.companyId,
    orderId: order.id,
    planName: order.planName,
    planNameEn: order.planNameEn,
    amountMils: order.amountMils,
    periodStart: order.startAt,
    periodEnd: order.endAt,
    status: order.payStatus,
    paidAt: order.payStatus === 'paid' ? Date.now() : null,
  }
  const cur = await db.invoiceByOrder(order.id)
  if (!cur) return db.insertInvoice(fields)
  // 已经付过的不重盖付款时间，否则每改一次订单，付款时间就往后跳一次。
  return (await db.updateInvoice(cur.id, {
    ...fields,
    paidAt: order.payStatus === 'paid' ? (cur.paidAt ?? Date.now()) : null,
  }))!
}

function publicInvoice(v: Invoice) {
  return {
    id: v.id,
    orderId: v.orderId,
    planName: v.planName,
    planNameEn: v.planNameEn,
    amount: v.amountMils / 1000,
    amountMils: v.amountMils,
    periodStart: v.periodStart,
    periodEnd: v.periodEnd,
    status: v.status,
    paidAt: v.paidAt,
    createdAt: v.createdAt,
  }
}

function publicPlanOrder(o: PlanOrder, company?: Company) {
  return {
    id: o.id,
    companyId: o.companyId,
    company: company ? { id: company.id, name: company.name, slug: company.slug } : null,
    kind: o.kind,
    note: o.note,
    planId: o.planId,
    planName: o.planName,
    planNameEn: o.planNameEn,
    period: o.period,
    seats: o.seats,
    amount: o.amountMils / 1000,
    amountMils: o.amountMils,
    bonus: o.bonusMils / 1000,
    bonusMils: o.bonusMils,
    startAt: o.startAt,
    endAt: o.endAt,
    payStatus: o.payStatus,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  }
}

function publicPlanSku(p: PlanSku) {
  return {
    id: p.id,
    name: p.name,
    nameEn: p.nameEn,
    // 两个都给：amount 是美元、给人看，amountMils 是权威值（整数厘），
    // 前端拿它来格式化，不用自己跟浮点数较劲。
    amount: p.amountMils / 1000,
    amountMils: p.amountMils,
    seats: p.seats,
    period: p.period,
    bonus: p.bonusMils / 1000,
    bonusMils: p.bonusMils,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  }
}

function emailOf(raw: string): string {
  const email = raw.trim().toLowerCase()
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'email 格式不对')
  return email
}

function slugOf(raw: string): string {
  const slug = raw.trim().toLowerCase()
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'slug 只能是小写字母开头的短名（字母数字和连字符）')
  return slug
}

function companyStatusOf(v: unknown): CompanyStatus {
  if (v !== 'active' && v !== 'disabled') throw new HttpError(400, 'status 只能是 active 或 disabled')
  return v
}

/**
 * 到期时间。收 `YYYY-MM-DD`（当天 23:59:59 到期，按本地时区）或毫秒时间戳；
 * null / 空串 = 不限期。
 */
function expiresAtOf(v: unknown): number | null {
  if (v == null || v === '') return null
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) throw new HttpError(400, '到期时间不对')
    return Math.floor(v)
  }
  if (typeof v !== 'string') throw new HttpError(400, '到期时间不对')
  const day = v.trim()
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? new Date(`${day}T23:59:59.999`).getTime() : new Date(day).getTime()
  if (!Number.isFinite(ms)) throw new HttpError(400, '到期时间不对')
  return ms
}

/**
 * 号码要带国家区号：`+` 加 1~4 位区号，后面是本地号码。
 * 各国本地格式差太多，后半段只挡明显不是号码的：数字、空格、连字符、括号。
 */
function phoneOf(raw: string): string {
  const phone = raw.trim()
  if (!PHONE_RE.test(phone)) throw new HttpError(400, '电话要带国家区号，例如 +86 13800000000')
  return phone
}

/** 公司官网。可以不写 scheme，补成 https；别的协议不收。 */
function websiteOf(raw: string): string {
  const text = raw.trim()
  if (!text) return ''
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  let u: URL
  try {
    u = new URL(hasScheme ? text : `https://${text}`)
  } catch {
    throw new HttpError(400, '网站必须是 http/https 地址')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, '网站必须是 http/https 地址')
  return u.toString().replace(/\/$/, '')
}

function roleOf(v: unknown, fallback: Role = 'member'): Role {
  if (v == null || v === '') return fallback
  if (v !== 'admin' && v !== 'member') throw new HttpError(400, 'role 只能是 admin 或 member')
  return v
}

function modelRoleOf(v: unknown, label: string): ModelRole {
  if (v == null) return { provider: '', model: '' }
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `${label} 必须是对象`)
  const o = v as Record<string, unknown>
  const provider = o.provider == null || o.provider === '' ? '' : strField(o, 'provider')
  const model = o.model == null || o.model === '' ? '' : strField(o, 'model')
  if (Boolean(provider) !== Boolean(model)) throw new HttpError(400, `${label} 需要同时有 provider 和 model`)
  return { provider, model }
}

function publicSettings(s: CompanySettings | PlatformSettings): PlatformSettings {
  return {
    daily: { provider: s.daily.provider, model: s.daily.model },
    utility: { provider: s.utility.provider, model: s.utility.model },
    enabledModels: Array.isArray((s as PlatformSettings).enabledModels) ? (s as PlatformSettings).enabledModels : [],
    priceMultiplier: parsePriceMultiplier((s as PlatformSettings).priceMultiplier),
    managerVersion: (s as PlatformSettings).managerVersion ?? '',
  }
}

function publicPlatformCred(c: { provider: string; createdAt: number; updatedAt: number }) {
  return { configured: true as const, provider: c.provider, createdAt: c.createdAt, updatedAt: c.updatedAt }
}

/**
 * 公司当前的订阅。套餐名跟着 SKU 走（SKU 改名这里就改名），所以每次现查，不落一份副本。
 * 套餐被删了就当没订：skuId 留着，名字给 null，界面显示「—」。
 */
async function publicPlan(db: Db, plan: Plan | undefined, used: number) {
  const sku = plan?.skuId ? await db.planSku(plan.skuId) : undefined
  // 账期按生效的那张订单来：订单上的周期可以跟价目表不一样（改过价、改过周期的单子），
  // 卖出去的那张才算数。
  const active = plan ? await db.activePaidOrder(plan.companyId) : undefined
  return {
    seats: plan?.seats ?? 0,
    used,
    skuId: plan?.skuId ?? null,
    skuName: sku?.name ?? null,
    skuNameEn: sku?.nameEn ?? null,
    period: active?.period ?? sku?.period ?? null,
    expiresAt: plan?.expiresAt ?? null,
    updatedAt: plan?.updatedAt ?? 0,
  }
}

async function orgSummary(db: Db, c: Company) {
  const plan = await db.plan(c.id)
  const used = await db.accountCount(c.id)
  return {
    ...publicCompany(c),
    seats: plan?.seats ?? 0,
    used,
    plan: await publicPlan(db, plan, used),
  }
}

function enabledModelsOf(v: unknown): string[] {
  if (v == null) return []
  if (!Array.isArray(v)) throw new HttpError(400, 'enabledModels 必须是数组')
  return v.map((x) => {
    if (typeof x !== 'string' || !x.trim()) throw new HttpError(400, 'enabledModels 必须是模型 id 字符串')
    return x.trim()
  })
}

/** 倍率写坏了要当场报错，不能悄悄回落成 1——那等于把管理员改的价吞了。 */
function priceMultiplierOf(v: unknown, fallback: number): number {
  if (v == null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new HttpError(400, 'priceMultiplier 必须是数字')
  if (n < PRICE_MULTIPLIER_MIN || n > PRICE_MULTIPLIER_MAX) {
    throw new HttpError(400, `priceMultiplier 只能在 ${PRICE_MULTIPLIER_MIN} 到 ${PRICE_MULTIPLIER_MAX} 之间`)
  }
  return n
}

function publicAccount(a: Account) {
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    title: a.title,
    phone: a.phone,
    theme: a.theme,
    locale: a.locale,
    role: a.role,
    status: a.status,
    companyId: a.companyId,
    createdAt: a.createdAt,
    lastSeenAt: a.lastSeenAt,
    passwordChangedAt: a.passwordChangedAt,
  }
}

/** 对外不带 companyId，形状跟 Bot 一致。 */
function publicGroup(g: Group) {
  return {
    id: g.id,
    name: g.name,
    desc: g.desc,
    icon: g.icon,
    role: g.role,
    members: g.members,
    agents: g.agents,
    createdAt: g.createdAt,
    builtin: false as const,
  }
}

function stringIds(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
}

function groupRoleOf(v: unknown): 'admin' | 'member' {
  return v === 'admin' ? 'admin' : 'member'
}

async function membersInCompany(db: Db, companyId: string, v: unknown): Promise<string[]> {
  const allowed = new Set((await db.accountsOf(companyId)).map((a) => a.id))
  return stringIds(v).filter((id) => allowed.has(id))
}

function publicCompany(c: Company) {
  return {
    id: c.id,
    slug: c.slug,
    name: c.name,
    status: c.status,
    contactName: c.contactName,
    contactPhone: c.contactPhone,
    contactEmail: c.contactEmail,
    address: c.address,
    website: c.website,
    machineId: c.machineId,
    accessUrl: c.accessUrl,
    createdAt: c.createdAt,
  }
}

/**
 * 一行会话索引对外的样子。
 *
 * `names` 是可选的预取表：列表接口一次性把本公司的账号和 Bot 拉齐再传进来，省掉每行
 * 两次查库——一页 200 行就是 400 次往返。单条详情接口不传，照旧现查。
 */
/**
 * 会话列表的翻页游标：`updatedAt:sessionId`。
 *
 * 排序键是 ("updatedAt" desc, "sessionId" desc)，游标就得是同一对值——只带 updatedAt
 * 的话，同一毫秒上报的两条会话在翻页边界上要么漏要么重。
 */
function sessionCursorOf(raw: string | null): { updatedAt: number; sessionId: string } | undefined {
  const text = (raw || '').trim()
  if (!text) return undefined
  const i = text.indexOf(':')
  const updatedAt = Number(text.slice(0, i))
  const sessionId = i < 0 ? '' : text.slice(i + 1)
  if (i < 0 || !Number.isFinite(updatedAt) || !sessionId) throw new HttpError(400, 'cursor 不合法')
  return { updatedAt, sessionId }
}

async function publicSessionIndex(
  db: Db,
  row: SessionIndex,
  names?: { accounts: Map<string, Account>; bots: Map<string, CatalogItem> },
) {
  const account = names ? names.accounts.get(row.accountId) : await db.account(row.accountId)
  const bot = row.botId ? (names ? names.bots.get(row.botId) : await db.catalog(row.botId)) : undefined
  return {
    sessionId: row.sessionId,
    accountId: row.accountId,
    accountName: account?.name || account?.email || row.accountId,
    botId: row.botId,
    botName: bot && bot.kind === 'bot' ? bot.name : null,
    origin: row.origin,
    remoteId: row.remoteId,
    messageCount: row.messageCount,
    title: row.title,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    machineId: row.machineId,
  }
}

function machineBase(host: string): string {
  const h = host.trim().replace(/\/$/, '')
  return /^https?:\/\//i.test(h) ? h : `http://${h}`
}

const PULL_ERROR = '机器不在线，全文拉不下来'

async function pullSessionEvents(
  host: string,
  sessionId: string,
  tokens: { seat: string; machine: string },
): Promise<{ ok: true; events: unknown[] } | { ok: false }> {
  const url = `${machineBase(host)}/internal/sessions/${encodeURIComponent(sessionId)}`
  // 两个头，**两把不同的票**：bot 认 authorization 上的席位票（sat_），管家认
  // x-satuwork-machine 上的机器票（smt_）。以前两个头塞的是同一把机器票，代价是 bot
  // 必须把 smt_ 存在自己的环境里——而那个环境是席位用户读得到的。
  const headers: Record<string, string> = {}
  if (tokens.seat) headers.authorization = `Bearer ${tokens.seat}`
  if (tokens.machine) headers['x-satuwork-machine'] = tokens.machine
  try {
    const r = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) return { ok: false }
    const body = (await r.json()) as { events?: unknown }
    if (!body || !Array.isArray(body.events)) return { ok: false }
    return { ok: true, events: body.events }
  } catch {
    return { ok: false }
  }
}


const INSTANCE_DOWN = '实例还没上线'

/**
 * 机器地址。`example.com:3080` 或 `http(s)://example.com:3080` 都收，别的都不收——
 * 这个值会被 Gateway 自己带着机器凭证去 fetch，路径、用户名口令、别的协议一律挡掉。
 */
function machineHostOf(raw: string): string {
  const text = raw.trim().replace(/\/$/, '')
  if (!text) return ''
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
  let u: URL
  try {
    u = new URL(hasScheme ? text : `http://${text}`)
  } catch {
    throw new HttpError(400, 'host 必须是 http/https 地址')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'host 必须是 http/https 地址')
  if (u.username || u.password) throw new HttpError(400, 'host 不能带用户名或口令')
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new HttpError(400, 'host 不能带路径')
  return hasScheme ? `${u.protocol}//${u.host}` : u.host
}

/**
 * 机器管家的基址。**一定带 scheme**——它要被直接拼成 fetch 的 URL，裸 host 会在
 * 调用点各自补一次，补法迟早会不一致。
 */
function managerHostOf(raw: string): string {
  const normalized = machineHostOf(raw)
  if (!normalized) throw new HttpError(400, 'host 不能为空')
  return machineBase(normalized)
}

/** 配对码 30 分钟过期。够贴一次命令，不够别人捡去慢慢试。 */
const PAIRING_TTL = 30 * 60 * 1000

/**
 * 配对码。`SW-XXXX-XXXX`。
 *
 * 字母表要能**照着屏幕手抄不出错**——这个码的唯一用法就是人肉搬到另一台机器上。
 * 所以成对易混的一律只留一个：去掉 `O/0`、`I/1/L`，以及 `S/5`、`Z/2`、`B/8` 里的
 * 字母那一半（留数字，因为数字在等宽字体里更好认）。
 *
 * 剩 28 个字符取 8 位 ≈ 38 bit，配上 30 分钟窗口和一次性认领足够——它换到的是一台
 * 机器的控制权，不是长期凭据。
 */
function randomPairingCode(): string {
  const alphabet = 'ACDEFGHJKMNPQRTUVWXY23456789'
  const buf = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) out += alphabet[buf[i]! % alphabet.length]
  return `SW-${out.slice(0, 4)}-${out.slice(4)}`
}

/**
 * 收码时把手抄错的那几个字符纠回去。
 *
 * 生成端已经不产出 `S/Z/B/O/I/L` 了，所以看到它们必定是抄错——直接映射成对应的
 * 数字，而不是让人对着一个「配对码无效」的提示反复重来。
 *
 * **代价**：换字母表之前发出去的、含这些字母的码，从此换不回去了（会被纠成数字，
 * 和库里存的对不上）。码只活 30 分钟且一次性，所以这个代价只在改动当天存在一次；
 * 但真撞上时症状是「明明没过期却说无效」，很难猜，所以写在这儿。
 */
function normalizePairingCode(raw: string): string {
  const text = String(raw || '').trim().toUpperCase()
  // **只纠随机那一段**：前缀 `SW-` 里就有一个 S，一起替换会把每个码都毁掉。
  if (!text.startsWith('SW-')) return text
  const fixed = text
    .slice(3)
    .replace(/[SZBOIL]/g, (c) => ({ S: '5', Z: '2', B: '8', O: '0', I: '1', L: '1' })[c] ?? c)
  return 'SW-' + fixed
}

/** 安装命令里的 Gateway 地址：优先 GATEWAY_PUBLIC_URL，否则按请求的 Host 猜。 */
function gatewayBaseFor(req: Req): string {
  const explicit = (process.env.GATEWAY_PUBLIC_URL || '').trim().replace(/\/$/, '')
  if (explicit) return explicit
  const host = String(req.headers.host || '').trim() || '127.0.0.1:3080'
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http'
  return `${proto}://${host}`
}

function installCommandFor(req: Req, code: string): string {
  return `curl -fsSL ${gatewayBaseFor(req)}/install-manager.sh | sudo bash -s -- --code ${code}`
}

/**
 * 只有配对好的机器才签得出桌面票；没配对时返回 undefined，URL 里就不带 ticket。
 *
 * 口令跟着票走（见 signDesktopTicket），所以「打开桌面」点开就是桌面本身，不再是
 * 一个还要人回去抄一遍口令的登录框。
 */
function desktopTicketFor(
  keys: JwtKeys,
  machine: Machine | undefined,
  row: { seatId: string; vncPassword?: string },
): string | undefined {
  if (!machinePaired(machine)) return undefined
  return signDesktopTicket(keys, row.seatId, row.vncPassword ?? '')
}

/**
 * 管家要求的最低 Node 大版本。
 *
 * 管家包里带着 tsx 但**不带 Node**，所以自升级换不了运行时。低于这个数就不升——
 * 让它继续用旧版本活着，等人重跑安装脚本。升到起不来比不升坏得多：没有 SSH 可以救。
 */
const MIN_MANAGER_NODE = 24

/**
 * 这台机器该跑哪个管家版本。
 *
 * 优先级：单机钉的 > 平台全局钉的 > 最新发布。单机那一层是灰度用的——先让一台机器
 * 追新版本，看几天再改全局。
 */
/**
 * 钉的那一版，但**换成这台机器的架构**。
 *
 * `0.1.2+abc-x64` 和 `0.1.2+abc-arm64` 是同一次发布的两份包。钉版本的人（尤其是平台
 * 全局那一档）只能写一个字符串，写不了两个架构；照着发下去，另一半机器必然拿到错包。
 * 所以先按原样找，架构对不上就找同版本的兄弟包。
 *
 * 找不到兄弟就返回 undefined，让调用方回落——发一个已知错架构的包没有任何意义。
 */
async function managerReleaseFor(db: Db, version: string, arch: string | null) {
  const row = await db.botRelease(version, 'manager')
  const want = arch?.trim()
  if (!want) return row
  const got = row ? releaseArch(row.version) : undefined
  if (row && (!got || got === want)) return row
  const sibling = version.replace(/-(x64|arm64)$/, '') + '-' + want
  if (sibling === version) return row
  return await db.botRelease(sibling, 'manager')
}

async function desiredManagerRelease(db: Db, machine?: Machine) {
  const arch = machine?.arch ?? null
  const pinned = machine?.desiredManagerVersion?.trim()
  if (pinned) {
    const row = await managerReleaseFor(db, pinned, arch)
    if (row) return row
  }
  const settings = await db.platformSettings()
  const global = (settings as { managerVersion?: unknown }).managerVersion
  if (typeof global === 'string' && global.trim()) {
    const row = await managerReleaseFor(db, global.trim(), arch)
    if (row) return row
  }
  return db.latestBotRelease('manager', arch)
}

/**
 * 席位 → 它那台机器的管家地址。
 *
 * 多机之后**不能再用「公司那台机器」**：两个员工的席位可能落在不同机器上，用错
 * 地址的后果是 noVNC 打不开、聊天反代打到别人的机器上。带一个 Map 当本次请求的
 * 缓存，列表接口不至于逐行查库。
 */
function machineHostResolver(db: Db) {
  const cache = new Map<string, string | null>()
  return async (row: { machineId: string }): Promise<string | null> => {
    const id = row.machineId
    if (!id) return null
    if (!cache.has(id)) cache.set(id, (await db.machine(id))?.host ?? null)
    return cache.get(id) ?? null
  }
}

/** 取这家公司名下的某台机器。跨公司拿 id 一律 404，不透露它存在。 */
async function machineOfOrg(db: Db, companyId: string, machineId: string): Promise<Machine> {
  const machine = await db.machine(machineId)
  if (!machine || machine.companyId !== companyId) throw new HttpError(404, '没有这台机器')
  return machine
}

/**
 * 一台机器在界面上的一张卡片：身份 + 负载 + 版本 + 有没有可升的。
 *
 * 「已用」算的是**激活账号数**，不是席位数——一个员工的多个 bot 落在同一台机器上，
 * 只占一个账号位。两个数都给，因为运维时想知道机器上到底跑着多少个进程。
 */
async function machineCard(
  db: Db,
  load: MachineLoad,
  latest: { botLatest: string | null; managerLatest: string | null },
  /**
   * 这家公司的第几台，1 起。**给人指代用的短号**（「2 号机上不去了」），不是标识符
   * ——中间删掉一台，后面的号会往前挪。要唯一地指一台，用 `machine.id`。
   */
  no: number,
  /**
   * `seatList: false` = 不带席位清单。
   *
   * 那份清单是给日志选择器用的，每个席位要查一次账号；而调用方里有两类根本用不上
   * 它：只画汇总的列表页，以及自己会重建一份更全的详情页。默认带着（公司详情页要），
   * 不要的显式说一声——**省掉的是一整轮按席位的账号查询**，机器一多就不是小数。
   *
   * 不要时整个键都不出现，而不是给一个空数组：空数组的意思是「这台机器没有席位」，
   * 那是另一回事，会让日志选择器安静地少列几行。
   */
  opts: { seatList?: boolean } = {},
) {
  const { machine, seatRows, accounts, seats, full } = load
  const counts = new Map<string, number>()
  for (const r of seatRows) {
    if (r.status === 'none') continue
    counts.set(r.botVersion ?? '', (counts.get(r.botVersion ?? '') ?? 0) + 1)
  }
  const botVersions = [...counts.entries()]
    .map(([version, n]) => ({ version: version || null, seats: n }))
    .sort((a, b) => b.seats - a.seats)
  const desired = (await desiredManagerRelease(db, machine))?.version ?? null
  // 席位清单给平台端的日志选择器用：要看某个席位的 bot 日志，得先知道有哪些席位。
  const seatList =
    opts.seatList === false
      ? undefined
      : await Promise.all(
          seatRows
            .filter((r) => r.status !== 'none')
            .map(async (r) => ({
              seatId: r.seatId,
              botId: r.botId,
              linuxUser: r.linuxUser,
              who: (await db.account(r.accountId))?.email ?? r.accountId,
            })),
        )
  return {
    no,
    ...(seatList ? { seatList } : {}),
    machine: ownerMachine(machine),
    accounts,
    maxAccounts: machine.maxAccounts,
    seats,
    full,
    botVersions,
    botOutdated: Boolean(latest.botLatest) && botVersions.some((v) => v.version !== latest.botLatest),
    managerDesired: desired,
    managerOutdated:
      Boolean(latest.managerLatest) && Boolean(machine.managerVersion) && machine.managerVersion !== latest.managerLatest,
    managerPending: Boolean(desired) && Boolean(machine.managerVersion) && machine.managerVersion !== desired,
    // 时区和管家版本一样是「下指令 → 机器自己去改 → 下一轮心跳才知道成没成」。
    timezonePending: Boolean(machine.timezone) && machine.currentTimezone !== machine.timezone,
  }
}

/** 把「新增版本」表单的四个字段收下来。四个都必填——验证靠的就是它们。 */
async function registerFromBody(db: Db, req: Req, kind: ReleaseKind) {
  const body = bodyOf(req)
  return registerRemoteRelease(db, {
    kind,
    version: strField(body, 'version'),
    url: strField(body, 'url'),
    // 数字和字符串都收：界面走 FormData 拿到的是字符串，脚本调用直接给数字。
    // 让一个数值字段只认字符串，是给调用方挖坑。
    size: Number((body as Record<string, unknown>).size),
    sha256: strField(body, 'sha256'),
    note: strField(body, 'note', false),
  })
}

/**
 * 流式下发一个发布包。
 *
 * 字节在本机还是在别处（只登记了 url）对调用方不可见——`openRelease` 抹平了这层。
 * **不用 302 打发到远端地址**：`x-bot-sha256` 要跟着响应走，重定向之后管家就拿不到
 * 校验值了，那等于把完整性检查悄悄关掉。
 */
async function sendReleaseFile(res: ServerResponse, kind: ReleaseKind, rawVersion: string, db: Db): Promise<void> {
  const version = parseBotVersion(rawVersion)
  const row = await db.botRelease(version, kind)
  if (!row) throw new HttpError(404, '没有这个版本')
  const body = await openRelease(row)
  res.writeHead(200, {
    'content-type': 'application/gzip',
    'content-length': String(row.size),
    'x-bot-sha256': row.sha256,
    'cache-control': 'no-store',
  })
  await pipeline(body, res)
}

/**
 * 取请求的来源 IP。
 *
 * 配对时用它决定「这台机器在哪儿」，所以**不信 `x-forwarded-for`**——那个头谁都能
 * 写，信了就等于让配对方自己指定 Gateway 以后往哪儿发部署。要支持反代场景的话得
 * 另外配可信代理名单，不是在这儿放一个口子。
 */
function sourceIpOf(req: Req): string {
  const raw = req.socket.remoteAddress || ''
  // Node 在双栈 socket 上给的是 ::ffff:1.2.3.4。
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw)
  return v4 ? v4[1] : raw
}

function instanceHostOf(raw: string): string {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    throw new HttpError(400, 'host 必须是 http/https URL')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'host 必须是 http/https URL')
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) throw new HttpError(400, 'host 不能带路径')
  return `${u.protocol}//${u.host}`
}

function requireSeat(account: Account): void {
  if (account.role === 'owner' || !account.companyId) throw new HttpError(403, '没有公司席位')
}

async function instanceHostFor(account: Account, db: Db, botId: string): Promise<string> {
  requireSeat(account)
  const id = (botId || '').trim()
  if (!id) throw new HttpError(400, 'botId 不能为空')
  const row = await db.instance(account.id, id)
  const host = row?.host?.trim() || ''
  if (!host) throw new HttpError(503, INSTANCE_DOWN)
  return host.replace(/\/$/, '')
}

async function visibleBotOf(db: Db, account: Account, botId: string) {
  requireSeat(account)
  const id = (botId || '').trim()
  if (!id) throw new HttpError(400, 'botId 不能为空')
  const hit = (await db.visibleCatalog('bot', account.companyId)).find((b) => b.id === id)
  if (!hit) throw new HttpError(404, '没有这个 Bot')
  return hit
}

async function pairRuntime(db: Db, account: Account, botId: string) {
  const rt = await db.seatRuntime(account.id, botId)
  if (!rt) return null
  return listSeatRuntime(rt, (await db.machine(rt.machineId))?.host ?? null)
}

/**
 * 这个席位**所在那台机器**的票。反代要用它过管家那一关。
 *
 * 以前取的是 `companies.machineId`——首次配对写死的默认机器。而 host 一直是按席位解析
 * 的（`instances.host` 由 deploySeat 按 machineForAccount 实际调度到的那台写入）。公司
 * 只有一台机器时两者恰好相同；配了第二台之后必然错配：拿 M1 的票去敲 M2，管家 401，
 * 聊天四条接口全部永久失败——而桌面和历史仍然正常，看起来像 bot 挂了而不是路由错了。
 *
 * 没有席位记录（stub / 老数据）才回落到公司默认机器。
 */
async function machineTokenFor(db: Db, account: Account, botId: string): Promise<string | undefined> {
  if (!account.companyId) return undefined
  const rt = await db.seatRuntime(account.id, botId)
  const seatMachine = rt?.machineId ? await db.machine(rt.machineId) : undefined
  const machine = seatMachine ?? (await companyMachineOf(db, account.companyId))
  return machine?.token || undefined
}

/** 反代目标。地址和机器票**一次解析出来**，两边各查各的就没有漂移的余地了。 */
interface SeatTarget {
  host: string
  machineToken: string | undefined
}

async function seatTargetFor(db: Db, account: Account, botId: string): Promise<SeatTarget> {
  return {
    host: await instanceHostFor(account, db, botId),
    machineToken: await machineTokenFor(db, account, botId),
  }
}

/**
 * **管家自己**那一层的地址，不是 bot 的。
 *
 * `instances.host` 长这样：`http://机器:8443/seats/<seatId>/bot`——它是给反代 bot 用
 * 的完整前缀。拿它再去拼 `/seats/:id/diag`，出来的是
 * `…/seats/X/bot/seats/X/diag`，管家把它当成「转给 bot 的路径」原样递下去，bot 回
 * 404。席位诊断从上线起就是这么坏的，而 404 长得像「这台机器没这个接口」，不像
 * 「地址拼错了」。
 *
 * 管家的地址只有一个来源：机器记录的 host。
 */
async function managerTargetFor(
  db: Db,
  account: Account,
  botId: string,
): Promise<{ base: string; seatId: string; machineToken: string | undefined }> {
  requireSeat(account)
  if (!botId) throw new HttpError(400, 'botId 不能为空')
  const runtime = await db.seatRuntime(account.id, botId)
  if (!runtime) throw new HttpError(404, '还没有部署')
  const machine = await db.machine(runtime.machineId)
  if (!machine?.host) throw new HttpError(503, INSTANCE_DOWN)
  return { base: machineBase(machine.host), seatId: runtime.seatId, machineToken: machine.token || undefined }
}

async function seatTargetForSession(db: Db, account: Account, sessionId: string): Promise<SeatTarget> {
  requireSeat(account)
  const idx = await db.sessionIndex(sessionId)
  const botId = (idx?.botId || '').trim()
  if (!botId || idx!.accountId !== account.id) throw new HttpError(503, INSTANCE_DOWN)
  return await seatTargetFor(db, account, botId)
}

async function seatBearer(db: Db, accountId: string): Promise<string> {
  const secrets = await db.accountSecrets(accountId)
  // 没有回落到机器票：bot 只认席位票了，把 smt_ 递过去只会换回一个 401，
  // 并且会让人以为「票发了但没生效」，比直接空着更难查。
  return secrets?.accessToken ?? ''
}

/**
 * 两层鉴权，两个头。
 *
 * `authorization` 是给 **bot** 的席位票（`sat_`），管家原样透传不看；
 * `x-satuwork-machine` 是给 **管家** 的机器票（`smt_`），管家验完就摘掉。
 * 分开是为了让 bot 那边一行都不用改。
 */
function machineHeader(machineToken?: string): Record<string, string> {
  return machineToken ? { 'x-satuwork-machine': machineToken } : {}
}

async function proxyJson(
  res: ServerResponse,
  method: string,
  url: string,
  body?: unknown,
  token?: string,
  machineToken?: string,
) {
  // authorization 上只能是席位票。bot 不认机器票了，回落到 smt_ 只会换回 401，
  // 而且会让人以为「票带了但没生效」，比空着更难查。
  const bearerTok = token || ''
  let r: Response
  try {
    r = await fetch(url, {
      method,
      headers: {
        authorization: bearerTok ? `Bearer ${bearerTok}` : '',
        accept: 'application/json',
        ...machineHeader(machineToken),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    throw new HttpError(503, INSTANCE_DOWN)
  }
  const text = await r.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { error: text.slice(0, 200) || INSTANCE_DOWN }
  }
  send(res, r.status, parsed)
}

/**
 * 把浏览器传上来的字节**边收边转**给席位，不在 Gateway 落地。
 *
 * 附件动辄几十 MB，`readBody` 那条路会先攒进内存再解析成 JSON——对文件来说两件事
 * 都是错的。所以路由用 `postRaw`，这里直接把 `req` 接到 fetch 的 body 上。
 *
 * `duplex: 'half'` 是流式 body 的硬性要求，不带这个参数 undici 直接拒绝发出。
 */
async function proxyUpload(
  req: Req,
  res: ServerResponse,
  url: string,
  headers: Record<string, string>,
  token?: string,
  machineToken?: string,
) {
  let r: Response
  try {
    r = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: token ? `Bearer ${token}` : '',
        accept: 'application/json',
        'content-type': 'application/octet-stream',
        ...headers,
        ...machineHeader(machineToken),
      },
      body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
      duplex: 'half',
      // 传大文件比一次 JSON 往返慢得多，15 秒那个超时会在半路砍断它。
      signal: AbortSignal.timeout(10 * 60 * 1000),
    } as RequestInit & { duplex: 'half' })
  } catch {
    throw new HttpError(503, INSTANCE_DOWN)
  }
  const text = await r.text()
  let parsed: unknown
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = { error: text.slice(0, 200) || INSTANCE_DOWN }
  }
  send(res, r.status, parsed)
}

/**
 * 把席位上的文件字节转给浏览器。预览和下载都走这条。
 *
 * **安全头在这里加，不在 bot 那边**：面向浏览器的是这一跳，源也是这一跳的源。
 * bot 那边同样设了一份，但那是防御纵深，真正生效的是这里。
 *
 * `content-type` 与 `content-disposition` 原样透传——它们由 bot 的白名单算出来
 * （见 workspace/index.ts 的 INLINE），Gateway 不该二次猜测，猜了反而会和白名单打架。
 */
async function proxyDownload(req: Req, res: ServerResponse, url: string, token?: string, machineToken?: string) {
  const ac = new AbortController()
  const onClose = () => ac.abort()
  req.on('close', onClose)
  let r: Response
  try {
    r = await fetch(url, {
      headers: {
        authorization: token ? `Bearer ${token}` : '',
        ...machineHeader(machineToken),
      },
      signal: ac.signal,
    })
  } catch {
    req.off('close', onClose)
    if (ac.signal.aborted) return
    throw new HttpError(503, INSTANCE_DOWN)
  }
  if (!r.ok || !r.body) {
    req.off('close', onClose)
    const text = await r.text().catch(() => '')
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : { error: INSTANCE_DOWN }
    } catch {
      parsed = { error: INSTANCE_DOWN }
    }
    send(res, r.status === 400 || r.status === 404 ? r.status : 503, parsed)
    return
  }
  const type = r.headers.get('content-type') || 'application/octet-stream'
  const disposition = r.headers.get('content-disposition') || 'attachment'
  const length = r.headers.get('content-length')
  res.writeHead(200, {
    'content-type': type,
    'content-disposition': disposition,
    ...(length ? { 'content-length': length } : {}),
    // 声明的类型就是最终类型：允许嗅探，一个改名成 .png 的 HTML 就能变回 HTML。
    'x-content-type-options': 'nosniff',
    /**
     * 这段字节是**用户上传的**，而它此刻挂在 Gateway 的源上。没有这条，一个 SVG 或
     * HTML 附件里的 `<script>` 就在登录态里跑起来了。
     *
     * `sandbox` 不带任何 allow-*：脚本、表单、同源存储、导航全关，图片和 PDF 照常
     * 显示。扩展名白名单已经挡掉了 SVG/HTML 的内联（它们只会 attachment），这条是
     * 第二道——白名单哪天加错一项，不至于当场变成 XSS。
     */
    'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; object-src 'self'",
    'cache-control': 'private, no-store',
  })
  try {
    await pipeline(Readable.fromWeb(r.body as any), res)
  } catch {
    // 浏览器中途关掉预览是常事，不是故障。
  } finally {
    req.off('close', onClose)
  }
}

async function proxySse(req: Req, res: ServerResponse, url: string, token?: string, machineToken?: string) {
  // authorization 上只能是席位票。bot 不认机器票了，回落到 smt_ 只会换回 401，
  // 而且会让人以为「票带了但没生效」，比空着更难查。
  const bearerTok = token || ''
  const ac = new AbortController()
  const onClose = () => ac.abort()
  req.on('close', onClose)
  let r: Response
  try {
    r = await fetch(url, {
      headers: {
        authorization: bearerTok ? `Bearer ${bearerTok}` : '',
        accept: 'text/event-stream',
        ...machineHeader(machineToken),
      },
      signal: ac.signal,
    })
  } catch {
    req.off('close', onClose)
    if (ac.signal.aborted) return
    throw new HttpError(503, INSTANCE_DOWN)
  }
  if (!r.ok || !r.body) {
    req.off('close', onClose)
    const text = await r.text().catch(() => '')
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : { error: INSTANCE_DOWN }
    } catch {
      parsed = { error: INSTANCE_DOWN }
    }
    send(res, r.status === 401 || r.status === 403 || r.status === 404 ? r.status : 503, parsed)
    return
  }
  res.writeHead(r.status, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  const reader = r.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!res.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => res.once('drain', resolve))
      }
    }
  } catch {
    /* 客户端断开或上游中断 */
  } finally {
    req.off('close', onClose)
    try {
      res.end()
    } catch {}
  }
}

function publicCatalog(item: { id: string; kind: string; scope: string; companyId: string | null; name: string; definition: unknown; createdAt: number; updatedAt: number }) {
  let definition = item.definition
  // 管理目录不能带 MCP token。实例走 /runtime/catalog。
  if (item.kind === 'mcp' && definition && typeof definition === 'object' && !Array.isArray(definition)) {
    const { token: _token, env, ...rest } = definition as Record<string, unknown>
    const keys = env && typeof env === 'object' && !Array.isArray(env) ? Object.keys(env as Record<string, unknown>) : []
    definition = {
      ...rest,
      ...(keys.length ? { env: Object.fromEntries(keys.map((k) => [k, ''])), hasEnv: true } : { hasEnv: false }),
    }
  }
  return {
    id: item.id,
    kind: item.kind,
    scope: item.scope,
    companyId: item.companyId,
    name: item.name,
    definition,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

/**
 * Bot 头像。两个层级各八个，**两套不重合**——凭头像就能看出这是全局的还是公司自己的。
 *
 * 光靠界面上色是不够的：那样公司随手把头像改成全局那一款，列表里就分不出来了。
 * 所以哪一套能用是跟 scope 绑死的，服务端校验，前端只是照着画。
 */
const COMPANY_BOT_ICONS = ['c-bot', 'c-chat', 'c-chart', 'c-pen', 'c-deal', 'c-code', 'c-flow', 'c-book'] as const
const GLOBAL_BOT_ICONS = ['g-core', 'g-relay', 'g-shield', 'g-globe', 'g-spark', 'g-grid', 'g-beacon', 'g-vault'] as const

const COMPANY_ICON_SET: ReadonlySet<string> = new Set(COMPANY_BOT_ICONS)
const GLOBAL_ICON_SET: ReadonlySet<string> = new Set(GLOBAL_BOT_ICONS)

/** 改版前存下来的那六个键。老 Bot 打开时按这张表落到新的一套上，不让它们变成默认头像。 */
const LEGACY_BOT_ICONS: Record<string, string> = {
  bot: 'c-bot',
  chat: 'c-chat',
  chart: 'c-chart',
  pen: 'c-pen',
  deal: 'c-deal',
  code: 'c-code',
}

function iconSetFor(scope: Scope): ReadonlySet<string> {
  return scope === 'global' ? GLOBAL_ICON_SET : COMPANY_ICON_SET
}

function defaultIconFor(scope: Scope): string {
  return scope === 'global' ? 'g-core' : 'c-bot'
}
const DEFAULT_BOT_PROMPT =
  '你是 Satuwork 的 AI 员工。用简洁、专业的中文回答。需要当前时间、查看或修改文件、执行命令时调用工具，不要凭猜测。'
const DEFAULT_BOT_PROVIDER = 'deepseek'
const DEFAULT_BOT_MODEL = 'deepseek-v4-flash'

function botDefOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) }
  return {}
}

/**
 * 归一化头像键。不认识的、或者不属于这个层级的，一律落到该层级的默认头像——
 * 宁可显示成默认，也不能让公司 Bot 顶着全局那套图标。
 */
function botIconOf(v: unknown, scope: Scope = 'company'): string {
  const raw = typeof v === 'string' ? v.trim() : ''
  const key = LEGACY_BOT_ICONS[raw] ?? raw
  return iconSetFor(scope).has(key) ? key : defaultIconFor(scope)
}

function botNameOf(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : ''
  if (!name) throw new HttpError(400, '助理要有名字')
  return name
}

/**
 * 行为边界。服务端只存开关，标题和说明留在前端——那两行是要跟着界面语言走的文案，
 * 存进库里就等于把中文钉死在数据上，改一次文案还得迁一次数据。
 */
const BOT_GUARD_IDS = ['high-risk', 'pii', 'no-external'] as const
const DEFAULT_BOT_GUARDS: Record<string, boolean> = { 'high-risk': true, pii: true, 'no-external': true }

/**
 * 记忆设置。scope / kinds / ttl 存的就是这几个中文原串——它们同时是界面上的选项值，
 * 前端只翻显示的那一份（见 app.js 里 MEMORY_* 那几个常量），两边对的是同一套键。
 */
const MEMORY_SCOPES = ['仅本人', '所属分组', '全公司']
const MEMORY_KINDS = ['偏好', '事实', '流程', '联系人']
const MEMORY_TTLS = ['30 天', '90 天', '180 天', '永久保留']

interface BotMemory {
  on: boolean
  scope: string
  kinds: string[]
  ttl: string
  cap: number
  confirm: boolean
  pii: boolean
}

const DEFAULT_BOT_MEMORY: BotMemory = {
  on: true,
  scope: '所属分组',
  kinds: ['偏好', '事实'],
  ttl: '90 天',
  cap: 20,
  confirm: true,
  pii: true,
}

function objOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** 只认识这三个开关，其余键丢掉；没传的沿用 base，所以改一个不会把另外两个带回默认。 */
function botGuardsOf(v: unknown, base: Record<string, boolean> = DEFAULT_BOT_GUARDS): Record<string, boolean> {
  const raw = objOf(v)
  const out: Record<string, boolean> = {}
  for (const id of BOT_GUARD_IDS) out[id] = typeof raw[id] === 'boolean' ? (raw[id] as boolean) : base[id] !== false
  return out
}

/** 不认识的选项一律退回 base，不报错——界面上那几个下拉本来就只给得出合法值。 */
function botMemoryOf(v: unknown, base: BotMemory = DEFAULT_BOT_MEMORY): BotMemory {
  const raw = objOf(v)
  const pick = (val: unknown, allowed: string[], fallback: string) => {
    const s = typeof val === 'string' ? val.trim() : ''
    return allowed.includes(s) ? s : fallback
  }
  const cap = Number(raw.cap)
  return {
    on: typeof raw.on === 'boolean' ? raw.on : base.on,
    scope: pick(raw.scope, MEMORY_SCOPES, base.scope),
    kinds: Array.isArray(raw.kinds)
      ? [...new Set(raw.kinds.filter((k): k is string => typeof k === 'string' && MEMORY_KINDS.includes(k)))]
      : base.kinds.slice(),
    ttl: pick(raw.ttl, MEMORY_TTLS, base.ttl),
    // 界面上是 5–50、步进 5 的滑杆，服务端按同一套收口。
    cap: Number.isFinite(cap) ? Math.min(50, Math.max(5, Math.round(cap / 5) * 5)) : base.cap,
    confirm: typeof raw.confirm === 'boolean' ? raw.confirm : base.confirm,
    pii: typeof raw.pii === 'boolean' ? raw.pii : base.pii,
  }
}

/** 平台指定的那一对：日常，没有再退到 utility，再没有就 deepseek。Bot 不自己挑模型。 */
async function defaultBotModel(db: Db): Promise<{ provider: string; model: string }> {
  const s = await db.platformSettings()
  if (s.daily.provider && s.daily.model) return { provider: s.daily.provider, model: s.daily.model }
  if (s.utility.provider && s.utility.model) return { provider: s.utility.provider, model: s.utility.model }
  return { provider: DEFAULT_BOT_PROVIDER, model: DEFAULT_BOT_MODEL }
}

function idList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))]
}

/**
 * 目录项的归属。全局项 companyId 为 null、审计记在 platform 名下；公司项记在自己名下。
 *
 * 建 / 改的那套逻辑对两种归属是同一份，差别全收在这个对象里——不然平台侧要把
 * 公司侧那两百来行校验再抄一遍，抄完两边就开始各自漂移。
 */
interface CatalogOwner {
  scope: Scope
  companyId: string | null
  /** 审计和 skill 标签按这个键存。全局项没有公司，用 'platform'。 */
  auditCompanyId: string
}

const GLOBAL_OWNER: CatalogOwner = { scope: 'global', companyId: null, auditCompanyId: 'platform' }

function companyOwner(id: string): CatalogOwner {
  return { scope: 'company', companyId: id, auditCompanyId: id }
}

/**
 * 只收下这个归属看得见的 id，不认识的直接丢掉。
 *
 * 公司 Bot 能挂全局 Skill/MCP（visibleCatalog 是「全局 ∪ 本公司」），全局 Bot 只能挂
 * 全局的——挂了某家公司的东西，别的公司跑起来就找不到。
 */
async function assignedIds(db: Db, owner: CatalogOwner, kind: 'skill' | 'mcp', v: unknown): Promise<string[]> {
  if (!Array.isArray(v)) return []
  const known = new Set((await db.visibleCatalog(kind, owner.companyId)).map((i) => i.id))
  return idList(v).filter((id) => known.has(id))
}

/** 全局目录项。公司侧的 requireCompany* 会因为 scope 不符自然 404，不用另加守卫。 */
async function requireGlobalItem(db: Db, id: string, kind: CatalogKind, missing: string): Promise<CatalogItem> {
  const item = await db.catalog(id)
  if (!item || item.kind !== kind || item.scope !== 'global') throw new HttpError(404, missing)
  return item
}

/**
 * 对外的 Bot。
 *
 * provider / model 一律给平台指定的那一对，不给存里那一对：Bot 不自己挑模型，
 * 库里那两个字段只是上次保存时的快照。平台换了日常模型，所有 Bot——包括之后再没人
 * 动过的——下一次读就跟着换，不用挨个打开保存一遍。
 */
function publicBot(item: CatalogItem, pinned: { provider: string; model: string }) {
  const def = botDefOf(item.definition)
  const skills = idList(def.skills)
  const mcps = idList(def.mcps)
  return {
    id: item.id,
    name: item.name,
    description: typeof def.description === 'string' ? def.description : '',
    prompt: typeof def.prompt === 'string' ? def.prompt : '',
    greeting: typeof def.greeting === 'string' ? def.greeting : '',
    escalate: typeof def.escalate === 'string' ? def.escalate : '',
    guards: botGuardsOf(def.guards),
    memory: botMemoryOf(def.memory),
    icon: botIconOf(def.icon, item.scope),
    provider: pinned.provider,
    model: pinned.model,
    enabled: def.enabled !== false,
    origin: item.scope === 'global' ? ('global' as const) : ('company' as const),
    createdAt: item.createdAt,
    skills,
    mcps,
    skillCount: skills.length,
    mcpCount: mcps.length,
    usage: '—',
  }
}


/**
 * 看得见的 Bot：本公司的，或者全局的。
 *
 * 只给读路径用。写路径继续走 requireCompanyBot——公司管理员能打开全局 Bot 看配置，
 * 但存不了也删不了。
 */
async function requireVisibleBot(db: Db, orgId: string, botId: string): Promise<CatalogItem> {
  const item = await db.catalog(botId)
  const mine = item?.scope === 'company' && item.companyId === orgId
  if (!item || item.kind !== 'bot' || !(mine || item.scope === 'global')) {
    throw new HttpError(404, '没有这个助理')
  }
  return item
}

async function requireCompanyBot(db: Db, orgId: string, botId: string): Promise<CatalogItem> {
  const item = await db.catalog(botId)
  if (!item || item.kind !== 'bot' || item.scope !== 'company' || item.companyId !== orgId) {
    throw new HttpError(404, '没有这个助理')
  }
  return item
}

const SKILL_SOURCES = ['手动编写', '单文件 Skill', 'ZIP 包'] as const
const MCP_KINDS = ['stdio', 'SSE', 'HTTP'] as const
const MCP_PERMS = ['只读', '可写', '需审批'] as const
const DEFAULT_SKILL_TAGS = ['客服', '数据分析', '内容运营', '销售', '研发支持', '行政支持', '自动化', '需复核']
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024
const MAX_PACKAGE_FILES = 200

type SkillSource = (typeof SKILL_SOURCES)[number]
type McpKind = (typeof MCP_KINDS)[number]
type McpPerm = (typeof MCP_PERMS)[number]

function asDef(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) }
  return {}
}

function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function namedOf(v: unknown): string {
  const name = trimStr(v)
  if (!name) throw new HttpError(400, '要有名字')
  return name
}

function tagsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, 20)
}

/** 「几个步骤」是数出来的，不是填的。列表项——有序无序都算。 */
const stepsOf = (body: string) => body.split('\n').filter((line) => /^\s*(?:\d+[.)]|[-*+])\s+/.test(line)).length

/** 摘要取正文第一段没被列表符号占住的话。 */
const summaryOf = (body: string) => {
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^[#>\-*+\d]/.test(l))
  return line ? (line.length > 90 ? `${line.slice(0, 90)}…` : line) : ''
}

async function knownTags(db: Db, companyId: string): Promise<string[]> {
  const tags = await db.skillTags(companyId)
  if (tags.length) return tags
  for (const tag of DEFAULT_SKILL_TAGS) await db.insertSkillTag(companyId, tag)
  return await db.skillTags(companyId)
}

async function rememberTags(db: Db, companyId: string, tags: string[]) {
  const known = new Set(await knownTags(db, companyId))
  for (const tag of tags) {
    if (!known.has(tag)) await db.insertSkillTag(companyId, tag)
  }
}

/**
 * ZIP 解开后的清单。二进制（base64）丢掉——Gateway 不落磁盘包，只把文本收进定义。
 */
function filesOf(v: unknown): { path: string; text: string }[] {
  if (!Array.isArray(v)) return []
  if (v.length > MAX_PACKAGE_FILES) throw new HttpError(400, `包里最多 ${MAX_PACKAGE_FILES} 个文件`)
  let total = 0
  const files: { path: string; text: string }[] = []
  for (const raw of v) {
    const item = (raw ?? {}) as Record<string, unknown>
    const path = trimStr(item.path).replace(/\\/g, '/').replace(/^\/+/, '')
    if (!path || path.split('/').includes('..')) {
      if (typeof item.text === 'string') throw new HttpError(400, '包里有一个文件没有路径')
      continue
    }
    if (typeof item.text !== 'string') continue
    total += Buffer.byteLength(item.text)
    files.push({ path, text: item.text })
  }
  if (total > MAX_PACKAGE_BYTES) throw new HttpError(400, `包太大了：最多 ${MAX_PACKAGE_BYTES / 1024 / 1024} MB`)
  return files
}

/** 环境变量是一层字符串字典。JSON 字符串或对象都行。 */
function envOf(v: unknown): Record<string, string> {
  if (v == null || v === '') return {}
  let parsed: unknown = v
  if (typeof v === 'string') {
    const text = v.trim()
    if (!text) return {}
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new HttpError(400, '环境变量不是合法的 JSON')
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, '环境变量要是一个 JSON 对象')
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof val !== 'string' && typeof val !== 'number') throw new HttpError(400, `环境变量 ${k} 的值要是字符串`)
    out[k] = String(val)
  }
  return out
}

function publicSkill(item: CatalogItem) {
  const def = asDef(item.definition)
  const body = typeof def.body === 'string' ? def.body : ''
  const source: SkillSource =
    def.source === '单文件 Skill' || def.source === 'ZIP 包' ? def.source : '手动编写'
  const tags = Array.isArray(def.tags) ? def.tags.map((x) => String(x)) : []
  const fileName = trimStr(def.fileName)
  const createdAt = typeof def.createdAt === 'number' ? def.createdAt : item.createdAt
  const updatedAt = typeof def.updatedAt === 'number' ? def.updatedAt : item.updatedAt
  const base = {
    id: item.id,
    name: item.name,
    // 全局项在公司侧是只读的，界面靠这个字段决定给不给编辑入口。
    origin: item.scope === 'global' ? ('global' as const) : ('company' as const),
    body,
    tags,
    source,
    ...(fileName ? { fileName } : {}),
    enabled: def.enabled !== false,
    createdAt,
    updatedAt,
    steps: stepsOf(body),
    summary: summaryOf(body),
  }
  if (source !== 'ZIP 包') return base
  const files = Array.isArray(def.files)
    ? (def.files as { path?: unknown; text?: unknown }[]).filter((f) => typeof f?.path === 'string' && typeof f?.text === 'string')
    : []
  return {
    ...base,
    fileCount: files.length,
    bytes: files.reduce((n, f) => n + Buffer.byteLength(String(f.text)), 0),
  }
}

function publicServer(item: CatalogItem) {
  const def = asDef(item.definition)
  const kind: McpKind = (MCP_KINDS as readonly string[]).includes(trimStr(def.kind)) ? (trimStr(def.kind) as McpKind) : 'SSE'
  const perm: McpPerm = (MCP_PERMS as readonly string[]).includes(trimStr(def.perm)) ? (trimStr(def.perm) as McpPerm) : '只读'
  const env = def.env && typeof def.env === 'object' && !Array.isArray(def.env) ? (def.env as Record<string, string>) : {}
  const token = typeof def.token === 'string' ? def.token.trim() : ''
  const envKeys = Object.keys(env)
  return {
    id: item.id,
    name: item.name,
    origin: item.scope === 'global' ? ('global' as const) : ('company' as const),
    kind,
    endpoint: typeof def.endpoint === 'string' ? def.endpoint : '',
    env: Object.fromEntries(envKeys.map((k) => [k, ''])),
    hasEnv: envKeys.length > 0,
    perm,
    enabled: def.enabled !== false,
    createdAt: typeof def.createdAt === 'number' ? def.createdAt : item.createdAt,
    updatedAt: typeof def.updatedAt === 'number' ? def.updatedAt : item.updatedAt,
    hasToken: !!token,
  }
}

/** 给实例用：带 token 和真实 env。管理面的 publicServer 永远不带。 */
function runtimeServer(item: CatalogItem) {
  const def = asDef(item.definition)
  const token = typeof def.token === 'string' ? def.token.trim() : ''
  const env = def.env && typeof def.env === 'object' && !Array.isArray(def.env) ? (def.env as Record<string, string>) : {}
  return { ...publicServer(item), token, env, hasEnv: Object.keys(env).length > 0 }
}

async function requireCompanySkill(db: Db, orgId: string, skillId: string): Promise<CatalogItem> {
  const item = await db.catalog(skillId)
  if (!item || item.kind !== 'skill' || item.scope !== 'company' || item.companyId !== orgId) {
    throw new HttpError(404, '没有这个 Skill')
  }
  return item
}

async function requireCompanyMcp(db: Db, orgId: string, serverId: string): Promise<CatalogItem> {
  const item = await db.catalog(serverId)
  if (!item || item.kind !== 'mcp' || item.scope !== 'company' || item.companyId !== orgId) {
    throw new HttpError(404, '没有这个 MCP 服务器')
  }
  return item
}

/** 密钥本身永远不出现在响应里，只说配好了。 */
function publicCred(c: Credential) {
  return { id: c.id, companyId: c.companyId, provider: c.provider, configured: true as const, createdAt: c.createdAt, updatedAt: c.updatedAt }
}

function accessUrlFor(slug: string): string {
  const base = process.env.GATEWAY_ACCESS_HOST ?? 'satuwork.com'
  if (base.includes('{slug}')) return base.replaceAll('{slug}', slug)
  if (/^https?:\/\//i.test(base)) {
    const u = new URL(base)
    return `${u.protocol}//${slug}.${u.host}`
  }
  return `https://${slug}.${base}`
}

function gateAccount(account: Account | undefined): Account {
  if (!account) throw new HttpError(401, '需要登录')
  if (account.status === 'disabled') throw new HttpError(401, '这个账号已被停用，请联系管理员')
  if (account.status === 'invited') throw new HttpError(401, '请先用邀请链接设置口令')
  return account
}

/**
 * 公司停用就整家挡在门外——账号自己没停用也一样，省得一家家去停人。
 * owner 不属于任何公司，不受这条影响，否则停完就没人能把它开回来了。
 */
async function gateCompany(db: Db, account: Account): Promise<Account> {
  if (!account.companyId) return account
  const company = await db.company(account.companyId)
  if (company && company.status === 'disabled') throw new HttpError(403, '这家公司已被停用，请联系平台管理员')
  return account
}

async function accountFromJwt(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '需要登录')
  if (token.startsWith('sk_sw_') || token.startsWith('sat_')) throw new HttpError(401, '需要登录')
  let payload: JwtPayload
  try {
    payload = verifyJwt(keys, token)
  } catch (e) {
    throw new HttpError(401, (e as Error).message)
  }
  const account = await db.account(payload.accountId)
  if (!account) throw new HttpError(401, '账号不存在')
  if (account.tokenRevokedAt && payload.iat < Math.floor(account.tokenRevokedAt / 1000)) {
    throw new HttpError(401, '登录已失效，请重新登录')
  }
  return gateCompany(db, gateAccount(account))
}

/** 控制台写操作：只要登录 JWT。sat_ / sk_sw_ 都不行。 */
async function requireUser(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  return await accountFromJwt(req, db, keys)
}

/** Bot 拉目录：登录 JWT 或席位 sat_。sk_sw_ 不行。 */
async function requireSeatOrUser(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '需要登录')
  if (token.startsWith('sk_sw_')) throw new HttpError(401, '需要登录')
  if (token.startsWith('sat_')) return gateCompany(db, gateAccount(await db.accountByAccessToken(token)))
  return await accountFromJwt(req, db, keys)
}

/**
 * 只认席位 sat_。**浏览器的登录 JWT 不行**——这条路会带出 MCP 明文 token 与 env，
 * 那是给实例进程用的，不是给某个成员的浏览器用的。
 */
async function requireSeatOnly(req: Req, db: Db): Promise<Account> {
  const token = bearer(req)
  if (!token || !token.startsWith('sat_')) throw new HttpError(401, '需要席位凭证')
  return gateCompany(db, gateAccount(await db.accountByAccessToken(token)))
}

function headerOf(req: Req, name: string): string | undefined {
  const v = req.headers[name]
  if (Array.isArray(v)) return v[0]
  return typeof v === 'string' ? v : undefined
}

function inviteLinkOf(req: Req, token: string): string {
  const host = headerOf(req, 'x-forwarded-host') || headerOf(req, 'host') || '127.0.0.1:3080'
  const proto = headerOf(req, 'x-forwarded-proto') || 'http'
  return `${proto}://${host}/join/${token}`
}

async function inviteeOf(db: Db, token: string) {
  const id = sha256Hex(token)
  const row = await db.invite(id)
  if (!row) return null
  if (row.expiresAt < Date.now()) {
    await db.deleteInvite(id)
    return null
  }
  const user = await db.account(row.userId)
  if (!user || user.status === 'disabled') return null
  return { user, invite: row, id }
}

async function issueInvite(db: Db, user: Account, createdBy: string, ttl: number) {
  await db.deleteInvitesForUser(user.id)
  const token = randomInviteToken()
  const now = Date.now()
  await db.putInvite({
    id: sha256Hex(token),
    userId: user.id,
    companyId: user.companyId ?? '',
    createdBy,
    createdAt: now,
    expiresAt: now + ttl,
  })
  return { token, expiresAt: now + ttl }
}

async function noteLogin(db: Db, account: Account): Promise<Account> {
  return await db.updateAccount(account.id, {
    lastSeenAt: Date.now(),
    status: account.status === 'invited' ? 'active' : account.status,
  })
}

function statusOf(v: unknown): AccountStatus {
  if (v !== 'active' && v !== 'disabled' && v !== 'invited') throw new HttpError(400, 'status 只能是 active、disabled 或 invited')
  return v
}

function losingAdmin(row: Account, nextRole: Role, nextStatus: AccountStatus): boolean {
  return row.role === 'admin' && row.status !== 'disabled' && (nextRole !== 'admin' || nextStatus === 'disabled')
}

function requireOrg(account: Account, orgId: string, admin = false): void {
  if (account.role === 'owner') return
  if (account.companyId !== orgId) throw new HttpError(403, '不属于这家公司')
  if (admin && account.role !== 'admin') throw new HttpError(403, '需要管理员')
}

function requireOwner(account: Account): void {
  if (account.role !== 'owner') throw new HttpError(403, '需要系统管理员')
}

function rangeQuery(req: Req): { from?: number; to?: number } {
  const fromRaw = req.query.get('from')
  const toRaw = req.query.get('to')
  const from = fromRaw != null && fromRaw !== '' ? Number(fromRaw) : undefined
  const to = toRaw != null && toRaw !== '' ? Number(toRaw) : undefined
  if (fromRaw && fromRaw !== '' && !Number.isFinite(from)) throw new HttpError(400, 'from 必须是 unix 毫秒')
  if (toRaw && toRaw !== '' && !Number.isFinite(to)) throw new HttpError(400, 'to 必须是 unix 毫秒')
  return { from, to }
}

function usagePayload(
  usage: { calls: number; promptTokens: number; completionTokens: number; byAccount: { accountId: string; calls: number; promptTokens: number; completionTokens: number; lastAt: number | null }[] },
  opts: { seats: number; members: Account[]; includeMembers: boolean },
) {
  const byAccount = new Map(usage.byAccount.map((row) => [row.accountId, row]))
  /**
   * 名册上已经没有、但用量记录还在的那些人。
   *
   * 删员工时他的 llm_calls 是**留着**的（留档要求），所以公司总数里一直含着这部分，
   * 而下面「按成员」只列现有成员。不把这一行兜出来，顶部的总数就大于各行相加，差额
   * 没有出处——看的人只会以为哪里算错了。
   */
  const departed = usage.byAccount.filter((row) => !opts.members.some((m) => m.id === row.accountId))
  const departedRow =
    departed.length === 0
      ? null
      : {
          id: '',
          departed: true,
          count: departed.length,
          name: '已离职员工',
          initial: '·',
          tasks: String(departed.reduce((n, r) => n + r.calls, 0)),
          tokens: String(departed.reduce((n, r) => n + r.promptTokens + r.completionTokens, 0)),
          fail: '—',
          last: '—',
        }
  return {
    stats: [
      { label: '任务执行', value: String(usage.calls), delta: '—' },
      { label: '输入 Tokens', value: String(usage.promptTokens), delta: '—' },
      { label: '输出 Tokens', value: String(usage.completionTokens), delta: '—' },
      { label: '费用', value: '—', delta: '—' },
    ],
    daily: [] as unknown[],
    byAgent: [] as unknown[],
    byModel: [] as unknown[],
    quota: [] as unknown[],
    seats: opts.seats,
    ...(opts.includeMembers
      ? {
          byMember: [
            ...opts.members.map((m) => {
              const name = m.name || m.email
              const initial = (name || '·').trim().slice(0, 1).toUpperCase()
              const row = byAccount.get(m.id)
              const tokens = row ? row.promptTokens + row.completionTokens : 0
              return {
                id: m.id,
                departed: false,
                count: 0,
                name,
                initial,
                tasks: String(row?.calls ?? 0),
                tokens: String(tokens),
                fail: '—',
                last: '—',
              }
            }),
            ...(departedRow ? [departedRow] : []),
          ],
        }
      : {}),
  }
}


function requireBootstrapMachine(req: Req) {
  const expected = process.env.GATEWAY_MACHINE_TOKEN ?? ''
  const token = bearer(req)
  if (!expected || !token || !timingSafeToken(token, expected)) {
    throw new HttpError(401, '无效的机器凭证')
  }
}

async function requireMachine(req: Req, db: Db): Promise<Machine> {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '无效的机器凭证')
  const machine = await db.machineByToken(token)
  if (!machine || !machine.token || !timingSafeToken(token, machine.token)) {
    throw new HttpError(401, '无效的机器凭证')
  }
  return machine
}

/**
 * `/internal/*` 里**由 bot 发起**的那几条（ready / sessions.index / usage）的调用方。
 *
 * 两种凭据都收，但权限不一样：
 *
 *  - `sat_` 席位票：bot 进程自己。只能报**它自己那个账号**的事，body 里的 accountId 不作数。
 *  - `smt_` 机器票：管家。能替本机任意席位报。
 *
 * 加 `sat_` 这条路是为了让 bot 不再需要机器票。`smt_` 同时是管家的 root 控制面凭据
 * （`PUT /seats/:id` 就是拿它鉴权的），以前却被写进席位 Linux 用户读得到的 `bot.env`，
 * 于是员工桌面上一句 `cat` 就能拿到整台机器的控制权。现在它不再离开
 * `/etc/satuwork/manager.json`。
 */
type InternalCaller =
  | { kind: 'machine'; machine: Machine; companyId: string }
  | { kind: 'seat'; account: Account; companyId: string }

async function requireInternalCaller(req: Req, db: Db): Promise<InternalCaller> {
  const token = bearer(req)
  if (token && token.startsWith('sat_')) {
    const account = await gateCompany(db, gateAccount(await db.accountByAccessToken(token)))
    if (!account.companyId) throw new HttpError(403, '没有公司席位')
    return { kind: 'seat', account, companyId: account.companyId }
  }
  const machine = await requireMachine(req, db)
  if (!machine.companyId) throw new HttpError(403, '机器还没有派给公司')
  return { kind: 'machine', machine, companyId: machine.companyId }
}

/** 调用方能替哪个账号说话。席位票只能是自己，机器票由 body 指定。 */
function callerAccountId(caller: InternalCaller, fromBody: () => string): string {
  return caller.kind === 'seat' ? caller.account.id : fromBody()
}

function requirePlatformToken(req: Req) {
  const expected = process.env.GATEWAY_PLATFORM_TOKEN ?? ''
  const token = bearer(req)
  if (!expected || !token || !timingSafeToken(token, expected)) {
    throw new HttpError(401, '无效的平台凭证')
  }
}

/**
 * 谁能发布 Bot 版本：CI 拿平台令牌，人拿 owner 登录态。
 * 返回 accountId（平台令牌没有账号，返回空串）。
 */
async function requireReleaseAuthor(req: Req, db: Db, keys: JwtKeys): Promise<string> {
  const expected = process.env.GATEWAY_PLATFORM_TOKEN ?? ''
  const token = bearer(req)
  if (expected && token && timingSafeToken(token, expected)) return ''
  const account = await requireUser(req, db, keys)
  requireOwner(account)
  return account.id
}

function issue(keys: JwtKeys, account: Account) {
  return signJwt(
    keys,
    {
      sub: account.id,
      accountId: account.id,
      companyId: account.role === 'owner' ? '' : (account.companyId ?? ''),
      role: account.role,
    },
    JWT_TTL,
  )
}

function send(res: ServerResponse, status: number, body: unknown) {
  json(res, status, body)
}

function kindOf(name: string): CatalogKind {
  const k = KIND[name]
  if (!k) throw new HttpError(404, '未知目录')
  return k
}

/**
 * 把 M2 的路由挂上去。
 *
 * 控制面：注册登录、公司/席位、目录、机器登记。
 * 对话 UI 在这里；正文仍只活在 Bot 磁盘上，本进程只反代、不落库。
 */
export function attach(router: Router, db: Db, keys: JwtKeys) {
  const llm = createLlm(db)
  attachV1(router, db, keys, llm)

  router.get('/health', async (_req, res) => send(res, 200, { ok: true }))
  router.get('/jwks', async (_req, res) => send(res, 200, jwks(keys)))
  router.get('/.well-known/jwks.json', async (_req, res) => send(res, 200, jwks(keys)))

  /**
   * 门口的状态。**公开**：还没登录的浏览器要靠它决定画登录页还是「创建系统管理员」。
   * 只回一个布尔，不透露任何账号信息。
   */
  router.get('/auth/state', async (_req, res) => {
    send(res, 200, { needsSetup: (await db.owners()).length === 0 })
  })

  /**
   * 建第一个系统管理员。**只在一个 owner 都没有时可用**，这条检查在服务端——
   * 否则任何人都能往这个接口再造一个 owner 出来。
   */
  router.post('/auth/setup', async (req, res) => {
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const password = strField(body, 'password')
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    const name = strField(body, 'name', false)
    const passwordHash = await hashPassword(password)
    // 并发点两次「创建」也只成一个：抢在事务里再查一遍。
    const owner = await db.tx(async () => {
      if ((await db.owners()).length) throw new HttpError(409, '已经有系统管理员了')
      if (await db.accountByEmail(email)) throw new HttpError(409, '这个邮箱已经注册')
      return db.insertAccount({ companyId: null, email, passwordHash, role: 'owner', name })
    })
    await db.audit({ companyId: 'platform', accountId: owner.id, action: 'auth.setup', detail: { email } })
    send(res, 201, { token: issue(keys, owner), account: publicAccount(owner), company: null })
  })

  // ── 注册 / 登录 ─────────────────────────────────────────────────────

  router.post('/auth/register', async (req, res) => {
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const password = strField(body, 'password')
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    const name = strField(body, 'companyName')
    const slug = slugOf(strField(body, 'slug'))
    const seats = seatsOf(body.seats, 1)
    if (await db.accountByEmail(email)) throw new HttpError(409, '这个邮箱已经注册')
    if (await db.companyBySlug(slug)) throw new HttpError(409, '这个 slug 已被占用')
    const passwordHash = await hashPassword(password)
    const { company, account } = await db.tx(async () => {
      const company = await db.insertCompany({ slug, name })
      await db.upsertPlan(company.id, seats)
      const account = await db.insertAccount({ companyId: company.id, email, passwordHash, role: 'admin' })
      await db.audit({ companyId: company.id, accountId: account.id, action: 'auth.register', detail: { slug, seats } })
      return { company, account }
    })
    send(res, 201, { token: issue(keys, account), account: publicAccount(account), company: publicCompany(company) })
  })

  router.post('/auth/login', async (req, res) => {
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const password = strField(body, 'password')
    const account = await db.accountByEmail(email)
    // 找不到也走同一条失败路径，不靠耗时差泄露「这个邮箱在不在」。
    const ok = account ? await verifyPassword(password, account.passwordHash) : await verifyPassword(password, await LOGIN_DUMMY_HASH)
    if (!account || !ok) throw new HttpError(401, '邮箱或口令不对')
    if (account.status === 'disabled') throw new HttpError(403, '这个账号已被停用，请联系管理员')
    if (account.status === 'invited') throw new HttpError(403, '请先用邀请链接设置口令')
    const logged = await noteLogin(db, account)
    if (logged.role === 'owner') {
      await db.audit({ companyId: 'platform', accountId: logged.id, action: 'auth.login' })
      send(res, 200, { token: issue(keys, logged), account: publicAccount(logged), company: null })
      return
    }
    const company = await db.company(logged.companyId!)
    if (!company) throw new HttpError(401, '账号不存在')
    if (company.status === 'disabled') throw new HttpError(403, '这家公司已被停用，请联系平台管理员')
    await db.audit({ companyId: company.id, accountId: logged.id, action: 'auth.login' })
    send(res, 200, { token: issue(keys, logged), account: publicAccount(logged), company: publicCompany(company) })
  })

  /**
   * 看一条邀请是否还有效。公开：点链接的人还没有账号。
   * 无效不区分「不存在 / 过期 / 用过」——三者对访客是同一件事。
   */
  router.get('/invites/:token', async (req, res) => {
    const found = await inviteeOf(db, req.params.token)
    if (!found) {
      send(res, 200, { valid: false })
      return
    }
    send(res, 200, {
      valid: true,
      email: found.user.email,
      name: found.user.name,
      expiresAt: found.invite.expiresAt,
    })
  })

  router.post('/invites/:token/accept', async (req, res) => {
    const found = await inviteeOf(db, req.params.token)
    if (!found) throw new HttpError(400, '这条邀请链接不可用')
    const body = bodyOf(req)
    const password = strField(body, 'password')
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    const name = strField(body, 'name', false)
    const passwordHash = await hashPassword(password)
    const now = Date.now()
    const next = await db.updateAccount(found.user.id, {
      name: name || found.user.name,
      passwordHash,
      status: 'active',
      passwordChangedAt: now,
      lastSeenAt: now,
    })
    await db.deleteInvite(found.id)
    send(res, 200, { token: issue(keys, next), account: publicAccount(next) })
  })

  router.get('/me', async (req, res) => {
    const account = await requireSeatOrUser(req, db, keys)
    const settings = publicSettings(await db.platformSettings())
    if (account.role === 'owner') {
      send(res, 200, {
        account: publicAccount(account),
        company: null,
        plan: null,
        settings,
        orgs: await Promise.all((await db.companies()).map((c) => orgSummary(db, c))),
      })
      return
    }
    const company = await db.company(account.companyId!)
    if (!company) throw new HttpError(401, '账号不存在')
    const plan = (await db.plan(company.id))!
    send(res, 200, {
      account: publicAccount(account),
      company: publicCompany(company),
      plan: await publicPlan(db, plan, await db.accountCount(company.id)),
      settings,
    })
  })

  /**
   * 改自己的资料与界面偏好。邮箱/角色/状态/口令不在这里——邮箱是登录身份，
   * 角色是管理面的事，口令走 /me/password。
   */
  router.patch('/me', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const body = bodyOf(req)
    const patch: {
      name?: string
      title?: string
      phone?: string
      theme?: Account['theme']
      locale?: Account['locale']
    } = {}
    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (name) patch.name = name
    }
    if (typeof body.title === 'string') patch.title = body.title.trim()
    if (typeof body.phone === 'string') patch.phone = body.phone.trim()
    if (body.theme != null && body.theme !== '') {
      const theme = strField(body, 'theme')
      if (theme !== 'light' && theme !== 'dark' && theme !== 'system') {
        throw new HttpError(400, 'theme 只能是 light、dark 或 system')
      }
      patch.theme = theme as Account['theme']
    }
    if (body.locale != null && body.locale !== '') {
      const locale = strField(body, 'locale')
      if (locale !== 'zh' && locale !== 'en') throw new HttpError(400, 'locale 只能是 zh 或 en')
      patch.locale = locale as Account['locale']
    }
    const next = Object.keys(patch).length ? await db.updateAccount(account.id, patch) : account
    send(res, 200, { account: publicAccount(next) })
  })

  /**
   * 改口令。先验当前口令；改完 tokenRevokedAt 立刻作废其他 JWT，当前这次发一张新票。
   */
  router.post('/me/password', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const body = bodyOf(req)
    const current = strField(body, 'current')
    const next = strField(body, 'next')
    const ok = await verifyPassword(current, account.passwordHash)
    if (!ok) throw new HttpError(400, '当前口令不对')
    if (next.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    if (next === current) throw new HttpError(400, '新口令不能和当前口令相同')
    const passwordHash = await hashPassword(next)
    const now = Date.now()
    const nextAccount = await db.updateAccount(account.id, {
      passwordHash,
      passwordChangedAt: now,
      tokenRevokedAt: now,
    })
    await db.audit({
      companyId: account.companyId ?? 'platform',
      accountId: account.id,
      action: 'account.password',
    })
    send(res, 200, { ok: true, token: issue(keys, nextAccount) })
  })

  /**
   * Gateway 用 JWT，没有会话表。只回当前这一次，列不出也注销不了其他设备。
   */
  router.get('/me/sessions', async (req, res) => {
    const account = await requireUser(req, db, keys)
    send(res, 200, {
      sessions: [
        {
          id: 'current',
          agent: headerOf(req, 'user-agent') || '',
          createdAt: account.lastSeenAt || Date.now(),
          current: true,
        },
      ],
    })
  })

  // ── 平台（owner）───────────────────────────────────────────────────

  router.get('/platform/settings', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    send(res, 200, publicSettings(await db.platformSettings()))
  })

  router.put('/platform/settings', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    const cur = await db.platformSettings()
    const next: PlatformSettings = {
      daily: 'daily' in body ? modelRoleOf(body.daily, 'daily') : cur.daily,
      utility: 'utility' in body ? modelRoleOf(body.utility, 'utility') : cur.utility,
      enabledModels: 'enabledModels' in body ? enabledModelsOf(body.enabledModels) : cur.enabledModels ?? [],
      priceMultiplier: priceMultiplierOf(body.priceMultiplier, parsePriceMultiplier(cur.priceMultiplier)),
      managerVersion:
        'managerVersion' in body ? String(body.managerVersion ?? '').trim() : (cur.managerVersion ?? ''),
    }
    const saved = await db.putPlatformSettings(next)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.settings.update', detail: publicSettings(saved) })
    send(res, 200, publicSettings(saved))
  })

  router.get('/platform/credentials', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    send(res, 200, { credentials: (await db.platformCredentials()).map(publicPlatformCred) })
  })

  router.post('/platform/credentials', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    const provider = strField(body, 'provider')
    const secret = strField(body, 'secret')
    const existed = !!await db.platformCredential(provider)
    const row = await db.upsertPlatformCredential(provider, secret)
    await db.audit({
      companyId: 'platform',
      accountId: account.id,
      action: existed ? 'platform.credential.update' : 'platform.credential.create',
      detail: { provider },
    })
    send(res, existed ? 200 : 201, { credential: publicPlatformCred(row) })
  })

  router.put('/platform/credentials/:provider', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const provider = req.params.provider
    if (!await db.platformCredential(provider)) throw new HttpError(404, '密钥不存在')
    const secret = strField(bodyOf(req), 'secret')
    const row = await db.upsertPlatformCredential(provider, secret)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.credential.update', detail: { provider } })
    send(res, 200, { credential: publicPlatformCred(row) })
  })

  router.delete('/platform/credentials/:provider', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const provider = req.params.provider
    if (!await db.platformCredential(provider)) throw new HttpError(404, '密钥不存在')
    await db.deletePlatformCredential(provider)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.credential.delete', detail: { provider } })
    send(res, 200, { deleted: true, provider })
  })

  /**
   * 平台用量统计：按公司汇总 token，并按模型单价折成金额。
   *
   * 时间窗由前端算好用 from/to（unix 毫秒）传进来——「今日」「本月」是相对
   * **用户所在时区**的，服务端不知道那是哪个时区，自己切会错一整天。
   *
   * 金额用浮点数算：它是从 token 数折出来的展示值，不是账本条目（账本那边
   * 是 amountMils 整数厘）。token 数和单价的量级下，双精度的误差落不到显示位上。
   */
  router.get('/platform/stats', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const range = rangeQuery(req)
    const companyId = (req.query.get('companyId') || '').trim()
    if (companyId && !(await db.company(companyId))) throw new HttpError(404, '公司不存在')

    const rows = await db.llmUsageByCompanyModel(range, companyId || undefined)
    const multiplier = parsePriceMultiplier((await db.platformSettings()).priceMultiplier)
    const rates = new Map<string, { input: number; output: number }>()
    for (const m of await llm.catalog(null)) {
      const c = (m.cost ?? {}) as { input?: unknown; output?: unknown }
      rates.set(`${m.provider}/${m.id}`, { input: Number(c.input) || 0, output: Number(c.output) || 0 })
    }

    const companies = new Map((await db.companies()).map((c) => [c.id, c]))
    type Bucket = {
      companyId: string | null
      name: string
      calls: number
      promptTokens: number
      completionTokens: number
      costUsd: number
      quotedUsd: number
      unpricedCalls: number
      lastAt: number | null
    }
    const byCompany = new Map<string, Bucket>()
    const byModel = new Map<string, {
      provider: string
      model: string
      calls: number
      promptTokens: number
      completionTokens: number
      costUsd: number
      quotedUsd: number
      priced: boolean
    }>()
    /** 目录里没价的模型（pi-ai 没收录，或自定义时留了 0）。金额算不出来，得说清楚。 */
    const unpricedModels = new Set<string>()

    for (const row of rows) {
      const key = `${row.provider}/${row.model}`
      const rate = rates.get(key)
      const priced = !!rate && (rate.input > 0 || rate.output > 0)
      if (!priced) unpricedModels.add(key)
      // 单价的单位是「每 100 万 token 多少美元」，和内置目录一致。
      const cost = priced ? (row.promptTokens * rate.input + row.completionTokens * rate.output) / 1_000_000 : 0

      const cid = row.companyId
      const bk = cid ?? ''
      let bucket = byCompany.get(bk)
      if (!bucket) {
        bucket = {
          companyId: cid,
          name: cid ? companies.get(cid)?.name ?? cid : '平台（系统管理员）',
          calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, quotedUsd: 0, unpricedCalls: 0, lastAt: null,
        }
        byCompany.set(bk, bucket)
      }
      bucket.calls += row.calls
      bucket.promptTokens += row.promptTokens
      bucket.completionTokens += row.completionTokens
      bucket.costUsd += cost
      bucket.quotedUsd += cost * multiplier
      if (!priced) bucket.unpricedCalls += row.calls
      if (row.lastAt != null && (bucket.lastAt == null || row.lastAt > bucket.lastAt)) bucket.lastAt = row.lastAt

      let mb = byModel.get(key)
      if (!mb) {
        mb = { provider: row.provider, model: row.model, calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, quotedUsd: 0, priced }
        byModel.set(key, mb)
      }
      mb.calls += row.calls
      mb.promptTokens += row.promptTokens
      mb.completionTokens += row.completionTokens
      mb.costUsd += cost
      mb.quotedUsd += cost * multiplier
    }

    const list = [...byCompany.values()].sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens))
    const totals = list.reduce(
      (acc, x) => ({
        calls: acc.calls + x.calls,
        promptTokens: acc.promptTokens + x.promptTokens,
        completionTokens: acc.completionTokens + x.completionTokens,
        costUsd: acc.costUsd + x.costUsd,
        quotedUsd: acc.quotedUsd + x.quotedUsd,
        unpricedCalls: acc.unpricedCalls + x.unpricedCalls,
      }),
      { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, quotedUsd: 0, unpricedCalls: 0 },
    )

    send(res, 200, {
      from: range.from ?? null,
      to: range.to ?? null,
      multiplier,
      companies: [...companies.values()].map((c) => ({ id: c.id, name: c.name })),
      byCompany: list,
      byModel: [...byModel.values()].sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens)),
      totals,
      // 前端要据此提示「有模型没单价，金额不完整」，不能让 $0.00 被读成免费。
      unpricedModels: [...unpricedModels],
    })
  })

  // ── 自定义供应商（pi-ai 的 createProvider 形状）──────────────────────

  /** 删掉这个供应商就没模型可用了的角色。删之前先问清楚，别让日常模型悄悄哑掉。 */
  async function rolesUsing(provider: string): Promise<string[]> {
    const s = await db.platformSettings()
    const hit: string[] = []
    if (s.daily.provider === provider) hit.push('日常')
    if (s.utility.provider === provider) hit.push('utility')
    return hit
  }

  async function customProviderItem(id: string) {
    for (const item of await db.visibleCatalog('provider', null)) {
      const def = (item.definition ?? {}) as { id?: unknown }
      if (String(def.id ?? item.name) === id) return item
    }
    return undefined
  }

  function defOf(item: { definition: unknown }): CustomProviderDef {
    return parseProviderDef(item.definition)
  }

  /** parseProviderDef 抛的是 DefError，对外要变成 400，不能漏成 500。 */
  function parseOr400<T>(fn: () => T): T {
    try {
      return fn()
    } catch (e) {
      if (e instanceof DefError) throw new HttpError(400, e.message)
      throw e
    }
  }

  router.get('/platform/providers', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const items = await db.visibleCatalog('provider', null)
    const out: Record<string, unknown>[] = []
    for (const item of items) {
      try {
        out.push({ itemId: item.id, ...defOf(item) })
      } catch (e) {
        // 坏定义也要露出来，否则界面上它就是一条看不见删不掉的记录。
        out.push({ itemId: item.id, id: item.name, name: item.name, broken: (e as Error).message })
      }
    }
    send(res, 200, { providers: out, apis: CUSTOM_APIS, builtin: [...llm.builtinProviderIds()] })
  })

  router.post('/platform/providers', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const def = parseOr400(() => parseProviderDef(bodyOf(req)))
    if (llm.isBuiltinProvider(def.id)) throw new HttpError(409, `${def.id} 是内置供应商，换个 id`)
    if (await customProviderItem(def.id)) throw new HttpError(409, '这个供应商 id 已经有了')
    const item = await db.insertCatalog({ kind: 'provider', scope: 'global', companyId: null, name: def.id, definition: def })
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.provider.create', detail: { provider: def.id } })
    send(res, 201, { provider: { itemId: item.id, ...def } })
  })

  router.put('/platform/providers/:provider', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const item = await customProviderItem(req.params.provider)
    if (!item) throw new HttpError(404, '自定义供应商不存在')
    // id 不给改：模型角色、密钥、用量记录都是按它存的，改了会成孤儿。
    const def = parseOr400(() => parseProviderDef({ ...(bodyOf(req) as object), id: req.params.provider }))
    const next = await db.updateCatalog(item.id, { name: def.id, definition: def })
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.provider.update', detail: { provider: def.id } })
    send(res, 200, { provider: { itemId: next.id, ...def } })
  })

  router.delete('/platform/providers/:provider', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const provider = req.params.provider
    const item = await customProviderItem(provider)
    if (!item) throw new HttpError(404, '自定义供应商不存在')
    const used = await rolesUsing(provider)
    if (used.length && req.query.get('force') !== '1') {
      throw new HttpError(409, `${used.join(' 和 ')}模型正在用它，确认要删就带 force=1`, { roles: used })
    }
    await db.deleteCatalog(item.id)
    // 密钥跟着走，别在库里留一把指向不存在的供应商的密钥。
    if (await db.platformCredential(provider)) await db.deletePlatformCredential(provider)
    for (const role of used) {
      await db.putPlatformSettings({
        ...(await db.platformSettings()),
        [role === '日常' ? 'daily' : 'utility']: { provider: '', model: '' },
      })
    }
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.provider.delete', detail: { provider, clearedRoles: used } })
    send(res, 200, { deleted: true, provider, clearedRoles: used })
  })

  router.post('/platform/llm/test', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    let provider = ''
    let model = ''
    const role = body.role
    const cur = await db.platformSettings()
    if (role === 'daily' || role === 'utility') {
      const slot = cur[role]
      if (!slot.provider || !slot.model) throw new HttpError(400, `${role === 'daily' ? '日常' : 'utility'} 模型还没设置`)
      provider = slot.provider
      model = slot.model
    } else {
      provider = strField(body, 'provider')
      model = strField(body, 'model', false)
      if (!model) {
        if (cur.daily.provider === provider && cur.daily.model) model = cur.daily.model
        else if (cur.utility.provider === provider && cur.utility.model) model = cur.utility.model
        else model = await llm.firstModel(null, provider)
      }
      if (!model) throw new HttpError(400, '这个供应商没有可测的模型')
    }
    const result = await llm.probe(null, provider, model)
    if (!result.ok && result.error === '模型不在可见目录里') {
      throw new HttpError(404, result.error, { model: `${result.provider}/${result.model}` })
    }
    if (!result.ok && result.error?.startsWith('没有 ') && result.error.endsWith(' 的密钥')) {
      throw new HttpError(402, result.error, { provider: result.provider })
    }
    send(res, 200, result)
  })

  router.get('/platform/orgs', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    send(res, 200, { orgs: await Promise.all((await db.companies()).map((c) => orgSummary(db, c))) })
  })

  router.get('/platform/accounts', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const companies = new Map((await db.companies()).map((c) => [c.id, c]))
    send(res, 200, {
      accounts: (await db.accountsAll()).map((a) => {
        const company = a.companyId ? companies.get(a.companyId) : undefined
        return {
          ...publicAccount(a),
          company: company ? { id: company.id, name: company.name, slug: company.slug } : null,
        }
      }),
    })
  })

  router.get('/platform/accounts/:id', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOwner(actor)
    const row = await db.account(req.params.id)
    if (!row) throw new HttpError(404, '账号不存在')
    const company = row.companyId ? await db.company(row.companyId) : undefined
    const secrets = row.role === 'owner' ? undefined : await db.accountSecrets(row.id)
    send(res, 200, {
      account: publicAccount(row),
      company: company ? { id: company.id, name: company.name, slug: company.slug } : null,
      apiKey: secrets?.apiKey ?? null,
      accessToken: secrets?.accessToken ?? null,
    })
  })

  router.post('/platform/orgs', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOwner(actor)
    const body = bodyOf(req)
    const name = strField(body, 'name')
    const slug = slugOf(strField(body, 'slug'))
    const contactName = strField(body, 'contactName')
    const contactPhone = phoneOf(strField(body, 'contactPhone'))
    const contactEmail = emailOf(strField(body, 'contactEmail'))
    const address = strField(body, 'address', false)
    const website = websiteOf(strField(body, 'website', false))
    const adminEmail = emailOf(strField(body, 'adminEmail'))
    const adminPassword = strField(body, 'adminPassword')
    if (adminPassword.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    if (await db.accountByEmail(adminEmail)) throw new HttpError(409, '这个邮箱已经注册')
    if (await db.companyBySlug(slug)) throw new HttpError(409, '这个 slug 已被占用')
    const passwordHash = await hashPassword(adminPassword)
    // 建公司只开管理员这一个席位；加席位走 `PUT /platform/orgs/:id/plan`（公司详情页的订阅）。
    const seats = 1
    const created = await db.tx(async () => {
      const company = await db.insertCompany({ slug, name, contactName, contactPhone, contactEmail, address, website })
      await db.upsertPlan(company.id, seats)
      const admin = await db.insertAccount({ companyId: company.id, email: adminEmail, passwordHash, role: 'admin' })
      await db.audit({
        companyId: company.id,
        accountId: actor.id,
        action: 'platform.org.create',
        detail: { slug, contactName, contactEmail, adminEmail },
      })
      return { company, admin }
    })
    send(res, 201, { company: publicCompany(created.company), account: publicAccount(created.admin), plan: { seats, used: 1 } })
  })

  router.put('/platform/orgs/:id/plan', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const cur = await db.plan(req.params.id)
    // 选了套餐但没写席位，就按套餐的席位数来——价目表里那个数就是卖出去的席位。
    let sku
    if (body.skuId !== undefined && body.skuId !== null && body.skuId !== '') {
      sku = await db.planSku(strField(body, 'skuId'))
      if (!sku) throw new HttpError(404, '套餐不存在')
    }
    const seats = body.seats == null || body.seats === '' ? (sku?.seats ?? cur?.seats ?? 1) : seatsOf(body.seats)
    const used = await db.accountCount(req.params.id)
    if (seats < used) throw new HttpError(409, '席位不能少于已有账号数', { seats, used })
    const patch: { skuId?: string | null; expiresAt?: number | null } = {}
    if (body.skuId !== undefined) patch.skuId = sku ? sku.id : null
    if (body.expiresAt !== undefined) patch.expiresAt = expiresAtOf(body.expiresAt)
    const plan = await db.upsertPlan(req.params.id, seats, patch)
    await db.audit({
      companyId: req.params.id,
      accountId: account.id,
      action: 'plan.update',
      detail: { seats, skuId: plan.skuId, expiresAt: plan.expiresAt },
    })
    send(res, 200, await publicPlan(db, plan, used))
  })

  /**
   * 套餐 SKU（价目表）。只有 owner 能动。
   * 注意跟 `PUT /platform/orgs/:id/plan` 分清：那条改的是某家公司的席位额度，
   * 这里改的是「卖什么」，改价不会动已经开出去的公司席位。
   */
  router.get('/platform/plans', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    send(res, 200, { plans: (await db.planSkus()).map(publicPlanSku) })
  })

  router.get('/platform/plans/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const plan = await db.planSku(req.params.id)
    if (!plan) throw new HttpError(404, '套餐不存在')
    send(res, 200, { plan: publicPlanSku(plan) })
  })

  router.post('/platform/plans', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    const name = strField(body, 'name')
    // 英文名选填：留空的话英文界面回落到中文名，总比显示空白强。
    const nameEn = strField(body, 'nameEn', false)
    const amountMils = amountMilsOf(body.amount)
    const seats = seatsOf(body.seats)
    const period = periodOf(body.period)
    const bonusMils = bonusMilsOf(body.bonusTokens)
    if (await db.planSkuByName(name)) throw new HttpError(409, '这个套餐名已存在')
    if (nameEn && await db.planSkuByName(nameEn)) throw new HttpError(409, '这个套餐名已存在')
    const plan = await db.insertPlanSku({ name, nameEn, amountMils, seats, period, bonusMils })
    await db.audit({
      companyId: 'platform',
      accountId: account.id,
      action: 'platform.plan.create',
      detail: { id: plan.id, name, nameEn, amountMils, seats, period, bonusMils },
    })
    send(res, 201, { plan: publicPlanSku(plan) })
  })

  router.put('/platform/plans/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const cur = await db.planSku(req.params.id)
    if (!cur) throw new HttpError(404, '套餐不存在')
    const body = bodyOf(req)
    const name = 'name' in body ? strField(body, 'name') : cur.name
    const nameEn = 'nameEn' in body ? strField(body, 'nameEn', false) : cur.nameEn
    const amountMils = 'amount' in body ? amountMilsOf(body.amount, cur.amountMils) : cur.amountMils
    const seats = 'seats' in body ? seatsOf(body.seats, cur.seats) : cur.seats
    const period = 'period' in body ? periodOf(body.period, cur.period) : cur.period
    const bonusMils = 'bonusTokens' in body ? bonusMilsOf(body.bonusTokens, cur.bonusMils) : cur.bonusMils
    if (name !== cur.name) {
      const clash = await db.planSkuByName(name)
      if (clash && clash.id !== cur.id) throw new HttpError(409, '这个套餐名已存在')
    }
    if (nameEn && nameEn !== cur.nameEn) {
      const clash = await db.planSkuByName(nameEn)
      if (clash && clash.id !== cur.id) throw new HttpError(409, '这个套餐名已存在')
    }
    if (nameEn && nameEn === name) throw new HttpError(400, '中英文名不能填成同一个')
    const plan = await db.updatePlanSku(cur.id, { name, nameEn, amountMils, seats, period, bonusMils })
    if (!plan) throw new HttpError(404, '套餐不存在')
    await db.audit({
      companyId: 'platform',
      accountId: account.id,
      action: 'platform.plan.update',
      detail: { id: plan.id, name, nameEn, amountMils, seats, period, bonusMils },
    })
    send(res, 200, { plan: publicPlanSku(plan) })
  })

  /**
   * 订单：某公司订阅某套餐。owner 专属。
   * 下单时把套餐内容抄一份进订单——之后改价目表不会改写已经开出去的订单。
   */
  router.get('/platform/orders', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const companies = new Map((await db.companies()).map((c) => [c.id, c]))
    send(res, 200, { orders: (await db.planOrders()).map((o) => publicPlanOrder(o, companies.get(o.companyId))) })
  })

  router.get('/platform/orders/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const order = await db.planOrder(req.params.id)
    if (!order) throw new HttpError(404, '订单不存在')
    send(res, 200, { order: publicPlanOrder(order, await db.company(order.companyId)) })
  })

  router.post('/platform/orders', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    const company = await db.company(strField(body, 'companyId'))
    if (!company) throw new HttpError(404, '公司不存在')
    // 充值单：只有金额和备注。付了款才开充值记录，余额也是那时候才涨。
    if (orderKindOf(body.kind) === 'topup') {
      const amountMils = amountMilsOf(body.amount)
      if (amountMils <= 0) throw new HttpError(400, '充值金额必须大于 0')
      const note = strField(body, 'note', false)
      const startAt = dateMsOf(body.startAt, Date.now())
      const payStatus = payStatusOf(body.payStatus)
      const { order, topup } = await db.tx(async () => {
        const order = await db.insertPlanOrder({
          companyId: company.id,
          kind: 'topup',
          note,
          planId: null,
          planName: '充值',
          planNameEn: 'Top-up',
          period: 'month',
          // 充值没有席位、没有赠送、也没有账期：起止同一天，别装成一段订阅。
          seats: 0,
          amountMils,
          bonusMils: 0,
          startAt,
          endAt: startAt,
          payStatus,
        })
        return { order, topup: await syncTopupOfOrder(db, order, account.id) }
      })
      await db.audit({
        companyId: company.id,
        accountId: account.id,
        action: 'platform.order.create',
        detail: { id: order.id, kind: 'topup', amountMils, note, payStatus },
      })
      send(res, 201, {
        order: publicPlanOrder(order, company),
        topup: topup ? publicTopup(topup, company, account) : null,
        balance: await balanceOf(db, company.id),
      })
      return
    }
    const sku = await db.planSku(strField(body, 'planId'))
    if (!sku) throw new HttpError(404, '套餐不存在')
    // 套餐内容作为默认值抄进订单，但允许逐项改（打折、送席位都靠这个）。
    const period = 'period' in body ? periodOf(body.period, sku.period) : sku.period
    const seats = 'seats' in body ? seatsOf(body.seats, sku.seats) : sku.seats
    const amountMils = 'amount' in body ? amountMilsOf(body.amount, sku.amountMils) : sku.amountMils
    const bonusMils = 'bonusTokens' in body ? bonusMilsOf(body.bonusTokens, sku.bonusMils) : sku.bonusMils
    const startAt = dateMsOf(body.startAt, Date.now())
    const endAt = 'endAt' in body && body.endAt ? dateMsOf(body.endAt) : endOfPeriod(startAt, period)
    if (endAt <= startAt) throw new HttpError(400, '结束时间必须晚于开始时间')
    const payStatus = payStatusOf(body.payStatus)
    // 订单 + 账单一起落：账单开不出来就不该留下一条孤零零的订单。
    // 订阅要等付款——未付款时 syncPlanFromOrders 找不到已付款的生效订单，什么都不会写。
    const { order, invoice } = await db.tx(async () => {
      const order = await db.insertPlanOrder({
        companyId: company.id,
        kind: 'plan',
        note: '',
        planId: sku.id,
        planName: sku.name,
        planNameEn: sku.nameEn,
        period,
        seats,
        amountMils,
        bonusMils,
        startAt,
        endAt,
        payStatus,
      })
      const invoice = await syncInvoiceOfOrder(db, order)
      await db.syncPlanFromOrders(company.id)
      return { order, invoice }
    })
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'platform.order.create',
      detail: { id: order.id, planId: sku.id, planName: sku.name, period, seats, amountMils, bonusMils, payStatus },
    })
    send(res, 201, { order: publicPlanOrder(order, company), invoice: publicInvoice(invoice) })
  })

  router.put('/platform/orders/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const cur = await db.planOrder(req.params.id)
    if (!cur) throw new HttpError(404, '订单不存在')
    const body = bodyOf(req)
    const company = 'companyId' in body ? await db.company(strField(body, 'companyId')) : await db.company(cur.companyId)
    if (!company) throw new HttpError(404, '公司不存在')
    // 单据类型不给改：套餐单背后挂着账单，充值单背后挂着充值记录，改类型等于换一张单子。
    if ('kind' in body && orderKindOf(body.kind) !== cur.kind) throw new HttpError(400, '订单类型不能改，请另开一单')
    if (cur.kind === 'topup') {
      const amountMils = 'amount' in body ? amountMilsOf(body.amount, cur.amountMils) : cur.amountMils
      if (amountMils <= 0) throw new HttpError(400, '充值金额必须大于 0')
      const note = 'note' in body ? strField(body, 'note', false) : cur.note
      const startAt = 'startAt' in body ? dateMsOf(body.startAt, cur.startAt) : cur.startAt
      const payStatus = payStatusOf(body.payStatus, cur.payStatus)
      const { order, topup } = await db.tx(async () => {
        const order = await db.updatePlanOrder(cur.id, {
          companyId: company.id, note, amountMils, startAt, endAt: startAt, payStatus,
        })
        if (!order) throw new HttpError(404, '订单不存在')
        return { order, topup: await syncTopupOfOrder(db, order, account.id) }
      })
      await db.audit({
        companyId: company.id,
        accountId: account.id,
        action: 'platform.order.update',
        detail: { id: order.id, kind: 'topup', amountMils, note, payStatus },
      })
      send(res, 200, {
        order: publicPlanOrder(order, company),
        topup: topup ? publicTopup(topup, company) : null,
        balance: await balanceOf(db, company.id),
      })
      return
    }
    // 换套餐要把快照一起换掉，否则订单上写的还是旧套餐的名字。
    let { planId, planName, planNameEn } = cur
    let sku: PlanSku | undefined
    if ('planId' in body && strField(body, 'planId') !== cur.planId) {
      sku = await db.planSku(strField(body, 'planId'))
      if (!sku) throw new HttpError(404, '套餐不存在')
      planId = sku.id
      planName = sku.name
      planNameEn = sku.nameEn
    }
    const period = 'period' in body ? periodOf(body.period, cur.period) : sku?.period ?? cur.period
    const seats = 'seats' in body ? seatsOf(body.seats, cur.seats) : sku?.seats ?? cur.seats
    const amountMils = 'amount' in body ? amountMilsOf(body.amount, cur.amountMils) : sku?.amountMils ?? cur.amountMils
    const bonusMils = 'bonusTokens' in body ? bonusMilsOf(body.bonusTokens, cur.bonusMils) : sku?.bonusMils ?? cur.bonusMils
    const startAt = 'startAt' in body ? dateMsOf(body.startAt, cur.startAt) : cur.startAt
    const endAt = 'endAt' in body && body.endAt ? dateMsOf(body.endAt) : endOfPeriod(startAt, period)
    if (endAt <= startAt) throw new HttpError(400, '结束时间必须晚于开始时间')
    const payStatus = payStatusOf(body.payStatus, cur.payStatus)
    const { order, invoice } = await db.tx(async () => {
      const order = await db.updatePlanOrder(cur.id, {
        companyId: company.id, planId, planName, planNameEn, period, seats, amountMils, bonusMils, startAt, endAt, payStatus,
      })
      if (!order) throw new HttpError(404, '订单不存在')
      const invoice = await syncInvoiceOfOrder(db, order)
      // 换公司时两边都要拉齐：老东家少了一条订单，新东家多了一条。
      if (cur.companyId !== company.id) await db.syncPlanFromOrders(cur.companyId)
      await db.syncPlanFromOrders(company.id)
      return { order, invoice }
    })
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'platform.order.update',
      detail: { id: order.id, planId, planName, period, seats, amountMils, bonusMils, payStatus },
    })
    send(res, 200, { order: publicPlanOrder(order, company), invoice: publicInvoice(invoice) })
  })

  /**
   * 充值记录只由充值单付款开出来，没有单独的「加一笔」接口——
   * 有了就等于两条路能改余额，对不上账时说不清是谁加的。
   */
  /** 某家公司的充值明细 + 两笔余额。公司管理员看得到自己家的。 */
  router.get('/orgs/:id/topups', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const rows = await db.topupsOfCompany(company.id)
    // 操作人是平台这边的人，一条一条查太碎，先按 id 去重再一次取回来。
    const actors = new Map(
      (await Promise.all([...new Set(rows.map((r) => r.createdBy).filter(Boolean))].map((id) => db.account(id as string))))
        .filter(Boolean)
        .map((a) => [a!.id, a!]),
    )
    send(res, 200, {
      topups: rows.map((r) => publicTopup(r, company, r.createdBy ? actors.get(r.createdBy) : undefined)),
      balance: await balanceOf(db, company.id),
    })
  })

  router.get('/platform/orgs/:id/machine', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const loads = await machineLoads(db, company.id)
    const botLatest = (await db.latestBotRelease('bot'))?.version ?? null
    const managerLatest = (await db.latestBotRelease('manager'))?.version ?? null
    // 编号按登记先后给，和 machinesOfCompany 的排序是同一个（order by createdAt）。
    const machines = await Promise.all(
      loads.map((l, i) => machineCard(db, l, { botLatest, managerLatest }, i + 1)),
    )
    send(res, 200, {
      machines,
      botLatest,
      managerLatest,
      // **只算已配对的机器。** 没配对的那行提供不了任何账号位，把它的 maxAccounts
      // 计进去，界面就会声称有一批根本不存在的容量。
      capacity: {
        accounts: machines.reduce((n, m) => n + m.accounts, 0),
        max: machines.filter((m) => m.machine.paired).reduce((n, m) => n + m.maxAccounts, 0),
        machines: machines.filter((m) => m.machine.paired).length,
      },
      // 老界面读的是单个 machine，多机之后留一个「默认那台」兼容。取公司指定的那台，
      // 不是列表里的第一台——两者在多机时会分叉，而调用方以为拿到的是「这家公司的
      // 机器」。
      machine: (machines.find((m) => m.machine.id === company.machineId) ?? machines[0])?.machine ?? null,
    })
  })

  /**
   * 平台端看机器上的日志：不带 seatId 是**管家自己**的，带了是那个席位上 bot 的。
   *
   * 两者回答的问题不一样，缺一不可：部署失败、升级卡住、配对回拨不通只写在管家的
   * journal 里；某一轮为什么不结束只写在 bot 的。
   *
   * **走审计。** 席位的日志里有员工的对话正文和 bot 执行过的命令——这和「看别人的
   * 屏幕」是同一类动作，那条已经在审计里了，这条没有理由例外。
   *
   * seatId 必须是**这台机器上**的：它会进 systemd 单元名，不能拿别处的值来拼。
   */
  router.get('/platform/orgs/:id/machines/:machineId/logs', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const machine = await machineOfOrg(db, company.id, req.params.machineId)
    if (!machine?.host) throw new HttpError(503, INSTANCE_DOWN)
    const seatId = (req.query.get('seatId') || '').trim()
    if (seatId) {
      const rows = await db.seatRuntimesOfMachine(machine.id)
      if (!rows.some((r) => r.seatId === seatId)) throw new HttpError(404, '这台机器上没有这个席位')
    }
    const lines = Math.min(2000, Math.max(1, Math.trunc(Number(req.query.get('lines')) || 200)))
    const follow = req.query.get('follow') === '1'
    const base = machineBase(machine.host)
    const path = seatId ? `/seats/${encodeURIComponent(seatId)}/logs` : '/logs'
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'machine.logs',
      detail: { machineId: machine.id, seatId: seatId || null, follow },
    })
    const url = `${base}${path}?lines=${lines}${follow ? '&follow=1' : ''}`
    if (follow) await proxySse(req, res, url, undefined, machine.token || undefined)
    else await proxyJson(res, 'GET', url, undefined, undefined, machine.token || undefined)
  })

  /**
   * 移除一台机器的登记。
   *
   * **只是从 Gateway 上抹掉这条记录**，不碰机器本身——那上面的管家还跑着，要停得
   * 上去停。有席位就拒绝：删掉之后那些席位会指向一台不存在的机器，聊天和桌面都会
   * 打到空处，而且再也找不回来是哪台。
   */
  router.delete('/platform/orgs/:id/machines/:machineId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const machine = await machineOfOrg(db, company.id, req.params.machineId)
    const seats = await db.seatRuntimesOfMachine(machine.id)
    if (seats.length) throw new HttpError(409, `这台机器上还有 ${seats.length} 个席位，先把它们拆掉`)
    await db.deleteMachine(machine.id)
    if (company.machineId === machine.id) {
      const rest = await db.machinesOfCompany(company.id)
      await db.updateCompany(company.id, { machineId: rest[0]?.id ?? null })
    }
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'machine.remove',
      detail: { machineId: machine.id, host: machine.host },
    })
    send(res, 200, { ok: true })
  })

  /** 改一台机器的账号容量。调小到低于当前占用不拦——已经在上面的账号不会被赶走。 */
  router.put('/platform/orgs/:id/machines/:machineId/capacity', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const machine = await machineOfOrg(db, req.params.id, req.params.machineId)
    const maxAccounts = intField(bodyOf(req), 'maxAccounts')
    if (maxAccounts == null || maxAccounts < 1 || maxAccounts > 1000) {
      throw new HttpError(400, 'maxAccounts 须为 1–1000')
    }
    const next = await db.updateMachine(machine.id, { maxAccounts })
    await db.audit({
      companyId: req.params.id,
      accountId: account.id,
      action: 'machine.capacity',
      detail: { machineId: machine.id, maxAccounts },
    })
    send(res, 200, { machine: ownerMachine(next) })
  })

  /**
   * 设这台机器的时区。
   *
   * **只是把期望值钉在这里**，真正 `timedatectl set-timezone` 的是机器上的管家——
   * 和钉管家版本一条路：Gateway 没有登录这台机器的凭据，能做的只有在心跳响应里
   * 把期望值带下去，机器自己去收敛。所以按下之后 `pending` 为真，直到下一轮心跳
   * 自报的实际时区和它对上。
   *
   * 传空串 = 不再管这台机器的时区（不会把机器改回去，只是不再下发）。
   */
  router.put('/platform/orgs/:id/machines/:machineId/timezone', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const machine = await machineOfOrg(db, req.params.id, req.params.machineId)
    const timezone = normalizeTimezone(strField(bodyOf(req), 'timezone', false))
    if (timezone === undefined) throw new HttpError(400, '不认识这个时区，要填 IANA 名，例如 Asia/Shanghai')
    const next = await db.updateMachine(machine.id, { timezone })
    await db.audit({
      companyId: req.params.id,
      accountId: account.id,
      action: 'machine.timezone',
      detail: { machineId: machine.id, timezone },
    })
    send(res, 200, {
      machine: ownerMachine(next),
      // 说清楚这一步只是下了指令：机器还没心跳回来之前，界面别显示成「已生效」。
      pending: Boolean(timezone) && next.currentTimezone !== timezone,
    })
  })

  /**
   * 把这台机器（或这家公司的席位）升到某个版本。
   *
   * 管家和 bot 是两件事，所以两个按钮：
   *
   * - `kind: 'manager'` 只是**钉一个期望版本**到这台机器上。真正换版由机器自己在
   *   下一轮心跳里做——它要挑不忙的时候、要自检、失败要回滚，这些只有机器上做得了。
   * - `kind: 'bot'` 走已有的批量重部署，逐个席位推过去。
   */
  router.post('/platform/orgs/:id/machines/:machineId/upgrade', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const machine = await machineOfOrg(db, company.id, req.params.machineId)
    if (!machinePaired(machine)) throw new HttpError(409, '这台机器还没有配对')
    const body = bodyOf(req)
    const requested = strField(body, 'version', false)
    const rel = requested
      ? await db.botRelease(parseBotVersion(requested), 'manager')
      : await db.latestBotRelease('manager')
    if (!rel) throw new HttpError(requested ? 404 : 409, requested ? '没有这个管家版本' : '还没有发布管家版本')
    const next = await db.updateMachine(machine.id, { desiredManagerVersion: rel.version })
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'machine.upgrade',
      detail: { machineId: machine.id, version: rel.version },
    })
    send(res, 200, {
      machine: ownerMachine(next),
      version: rel.version,
      // 说清楚这一步只是下了指令：界面上别显示成「已升级」。
      pending: next.managerVersion !== rel.version,
    })
  })

  /**
   * 改机器地址。**只改地址，没有任何凭据字段**——机器的身份是配对时签发的 `smt_`，
   * 不是这里填进去的东西。换 IP、换端口时用它；换机器请重新配对。
   */
  router.put('/platform/orgs/:id/machine', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const raw = strField(body, 'host', false)
    const wanted = strField(body, 'machineId', false)
    const cur = wanted ? await machineOfOrg(db, company.id, wanted) : await companyMachineOf(db, company.id)
    if (!cur) throw new HttpError(409, '这家公司还没有配对过机器，请先生成配对码')
    if (!raw) throw new HttpError(400, 'host 不能为空')
    const host = managerHostOf(raw)
    const machine = await db.tx(async () => {
      const row = await db.updateMachine(cur.id, { host, lastError: null })
      if (company.machineId !== row.id) {
        await db.updateCompany(company.id, {
          machineId: row.id,
          accessUrl: company.accessUrl ?? accessUrlFor(company.slug),
        })
      }
      await db.audit({ companyId: company.id, accountId: account.id, action: 'machine.update', detail: { host } })
      return row
    })
    const probe = await managerHealth(host, { token: machine.token })
    send(res, 200, { machine: ownerMachine(machine), reachable: probe.ok, error: probe.error ?? null })
  })

  /**
   * 生成配对码。装机时贴给安装脚本，它拿去换这台机器的 `smt_`。
   *
   * 一家公司同时只该有一张有效的票，所以先把之前没用掉的作废掉——桌上躺着两张
   * 都能用的码，谁也说不清哪台机器是拿哪张进来的。
   */
  router.post('/platform/orgs/:id/pairing-code', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const now = Date.now()
    await db.expireMachinePairings(company.id, now)
    const row = await db.insertMachinePairing({
      code: randomPairingCode(),
      companyId: company.id,
      createdBy: account.id,
      createdAt: now,
      expiresAt: now + PAIRING_TTL,
      usedAt: null,
      machineId: null,
    })
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'machine.pairing-code',
      detail: { expiresAt: row.expiresAt },
    })
    send(res, 201, {
      code: row.code,
      expiresAt: row.expiresAt,
      installCommand: installCommandFor(req, row.code),
    })
  })

  // ── 平台侧的机器管理。──────────────────────────────────────────────
  //
  // 上面那一组是「**这家公司**的机器」，进得去的前提是先挑一家公司。平台这一侧要
  // 答的是另一个问题：**这台 Gateway 上现在挂着哪些机器、哪台出事了**。两者的差别
  // 不只是入口——没派给任何公司的机器（刚配对完还没分、原公司被删之后落单的）在
  // 按公司列的那条路上**永远列不出来**，而它们恰恰最需要被人看见。
  //
  // 所以这一组路由一律以 machineId 为主键，不带 orgId；公司只是机器上的一个属性。

  /** 取一台机器，不问归属。跨公司在这一侧不是越权——owner 本来就管着全部。 */
  async function machineOr404(id: string): Promise<Machine> {
    const machine = await db.machine(id)
    if (!machine) throw new HttpError(404, '没有这台机器')
    return machine
  }

  /**
   * 平台侧的一张机器卡：`machineCard` 那一套，外加归属公司。
   *
   * 编号（「几号机」）在这里是 null：那个短号是**一家公司内部**数出来的，平台这一
   * 侧把两家公司的机器摆在一张表里，两个「1 号机」并排会指代不清。这里认 id。
   */
  async function platformMachineCard(load: MachineLoad, latest: { botLatest: string | null; managerLatest: string | null }) {
    // 不要 machineCard 那份席位清单：列表页只画汇总，详情页在下面自己重建一份更全的
    // 盖上去。带着它等于每台机器白跑一轮按席位的账号查询。
    const card = await machineCard(db, load, latest, 0, { seatList: false })
    const company = load.machine.companyId ? await db.company(load.machine.companyId) : undefined
    return {
      ...card,
      no: null,
      company: company ? { id: company.id, name: company.name, slug: company.slug, status: company.status } : null,
    }
  }

  async function releaseLatest() {
    return {
      botLatest: (await db.latestBotRelease('bot'))?.version ?? null,
      managerLatest: (await db.latestBotRelease('manager'))?.version ?? null,
    }
  }

  /**
   * 机器上的操作写审计。
   *
   * **没派给公司的机器写不进去**：`audit_events.companyId` 是 not null，而审计是按
   * 公司分档看的，塞一个假 id 进去只会污染某家公司的账。这种机器上的动作只在
   * Gateway 日志里留痕——它们还没有归属，也就没有该看到这条记录的人。
   */
  async function auditMachine(machine: Machine, accountId: string, action: string, detail: unknown) {
    if (!machine.companyId) return
    await db.audit({ companyId: machine.companyId, accountId, action, detail })
  }

  /**
   * 席位行 + 人名和 Bot 名。
   *
   * 详情页的席位表是这一页的正题，出事时要看得见**是谁的、哪个槽位、上次部署报了
   * 什么**，所以列比 `listSeatRuntime` 多。
   *
   * Bot 名由这里给，不留给前端查：前端那份 `state.bots` 是别的页面（公司详情、Bot
   * 名录）顺带装进去的，机器详情页从不加载它——靠它的话，直接打开 /machines/:id
   * 时整列会是一串 uuid，而先逛过某家公司再进来又变成名字，同一页两种结果。
   *
   * 账号和 Bot 都**按 id 去重后各查一次**：一个员工在同一台机器上常有好几个席位。
   */
  async function withSeatNames(rows: SeatRuntime[]) {
    const accounts = new Map<string, Account | undefined>()
    for (const id of new Set(rows.map((r) => r.accountId))) accounts.set(id, await db.account(id))
    const bots = new Map<string, CatalogItem | undefined>()
    for (const id of new Set(rows.map((r) => r.botId))) bots.set(id, await db.catalog(id))
    return rows.map((r) => {
      const who = accounts.get(r.accountId)
      return {
        accountId: r.accountId,
        who: who?.email ?? r.accountId,
        whoName: who?.name || null,
        botId: r.botId,
        // Bot 被删掉之后席位还在（拆席位是另一件事），名字就没了——退回 id，
        // 至少还指得出是哪一个。
        botName: bots.get(r.botId)?.name || null,
        seatId: r.seatId,
        linuxUser: r.linuxUser,
        slot: r.slot,
        status: r.status,
        botVersion: r.botVersion ?? null,
        lastError: r.lastError,
        deployedAt: r.deployedAt,
      }
    })
  }

  /** 平台上所有机器。列表页一次拉齐，不分页——机器是几十台的量级，不是几万条。 */
  router.get('/platform/machines', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const latest = await releaseLatest()
    const rows = await db.allMachines()
    const machines = await Promise.all(
      rows.map(async (m) => platformMachineCard(await machineLoadOf(db, m), latest)),
    )
    send(res, 200, {
      machines,
      ...latest,
      // 只把已配对的机器算进容量：没配对那行提供不了任何账号位，计进去就是在报一批
      // 根本不存在的余量。在线台数另算，它答的是「现在有多少台真的在」。
      totals: {
        machines: machines.length,
        paired: machines.filter((m) => m.machine.paired).length,
        online: machines.filter((m) => m.machine.link === 'online').length,
        accounts: machines.reduce((n, m) => n + m.accounts, 0),
        max: machines.filter((m) => m.machine.paired).reduce((n, m) => n + m.maxAccounts, 0),
        seats: machines.reduce((n, m) => n + m.seats, 0),
      },
    })
  })

  /**
   * 一台机器的详情。
   *
   * 顺带把公司清单给出去——详情页要能改这台机器的归属，而那个下拉总不能让人手打
   * 公司 id。清单只有 id / 名字 / slug，没有别的。
   */
  router.get('/platform/machines/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const machine = await machineOr404(req.params.id)
    const latest = await releaseLatest()
    const load = await machineLoadOf(db, machine)
    const card = await platformMachineCard(load, latest)
    // 席位清单用的键名就是 `seatList`，和 machineCard 那份同名同义（这里是它的超集），
    // 不另起一个。
    //
    // **不叫 `seats`**：那个键是席位**数**，撞上就出过事——详情页的「席位 2」画成了
    // `[object Object],[object Object]`，而 `card.seats ?` 这类判断也跟着翻（空数组是
    // 真值），一台一个席位都没有的机器会被判成「还有席位，改不了归属」。
    //
    // 账号和 Bot 名字**按 id 去重后各查一次**：一个员工在同一台机器上往往有好几个
    // 席位，逐行查等于把同一行数据反复取回来。
    const seatList = await withSeatNames(load.seatRows)
    const companies = (await db.companies()).map((c) => ({ id: c.id, name: c.name, slug: c.slug }))
    send(res, 200, { ...card, ...latest, seatList, companies })
  })

  /**
   * 改机器地址。和公司侧那条同义：**只改地址，没有任何凭据字段**——机器的身份是
   * 配对时签发的 `smt_`。换 IP、换端口用它；换机器请重新配对。
   */
  router.put('/platform/machines/:id/host', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const machine = await machineOr404(req.params.id)
    const raw = strField(bodyOf(req), 'host', false)
    if (!raw) throw new HttpError(400, 'host 不能为空')
    const host = managerHostOf(raw)
    const next = await db.updateMachine(machine.id, { host, lastError: null })
    await auditMachine(next, account.id, 'machine.update', { machineId: next.id, host })
    // 存下来还不够：地址写错了要当场知道，不能等到第一次部署。
    const probe = await managerHealth(host, { token: next.token })
    send(res, 200, { machine: ownerMachine(next), reachable: probe.ok, error: probe.error ?? null })
  })

  /** 改账号容量。调小到低于当前占用不拦——已经在上面的账号不会被赶走。 */
  router.put('/platform/machines/:id/capacity', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const machine = await machineOr404(req.params.id)
    const maxAccounts = intField(bodyOf(req), 'maxAccounts')
    if (maxAccounts == null || maxAccounts < 1 || maxAccounts > 1000) {
      throw new HttpError(400, 'maxAccounts 须为 1–1000')
    }
    const next = await db.updateMachine(machine.id, { maxAccounts })
    await auditMachine(next, account.id, 'machine.capacity', { machineId: next.id, maxAccounts })
    send(res, 200, { machine: ownerMachine(next) })
  })

  /** 设时区。只是把期望值钉在这里，真正改的是机器上的管家，下一轮心跳才知道成没成。 */
  router.put('/platform/machines/:id/timezone', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const machine = await machineOr404(req.params.id)
    const timezone = normalizeTimezone(strField(bodyOf(req), 'timezone', false))
    if (timezone === undefined) throw new HttpError(400, '不认识这个时区，要填 IANA 名，例如 Asia/Shanghai')
    const next = await db.updateMachine(machine.id, { timezone })
    await auditMachine(next, account.id, 'machine.timezone', { machineId: next.id, timezone })
    send(res, 200, { machine: ownerMachine(next), pending: Boolean(timezone) && next.currentTimezone !== timezone })
  })

  /** 钉一个管家版本。换版、自检、失败回滚都在机器上做，这里只下指令。 */
  router.post('/platform/machines/:id/upgrade', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const machine = await machineOr404(req.params.id)
    if (!machinePaired(machine)) throw new HttpError(409, '这台机器还没有配对')
    const requested = strField(bodyOf(req), 'version', false)
    const rel = requested
      ? await db.botRelease(parseBotVersion(requested), 'manager')
      : await db.latestBotRelease('manager')
    if (!rel) throw new HttpError(requested ? 404 : 409, requested ? '没有这个管家版本' : '还没有发布管家版本')
    const next = await db.updateMachine(machine.id, { desiredManagerVersion: rel.version })
    await auditMachine(next, account.id, 'machine.upgrade', { machineId: next.id, version: rel.version })
    send(res, 200, { machine: ownerMachine(next), version: rel.version, pending: next.managerVersion !== rel.version })
  })

  /**
   * 把**这台机器上**的席位统统重铺到某个 bot 版本。
   *
   * 和公司侧那条 `runtime/update` 是两个口径，两个都要有：公司侧答的是「让这家公司
   * 的人都用上新版」，这一条答的是「这台机器上的东西都是新的」——排查一台机器时，
   * 按公司升级会连带动到别的机器上的席位，那不是这时候想要的。
   *
   * 逐个席位串着推：部署要在机器上解包、建目录、起 systemd，并发推一台机器只会
   * 让它更慢，还把失败搅在一起看不清是哪一个。
   */
  router.post('/platform/machines/:id/runtime/update', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const machine = await machineOr404(req.params.id)
    const requested = strField(bodyOf(req), 'version', false)
    let version: string
    if (requested) {
      parseBotVersion(requested)
      const rel = await db.botRelease(requested)
      if (!rel) throw new HttpError(404, '没有这个 Bot 版本')
      version = rel.version
    } else {
      const latest = await db.latestBotRelease()
      if (!latest) throw new HttpError(409, '还没有发布 Bot 版本')
      version = latest.version
    }
    const seats = (await db.seatRuntimesOfMachine(machine.id)).filter((r) => r.status !== 'none')
    const results: { accountId: string; botId: string; status: string; botVersion: string | null; error?: string }[] = []
    for (const seat of seats) {
      const row = await db.account(seat.accountId)
      if (!row) {
        results.push({
          accountId: seat.accountId,
          botId: seat.botId,
          status: seat.status,
          botVersion: seat.botVersion ?? null,
          error: '账号不存在',
        })
        continue
      }
      const out = await deploySeat(db, keys, row, { botId: seat.botId, version, update: true })
      results.push(
        out.ok
          ? {
              accountId: row.id,
              botId: seat.botId,
              status: out.result.runtime.status,
              botVersion: out.result.runtime.botVersion ?? null,
            }
          : {
              accountId: row.id,
              botId: seat.botId,
              status: out.runtime?.status ?? 'error',
              botVersion: out.runtime?.botVersion ?? null,
              error: out.error,
            },
      )
    }
    await auditMachine(machine, account.id, 'runtime.update', {
      machineId: machine.id,
      version,
      count: results.length,
    })
    send(res, 200, { version, results })
  })

  /**
   * 改这台机器的归属公司。传空 = 收回，让它变成一台待分配的机器。
   *
   * **有席位就拒绝。** 席位是按公司建的账号和目录，改归属并不会把它们搬走，只会让
   * 一台 A 公司的机器名义上属于 B 公司，而上面跑着 A 的人——那时谁看到谁的桌面就
   * 说不清了。要改归属，先把席位拆干净。
   */
  router.put('/platform/machines/:id/company', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const machine = await machineOr404(req.params.id)
    const wanted = strField(bodyOf(req), 'companyId', false)
    const target = wanted ? await db.company(wanted) : undefined
    if (wanted && !target) throw new HttpError(404, '公司不存在')
    const nextCompanyId = target?.id ?? null
    if (nextCompanyId === machine.companyId) {
      send(res, 200, { machine: ownerMachine(machine) })
      return
    }
    const seats = await db.seatRuntimesOfMachine(machine.id)
    if (seats.length) throw new HttpError(409, `这台机器上还有 ${seats.length} 个席位，先把它们拆掉再改归属`)
    const next = await db.tx(async () => {
      const row = await db.updateMachine(machine.id, { companyId: nextCompanyId })
      // 老东家把它当默认机器的话，得改指向别处——留着一个指向别人家机器的
      // companies.machineId，部署会一路打到不该去的地方。
      if (machine.companyId) {
        const prev = await db.company(machine.companyId)
        if (prev?.machineId === machine.id) {
          const rest = (await db.machinesOfCompany(prev.id)).filter((m) => m.id !== machine.id)
          await db.updateCompany(prev.id, { machineId: rest[0]?.id ?? null })
        }
      }
      // 新东家一台都没有的话，这台就是它的默认机器。已经有默认的就不动——默认那台
      // 是它自己挑的，不该被一次「加一台」悄悄换掉。
      //
      // accessUrl 跟着一起补：另外三条把机器挂到公司名下的路（配对回拨、公司认领、
      // 平台改地址）都会顺手补上它，漏了这一条的话，一家从没配过机器的公司在这里
      // 被指派了机器、却在自己的详情页上看到一个空的「访问地址」。
      if (target && !target.machineId) {
        await db.updateCompany(target.id, {
          machineId: row.id,
          accessUrl: target.accessUrl ?? accessUrlFor(target.slug),
        })
      }
      return row
    })
    if (machine.companyId) {
      await db.audit({
        companyId: machine.companyId,
        accountId: account.id,
        action: 'machine.unassign',
        detail: { machineId: machine.id, to: nextCompanyId },
      })
    }
    await auditMachine(next, account.id, 'machine.assign', { machineId: next.id, from: machine.companyId })
    send(res, 200, { machine: ownerMachine(next) })
  })

  /**
   * 看这台机器上的日志：不带 seatId 是**管家自己**的，带了是那个席位上 bot 的。
   *
   * 走审计，理由和公司侧那条一样：席位的日志里有员工的对话正文和 bot 执行过的命令。
   */
  router.get('/platform/machines/:id/logs', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const machine = await machineOr404(req.params.id)
    if (!machine.host) throw new HttpError(503, INSTANCE_DOWN)
    const seatId = (req.query.get('seatId') || '').trim()
    if (seatId) {
      const rows = await db.seatRuntimesOfMachine(machine.id)
      if (!rows.some((r) => r.seatId === seatId)) throw new HttpError(404, '这台机器上没有这个席位')
    }
    const lines = Math.min(2000, Math.max(1, Math.trunc(Number(req.query.get('lines')) || 200)))
    const follow = req.query.get('follow') === '1'
    const path = seatId ? `/seats/${encodeURIComponent(seatId)}/logs` : '/logs'
    await auditMachine(machine, account.id, 'machine.logs', { machineId: machine.id, seatId: seatId || null, follow })
    const url = `${machineBase(machine.host)}${path}?lines=${lines}${follow ? '&follow=1' : ''}`
    if (follow) await proxySse(req, res, url, undefined, machine.token || undefined)
    else await proxyJson(res, 'GET', url, undefined, undefined, machine.token || undefined)
  })

  /**
   * 移除一台机器的登记。**只是从 Gateway 上抹掉这条记录**，不碰机器本身——上面的
   * 管家还跑着，要停得上去停。有席位就拒绝：删掉之后那些席位会指向一台不存在的
   * 机器，聊天和桌面都会打到空处，而且再也查不出是哪一台。
   */
  router.delete('/platform/machines/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const machine = await machineOr404(req.params.id)
    const seats = await db.seatRuntimesOfMachine(machine.id)
    if (seats.length) throw new HttpError(409, `这台机器上还有 ${seats.length} 个席位，先把它们拆掉`)
    await db.deleteMachine(machine.id)
    if (machine.companyId) {
      const company = await db.company(machine.companyId)
      if (company?.machineId === machine.id) {
        const rest = await db.machinesOfCompany(company.id)
        await db.updateCompany(company.id, { machineId: rest[0]?.id ?? null })
      }
    }
    await auditMachine(machine, account.id, 'machine.remove', { machineId: machine.id, host: machine.host })
    send(res, 200, { ok: true })
  })

  // 读发布列表跟上传同一套凭证：CI 传完要能回查，人在发布页看的是同一份数据。
  // 这里没有秘密——版本号、sha256、大小、说明。
  router.get('/platform/bot-releases', async (req, res) => {
    await requireReleaseAuthor(req, db, keys)
    const releases = await db.botReleases()
    send(res, 200, {
      releases: releases.map((r) => publicBotRelease(r, gatewayBaseFor(req))),
      latest: releases[0]?.version ?? null,
    })
  })

  router.get('/platform/bot-releases/:version', async (req, res) => {
    await requireReleaseAuthor(req, db, keys)
    const row = await db.botRelease(req.params.version)
    if (!row) throw new HttpError(404, '没有这个 Bot 版本')
    send(res, 200, { release: publicBotRelease(row, gatewayBaseFor(req)) })
  })

  /**
   * 上传发布包。body 就是 tgz 本身，不解析成 JSON（`putRaw`）。
   *
   *   curl -sf -X PUT "$GW/platform/bot-releases/1.2.3+abc1234?note=nightly" \
   *     -H "Authorization: Bearer $GATEWAY_PLATFORM_TOKEN" \
   *     -H "X-Bot-Sha256: $(shasum -a 256 bot.tgz | cut -d' ' -f1)" \
   *     --data-binary @bot.tgz
   */
  router.putRaw('/platform/bot-releases/:version', async (req, res) => {
    const accountId = await requireReleaseAuthor(req, db, keys)
    const version = parseBotVersion(req.params.version)
    const note = (req.query.get('note') || '').trim()
    const sha256 = String(req.headers['x-bot-sha256'] || '').trim()
    const release = await storeUploadedRelease(db, { version, note, body: req, sha256 })
    await db.audit({
      companyId: '',
      accountId: accountId || null,
      action: 'bot-release.upload',
      detail: { version: release.version, sha256: release.sha256, size: release.size },
    })
    send(res, 200, { release: publicBotRelease(release, gatewayBaseFor(req)) })
  })

  /**
   * 替某个席位签一张桌面票。owner 的支持入口——员工那边打不开桌面时，不用去问
   * VNC 口令，也不用登机器。
   *
   * 走审计：这是「看别人的屏幕」，必须留痕。票只活五分钟。
   */
  router.get('/platform/desktop-ticket', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const seatId = (req.query.get('seatId') || '').trim()
    if (!seatId) throw new HttpError(400, 'seatId 不能为空')
    await db.audit({
      companyId: 'platform',
      accountId: account.id,
      action: 'desktop.ticket',
      detail: { seatId },
    })
    send(res, 200, { ticket: signDesktopTicket(keys, seatId) })
  })

  // ── 管家发布包。和 bot 那套同一个表、同一套校验，只是 kind 不同。──

  router.get('/platform/manager-releases', async (req, res) => {
    await requireReleaseAuthor(req, db, keys)
    const releases = await db.botReleases('manager')
    const settings = await db.platformSettings()
    send(res, 200, {
      releases: releases.map((r) => publicBotRelease(r, gatewayBaseFor(req))),
      latest: releases[0]?.version ?? null,
      // 空 = 跟最新走。机器按这个数字自己换版，改它就是发起一轮灰度。
      desired: settings.managerVersion ?? '',
      minNode: MIN_MANAGER_NODE,
      minProtocol: MIN_MANAGER_PROTOCOL,
    })
  })

  router.putRaw('/platform/manager-releases/:version', async (req, res) => {
    const accountId = await requireReleaseAuthor(req, db, keys)
    const version = parseBotVersion(req.params.version)
    const note = (req.query.get('note') || '').trim()
    const sha256 = String(req.headers['x-bot-sha256'] || '').trim()
    const release = await storeUploadedRelease(db, { version, note, body: req, sha256, kind: 'manager' })
    await db.audit({
      companyId: '',
      accountId: accountId || null,
      action: 'manager-release.upload',
      detail: { version: release.version, sha256: release.sha256, size: release.size },
    })
    send(res, 200, { release: publicBotRelease(release, gatewayBaseFor(req)) })
  })

  /**
   * 登记一个放在别处的发布包。界面上「新增版本」走这条。
   *
   * 和上传的区别只有字节存不存在 Gateway 上；校验一点没少（整包拉一遍比对 size 和
   * sha256、确认入口文件在），验不过不入库。
   */
  router.post('/platform/bot-releases', async (req, res) => {
    await requireReleaseAuthor(req, db, keys)
    send(res, 201, { release: publicBotRelease(await registerFromBody(db, req, 'bot'), gatewayBaseFor(req)) })
  })

  router.post('/platform/manager-releases', async (req, res) => {
    await requireReleaseAuthor(req, db, keys)
    send(res, 201, { release: publicBotRelease(await registerFromBody(db, req, 'manager'), gatewayBaseFor(req)) })
  })

  /**
   * 装机脚本。**公开**——它不含任何秘密，配对码是装机的人从命令行传进去的。
   *
   * 脚本里的 Gateway 地址按请求的 Host 填好，所以复制粘贴那条命令就能跑，不用再
   * 让人手填一遍地址（填错地址是这一步最常见的事故）。
   */
  router.get('/install-manager.sh', async (req, res) => {
    const script = installScript(gatewayBaseFor(req))
    res.writeHead(200, { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-store' })
    res.end(script)
  })

  /**
   * 装机脚本下载管家包。**凭配对码**——它还没有 `smt_`，那要配对之后才有。
   *
   * 码在这里只用来看「是不是一张有效的票」，不消费它：真正的认领在 /machines/pair。
   * 下错了包可以重来，认领错了要重新生成码。
   */
  router.get('/manager/release', async (req, res) => {
    const code = normalizePairingCode(req.query.get('code') || '')
    const pairing = await db.machinePairing(code)
    if (!pairing || pairing.usedAt || pairing.expiresAt <= Date.now()) throw new HttpError(401, '配对码无效或已过期')
    const desired = await desiredManagerRelease(db)
    if (!desired) throw new HttpError(409, '还没有发布机器管家版本')
    await sendReleaseFile(res, 'manager', desired.version, db)
  })


  router.post('/platform/orgs/:id/runtime/update', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const requested = strField(body, 'version', false)
    let version: string
    if (requested) {
      parseBotVersion(requested)
      const rel = await db.botRelease(requested)
      if (!rel) throw new HttpError(404, '没有这个 Bot 版本')
      version = rel.version
    } else {
      const latest = await db.latestBotRelease()
      if (!latest) throw new HttpError(409, '还没有发布 Bot 版本')
      version = latest.version
    }
    const seats = (await db.seatRuntimesOf(company.id)).filter((r) => r.status !== 'none')
    const results: { accountId: string; botId: string; status: string; botVersion: string | null; error?: string }[] = []
    for (const seat of seats) {
      const row = await db.account(seat.accountId)
      if (!row) {
        results.push({
          accountId: seat.accountId,
          botId: seat.botId,
          status: seat.status,
          botVersion: seat.botVersion ?? null,
          error: '账号不存在',
        })
        continue
      }
      const out = await deploySeat(db, keys, row, { botId: seat.botId, version, update: true })
      if (out.ok) {
        results.push({
          accountId: row.id,
          botId: seat.botId,
          status: out.result.runtime.status,
          botVersion: out.result.runtime.botVersion ?? null,
        })
      } else {
        results.push({
          accountId: row.id,
          botId: seat.botId,
          status: out.runtime?.status ?? 'error',
          botVersion: out.runtime?.botVersion ?? null,
          error: out.error,
        })
      }
    }
    await db.audit({
      companyId: company.id,
      accountId: actor.id,
      action: 'runtime.update',
      detail: { version, count: results.length },
    })
    send(res, 200, { version, results })
  })

  router.get('/platform/orgs/:id/accounts/:accountId/runtime', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== company.id) throw new HttpError(404, '账号不存在')
    const machine = await companyMachineOf(db, company.id)
    const hostOf = machineHostResolver(db)
    const botId = (req.query.get('botId') || '').trim()
    if (botId) {
      const runtime = await db.seatRuntime(row.id, botId)
      if (!runtime) throw new HttpError(404, '还没有部署')
      send(res, 200, { runtimes: [publicSeatRuntime(runtime, await hostOf(runtime), { includePassword: true })] })
      return
    }
    const runtimes = await Promise.all(
      (await db.seatRuntimesOfAccount(row.id)).map(async (rt) =>
        publicSeatRuntime(rt, await hostOf(rt), { includePassword: true }),
      ),
    )
    send(res, 200, { runtimes })
  })

  // ── 公司 ────────────────────────────────────────────────────────────

  router.get('/orgs/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const plan = (await db.plan(company.id))!
    send(res, 200, {
      company: publicCompany(company),
      plan: await publicPlan(db, plan, await db.accountCount(company.id)),
      // 套餐赠送和单独充值分开报，界面上也分开显示——两者的有效期规矩不一样。
      balance: await balanceOf(db, company.id),
    })
  })

  router.patch('/orgs/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const patch: {
      name?: string
      slug?: string
      status?: CompanyStatus
      contactName?: string
      contactPhone?: string
      contactEmail?: string
      address?: string
      website?: string
      machineId?: string | null
      accessUrl?: string | null
    } = {}
    if (body.name != null) patch.name = strField(body, 'name')
    if (body.status != null) {
      // 停用是把整家公司关在门外，公司管理员不能自己停自己——停完谁也开不回来。
      requireOwner(account)
      patch.status = companyStatusOf(body.status)
    }
    if (body.contactName != null) patch.contactName = strField(body, 'contactName')
    if (body.contactPhone != null) patch.contactPhone = phoneOf(strField(body, 'contactPhone'))
    if (body.contactEmail != null) patch.contactEmail = emailOf(strField(body, 'contactEmail'))
    // 地址和网站可以清空，空串就是清空。
    if (body.address !== undefined) patch.address = strField(body, 'address', false)
    if (body.website !== undefined) patch.website = websiteOf(strField(body, 'website', false))
    if (body.accessUrl !== undefined) {
      if (body.accessUrl === null || body.accessUrl === '') patch.accessUrl = null
      else patch.accessUrl = strField(body, 'accessUrl')
    }
    if (body.slug != null) {
      patch.slug = slugOf(strField(body, 'slug'))
      if (patch.slug !== company.slug && await db.companyBySlug(patch.slug)) throw new HttpError(409, '这个 slug 已被占用')
    }
    if (body.machineId !== undefined) {
      if (body.machineId === null || body.machineId === '') {
        const prev = company.machineId
        if (prev) await db.updateMachine(prev, { companyId: null })
        patch.machineId = null
      } else {
        const machineId = strField(body, 'machineId')
        const machine = await db.machine(machineId)
        if (!machine) throw new HttpError(404, '机器不存在')
        if (machine.companyId && machine.companyId !== company.id) throw new HttpError(409, '这台机器已经派给别的公司')
        if (company.machineId && company.machineId !== machine.id) await db.updateMachine(company.machineId, { companyId: null })
        await db.updateMachine(machine.id, { companyId: company.id })
        patch.machineId = machine.id
        // 派机器时写入访问地址。换机器只改解析，地址按 slug 保持。
        const slug = patch.slug ?? company.slug
        patch.accessUrl = company.accessUrl && !(body.slug != null && patch.slug !== company.slug) ? company.accessUrl : accessUrlFor(slug)
      }
    }
    if (patch.slug && patch.slug !== company.slug && (company.accessUrl || patch.machineId || company.machineId)) {
      patch.accessUrl = accessUrlFor(patch.slug)
    }
    const next = await db.updateCompany(company.id, patch)
    await db.audit({ companyId: company.id, accountId: account.id, action: 'org.update', detail: patch })
    send(res, 200, { company: publicCompany(next) })
  })

  router.delete('/orgs/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    // 删公司是**硬删**：账号、审计、发票、订单、充值、用量一起没。这不是公司管理员
    // 该有的权限——「停用」才是公司层面的动作，而且那条已经是 owner-only 了；删除比
    // 停用更不可逆，权限却更松，是说不通的。
    requireOwner(account)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    // 账单**和用量**都要留档，硬删和留档直接冲突：有过任何一条的公司只能停用，不能删。
    // 用量算进来的代价是「发过一条消息的公司就删不掉了」——这是留档要求的必然结果，
    // 不是遗漏。要清理这类公司，走「停用」；真要腾库存得先有一套留存期到期后的归档
    // 流程，那是另一件事，不能靠这个接口顺手做掉。
    const footprint = await db.billingFootprint(company.id)
    const kept = footprint.invoices + footprint.orders + footprint.topups + footprint.llmCalls
    if (kept > 0) {
      throw new HttpError(409, '这家公司有账单或用量记录，必须留档；请改用「停用」而不是删除', footprint)
    }
    await db.tx(() => db.deleteCompany(company.id))
    // 审计写在事务**之后**：deleteCompany 会把这家公司的 audit_events 一起删掉，写在
    // 事务里等于白写。audit_events 没有指向 companies 的外键，公司没了这条也留得住。
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'org.delete',
      detail: { name: company.name, slug: company.slug },
    })
    send(res, 200, { deleted: true, id: company.id })
  })

  // ── 公司模型角色（日常 / utility）。不存密钥。──────────────────────

  router.get('/orgs/:id/settings', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    send(res, 200, publicSettings(await db.platformSettings()))
  })

  router.put('/orgs/:id/settings', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '日常和 utility 由系统管理员配置')
  })

  // ── 连通性探测。用公司密钥打一枪上游，永不回显 secret。────────────
  router.post('/orgs/:id/llm/test', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    let provider = ''
    let model = ''
    const role = body.role
    if (role === 'daily' || role === 'utility') {
      const cur = (await db.platformSettings())[role]
      if (!cur.provider || !cur.model) throw new HttpError(400, `${role === 'daily' ? '日常' : 'utility'} 模型还没设置`)
      provider = cur.provider
      model = cur.model
    } else {
      provider = strField(body, 'provider')
      model = strField(body, 'model', false)
      if (!model) {
        const cur = await db.platformSettings()
        if (cur.daily.provider === provider && cur.daily.model) model = cur.daily.model
        else if (cur.utility.provider === provider && cur.utility.model) model = cur.utility.model
        else model = await llm.firstModel(req.params.id, provider)
      }
      if (!model) throw new HttpError(400, '这个供应商没有可测的模型')
    }
    const result = await llm.probe(req.params.id, provider, model)
    if (!result.ok && result.error === '模型不在可见目录里') {
      throw new HttpError(404, result.error, { model: `${result.provider}/${result.model}` })
    }
    if (!result.ok && result.error?.startsWith('没有 ') && result.error.endsWith(' 的密钥')) {
      throw new HttpError(402, result.error, { provider: result.provider })
    }
    send(res, 200, result)
  })

  // ── 席位 / 账号 ─────────────────────────────────────────────────────

  router.get('/orgs/:id/accounts', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const plan = await db.plan(company.id)
    const machine = account.role === 'owner' ? await companyMachineOf(db, company.id) : undefined
    const runtimes = account.role === 'owner' ? await db.seatRuntimesOf(company.id) : []
    const byAccount = new Map<string, typeof runtimes>()
    for (const rt of runtimes) {
      const list = byAccount.get(rt.accountId) || []
      list.push(rt)
      byAccount.set(rt.accountId, list)
    }
    const hostOf = machineHostResolver(db)
    const members = await Promise.all(
      (await db.accountsOf(req.params.id)).map(async (row) => {
        const pub = publicAccount(row)
        if (account.role !== 'owner') return pub
        const list = byAccount.get(row.id) || []
        return { ...pub, runtimes: await Promise.all(list.map(async (rt) => listSeatRuntime(rt, await hostOf(rt)))) }
      }),
    )
    send(res, 200, {
      members,
      // 「全体成员」是算出来的，不落库：新人进来自动在里面。
      groups: [
        {
          id: 'all',
          builtin: true,
          name: '全体成员',
          desc: '所有已加入的成员，自动维护',
          icon: 'users',
          role: null,
          members: members.map((m) => m.id),
          agents: [],
          createdAt: members[0]?.createdAt ?? Date.now(),
        },
        ...(await db.groupsOf(company.id)).map(publicGroup),
      ],
      seats: { total: plan?.seats ?? 0, used: await db.accountCount(company.id) },
      me: publicAccount(account),
    })
  })

  router.post('/orgs/:id/accounts', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const password = strField(body, 'password')
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    const role = roleOf(body.role, 'member')
    const name = strField(body, 'name', false)
    if (await db.accountByEmail(email)) throw new HttpError(409, '这个邮箱已经注册')
    const passwordHash = await hashPassword(password)
    const created = await db.tx(async () => {
      await db.lockPlan(company.id)
      const plan = await db.plan(company.id)
      const used = await db.accountCount(company.id)
      const seats = plan?.seats ?? 0
      if (used >= seats) throw new HttpError(409, '席位已满', { seats, used })
      const row = await db.insertAccount({ companyId: company.id, email, passwordHash, role, name, status: 'active' })
      await db.audit({ companyId: company.id, accountId: actor.id, action: 'account.create', detail: { id: row.id, email, role } })
      return row
    })
    send(res, 201, { account: publicAccount(created) })
  })

  /**
   * 建号并发一条邀请链接。账号当场建出来（待接受），链接只负责让本人设口令。
   * 必须写在 /accounts/:accountId 前面，否则 members 会被当成 accountId。
   */
  router.post('/orgs/:id/accounts/members', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const name = strField(body, 'name', false)
    const role = roleOf(body.role, 'member')
    const days = Math.min(Math.max(Number(body.ttlDays) || 7, 1), 30)
    if (await db.accountByEmail(email)) throw new HttpError(409, '这个邮箱已经注册')
    const passwordHash = await hashPassword(randomUUID())
    const created = await db.tx(async () => {
      await db.lockPlan(company.id)
      const plan = await db.plan(company.id)
      const used = await db.accountCount(company.id)
      const seats = plan?.seats ?? 0
      if (used >= seats) throw new HttpError(409, '席位已满', { seats, used })
      const row = await db.insertAccount({
        companyId: company.id,
        email,
        passwordHash,
        role,
        name,
        status: 'invited',
      })
      const invite = await issueInvite(db, row, actor.id, days * 24 * 3600 * 1000)
      await db.audit({
        companyId: company.id,
        accountId: actor.id,
        action: 'account.invite',
        detail: { id: row.id, email, role, expiresAt: invite.expiresAt },
      })
      return { row, invite }
    })
    send(res, 201, {
      user: publicAccount(created.row),
      invite: { url: inviteLinkOf(req, created.invite.token), expiresAt: created.invite.expiresAt },
    })
  })

  /**
   * 分组。必须写在 /accounts/:accountId 前面，否则 groups 会被当成 accountId。
   * 默认角色只影响以后加进组的人，不改已有成员的账号角色。
   */
  router.post('/orgs/:id/accounts/groups', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new HttpError(400, '分组要有名字')
    const desc = typeof body.desc === 'string' ? body.desc.trim() : ''
    const icon = (typeof body.icon === 'string' && body.icon.trim()) || 'chat'
    const role = groupRoleOf(body.role)
    const members = await membersInCompany(db, company.id, body.members)
    const agents = stringIds(body.agents)
    const group = await db.insertGroup({ companyId: company.id, name, desc, icon, role, members, agents })
    await db.audit({ companyId: company.id, accountId: actor.id, action: 'group.create', detail: { id: group.id, name } })
    send(res, 201, { group: publicGroup(group) })
  })

  router.patch('/orgs/:id/accounts/groups/:groupId', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    if (req.params.groupId === 'all') throw new HttpError(400, '「全体成员」是系统固定分组')
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const cur = await db.group(req.params.groupId)
    if (!cur || cur.companyId !== company.id) throw new HttpError(404, '没有这个分组')
    const body = bodyOf(req)
    const patch: Partial<Pick<Group, 'name' | 'desc' | 'icon' | 'role' | 'members' | 'agents'>> = {}
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) throw new HttpError(400, '分组要有名字')
      patch.name = name
    }
    if (typeof body.desc === 'string') patch.desc = body.desc.trim()
    if (typeof body.icon === 'string' && body.icon.trim()) patch.icon = body.icon.trim()
    if (body.role === 'admin' || body.role === 'member') patch.role = body.role
    if (Array.isArray(body.members)) patch.members = await membersInCompany(db, company.id, body.members)
    if (Array.isArray(body.agents)) patch.agents = stringIds(body.agents)
    const group = await db.updateGroup(cur.id, patch)
    await db.audit({ companyId: company.id, accountId: actor.id, action: 'group.update', detail: { id: group.id } })
    send(res, 200, { group: publicGroup(group) })
  })

  router.delete('/orgs/:id/accounts/groups/:groupId', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    if (req.params.groupId === 'all') throw new HttpError(400, '「全体成员」是系统固定分组')
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const cur = await db.group(req.params.groupId)
    if (!cur || cur.companyId !== company.id) throw new HttpError(404, '没有这个分组')
    await db.deleteGroup(cur.id)
    await db.audit({ companyId: company.id, accountId: actor.id, action: 'group.delete', detail: { id: cur.id, name: cur.name } })
    send(res, 200, { ok: true })
  })

  router.get('/orgs/:id/accounts/:accountId', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    send(res, 200, { account: publicAccount(row) })
  })

  router.patch('/orgs/:id/accounts/:accountId', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    const body = bodyOf(req)
    if (row.id === actor.id && (body.role || body.status)) throw new HttpError(400, '不能改自己的角色或状态')
    const patch: { name?: string; role?: Role; status?: AccountStatus; tokenRevokedAt?: number | null } = {}
    if (body.name != null) {
      const name = strField(body, 'name')
      if (!name) throw new HttpError(400, 'name 不能为空')
      patch.name = name
    }
    if (body.role !== undefined && body.role !== '') patch.role = roleOf(body.role)
    if (body.status !== undefined && body.status !== '') patch.status = statusOf(body.status)
    const nextRole = patch.role ?? row.role
    const nextStatus = patch.status ?? row.status
    if (patch.status === 'invited' && row.status !== 'invited') {
      throw new HttpError(400, '已激活的账号不能退回待接受，需要重设口令请用重置链接')
    }
    if (patch.status === 'active' && row.status === 'invited') {
      throw new HttpError(400, '待接受的账号不能由管理员直接激活，对方需用邀请链接设置口令')
    }
    if (losingAdmin(row, nextRole, nextStatus) && await db.adminCount(row.companyId!) <= 1) {
      throw new HttpError(409, '至少要留一个管理员')
    }
    if (patch.status === 'disabled') patch.tokenRevokedAt = Date.now()
    // 停用的人重新激活会多占一个席位。满了就不让激活——先加席位，或者停掉别人。
    // 检查和写入放在同一个事务里，并先锁住套餐行，否则两个人同时激活会一起挤进来。
    const next = await db.tx(async () => {
      if (patch.status === 'active' && row.status === 'disabled') {
        await db.lockPlan(row.companyId!)
        const seats = (await db.plan(row.companyId!))?.seats ?? 0
        const used = await db.accountCount(row.companyId!)
        if (used >= seats) throw new HttpError(409, '席位已满，先加席位或停用其他成员', { seats, used })
      }
      return db.updateAccount(row.id, patch)
    })
    await db.audit({
      companyId: row.companyId,
      accountId: actor.id,
      action: 'account.update',
      detail: { id: row.id, name: patch.name, role: patch.role, status: patch.status },
    })
    send(res, 200, { account: publicAccount(next) })
  })

  /**
   * 重发邀请 / 重置口令，都落成一条新链接。旧邀请删掉，tokenRevokedAt 立刻作废旧 JWT。
   * Gateway 没有会话表：未过期的 JWT 若签发于 tokenRevokedAt 之后仍可用；登录会因 disabled 被拒。
   */
  router.post('/orgs/:id/accounts/:accountId/reset', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '没有这个成员')
    await db.updateAccount(row.id, { tokenRevokedAt: Date.now() })
    const ttl = row.status === 'invited' ? INVITE_TTL : RESET_LINK_TTL
    const invite = await issueInvite(db, row, actor.id, ttl)
    await db.audit({
      companyId: row.companyId,
      accountId: actor.id,
      action: 'account.reset',
      detail: { id: row.id, expiresAt: invite.expiresAt },
    })
    send(res, 200, { invite: { url: inviteLinkOf(req, invite.token), expiresAt: invite.expiresAt } })
  })

  router.post('/orgs/:id/accounts/:accountId/deploy', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    if (row.role === 'owner') throw new HttpError(403, '系统管理员没有席位')
    const out = await deploySeat(db, keys, row, deployOptsOf(req))
    const rt = out.ok ? out.result.runtime : out.runtime
    await db.audit({
      companyId: req.params.id,
      accountId: actor.id,
      action: 'runtime.deploy',
      detail: {
        targetAccountId: row.id,
        botId: rt?.botId,
        linuxUser: rt?.linuxUser,
        seatId: rt?.seatId,
        slot: rt?.slot,
        status: rt?.status,
      },
    })
    if (!out.ok) throw new HttpError(out.status, out.error)
    send(res, 200, publicSeatRuntime(out.result.runtime, out.result.machine.host, {
      includePassword: actor.role === 'owner' || actor.id === row.id,
      ticket: desktopTicketFor(keys, out.result.machine, out.result.runtime),
    }))
  })

  router.delete('/orgs/:id/accounts/:accountId', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    if (row.id === actor.id) throw new HttpError(400, '不能删除自己')
    if (row.role === 'admin' && row.status !== 'disabled' && row.companyId && await db.adminCount(row.companyId) <= 1) {
      throw new HttpError(409, '不能删掉最后一个管理员')
    }
    // **先拆机器上的席位，再删库里的行。** 反过来的话 seat_runtimes 一没，slot 立刻能
    // 被下一个账号分走（allocateSlot 就是扫这张表找第一个空号），而机器上那套 systemd
    // 单元还在跑、还占着同一组端口（3200+N / 6081+N）。下一个人的席位于是起不来，现象
    // 是「新员工的 bot 一直起不来」，谁也不会想到是几个月前删的那个人留下的。
    const seats = await db.seatRuntimesOfAccount(row.id)
    for (const seat of seats) {
      const machine = seat.machineId ? await db.machine(seat.machineId) : undefined
      if (!machinePaired(machine)) continue
      try {
        await managerRemoveSeat(machine, seat.seatId)
      } catch (e) {
        // 拆不掉就不删。硬删下去会留下一个谁也看不见、还占着端口的席位；而「停用」是
        // 现成的非破坏性动作，机器回来之后再删也不迟。
        throw new HttpError(
          502,
          `席位 ${seat.seatId} 所在的机器拆不掉（${sanitizeError(e, [machine.token])}）。` +
            '先把账号「停用」，等机器恢复后再删除。',
        )
      }
    }
    await db.deleteAccount(row.id)
    await db.audit({
      companyId: row.companyId,
      accountId: actor.id,
      action: 'account.delete',
      detail: { id: row.id, email: row.email, seats: seats.map((x) => x.seatId) },
    })
    send(res, 200, { deleted: true, id: row.id })
  })

  router.get('/orgs/:id/plan', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const plan = await db.plan(req.params.id)
    if (!plan) throw new HttpError(404, '套餐不存在')
    send(res, 200, await publicPlan(db, plan, await db.accountCount(req.params.id)))
  })

  /**
   * 公司账单。席位来自 db.plan，是真的。发票、充值、扣款都还没接——空列表，不编数字。
   */
  router.get('/orgs/:id/billing', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const plan = await db.plan(company.id)
    if (!plan) throw new HttpError(404, '套餐不存在')
    const used = await db.accountCount(company.id)
    // 订阅和账单都来自订单：已付款且在期内的那条订单就是「现在订的是什么」。
    const active = await db.activePaidOrder(company.id)
    const expired = plan.expiresAt != null && plan.expiresAt < Date.now()
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    const invoices = await db.invoicesOfCompany(company.id)
    const topups = await db.topupsOfCompany(company.id)
    const balance = await balanceOf(db, company.id)
    send(res, 200, {
      plan: {
        name: active?.planName || '席位套餐',
        status: active ? '生效中' : expired ? '已到期' : '未订阅',
        cycle: '—',
        seats: `${plan.seats} 个席位`,
        used,
        period: active ? `${day(active.startAt)} → ${day(active.endAt)}` : '—',
        renew: plan.expiresAt == null ? '—' : day(plan.expiresAt),
        amount: active ? usd(active.amountMils) : '—',
        autoRenew: false,
      },
      // 客户这边只看已付款的：没付的单子是「还没成交」，摆在账单里像已经欠着钱。
      // 界面那张表按 period / amount / status / paid 四列画，这里就按它的形状给。
      invoices: invoices
        .filter((v) => v.status === 'paid')
        .map((v) => ({
          id: v.id,
          period: `${day(v.periodStart)} → ${day(v.periodEnd)}`,
          amount: usd(v.amountMils),
          status: '已付款',
          paid: v.paidAt ? day(v.paidAt) : '—',
        })),
      // 两笔额度分开报：赠送的跟着套餐到期清零，充的不过期。合计只是给一眼看的。
      balance: {
        amount: usd(balance.planBonusMils + balance.topupMils),
        planBonus: usd(balance.planBonusMils),
        planBonusExpires: balance.planBonusExpiresAt ? day(balance.planBonusExpiresAt) : '—',
        topup: usd(balance.topupMils),
        // 按量扣费还没接，用了多少、预警线都还没有真数字，不编。
        spentThisMonth: '—',
        alertAt: '—',
      },
      topups: topups.map((v) => ({
        id: v.id,
        time: day(v.createdAt),
        amount: usd(v.amountMils),
        note: v.note || '—',
      })),
    })
  })

  /**
   * 公司用量。费用没有真实账单，永远是 —，不编钱。
   * 有 llm_calls 就报真实调用次数和 token 合计；没有就 0 / —。
   * 管理员；员工走 GET /me/stats。
   */
  router.get('/orgs/:id/usage', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const range = rangeQuery(req)
    const plan = await db.plan(company.id)
    const seats = plan?.seats ?? 0
    const members = (await db.accountsOf(company.id)).filter((a) => a.role !== 'owner')
    const usage = await db.llmUsageOfCompany(company.id, range)
    send(res, 200, usagePayload(usage, { seats, members, includeMembers: true }))
  })

  router.get('/me/stats', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const range = rangeQuery(req)
    const usage = await db.llmUsageOfAccount(account.id, range)
    send(res, 200, usagePayload(usage, { seats: 0, members: [account], includeMembers: false }))
  })

  router.put('/orgs/:id/plan', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '席位由系统管理员分配')
  })

  router.patch('/orgs/:id/plan', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '席位由系统管理员分配')
  })

  // ── 机器 / 访问地址 ─────────────────────────────────────────────────

  router.get('/orgs/:id/machine', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const machine = company.machineId ? await db.machine(company.machineId) : await companyMachineOf(db, company.id)
    send(res, 200, { machine: machine ? publicMachine(machine) : null, accessUrl: company.accessUrl })
  })

  router.post('/orgs/:id/machine', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    // 机器地址是平台的事：登记走 POST /internal/machines（引导票），改走
    // PUT /platform/orgs/:id/machine（owner）。公司管理员只能把已有机器认领过来。
    // 否则管理员能把 host 指到自己的服务器上，让 Gateway 带着 smt_ 打过去。
    const rawHost = body.host != null ? strField(body, 'host', false) : ''
    if (rawHost && account.role !== 'owner') throw new HttpError(403, '机器地址由系统管理员配置')
    const host = rawHost ? machineHostOf(rawHost) : null
    const id = body.id != null ? strField(body, 'id', false) || undefined : undefined
    const existing = id ? await db.machine(id) : undefined
    if (existing && existing.companyId && existing.companyId !== company.id) {
      throw new HttpError(409, '这台机器已经派给别的公司')
    }
    // **配过对的机器不是「谁先认领谁得」。** companyId 为空不代表这台是干净的新机器：
    // 公司被删时 machines.companyId 会被置空，而那台机器上的席位还在跑。这种机器只能
    // 由 owner 重新指派，或者由**当初配对它的那家公司**认回去。没配过对的预登记机器
    // （平台先 POST /internal/machines 建好、再交给公司）不受影响，照旧可以认领。
    if (
      existing &&
      !existing.companyId &&
      existing.pairedAt &&
      account.role !== 'owner' &&
      !(await db.machinePairedBy(existing.id, company.id))
    ) {
      throw new HttpError(403, '这台机器不是本公司配对的，请让系统管理员指派')
    }
    const { machine, next } = await db.tx(async () => {
      // **认领是「加一台」，不是「换一台」。** 以前这里会把 company.machineId 指向的
      // 那台解绑——单机时代那是对的，多机之后会把已经在跑的机器连同它上面的席位一起
      // 踢出公司，容量凭空缩水。
      const machine = existing
        ? await db.updateMachine(existing.id, { companyId: company.id, host: host ?? existing.host })
        : await db.insertMachine({ id, host, companyId: company.id })
      const accessUrl = company.accessUrl ?? accessUrlFor(company.slug)
      // 认领是个明确动作，把这台设成公司的默认机器是合理的。但**只是改默认**——
      // 上面那台仍然属于这家公司、仍然在跑、仍然算容量。
      const next = await db.updateCompany(company.id, { machineId: machine.id, accessUrl })
      await db.audit({ companyId: company.id, accountId: account.id, action: 'machine.assign', detail: { machineId: machine.id, accessUrl } })
      return { machine, next }
    })
    send(res, 201, { machine: publicMachine(machine), company: publicCompany(next) })
  })

  // ── 可见目录（全局 ∪ 本公司）────────────────────────────────────────

  for (const name of Object.keys(KIND)) {
    router.get(`/catalog/${name}`, async (req, res) => {
      const account = await requireUser(req, db, keys)
      send(res, 200, { items: (await db.visibleCatalog(kindOf(name), account.companyId)).map(publicCatalog) })
    })
    router.post(`/catalog/${name}`, async (req, res) => {
      requirePlatformToken(req)
      const body = bodyOf(req)
      const item = await db.insertCatalog({
        kind: kindOf(name),
        scope: 'global',
        companyId: null,
        name: strField(body, 'name'),
        definition: body.definition ?? {},
      })
      send(res, 201, { item: publicCatalog(item) })
    })
    router.patch(`/catalog/${name}/:itemId`, async (req, res) => {
      requirePlatformToken(req)
      const item = await db.catalog(req.params.itemId)
      if (!item || item.kind !== kindOf(name) || item.scope !== 'global') throw new HttpError(404, '目录项不存在')
      const body = bodyOf(req)
      const next = await db.updateCatalog(item.id, {
        name: body.name != null ? strField(body, 'name') : undefined,
        definition: body.definition,
      })
      send(res, 200, { item: publicCatalog(next) })
    })
    router.delete(`/catalog/${name}/:itemId`, async (req, res) => {
      requirePlatformToken(req)
      const item = await db.catalog(req.params.itemId)
      if (!item || item.kind !== kindOf(name) || item.scope !== 'global') throw new HttpError(404, '目录项不存在')
      await db.deleteCatalog(item.id)
      send(res, 200, { deleted: true, id: item.id })
    })
  }

  /**
   * 实例拉目录。MCP token 与 env 明文只出现在这里，不出现在 /catalog/mcp，也不出现在
   * 管理面的 /orgs/:id/mcp-servers。**只认席位 sat_**：登录 JWT 能进来的话，任何一个
   * 成员在浏览器里就能把公司所有 MCP 的密钥读走。
   */
  router.get('/runtime/catalog', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const companyId = account.role === 'owner' ? null : account.companyId
    const botId = (req.query.get('botId') || '').trim()
    let bots = await db.visibleCatalog('bot', companyId)
    if (botId) {
      const hit = bots.find((b) => b.id === botId)
      if (!hit) throw new HttpError(404, '没有这个 Bot')
      bots = [hit]
    }
    const pinned = await defaultBotModel(db)
    send(res, 200, {
      bots: bots.map((b) => publicBot(b, pinned)),
      skills: (await db.visibleCatalog('skill', companyId)).map(publicSkill),
      servers: (await db.visibleCatalog('mcp', companyId)).map(runtimeServer),
    })
  })

  router.get('/runtime/desktop', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const botId = (req.query.get('botId') || '').trim()
    if (!botId) throw new HttpError(400, 'botId 不能为空')
    const runtime = await db.seatRuntime(account.id, botId)
    if (!runtime) throw new HttpError(404, '还没有部署')
    const machine = await companyMachineOf(db, account.companyId!)
    send(res, 200, publicSeatRuntime(runtime, (await db.machine(runtime.machineId))?.host ?? null, {
      includePassword: true,
      ticket: desktopTicketFor(keys, machine, runtime),
    }))
  })

  /**
   * 席位现场诊断。转发管家的 `/seats/:id/diag`。
   *
   * **给「席位本人」用，不是只给平台管理员。** 出问题的是他那块屏，而管理员未必在场；
   * 报告里也没有凭据（管家那侧只报文件的存在与时间，日志过了脱敏）。要它下沉到这一层，
   * 才算真的补上「没有 SSH 就看不见机器」这个洞。
   */
  router.get('/runtime/diag', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const t = await managerTargetFor(db, account, (req.query.get('botId') || '').trim())
    const lines = Number(req.query.get('lines') || 40)
    const q = Number.isFinite(lines) ? `?lines=${Math.min(200, Math.max(1, Math.trunc(lines)))}` : ''
    await proxyJson(res, 'GET', `${t.base}/seats/${encodeURIComponent(t.seatId)}/diag${q}`, undefined, undefined, t.machineToken)
  })

  /**
   * 席位 bot 的运行日志。`follow=1` 跟着滚（SSE），否则给最近 N 行。
   *
   * 和 diag 是一对：那条回答「它活着吗」，这条回答「它卡在哪一步」。这一层最贵的
   * 故障恰恰都不报错——单元 active、端口有人听，只是那一轮永远不结束——不看日志
   * 就只能靠猜，而没有 SSH 的时候连猜的依据都没有。
   *
   * 只看**自己席位**的：seatRuntime 按 (account.id, botId) 查，管理员也调不出别人的。
   * 日志里有对话正文和 bash 跑过的命令，这条线不该松。机器票留在 Gateway，浏览器
   * 只拿自己的席位票——它是管家的 root 控制面凭据，一步都不能往下放。
   */
  router.get('/runtime/logs', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const t = await managerTargetFor(db, account, (req.query.get('botId') || '').trim())
    const lines = Math.min(2000, Math.max(1, Math.trunc(Number(req.query.get('lines')) || 200)))
    const follow = req.query.get('follow') === '1'
    const url = `${t.base}/seats/${encodeURIComponent(t.seatId)}/logs?lines=${lines}${follow ? '&follow=1' : ''}`
    if (follow) await proxySse(req, res, url, undefined, t.machineToken)
    else await proxyJson(res, 'GET', url, undefined, undefined, t.machineToken)
  })

  router.post('/runtime/deploy', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const out = await deploySeat(db, keys, account, deployOptsOf(req))
    if (!out.ok) throw new HttpError(out.status, out.error)
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'runtime.deploy',
      detail: {
        botId: out.result.runtime.botId,
        linuxUser: out.result.runtime.linuxUser,
        seatId: out.result.runtime.seatId,
        slot: out.result.runtime.slot,
        status: out.result.runtime.status,
      },
    })
    send(res, 200, publicSeatRuntime(out.result.runtime, out.result.machine.host, {
      includePassword: true,
      ticket: desktopTicketFor(keys, out.result.machine, out.result.runtime),
    }))
  })

  // ── 对话。名册走 Gateway 目录；会话才反代到该 pair 的实例。────────

  router.get('/runtime/bots', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    // 平台指定的那一对，整份名册共用一次——每行各读一次设置没有意义。
    const pinned = await defaultBotModel(db)
    const bots = await Promise.all(
      (await db.visibleCatalog('bot', account.companyId)).map(async (item) => ({
        ...publicBot(item, pinned),
        runtime: await pairRuntime(db, account, item.id),
      })),
    )
    send(res, 200, { bots })
  })

  router.get('/runtime/bots/:id/session', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const bot = await visibleBotOf(db, account, req.params.id)
    const target = await seatTargetFor(db, account, bot.id)
    const url = `${target.host}/api/bots/${encodeURIComponent(bot.id)}/session`
    const bearerTok = await seatBearer(db, account.id)
    let r: Response
    try {
      r = await fetch(url, {
        headers: {
          authorization: bearerTok ? `Bearer ${bearerTok}` : '',
          accept: 'application/json',
          ...machineHeader(target.machineToken),
        },
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      throw new HttpError(503, INSTANCE_DOWN)
    }
    const text = await r.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { error: text.slice(0, 200) || INSTANCE_DOWN }
    }
    if (r.ok && parsed && typeof parsed === 'object' && account.companyId) {
      const sessionId = (parsed as { sessionId?: unknown }).sessionId
      if (typeof sessionId === 'string' && sessionId) {
        await db.upsertSessionIndex({
          sessionId,
          companyId: account.companyId,
          accountId: account.id,
          botId: bot.id,
        })
      }
    }
    send(res, r.status, parsed)
  })

  router.get('/runtime/bots/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const bot = await visibleBotOf(db, account, req.params.id)
    send(res, 200, { bot: { ...publicBot(bot, await defaultBotModel(db)), runtime: await pairRuntime(db, account, bot.id) } })
  })

  router.get('/runtime/sessions/:id/events', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const after = req.query.get('after')
    // tail：头一次连上只要最近几轮，别把整段历史推一遍（见 bot 的 replay.ts）。
    const tail = Math.min(50, Math.max(0, Math.trunc(Number(req.query.get('tail')) || 0)))
    const parts: string[] = []
    if (after != null && after !== '') parts.push(`after=${encodeURIComponent(after)}`)
    if (tail > 0) parts.push(`tail=${tail}`)
    const q = parts.length ? `?${parts.join('&')}` : ''
    await proxySse(
      req,
      res,
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/events${q}`,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 再往前翻一页历史。游标是上一页最靠前那条的 seq。
   *
   * 和那条流分开走：翻页是人点出来的一次性动作，塞进流里既要发明请求帧，又会让
   * 重连的游标语义变浑。
   */
  router.get('/runtime/sessions/:id/history', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const before = Math.max(0, Math.trunc(Number(req.query.get('before')) || 0))
    const turns = Math.min(50, Math.max(1, Math.trunc(Number(req.query.get('turns')) || 20)))
    await proxyJson(
      res,
      'GET',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/history?turns=${turns}${before ? `&before=${before}` : ''}`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  router.post('/runtime/sessions/:id/messages', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const body = bodyOf(req)
    // 图片带的是**工作区里的路径**，不是字节——文件早就传上去了（见上面那条 files）。
    // 真正的校验（路径越界、文件在不在、格式模型认不认）在席位那头，那里才有工作区。
    const images = Array.isArray(body.images)
      ? body.images.slice(0, 10).map((x) => {
          const o = (x ?? {}) as Record<string, unknown>
          return { path: String(o.path ?? ''), mime: String(o.mime ?? '') }
        })
      : undefined
    await proxyJson(
      res,
      'POST',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/messages`,
      images?.length ? { text: strField(body, 'text', false), images } : { text: strField(body, 'text') },
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  router.post('/runtime/sessions/:id/abort', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    await proxyJson(
      res,
      'POST',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/abort`,
      {},
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 上传附件到这条会话的工作区。字节边收边转，Gateway 不落地。
   *
   * 文件名走 header 而不是查询串：查询串会进访问日志，而文件名常常就是内容本身
   * （「二季度裁员名单.xlsx」）。
   */
  router.postRaw('/runtime/sessions/:id/files', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const filename = req.headers['x-filename']
    await proxyUpload(
      req,
      res,
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/files`,
      typeof filename === 'string' ? { 'x-filename': filename } : {},
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 预览（或下载）这条会话所在席位的工作区里的一个文件。
   *
   * 上传进来的和 Bot 自己写出来的走同一条路——它们本来就在同一个目录里。越界检查在
   * 席位那头（workspace 服务），这里只负责证明「这个人有权打这台席位」。
   */
  router.get('/runtime/sessions/:id/files', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const path = req.query.get('path') ?? ''
    if (!path.trim()) throw new HttpError(400, 'path 不能为空')
    const q = `?path=${encodeURIComponent(path)}${req.query.get('download') === '1' ? '&download=1' : ''}`
    await proxyDownload(
      req,
      res,
      `${target.host}/api/workspace/file${q}`,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  // ── 目录项的建 / 改。平台侧和公司侧共用这几段，差别只在 owner。────────

  async function newBotDefinition(owner: CatalogOwner, body: Record<string, unknown>) {
    // 模型不收 body 里那一对：谁都不能给某个 Bot 单独挑一个模型。
    const pinned = await defaultBotModel(db)
    return {
      description: typeof body.description === 'string' ? body.description.trim() : '',
      prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : DEFAULT_BOT_PROMPT,
      greeting: typeof body.greeting === 'string' ? body.greeting.trim() : '',
      escalate: typeof body.escalate === 'string' ? body.escalate.trim() : '',
      guards: botGuardsOf(body.guards),
      memory: botMemoryOf(body.memory),
      icon: botIconOf(body.icon, owner.scope),
      provider: pinned.provider,
      model: pinned.model,
      enabled: true,
      skills: await assignedIds(db, owner, 'skill', body.skills),
      mcps: await assignedIds(db, owner, 'mcp', body.mcps),
    }
  }

  async function applyBotPatch(owner: CatalogOwner, def: Record<string, unknown>, body: Record<string, unknown>) {
    if (body.description !== undefined) def.description = String(body.description).trim()
    if (body.prompt !== undefined) def.prompt = String(body.prompt).trim()
    if (body.greeting !== undefined) def.greeting = String(body.greeting).trim()
    if (body.escalate !== undefined) def.escalate = String(body.escalate).trim()
    // 传来的是「改动的那几个开关」，跟库里现有的合并——只改一个不该把另外两个带回默认。
    if (body.guards !== undefined) def.guards = botGuardsOf(body.guards, botGuardsOf(def.guards))
    if (body.memory !== undefined) def.memory = botMemoryOf(body.memory, botMemoryOf(def.memory))
    // 写入也走一遍归一化：老键（chat 这些）映射到新的一套，另一层级的键当没传、保留原值。
    if (typeof body.icon === 'string') {
      const key = LEGACY_BOT_ICONS[body.icon.trim()] ?? body.icon.trim()
      if (iconSetFor(owner.scope).has(key)) def.icon = key
    }
    // body 里的 provider / model 一概不看。存下来的这一对只是快照，顺手跟平台对齐；
    // 真正对外报的是 publicBot 读的时候现取的那一对。
    const pinned = await defaultBotModel(db)
    def.provider = pinned.provider
    def.model = pinned.model
    if (typeof body.enabled === 'boolean') def.enabled = body.enabled
    if (Array.isArray(body.skills)) def.skills = await assignedIds(db, owner, 'skill', body.skills)
    if (Array.isArray(body.mcps)) def.mcps = await assignedIds(db, owner, 'mcp', body.mcps)
    return def
  }

  function newSkillDefinition(b: Record<string, unknown>) {
    const source: SkillSource = b.source === '单文件 Skill' || b.source === 'ZIP 包' ? b.source : '手动编写'
    const files = source === 'ZIP 包' ? filesOf(b.files) : []
    const readme = files.find((f) => f.path.toLowerCase() === 'skill.md')
    const now = Date.now()
    const fileName = trimStr(b.fileName)
    const tags = tagsOf(b.tags)
    const definition: Record<string, unknown> = {
      body: source === 'ZIP 包' ? (readme?.text ?? '') : typeof b.body === 'string' ? b.body : '',
      tags,
      source,
      enabled: b.enabled !== false,
      createdAt: now,
      updatedAt: now,
    }
    if (fileName) definition.fileName = fileName
    if (files.length) definition.files = files
    return { definition, tags }
  }

  function applySkillPatch(def: Record<string, unknown>, b: Record<string, unknown>) {
    if (typeof b.body === 'string') def.body = b.body
    if (Array.isArray(b.tags)) def.tags = tagsOf(b.tags)
    if (typeof b.enabled === 'boolean') def.enabled = b.enabled
    const source = def.source === '单文件 Skill' || def.source === 'ZIP 包' ? def.source : '手动编写'
    if (typeof b.body === 'string' && source === 'ZIP 包' && Array.isArray(def.files)) {
      def.files = (def.files as { path: string; text: string }[]).map((f) =>
        f.path.toLowerCase() === 'skill.md' ? { ...f, text: b.body as string } : f,
      )
    }
    def.updatedAt = Date.now()
    return def
  }

  function newMcpDefinition(b: Record<string, unknown>) {
    const kind: McpKind = (MCP_KINDS as readonly string[]).includes(trimStr(b.kind)) ? (trimStr(b.kind) as McpKind) : 'SSE'
    const endpoint = trimStr(b.endpoint)
    if (!endpoint) throw new HttpError(400, kind === 'stdio' ? '要有启动命令' : '要有服务器地址')
    const now = Date.now()
    const token = trimStr(b.token)
    const definition: Record<string, unknown> = {
      kind,
      endpoint,
      env: envOf(b.env),
      perm: (MCP_PERMS as readonly string[]).includes(trimStr(b.perm)) ? trimStr(b.perm) : '只读',
      enabled: b.enabled !== false,
      createdAt: now,
      updatedAt: now,
    }
    if (token) definition.token = token
    return definition
  }

  function applyMcpPatch(def: Record<string, unknown>, b: Record<string, unknown>) {
    if ((MCP_KINDS as readonly string[]).includes(trimStr(b.kind))) def.kind = trimStr(b.kind)
    if (b.endpoint !== undefined) {
      const endpoint = trimStr(b.endpoint)
      const kind = (MCP_KINDS as readonly string[]).includes(trimStr(def.kind)) ? trimStr(def.kind) : 'SSE'
      if (!endpoint) throw new HttpError(400, kind === 'stdio' ? '要有启动命令' : '要有服务器地址')
      def.endpoint = endpoint
    }
    if (b.env !== undefined) def.env = envOf(b.env)
    if ((MCP_PERMS as readonly string[]).includes(trimStr(b.perm))) def.perm = trimStr(b.perm)
    if (typeof b.enabled === 'boolean') def.enabled = b.enabled
    // token 三种意思：没带这个字段=不动，带了空串=清掉，带了内容=换新的。
    if (typeof b.token === 'string') {
      const token = trimStr(b.token)
      if (token) def.token = token
      else delete def.token
    }
    def.updatedAt = Date.now()
    return def
  }

  // ── 全局 Bot / Skill / MCP（owner）。所有公司都看得见，只有 owner 能改。──

  router.get('/platform/bots', async (req, res) => {
    requireOwner(await requireUser(req, db, keys))
    const pinned = await defaultBotModel(db)
    send(res, 200, { bots: (await db.visibleCatalog('bot', null)).map((i) => publicBot(i, pinned)) })
  })

  router.get('/platform/bots/options', async (req, res) => {
    requireOwner(await requireUser(req, db, keys))
    send(res, 200, {
      skills: (await db.visibleCatalog('skill', null)).map((i) => ({ id: i.id, name: i.name })),
      mcps: (await db.visibleCatalog('mcp', null)).map((i) => ({ id: i.id, name: i.name })),
      // 全局 Bot 不挂公司分组和知识库：那些是某一家公司的东西。
      groups: [] as { id: string; name: string }[],
      kbs: [] as { id: string; name: string }[],
      icons: [...GLOBAL_BOT_ICONS],
    })
  })

  router.post('/platform/bots', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    const item = await db.insertCatalog({
      kind: 'bot',
      scope: 'global',
      companyId: null,
      name: botNameOf(body.name),
      definition: await newBotDefinition(GLOBAL_OWNER, body),
    })
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'catalog.create', detail: { kind: 'bot', scope: 'global', id: item.id } })
    send(res, 201, { bot: publicBot(item, await defaultBotModel(db)) })
  })

  router.get('/platform/bots/:botId', async (req, res) => {
    requireOwner(await requireUser(req, db, keys))
    send(res, 200, { bot: publicBot(await requireGlobalItem(db, req.params.botId, 'bot', '没有这个助理'), await defaultBotModel(db)) })
  })

  router.patch('/platform/bots/:botId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const item = await requireGlobalItem(db, req.params.botId, 'bot', '没有这个助理')
    const body = bodyOf(req)
    const def = await applyBotPatch(GLOBAL_OWNER, botDefOf(item.definition), body)
    const next = await db.updateCatalog(item.id, {
      name: body.name !== undefined ? botNameOf(body.name) : undefined,
      definition: def,
    })
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'catalog.update', detail: { kind: 'bot', scope: 'global', id: item.id } })
    send(res, 200, { bot: publicBot(next, await defaultBotModel(db)) })
  })

  router.delete('/platform/bots/:botId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const item = await requireGlobalItem(db, req.params.botId, 'bot', '没有这个助理')
    await db.deleteCatalog(item.id)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'catalog.delete', detail: { kind: 'bot', scope: 'global', id: item.id } })
    send(res, 200, { deleted: true, id: item.id })
  })

  router.get('/platform/skills', async (req, res) => {
    requireOwner(await requireUser(req, db, keys))
    send(res, 200, {
      skills: (await db.visibleCatalog('skill', null)).map(publicSkill),
      servers: (await db.visibleCatalog('mcp', null)).map(publicServer),
      tags: await knownTags(db, 'platform'),
    })
  })

  router.post('/platform/skills', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const b = bodyOf(req)
    const { definition, tags } = newSkillDefinition(b)
    const item = await db.insertCatalog({ kind: 'skill', scope: 'global', companyId: null, name: namedOf(b.name), definition })
    await rememberTags(db, 'platform', tags)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'catalog.create', detail: { kind: 'skill', scope: 'global', id: item.id } })
    send(res, 201, { skill: publicSkill(item) })
  })

  router.post('/platform/skills/tags', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const name = namedOf(bodyOf(req).name)
    await rememberTags(db, 'platform', [name])
    send(res, 201, { tags: await knownTags(db, 'platform') })
  })

  router.delete('/platform/skills/tags/:name', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const tag = decodeURIComponent(req.params.name)
    await db.deleteSkillTag('platform', tag)
    for (const item of await db.visibleCatalog('skill', null)) {
      const def = asDef(item.definition)
      if (!Array.isArray(def.tags) || !def.tags.includes(tag)) continue
      def.tags = (def.tags as unknown[]).filter((x) => x !== tag)
      await db.updateCatalog(item.id, { definition: def })
    }
    send(res, 200, { tags: await knownTags(db, 'platform') })
  })

  router.get('/platform/skills/:skillId', async (req, res) => {
    requireOwner(await requireUser(req, db, keys))
    send(res, 200, { skill: publicSkill(await requireGlobalItem(db, req.params.skillId, 'skill', '没有这个 Skill')) })
  })

  router.patch('/platform/skills/:skillId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const item = await requireGlobalItem(db, req.params.skillId, 'skill', '没有这个 Skill')
    const b = bodyOf(req)
    const def = applySkillPatch(asDef(item.definition), b)
    const next = await db.updateCatalog(item.id, { name: b.name !== undefined ? namedOf(b.name) : undefined, definition: def })
    if (Array.isArray(def.tags)) await rememberTags(db, 'platform', def.tags.map((x) => String(x)))
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'catalog.update', detail: { kind: 'skill', scope: 'global', id: item.id } })
    send(res, 200, { skill: publicSkill(next) })
  })

  router.delete('/platform/skills/:skillId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const item = await requireGlobalItem(db, req.params.skillId, 'skill', '没有这个 Skill')
    await db.deleteCatalog(item.id)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'catalog.delete', detail: { kind: 'skill', scope: 'global', id: item.id } })
    send(res, 200, { deleted: true, id: item.id })
  })

  router.get('/platform/mcp-servers', async (req, res) => {
    requireOwner(await requireUser(req, db, keys))
    send(res, 200, { servers: (await db.visibleCatalog('mcp', null)).map(publicServer) })
  })

  router.post('/platform/mcp-servers', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const b = bodyOf(req)
    const item = await db.insertCatalog({
      kind: 'mcp',
      scope: 'global',
      companyId: null,
      name: namedOf(b.name),
      definition: newMcpDefinition(b),
    })
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'catalog.create', detail: { kind: 'mcp', scope: 'global', id: item.id } })
    send(res, 201, { server: publicServer(item) })
  })

  router.get('/platform/mcp-servers/:serverId', async (req, res) => {
    requireOwner(await requireUser(req, db, keys))
    send(res, 200, { server: publicServer(await requireGlobalItem(db, req.params.serverId, 'mcp', '没有这个 MCP')) })
  })

  router.patch('/platform/mcp-servers/:serverId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const item = await requireGlobalItem(db, req.params.serverId, 'mcp', '没有这个 MCP')
    const b = bodyOf(req)
    const def = applyMcpPatch(asDef(item.definition), b)
    const next = await db.updateCatalog(item.id, { name: b.name !== undefined ? namedOf(b.name) : undefined, definition: def })
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'catalog.update', detail: { kind: 'mcp', scope: 'global', id: item.id } })
    send(res, 200, { server: publicServer(next) })
  })

  router.delete('/platform/mcp-servers/:serverId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const item = await requireGlobalItem(db, req.params.serverId, 'mcp', '没有这个 MCP')
    await db.deleteCatalog(item.id)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'catalog.delete', detail: { kind: 'mcp', scope: 'global', id: item.id } })
    send(res, 200, { deleted: true, id: item.id })
  })

  // ── 公司 Bot。形状跟 Bot 运行时一致：{ bots } / { bot }。────────────

  router.get('/orgs/:id/bots', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    // 全局 ∪ 本公司：全局项在界面上是只读的，写路径会被 requireCompanyBot 挡掉。
    const pinned = await defaultBotModel(db)
    send(res, 200, { bots: (await db.visibleCatalog('bot', req.params.id)).map((i) => publicBot(i, pinned)) })
  })

  // 必须写在 /bots/:botId 前面，否则 options 会被当成 botId。
  router.get('/orgs/:id/bots/options', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const orgId = req.params.id
    send(res, 200, {
      skills: (await db.visibleCatalog('skill', orgId)).map((i) => ({ id: i.id, name: i.name })),
      mcps: (await db.visibleCatalog('mcp', orgId)).map((i) => ({ id: i.id, name: i.name })),
      groups: (await db.groupsOf(orgId)).map((g) => ({ id: g.id, name: g.name })),
      kbs: [] as { id: string; name: string }[],
      icons: [...COMPANY_BOT_ICONS],
    })
  })

  router.post('/orgs/:id/bots', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const item = await db.insertCatalog({
      kind: 'bot',
      scope: 'company',
      companyId: req.params.id,
      name: botNameOf(body.name),
      definition: await newBotDefinition(companyOwner(req.params.id), body),
    })
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.create', detail: { kind: 'bot', id: item.id } })
    send(res, 201, { bot: publicBot(item, await defaultBotModel(db)) })
  })

  router.get('/orgs/:id/bots/:botId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    send(res, 200, { bot: publicBot(await requireVisibleBot(db, req.params.id, req.params.botId), await defaultBotModel(db)) })
  })

  router.patch('/orgs/:id/bots/:botId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const item = await requireCompanyBot(db, req.params.id, req.params.botId)
    const body = bodyOf(req)
    const def = await applyBotPatch(companyOwner(req.params.id), botDefOf(item.definition), body)
    const next = await db.updateCatalog(item.id, {
      name: body.name !== undefined ? botNameOf(body.name) : undefined,
      definition: def,
    })
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.update', detail: { kind: 'bot', id: item.id } })
    send(res, 200, { bot: publicBot(next, await defaultBotModel(db)) })
  })

  router.delete('/orgs/:id/bots/:botId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const item = await requireCompanyBot(db, req.params.id, req.params.botId)
    await db.deleteCatalog(item.id)
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.delete', detail: { kind: 'bot', id: item.id } })
    send(res, 200, { deleted: true, id: item.id })
  })


  // ── 公司 Skill / MCP。形状跟 Bot 运行时一致；执行与连接都还没接。──

  router.get('/orgs/:id/skills', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const orgId = req.params.id
    send(res, 200, {
      skills: (await db.visibleCatalog('skill', orgId)).map(publicSkill),
      servers: (await db.visibleCatalog('mcp', orgId)).map(publicServer),
      tags: await knownTags(db, orgId),
    })
  })

  router.post('/orgs/:id/skills', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const b = bodyOf(req)
    const { definition, tags } = newSkillDefinition(b)
    const item = await db.insertCatalog({
      kind: 'skill',
      scope: 'company',
      companyId: req.params.id,
      name: namedOf(b.name),
      definition,
    })
    await rememberTags(db, req.params.id, tags)
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.create', detail: { kind: 'skill', id: item.id } })
    send(res, 201, { skill: publicSkill(item) })
  })

  router.post('/orgs/:id/skills/tags', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const tag = namedOf(bodyOf(req).name)
    if (tag.length > 12) throw new HttpError(400, '标签最多 12 个字')
    await knownTags(db, req.params.id)
    await db.insertSkillTag(req.params.id, tag)
    send(res, 200, { tags: await knownTags(db, req.params.id) })
  })

  router.delete('/orgs/:id/skills/tags/:name', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const orgId = req.params.id
    const tag = req.params.name
    await db.deleteSkillTag(orgId, tag)
    let touched = 0
    for (const item of await db.companyCatalog('skill', orgId)) {
      const def = asDef(item.definition)
      const tags = Array.isArray(def.tags) ? def.tags.map((x) => String(x)) : []
      if (!tags.includes(tag)) continue
      def.tags = tags.filter((x) => x !== tag)
      def.updatedAt = Date.now()
      await db.updateCatalog(item.id, { definition: def })
      touched++
    }
    send(res, 200, { tags: await knownTags(db, orgId), touched })
  })

  router.get('/orgs/:id/skills/:skillId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    send(res, 200, { skill: publicSkill(await requireCompanySkill(db, req.params.id, req.params.skillId)) })
  })

  router.patch('/orgs/:id/skills/:skillId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const item = await requireCompanySkill(db, req.params.id, req.params.skillId)
    const b = bodyOf(req)
    const def = applySkillPatch(asDef(item.definition), b)
    const next = await db.updateCatalog(item.id, { name: b.name !== undefined ? namedOf(b.name) : undefined, definition: def })
    if (Array.isArray(def.tags)) await rememberTags(db, req.params.id, def.tags.map((x) => String(x)))
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.update', detail: { kind: 'skill', id: item.id } })
    send(res, 200, { skill: publicSkill(next) })
  })

  router.delete('/orgs/:id/skills/:skillId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const item = await requireCompanySkill(db, req.params.id, req.params.skillId)
    await db.deleteCatalog(item.id)
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.delete', detail: { kind: 'skill', id: item.id } })
    send(res, 200, { deleted: true, id: item.id })
  })

  router.get('/orgs/:id/mcp-servers', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    send(res, 200, { servers: (await db.visibleCatalog('mcp', req.params.id)).map(publicServer) })
  })

  router.post('/orgs/:id/mcp-servers', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const b = bodyOf(req)
    const item = await db.insertCatalog({
      kind: 'mcp',
      scope: 'company',
      companyId: req.params.id,
      name: namedOf(b.name),
      definition: newMcpDefinition(b),
    })
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.create', detail: { kind: 'mcp', id: item.id } })
    send(res, 201, { server: publicServer(item) })
  })

  router.get('/orgs/:id/mcp-servers/:serverId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    send(res, 200, { server: publicServer(await requireCompanyMcp(db, req.params.id, req.params.serverId)) })
  })

  router.patch('/orgs/:id/mcp-servers/:serverId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const item = await requireCompanyMcp(db, req.params.id, req.params.serverId)
    const b = bodyOf(req)
    const def = applyMcpPatch(asDef(item.definition), b)
    const next = await db.updateCatalog(item.id, { name: b.name !== undefined ? namedOf(b.name) : undefined, definition: def })
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.update', detail: { kind: 'mcp', id: item.id } })
    send(res, 200, { server: publicServer(next) })
  })

  router.delete('/orgs/:id/mcp-servers/:serverId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const item = await requireCompanyMcp(db, req.params.id, req.params.serverId)
    await db.deleteCatalog(item.id)
    await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.delete', detail: { kind: 'mcp', id: item.id } })
    send(res, 200, { deleted: true, id: item.id })
  })

  // ── 公司目录（admin）。bots 走上面那组，形状不同。────────────────

  for (const name of ['models'] as const) {
    const kind = kindOf(name)
    router.get(`/orgs/:id/${name}`, async (req, res) => {
      const account = await requireUser(req, db, keys)
      requireOrg(account, req.params.id)
      send(res, 200, { items: (await db.companyCatalog(kind, req.params.id)).map(publicCatalog) })
    })
    router.post(`/orgs/:id/${name}`, async (req, res) => {
      const account = await requireUser(req, db, keys)
      requireOrg(account, req.params.id, true)
      if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
      const body = bodyOf(req)
      const item = await db.insertCatalog({
        kind,
        scope: 'company',
        companyId: req.params.id,
        name: strField(body, 'name'),
        definition: body.definition ?? {},
      })
      await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.create', detail: { kind, id: item.id } })
      send(res, 201, { item: publicCatalog(item) })
    })
    router.get(`/orgs/:id/${name}/:itemId`, async (req, res) => {
      const account = await requireUser(req, db, keys)
      requireOrg(account, req.params.id)
      const item = await db.catalog(req.params.itemId)
      if (!item || item.kind !== kind || item.companyId !== req.params.id) throw new HttpError(404, '目录项不存在')
      send(res, 200, { item: publicCatalog(item) })
    })
    router.patch(`/orgs/:id/${name}/:itemId`, async (req, res) => {
      const account = await requireUser(req, db, keys)
      requireOrg(account, req.params.id, true)
      const item = await db.catalog(req.params.itemId)
      if (!item || item.kind !== kind || item.companyId !== req.params.id) throw new HttpError(404, '目录项不存在')
      const body = bodyOf(req)
      const next = await db.updateCatalog(item.id, {
        name: body.name != null ? strField(body, 'name') : undefined,
        definition: body.definition,
      })
      await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.update', detail: { kind, id: item.id } })
      send(res, 200, { item: publicCatalog(next) })
    })
    router.delete(`/orgs/:id/${name}/:itemId`, async (req, res) => {
      const account = await requireUser(req, db, keys)
      requireOrg(account, req.params.id, true)
      const item = await db.catalog(req.params.itemId)
      if (!item || item.kind !== kind || item.companyId !== req.params.id) throw new HttpError(404, '目录项不存在')
      await db.deleteCatalog(item.id)
      await db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.delete', detail: { kind, id: item.id } })
      send(res, 200, { deleted: true, id: item.id })
    })
  }

  // ── 公司密钥。列表/详情只回 configured: true ────────────────────────

  router.get('/orgs/:id/credentials', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    send(res, 200, { credentials: (await db.platformCredentials()).map(publicPlatformCred) })
  })

  router.post('/orgs/:id/credentials', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '供应商由系统管理员配置')
  })

  router.get('/orgs/:id/credentials/:credId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const provider = req.params.credId.startsWith('platform:') ? req.params.credId.slice('platform:'.length) : req.params.credId
    const row = await db.platformCredential(provider)
    if (!row) throw new HttpError(404, '密钥不存在')
    send(res, 200, { credential: publicPlatformCred(row) })
  })

  router.put('/orgs/:id/credentials/:credId', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '供应商由系统管理员配置')
  })

  router.delete('/orgs/:id/credentials/:credId', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '供应商由系统管理员配置')
  })

  // ── 会话索引 / 按需拉全文。Gateway 只存指针，正文留在机器上。────────

  router.get('/orgs/:id/sessions', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const accountId = (req.query.get('accountId') || '').trim()
    const botId = (req.query.get('botId') || '').trim()
    const range = rangeQuery(req)
    const limit = sessionPageLimit(intField({ limit: req.query.get('limit') ?? undefined }, 'limit'))
    const before = sessionCursorOf(req.query.get('cursor'))
    // 多取一条来判断后面还有没有。静默截断比没有上限还糟：调用方看到的是一份「看起来
    // 很完整」的列表，然后据此得出「这些会话不存在」的结论。
    const rows = await db.listSessionIndex(company.id, {
      accountId: accountId || undefined,
      botId: botId || undefined,
      from: range.from,
      to: range.to,
      limit: limit + 1,
      before,
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const nextCursor = hasMore && last ? `${last.updatedAt}:${last.sessionId}` : null
    // 名字一次性查齐，不要每行两次。
    const names = {
      accounts: new Map((await db.accountsOf(company.id)).map((a) => [a.id, a])),
      bots: new Map((await db.visibleCatalog('bot', company.id)).map((b) => [b.id, b])),
    }
    send(res, 200, {
      sessions: await Promise.all(page.map((row) => publicSessionIndex(db, row, names))),
      limit,
      hasMore,
      nextCursor,
    })
  })

  router.get('/orgs/:id/sessions/:sessionId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const row = await db.sessionIndex(req.params.sessionId)
    if (!row || row.companyId !== company.id) throw new HttpError(404, '会话不存在')
    const session = await publicSessionIndex(db, row)
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'session.pull',
      detail: { sessionId: row.sessionId },
    })
    const machineId = row.machineId || company.machineId
    const machine = machineId ? await db.machine(machineId) : await companyMachineOf(db, company.id)
    const instance = row.botId ? await db.instance(row.accountId, row.botId) : undefined
    const host = (instance?.host || machine?.host || '').trim()
    if (!host) {
      send(res, 200, { session, events: null, pullError: PULL_ERROR })
      return
    }
    const pulled = await pullSessionEvents(host, row.sessionId, {
      seat: await seatBearer(db, row.accountId),
      machine: machine?.token || '',
    })
    if (!pulled.ok) {
      send(res, 200, { session, events: null, pullError: PULL_ERROR })
      return
    }
    send(res, 200, { session, events: pulled.events })
  })

  router.get('/orgs/:id/audit', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    send(res, 200, {
      events: (await db.auditsOf(req.params.id)).map((e) => ({
        id: e.id,
        accountId: e.accountId,
        action: e.action,
        detail: e.detail,
        createdAt: e.createdAt,
      })),
    })
  })

  /**
   * 配对。**这条路由没有登录态**——配对码本身就是凭据，装机的人手里只有它。
   *
   * 做完三件事：签一把 `smt_`、把机器地址记成请求的来源 IP、**立刻回拨一次**确认
   * Gateway 真能打到这台机器。最后那一下不能省：不然「配对成功但打不通」会拖到第
   * 一次部署才暴露，那时装机的人已经离开机器了。
   *
   * 回拨用 challenge 而不是 `smt_`：那一刻票还在我们手里，管家还没收到响应。
   */
  router.post('/machines/pair', async (req, res) => {
    const body = bodyOf(req)
    const code = normalizePairingCode(strField(body, 'code'))
    const port = intField(body, 'managerPort') ?? 8443
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'managerPort 不合法')
    const protocol = intField(body, 'protocol') ?? 0
    const managerVersion = strField(body, 'managerVersion', false) || null
    const challenge = strField(body, 'challenge', false)

    const now = Date.now()
    const pairing = await db.machinePairing(code)
    // 不存在 / 用过 / 过期一律同一句话：区分了就是在帮人猜码。
    if (!pairing || pairing.usedAt || pairing.expiresAt <= now) throw new HttpError(401, '配对码无效或已过期')
    const company = await db.company(pairing.companyId)
    if (!company) throw new HttpError(404, '公司不存在')

    const ip = sourceIpOf(req)
    if (!ip) throw new HttpError(400, '取不到来源地址，无法配对')
    const host = managerHostOf(`${ip.includes(':') ? `[${ip}]` : ip}:${port}`)

    // 一家公司可以有多台机器。**同一个地址算同一台**——重跑装机脚本是修复手段，
    // 不该凭空多出一台机器；地址不同才是新增。重配会换一把新票，旧管家立刻失效。
    const existing = await db.machineByHost(company.id, host)
    const machine = await db.tx(async () => {
      let row: Machine
      if (existing) {
        await db.rotateMachineToken(existing.id)
        row = (await db.updateMachine(existing.id, {
          host,
          companyId: company.id,
          pairedAt: now,
          managerVersion,
          protocol,
          lastError: null,
        }))!
        row = (await db.machine(existing.id))!
      } else {
        row = await db.insertMachine({ companyId: company.id, host, pairedAt: now, managerVersion, protocol })
      }
      if (!(await db.claimMachinePairing(code, row.id, now))) throw new HttpError(401, '配对码无效或已过期')
      // machineId 现在只是「默认那台」，多机之后调度由 machineForAccount 决定。
      // 第一台配上时顺手把它设成默认，并补上访问地址。
      if (!company.machineId) {
        await db.updateCompany(company.id, {
          machineId: row.id,
          accessUrl: company.accessUrl ?? accessUrlFor(company.slug),
        })
      }
      await db.audit({
        companyId: company.id,
        accountId: pairing.createdBy,
        action: existing ? 'machine.repair' : 'machine.pair',
        detail: { machineId: row.id, host, managerVersion, protocol },
      })
      return row
    })

    const probe = challenge ? await managerHealth(host, { challenge }) : { ok: false, error: '没有 challenge，跳过回拨' }
    if (!probe.ok) await db.updateMachine(machine.id, { lastError: `Gateway 打不到 ${host}：${probe.error}` })
    send(res, 201, {
      machineId: machine.id,
      token: machine.token,
      host,
      reachable: probe.ok,
      error: probe.ok ? null : probe.error,
      protocolTooOld: protocol < MIN_MANAGER_PROTOCOL,
    })
  })

  // ── 机器服务凭证。登记用引导票；心跳 / ready / 索引 / 用量用每台机器的 smt_。──

  router.post('/internal/machines', async (req, res) => {
    requireBootstrapMachine(req)
    const body = bodyOf(req)
    const id = body.id != null ? strField(body, 'id', false) || undefined : undefined
    const rawHost = body.host != null ? strField(body, 'host', false) : ''
    const host = rawHost ? machineHostOf(rawHost) : null
    if (id && await db.machine(id)) throw new HttpError(409, '这台机器已经登记')
    const machine = await db.insertMachine({ id, host })
    send(res, 201, { machine: { ...publicMachine(machine), token: machine.token } })
  })

  /**
   * 心跳。也是自升级的下发通道。
   *
   * **升级是心跳驱动，不是 Gateway 推送**：推送要求推的那一刻机器在线且可达，
   * 心跳驱动只要机器最终上线就会收敛，灰度也只是改一个数字。响应里带上期望版本，
   * 管家发现和自己不一样就去换——换不换、什么时候换，由管家自己决定（部署跑到
   * 一半时它会跳过这一轮）。
   */
  router.post('/internal/machines/:id/heartbeat', async (req, res) => {
    const machine = await requireMachine(req, db)
    if (machine.id !== req.params.id) throw new HttpError(403, '机器凭证与路径不符')
    const body = (bodyOf(req) ?? {}) as Record<string, unknown>
    const managerVersion = typeof body.managerVersion === 'string' ? body.managerVersion.trim() : ''
    const protocol = Number(body.protocol)
    const upgradeError = typeof body.upgradeError === 'string' ? body.upgradeError.slice(0, 500) : null
    // 管家自报的 process.arch。只收认识的两个值——它决定给这台机器发哪个包，
    // 收一个乱七八糟的字符串只会让选包静默退回「按未知处理」。
    const rawArch = typeof body.arch === 'string' ? body.arch.trim() : ''
    const arch = rawArch === 'x64' || rawArch === 'arm64' ? rawArch : undefined
    // 管家自报的机器实际时区。**过一遍同一个校验器**——它来自网络，最后会显示在
    // 界面上；不认识的名字宁可当成「没报」，也不要存一个假的实际值进去，那会让
    // 「改上了没有」这个判断永远错。老管家不报，那时保持原样。
    const reportedTz = typeof body.timezone === 'string' ? normalizeTimezone(body.timezone) : undefined
    const next = await db.updateMachine(machine.id, {
      lastHeartbeatAt: Date.now(),
      ...(managerVersion ? { managerVersion } : {}),
      ...(Number.isInteger(protocol) ? { protocol } : {}),
      ...(arch ? { arch } : {}),
      ...(reportedTz === undefined ? {} : { currentTimezone: reportedTz }),
      lastError: upgradeError,
    })
    const desired = await desiredManagerRelease(db, next)
    send(res, 200, {
      machine: { id: next.id, lastHeartbeatAt: next.lastHeartbeatAt },
      desiredManagerVersion: desired?.version ?? null,
      url: desired ? `${gatewayBaseFor(req)}/internal/manager-releases/${encodeURIComponent(desired.version)}` : null,
      sha256: desired?.sha256 ?? null,
      // 期望时区。空 = 没人指定过，管家什么都不做——**不是**「改成 UTC」。
      timezone: next.timezone,
      minNode: MIN_MANAGER_NODE,
      minProtocol: MIN_MANAGER_PROTOCOL,
    })
  })

  /** 管家自升级拉包。和 bot 发布包同一套鉴权：这台机器的 `smt_`。 */
  router.get('/internal/manager-releases/:version', async (req, res) => {
    await requireMachine(req, db)
    await sendReleaseFile(res, 'manager', req.params.version, db)
  })

  /**
   * 管家按版本拉 bot 发布包。**取代了原来逐席位 scp 一遍完整安装包**——同一版本
   * 一台机器只拉一次，解在 /opt/satuwork/releases 下全机共享。
   */
  router.get('/internal/bot-releases/:version', async (req, res) => {
    await requireMachine(req, db)
    await sendReleaseFile(res, 'bot', req.params.version, db)
  })

  router.post('/internal/instances/:accountId/ready', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const account = await db.account(req.params.accountId)
    if (!account) throw new HttpError(404, '账号不存在')
    if (!account.companyId) throw new HttpError(403, '没有公司席位')
    if (account.companyId !== caller.companyId) throw new HttpError(403, '机器不属于这家公司')
    // 席位票只能报自己上线，不能替同公司的别人报。
    if (caller.kind === 'seat' && caller.account.id !== account.id) throw new HttpError(403, '席位票只能上报自己')
    const body = bodyOf(req)
    const botId = strField(body, 'botId')
    // 先校验 body.host 再查席位：它仍然是这条接口的输入契约，格式不对要 400，
    // 不能因为「席位还没部署」这个更靠后的原因把 400 盖成 404。
    const reportedHost = instanceHostOf(strField(bodyOf(req), 'host'))
    const seat = await db.seatRuntime(account.id, botId)
    if (!seat) throw new HttpError(404, '还没有部署')
    // **不再采信 body.host。** bot 报的是自己看到的地址，而它只听 127.0.0.1；那个
    // 地址对管家是对的，对 Gateway 是打不通的。以前采信它，结果是 bot 一上线就把
    // Gateway 写好的地址覆盖成 loopback，之后 Gateway 再也打不到这个 bot。
    // 现在只认管家的反代入口，这条上报的意义只剩「我起来了」。
    //
    // 例外只有 stub：那条路径上根本没有管家，bot 自报是唯一的地址来源。
    const reported = process.env.SATUWORK_DEPLOY_STUB === '1' ? reportedHost : ''
    // 反代入口来自**席位实际所在**的那台机器。管家自己报时就是它自己；bot 用席位票
    // 报时按 seat.machineId 查——不能回落到公司默认机器，多机公司会写出错的地址。
    const machine = caller.kind === 'machine' ? caller.machine : await db.machine(seat.machineId)
    const instance = await db.upsertInstance({
      accountId: account.id,
      botId,
      companyId: account.companyId,
      host: reported || botBaseOf(machine?.host ?? null, seat.seatId),
    })
    send(res, 200, { instance })
  })

  router.post('/internal/sessions/index', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const companyId = caller.companyId
    const body = bodyOf(req)
    const sessionId = strField(body, 'sessionId')
    const accountId = callerAccountId(caller, () => strField(body, 'accountId'))
    const bodyCompany = strField(body, 'companyId', false)
    if (bodyCompany && bodyCompany !== companyId) throw new HttpError(403, '机器不属于这家公司')
    const account = await db.account(accountId)
    if (!account || account.companyId !== companyId) throw new HttpError(403, '账号不属于这家公司')
    const botIdRaw = body.botId == null ? undefined : strField(body, 'botId', false)
    const titleRaw = body.title == null ? undefined : strField(body, 'title', false)
    const originRaw = body.origin == null ? undefined : strField(body, 'origin', false)
    const remoteIdRaw = body.remoteId == null ? undefined : strField(body, 'remoteId', false)
    // machineId **一律服务端算**，不收 body。它决定了之后拉全文时 Gateway 去敲哪台
    // 机器、带哪把票；采信 body 等于让调用方指定这条会话「属于」哪台机器。
    // 席位票那条按**账号**查机器，不按 botId：会话根事件不一定带 botId（`data.botId ||
    // null`），按 botId 查的话这种会话就落不到机器上，拉全文时又回落到公司默认机器——
    // 正是 machineTokenFor 修掉的那个 host/token 错配。账号粘住机器（见
    // docs/gateway-runtime.md §3.0），所以取该账号任意一个席位的机器都是对的。
    const machineId =
      caller.kind === 'machine'
        ? caller.machine.id
        : (await db.seatRuntimesOfAccount(accountId))[0]?.machineId ?? null
    const session = await db.upsertSessionIndex({
      sessionId,
      companyId,
      accountId,
      botId: botIdRaw === undefined ? undefined : botIdRaw || null,
      machineId: machineId ?? undefined,
      origin: originRaw === undefined ? undefined : originRaw || null,
      remoteId: remoteIdRaw === undefined ? undefined : remoteIdRaw || null,
      messageCount: intField(body, 'messageCount'),
      title: titleRaw === undefined ? undefined : titleRaw || null,
      createdAt: intField(body, 'createdAt'),
      updatedAt: intField(body, 'updatedAt'),
    })
    send(res, 200, { session })
  })

  /**
   * 收下就算了，**不写库**。
   *
   * bot 的每一次模型调用都是走 `/v1/chat/completions` 从这里出去的，那条路上
   * `recordLlmCall` 已经按请求写了一行 llm_calls，用的还是上游返回的原始 usage。
   * 这里再插一行，同一次调用就记了两遍——账面上的用量直接翻倍。
   *
   * 端点保留，是因为线上还有旧版 bot 在轮次结束时调它：改成 404 会让它们的本地
   * 队列永远重试不掉。新版 bot 已经不发了（见 bot/src/session/gateway.ts）。
   * 等所有席位都升上去之后，这段可以整个删掉。
   */
  router.post('/internal/usage', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    // 不写库了，但**租户边界照查**：这条路仍然是一台机器拿着自己的票点名某个账号，
    // 少了这一层，跨公司的机器就能拿别家账号的 id 试出「这个账号存不存在」。
    const accountId = callerAccountId(caller, () => strField(bodyOf(req), 'accountId'))
    const account = await db.account(accountId)
    if (!account || account.companyId !== caller.companyId) throw new HttpError(403, '账号不属于这家公司')
    send(res, 200, { ok: true, recorded: false })
  })
}
