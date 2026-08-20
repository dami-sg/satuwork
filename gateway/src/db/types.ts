/**
 * 库里那些行长什么样，以及跟着它们走的常量和纯函数。
 *
 * 单独一个文件，是因为**几乎每个模块都要 import 这里的类型**，而它们和连接、SQL、
 * 事务没有任何关系。放在 db.ts 里的时候，routes 那边一条 `import type { Account }`
 * 会把整个 3000 行的 Db 类拖进依赖图。
 */

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

export type WebCallKind = 'search' | 'extract'

export interface WebCall {
  id: string
  accountId: string
  companyId: string | null
  kind: WebCallKind
  backend: string
  /** search 恒为 1；extract 记**真打了后端且抓成功**的条数——失败和命中缓存都不算。 */
  units: number
  /** 写行那一刻的报价，整数「厘」。 */
  mils: number
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
  /** 整个提示词，**含**命中缓存的那一截。 */
  promptTokens: number
  completionTokens: number
  /** promptTokens 里命中缓存的那一截。是子集，不是加项——计价时要按缓存读的单价单算。 */
  cachedTokens: number
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
  /** 网页搜索/提取的后端与价目。密钥不在这里，在 platform_credentials。 */
  webTools?: WebToolsSettings
}

/** 能挂网页工具的后端。`firecrawl` 只占位，还没接。 */
export const WEB_BACKENDS = ['tavily', 'searxng', 'duckduckgo', 'firecrawl'] as const
export type WebBackendId = (typeof WEB_BACKENDS)[number]

/** 单价，整数「厘」（千分之一美元），每次调用。和账单那套的单位一致。 */
export interface WebToolPrice {
  search: number
  extract: number
}

export interface WebToolsSettings {
  /** 空 = 没配。**不做自动检测**：配了哪把密钥就悄悄换一家后端，界面和实际会对不上。 */
  searchBackend: WebBackendId | ''
  extractBackend: WebBackendId | ''
  /** 自托管 SearXNG 的实例地址。不是密文，所以不进凭证表。 */
  searxngUrl: string
  pricing: Record<string, WebToolPrice>
  /** 一家公司一天最多几次调用。0 = 不限。防的是跑飞，不是精确计费。 */
  dailyLimit: number
}

export function emptyWebTools(): WebToolsSettings {
  return { searchBackend: '', extractBackend: '', searxngUrl: '', pricing: {}, dailyLimit: 0 }
}

function parseWebPrice(raw: unknown): WebToolPrice {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const mils = (v: unknown) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) && n >= 0 ? n : 0
  }
  return { search: mils(o.search), extract: mils(o.extract) }
}

export function parseWebTools(raw: unknown): WebToolsSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const backend = (v: unknown): WebBackendId | '' =>
    WEB_BACKENDS.includes(v as WebBackendId) ? (v as WebBackendId) : ''
  const pricing: Record<string, WebToolPrice> = {}
  const rawPricing = (o.pricing && typeof o.pricing === 'object' ? o.pricing : {}) as Record<string, unknown>
  for (const id of WEB_BACKENDS) {
    if (rawPricing[id] != null) pricing[id] = parseWebPrice(rawPricing[id])
  }
  const limit = Math.round(Number(o.dailyLimit))
  return {
    searchBackend: backend(o.searchBackend),
    extractBackend: backend(o.extractBackend),
    searxngUrl: typeof o.searxngUrl === 'string' ? o.searxngUrl.trim() : '',
    pricing,
    dailyLimit: Number.isFinite(limit) && limit > 0 ? limit : 0,
  }
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
  return { daily: { provider: '', model: '' }, utility: { provider: '', model: '' }, enabledModels: [], priceMultiplier: 1, managerVersion: '', webTools: emptyWebTools() }
}
