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

/**
 * `Authorization: Bearer` 或 `x-api-key`。后者是 Anthropic SDK 的写法，
 * `/v1/messages` 的调用方基本都这么发。
 *
 * Node 把重复出现的非 set-cookie 头合成一个逗号分隔的字符串，所以这里只需要处理
 * string——以前那条 `Array.isArray` 分支永远到不了。
 */
function callerToken(req: Req): string | undefined {
  const b = bearer(req)
  if (b) return b
  const x = req.headers['x-api-key']
  if (typeof x === 'string' && x.trim()) return x.trim()
}

async function requireUser(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  const token = callerToken(req)
  if (!token) throw new HttpError(401, '需要登录')
  // access token 是席位运行时票，不能拿来调 /v1。
  if (token.startsWith('sat_')) throw new HttpError(401, '需要登录')
  let account: Account | undefined
  if (token.startsWith('sk_sw_')) {
    account = await db.accountByApiKey(token)
    if (!account) throw new HttpError(401, '需要登录')
  } else {
    let payload
    try {
      payload = verifyJwt(keys, token)
    } catch (e) {
      throw new HttpError(401, (e as Error).message)
    }
    account = await db.account(payload.accountId)
    if (!account) throw new HttpError(401, '账号不存在')
    // iat 只有秒精度：同一秒内新签发的票不能被刚写下的 tokenRevokedAt 误杀。
    if (account.tokenRevokedAt && payload.iat < Math.floor(account.tokenRevokedAt / 1000)) {
      throw new HttpError(401, '登录已失效，请重新登录')
    }
  }
  if (account.status === 'disabled') throw new HttpError(401, '这个账号已被停用，请联系管理员')
  if (account.status === 'invited') throw new HttpError(401, '请先用邀请链接设置口令')
  // 公司停用了，这家的密钥一律不认——控制台那边是同一条规矩。
  if (account.companyId) {
    const company = await db.company(account.companyId)
    if (company && company.status === 'disabled') throw new HttpError(403, '这家公司已被停用，请联系平台管理员')
  }
  return account
}

async function recordLlmCall(
  db: Db,
  account: Account,
  found: { provider: string; id: string },
): Promise<string> {
  const row = await db.insertLlmCall({
    accountId: account.id,
    companyId: account.companyId,
    provider: found.provider,
    model: found.id,
  })
  return row.id
}

function bodyOf(req: Req): Record<string, unknown> {
  if (req.body == null) return {}
  if (typeof req.body !== 'object' || Array.isArray(req.body)) throw new HttpError(400, '请求体必须是对象')
  return req.body as Record<string, unknown>
}

