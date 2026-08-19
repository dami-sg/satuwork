import { Service, type Context } from '@deepseek-ai/cordis'
import type { Collection } from '../storage/index.ts'
import type { SessionOrigin } from '../session/types.ts'
import { gatewayUrl } from '../llm/gateway.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    roster: AgentRegistry
  }
}

/** 本机 Bot。origin: local 是自建；company / global 是从 Gateway 钉下来的。 */
export interface BotRecord {
  id: string
  name: string
  /** 侧栏下一行的短描述。 */
  description?: string
  /** 系统提示词。空则回落到全局 agent.system。 */
  prompt?: string
  icon: string
  /** 发消息用这一对，不是进程全局默认。 */
  provider: string
  model: string
  enabled: boolean
  origin: SessionOrigin
  remoteId?: string
  /** 这个 Bot 的长会话。打开 /a/:id 复用，不每次新建。 */
  sessionId?: string
  /** 挂上的 Skill / MCP 目录 id。公司 Bot 从 Gateway 同步下来。 */
  skills?: string[]
  mcps?: string[]
  createdAt: number
}

const ICONS = new Set(['bot', 'chat', 'chart', 'pen', 'deal', 'code'])

function pinnedBotId(): string {
  return (process.env.SATUWORK_BOT_ID || '').trim()
}
export const DEFAULT_BOT_ID = 'default'
export const DEFAULT_PROVIDER = 'deepseek'
export const DEFAULT_MODEL = 'deepseek-v4-flash'

const DEFAULT_PROMPT =
  '你是 Satuwork 的 AI 员工。用简洁、专业的中文回答。需要当前时间、查看或修改文件、执行命令时调用工具，不要凭猜测。'

/**
 * 本机 Bot 名册。
 *
 * 定义落 `storage.collection('bots')`，会话属于 Bot。
 * 本机不提供配置后台：钉公司 Bot、种默认 Bot。改定义只在 Gateway。
 */
export class AgentRegistry extends Service {
  static inject = ['storage', 'sessions']
  private col: Collection<BotRecord>

  constructor(ctx: Context) {
    super(ctx, 'roster')
    this.col = ctx.storage.collection<BotRecord>('bots')
    this.migrateFromAgents(ctx)
  }

  /** 旧 collection 名是 agents。有数据且 bots 为空时搬过来，并补上 provider+model。 */
  private migrateFromAgents(ctx: Context) {
    if (this.col.list().length) {
      for (const row of this.col.list()) {
        const v = row.value as BotRecord & { model?: string; provider?: string }
        if (!v.provider || !v.model) {
          this.col.put(row.id, { ...v, provider: v.provider || DEFAULT_PROVIDER, model: v.model || DEFAULT_MODEL })
        }
      }
      return
    }
    const legacy = ctx.storage.collection<BotRecord>('agents')
    for (const row of legacy.list()) {
      const v = row.value as BotRecord & { model?: string; provider?: string }
      this.col.put(row.id, {
        ...v,
        provider: v.provider || DEFAULT_PROVIDER,
        model: v.model || DEFAULT_MODEL,
      })
    }
  }

  /** 库是空的就下一颗默认助理。id 固定为 `default`，旧会话迁移挂在它上面。
   *  SATUWORK_BOT_ID 已设、或已配 GATEWAY_URL 时不种默认。 */
  seed(): BotRecord {
    const existing = this.col.get(DEFAULT_BOT_ID)
    if (existing) return existing
    if (this.col.list().length) {
      return this.col.list()[0].value
    }
    if (pinnedBotId()) {
      throw new Error('SATUWORK_BOT_ID 已设，不种默认助理')
    }
    if (gatewayUrl()) {
      throw new Error('已配置 GATEWAY_URL 但未设 SATUWORK_BOT_ID，不种默认助理')
    }
    const agent: BotRecord = {
      id: DEFAULT_BOT_ID,
      name: 'Satuwork',
      description: '默认助理',
      prompt: DEFAULT_PROMPT,
      icon: 'chat',
      provider: DEFAULT_PROVIDER,
      model: DEFAULT_MODEL,
      enabled: true,
      origin: 'local',
      createdAt: Date.now(),
    }
    this.col.put(agent.id, agent)
    return agent
  }

  defaultId(): string {
    if (this.col.get(DEFAULT_BOT_ID)) return DEFAULT_BOT_ID
    const rows = this.col.list()
    if (rows.length) return (rows.find((r) => r.value.enabled) ?? rows[0]).id
    const pin = pinnedBotId()
    if (pin) return pin
    if (gatewayUrl()) {
      throw new Error('已配置 GATEWAY_URL 但未设 SATUWORK_BOT_ID，不种默认助理')
    }
    return this.seed().id
  }

  list(): BotRecord[] {
    if (!this.col.list().length && !pinnedBotId() && !gatewayUrl()) this.seed()
    return this.col.list().map((r) => r.value)
  }

  get(id: string): BotRecord | undefined {
    return this.col.get(id)
  }

