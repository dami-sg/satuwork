import { Account, AuditEvent, BotRelease, CatalogItem, CatalogKind, Company, ConnectionScope, ConnectionStatus, ConnectorCall, ConnectorCallStatus, ConnectorConnection, ConnectorInstall, Credential, DEFAULT_MAX_ACCOUNTS, Group, Instance, Invite, Invoice, Locale, Machine, MachineMetricMinute, MachinePairing, Memory, ModelRole, OrderKind, PLAN_PERIODS, PayStatus, Plan, PlanOrder, PlanPeriod, PlanSku, PlatformSettings, Role, Scope, SeatDeployPhase, SeatRuntime, SeatRuntimeStatus, Handoff, HandoffState, Routine, RoutineRun, RoutineRunStatus, RoutineRunTrigger, SessionIndex, Theme, Topup, ChargeKind, ChargeStatus, UsageCharge, emptyPlatformSettings, parseBilling, parseRoutineModelRole, parseRoutineTriggers, parseConnectorPricing, parseMemoryKind, parseMemoryLayer, parseMemoryPii, parseModelPricing, parsePriceMultiplier, parseWebTools } from './types.ts'

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
    handoffWebhook: strOrNull(r.handoffWebhook),
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
    connectorPricing: parseConnectorPricing(o.connectorPricing),
    // 空字符串 = 没钉，跟最新发布走。写端和这里必须成对，少一边这个开关就是死的。
    managerVersion: typeof o.managerVersion === 'string' ? o.managerVersion.trim() : '',
    webTools: parseWebTools(o.webTools),
    modelPricing: parseModelPricing(o.modelPricing),
    // 老库里没有这个字段，回落成「开」——默认值定死在 parseBilling 里，这里不另写一份。
    billing: parseBilling(o.billing),
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
    // 自报数据整格可能是空（老管家从不报）。空就是 null，别用 `{}` 顶——那样界面
    // 得再判一次「里头两项是不是都没有」，而「没报过」本来就是一个干净的状态。
    telemetry: r.telemetry == null ? null : (jsonOf(r.telemetry) as Machine['telemetry']),
    telemetryAt: numOrNull(r.telemetryAt),
    logCapMb: numOrNull(r.logCapMb),
    removedAt: numOrNull(r.removedAt),
    token: str(r.token || ''),
  }
}

