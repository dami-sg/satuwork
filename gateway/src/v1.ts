import type { ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { Account, Db } from './db.ts'
import type { JwtKeys } from './crypto.ts'
import { verifyJwt } from './crypto.ts'
import { HttpError, bearer, json, type Req, type Router } from './http.ts'
import { EMPTY_USAGE, openaiModelId, redact, type Llm } from './llm.ts'

const ANTHROPIC_VERSION = '2023-06-01'

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function callerToken(req: Req): string | undefined {
  const b = bearer(req)
  if (b) return b
  const x = req.headers['x-api-key']
  if (typeof x === 'string' && x.trim()) return x.trim()
  const arr = req.headers['x-api-key']
  if (Array.isArray(arr) && arr[0]?.trim()) return arr[0].trim()
}

function requireUser(req: Req, db: Db, keys: JwtKeys): Account {
  const token = callerToken(req)
  if (!token) throw new HttpError(401, '需要登录')
  // access token 是席位运行时票，不能拿来调 /v1。
  if (token.startsWith('sat_')) throw new HttpError(401, '需要登录')
  let account: Account | undefined
  if (token.startsWith('sk_sw_')) {
    account = db.accountByApiKey(token)
    if (!account) throw new HttpError(401, '需要登录')
  } else {
    let payload
    try {
      payload = verifyJwt(keys, token)
    } catch (e) {
      throw new HttpError(401, (e as Error).message)
    }
    account = db.account(payload.accountId)
    if (!account) throw new HttpError(401, '账号不存在')
    // iat 只有秒精度：同一秒内新签发的票不能被刚写下的 tokenRevokedAt 误杀。
    if (account.tokenRevokedAt && payload.iat < Math.floor(account.tokenRevokedAt / 1000)) {
      throw new HttpError(401, '登录已失效，请重新登录')
    }
  }
  if (account.status === 'disabled') throw new HttpError(401, '这个账号已被停用，请联系管理员')
  if (account.status === 'invited') throw new HttpError(401, '请先用邀请链接设置口令')
  return account
}

function recordLlmCall(
  db: Db,
  account: Account,
  found: { provider: string; id: string },
): string {
  return db.insertLlmCall({
    accountId: account.id,
    companyId: account.companyId,
    provider: found.provider,
    model: found.id,
  }).id
}

function bodyOf(req: Req): Record<string, unknown> {
  if (req.body == null) return {}
  if (typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, '请求体必须是对象')
  return req.body as Record<string, unknown>
}

function publicModels(llm: Llm, companyId: string | null) {
  return llm.catalog(companyId).map((m) => ({
    id: openaiModelId(m),
    object: 'model' as const,
    owned_by: m.provider,
    provider: m.provider,
    model: m.id,
    name: m.name,
    api: m.api,
    context_window: m.contextWindow,
    max_tokens: m.maxTokens,
    reasoning: m.reasoning,
    input: m.input && m.input.length ? m.input : ['text'],
    cost: m.cost,
  }))
}

function resolveOr404(llm: Llm, companyId: string | null, raw: string, hint?: string) {
  const found = llm.find(companyId, raw, hint)
  if (!found) throw new HttpError(404, '模型不在可见目录里', { model: raw })
  return found
}

function secretOr402(llm: Llm, companyId: string | null, provider: string): string {
  const secret = llm.secret(companyId, provider)
  if (!secret) throw new HttpError(402, `没有 ${provider} 的密钥`, { provider })
  return secret
}

function openaiBase(): string {
  return (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/$/, '')
}
function anthropicBase(): string {
  return (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '')
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c
        if (c && typeof c === 'object' && 'text' in c) return String((c as { text?: unknown }).text ?? '')
        return ''
      })
      .join('')
  }
  return content == null ? '' : String(content)
}

