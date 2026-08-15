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
}

export const name = 'satu-llm'
export const inject = ['storage']

export function apply(ctx: Ctx) {
  ctx.plugin(LlmService)
}
