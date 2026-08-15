import { Service, type Context } from '@deepseek-ai/cordis'
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
  /** 一个 turn 内最多几步。防的是工具调用打转，不是正常的多步推理。 */
  maxSteps?: number
}

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }

/**
 * Agent 循环。
 *
 * 一个 **turn** 是一次用户输入引发的全部工作；一个 **step** 是一次模型请求加上它
 * 触发的工具调用。工具还欠结果就再走一步，直到模型不再调工具。
 *
 * 模型看到的历史**完全从会话日志派生**——没有第二份内存里的对话状态。这条不是
 * 洁癖：调用链路那屏要能回放「模型当时到底看到了什么」，只有日志是唯一事实来源时
 * 才做得到。
 */
export class AgentService extends Service {
  private running = new Set<string>()

  constructor(
    ctx: Context,
    private config: Config = {},
  ) {
    super(ctx, 'agents')
  }

  get provider() {
    return this.config.provider ?? 'deepseek'
  }
  get model() {
    return this.config.model ?? 'deepseek-chat'
  }

  isRunning(sessionId: string) {
    return this.running.has(sessionId)
  }

  /** 收一条用户输入，跑一个完整 turn。返回时 turn 已经写完日志。 */
  async send(sessionId: string, text: string): Promise<void> {
    if (this.running.has(sessionId)) throw new Error('agents: 该会话正在运行中')
    this.running.add(sessionId)
    try {
      await this.runTurn(sessionId, text)
    } finally {
      this.running.delete(sessionId)
    }
  }

  private async runTurn(sessionId: string, text: string) {
    const { sessions, tools, llm } = this.ctx
    const events = await sessions.events(sessionId)
    const turn = events.filter((e) => e.type === 'turn/start').length + 1

    await sessions.append(sessionId, 'user/message', {
      message: { id: randomUUID(), role: 'user', content: [{ type: 'text', text }] },
      source: { kind: 'user' },
    })
    await sessions.append(sessionId, 'turn/start', { turn })

    let reason: 'completed' | 'error' | 'aborted' = 'completed'
    try {
      const maxSteps = this.config.maxSteps ?? 12
      for (let step = 1; step <= maxSteps; step++) {
        const outcome = await this.runStep(sessionId, turn, step)
        if (outcome === 'error') {
          reason = 'error'
          break
        }
        if (outcome === 'done') break
        // 走到上限还在调工具，多半是打转了，按错误收尾而不是静默截断。
        if (step === maxSteps) reason = 'error'
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
      await sessions.append(sessionId, 'turn/end', { turn, reason })
    }
    void tools
    void llm
  }

  /**
   * 跑一步。
   *
   * 返回 'more' 表示工具还欠结果、需要再来一步；'done' 是正常收尾；'error' 是模型
   * 侧失败——注意失败是**返回**的（finish 事件），不是抛出的，所以必须显式检查，
   * 否则一个出错的 turn 会被记成 completed。
   */
  private async runStep(sessionId: string, turn: number, step: number): Promise<'more' | 'done' | 'error'> {
    const { sessions, tools, llm } = this.ctx
    await sessions.append(sessionId, 'step/start', { turn, step })

    const system = this.config.system ?? '你是 Satuwork 的 AI 员工，用简洁、专业的中文回答。'
    const schemas = tools.schemas()
    const messages = deriveMessages(await sessions.events(sessionId))

    // 有效提示词与工具表逐步落库：链路视图的 SYSTEM 段读的就是这条。
    await sessions.append(sessionId, 'request/header', {
      turn,
      step,
      provider: this.provider,
      model: this.model,
      system,
      tools: schemas.map((t) => ({ name: t.name, description: t.description })),
    })

    const blocks = new Map<number, ContentBlock>()
    let usage = EMPTY_USAGE
    let finish: StreamChunk | undefined

    for await (const chunk of llm.stream({
      provider: this.provider,
      model: this.model,
      system,
      messages,
      tools: schemas,
    })) {
      await sessions.append(sessionId, 'assistant/chunk', { turn, step, chunk })
      applyChunk(blocks, chunk)
      if (chunk.type === 'usage') usage = chunk.usage
      if (chunk.type === 'finish') finish = chunk
    }

    let content = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b)

    // 模型侧失败要在对话里看得见，否则用户面对的是一片空白。
    if (finish?.type === 'finish' && finish.reason === 'error') {
      content = [...content, { type: 'text', text: `模型调用失败：${finish.error ?? '未知原因'}` }]
    }
    await sessions.append(sessionId, 'assistant/message', {
      turn,
      step,
      message: { id: randomUUID(), role: 'assistant', content },
      usage,
    })

    if (finish?.type === 'finish' && finish.reason === 'error') {
      await sessions.append(sessionId, 'step/end', { turn, step })
      return 'error'
    }

    const calls = content.filter((c) => c.type === 'tool-call')
    if (!calls.length) {
      await sessions.append(sessionId, 'step/end', { turn, step })
      return 'done'
    }

    for (const call of calls) {
      if (call.type !== 'tool-call') continue
      await sessions.append(sessionId, 'tool/call', {
        turn,
        step,
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
      })
      const result = await tools.execute({
        callId: call.callId,
        name: call.name,
        arguments: call.arguments,
        sessionId,
      })
      await sessions.append(sessionId, 'tool/result', {
        turn,
        step,
        callId: call.callId,
        text: result.text,
        failed: Boolean(result.failed),
      })
    }

    await sessions.append(sessionId, 'step/end', { turn, step })
    return 'more'
  }
}