function safeParse(s: unknown): unknown {
  if (s && typeof s === 'object') return s
  if (typeof s !== 'string') return {}
  try {
    return s.trim() ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}

function toPiContext(body: Record<string, unknown>, provider: string, modelId: string) {
  const messagesIn = Array.isArray(body.messages) ? body.messages : []
  let systemPrompt: string | undefined
  const messages: any[] = []
  for (const raw of messagesIn) {
    const m = raw as Record<string, any>
    const role = m.role
    if (role === 'system' || role === 'developer') {
      const t = contentText(m.content)
      systemPrompt = [systemPrompt, t].filter(Boolean).join('\n')
      continue
    }
    if (role === 'user') {
      messages.push({ role: 'user', content: contentText(m.content), timestamp: Date.now() })
      continue
    }
    if (role === 'assistant') {
      const content: any[] = []
      const text = contentText(m.content)
      if (text) content.push({ type: 'text', text })
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          content.push({
            type: 'toolCall',
            id: tc.id,
            name: tc.function?.name ?? tc.name,
            arguments: safeParse(tc.function?.arguments ?? tc.arguments),
          })
        }
      }
      messages.push({
        role: 'assistant',
        content,
        api: 'openai-completions',
        provider,
        model: modelId,
        usage: EMPTY_USAGE,
        stopReason: 'stop',
        timestamp: Date.now(),
      })
      continue
    }
    if (role === 'tool') {
      messages.push({
        role: 'toolResult',
        toolCallId: m.tool_call_id ?? m.toolCallId,
        toolName: m.name ?? '',
        content: [{ type: 'text', text: contentText(m.content) }],
        isError: false,
        timestamp: Date.now(),
      })
    }
  }
  const tools = Array.isArray(body.tools)
    ? body.tools.map((t: any) => {
        const fn = t.function ?? t
        return {
          name: fn.name,
          description: fn.description ?? '',
          parameters: fn.parameters ?? t.input_schema ?? { type: 'object', properties: {} },
        }
      })
    : undefined
  return { systemPrompt, messages, tools }
}

function chunk(id: string, model: string, delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: extra.finish_reason ?? null }],
    ...('usage' in extra ? { usage: extra.usage } : {}),
  }
}

function writeSse(res: ServerResponse, payload: unknown) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function openaiUsage(u: any) {
  if (!u) return undefined
  const prompt = u.input ?? u.prompt_tokens
  const completion = u.output ?? u.completion_tokens
  if (prompt == null && completion == null) return undefined
  const pt = Number(prompt)
  const ct = Number(completion)
  const prompt_tokens = Number.isFinite(pt) ? pt : 0
  const completion_tokens = Number.isFinite(ct) ? ct : 0
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: u.totalTokens ?? prompt_tokens + completion_tokens,
  }
}

type TokenUsage = { prompt_tokens: number; completion_tokens: number }

function tokensOf(u: { prompt_tokens: number; completion_tokens: number } | undefined): TokenUsage | undefined {
  if (!u) return undefined
  return { prompt_tokens: u.prompt_tokens, completion_tokens: u.completion_tokens }
}

function usageFromPayload(obj: unknown): TokenUsage | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined
  const o = obj as Record<string, unknown>
  const raw = o.usage && typeof o.usage === 'object' && !Array.isArray(o.usage) ? (o.usage as Record<string, unknown>) : o
  const prompt = raw.prompt_tokens ?? raw.input_tokens ?? raw.input
  const completion = raw.completion_tokens ?? raw.output_tokens ?? raw.output
  if (prompt == null && completion == null) return undefined
  const pt = Number(prompt)
  const ct = Number(completion)
  return {
    prompt_tokens: Number.isFinite(pt) ? pt : 0,
    completion_tokens: Number.isFinite(ct) ? ct : 0,
  }
}

