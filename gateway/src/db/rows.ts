import { Account, AuditEvent, BotRelease, CatalogItem, CatalogKind, Company, Credential, DEFAULT_MAX_ACCOUNTS, Group, Instance, Invite, Invoice, Locale, Machine, MachinePairing, ModelRole, OrderKind, PLAN_PERIODS, PayStatus, Plan, PlanOrder, PlanPeriod, PlanSku, PlatformSettings, Role, Scope, SeatRuntime, SeatRuntimeStatus, SessionIndex, Theme, Topup, emptyPlatformSettings, parsePriceMultiplier } from './types.ts'

/**
 * `select *` 回来的裸行 → 上面那些类型。
 *
 * 驼峰列名一律加引号：PG 不加引号会折成小写，而 `select *` 的结果直接喂给这些
 * mapper。加了引号，写漏的那一刻 PG 就报 column does not exist，不会静默变 undefined。
 */

export type Row = Record<string, unknown>

export function str(v: unknown): string {
  return String(v)
}

/** PG 的唯一约束冲突是 23505。别去 match 报错文案。 */
export function isUniqueViolation(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && (e as { code?: string }).code === '23505')
}
export function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v)
}
/** bigint 在 pg 里回来是字符串（超出 double 安全范围时不该硬转，但毫秒时间戳远没到）。 */
export function num(v: unknown): number {
  return Number(v)
}
export function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v)
}
/** jsonb 回来已经是对象；早期写进去的字符串也兜一下。 */
export function jsonOf(v: unknown): unknown {
  if (typeof v !== 'string') return v ?? {}
  try {
    return JSON.parse(v)
  } catch {
    return {}
  }
}

export function companyOf(r: Row): Company {
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
export function themeOf(v: unknown): Theme {
  const t = str(v || 'system')
  return t === 'light' || t === 'dark' || t === 'system' ? t : 'system'
}
export function localeOf(v: unknown): Locale {
  return str(v || 'zh') === 'en' ? 'en' : 'zh'
}
export function accountOf(r: Row): Account {
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

export function inviteOf(r: Row): Invite {
  return {
    id: str(r.id),
    userId: str(r.userId),
    companyId: str(r.companyId),
    createdBy: str(r.createdBy),
    createdAt: num(r.createdAt),
    expiresAt: num(r.expiresAt),
  }
}

export function nameFromEmail(email: string): string {
  const local = email.split('@')[0]?.trim()
  return local || email
}

export function parseModelRole(raw: Partial<ModelRole> | undefined): ModelRole {
  return { provider: String(raw?.provider ?? ''), model: String(raw?.model ?? '') }
}

export function parsePlatformPayload(raw: unknown): PlatformSettings {
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
export function planOf(r: Row): Plan {
  return {
    companyId: str(r.companyId),
    seats: num(r.seats),
    skuId: strOrNull(r.skuId),
    expiresAt: r.expiresAt == null ? null : num(r.expiresAt),
    updatedAt: num(r.updatedAt),
  }
}

/** 库里存的是英文枚举；认不出来的一律当月包，不让脏值把界面弄崩。 */
export function periodOf(v: unknown): PlanPeriod {
  const s = String(v ?? '')
  return (PLAN_PERIODS as string[]).includes(s) ? (s as PlanPeriod) : 'month'
}

export function payStatusOfRow(v: unknown): PayStatus {
  return String(v ?? '') === 'paid' ? 'paid' : 'unpaid'
}

export function topupOf(r: Row): Topup {
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

export function invoiceOf(r: Row): Invoice {
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

export function orderKindOfRow(v: unknown): OrderKind {
  return String(v ?? '') === 'topup' ? 'topup' : 'plan'
}

export function planOrderOf(r: Row): PlanOrder {
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

export function planSkuOf(r: Row): PlanSku {
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

export function parseIdList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x))
  const v = jsonOf(raw)
  return Array.isArray(v) ? v.map((x) => String(x)) : []
}

export function groupOf(r: Row): Group {
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
export function machineOf(r: Row): Machine {
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

export function machinePairingOf(r: Row): MachinePairing {
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

export function seatStatusOf(v: unknown): SeatRuntimeStatus {
  const s = str(v || 'none')
  if (s === 'deploying' || s === 'ready' || s === 'error' || s === 'none') return s
  return 'error'
}

export function seatRuntimeOf(r: Row): SeatRuntime {
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
export function botReleaseOf(r: Row): BotRelease {
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
export function catalogOf(r: Row): CatalogItem {
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
export function credOf(r: Row): Credential {
  return {
    id: str(r.id),
    companyId: str(r.companyId),
    provider: str(r.provider),
    secret: str(r.secret),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}
export function auditOf(r: Row): AuditEvent {
  return {
    id: str(r.id),
    companyId: str(r.companyId),
    accountId: strOrNull(r.accountId),
    action: str(r.action),
    detail: jsonOf(r.detail),
    createdAt: num(r.createdAt),
  }
}
export function sessionIndexOf(r: Row): SessionIndex {
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

export function instanceOf(r: Row): Instance {
  return {
    accountId: str(r.accountId),
    botId: str(r.botId),
    companyId: strOrNull(r.companyId),
    host: str(r.host),
    lastReadyAt: num(r.lastReadyAt),
  }
}

/** `?` 占位符换成 PG 的 `$1..$n`。SQL 照原样写，省得每条都数一遍位置。 */
export function toPg(text: string): string {
  let i = 0
  return text.replace(/\?/g, () => `$${++i}`)
}