/** 流式增量落回内容块。索引是块序号，同一块的增量累加。 */
function applyChunk(blocks: Map<number, ContentBlock>, chunk: StreamChunk) {
  switch (chunk.type) {
    case 'block-start':
      blocks.set(
        chunk.index,
        chunk.kind === 'tool-call'
          ? { type: 'tool-call', callId: '', name: '', arguments: '' }
          : chunk.kind === 'reasoning'
            ? { type: 'reasoning', text: '' }
            : { type: 'text', text: '' },
      )
      break
    case 'text-delta': {
      const b = blocks.get(chunk.index)
      if (b?.type === 'text') b.text += chunk.text
      break
    }
    case 'reasoning-delta': {
      const b = blocks.get(chunk.index)
      if (b?.type === 'reasoning') b.text += chunk.text
      break
    }
    case 'tool-call-delta': {
      const b = blocks.get(chunk.index)
      if (b?.type !== 'tool-call') break
      if (chunk.callId) b.callId = chunk.callId
      if (chunk.name) b.name = chunk.name
      if (chunk.arguments) b.arguments += chunk.arguments
      break
    }
  }
}

/**
 * 从日志派生模型历史。
 *
 * 只读三种事件：用户消息、助手消息、工具结果。推理块不回传——它是给人看的，
 * 回传既费 token 又可能干扰下一轮。
 */
function deriveMessages(events: Awaited<ReturnType<Context['sessions']['events']>>): Message[] {
  const out: Message[] = []
  for (const e of events) {
    if (e.type === 'user/message') {
      out.push(e.data.message)
    } else if (e.type === 'assistant/message') {
      const content = e.data.message.content.filter((c) => c.type !== 'reasoning')
      if (content.length) out.push({ ...e.data.message, content })
    } else if (e.type === 'tool/result') {
      out.push({
        id: `r-${e.data.callId}`,
        role: 'user',
        content: [{ type: 'tool-result', callId: e.data.callId, text: e.data.text, failed: e.data.failed }],
      })
    }
  }
  return out
}

export const name = 'satu-agent'
export const inject = ['sessions', 'llm', 'tools']

export function apply(ctx: Context, config: Config = {}) {
  ctx.plugin(AgentService, config)
}
