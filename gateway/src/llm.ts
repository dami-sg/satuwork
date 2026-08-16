import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { Db } from './db.ts'

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
  source: 'builtin' | 'company'
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
  const keys = aliases[provider] ?? [`${provider.toUpperCase().replace(/-/g, '_')}_API_KEY`]
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

  constructor(private db: Db) {}

  catalog(companyId: string | null): CatalogModel[] {
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
          source: 'builtin',
        })
      }
    }
    for (const item of this.db.visibleCatalog('model', companyId || null)) {
      const def = (item.definition ?? {}) as Record<string, unknown>
      const provider = String(def.provider ?? item.name ?? '').trim()
      const id = String(def.id ?? def.model ?? item.name ?? '').trim()
      if (!provider || !id) continue
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
        source: 'company',
      })
    }
    const enabled = this.db.platformSettings().enabledModels
    if (Array.isArray(enabled) && enabled.length) {
      const allow = new Set(enabled)
      return out.filter((m) => allow.has(`${m.provider}/${m.id}`))
    }
    return out
  }

  find(companyId: string | null, raw: string, hint?: string): CatalogModel | undefined {
    const ref = parseModelRef(raw, hint)
    const list = this.catalog(companyId)
    if (ref.provider && ref.id) {
      return list.find((m) => m.provider === ref.provider && m.id === ref.id)
    }
    if (ref.id) {
      const hits = list.filter((m) => m.id === ref.id)
      if (hits.length === 1) return hits[0]
      if (hint) return hits.find((m) => m.provider === hint)
    }
    return undefined
  }

  /**
   * 平台表优先，否则环境变量，否则公司密钥（过渡期回落）。
   * 调用方拿去调上游，响应里不得出现这个字符串。
   */
  secret(companyId: string | null, provider: string): string | undefined {
    const platform = this.db.platformCredential(provider)
    if (platform?.secret) return platform.secret
    const env = envSecret(provider)
    if (env) return env
    if (companyId) {
      const company = this.db.credentialByProvider(companyId, provider)
      if (company?.secret) return company.secret
    }
    return undefined
  }

  piModel(provider: string, id: string) {
    return this.models.getModel(provider, id)
  }

  firstModel(companyId: string | null, provider: string): string {
    const list = this.catalog(companyId).filter((m) => m.provider === provider)
    const cheap = list.find((m) => /flash|mini|haiku|lite|nano/i.test(m.id))
    return (cheap || list[0])?.id || ''
  }

  async probe(companyId: string | null, provider: string, model: string): Promise<ProbeResult> {
    const found = this.find(companyId, model, provider)
    if (!found) return { ok: false, provider, model, latencyMs: 0, error: '模型不在可见目录里' }
    const secret = this.secret(companyId, found.provider)
    if (!secret) return { ok: false, provider: found.provider, model: found.id, latencyMs: 0, error: `没有 ${found.provider} 的密钥` }
    const piModel = this.piModel(found.provider, found.id)
    if (!piModel) return { ok: false, provider: found.provider, model: found.id, latencyMs: 0, error: '模型不在可见目录里' }
    const started = Date.now()
    try {
      const message = await this.models.completeSimple(
        piModel as any,
        {
          messages: [{ role: 'user', content: 'Reply with exactly: ok', timestamp: Date.now() }],
        } as any,
        { apiKey: secret, maxTokens: 16, temperature: 0 },
      )
      const latencyMs = Date.now() - started
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
        error: redact((e as Error).message || 'upstream error', secret),
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
