/**
 * 可见目录，以及反代到席位实例的那一组：目录下发、桌面、日志、部署、对话。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { INSTANCE_DOWN, desktopTicketFor } from '../lib/machines.ts'
import { KIND, bodyOf, deployOptsOf, strField } from '../lib/validate.ts'
import type { Account, CatalogItem } from '../db.ts'
import { companyMachineOf, deploySeat, publicSeatRuntime, releaseSeats } from '../deploy.ts'
import { LEGACY_BOT_ICONS, botContext, botIconOf, botNameOf, defaultBotModel, extraPromptOf, iconSetFor, publicBot, publicCatalog, publicSkill, runtimeServer } from '../lib/catalog.ts'
import { kindOf, requirePlatformToken, requireSeatOnly, requireUser } from '../lib/guards.ts'
import { machineHeader, managerTargetFor, pairRuntime, proxyDownload, proxyJson, proxySse, proxyUpload, requireSeat, seatBearer, seatTargetFor, seatTargetForSession, visibleBotOf } from '../lib/runtime.ts'

/**
 * 一个人最多建几个 Bot。
 *
 * 有上限是因为**每个 Bot 都是机器上的一个真实进程**（一个席位一套 systemd 单元、一块
 * 屏、一个端口），不是一行配置。默认 10 够一个人分工用，真不够就调环境变量，不必改码。
 */
export const MAX_USER_BOTS = Math.max(1, Math.trunc(Number(process.env.GATEWAY_MAX_USER_BOTS) || 10))

/**
 * 「这份目录变了没有」的指纹。
 *
 * 四样东西并成一个串：公司模版的版本号、这一颗 Bot 自己的 updatedAt、可见的
 * Skill/MCP 里最新的那个 updatedAt，以及它们的条数。改模版、改 Bot 的名字头像、
 * 给公司加一个 MCP、删掉一个 Skill，都会让它变。
 *
 * 条数不能省：只看「最新的那个时间」的话，删掉一条不会让任何时间变小，实例就永远
 * 以为没事。
 */
function catalogStamp(version: number, bot: CatalogItem | undefined, tools: CatalogItem[]): string {
  const toolsAt = tools.reduce((n, i) => Math.max(n, i.updatedAt), 0)
  return `${version}:${bot?.updatedAt ?? 0}:${toolsAt}:${tools.length}`
}

