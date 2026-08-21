/**
 * 机器配对，以及管家/实例回连 Gateway 的那一组（心跳、ready、会话索引）。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { MIN_MANAGER_NODE, desiredManagerRelease, gatewayBaseFor, machineHostOf, managerHostOf, normalizePairingCode, sendReleaseFile } from '../lib/machines.ts'
import { MIN_MANAGER_PROTOCOL, botBaseOf, managerHealth, normalizeTimezone, publicMachine } from '../deploy.ts'
import { accessUrlFor } from '../lib/catalog.ts'
import { bodyOf, intField, strField } from '../lib/validate.ts'
import { callerAccountId, requireBootstrapMachine, requireInternalCaller, requireMachine } from '../lib/guards.ts'
import { instanceHostOf, sourceIpOf } from '../lib/runtime.ts'
import { type Machine } from '../db.ts'

/**
 * 席位报上来的 guard / outcome 只认这两张表里的值。
 *
 * 和 `gateway/src/lib/catalog.ts` 的 BOT_GUARD_IDS 是同一套键，外加 `escalate`
 * ——转人工不是一条开关，但它和那三条走同一条上报路。
 */
const GUARD_IDS = new Set(['high-risk', 'pii', 'no-external', 'escalate'])
const GUARD_OUTCOMES = new Set(['blocked', 'approved', 'denied', 'timeout', 'redacted', 'escalated'])