async function streamChatCompletions(
  res: ServerResponse,
  llm: Llm,
  found: { provider: string; id: string },
  secret: string,
  body: Record<string, unknown>,
): Promise<TokenUsage | undefined> {
  const modelId = openaiModelId(found)
  const id = `chatcmpl-${randomUUID()}`
  const piModel = llm.piModel(found.provider, found.id)
  if (!piModel) {
    throw new HttpError(404, '模型不在可见目录里', { model: modelId })
  }
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  })
  const context = toPiContext(body, found.provider, found.id)
  const stream = llm.models.streamSimple(piModel as any, context as any, {
    apiKey: secret,
    temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
    maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : typeof body.max_completion_tokens === 'number' ? body.max_completion_tokens : undefined,
  })
  let usage: TokenUsage | undefined
  try {
    for await (const event of stream) {
      switch (event.type) {
        case 'start':
          writeSse(res, chunk(id, modelId, { role: 'assistant' }))
          break
        case 'text_delta':
          writeSse(res, chunk(id, modelId, { content: event.delta }))
          break
        case 'thinking_delta':
          writeSse(res, chunk(id, modelId, { reasoning_content: event.delta }))
          break
        case 'toolcall_start': {
          const tc = (event.partial?.content?.[event.contentIndex] as any) ?? {}
          writeSse(
            res,
            chunk(id, modelId, {
              tool_calls: [
                {
                  index: event.contentIndex,
                  id: tc.id ?? `call_${event.contentIndex}`,
                  type: 'function',
                  function: { name: tc.name ?? '', arguments: '' },
                },
              ],
            }),
          )
          break
        }
        case 'toolcall_delta':
          writeSse(
            res,
            chunk(id, modelId, {
              tool_calls: [{ index: event.contentIndex, function: { arguments: event.delta } }],
            }),
          )
          break
        case 'done': {
          const reason = event.reason === 'toolUse' ? 'tool_calls' : event.reason === 'length' ? 'length' : 'stop'
          const u = openaiUsage(event.message?.usage)
          if (u) usage = tokensOf(u)
          writeSse(res, chunk(id, modelId, {}, { finish_reason: reason, usage: u }))
          break
        }
        case 'error': {
          const msg = redact(event.error?.errorMessage || 'model error', secret)
          writeSse(res, chunk(id, modelId, { content: '' }, { finish_reason: 'stop' }))
          writeSse(res, { error: { message: msg, type: 'upstream_error' } })
          break
        }
      }
    }
  } catch (e) {
    const msg = redact((e as Error).message || 'upstream error', secret)
    writeSse(res, { error: { message: msg, type: 'upstream_error' } })
  }
  res.write('data: [DONE]\n\n')
  res.end()
  return usage
}

