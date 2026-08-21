import { Service, type Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl } from '../llm/gateway.ts'
import type { BotRecord } from '../registry/index.ts'
import { mcpToolName, McpHttpClient, type JsonRpcTool } from './mcp.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    catalog: CatalogService
  }
}

interface RemoteBot {
  id: string
  name: string
  description?: string
  prompt?: string
  icon?: string
  provider?: string
  model?: string
  enabled?: boolean
  origin?: 'company' | 'global' | 'local'
  skills?: string[]
  mcps?: string[]
}

export interface ModelRole {
  provider: string
  model: string
}

const EMPTY_ROLE: ModelRole = { provider: '', model: '' }

/** 老 Gateway 不带 models 字段，回落成空——空就由调用方自己回退，不在这里瞎猜。 */
function roleOf(raw: ModelRole | undefined): ModelRole {
  return { provider: String(raw?.provider ?? ''), model: String(raw?.model ?? '') }
}

interface RemoteSkill {
  id: string
  name: string
  body?: string
  tags?: string[]
  source?: string
  enabled?: boolean
  fileName?: string
}

interface RemoteServer {
  id: string
  name: string
  kind?: string
  endpoint?: string
  env?: Record<string, string>
  perm?: string
  enabled?: boolean
  token?: string
  /** 目录可以给某一条单独定时限。连接器那几条是 60 秒（发邮件、查 CRM 都不快）。 */
  timeoutMs?: number
  /** 「仅 @ 时可用」：连上、也注册工具，但不进默认工具表。 */
  mentionOnly?: boolean
}

interface CachedSkill {
  id: string
  name: string
  body: string
  tags: string[]
  source: '手动编写' | '单文件 Skill' | 'ZIP 包'
  fileName?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

interface CachedServer {
  id: string
  name: string
  kind: 'stdio' | 'SSE' | 'HTTP'
  endpoint: string
  env: Record<string, string>
  perm: '只读' | '可写' | '需审批'
  enabled: boolean
  timeoutMs?: number
  mentionOnly?: boolean
  createdAt: number
  updatedAt: number
}

export interface ServerStatus {
  id: string
  name: string
  kind: string
  enabled: boolean
  connected: boolean
  tools: string[]
  /** 「仅 @ 时可用」。连着，但不进默认工具表。 */
  mentionOnly?: boolean
  error?: string
}

const TOKEN_NS = 'mcp-tokens'
/**
 * 探针间隔。够快到「改完喝口水就生效」，又不至于让 Gateway 被一屋子席位刷。
 *
 * 下限 1 秒是给 e2e 用的（那条用例要在几秒内看到模版改动落到实例上）；生产上没人会
 * 去设它，默认一分钟。
 */
const POLL_MS = Math.max(1000, Math.trunc(Number(process.env.SATUWORK_CATALOG_POLL_MS) || 60000))
const KINDS = ['stdio', 'SSE', 'HTTP'] as const

type Dispose = () => unknown

/**
 * Gateway 目录缓存：启动时拉一次，写进本机 collection，把公司 Bot 钉到名册。
 * 定义只在 Gateway 改；这里只同步。
 */
export class CatalogService extends Service {
  static inject = ['storage', 'roster', 'tools']

  pulledAt: number | null = null
  lastError: string | null = null
  servers: ServerStatus[] = []
  /**
   * 平台钉的两个模型角色。**下发的，不是本机配的**：挑模型是平台的事，让席位的
   * cordis.yml 也能改，等于给了一条绕过平台配置的暗路。
   * 网页提取的摘要走 utility——廉价、大批量、不面对用户，正是它的定义。
   */
  models: { daily: ModelRole; utility: ModelRole } = { daily: EMPTY_ROLE, utility: EMPTY_ROLE }
  /** 上一次拉到的公司模版版本号。给 /api/runtime/status 看，也用来打日志。 */
  templateVersion = 0
  /** 上一次探针给的指纹。变了才重拉整份目录。 */
  private stamp = ''
  private remoteBots: RemoteBot[] = []
  private mcpEffects: Dispose[] = []
  /** 工具名 → 所属服务器 id，用来按 Bot 的 mcps 过滤。 */
  private toolServer = new Map<string, string>()
  /** 「仅 @ 时可用」的服务器 id。连上了，但平时不进工具表。 */
  private mentionOnly = new Set<string>()
  private clients = new Map<string, McpHttpClient>()

