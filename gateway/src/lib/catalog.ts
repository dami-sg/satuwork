/**
 * 目录项：Bot / Skill / MCP 的定义、校验与对外序列化。
 *
 * 从 routes.ts 拆出来的——那个文件曾经是 5700 行，前 1900 行全是这类帮手。
 */
import { HttpError } from '../http.ts'
import { type CatalogItem, type Credential, type Db, type Scope } from '../db.ts'

export function publicCatalog(item: { id: string; kind: string; scope: string; companyId: string | null; name: string; definition: unknown; createdAt: number; updatedAt: number }) {
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
export const COMPANY_BOT_ICONS = ['c-bot', 'c-chat', 'c-chart', 'c-pen', 'c-deal', 'c-code', 'c-flow', 'c-book'] as const
export const GLOBAL_BOT_ICONS = ['g-core', 'g-relay', 'g-shield', 'g-globe', 'g-spark', 'g-grid', 'g-beacon', 'g-vault'] as const

export const COMPANY_ICON_SET: ReadonlySet<string> = new Set(COMPANY_BOT_ICONS)
export const GLOBAL_ICON_SET: ReadonlySet<string> = new Set(GLOBAL_BOT_ICONS)

/** 改版前存下来的那六个键。老 Bot 打开时按这张表落到新的一套上，不让它们变成默认头像。 */
export const LEGACY_BOT_ICONS: Record<string, string> = {
  bot: 'c-bot',
  chat: 'c-chat',
  chart: 'c-chart',
  pen: 'c-pen',
  deal: 'c-deal',
  code: 'c-code',
}

export function iconSetFor(scope: Scope): ReadonlySet<string> {
  return scope === 'global' ? GLOBAL_ICON_SET : COMPANY_ICON_SET
}

export function defaultIconFor(scope: Scope): string {
  return scope === 'global' ? 'g-core' : 'c-bot'
}
export const DEFAULT_BOT_PROMPT =
  '你是 Satuwork 的 AI 员工。用简洁、专业的中文回答。需要当前时间、查看或修改文件、执行命令时调用工具，不要凭猜测。'
export const DEFAULT_BOT_PROVIDER = 'deepseek'
export const DEFAULT_BOT_MODEL = 'deepseek-v4-flash'

export function botDefOf(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) }
  return {}
}

/**
 * 归一化头像键。不认识的、或者不属于这个层级的，一律落到该层级的默认头像——
 * 宁可显示成默认，也不能让公司 Bot 顶着全局那套图标。
 */
export function botIconOf(v: unknown, scope: Scope = 'company'): string {
  const raw = typeof v === 'string' ? v.trim() : ''
  const key = LEGACY_BOT_ICONS[raw] ?? raw
  return iconSetFor(scope).has(key) ? key : defaultIconFor(scope)
}

export function botNameOf(v: unknown): string {
  const name = typeof v === 'string' ? v.trim() : ''
  if (!name) throw new HttpError(400, '助理要有名字')
  return name
}

/**
 * 行为边界。服务端只存开关，标题和说明留在前端——那两行是要跟着界面语言走的文案，
 * 存进库里就等于把中文钉死在数据上，改一次文案还得迁一次数据。
 */
export const BOT_GUARD_IDS = ['high-risk', 'pii', 'no-external'] as const
export const DEFAULT_BOT_GUARDS: Record<string, boolean> = { 'high-risk': true, pii: true, 'no-external': true }

/**
 * 记忆设置。scope / kinds / ttl 存的就是这几个中文原串——它们同时是界面上的选项值，
 * 前端只翻显示的那一份（见 app.js 里 MEMORY_* 那几个常量），两边对的是同一套键。
 */
export const MEMORY_SCOPES = ['仅本人', '所属分组', '全公司']
export const MEMORY_KINDS = ['偏好', '事实', '流程', '联系人']
export const MEMORY_TTLS = ['30 天', '90 天', '180 天', '永久保留']

