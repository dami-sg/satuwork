import { Service, type Context as Ctx } from '@deepseek-ai/cordis'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import { createCredentialStore } from './credentials.ts'

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

/**
 * 模型能力接缝，底下是 [`@earendil-works/pi-ai`](https://github.com/earendil-works/pi)。
 *
 * 不自己写任何一家的适配器：pi-ai 带 40 家 provider 的目录、线协议、鉴权（含 OAuth）
 * 和**单价**，加一个 provider 是配置不是代码。
 *
 * 这个服务只管**目录与凭据**：模型的流式调用由 agent 层直接用 pi 的
 * `models.streamSimple`，事件在那里投影进我们自己的会话日志——翻译放在写日志的
 * 地方，比在这里再包一层更少一次转手。
 */
export class LlmService extends Service {
  /** pi-ai 的模型集合。目录查询、鉴权状态这些直接用它的 API。 */
  readonly models

  constructor(ctx: Ctx) {
    super(ctx, 'llm')
    // 把凭据存储接到我们的 SQLite 上：界面上填的 key 存这里，
    // 环境变量退化成「什么都没存时」的回落。
    this.models = builtinModels({ credentials: createCredentialStore(ctx.storage) } as any)
  }

  /** 哪些 provider 已经配了凭据。契约保证这里不会解析出密钥本身。 */
  async configured(): Promise<string[]> {
    const list = await (this.models as any).credentials?.list?.()
    if (list) return list.map((c: { providerId: string }) => c.providerId)
    return []
  }

  /** 存一把 key。传 null 表示删除，之后该 provider 重新回落到环境变量。 */
  async setCredential(providerId: string, key: string | null) {
    const store = createCredentialStore(this.ctx.storage)
    if (!key) return store.delete(providerId)
    await store.modify(providerId, () => ({ type: 'api_key', key }))
  }

  /**
   * 目录里的全部 provider 与模型。
   *
   * 把 pi-ai 的元数据**原样透出来**（上下文窗口、输出上限、单价、是否支持推理），
   * 而不是只给一串 id：模型配置那屏的每一列都在这份数据里，我们不需要另外维护
   * 一张表——那张表迟早会和目录对不上。
   */
  catalog() {
    return this.models.getProviders().map((p: any) => {
      const id = typeof p === 'string' ? p : p.id
      const models = (this.models.getModels(id) ?? []).map((m: any) => ({
        id: m.id,
        name: m.name ?? m.id,
        api: m.api,
        baseUrl: m.baseUrl,
        reasoning: !!m.reasoning,
        input: m.input ?? ['text'],
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        /** 每 100 万 token 的美元单价。 */
        cost: m.cost,
      }))
      return {
        provider: id,
        name: typeof p === 'string' ? id : (p.name ?? id),
        /** 这家要什么样的凭据。界面据此决定填什么。 */
        auth: typeof p === 'string' ? undefined : p.auth,
        endpoint: models[0]?.baseUrl,
        models,
      }
    })
  }

  /**
   * 凭据已就绪、真的能调的 **provider**。
   *
   * pi-ai 的 `getAvailable()` 返回的是**模型**列表，不是 provider——按 provider 去重
   * 是这里的事。它比 `configured()` 宽：只设了环境变量、没在界面里存过 key 的那些
   * 也算就绪。
   */
  async available(): Promise<string[]> {
    try {
      const list = await this.models.getAvailable()
      return [...new Set(list.map((m: any) => (typeof m === 'string' ? m : (m.provider ?? m.id))))]
    } catch {
      return []
    }
  }
}

export const name = 'satu-llm'
export const inject = ['storage']

export function apply(ctx: Ctx) {
  ctx.plugin(LlmService)
}