  constructor(ctx: Context) {
    super(ctx, 'catalog')
  }

  get configured(): boolean {
    return Boolean(gatewayUrl() && gatewayToken())
  }

  /**
   * 这些服务器上的工具名。
   *
   * `mentionOnly` 的那几台**默认不算在内**——它们连着、工具也注册了，但不进工具表，
   * 除非这一轮被 `@` 点名（`mentioned` 里有它）。「个人邮箱只有我点名了你才能碰」
   * 就是靠这一层实现的；不连它是不行的：真被点名时再去握手就晚了。
   */
  toolNamesFor(serverIds: string[], mentioned: string[] = []): string[] {
    const allow = new Set(serverIds)
    const named = new Set(mentioned)
    const out: string[] = []
    for (const [name, sid] of this.toolServer) {
      if (!allow.has(sid)) continue
      if (this.mentionOnly.has(sid) && !named.has(sid)) continue
      out.push(name)
    }
    return out
  }

  status() {
    return {
      gateway: this.configured ? gatewayUrl() : null,
      pulledAt: this.pulledAt,
      templateVersion: this.templateVersion,
      error: this.lastError,
      bots: this.ctx.roster.list().map((b) => ({
        id: b.id,
        name: b.name,
        origin: b.origin,
        remoteId: b.remoteId ?? null,
        enabled: b.enabled,
      })),
      skills: this.ctx.storage.collection<CachedSkill>('skills').list().map((r) => ({
        id: r.value.id,
        name: r.value.name,
        enabled: r.value.enabled,
      })),
      servers: this.servers.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
        enabled: s.enabled,
        connected: s.connected,
        tools: s.tools,
        ...(s.error ? { error: s.error } : {}),
      })),
    }
  }

  private inflight: Promise<boolean> | null = null

  /** SATUWORK_BOT_ID 对应的那一颗已经钉进名册。 */
  get pinSucceeded(): boolean {
    const id = (process.env.SATUWORK_BOT_ID || '').trim()
    if (!id) return false
    return Boolean(this.pulledAt && this.ctx.roster.get(id))
  }

  async pull(): Promise<boolean> {
    if (this.inflight) return this.inflight
    this.inflight = this.runPull().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async runPull(): Promise<boolean> {
    if (!this.configured) {
      this.lastError = '未配置 GATEWAY_URL / GATEWAY_TOKEN'
      return false
    }
    const base = gatewayUrl()
    const token = gatewayToken()
    let body: {
      templateVersion?: number
      stamp?: string
      bots?: RemoteBot[]
      skills?: RemoteSkill[]
      servers?: RemoteServer[]
      models?: { daily?: ModelRole; utility?: ModelRole }
    }
    const pinId = (process.env.SATUWORK_BOT_ID || '').trim()
    const catalogUrl = pinId
      ? `${base}/runtime/catalog?botId=${encodeURIComponent(pinId)}`
      : base + '/runtime/catalog'
    try {
      const r = await fetch(catalogUrl, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000),
      })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        throw new Error(`HTTP ${r.status}${text ? ` ${text.slice(0, 160)}` : ''}`)
      }
      body = (await r.json()) as typeof body
    } catch (e) {
      this.lastError = (e as Error).message
      this.ctx.logger?.warn?.(`catalog: 拉取失败 ${this.lastError}`)
      return false
    }
    this.templateVersion = Number(body.templateVersion) || this.templateVersion
    // 这一份内容的指纹，跟着数据一起来。**基线取自这里**，不能等第一次探针——那两件事
    // 之间隔着一整轮插件启动，中间落地的改动会永远丢掉。但先攥在手里，等下面这一份
    // 真的落地了再写进 this.stamp（见函数末尾）。
    const stamp = typeof body.stamp === 'string' ? body.stamp : ''
    this.remoteBots = Array.isArray(body.bots) ? body.bots : []
    this.models = {
      daily: roleOf(body.models?.daily),
      utility: roleOf(body.models?.utility),
    }
    this.syncSkills(Array.isArray(body.skills) ? body.skills : [])
    this.syncServers(Array.isArray(body.servers) ? body.servers : [])
    const pinned = this.pinBots(this.remoteBots)
    await this.connectMcp()
    if (!pinned) return false
    this.pulledAt = Date.now()
    /**
     * **指纹在这里才落。**
     *
     * 早一步写的话，中间任何一步抛错（storage 写不进去、pin 撞了本地同名 Bot）都会留下
     * 「指纹是新的、数据还是旧的」——之后每一轮探针都判定「没变」，这台席位就静悄悄地
     * 停在旧模版上，直到下次有人改模版或者进程重启。宁可重拉一次，也不能不声不响地停住。
     */
    if (stamp) this.stamp = stamp
    this.lastError = null
    return true
  }

  /**
   * 「底座换了没有」——探一下，变了才重拉。
   *
   * 公司的 Bot 模版一改，版本号就 +1，这台席位上的 Bot 得跟着换提示词和工具表；但
   * 目录那一份带着 MCP 明文 token 和全部 Skill 正文，每分钟整份拉一遍既费字节又让
   * 密钥白白多流动几十次。所以探针只回一个指纹，指纹没动就一个字节都不再取。
   *
   * 拉失败不清 stamp：下一轮还会再探到同一个新指纹，自然会重试。
   */
  async poll(): Promise<void> {
    if (!this.configured) return
    const pinId = (process.env.SATUWORK_BOT_ID || '').trim()
    const url = `${gatewayUrl()}/runtime/catalog/version${pinId ? `?botId=${encodeURIComponent(pinId)}` : ''}`
    let next = ''
    try {
      const r = await fetch(url, {
        headers: { authorization: `Bearer ${gatewayToken()}` },
        signal: AbortSignal.timeout(10000),
      })
      if (!r.ok) return
      const body = (await r.json()) as { stamp?: unknown }
      next = typeof body.stamp === 'string' ? body.stamp : ''
    } catch {
      // 探针失败不写 lastError：那一栏说的是「目录同步」的状态，一次网络抖动不该让
      // 界面上出现红字，而下一轮探针一分钟后就到。
      return
    }
    if (!next || next === this.stamp) return
    this.ctx.logger?.info?.(`catalog: 目录有变（${next}），重新拉取`)
    /**
     * **拉取的异常在这里就地收住。**
     *
     * runPull 只 catch 了 fetch 那一段；后面 syncSkills / pinBots / connectMcp 里任何一处
     * 抛出来（磁盘满、SQLite busy、pin 撞了同名 Bot）都会顺着这里冒成未处理的 Promise
     * 拒绝——Node 默认策略是直接终止进程，于是席位上的 bot 每分钟被自己杀一次，日志里
     * 只留一行栈。停在旧目录上是可以忍的，进程反复自杀不行。
     */
    try {
      await this.pull()
    } catch (e) {
      this.lastError = (e as Error).message
      this.ctx.logger?.warn?.(`catalog: 重新拉取失败 ${this.lastError}`)
    }
  }

  async pinRemote(remoteId: string): Promise<BotRecord> {
    let bot = this.remoteBots.find((b) => b.id === remoteId)
    if (!bot && this.configured) {
      await this.pull()
      bot = this.remoteBots.find((b) => b.id === remoteId)
    }
    if (!bot) throw new Error(`目录里没有这个助理：${remoteId}`)
    return this.pinOne(bot)
  }

  private syncSkills(items: RemoteSkill[]) {
    const col = this.ctx.storage.collection<CachedSkill>('skills')
    const now = Date.now()
    for (const s of items) {
      const prev = col.get(s.id)
      const source =
        s.source === '单文件 Skill' || s.source === 'ZIP 包' ? s.source : ('手动编写' as const)
      col.put(s.id, {
        id: s.id,
        name: s.name,
        body: typeof s.body === 'string' ? s.body : '',
        tags: Array.isArray(s.tags) ? s.tags.map(String) : [],
        source,
        ...(s.fileName ? { fileName: s.fileName } : {}),
        enabled: s.enabled !== false,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      })
    }
  }

  private syncServers(items: RemoteServer[]) {
    const col = this.ctx.storage.collection<CachedServer>('mcp-servers')
    const now = Date.now()
    for (const s of items) {
      const prev = col.get(s.id)
      const kind = (KINDS as readonly string[]).includes(s.kind || '') ? (s.kind as CachedServer['kind']) : 'SSE'
      col.put(s.id, {
        id: s.id,
        name: s.name,
        kind,
        endpoint: typeof s.endpoint === 'string' ? s.endpoint : '',
        env: s.env && typeof s.env === 'object' ? s.env : {},
        perm: s.perm === '可写' || s.perm === '需审批' ? s.perm : '只读',
        enabled: s.enabled !== false,
        ...(Number.isFinite(Number(s.timeoutMs)) && Number(s.timeoutMs) > 0 ? { timeoutMs: Math.trunc(Number(s.timeoutMs)) } : {}),
        ...(s.mentionOnly === true ? { mentionOnly: true } : {}),
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      })
      const token = typeof s.token === 'string' ? s.token : ''
      this.ctx.storage.setSetting(TOKEN_NS, s.id, token || null)
    }
  }

  private pinBots(items: RemoteBot[]): boolean {
    const only = (process.env.SATUWORK_BOT_ID || '').trim()
    if (!only) {
      // GATEWAY_URL 已设才会走到这里。没有钉 id 就不钉整份目录，也不种 default。
      this.lastError = '未设 SATUWORK_BOT_ID，不钉目录'
      this.ctx.logger?.warn?.('catalog: 已配置 GATEWAY_URL 但未设 SATUWORK_BOT_ID，不钉目录')
      return false
    }
    const hit = items.find((b) => b.id === only)
    if (!hit) {
      this.lastError = `目录里没有这个助理：${only}`
      this.ctx.logger?.warn?.(`catalog: ${this.lastError}`)
      return false
    }
    this.pinOne(hit)
    this.ctx.roster.pruneExcept(only)
    return true
  }

  private pinOne(b: RemoteBot): BotRecord {
    const origin = b.origin === 'global' ? 'global' : 'company'
    return this.ctx.roster.pin({
      remoteId: b.id,
      origin,
      name: b.name,
      description: b.description,
      prompt: b.prompt,
      icon: b.icon,
      provider: b.provider,
      model: b.model,
      enabled: b.enabled !== false,
      skills: Array.isArray(b.skills) ? b.skills : [],
      mcps: Array.isArray(b.mcps) ? b.mcps : [],
    })
  }

  private dropMcpTools() {
    for (const name of this.toolServer.keys()) {
      this.ctx.tools.unregister(name)
    }
    for (const dispose of this.mcpEffects.splice(0)) {
      try {
        const r = dispose()
        if (r && typeof (r as Promise<unknown>).then === 'function') void (r as Promise<unknown>).catch(() => {})
      } catch {
        /* 卸工具失败不挡下一轮 */
      }
    }
    this.toolServer.clear()
    this.mentionOnly.clear()
    this.clients.clear()
  }

  private async connectMcp() {
    this.dropMcpTools()
    const rows = this.ctx.storage.collection<CachedServer>('mcp-servers').list()
    const statuses: ServerStatus[] = []
    for (const row of rows) {
      const s = row.value
      if (!s.enabled) {
        statuses.push({ id: s.id, name: s.name, kind: s.kind, enabled: false, connected: false, tools: [] })
        continue
      }
      if (s.kind === 'stdio') {
        this.ctx.logger?.info?.(`catalog: 跳过 stdio MCP ${s.name}`)
        statuses.push({
          id: s.id,
          name: s.name,
          kind: s.kind,
          enabled: true,
          connected: false,
          tools: [],
          error: 'stdio 不支持',
        })
        continue
      }
      const token = this.ctx.storage.getSetting<string>(TOKEN_NS, s.id) ?? ''
      const client = new McpHttpClient(s.endpoint, token, s.timeoutMs)
      try {
        await client.initialize()
        const listed = await client.listTools()
        const names: string[] = []
        for (const tool of listed) {
          const name = mcpToolName(s.name, tool.name)
          if (this.ctx.tools.has(name)) {
            // 重名只可能是截断撞了。**要说出来**：静默跳过的表现是「某个工具时有时无」，
            // 而没有任何一行日志指向原因。
            this.ctx.logger?.warn?.(`catalog: ${s.name} 的 ${tool.name} 撞名 ${name}，这一个没注册`)
            continue
          }
          this.registerMcpTool(s.id, name, tool, client)
          names.push(name)
        }
        this.clients.set(s.id, client)
        if (s.mentionOnly) this.mentionOnly.add(s.id)
        statuses.push({ id: s.id, name: s.name, kind: s.kind, enabled: true, connected: true, tools: names, ...(s.mentionOnly ? { mentionOnly: true } : {}) })
      } catch (e) {
        this.ctx.logger?.warn?.(`catalog: MCP ${s.name} 失败 ${(e as Error).message}`)
        statuses.push({
          id: s.id,
          name: s.name,
          kind: s.kind,
          enabled: true,
          connected: false,
          tools: [],
          error: (e as Error).message,
        })
      }
    }
    this.servers = statuses
  }

  private registerMcpTool(serverId: string, name: string, tool: JsonRpcTool, client: McpHttpClient) {
    const parameters =
      tool.inputSchema && typeof tool.inputSchema === 'object'
        ? tool.inputSchema
        : { type: 'object', properties: {} }
    const remoteName = tool.name
    const fork = this.ctx.tools.register({
      name,
      description: tool.description || remoteName,
      parameters,
      execute: async (args, call) => {
        try {
          /**
           * 这一次是不是用户 `@` 点名的这台服务器。
           *
           * 只有这一侧知道答案（点名决定的是这一轮的工具表），所以由这里带给服务端，
           * 让流水上记得住「人点的还是模型自己挑的」。`agents` 用可选取法，免得目录
           * 插件为一个附加信息去 inject 它、绕出一条依赖环。
           */
          const viaMention = this.ctx.agents?.mentionedIn?.(call.sessionId ?? '')?.has(serverId) === true
          const text = await client.callTool(remoteName, args, viaMention ? { viaMention: true } : undefined)
          return { text }
        } catch (e) {
          return { text: `MCP 调用失败：${(e as Error).message}`, failed: true }
        }
      },
    })
    this.mcpEffects.push(() => (fork as Dispose)())
    this.toolServer.set(name, serverId)
  }
}