async function publicModels(llm: Llm, companyId: string | null) {
  return (await llm.catalog(companyId)).map((m) => ({
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

async function resolveOr404(llm: Llm, companyId: string | null, raw: string, hint?: string) {
  const found = await llm.find(companyId, raw, hint)
  if (!found) throw new HttpError(404, '模型不在可见目录里', { model: raw })
  return found
}

async function secretOr402(llm: Llm, companyId: string | null, provider: string): Promise<string> {
  const secret = await llm.secret(companyId, provider)
  if (!secret) throw new HttpError(402, `没有 ${provider} 的密钥`, { provider })
  return secret
}

/**
 * 这两条路由是**厂商原生协议**的透传口，上游地址写死：`/v1/responses` 是 OpenAI 的
 * Responses API，`/v1/messages` 是 Anthropic 的 Messages API。而凭据是按解析出来的
 * `found.provider` 取的——两者不对齐就会错配：`{"model":"anthropic/claude-…"}` 打到
 * `/v1/responses`，Gateway 就把 ANTHROPIC_API_KEY 以 `Authorization: Bearer` 发给
 * api.openai.com。密钥不回显给调用方（proxyUpstream 有 redact），但已经落进了另一家
 * 厂商的请求日志，只能轮换。
 *
 * `/v1/chat/completions` 没这个问题：它走 `llm.piModel(...)`，凭据和目的地必然同源。
 */
function requireProvider(provider: string, want: string, route: string): void {
  if (provider !== want) {
    throw new HttpError(400, `${route} 只接受 ${want} 的模型，收到的是 ${provider || '未知'}`)
  }
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

/**
 * 用户消息 → pi 的 content。
 *
 * **这一层最容易被漏掉**：Bot 那边把图片发对了，到这儿再被 contentText() 拍成字符串，
 * 图就没了——而且没有任何报错，模型只是看不见它。
 *
 * 进来的是 OpenAI 口径的 content 数组（`image_url.url` 里是 data URI），出去的是 pi 的
 * `{type:'image', data, mimeType}`。没有图就还给字符串，跟以前一样。
 */
export function userContent(content: unknown): any {
  if (!Array.isArray(content)) return contentText(content)
  if (!content.some((c: any) => c?.type === 'image_url' || c?.type === 'image')) return contentText(content)
  const out: any[] = []
  for (const c of content as any[]) {
    if (c?.type === 'image_url') {
      const url = String(c.image_url?.url ?? '')
      const m = /^data:([^;,]+);base64,(.*)$/s.exec(url)
      // 只收内联的 base64。远程 URL 得由这一层去取，那是一个可以被指使去打内网的
      // 出站请求（SSRF），不做。
      if (m) out.push({ type: 'image', mimeType: m[1], data: m[2] })
      continue
    }
    if (c?.type === 'image' && typeof c.data === 'string') {
      out.push({ type: 'image', mimeType: c.mimeType || 'image/png', data: c.data })
      continue
    }
    const t = typeof c === 'string' ? c : (c?.text ?? '')
    if (t) out.push({ type: 'text', text: t })
  }
  return out.length ? out : contentText(content)
}

export function toPiContext(body: Record<string, unknown>, provider: string, modelId: string) {
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
      messages.push({ role: 'user', content: userContent(m.content), timestamp: Date.now() })
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

const nonNegInt = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * pi 的 usage → OpenAI 线上格式。
 *
 * **`prompt_tokens` 报整个提示词，命中缓存的那部分也算在内。** pi 的 `input` 是
 * 未命中的那一截，上游一开前缀缓存它就只剩零头——实测一次约 2600 token 的提示词
 * 记成了 308，而 llm_calls 记的就是这个数，用量和账单跟着一起矮下去。
 *
 * 细分放 `prompt_tokens_details.cached_tokens`，跟 OpenAI 的约定一致。缓存读单价
 * 更低，但**不在这里折价**：目录里有单价，折算是计价那一层的事。
 */
function openaiUsage(u: any) {
  if (!u) return undefined
  // pi 的形状（有 input/output）和已经是 OpenAI 形状的载荷（有 prompt_tokens）
  // 对「含不含缓存」的约定相反，必须分开处理，否则要么漏掉、要么加两遍。
  const isPi = u.input != null || u.output != null
  const cached_tokens = nonNegInt(isPi ? u.cacheRead : u.prompt_tokens_details?.cached_tokens)
  const prompt = isPi ? u.input : u.prompt_tokens
  const completion = isPi ? u.output : u.completion_tokens
  if (prompt == null && completion == null) return undefined
  const prompt_tokens = nonNegInt(prompt) + (isPi ? cached_tokens : 0)
  const completion_tokens = nonNegInt(completion)
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    ...(cached_tokens ? { prompt_tokens_details: { cached_tokens } } : {}),
  }
}

type TokenUsage = { prompt_tokens: number; completion_tokens: number; cached_tokens: number }

/** 一帧只报了一半是常事，所以缺的字段是 undefined，不是 0——0 会把上一帧盖掉。 */
type PartialUsage = { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number }

function tokensOf(u: ReturnType<typeof openaiUsage>): TokenUsage | undefined {
  if (!u) return undefined
  return {
    prompt_tokens: u.prompt_tokens,
    completion_tokens: u.completion_tokens,
    cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0,
  }
}

function objectAt(o: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = o[key]
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
}

/**
 * usage 可能在顶层，也可能裹一层：OpenAI Responses 是 `response.usage`，
 * Anthropic 的 message_start 是 `message.usage`。只看顶层就会把输入 token 丢光。
 */
function usageCandidates(obj: unknown): Record<string, unknown>[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return []
  const o = obj as Record<string, unknown>
  const out: Record<string, unknown>[] = []
  const push = (v: Record<string, unknown> | undefined) => {
    if (v) out.push(v)
  }
  push(objectAt(o, 'usage'))
  for (const key of ['response', 'message']) {
    const inner = objectAt(o, key)
    if (inner) push(objectAt(inner, 'usage'))
  }
  out.push(o)
  return out
}

/**
 * 从原样透传的上游响应里捞 usage。
 *
 * **缓存那几项要单独加回去。** Anthropic 的 `input_tokens` 不含
 * `cache_read_input_tokens` / `cache_creation_input_tokens`，只读前者就等于把命中缓存
 * 的提示词当成没发生过。OpenAI 的 `prompt_tokens` 相反，本来就是含缓存的总数，
 * 细分在 `prompt_tokens_details.cached_tokens` 里——所以两边不能用同一套加法。
 */
function usageFromPayload(obj: unknown): PartialUsage | undefined {
  for (const raw of usageCandidates(obj)) {
    const openaiPrompt = raw.prompt_tokens
    const anthropicPrompt = raw.input_tokens ?? raw.input
    const prompt = openaiPrompt ?? anthropicPrompt
    const completion = raw.completion_tokens ?? raw.output_tokens ?? raw.output
    if (prompt == null && completion == null) continue
    const details = raw.prompt_tokens_details as Record<string, unknown> | undefined
    const readRaw = openaiPrompt != null ? details?.cached_tokens : raw.cache_read_input_tokens
    const writeRaw = openaiPrompt != null ? undefined : raw.cache_creation_input_tokens
    const cacheRead = nonNegInt(readRaw)
    // 写缓存的那部分也是这次真发出去的提示词，算进总量；但它不是「读到的缓存」，
    // 不进 cached_tokens——两者单价不同。
    const cacheWrite = nonNegInt(writeRaw)
    const out: PartialUsage = {}
    const pt = Number(prompt)
    const ct = Number(completion)
    if (prompt != null && Number.isFinite(pt)) {
      out.prompt_tokens = openaiPrompt != null ? pt : pt + cacheRead + cacheWrite
      // **这一帧没带缓存字段就别写这个键。** 写成 0 的话，mergeUsage 取 next 优先，
      // 会把前面帧里记下的缓存 token 抹掉：Anthropic 的 message_start 报了
      // input 900 + cache_read 400，后面某个 message_delta 只回传累计 input_tokens
      // 而不重复缓存字段，最终就落库成 900/0——正是这次要修的那个漏记又回来了。
      if (readRaw != null) out.cached_tokens = cacheRead
    }
    if (completion != null && Number.isFinite(ct)) out.completion_tokens = ct
    if (out.prompt_tokens != null || out.completion_tokens != null) return out
  }
  return undefined
}

/**
 * 逐帧累积，不整块替换。Anthropic 把输入 token 放在 message_start、输出 token 放在
 * message_delta——整块替换的话最后一帧会把输入抹成 0。
 *
 * **取较大值，不是后来居上。** 一次请求的提示词大小是定值，各帧只是报得完整程度不同：
 * message_start 给 input 900 + cache_read 400（合成 1300），而某些版本的 message_delta
 * 会再回传一次累计 input_tokens 却不重复缓存字段（算出 900）。后来居上就会把 1300
 * 覆盖成 900，缓存那截又漏掉了。输出 token 在流式里是累计上报的，取大同样成立。
 */
function mergeUsage(cur: TokenUsage | undefined, next: PartialUsage): TokenUsage {
  const pick = (a: number | undefined, b: number | undefined) => Math.max(a ?? 0, b ?? 0)
  return {
    prompt_tokens: pick(next.prompt_tokens, cur?.prompt_tokens),
    completion_tokens: pick(next.completion_tokens, cur?.completion_tokens),
    cached_tokens: pick(next.cached_tokens, cur?.cached_tokens),
  }
}

async function streamChatCompletions(
  req: Req,
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
  // 客户端一走就得停下来。以前没有这一条：浏览器关了标签页，Gateway 还在把上游的
  // token 一个个拉完——写进一个没人读的 socket，钱照付。break 会调 for-await 的
  // .return()，取消一路传到底层流。
  let gone = false
  const onClose = () => {
    gone = true
  }
  req.on('close', onClose)
  try {
    for await (const event of stream) {
      if (gone) break
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
    if (!gone) writeSse(res, { error: { message: msg, type: 'upstream_error' } })
  } finally {
    req.off('close', onClose)
  }
  // 客户端已经走了就别再往 socket 里写；但 usage 要照常返回——已经问上游要过的
  // token 是花掉了的，不记账等于白送。
  if (!gone) {
    res.write('data: [DONE]\n\n')
    res.end()
  }
  return usage
}

async function completeChatCompletions(
  res: ServerResponse,
  llm: Llm,
  found: { provider: string; id: string },
  secret: string,
  body: Record<string, unknown>,
): Promise<TokenUsage | undefined> {
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
  return tokensOf(openaiUsage(message?.usage))
}

async function proxyUpstream(
  req: Req,
  res: ServerResponse,
  opts: { url: string; headers: Record<string, string>; body: unknown; secret: string },
): Promise<TokenUsage | undefined> {
  // 客户端断了就别再拉上游：那边是按 token 计费的，没人读的字节一样要付钱。
  // 和 120s 超时合成一个信号——两个条件里先到的那个生效。
  const ac = new AbortController()
  const onClose = () => ac.abort()
  req.on('close', onClose)
  let upstream: Response
  try {
    upstream = await fetch(opts.url, {
      method: 'POST',
      headers: opts.headers,
      body: JSON.stringify(opts.body),
      signal: AbortSignal.any([ac.signal, AbortSignal.timeout(120_000)]),
    })
  } catch (e) {
    req.off('close', onClose)
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
    // 一个解码器从头用到尾：多字节字符会被切在两个 chunk 之间，每次新建解码器会把
    // 它解成替换字符，那一帧的 JSON 就 parse 不动，用量记录跟着丢。
    const decoder = new TextDecoder()
    const take = (piece: string | Buffer) => {
      const bytes = typeof piece === 'string' ? piece : Buffer.from(piece)
      res.write(bytes)
      buf += typeof piece === 'string' ? piece : decoder.decode(piece, { stream: true })
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
            if (u) usage = mergeUsage(usage, u)
          } catch {}
        }
      }
    }
    // 读流放在 try 里：以前它在外面，任何中途失败（120s 超时会连响应体一起中止）都会
    // 一路抛出去，`res.end()` 和外层的 updateLlmCallTokens 都不执行——**这一次调用已经
    // 累计到的 token 全部丢掉**。断流是断流，账还是要记。
    if (upstream.body) {
      try {
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
      } catch {
        /* 中途断了：保留已经累计的 usage，下面照常收尾。 */
      }
    }
    req.off('close', onClose)
    if (!res.writableEnded) res.end()
    return usage
  }
  let text: string
  try {
    text = redact(await upstream.text(), opts.secret)
  } finally {
    req.off('close', onClose)
  }
  res.writeHead(upstream.status, {
    'content-type': ctype.includes('json') ? 'application/json; charset=utf-8' : ctype,
    'cache-control': 'no-store',
  })
  res.end(text)
  try {
    const u = usageFromPayload(JSON.parse(text))
    return u ? mergeUsage(undefined, u) : undefined
  } catch {
    return undefined
  }
}

/**
 * OpenAI / Anthropic 兼容的模型代理。鉴权是席位 API Key（sk_sw_）或登录 JWT；
 * 上游供应商密钥只在 Gateway 里，响应永不回显。
 */
export function attachV1(router: Router, db: Db, keys: JwtKeys, llm: Llm) {
  router.get('/v1/models', async (req, res) => {
    const account = await requireUser(req, db, keys)
    json(res, 200, { object: 'list', data: await publicModels(llm, account.companyId) })
  })

  router.post('/v1/chat/completions', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const body = bodyOf(req)
    const modelRaw = str(body.model)
    if (!modelRaw) throw new HttpError(400, 'model 不能为空')
    const hint = str(body.provider) || undefined
    const found = await resolveOr404(llm, account.companyId, modelRaw, hint)
    const secret = await secretOr402(llm, account.companyId, found.provider)
    const callId = await recordLlmCall(db, account, found)
    const stream = body.stream === true
    if (stream) {
      const usage = await streamChatCompletions(req, res, llm, found, secret, body)
      if (usage) await db.updateLlmCallTokens(callId, usage)
      return
    }
    const usage = await completeChatCompletions(res, llm, found, secret, body)
    if (usage) await db.updateLlmCallTokens(callId, usage)
  })

  router.post('/v1/responses', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const body = { ...bodyOf(req) }
    const modelRaw = str(body.model)
    if (!modelRaw) throw new HttpError(400, 'model 不能为空')
    const found = await resolveOr404(llm, account.companyId, modelRaw, str(body.provider) || 'openai')
    requireProvider(found.provider, 'openai', '/v1/responses')
    const secret = await secretOr402(llm, account.companyId, found.provider)
    const callId = await recordLlmCall(db, account, found)
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
    if (usage) await db.updateLlmCallTokens(callId, usage)
  })

  router.post('/v1/messages', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const body = { ...bodyOf(req) }
    const modelRaw = str(body.model)
    if (!modelRaw) throw new HttpError(400, 'model 不能为空')
    const found = await resolveOr404(llm, account.companyId, modelRaw, str(body.provider) || 'anthropic')
    requireProvider(found.provider, 'anthropic', '/v1/messages')
    const secret = await secretOr402(llm, account.companyId, found.provider)
    const callId = await recordLlmCall(db, account, found)
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
    if (usage) await db.updateLlmCallTokens(callId, usage)
  })
}