async function completeChatCompletions(
  res: ServerResponse,
  llm: Llm,
  found: { provider: string; id: string },
  secret: string,
  body: Record<string, unknown>,
): Promise<{ prompt_tokens: number; completion_tokens: number } | undefined> {
  const modelId = openaiModelId(found)
  const piModel = llm.piModel(found.provider, found.id)
  if (!piModel) throw new HttpError(404, '模型不在可见目录里', { model: modelId })
  const context = toPiContext(body, found.provider, found.id)
  let message: any
  try {
    message = await llm.models.completeSimple(piModel as any, context as any, {
      apiKey: secret,
      temperature: typeof body.temperature === 'number' ? body.temperature : undefined,
      maxTokens: typeof body.max_tokens === 'number' ? body.max_tokens : undefined,
    })
  } catch (e) {
    throw new HttpError(503, redact((e as Error).message || 'upstream error', secret))
  }
  if (message?.stopReason === 'error' || message?.errorMessage) {
    throw new HttpError(503, redact(String(message.errorMessage || 'model error'), secret))
  }
  const text = Array.isArray(message?.content)
    ? message.content.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('')
    : ''
  const toolCalls = Array.isArray(message?.content)
    ? message.content
        .filter((c: any) => c.type === 'toolCall')
        .map((c: any) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }))
    : []
  json(res, 200, {
    id: `chatcmpl-${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length ? 'tool_calls' : 'stop',
      },
    ],
    usage: openaiUsage(message?.usage) ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  })
  const usage = openaiUsage(message?.usage)
  if (!usage) return undefined
  return { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens }
}

async function proxyUpstream(
  req: Req,
  res: ServerResponse,
  opts: { url: string; headers: Record<string, string>; body: unknown; secret: string },
): Promise<TokenUsage | undefined> {
  let upstream: Response
  try {
    upstream = await fetch(opts.url, {
      method: 'POST',
      headers: opts.headers,
      body: JSON.stringify(opts.body),
      signal: AbortSignal.timeout(120_000),
    })
  } catch (e) {
    throw new HttpError(503, redact((e as Error).message || 'upstream unreachable', opts.secret))
  }
  const ctype = upstream.headers.get('content-type') || 'application/json; charset=utf-8'
  const streaming = ctype.includes('text/event-stream') || ctype.includes('text/plain')
  if (streaming) {
    res.writeHead(upstream.status, {
      'content-type': ctype,
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    let usage: TokenUsage | undefined
    let buf = ''
    const take = (piece: string | Buffer) => {
      const bytes = typeof piece === 'string' ? piece : Buffer.from(piece)
      res.write(bytes)
      buf += typeof piece === 'string' ? piece : new TextDecoder().decode(piece)
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload || payload === '[DONE]') continue
          try {
            const u = usageFromPayload(JSON.parse(payload))
            if (u) usage = u
          } catch {}
        }
      }
    }
    if (upstream.body) {
      const reader = (upstream.body as any).getReader?.()
      if (reader) {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          take(typeof value === 'string' ? value : Buffer.from(value))
        }
      } else {
        for await (const chunk of upstream.body as any) {
          take(typeof chunk === 'string' ? chunk : Buffer.from(chunk))
        }
      }
    }
    res.end()
    return usage
  }
  const text = redact(await upstream.text(), opts.secret)
  res.writeHead(upstream.status, {
    'content-type': ctype.includes('json') ? 'application/json; charset=utf-8' : ctype,
    'cache-control': 'no-store',
  })
  res.end(text)
  try {
    return usageFromPayload(JSON.parse(text))
  } catch {
    return undefined
  }
}

/**
 * OpenAI / Anthropic 兼容的模型代理。鉴权是席位 API Key（sk_sw_）或登录 JWT；
 * 上游供应商密钥只在 Gateway 里，响应永不回显。
 */
export function attachV1(router: Router, db: Db, keys: JwtKeys, llm: Llm) {
  router.get('/v1/models', (req, res) => {
    const account = requireUser(req, db, keys)
    json(res, 200, { object: 'list', data: publicModels(llm, account.companyId) })
  })

  router.post('/v1/chat/completions', async (req, res) => {
    const account = requireUser(req, db, keys)
    const body = bodyOf(req)
    const modelRaw = str(body.model)
    if (!modelRaw) throw new HttpError(400, 'model 不能为空')
    const hint = str(body.provider) || undefined
    const found = resolveOr404(llm, account.companyId, modelRaw, hint)
    const secret = secretOr402(llm, account.companyId, found.provider)
    const callId = recordLlmCall(db, account, found)
    const stream = body.stream === true
    if (stream) {
      const usage = await streamChatCompletions(res, llm, found, secret, body)
      if (usage) db.updateLlmCallTokens(callId, usage.prompt_tokens, usage.completion_tokens)
      return
    }
    const usage = await completeChatCompletions(res, llm, found, secret, body)
    if (usage) db.updateLlmCallTokens(callId, usage.prompt_tokens, usage.completion_tokens)
  })

  router.post('/v1/responses', async (req, res) => {
    const account = requireUser(req, db, keys)
    const body = { ...bodyOf(req) }
    const modelRaw = str(body.model)
    if (!modelRaw) throw new HttpError(400, 'model 不能为空')
    const found = resolveOr404(llm, account.companyId, modelRaw, str(body.provider) || 'openai')
    const secret = secretOr402(llm, account.companyId, found.provider)
    const callId = recordLlmCall(db, account, found)
    body.model = found.id
    const headers: Record<string, string> = {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/json',
    }
    const beta = req.headers['openai-beta']
    if (typeof beta === 'string' && beta) headers['openai-beta'] = beta
    const usage = await proxyUpstream(req, res, {
      url: `${openaiBase()}/v1/responses`,
      headers,
      body,
      secret,
    })
    if (usage) db.updateLlmCallTokens(callId, usage.prompt_tokens, usage.completion_tokens)
  })

  router.post('/v1/messages', async (req, res) => {
    const account = requireUser(req, db, keys)
    const body = { ...bodyOf(req) }
    const modelRaw = str(body.model)
    if (!modelRaw) throw new HttpError(400, 'model 不能为空')
    const found = resolveOr404(llm, account.companyId, modelRaw, str(body.provider) || 'anthropic')
    const secret = secretOr402(llm, account.companyId, found.provider)
    const callId = recordLlmCall(db, account, found)
    body.model = found.id
    const versionHeader = req.headers['anthropic-version']
    const version = typeof versionHeader === 'string' && versionHeader ? versionHeader : ANTHROPIC_VERSION
    const usage = await proxyUpstream(req, res, {
      url: `${anthropicBase()}/v1/messages`,
      headers: {
        'x-api-key': secret,
        'anthropic-version': version,
        'content-type': 'application/json',
      },
      body,
      secret,
    })
    if (usage) db.updateLlmCallTokens(callId, usage.prompt_tokens, usage.completion_tokens)
  })
}