export const name = 'satu-catalog'
export const inject = ['storage', 'roster', 'tools', 'server']

export function apply(ctx: Context) {
  ctx.plugin(CatalogService)
  ctx.inject(['catalog'], (ctx: Context) => {
    // 启动那一次同样不能让异常冒出去：runPull 的 fetch 之外还有一截会抛（见 poll）。
    ctx.catalog.pull().catch((e: unknown) => ctx.logger?.warn?.(`catalog: 首次拉取失败 ${(e as Error).message}`))

    /**
     * 跟住 Gateway 上的改动。
     *
     * 以前只在启动时拉一次，于是公司改了 Bot 模版（或者管理员加了个 MCP），这台席位
     * 要等到下一次重新部署才知道——而那正是「模版改完全公司自动跟上」这条产品承诺
     * 落不了地的地方。一分钟一次的探针够快，又不至于让 Gateway 被几十台席位刷。
     */
    const timer = setInterval(() => {
      ctx.catalog.poll().catch((e: unknown) => ctx.logger?.warn?.(`catalog: 探针失败 ${(e as Error).message}`))
    }, POLL_MS)
    timer.unref?.()
    ctx.effect(() => () => clearInterval(timer))

    ctx.server.get('/api/runtime/status', async (req, res) => {
      res.json(ctx.catalog.status())
    })

    ctx.server.post('/api/bots/pin', async (req, res) => {
      if ((process.env.SATUWORK_BOT_ID || '').trim()) {
        res.status = 410
        res.json({ error: 'Bot 配置在 Gateway' })
        return
      }
      const body = (await req.json().catch(() => ({}))) as { remoteId?: string }
      const remoteId = typeof body.remoteId === 'string' ? body.remoteId.trim() : ''
      if (!remoteId) {
        res.status = 400
        res.json({ error: 'remoteId 不能为空' })
        return
      }
      try {
        res.json({ bot: await ctx.catalog.pinRemote(remoteId) })
      } catch (e) {
        const msg = (e as Error).message
        res.status = msg.startsWith('目录里没有') ? 404 : 400
        res.json({ error: msg })
      }
    })
  })
}
