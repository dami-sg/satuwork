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
    return this.live.has(sessionId)
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
    if (this.live.has(sessionId)) throw new Error('agents: 该会话正在运行中')

    const { sessions, llm } = this.ctx
    const model = (llm.models as any).getModel(this.provider, this.model)
    if (!model) throw new Error(`agents: 目录里没有 ${this.provider}/${this.model}`)

    const history = await sessions.events(sessionId)
    const turn = history.filter((e) => e.type === 'turn/start').length + 1

    await sessions.append(sessionId, 'user/message', {
      message: { id: randomUUID(), role: 'user', content: [{ type: 'text', text }] },
      source: { kind: 'user' },
    })
    await sessions.append(sessionId, 'turn/start', { turn })

    const agent = new Agent({
      initialState: {
        systemPrompt: this.system,
        model,
        messages: toAgentMessages(history),
        tools: this.bridgeTools(sessionId),
      },
      streamFn: (llm.models as any).streamSimple.bind(llm.models),
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      sessionId,
    } as any)

    this.live.set(sessionId, agent)
    const off = agent.subscribe(this.projector(sessionId, turn))

    let reason: 'completed' | 'error' | 'aborted' = 'completed'
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
    }
  }

  /**
   * 把 ctx.tools 的注册表桥成 pi 的 AgentTool。
   *
   * 两边的失败约定相反：我们的 execute **永远 resolve**（业务失败写进 text），
   * pi 要求**失败抛异常**。所以只有管道层失败（`failed`）才抛——业务失败照常作为
   * 内容返回，模型读得到、能自己重试。
   */
  private bridgeTools(sessionId: string) {
    return this.ctx.tools.schemas().map((schema) => ({
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

  /**
   * pi 的事件 → 我们的会话日志。
   *
   * 名称对不上要留意：pi 的一个 **turn** 是「一次模型调用加它的工具」，也就是我们
   * 的 **step**；我们的 turn 是一次用户输入引发的全部工作。
   */
  private projector(sessionId: string, turn: number) {
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
            provider: this.provider,
            model: this.model,
            system: this.system,
            tools: this.ctx.tools
              .schemas()
              .map((t) => ({ name: t.name, description: t.description })),
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
 */
function toAgentMessages(
  events: Awaited<ReturnType<Context['sessions']['events']>>,
): AgentMessage[] {
  const out: AgentMessage[] = []
  const ts = Date.now()
  for (const e of events) {
    if (e.type === 'user/message') {
      out.push({ role: 'user', content: textFrom(e.data.message), timestamp: ts } as AgentMessage)
    } else if (e.type === 'assistant/message') {
      const content = e.data.message.content
        .filter((c) => c.type !== 'reasoning')
        .map((c) =>
          c.type === 'tool-call'
            ? { type: 'toolCall', id: c.callId, name: c.name, arguments: safeParse(c.arguments) }
            : { type: 'text', text: (c as { text: string }).text },
        )
      if (content.length) out.push({ role: 'assistant', content, timestamp: ts } as any)
    } else if (e.type === 'tool/result') {
      out.push({
        role: 'toolResult',
        toolCallId: e.data.callId,
        toolName: '',
        content: [{ type: 'text', text: e.data.text }],
        isError: e.data.failed,
        timestamp: ts,
      } as any)
    }
  }
  return out
}

const textFrom = (m: Message) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join('')

function safeParse(s: string): unknown {
  try {
    return s.trim() ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}

export const name = 'satu-agent'
export const inject = ['sessions', 'llm', 'tools', 'storage']

export function apply(ctx: Context, config: Config = {}) {
  ctx.plugin(AgentService, config)
}