export interface BotMemory {
  on: boolean
  scope: string
  kinds: string[]
  ttl: string
  cap: number
  confirm: boolean
  pii: boolean
}

export const DEFAULT_BOT_MEMORY: BotMemory = {
  on: true,
  scope: '所属分组',
  kinds: ['偏好', '事实'],
  ttl: '90 天',
  cap: 20,
  confirm: true,
  pii: true,
}

export function objOf(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** 只认识这三个开关，其余键丢掉；没传的沿用 base，所以改一个不会把另外两个带回默认。 */
export function botGuardsOf(v: unknown, base: Record<string, boolean> = DEFAULT_BOT_GUARDS): Record<string, boolean> {
  const raw = objOf(v)
  const out: Record<string, boolean> = {}
  for (const id of BOT_GUARD_IDS) out[id] = typeof raw[id] === 'boolean' ? (raw[id] as boolean) : base[id] !== false
  return out
}

/** 不认识的选项一律退回 base，不报错——界面上那几个下拉本来就只给得出合法值。 */
export function botMemoryOf(v: unknown, base: BotMemory = DEFAULT_BOT_MEMORY): BotMemory {
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
export async function defaultBotModel(db: Db): Promise<{ provider: string; model: string }> {
  const s = await db.platformSettings()
  if (s.daily.provider && s.daily.model) return { provider: s.daily.provider, model: s.daily.model }
  if (s.utility.provider && s.utility.model) return { provider: s.utility.provider, model: s.utility.model }
  return { provider: DEFAULT_BOT_PROVIDER, model: DEFAULT_BOT_MODEL }
}

export function idList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()))]
}

/**
 * 目录项的归属。全局项 companyId 为 null、审计记在 platform 名下；公司项记在自己名下。
 *
 * 建 / 改的那套逻辑对两种归属是同一份，差别全收在这个对象里——不然平台侧要把
 * 公司侧那两百来行校验再抄一遍，抄完两边就开始各自漂移。
 */
export interface CatalogOwner {
  scope: Scope
  companyId: string | null
  /** 审计和 skill 标签按这个键存。全局项没有公司，用 'platform'。 */
  auditCompanyId: string
}

export const GLOBAL_OWNER: CatalogOwner = { scope: 'global', companyId: null, auditCompanyId: 'platform' }

export function companyOwner(id: string): CatalogOwner {
  return { scope: 'company', companyId: id, auditCompanyId: id }
}

/**
 * 只收下这个归属看得见的 id，不认识的直接丢掉。
 *
 * 公司 Bot 能挂全局 Skill/MCP（visibleCatalog 是「全局 ∪ 本公司」），全局 Bot 只能挂
 * 全局的——挂了某家公司的东西，别的公司跑起来就找不到。
 */
export async function assignedIds(db: Db, owner: CatalogOwner, kind: 'skill' | 'mcp', v: unknown): Promise<string[]> {
  if (!Array.isArray(v)) return []
  const known = new Set((await db.visibleCatalog(kind, owner.companyId)).map((i) => i.id))
  return idList(v).filter((id) => known.has(id))
}

/**
 * 公司的 **Bot 模版**：全公司所有 Bot 共用的那一份底座。
 *
 * 公司这一层不再是「一批共享的 Bot」，而是这一份配置——员工自己建的每个 Bot 都长在
 * 它上面。所以这里只有底座该有的东西（提示词、行为边界、记忆策略、挂哪些 Skill/MCP），
 * 没有名字和头像：那是每个 Bot 自己的身份，不是公司统一的口径。
 */
export interface BotTemplate {
  /**
   * 版本号。每保存一次 +1，**不是时间戳**。
   *
   * 它是「跟没跟上」的唯一判据：席位实例拿着自己那一版去问 Gateway，数字对不上就
   * 重新拉一遍目录。用 updatedAt 也能比，但那样时钟一歪（机器时区、库恢复）就会
   * 出现「新的比旧的还早」，而一个只增的整数不会。
   */
  version: number
  prompt: string
  escalate: string
  guards: Record<string, boolean>
  memory: BotMemory
  skills: string[]
  mcps: string[]
  updatedAt: number
}

