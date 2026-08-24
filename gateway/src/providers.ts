/**
 * 自定义供应商：把库里存的定义还原成 pi-ai 的 Provider。
 *
 * 存的形状**就是** pi-ai `createProvider()` 的入参形状（id / name / baseUrl /
 * api / models），模型条目也是 pi-ai `Model` 的字段。这样内置目录和自定义目录
 * 在下游是同一种东西——`models.getModel()` 找得到，probe 和 /v1/* 才能真的调它。
 * 之前 catalog 里那种「只在列表里出现、piModel 找不到」的模型是调不通的。
 */
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { envApiKeyAuth } from '@earendil-works/pi-ai'
import { createProvider, type Provider } from '@earendil-works/pi-ai'

/** 能挂自定义供应商的 API。都是 pi-ai 的 KnownApi 值，别自己造名字。 */
export const CUSTOM_APIS = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
  'google-generative-ai',
] as const

export type CustomApi = (typeof CUSTOM_APIS)[number]

export const DEFAULT_CUSTOM_API: CustomApi = 'openai-completions'

const API_IMPL: Record<CustomApi, () => ReturnType<typeof openAICompletionsApi>> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
  'google-generative-ai': googleGenerativeAIApi,
}

export interface CustomModelDef {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  reasoning: boolean
  input: ('text' | 'image')[]
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

export interface CustomProviderDef {
  id: string
  name: string
  baseUrl: string
  api: CustomApi
  headers?: Record<string, string>
  models: CustomModelDef[]
}

/** provider id 要能安全地进 URL 和 `provider/model` 这种复合 id，所以不收斜杠。 */
export const PROVIDER_ID_RE = /^[a-z][a-z0-9-]{1,39}$/

/**
 * 模型 id 收斜杠：OpenRouter 的 `openai/gpt-4o`、Fireworks 的
 * `accounts/fireworks/models/…` 就是这个形状，不放行的话这些上游一个都录不进来。
 *
 * 斜杠只能夹在中间做分隔——不能开头、不能结尾、不能连着两个。复合 id
 * `provider/model` 是在**第一个**斜杠上切的（见 parseModelRef），而 provider 那半段
 * 本来就不收斜杠，所以只要模型 id 自己没有空段，切回来的还是原来那一对。
 */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*(?:\/[A-Za-z0-9][A-Za-z0-9._:-]*)*$/
export const MODEL_ID_MAX = 128

export function isModelId(id: string): boolean {
  return id.length <= MODEL_ID_MAX && MODEL_ID_RE.test(id)
}

export class DefError extends Error {}

function fail(msg: string): never {
  throw new DefError(msg)
}

function str(o: Record<string, unknown>, k: string, label: string): string {
  const v = o[k]
  if (typeof v !== 'string' || !v.trim()) fail(`${label}不能为空`)
  return (v as string).trim()
}

function nonNegative(v: unknown, label: string): number {
  if (v == null || v === '') return 0
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) fail(`${label}必须是不小于 0 的数字`)
  return n
}

function positiveInt(v: unknown, label: string, fallback: number): number {
  if (v == null || v === '') return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) fail(`${label}必须是正整数`)
  return n
}

export function parseModelDef(raw: unknown): CustomModelDef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('模型必须是对象')
  const o = raw as Record<string, unknown>
  const id = str(o, 'id', '模型 id')
  if (id.length > MODEL_ID_MAX) fail(`模型 id 最长 ${MODEL_ID_MAX} 个字符`)
  if (!MODEL_ID_RE.test(id)) fail('模型 id 只能是字母数字和 . _ : - /，斜杠只能夹在中间做分隔')
  const cost = (o.cost && typeof o.cost === 'object' ? o.cost : {}) as Record<string, unknown>
  const input = Array.isArray(o.input)
    ? (o.input as unknown[]).filter((x): x is 'text' | 'image' => x === 'text' || x === 'image')
    : ['text' as const]
  return {
    id,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : id,
    contextWindow: positiveInt(o.contextWindow, '上下文窗口', 128_000),
    maxTokens: positiveInt(o.maxTokens, '最大输出', 8_192),
    reasoning: Boolean(o.reasoning),
    input: input.length ? input : ['text'],
    cost: {
      // 单位和 pi-ai 内置目录一致：每 100 万 token 多少美元。
      input: nonNegative(cost.input, '输入单价'),
      output: nonNegative(cost.output, '输出单价'),
      cacheRead: nonNegative(cost.cacheRead, '缓存读单价'),
      cacheWrite: nonNegative(cost.cacheWrite, '缓存写单价'),
    },
  }
}

export function parseProviderDef(raw: unknown): CustomProviderDef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('供应商定义必须是对象')
  const o = raw as Record<string, unknown>
  const id = str(o, 'id', '供应商 id')
  if (!PROVIDER_ID_RE.test(id)) fail('供应商 id 只能是小写字母开头的短名（字母数字和连字符，2–40 位）')
  const baseUrl = str(o, 'baseUrl', 'baseUrl')
  let u: URL
  try {
    u = new URL(baseUrl)
  } catch {
    fail('baseUrl 必须是完整的 http/https 地址')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') fail('baseUrl 必须是 http/https 地址')
  const api = (o.api == null || o.api === '' ? DEFAULT_CUSTOM_API : o.api) as CustomApi
  if (!CUSTOM_APIS.includes(api)) fail(`api 只能是 ${CUSTOM_APIS.join(' / ')}`)

  const headers: Record<string, string> = {}
  if (o.headers != null) {
    if (typeof o.headers !== 'object' || Array.isArray(o.headers)) fail('headers 必须是对象')
    for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) {
      if (!k.trim()) continue
      headers[k.trim()] = String(v ?? '')
    }
  }

  const rawModels = Array.isArray(o.models) ? o.models : []
  const models: CustomModelDef[] = []
  const seen = new Set<string>()
  for (const m of rawModels) {
    const def = parseModelDef(m)
    if (seen.has(def.id)) fail(`模型 id 重复：${def.id}`)
    seen.add(def.id)
    models.push(def)
  }

  return {
    id,
    name: typeof o.name === 'string' && o.name.trim() ? o.name.trim() : id,
    baseUrl: baseUrl.replace(/\/$/, ''),
    api,
    ...(Object.keys(headers).length ? { headers } : {}),
    models,
  }
}

/** 自定义供应商也走 SATUWORK_<ID>_API_KEY 这条环境变量；平台表里的密钥优先。 */
export function customEnvVar(id: string): string {
  return `SATUWORK_${id.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

/** 还原成 pi-ai 的 Provider。models 里的每一条都是完整的 pi-ai Model。 */
export function buildProvider(def: CustomProviderDef): Provider {
  return createProvider({
    id: def.id,
    name: def.name,
    baseUrl: def.baseUrl,
    ...(def.headers ? { headers: def.headers } : {}),
    auth: { apiKey: envApiKeyAuth(`${def.name} API key`, [customEnvVar(def.id)]) },
    models: def.models.map((m) => ({
      id: m.id,
      name: m.name,
      api: def.api,
      provider: def.id,
      baseUrl: def.baseUrl,
      reasoning: m.reasoning,
      input: m.input,
      cost: m.cost,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
    api: API_IMPL[def.api](),
  })
}
