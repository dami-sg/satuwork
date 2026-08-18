import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { json } from './http.ts'
import { seat } from './seats.ts'
import { cookieName, cookieOf, verifyTicket } from './ticket.ts'

/**
 * 反代。席位的 bot 口和 noVNC 口都只听 127.0.0.1，对外只有管家这一个端口。
 *
 * 用 `node:http` 的 request 而不是 fetch：聊天是 SSE，要的是**流**——fetch 那套在这
 * 条路径上要自己接 ReadableStream 再往 res 里倒，pipe 一行就够的事没必要绕。
 *
 * 两条路径两套鉴权，因为调用方不同：
 *
 *   /seats/:id/bot/*   Gateway 调    x-satuwork-machine: smt_
 *   /seats/:id/vnc/*   浏览器直连     Gateway 签的短期 ticket → path 限定 cookie
 *
 * bot 那条**原样透传 authorization**：bot 自己要验席位票（`sat_`），管家不掺和，
 * 所以用一个自己的头，两层互不干扰。
 */

const BOT_PREFIX = /^\/seats\/([^/]+)\/bot(\/.*)?$/
const VNC_PREFIX = /^\/seats\/([^/]+)\/vnc(\/.*)?$/

export interface ProxyDeps {
  machineToken: () => string
  gatewayUrl: () => string
}

function machineTokenOk(req: IncomingMessage, expected: string): boolean {
  const given = String(req.headers['x-satuwork-machine'] || '')
  if (!expected || !given || given.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

function pipeUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  path: string,
  headers: Record<string, string | string[]>,
) {
  const upstream = httpRequest(
    { host: '127.0.0.1', port, method: req.method, path, headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers as Record<string, string | string[]>)
      up.pipe(res)
    },
  )
  upstream.on('error', (e) => {
    if (!res.headersSent) json(res, 502, { error: '席位没有响应: ' + (e as Error).message })
    else res.end()
  })
  // 客户端先走（关标签页、Gateway 取消 SSE），上游连接不能留着。
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

function forwardHeaders(req: IncomingMessage, port: number): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    // hop-by-hop 与我们自己的鉴权头不往下传；host 要换成上游的。
    if (k === 'host' || k === 'connection' || k === 'x-satuwork-machine' || k === 'cookie') continue
    headers[k] = v
  }
  headers.host = `127.0.0.1:${port}`
  return headers
}

/** 注册到 Router.intercept。返回 true 表示这个请求已经被反代接管。 */
export function proxyIntercept(deps: ProxyDeps) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const bot = BOT_PREFIX.exec(url.pathname)
    if (bot) {
      const row = seat(bot[1])
      if (!machineTokenOk(req, deps.machineToken())) {
        json(res, 401, { error: '无效的机器凭证' })
        return true
      }
      if (!row) {
        json(res, 404, { error: '没有这个席位' })
        return true
      }
      pipeUpstream(req, res, row.botPort, (bot[2] || '/') + url.search, forwardHeaders(req, row.botPort))
      return true
    }

    const vnc = VNC_PREFIX.exec(url.pathname)
    if (!vnc) return false
    const seatId = vnc[1]
    const row = seat(seatId)
    if (!row) {
      json(res, 404, { error: '没有这个席位' })
      return true
    }
    const rest = vnc[2] || '/'
    const ticket = url.searchParams.get('ticket')
    if (ticket) {
      // 入口带票 → 换成一张 path 限定的 cookie 再跳转。之后 noVNC 自己发的那些请求
      // （静态资源、WebSocket 升级）就不用把票挂在 URL 上到处跑了。
      const ok = await verifyTicket(ticket, deps.gatewayUrl())
      if (!ok || ok.seatId !== seatId) {
        json(res, 401, { error: '桌面票无效或已过期' })
        return true
      }
      const base = `/seats/${encodeURIComponent(seatId)}/vnc`
      const maxAge = Math.max(60, ok.exp - Math.floor(Date.now() / 1000))
      res.writeHead(302, {
        'set-cookie': `${cookieName(seatId)}=${encodeURIComponent(ticket)}; Path=${base}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`,
        location: `${base}/vnc.html`,
        'cache-control': 'no-store',
      })
      res.end()
      return true
    }
    const fromCookie = cookieOf(req, cookieName(seatId))
    const okCookie = fromCookie ? await verifyTicket(fromCookie, deps.gatewayUrl()) : undefined
    if (!okCookie || okCookie.seatId !== seatId) {
      json(res, 401, { error: '桌面票无效或已过期' })
      return true
    }
    pipeUpstream(req, res, row.novncPort, rest + url.search, forwardHeaders(req, row.novncPort))
    return true
  }
}

/**
 * WebSocket 升级。noVNC 的画面全走这条。
 *
 * 不引 ws 库：升级就是把原始 socket 接起来。用 `http.request` 发同样的升级请求，
 * 拿到上游的 `upgrade` 事件之后把两个 socket 对接，剩下的字节我们不看也不改。
 */
export function attachUpgrade(server: Server, deps: ProxyDeps) {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const bail = (line: string) => {
      try {
        socket.write(`HTTP/1.1 ${line}\r\nconnection: close\r\n\r\n`)
      } catch {}
      socket.destroy()
    }
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const vnc = VNC_PREFIX.exec(url.pathname)
      if (!vnc) return bail('404 Not Found')
      const seatId = vnc[1]
      const row = seat(seatId)
      if (!row) return bail('404 Not Found')
      const token = cookieOf(req, cookieName(seatId))
      const ok = token ? await verifyTicket(token, deps.gatewayUrl()) : undefined
      if (!ok || ok.seatId !== seatId) return bail('401 Unauthorized')

      // `connection` 在普通反代里是 hop-by-hop，要摘掉；但在升级请求里它**就是**
      // 那个把请求变成升级的头。摘了上游不会发 101，Node 的客户端也不会触发
      // 'upgrade' 事件，表现就是干等到超时。所以这里补回去。
      const headers = forwardHeaders(req, row.novncPort)
      headers.connection = 'Upgrade'
      headers.upgrade = String(req.headers.upgrade || 'websocket')
      const upstream = httpRequest({
        host: '127.0.0.1',
        port: row.novncPort,
        method: req.method,
        path: (vnc[2] || '/') + url.search,
        headers,
      })
      upstream.on('upgrade', (upRes, upSocket, upHead) => {
        const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`]
        for (const [k, v] of Object.entries(upRes.headers)) {
          for (const one of Array.isArray(v) ? v : [v]) if (one !== undefined) lines.push(`${k}: ${one}`)
        }
        socket.write(lines.join('\r\n') + '\r\n\r\n')
        if (upHead?.length) socket.write(upHead)
        upSocket.pipe(socket)
        socket.pipe(upSocket)
        const shut = () => {
          upSocket.destroy()
          socket.destroy()
        }
        upSocket.on('error', shut)
        socket.on('error', shut)
        upSocket.on('close', shut)
        socket.on('close', shut)
      })
      upstream.on('error', () => bail('502 Bad Gateway'))
      // 有些客户端把第一帧和升级请求粘在一起发，那段字节在 head 里，不转就丢了。
      if (head?.length) upstream.write(head)
      upstream.end()
    })().catch(() => bail('500 Internal Server Error'))
  })
}
