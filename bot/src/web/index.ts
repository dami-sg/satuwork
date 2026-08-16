import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '../session/types.ts'

/**
 * Satuwork 的 HTTP API。无头运行时：不发 SPA，未知路径 JSON 404。
 *
 * `inject` 里的服务在 apply 运行时保证就绪；它们之后消失也会连带卸载本插件，
 * 所以下面不需要任何「服务还在吗」的防御判断。
 */
export const name = 'satu-web'
export const inject = ['server', 'sessions', 'agents', 'llm', 'storage', 'roster']

export interface Config {
}

export function apply(ctx: Context, _config: Config = {}) {

  /** 运行时地址。真正听在哪个端口由 server 服务说了算。 */
  console.log(`satuwork: runtime ${ctx.server.baseUrl}`)

  ctx.server.get('/api/health', async (req, res) => res.json({ ok: true }))

  /**
   * 模型目录。来自 Gateway /v1/models 的缓存。本机没有密钥。
   */
  ctx.server.get('/api/models', async (req, res) => {
    const catalog = await ctx.llm.refresh()
    return res.json({
      catalog,
      configured: [],
      available: await ctx.llm.available(),
      gateway: ctx.llm.url || null,
    })
  })

  /** 生效设置。只读：改模型 / 提示词在 Gateway。 */
  ctx.server.get('/api/settings', async (req, res) =>
    res.json({
      provider: ctx.agents.provider,
      model: ctx.agents.model,
      system: ctx.agents.system,
    }),
  )

  ctx.server.put('/api/settings', async (req, res) => {
    res.status = 410
    return res.json({ error: '模型配置在 Gateway' })
  })

  ctx.server.put('/api/credentials/:provider', async (req, res) => {
    res.status = 410
    return res.json({ error: 'credentials live on Gateway' })
  })

  ctx.server.get('/api/sessions', async (req, res) => res.json(await ctx.sessions.list()))

  ctx.server.post('/api/sessions', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as { title?: string; botId?: string; agentId?: string }
    const botId = body.botId || body.agentId
    if (!botId) {
      res.status = 400
      return res.json({ error: 'botId 不能为空' })
    }
    const bot = ctx.roster.get(botId)
    if (!bot) {
      res.status = 404
      return res.json({ error: `没有这个助理：${botId}` })
    }
    return res.json({
      id: await ctx.sessions.create({
        title: body.title ?? bot.name,
        botId: bot.id,
        origin: bot.origin,
        remoteId: bot.remoteId,
      }),
    })
  })

  ctx.server.get('/api/sessions/:id/events', async (req, res) =>
    sse(ctx, req.params.id, Number(req.query.get('after') ?? 0), res),
  )

  /**
   * 发消息。
   *
   * agent 正在跑就走 **steering**——工具跑到一半也能插话，不用等这一轮结束。
   * 否则开新的一轮。前端不需要知道这个分支，一个入口就够。
   */
  ctx.server.post('/api/sessions/:id/messages', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as { text?: string }
    if (!body.text?.trim()) {
      res.status = 400
      return res.json({ error: 'text 不能为空' })
    }
    if (ctx.agents.steer(req.params.id, body.text)) return res.json({ steered: true })
    // 不等 turn 跑完就返回：结果通过 SSE 推，HTTP 只负责「收到了」。
    void ctx.agents.send(req.params.id, body.text).catch((e: Error) => {
      console.error(`satuwork: agents.send 失败：${e.message}`)
      ctx.logger?.warn?.(`agents.send 失败：${e.message}`)
    })
    return res.json({ accepted: true })
  })

  /** 中止当前这一轮。 */
  ctx.server.post('/api/sessions/:id/abort', async (req, res) =>
    res.json({ aborted: ctx.agents.abort(req.params.id) }),
  )

  // 未知的 /api/* 必须是 JSON 404，不能掉进下面的 SPA 兜底——否则前端 fetch
  // 拿到一段 HTML，报错会指向 JSON 解析而不是真正的路由缺失。
  //
  // **先放行再兜底**：路由按注册顺序匹配，而插件是并发挂载的，这条路由没法保证
  // 自己排在最后。写死成「匹配即 404」会把后挂上来的那些屏自己的 API 一并吞掉，
  // 而且吞得毫无痕迹。
  ctx.server.all('/api/{*rest}', async (req, res, next) => {
    const response = await next()
    if (response || res.claimed) return response
    res.status = 404
    return res.json({ error: 'unknown endpoint', path: req.path })
  })

  ctx.server.all('/internal/{*rest}', async (req, res, next) => {
    const response = await next()
    if (response || res.claimed) return response
    res.status = 404
    return res.json({ error: 'unknown endpoint', path: req.path })
  })

  ctx.server.get('/', async (req, res) => {
    res.status = 404
    return res.json({ error: 'unknown endpoint', path: req.path || '/' })
  })

  /**
   * 未知路径 JSON 404，不再回 index.html。
   */
  ctx.server.all('/{*path}', async (req, res, next) => {
    const response = await next()
    if (response || res.claimed) return response
    res.status = 404
    return res.json({ error: 'unknown endpoint', path: req.path })
  })

}

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
