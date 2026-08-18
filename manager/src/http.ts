import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

/**
 * 极小路由器。
 *
 * **不复用 gateway/src/http.ts**：那份的 `listen()` 写死 `GATEWAY_HOST`/`GATEWAY_PORT`，
 * `Router.handle` 的兜底 `serveUi` 写死 `gateway/ui` 目录，错误日志写死 Gateway 前缀；
 * 而且 gateway 包没有 `exports`，第三个包 import 不到。管家只有几条路由，抄一份比抽
 * 公共包动的地方少。
 */

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export type Req = IncomingMessage & {
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
}

export type Handler = (req: Req, res: ServerResponse) => Promise<void> | void

/** 请求进来先过它。返回 true 表示已经接管（反代走这条，不进路由器）。 */
export type Intercept = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>

export function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function bearer(req: IncomingMessage): string {
  const h = req.headers.authorization
  if (!h?.startsWith('Bearer ')) return ''
  return h.slice(7).trim()
}

const BODY_LIMIT = 4_000_000

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let n = 0
  for await (const chunk of req) {
    n += (chunk as Buffer).length
    if (n > BODY_LIMIT) throw new HttpError(413, 'request body too large')
    chunks.push(chunk as Buffer)
  }
  if (!chunks.length) return undefined
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'malformed JSON')
  }
}

interface Route {
  method: string
  parts: string[]
  handler: Handler
}

function match(parts: string[], path: string): Record<string, string> | null {
  const segs = path.split('/').filter(Boolean)
  if (parts.length !== segs.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(segs[i])
    else if (p !== segs[i]) return null
  }
  return params
}

export class Router {
  private routes: Route[] = []
  private intercepts: Intercept[] = []

  on(method: string, path: string, handler: Handler) {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler })
  }
  get(path: string, handler: Handler) {
    this.on('GET', path, handler)
  }
  post(path: string, handler: Handler) {
    this.on('POST', path, handler)
  }
  put(path: string, handler: Handler) {
    this.on('PUT', path, handler)
  }
  delete(path: string, handler: Handler) {
    this.on('DELETE', path, handler)
  }

  /** 反代注册在这儿：它要拿原始 req 当流用，不能让路由器先把 body 读掉。 */
  intercept(fn: Intercept) {
    this.intercepts.push(fn)
  }

  async handle(raw: IncomingMessage, res: ServerResponse) {
    const url = new URL(raw.url ?? '/', `http://${raw.headers.host ?? '127.0.0.1'}`)
    const method = (raw.method ?? 'GET').toUpperCase()
    try {
      for (const fn of this.intercepts) {
        if (await fn(raw, res, url)) return
      }
      for (const route of this.routes) {
        if (route.method !== method) continue
        const params = match(route.parts, url.pathname)
        if (!params) continue
        const req = raw as Req
        req.params = params
        req.query = url.searchParams
        req.body = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? undefined : await readBody(raw)
        await route.handler(req, res)
        if (!res.writableEnded) json(res, 204, null)
        return
      }
      json(res, 404, { error: 'unknown endpoint', path: url.pathname })
    } catch (e) {
      if (res.headersSent) {
        try {
          res.end()
        } catch {}
        return
      }
      if (e instanceof HttpError) {
        json(res, e.status, { error: e.message, ...e.extra })
        return
      }
      const err = e as Error
      console.error(`satuwork-manager: ${err.stack ?? err.message}`)
      json(res, 500, { error: 'internal error' })
    }
  }
}

export function listen(router: Router, host: string, port: number): Server {
  const server = createServer((req, res) => {
    void router.handle(req, res)
  })
  server.listen(port, host, () => {
    console.log(`satuwork-manager: listening on http://${host}:${port}`)
  })
  return server
}
