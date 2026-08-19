import { Service, type Context } from '@deepseek-ai/cordis'
import { Agent, type AgentEvent, type AgentMessage } from '@earendil-works/pi-agent-core'
import { randomUUID } from 'node:crypto'
import type { ContentBlock, Message, StreamChunk, Usage } from '../session/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentService
  }
}

export interface Config {
  provider?: string
  model?: string
  system?: string
}

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }

/**
 * Agent 循环。
 *
 * 循环本身是 `@earendil-works/pi-agent-core`——它带 steering（**工具跑到一半也能
 * 插话**）、follow-up 队列、中止、思考预算，以及 `transformContext` 这个注入外部
 * 上下文的钩子（知识库检索与长期记忆以后挂那里）。自己写这些没有收益。
 *
 * 但**持久记录仍然是我们自己的**：订阅它的事件，投影进我们的会话日志。运行时
 * 状态归它、durable 记录归我们，单向流动不会漂移。它的会话后端
 * （`pi-session-backend-sqlite-node`）刻意不用——那会把日志格式交出去。
 */
export class AgentService extends Service {
  /** 正在跑的 agent。steering 要够得着它，所以不能只是个局部变量。 */
  private live = new Map<string, Agent>()
  /**
   * 已经开跑、但 Agent 还没造出来的会话。
   *
   * send() 里「检查在不在跑」和「登记进 live」之间隔着好几个 await（读历史、组 system、
   * 查模型）。只看 live 的话，两个并发的 send 会双双通过检查，于是同一条会话上跑起两个
   * agent：事件交错写进同一份 JSONL，用量也记两遍。占位必须在**第一个 await 之前**
   * 同步做掉。
   */
  private starting = new Set<string>()

  constructor(
    ctx: Context,
    private config: Config = {},
  ) {
    super(ctx, 'agents')
  }

  /**
   * 生效配置：设置库 > cordis.yml > 内置默认。
   * **在使用点读取**，不在构造时缓存——界面上改完下一轮就生效。
   */
  private setting<T>(key: string, fallback: T): T {
    return this.ctx.storage.getSetting<T>('agent', key) ?? fallback
  }
  get provider() {
    return this.setting('provider', this.config.provider ?? 'deepseek')
  }
  get model() {
    return this.setting('model', this.config.model ?? 'deepseek-v4-flash')
  }
  get system() {
    return this.setting(
      'system',
      this.config.system ?? '你是 Satuwork 的 AI 员工，用简洁、专业的中文回答。',
    )
  }

  isRunning(sessionId: string) {
    return this.live.has(sessionId) || this.starting.has(sessionId)
  }

  /** 跑到一半插话。agent 不在跑时返回 false，由调用方决定改成普通消息。 */
  steer(sessionId: string, text: string): boolean {
    const agent = this.live.get(sessionId)
    if (!agent) return false
    agent.steer({ role: 'user', content: text, timestamp: Date.now() } as AgentMessage)
    return true
  }

  abort(sessionId: string): boolean {
    const agent = this.live.get(sessionId)
    if (!agent) return false
    agent.abort()
    return true
  }

  async send(sessionId: string, text: string): Promise<void> {
    if (this.isRunning(sessionId)) {
      // 这条以前是静默的，而它意味着**用户那句话被丢掉了**——steer 没接住、send 又
      // 拒收。界面上什么都看不出来，日志里也没有。
      this.ctx.logger?.warn?.(`agents: 会话 ${sessionId} 已在运行，这条消息没能进去`)
      throw new Error('agents: 该会话正在运行中')
    }
    // 同步占位，之后才允许出现 await。
    this.starting.add(sessionId)
    try {
      await this.runTurn(sessionId, text)
    } finally {
      this.starting.delete(sessionId)
    }
  }

