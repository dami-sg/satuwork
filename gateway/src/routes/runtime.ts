/**
 * 可见目录，以及反代到席位实例的那一组：目录下发、桌面、日志、部署、对话。
 */
import type { ServerResponse } from 'node:http'
import type { RouteCtx } from './ctx.ts'
import { HttpError, bearer, json, type Router } from '../http.ts'
import { INSTANCE_DOWN, desktopTicketFor } from '../lib/machines.ts'
import { KIND, bodyOf, deployOptsOf, strField } from '../lib/validate.ts'
import type { Account, CatalogItem } from '../db.ts'
import { companyMachineOf, deploySeat, publicSeatRuntime, purgeBot } from '../deploy.ts'
import { blockMapOf, connectorDefOf, runtimeConnectorServer } from '../lib/connectors.ts'
import { LEGACY_BOT_ICONS, botContext, botIconOf, botNameOf, defaultBotModel, extraPromptOf, iconSetFor, publicBot, publicCatalog, publicSkill, runtimeServer } from '../lib/catalog.ts'
import { kindOf, originOf, requirePlatformToken, requireSeatOnly, requireUser } from '../lib/guards.ts'
import { WebToolError } from '../web-tools.ts'
import { runExtract, runSearch } from '../web-service.ts'
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
/**
 * 下发给席位的连接器超时。
 *
 * `bot/src/catalog/mcp.ts` 默认只等 8 秒——对本地 MCP 够用，对「发一封邮件」「查一遍
 * CRM」不够。Gateway 自己对上游是 45 秒（见 routes/mcp.ts），必须比这个数**小**：
 * 我们要先拿到结果再回答，否则席位那边已经断了，这一次调用记不到结果，钱也说不清。
 */
const CONNECTOR_TIMEOUT_MS = 60_000

function catalogStamp(
  version: number,
  bot: CatalogItem | undefined,
  tools: CatalogItem[],
  /**
   * 连接器那一截：这个账号的安装和连接。
   *
   * **不能省。** 员工装一个连接器、连一个新邮箱、关掉几个工具，`catalog_items` 一个
   * 字节都不会变，只看上面那三样的话探针会一直判「没变」，工具永远不出现——直到有人
   * 重新部署。
   */
  conn: { updatedAt: number; count: number } = { updatedAt: 0, count: 0 },
  /**
   * 平台钉的两个模型角色。
   *
   * **不能省。** 席位拿着 `models.utility` 去做网页摘要，而这两个角色改动时
   * `catalog_items` 一个字节都不会变——只看上面那几样的话，管理员换掉 utility（比如
   * 旧的那个下架了）之后，跑着的席位永远不会重拉目录，摘要会一直打那个已经不存在的
   * 模型，然后静静退化成「截原文前 8000 字」。
   */
  models = '',
): string {
  const toolsAt = tools.reduce((n, i) => Math.max(n, i.updatedAt), 0)
  return `${version}:${bot?.updatedAt ?? 0}:${toolsAt}:${tools.length}:${conn.updatedAt}:${conn.count}:${models}`
}

/** 两个模型角色压成一小段，进指纹用。 */
function modelStamp(s: { daily: { provider: string; model: string }; utility: { provider: string; model: string } }): string {
  return `${s.daily.provider}/${s.daily.model}|${s.utility.provider}/${s.utility.model}`
}