  /**
   * 物化一条全局/公司 Bot。本机 id 跟远程 id 相同。不覆盖 sessionId。
   * 每次同步更新提示词、模型、Skill/MCP；会话仍是这一条。
   */
  pin(input: {
    remoteId: string
    origin: 'company' | 'global'
    name: string
    description?: string
    prompt?: string
    icon?: string
    provider?: string
    model?: string
    enabled?: boolean
    skills?: string[]
    mcps?: string[]
  }): BotRecord {
    const id = input.remoteId
    const current = this.col.get(id)
    if (current && current.origin === 'local' && !current.remoteId) {
      throw new Error(`本机已有同名 id 的自建助理：${id}`)
    }
    const next: BotRecord = {
      id,
      name: input.name,
      description: input.description?.trim() || undefined,
      prompt: input.prompt?.trim() || undefined,
      icon: ICONS.has(input.icon ?? '') ? input.icon! : current?.icon || 'bot',
      provider: input.provider?.trim() || current?.provider || DEFAULT_PROVIDER,
      model: input.model?.trim() || current?.model || DEFAULT_MODEL,
      enabled: input.enabled !== false,
      origin: input.origin,
      remoteId: input.remoteId,
      sessionId: current?.sessionId,
      skills: Array.isArray(input.skills) ? input.skills : current?.skills,
      mcps: Array.isArray(input.mcps) ? input.mcps : current?.mcps,
      createdAt: current?.createdAt ?? Date.now(),
    }
    this.col.put(id, next)
    return next
  }

  /** 部署实例只留钉住的那一颗，其余从名册删掉。 */
  pruneExcept(keepId: string): void {
    for (const row of this.col.list()) {
      if (row.id !== keepId) this.col.delete(row.id)
    }
  }

  /** 把一条已有会话认领为该 Bot 的长会话。迁移用，不新建。 */
  bindSession(id: string, sessionId: string): void {
    const current = this.col.get(id)
    if (!current || current.sessionId) return
    this.col.put(id, { ...current, sessionId })
  }

  /**
   * 一个 Bot 一条长会话。有就复用，文件没了再造一条。
   * 不在这里上报索引——那是 M5 的事。
   */
  async ensureSession(botId: string): Promise<{ sessionId: string; created: boolean }> {
    const agent = this.col.get(botId)
    if (!agent) throw new Error(`没有这个助理：${botId}`)
    if (agent.sessionId) {
      try {
        await this.ctx.sessions.events(agent.sessionId)
        return { sessionId: agent.sessionId, created: false }
      } catch {
        // 文件没了：再造一条，不把旧 id 留在名册上。
      }
    }
    // 启动迁移可能刚把旧文件挂到这个 Bot，但还没来得及 bindSession。
    // list() 会走 load()，旧文件当场迁完，这里就能认领，不必另开一条。
    const mine = (await this.ctx.sessions.list()).filter((s) => s.botId === agent.id)
    if (mine[0]) {
      this.bindSession(agent.id, mine[0].id)
      return { sessionId: mine[0].id, created: false }
    }
    const sessionId = await this.ctx.sessions.create({
      title: agent.name,
      botId: agent.id,
      origin: agent.origin,
      remoteId: agent.remoteId,
    })
    this.col.put(agent.id, { ...this.col.get(agent.id)!, sessionId })
    return { sessionId, created: true }
  }
}

export const name = 'satu-agent-registry'
export const inject = ['storage', 'sessions', 'server']

export function apply(ctx: Context) {
  ctx.plugin(AgentRegistry)

  ctx.inject(['roster'], (ctx: Context) => {
    const { roster, sessions } = ctx
    if (!pinnedBotId() && !gatewayUrl()) {
      const seeded = roster.seed()
      void sessions.migrateAll(seeded.id).then(async () => {
        // 旧会话挂到默认 Bot 之后，若它还没有长会话，把最近一条认领过来。
        const agent = roster.get(seeded.id)
        if (!agent || agent.sessionId) return
        const mine = (await sessions.list()).filter((s) => s.botId === agent.id)
        if (mine[0]) roster.bindSession(agent.id, mine[0].id)
      })
    } else if (gatewayUrl() && !pinnedBotId()) {
      ctx.logger?.warn?.('名册: 已配置 GATEWAY_URL 但未设 SATUWORK_BOT_ID，不种 default，也不钉整份目录')
    }

    const fail = (res: { status: number }, status: number, error: string) => {
      res.status = status
      return { error }
    }

    ctx.server.get('/api/bots', async (req, res) =>
      res.json({
        bots: roster.list().map((b) => ({
          ...b,
          skillCount: (b.skills ?? []).length,
          mcpCount: (b.mcps ?? []).length,
          usage: '—',
        })),
      }),
    )

    // 配置后台在 Gateway。本机只读名册、钉公司 Bot、开长会话。
    ctx.server.get('/api/bots/options', async (req, res) => {
      res.status = 410
      return res.json({ error: 'Bot 配置在 Gateway' })
    })

    ctx.server.post('/api/bots', async (req, res) => {
      res.status = 410
      return res.json({ error: 'Bot 配置在 Gateway' })
    })

    ctx.server.get('/api/bots/:id/session', async (req, res) => {
      try {
        return res.json(await roster.ensureSession(req.params.id))
      } catch (e) {
        return res.json(fail(res, 404, (e as Error).message))
      }
    })

    ctx.server.get('/api/bots/:id', async (req, res, next) => {
      // options / pin 留给别的插件。:id 不能把它们吞掉。
      if (req.params.id === 'options' || req.params.id === 'pin') return next()
      const bot = roster.get(req.params.id)
      if (!bot) return res.json(fail(res, 404, `没有这个助理：${req.params.id}`))
      return res.json({ bot })
    })

    ctx.server.patch('/api/bots/:id', async (req, res) => {
      res.status = 410
      return res.json({ error: 'Bot 配置在 Gateway' })
    })
  })
}
