import type { ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import {
  type Account,
  type AccountStatus,
  type CatalogItem,
  type CatalogKind,
  type Company,
  type CompanySettings,
  type Credential,
  type Db,
  type Group,
  type Machine,
  type ModelRole,
  type PlatformSettings,
  type Role,
  type SessionIndex,
} from './db.ts'
import {
  companyMachineOf,
  deploySeat,
  listSeatRuntime,
  ownerMachine,
  publicMachine,
  publicSeatRuntime,
} from './deploy.ts'
import { botSrcVersion, parseBotVersion, publicBotRelease, publishBotRelease } from './releases.ts'
import {
  hashPassword,
  INVITE_TTL,
  jwks,
  MIN_PASSWORD,
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
import { HttpError, bearer, json, type Req, type Router } from './http.ts'
import { createLlm } from './llm.ts'
import { attachV1 } from './v1.ts'

const JWT_TTL = Number(process.env.GATEWAY_JWT_TTL_SECONDS ?? 7 * 24 * 3600)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SLUG_RE = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/
const KIND: Record<string, CatalogKind> = { models: 'model', skills: 'skill', mcp: 'mcp', bots: 'bot' }
const LOGIN_DUMMY_HASH = hashPassword('satuwork-login-dummy')

function bodyOf(req: Req): Record<string, unknown> {
  if (req.body == null) return {}
  if (typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, '请求体必须是对象')
  return req.body as Record<string, unknown>
}

function deployOptsOf(req: Req): { botId: string; version?: string; update?: boolean } {
  const body = bodyOf(req)
  const botId = strField(body, 'botId')
  const version = strField(body, 'version', false)
  return { botId, version: version || undefined, update: body.update === true }
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

function tokenCount(v: unknown, key: string): number {
  if (v == null || v === '') return 0
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${key} 必须是非负数字`)
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
  }
}

function publicPlatformCred(c: { provider: string; createdAt: number; updatedAt: number }) {
  return { configured: true as const, provider: c.provider, createdAt: c.createdAt, updatedAt: c.updatedAt }
}

function orgSummary(db: Db, c: Company) {
  const plan = db.plan(c.id)
  return {
    ...publicCompany(c),
    seats: plan?.seats ?? 0,
    used: db.accountCount(c.id),
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

function membersInCompany(db: Db, companyId: string, v: unknown): string[] {
  const allowed = new Set(db.accountsOf(companyId).map((a) => a.id))
  return stringIds(v).filter((id) => allowed.has(id))
}

function publicCompany(c: Company) {
  return { id: c.id, slug: c.slug, name: c.name, machineId: c.machineId, accessUrl: c.accessUrl, createdAt: c.createdAt }
}

function publicSessionIndex(db: Db, row: SessionIndex) {
  const account = db.account(row.accountId)
  const bot = row.botId ? db.catalog(row.botId) : undefined
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
  token = process.env.GATEWAY_MACHINE_TOKEN ?? '',
): Promise<{ ok: true; events: unknown[] } | { ok: false }> {
  const url = `${machineBase(host)}/internal/sessions/${encodeURIComponent(sessionId)}`
  try {
    const r = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
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

function instanceHostFor(account: Account, db: Db, botId: string): string {
  requireSeat(account)
  const id = (botId || '').trim()
  if (!id) throw new HttpError(400, 'botId 不能为空')
  const row = db.instance(account.id, id)
  const host = row?.host?.trim() || ''
  if (!host) throw new HttpError(503, INSTANCE_DOWN)
  return host.replace(/\/$/, '')
}

function instanceHostForSession(account: Account, db: Db, sessionId: string): string {
  requireSeat(account)
  const idx = db.sessionIndex(sessionId)
  const botId = (idx?.botId || '').trim()
  if (!botId || idx!.accountId !== account.id) throw new HttpError(503, INSTANCE_DOWN)
  return instanceHostFor(account, db, botId)
}

function visibleBotOf(db: Db, account: Account, botId: string) {
  requireSeat(account)
  const id = (botId || '').trim()
  if (!id) throw new HttpError(400, 'botId 不能为空')
  const hit = db.visibleCatalog('bot', account.companyId).find((b) => b.id === id)
  if (!hit) throw new HttpError(404, '没有这个 Bot')
  return hit
}

function pairRuntime(db: Db, account: Account, botId: string) {
  const rt = db.seatRuntime(account.id, botId)
  if (!rt) return null
  const machine = companyMachineOf(db, account.companyId!)
  return listSeatRuntime(rt, machine?.sshHost || '')
}

function seatBearer(db: Db, accountId: string): string {
  const secrets = db.accountSecrets(accountId)
  if (secrets?.accessToken) return secrets.accessToken
  return process.env.GATEWAY_MACHINE_TOKEN ?? ''
}

async function proxyJson(res: ServerResponse, method: string, url: string, body?: unknown, token?: string) {
  const bearerTok = token || process.env.GATEWAY_MACHINE_TOKEN || ''
  let r: Response
  try {
    r = await fetch(url, {
      method,
      headers: {
        authorization: bearerTok ? `Bearer ${bearerTok}` : '',
        accept: 'application/json',
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

async function proxySse(req: Req, res: ServerResponse, url: string, token?: string) {
  const bearerTok = token || process.env.GATEWAY_MACHINE_TOKEN || ''
  const ac = new AbortController()
  const onClose = () => ac.abort()
  req.on('close', onClose)
  let r: Response
  try {
    r = await fetch(url, {
      headers: {
        authorization: bearerTok ? `Bearer ${bearerTok}` : '',
        accept: 'text/event-stream',
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

const BOT_ICONS = new Set(['bot', 'chat', 'chart', 'pen', 'deal', 'code'])
const DEFAULT_BOT_PROMPT =
  '你是 Satuwork 的 AI 员工。用简洁、专业的中文回答。需要当前时间或精确计算时调用工具，不要凭猜测。'
const DEFAULT_BOT_PROVIDER = 'deepseek'
const DEFAULT_BOT_MODEL = 'deepseek-v4-flash'

function botDefOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) }
  return {}
}

function botIconOf(v: unknown, fallback = 'bot'): string {
  return typeof v === 'string' && BOT_ICONS.has(v) ? v : fallback
}

function botNameOf(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : ''
  if (!name) throw new HttpError(400, '助理要有名字')
  return name
}

/** 新建时用平台日常，没有再退到 utility，再没有就 deepseek。 */
function defaultBotModel(db: Db): { provider: string; model: string } {
  const s = db.platformSettings()
  if (s.daily.provider && s.daily.model) return { provider: s.daily.provider, model: s.daily.model }
  if (s.utility.provider && s.utility.model) return { provider: s.utility.provider, model: s.utility.model }
  return { provider: DEFAULT_BOT_PROVIDER, model: DEFAULT_BOT_MODEL }
}

function idList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))]
}

/** 只收下本公司目录里真实存在的 id，不认识的直接丢掉。 */
function assignedIds(db: Db, orgId: string, kind: 'skill' | 'mcp', v: unknown): string[] {
  if (!Array.isArray(v)) return []
  const known = new Set(db.companyCatalog(kind, orgId).map((i) => i.id))
  return idList(v).filter((id) => known.has(id))
}

function publicBot(item: CatalogItem) {
  const def = botDefOf(item.definition)
  const skills = idList(def.skills)
  const mcps = idList(def.mcps)
  return {
    id: item.id,
    name: item.name,
    description: typeof def.description === 'string' ? def.description : '',
    prompt: typeof def.prompt === 'string' ? def.prompt : '',
    icon: botIconOf(def.icon),
    provider: typeof def.provider === 'string' ? def.provider : '',
    model: typeof def.model === 'string' ? def.model : '',
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


function requireCompanyBot(db: Db, orgId: string, botId: string): CatalogItem {
  const item = db.catalog(botId)
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

function knownTags(db: Db, companyId: string): string[] {
  const tags = db.skillTags(companyId)
  if (tags.length) return tags
  for (const tag of DEFAULT_SKILL_TAGS) db.insertSkillTag(companyId, tag)
  return db.skillTags(companyId)
}

function rememberTags(db: Db, companyId: string, tags: string[]) {
  const known = new Set(knownTags(db, companyId))
  for (const tag of tags) {
    if (!known.has(tag)) db.insertSkillTag(companyId, tag)
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

function requireCompanySkill(db: Db, orgId: string, skillId: string): CatalogItem {
  const item = db.catalog(skillId)
  if (!item || item.kind !== 'skill' || item.scope !== 'company' || item.companyId !== orgId) {
    throw new HttpError(404, '没有这个 Skill')
  }
  return item
}

function requireCompanyMcp(db: Db, orgId: string, serverId: string): CatalogItem {
  const item = db.catalog(serverId)
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

function accountFromJwt(req: Req, db: Db, keys: JwtKeys): Account {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '需要登录')
  if (token.startsWith('sk_sw_') || token.startsWith('sat_')) throw new HttpError(401, '需要登录')
  let payload: JwtPayload
  try {
    payload = verifyJwt(keys, token)
  } catch (e) {
    throw new HttpError(401, (e as Error).message)
  }
  const account = db.account(payload.accountId)
  if (!account) throw new HttpError(401, '账号不存在')
  if (account.tokenRevokedAt && payload.iat < Math.floor(account.tokenRevokedAt / 1000)) {
    throw new HttpError(401, '登录已失效，请重新登录')
  }
  return gateAccount(account)
}

/** 控制台写操作：只要登录 JWT。sat_ / sk_sw_ 都不行。 */
function requireUser(req: Req, db: Db, keys: JwtKeys): Account {
  return accountFromJwt(req, db, keys)
}

/** Bot 拉目录：登录 JWT 或席位 sat_。sk_sw_ 不行。 */
function requireSeatOrUser(req: Req, db: Db, keys: JwtKeys): Account {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '需要登录')
  if (token.startsWith('sk_sw_')) throw new HttpError(401, '需要登录')
  if (token.startsWith('sat_')) return gateAccount(db.accountByAccessToken(token))
  return accountFromJwt(req, db, keys)
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

function inviteeOf(db: Db, token: string) {
  const id = sha256Hex(token)
  const row = db.invite(id)
  if (!row) return null
  if (row.expiresAt < Date.now()) {
    db.deleteInvite(id)
    return null
  }
  const user = db.account(row.userId)
  if (!user || user.status === 'disabled') return null
  return { user, invite: row, id }
}

function issueInvite(db: Db, user: Account, createdBy: string, ttl: number) {
  db.deleteInvitesForUser(user.id)
  const token = randomInviteToken()
  const now = Date.now()
  db.putInvite({
    id: sha256Hex(token),
    userId: user.id,
    companyId: user.companyId ?? '',
    createdBy,
    createdAt: now,
    expiresAt: now + ttl,
  })
  return { token, expiresAt: now + ttl }
}

function noteLogin(db: Db, account: Account): Account {
  return db.updateAccount(account.id, {
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
          byMember: opts.members.map((m) => {
            const name = m.name || m.email
            const initial = (name || '·').trim().slice(0, 1).toUpperCase()
            const row = byAccount.get(m.id)
            const tokens = row ? row.promptTokens + row.completionTokens : 0
            return {
              id: m.id,
              name,
              initial,
              tasks: String(row?.calls ?? 0),
              tokens: String(tokens),
              fail: '—',
              last: '—',
            }
          }),
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

function requireMachine(req: Req, db: Db): Machine {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '无效的机器凭证')
  const machine = db.machineByToken(token)
  if (!machine || !machine.token || !timingSafeToken(token, machine.token)) {
    throw new HttpError(401, '无效的机器凭证')
  }
  return machine
}

function requirePlatformToken(req: Req) {
  const expected = process.env.GATEWAY_PLATFORM_TOKEN ?? ''
  const token = bearer(req)
  if (!expected || !token || !timingSafeToken(token, expected)) {
    throw new HttpError(401, '无效的平台凭证')
  }
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

  router.get('/health', (_req, res) => send(res, 200, { ok: true }))
  router.get('/jwks', (_req, res) => send(res, 200, jwks(keys)))
  router.get('/.well-known/jwks.json', (_req, res) => send(res, 200, jwks(keys)))

  // ── 注册 / 登录 ─────────────────────────────────────────────────────

  router.post('/auth/register', async (req, res) => {
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const password = strField(body, 'password')
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    const name = strField(body, 'companyName')
    const slug = slugOf(strField(body, 'slug'))
    const seats = seatsOf(body.seats, 1)
    if (db.accountByEmail(email)) throw new HttpError(409, '这个邮箱已经注册')
    if (db.companyBySlug(slug)) throw new HttpError(409, '这个 slug 已被占用')
    const passwordHash = await hashPassword(password)
    const { company, account } = db.tx(() => {
      const company = db.insertCompany({ slug, name })
      db.upsertPlan(company.id, seats)
      const account = db.insertAccount({ companyId: company.id, email, passwordHash, role: 'admin' })
      db.audit({ companyId: company.id, accountId: account.id, action: 'auth.register', detail: { slug, seats } })
      return { company, account }
    })
    send(res, 201, { token: issue(keys, account), account: publicAccount(account), company: publicCompany(company) })
  })

  router.post('/auth/login', async (req, res) => {
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const password = strField(body, 'password')
    const account = db.accountByEmail(email)
    // 找不到也走同一条失败路径，不靠耗时差泄露「这个邮箱在不在」。
    const ok = account ? await verifyPassword(password, account.passwordHash) : await verifyPassword(password, await LOGIN_DUMMY_HASH)
    if (!account || !ok) throw new HttpError(401, '邮箱或口令不对')
    if (account.status === 'disabled') throw new HttpError(403, '这个账号已被停用，请联系管理员')
    if (account.status === 'invited') throw new HttpError(403, '请先用邀请链接设置口令')
    const logged = noteLogin(db, account)
    if (logged.role === 'owner') {
      db.audit({ companyId: 'platform', accountId: logged.id, action: 'auth.login' })
      send(res, 200, { token: issue(keys, logged), account: publicAccount(logged), company: null })
      return
    }
    const company = db.company(logged.companyId!)
    if (!company) throw new HttpError(401, '账号不存在')
    db.audit({ companyId: company.id, accountId: logged.id, action: 'auth.login' })
    send(res, 200, { token: issue(keys, logged), account: publicAccount(logged), company: publicCompany(company) })
  })

  /**
   * 看一条邀请是否还有效。公开：点链接的人还没有账号。
   * 无效不区分「不存在 / 过期 / 用过」——三者对访客是同一件事。
   */
  router.get('/invites/:token', (req, res) => {
    const found = inviteeOf(db, req.params.token)
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
    const found = inviteeOf(db, req.params.token)
    if (!found) throw new HttpError(400, '这条邀请链接不可用')
    const body = bodyOf(req)
    const password = strField(body, 'password')
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    const name = strField(body, 'name', false)
    const passwordHash = await hashPassword(password)
    const now = Date.now()
    const next = db.updateAccount(found.user.id, {
      name: name || found.user.name,
      passwordHash,
      status: 'active',
      passwordChangedAt: now,
      lastSeenAt: now,
    })
    db.deleteInvite(found.id)
    send(res, 200, { token: issue(keys, next), account: publicAccount(next) })
  })

  router.get('/me', (req, res) => {
    const account = requireSeatOrUser(req, db, keys)
    const settings = publicSettings(db.platformSettings())
    if (account.role === 'owner') {
      send(res, 200, {
        account: publicAccount(account),
        company: null,
        plan: null,
        settings,
        orgs: db.companies().map((c) => orgSummary(db, c)),
      })
      return
    }
    const company = db.company(account.companyId!)
    if (!company) throw new HttpError(401, '账号不存在')
    const plan = db.plan(company.id)!
    send(res, 200, {
      account: publicAccount(account),
      company: publicCompany(company),
      plan: { seats: plan.seats, used: db.accountCount(company.id) },
      settings,
    })
  })

  /**
   * 改自己的资料与界面偏好。邮箱/角色/状态/口令不在这里——邮箱是登录身份，
   * 角色是管理面的事，口令走 /me/password。
   */
  router.patch('/me', (req, res) => {
    const account = requireUser(req, db, keys)
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
    const next = Object.keys(patch).length ? db.updateAccount(account.id, patch) : account
    send(res, 200, { account: publicAccount(next) })
  })

  /**
   * 改口令。先验当前口令；改完 tokenRevokedAt 立刻作废其他 JWT，当前这次发一张新票。
   */
  router.post('/me/password', async (req, res) => {
    const account = requireUser(req, db, keys)
    const body = bodyOf(req)
    const current = strField(body, 'current')
    const next = strField(body, 'next')
    const ok = await verifyPassword(current, account.passwordHash)
    if (!ok) throw new HttpError(400, '当前口令不对')
    if (next.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    if (next === current) throw new HttpError(400, '新口令不能和当前口令相同')
    const passwordHash = await hashPassword(next)
    const now = Date.now()
    const nextAccount = db.updateAccount(account.id, {
      passwordHash,
      passwordChangedAt: now,
      tokenRevokedAt: now,
    })
    db.audit({
      companyId: account.companyId ?? 'platform',
      accountId: account.id,
      action: 'account.password',
    })
    send(res, 200, { ok: true, token: issue(keys, nextAccount) })
  })

  /**
   * Gateway 用 JWT，没有会话表。只回当前这一次，列不出也注销不了其他设备。
   */
  router.get('/me/sessions', (req, res) => {
    const account = requireUser(req, db, keys)
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

  router.get('/platform/settings', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    send(res, 200, publicSettings(db.platformSettings()))
  })

  router.put('/platform/settings', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    const cur = db.platformSettings()
    const next: PlatformSettings = {
      daily: 'daily' in body ? modelRoleOf(body.daily, 'daily') : cur.daily,
      utility: 'utility' in body ? modelRoleOf(body.utility, 'utility') : cur.utility,
      enabledModels: 'enabledModels' in body ? enabledModelsOf(body.enabledModels) : cur.enabledModels ?? [],
    }
    const saved = db.putPlatformSettings(next)
    db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.settings.update', detail: publicSettings(saved) })
    send(res, 200, publicSettings(saved))
  })

  router.get('/platform/credentials', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    send(res, 200, { credentials: db.platformCredentials().map(publicPlatformCred) })
  })

  router.post('/platform/credentials', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    const provider = strField(body, 'provider')
    const secret = strField(body, 'secret')
    const existed = !!db.platformCredential(provider)
    const row = db.upsertPlatformCredential(provider, secret)
    db.audit({
      companyId: 'platform',
      accountId: account.id,
      action: existed ? 'platform.credential.update' : 'platform.credential.create',
      detail: { provider },
    })
    send(res, existed ? 200 : 201, { credential: publicPlatformCred(row) })
  })

  router.put('/platform/credentials/:provider', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    const provider = req.params.provider
    if (!db.platformCredential(provider)) throw new HttpError(404, '密钥不存在')
    const secret = strField(bodyOf(req), 'secret')
    const row = db.upsertPlatformCredential(provider, secret)
    db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.credential.update', detail: { provider } })
    send(res, 200, { credential: publicPlatformCred(row) })
  })

  router.delete('/platform/credentials/:provider', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    const provider = req.params.provider
    if (!db.platformCredential(provider)) throw new HttpError(404, '密钥不存在')
    db.deletePlatformCredential(provider)
    db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.credential.delete', detail: { provider } })
    send(res, 200, { deleted: true, provider })
  })

  router.post('/platform/llm/test', async (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    let provider = ''
    let model = ''
    const role = body.role
    const cur = db.platformSettings()
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
        else model = llm.firstModel(null, provider)
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

  router.get('/platform/orgs', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    send(res, 200, { orgs: db.companies().map((c) => orgSummary(db, c)) })
  })

  router.get('/platform/accounts', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    const companies = new Map(db.companies().map((c) => [c.id, c]))
    send(res, 200, {
      accounts: db.accountsAll().map((a) => {
        const company = a.companyId ? companies.get(a.companyId) : undefined
        return {
          ...publicAccount(a),
          company: company ? { id: company.id, name: company.name, slug: company.slug } : null,
        }
      }),
    })
  })

  router.get('/platform/accounts/:id', (req, res) => {
    const actor = requireUser(req, db, keys)
    requireOwner(actor)
    const row = db.account(req.params.id)
    if (!row) throw new HttpError(404, '账号不存在')
    const company = row.companyId ? db.company(row.companyId) : undefined
    const secrets = row.role === 'owner' ? undefined : db.accountSecrets(row.id)
    send(res, 200, {
      account: publicAccount(row),
      company: company ? { id: company.id, name: company.name, slug: company.slug } : null,
      apiKey: secrets?.apiKey ?? null,
      accessToken: secrets?.accessToken ?? null,
    })
  })

  router.post('/platform/orgs', async (req, res) => {
    const actor = requireUser(req, db, keys)
    requireOwner(actor)
    const body = bodyOf(req)
    const name = strField(body, 'name')
    const slug = slugOf(strField(body, 'slug'))
    const seats = seatsOf(body.seats, 1)
    const adminEmail = emailOf(strField(body, 'adminEmail'))
    const adminPassword = strField(body, 'adminPassword')
    if (adminPassword.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    if (db.accountByEmail(adminEmail)) throw new HttpError(409, '这个邮箱已经注册')
    if (db.companyBySlug(slug)) throw new HttpError(409, '这个 slug 已被占用')
    const passwordHash = await hashPassword(adminPassword)
    const created = db.tx(() => {
      const company = db.insertCompany({ slug, name })
      db.upsertPlan(company.id, seats)
      const admin = db.insertAccount({ companyId: company.id, email: adminEmail, passwordHash, role: 'admin' })
      db.audit({
        companyId: company.id,
        accountId: actor.id,
        action: 'platform.org.create',
        detail: { slug, seats, adminEmail },
      })
      return { company, admin }
    })
    send(res, 201, { company: publicCompany(created.company), account: publicAccount(created.admin), plan: { seats, used: 1 } })
  })

  router.put('/platform/orgs/:id/plan', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    if (!db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const seats = seatsOf(bodyOf(req).seats)
    const used = db.accountCount(req.params.id)
    if (seats < used) throw new HttpError(409, '席位不能少于已有账号数', { seats, used })
    const plan = db.upsertPlan(req.params.id, seats)
    db.audit({ companyId: req.params.id, accountId: account.id, action: 'plan.update', detail: { seats } })
    send(res, 200, { seats: plan.seats, used, updatedAt: plan.updatedAt })
  })

  router.get('/platform/orgs/:id/machine', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const machine = companyMachineOf(db, company.id)
    send(res, 200, { machine: machine ? ownerMachine(machine) : null })
  })

  router.put('/platform/orgs/:id/machine', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const sshHost = strField(body, 'sshHost', false)
    const sshUserRaw = strField(body, 'sshUser', false)
    const sshAuthRaw = strField(body, 'sshAuth', false)
    const sshSecretRaw = body.sshSecret == null ? undefined : strField(body, 'sshSecret', false)
    const sshPortRaw = intField(body, 'sshPort')
    if (sshAuthRaw && sshAuthRaw !== 'password' && sshAuthRaw !== 'key') {
      throw new HttpError(400, 'sshAuth 只能是 password 或 key')
    }
    const cur = companyMachineOf(db, company.id)
    if (!cur && !sshHost) throw new HttpError(400, 'sshHost 不能为空')
    const sshAuth = (sshAuthRaw === 'key' || sshAuthRaw === 'password' ? sshAuthRaw : cur?.sshAuth) || 'password'
    const sshUser = sshUserRaw || cur?.sshUser || 'debian'
    const sshPort = sshPortRaw ?? cur?.sshPort ?? 22
    const host = sshHost || cur?.sshHost || ''
    const keepSecret = sshSecretRaw == null || sshSecretRaw === ''
    const machine = db.tx(() => {
      let row = cur
      if (!row) {
        row = db.insertMachine({
          companyId: company.id,
          host,
          sshHost: host,
          sshPort,
          sshUser,
          sshAuth,
          sshSecret: keepSecret ? null : sshSecretRaw,
        })
      } else {
        row = db.updateMachine(row.id, {
          host: host || row.host,
          sshHost: host,
          sshPort,
          sshUser,
          sshAuth,
          sshSecret: keepSecret ? undefined : sshSecretRaw,
        })
      }
      if (company.machineId !== row.id) {
        db.updateCompany(company.id, {
          machineId: row.id,
          accessUrl: company.accessUrl ?? accessUrlFor(company.slug),
        })
      }
      db.audit({
        companyId: company.id,
        accountId: account.id,
        action: 'machine.update',
        detail: { sshHost: host, sshPort, sshUser, sshAuth, hasSshAuth: Boolean(row.sshSecret) },
      })
      return row
    })
    send(res, 200, { machine: ownerMachine(machine) })
  })

  router.get('/platform/bot-releases', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    const releases = db.botReleases()
    send(res, 200, {
      releases: releases.map(publicBotRelease),
      latest: releases[0]?.version ?? null,
    })
  })

  router.get('/platform/bot-releases/:version', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    const row = db.botRelease(req.params.version)
    if (!row) throw new HttpError(404, '没有这个 Bot 版本')
    send(res, 200, { release: publicBotRelease(row) })
  })

  router.post('/platform/bot-releases', async (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    const version = strField(body, 'version')
    const note = strField(body, 'note', false)
    const release = await publishBotRelease(db, { version, note })
    db.audit({
      companyId: '',
      accountId: account.id,
      action: 'bot-release.publish',
      detail: { version: release.version, sha256: release.sha256, size: release.size },
    })
    send(res, 200, { release: publicBotRelease(release) })
  })

  router.get('/platform/bot-src', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    send(res, 200, botSrcVersion())
  })

  router.post('/platform/orgs/:id/runtime/update', async (req, res) => {
    const actor = requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const requested = strField(body, 'version', false)
    let version: string
    if (requested) {
      parseBotVersion(requested)
      const rel = db.botRelease(requested)
      if (!rel) throw new HttpError(404, '没有这个 Bot 版本')
      version = rel.version
    } else {
      const latest = db.latestBotRelease()
      if (!latest) throw new HttpError(409, '还没有发布 Bot 版本')
      version = latest.version
    }
    const seats = db.seatRuntimesOf(company.id).filter((r) => r.status !== 'none')
    const results: { accountId: string; botId: string; status: string; botVersion: string | null; error?: string }[] = []
    for (const seat of seats) {
      const row = db.account(seat.accountId)
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
    db.audit({
      companyId: company.id,
      accountId: actor.id,
      action: 'runtime.update',
      detail: { version, count: results.length },
    })
    send(res, 200, { version, results })
  })

  router.get('/platform/orgs/:id/accounts/:accountId/runtime', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOwner(account)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const row = db.account(req.params.accountId)
    if (!row || row.companyId !== company.id) throw new HttpError(404, '账号不存在')
    const machine = companyMachineOf(db, company.id)
    const sshHost = machine?.sshHost || ''
    const botId = (req.query.get('botId') || '').trim()
    if (botId) {
      const runtime = db.seatRuntime(row.id, botId)
      if (!runtime) throw new HttpError(404, '还没有部署')
      send(res, 200, { runtimes: [publicSeatRuntime(runtime, sshHost, { includePassword: true })] })
      return
    }
    const runtimes = db.seatRuntimesOfAccount(row.id).map((rt) => publicSeatRuntime(rt, sshHost, { includePassword: true }))
    send(res, 200, { runtimes })
  })

  // ── 公司 ────────────────────────────────────────────────────────────

  router.get('/orgs/:id', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const plan = db.plan(company.id)!
    send(res, 200, { company: publicCompany(company), plan: { seats: plan.seats, used: db.accountCount(company.id) } })
  })

  router.patch('/orgs/:id', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const patch: { name?: string; slug?: string; machineId?: string | null; accessUrl?: string | null } = {}
    if (body.name != null) patch.name = strField(body, 'name')
    if (body.accessUrl !== undefined) {
      if (body.accessUrl === null || body.accessUrl === '') patch.accessUrl = null
      else patch.accessUrl = strField(body, 'accessUrl')
    }
    if (body.slug != null) {
      patch.slug = slugOf(strField(body, 'slug'))
      if (patch.slug !== company.slug && db.companyBySlug(patch.slug)) throw new HttpError(409, '这个 slug 已被占用')
    }
    if (body.machineId !== undefined) {
      if (body.machineId === null || body.machineId === '') {
        const prev = company.machineId
        if (prev) db.updateMachine(prev, { companyId: null })
        patch.machineId = null
      } else {
        const machineId = strField(body, 'machineId')
        const machine = db.machine(machineId)
        if (!machine) throw new HttpError(404, '机器不存在')
        if (machine.companyId && machine.companyId !== company.id) throw new HttpError(409, '这台机器已经派给别的公司')
        if (company.machineId && company.machineId !== machine.id) db.updateMachine(company.machineId, { companyId: null })
        db.updateMachine(machine.id, { companyId: company.id })
        patch.machineId = machine.id
        // 派机器时写入访问地址。换机器只改解析，地址按 slug 保持。
        const slug = patch.slug ?? company.slug
        patch.accessUrl = company.accessUrl && !(body.slug != null && patch.slug !== company.slug) ? company.accessUrl : accessUrlFor(slug)
      }
    }
    if (patch.slug && patch.slug !== company.slug && (company.accessUrl || patch.machineId || company.machineId)) {
      patch.accessUrl = accessUrlFor(patch.slug)
    }
    const next = db.updateCompany(company.id, patch)
    db.audit({ companyId: company.id, accountId: account.id, action: 'org.update', detail: patch })
    send(res, 200, { company: publicCompany(next) })
  })

  router.delete('/orgs/:id', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    db.tx(() => db.deleteCompany(company.id))
    send(res, 200, { deleted: true, id: company.id })
  })

  // ── 公司模型角色（日常 / utility）。不存密钥。──────────────────────

  router.get('/orgs/:id/settings', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    if (!db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    send(res, 200, publicSettings(db.platformSettings()))
  })

  router.put('/orgs/:id/settings', (req, res) => {
    requireUser(req, db, keys)
    throw new HttpError(403, '日常和 utility 由系统管理员配置')
  })

  // ── 连通性探测。用公司密钥打一枪上游，永不回显 secret。────────────
  router.post('/orgs/:id/llm/test', async (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    if (!db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    let provider = ''
    let model = ''
    const role = body.role
    if (role === 'daily' || role === 'utility') {
      const cur = db.platformSettings()[role]
      if (!cur.provider || !cur.model) throw new HttpError(400, `${role === 'daily' ? '日常' : 'utility'} 模型还没设置`)
      provider = cur.provider
      model = cur.model
    } else {
      provider = strField(body, 'provider')
      model = strField(body, 'model', false)
      if (!model) {
        const cur = db.platformSettings()
        if (cur.daily.provider === provider && cur.daily.model) model = cur.daily.model
        else if (cur.utility.provider === provider && cur.utility.model) model = cur.utility.model
        else model = llm.firstModel(req.params.id, provider)
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

  router.get('/orgs/:id/accounts', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const plan = db.plan(company.id)
    const machine = account.role === 'owner' ? companyMachineOf(db, company.id) : undefined
    const runtimes = account.role === 'owner' ? db.seatRuntimesOf(company.id) : []
    const byAccount = new Map<string, typeof runtimes>()
    for (const rt of runtimes) {
      const list = byAccount.get(rt.accountId) || []
      list.push(rt)
      byAccount.set(rt.accountId, list)
    }
    const sshHost = machine?.sshHost?.trim() || ''
    const members = db.accountsOf(req.params.id).map((row) => {
      const pub = publicAccount(row)
      if (account.role !== 'owner') return pub
      const list = byAccount.get(row.id) || []
      return { ...pub, runtimes: list.map((rt) => listSeatRuntime(rt, sshHost)) }
    })
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
        ...db.groupsOf(company.id).map(publicGroup),
      ],
      seats: { total: plan?.seats ?? 0, used: db.accountCount(company.id) },
      me: publicAccount(account),
    })
  })

  router.post('/orgs/:id/accounts', async (req, res) => {
    const actor = requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const password = strField(body, 'password')
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    const role = roleOf(body.role, 'member')
    const name = strField(body, 'name', false)
    if (db.accountByEmail(email)) throw new HttpError(409, '这个邮箱已经注册')
    const passwordHash = await hashPassword(password)
    const created = db.tx(() => {
      const plan = db.plan(company.id)
      const used = db.accountCount(company.id)
      const seats = plan?.seats ?? 0
      if (used >= seats) throw new HttpError(409, '席位已满', { seats, used })
      const row = db.insertAccount({ companyId: company.id, email, passwordHash, role, name, status: 'active' })
      db.audit({ companyId: company.id, accountId: actor.id, action: 'account.create', detail: { id: row.id, email, role } })
      return row
    })
    send(res, 201, { account: publicAccount(created) })
  })

  /**
   * 建号并发一条邀请链接。账号当场建出来（待接受），链接只负责让本人设口令。
   * 必须写在 /accounts/:accountId 前面，否则 members 会被当成 accountId。
   */
  router.post('/orgs/:id/accounts/members', async (req, res) => {
    const actor = requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const name = strField(body, 'name', false)
    const role = roleOf(body.role, 'member')
    const days = Math.min(Math.max(Number(body.ttlDays) || 7, 1), 30)
    if (db.accountByEmail(email)) throw new HttpError(409, '这个邮箱已经注册')
    const passwordHash = await hashPassword(randomUUID())
    const created = db.tx(() => {
      const plan = db.plan(company.id)
      const used = db.accountCount(company.id)
      const seats = plan?.seats ?? 0
      if (used >= seats) throw new HttpError(409, '席位已满', { seats, used })
      const row = db.insertAccount({
        companyId: company.id,
        email,
        passwordHash,
        role,
        name,
        status: 'invited',
      })
      const invite = issueInvite(db, row, actor.id, days * 24 * 3600 * 1000)
      db.audit({
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
  router.post('/orgs/:id/accounts/groups', (req, res) => {
    const actor = requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new HttpError(400, '分组要有名字')
    const desc = typeof body.desc === 'string' ? body.desc.trim() : ''
    const icon = (typeof body.icon === 'string' && body.icon.trim()) || 'chat'
    const role = groupRoleOf(body.role)
    const members = membersInCompany(db, company.id, body.members)
    const agents = stringIds(body.agents)
    const group = db.insertGroup({ companyId: company.id, name, desc, icon, role, members, agents })
    db.audit({ companyId: company.id, accountId: actor.id, action: 'group.create', detail: { id: group.id, name } })
    send(res, 201, { group: publicGroup(group) })
  })

  router.patch('/orgs/:id/accounts/groups/:groupId', (req, res) => {
    const actor = requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    if (req.params.groupId === 'all') throw new HttpError(400, '「全体成员」是系统固定分组')
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const cur = db.group(req.params.groupId)
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
    if (Array.isArray(body.members)) patch.members = membersInCompany(db, company.id, body.members)
    if (Array.isArray(body.agents)) patch.agents = stringIds(body.agents)
    const group = db.updateGroup(cur.id, patch)
    db.audit({ companyId: company.id, accountId: actor.id, action: 'group.update', detail: { id: group.id } })
    send(res, 200, { group: publicGroup(group) })
  })

  router.delete('/orgs/:id/accounts/groups/:groupId', (req, res) => {
    const actor = requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    if (req.params.groupId === 'all') throw new HttpError(400, '「全体成员」是系统固定分组')
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const cur = db.group(req.params.groupId)
    if (!cur || cur.companyId !== company.id) throw new HttpError(404, '没有这个分组')
    db.deleteGroup(cur.id)
    db.audit({ companyId: company.id, accountId: actor.id, action: 'group.delete', detail: { id: cur.id, name: cur.name } })
    send(res, 200, { ok: true })
  })

  router.get('/orgs/:id/accounts/:accountId', (req, res) => {
    const actor = requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    send(res, 200, { account: publicAccount(row) })
  })

  router.patch('/orgs/:id/accounts/:accountId', (req, res) => {
    const actor = requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = db.account(req.params.accountId)
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
    if (losingAdmin(row, nextRole, nextStatus) && db.adminCount(row.companyId!) <= 1) {
      throw new HttpError(409, '至少要留一个管理员')
    }
    if (patch.status === 'disabled') patch.tokenRevokedAt = Date.now()
    const next = db.updateAccount(row.id, patch)
    db.audit({
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
  router.post('/orgs/:id/accounts/:accountId/reset', (req, res) => {
    const actor = requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '没有这个成员')
    db.updateAccount(row.id, { tokenRevokedAt: Date.now() })
    const ttl = row.status === 'invited' ? INVITE_TTL : RESET_LINK_TTL
    const invite = issueInvite(db, row, actor.id, ttl)
    db.audit({
      companyId: row.companyId,
      accountId: actor.id,
      action: 'account.reset',
      detail: { id: row.id, expiresAt: invite.expiresAt },
    })
    send(res, 200, { invite: { url: inviteLinkOf(req, invite.token), expiresAt: invite.expiresAt } })
  })

  router.post('/orgs/:id/accounts/:accountId/deploy', async (req, res) => {
    const actor = requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    if (row.role === 'owner') throw new HttpError(403, '系统管理员没有席位')
    const out = await deploySeat(db, keys, row, deployOptsOf(req))
    const rt = out.ok ? out.result.runtime : out.runtime
    db.audit({
      companyId: req.params.id,
      accountId: actor.id,
      action: 'runtime.deploy',
      detail: { targetAccountId: row.id, botId: rt?.botId, linuxUser: rt?.linuxUser, slot: rt?.slot, status: rt?.status },
    })
    if (!out.ok) throw new HttpError(out.status, out.error)
    send(res, 200, publicSeatRuntime(out.result.runtime, out.result.machine.sshHost || '', { includePassword: actor.role === 'owner' || actor.id === row.id }))
  })

  router.delete('/orgs/:id/accounts/:accountId', (req, res) => {
    const actor = requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    if (row.id === actor.id) throw new HttpError(400, '不能删除自己')
    if (row.role === 'admin' && row.status !== 'disabled' && row.companyId && db.adminCount(row.companyId) <= 1) {
      throw new HttpError(409, '不能删掉最后一个管理员')
    }
    db.deleteAccount(row.id)
    db.audit({ companyId: row.companyId, accountId: actor.id, action: 'account.delete', detail: { id: row.id, email: row.email } })
    send(res, 200, { deleted: true, id: row.id })
  })

  router.get('/orgs/:id/plan', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const plan = db.plan(req.params.id)
    if (!plan) throw new HttpError(404, '套餐不存在')
    send(res, 200, { seats: plan.seats, used: db.accountCount(req.params.id), updatedAt: plan.updatedAt })
  })

  /**
   * 公司账单。席位来自 db.plan，是真的。发票、充值、扣款都还没接——空列表，不编数字。
   */
  router.get('/orgs/:id/billing', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const plan = db.plan(company.id)
    if (!plan) throw new HttpError(404, '套餐不存在')
    const used = db.accountCount(company.id)
    send(res, 200, {
      plan: {
        name: '席位套餐',
        status: '生效中',
        cycle: '—',
        seats: `${plan.seats} 个席位`,
        used,
        period: '—',
        renew: '—',
        amount: '—',
        autoRenew: false,
      },
      invoices: [],
      balance: { amount: '—', spentThisMonth: '—', alertAt: '—' },
      topups: [],
    })
  })

  /**
   * 公司用量。费用没有真实账单，永远是 —，不编钱。
   * 有 llm_calls 就报真实调用次数和 token 合计；没有就 0 / —。
   * 管理员；员工走 GET /me/stats。
   */
  router.get('/orgs/:id/usage', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const range = rangeQuery(req)
    const plan = db.plan(company.id)
    const seats = plan?.seats ?? 0
    const members = db.accountsOf(company.id).filter((a) => a.role !== 'owner')
    const usage = db.llmUsageOfCompany(company.id, range)
    send(res, 200, usagePayload(usage, { seats, members, includeMembers: true }))
  })

  router.get('/me/stats', (req, res) => {
    const account = requireUser(req, db, keys)
    const range = rangeQuery(req)
    const usage = db.llmUsageOfAccount(account.id, range)
    send(res, 200, usagePayload(usage, { seats: 0, members: [account], includeMembers: false }))
  })

  router.put('/orgs/:id/plan', (req, res) => {
    requireUser(req, db, keys)
    throw new HttpError(403, '席位由系统管理员分配')
  })

  router.patch('/orgs/:id/plan', (req, res) => {
    requireUser(req, db, keys)
    throw new HttpError(403, '席位由系统管理员分配')
  })

  // ── 机器 / 访问地址 ─────────────────────────────────────────────────

  router.get('/orgs/:id/machine', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const machine = company.machineId ? db.machine(company.machineId) : companyMachineOf(db, company.id)
    send(res, 200, { machine: machine ? publicMachine(machine) : null, accessUrl: company.accessUrl })
  })

  router.post('/orgs/:id/machine', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const host = body.host != null ? strField(body, 'host', false) || null : null
    const id = body.id != null ? strField(body, 'id', false) || undefined : undefined
    const existing = id ? db.machine(id) : undefined
    if (existing && existing.companyId && existing.companyId !== company.id) {
      throw new HttpError(409, '这台机器已经派给别的公司')
    }
    const { machine, next } = db.tx(() => {
      if (company.machineId && company.machineId !== existing?.id) db.updateMachine(company.machineId, { companyId: null })
      const machine = existing
        ? db.updateMachine(existing.id, { companyId: company.id, host: host ?? existing.host })
        : db.insertMachine({ id, host, companyId: company.id })
      const accessUrl = company.accessUrl ?? accessUrlFor(company.slug)
      const next = db.updateCompany(company.id, { machineId: machine.id, accessUrl })
      db.audit({ companyId: company.id, accountId: account.id, action: 'machine.assign', detail: { machineId: machine.id, accessUrl } })
      return { machine, next }
    })
    send(res, 201, { machine: publicMachine(machine), company: publicCompany(next) })
  })

  // ── 可见目录（全局 ∪ 本公司）────────────────────────────────────────

  for (const name of Object.keys(KIND)) {
    router.get(`/catalog/${name}`, (req, res) => {
      const account = requireUser(req, db, keys)
      send(res, 200, { items: db.visibleCatalog(kindOf(name), account.companyId).map(publicCatalog) })
    })
    router.post(`/catalog/${name}`, (req, res) => {
      requirePlatformToken(req)
      const body = bodyOf(req)
      const item = db.insertCatalog({
        kind: kindOf(name),
        scope: 'global',
        companyId: null,
        name: strField(body, 'name'),
        definition: body.definition ?? {},
      })
      send(res, 201, { item: publicCatalog(item) })
    })
    router.patch(`/catalog/${name}/:itemId`, (req, res) => {
      requirePlatformToken(req)
      const item = db.catalog(req.params.itemId)
      if (!item || item.kind !== kindOf(name) || item.scope !== 'global') throw new HttpError(404, '目录项不存在')
      const body = bodyOf(req)
      const next = db.updateCatalog(item.id, {
        name: body.name != null ? strField(body, 'name') : undefined,
        definition: body.definition,
      })
      send(res, 200, { item: publicCatalog(next) })
    })
    router.delete(`/catalog/${name}/:itemId`, (req, res) => {
      requirePlatformToken(req)
      const item = db.catalog(req.params.itemId)
      if (!item || item.kind !== kindOf(name) || item.scope !== 'global') throw new HttpError(404, '目录项不存在')
      db.deleteCatalog(item.id)
      send(res, 200, { deleted: true, id: item.id })
    })
  }

  /**
   * 实例拉目录。MCP token 只出现在这里，不出现在 /catalog/mcp。
   */
  router.get('/runtime/catalog', (req, res) => {
    const account = requireSeatOrUser(req, db, keys)
    const companyId = account.role === 'owner' ? null : account.companyId
    const botId = (req.query.get('botId') || '').trim()
    let bots = db.visibleCatalog('bot', companyId)
    if (botId) {
      const hit = bots.find((b) => b.id === botId)
      if (!hit) throw new HttpError(404, '没有这个 Bot')
      bots = [hit]
    }
    send(res, 200, {
      bots: bots.map(publicBot),
      skills: db.visibleCatalog('skill', companyId).map(publicSkill),
      servers: db.visibleCatalog('mcp', companyId).map(runtimeServer),
    })
  })

  router.get('/runtime/desktop', (req, res) => {
    const account = requireUser(req, db, keys)
    requireSeat(account)
    const botId = (req.query.get('botId') || '').trim()
    if (!botId) throw new HttpError(400, 'botId 不能为空')
    const runtime = db.seatRuntime(account.id, botId)
    if (!runtime) throw new HttpError(404, '还没有部署')
    const machine = companyMachineOf(db, account.companyId!)
    send(res, 200, publicSeatRuntime(runtime, machine?.sshHost || '', { includePassword: true }))
  })

  router.post('/runtime/deploy', async (req, res) => {
    const account = requireUser(req, db, keys)
    requireSeat(account)
    const out = await deploySeat(db, keys, account, deployOptsOf(req))
    if (!out.ok) throw new HttpError(out.status, out.error)
    db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'runtime.deploy',
      detail: {
        botId: out.result.runtime.botId,
        linuxUser: out.result.runtime.linuxUser,
        slot: out.result.runtime.slot,
        status: out.result.runtime.status,
      },
    })
    send(res, 200, publicSeatRuntime(out.result.runtime, out.result.machine.sshHost || '', { includePassword: true }))
  })

  // ── 对话。名册走 Gateway 目录；会话才反代到该 pair 的实例。────────

  router.get('/runtime/bots', (req, res) => {
    const account = requireUser(req, db, keys)
    requireSeat(account)
    const bots = db.visibleCatalog('bot', account.companyId).map((item) => ({
      ...publicBot(item),
      runtime: pairRuntime(db, account, item.id),
    }))
    send(res, 200, { bots })
  })

  router.get('/runtime/bots/:id/session', async (req, res) => {
    const account = requireUser(req, db, keys)
    const bot = visibleBotOf(db, account, req.params.id)
    const host = instanceHostFor(account, db, bot.id)
    const url = `${host}/api/bots/${encodeURIComponent(bot.id)}/session`
    const bearerTok = seatBearer(db, account.id)
    let r: Response
    try {
      r = await fetch(url, {
        headers: { authorization: bearerTok ? `Bearer ${bearerTok}` : '', accept: 'application/json' },
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
        db.upsertSessionIndex({
          sessionId,
          companyId: account.companyId,
          accountId: account.id,
          botId: bot.id,
        })
      }
    }
    send(res, r.status, parsed)
  })

  router.get('/runtime/bots/:id', (req, res) => {
    const account = requireUser(req, db, keys)
    const bot = visibleBotOf(db, account, req.params.id)
    send(res, 200, { bot: { ...publicBot(bot), runtime: pairRuntime(db, account, bot.id) } })
  })

  router.get('/runtime/sessions/:id/events', async (req, res) => {
    const account = requireUser(req, db, keys)
    const host = instanceHostForSession(account, db, req.params.id)
    const after = req.query.get('after')
    const q = after != null && after !== '' ? `?after=${encodeURIComponent(after)}` : ''
    await proxySse(req, res, `${host}/api/sessions/${encodeURIComponent(req.params.id)}/events${q}`, seatBearer(db, account.id))
  })

  router.post('/runtime/sessions/:id/messages', async (req, res) => {
    const account = requireUser(req, db, keys)
    const host = instanceHostForSession(account, db, req.params.id)
    const body = bodyOf(req)
    const text = strField(body, 'text')
    await proxyJson(res, 'POST', `${host}/api/sessions/${encodeURIComponent(req.params.id)}/messages`, { text }, seatBearer(db, account.id))
  })

  router.post('/runtime/sessions/:id/abort', async (req, res) => {
    const account = requireUser(req, db, keys)
    const host = instanceHostForSession(account, db, req.params.id)
    await proxyJson(res, 'POST', `${host}/api/sessions/${encodeURIComponent(req.params.id)}/abort`, {}, seatBearer(db, account.id))
  })

  // ── 公司 Bot。形状跟 Bot 运行时一致：{ bots } / { bot }。────────────

  router.get('/orgs/:id/bots', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    send(res, 200, { bots: db.companyCatalog('bot', req.params.id).map(publicBot) })
  })

  // 必须写在 /bots/:botId 前面，否则 options 会被当成 botId。
  router.get('/orgs/:id/bots/options', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const orgId = req.params.id
    send(res, 200, {
      skills: db.companyCatalog('skill', orgId).map((i) => ({ id: i.id, name: i.name })),
      mcps: db.companyCatalog('mcp', orgId).map((i) => ({ id: i.id, name: i.name })),
      groups: db.groupsOf(orgId).map((g) => ({ id: g.id, name: g.name })),
      kbs: [] as { id: string; name: string }[],
    })
  })

  router.post('/orgs/:id/bots', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    if (!db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const name = botNameOf(body.name)
    const fallback = defaultBotModel(db)
    const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : fallback.provider
    const model = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : fallback.model
    const prompt = typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : DEFAULT_BOT_PROMPT
    const description = typeof body.description === 'string' ? body.description.trim() : ''
    const item = db.insertCatalog({
      kind: 'bot',
      scope: 'company',
      companyId: req.params.id,
      name,
      definition: {
        description,
        prompt,
        icon: botIconOf(body.icon),
        provider,
        model,
        enabled: true,
        skills: assignedIds(db, req.params.id, 'skill', body.skills),
        mcps: assignedIds(db, req.params.id, 'mcp', body.mcps),
      },
    })
    db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.create', detail: { kind: 'bot', id: item.id } })
    send(res, 201, { bot: publicBot(item) })
  })

  router.get('/orgs/:id/bots/:botId', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    send(res, 200, { bot: publicBot(requireCompanyBot(db, req.params.id, req.params.botId)) })
  })

  router.patch('/orgs/:id/bots/:botId', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const item = requireCompanyBot(db, req.params.id, req.params.botId)
    const body = bodyOf(req)
    const def = botDefOf(item.definition)
    let name: string | undefined
    if (body.name !== undefined) name = botNameOf(body.name)
    if (body.description !== undefined) def.description = String(body.description).trim()
    if (body.prompt !== undefined) def.prompt = String(body.prompt).trim()
    if (typeof body.icon === 'string' && BOT_ICONS.has(body.icon)) def.icon = body.icon
    if (body.model !== undefined) def.model = String(body.model).trim() || DEFAULT_BOT_MODEL
    if (body.provider !== undefined) def.provider = String(body.provider).trim() || DEFAULT_BOT_PROVIDER
    if (typeof body.enabled === 'boolean') def.enabled = body.enabled
    if (Array.isArray(body.skills)) def.skills = assignedIds(db, req.params.id, 'skill', body.skills)
    if (Array.isArray(body.mcps)) def.mcps = assignedIds(db, req.params.id, 'mcp', body.mcps)
    const next = db.updateCatalog(item.id, { name, definition: def })
    db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.update', detail: { kind: 'bot', id: item.id } })
    send(res, 200, { bot: publicBot(next) })
  })

  router.delete('/orgs/:id/bots/:botId', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const item = requireCompanyBot(db, req.params.id, req.params.botId)
    db.deleteCatalog(item.id)
    db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.delete', detail: { kind: 'bot', id: item.id } })
    send(res, 200, { deleted: true, id: item.id })
  })


  // ── 公司 Skill / MCP。形状跟 Bot 运行时一致；执行与连接都还没接。──

  router.get('/orgs/:id/skills', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const orgId = req.params.id
    send(res, 200, {
      skills: db.companyCatalog('skill', orgId).map(publicSkill),
      servers: db.companyCatalog('mcp', orgId).map(publicServer),
      tags: knownTags(db, orgId),
    })
  })

  router.post('/orgs/:id/skills', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    if (!db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const b = bodyOf(req)
    const name = namedOf(b.name)
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
    const item = db.insertCatalog({
      kind: 'skill',
      scope: 'company',
      companyId: req.params.id,
      name,
      definition,
    })
    rememberTags(db, req.params.id, tags)
    db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.create', detail: { kind: 'skill', id: item.id } })
    send(res, 201, { skill: publicSkill(item) })
  })

  router.post('/orgs/:id/skills/tags', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    if (!db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const tag = namedOf(bodyOf(req).name)
    if (tag.length > 12) throw new HttpError(400, '标签最多 12 个字')
    knownTags(db, req.params.id)
    db.insertSkillTag(req.params.id, tag)
    send(res, 200, { tags: knownTags(db, req.params.id) })
  })

  router.delete('/orgs/:id/skills/tags/:name', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const orgId = req.params.id
    const tag = req.params.name
    db.deleteSkillTag(orgId, tag)
    let touched = 0
    for (const item of db.companyCatalog('skill', orgId)) {
      const def = asDef(item.definition)
      const tags = Array.isArray(def.tags) ? def.tags.map((x) => String(x)) : []
      if (!tags.includes(tag)) continue
      def.tags = tags.filter((x) => x !== tag)
      def.updatedAt = Date.now()
      db.updateCatalog(item.id, { definition: def })
      touched++
    }
    send(res, 200, { tags: knownTags(db, orgId), touched })
  })

  router.get('/orgs/:id/skills/:skillId', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    send(res, 200, { skill: publicSkill(requireCompanySkill(db, req.params.id, req.params.skillId)) })
  })

  router.patch('/orgs/:id/skills/:skillId', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const item = requireCompanySkill(db, req.params.id, req.params.skillId)
    const b = bodyOf(req)
    const def = asDef(item.definition)
    let name: string | undefined
    if (b.name !== undefined) name = namedOf(b.name)
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
    const next = db.updateCatalog(item.id, { name, definition: def })
    if (Array.isArray(def.tags)) rememberTags(db, req.params.id, def.tags.map((x) => String(x)))
    db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.update', detail: { kind: 'skill', id: item.id } })
    send(res, 200, { skill: publicSkill(next) })
  })

  router.delete('/orgs/:id/skills/:skillId', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const item = requireCompanySkill(db, req.params.id, req.params.skillId)
    db.deleteCatalog(item.id)
    db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.delete', detail: { kind: 'skill', id: item.id } })
    send(res, 200, { deleted: true, id: item.id })
  })

  router.get('/orgs/:id/mcp-servers', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    send(res, 200, { servers: db.companyCatalog('mcp', req.params.id).map(publicServer) })
  })

  router.post('/orgs/:id/mcp-servers', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    if (!db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const b = bodyOf(req)
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
    const item = db.insertCatalog({
      kind: 'mcp',
      scope: 'company',
      companyId: req.params.id,
      name: namedOf(b.name),
      definition,
    })
    db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.create', detail: { kind: 'mcp', id: item.id } })
    send(res, 201, { server: publicServer(item) })
  })

  router.get('/orgs/:id/mcp-servers/:serverId', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    send(res, 200, { server: publicServer(requireCompanyMcp(db, req.params.id, req.params.serverId)) })
  })

  router.patch('/orgs/:id/mcp-servers/:serverId', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const item = requireCompanyMcp(db, req.params.id, req.params.serverId)
    const b = bodyOf(req)
    const def = asDef(item.definition)
    let name: string | undefined
    if (b.name !== undefined) name = namedOf(b.name)
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
    const next = db.updateCatalog(item.id, { name, definition: def })
    db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.update', detail: { kind: 'mcp', id: item.id } })
    send(res, 200, { server: publicServer(next) })
  })

  router.delete('/orgs/:id/mcp-servers/:serverId', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const item = requireCompanyMcp(db, req.params.id, req.params.serverId)
    db.deleteCatalog(item.id)
    db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.delete', detail: { kind: 'mcp', id: item.id } })
    send(res, 200, { deleted: true, id: item.id })
  })

  // ── 公司目录（admin）。bots 走上面那组，形状不同。────────────────

  for (const name of ['models'] as const) {
    const kind = kindOf(name)
    router.get(`/orgs/:id/${name}`, (req, res) => {
      const account = requireUser(req, db, keys)
      requireOrg(account, req.params.id)
      send(res, 200, { items: db.companyCatalog(kind, req.params.id).map(publicCatalog) })
    })
    router.post(`/orgs/:id/${name}`, (req, res) => {
      const account = requireUser(req, db, keys)
      requireOrg(account, req.params.id, true)
      if (!db.company(req.params.id)) throw new HttpError(404, '公司不存在')
      const body = bodyOf(req)
      const item = db.insertCatalog({
        kind,
        scope: 'company',
        companyId: req.params.id,
        name: strField(body, 'name'),
        definition: body.definition ?? {},
      })
      db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.create', detail: { kind, id: item.id } })
      send(res, 201, { item: publicCatalog(item) })
    })
    router.get(`/orgs/:id/${name}/:itemId`, (req, res) => {
      const account = requireUser(req, db, keys)
      requireOrg(account, req.params.id)
      const item = db.catalog(req.params.itemId)
      if (!item || item.kind !== kind || item.companyId !== req.params.id) throw new HttpError(404, '目录项不存在')
      send(res, 200, { item: publicCatalog(item) })
    })
    router.patch(`/orgs/:id/${name}/:itemId`, (req, res) => {
      const account = requireUser(req, db, keys)
      requireOrg(account, req.params.id, true)
      const item = db.catalog(req.params.itemId)
      if (!item || item.kind !== kind || item.companyId !== req.params.id) throw new HttpError(404, '目录项不存在')
      const body = bodyOf(req)
      const next = db.updateCatalog(item.id, {
        name: body.name != null ? strField(body, 'name') : undefined,
        definition: body.definition,
      })
      db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.update', detail: { kind, id: item.id } })
      send(res, 200, { item: publicCatalog(next) })
    })
    router.delete(`/orgs/:id/${name}/:itemId`, (req, res) => {
      const account = requireUser(req, db, keys)
      requireOrg(account, req.params.id, true)
      const item = db.catalog(req.params.itemId)
      if (!item || item.kind !== kind || item.companyId !== req.params.id) throw new HttpError(404, '目录项不存在')
      db.deleteCatalog(item.id)
      db.audit({ companyId: req.params.id, accountId: account.id, action: 'catalog.delete', detail: { kind, id: item.id } })
      send(res, 200, { deleted: true, id: item.id })
    })
  }

  // ── 公司密钥。列表/详情只回 configured: true ────────────────────────

  router.get('/orgs/:id/credentials', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    send(res, 200, { credentials: db.platformCredentials().map(publicPlatformCred) })
  })

  router.post('/orgs/:id/credentials', (req, res) => {
    requireUser(req, db, keys)
    throw new HttpError(403, '供应商由系统管理员配置')
  })

  router.get('/orgs/:id/credentials/:credId', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const provider = req.params.credId.startsWith('platform:') ? req.params.credId.slice('platform:'.length) : req.params.credId
    const row = db.platformCredential(provider)
    if (!row) throw new HttpError(404, '密钥不存在')
    send(res, 200, { credential: publicPlatformCred(row) })
  })

  router.put('/orgs/:id/credentials/:credId', (req, res) => {
    requireUser(req, db, keys)
    throw new HttpError(403, '供应商由系统管理员配置')
  })

  router.delete('/orgs/:id/credentials/:credId', (req, res) => {
    requireUser(req, db, keys)
    throw new HttpError(403, '供应商由系统管理员配置')
  })

  // ── 会话索引 / 按需拉全文。Gateway 只存指针，正文留在机器上。────────

  router.get('/orgs/:id/sessions', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const accountId = (req.query.get('accountId') || '').trim()
    const botId = (req.query.get('botId') || '').trim()
    const range = rangeQuery(req)
    const rows = db.listSessionIndex(company.id, {
      accountId: accountId || undefined,
      botId: botId || undefined,
      from: range.from,
      to: range.to,
    })
    send(res, 200, { sessions: rows.map((row) => publicSessionIndex(db, row)) })
  })

  router.get('/orgs/:id/sessions/:sessionId', async (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const row = db.sessionIndex(req.params.sessionId)
    if (!row || row.companyId !== company.id) throw new HttpError(404, '会话不存在')
    const session = publicSessionIndex(db, row)
    db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'session.pull',
      detail: { sessionId: row.sessionId },
    })
    const machineId = row.machineId || company.machineId
    const machine = machineId ? db.machine(machineId) : companyMachineOf(db, company.id)
    const instance = row.botId ? db.instance(row.accountId, row.botId) : undefined
    const host = (instance?.host || machine?.host || '').trim()
    const pullTok = machine?.token || ''
    if (!host) {
      send(res, 200, { session, events: null, pullError: PULL_ERROR })
      return
    }
    const pulled = await pullSessionEvents(host, row.sessionId, pullTok)
    if (!pulled.ok) {
      send(res, 200, { session, events: null, pullError: PULL_ERROR })
      return
    }
    send(res, 200, { session, events: pulled.events })
  })

  router.get('/orgs/:id/audit', (req, res) => {
    const account = requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    send(res, 200, {
      events: db.auditsOf(req.params.id).map((e) => ({
        id: e.id,
        accountId: e.accountId,
        action: e.action,
        detail: e.detail,
        createdAt: e.createdAt,
      })),
    })
  })

  // ── 机器服务凭证。登记用引导票；心跳 / ready / 索引 / 用量用每台机器的 smt_。──

  router.post('/internal/machines', (req, res) => {
    requireBootstrapMachine(req)
    const body = bodyOf(req)
    const id = body.id != null ? strField(body, 'id', false) || undefined : undefined
    const host = body.host != null ? strField(body, 'host', false) || null : null
    if (id && db.machine(id)) throw new HttpError(409, '这台机器已经登记')
    const machine = db.insertMachine({ id, host })
    send(res, 201, { machine: { ...publicMachine(machine), token: machine.token } })
  })

  router.post('/internal/machines/:id/heartbeat', (req, res) => {
    const machine = requireMachine(req, db)
    if (machine.id !== req.params.id) throw new HttpError(403, '机器凭证与路径不符')
    const next = db.updateMachine(machine.id, { lastHeartbeatAt: Date.now() })
    send(res, 200, { machine: { id: next.id, lastHeartbeatAt: next.lastHeartbeatAt } })
  })

  router.post('/internal/instances/:accountId/ready', (req, res) => {
    const machine = requireMachine(req, db)
    const account = db.account(req.params.accountId)
    if (!account) throw new HttpError(404, '账号不存在')
    if (!account.companyId) throw new HttpError(403, '没有公司席位')
    if (!machine.companyId || machine.companyId !== account.companyId) throw new HttpError(403, '机器不属于这家公司')
    const body = bodyOf(req)
    const botId = strField(body, 'botId')
    const host = instanceHostOf(strField(body, 'host'))
    if (!db.seatRuntime(account.id, botId)) throw new HttpError(404, '还没有部署')
    const instance = db.upsertInstance({
      accountId: account.id,
      botId,
      companyId: account.companyId,
      host,
    })
    send(res, 200, { instance })
  })

  router.post('/internal/sessions/index', (req, res) => {
    const machine = requireMachine(req, db)
    if (!machine.companyId) throw new HttpError(403, '机器还没有派给公司')
    const companyId = machine.companyId
    const body = bodyOf(req)
    const sessionId = strField(body, 'sessionId')
    const accountId = strField(body, 'accountId')
    const bodyCompany = strField(body, 'companyId', false)
    if (bodyCompany && bodyCompany !== companyId) throw new HttpError(403, '机器不属于这家公司')
    const account = db.account(accountId)
    if (!account || account.companyId !== companyId) throw new HttpError(403, '账号不属于这家公司')
    const botIdRaw = body.botId == null ? undefined : strField(body, 'botId', false)
    const machineIdRaw = body.machineId == null ? undefined : strField(body, 'machineId', false)
    const titleRaw = body.title == null ? undefined : strField(body, 'title', false)
    const originRaw = body.origin == null ? undefined : strField(body, 'origin', false)
    const remoteIdRaw = body.remoteId == null ? undefined : strField(body, 'remoteId', false)
    const session = db.upsertSessionIndex({
      sessionId,
      companyId,
      accountId,
      botId: botIdRaw === undefined ? undefined : botIdRaw || null,
      machineId: machineIdRaw === undefined ? machine.id : machineIdRaw || machine.id,
      origin: originRaw === undefined ? undefined : originRaw || null,
      remoteId: remoteIdRaw === undefined ? undefined : remoteIdRaw || null,
      messageCount: intField(body, 'messageCount'),
      title: titleRaw === undefined ? undefined : titleRaw || null,
      createdAt: intField(body, 'createdAt'),
      updatedAt: intField(body, 'updatedAt'),
    })
    send(res, 200, { session })
  })

  router.post('/internal/usage', (req, res) => {
    const machine = requireMachine(req, db)
    if (!machine.companyId) throw new HttpError(403, '机器还没有派给公司')
    const body = bodyOf(req)
    const accountId = strField(body, 'accountId')
    const account = db.account(accountId)
    if (!account || account.companyId !== machine.companyId) throw new HttpError(403, '账号不属于这家公司')
    const provider = strField(body, 'provider')
    const model = strField(body, 'model')
    const promptTokens = tokenCount(body.promptTokens, 'promptTokens')
    const completionTokens = tokenCount(body.completionTokens, 'completionTokens')
    db.insertLlmCall({
      accountId: account.id,
      companyId: account.companyId,
      provider,
      model,
      promptTokens,
      completionTokens,
    })
    send(res, 200, { ok: true })
  })
}
