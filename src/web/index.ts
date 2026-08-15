import type { Context } from '@deepseek-ai/cordis'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionEvent } from '../session/types.ts'
import { serve } from './static.ts'

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
export const inject = ['server', 'client', 'sessions', 'agents', 'llm', 'storage']

export interface Config {
  /** shell 的目录。默认仓库里的 `ui/`。 */
  root?: string
}

export function apply(ctx: Context, config: Config = {}) {
  const root = config.root ?? fileURLToPath(new URL('../../ui/', import.meta.url))

  ctx.server.get('/api/health', async (req, res) => res.json({ ok: true }))

  /**
   * 模型目录 + 哪些 provider 已配凭据 + 哪些真的能调。**凭据本身不出现在响应里。**
   *
   * `configured` 是「我们的 SQLite 里存了 key」，`available` 是「pi-ai 认为这家
   * 现在能调」——后者还包含只配了环境变量的那些。两个都给，界面才能说清「这家为
   * 什么能用」。
   */
  ctx.server.get('/api/models', async (req, res) =>
    res.json({
      catalog: ctx.llm.catalog(),
      configured: await ctx.llm.configured(),
      available: await ctx.llm.available(),
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

  /**
   * shell 与 SPA 兜底。
   *
   * 未知路径回落到 index.html，所以深链接（`/tasks`、`/kb/xxx`）直接可用，前端
   * 不需要退回 hash 路由。
   */
  ctx.server.get('/{*path}', async (req, res, next) => {
    const response = await next()
    if (response || res.claimed) return response
    // `/api/*` 的缺失由上面那条 JSON 404 负责。这里必须闪开，否则前端 fetch 到
    // 一个不存在的接口时拿到的是一段 HTML。
    if (req.path.startsWith('/api/')) return
    if (serve(res, root, req.path)) return
    const index = join(root, 'index.html')
    if (!existsSync(index)) {
      res.status = 404
      return res.text('satu-web: 找不到 ui/index.html')
    }
    res.headers.set('content-type', 'text/html; charset=utf-8')
    res.headers.set('cache-control', 'no-cache')
    return res.text(tapIndex(readFileSync(index, 'utf8'), ctx))
  })
}

/**
 * 把插件表与运行时单例注进 index。
 *
 * 每次渲染都重新注入，所以刷新一定是对着**当前**的组合启动的——`cordis.yml` 里
 * 注释掉一行，刷新之后那一屏连同它的导航项一起消失，不需要重新构建前端。
 *
 * 注入点是 `<head>` 之后的第一个位置：importmap 必须先于任何用裸说明符的模块，
 * 否则浏览器已经开始解析就来不及了。
 */
function tapIndex(html: string, ctx: Context) {
  const imports = { ...ctx.client.imports(), '@satu/shell': '/shell/index.js' }
  // `<` 转义掉：插件 id 是可控的，但这条防线不该依赖「谁不会起坏名字」。
  const json = (value: unknown) => JSON.stringify(value).replaceAll('<', '\\u003c')
  const head = [
    `<script type="importmap">${json({ imports })}</script>`,
    `<script>window.__SATU_BOOT__=${json(ctx.client.graph())}</script>`,
  ].join('\n')
  return html.replace('<head>', `<head>\n${head}`)
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