/** 这个账号的连接器状态指纹：安装和连接一起算，删一条也要能看出来。 */
async function connectorStampOf(db: RouteCtx['db'], accountId: string, companyId: string | null) {
  const installs = await db.connectorInstalls(accountId)
  const conns = await db.connectionsFor(accountId, companyId)
  const updatedAt = [...installs, ...conns].reduce((n, r) => Math.max(n, r.updatedAt), 0)
  return { updatedAt, count: installs.length + conns.length }
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
  const { db, keys, meter } = ctx

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

    /**
     * 连接器合成出来的 MCP 记录：这个账号每一把 `active` 的连接一条。
     *
     * `mentionOnly` 的**不进默认表**——它的全部意思就是「只有我 @ 你的时候才用你」，
     * 进了默认表等于这个开关没打开。它由发消息那一轮按 mentions 单独注入。
     *
     * endpoint 指回 Gateway 自己（`/mcp/connectors/:id`），票就用席位这次带来的
     * `sat_`——同一把票，不用再去库里取一次，也不会取错人。
     */
    const connectorItems = await db.visibleCatalog('connector', companyId)
    const blocked = blockMapOf(connectorItems)
    const conns = (await db.connectionsFor(account.id, companyId)).filter((c) => c.status === 'active')
    const synth = conns
      .map((c) => {
        const item = connectorItems.find((i) => i.id === c.connectorId && i.scope === 'global')
        if (!item || blocked.get(item.id)?.blocked) return null
        return runtimeConnectorServer(c, item, {
          origin: originOf(req),
          token: bearer(req) ?? '',
          botId,
          timeoutMs: CONNECTOR_TIMEOUT_MS,
        })
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    /**
     * **`mentionOnly` 的也下发**，只是带个标记。
     *
     * 席位那边照样连上、照样注册工具，但不进默认工具表——只有这一轮被 `@` 点名才进。
     * 不下发是不行的：真被点名时再去握手就晚了，那一轮已经在组请求了。
     */
    const synthIds = synth.filter((x) => !x.mentionOnly).map((x) => x.id)

    // 席位要知道 utility 是谁：网页提取的摘要走它。挑模型是平台的事，所以是下发的，
    // 不是席位自己在 cordis.yml 里配的——那等于给了一条绕过平台配置的暗路。
    const settings = await db.platformSettings()

    json(res, 200, {
      // 实例照着这个数字判断「底座换了没有」。和下面那条探针给的是同一个值。
      templateVersion: tpl.version,
      models: { daily: settings.daily, utility: settings.utility },
      /**
       * **这一份内容的指纹，和探针给的算法完全一样。**
       *
       * 一起给出来，实例才有一个和这份数据同时刻的基线。少了它，实例只能拿第一次探针
       * 的结果当基线，而在「拉完目录」到「第一次探针」之间落地的改动就永远丢了——
       * 那两件事之间隔着一整轮插件启动，几百毫秒到几十秒都可能。
       */
      stamp: catalogStamp(
        tpl.version,
        botId ? bots[0] : undefined,
        [...skills, ...servers],
        await connectorStampOf(db, account.id, companyId),
        modelStamp(settings),
      ),
      /**
       * 连接器绑账号、不绑 Bot：合成出来的那几条挂到**每一颗** Bot 的 `mcps` 上。
       * 席位那边 `toolSchemasFor()` 照现有逻辑按 `mcps` 过滤，一行都不用改。
       */
      bots: bots.map((b) => {
        const pub = publicBot(b, pinned, tpl)
        return { ...pub, mcps: [...pub.mcps, ...synthIds] }
      }),
      skills: skills.map(publicSkill),
      servers: [...servers.map(runtimeServer), ...synth],
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
    /**
     * **顺路把席位自己报的版本记下来。**`?have=` 是它这会儿真正跑着的那一版。
     *
     * 为什么捎在探针上、而不是另开一条上报接口：这条路本来就每分钟一趟、本来就带着席位
     * 的票，多一个查询参数是零成本；单开一条就是把每台席位的请求数翻倍，换来的信息一个
     * 字节都不多。顺带它还兼了心跳——版本对得上、汇报却停在两小时前，说明那个进程已经
     * 不在了，而这件事光看版本号看不出来。
     *
     * 只在带 botId 时记：这两列挂在 (accountId, botId) 那一行上，没有 botId 就不知道
     * 记到哪一行去。席位实例一定带（deploy 下发的 SATUWORK_BOT_ID），不带的是脚本。
     */
    const have = Number(req.query.get('have'))
    /**
     * **整数、且在 int4 里**。这一列是 `int`，一个 `have=99999999999` 会让 PG 抛
     * 22003、整条探针 500——而这条路是席位判断「目录变了没有」的唯一入口，500 之后它
     * 这一轮既拿不到 stamp 也不会重拉。一个畸形参数就能把一台席位卡住，而界面上只会
     * 显示它一直落后。认不出来的值当没带：报不上来不是错误，下一轮再说。
     */
    const sane = Number.isInteger(have) && have > 0 && have <= 2147483647
    if (botId && sane) await db.noteSeatTemplate(account.id, botId, have)
    const tools = [
      ...(await db.visibleCatalog('skill', companyId)),
      ...(await db.visibleCatalog('mcp', companyId)),
    ]
    json(res, 200, {
      templateVersion: version,
      stamp: catalogStamp(
        version,
        bot,
        tools,
        await connectorStampOf(db, account.id, companyId),
        modelStamp(await db.platformSettings()),
      ),
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
      runSearch(db, meter, account, {
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
    await webCall(res, () => runExtract(db, meter, account, bodyOf(req).urls))
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
   *
   * **席位拆不掉也照删。** 以前是拆不掉就 502、什么都不删，而管家拆席位是「先停单元
   * 再收拾目录」：中间任何一步出岔子，Bot 已经聊不了了，删除却每次都以同一个理由
   * 失败——界面上于是永远挂着一颗既用不了也删不掉的 Bot。现在那行席位留成墓碑
   * （slot 不会被下一个人分走），Bot 该删的全删，回执里说清还剩几个席位要清理。
   */
  router.delete('/runtime/bots/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const item = await ownBotOf(db, account, req.params.id)
    const { released, failed } = await purgeBot(db, item.id)
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'bot.delete',
      detail: {
        id: item.id,
        name: item.name,
        seats: released.map((s) => s.seatId),
        // 拆不掉的那些要留在审计里：机器详情页上那条「出错、没有 Bot 名」的席位
        // 是从哪来的，只有这里答得上。
        orphans: failed.map((f) => ({ seatId: f.seat.seatId, error: f.error })),
      },
    })
    json(res, 200, {
      deleted: true,
      id: item.id,
      seats: released.length,
      orphans: failed.map((f) => ({ seatId: f.seat.seatId, error: f.error })),
    })
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
    /**
     * **席位说「没有这个助理」不等于「没有这颗 Bot」，它说的是「我还不认识它」。**
     *
     * 进程刚起来那会儿目录还没拉回来（catalog 的首次 pull 是 fire-and-forget，见 bot 的
     * catalog/index.ts），名册是空的，`/api/bots/:id/session` 于是 404。这和「进程还没
     * 听上端口」是同一件事的两副面孔——一次全新部署必然把两个窗口都走一遍。
     *
     * 原样把 404 转出去的话，调用方只能在**两种含义完全相反的 404** 之间猜：这一条是
     * 「再等等就好」，而上面 visibleBotOf 那条（这颗 Bot 不是你的 / 已经删了）是「等一
     * 万年也一样」。折成 503 之后，「还没就绪」在这条接口上只有一个状态码，404 就单纯
     * 是永久错误了。席位自己那句话留在 body 里，curl 排错时还看得见。
     */
    if (r.status === 404) {
      const seatSaid = (parsed as { error?: unknown } | null)?.error
      json(res, 503, { error: typeof seatSaid === 'string' && seatSaid ? `${INSTANCE_DOWN}（席位：${seatSaid}）` : INSTANCE_DOWN })
      return
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
    /**
     * `@` 点名。**Gateway 必须逐个校验，不能原样透传。**
     *
     * 席位那边收到什么就注入什么——它信的是那张 `sat_` 票，票背后是谁由我们说了算。
     * 不属于这个账号的、断了的、公司禁了的一律**剔掉**，并在响应里说明是哪几条；
     * 不是让整条消息失败：用户那句话没有错，错的是一个已经失效的点名。
     */
    const wanted = Array.isArray(body.mentions) ? body.mentions.slice(0, 10) : []
    const mentions: { kind: string; id: string; label: string }[] = []
    const dropped: string[] = []
    if (wanted.length) {
      const companyId = account.role === 'owner' ? null : account.companyId
      const items = await db.visibleCatalog('connector', companyId)
      const blocks = blockMapOf(items)
      const defs = new Map(items.filter((i) => i.scope === 'global').map((i) => [i.id, connectorDefOf(i)]))
      const conns = new Map(
        (await db.connectionsFor(account.id, companyId)).filter((c) => c.status === 'active').map((c) => [c.id, c]),
      )
      for (const raw of wanted) {
        const o = (raw ?? {}) as Record<string, unknown>
        const id = String(o.id ?? '').trim()
        const kind = String(o.kind ?? 'connector')
        const conn = kind === 'connector' ? conns.get(id) : undefined
        const def = conn ? defs.get(conn.connectorId) : undefined
        if (!conn || !def || !def.enabled || blocks.get(conn.connectorId)?.blocked) {
          if (id) dropped.push(id)
          continue
        }
        mentions.push({ kind: 'connector', id, label: `${def.name} (${conn.label})` })
      }
    }

    await proxyJson(
      res,
      'POST',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/messages`,
      {
        text: strField(body, 'text', images?.length || mentions.length ? false : true),
        ...(images?.length ? { images } : {}),
        ...(mentions.length ? { mentions } : {}),
      },
      await seatBearer(db, account.id),
      target.machineToken,
      // 剔掉了什么要说出来：界面上那几颗药丸得消失，而人要知道为什么。
      dropped.length ? { droppedMentions: dropped } : undefined,
    )
  })

  /** 排着的消息。刷新页面之后 dock 靠它恢复——队列的真相在席位那边，不在浏览器。 */
  router.get('/runtime/sessions/:id/queue', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    await proxyJson(
      res,
      'GET',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/queue`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /** 取消一条。已经开跑的席位会回 409，原样透出去——界面据此把那一行改成气泡。 */
  router.delete('/runtime/sessions/:id/queue/:queueId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    await proxyJson(
      res,
      'DELETE',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/queue/${encodeURIComponent(req.params.queueId)}`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 还等着人拍板的高风险调用。**真相在席位那边**——等待方是那个进程里的一个 Promise，
   * Gateway 只是把它转出来；自己缓存一份的话，刷新页面看到的会是一张早就点过的卡片。
   */
  router.get('/runtime/sessions/:id/approvals', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    await proxyJson(
      res,
      'GET',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/approvals`,
      undefined,
      await seatBearer(db, account.id),
      target.machineToken,
    )
  })

  /**
   * 批准 / 拒绝。
   *
   * **鉴权就是 `seatTargetForSession`**：它已经保证了这条会话属于这个账号（那把
   * `sat_` 是按账号发的）。别人的会话在这里根本查不出席位，拿不到可以点的地方——
   * 这也是为什么这条路不能走席位票直连：那把票在员工的桌面里够得着。
   *
   * 席位回 409（这条确认已经结束）原样透出去，界面据此把卡片改成「已失效」。
   */
  router.post('/runtime/sessions/:id/approvals/:callId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const target = await seatTargetForSession(db, account, req.params.id)
    const body = bodyOf(req)
    await proxyJson(
      res,
      'POST',
      `${target.host}/api/sessions/${encodeURIComponent(req.params.id)}/approvals/${encodeURIComponent(req.params.callId)}`,
      {
        decision: strField(body, 'decision'),
        scope: strField(body, 'scope', false) || 'once',
        /**
         * 卡片上改过的那几格，**原样转发**。
         *
         * Gateway 不认字段、也不做校验：哪几格能改是席位那边算出来的（policy/forms.ts），
         * 在这儿再判一次就是同一套规则的第二份，两份迟早会漂。这里只保证形状是个对象。
         */
        ...(body.edits && typeof body.edits === 'object' && !Array.isArray(body.edits) ? { edits: body.edits } : {}),
      },
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
    // `as=text` 回的是 JSON（提取出来的文档正文），不是字节流——走 proxyJson。
    // 拿 proxyDownload 转会给它安上 content-disposition 和那条 sandbox CSP，
    // 对一段 JSON 既没意义又容易让人误以为它也是「文件字节」。
    if (req.query.get('as') === 'text') {
      await proxyJson(
        res,
        'GET',
        `${target.host}/api/workspace/file?path=${encodeURIComponent(path)}&as=text`,
        undefined,
        await seatBearer(db, account.id),
        target.machineToken,
      )
      return
    }
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
