import { AssistantMessageEventStream, EMPTY_USAGE, emptyAssistant, stubModel } from './stream.ts'

export function gatewayUrl(): string {
  return (process.env.GATEWAY_URL || '').replace(/\/$/, '')
}

export function gatewayToken(): string {
  return (process.env.GATEWAY_TOKEN || '').trim()
}

export function gatewayApiKey(): string {
  return (process.env.GATEWAY_API_KEY || '').trim()
}

function apiFor(provider: string) {
  if (provider === 'anthropic') return '/v1/messages'
  return '/v1/chat/completions'
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.text ?? c?.thinking ?? ''))
      .join('')
  }
  return content == null ? '' : String(content)
}

function toOpenAI(context: any, model: { provider: string; id: string }) {
  const messages: any[] = []
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt })
  for (const m of context.messages ?? []) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: contentText(m.content) })
    } else if (m.role === 'assistant') {
      const text = (m.content ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('')
      const tool_calls = (m.content ?? [])
        .filter((c: any) => c.type === 'toolCall')
        .map((c: any) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? {}) },
        }))
      const row: any = { role: 'assistant', content: text || null }
      if (tool_calls.length) row.tool_calls = tool_calls
      messages.push(row)
    } else if (m.role === 'toolResult') {
      messages.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: contentText(m.content),
      })
    }
  }
  const tools = (context.tools ?? []).map((t: any) => ({
    type: 'function',
    function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } },
  }))
  return {
    model: `${model.provider}/${model.id}`,
    provider: model.provider,
    messages,
    ...(tools.length ? { tools } : {}),
    stream: true,
  }
}

function toAnthropic(context: any, model: { id: string }) {
  const messages: any[] = []
  for (const m of context.messages ?? []) {
    if (m.role === 'user') {
      messages.push({ role: 'user', content: contentText(m.content) })
    } else if (m.role === 'assistant') {
      const content: any[] = []
      for (const c of m.content ?? []) {
        if (c.type === 'text' && c.text) content.push({ type: 'text', text: c.text })
        else if (c.type === 'toolCall') content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments ?? {} })
      }
      if (!content.length) content.push({ type: 'text', text: '' })
      messages.push({ role: 'assistant', content })
    } else if (m.role === 'toolResult') {
      messages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: contentText(m.content),
            is_error: !!m.isError,
          },
        ],
      })
    }
  }
  const tools = (context.tools ?? []).map((t: any) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: t.parameters ?? { type: 'object', properties: {} },
  }))
  return {
    model: model.id,
    system: context.systemPrompt || undefined,
    messages,
    max_tokens: 8192,
    stream: true,
    ...(tools.length ? { tools } : {}),
  }
}

async function* readSse(res: Response): AsyncGenerator<{ event?: string; data: string }> {
  const reader = res.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    buf = buf.replace(/\r\n/g, '\n')
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      if (!raw.trim()) continue
      let event: string | undefined
      const data: string[] = []
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
      }
      yield { event, data: data.join('\n') }
    }
  }
}

function fail(stream: AssistantMessageEventStream, model: any, message: string) {
  const error = emptyAssistant(model, message)
  stream.push({ type: 'error', reason: 'error', error })
}

async function consumeOpenAI(res: Response, stream: AssistantMessageEventStream, model: any) {
  let partial: any = emptyAssistant(model)
  let started = false
  let textIndex = -1
  const start = () => {
    if (started) return
    started = true
    stream.push({ type: 'start', partial })
  }
  for await (const ev of readSse(res)) {
    if (ev.data === '[DONE]') break
    let chunk: any
    try {
      chunk = JSON.parse(ev.data)
    } catch {
      continue
    }
    if (chunk.error) {
      fail(stream, model, chunk.error.message || JSON.stringify(chunk.error))
      return
    }
    const choice = chunk.choices?.[0] ?? {}
    const delta = choice.delta ?? {}
    if (delta.role) start()
    if (typeof delta.content === 'string' && delta.content) {
      start()
      if (textIndex < 0) {
        textIndex = partial.content.length
        partial = { ...partial, content: [...partial.content, { type: 'text', text: '' }] }
        stream.push({ type: 'text_start', contentIndex: textIndex, partial })
      }
      partial.content[textIndex].text += delta.content
      partial = { ...partial, content: [...partial.content] }
      stream.push({ type: 'text_delta', contentIndex: textIndex, delta: delta.content, partial })
    }
    if (Array.isArray(delta.tool_calls)) {
      start()
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : partial.content.length
        while (partial.content.length <= idx) {
          const i = partial.content.length
          partial.content.push({ type: 'toolCall', id: '', name: '', arguments: {} })
          stream.push({ type: 'toolcall_start', contentIndex: i, partial })
        }
        const block = partial.content[idx]
        if (tc.id) block.id = tc.id
        if (tc.function?.name) block.name = tc.function.name
        if (tc.function?.arguments) {
          const prev = typeof block._raw === 'string' ? block._raw : ''
          block._raw = prev + tc.function.arguments
          try {
            block.arguments = JSON.parse(block._raw)
          } catch {
            block.arguments = {}
          }
          stream.push({ type: 'toolcall_delta', contentIndex: idx, delta: tc.function.arguments, partial })
        }
      }
    }
    if (choice.finish_reason) {
      if (textIndex >= 0) {
        stream.push({ type: 'text_end', contentIndex: textIndex, content: partial.content[textIndex].text, partial })
      }
      for (let i = 0; i < partial.content.length; i++) {
        if (partial.content[i].type === 'toolCall') {
          delete partial.content[i]._raw
          stream.push({ type: 'toolcall_end', contentIndex: i, toolCall: partial.content[i], partial })
        }
      }
      const reason = choice.finish_reason === 'tool_calls' ? 'toolUse' : choice.finish_reason === 'length' ? 'length' : 'stop'
      const u = chunk.usage
      if (u) {
        partial.usage = {
          input: u.prompt_tokens ?? 0,
          output: u.completion_tokens ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: u.total_tokens ?? 0,
          cost: { ...EMPTY_USAGE.cost },
        }
      }
      partial.stopReason = reason
      stream.push({ type: 'done', reason, message: partial })
      return
    }
  }
  if (!started) {
    fail(stream, model, 'empty stream')
    return
  }
  stream.push({ type: 'done', reason: 'stop', message: partial })
}