export const BOT_TEMPLATE_NAME = 'Bot 模版'
/** 追加提示词的上限。够写一段岗位说明，又不至于让谁把整本手册塞进去。 */
export const MAX_EXTRA_PROMPT = 4000

export function defaultBotTemplate(now = Date.now()): BotTemplate {
  return {
    version: 1,
    prompt: DEFAULT_BOT_PROMPT,
    escalate: '',
    guards: { ...DEFAULT_BOT_GUARDS },
    memory: { ...DEFAULT_BOT_MEMORY, kinds: [...DEFAULT_BOT_MEMORY.kinds] },
    skills: [],
    mcps: [],
    updatedAt: now,
  }
}

/** 库里那一行读成模版。没有这一行（新公司还没人打开过）就是出厂默认。 */
export function botTemplateOf(item: CatalogItem | undefined): BotTemplate {
  const base = defaultBotTemplate(item?.updatedAt ?? Date.now())
  if (!item) return base
  const def = objOf(item.definition)
  const version = Number(def.version)
  return {
    version: Number.isFinite(version) && version >= 1 ? Math.trunc(version) : 1,
    prompt: typeof def.prompt === 'string' && def.prompt.trim() ? def.prompt : base.prompt,
    escalate: typeof def.escalate === 'string' ? def.escalate : '',
    guards: botGuardsOf(def.guards),
    memory: botMemoryOf(def.memory),
    skills: idList(def.skills),
    mcps: idList(def.mcps),
    updatedAt: typeof def.updatedAt === 'number' ? def.updatedAt : item.updatedAt,
  }
}

/** 对外的模版。模型那一对跟 Bot 一样由平台钉，列在这里只是让人看见用的是哪一个。 */
export function publicTemplate(tpl: BotTemplate, pinned: { provider: string; model: string }) {
  return { ...tpl, provider: pinned.provider, model: pinned.model }
}

/**
 * 这家公司的模版行。没有就现建一份出厂默认的。
 *
 * 懒创建而不是在建公司时插一行：0003 只管得了迁移那一刻**已经存在**的公司，之后新建
 * 的公司还是得有人补上这一份。补在读的时候，建公司那条路径就不必知道模版这回事。
 *
 * 并发下两个请求可能同时插——`catalog_one_template` 那条唯一索引会让后到的那个失败，
 * 这时重查一次即可（对方刚插好的就是我们要的）。
 */
export async function ensureBotTemplate(db: Db, companyId: string): Promise<CatalogItem> {
  const hit = await db.botTemplate(companyId)
  if (hit) return hit
  try {
    return await db.insertCatalog({
      kind: 'bot-template',
      scope: 'company',
      companyId,
      name: BOT_TEMPLATE_NAME,
      definition: defaultBotTemplate(),
    })
  } catch {
    const again = await db.botTemplate(companyId)
    if (!again) throw new HttpError(500, '模版创建失败')
    return again
  }
}

/**
 * 读这家公司「合成一个 Bot 要用到的东西」：平台钉的模型 + 模版。
 *
 * 名册一次要合成十来个 Bot，每个都各读一遍设置和模版毫无意义——调用方取一次，
 * 整批共用。
 */
export async function botContext(db: Db, companyId: string | null): Promise<{ pinned: { provider: string; model: string }; tpl: BotTemplate }> {
  const pinned = await defaultBotModel(db)
  if (!companyId) return { pinned, tpl: defaultBotTemplate() }
  return { pinned, tpl: botTemplateOf(await db.botTemplate(companyId)) }
}

/**
 * 收下一次模版改动，**版本号 +1**。
 *
 * 没传的字段沿用原值（PUT 但按 patch 收），传了空提示词也退回原值——底座不能是空的，
 * 那等于全公司的 Bot 一起失去人设。
 */
