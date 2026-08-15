// Satuwork 的前端服务插件。
//
// 我们不用 dsh 的浏览器客户端，前端整套自己写。但**不拆成两个服务**——同一个进程、
// 同一个端口：ctx.webServer 是 dsh 的 HTTP 载体，这里做两件事
//   1. registerFallback 占下 SPA 座位，把 ui/dist 发出去（原来是 dsh 自己的
//      frontend-static 占着，那一行已在 cordis.yml 里停用）
//   2. register 挂我们自己的 API 路由；handler 掌控完整响应生命周期，SSE 这种
//      长连接也能用同一条路子
//
// 浏览器与宿主之间的契约因此是**我们自己的**，不经过 dsh 的 Typert/客户端模块
// 那一套——那是为它自己的 UI 设计的。

import { createReadStream, existsSync, statSync } from 'node:fs'
import { join, normalize, extname } from 'node:path'

export const name = 'satu-web'
export const inject = ['webServer']

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
}

export function apply(ctx, config = {}) {
  const dist = config.dist ?? new URL('../ui/dist/', import.meta.url).pathname

  // ── 我们自己的 API ────────────────────────────────────────────────────
  // 先立一个健康检查把契约的形状定下来；会话、消息、SSE 事件流接下来长在这里。
  ctx.webServer.register({
    kind: 'exact',
    path: '/api/satuwork/health',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({
        ok: true,
        // 证明这条路由确实活在同一棵 Cordis 树里、能看到宿主服务
        services: {
          agents: Boolean(ctx.get?.('agents')),
          sessions: Boolean(ctx.get?.('sessions')),
          llm: Boolean(ctx.get?.('llm')),
        },
      }))
    },
  })

  // ── SPA ───────────────────────────────────────────────────────────────
  // 座位只能有一个主人，第二次注册会抛错——所以 dsh 的 web-runtime 必须先停用。
  ctx.webServer.registerFallback((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      return res.end()
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    // 归一化后仍越界的路径直接拒绝，别让 ../ 走出 dist。
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
    let file = join(dist, rel)
    if (!file.startsWith(dist)) {
      res.writeHead(403)
      return res.end()
    }
    // 未命中一律回 index.html + 200，交给前端路由（SPA 约定）。
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html')
    if (!existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('satu-web: ui/dist 还没构建')
    }

    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    if (req.method === 'HEAD') return res.end()
    createReadStream(file).pipe(res)
  })
}

export default { name, inject, apply }