  private async runTurn(sessionId: string, text: string): Promise<void> {
    const { sessions, llm } = this.ctx
    const history = await sessions.events(sessionId)
    let system: { text: string; base: string; skills: string }
    let provider: string
    let modelId: string
    let model: ReturnType<typeof llm.modelOf>
    let toolSchemas: { name: string; description: string; parameters?: unknown }[]
    try {
      const bot = this.botOf(history)
      system = this.composeSystem(bot)
      provider = bot?.provider?.trim() || this.provider
      modelId = bot?.model?.trim() || this.model
      model = llm.modelOf(provider, modelId)
      toolSchemas = this.toolSchemasFor(bot)
    } catch (e) {
      const turn = history.filter((ev) => ev.type === 'turn/start').length + 1
      await sessions.append(sessionId, 'user/message', {
        message: { id: randomUUID(), role: 'user', content: [{ type: 'text', text }] },
        source: { kind: 'user' },
      })
      await sessions.append(sessionId, 'turn/start', { turn })
      await sessions.append(sessionId, 'assistant/message', {
        turn,
        step: 0,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'text', text: `出错了：${(e as Error).message}` }],
        },
        usage: EMPTY_USAGE,
      })
      await sessions.append(sessionId, 'turn/end', { turn, reason: 'error' })
      throw e
    }

    const turn = history.filter((e) => e.type === 'turn/start').length + 1

    await sessions.append(sessionId, 'user/message', {
      message: { id: randomUUID(), role: 'user', content: [{ type: 'text', text }] },
      source: { kind: 'user' },
    })
    await sessions.append(sessionId, 'turn/start', { turn })

    const agent = new Agent({
      initialState: {
        systemPrompt: system.text,
        model,
        messages: toAgentMessages(history, model),
        tools: this.bridgeTools(sessionId, new Set(toolSchemas.map((t) => t.name))),
      },
      streamFn: llm.streamFn,
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      sessionId,
    } as any)

    this.live.set(sessionId, agent)
    const isMcp = (t: { name: string }) => t.name.startsWith('mcp_')
    const off = agent.subscribe(
      this.projector(sessionId, turn, {
        provider,
        model: modelId,
        system: system.text,
        tools: toolSchemas,
        contextWindow: this.windowOf(provider, modelId),
        sections: {
          system: estTokens(system.base),
          skills: estTokens(system.skills),
          builtinTools: estTokens(toolsText(toolSchemas.filter((t) => !isMcp(t)))),
          mcpTools: estTokens(toolsText(toolSchemas.filter(isMcp))),
        },
      }),
    )

    let reason: 'completed' | 'error' | 'aborted' = 'completed'
    const startedAt = Date.now()
    this.ctx.logger?.info?.(`agents: 会话 ${sessionId} 第 ${turn} 轮开始（${provider}/${modelId}）`)
    try {
      await agent.prompt(text)
      // pi-agent **不抛**模型侧错误，它落在 state.errorMessage / 最终消息的
      // stopReason 上。不显式检查的话，一个失败的 turn 会被记成 completed，
      // 而对话里只剩一条空的助手消息。
      const failure = (agent.state as any)?.errorMessage
      if (failure) {
        reason = 'error'
        await sessions.append(sessionId, 'assistant/message', {
          turn,
          step: 0,
          message: {
            id: randomUUID(),
            role: 'assistant',
            content: [{ type: 'text', text: `模型调用失败：${failure}` }],
          },
          usage: EMPTY_USAGE,
        })
      }
    } catch (e) {
      reason = 'error'
      // 失败也要留在日志里，否则这个 turn 在链路视图上就是一段空白。
      await sessions.append(sessionId, 'assistant/message', {
        turn,
        step: 0,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'text', text: `出错了：${(e as Error).message}` }],
        },
        usage: EMPTY_USAGE,
      })
    } finally {
      off()
      this.live.delete(sessionId)
      await sessions.append(sessionId, 'turn/end', { turn, reason })
      // 有这一行，「那一轮到底结束没有」就不用再猜了。
      this.ctx.logger?.info?.(
        `agents: 会话 ${sessionId} 第 ${turn} 轮结束（${reason}，${Date.now() - startedAt}ms）`,
      )
    }
  }

  /**
   * 把 ctx.tools 的注册表桥成 pi 的 AgentTool。
   *
   * 两边的失败约定相反：我们的 execute **永远 resolve**（业务失败写进 text），
   * pi 要求**失败抛异常**。所以只有管道层失败（`failed`）才抛——业务失败照常作为
   * 内容返回，模型读得到、能自己重试。
   */
  private bridgeTools(sessionId: string, allowed?: Set<string>) {
    const schemas = allowed
      ? this.ctx.tools.schemas().filter((s) => allowed.has(s.name))
      : this.ctx.tools.schemas()
    return schemas.map((schema) => ({
      name: schema.name,
      label: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      execute: async (toolCallId: string, params: unknown) => {
        const result = await this.ctx.tools.execute({
          callId: toolCallId,
          name: schema.name,
          arguments: JSON.stringify(params ?? {}),
          sessionId,
        })
        if (result.failed) throw new Error(result.text)
        return { content: [{ type: 'text' as const, text: result.text }], details: undefined }
      },
    })) as any
  }

  /** 会话根上的 botId → 名册里的提示词 / provider+model。没有就回落全局设置。 */
  private botOf(history: Awaited<ReturnType<Context['sessions']['events']>>) {
    const root = history.find((e) => e.type === 'session')
    const data = root?.data as { botId?: string; agentId?: string } | undefined
    const botId = data?.botId ?? data?.agentId
    if (!botId) return undefined
    type Row = { prompt?: string; model?: string; provider?: string; skills?: string[]; mcps?: string[] }
    return this.ctx.storage.collection<Row>('bots').get(botId)
      ?? this.ctx.storage.collection<Row>('agents').get(botId)
  }

  /**
   * 把该 Bot 挂上的、且已启用的 Skill 正文拼进系统提示词。
   * 没有 skills 列表 → 本机所有启用的 Skill；空数组 → 不加。
   *
   * 返回时把两段分开留一份：上下文占比要分别报「提示词」和「Skill」，拼完再去切
   * 字符串既脆（提示词里出现同样的小标题就切错）又白算一遍。
   */
  private composeSystem(
    bot: { prompt?: string; skills?: string[] } | undefined,
  ): { text: string; base: string; skills: string } {
    const base = bot?.prompt?.trim() || this.system
    const col = this.ctx.storage.collection<{ id: string; name: string; body: string; enabled?: boolean }>('skills')
    const ids = bot?.skills
    const picked =
      ids === undefined
        ? col.list().map((r) => r.value).filter((s) => s.enabled !== false)
        : ids
            .map((id) => col.get(id))
            .filter((s): s is { id: string; name: string; body: string; enabled?: boolean } => !!s && s.enabled !== false)
    if (!picked.length) return { text: base, base, skills: '' }
    const extra = picked.map((s) => `## Skill: ${s.name}\n${s.body}`).join('\n\n')
    return { text: `${base}\n\n${extra}`, base, skills: extra }
  }

  /** 模型的上下文窗口，来自 Gateway 目录。拉不到就没有——界面那条占比会自己让位。 */
  private windowOf(provider: string, model: string): number | undefined {
    const found = this.ctx.llm
      .catalog()
      .find((p) => p.provider === provider)
      ?.models.find((m) => m.id === model)
    return typeof found?.contextWindow === 'number' ? found.contextWindow : undefined
  }

  /** 内置工具始终在。MCP 工具只在成功 list 之后才注册，再按 Bot.mcps 过滤。 */
  private toolSchemasFor(bot: { mcps?: string[] } | undefined) {
    const all = this.ctx.tools.schemas()
    const mcpNames = new Set<string>()
    const catalog = this.ctx.catalog
    const assigned = bot?.mcps
    if (assigned === undefined) {
      for (const s of catalog.servers) for (const n of s.tools) mcpNames.add(n)
    } else {
      for (const n of catalog.toolNamesFor(assigned)) mcpNames.add(n)
    }
    return all.filter((t) => !t.name.startsWith('mcp_') || mcpNames.has(t.name))
  }

  /**
   * pi 的事件 → 我们的会话日志。
   *
   * 名称对不上要留意：pi 的一个 **turn** 是「一次模型调用加它的工具」，也就是我们
   * 的 **step**；我们的 turn 是一次用户输入引发的全部工作。
   */
  private projector(
    sessionId: string,
    turn: number,
    used: {
      provider: string
      model: string
      system: string
      tools: { name: string; description: string }[]
      contextWindow?: number
      sections?: { system: number; skills: number; builtinTools: number; mcpTools: number }
    },
  ) {
    const { sessions } = this.ctx
    let step = 0

    const chunk = (c: StreamChunk) =>
      sessions.append(sessionId, 'assistant/chunk', { turn, step, chunk: c })

    return async (event: AgentEvent) => {
      switch (event.type) {
        case 'turn_start': {
          step += 1
          await sessions.append(sessionId, 'step/start', { turn, step })
          // 每一步的有效提示词与工具表：链路视图的 SYSTEM 段读的就是这条。
          await sessions.append(sessionId, 'request/header', {
            turn,
            step,
            provider: used.provider,
            model: used.model,
            system: used.system,
            tools: used.tools.map((t) => ({ name: t.name, description: t.description })),
            contextWindow: used.contextWindow,
            sections: used.sections,
          })
          break
        }

        case 'message_update': {
          const e = event.assistantMessageEvent as any
          const index = e.contentIndex ?? 0
          if (e.type === 'text_start') await chunk({ type: 'block-start', index, kind: 'text' })
          else if (e.type === 'text_delta') await chunk({ type: 'text-delta', index, text: e.delta })
          else if (e.type === 'thinking_start')
            await chunk({ type: 'block-start', index, kind: 'reasoning' })
          else if (e.type === 'thinking_delta')
            await chunk({ type: 'reasoning-delta', index, text: e.delta })
          else if (e.type === 'text_end' || e.type === 'thinking_end')
            await chunk({ type: 'block-end', index })
          break
        }

        case 'turn_end': {
          const msg = event.message as any
          const content = fromAgentContent(msg?.content ?? [])
          // 空消息不入日志：模型调用失败时 pi 也会发一次 turn_end，内容是空的，
          // 记下来只会在对话和链路视图里留一条什么都没有的气泡。
          if (!content.length) {
            await sessions.append(sessionId, 'step/end', { turn, step })
            break
          }
          await sessions.append(sessionId, 'assistant/message', {
            turn,
            step,
            message: {
              id: msg?.id ?? randomUUID(),
              role: 'assistant',
              content,
            },
            usage: toUsage(msg?.usage),
          })
          await sessions.append(sessionId, 'step/end', { turn, step })
          break
        }

        case 'tool_execution_start':
          await sessions.append(sessionId, 'tool/call', {
            turn,
            step,
            callId: event.toolCallId,
            name: event.toolName,
            arguments: JSON.stringify(event.args ?? {}),
          })
          break

        case 'tool_execution_end':
          await sessions.append(sessionId, 'tool/result', {
            turn,
            step,
            callId: event.toolCallId,
            text: textOf(event.result),
            failed: Boolean(event.isError),
          })
          break
      }
    }
  }
}