async function consumeAnthropic(res: Response, stream: AssistantMessageEventStream, model: any) {
  let partial: any = emptyAssistant(model)
  let started = false
  const start = () => {
    if (started) return
    started = true
    stream.push({ type: 'start', partial })
  }
  for await (const ev of readSse(res)) {
    if (!ev.data || ev.data === '[DONE]') continue
    let chunk: any
    try {
      chunk = JSON.parse(ev.data)
    } catch {
      continue
    }
    const type = ev.event || chunk.type
    if (type === 'message_start') {
      start()
      continue
    }
    if (type === 'content_block_start') {
      start()
      const block = chunk.content_block ?? {}
      const index = chunk.index ?? partial.content.length
      if (block.type === 'tool_use') {
        while (partial.content.length <= index) partial.content.push({ type: 'toolCall', id: '', name: '', arguments: {} })
        partial.content[index] = { type: 'toolCall', id: block.id, name: block.name, arguments: block.input ?? {}, _raw: '' }
        stream.push({ type: 'toolcall_start', contentIndex: index, partial })
      } else {
        while (partial.content.length <= index) partial.content.push({ type: 'text', text: '' })
        partial.content[index] = { type: 'text', text: block.text ?? '' }
        stream.push({ type: 'text_start', contentIndex: index, partial })
      }
      continue
    }
    if (type === 'content_block_delta') {
      const index = chunk.index ?? 0
      const delta = chunk.delta ?? {}
      if (delta.type === 'text_delta' && delta.text) {
        if (!partial.content[index]) partial.content[index] = { type: 'text', text: '' }
        partial.content[index].text += delta.text
        stream.push({ type: 'text_delta', contentIndex: index, delta: delta.text, partial })
      } else if (delta.type === 'input_json_delta' && delta.partial_json) {
        const block = partial.content[index]
        if (block) {
          block._raw = (block._raw || '') + delta.partial_json
          try {
            block.arguments = JSON.parse(block._raw)
          } catch {
            block.arguments = {}
          }
          stream.push({ type: 'toolcall_delta', contentIndex: index, delta: delta.partial_json, partial })
        }
      }
      continue
    }
    if (type === 'content_block_stop') {
      const index = chunk.index ?? 0
      const block = partial.content[index]
      if (block?.type === 'text') stream.push({ type: 'text_end', contentIndex: index, content: block.text, partial })
      else if (block?.type === 'toolCall') {
        delete block._raw
        stream.push({ type: 'toolcall_end', contentIndex: index, toolCall: block, partial })
      }
      continue
    }
    if (type === 'message_delta') {
      const stop = chunk.delta?.stop_reason
      if (stop === 'tool_use') partial.stopReason = 'toolUse'
      else if (stop === 'max_tokens') partial.stopReason = 'length'
      else partial.stopReason = 'stop'
      const u = chunk.usage
      if (u) {
        partial.usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
          cost: { ...EMPTY_USAGE.cost },
        }
      }
      continue
    }
    if (type === 'message_stop') {
      const reason = partial.stopReason === 'toolUse' ? 'toolUse' : partial.stopReason === 'length' ? 'length' : 'stop'
      stream.push({ type: 'done', reason, message: partial })
      return
    }
    if (type === 'error' || chunk.error) {
      fail(stream, model, chunk.error?.message || chunk.message || 'anthropic error')
      return
    }
  }
  if (!started) fail(stream, model, 'empty stream')
  else stream.push({ type: 'done', reason: 'stop', message: partial })
}

export async function streamViaGateway(model: any, context: any, options?: { signal?: AbortSignal }) {
  const stream = new AssistantMessageEventStream()
  const run = async () => {
    const base = gatewayUrl()
    if (!base) {
      fail(stream, model, '未配置 GATEWAY_URL')
      return
    }
    const apiKey = gatewayApiKey()
    if (!apiKey) {
      fail(stream, model, '未配置 GATEWAY_API_KEY')
      return
    }
    const provider = model.provider || 'deepseek'
    const path = apiFor(provider)
    const body = path === '/v1/messages' ? toAnthropic(context, model) : toOpenAI(context, model)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    }
    if (path === '/v1/messages') headers['anthropic-version'] = '2023-06-01'
    let res: Response
    try {
      res = await fetch(base + path, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: options?.signal,
      })
    } catch (e) {
      fail(stream, model, `Gateway 不可达：${(e as Error).message}`)
      return
    }
    const ctype = res.headers.get('content-type') || ''
    if (!res.ok && !ctype.includes('text/event-stream')) {
      const text = await res.text()
      let msg = text
      try {
        const j = JSON.parse(text)
        msg = j.error?.message || j.error || text
      } catch {}
      fail(stream, model, typeof msg === 'string' ? msg : JSON.stringify(msg))
      return
    }
    if (path === '/v1/messages') await consumeAnthropic(res, stream, model)
    else await consumeOpenAI(res, stream, model)
  }
  void run()
    .catch((e) => fail(stream, model, (e as Error).message))
    .finally(() => stream.end())
  return stream
}

export { stubModel }
