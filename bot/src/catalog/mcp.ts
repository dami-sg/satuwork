/**
 * 最小 HTTP JSON-RPC MCP 客户端。不引 @modelcontextprotocol/sdk。
 * stdio 不在这里处理。
 */

export interface JsonRpcTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export class McpHttpError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'McpHttpError'
  }
}

function headersOf(token: string, sessionId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (token) headers.authorization = `Bearer ${token}`
  if (sessionId) headers['mcp-session-id'] = sessionId
  return headers
}

async function readBody(res: Response): Promise<unknown> {
  const ctype = res.headers.get('content-type') || ''
  const text = await res.text()
  if (!text.trim()) return undefined
  if (ctype.includes('text/event-stream')) {
    let last: unknown
    for (const block of text.replace(/\r\n/g, '\n').split('\n\n')) {
      for (const line of block.split('\n')) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          last = JSON.parse(data)
        } catch {
          /* 不是 JSON 的 data 行丢掉 */
        }
      }
    }
    if (last === undefined) throw new McpHttpError('SSE 里没有 JSON-RPC 响应')
    return last
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new McpHttpError(`不是 JSON：${text.slice(0, 120)}`)
  }
}

export class McpHttpClient {
  private nextId = 1
  sessionId?: string

  constructor(
    readonly endpoint: string,
    readonly token: string,
  ) {}

  async rpc(method: string, params?: unknown, notification = false): Promise<unknown> {
    const id = notification ? undefined : this.nextId++
    const body: Record<string, unknown> = { jsonrpc: '2.0', method }
    if (id !== undefined) body.id = id
    if (params !== undefined) body.params = params
    let res: Response
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers: headersOf(this.token, this.sessionId),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      })
    } catch (e) {
      throw new McpHttpError(`连不上：${(e as Error).message}`)
    }
    const sid = res.headers.get('mcp-session-id')
    if (sid) this.sessionId = sid
    if (notification) {
      await res.arrayBuffer().catch(() => undefined)
      return undefined
    }
    if (!res.ok && res.status !== 200) {
      const text = await res.text().catch(() => '')
      throw new McpHttpError(`HTTP ${res.status}${text ? ` ${text.slice(0, 160)}` : ''}`)
    }
    const parsed = (await readBody(res)) as { result?: unknown; error?: { message?: string; code?: number } } | undefined
    if (!parsed || typeof parsed !== 'object') throw new McpHttpError('空响应')
    if (parsed.error) throw new McpHttpError(parsed.error.message || `rpc error ${parsed.error.code}`)
    return parsed.result
  }

  async initialize(): Promise<void> {
    await this.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'satuwork', version: '0.1.0' },
    })
    try {
      await this.rpc('notifications/initialized', {}, true)
    } catch {
      /* 有的服务器不认这条通知 */
    }
  }

  async listTools(): Promise<JsonRpcTool[]> {
    const result = (await this.rpc('tools/list')) as { tools?: JsonRpcTool[] } | undefined
    return Array.isArray(result?.tools) ? result!.tools! : []
  }

  async callTool(name: string, args: unknown): Promise<string> {
    const result = (await this.rpc('tools/call', { name, arguments: args ?? {} })) as {
      content?: { type?: string; text?: string }[]
      isError?: boolean
    }
    const text = Array.isArray(result?.content)
      ? result.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('')
      : JSON.stringify(result ?? null)
    if (result?.isError) return text || '工具返回了错误'
    return text
  }
}

export function mcpToolName(serverName: string, toolName: string): string {
  const short = sanitize(serverName).slice(0, 12) || 'srv'
  const tool = sanitize(toolName) || 'tool'
  return `mcp_${short}_${tool}`.slice(0, 40)
}

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}