function textOf(result: any): string {
  if (typeof result === 'string') return result
  const content = result?.content
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? '').join('')
  return JSON.stringify(result ?? null)
}

/**
 * 估算 token 数。
 *
 * 没有分词器，也不该为了输入框上一行灰字去装一个：那要么按模型各配一份词表，要么把
 * 整段提示词再跑一遍分词。CJK 大致一字一 token，其余按 ~3.6 字符一 token，够撑一条
 * 「占了多少」的提示。**总量不用它**——那个是模型自己回报的，见 usage。
 */
function estTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  return Math.round(cjk + (text.length - cjk) / 3.6)
}

/** 工具表进模型时的实际形状。参数表往往比描述还大，只量描述会差出一大截。 */
function toolsText(tools: { name: string; description: string; parameters?: unknown }[]): string {
  return tools
    .map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters ?? {} }))
    .join('')
}

function toUsage(u: any): Usage {
  if (!u) return EMPTY_USAGE
  return {
    inputTokens: u.input ?? 0,
    outputTokens: u.output ?? 0,
    cacheReadTokens: u.cacheRead ?? 0,
    reasoningTokens: u.reasoning ?? 0,
    cost: u.cost?.total,
  }
}

/** pi 的内容块 → 我们的。 */
function fromAgentContent(content: any[]): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const c of content) {
    if (c?.type === 'text') out.push({ type: 'text', text: c.text })
    else if (c?.type === 'thinking') out.push({ type: 'reasoning', text: c.thinking ?? c.text ?? '' })
    else if (c?.type === 'toolCall')
      out.push({
        type: 'tool-call',
        callId: c.id,
        name: c.name,
        arguments: JSON.stringify(c.arguments ?? {}),
      })
  }
  return out
}