/** 自己建的那一颗。别人的、公司的、全局的都不是——改和删都走它。 */
async function ownBotOf(db: RouteCtx['db'], account: Account, id: string) {
  const item = await db.catalog((id || '').trim())
  if (!item || item.kind !== 'bot' || item.scope !== 'user' || item.accountId !== account.id) {
    throw new HttpError(404, '没有这个 Bot')
  }
  return item
}

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
    let bots = await db.botsFor(companyId, account.id)
    if (botId) {
      const hit = bots.find((b) => b.id === botId)
      if (!hit) throw new HttpError(404, '没有这个 Bot')
      bots = [hit]
    }
    const { pinned, tpl } = await botContext(db, companyId)
    const skills = await db.visibleCatalog('skill', companyId)
    const servers = await db.visibleCatalog('mcp', companyId)
    json(res, 200, {
      // 实例照着这个数字判断「底座换了没有」。和下面那条探针给的是同一个值。
      templateVersion: tpl.version,
      /**
       * **这一份内容的指纹，和探针给的算法完全一样。**
       *
       * 一起给出来，实例才有一个和这份数据同时刻的基线。少了它，实例只能拿第一次探针
       * 的结果当基线，而在「拉完目录」到「第一次探针」之间落地的改动就永远丢了——
       * 那两件事之间隔着一整轮插件启动，几百毫秒到几十秒都可能。
       */
      stamp: catalogStamp(tpl.version, botId ? bots[0] : undefined, [...skills, ...servers]),
      bots: bots.map((b) => publicBot(b, pinned, tpl)),
      skills: skills.map(publicSkill),
      servers: servers.map(runtimeServer),
    })
  })

  /**
   * 「有没有变」的探针。席位实例每分钟打一次，指纹没动就什么都不做。
   *
   * 为什么不让实例直接重拉整份目录：那一份里带着 MCP 的明文 token 和全部 Skill 正文，
   * 一家公司几十个席位每分钟各拉一遍，既是没必要的字节，也是没必要的密钥流动。
   */
  router.get('/runtime/catalog/version', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const companyId = account.role === 'owner' ? null : account.companyId
    const botId = (req.query.get('botId') || '').trim()
    const tplItem = companyId ? await db.botTemplate(companyId) : undefined
    const version = Number((tplItem?.definition as { version?: unknown } | undefined)?.version) || 1
    const bots = await db.botsFor(companyId, account.id)
    const bot = botId ? bots.find((b) => b.id === botId) : undefined
    if (botId && !bot) throw new HttpError(404, '没有这个 Bot')
    const tools = [
      ...(await db.visibleCatalog('skill', companyId)),
      ...(await db.visibleCatalog('mcp', companyId)),
    ]
    json(res, 200, { templateVersion: version, stamp: catalogStamp(version, bot, tools) })
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
    // 平台指定的那一对和公司模版，整份名册共用一次——每行各读一遍没有意义。
    const { pinned, tpl } = await botContext(db, account.companyId)
    const bots = await Promise.all(
      (await db.botsFor(account.companyId, account.id)).map(async (item) => ({
        ...publicBot(item, pinned, tpl),
        runtime: await pairRuntime(db, account, item.id),
      })),
    )
    json(res, 200, { bots, quota: { used: await db.countUserBots(account.id), max: MAX_USER_BOTS } })
  })

  /**
   * 自己建一个 Bot。
   *
   * **这一层只收身份**：名字、头像、简介、开场白，外加一段追加提示词。人设、行为边界、
   * 记忆策略、能用哪些 Skill / MCP 全部来自公司模版（见 lib/catalog.ts 的 publicBot），
   * 这里既不存也不收——收了就会有人以为自己改得动，而下一次读仍然是模版那一份。
   *
   * 建完还没有席位。要真的能聊，得再点一次「部署」（`POST /runtime/deploy`）——一个
   * Bot 一个进程，那是机器上的真实开销，不该在填完名字的一瞬间悄悄发生。
   */
  router.post('/runtime/bots', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const body = bodyOf(req)
    const used = await db.countUserBots(account.id)
    if (used >= MAX_USER_BOTS) throw new HttpError(409, `最多建 ${MAX_USER_BOTS} 个 Bot`)
    const item = await db.insertCatalog({
      kind: 'bot',
      scope: 'user',
      companyId: account.companyId,
      accountId: account.id,
      name: botNameOf(body.name),
      definition: {
        description: strField(body, 'description', false),
        greeting: strField(body, 'greeting', false),
        extraPrompt: extraPromptOf(body.extraPrompt),
        icon: botIconOf(body.icon, 'company'),
        enabled: true,
      },
    })
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'bot.create',
      detail: { id: item.id, name: item.name },
    })
    const { pinned, tpl } = await botContext(db, account.companyId)
    json(res, 201, { bot: { ...publicBot(item, pinned, tpl), runtime: null } })
  })

  /** 改自己那一个。同样只认身份字段——底座在模版里，这里传什么都不看。 */
  router.patch('/runtime/bots/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const item = await ownBotOf(db, account, req.params.id)
    const body = bodyOf(req)
    const def = { ...(item.definition as Record<string, unknown>) }
    if (body.description !== undefined) def.description = String(body.description).trim()
    if (body.greeting !== undefined) def.greeting = String(body.greeting).trim()
    if (body.extraPrompt !== undefined) def.extraPrompt = extraPromptOf(body.extraPrompt)
    // 跨层级的键（全局那套）当没传，保留原值——跟平台侧那条 patch 一个规矩。
    // 走 botIconOf 的话不认识的键会落回默认头像，改一次名字顺手把头像也冲了。
    if (typeof body.icon === 'string') {
      const key = LEGACY_BOT_ICONS[body.icon.trim()] ?? body.icon.trim()
      if (iconSetFor('company').has(key)) def.icon = key
    }
    if (typeof body.enabled === 'boolean') def.enabled = body.enabled
    const next = await db.updateCatalog(item.id, {
      name: body.name !== undefined ? botNameOf(body.name) : undefined,
      definition: def,
    })
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'bot.update',
      detail: { id: item.id, name: next.name },
    })
    const { pinned, tpl } = await botContext(db, account.companyId)
    json(res, 200, { bot: { ...publicBot(next, pinned, tpl), runtime: await pairRuntime(db, account, next.id) } })
  })

  /**
   * 删自己那一个，**连席位一起拆**。
   *
   * 只删目录项的话，机器上那套 systemd 单元还在跑、还占着 slot 和端口，而库里已经没有
   * 任何东西指向它了——下一个人的席位起不来，现场没有一条线索指回这次删除。
   */
  router.delete('/runtime/bots/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const item = await ownBotOf(db, account, req.params.id)
    const seat = await db.seatRuntime(account.id, item.id)
    if (seat) {
      try {
        await releaseSeats(db, [seat])
      } catch (e) {
        throw new HttpError(502, `席位没拆干净，先重试或者联系管理员：${(e as Error).message}`)
      }
      await db.deleteSeatRuntimeOf(account.id, item.id)
    }
    await db.deleteCatalog(item.id)
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'bot.delete',
      detail: { id: item.id, name: item.name, seat: seat?.seatId ?? null },
    })
    json(res, 200, { deleted: true, id: item.id })
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
    const { pinned, tpl } = await botContext(db, account.companyId)
    json(res, 200, { bot: { ...publicBot(bot, pinned, tpl), runtime: await pairRuntime(db, account, bot.id) } })
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
