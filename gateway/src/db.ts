import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { randomAccessToken, randomApiKey, randomMachineToken } from './crypto.ts'

const { Pool } = pg
type PoolClient = pg.PoolClient

export type Role = 'owner' | 'admin' | 'member'
export type Scope = 'global' | 'company'
export type CatalogKind = 'model' | 'skill' | 'mcp' | 'bot' | 'provider'

export type CompanyStatus = 'active' | 'disabled'

export interface Company {
  id: string
  slug: string
  name: string
  /** 停用的公司整家进不来：本公司的人一律登不上，也刷不动 API。 */
  status: CompanyStatus
  /** 对接人。建公司时必填，出问题先找这个人。 */
  contactName: string
  contactPhone: string
  contactEmail: string
  /** 地址和网站可留空，留空存空串而不是 null。 */
  address: string
  website: string
  machineId: string | null
  accessUrl: string | null
  createdAt: number
  updatedAt: number
}

export type AccountStatus = 'active' | 'disabled' | 'invited'

export type Theme = 'light' | 'dark' | 'system'
export type Locale = 'zh' | 'en'

export interface Account {
  id: string
  companyId: string | null
  email: string
  name: string
  title: string
  phone: string
  theme: Theme
  locale: Locale
  passwordHash: string
  role: Role
  status: AccountStatus
  lastSeenAt: number | null
  passwordChangedAt: number | null
  /** 早于此时签发的 JWT 一律作废。Gateway 没有会话表，靠这个补「立刻踢下线」。 */
  tokenRevokedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Invite {
  id: string
  userId: string
  companyId: string
  createdBy: string
  createdAt: number
  expiresAt: number
}

export interface Plan {
  companyId: string
  seats: number
  /** 订的是价目表里的哪一条。null = 还没定套餐，只有席位。 */
  skuId: string | null
  /** 到期时间。null = 不限期。 */
  expiresAt: number | null
  updatedAt: number
}

/**
 * 套餐 SKU：owner 维护的价目表，一条 = 一个可卖的套餐。
 * 跟 `Plan` 不是一回事——`Plan` 是某家公司**当前**的席位额度，这里是「卖什么」。
 */
/** 套餐周期。存英文枚举当键，界面按语言翻——中文名进库以后没法换语言。 */
export type PlanPeriod = 'month' | 'quarter' | 'year'
export const PLAN_PERIODS: PlanPeriod[] = ['month', 'quarter', 'year']

/**
 * 订单：某公司买了什么。**买套餐和充值走同一张表**——都是「一笔钱 + 一个付款状态」，
 * 分两张表只会让「这家公司一共下过几单」变成两处查。
 *
 * 套餐单：套餐内容在下单时**抄一份存进来**（planName/seats/金额/赠送/周期）。
 * 价目表随时会改，但已经签出去的订单不能跟着变——查历史订单要看到当时卖的是什么。
 * planId 只用来追溯是哪条 SKU，不作为展示来源。
 *
 * 充值单：只有金额和备注，seats/bonus 是 0，`endAt` 等于 `startAt`（充值没有账期）。
 */
export type OrderKind = 'plan' | 'topup'
export const ORDER_KINDS: OrderKind[] = ['plan', 'topup']

/** 付款状态。只有这两种：钱到了没有。退款、部分付款这些还没有，别提前造。 */
export type PayStatus = 'unpaid' | 'paid'

export interface PlanOrder {
  id: string
  companyId: string
  kind: OrderKind
  planId: string | null
  planName: string
  planNameEn: string
  /** 充值单的备注。套餐单留空。 */
  note: string
  period: PlanPeriod
  seats: number
  amountMils: number
  bonusMils: number
  startAt: number
  endAt: number
  payStatus: PayStatus
  createdAt: number
  updatedAt: number
}

/**
 * 单独充值：给某家公司加一笔额度。
 *
 * 跟套餐赠送分开记，因为两者的规矩不一样：赠送的跟着套餐有效期走，套餐一到期没用完就清零；
 * 充值的**不过期**，用完为止。所以它们不能合成一个数存，得各算各的。
 */
export interface Topup {
  id: string
  companyId: string
  /** 是哪笔充值单付款之后开出来的。只有付了款才会有这条记录。 */
  orderId: string | null
  amountMils: number
  note: string
  /** 谁充的。账号删了就留 null，记录本身不跟着走。 */
  createdBy: string | null
  createdAt: number
}

/**
 * 账单：一条订单开一张。金额和账期在开单时抄下来——订单改了要跟着改，
 * 但账单是「这段时间该收多少钱」的凭据，不去实时算。
 */
export interface Invoice {
  id: string
  companyId: string
  orderId: string | null
  planName: string
  planNameEn: string
  amountMils: number
  periodStart: number
  periodEnd: number
  status: PayStatus
  paidAt: number | null
  createdAt: number
  updatedAt: number
}

export interface PlanSku {
  id: string
  /** 套餐名是**数据**，不是界面文案——译表翻不了它，只能两种语言各存一份。 */
  name: string
  nameEn: string
  /** 金额存「厘」（千分之一元）。钱不进浮点数；用厘是为了留出分以下的定价精度。 */
  amountMils: number
  seats: number
  /** 月包 / 季包 / 年包。默认月包。 */
  period: PlanPeriod
  /**
   * 赠送额度，跟金额一样按「厘」存、按美元显示。
   * 它是一笔钱（可以拿去买 token），不是 token 个数——所以要小数和 $ 符号。
   */
  bonusMils: number
  createdAt: number
  updatedAt: number
}

export interface Group {
  id: string
  companyId: string
  name: string
  desc: string
  icon: string
  role: 'admin' | 'member'
  members: string[]
  agents: string[]
  createdAt: number
}

export interface Machine {
  id: string
  /** 机器管家的基址 `http://<ip>:8443`。**Gateway 打这台机器的唯一入口。** */
  host: string | null
  companyId: string | null
  lastHeartbeatAt: number | null
  createdAt: number
  /** 配对完成的时刻。为空 = 还没装管家，部署会被挡下。 */
  pairedAt: number | null
  managerVersion: string | null
  /** 管家握手协议版本。整数，不解析 semver——太旧就不给它下发部署。 */
  protocol: number
  /** 管家上报的最近一次故障（升级失败等）。给界面看，不参与判定。 */
  lastError: string | null
  /**
   * 管家自报的 CPU 架构（`process.arch`，如 `x64` / `arm64`）。
   *
   * 发布包里带 esbuild 的原生二进制，装错架构起不来。选包按它过滤。
   * 为空 = 还没心跳过（老管家不报），那时退回「不按架构挑」的老行为。
   */
  arch: string | null
  /**
   * 这台机器最多承载几个**激活账号**。
   *
   * 计的是账号不是席位：一个员工的所有 bot 共用一个 uid 和 `~/work`，必须落在同一
   * 台机器上，所以调度单位只能是账号。账号名下再加 bot 不多占容量。
   */
  maxAccounts: number
  /**
   * 这台机器要用的时区（IANA 名，如 `Asia/Shanghai`）。空 = 不管，跟机器现状走。
   *
   * 和 `desiredManagerVersion` 一样是**期望值**：写在这里只是下指令，真正改的是
   * 管家（`timedatectl set-timezone`）。改完了没有由 `currentTimezone` 说了算。
   */
  timezone: string | null
  /** 管家心跳自报的机器**实际**时区。期望和实际分开，界面才说得清「改上了没有」。 */
  currentTimezone: string | null
  /**
   * 这台机器要追的管家版本。空 = 跟平台的全局期望版本走。
   *
   * 存在的理由是灰度：先把一台机器钉到新版本看几天，再改全局。没有它，「升级这台
   * 机器」这个按钮只能改全局设置，一按就是全机队。
   */
  desiredManagerVersion: string | null
  /**
   * 被移除的时刻。null = 在册。
   *
   * **这是一块墓碑，不是一台机器。** 平台上按「移除」之后，这一行对所有面向界面的
   * 查询等于不存在（见下面那批 `removedAt is null`），留着只为一件事：把「你被移除
   * 了」这个消息送到机器上——心跳是机器主动打的，Gateway 没有别的路子找它。
   *
   * 为什么不直接删了了事：删掉之后机器票就查不到，心跳只会拿到 401，而 401 是**否
   * 定式**信号（「我不认识你」）。Gateway 回滚版本、库恢复到旧快照、DNS 指错，都会
   * 让整个机队同时收到 401——管家要是据此自毁，那就是全机队自杀。墓碑让信号变成
   * **肯定式**的：我认识你，并且我告诉你你被移除了。
   *
   * 管家收拾完会回执（POST /internal/machines/:id/removed），那时才真删。它一直不
   * 来收信的话，超过 MACHINE_TOMBSTONE_TTL 由 sweepRemovedMachines 收掉。
   */
  removedAt: number | null
  token: string
}

export interface MachinePairing {
  code: string
  companyId: string
  createdBy: string | null
  createdAt: number
  expiresAt: number
  usedAt: number | null
  machineId: string | null
}

/** 新机器默认能装几个账号。够一个小团队，超了在界面上改。 */
export const DEFAULT_MAX_ACCOUNTS = 10

export type SeatRuntimeStatus = 'none' | 'deploying' | 'ready' | 'error'

export interface SeatRuntime {
  accountId: string
  botId: string
  companyId: string
  /** 员工的 Linux 账号。同一员工的多个 bot **共用**它——共享文件靠的就是这个。 */
  linuxUser: string
  /** 席位标识：systemd 实例名与席位私有目录名。公司内唯一。 */
  seatId: string
  /**
   * 这个席位落在哪台机器上。
   *
   * 同一个账号的所有席位**必须**在同一台机器上——它们共用一个 uid 和 `~/work`，
   * 拆到两台机器上「共享文件」就不成立了。调度因此以账号为单位。
   */
  machineId: string
  slot: number
  display: number
  vncPort: number
  novncPort: number
  botPort: number
  vncPassword: string
  status: SeatRuntimeStatus
  lastError: string | null
  deployedAt: number | null
  updatedAt: number
  botVersion: string | null
}

/** 发布包的种类。bot 装到席位上，manager 是机器管家自己。 */
export type ReleaseKind = 'bot' | 'manager'

/** 会话索引一页的默认条数与硬上限。调用方可以调小，调不大。 */
export const SESSION_PAGE_DEFAULT = 500
export const SESSION_PAGE_MAX = 2000

/** 把调用方给的 limit 收进合法区间。路由和 db 用同一套，免得两边各算各的。 */
export function sessionPageLimit(raw?: number): number {
  const n = Math.trunc(raw ?? SESSION_PAGE_DEFAULT)
  if (!Number.isFinite(n)) return SESSION_PAGE_DEFAULT
  return Math.min(Math.max(n, 1), SESSION_PAGE_MAX)
}

/**
 * 从版本号尾巴认架构：`…-x64` / `…-arm64`。
 *
 * 架构是打包时定死的（包里带 esbuild 的原生二进制），而版本号是唯一跟着包走到机器上
 * 的东西，所以约定把它编进版本号尾巴——CI 和本地出包都这么打。
 * 认不出来返回 undefined，意思是「不知道」，不是「通用」：调用方按未知处理，
 * 别当成匹配任意架构。
 */
export function releaseArch(version: string): string | undefined {
  const m = /-(x64|arm64)$/.exec(String(version || ''))
  return m ? m[1] : undefined
}

export interface BotRelease {
  kind: ReleaseKind
  version: string
  sha256: string
  size: number
  createdAt: number
  note: string
  /**
   * 包的下载地址。空 = 字节在 Gateway 本机磁盘上（CI 传上来的那种）。
   *
   * 非空时 Gateway 不存字节，下发时从这个地址现取并流式转出去——**转而不是 302**，
   * 因为 `x-bot-sha256` 那个校验头要跟着响应走，重定向之后管家就拿不到了。
   */
  url: string
}

export interface CatalogItem {
  id: string
  kind: CatalogKind
  scope: Scope
  companyId: string | null
  name: string
  definition: unknown
  createdAt: number
  updatedAt: number
}

export interface Credential {
  id: string
  companyId: string
  provider: string
  secret: string
  createdAt: number
  updatedAt: number
}

export interface AuditEvent {
  id: string
  companyId: string
  accountId: string | null
  action: string
  detail: unknown
  createdAt: number
}

/** Gateway 只存指针。正文永远不该出现在这张表里。 */
export interface SessionIndex {
  sessionId: string
  companyId: string
  accountId: string
  botId: string | null
  machineId: string | null
  origin: string | null
  remoteId: string | null
  messageCount: number | null
  title: string | null
  createdAt: number
  updatedAt: number
}

export interface Instance {
  accountId: string
  botId: string
  companyId: string | null
  host: string
  lastReadyAt: number
}

export interface AccountSecrets {
  accountId: string
  apiKey: string
  accessToken: string
  createdAt: number
}

export interface LlmCall {
  id: string
  accountId: string
  companyId: string | null
  provider: string
  model: string
  /** 整个提示词，含命中缓存的部分。 */
  promptTokens: number
  completionTokens: number
  /** promptTokens 里命中缓存的那一截，是子集不是加项。 */
  cachedTokens: number
  createdAt: number
}

export interface LlmUsageByAccount {
  accountId: string
  calls: number
  promptTokens: number
  completionTokens: number
  lastAt: number | null
}

export interface LlmUsage {
  calls: number
  promptTokens: number
  completionTokens: number
  byAccount: LlmUsageByAccount[]
}

/** 平台统计的底表行。companyId 为 null 的是 owner 自己发起的调用。 */
export interface CompanyModelUsage {
  companyId: string | null
  provider: string
  model: string
  calls: number
  promptTokens: number
  completionTokens: number
  lastAt: number | null
}

export interface ModelRole {
  provider: string
  model: string
}

export interface CompanySettings {
  daily: ModelRole
  utility: ModelRole
}

export interface PlatformSettings {
  daily: ModelRole
  utility: ModelRole
  enabledModels?: string[]
  /** 对外报价相对模型原价的倍率。1 就是按原价，1.2 就是加两成。 */
  priceMultiplier?: number
  /**
   * 全机队期望的管家版本。留空 = 跟最新发布走。
   *
   * 灰度就靠改这一个数字：心跳时下发，机器自己去换。回滚同理——把它改回上一版，
   * 下一轮心跳各台机器自己退回去。
   */
  managerVersion?: string
}

/** 倍率的合法区间。0 会把报价抹平成免费，上限挡住一个手滑多打的零。 */
export const PRICE_MULTIPLIER_MIN = 0.01
export const PRICE_MULTIPLIER_MAX = 100

export function parsePriceMultiplier(v: unknown, fallback = 1): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n < PRICE_MULTIPLIER_MIN || n > PRICE_MULTIPLIER_MAX) return fallback
  return n
}

