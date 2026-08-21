/**
 * 最小 HTTP JSON-RPC MCP 客户端。不引 @modelcontextprotocol/sdk。
 * stdio 不在这里处理。
 */
import type { ToolRisk } from '../tools/index.ts'

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

/**
 * 一次 RPC 的默认时限。
 *
 * 本地 MCP 八秒绰绰有余，但连接器不一样：发一封邮件、查一遍 CRM，十几秒是常态。
 * 所以这个数可以由目录下发（`timeoutMs`）——Gateway 给连接器那几条填 60 秒。
 */
const DEFAULT_TIMEOUT_MS = 8000

export class McpHttpClient {
  private nextId = 1
  sessionId?: string

  constructor(
    readonly endpoint: string,
    readonly token: string,
    readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
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
        signal: AbortSignal.timeout(this.timeoutMs),
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

  /**
   * 调一次工具。
   *
   * `meta` 走 MCP 的 `params._meta`（协议给自定义字段留的那一格）：服务端认得就用，
   * 不认得就忽略，不会破坏握手。我们拿它送「这一次是不是用户 `@` 点名的」——
   * 那是出事后第一个要问的问题，只有这一侧知道答案。
   */
  async callTool(name: string, args: unknown, meta?: Record<string, unknown>): Promise<string> {
    const result = (await this.rpc('tools/call', {
      name,
      arguments: args ?? {},
      ...(meta && Object.keys(meta).length ? { _meta: meta } : {}),
    })) as {
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

/**
 * 一把 MCP 工具的风险面。
 *
 * 两个来源，**只叠加、不相减**：
 *
 *  1. 服务器的 `perm`（管理员在目录里配的：只读 / 可写 / 需审批）。它是**权威**——
 *     说可写就是可写。
 *  2. 远端工具名里的动词。连接器那批合成出来的服务器 perm 默认是「只读」（见
 *     gateway/src/lib/connectors.ts 的 connectorDefOf），而同一把连接里躺着
 *     `GMAIL_SEND_EMAIL`。只信 perm 的话，「对外发送前先征求同意」这条边界对连接器
 *     整个失效——而那正是它最该管住的地方。
 *
 * 动词表只往严了推，永远不会把一把「可写」的工具降回只读：判断错一次的代价是多问
 * 一句，反过来是一封已经发出去的邮件。
 */
const MUTATING_VERBS = [
  'send', 'create', 'add', 'insert', 'update', 'patch', 'edit', 'modify', 'write', 'upload',
  'post', 'reply', 'forward', 'move', 'archive', 'label', 'assign', 'invite', 'schedule',
  'publish', 'share', 'set', 'put', 'pay', 'transfer', 'charge', 'refund', 'order', 'submit',
  'approve', 'merge', 'close', 'complete', 'execute', 'run', 'trigger', 'import', 'sync',
]
const DESTRUCTIVE_VERBS = ['delete', 'remove', 'destroy', 'purge', 'drop', 'trash', 'revoke', 'cancel', 'terminate', 'wipe']

export function mcpToolRisk(perm: string, remoteName: string): ToolRisk[] {
  // MCP 工具一律出这台席位——它打的是另一个进程、另一台主机。
  const risk = new Set<ToolRisk>(['external', 'read'])
  if (perm === '可写' || perm === '需审批') risk.add('write')
  const words = remoteName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (words.some((w) => MUTATING_VERBS.includes(w))) risk.add('write')
  if (words.some((w) => DESTRUCTIVE_VERBS.includes(w))) {
    risk.add('write')
    risk.add('destructive')
  }
  return [...risk]
}

/**
 * 工具名。上限 **64**，不是 40。
 *
 * 40 太紧：连接器一家就有几十个工具，名字长得像 `FETCH_MESSAGE_BY_THREAD_ID`，
 * 截到 40 之后两个不同的工具会变成同一个名字，而重名的那个会被静默丢掉——表现是
 * 「某个工具时有时无」，最难查的一类。64 是 OpenAI 和 Anthropic 都接受的上限。
 */
export function mcpToolName(serverName: string, toolName: string): string {
  const short = sanitize(serverName).slice(0, 16) || 'srv'
  const tool = sanitize(toolName) || 'tool'
  return `mcp_${short}_${tool}`.slice(0, 64)
}

function sanitize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}
