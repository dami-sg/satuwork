import { Service, type Context as Ctx } from '@deepseek-ai/cordis'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { Message, StreamChunk, Usage } from '../session/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmService
  }
}

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema。TypeBox 产出的就是 JSON Schema，两边通用。 */
  parameters: Record<string, unknown>
}

export interface ModelRequest {
  provider: string
  model: string
  system: string
  messages: Message[]
  tools: ToolSchema[]
  signal?: AbortSignal
}

/**
 * 模型能力接缝，底下是 [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi)。
 *
 * 不自己写任何一家的适配器：pi-ai 带 40 家 provider 的目录、线协议、鉴权（含 OAuth）
 * 和**单价**，加一个 provider 是配置不是代码。
 *
 * 但**对外仍然是我们自己的词汇**：pi-ai 的事件在这里翻译成 StreamChunk 再进日志。
 * 这一层薄翻译是有意的——会话日志是产品资产，它的格式不该跟着某个第三方库的
 * 版本走；哪天换掉 pi-ai，历史不用迁移。
 */
export class LlmService extends Service {
  /** pi-ai 的模型集合。目录查询、鉴权状态这些直接用它的 API。 */
  readonly models = builtinModels()

  constructor(ctx: Ctx) {
    super(ctx, 'llm')
  }

  /** 目录里的全部 provider 与模型。 */
  catalog() {
    return this.models.getProviders().map((p: any) => ({
      provider: typeof p === 'string' ? p : p.id,
      models: (this.models.getModels(typeof p === 'string' ? p : p.id) ?? []).map((m: any) => m.id),
    }))
  }

  /** 凭据已就绪、真的能调的那些。模型下拉读这个，而不是整本目录。 */
  async available(): Promise<string[]> {
    try {
      const list = await this.models.getAvailable()
      return list.map((p: any) => (typeof p === 'string' ? p : p.id))
    } catch {
      return []
    }
  }

  async *stream(req: ModelRequest): AsyncIterable<StreamChunk> {
    const model = this.models.getModel(req.provider, req.model)
    // 找不到路由响亮失败，不静默回落到别的模型——那会让成本和行为都变得不可解释。
    if (!model) throw new Error(`llm: 目录里没有 ${req.provider}/${req.model}`)

    const stream = this.models.stream(model, {
      systemPrompt: req.system,
      messages: req.messages.map(toPi),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    } as any, { signal: req.signal } as any)

    // pi-ai 用 contentIndex 标块，跟我们的 index 语义一致，直接透传。
    for await (const e of stream as AsyncIterable<any>) {
      switch (e.type) {
        case 'text_start':
          yield { type: 'block-start', index: e.contentIndex, kind: 'text' }
          break
        case 'text_delta':
          yield { type: 'text-delta', index: e.contentIndex, text: e.delta }
          break
        case 'thinking_start':
          yield { type: 'block-start', index: e.contentIndex, kind: 'reasoning' }
          break
        case 'thinking_delta':
          yield { type: 'reasoning-delta', index: e.contentIndex, text: e.delta }
          break
        case 'text_end':
        case 'thinking_end':
          yield { type: 'block-end', index: e.contentIndex }
          break
        case 'toolcall_start':
          yield { type: 'block-start', index: e.contentIndex, kind: 'tool-call' }
          break
        case 'toolcall_end':
          // 参数在这里才完整。中途的 delta 不透传：它对 UI 没用，却会让日志膨胀。
          yield {
            type: 'tool-call-delta',
            index: e.contentIndex,
            callId: e.toolCall.id,
            name: e.toolCall.name,
            arguments: JSON.stringify(e.toolCall.arguments ?? {}),
          }
          yield { type: 'block-end', index: e.contentIndex }
          break
        case 'error':
          yield { type: 'finish', reason: 'error', error: e.error?.errorMessage ?? String(e.error) }
          return
      }
    }

    const final = await (stream as any).result()
    yield { type: 'usage', usage: toUsage(final?.usage) }
    yield { type: 'finish', reason: hasToolCall(final) ? 'tool-calls' : 'stop' }
  }
}

function hasToolCall(final: any): boolean {
  return Boolean(final?.content?.some((b: any) => b.type === 'toolCall'))
}

function toUsage(u: any): Usage {
  return {
    inputTokens: u?.input ?? 0,
    outputTokens: u?.output ?? 0,
    cacheReadTokens: u?.cacheRead ?? u?.cache_read ?? 0,
    reasoningTokens: u?.reasoning ?? 0,
    cost: u?.cost?.total,
  }
}

/** 我们的消息 → pi-ai 的 Context.messages。 */
function toPi(m: Message): any {
  const timestamp = Date.now()
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      timestamp,
      content: m.content
        .filter((c) => c.type === 'text' || c.type === 'tool-call')
        .map((c) =>
          c.type === 'tool-call'
            ? { type: 'toolCall', id: c.callId, name: c.name, arguments: safeParse(c.arguments) }
            : { type: 'text', text: (c as { text: string }).text },
        ),
    }
  }
  // 工具结果在我们的模型里挂在 user 消息上；pi-ai 要求独立的 toolResult 角色。
  const result = m.content.find((c) => c.type === 'tool-result')
  if (result?.type === 'tool-result') {
    return {
      role: 'toolResult',
      timestamp,
      toolCallId: result.callId,
      toolName: '',
      content: [{ type: 'text', text: result.text }],
      isError: Boolean(result.failed),
    }
  }
  return {
    role: 'user',
    timestamp,
    content: m.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
  }
}

function safeParse(s: string): unknown {
  try {
    return s.trim() ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}

export const name = 'satu-llm'

export function apply(ctx: Ctx) {
  ctx.plugin(LlmService)
}