export async function applyTemplatePatch(db: Db, companyId: string, cur: BotTemplate, body: Record<string, unknown>): Promise<BotTemplate> {
  const owner = companyOwner(companyId)
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  return {
    version: cur.version + 1,
    prompt: prompt || cur.prompt,
    escalate: body.escalate !== undefined ? String(body.escalate).trim() : cur.escalate,
    guards: body.guards !== undefined ? botGuardsOf(body.guards, cur.guards) : cur.guards,
    memory: body.memory !== undefined ? botMemoryOf(body.memory, cur.memory) : cur.memory,
    skills: Array.isArray(body.skills) ? await assignedIds(db, owner, 'skill', body.skills) : cur.skills,
    mcps: Array.isArray(body.mcps) ? await assignedIds(db, owner, 'mcp', body.mcps) : cur.mcps,
    updatedAt: Date.now(),
  }
}

/**
 * 用户 Bot 自己那一段追加提示词。拼在模版提示词**后面**，不覆盖它。
 *
 * 覆盖式的「自定义提示词」会让模版形同虚设——第一个想改口气的人就把整段底座替掉了，
 * 之后公司再改模版，他这台永远跟不上。追加则是可叠加的：底座换了，追加的还在。
 */
export function extraPromptOf(v: unknown, base = ''): string {
  if (v === undefined) return base
  const s = typeof v === 'string' ? v.trim() : ''
  if (s.length > MAX_EXTRA_PROMPT) throw new HttpError(400, `补充说明最多 ${MAX_EXTRA_PROMPT} 字`)
  return s
}

/**
 * 对外的 Bot。
 *
 * provider / model 一律给平台指定的那一对，不给存里那一对：Bot 不自己挑模型，
 * 库里那两个字段只是上次保存时的快照。平台换了日常模型，所有 Bot——包括之后再没人
 * 动过的——下一次读就跟着换，不用挨个打开保存一遍。
 *
 * **用户 Bot 同理，底座是现取的。** 它库里只有身份那几个字段，提示词 / 行为边界 /
 * 记忆 / Skill / MCP 全部来自传进来的模版，读一次合成一次。所以「模版改了，公司里
 * 的 Bot 跟着变」不是一个要去触发的同步动作——没有副本，也就没有会漂的东西。
 */
export function publicBot(item: CatalogItem, pinned: { provider: string; model: string }, tpl?: BotTemplate) {
  const def = botDefOf(item.definition)
  if (item.scope === 'user') {
    const template = tpl ?? defaultBotTemplate()
    const extraPrompt = typeof def.extraPrompt === 'string' ? def.extraPrompt : ''
    return {
      id: item.id,
      name: item.name,
      description: typeof def.description === 'string' ? def.description : '',
      prompt: [template.prompt, extraPrompt].filter(Boolean).join('\n\n'),
      greeting: typeof def.greeting === 'string' ? def.greeting : '',
      escalate: template.escalate,
      guards: template.guards,
      memory: template.memory,
      icon: botIconOf(def.icon, 'company'),
      provider: pinned.provider,
      model: pinned.model,
      enabled: def.enabled !== false,
      /**
       * **给运行面看的仍然是 company。** origin 会写进会话 JSONL 的信封
       * （SessionOrigin），那是落盘格式；为了一个只有界面用得上的区别去动它，等于让
       * 所有历史会话跟着迁一次。界面要分辨自建 / 公司 / 全局，看下面的 scope。
       */
      origin: 'company' as const,
      scope: 'user' as const,
      ownerId: item.accountId,
      extraPrompt,
      templateVersion: template.version,
      createdAt: item.createdAt,
      skills: template.skills,
      mcps: template.mcps,
      skillCount: template.skills.length,
      mcpCount: template.mcps.length,
      usage: '—',
    }
  }
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
    scope: item.scope === 'global' ? ('global' as const) : ('company' as const),
    ownerId: null as string | null,
    extraPrompt: '',
    templateVersion: 0,
    /** 0003 停用掉的老公司 Bot。界面据此标「已停用」并给出删除入口。 */
    legacy: item.scope === 'company' && def.legacy === true,
    createdAt: item.createdAt,
    skills,
    mcps,
    skillCount: skills.length,
    mcpCount: mcps.length,
    usage: '—',
  }
}

