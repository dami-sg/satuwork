import type { Context } from 'cordis'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Satuwork 的前端服务。
 *
 * 一个进程、一个端口：同一棵 Cordis 树里，这个插件既发 SPA 也挂 API，
 * 前后端不拆成两个服务。
 *
 * `inject` 声明的服务在 apply 运行时保证就绪；如果 server 之后消失（被卸载或
 * 热替换），本插件会自动卸载并在它回来时重新加载——所以下面不需要任何
 * "server 还在吗" 的防御性判断。
 */
export const name = 'satu-web'
export const inject = ['server']

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
}

export interface Config {
  /** SPA 构建产物目录，相对本文件解析。 */
  dist?: string
}

export function apply(ctx: Context, config: Config = {}) {
  const dist = config.dist
    ? normalize(config.dist)
    : fileURLToPath(new URL('../../ui/dist/', import.meta.url))

  // ── API ───────────────────────────────────────────────────────────────
  // 契约是我们自己的。会话、消息、事件流接下来长在这里。
  ctx.server.get('/api/health', async (req, res) => {
    return res.json({
      ok: true,
      // 证明路由活在同一棵树里、看得到兄弟服务
      services: ['server', 'timer'].filter((n) => Boolean(ctx.get(n as never))),
    })
  })

  // 未知的 /api/* 必须是 JSON 404，不能掉进下面的 SPA 兜底——否则前端 fetch
  // 拿到的是一段 HTML，报错信息会指向 JSON 解析而不是真正的路由缺失。
  ctx.server.all('/api/{*rest}', async (req, res) => {
    res.status = 404
    return res.json({ error: 'unknown endpoint', path: req.path })
  })

  // ── SPA ───────────────────────────────────────────────────────────────
  // 放在最后注册：未命中的路径一律回 index.html，交给前端路由。
  ctx.server.get('/{*path}', async (req, res) => {
    const rel = normalize(decodeURIComponent(req.path)).replace(/^(\.\.[/\\])+/, '')
    let file = join(dist, rel)
    if (!file.startsWith(dist)) {
      res.status = 403
      return res.text('forbidden')
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html')
    if (!existsSync(file)) {
      res.status = 404
      return res.text('satu-web: ui/dist 还没构建')
    }
    res.headers.set('content-type', MIME[extname(file)] ?? 'application/octet-stream')
    res.headers.set('cache-control', 'no-cache')
    return res.bytes(new Uint8Array(await readAll(file)))
  })

  ctx.logger?.info?.(`satu-web: 发 ${dist}`)
}

/** 小文件一次读完即可；SPA 资源不需要流式。 */
function readAll(file: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    createReadStream(file)
      .on('data', (c) => chunks.push(c as Buffer))
      .on('end', () => resolve(Buffer.concat(chunks)))
      .on('error', reject)
  })
}
