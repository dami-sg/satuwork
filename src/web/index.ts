import type { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionEvent } from '../session/types.ts'

/**
 * Satuwork 的前端服务与 API。
 *
 * 一个进程、一个端口：SPA 与 API 由同一棵 Cordis 树里的同一个 server 发出，
 * 前后端不拆成两个服务。浏览器与宿主之间的契约是**我们自己的**——下面这几条
 * 路由就是它的全部。
 *
 * `inject` 里的服务在 apply 运行时保证就绪；它们之后消失也会连带卸载本插件，
 * 所以下面不需要任何「服务还在吗」的防御判断。
 */
export const name = 'satu-web'
export const inject = ['server', 'sessions', 'agents', 'llm', 'storage']

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

export interface Config {
  dist?: string
}

export function apply(ctx: Context, config: Config = {}) {
  const dist = config.dist ?? fileURLToPath(new URL('../../ui/dist/', import.meta.url))

  ctx.server.get('/api/health', async (req, res) => res.json({ ok: true }))

  /** 模型目录 + 哪些 provider 已配凭据。凭据本身不出现在响应里。 */
  ctx.server.get('/api/models', async (req, res) =>
    res.json({
      catalog: ctx.llm.catalog(),
      configured: await ctx.llm.configured(),
    }),
  )

  /** 生效设置。前端设置面板读它，改完立刻对下一轮生效。 */
  ctx.server.get('/api/settings', async (req, res) =>
    res.json({
      provider: ctx.agents.provider,
      model: ctx.agents.model,
      system: ctx.agents.system,
    }),
  )

  ctx.server.put('/api/settings', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    for (const key of ['provider', 'model', 'system'] as const) {
      if (typeof body[key] === 'string') ctx.storage.setSetting('agent', key, body[key])
    }
    return res.json({ provider: ctx.agents.provider, model: ctx.agents.model, system: ctx.agents.system })
  })

  /**
   * 存一把 provider 密钥。
   *
   * 响应里**不回显密钥**，只回「配好了」。key 传空表示删除，之后该 provider
   * 重新回落到环境变量——pi-ai 的规则是存了的凭据拥有该 provider。
   */
  ctx.server.put('/api/credentials/:provider', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as { key?: string }
    await ctx.llm.setCredential(req.params.provider, body.key?.trim() || null)
    return res.json({ configured: await ctx.llm.configured() })
  })

  ctx.server.get('/api/sessions', async (req, res) => res.json(await ctx.sessions.list()))

  ctx.server.post('/api/sessions', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as { title?: string }
    return res.json({ id: await ctx.sessions.create(body.title) })
  })

  ctx.server.get('/api/sessions/:id/events', async (req, res) =>
    sse(ctx, req.params.id, Number(req.query.get('after') ?? 0), res),
  )

  ctx.server.post('/api/sessions/:id/messages', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as { text?: string }
    if (!body.text?.trim()) {
      res.status = 400
      return res.json({ error: 'text 不能为空' })
    }
    // 不等 turn 跑完就返回：结果通过 SSE 推，HTTP 只负责「收到了」。
    void ctx.agents.send(req.params.id, body.text).catch((e: Error) => {
      ctx.logger?.warn?.(`agents.send 失败：${e.message}`)
    })
    return res.json({ accepted: true })
  })

  // 未知的 /api/* 必须是 JSON 404，不能掉进下面的 SPA 兜底——否则前端 fetch
  // 拿到一段 HTML，报错会指向 JSON 解析而不是真正的路由缺失。
  ctx.server.all('/api/{*rest}', async (req, res) => {
    res.status = 404
    return res.json({ error: 'unknown endpoint', path: req.path })
  })

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
    return res.bytes(new Uint8Array(readFileSync(file)))
  })
}

/**
 * 会话事件流。
 *
 * 先补历史再转推实时，**中间不留空窗**：监听在读历史之前就装好，这期间到达的
 * 事件先入队，历史发完再放行。否则正好卡在两者之间的那条会永远丢失。
 */
function sse(ctx: Context, sessionId: string, after: number, res: { _res?: { on?: Function } }) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (event: SessionEvent) =>
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))

        let queue: SessionEvent[] | null = []
        const off = ctx.on('session/event', (id: string, event: SessionEvent) => {
          if (id !== sessionId) return
          if (queue) queue.push(event)
          else send(event)
        })

        try {
          for (const event of await ctx.sessions.events(sessionId, after)) send(event)
        } catch (e) {
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`),
          )
          off()
          return controller.close()
        }

        const pending = queue
        queue = null
        for (const event of pending) if (event.seq > after) send(event)

        // 长连接不该等到插件卸载才释放。ctx.on 是 effect，那只是兜底。
        res._res?.on?.('close', () => {
          off()
          try {
            controller.close()
          } catch {}
        })
      },
    }),
    {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    },
  )
}
