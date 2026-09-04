import type { Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl } from '../llm/gateway.ts'

export const name = 'satu-local-tunnel'
export const inject = ['server']

type Wire = Record<string, unknown> & { type?: string; id?: string }

function tunnelUrl(base: string): string {
  const url = new URL(base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/runtime/local-tunnel'
  url.search = ''
  url.hash = ''
  return url.href
}

export function apply(ctx: Context) {
  if ((process.env.SATUWORK_RUNTIME_KIND || '').trim() !== 'local') return
  const base = gatewayUrl()
  const token = gatewayToken()
  const botId = (process.env.SATUWORK_BOT_ID || '').trim()
  if (!base || !token || !botId) {
    ctx.logger?.warn?.('local tunnel: 缺 GATEWAY_URL / GATEWAY_TOKEN / SATUWORK_BOT_ID')
    return
  }

  let stopped = false
  let socket: WebSocket | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  const requests = new Map<string, { method: string; path: string; headers: Record<string, string>; chunks: Buffer[] }>()

  const send = (message: Wire) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }

  const handle = async (message: Wire) => {
    const id = typeof message.id === 'string' ? message.id : ''
    if (message.type === 'request' && id) {
      requests.set(id, {
        method: String(message.method || 'GET'),
        path: String(message.path || '/'),
        headers: message.headers && typeof message.headers === 'object' ? message.headers as Record<string, string> : {},
        chunks: [],
      })
      return
    }
    const request = requests.get(id)
    if (!request) return
    if (message.type === 'request/chunk') {
      if (typeof message.data === 'string') request.chunks.push(Buffer.from(message.data, 'base64'))
      return
    }
    if (message.type !== 'request/end') return
    requests.delete(id)
    try {
      const url = new URL(request.path, String(ctx.server.baseUrl || 'http://127.0.0.1'))
      const body = request.chunks.length ? Buffer.concat(request.chunks) : undefined
      const response = await fetch(url, {
        method: request.method,
        headers: request.headers,
        body,
        ...(body ? { duplex: 'half' as const } : {}),
      } as RequestInit & { duplex?: 'half' })
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => (headers[name] = value))
      send({ type: 'response', id, status: response.status, headers })
      if (response.body) {
        const reader = response.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          send({ type: 'response/chunk', id, data: Buffer.from(value).toString('base64') })
        }
      }
      send({ type: 'response/end', id })
    } catch (error) {
      send({ type: 'response/error', id, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const connect = () => {
    if (stopped) return
    try {
      socket = new WebSocket(tunnelUrl(base))
    } catch {
      retry = setTimeout(connect, 2000)
      return
    }
    socket.addEventListener('open', () => send({ type: 'auth', token, botId }))
    socket.addEventListener('message', (event) => {
      let message: Wire
      try {
        message = JSON.parse(String(event.data)) as Wire
      } catch {
        return
      }
      if (message.type === 'ready') ctx.logger?.info?.('local tunnel: 已连接 Gateway')
      else void handle(message)
    })
    socket.addEventListener('close', () => {
      requests.clear()
      if (!stopped) retry = setTimeout(connect, 2000)
    })
    socket.addEventListener('error', () => socket?.close())
  }

  // server 服务完成 init 后才有 baseUrl；和 instance ready 那条一样下一拍启动。
  retry = setTimeout(connect, 0)
  ctx.effect(() => () => {
    stopped = true
    if (retry) clearTimeout(retry)
    socket?.close()
  })
}