/**
 * 从日志重建 pi 的历史。
 *
 * 只读三种事件；推理块不回传——它是给人看的，回传既费 token 又可能干扰下一轮。
 *
 * **顺序要重排**：日志按真实时序记录，而 pi 在 `turn_end` 才给出最终助手消息，
 * 所以带 tool-call 的那条排在它自己的 tool/result 之后。直接按 seq 喂回去，
 * provider 会拒绝——「role 'tool' 必须紧跟在带 tool_calls 的消息之后」。
 * 这里把每个 step 的工具结果挂到该 step 助手消息的后面。
 */
function toAgentMessages(
  events: Awaited<ReturnType<Context['sessions']['events']>>,
  model: { api?: string; provider?: string; id?: string } = {},
): AgentMessage[] {
  const ts = Date.now()
  const stepKey = (t: number, s: number) => `${t}:${s}`

  // 先找出每个 step 的助手消息落在哪个 seq，工具结果据此排到它后面。
  const assistantSeq = new Map<string, number>()
  for (const e of events) {
    if (e.type === 'assistant/message') {
      assistantSeq.set(stepKey(e.data.turn, e.data.step), e.seq)
    }
  }

  const entries: { order: number; message: AgentMessage }[] = []
  let resultIndex = 0

  for (const e of events) {
    if (e.type === 'user/message') {
      entries.push({
        order: e.seq,
        message: { role: 'user', content: textFrom(e.data.message), timestamp: ts } as AgentMessage,
      })
    } else if (e.type === 'assistant/message') {
      const content = e.data.message.content
        .filter((c) => c.type !== 'reasoning')
        .map((c) =>
          c.type === 'tool-call'
            ? { type: 'toolCall', id: c.callId, name: c.name, arguments: safeParse(c.arguments) }
            : { type: 'text', text: (c as { text: string }).text },
        )
      if (!content.length) continue
      // 重建的助手消息必须跟 pi 自己产出的**同形**：除了 content，还要带 usage 与
      // api/provider/model。少了 usage，pi 在后续轮次读它的 totalTokens 时会炸——
      // 症状是第一轮正常、第二轮起全部失败。
      entries.push({
        order: e.seq,
        message: {
          role: 'assistant',
          content,
          api: model.api ?? 'unknown',
          provider: model.provider ?? 'unknown',
          model: model.id ?? 'unknown',
          usage: piUsage(e.data.usage),
          timestamp: ts,
        } as any,
      })
    } else if (e.type === 'tool/result') {
      const anchor = assistantSeq.get(stepKey(e.data.turn, e.data.step)) ?? e.seq
      entries.push({
        // 小数偏移把结果排到锚点之后、下一条整数 seq 之前，同时保持批内先后。
        order: anchor + 1e-6 * ++resultIndex,
        message: {
          role: 'toolResult',
          toolCallId: e.data.callId,
          toolName: '',
          content: [{ type: 'text', text: e.data.text }],
          isError: e.data.failed,
          timestamp: ts,
        } as any,
      })
    }
  }

  return entries.sort((a, b) => a.order - b.order).map((x) => x.message)
}

const textFrom = (m: Message) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join('')

/** 我们的 usage → pi 的形状。字段名不同，且它多一个 totalTokens 与分项成本。 */
function piUsage(u: Usage | undefined) {
  const input = u?.inputTokens ?? 0
  const output = u?.outputTokens ?? 0
  return {
    input,
    output,
    cacheRead: u?.cacheReadTokens ?? 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u?.cost ?? 0 },
  }
}

function safeParse(s: string): unknown {
  try {
    return s.trim() ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}

export const name = 'satu-agent'
export const inject = ['sessions', 'llm', 'tools', 'storage', 'catalog']

export function apply(ctx: Context, config: Config = {}) {
  ctx.plugin(AgentService, config)
}
