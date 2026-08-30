import type { Provider } from '@earendil-works/pi-ai'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { Db } from './db.ts'
import { overlayProvider, resolveOverlay, type DiscoverySnapshot } from './model-discovery.ts'
import { buildProvider, customEnvVar, isModelId, parseProviderDef, PROVIDER_ID_RE, type CustomProviderDef } from './providers.ts'

export interface CatalogModel {
  provider: string
  id: string
  name: string
  api?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
  input?: ('text' | 'image')[]
  cost?: unknown
  source: 'builtin' | 'company' | 'custom' | 'discovered'
}

export interface ModelRef {
  provider: string
  id: string
}

export interface ProbeResult {
  ok: boolean
  provider: string
  model: string
  latencyMs: number
  excerpt?: string
  error?: string
}

/** 连通性测试的上限。上游卡住时页面上那颗按钮不能一直转。 */
const PROBE_TIMEOUT_MS = 20_000

export function openaiModelId(m: { provider: string; id: string }): string {
  return `${m.provider}/${m.id}`
}

/** 常见 provider 的环境变量名。只在 Gateway 进程里读，绝不下发。 */
export function envSecret(provider: string): string | undefined {
  const aliases: Record<string, string[]> = {
    deepseek: ['DEEPSEEK_API_KEY'],
    openai: ['OPENAI_API_KEY'],
    anthropic: ['ANTHROPIC_API_KEY'],
    google: ['GOOGLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    groq: ['GROQ_API_KEY'],
    openrouter: ['OPENROUTER_API_KEY'],
    xai: ['XAI_API_KEY'],
    mistral: ['MISTRAL_API_KEY'],
  }
  const keys = aliases[provider] ?? [
    `${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`,
    // 自定义供应商用带前缀的名字，免得撞上机器上别的同名变量。
    customEnvVar(provider),
  ]
  for (const k of keys) {
    const v = process.env[k]?.trim()
    if (v) return v
  }
}

export function parseModelRef(raw: string, hint?: string): ModelRef {
  const s = String(raw || '').trim()
  if (!s) return { provider: hint || '', id: '' }
  const slash = s.indexOf('/')
  if (slash > 0) return { provider: s.slice(0, slash), id: s.slice(slash + 1) }
  return { provider: hint || '', id: s }
}

/**
 * Gateway 上的模型目录与密钥解析。pi-ai 只活在这里。
 *
 * 可见集 = pi-ai 内置全局目录 ∪ 该公司 catalog 里的 model。
 * 若平台 enabledModels 非空，再按 openai id（provider/id）过滤。
 * 密钥：平台表 > 进程环境变量 > 公司（过渡期回落）。永远不回显。
 */
export class Llm {
  readonly models = builtinModels()
  /** 内置 provider 的 id。自定义的绝不能顶掉它们，同步时也不能把它们删了。 */
  private readonly builtinIds = new Set(builtinModels().getProviders().map((p) => p.id))
  private registered = new Set<string>()
  private fingerprint = ''

  /**
   * 内置 provider 的原件。套壳前先留一份，因为补模型是 `setProvider(套壳后的)`——
   * 不留原件的话，第二次同步就会拿**上一层壳**再套一层，壳叠壳，上一轮补进去的
   * 模型也会跟着漏到下一轮，撤不掉。
   */
  private readonly originals = new Map<string, Provider>()
  /** 当前被套了壳的 provider。发现结果变空时要按这个名单还原。 */
  private overlaid = new Set<string>()
  private discoveryFingerprint = ''
  /** `provider/id`，catalog() 拿它给这些模型打「自动发现」的标。 */
  private discoveredKeys = new Set<string>()

  constructor(private db: Db) {
    for (const p of this.models.getProviders()) this.originals.set(p.id, p)
  }

  isBuiltinProvider(id: string): boolean {
    return this.builtinIds.has(id)
  }

  builtinProviderIds(): ReadonlySet<string> {
    return this.builtinIds
  }

  /**
   * 把库里的自定义供应商灌进 pi-ai 的注册表。
   *
   * 每次要用目录之前都走一遍：定义存在库里，可能是别的进程改的，光靠进程内的
   * 事件通知会漏。变了才重建——指纹一样就直接返回，热路径上不做无谓的工作。
   */
  async syncCustomProviders(): Promise<CustomProviderDef[]> {
    const defs: CustomProviderDef[] = []
    for (const item of await this.db.visibleCatalog('provider', null)) {
      try {
        const def = parseProviderDef(item.definition)
        // 撞上内置 id 就跳过：顶掉 openai 会让所有公司的模型一起哑掉。
        if (this.builtinIds.has(def.id)) continue
        defs.push(def)
      } catch {
        // 库里存着一条坏定义，不该让整个目录跟着塌。跳过它。
      }
    }
    const fp = JSON.stringify(defs)
    if (fp === this.fingerprint) return defs
    const next = new Set(defs.map((d) => d.id))
    for (const id of this.registered) {
      if (!next.has(id) && !this.builtinIds.has(id)) this.models.deleteProvider(id)
    }
    for (const def of defs) this.models.setProvider(buildProvider(def))
    this.registered = next
    this.fingerprint = fp
    return defs
  }

  /**
   * 把库里那份「自动发现」的快照铺到注册表上（见 model-discovery.ts）。
   *
   * 和 syncCustomProviders 一样每次都读库、按指纹决定要不要重建：写这一行的是
   * 后台刷新任务，多进程部署时它可能跑在**另一个网关进程**里，只靠进程内的通知
   * 一定会漏。
   */
  async syncDiscovered(): Promise<number> {
    let snap: DiscoverySnapshot
    try {
      snap = await this.db.discoveredModels()
    } catch {
      // 读不到就当没有。自动发现是锦上添花，不能因为它让整个目录塌掉。
      return this.discoveredKeys.size
    }
    // 指纹里要带上自定义供应商的那一份：它们也会改变注册表，而推导是拿注册表当
    // 输入的。只按快照做指纹的话，新加一个自定义供应商之后就不会重新推导。
    const fp = `${snap.fetchedAt}|${snap.entries.length}|${snap.deny.join(',')}|${this.fingerprint}`
    if (fp === this.discoveryFingerprint) return this.discoveredKeys.size

    // 传 originals 而不是 this.models：只往内置 provider 上补（自定义供应商的模型
    // 是人手录进去的，那份定义就是权威），而且基线必须是没套过壳的——理由见
    // resolveOverlay 的注释，那是个会让目录来回跳的坑。
    const { extras } = resolveOverlay(this.originals.values(), snap.entries, new Set(snap.deny))
    const keys = new Set<string>()
    for (const [providerId, add] of extras) {
      const base = this.originals.get(providerId)!
      this.models.setProvider(overlayProvider(base, add))
      for (const m of add) keys.add(`${providerId}/${m.id}`)
    }
    for (const id of this.overlaid) {
      if (extras.has(id)) continue
      const base = this.originals.get(id)
      if (base) this.models.setProvider(base)
    }
    this.overlaid = new Set(extras.keys())
    this.discoveredKeys = keys
    this.discoveryFingerprint = fp
    return keys.size
  }

  async catalog(companyId: string | null): Promise<CatalogModel[]> {
    const custom = new Set((await this.syncCustomProviders()).map((d) => d.id))
    // 必须排在 syncCustomProviders 后面：发现结果的指纹里带着自定义供应商那一份，
    // 反过来的话这一轮读到的是上一轮的旧指纹，注册表已经变了却不会重新推导。
    await this.syncDiscovered()
    const discovered = this.discoveredKeys
    const out: CatalogModel[] = []
    const seen = new Set<string>()
    for (const p of this.models.getProviders()) {
      for (const m of this.models.getModels(p.id) ?? []) {
        const key = `${p.id}/${m.id}`
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          provider: p.id,
          id: m.id,
          name: (m as { name?: string }).name ?? m.id,
          api: (m as { api?: string }).api,
          contextWindow: (m as { contextWindow?: number }).contextWindow,
          maxTokens: (m as { maxTokens?: number }).maxTokens,
          reasoning: !!(m as { reasoning?: boolean }).reasoning,
          input: Array.isArray((m as { input?: unknown }).input)
            ? ((m as { input: ('text' | 'image')[] }).input.filter((x) => x === 'text' || x === 'image'))
            : ['text'],
          cost: (m as { cost?: unknown }).cost,
          source: custom.has(p.id) ? 'custom' : discovered.has(key) ? 'discovered' : 'builtin',
        })
      }
    }
    for (const item of await this.db.visibleCatalog('model', companyId || null)) {
      const def = (item.definition ?? {}) as Record<string, unknown>
      const provider = String(def.provider ?? item.name ?? '').trim()
      const id = String(def.id ?? def.model ?? item.name ?? '').trim()
      if (!provider || !id) continue
      // provider 会被 envSecret 拼成 `<PROVIDER>_API_KEY` 去索引 process.env，所以它
      // 不能是任意字符串：一条 `{"provider":"stripe"}` 的公司模型就能让网关拿着
      // STRIPE_API_KEY 去打模型接口。形状不对的条目直接不进目录。
      if (!PROVIDER_ID_RE.test(provider) || !isModelId(id)) continue
      const key = `${provider}/${id}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        provider,
        id,
        name: String(def.name ?? item.name ?? id),
        api: typeof def.api === 'string' ? def.api : undefined,
        input: Array.isArray(def.input)
          ? (def.input as unknown[]).filter((x): x is 'text' | 'image' => x === 'text' || x === 'image')
          : ['text'],
        contextWindow: typeof def.contextWindow === 'number' ? def.contextWindow : undefined,
        maxTokens: typeof def.maxTokens === 'number' ? def.maxTokens : undefined,
        reasoning: Boolean(def.reasoning),
        // 之前这里没带 cost，界面上这类模型的单价一律是空的。
        cost: def.cost,
        source: 'company',
      })
    }
    const enabled = (await this.db.platformSettings()).enabledModels
    if (Array.isArray(enabled) && enabled.length) {
      const allow = new Set(enabled)
      return out.filter((m) => allow.has(`${m.provider}/${m.id}`))
    }
    return out
  }

  async find(companyId: string | null, raw: string, hint?: string): Promise<CatalogModel | undefined> {
    const ref = parseModelRef(raw, hint)
    const list = await this.catalog(companyId)
    if (ref.provider && ref.id) {
      const hit = list.find((m) => m.provider === ref.provider && m.id === ref.id)
      if (hit) return hit
    }
    // 模型 id 自己带斜杠时（`openai/gpt-4o` 这种），上面那一刀会把前半段当成 provider。
    // 切错了就把整条再当作裸 id 找一遍——唯一命中，或者跟 hint 的供应商对得上，才算数。
    const bare = String(raw || '').trim()
    if (bare) {
      const hits = list.filter((m) => m.id === bare)
      if (hits.length === 1) return hits[0]
      if (hint) return hits.find((m) => m.provider === hint)
    }
    return undefined
  }

  /**
   * 平台表优先，否则环境变量，否则公司密钥（过渡期回落）。
   * 调用方拿去调上游，响应里不得出现这个字符串。
   */
  async secret(companyId: string | null, provider: string): Promise<string | undefined> {
    const platform = await this.db.platformCredential(provider)
    if (platform?.secret) return platform.secret
    const env = envSecret(provider)
    if (env) return env
    if (companyId) {
      const company = await this.db.credentialByProvider(companyId, provider)
      if (company?.secret) return company.secret
    }
    return undefined
  }

  piModel(provider: string, id: string) {
    return this.models.getModel(provider, id)
  }

  async firstModel(companyId: string | null, provider: string): Promise<string> {
    const list = (await this.catalog(companyId)).filter((m) => m.provider === provider)
    const cheap = list.find((m) => /flash|mini|haiku|lite|nano/i.test(m.id))
    return (cheap || list[0])?.id || ''
  }

  async probe(companyId: string | null, provider: string, model: string): Promise<ProbeResult> {
    const found = await this.find(companyId, model, provider)
    if (!found) return { ok: false, provider, model, latencyMs: 0, error: '模型不在可见目录里' }
    const secret = await this.secret(companyId, found.provider)
    if (!secret) return { ok: false, provider: found.provider, model: found.id, latencyMs: 0, error: `没有 ${found.provider} 的密钥` }
    const piModel = this.piModel(found.provider, found.id)
    if (!piModel) return { ok: false, provider: found.provider, model: found.id, latencyMs: 0, error: '模型不在可见目录里' }
    const started = Date.now()
    const abort = AbortSignal.timeout(PROBE_TIMEOUT_MS)
    try {
      const message = await this.models.completeSimple(
        piModel as any,
        {
          messages: [{ role: 'user', content: 'Reply with exactly: ok', timestamp: Date.now() }],
        } as any,
        { apiKey: secret, maxTokens: 16, temperature: 0, signal: abort },
      )
      const latencyMs = Date.now() - started
      if (message?.stopReason === 'aborted' || abort.aborted) {
        return { ok: false, provider: found.provider, model: found.id, latencyMs, error: `${PROBE_TIMEOUT_MS / 1000}s 内没有响应` }
      }
      if (message?.stopReason === 'error' || message?.errorMessage) {
        return {
          ok: false,
          provider: found.provider,
          model: found.id,
          latencyMs,
          error: redact(String(message.errorMessage || 'model error'), secret),
        }
      }
      const text = Array.isArray(message?.content)
        ? message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
        : ''
      return { ok: true, provider: found.provider, model: found.id, latencyMs, excerpt: String(text).slice(0, 80) }
    } catch (e) {
      return {
        ok: false,
        provider: found.provider,
        model: found.id,
        latencyMs: Date.now() - started,
        error: abort.aborted
          ? `${PROBE_TIMEOUT_MS / 1000}s 内没有响应`
          : redact((e as Error).message || 'upstream error', secret),
      }
    }
  }
}

export function createLlm(db: Db) {
  return new Llm(db)
}

export function redact(text: string, secret?: string): string {
  if (!secret || !text) return text
  return text.split(secret).join('[redacted]')
}

export const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
