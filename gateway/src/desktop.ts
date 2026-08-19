import { request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { verifyDesktopTicket, type JwtKeys } from './crypto.ts'
import type { Db } from './db.ts'
import { json } from './http.ts'

/**
 * 桌面反代。`/desktop/:seatId/*` → 管家的 `/seats/:seatId/vnc/*`。
 *
 * **为什么要多这一跳。** 桌面原来是浏览器直连管家：`{machine.host}/seats/:id/vnc/`。
 * 那是一个顶层跳转（新标签页打开），管家发的 `SameSite=Lax` cookie 照常放行。改成
 * 在右栏里内嵌之后，那条 cookie 就废了——iframe 里的请求既不是顶层导航，也（当
 * Gateway 和管家不同站时）不是同站请求，浏览器**连存都不会存**它，于是 vnc.html 和
 * 之后的 WebSocket 一律 401，而界面上只是一片空白。
 *
 * 走 Gateway 同域之后，cookie 是第一方的，Lax 不再挡路。顺带两个好处：
 *
 *   - 浏览器**不再需要能连到管家**。以前 Gateway 在云上、管家在公司内网时，这条路
 *     本来就走不通；现在只要 Gateway 连得到管家就行，而它本来就连得到（聊天走的就是
 *     同一条）。
 *   - 机器票（`smt_`）不进浏览器。这一跳用它认到管家那侧，浏览器手里只有一张只对
 *     一块屏、五分钟有效的桌面票。
 *
 * **代价说清楚**：桌面的像素现在全部经过 Gateway。noVNC 只在画面变化时发字节，几个
 * 席位不成问题；真要成规模，这一跳得挪到边缘去。
 */

const DESKTOP_PREFIX = /^\/desktop\/([^/]+)(\/.*)?$/

/** 每块屏一张，path 限定。名字里带 seatId，多开几块屏互不覆盖。 */
export const deskCookieName = (seatId: string) => `satu_desk_${seatId.replace(/[^A-Za-z0-9_-]/g, '')}`

function cookieOf(req: IncomingMessage, name: string): string {
  const raw = req.headers.cookie
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() !== name) continue
    return decodeURIComponent(part.slice(i + 1).trim())
  }
  return ''
}

/**
 * 允许原样带到 noVNC 落地页的显示参数。
 *
 * 右栏那块预览只有两百来像素宽，不给 `resize=scale` 的话 noVNC 按 1:1 画，看到的是
 * 桌面左上角那一小角。**白名单，不是黑名单**：`path` 和 `password` 是这条链上唯一的
 * 连接地址和唯一的凭据，两者都由票决定，放开透传等于让调用方覆盖它们。
 */
const VIEW_PARAMS = new Set(['resize', 'view_only', 'bell', 'reconnect', 'quality', 'compression'])

function viewParams(url: URL): string {
  let out = ''
  const seen = new Set<string>()
  for (const [k, v] of url.searchParams) {
    if (!VIEW_PARAMS.has(k) || seen.has(k)) continue
    if (!/^[A-Za-z0-9_.-]{1,16}$/.test(v)) continue
    seen.add(k)
    out += `&${k}=${encodeURIComponent(v)}`
  }
  return out
}

/** 这块屏在哪台机器上、拿什么认。查不到就是没有。 */
async function upstreamOf(db: Db, seatId: string): Promise<{ base: string; token: string } | undefined> {
  const row = await db.seatRuntimeBySeatId(seatId)
  if (!row) return
  const machine = await db.machine(row.machineId)
  const base = (machine?.host || '').trim().replace(/\/$/, '')
  if (!base || !machine?.token) return
  return { base, token: machine.token }
}

/** 认这张 cookie 认不认。认不过的一律当没认，不区分原因。 */
function seatOfCookie(req: IncomingMessage, keys: JwtKeys, seatId: string): boolean {
  const token = cookieOf(req, deskCookieName(seatId))
  if (!token) return false
  const ok = verifyDesktopTicket(keys, token)
  return !!ok && ok.seatId === seatId
}

function upstreamPath(seatId: string, rest: string, search: string): string {
  return `/seats/${encodeURIComponent(seatId)}/vnc${rest}${search}`
}

function pipeUpstream(
  req: IncomingMessage,
  res: ServerResponse,
  target: { base: string; token: string },
  path: string,
) {
  let url: URL
  try {
    url = new URL(target.base + path)
  } catch {
    json(res, 502, { error: '机器地址不对' })
    return
  }
  const headers: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue
    // hop-by-hop、我们自己的 cookie、以及 host 都不往下传。**cookie 尤其不能传**：
    // 那是 Gateway 这一侧的凭据，管家不需要，传过去只是多一个泄露面。
    if (k === 'host' || k === 'connection' || k === 'cookie' || k === 'authorization') continue
    headers[k] = v
  }
  headers.host = url.host
  headers['x-satuwork-machine'] = target.token
  const upstream = httpRequest(
    {
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      method: req.method,
      path: url.pathname + url.search,
      headers,
    },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers as Record<string, string | string[]>)
      up.pipe(res)
    },
  )
  upstream.on('error', (e) => {
    if (!res.headersSent) json(res, 502, { error: '连不上机器管家: ' + (e as Error).message })
    else res.end()
  })
  // 客户端先走（关标签页、收起右栏），上游连接不能留着。
  res.on('close', () => upstream.destroy())
  req.pipe(upstream)
}

