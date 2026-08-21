/**
 * 公司、账号、分组、会话索引：校验与对外序列化。
 *
 * 从 routes.ts 拆出来的——那个文件曾经是 5700 行，前 1900 行全是这类帮手。
 */
import { EMAIL_RE, PHONE_RE, SLUG_RE, strField } from './validate.ts'
import { HttpError } from '../http.ts'
import { type Account, type CatalogItem, type Company, type CompanySettings, type CompanyStatus, type Db, type Group, type ModelRole, PRICE_MULTIPLIER_MAX, PRICE_MULTIPLIER_MIN, type Plan, type PlatformSettings, type Role, type SessionIndex, parseConnectorPricing, parsePriceMultiplier } from '../db.ts'

export function emailOf(raw: string): string {
  const email = raw.trim().toLowerCase()
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'email 格式不对')
  return email
}

export function slugOf(raw: string): string {
  const slug = raw.trim().toLowerCase()
  if (!SLUG_RE.test(slug)) throw new HttpError(400, 'slug 只能是小写字母开头的短名（字母数字和连字符）')
  return slug
}

export function companyStatusOf(v: unknown): CompanyStatus {
  if (v !== 'active' && v !== 'disabled') throw new HttpError(400, 'status 只能是 active 或 disabled')
  return v
}

/**
 * 到期时间。收 `YYYY-MM-DD`（当天 23:59:59 到期，按本地时区）或毫秒时间戳；
 * null / 空串 = 不限期。
 */
export function expiresAtOf(v: unknown): number | null {
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
export function phoneOf(raw: string): string {
  const phone = raw.trim()
  if (!PHONE_RE.test(phone)) throw new HttpError(400, '电话要带国家区号，例如 +86 13800000000')
  return phone
}

/** 公司官网。可以不写 scheme，补成 https；别的协议不收。 */
export function websiteOf(raw: string): string {
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

export function roleOf(v: unknown, fallback: Role = 'member'): Role {
  if (v == null || v === '') return fallback
  if (v !== 'admin' && v !== 'member') throw new HttpError(400, 'role 只能是 admin 或 member')
  return v
}

export function modelRoleOf(v: unknown, label: string): ModelRole {
  if (v == null) return { provider: '', model: '' }
  if (typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `${label} 必须是对象`)
  const o = v as Record<string, unknown>
  const provider = o.provider == null || o.provider === '' ? '' : strField(o, 'provider')
  const model = o.model == null || o.model === '' ? '' : strField(o, 'model')
  if (Boolean(provider) !== Boolean(model)) throw new HttpError(400, `${label} 需要同时有 provider 和 model`)
  return { provider, model }
}

export function publicSettings(s: CompanySettings | PlatformSettings): PlatformSettings {
  return {
    daily: { provider: s.daily.provider, model: s.daily.model },
    utility: { provider: s.utility.provider, model: s.utility.model },
    enabledModels: Array.isArray((s as PlatformSettings).enabledModels) ? (s as PlatformSettings).enabledModels : [],
    priceMultiplier: parsePriceMultiplier((s as PlatformSettings).priceMultiplier),
    connectorPricing: parseConnectorPricing((s as PlatformSettings).connectorPricing),
    managerVersion: (s as PlatformSettings).managerVersion ?? '',
  }
}

export function publicPlatformCred(c: { provider: string; createdAt: number; updatedAt: number }) {
  return { configured: true as const, provider: c.provider, createdAt: c.createdAt, updatedAt: c.updatedAt }
}

/**
 * 公司当前的订阅。套餐名跟着 SKU 走（SKU 改名这里就改名），所以每次现查，不落一份副本。
 * 套餐被删了就当没订：skuId 留着，名字给 null，界面显示「—」。
 */
export async function publicPlan(db: Db, plan: Plan | undefined, used: number) {
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

export async function orgSummary(db: Db, c: Company) {
  const plan = await db.plan(c.id)
  const used = await db.accountCount(c.id)
  return {
    ...publicCompany(c),
    seats: plan?.seats ?? 0,
    used,
    plan: await publicPlan(db, plan, used),
  }
}

export function enabledModelsOf(v: unknown): string[] {
  if (v == null) return []
  if (!Array.isArray(v)) throw new HttpError(400, 'enabledModels 必须是数组')
  return v.map((x) => {
    if (typeof x !== 'string' || !x.trim()) throw new HttpError(400, 'enabledModels 必须是模型 id 字符串')
    return x.trim()
  })
}

/** 倍率写坏了要当场报错，不能悄悄回落成 1——那等于把管理员改的价吞了。 */
export function priceMultiplierOf(v: unknown, fallback: number): number {
  if (v == null || v === '') return fallback
  const n = Number(v)
  if (!Number.isFinite(n)) throw new HttpError(400, 'priceMultiplier 必须是数字')
  if (n < PRICE_MULTIPLIER_MIN || n > PRICE_MULTIPLIER_MAX) {
    throw new HttpError(400, `priceMultiplier 只能在 ${PRICE_MULTIPLIER_MIN} 到 ${PRICE_MULTIPLIER_MAX} 之间`)
  }
  return n
}

export function publicAccount(a: Account) {
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
export function publicGroup(g: Group) {
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

export function stringIds(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
}

export function groupRoleOf(v: unknown): 'admin' | 'member' {
  return v === 'admin' ? 'admin' : 'member'
}

export async function membersInCompany(db: Db, companyId: string, v: unknown): Promise<string[]> {
  const allowed = new Set((await db.accountsOf(companyId)).map((a) => a.id))
  return stringIds(v).filter((id) => allowed.has(id))
}

export function publicCompany(c: Company) {
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
export function sessionCursorOf(raw: string | null): { updatedAt: number; sessionId: string } | undefined {
  const text = (raw || '').trim()
  if (!text) return undefined
  const i = text.indexOf(':')
  const updatedAt = Number(text.slice(0, i))
  const sessionId = i < 0 ? '' : text.slice(i + 1)
  if (i < 0 || !Number.isFinite(updatedAt) || !sessionId) throw new HttpError(400, 'cursor 不合法')
  return { updatedAt, sessionId }
}

export async function publicSessionIndex(
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