export function attachInternal(router: Router, ctx: RouteCtx) {
  const { db } = ctx

  /**
   * 配对。**这条路由没有登录态**——配对码本身就是凭据，装机的人手里只有它。
   *
   * 做完三件事：签一把 `smt_`、把机器地址记成请求的来源 IP、**立刻回拨一次**确认
   * Gateway 真能打到这台机器。最后那一下不能省：不然「配对成功但打不通」会拖到第
   * 一次部署才暴露，那时装机的人已经离开机器了。
   *
   * 回拨用 challenge 而不是 `smt_`：那一刻票还在我们手里，管家还没收到响应。
   */
  router.post('/machines/pair', async (req, res) => {
    const body = bodyOf(req)
    const code = normalizePairingCode(strField(body, 'code'))
    const port = intField(body, 'managerPort') ?? 8443
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'managerPort 不合法')
    const protocol = intField(body, 'protocol') ?? 0
    const managerVersion = strField(body, 'managerVersion', false) || null
    const challenge = strField(body, 'challenge', false)

    const now = Date.now()
    const pairing = await db.machinePairing(code)
    // 不存在 / 用过 / 过期一律同一句话：区分了就是在帮人猜码。
    if (!pairing || pairing.usedAt || pairing.expiresAt <= now) throw new HttpError(401, '配对码无效或已过期')
    const company = await db.company(pairing.companyId)
    if (!company) throw new HttpError(404, '公司不存在')

    const ip = sourceIpOf(req)
    if (!ip) throw new HttpError(400, '取不到来源地址，无法配对')
    const host = managerHostOf(`${ip.includes(':') ? `[${ip}]` : ip}:${port}`)

    // 一家公司可以有多台机器。**同一个地址算同一台**——重跑装机脚本是修复手段，
    // 不该凭空多出一台机器；地址不同才是新增。重配会换一把新票，旧管家立刻失效。
    const existing = await db.machineByHost(company.id, host)
    const machine = await db.tx(async () => {
      let row: Machine
      if (existing) {
        await db.rotateMachineToken(existing.id)
        row = (await db.updateMachine(existing.id, {
          host,
          companyId: company.id,
          pairedAt: now,
          managerVersion,
          protocol,
          lastError: null,
        }))!
        row = (await db.machine(existing.id))!
      } else {
        row = await db.insertMachine({ companyId: company.id, host, pairedAt: now, managerVersion, protocol })
      }
      if (!(await db.claimMachinePairing(code, row.id, now))) throw new HttpError(401, '配对码无效或已过期')
      // machineId 现在只是「默认那台」，多机之后调度由 machineForAccount 决定。
      // 第一台配上时顺手把它设成默认，并补上访问地址。
      if (!company.machineId) {
        await db.updateCompany(company.id, {
          machineId: row.id,
          accessUrl: company.accessUrl ?? accessUrlFor(company.slug),
        })
      }
      await db.audit({
        companyId: company.id,
        accountId: pairing.createdBy,
        action: existing ? 'machine.repair' : 'machine.pair',
        detail: { machineId: row.id, host, managerVersion, protocol },
      })
      return row
    })

    const probe = challenge ? await managerHealth(host, { challenge }) : { ok: false, error: '没有 challenge，跳过回拨' }
    if (!probe.ok) await db.updateMachine(machine.id, { lastError: `Gateway 打不到 ${host}：${probe.error}` })
    json(res, 201, {
      machineId: machine.id,
      token: machine.token,
      host,
      reachable: probe.ok,
      error: probe.ok ? null : probe.error,
      protocolTooOld: protocol < MIN_MANAGER_PROTOCOL,
    })
  })

  // ── 机器服务凭证。登记用引导票；心跳 / ready / 索引 / 用量用每台机器的 smt_。──

  router.post('/internal/machines', async (req, res) => {
    requireBootstrapMachine(req)
    const body = bodyOf(req)
    const id = body.id != null ? strField(body, 'id', false) || undefined : undefined
    const rawHost = body.host != null ? strField(body, 'host', false) : ''
    const host = rawHost ? machineHostOf(rawHost) : null
    if (id && await db.machine(id)) throw new HttpError(409, '这台机器已经登记')
    const machine = await db.insertMachine({ id, host })
    json(res, 201, { machine: { ...publicMachine(machine), token: machine.token } })
  })

  /**
   * 心跳。也是自升级的下发通道。
   *
   * **升级是心跳驱动，不是 Gateway 推送**：推送要求推的那一刻机器在线且可达，
   * 心跳驱动只要机器最终上线就会收敛，灰度也只是改一个数字。响应里带上期望版本，
   * 管家发现和自己不一样就去换——换不换、什么时候换，由管家自己决定（部署跑到
   * 一半时它会跳过这一轮）。
   */
  /**
   * 管家的收尾回执：「席位停完了，我也要退出了」。收到就真删那一行。
   *
   * 收不到也不会卡住——墓碑有 TTL，sweepRemovedMachines 会收掉。回执的意义是让常见
   * 情况（机器活着、收到了信）当场干净收场，而不是干等十分钟。
   */
  router.post('/internal/machines/:id/removed', async (req, res) => {
    const machine = await requireMachine(req, db)
    if (machine.id !== req.params.id) throw new HttpError(403, '机器凭证与路径不符')
    if (!machine.removedAt) throw new HttpError(409, '这台机器没有被移除')
    await db.deleteMachine(machine.id)
    json(res, 200, { ok: true })
  })

  router.post('/internal/machines/:id/heartbeat', async (req, res) => {
    const machine = await requireMachine(req, db)
    if (machine.id !== req.params.id) throw new HttpError(403, '机器凭证与路径不符')
    // 这台机器已经在平台上被移除了，这一下心跳就是把消息交给它的机会。
    //
    // **不更新任何字段**：它不在册了，写 lastHeartbeatAt 只会让墓碑看起来还活着。
    // 也不回 401——那是否定式信号，管家分不出「我被移除了」和「Gateway 那边出了
    // 状况」，据此自毁的话一次库回滚就能带走整个机队。见 Machine.removedAt。
    if (machine.removedAt) {
      json(res, 200, { removed: true, minNode: MIN_MANAGER_NODE, minProtocol: MIN_MANAGER_PROTOCOL })
      return
    }
    const body = (bodyOf(req) ?? {}) as Record<string, unknown>
    const managerVersion = typeof body.managerVersion === 'string' ? body.managerVersion.trim() : ''
    const protocol = Number(body.protocol)
    const upgradeError = typeof body.upgradeError === 'string' ? body.upgradeError.slice(0, 500) : null
    // 管家自报的 process.arch。只收认识的两个值——它决定给这台机器发哪个包，
    // 收一个乱七八糟的字符串只会让选包静默退回「按未知处理」。
    const rawArch = typeof body.arch === 'string' ? body.arch.trim() : ''
    const arch = rawArch === 'x64' || rawArch === 'arm64' ? rawArch : undefined
    // 管家自报的机器实际时区。**过一遍同一个校验器**——它来自网络，最后会显示在
    // 界面上；不认识的名字宁可当成「没报」，也不要存一个假的实际值进去，那会让
    // 「改上了没有」这个判断永远错。老管家不报，那时保持原样。
    const reportedTz = typeof body.timezone === 'string' ? normalizeTimezone(body.timezone) : undefined
    const next = await db.updateMachine(machine.id, {
      lastHeartbeatAt: Date.now(),
      ...(managerVersion ? { managerVersion } : {}),
      ...(Number.isInteger(protocol) ? { protocol } : {}),
      ...(arch ? { arch } : {}),
      ...(reportedTz === undefined ? {} : { currentTimezone: reportedTz }),
      lastError: upgradeError,
    })
    const desired = await desiredManagerRelease(db, next)
    json(res, 200, {
      machine: { id: next.id, lastHeartbeatAt: next.lastHeartbeatAt },
      desiredManagerVersion: desired?.version ?? null,
      url: desired ? `${gatewayBaseFor(req)}/internal/manager-releases/${encodeURIComponent(desired.version)}` : null,
      sha256: desired?.sha256 ?? null,
      // 期望时区。空 = 没人指定过，管家什么都不做——**不是**「改成 UTC」。
      timezone: next.timezone,
      minNode: MIN_MANAGER_NODE,
      minProtocol: MIN_MANAGER_PROTOCOL,
    })
  })

  /** 管家自升级拉包。和 bot 发布包同一套鉴权：这台机器的 `smt_`。 */
  router.get('/internal/manager-releases/:version', async (req, res) => {
    await requireMachine(req, db)
    await sendReleaseFile(res, 'manager', req.params.version, db)
  })

  /**
   * 管家按版本拉 bot 发布包。**取代了原来逐席位 scp 一遍完整安装包**——同一版本
   * 一台机器只拉一次，解在 /opt/satuwork/releases 下全机共享。
   */
  router.get('/internal/bot-releases/:version', async (req, res) => {
    await requireMachine(req, db)
    await sendReleaseFile(res, 'bot', req.params.version, db)
  })

  router.post('/internal/instances/:accountId/ready', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const account = await db.account(req.params.accountId)
    if (!account) throw new HttpError(404, '账号不存在')
    if (!account.companyId) throw new HttpError(403, '没有公司席位')
    if (account.companyId !== caller.companyId) throw new HttpError(403, '机器不属于这家公司')
    // 席位票只能报自己上线，不能替同公司的别人报。
    if (caller.kind === 'seat' && caller.account.id !== account.id) throw new HttpError(403, '席位票只能上报自己')
    const body = bodyOf(req)
    const botId = strField(body, 'botId')
    // 先校验 body.host 再查席位：它仍然是这条接口的输入契约，格式不对要 400，
    // 不能因为「席位还没部署」这个更靠后的原因把 400 盖成 404。
    const reportedHost = instanceHostOf(strField(bodyOf(req), 'host'))
    const seat = await db.seatRuntime(account.id, botId)
    if (!seat) throw new HttpError(404, '还没有部署')
    // **不再采信 body.host。** bot 报的是自己看到的地址，而它只听 127.0.0.1；那个
    // 地址对管家是对的，对 Gateway 是打不通的。以前采信它，结果是 bot 一上线就把
    // Gateway 写好的地址覆盖成 loopback，之后 Gateway 再也打不到这个 bot。
    // 现在只认管家的反代入口，这条上报的意义只剩「我起来了」。
    //
    // 例外只有 stub：那条路径上根本没有管家，bot 自报是唯一的地址来源。
    const reported = process.env.SATUWORK_DEPLOY_STUB === '1' ? reportedHost : ''
    // 反代入口来自**席位实际所在**的那台机器。管家自己报时就是它自己；bot 用席位票
    // 报时按 seat.machineId 查——不能回落到公司默认机器，多机公司会写出错的地址。
    const machine = caller.kind === 'machine' ? caller.machine : await db.machine(seat.machineId)
    const instance = await db.upsertInstance({
      accountId: account.id,
      botId,
      companyId: account.companyId,
      host: reported || botBaseOf(machine?.host ?? null, seat.seatId),
    })
    json(res, 200, { instance })
  })

  router.post('/internal/sessions/index', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const companyId = caller.companyId
    const body = bodyOf(req)
    const sessionId = strField(body, 'sessionId')
    const accountId = callerAccountId(caller, () => strField(body, 'accountId'))
    const bodyCompany = strField(body, 'companyId', false)
    if (bodyCompany && bodyCompany !== companyId) throw new HttpError(403, '机器不属于这家公司')
    const account = await db.account(accountId)
    if (!account || account.companyId !== companyId) throw new HttpError(403, '账号不属于这家公司')
    const botIdRaw = body.botId == null ? undefined : strField(body, 'botId', false)
    const titleRaw = body.title == null ? undefined : strField(body, 'title', false)
    const originRaw = body.origin == null ? undefined : strField(body, 'origin', false)
    const remoteIdRaw = body.remoteId == null ? undefined : strField(body, 'remoteId', false)
    // machineId **一律服务端算**，不收 body。它决定了之后拉全文时 Gateway 去敲哪台
    // 机器、带哪把票；采信 body 等于让调用方指定这条会话「属于」哪台机器。
    // 席位票那条按**账号**查机器，不按 botId：会话根事件不一定带 botId（`data.botId ||
    // null`），按 botId 查的话这种会话就落不到机器上，拉全文时又回落到公司默认机器——
    // 正是 machineTokenFor 修掉的那个 host/token 错配。账号粘住机器（见
    // docs/gateway-runtime.md §3.0），所以取该账号任意一个席位的机器都是对的。
    const machineId =
      caller.kind === 'machine'
        ? caller.machine.id
        : (await db.seatRuntimesOfAccount(accountId))[0]?.machineId ?? null
    const session = await db.upsertSessionIndex({
      sessionId,
      companyId,
      accountId,
      botId: botIdRaw === undefined ? undefined : botIdRaw || null,
      machineId: machineId ?? undefined,
      origin: originRaw === undefined ? undefined : originRaw || null,
      remoteId: remoteIdRaw === undefined ? undefined : remoteIdRaw || null,
      messageCount: intField(body, 'messageCount'),
      title: titleRaw === undefined ? undefined : titleRaw || null,
      createdAt: intField(body, 'createdAt'),
      updatedAt: intField(body, 'updatedAt'),
    })
    json(res, 200, { session })
  })

  /**
   * 行为边界的表态。席位那边每拦一次、每批一次都往这里报一条。
   *
   * **它是这三个开关对管理员的全部价值。** 只拦不报的话，界面上开关开着、
   * 而没有任何一处回答得了「上个月拦了几次、拦的是谁、批的是谁」——那时候它是个
   * 心理安慰，不是一条合规证据。
   *
   * 用 `requireInternalCaller`：席位票 `sat_` 只能报自己那个账号（body 里的 accountId
   * 对它不作数），管家的机器票能替本机任意席位报。和会话索引那条是同一套口径。
   *
   * **落审计，不落新表。** 审计表已经有公司、账号、动作、详情、时间这五样，
   * 而这条记录要的就是这五样；另起一张表意味着「操作记录」那一屏要查两处，
   * 而人不会记得去第二处翻。
   */
  router.post('/internal/guard-events', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const body = bodyOf(req)
    const accountId = callerAccountId(caller, () => strField(body, 'accountId'))
    const account = await db.account(accountId)
    if (!account || account.companyId !== caller.companyId) throw new HttpError(403, '账号不属于这家公司')

    const guard = strField(body, 'guard')
    const outcome = strField(body, 'outcome')
    // 白名单，不是原样收下：`action` 会进审计的检索面，让上报方自己定义动作名，
    // 那一栏迟早会长出十几种拼写。
    if (!GUARD_IDS.has(guard)) throw new HttpError(400, 'guard 不认识')
    if (!GUARD_OUTCOMES.has(outcome)) throw new HttpError(400, 'outcome 不认识')

    const event = await db.audit({
      companyId: caller.companyId,
      accountId,
      action: `bot.guard.${outcome}`,
      detail: {
        guard,
        tool: strField(body, 'tool', false),
        botId: strField(body, 'botId', false),
        sessionId: strField(body, 'sessionId', false),
        callId: strField(body, 'callId', false),
        // **理由是席位那边生成的一句中文，不含被拦下来的原值**（见 policy/pii.ts）。
        // 把刚拦住的号码抄进审计，等于挡了门又从窗户递出去。
        reason: strField(body, 'reason', false).slice(0, 500),
        at: intField(body, 'at') ?? Date.now(),
      },
    })
    json(res, 200, { event })
  })

  /**
   * 这里以前还有一条 `POST /internal/usage`：收下、查一遍租户边界、**不写库**。
   *
   * 它是旧版 bot 的兼容层——那时候 bot 在轮次结束时把这一轮的 token 报上来，
   * 而模型调用本来就是走 `/v1/chat/completions` 从 Gateway 出去的，那条路上
   * `recordLlmCall` 已经按请求记了一行 llm_calls。两边都记，用量直接翻倍。
   * 新版 bot 早就不发了（见 bot/src/session/gateway.ts），端点留着只是为了不让
   * 旧席位的本地重试队列卡死。旧版已经清理，这条一并拆掉。
   */
}