export function machineMetricMinuteOf(r: Row): MachineMetricMinute {
  return {
    machineId: str(r.machineId),
    minuteStart: num(r.minuteStart),
    samples: num(r.samples),
    cpuSum: num(r.cpuSum),
    cpuMax: num(r.cpuMax),
    memSum: num(r.memSum),
    memMax: num(r.memMax),
    diskSum: num(r.diskSum),
    diskMax: num(r.diskMax),
    txBytes: num(r.txBytes),
    rxBytes: num(r.rxBytes),
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

/** 认不出来的一律当「没在装」。这一列只用来画进度，猜错还不如不画。 */
export function seatPhaseOf(v: unknown): SeatDeployPhase | null {
  const s = str(v || '')
  return s === 'queued' || s === 'installing' ? s : null
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
    tplVersion: numOrNull(r.tplVersion),
    tplSyncedAt: numOrNull(r.tplSyncedAt),
    deployPhase: seatPhaseOf(r.deployPhase),
    deployStartedAt: numOrNull(r.deployStartedAt),
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
/** jsonb 的字符串数组。脏数据（不是数组、混了别的类型）一律当空，不让它往下传。 */
export function strListOf(v: unknown): string[] {
  const parsed = jsonOf(v)
  if (!Array.isArray(parsed)) return []
  return parsed.filter((x): x is string => typeof x === 'string')
}

export function connectorInstallOf(r: Row): ConnectorInstall {
  return {
    id: str(r.id),
    connectorId: str(r.connectorId),
    accountId: str(r.accountId),
    companyId: str(r.companyId),
    enabledTools: strListOf(r.enabledTools),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}

export function connectorConnectionOf(r: Row): ConnectorConnection {
  return {
    id: str(r.id),
    connectorId: str(r.connectorId),
    vendor: str(r.vendor),
    scope: str(r.scope) as ConnectionScope,
    label: str(r.label),
    accountId: strOrNull(r.accountId),
    companyId: str(r.companyId),
    externalUserId: str(r.externalUserId),
    externalId: strOrNull(r.externalId),
    status: str(r.status) as ConnectionStatus,
    mentionOnly: r.mentionOnly === true,
    lastError: strOrNull(r.lastError),
    connectedAt: numOrNull(r.connectedAt),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}

export function connectorCallOf(r: Row): ConnectorCall {
  return {
    id: str(r.id),
    companyId: strOrNull(r.companyId),
    accountId: str(r.accountId),
    connectionId: strOrNull(r.connectionId),
    botId: strOrNull(r.botId),
    sessionId: strOrNull(r.sessionId),
    vendor: str(r.vendor),
    connector: str(r.connector),
    label: str(r.label || ''),
    tool: str(r.tool),
    status: str(r.status) as ConnectorCallStatus,
    amountMicros: num(r.amountMicros),
    bonusMicros: num(r.bonusMicros),
    latencyMs: num(r.latencyMs),
    viaMention: r.viaMention === true,
    createdAt: num(r.createdAt),
  }
}

/** 账本行。jsonb 两列回来已经是对象，但早期写进去的字符串也兜一下（jsonOf）。 */
export function usageChargeOf(r: Row): UsageCharge {
  const nums = (v: unknown): Record<string, number> => {
    const o = jsonOf(v)
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {}
    const out: Record<string, number> = {}
    for (const [k, val] of Object.entries(o as Record<string, unknown>)) {
      const n = Number(val)
      if (Number.isFinite(n)) out[k] = n
    }
    return out
  }
  return {
    id: str(r.id),
    companyId: strOrNull(r.companyId),
    accountId: str(r.accountId),
    botId: strOrNull(r.botId),
    sessionId: strOrNull(r.sessionId),
    kind: str(r.kind) as ChargeKind,
    subject: str(r.subject),
    status: str(r.status) as ChargeStatus,
    quantity: nums(r.quantity),
    unitPrice: nums(r.unitPrice),
    multiplier: num(r.multiplier),
    amountMicros: num(r.amountMicros),
    bonusMicros: num(r.bonusMicros),
    unpriced: r.unpriced === true,
    refId: strOrNull(r.refId),
    createdAt: num(r.createdAt),
  }
}

export function catalogOf(r: Row): CatalogItem {
  return {
    id: str(r.id),
    kind: str(r.kind) as CatalogKind,
    scope: str(r.scope) as Scope,
    companyId: strOrNull(r.companyId),
    accountId: strOrNull(r.accountId),
    botId: strOrNull(r.botId),
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

export function routineOf(r: Row): Routine {
  return {
    id: str(r.id),
    botId: str(r.botId),
    accountId: str(r.accountId),
    companyId: str(r.companyId),
    name: str(r.name),
    instruction: str(r.instruction),
    active: Boolean(r.active),
    triggers: parseRoutineTriggers(r.triggers),
    modelRole: parseRoutineModelRole(r.modelRole),
    nextRunAt: numOrNull(r.nextRunAt),
    retryAt: numOrNull(r.retryAt),
    retryCount: num(r.retryCount),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}

/**
 * 一条长期记忆。
 *
 * `pii` 用 `parseMemoryPii` 而不是直接 `as string[]`：那一列是**席位报上来的**，
 * Gateway 只存不判（docs/memory.md §6），所以读回来时也不能假设它的形状。
 */
export function memoryOf(r: Row): Memory {
  return {
    id: str(r.id),
    layer: parseMemoryLayer(r.layer),
    companyId: str(r.companyId),
    accountId: strOrNull(r.accountId),
    botId: strOrNull(r.botId),
    groupId: strOrNull(r.groupId),
    kind: parseMemoryKind(r.kind),
    text: str(r.text),
    by: str(r.by) === 'user' ? 'user' : 'agent',
    sourceSessionId: strOrNull(r.sourceSessionId),
    pii: parseMemoryPii(jsonOf(r.pii)),
    pinned: Boolean(r.pinned),
    expiresAt: numOrNull(r.expiresAt),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}

export function routineRunOf(r: Row): RoutineRun {
  return {
    id: str(r.id),
    routineId: str(r.routineId),
    botId: str(r.botId),
    accountId: str(r.accountId),
    companyId: str(r.companyId),
    trigger: str(r.trigger) as RoutineRunTrigger,
    status: str(r.status) as RoutineRunStatus,
    sessionId: strOrNull(r.sessionId),
    error: strOrNull(r.error),
    startedAt: num(r.startedAt),
    endedAt: numOrNull(r.endedAt),
  }
}

export function handoffOf(r: Row): Handoff {
  return {
    id: str(r.id),
    sessionId: str(r.sessionId),
    botId: str(r.botId),
    accountId: str(r.accountId),
    companyId: str(r.companyId),
    machineId: strOrNull(r.machineId),
    state: str(r.state) as HandoffState,
    assignee: strOrNull(r.assignee),
    claimedBy: strOrNull(r.claimedBy),
    blocking: Boolean(r.blocking),
    repeats: num(r.repeats),
    reason: str(r.reason),
    ask: str(r.ask),
    notifyStep: num(r.notifyStep),
    createdAt: num(r.createdAt),
    claimedAt: numOrNull(r.claimedAt),
    returnedAt: numOrNull(r.returnedAt),
    closedAt: numOrNull(r.closedAt),
    updatedAt: num(r.updatedAt),
  }
}

/** `?` 占位符换成 PG 的 `$1..$n`。SQL 照原样写，省得每条都数一遍位置。 */
export function toPg(text: string): string {
  let i = 0
  return text.replace(/\?/g, () => `$${++i}`)
}
