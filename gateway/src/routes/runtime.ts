/**
 * 可见目录，以及反代到席位实例的那一组：目录下发、桌面、日志、部署、对话。
 */
import type { ServerResponse } from 'node:http'
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { INSTANCE_DOWN, desktopTicketFor } from '../lib/machines.ts'
import { KIND, bodyOf, deployOptsOf, strField } from '../lib/validate.ts'
import { companyMachineOf, deploySeat, publicSeatRuntime } from '../deploy.ts'
import { defaultBotModel, publicBot, publicCatalog, publicSkill, runtimeServer } from '../lib/catalog.ts'
import { kindOf, requirePlatformToken, requireSeatOnly, requireUser } from '../lib/guards.ts'
import { WebToolError } from '../web-tools.ts'
import { runDocument, runExtract, runSearch } from '../web-service.ts'
import { machineHeader, managerTargetFor, pairRuntime, proxyDownload, proxyJson, proxySse, proxyUpload, requireSeat, seatBearer, seatTargetFor, seatTargetForSession, visibleBotOf } from '../lib/runtime.ts'

export function attachRuntime(router: Router, ctx: RouteCtx) {
  const { db, keys } = ctx

  // ── 可见目录（全局 ∪ 本公司）────────────────────────────────────────

  for (const name of Object.keys(KIND)) {
    router.get(`/catalog/${name}`, async (req, res) => {
      const account = await requireUser(req, db, keys)
      json(res, 200, { items: (await db.visibleCatalog(kindOf(name), account.companyId)).map(publicCatalog) })
    })
    router.post(`/catalog/${name}`, async (req, res) => {
      requirePlatformToken(req)
      const body = bodyOf(req)
      const item = await db.insertCatalog({
        kind: kindOf(name),
        scope: 'global',
        companyId: null,
        name: strField(body, 'name'),
        definition: body.definition ?? {},
      })
      json(res, 201, { item: publicCatalog(item) })
    })
    router.patch(`/catalog/${name}/:itemId`, async (req, res) => {
      requirePlatformToken(req)
      const item = await db.catalog(req.params.itemId)
      if (!item || item.kind !== kindOf(name) || item.scope !== 'global') throw new HttpError(404, '目录项不存在')
      const body = bodyOf(req)
      const next = await db.updateCatalog(item.id, {
        name: body.name != null ? strField(body, 'name') : undefined,
        definition: body.definition,
      })
      json(res, 200, { item: publicCatalog(next) })
    })
    router.delete(`/catalog/${name}/:itemId`, async (req, res) => {
      requirePlatformToken(req)
      const item = await db.catalog(req.params.itemId)
      if (!item || item.kind !== kindOf(name) || item.scope !== 'global') throw new HttpError(404, '目录项不存在')
      await db.deleteCatalog(item.id)
      json(res, 200, { deleted: true, id: item.id })
    })
  }

  /**
   * 实例拉目录。MCP token 与 env 明文只出现在这里，不出现在 /catalog/mcp，也不出现在
   * 管理面的 /orgs/:id/mcp-servers。**只认席位 sat_**：登录 JWT 能进来的话，任何一个
   * 成员在浏览器里就能把公司所有 MCP 的密钥读走。
   */
  router.get('/runtime/catalog', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const companyId = account.role === 'owner' ? null : account.companyId
    const botId = (req.query.get('botId') || '').trim()
    let bots = await db.visibleCatalog('bot', companyId)
    if (botId) {
      const hit = bots.find((b) => b.id === botId)
      if (!hit) throw new HttpError(404, '没有这个 Bot')
      bots = [hit]
    }
    const pinned = await defaultBotModel(db)
    const s = await db.platformSettings()
    json(res, 200, {
      bots: bots.map((b) => publicBot(b, pinned)),
      skills: (await db.visibleCatalog('skill', companyId)).map(publicSkill),
      servers: (await db.visibleCatalog('mcp', companyId)).map(runtimeServer),
      // 席位要知道 utility 是谁：网页提取的摘要走它。挑模型是平台的事，所以是下发的，
      // 不是席位自己在 cordis.yml 里配的——那等于给了一条绕过平台配置的暗路。
      models: { daily: s.daily, utility: s.utility },
    })
  })

  // ── 网页工具。密钥在平台，所以抓取也在这里做完，席位只拿结果。 ─────────
  //
  // 走 /runtime/* 而不是 /v1/*：那一面是 OpenAI/Anthropic 兼容面，明确拒 sat_；
  // 搜索是席位运行时的能力，和 /runtime/catalog 同类。用席位票还顺带把
  // (accountId, companyId) 带了出来——计量不用 body 自报家门，自报的不作数。

  /** 业务失败要成为**结果**，不是 4xx：席位那头要把它原样说给模型听。 */
  async function webCall(res: ServerResponse, run: () => Promise<unknown>) {
    try {
      json(res, 200, { ok: true, ...(await run() as object) })
    } catch (e) {
      if (e instanceof WebToolError) return json(res, 200, { ok: false, error: e.hint })
      throw e
    }
  }

  router.post('/runtime/web/search', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const body = bodyOf(req)
    await webCall(res, () =>
      runSearch(db, account, {
        query: String(body.query ?? ''),
        count: body.count == null ? undefined : Number(body.count),
        domains: Array.isArray(body.domains) ? body.domains.map(String) : [],
        exclude: Array.isArray(body.exclude) ? body.exclude.map(String) : [],
        freshness: String(body.freshness ?? ''),
      }),
    )
  })

  router.post('/runtime/web/extract', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    await webCall(res, () => runExtract(db, account, bodyOf(req).urls))
  })

  /**
   * 文档（PDF / Word / Excel）的字节。`document_read` 走这条。
   *
   * 和 extract 分开是因为它们是两件事：extract 花的是提取后端的额度，这条花的是我们
   * 自己的带宽——**不需要配任何后端**，一套刚装好的部署读 PDF 也是通的。
   */
  router.post('/runtime/web/document', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    await webCall(res, () => runDocument(db, account, bodyOf(req).urls))
  })

  router.get('/runtime/desktop', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const botId = (req.query.get('botId') || '').trim()
    if (!botId) throw new HttpError(400, 'botId 不能为空')
    const runtime = await db.seatRuntime(account.id, botId)
    if (!runtime) throw new HttpError(404, '还没有部署')
    const machine = await companyMachineOf(db, account.companyId!)
    json(res, 200, publicSeatRuntime(runtime, (await db.machine(runtime.machineId))?.host ?? null, {
      includePassword: true,
      ticket: desktopTicketFor(keys, machine, runtime),
    }))
  })

  /**
   * 席位现场诊断。转发管家的 `/seats/:id/diag`。
   *
   * **给「席位本人」用，不是只给平台管理员。** 出问题的是他那块屏，而管理员未必在场；
   * 报告里也没有凭据（管家那侧只报文件的存在与时间，日志过了脱敏）。要它下沉到这一层，
   * 才算真的补上「没有 SSH 就看不见机器」这个洞。
   */
  router.get('/runtime/diag', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const t = await managerTargetFor(db, account, (req.query.get('botId') || '').trim())
    const lines = Number(req.query.get('lines') || 40)
    const q = Number.isFinite(lines) ? `?lines=${Math.min(200, Math.max(1, Math.trunc(lines)))}` : ''
    await proxyJson(res, 'GET', `${t.base}/seats/${encodeURIComponent(t.seatId)}/diag${q}`, undefined, undefined, t.machineToken)
  })

  /**
   * 席位 bot 的运行日志。`follow=1` 跟着滚（SSE），否则给最近 N 行。
   *
   * 和 diag 是一对：那条回答「它活着吗」，这条回答「它卡在哪一步」。这一层最贵的
   * 故障恰恰都不报错——单元 active、端口有人听，只是那一轮永远不结束——不看日志
   * 就只能靠猜，而没有 SSH 的时候连猜的依据都没有。
   *
   * 只看**自己席位**的：seatRuntime 按 (account.id, botId) 查，管理员也调不出别人的。
   * 日志里有对话正文和 bash 跑过的命令，这条线不该松。机器票留在 Gateway，浏览器
   * 只拿自己的席位票——它是管家的 root 控制面凭据，一步都不能往下放。
   */
  router.get('/runtime/logs', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const t = await managerTargetFor(db, account, (req.query.get('botId') || '').trim())
    const lines = Math.min(2000, Math.max(1, Math.trunc(Number(req.query.get('lines')) || 200)))
    const follow = req.query.get('follow') === '1'
    const url = `${t.base}/seats/${encodeURIComponent(t.seatId)}/logs?lines=${lines}${follow ? '&follow=1' : ''}`
    if (follow) await proxySse(req, res, url, undefined, t.machineToken)
    else await proxyJson(res, 'GET', url, undefined, undefined, t.machineToken)
  })

  router.post('/runtime/deploy', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const out = await deploySeat(db, keys, account, deployOptsOf(req))
    if (!out.ok) throw new HttpError(out.status, out.error)
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'runtime.deploy',
      detail: {
        botId: out.result.runtime.botId,
        linuxUser: out.result.runtime.linuxUser,
        seatId: out.result.runtime.seatId,
        slot: out.result.runtime.slot,
        status: out.result.runtime.status,
      },
    })
    json(res, 200, publicSeatRuntime(out.result.runtime, out.result.machine.host, {
      includePassword: true,
      ticket: desktopTicketFor(keys, out.result.machine, out.result.runtime),
    }))
  })

  // ── 对话。名册走 Gateway 目录；会话才反代到该 pair 的实例。────────

  router.get('/runtime/bots', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    // 平台指定的那一对，整份名册共用一次——每行各读一次设置没有意义。
    const pinned = await defaultBotModel(db)
    const bots = await Promise.all(
      (await db.visibleCatalog('bot', account.companyId)).map(async (item) => ({
        ...publicBot(item, pinned),
        runtime: await pairRuntime(db, account, item.id),
      })),
    )
    json(res, 200, { bots })
  })

  router.get('/runtime/bots/:id/session', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const bot = await visibleBotOf(db, account, req.params.id)
    const target = await seatTargetFor(db, account, bot.id)
    const url = `${target.host}/api/bots/${encodeURIComponent(bot.id)}/session`
    const bearerTok = await seatBearer(db, account.id)
    let r: Response
    try {
      r = await fetch(url, {
        headers: {
          authorization: bearerTok ? `Bearer ${bearerTok}` : '',
          accept: 'application/json',
          ...machineHeader(target.machineToken),
        },
        signal: AbortSignal.timeout(15000),
      })
    } catch {
      throw new HttpError(503, INSTANCE_DOWN)
    }
    const text = await r.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = { error: text.slice(0, 200) || INSTANCE_DOWN }
    }
    if (r.ok && parsed && typeof parsed === 'object' && account.companyId) {
      const sessionId = (parsed as { sessionId?: unknown }).sessionId
      if (typeof sessionId === 'string' && sessionId) {
        await db.upsertSessionIndex({
          sessionId,
          companyId: account.companyId,
          accountId: account.id,
          botId: bot.id,
        })
      }
    }
    json(res, r.status, parsed)
  })

  router.get('/runtime/bots/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const bot = await visibleBotOf(db, account, req.params.id)
    json(res, 200, { bot: { ...publicBot(bot, await defaultBotModel(db)), runtime: await pairRuntime(db, account, bot.id) } })
  })

  router.get('/runtime/sessions/:id/events', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const after = req.query.get('after')
    // tail：头一次连上只要最近几轮，别把整段历史推一遍（见 bot 的 replay.ts）。
    const tail = Math.min(50, Math.max(0, Math.trunc(Number(req.query.get('tail')) || 0)))
    const parts: string[] = []
    if (after != null && after !== '') parts.push(`after=${encodeURIComponent(after)}`)
    if (tail > 0) parts.push(`tail=${tail}`)
    const q = parts.length ? `?${parts.join('&')}` : ''
    await proxySse(
      req,
      res,
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/events${q}`,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 再往前翻一页历史。游标是上一页最靠前那条的 seq。
   *
   * 和那条流分开走：翻页是人点出来的一次性动作，塞进流里既要发明请求帧，又会让
   * 重连的游标语义变浑。
   */
  router.get('/runtime/sessions/:id/history', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const before = Math.max(0, Math.trunc(Number(req.query.get('before')) || 0))
    const turns = Math.min(50, Math.max(1, Math.trunc(Number(req.query.get('turns')) || 20)))
    await proxyJson(
      res,
      'GET',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/history?turns=${turns}${before ? `&before=${before}` : ''}`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  router.post('/runtime/sessions/:id/messages', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const body = bodyOf(req)
    // 图片带的是**工作区里的路径**，不是字节——文件早就传上去了（见上面那条 files）。
    // 真正的校验（路径越界、文件在不在、格式模型认不认）在席位那头，那里才有工作区。
    const images = Array.isArray(body.images)
      ? body.images.slice(0, 10).map((x) => {
          const o = (x ?? {}) as Record<string, unknown>
          return { path: String(o.path ?? ''), mime: String(o.mime ?? '') }
        })
      : undefined
    await proxyJson(
      res,
      'POST',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/messages`,
      images?.length ? { text: strField(body, 'text', false), images } : { text: strField(body, 'text') },
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  router.post('/runtime/sessions/:id/abort', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    await proxyJson(
      res,
      'POST',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/abort`,
      {},
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 上传附件到这条会话的工作区。字节边收边转，Gateway 不落地。
   *
   * 文件名走 header 而不是查询串：查询串会进访问日志，而文件名常常就是内容本身
   * （「二季度裁员名单.xlsx」）。
   */
  router.postRaw('/runtime/sessions/:id/files', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const filename = req.headers['x-filename']
    await proxyUpload(
      req,
      res,
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/files`,
      typeof filename === 'string' ? { 'x-filename': filename } : {},
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 预览（或下载）这条会话所在席位的工作区里的一个文件。
   *
   * 上传进来的和 Bot 自己写出来的走同一条路——它们本来就在同一个目录里。越界检查在
   * 席位那头（workspace 服务），这里只负责证明「这个人有权打这台席位」。
   */
  router.get('/runtime/sessions/:id/files', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const path = req.query.get('path') ?? ''
    if (!path.trim()) throw new HttpError(400, 'path 不能为空')
    const q = `?path=${encodeURIComponent(path)}${req.query.get('download') === '1' ? '&download=1' : ''}`
    await proxyDownload(
      req,
      res,
      `${target.host}/api/workspace/file${q}`,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })
}