export function emptySettings(): CompanySettings {
  return { daily: { provider: '', model: '' }, utility: { provider: '', model: '' } }
}

export function emptyPlatformSettings(): PlatformSettings {
  return { daily: { provider: '', model: '' }, utility: { provider: '', model: '' }, enabledModels: [], priceMultiplier: 1, managerVersion: '' }
}

type Row = Record<string, unknown>

function str(v: unknown): string {
  return String(v)
}

/** PG 的唯一约束冲突是 23505。别去 match 报错文案。 */
export function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && (e as { code?: string }).code === '23505')
}
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v)
}
/** bigint 在 pg 里回来是字符串（超出 double 安全范围时不该硬转，但毫秒时间戳远没到）。 */
function num(v: unknown): number {
  return Number(v)
}
function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v)
}
/** jsonb 回来已经是对象；早期写进去的字符串也兜一下。 */
function jsonOf(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? {}
  try {
    return JSON.parse(v)
  } catch {
    return {}
  }
}

function companyOf(r: Row): Company {
  return {
    id: str(r.id),
    slug: str(r.slug),
    name: str(r.name),
    status: str(r.status) === 'disabled' ? 'disabled' : 'active',
    contactName: str(r.contactName),
    contactPhone: str(r.contactPhone),
    contactEmail: str(r.contactEmail),
    address: str(r.address),
    website: str(r.website),
    machineId: strOrNull(r.machineId),
    accessUrl: strOrNull(r.accessUrl),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}
function themeOf(v: unknown): Theme {
  const t = str(v || 'system')
  return t === 'light' || t === 'dark' || t === 'system' ? t : 'system'
}
function localeOf(v: unknown): Locale {
  return str(v || 'zh') === 'en' ? 'en' : 'zh'
}
function accountOf(r: Row): Account {
  const email = str(r.email)
  const status = str(r.status || 'active')
  return {
    id: str(r.id),
    companyId: strOrNull(r.companyId),
    email,
    name: str(r.name || email.split('@')[0] || email),
    title: str(r.title || ''),
    phone: str(r.phone || ''),
    theme: themeOf(r.theme),
    locale: localeOf(r.locale),
    passwordHash: str(r.passwordHash),
    role: str(r.role) as Role,
    status: status === 'disabled' || status === 'invited' ? status : 'active',
    lastSeenAt: numOrNull(r.lastSeenAt),
    passwordChangedAt: numOrNull(r.passwordChangedAt),
    tokenRevokedAt: numOrNull(r.tokenRevokedAt),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}

function inviteOf(r: Row): Invite {
  return {
    id: str(r.id),
    userId: str(r.userId),
    companyId: str(r.companyId),
    createdBy: str(r.createdBy),
    createdAt: num(r.createdAt),
    expiresAt: num(r.expiresAt),
  }
}

function nameFromEmail(email: string): string {
  const local = email.split('@')[0]?.trim()
  return local || email
}

function parseModelRole(raw: Partial<ModelRole> | undefined): ModelRole {
  return { provider: String(raw?.provider ?? ''), model: String(raw?.model ?? '') }
}

function parsePlatformPayload(raw: unknown): PlatformSettings {
  const o = (jsonOf(raw) ?? {}) as Partial<PlatformSettings>
  if (!o || typeof o !== 'object') return emptyPlatformSettings()
  const enabled = Array.isArray(o.enabledModels) ? o.enabledModels.map((x) => String(x)).filter(Boolean) : []
  return {
    daily: parseModelRole(o.daily),
    utility: parseModelRole(o.utility),
    enabledModels: enabled,
    // 老库里没有这个字段，回落成 1——按原价，等于没开倍率。
    priceMultiplier: parsePriceMultiplier(o.priceMultiplier),
    // 空字符串 = 没钉，跟最新发布走。写端和这里必须成对，少一边这个开关就是死的。
    managerVersion: typeof o.managerVersion === 'string' ? o.managerVersion.trim() : '',
  }
}
function planOf(r: Row): Plan {
  return {
    companyId: str(r.companyId),
    seats: num(r.seats),
    skuId: strOrNull(r.skuId),
    expiresAt: r.expiresAt == null ? null : num(r.expiresAt),
    updatedAt: num(r.updatedAt),
  }
}

/** 库里存的是英文枚举；认不出来的一律当月包，不让脏值把界面弄崩。 */
function periodOf(v: unknown): PlanPeriod {
  const s = String(v ?? '')
  return (PLAN_PERIODS as string[]).includes(s) ? (s as PlanPeriod) : 'month'
}

function payStatusOfRow(v: unknown): PayStatus {
  return String(v ?? '') === 'paid' ? 'paid' : 'unpaid'
}

function topupOf(r: Row): Topup {
  return {
    id: str(r.id),
    companyId: str(r.companyId),
    orderId: strOrNull(r.orderId),
    amountMils: num(r.amountMils),
    note: str(r.note || ''),
    createdBy: strOrNull(r.createdBy),
    createdAt: num(r.createdAt),
  }
}

function invoiceOf(r: Row): Invoice {
  return {
    id: str(r.id),
    companyId: str(r.companyId),
    orderId: strOrNull(r.orderId),
    planName: str(r.planName),
    planNameEn: str(r.planNameEn || ''),
    amountMils: num(r.amountMils),
    periodStart: num(r.periodStart),
    periodEnd: num(r.periodEnd),
    status: payStatusOfRow(r.status),
    paidAt: r.paidAt == null ? null : num(r.paidAt),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}

function orderKindOfRow(v: unknown): OrderKind {
  return String(v ?? '') === 'topup' ? 'topup' : 'plan'
}

function planOrderOf(r: Row): PlanOrder {
  return {
    id: str(r.id),
    companyId: str(r.companyId),
    kind: orderKindOfRow(r.kind),
    note: str(r.note || ''),
    planId: r.planId ? str(r.planId) : null,
    planName: str(r.planName),
    planNameEn: str(r.planNameEn || ''),
    period: periodOf(r.period),
    seats: num(r.seats),
    amountMils: num(r.amountMils),
    bonusMils: num(r.bonusMils),
    startAt: num(r.startAt),
    endAt: num(r.endAt),
    payStatus: payStatusOfRow(r.payStatus),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}

function planSkuOf(r: Row): PlanSku {
  return {
    id: str(r.id),
    name: str(r.name),
    nameEn: str(r.nameEn || ''),
    amountMils: num(r.amountMils),
    seats: num(r.seats),
    period: periodOf(r.period),
    bonusMils: num(r.bonusMils),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}

function parseIdList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x))
  const v = jsonOf(raw)
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}

function groupOf(r: Row): Group {
  return {
    id: str(r.id),
    companyId: str(r.companyId),
    name: str(r.name),
    desc: str(r.desc || ''),
    icon: str(r.icon || 'chat'),
    role: str(r.role) === 'admin' ? 'admin' : 'member',
    members: parseIdList(r.members),
    agents: parseIdList(r.agents),
    createdAt: num(r.createdAt),
  }
}
function machineOf(r: Row): Machine {
  return {
    id: str(r.id),
    host: strOrNull(r.host),
    companyId: strOrNull(r.companyId),
    lastHeartbeatAt: numOrNull(r.lastHeartbeatAt),
    createdAt: num(r.createdAt),
    pairedAt: numOrNull(r.pairedAt),
    managerVersion: strOrNull(r.managerVersion),
    protocol: r.protocol == null ? 0 : num(r.protocol),
    lastError: strOrNull(r.lastError),
    arch: strOrNull(r.arch),
    maxAccounts: r.maxAccounts == null ? DEFAULT_MAX_ACCOUNTS : num(r.maxAccounts),
    timezone: strOrNull(r.timezone),
    currentTimezone: strOrNull(r.currentTimezone),
    desiredManagerVersion: strOrNull(r.desiredManagerVersion),
    removedAt: numOrNull(r.removedAt),
    token: str(r.token || ''),
  }
}

function machinePairingOf(r: Row): MachinePairing {
  return {
    code: str(r.code),
    companyId: str(r.companyId),
    createdBy: strOrNull(r.createdBy),
    createdAt: num(r.createdAt),
    expiresAt: num(r.expiresAt),
    usedAt: numOrNull(r.usedAt),
    machineId: strOrNull(r.machineId),
  }
}

function seatStatusOf(v: unknown): SeatRuntimeStatus {
  const s = str(v || 'none')
  if (s === 'deploying' || s === 'ready' || s === 'error' || s === 'none') return s
  return 'error'
}

function seatRuntimeOf(r: Row): SeatRuntime {
  return {
    accountId: str(r.accountId),
    botId: str(r.botId),
    companyId: str(r.companyId),
    linuxUser: str(r.linuxUser),
    seatId: str(r.seatId),
    machineId: str(r.machineId),
    slot: num(r.slot),
    display: num(r.display),
    vncPort: num(r.vncPort),
    novncPort: num(r.novncPort),
    botPort: num(r.botPort),
    vncPassword: str(r.vncPassword),
    status: seatStatusOf(r.status),
    lastError: strOrNull(r.lastError),
    deployedAt: numOrNull(r.deployedAt),
    updatedAt: num(r.updatedAt),
    botVersion: strOrNull(r.botVersion),
  }
}
function botReleaseOf(r: Row): BotRelease {
  return {
    kind: str(r.kind || 'bot') === 'manager' ? 'manager' : 'bot',
    version: str(r.version),
    sha256: str(r.sha256),
    size: num(r.size),
    createdAt: num(r.createdAt),
    note: str(r.note || ''),
    url: str(r.url || ''),
  }
}
function catalogOf(r: Row): CatalogItem {
  return {
    id: str(r.id),
    kind: str(r.kind) as CatalogKind,
    scope: str(r.scope) as Scope,
    companyId: strOrNull(r.companyId),
    name: str(r.name),
    definition: jsonOf(r.definition),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}
function credOf(r: Row): Credential {
  return {
    id: str(r.id),
    companyId: str(r.companyId),
    provider: str(r.provider),
    secret: str(r.secret),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}
function auditOf(r: Row): AuditEvent {
  return {
    id: str(r.id),
    companyId: str(r.companyId),
    accountId: strOrNull(r.accountId),
    action: str(r.action),
    detail: jsonOf(r.detail),
    createdAt: num(r.createdAt),
  }
}
function sessionIndexOf(r: Row): SessionIndex {
  return {
    sessionId: str(r.sessionId),
    companyId: str(r.companyId),
    accountId: str(r.accountId),
    botId: strOrNull(r.botId),
    machineId: strOrNull(r.machineId),
    origin: strOrNull(r.origin),
    remoteId: strOrNull(r.remoteId),
    messageCount: numOrNull(r.messageCount),
    title: strOrNull(r.title),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}

function instanceOf(r: Row): Instance {
  return {
    accountId: str(r.accountId),
    botId: str(r.botId),
    companyId: strOrNull(r.companyId),
    host: str(r.host),
    lastReadyAt: num(r.lastReadyAt),
  }
}

/** `?` 占位符换成 PG 的 `$1..$n`。SQL 照原样写，省得每条都数一遍位置。 */
function toPg(text: string): string {
  let i = 0
  return text.replace(/\?/g, () => `$${++i}`)
}

/** schema 名只允许普通标识符：它要拼进 SQL，不能走参数。 */
export function safeSchema(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`不合法的 schema 名：${name}`)
  return name
}

export interface DbOptions {
  url: string
  schema?: string
}

export function databaseUrl(): string {
  const url = (process.env.GATEWAY_DATABASE_URL || '').trim()
  if (!url) {
    throw new Error(
      '未配置 GATEWAY_DATABASE_URL。示例：postgres://satuwork:satuwork@127.0.0.1:5434/satuwork（docker compose up -d postgres）',
    )
  }
  return url
}

/**
 * Gateway 自己的库（PostgreSQL）。跟 Bot 的 satuwork.db 不是同一份——
 * 聊天正文永远不该出现在这里。
 *
 * 驼峰列名一律加引号：PG 不加引号会折成小写，而 `select *` 的结果直接喂给上面那些
 * mapper。加了引号，写漏的那一刻 PG 就报 column does not exist，不会静默变 undefined。
 */
export class Db {
  private pool: pg.Pool
  private schema: string
  /** 事务期间把 client 放这儿，`db.tx(() => db.xxx())` 里的每条语句才走同一个连接。 */
  private txClient = new AsyncLocalStorage<PoolClient>()

  constructor(opts: DbOptions | string) {
    const o = typeof opts === 'string' ? { url: opts } : opts
    this.schema = safeSchema(o.schema || process.env.GATEWAY_PG_SCHEMA || 'public')
    // search_path 走连接启动参数，不走 connect 事件里补一条 `set`——后者不等它跑完
    // 就可能先发业务查询，是条竞态。
    this.pool = new Pool({
      connectionString: o.url,
      max: 10,
      options: `-c search_path=${this.schema}`,
    })
    this.pool.on('error', (e) => {
      console.error(`satuwork-gateway: 连接池错误 ${e.message}`)
    })
  }

  private async query(text: string, params: unknown[] = []): Promise<pg.QueryResult> {
    const client = this.txClient.getStore()
    if (client) return client.query(toPg(text), params)
    return this.pool.query(toPg(text), params)
  }

  private async one(text: string, params: unknown[] = []): Promise<Row | undefined> {
    const r = await this.query(text, params)
    return r.rows[0] as Row | undefined
  }

  private async many(text: string, params: unknown[] = []): Promise<Row[]> {
    const r = await this.query(text, params)
    return r.rows as Row[]
  }

  private async run(text: string, params: unknown[] = []): Promise<number> {
    const r = await this.query(text, params)
    return r.rowCount ?? 0
  }

  /** 建 schema 和表。空库起步，没有从 SQLite 升上来的迁移。 */
  async init(): Promise<void> {
    if (this.schema !== 'public') {
      // e2e 每轮要干净的库。**只对非 public schema 生效**——生产跑在 public 上，
      // 这个开关碰不到它。
      if (process.env.GATEWAY_PG_RESET === '1') {
        await this.pool.query(`drop schema if exists "${this.schema}" cascade`)
      }
      await this.pool.query(`create schema if not exists "${this.schema}"`)
    }
    await this.query(`
      create table if not exists companies (
        id             text primary key,
        slug           text not null unique,
        name           text not null,
        status         text not null default 'active',
        "contactName"  text not null default '',
        "contactPhone" text not null default '',
        "contactEmail" text not null default '',
        address        text not null default '',
        website        text not null default '',
        "machineId"    text,
        "accessUrl"    text,
        "createdAt"    bigint not null,
        "updatedAt"    bigint not null
      );
      -- 联系人字段和启用状态比这张表晚落地，已经建过的库要补列。
      -- 状态不写库级 check：alter 加列带不上，新老库会长得不一样，值由 companyOf 归一。
      alter table companies add column if not exists status text not null default 'active';
      alter table companies add column if not exists "contactName" text not null default '';
      alter table companies add column if not exists "contactPhone" text not null default '';
      alter table companies add column if not exists "contactEmail" text not null default '';
      alter table companies add column if not exists address text not null default '';
      alter table companies add column if not exists website text not null default '';
      create table if not exists accounts (
        id                  text primary key,
        "companyId"         text references companies(id),
        email               text not null unique,
        name                text not null default '',
        title               text not null default '',
        phone               text not null default '',
        theme               text not null default 'system',
        locale              text not null default 'zh',
        "passwordHash"      text not null,
        role                text not null check (role in ('owner', 'admin', 'member')),
        status              text not null default 'active' check (status in ('active', 'disabled', 'invited')),
        "lastSeenAt"        bigint,
        "passwordChangedAt" bigint,
        "tokenRevokedAt"    bigint,
        "createdAt"         bigint not null,
        "updatedAt"         bigint not null
      );
      create table if not exists invites (
        id          text primary key,
        "userId"    text not null,
        "companyId" text not null,
        "createdBy" text not null,
        "createdAt" bigint not null,
        "expiresAt" bigint not null
      );
      create index if not exists invites_user on invites ("userId");
      create table if not exists plans (
        "companyId" text primary key references companies(id),
        seats       integer not null,
        "skuId"     text,
        "expiresAt" bigint,
        "updatedAt" bigint not null
      );
      -- 订阅的套餐和到期时间比席位晚落地，已经建过的库要补列。
      alter table plans add column if not exists "skuId" text;
      alter table plans add column if not exists "expiresAt" bigint;
      create table if not exists plan_skus (
        id            text primary key,
        name          text not null,
        "nameEn"      text not null default '',
        "amountMils"  bigint not null default 0,
        seats         integer not null,
        period        text not null default 'month',
        "bonusMils"   bigint not null default 0,
        "createdAt"   bigint not null,
        "updatedAt"   bigint not null
      );
      -- 这张表比双语名和赠送额度先落地，已经建过的库要补列。
      -- 跟上面 companies 一样：create table if not exists 加不了列，只能 alter。
      alter table plan_skus add column if not exists "nameEn" text not null default '';
      alter table plan_skus add column if not exists "bonusMils" bigint not null default 0;
      alter table plan_skus add column if not exists "amountMils" bigint not null default 0;
      alter table plan_skus add column if not exists period text not null default 'month';
      -- 金额从「分」改存「厘」：老值 ×10 搬过去，再把老列去掉。
      -- 只在老列还在时跑一次；新库压根没有 amountCents，这段是空转。
      do $$
      begin
        if exists (
          select 1 from information_schema.columns
          where table_schema = current_schema() and table_name = 'plan_skus' and column_name = 'amountCents'
        ) then
          update plan_skus set "amountMils" = "amountCents" * 10;
          alter table plan_skus drop column "amountCents";
        end if;
        -- 赠送额度从「token 个数」改成「钱」：原来填的数字当美元看，×1000 变厘。
        -- 填 100 的那条迁完显示 $100.00，跟当初敲进去的数字一致。
        if exists (
          select 1 from information_schema.columns
          where table_schema = current_schema() and table_name = 'plan_skus' and column_name = 'bonusTokens'
        ) then
          update plan_skus set "bonusMils" = "bonusTokens" * 1000;
          alter table plan_skus drop column "bonusTokens";
        end if;
      end
      $$;
      create table if not exists plan_orders (
        id           text primary key,
        "companyId"  text not null references companies(id),
        kind         text not null default 'plan',
        note         text not null default '',
        "planId"     text references plan_skus(id),
        "planName"   text not null,
        "planNameEn" text not null default '',
        period       text not null default 'month',
        seats        integer not null,
        "amountMils" bigint not null default 0,
        "bonusMils"  bigint not null default 0,
        "startAt"    bigint not null,
        "endAt"      bigint not null,
        "payStatus"  text not null default 'unpaid',
        "createdAt"  bigint not null,
        "updatedAt"  bigint not null
      );
      create index if not exists plan_orders_company on plan_orders ("companyId");
      -- 付款状态、单据类型（套餐/充值）和备注比订单晚落地，已经建过的库要补列。
      alter table plan_orders add column if not exists "payStatus" text not null default 'unpaid';
      alter table plan_orders add column if not exists kind text not null default 'plan';
      alter table plan_orders add column if not exists note text not null default '';
      create table if not exists invoices (
        id            text primary key,
        "companyId"   text not null references companies(id),
        "orderId"     text references plan_orders(id),
        "planName"    text not null,
        "planNameEn"  text not null default '',
        "amountMils"  bigint not null default 0,
        "periodStart" bigint not null,
        "periodEnd"   bigint not null,
        status        text not null default 'unpaid',
        "paidAt"      bigint,
        "createdAt"   bigint not null,
        "updatedAt"   bigint not null
      );
      create index if not exists invoices_company on invoices ("companyId", "periodStart" desc);
      create table if not exists topups (
        id           text primary key,
        "companyId"  text not null references companies(id),
        "orderId"    text references plan_orders(id),
        "amountMils" bigint not null,
        note         text not null default '',
        "createdBy"  text,
        "createdAt"  bigint not null
      );
      create index if not exists topups_company on topups ("companyId", "createdAt" desc);
      -- 充值记录改成由充值单付款后开出来，已经建过的库要补这一列。
      alter table topups add column if not exists "orderId" text references plan_orders(id);
      -- 一笔充值单只开一条充值记录：改单是改这条，不是再记一笔。
      create unique index if not exists topups_order on topups ("orderId") where "orderId" is not null;
      -- 一条订单只开一张账单：改订单是改这张，不是再开一张。
      create unique index if not exists invoices_order on invoices ("orderId") where "orderId" is not null;
      -- 重名的套餐在列表里分不出谁是谁，库这层就挡住。中英各管各的。
      create unique index if not exists plan_skus_name on plan_skus (name);
      -- 英文名允许留空（留空就回落到中文名），空串不参与唯一性。
      create unique index if not exists plan_skus_name_en on plan_skus ("nameEn") where "nameEn" <> '';
      create table if not exists machines (
        id                text primary key,
        host              text,
        "companyId"       text references companies(id),
        "lastHeartbeatAt" bigint,
        "createdAt"       bigint not null,
        "pairedAt"        bigint,
        "managerVersion"  text,
        protocol          integer not null default 0,
        "lastError"       text,
        "desiredManagerVersion" text,
        "maxAccounts"     integer not null default 10,
        token             text
      );
      create unique index if not exists machines_token on machines (token);
      -- 管家在心跳里自报 process.arch。发布包带的是原生二进制，架构不对就起不来，
      -- 所以选包必须认它——不认的话「最新」有一半概率是错架构的包。
      alter table machines add column if not exists arch text;
      -- 部署路径从「Gateway SSH 进去」换成「机器上常驻的管家」。Gateway 因此不再
      -- 持有任何能登录机器的凭据，这几列必须真的消失，不能只是不再读。
      alter table machines add column if not exists "pairedAt" bigint;
      alter table machines add column if not exists "managerVersion" text;
      alter table machines add column if not exists protocol integer not null default 0;
      alter table machines add column if not exists "lastError" text;
      -- 单台钉版本做灰度：空就跟平台的全局期望版本走。
      alter table machines add column if not exists "desiredManagerVersion" text;
      -- 一家公司可以有多台机器，每台限一个激活账号上限。
      alter table machines add column if not exists "maxAccounts" integer not null default 10;
      -- 机器时区。期望值由人在界面上定，实际值由管家心跳自报——两列分开存，
      -- 只有一列的话「已经改上了」和「还没改上」在界面上是一个样子。
      alter table machines add column if not exists timezone text;
      alter table machines add column if not exists "currentTimezone" text;
      -- 移除是两步：先立墓碑把信送到机器上，管家收拾完回执了才真删。见 Machine.removedAt。
      alter table machines add column if not exists "removedAt" bigint;
      -- 老库里 host 存的是 bot 直连地址，现在这一列的语义是管家基址；ssh 那套已经
      -- 没有对应物了。整行留着但清空 host，逼这台机器重新配对——留着旧值会让
      -- Gateway 一直往一个打不通的地方发部署。
      do $$
      begin
        if exists (
          select 1 from information_schema.columns
          where table_schema = current_schema() and table_name = 'machines' and column_name = 'sshHost'
        ) then
          update machines set host = null, "lastError" = '部署方式已改为机器管家，请重新配对';
          alter table machines drop column if exists "sshHost";
          alter table machines drop column if exists "sshPort";
          alter table machines drop column if exists "sshUser";
          alter table machines drop column if exists "sshAuth";
          alter table machines drop column if exists "sshSecret";
        end if;
      end
      $$;
      create table if not exists machine_pairings (
        code        text primary key,
        "companyId" text not null references companies(id),
        "createdBy" text,
        "createdAt" bigint not null,
        "expiresAt" bigint not null,
        "usedAt"    bigint,
        "machineId" text
      );
      create index if not exists machine_pairings_company on machine_pairings ("companyId", "createdAt" desc);
      create table if not exists catalog_items (
        id          text primary key,
        kind        text not null check (kind in ('model', 'skill', 'mcp', 'bot', 'provider')),
        scope       text not null check (scope in ('global', 'company')),
        "companyId" text references companies(id),
        name        text not null,
        definition  jsonb not null,
        "createdAt" bigint not null,
        "updatedAt" bigint not null
      );
      create index if not exists catalog_scope on catalog_items (kind, scope, "companyId");
      -- 老库的 kind 约束里没有 'provider'。约束名是 PG 自动起的，按名字找出来换掉，
      -- 不是无脑 drop——这张表上还有别的 check。
      do $$
      declare c text;
      begin
        select con.conname into c
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = current_schema() and rel.relname = 'catalog_items'
          and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%kind%'
          and pg_get_constraintdef(con.oid) not like '%provider%';
        if c is not null then
          execute format('alter table catalog_items drop constraint %I', c);
          alter table catalog_items add check (kind in ('model', 'skill', 'mcp', 'bot', 'provider'));
        end if;
      end
      $$;
      create table if not exists credentials (
        id          text primary key,
        "companyId" text not null references companies(id),
        provider    text not null,
        secret      text not null,
        "createdAt" bigint not null,
        "updatedAt" bigint not null,
        unique ("companyId", provider)
      );
      create table if not exists audit_events (
        id          text primary key,
        "companyId" text not null,
        "accountId" text,
        action      text not null,
        detail      jsonb not null,
        "createdAt" bigint not null
      );
      create index if not exists audit_company on audit_events ("companyId", "createdAt" desc);
      create table if not exists settings (
        "companyId" text primary key references companies(id),
        payload     jsonb not null,
        "updatedAt" bigint not null
      );
      create table if not exists platform_credentials (
        provider    text primary key,
        secret      text not null,
        "createdAt" bigint not null,
        "updatedAt" bigint not null
      );
      create table if not exists platform_settings (
        id          text primary key,
        payload     jsonb not null,
        "updatedAt" bigint not null
      );
      create table if not exists groups (
        id          text primary key,
        "companyId" text not null references companies(id),
        name        text not null,
        "desc"      text not null default '',
        icon        text not null default 'chat',
        role        text not null check (role in ('admin', 'member')),
        members     jsonb not null default '[]'::jsonb,
        agents      jsonb not null default '[]'::jsonb,
        "createdAt" bigint not null
      );
      create index if not exists groups_company on groups ("companyId");
      create table if not exists skill_tags (
        "companyId" text not null,
        tag         text not null,
        seq         bigserial,
        primary key ("companyId", tag)
      );
      create table if not exists session_index (
        "sessionId"    text primary key,
        "companyId"    text not null,
        "accountId"    text not null,
        "botId"        text,
        "machineId"    text,
        origin         text,
        "remoteId"     text,
        "messageCount" integer,
        title          text,
        "createdAt"    bigint,
        "updatedAt"    bigint
      );
      create index if not exists session_index_company on session_index ("companyId", "updatedAt" desc);
      -- 翻页是 keyset 的，排序键是 ("updatedAt" desc, "sessionId" desc)：updatedAt 会撞
      -- （同一毫秒上报两条），只按它翻页会漏行或重复。索引跟着排序键走。
      create index if not exists session_index_page on session_index ("companyId", "updatedAt" desc, "sessionId" desc);
      create table if not exists instances (
        "accountId"   text not null,
        "botId"       text not null,
        "companyId"   text,
        host          text not null,
        "lastReadyAt" bigint not null,
        primary key ("accountId", "botId")
      );
      create table if not exists seat_runtimes (
        "accountId"   text not null,
        "botId"       text not null,
        "companyId"   text not null,
        "linuxUser"   text not null,
        "seatId"      text not null default '',
        "machineId"   text not null default '',
        slot          integer not null,
        display       integer not null,
        "vncPort"     integer not null,
        "novncPort"   integer not null,
        "botPort"     integer not null,
        "vncPassword" text not null,
        status        text not null check (status in ('none', 'deploying', 'ready', 'error')),
        "lastError"   text,
        "deployedAt"  bigint,
        "updatedAt"   bigint not null,
        "botVersion"  text,
        primary key ("accountId", "botId")
      );
      create index if not exists seat_runtimes_account on seat_runtimes ("accountId");
      -- 一家公司可以有多台机器。**槽位因此按机器唯一，不是按公司**——端口是从槽位
      -- 算出来的（3200+N 等），两台机器上各自的 slot 0 互不冲突，按公司唯一会白白
      -- 把第二台机器的端口段浪费掉，还会在满 N 席之后拒绝部署。
      alter table seat_runtimes add column if not exists "machineId" text not null default '';
      do $$
      declare c text;
      begin
        select con.conname into c
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = current_schema() and rel.relname = 'seat_runtimes'
          and con.contype = 'u' and pg_get_constraintdef(con.oid) like '%slot%'
          and pg_get_constraintdef(con.oid) like '%companyId%';
        if c is not null then
          execute format('alter table seat_runtimes drop constraint %I', c);
        end if;
      end
      $$;
      -- 老行没有 machineId，补成该公司那台唯一的机器。
      update seat_runtimes s set "machineId" = m.id
      from machines m where m."companyId" = s."companyId" and s."machineId" = '';
      create unique index if not exists seat_runtimes_slot on seat_runtimes ("machineId", slot);
      -- 席位从「一个 bot 一个 Linux 账号」改成「一个员工一个账号」。linuxUser 不再
      -- 唯一（同员工的多个 bot 共用它，共享文件正是靠这个），唯一性移到 seatId 上。
      alter table seat_runtimes add column if not exists "seatId" text not null default '';
      -- 老库那条 unique(companyId, linuxUser) 现在会挡住同员工的第二个 bot。约束名
      -- 是 PG 自动起的，按定义找出来删——这张表上还有 unique(companyId, slot)。
      do $$
      declare c text;
      begin
        select con.conname into c
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = current_schema() and rel.relname = 'seat_runtimes'
          and con.contype = 'u' and pg_get_constraintdef(con.oid) like '%linuxUser%';
        if c is not null then
          execute format('alter table seat_runtimes drop constraint %I', c);
        end if;
      end
      $$;
      -- 老行的 linuxUser / 实例名都是旧方案算出来的，就地换成新方案，并**打回
      -- error**：机器上跑的还是 bot-xxxx 那套单元，DB 说 ready 就是在撒谎。重新
      -- 部署一次会按新命名建账号和单元；旧的 bot-xxxx 账号需要人工清理。
      update seat_runtimes set
        "linuxUser" = 'sw-' || substr(encode(sha256(convert_to("accountId", 'UTF8')), 'hex'), 1, 12),
        "seatId"    = 'sw-' || substr(encode(sha256(convert_to("accountId", 'UTF8')), 'hex'), 1, 12)
                      || '-' || substr(encode(sha256(convert_to("botId", 'UTF8')), 'hex'), 1, 12),
        status      = 'error',
        "lastError" = '席位命名已改为「一员工一账号」，请重新部署'
      where "seatId" = '';
      create unique index if not exists seat_runtimes_seat on seat_runtimes ("companyId", "seatId");
      create table if not exists bot_releases (
        kind        text not null default 'bot',
        version     text not null,
        sha256      text not null,
        size        bigint not null,
        "createdAt" bigint not null,
        note        text not null default '',
        url         text not null default '',
        primary key (kind, version)
      );
      -- 机器管家自己也按版本发布，跟 bot 走同一套上传/校验/下发。老库只有 bot 那
      -- 一种，主键从 version 换成 (kind, version)：同名的 bot 和 manager 包要能共存。
      alter table bot_releases add column if not exists kind text not null default 'bot';
      -- 发布包也可以只登记地址、字节放在别处（对象存储、内网 HTTP）。空 = 在本机磁盘上。
      alter table bot_releases add column if not exists url text not null default '';
      do $$
      declare c text;
      begin
        select con.conname into c
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = current_schema() and rel.relname = 'bot_releases'
          and con.contype = 'p' and pg_get_constraintdef(con.oid) not like '%kind%';
        if c is not null then
          execute format('alter table bot_releases drop constraint %I', c);
          alter table bot_releases add primary key (kind, version);
        end if;
      end
      $$;
      create table if not exists account_secrets (
        "accountId"   text primary key references accounts(id),
        "apiKey"      text not null unique,
        "accessToken" text not null unique,
        "createdAt"   bigint not null
      );
      create table if not exists llm_calls (
        id                 text primary key,
        "accountId"        text not null,
        "companyId"        text,
        provider           text not null,
        model              text not null,
        "promptTokens"     bigint not null default 0,
        "completionTokens" bigint not null default 0,
        "createdAt"        bigint not null
      );
      -- promptTokens 是**整个提示词**，命中缓存的那部分也在里面；cachedTokens 是其中
      -- 命中的一截，两者不相加。缓存读单价低，折价要用得上这个细分。
      -- 老行都是 0：那时候我们连缓存命中都没记，追不回来了。
      alter table llm_calls add column if not exists "cachedTokens" bigint not null default 0;
      create index if not exists llm_calls_company on llm_calls ("companyId", "createdAt" desc);
      create index if not exists llm_calls_account on llm_calls ("accountId");
    `)
  }

  /** e2e 用：把本 schema 整个丢掉重建。生产不会走到。 */
  async dropSchema(): Promise<void> {
    if (this.schema === 'public') throw new Error('拒绝 drop public schema')
    await this.pool.query(`drop schema if exists "${this.schema}" cascade`)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async tx<T>(fn: () => Promise<T> | T): Promise<T> {
    const existing = this.txClient.getStore()
    // 已经在事务里就直接跑，不开嵌套事务。
    if (existing) return fn()
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const out = await this.txClient.run(client, async () => fn())
      await client.query('commit')
      return out
    } catch (e) {
      try {
        await client.query('rollback')
      } catch {}
      throw e
    } finally {
      client.release()
    }
  }

  // ── 公司 ──────────────────────────────────────────────────────────────

  async insertCompany(
    input: {
      slug: string
      name: string
    } & Partial<Pick<Company, 'contactName' | 'contactPhone' | 'contactEmail' | 'address' | 'website'>>,
  ): Promise<Company> {
    const now = Date.now()
    const row: Company = {
      id: randomUUID(),
      slug: input.slug,
      name: input.name,
      status: 'active',
      contactName: input.contactName ?? '',
      contactPhone: input.contactPhone ?? '',
      contactEmail: input.contactEmail ?? '',
      address: input.address ?? '',
      website: input.website ?? '',
      machineId: null,
      accessUrl: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into companies (id, slug, name, status, "contactName", "contactPhone", "contactEmail", address, website, "machineId", "accessUrl", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.slug,
        row.name,
        row.status,
        row.contactName,
        row.contactPhone,
        row.contactEmail,
        row.address,
        row.website,
        row.machineId,
        row.accessUrl,
        row.createdAt,
        row.updatedAt,
      ],
    )
    return row
  }

  async company(id: string): Promise<Company | undefined> {
    const r = await this.one('select * from companies where id = ?', [id])
    return r ? companyOf(r) : undefined
  }

  async companyBySlug(slug: string): Promise<Company | undefined> {
    const r = await this.one('select * from companies where slug = ?', [slug])
    return r ? companyOf(r) : undefined
  }

  async updateCompany(
    id: string,
    patch: Partial<
      Pick<
        Company,
        | 'name'
        | 'slug'
        | 'status'
        | 'contactName'
        | 'contactPhone'
        | 'contactEmail'
        | 'address'
        | 'website'
        | 'machineId'
        | 'accessUrl'
      >
    >,
  ): Promise<Company> {
    const cur = await this.company(id)
    if (!cur) throw new Error('公司不存在')
    const next: Company = {
      ...cur,
      name: patch.name ?? cur.name,
      slug: patch.slug ?? cur.slug,
      status: patch.status ?? cur.status,
      contactName: patch.contactName ?? cur.contactName,
      contactPhone: patch.contactPhone ?? cur.contactPhone,
      contactEmail: patch.contactEmail ?? cur.contactEmail,
      address: patch.address ?? cur.address,
      website: patch.website ?? cur.website,
      machineId: patch.machineId === undefined ? cur.machineId : patch.machineId,
      accessUrl: patch.accessUrl === undefined ? cur.accessUrl : patch.accessUrl,
      updatedAt: Date.now(),
    }
    await this.run(
      'update companies set slug=?, name=?, status=?, "contactName"=?, "contactPhone"=?, "contactEmail"=?, address=?, website=?, "machineId"=?, "accessUrl"=?, "updatedAt"=? where id=?',
      [
        next.slug,
        next.name,
        next.status,
        next.contactName,
        next.contactPhone,
        next.contactEmail,
        next.address,
        next.website,
        next.machineId,
        next.accessUrl,
        next.updatedAt,
        id,
      ],
    )
    return next
  }

  async deleteCompany(id: string): Promise<void> {
    await this.run('delete from groups where "companyId" = ?', [id])
    await this.run('delete from skill_tags where "companyId" = ?', [id])
    await this.run('delete from session_index where "companyId" = ?', [id])
    await this.run('delete from instances where "companyId" = ?', [id])
    await this.run('delete from seat_runtimes where "companyId" = ?', [id])
    await this.run('delete from audit_events where "companyId" = ?', [id])
    await this.run('delete from settings where "companyId" = ?', [id])
    await this.run('delete from credentials where "companyId" = ?', [id])
    await this.run('delete from catalog_items where "companyId" = ?', [id])
    await this.run('update machines set "companyId" = null where "companyId" = ?', [id])
    // machine_pairings."companyId" 有真外键指向 companies(id)。漏了这一条，最后那句
    // `delete from companies` 对**任何配对过机器的公司**都会外键报错，整条删除永远
    // 走不通。machines 那行是解绑（机器要留着重派），配对码则是一次性的，直接删。
    await this.run('delete from machine_pairings where "companyId" = ?', [id])
    await this.run('delete from invites where "companyId" = ?', [id])
    // **用量不删。** llm_calls 属于必须留档的记录，路由那道闸已经挡住「有用量的公司
    // 不许硬删」；这里不留销毁语句，免得将来有别的调用方绕过闸把它抹掉。表上没有指向
    // companies 的外键，公司行没了这些记录照样留得住。
    await this.run('delete from account_secrets where "accountId" in (select id from accounts where "companyId" = ?)', [id])
    await this.run('delete from accounts where "companyId" = ?', [id])
    await this.run('delete from plans where "companyId" = ?', [id])
    // 账单挂在订单上，先账单后订单，否则外键把订单卡住。
    await this.run('delete from topups where "companyId" = ?', [id])
    await this.run('delete from invoices where "companyId" = ?', [id])
    await this.run('delete from plan_orders where "companyId" = ?', [id])
    await this.run('delete from companies where id = ?', [id])
  }

  /**
   * 这家公司还剩多少条**要留档**的记录。
   *
   * 账单和用量有留存要求，而 deleteCompany 是硬删——两者冲突时以留档为准，
   * 所以删除路由拿它来决定是不是该改走「停用」。
   */
  async billingFootprint(id: string): Promise<{ invoices: number; orders: number; topups: number; llmCalls: number }> {
    const n = (r: Row | undefined) => Number((r as { n?: unknown } | undefined)?.n ?? 0)
    // 表名写死在四条语句里，不拼字符串——这个文件里的 SQL 一律只有占位符是变的。
    return {
      invoices: n(await this.one('select count(*)::int as n from invoices where "companyId" = ?', [id])),
      orders: n(await this.one('select count(*)::int as n from plan_orders where "companyId" = ?', [id])),
      topups: n(await this.one('select count(*)::int as n from topups where "companyId" = ?', [id])),
      llmCalls: n(await this.one('select count(*)::int as n from llm_calls where "companyId" = ?', [id])),
    }
  }

  async companies(): Promise<Company[]> {
    const rows = await this.many('select * from companies order by "createdAt"')
    return rows.map(companyOf)
  }

  // ── 账号 ──────────────────────────────────────────────────────────────

  async insertAccount(input: {
    companyId: string | null
    email: string
    passwordHash: string
    role: Role
    name?: string
    status?: AccountStatus
  }): Promise<Account> {
    let companyId = input.companyId
    if (input.role === 'owner') {
      if (companyId) throw new Error('owner 不能属于公司')
      companyId = null
    } else if (input.role === 'admin' || input.role === 'member') {
      if (!companyId) throw new Error('admin/member 必须属于公司')
    } else {
      throw new Error('未知角色')
    }
    const now = Date.now()
    const email = input.email
    const row: Account = {
      id: randomUUID(),
      companyId,
      email,
      name: (input.name ?? '').trim() || nameFromEmail(email),
      title: '',
      phone: '',
      theme: 'system',
      locale: 'zh',
      passwordHash: input.passwordHash,
      role: input.role,
      status: input.status ?? 'active',
      lastSeenAt: null,
      passwordChangedAt: null,
      tokenRevokedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into accounts (id, "companyId", email, name, title, phone, theme, locale, "passwordHash", role, status, "lastSeenAt", "passwordChangedAt", "tokenRevokedAt", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.companyId,
        row.email,
        row.name,
        row.title,
        row.phone,
        row.theme,
        row.locale,
        row.passwordHash,
        row.role,
        row.status,
        row.lastSeenAt,
        row.passwordChangedAt,
        row.tokenRevokedAt,
        row.createdAt,
        row.updatedAt,
      ],
    )
    if (row.role === 'admin' || row.role === 'member') await this.issueAccountSecrets(row.id)
    return row
  }

  async account(id: string): Promise<Account | undefined> {
    const r = await this.one('select * from accounts where id = ?', [id])
    return r ? accountOf(r) : undefined
  }

  async accountByEmail(email: string): Promise<Account | undefined> {
    const r = await this.one('select * from accounts where email = ?', [email])
    return r ? accountOf(r) : undefined
  }

  async accountsOf(companyId: string): Promise<Account[]> {
    const rows = await this.many('select * from accounts where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(accountOf)
  }

  async accountsAll(): Promise<Account[]> {
    const rows = await this.many('select * from accounts order by "createdAt"')
    return rows.map(accountOf)
  }

  async owners(): Promise<Account[]> {
    const rows = await this.many("select * from accounts where role = 'owner' order by \"createdAt\"")
    return rows.map(accountOf)
  }

  /** 占用席位：本公司非停用账号（owner 本来就不属于公司）。 */
  /**
   * 占席位这件事要串起来做：在事务里先锁住这家公司的套餐行，再数人、再写人。
   * 不锁的话两个请求可能同时读到「还剩一个席位」，各自放行，超出上限。
   */
  async lockPlan(companyId: string): Promise<void> {
    await this.one('select 1 from plans where "companyId" = ? for update', [companyId])
  }

  /** 占着席位的人：算 active 和 invited（邀请也占位），不算停用的，也不算 owner。 */
  async accountCount(companyId: string): Promise<number> {
    const r = await this.one(
      "select count(*) as n from accounts where \"companyId\" = ? and status != 'disabled' and role != 'owner'",
      [companyId],
    )
    return Number(r?.n ?? 0)
  }

  /** 还能管事的管理员：未停用的 admin（含待接受）。最后一个管理员靠它守门。 */
  async adminCount(companyId: string): Promise<number> {
    const r = await this.one(
      "select count(*) as n from accounts where \"companyId\" = ? and role = 'admin' and status != 'disabled'",
      [companyId],
    )
    return Number(r?.n ?? 0)
  }

  async updateAccount(
    id: string,
    patch: Partial<
      Pick<
        Account,
        | 'name'
        | 'title'
        | 'phone'
        | 'theme'
        | 'locale'
        | 'role'
        | 'status'
        | 'lastSeenAt'
        | 'passwordHash'
        | 'passwordChangedAt'
        | 'tokenRevokedAt'
      >
    >,
  ): Promise<Account> {
    const cur = await this.account(id)
    if (!cur) throw new Error('账号不存在')
    const next: Account = {
      ...cur,
      name: patch.name !== undefined ? patch.name : cur.name,
      title: patch.title !== undefined ? patch.title : cur.title,
      phone: patch.phone !== undefined ? patch.phone : cur.phone,
      theme: patch.theme ?? cur.theme,
      locale: patch.locale ?? cur.locale,
      role: patch.role ?? cur.role,
      status: patch.status ?? cur.status,
      lastSeenAt: patch.lastSeenAt !== undefined ? patch.lastSeenAt : cur.lastSeenAt,
      passwordHash: patch.passwordHash ?? cur.passwordHash,
      passwordChangedAt: patch.passwordChangedAt !== undefined ? patch.passwordChangedAt : cur.passwordChangedAt,
      tokenRevokedAt: patch.tokenRevokedAt !== undefined ? patch.tokenRevokedAt : cur.tokenRevokedAt,
      updatedAt: Date.now(),
    }
    await this.run(
      'update accounts set name=?, title=?, phone=?, theme=?, locale=?, role=?, status=?, "lastSeenAt"=?, "passwordHash"=?, "passwordChangedAt"=?, "tokenRevokedAt"=?, "updatedAt"=? where id=?',
      [
        next.name,
        next.title,
        next.phone,
        next.theme,
        next.locale,
        next.role,
        next.status,
        next.lastSeenAt,
        next.passwordHash,
        next.passwordChangedAt,
        next.tokenRevokedAt,
        next.updatedAt,
        id,
      ],
    )
    return next
  }

  async deleteAccount(id: string): Promise<void> {
    await this.tx(async () => {
      const cur = await this.account(id)
      await this.deleteInvitesForUser(id)
      await this.run('delete from session_index where "accountId" = ?', [id])
      await this.run('delete from instances where "accountId" = ?', [id])
      await this.run('delete from seat_runtimes where "accountId" = ?', [id])
      // 同上：删员工也不销毁他的用量记录。少了它，公司的历史用量会凭空缺一块，而
      // 「谁烧了多少」正是要留档的东西。accountId 变成悬空引用，统计里按 id 显示。
      await this.run('delete from account_secrets where "accountId" = ?', [id])
      if (cur?.companyId) {
        for (const g of await this.groupsOf(cur.companyId)) {
          if (!g.members.includes(id)) continue
          await this.updateGroup(g.id, { members: g.members.filter((m) => m !== id) })
        }
      }
      await this.run('delete from accounts where id = ?', [id])
    })
  }

  // ── 席位密钥。明文存，详情页给 owner 看；列表接口不许带出去。────────

  async accountSecrets(accountId: string): Promise<AccountSecrets | undefined> {
    const r = await this.one('select * from account_secrets where "accountId" = ?', [accountId])
    if (!r) return undefined
    return {
      accountId: str(r.accountId),
      apiKey: str(r.apiKey),
      accessToken: str(r.accessToken),
      createdAt: num(r.createdAt),
    }
  }

  async issueAccountSecrets(accountId: string): Promise<AccountSecrets | undefined> {
    const existing = await this.accountSecrets(accountId)
    if (existing) return existing
    const account = await this.account(accountId)
    if (!account || account.role === 'owner') return undefined
    for (let i = 0; i < 8; i++) {
      const apiKey = randomApiKey()
      const accessToken = randomAccessToken()
      const createdAt = Date.now()
      try {
        await this.run(
          'insert into account_secrets ("accountId", "apiKey", "accessToken", "createdAt") values (?,?,?,?)',
          [accountId, apiKey, accessToken, createdAt],
        )
        return { accountId, apiKey, accessToken, createdAt }
      } catch (e) {
        if (i === 7 || !isUniqueViolation(e)) throw e
      }
    }
    return undefined
  }

  /** 旧席位部署时补发。已有则原样返回。 */
  async ensureAccountSecrets(accountId: string): Promise<AccountSecrets | undefined> {
    return this.issueAccountSecrets(accountId)
  }

  async accountByApiKey(key: string): Promise<Account | undefined> {
    if (!key) return undefined
    const r = await this.one('select "accountId" from account_secrets where "apiKey" = ?', [key])
    return r ? this.account(str(r.accountId)) : undefined
  }

  async accountByAccessToken(token: string): Promise<Account | undefined> {
    if (!token) return undefined
    const r = await this.one('select "accountId" from account_secrets where "accessToken" = ?', [token])
    return r ? this.account(str(r.accountId)) : undefined
  }

  async insertLlmCall(input: {
    accountId: string
    companyId?: string | null
    provider: string
    model: string
    promptTokens?: number
    completionTokens?: number
    cachedTokens?: number
  }): Promise<LlmCall> {
    const row: LlmCall = {
      id: randomUUID(),
      accountId: input.accountId,
      companyId: input.companyId ?? null,
      provider: input.provider,
      model: input.model,
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
      cachedTokens: input.cachedTokens ?? 0,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "cachedTokens", "createdAt") values (?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.accountId,
        row.companyId,
        row.provider,
        row.model,
        row.promptTokens,
        row.completionTokens,
        row.cachedTokens,
        row.createdAt,
      ],
    )
    return row
  }

  async updateLlmCallTokens(
    id: string,
    usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number },
  ): Promise<void> {
    await this.run('update llm_calls set "promptTokens"=?, "completionTokens"=?, "cachedTokens"=? where id=?', [
      usage.prompt_tokens,
      usage.completion_tokens,
      usage.cached_tokens ?? 0,
      id,
    ])
  }

  async llmCallsOfCompany(companyId: string): Promise<LlmCall[]> {
    const rows = await this.many('select * from llm_calls where "companyId" = ? order by "createdAt" desc', [companyId])
    return rows.map((r) => ({
      id: str(r.id),
      accountId: str(r.accountId),
      companyId: strOrNull(r.companyId),
      provider: str(r.provider),
      model: str(r.model),
      promptTokens: num(r.promptTokens),
      completionTokens: num(r.completionTokens),
      cachedTokens: num(r.cachedTokens),
      createdAt: num(r.createdAt),
    }))
  }

  private llmRangeSql(range?: { from?: number; to?: number }): { sql: string; args: number[] } {
    let sql = ''
    const args: number[] = []
    if (range?.from != null) {
      sql += ' and "createdAt" >= ?'
      args.push(range.from)
    }
    if (range?.to != null) {
      sql += ' and "createdAt" <= ?'
      args.push(range.to)
    }
    return { sql, args }
  }

  private async llmUsageBy(
    column: 'companyId' | 'accountId',
    value: string,
    range?: { from?: number; to?: number },
  ): Promise<LlmUsage> {
    const r = this.llmRangeSql(range)
    const total = await this.one(
      `select count(*) as calls, coalesce(sum("promptTokens"), 0) as "promptTokens", coalesce(sum("completionTokens"), 0) as "completionTokens" from llm_calls where "${column}" = ?${r.sql}`,
      [value, ...r.args],
    )
    const by = await this.many(
      `select "accountId", count(*) as calls, coalesce(sum("promptTokens"), 0) as "promptTokens", coalesce(sum("completionTokens"), 0) as "completionTokens", max("createdAt") as "lastAt" from llm_calls where "${column}" = ?${r.sql} group by "accountId"`,
      [value, ...r.args],
    )
    return {
      calls: num(total?.calls ?? 0),
      promptTokens: num(total?.promptTokens ?? 0),
      completionTokens: num(total?.completionTokens ?? 0),
      byAccount: by.map((row) => ({
        accountId: str(row.accountId),
        calls: num(row.calls),
        promptTokens: num(row.promptTokens),
        completionTokens: num(row.completionTokens),
        lastAt: numOrNull(row.lastAt),
      })),
    }
  }

  llmUsageOfCompany(companyId: string, range?: { from?: number; to?: number }): Promise<LlmUsage> {
    return this.llmUsageBy('companyId', companyId, range)
  }

  llmUsageOfAccount(accountId: string, range?: { from?: number; to?: number }): Promise<LlmUsage> {
    return this.llmUsageBy('accountId', accountId, range)
  }

  /**
   * 平台统计的底表：按 (公司, 供应商, 模型) 汇总。
   *
   * 折成金额要按模型单价算，所以必须细到模型这一层再聚合——只按公司汇总的话
   * 拿不回每条调用用的是哪个模型，价就算不出来。
   * companyId 为 null 的是 owner 自己的调用，原样留着，由上层标成「平台」。
   */
  async llmUsageByCompanyModel(
    range?: { from?: number; to?: number },
    companyId?: string,
  ): Promise<CompanyModelUsage[]> {
    const r = this.llmRangeSql(range)
    let where = `where 1=1${r.sql}`
    const args: (number | string)[] = [...r.args]
    if (companyId) {
      where += ' and "companyId" = ?'
      args.push(companyId)
    }
    const rows = await this.many(
      `select "companyId", provider, model, count(*) as calls,
              coalesce(sum("promptTokens"), 0) as "promptTokens",
              coalesce(sum("completionTokens"), 0) as "completionTokens",
              max("createdAt") as "lastAt"
       from llm_calls ${where}
       group by "companyId", provider, model
       order by "companyId", provider, model`,
      args,
    )
    return rows.map((row) => ({
      companyId: strOrNull(row.companyId),
      provider: str(row.provider),
      model: str(row.model),
      calls: num(row.calls),
      promptTokens: num(row.promptTokens),
      completionTokens: num(row.completionTokens),
      lastAt: numOrNull(row.lastAt),
    }))
  }

  // ── 分组。全体成员是算出来的，不进这张表。──────────────────────────

  async groupsOf(companyId: string): Promise<Group[]> {
    const rows = await this.many('select * from groups where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(groupOf)
  }

  async group(id: string): Promise<Group | undefined> {
    const r = await this.one('select * from groups where id = ?', [id])
    return r ? groupOf(r) : undefined
  }

  async insertGroup(input: {
    companyId: string
    name: string
    desc?: string
    icon?: string
    role: 'admin' | 'member'
    members?: string[]
    agents?: string[]
  }): Promise<Group> {
    const row: Group = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name,
      desc: input.desc ?? '',
      icon: input.icon || 'chat',
      role: input.role,
      members: input.members ?? [],
      agents: input.agents ?? [],
      createdAt: Date.now(),
    }
    await this.run(
      'insert into groups (id, "companyId", name, "desc", icon, role, members, agents, "createdAt") values (?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.companyId,
        row.name,
        row.desc,
        row.icon,
        row.role,
        JSON.stringify(row.members),
        JSON.stringify(row.agents),
        row.createdAt,
      ],
    )
    return row
  }

  async updateGroup(
    id: string,
    patch: Partial<Pick<Group, 'name' | 'desc' | 'icon' | 'role' | 'members' | 'agents'>>,
  ): Promise<Group> {
    const cur = await this.group(id)
    if (!cur) throw new Error('分组不存在')
    const next: Group = {
      ...cur,
      name: patch.name !== undefined ? patch.name : cur.name,
      desc: patch.desc !== undefined ? patch.desc : cur.desc,
      icon: patch.icon !== undefined ? patch.icon : cur.icon,
      role: patch.role ?? cur.role,
      members: patch.members !== undefined ? patch.members : cur.members,
      agents: patch.agents !== undefined ? patch.agents : cur.agents,
    }
    await this.run('update groups set name=?, "desc"=?, icon=?, role=?, members=?, agents=? where id=?', [
      next.name,
      next.desc,
      next.icon,
      next.role,
      JSON.stringify(next.members),
      JSON.stringify(next.agents),
      id,
    ])
    return next
  }

  async deleteGroup(id: string): Promise<boolean> {
    return (await this.run('delete from groups where id = ?', [id])) > 0
  }

  // ── 邀请 ──────────────────────────────────────────────────────────────

  async putInvite(row: Invite): Promise<Invite> {
    await this.run(
      'insert into invites (id, "userId", "companyId", "createdBy", "createdAt", "expiresAt") values (?,?,?,?,?,?)',
      [row.id, row.userId, row.companyId, row.createdBy, row.createdAt, row.expiresAt],
    )
    return row
  }

  async invite(id: string): Promise<Invite | undefined> {
    const r = await this.one('select * from invites where id = ?', [id])
    return r ? inviteOf(r) : undefined
  }

  async deleteInvitesForUser(userId: string): Promise<void> {
    await this.run('delete from invites where "userId" = ?', [userId])
  }

  async deleteInvite(id: string): Promise<void> {
    await this.run('delete from invites where id = ?', [id])
  }

  // ── 套餐 ──────────────────────────────────────────────────────────────

  /** 套餐和到期时间是可选补丁：不传就保持原样，传 null 才是清空。 */
  async upsertPlan(
    companyId: string,
    seats: number,
    patch: { skuId?: string | null; expiresAt?: number | null } = {},
  ): Promise<Plan> {
    const now = Date.now()
    const cur = await this.plan(companyId)
    const next: Plan = {
      companyId,
      seats,
      skuId: patch.skuId === undefined ? (cur?.skuId ?? null) : patch.skuId,
      expiresAt: patch.expiresAt === undefined ? (cur?.expiresAt ?? null) : patch.expiresAt,
      updatedAt: now,
    }
    await this.run(
      'insert into plans ("companyId", seats, "skuId", "expiresAt", "updatedAt") values (?,?,?,?,?) on conflict ("companyId") do update set seats=excluded.seats, "skuId"=excluded."skuId", "expiresAt"=excluded."expiresAt", "updatedAt"=excluded."updatedAt"',
      [companyId, next.seats, next.skuId, next.expiresAt, next.updatedAt],
    )
    return next
  }

  async plan(companyId: string): Promise<Plan | undefined> {
    const r = await this.one('select * from plans where "companyId" = ?', [companyId])
    return r ? planOf(r) : undefined
  }

  // ── 套餐 SKU（价目表）────────────────────────────────────────────────

  async planSkus(): Promise<PlanSku[]> {
    const rows = await this.many('select * from plan_skus order by "amountMils", "createdAt"')
    return rows.map(planSkuOf)
  }

  async planSku(id: string): Promise<PlanSku | undefined> {
    const r = await this.one('select * from plan_skus where id = ?', [id])
    return r ? planSkuOf(r) : undefined
  }

  /** 按名字找。中英两列都查——重名要挡的是「界面上看着一样」，不分哪一列。 */
  async planSkuByName(name: string): Promise<PlanSku | undefined> {
    const r = await this.one('select * from plan_skus where name = ? or ("nameEn" <> \'\' and "nameEn" = ?)', [name, name])
    return r ? planSkuOf(r) : undefined
  }

  async insertPlanSku(input: {
    name: string
    nameEn?: string
    amountMils: number
    seats: number
    period?: PlanPeriod
    bonusMils?: number
  }): Promise<PlanSku> {
    const now = Date.now()
    const row: PlanSku = {
      id: randomUUID(),
      name: input.name,
      nameEn: input.nameEn ?? '',
      amountMils: input.amountMils,
      seats: input.seats,
      period: input.period ?? 'month',
      bonusMils: input.bonusMils ?? 0,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into plan_skus (id, name, "nameEn", "amountMils", seats, period, "bonusMils", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?)',
      [row.id, row.name, row.nameEn, row.amountMils, row.seats, row.period, row.bonusMils, row.createdAt, row.updatedAt],
    )
    return row
  }

  /** 只改传进来的字段。套餐不存在返回 undefined，由上层决定报 404 还是别的。 */
  async updatePlanSku(
    id: string,
    patch: { name?: string; nameEn?: string; amountMils?: number; seats?: number; period?: PlanPeriod; bonusMils?: number },
  ): Promise<PlanSku | undefined> {
    const cur = await this.planSku(id)
    if (!cur) return undefined
    const r = await this.one(
      'update plan_skus set name=?, "nameEn"=?, "amountMils"=?, seats=?, period=?, "bonusMils"=?, "updatedAt"=? where id=? returning *',
      [
        patch.name ?? cur.name,
        patch.nameEn ?? cur.nameEn,
        patch.amountMils ?? cur.amountMils,
        patch.seats ?? cur.seats,
        patch.period ?? cur.period,
        patch.bonusMils ?? cur.bonusMils,
        Date.now(),
        id,
      ],
    )
    return r ? planSkuOf(r) : undefined
  }

  // ── 订单 ──────────────────────────────────────────────────────────────

  async planOrders(): Promise<PlanOrder[]> {
    const rows = await this.many('select * from plan_orders order by "startAt" desc, "createdAt" desc')
    return rows.map(planOrderOf)
  }

  async planOrder(id: string): Promise<PlanOrder | undefined> {
    const r = await this.one('select * from plan_orders where id = ?', [id])
    return r ? planOrderOf(r) : undefined
  }

  async planOrdersOfCompany(companyId: string): Promise<PlanOrder[]> {
    const rows = await this.many('select * from plan_orders where "companyId" = ? order by "startAt" desc', [companyId])
    return rows.map(planOrderOf)
  }

  async insertPlanOrder(input: Omit<PlanOrder, 'id' | 'createdAt' | 'updatedAt'>): Promise<PlanOrder> {
    const now = Date.now()
    const row: PlanOrder = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
    await this.run(
      `insert into plan_orders
       (id, "companyId", kind, note, "planId", "planName", "planNameEn", period, seats, "amountMils", "bonusMils", "startAt", "endAt", "payStatus", "createdAt", "updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.companyId, row.kind, row.note, row.planId, row.planName, row.planNameEn, row.period,
        row.seats, row.amountMils, row.bonusMils, row.startAt, row.endAt, row.payStatus, row.createdAt, row.updatedAt,
      ],
    )
    return row
  }

  /** 只改传进来的字段。订单不存在返回 undefined。 */
  async updatePlanOrder(id: string, patch: Partial<Omit<PlanOrder, 'id' | 'createdAt'>>): Promise<PlanOrder | undefined> {
    const cur = await this.planOrder(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    const r = await this.one(
      `update plan_orders set "companyId"=?, kind=?, note=?, "planId"=?, "planName"=?, "planNameEn"=?, period=?,
       seats=?, "amountMils"=?, "bonusMils"=?, "startAt"=?, "endAt"=?, "payStatus"=?, "updatedAt"=? where id=? returning *`,
      [
        next.companyId, next.kind, next.note, next.planId, next.planName, next.planNameEn, next.period,
        next.seats, next.amountMils, next.bonusMils, next.startAt, next.endAt, next.payStatus, next.updatedAt, id,
      ],
    )
    return r ? planOrderOf(r) : undefined
  }

  /**
   * 此刻生效的那条**套餐**订单：已付款、开始时间已到、结束时间未过。充值单不参与订阅。
   * 未付款的订单只是一张待收的账单，不算订阅——钱没到就别开服务。
   * 有重叠就取开始得最晚的一条——续约提前下单时，新订单一生效就顶掉旧的。
   */
  async activePaidOrder(companyId: string, at = Date.now()): Promise<PlanOrder | undefined> {
    const r = await this.one(
      `select * from plan_orders
       where "companyId" = ? and kind = 'plan' and "payStatus" = 'paid' and "startAt" <= ? and "endAt" > ?
       order by "startAt" desc limit 1`,
      [companyId, at, at],
    )
    return r ? planOrderOf(r) : undefined
  }

  /**
   * 把公司的订阅拉齐到订单：**已付款且在期内**的那条订单说了算，没有就把套餐清掉。
   * 未付款的订单只是一张待收的账单，不写订阅。
   * 席位不缩到已有账号数以下——订单少给了席位也不能把人挤掉，先按现有人数保住。
   *
   * 下单/改单之后调它；起进程时也对一遍全量，把「订单到期了没人碰」和历史规则留下的
   * 脏值收干净——plans 里那几列是订单算出来的结果，不是另一份可以自己漂的真相。
   */
  async syncPlanFromOrders(companyId: string): Promise<void> {
    const active = await this.activePaidOrder(companyId)
    const used = await this.accountCount(companyId)
    const cur = await this.plan(companyId)
    if (!active) {
      if (cur?.skuId == null && cur?.expiresAt == null && cur) return
      await this.upsertPlan(companyId, cur?.seats ?? Math.max(used, 1), { skuId: null, expiresAt: null })
      return
    }
    await this.upsertPlan(companyId, Math.max(active.seats, used), { skuId: active.planId, expiresAt: active.endAt })
  }

  /** 起进程时对一遍所有公司的订阅。返回被改动的公司数，只为在日志里说一声。 */
  async syncAllPlansFromOrders(): Promise<number> {
    let changed = 0
    for (const c of await this.companies()) {
      const before = await this.plan(c.id)
      await this.syncPlanFromOrders(c.id)
      const after = await this.plan(c.id)
      if (before?.skuId !== after?.skuId || before?.expiresAt !== after?.expiresAt || before?.seats !== after?.seats) changed++
    }
    return changed
  }

  // ── 单独充值 ──────────────────────────────────────────────────────────

  async topups(): Promise<Topup[]> {
    const rows = await this.many('select * from topups order by "createdAt" desc')
    return rows.map(topupOf)
  }

  async topupsOfCompany(companyId: string): Promise<Topup[]> {
    const rows = await this.many('select * from topups where "companyId" = ? order by "createdAt" desc', [companyId])
    return rows.map(topupOf)
  }

  /** 充值总额。充值不过期，所以是从头累加，不按时间窗口切。 */
  async topupTotal(companyId: string): Promise<number> {
    const r = await this.one('select coalesce(sum("amountMils"), 0) as total from topups where "companyId" = ?', [companyId])
    return num(r?.total)
  }

  async topupByOrder(orderId: string): Promise<Topup | undefined> {
    const r = await this.one('select * from topups where "orderId" = ?', [orderId])
    return r ? topupOf(r) : undefined
  }

  async insertTopup(input: {
    companyId: string
    amountMils: number
    orderId?: string | null
    note?: string
    createdBy?: string | null
  }): Promise<Topup> {
    const row: Topup = {
      id: randomUUID(),
      companyId: input.companyId,
      orderId: input.orderId ?? null,
      amountMils: input.amountMils,
      note: input.note ?? '',
      createdBy: input.createdBy ?? null,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into topups (id, "companyId", "orderId", "amountMils", note, "createdBy", "createdAt") values (?,?,?,?,?,?,?)',
      [row.id, row.companyId, row.orderId, row.amountMils, row.note, row.createdBy, row.createdAt],
    )
    return row
  }

  async updateTopup(id: string, patch: Partial<Pick<Topup, 'companyId' | 'amountMils' | 'note'>>): Promise<Topup | undefined> {
    const cur = await this.one('select * from topups where id = ?', [id])
    if (!cur) return undefined
    const next = { ...topupOf(cur), ...patch }
    const r = await this.one(
      'update topups set "companyId"=?, "amountMils"=?, note=? where id=? returning *',
      [next.companyId, next.amountMils, next.note, id],
    )
    return r ? topupOf(r) : undefined
  }

  /** 充值单退回未付款时，把开出去的那条充值记录撤掉——余额跟着掉回去。 */
  async deleteTopup(id: string): Promise<void> {
    await this.run('delete from topups where id = ?', [id])
  }

  // ── 账单 ──────────────────────────────────────────────────────────────

  async invoicesOfCompany(companyId: string): Promise<Invoice[]> {
    const rows = await this.many('select * from invoices where "companyId" = ? order by "periodStart" desc', [companyId])
    return rows.map(invoiceOf)
  }

  async invoiceByOrder(orderId: string): Promise<Invoice | undefined> {
    const r = await this.one('select * from invoices where "orderId" = ?', [orderId])
    return r ? invoiceOf(r) : undefined
  }

  async insertInvoice(input: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'>): Promise<Invoice> {
    const now = Date.now()
    const row: Invoice = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
    await this.run(
      `insert into invoices
       (id, "companyId", "orderId", "planName", "planNameEn", "amountMils", "periodStart", "periodEnd", status, "paidAt", "createdAt", "updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.companyId, row.orderId, row.planName, row.planNameEn, row.amountMils,
        row.periodStart, row.periodEnd, row.status, row.paidAt, row.createdAt, row.updatedAt,
      ],
    )
    return row
  }

  async updateInvoice(id: string, patch: Partial<Omit<Invoice, 'id' | 'createdAt'>>): Promise<Invoice | undefined> {
    const cur = await this.one('select * from invoices where id = ?', [id])
    if (!cur) return undefined
    const next = { ...invoiceOf(cur), ...patch, updatedAt: Date.now() }
    const r = await this.one(
      `update invoices set "companyId"=?, "orderId"=?, "planName"=?, "planNameEn"=?, "amountMils"=?,
       "periodStart"=?, "periodEnd"=?, status=?, "paidAt"=?, "updatedAt"=? where id=? returning *`,
      [
        next.companyId, next.orderId, next.planName, next.planNameEn, next.amountMils,
        next.periodStart, next.periodEnd, next.status, next.paidAt, next.updatedAt, id,
      ],
    )
    return r ? invoiceOf(r) : undefined
  }

  // ── 机器 ──────────────────────────────────────────────────────────────

  async insertMachine(input: {
    id?: string
    host?: string | null
    companyId?: string | null
    pairedAt?: number | null
    managerVersion?: string | null
    protocol?: number
    maxAccounts?: number
  }): Promise<Machine> {
    const base = {
      id: input.id ?? randomUUID(),
      host: input.host ?? null,
      companyId: input.companyId ?? null,
      lastHeartbeatAt: null as number | null,
      createdAt: Date.now(),
      pairedAt: input.pairedAt ?? null,
      managerVersion: input.managerVersion ?? null,
      protocol: input.protocol ?? 0,
      lastError: null as string | null,
      // 配对时还不知道架构，等第一次心跳带上来。
      arch: null as string | null,
      desiredManagerVersion: null as string | null,
      maxAccounts: input.maxAccounts ?? DEFAULT_MAX_ACCOUNTS,
      // 时区默认不管：没人指定之前，机器装成什么样就是什么样。
      timezone: null as string | null,
      currentTimezone: null as string | null,
      // 新登记的机器当然在册。墓碑只由 markMachineRemoved 立。
      removedAt: null as number | null,
    }
    for (let i = 0; i < 8; i++) {
      const row: Machine = { ...base, token: randomMachineToken() }
      try {
        await this.run(
          'insert into machines (id, host, "companyId", "lastHeartbeatAt", "createdAt", "pairedAt", "managerVersion", protocol, "lastError", arch, "desiredManagerVersion", "maxAccounts", timezone, "currentTimezone", token) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [
            row.id,
            row.host,
            row.companyId,
            row.lastHeartbeatAt,
            row.createdAt,
            row.pairedAt,
            row.managerVersion,
            row.protocol,
            row.lastError,
            row.arch,
            row.desiredManagerVersion,
            row.maxAccounts,
            row.timezone,
            row.currentTimezone,
            row.token,
          ],
        )
        return row
      } catch (e) {
        if (i === 7 || !isUniqueViolation(e)) throw e
      }
    }
    throw new Error('无法签发机器凭证')
  }

  /**
   * 换一把新的机器票。重新配对时用——旧管家（或者捡到旧票的人）立刻失效。
   * `insertMachine` 那边 token 是不可更新的，这里是唯一的轮换口子。
   */
  async rotateMachineToken(id: string): Promise<Machine | undefined> {
    for (let i = 0; i < 8; i++) {
      try {
        await this.run('update machines set token = ? where id = ?', [randomMachineToken(), id])
        return this.machine(id)
      } catch (e) {
        if (i === 7 || !isUniqueViolation(e)) throw e
      }
    }
    throw new Error('无法签发机器凭证')
  }

  /**
   * 按 id 取一台**在册**的机器。墓碑当不存在——它对界面来说已经被移除了。
   *
   * 唯一看得见墓碑的是 `machineByToken`（心跳要靠它把「你被移除了」送下去）。
   */
  async machine(id: string): Promise<Machine | undefined> {
    const r = await this.one('select * from machines where id = ? and "removedAt" is null', [id])
    return r ? machineOf(r) : undefined
  }

  /**
   * 按机器票取，**墓碑也返回**。
   *
   * 这是整个库里唯一看得见墓碑的查询，而且必须看得见：移除之后管家还会照常心跳，
   * 那一下正是把「你被移除了」交给它的唯一机会。调用方（心跳）要自己判 `removedAt`。
   */
  async machineByToken(token: string): Promise<Machine | undefined> {
    if (!token) return undefined
    const r = await this.one('select * from machines where token = ?', [token])
    return r ? machineOf(r) : undefined
  }

  /** 立墓碑。席位登记和公司默认机器的指向由调用方在同一个事务里先处理掉。 */
  async markMachineRemoved(id: string, at: number): Promise<void> {
    await this.run('update machines set "removedAt" = ? where id = ?', [at, id])
  }

  /**
   * 收掉过期的墓碑。
   *
   * 管家一直不来收信（机器已经关机、网线拔了、被重装了）时，墓碑不能永远躺着。
   * 不开定时器：读列表和删机器时各扫一次就够——这两处的频率远高于 TTL，而代价是
   * 一条走主键之外单列的 delete。
   */
  async sweepRemovedMachines(before: number): Promise<number> {
    return this.run('delete from machines where "removedAt" is not null and "removedAt" < ?', [before])
  }

  /**
   * 平台上登记过的所有机器，登记先后。
   *
   * **包括没派给任何公司的那些**（`companyId is null`）：机器管理页要答的是「平台上
   * 现在有哪些机器」，而一台刚配对完还没分配、或者原公司被删之后落单的机器，恰恰是
   * 最需要被人看见的——按公司去列永远列不到它们。
   */
  async allMachines(): Promise<Machine[]> {
    const rows = await this.many('select * from machines where "removedAt" is null order by "createdAt"')
    return rows.map(machineOf)
  }

  /** 这家公司的所有机器，登记先后。多机调度按这个顺序做兜底排序。 */
  async machinesOfCompany(companyId: string): Promise<Machine[]> {
    const rows = await this.many('select * from machines where "companyId" = ? and "removedAt" is null order by "createdAt"', [companyId])
    return rows.map(machineOf)
  }

  /** 按管家基址找机器。重跑装机脚本时靠它认出「还是那一台」，而不是凭空多一台。 */
  async machineByHost(companyId: string, host: string): Promise<Machine | undefined> {
    if (!host) return undefined
    const r = await this.one('select * from machines where "companyId" = ? and host = ? and "removedAt" is null', [companyId, host])
    return r ? machineOf(r) : undefined
  }

  async machineOfCompany(companyId: string): Promise<Machine | undefined> {
    const r = await this.one('select * from machines where "companyId" = ? and "removedAt" is null', [companyId])
    return r ? machineOf(r) : undefined
  }

  /** 只删登记，不碰机器。上面还有席位的话，先走 deleteSeatRuntimesOfMachine。 */
  async deleteMachine(id: string): Promise<void> {
    await this.run('delete from machines where id = ?', [id])
  }

  /**
   * 抹掉这台机器上所有席位的**登记**（不碰机器上的进程）。
   *
   * 跟 deleteMachine 是一对，必须同进同出：只删机器不删席位的话，那些行会留着一个
   * 指向不存在机器的 machineId，而 machineTokenFor 查不到就会**回落到这家公司的另
   * 一台机器**——聊天请求于是带着别的机器的票发出去，静默打到错的地方。
   *
   * instances 要一起删，而且**得在 seat_runtimes 之前**：那张表没有 machineId，只能
   * 顺着席位行去找；先删席位就没法定位了。它存的是 bot 的反代前缀，留着同样是一个
   * 指向已移除机器的旧地址。
   */
  async deleteSeatRuntimesOfMachine(machineId: string): Promise<number> {
    if (!machineId) return 0
    await this.run(
      'delete from instances i using seat_runtimes s where s."machineId" = ? and i."accountId" = s."accountId" and i."botId" = s."botId"',
      [machineId],
    )
    return this.run('delete from seat_runtimes where "machineId" = ?', [machineId])
  }

  async updateMachine(
    id: string,
    patch: Partial<
      Pick<
        Machine,
        | 'host'
        | 'companyId'
        | 'lastHeartbeatAt'
        | 'pairedAt'
        | 'managerVersion'
        | 'protocol'
        | 'lastError'
        | 'arch'
        | 'desiredManagerVersion'
        | 'maxAccounts'
        | 'timezone'
        | 'currentTimezone'
      >
    >,
  ): Promise<Machine> {
    const cur = await this.machine(id)
    if (!cur) throw new Error('机器不存在')
    const next: Machine = {
      ...cur,
      host: patch.host === undefined ? cur.host : patch.host,
      companyId: patch.companyId === undefined ? cur.companyId : patch.companyId,
      lastHeartbeatAt: patch.lastHeartbeatAt === undefined ? cur.lastHeartbeatAt : patch.lastHeartbeatAt,
      pairedAt: patch.pairedAt === undefined ? cur.pairedAt : patch.pairedAt,
      managerVersion: patch.managerVersion === undefined ? cur.managerVersion : patch.managerVersion,
      protocol: patch.protocol === undefined ? cur.protocol : patch.protocol,
      lastError: patch.lastError === undefined ? cur.lastError : patch.lastError,
      arch: patch.arch === undefined ? cur.arch : patch.arch,
      desiredManagerVersion:
        patch.desiredManagerVersion === undefined ? cur.desiredManagerVersion : patch.desiredManagerVersion,
      maxAccounts: patch.maxAccounts === undefined ? cur.maxAccounts : patch.maxAccounts,
      timezone: patch.timezone === undefined ? cur.timezone : patch.timezone,
      currentTimezone: patch.currentTimezone === undefined ? cur.currentTimezone : patch.currentTimezone,
    }
    await this.run(
      'update machines set host=?, "companyId"=?, "lastHeartbeatAt"=?, "pairedAt"=?, "managerVersion"=?, protocol=?, "lastError"=?, arch=?, "desiredManagerVersion"=?, "maxAccounts"=?, timezone=?, "currentTimezone"=? where id=?',
      [
        next.host,
        next.companyId,
        next.lastHeartbeatAt,
        next.pairedAt,
        next.managerVersion,
        next.protocol,
        next.lastError,
        next.arch,
        next.desiredManagerVersion,
        next.maxAccounts,
        next.timezone,
        next.currentTimezone,
        id,
      ],
    )
    return next
  }

  // ── 配对码。一次性、30 分钟过期，装管家时拿它换这台机器的 smt_。──

  async insertMachinePairing(row: MachinePairing): Promise<MachinePairing> {
    await this.run(
      'insert into machine_pairings (code, "companyId", "createdBy", "createdAt", "expiresAt", "usedAt", "machineId") values (?,?,?,?,?,?,?)',
      [row.code, row.companyId, row.createdBy, row.createdAt, row.expiresAt, row.usedAt, row.machineId],
    )
    return row
  }

  async machinePairing(code: string): Promise<MachinePairing | undefined> {
    if (!code) return undefined
    const r = await this.one('select * from machine_pairings where code = ?', [code])
    return r ? machinePairingOf(r) : undefined
  }

  /**
   * 认领一个配对码。**未用过才认领得到**——`usedAt is null` 写在 where 里，两台机器
   * 同时拿同一个码时数据库来裁决，不靠先查后写那种竞态。
   */
  async claimMachinePairing(code: string, machineId: string, now: number): Promise<boolean> {
    const n = await this.run(
      'update machine_pairings set "usedAt" = ?, "machineId" = ? where code = ? and "usedAt" is null and "expiresAt" > ?',
      [now, machineId, code, now],
    )
    return n > 0
  }

  /** 同一家公司再生成一个码时，把之前没用掉的作废——桌上不该同时躺着两张有效的票。 */
  /** 这台机器是不是这家公司配对进来的。认领只认自己配对的那台。 */
  async machinePairedBy(machineId: string, companyId: string): Promise<boolean> {
    const r = await this.one(
      'select 1 as n from machine_pairings where "machineId" = ? and "companyId" = ? limit 1',
      [machineId, companyId],
    )
    return Boolean(r)
  }

  async expireMachinePairings(companyId: string, now: number): Promise<void> {
    await this.run('update machine_pairings set "expiresAt" = ? where "companyId" = ? and "usedAt" is null and "expiresAt" > ?', [
      now,
      companyId,
      now,
    ])
  }

  // ── 实例。(账号, botId) 一对一台 Bot 运行时。只存 host，不存聊天正文。──

  async instance(accountId: string, botId: string): Promise<Instance | undefined> {
    const r = await this.one('select * from instances where "accountId" = ? and "botId" = ?', [accountId, botId])
    return r ? instanceOf(r) : undefined
  }

  async seatRuntime(accountId: string, botId: string): Promise<SeatRuntime | undefined> {
    const r = await this.one('select * from seat_runtimes where "accountId" = ? and "botId" = ?', [accountId, botId])
    return r ? seatRuntimeOf(r) : undefined
  }

  /** 按席位 id 反查。桌面反代只认得 URL 里那个 seatId，没有 accountId/botId。 */
  async seatRuntimeBySeatId(seatId: string): Promise<SeatRuntime | undefined> {
    const r = await this.one('select * from seat_runtimes where "seatId" = ?', [seatId])
    return r ? seatRuntimeOf(r) : undefined
  }

  async seatRuntimesOf(companyId: string): Promise<SeatRuntime[]> {
    const rows = await this.many('select * from seat_runtimes where "companyId" = ? order by slot', [companyId])
    return rows.map(seatRuntimeOf)
  }

  /** 某台机器上的席位。算容量和分配槽位都靠它。 */
  async seatRuntimesOfMachine(machineId: string): Promise<SeatRuntime[]> {
    const rows = await this.many('select * from seat_runtimes where "machineId" = ? order by slot', [machineId])
    return rows.map(seatRuntimeOf)
  }

  async seatRuntimesOfAccount(accountId: string): Promise<SeatRuntime[]> {
    const rows = await this.many('select * from seat_runtimes where "accountId" = ? order by slot', [accountId])
    return rows.map(seatRuntimeOf)
  }

  async upsertSeatRuntime(row: SeatRuntime): Promise<SeatRuntime> {
    await this.run(
      `insert into seat_runtimes (
         "accountId", "botId", "companyId", "linuxUser", "seatId", "machineId", slot, display, "vncPort", "novncPort",
         "botPort", "vncPassword", status, "lastError", "deployedAt", "updatedAt", "botVersion"
       ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict ("accountId", "botId") do update set
         "companyId"=excluded."companyId",
         "linuxUser"=excluded."linuxUser",
         "seatId"=excluded."seatId",
         "machineId"=excluded."machineId",
         slot=excluded.slot,
         display=excluded.display,
         "vncPort"=excluded."vncPort",
         "novncPort"=excluded."novncPort",
         "botPort"=excluded."botPort",
         "vncPassword"=excluded."vncPassword",
         status=excluded.status,
         "lastError"=excluded."lastError",
         "deployedAt"=excluded."deployedAt",
         "updatedAt"=excluded."updatedAt",
         "botVersion"=excluded."botVersion"`,
      [
        row.accountId,
        row.botId,
        row.companyId,
        row.linuxUser,
        row.seatId,
        row.machineId,
        row.slot,
        row.display,
        row.vncPort,
        row.novncPort,
        row.botPort,
        row.vncPassword,
        row.status,
        row.lastError,
        row.deployedAt,
        row.updatedAt,
        row.botVersion,
      ],
    )
    return (await this.seatRuntime(row.accountId, row.botId))!
  }

  async deleteSeatRuntime(accountId: string): Promise<void> {
    await this.run('delete from seat_runtimes where "accountId" = ?', [accountId])
  }

  // ── Bot 发布包。只存元数据，tarball 在 $SATUWORK_GATEWAY_HOME/releases。──

  async insertBotRelease(row: BotRelease): Promise<BotRelease> {
    await this.run(
      'insert into bot_releases (kind, version, sha256, size, "createdAt", note, url) values (?,?,?,?,?,?,?)',
      [row.kind, row.version, row.sha256, row.size, row.createdAt, row.note, row.url],
    )
    return row
  }

  async botRelease(version: string, kind: ReleaseKind = 'bot'): Promise<BotRelease | undefined> {
    const r = await this.one('select * from bot_releases where kind = ? and version = ?', [kind, version])
    return r ? botReleaseOf(r) : undefined
  }

  async botReleases(kind: ReleaseKind = 'bot'): Promise<BotRelease[]> {
    const rows = await this.many('select * from bot_releases where kind = ? order by "createdAt" desc', [kind])
    return rows.map(botReleaseOf)
  }

  /**
   * 最新的发布包，**按架构挑**。
   *
   * `arch` 给了就先找同架构的最新一版；没有同架构的，退回「认不出架构」的版本
   * （老版本号没有后缀，比如 `0.0.1`）；**绝不返回另一个已知架构的包**——那正是
   * 这个参数要挡的事。不给 `arch` 就是老行为：谁新要谁。
   */
  async latestBotRelease(kind: ReleaseKind = 'bot', arch?: string | null): Promise<BotRelease | undefined> {
    if (!arch) {
      const r = await this.one('select * from bot_releases where kind = ? order by "createdAt" desc limit 1', [kind])
      return r ? botReleaseOf(r) : undefined
    }
    const rows = await this.botReleases(kind) // 已按 createdAt desc 排好
    return rows.find((r) => releaseArch(r.version) === arch) ?? rows.find((r) => !releaseArch(r.version))
  }

  async upsertInstance(input: {
    accountId: string
    botId: string
    companyId?: string | null
    host: string
  }): Promise<Instance> {
    const now = Date.now()
    const companyId = input.companyId === undefined ? null : input.companyId
    await this.run(
      `insert into instances ("accountId", "botId", "companyId", host, "lastReadyAt") values (?,?,?,?,?)
       on conflict ("accountId", "botId") do update set
         "companyId"=excluded."companyId",
         host=excluded.host,
         "lastReadyAt"=excluded."lastReadyAt"`,
      [input.accountId, input.botId, companyId, input.host, now],
    )
    return { accountId: input.accountId, botId: input.botId, companyId, host: input.host, lastReadyAt: now }
  }

  // ── 目录 ──────────────────────────────────────────────────────────────

  async insertCatalog(input: {
    kind: CatalogKind
    scope: Scope
    companyId: string | null
    name: string
    definition?: unknown
  }): Promise<CatalogItem> {
    const now = Date.now()
    const row: CatalogItem = {
      id: randomUUID(),
      kind: input.kind,
      scope: input.scope,
      companyId: input.scope === 'global' ? null : input.companyId,
      name: input.name,
      definition: input.definition ?? {},
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into catalog_items (id, kind, scope, "companyId", name, definition, "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?)',
      [row.id, row.kind, row.scope, row.companyId, row.name, JSON.stringify(row.definition), row.createdAt, row.updatedAt],
    )
    return row
  }

  async catalog(id: string): Promise<CatalogItem | undefined> {
    const r = await this.one('select * from catalog_items where id = ?', [id])
    return r ? catalogOf(r) : undefined
  }

  async visibleCatalog(kind: CatalogKind, companyId: string | null): Promise<CatalogItem[]> {
    if (!companyId) {
      const rows = await this.many("select * from catalog_items where kind = ? and scope = 'global' order by name", [kind])
      return rows.map(catalogOf)
    }
    const rows = await this.many(
      "select * from catalog_items where kind = ? and (scope = 'global' or (scope = 'company' and \"companyId\" = ?)) order by scope, name",
      [kind, companyId],
    )
    return rows.map(catalogOf)
  }

  async companyCatalog(kind: CatalogKind, companyId: string): Promise<CatalogItem[]> {
    const rows = await this.many(
      "select * from catalog_items where kind = ? and scope = 'company' and \"companyId\" = ? order by name",
      [kind, companyId],
    )
    return rows.map(catalogOf)
  }

  async updateCatalog(id: string, patch: { name?: string; definition?: unknown }): Promise<CatalogItem> {
    const cur = await this.catalog(id)
    if (!cur) throw new Error('目录项不存在')
    const next: CatalogItem = {
      ...cur,
      name: patch.name ?? cur.name,
      definition: patch.definition === undefined ? cur.definition : patch.definition,
      updatedAt: Date.now(),
    }
    await this.run('update catalog_items set name=?, definition=?, "updatedAt"=? where id=?', [
      next.name,
      JSON.stringify(next.definition),
      next.updatedAt,
      id,
    ])
    return next
  }

  async deleteCatalog(id: string): Promise<void> {
    await this.run('delete from catalog_items where id = ?', [id])
  }

  // ── 密钥 ──────────────────────────────────────────────────────────────

  async insertCredential(input: { companyId: string; provider: string; secret: string }): Promise<Credential> {
    const now = Date.now()
    const row: Credential = {
      id: randomUUID(),
      companyId: input.companyId,
      provider: input.provider,
      secret: input.secret,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into credentials (id, "companyId", provider, secret, "createdAt", "updatedAt") values (?,?,?,?,?,?)',
      [row.id, row.companyId, row.provider, row.secret, row.createdAt, row.updatedAt],
    )
    return row
  }

  async credential(id: string): Promise<Credential | undefined> {
    const r = await this.one('select * from credentials where id = ?', [id])
    return r ? credOf(r) : undefined
  }

  async credentialsOf(companyId: string): Promise<Credential[]> {
    const rows = await this.many('select * from credentials where "companyId" = ? order by provider', [companyId])
    return rows.map(credOf)
  }

  async credentialByProvider(companyId: string, provider: string): Promise<Credential | undefined> {
    const r = await this.one('select * from credentials where "companyId" = ? and provider = ?', [companyId, provider])
    return r ? credOf(r) : undefined
  }

  async platformCredential(provider: string): Promise<Credential | undefined> {
    const r = await this.one('select * from platform_credentials where provider = ?', [provider])
    if (!r) return undefined
    return {
      id: `platform:${str(r.provider)}`,
      companyId: '',
      provider: str(r.provider),
      secret: str(r.secret),
      createdAt: num(r.createdAt),
      updatedAt: num(r.updatedAt),
    }
  }

  async upsertPlatformCredential(provider: string, secret: string): Promise<Credential> {
    const now = Date.now()
    await this.run(
      'insert into platform_credentials (provider, secret, "createdAt", "updatedAt") values (?,?,?,?) on conflict (provider) do update set secret=excluded.secret, "updatedAt"=excluded."updatedAt"',
      [provider, secret, now, now],
    )
    return (await this.platformCredential(provider))!
  }

  async platformCredentials(): Promise<Credential[]> {
    const rows = await this.many('select * from platform_credentials order by provider')
    return rows.map((r) => ({
      id: `platform:${str(r.provider)}`,
      companyId: '',
      provider: str(r.provider),
      secret: str(r.secret),
      createdAt: num(r.createdAt),
      updatedAt: num(r.updatedAt),
    }))
  }

  async deletePlatformCredential(provider: string): Promise<void> {
    await this.run('delete from platform_credentials where provider = ?', [provider])
  }

  async updateCredential(id: string, secret: string): Promise<Credential> {
    const cur = await this.credential(id)
    if (!cur) throw new Error('密钥不存在')
    const next = { ...cur, secret, updatedAt: Date.now() }
    await this.run('update credentials set secret=?, "updatedAt"=? where id=?', [next.secret, next.updatedAt, id])
    return next
  }

  async deleteCredential(id: string): Promise<void> {
    await this.run('delete from credentials where id = ?', [id])
  }

  // ── 审计 ──────────────────────────────────────────────────────────────

  async audit(input: {
    companyId: string
    accountId?: string | null
    action: string
    detail?: unknown
  }): Promise<AuditEvent> {
    const row: AuditEvent = {
      id: randomUUID(),
      companyId: input.companyId,
      accountId: input.accountId ?? null,
      action: input.action,
      detail: input.detail ?? {},
      createdAt: Date.now(),
    }
    await this.run(
      'insert into audit_events (id, "companyId", "accountId", action, detail, "createdAt") values (?,?,?,?,?,?)',
      [row.id, row.companyId, row.accountId, row.action, JSON.stringify(row.detail), row.createdAt],
    )
    return row
  }

  async auditsOf(companyId: string, limit = 100): Promise<AuditEvent[]> {
    const rows = await this.many('select * from audit_events where "companyId" = ? order by "createdAt" desc limit ?', [
      companyId,
      limit,
    ])
    return rows.map(auditOf)
  }

  // ── 会话索引。只存指针，不存 user/message 或 assistant/message 正文。──

  async upsertSessionIndex(input: {
    sessionId: string
    companyId: string
    accountId: string
    botId?: string | null
    machineId?: string | null
    origin?: string | null
    remoteId?: string | null
    messageCount?: number | null
    title?: string | null
    createdAt?: number | null
    updatedAt?: number | null
  }): Promise<SessionIndex> {
    const cur = await this.sessionIndex(input.sessionId)
    const now = Date.now()
    const row: SessionIndex = {
      sessionId: input.sessionId,
      companyId: input.companyId,
      accountId: input.accountId,
      botId: input.botId !== undefined ? input.botId : (cur?.botId ?? null),
      machineId: input.machineId !== undefined ? input.machineId : (cur?.machineId ?? null),
      origin: input.origin !== undefined ? input.origin : (cur?.origin ?? null),
      remoteId: input.remoteId !== undefined ? input.remoteId : (cur?.remoteId ?? null),
      messageCount: input.messageCount !== undefined ? input.messageCount : (cur?.messageCount ?? null),
      title: input.title !== undefined ? input.title : (cur?.title ?? null),
      createdAt: input.createdAt ?? cur?.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    }
    await this.run(
      `insert into session_index ("sessionId", "companyId", "accountId", "botId", "machineId", origin, "remoteId", "messageCount", title, "createdAt", "updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?)
       on conflict ("sessionId") do update set
         "companyId"=excluded."companyId",
         "accountId"=excluded."accountId",
         "botId"=excluded."botId",
         "machineId"=excluded."machineId",
         origin=excluded.origin,
         "remoteId"=excluded."remoteId",
         "messageCount"=excluded."messageCount",
         title=excluded.title,
         "createdAt"=excluded."createdAt",
         "updatedAt"=excluded."updatedAt"`,
      [
        row.sessionId,
        row.companyId,
        row.accountId,
        row.botId,
        row.machineId,
        row.origin,
        row.remoteId,
        row.messageCount,
        row.title,
        row.createdAt,
        row.updatedAt,
      ],
    )
    return row
  }

  async sessionIndex(sessionId: string): Promise<SessionIndex | undefined> {
    const r = await this.one('select * from session_index where "sessionId" = ?', [sessionId])
    return r ? sessionIndexOf(r) : undefined
  }

  /**
   * 会话索引列表。**必须带上限**：这张表随聊天无限增长，没有 LIMIT 的话一家用了一年
   * 的公司点一次「会话」就把几十万行读进内存再序列化成 JSON 发出去。
   */
  async listSessionIndex(
    companyId: string,
    filter: {
      accountId?: string
      botId?: string
      from?: number
      to?: number
      limit?: number
      /** keyset 游标：只要**严格排在它后面**的行。来自上一页最后一行。 */
      before?: { updatedAt: number; sessionId: string }
    } = {},
  ): Promise<SessionIndex[]> {
    let sql = 'select * from session_index where "companyId" = ?'
    const args: (string | number)[] = [companyId]
    if (filter.accountId) {
      sql += ' and "accountId" = ?'
      args.push(filter.accountId)
    }
    if (filter.botId) {
      sql += ' and "botId" = ?'
      args.push(filter.botId)
    }
    if (filter.from != null) {
      sql += ' and "updatedAt" >= ?'
      args.push(filter.from)
    }
    if (filter.to != null) {
      sql += ' and "updatedAt" <= ?'
      args.push(filter.to)
    }
    if (filter.before) {
      // 用 keyset 而不是 OFFSET：两页之间有新会话上报时，OFFSET 会让行整体后移，
      // 翻页要么漏要么重。审计列表漏行是实质问题。
      sql += ' and ("updatedAt" < ? or ("updatedAt" = ? and "sessionId" < ?))'
      args.push(filter.before.updatedAt, filter.before.updatedAt, filter.before.sessionId)
    }
    // 上限放到 MAX+1：路由会多要一条用来判断 hasMore，卡在 MAX 的话最后一页永远
    // 报「没有更多」。真正对外的每页条数由 sessionPageLimit 决定。
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? SESSION_PAGE_DEFAULT), 1), SESSION_PAGE_MAX + 1)
    sql += ' order by "updatedAt" desc, "sessionId" desc limit ?'
    args.push(limit)
    const rows = await this.many(sql, args)
    return rows.map(sessionIndexOf)
  }

  // ── 公司模型角色（日常 / utility）。不存密钥。────────────────────────

  async settings(companyId: string): Promise<CompanySettings> {
    const r = await this.one('select payload from settings where "companyId" = ?', [companyId])
    if (!r) return emptySettings()
    const raw = (jsonOf(r.payload) ?? {}) as Partial<CompanySettings>
    return {
      daily: { provider: String(raw.daily?.provider ?? ''), model: String(raw.daily?.model ?? '') },
      utility: { provider: String(raw.utility?.provider ?? ''), model: String(raw.utility?.model ?? '') },
    }
  }

  async putSettings(companyId: string, next: CompanySettings): Promise<CompanySettings> {
    const now = Date.now()
    const payload = JSON.stringify({
      daily: { provider: next.daily.provider, model: next.daily.model },
      utility: { provider: next.utility.provider, model: next.utility.model },
    })
    await this.run(
      'insert into settings ("companyId", payload, "updatedAt") values (?,?,?) on conflict ("companyId") do update set payload=excluded.payload, "updatedAt"=excluded."updatedAt"',
      [companyId, payload, now],
    )
    return this.settings(companyId)
  }

  async platformSettings(): Promise<PlatformSettings> {
    const r = await this.one("select payload from platform_settings where id = 'platform'")
    if (!r) return emptyPlatformSettings()
    return parsePlatformPayload(r.payload)
  }

  async putPlatformSettings(next: PlatformSettings): Promise<PlatformSettings> {
    const now = Date.now()
    const enabled = Array.isArray(next.enabledModels) ? next.enabledModels.map((x) => String(x)).filter(Boolean) : []
    const payload = JSON.stringify({
      daily: { provider: next.daily.provider, model: next.daily.model },
      utility: { provider: next.utility.provider, model: next.utility.model },
      enabledModels: enabled,
      priceMultiplier: parsePriceMultiplier(next.priceMultiplier),
      // **不能漏。** 这一行漏了整整一版：类型上有、路由层收得好好的、界面也能填，
      // 只有这里拼 payload 时把它丢了——于是 PUT 回 200、读出来永远是空。
      // 后果是「全机队钉版本」这一级完全失效：传一个包上去，所有没有逐台钉过的机器
      // 都会在下一次心跳自己升上去，而唯一能拦住它的开关，看起来能设、其实存不进去。
      managerVersion: String(next.managerVersion ?? '').trim(),
    })
    await this.run(
      "insert into platform_settings (id, payload, \"updatedAt\") values ('platform', ?, ?) on conflict (id) do update set payload=excluded.payload, \"updatedAt\"=excluded.\"updatedAt\"",
      [payload, now],
    )
    return this.platformSettings()
  }

  /**
   * 一次性：公司日常/utility 升到平台设置（平台还空时）；
   * 公司密钥升到 platform_credentials（该 provider 还没有平台密钥时）。
   */
  async liftCompanyDataToPlatform(): Promise<{ settings: boolean; providers: string[] }> {
    const lifted = { settings: false, providers: [] as string[] }
    const cur = await this.platformSettings()
    const empty = !cur.daily.provider && !cur.daily.model && !cur.utility.provider && !cur.utility.model
    if (empty) {
      const rows = await this.many('select payload from settings order by "updatedAt" desc')
      for (const row of rows) {
        const s = parsePlatformPayload(row.payload)
        if (s.daily.provider || s.daily.model || s.utility.provider || s.utility.model) {
          await this.putPlatformSettings({
            daily: s.daily,
            utility: s.utility,
            enabledModels: cur.enabledModels,
            priceMultiplier: cur.priceMultiplier,
          })
          lifted.settings = true
          break
        }
      }
    }
    const have = new Set((await this.platformCredentials()).map((c) => c.provider))
    const creds = await this.many('select provider, secret from credentials')
    for (const row of creds) {
      const provider = str(row.provider)
      if (!provider || have.has(provider)) continue
      await this.upsertPlatformCredential(provider, str(row.secret))
      have.add(provider)
      lifted.providers.push(provider)
    }
    return lifted
  }

  // ── Skill 标签。稿子上那八个是初值，建了新的就进这张表。──────────────

  async skillTags(companyId: string): Promise<string[]> {
    const rows = await this.many('select tag from skill_tags where "companyId" = ? order by seq', [companyId])
    return rows.map((r) => str(r.tag))
  }

  async insertSkillTag(companyId: string, tag: string): Promise<void> {
    await this.run('insert into skill_tags ("companyId", tag) values (?, ?) on conflict do nothing', [companyId, tag])
  }

  async deleteSkillTag(companyId: string, tag: string): Promise<boolean> {
    return (await this.run('delete from skill_tags where "companyId" = ? and tag = ?', [companyId, tag])) > 0
  }
}