/** 注册到 Router.intercept。返回 true 表示这个请求已经被反代接管。 */
export function desktopIntercept(db: Db, keys: JwtKeys) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> => {
    const hit = DESKTOP_PREFIX.exec(url.pathname)
    if (!hit) return false
    const seatId = decodeURIComponent(hit[1])
    const rest = hit[2] || '/'
    const ticket = url.searchParams.get('ticket')
    if (ticket) {
      /**
       * 入口。票换 cookie 再跳转，之后 noVNC 自己发的那些请求（静态资源、WebSocket
       * 升级）就不用把票挂在 URL 上到处跑了。
       *
       * **必须把 path 告诉 noVNC。** 它拼 WebSocket 地址的写法是 `'/' + path`，从
       * **根**开始，而 path 默认是 `websockify`——不传的话它会去连 ws://<gateway>/
       * websockify，那个路径不属于任何席位，反代认不出来直接 404。页面本身照样打得
       * 开（静态资源是相对路径），坏的只有这一条连接，而它是唯一真正要紧的那条。
       */
      const ok = verifyDesktopTicket(keys, ticket)
      if (!ok || ok.seatId !== seatId) {
        json(res, 401, { error: '桌面票无效或已过期' })
        return true
      }
      const base = `/desktop/${encodeURIComponent(seatId)}`
      const maxAge = Math.max(60, ok.exp - Math.floor(Date.now() / 1000))
      const wsPath = `${base.slice(1)}/websockify`
      // 口令由票带过来（票已经验过签），这里转成 noVNC 认的 `password=`——它只从 URL
      // 或输入框读凭据，没有别的入口。代价：这一跳之后 iframe 的地址里有明文口令。
      // 换来的是「点开就是桌面」。没带口令时照旧弹输入框，不会更差。
      const query =
        `path=${encodeURIComponent(wsPath)}&autoconnect=1` +
        (ok.vnc ? `&password=${encodeURIComponent(ok.vnc)}` : '') +
        viewParams(url)
      res.writeHead(302, {
        // Secure 跟着 Gateway 自己走：https 部署时加上，http 内网部署时加了反而
        // 会让浏览器直接丢掉这张 cookie。
        'set-cookie':
          `${deskCookieName(seatId)}=${encodeURIComponent(ticket)}; Path=${base}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax` +
          (isHttps(req) ? '; Secure' : ''),
        location: `${base}/vnc.html?${query}`,
        'cache-control': 'no-store',
      })
      res.end()
      return true
    }
    if (!seatOfCookie(req, keys, seatId)) {
      json(res, 401, { error: '桌面票无效或已过期' })
      return true
    }
    const target = await upstreamOf(db, seatId)
    if (!target) {
      json(res, 404, { error: '没有这个席位' })
      return true
    }
    pipeUpstream(req, res, target, upstreamPath(seatId, rest, url.search))
    return true
  }
}

/** 反代前面通常还有一层。有 `x-forwarded-proto` 就信它，没有就看这一跳本身。 */
function isHttps(req: IncomingMessage): boolean {
  const fwd = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase()
  if (fwd) return fwd === 'https'
  return Boolean((req.socket as { encrypted?: boolean }).encrypted)
}

/**
 * WebSocket 升级。桌面的画面全走这条。
 *
 * 不引 ws 库：升级就是把原始 socket 接起来。用 `http.request` 发同样的升级请求，拿到
 * 上游的 `upgrade` 事件之后把两个 socket 对接，剩下的字节我们不看也不改。
 */
export function attachDesktopUpgrade(server: Server, db: Db, keys: JwtKeys) {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const bail = (line: string) => {
      try {
        socket.write(`HTTP/1.1 ${line}\r\nconnection: close\r\n\r\n`)
      } catch {}
      socket.destroy()
    }
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const hit = DESKTOP_PREFIX.exec(url.pathname)
      if (!hit) return bail('404 Not Found')
      const seatId = decodeURIComponent(hit[1])
      if (!seatOfCookie(req, keys, seatId)) return bail('401 Unauthorized')
      const target = await upstreamOf(db, seatId)
      if (!target) return bail('404 Not Found')
      let up: URL
      try {
        up = new URL(target.base + upstreamPath(seatId, hit[2] || '/', url.search))
      } catch {
        return bail('502 Bad Gateway')
      }
      const headers: Record<string, string | string[]> = {}
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue
        if (k === 'host' || k === 'cookie' || k === 'authorization') continue
        headers[k] = v
      }
      headers.host = up.host
      headers['x-satuwork-machine'] = target.token
      // `connection` 在普通反代里是 hop-by-hop，要摘掉；但在升级请求里它**就是**那个
      // 把请求变成升级的头。摘了上游不会发 101，Node 也不会触发 'upgrade'，表现就是
      // 干等到超时。所以这里明确补回去。
      headers.connection = 'Upgrade'
      headers.upgrade = String(req.headers.upgrade || 'websocket')
      const upstream = httpRequest({
        protocol: up.protocol,
        hostname: up.hostname,
        port: up.port,
        method: req.method,
        path: up.pathname + up.search,
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
      upstream.on('response', (upRes) => bail(`${upRes.statusCode} ${upRes.statusMessage}`))
      upstream.on('error', () => bail('502 Bad Gateway'))
      if (head?.length) upstream.write(head)
      upstream.end()
    })()
  })
}
