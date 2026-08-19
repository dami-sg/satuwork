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
  error?: string
}

const TOKEN_NS = 'mcp-tokens'
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
  private remoteBots: RemoteBot[] = []
  private mcpEffects: Dispose[] = []
  /** 工具名 → 所属服务器 id，用来按 Bot 的 mcps 过滤。 */
  private toolServer = new Map<string, string>()
  private clients = new Map<string, McpHttpClient>()

  constructor(ctx: Context) {
    super(ctx, 'catalog')
  }

  get configured(): boolean {
    return Boolean(gatewayUrl() && gatewayToken())
  }

  toolNamesFor(serverIds: string[]): string[] {
    const allow = new Set(serverIds)
    const out: string[] = []
    for (const [name, sid] of this.toolServer) {
      if (allow.has(sid)) out.push(name)
    }
    return out
  }

  status() {
    return {
      gateway: this.configured ? gatewayUrl() : null,
      pulledAt: this.pulledAt,
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
    let body: { bots?: RemoteBot[]; skills?: RemoteSkill[]; servers?: RemoteServer[] }
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
    this.remoteBots = Array.isArray(body.bots) ? body.bots : []
    this.syncSkills(Array.isArray(body.skills) ? body.skills : [])
    this.syncServers(Array.isArray(body.servers) ? body.servers : [])
    const pinned = this.pinBots(this.remoteBots)
    await this.connectMcp()
    if (!pinned) return false
    this.pulledAt = Date.now()
    this.lastError = null
    return true
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
      const client = new McpHttpClient(s.endpoint, token)
      try {
        await client.initialize()
        const listed = await client.listTools()
        const names: string[] = []
        for (const tool of listed) {
          const name = mcpToolName(s.name, tool.name)
          if (this.ctx.tools.has(name)) continue
          this.registerMcpTool(s.id, name, tool, client)
          names.push(name)
        }
        this.clients.set(s.id, client)
        statuses.push({ id: s.id, name: s.name, kind: s.kind, enabled: true, connected: true, tools: names })
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
      async execute(args) {
        try {
          const text = await client.callTool(remoteName, args)
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
    void ctx.catalog.pull()

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