export const SKILL_SOURCES = ['手动编写', '单文件 Skill', 'ZIP 包'] as const
export const MCP_KINDS = ['stdio', 'SSE', 'HTTP'] as const
export const MCP_PERMS = ['只读', '可写', '需审批'] as const
export const DEFAULT_SKILL_TAGS = ['客服', '数据分析', '内容运营', '销售', '研发支持', '行政支持', '自动化', '需复核']
export const MAX_PACKAGE_BYTES = 5 * 1024 * 1024
export const MAX_PACKAGE_FILES = 200

export type SkillSource = (typeof SKILL_SOURCES)[number]
export type McpKind = (typeof MCP_KINDS)[number]
export type McpPerm = (typeof MCP_PERMS)[number]

export function asDef(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) }
  return {}
}

export function trimStr(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function namedOf(v: unknown): string {
  const name = trimStr(v)
  if (!name) throw new HttpError(400, '要有名字')
  return name
}

export function tagsOf(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, 20)
}

/** 「几个步骤」是数出来的，不是填的。列表项——有序无序都算。 */
export const stepsOf = (body: string) => body.split('\n').filter((line) => /^\s*(?:\d+[.)]|[-*+])\s+/.test(line)).length

/** 摘要取正文第一段没被列表符号占住的话。 */
export const summaryOf = (body: string) => {
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^[#>\-*+\d]/.test(l))
  return line ? (line.length > 90 ? `${line.slice(0, 90)}…` : line) : ''
}

export async function knownTags(db: Db, companyId: string): Promise<string[]> {
  const tags = await db.skillTags(companyId)
  if (tags.length) return tags
  for (const tag of DEFAULT_SKILL_TAGS) await db.insertSkillTag(companyId, tag)
  return await db.skillTags(companyId)
}

export async function rememberTags(db: Db, companyId: string, tags: string[]) {
  const known = new Set(await knownTags(db, companyId))
  for (const tag of tags) {
    if (!known.has(tag)) await db.insertSkillTag(companyId, tag)
  }
}

/**
 * ZIP 解开后的清单。二进制（base64）丢掉——Gateway 不落磁盘包，只把文本收进定义。
 */
export function filesOf(v: unknown): { path: string; text: string }[] {
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
export function envOf(v: unknown): Record<string, string> {
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

export function publicSkill(item: CatalogItem) {
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

export function publicServer(item: CatalogItem) {
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
export function runtimeServer(item: CatalogItem) {
  const def = asDef(item.definition)
  const token = typeof def.token === 'string' ? def.token.trim() : ''
  const env = def.env && typeof def.env === 'object' && !Array.isArray(def.env) ? (def.env as Record<string, string>) : {}
  return { ...publicServer(item), token, env, hasEnv: Object.keys(env).length > 0 }
}

/** 密钥本身永远不出现在响应里，只说配好了。 */
export function publicCred(c: Credential) {
  return { id: c.id, companyId: c.companyId, provider: c.provider, configured: true as const, createdAt: c.createdAt, updatedAt: c.updatedAt }
}

export function accessUrlFor(slug: string): string {
  const base = process.env.GATEWAY_ACCESS_HOST ?? 'satuwork.com'
  if (base.includes('{slug}')) return base.replaceAll('{slug}', slug)
  if (/^https?:\/\//i.test(base)) {
    const u = new URL(base)
    return `${u.protocol}//${slug}.${u.host}`
  }
  return `https://${slug}.${base}`
}
