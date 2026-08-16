import { Service, type Context as Ctx } from '@deepseek-ai/cordis'
import { gatewayApiKey, gatewayUrl, streamViaGateway, stubModel } from './gateway.ts'
import { AssistantMessageEventStream, emptyAssistant } from './stream.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: LlmService
  }
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface CatalogProvider {
  provider: string
  name: string
  endpoint?: string
  models: {
    id: string
    name: string
    api?: string
    reasoning?: boolean
    contextWindow?: number
    maxTokens?: number
    cost?: unknown
  }[]
}

/**
 * 模型接缝：Gateway 的薄客户端。
 *
 * 目录与补全都打 GATEWAY_URL 的 /v1/*。本进程不持有 provider 密钥，也不依赖 pi-ai。
 * 流式结果映射成 pi-agent-core 的 streamFn，会话投影不用改。
 */
export class LlmService extends Service {
  private cached: CatalogProvider[] = []

  constructor(ctx: Ctx) {
    super(ctx, 'llm')
  }

  get url() {
    return gatewayUrl()
  }

  /** 发给 pi-agent-core 的 streamFn。失败编码进流，不抛。 */
  streamFn = (model: any, context: any, options?: any) => {
    if (process.env.E2E_STUB_LLM === '1') return stubLlmStream(model)
    return streamViaGateway(model, context, options)
  }

  modelOf(provider: string, id: string) {
    return stubModel(provider, id)
  }

  async configured(): Promise<string[]> {
    return []
  }

  async available(): Promise<string[]> {
    const cat = await this.refresh()
    return [...new Set(cat.map((p) => p.provider))]
  }

  catalog(): CatalogProvider[] {
    return this.cached
  }

  async refresh(): Promise<CatalogProvider[]> {
    const base = gatewayUrl()
    const apiKey = gatewayApiKey()
    if (!base || !apiKey) {
      this.cached = []
      return this.cached
    }
    try {
      const r = await fetch(base + '/v1/models', { headers: { authorization: `Bearer ${apiKey}` } })
      if (!r.ok) {
        this.cached = []
        return this.cached
      }
      const body = (await r.json()) as { data?: any[] }
      const by = new Map<string, CatalogProvider>()
      for (const m of body.data ?? []) {
        const provider = String(m.provider || m.owned_by || 'unknown')
        const id = String(m.model || String(m.id || '').split('/').pop() || m.id)
        if (!by.has(provider)) {
          by.set(provider, { provider, name: provider, models: [] })
        }
        by.get(provider)!.models.push({
          id,
          name: m.name ?? id,
          api: m.api,
          reasoning: !!m.reasoning,
          contextWindow: m.context_window,
          maxTokens: m.max_tokens,
          cost: m.cost,
        })
      }
      this.cached = [...by.values()]
      return this.cached
    } catch {
      this.cached = []
      return this.cached
    }
  }
}

export const name = 'satu-llm'
export const inject = ['storage']

export function apply(ctx: Ctx) {
  ctx.plugin(LlmService)
  ctx.inject(['llm'], (ctx: Ctx) => {
    void ctx.llm.refresh()
  })
}

/** 只在 E2E_STUB_LLM=1 时走。仍经过 Agent.send，会写下 request/header。不假装模型成功。 */
function stubLlmStream(model: any) {
  const stream = new AssistantMessageEventStream()
  queueMicrotask(() => {
    const error = emptyAssistant(model, 'E2E_STUB_LLM')
    stream.push({ type: 'error', reason: 'error', error })
    stream.end()
  })
  return stream
}
