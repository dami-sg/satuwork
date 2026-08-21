import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '../session/types.ts'
import { historySlice } from '../session/replay.ts'
import { stat } from 'node:fs/promises'
import { WorkspaceError } from '../workspace/index.ts'
import type { ImageRef, Mention } from '../agent/index.ts'

/**
 * Satuwork 的 HTTP API。无头运行时：不发 SPA，未知路径 JSON 404。
 *
 * `inject` 里的服务在 apply 运行时保证就绪；它们之后消失也会连带卸载本插件，
 * 所以下面不需要任何「服务还在吗」的防御判断。
 */
export const name = 'satu-web'
export const inject = ['server', 'sessions', 'agents', 'llm', 'storage', 'roster', 'workspace']

export interface Config {
}

export function apply(ctx: Context, _config: Config = {}) {

  /** 运行时地址。真正听在哪个端口由 server 服务说了算。 */
  console.log(`satuwork: runtime ${ctx.server.baseUrl}`)

  ctx.server.get('/api/health', async (req, res) => {
    res.json({ ok: true })
  })

  /**
   * 模型目录。来自 Gateway /v1/models 的缓存。本机没有密钥。
   */
  ctx.server.get('/api/models', async (req, res) => {
    const catalog = await ctx.llm.refresh()
    res.json({
      catalog,
      configured: [],
      available: await ctx.llm.available(),
      gateway: ctx.llm.url || null,
    })
  })

  /** 生效设置。只读：改模型 / 提示词在 Gateway。 */
  ctx.server.get('/api/settings', async (req, res) => {
    res.json({
      provider: ctx.agents.provider,
      model: ctx.agents.model,
      system: ctx.agents.system,
    })
  })

  ctx.server.put('/api/settings', async (req, res) => {
    res.status = 410
    res.json({ error: '模型配置在 Gateway' })
  })

  ctx.server.put('/api/credentials/:provider', async (req, res) => {
    res.status = 410
    res.json({ error: 'credentials live on Gateway' })
  })

  ctx.server.get('/api/sessions', async (req, res) => {
    res.json(await ctx.sessions.list())
  })

  ctx.server.post('/api/sessions', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as { title?: string; botId?: string; agentId?: string }
    const botId = body.botId || body.agentId
    if (!botId) {
      res.status = 400
      res.json({ error: 'botId 不能为空' })
      return
    }
    const bot = ctx.roster.get(botId)
    if (!bot) {
      res.status = 404
      res.json({ error: `没有这个助理：${botId}` })
      return
    }
    res.json({
      id: await ctx.sessions.create({
        title: body.title ?? bot.name,
        botId: bot.id,
        origin: bot.origin,
        remoteId: bot.remoteId,
      }),
    })
  })

  ctx.server.get('/api/sessions/:id/events', async (req, res) =>
    sse(ctx, req.params.id, Number(req.query.get('after') ?? 0), res, Number(req.query.get('tail') ?? 0)),
  )

  /**
   * 往前翻历史。一页几轮，游标是上一页最靠前那条的 seq。
   *
   * 走普通 HTTP 而不是塞进那条流：翻页是**人点出来的一次性动作**，和「跟着看新消息」
   * 不是一回事。混在一条流里，既要发明一套请求帧，又会让重连的游标语义变浑。
   */
  ctx.server.get('/api/sessions/:id/history', async (req, res) => {
    const before = Number(req.query.get('before') ?? 0)
    const turns = Math.min(50, Math.max(1, Number(req.query.get('turns') ?? 20)))
    try {
      const all = await ctx.sessions.events(req.params.id)
      res.json(historySlice(all, { turns, before: before > 0 ? before : undefined }))
    } catch (e) {
      res.status = 404
      res.json({ error: (e as Error).message })
    }
  })

  /**
   * 发消息。三岔，不是两岔：
   *
   * | 情况 | 走法 |
   * |---|---|
   * | 没在跑 | 新一轮 |
   * | 在跑、消息**不带** `@` | steering——工具跑到一半也能插话 |
   * | 在跑、消息**带** `@` | 入队，这一轮跑完自动接上 |
   *
   * 第三岔是必须的：steering 是插进正在进行的那一轮，而那一轮的工具表早就定了，
   * 而 `@` 的全部意义就是改工具表。插进去的话点名会静静地不起作用。
   *
   * **前端需要知道走了哪一岔**（原来那句「不需要知道」不成立了）：排队的那条要画成
   * 输入框顶上的一行 dock，不是消息气泡。
   */
  ctx.server.post('/api/sessions/:id/messages', async (req, res) => {
    const body = (await req.json().catch(() => ({}))) as { text?: string; images?: unknown; mentions?: unknown }
    let images: ImageRef[]
    try {
      images = await imageRefs(ctx, body.images)
    } catch (e) {
      res.status = 400
      res.json({ error: (e as Error).message })
      return
    }
    const mentions = mentionList(body.mentions)
    // 带图的消息可以没有正文——「这张图什么意思」本来就常常只有一张图。
    if (!body.text?.trim() && !images.length && !mentions.length) {
      res.status = 400
      res.json({ error: 'text 不能为空' })
      return
    }
    if (ctx.agents.isRunning(req.params.id)) {
      if (mentions.length) {
        try {
          const row = ctx.agents.enqueue(req.params.id, body.text ?? '', images, mentions)
          res.json({ queued: true, queueId: row.id })
        } catch (e) {
          // 队满。**明说**，不静默丢——用户以为发出去了才是最糟的。
          res.status = 429
          res.json({ error: (e as Error).message })
        }
        return
      }
      if (await ctx.agents.steer(req.params.id, body.text ?? '', images)) {
        res.json({ steered: true })
        return
      }
      // 刚好在这几毫秒里跑完了：落回下面开新一轮，别把这条丢掉。
    }
    // 不等 turn 跑完就返回：结果通过 SSE 推，HTTP 只负责「收到了」。
    void ctx.agents.send(req.params.id, body.text ?? '', images, mentions).catch((e: Error) => {
      console.error(`satuwork: agents.send 失败：${e.message}`)
      ctx.logger?.warn?.(`agents.send 失败：${e.message}`)
    })
    res.json({ accepted: true })
  })

  /** 排着的消息。刷新页面之后 dock 靠它恢复。 */
  ctx.server.get('/api/sessions/:id/queue', async (req, res) => {
    res.json({ queued: ctx.agents.queued(req.params.id) })
  })

  /**
   * 取消一条排队的消息。
   *
   * 已经出队开跑的返回 **409**，不是静默成功：用户点取消的同一刻这一轮正好结束、队首
   * 被取出开跑，是必然会撞上的竞态。回 200 的话他会以为取消成功了，然后眼看着它跑起来。
   */
  ctx.server.delete('/api/sessions/:id/queue/:queueId', async (req, res) => {
    const r = ctx.agents.cancelQueued(req.params.id, req.params.queueId)
    if (r === 'cancelled') {
      res.json({ cancelled: true })
      return
    }
    // 两种失败分开报：**「已经开跑」和「压根没这条」对用户是完全不同的两句话**。
    // 合成一句「已经开始执行」的话，两个标签页各点一次取消，后点的那个会以为自己
    // 拦不住一条其实早就被取消掉的消息。
    res.status = r === 'started' ? 409 : 404
    res.json({ error: r === 'started' ? '已经开始执行' : '没有这条排队消息' })
  })

  /** 中止当前这一轮。 */
  ctx.server.post('/api/sessions/:id/abort', async (req, res) => {
    res.json({ aborted: ctx.agents.abort(req.params.id) })
  })

  /**
   * 上传附件。裸字节进 body，文件名走 `x-filename`（URL 编码）。
   *
   * **不用 multipart**：这条路只传一个文件，multipart 要么拉个解析依赖，要么自己写一个
   * 状态机去切 boundary——都是为了一个这里根本用不上的「多部分」语义付钱。
   *
   * 文件落进工作区（`uploads/<sessionId>/`），返回相对路径。之后模型用 read/bash 读它，
   * 浏览器用下面那条 GET 预览它——**同一份字节，没有第二处副本**。
   */
  ctx.server.post('/api/sessions/:id/files', async (req, res) => {
    const sessionId = req.params.id
    // 会话必须真的存在。Gateway 那边已经按账号校过一遍，这里再挡一次是因为
    // 「往哪个目录写」是这条路唯一的副作用，不该由一个没人认领的 id 决定。
    try {
      await ctx.sessions.events(sessionId)
    } catch {
      res.status = 404
      res.json({ error: `没有这个会话：${sessionId}` })
      return
    }
    const raw = req.headers.get('x-filename') ?? ''
    let filename = raw
    try {
      filename = decodeURIComponent(raw)
    } catch {
      // 不是合法的百分号编码就按原样用，safeName 会再洗一遍。
    }
    try {
      const saved = await ctx.workspace.saveUpload(sessionId, filename, req.body)
      ctx.logger?.info?.(`upload: ${sessionId} ← ${saved.path}（${saved.size} 字节）`)
      res.json(saved)
    } catch (e) {
      if (e instanceof WorkspaceError) {
        res.status = 400
        res.json({ error: e.message })
        return
      }
      throw e
    }
  })

  /**
   * 预览工作区里的一个文件。上传进来的和 Bot 自己写出来的走的是同一条路——
   * 它们本来就在同一个目录里，没有理由分两套。
   *
   * `?download=1` 强制另存。除此之外，能不能内联由**扩展名白名单**说了算
   * （见 workspace/index.ts 的 INLINE）：SVG 和 HTML 不在里面，它们能带脚本。
   */
  ctx.server.get('/api/workspace/file', async (req, res) => {
    const path = req.query.get('path') ?? ''
    if (!path.trim()) {
      res.status = 400
      res.json({ error: 'path 不能为空' })
      return
    }
    let file: Awaited<ReturnType<typeof ctx.workspace.open>>
    try {
      file = await ctx.workspace.open(path)
    } catch (e) {
      const err = e as NodeJS.ErrnoException
      res.status = e instanceof WorkspaceError ? 400 : err?.code === 'ENOENT' ? 404 : 500
      res.json({ error: e instanceof WorkspaceError ? e.message : err?.code === 'ENOENT' ? '文件不存在' : '读不出来' })
      return
    }
    const inline = file.inline && req.query.get('download') !== '1'
    return new Response(file.stream, {
      status: 200,
      headers: {
        'content-type': file.contentType,
        'content-length': String(file.size),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; ${dispositionName(file.name)}`,
        // 声明的类型就是最终类型。允许嗅探，等于让一个改名成 .png 的 HTML
        // 重新变回 HTML——白名单当场作废。
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    })
  })

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
    res.json({ error: 'unknown endpoint', path: req.path })
  })

  ctx.server.all('/internal/{*rest}', async (req, res, next) => {
    const response = await next()
    if (response || res.claimed) return response
    res.status = 404
    res.json({ error: 'unknown endpoint', path: req.path })
  })

  ctx.server.get('/', async (req, res) => {
    res.status = 404
    res.json({ error: 'unknown endpoint', path: req.path || '/' })
  })

  /**
   * 未知路径 JSON 404，不再回 index.html。
   */
  ctx.server.all('/{*path}', async (req, res, next) => {
    const response = await next()
    if (response || res.claimed) return response
    res.status = 404
    res.json({ error: 'unknown endpoint', path: req.path })
  })

}

/**
 * 模型真能看的图片格式。
 *
 * 是白名单不是黑名单：不在里面的（TIFF、SVG、HEIC）各家 provider 支持不一，发过去
 * 多半换回一个 400，而那个 400 长得像我们自己的 bug，查起来要绕一大圈。不如在这儿
 * 就说清楚。
 */
const MODEL_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * 请求里的图片 → 校验过的引用。
 *
 * 三件事一起做：路径必须落在工作区内（`resolve` 越界即抛）、文件必须真的在、格式必须
 * 是模型看得懂的。**路径是浏览器传上来的**，这一层不做，工作区边界就等于没有。
 */
async function imageRefs(ctx: Context, raw: unknown): Promise<ImageRef[]> {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('images 必须是数组')
  if (raw.length > 10) throw new Error('一条消息最多带 10 张图')
  const out: ImageRef[] = []
  for (const item of raw) {
    const path = typeof item?.path === 'string' ? item.path.trim() : ''
    const mime = typeof item?.mime === 'string' ? item.mime.trim().toLowerCase() : ''
    if (!path) throw new Error('images 里有一项缺 path')
    if (!MODEL_IMAGE_MIME.has(mime)) throw new Error(`这种图片格式模型看不了：${mime || '(空)'}`)
    const file = ctx.workspace.resolve(path)
    const info = await stat(file).catch(() => null)
    if (!info?.isFile()) throw new Error(`图片不存在：${path}`)
    out.push({ path: ctx.workspace.show(file), mime })
  }
  return out
}

/**
 * Content-Disposition 里的文件名。
 *
 * 两份一起给：`filename=` 是 ASCII 兜底，`filename*=` 按 RFC 5987 带 UTF-8 原名。
 * 中文名只给前者会变成乱码，只给后者老浏览器不认。ASCII 那份把引号和反斜杠也换掉——
 * 它在引号里，不换就能把这个 header 撑破。
 */
function dispositionName(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

function sse(
  ctx: Context,
  sessionId: string,
  after: number,
  res: { _res?: { on?: Function } },
  tail = 0,
) {
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
        /**
         * 排队的消息有变。
         *
         * 走同一条流，因为界面要画的是同一屏；而且**队列的真相在这边**——浏览器刷新
         * 之后必须能把 dock 恢复出来，靠它自己记就会出现「界面上没有但它还是跑了」。
         * 帧的形状和 `replay/done` 一样是个非会话事件，客户端按 type 分流。
         */
        const offQueue = ctx.on('queue/change', (id: string, queued: unknown) => {
          if (id !== sessionId) return
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'queue/change', queued })}\n\n`))
          } catch {
            /* 流已经关了，下一次心跳会清掉 */
          }
        })

        let replayed = 0
        let firstSeq: number | null = null
        let hasMore = false
        try {
          if (after > 0) {
            // 断线续传：从游标之后原样发，不切也不筛——那是「补上错过的」，
            // 和「打开页面看最近几轮」是两件事。
            for (const event of await ctx.sessions.events(sessionId, after)) {
              send(event)
              replayed++
            }
          } else {
            // 头一次连上：只发最近 tail 轮，并且丢掉已经作废的流式 chunk（见 replay.ts）。
            const slice = historySlice(await ctx.sessions.events(sessionId), { turns: tail })
            for (const event of slice.events) {
              send(event)
              replayed++
            }
            firstSeq = slice.firstSeq
            hasMore = slice.hasMore
          }
        } catch (e) {
          ctx.logger?.warn?.(`sse: 会话 ${sessionId} 读不出来：${(e as Error).message}`)
          controller.enqueue(
            encoder.encode(`event: error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`),
          )
          off()
          offQueue()
          return controller.close()
        }

        /**
         * 历史放完了。
         *
         * 这条标记**必须有**：历史和实时走的是同一个通道、同样的 `data:` 帧，客户端
         * 收到一条 `turn/start` 时没法知道它是「几小时前那一轮开始了」还是「刚刚开始
         * 了一轮」。于是重放一段长会话时，界面会一路挂着「正在处理」，直到重放出那个
         * 配对的 `turn/end`——会话越长挂得越久，而那期间什么都没在跑。
         *
         * 有了这条，客户端就能把标记之前的一律当历史，只认之后的状态。
         *
         * `live` 是**这条会话此刻到底在不在跑**，由 agents 直接给。带上它，是因为客户端
         * 原来只能从事件顺序里猜：从头扫，遇 turn/start 算在跑、遇 turn/end 算跑完，最后
         * 一个说了算。这个猜法有个前提——历史必须完整——而它经常不成立：
         *
         *   · 流断在重放中途，客户端手上就只剩半截，尾巴那条 turn/end 没到；
         *   · 进程半路没了（崩溃、机器重启、每一次「重新部署」），日志里那条 turn/end
         *     根本没写成——healDanglingTurn 要等下一次从磁盘读这条会话才补得上。
         *
         * 两种情况下界面都会一直挂着「正在处理」，而那边什么都没在跑，等多久都不会变。
         * 少几条消息是看得出来的，假装在跑不是——所以这件事不该猜，让知道的人说。
         */
        const live = ctx.agents.isRunning(sessionId)
        // 「界面为什么一直显示正在处理」全靠这一行断案：live 是 true 就是真在跑，
        // 是 false 而界面还挂着，那就是前端的事。
        ctx.logger?.info?.(
          `sse: 会话 ${sessionId} 接上，after=${after}，tail=${tail}，重放 ${replayed} 条，live=${live}，还有更早的=${hasMore}`,
        )
        controller.enqueue(
          encoder.encode(
            // 队列一起带上：刷新页面之后 dock 要能原样回来。
            `data: ${JSON.stringify({ type: 'replay/done', live, firstSeq, hasMore, queued: ctx.agents.queued(sessionId) })}\n\n`,
          ),
        )

        const pending = queue
        queue = null
        for (const event of pending) if (event.seq > after) send(event)

        /**
         * 心跳。
         *
         * **尾巴会卡在缓冲里。** 上面那些 `send()` 是 `controller.enqueue`，不阻塞——
         * 它只把事件塞进队列，什么时候真的写到浏览器由下游决定。而浏览器在 fetch 流
         * 上会攒够一定量才交付（Safari 尤其明显），于是一条安静下来的会话，最后几十
         * 条事件连同 `replay/done` 就一直压在那儿，再也没有新字节把它们顶出去。
         *
         * 实测长这样：bot 报「重放 1078 条」，客户端手上只有 1054 条，`replay/done`
         * 从没到达，而连接看着还开着、也不会重连——历史缺一截，界面因为拿不到那句
         * 「在不在跑」而永远挂着「正在处理」。哪条会话中招取决于它的字节数落在缓冲
         * 边界的哪一侧，所以刷一次换一个，看着像见了鬼。
         *
         * 一条 `: ping` 注释就够：它不是事件，客户端解析时直接跳过，但它是新字节，
         * 会把压着的那一截一起冲出去。顺带也让掉线被及时发现。
         */
        const beat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'))
          } catch {
            clearInterval(beat)
          }
        }, 15000)

        // 长连接不该等到插件卸载才释放。ctx.on 是 effect，那只是兜底。
        res._res?.on?.('close', () => {
          clearInterval(beat)
          off()
          offQueue()
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

/**
 * 请求体里的 mentions → 结构。
 *
 * **不做归属校验**：这一条是 Gateway 的活（它才知道这把连接属不属于这个账号）。
 * 席位这边只认形状——它信的是那张 `sat_` 票，票背后是谁由 Gateway 说了算。
 */
function mentionList(raw: unknown): Mention[] {
  if (!Array.isArray(raw)) return []
  const out: Mention[] = []
  for (const item of raw.slice(0, 10)) {
    const o = (item ?? {}) as Record<string, unknown>
    const id = String(o.id ?? '').trim()
    const kind = String(o.kind ?? 'connector')
    if (!id) continue
    if (kind !== 'connector' && kind !== 'bot' && kind !== 'routine') continue
    out.push({ kind, id, label: String(o.label ?? '').slice(0, 64) })
  }
  return out
}
