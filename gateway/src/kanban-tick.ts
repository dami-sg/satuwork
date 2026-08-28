/**
 * 看板的**派**：把 `ready` 的卡送到那颗 Bot 的席位上，并且保证它一定会离开 `running`。
 *
 * 挂在已有的那个 tick 上（`GATEWAY_ROUTINE_TICK_MS`），**不新起定时器**——多一个定时器
 * 就多一处关停时要记得清的东西，忘了清的表现是进程不退出（同 handoff-sweep）。
 *
 * ## 一轮六步
 *
 * 1. **收依赖**：父卡全部 done 的 `todo` 推成 `ready`。一条 SQL
 * 2. **收死的**：先看心跳（3 分钟没报就是死了），墙钟（60 分钟）只当兜底
 * 3. **选卡**：`ready` 且过了退避，过两道并发闸（一颗 Bot 1 张、一个账号 3 张）
 * 4. **抢**：带旧值的 CAS，`ready` → `running`
 * 5. **派**：`POST {seat}/api/cards`，**立即返回**
 * 6. **等回报**：席位跑完自己打 `/internal/kanban/cards/:id/result`
 *
 * 第 5 步和 routines 那条路最大的区别是**不挂事件流、不等 `turn/end`**：routine 把消息
 * 发进人的主会话、要知道那一轮的收口；卡跑在自己的会话上，收口判据是
 * `kanban_complete` 那次调用本身，由席位直接回报。少一条要维护的长连接，也少了「等到
 * 超时但事情其实早就做完了」那个毛病。
 *
 * 整套的理由见 docs/kanban.md §8、§12、§13。
 */
import {
  CARD_ACCOUNT_CONCURRENCY,
  CARD_FAILURE_LIMIT,
  CARD_SEAT_CONCURRENCY,
  type Card,
  type Db,
} from './db.ts'
import { machineTokenFor, seatBearer } from './lib/runtime.ts'
import { notifyBlocked, reportToOwner } from './kanban-notify.ts'

/** 席位多久没报心跳就算它死了。**主要的回收路径就是这一条。** */
const STALE_MS = Math.max(60_000, Math.trunc(Number(process.env.GATEWAY_KANBAN_STALE_MS ?? 3 * 60_000)))
/**
 * 一张卡的墙钟。
 *
 * **兜底，不是主路**：它管的是「进程还活着但那一轮陷进去了」——那时心跳照报，只有它
 * 拦得住。席位那边自己也有一道 abort，两层都要有（docs/kanban.md §12）。
 */
const TIMEOUT_MS = Math.max(60_000, Math.trunc(Number(process.env.GATEWAY_KANBAN_TIMEOUT_MS ?? 60 * 60_000)))
/**
 * 真失败之后隔多久再派。
 *
 * **不能省。** 不等的话，下一个 tick（半分钟）就重派，于是一张撞了确定性错误的卡在
 * 一分钟内把两次机会全烧完，直接进 blocked——而重试这件事本来是为「上一次是个偶然」
 * 准备的。
 */
const RETRY_DELAY_MS = Math.max(0, Math.trunc(Number(process.env.GATEWAY_KANBAN_RETRY_DELAY_MS ?? 5 * 60_000)))
/**
 * 席位不在线 / 忙 / 正在排空时隔多久再试。
 *
 * 比上面那个短一个量级：这三种**不是失败**，是「这一轮没派出去」。但也不能是零——
 * 排空那几十秒里同一张卡会每半分钟被派一次、每次 503，日志里刷出一片而什么都没发生。
 */
const REQUEUE_DELAY_MS = Math.max(0, Math.trunc(Number(process.env.GATEWAY_KANBAN_REQUEUE_DELAY_MS ?? 60_000)))
/** 一轮最多派几张。多了下一轮再来，别让一次 tick 卡在网络上。 */
const BATCH = 10

/** 时间线上那一行。系统说的话和人的评论混在一起排，人读的就是这一条线。 */
function sysLine(db: Db, cardId: string, body: string): Promise<unknown> {
  return db.insertCardComment({ cardId, kind: 'system', body }).catch((e: Error) => {
    console.error(`satuwork-gateway: 看板时间线写不下去（${cardId}）：${e.message}`)
    return null
  })
}

/**
 * 这一次没派出去：退回 `ready`，**不算失败**。
 *
 * 席位整夜关着是常态；把它记成失败的话，第二天早上是一板子的红，而没有任何一件事真的
 * 出过错。`attempt` 一动不动，只压一个短退避。
 *
 * 退回时**要在时间线上写一行**：静静地退回，和「一直没被派」在界面上长得一模一样。
 */
async function requeueCard(db: Db, card: Card, why: string): Promise<void> {
  await db.updateCard(card.id, {
    state: 'ready',
    startedAt: null,
    sessionId: null,
    heartbeatAt: null,
    retryAfter: Date.now() + REQUEUE_DELAY_MS,
  })
  await sysLine(db, card.id, `这一轮没派出去：${why}`)
}

/**
 * 一次失败。
 *
 * ```
 * 失败 1 次 → 回 ready，attempt+1，至少等 5 分钟
 * 失败 2 次 → blocked（failed），reason 写最后一次的错
 * ```
 *
 * `runStatus` 分 `error`（席位报了错）和 `stale`（席位失联）：后者查不出那一轮做到哪儿
 * 了，写成 error 是在编（同 delegation 那条 `lost`）。
 */
async function failCard(db: Db, card: Card, reason: string, runStatus: 'error' | 'stale'): Promise<void> {
  const attempt = card.attempt + 1
  const run = await db.runningCardRun(card.id)
  if (run) await db.finishCardRun(run.id, { status: runStatus, error: reason })
  if (attempt >= CARD_FAILURE_LIMIT) {
    await db.updateCard(card.id, {
      state: 'blocked',
      blockedKind: 'failed',
      blockedReason: reason,
      attempt,
      endedAt: Date.now(),
    })
    await sysLine(db, card.id, `第 ${attempt} 次失败，转人处理：${reason}`)
    // 推给人。**只推三档**，人自己按停止的那些不推（见 kanban-notify.ts）。
    const stuck = await db.card(card.id)
    if (stuck) void notifyBlocked(db, stuck)
    return
  }
  await db.updateCard(card.id, {
    state: 'ready',
    attempt,
    startedAt: null,
    heartbeatAt: null,
    retryAfter: Date.now() + RETRY_DELAY_MS,
  })
  await sysLine(db, card.id, `第 ${attempt} 次失败，待会儿重试：${reason}`)
}

/** 席位在哪、拿什么敲。和 routines 那边同一个形状，理由也一样（调度器手上只有 id）。 */
async function seatLinkOf(db: Db, accountId: string, botId: string) {
  const row = await db.instance(accountId, botId)
  const host = (row?.host || '').trim().replace(/\/$/, '')
  if (!host) throw new Error('席位还没上线')
  const account = await db.account(accountId)
  if (!account) throw new Error('账号不在了')
  return { host, bearer: await seatBearer(db, accountId), machineToken: await machineTokenFor(db, account, botId) }
}

/**
 * 让席位掐掉某张卡那一轮。
 *
 * 人在板上按停止时走这条。**失败不抛给调用方**：席位可能刚好死了，而那时更该把卡收掉
 * ——它已经没人在跑了。
 */
export async function abortOnSeat(db: Db, card: Card): Promise<boolean> {
  const link = await seatLinkOf(db, card.accountId, card.assigneeBotId ?? '')
  const r = await fetch(`${link.host}/api/cards/${encodeURIComponent(card.id)}/abort`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      ...(link.bearer ? { authorization: `Bearer ${link.bearer}` } : {}),
      ...(link.machineToken ? { 'x-satuwork-machine': link.machineToken } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  })
  return r.ok
}

/** 席位对这次投递的回话。三种「不是失败」的答案要分得出来。 */
type Delivery = { ok: true } | { ok: false; retry: string } | { ok: false; failed: string }

/**
 * 把执行包送过去。
 *
 * **不等它跑完**：这一跳只回答「收下了没有」。跑完由席位主动回报。
 *
 * 三种回话各有各的意思，混成一种就会把「机器关着」记成「这件事做砸了」：
 *
 * | 席位说 | 意思 |
 * |---|---|
 * | 2xx | 收下了，开始跑 |
 * | 409 | 忙（要浏览器而那块屏被占着）——**不是失败** |
 * | 503 | 正在排空换版——**不是失败** |
 * | 别的 4xx | 这个执行包它接不住（缺字段、没有这颗 Bot）——**是失败**，重试也一样 |
 */
async function deliver(db: Db, card: Card, pack: unknown): Promise<Delivery> {
  let link
  try {
    link = await seatLinkOf(db, card.accountId, card.assigneeBotId ?? '')
  } catch (e) {
    return { ok: false, retry: (e as Error).message }
  }
  let r: Response
  try {
    r = await fetch(`${link.host}/api/cards`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...(link.bearer ? { authorization: `Bearer ${link.bearer}` } : {}),
        ...(link.machineToken ? { 'x-satuwork-machine': link.machineToken } : {}),
      },
      body: JSON.stringify(pack),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    // 连不上：机器关着、网络断了、席位正在重启。都不是这张卡的错。
    return { ok: false, retry: `连不上席位：${(e as Error).message}` }
  }
  if (r.ok) return { ok: true }
  const text = await r.text().catch(() => '')
  const hint = (() => {
    try {
      return String((JSON.parse(text) as { error?: unknown })?.error ?? '') || text.slice(0, 200)
    } catch {
      return text.slice(0, 200)
    }
  })()
  if (r.status === 409) return { ok: false, retry: hint || '席位忙着' }
  if (r.status === 503) return { ok: false, retry: hint || '席位正在换版排空' }
  if (r.status >= 500) return { ok: false, retry: hint || `席位 HTTP ${r.status}` }
  return { ok: false, failed: hint || `席位不收这张卡（HTTP ${r.status}）` }
}

/**
 * 执行包（docs/kanban.md §9.1）。
 *
 * `parents` 带的是**结论和交付证据，不带过程**——这正是看板的全部价值所在。文件不用带：
 * 板上所有 Bot 共用一棵 `~/work`，`metadata.changed_files` 里那几个路径直接读得开。
 *
 * `lastFailure` 只在重试时有，而且**必须带**：不带的话第二次会一字不差地重演第一次，
 * 包括那个错。
 */
async function packOf(db: Db, card: Card) {
  const board = await db.board(card.boardId)
  const parents = await db.cardParents(card.id)
  const timeline = await db.cardComments(card.id)
  const runs = card.attempt > 0 ? await db.cardRuns(card.id, 1) : []
  return {
    cardId: card.id,
    boardId: card.boardId,
    title: card.title,
    body: card.body,
    brief: board?.brief ?? '',
    parents: parents.map((p) => ({ id: p.id, title: p.title, summary: p.summary, metadata: p.metadata })),
    // 系统那几行不带：模型要的是人和别的 Bot 说过的话，不是「第 1 次失败」这种流水账。
    comments: timeline.filter((t) => t.kind === 'comment').map((t) => ({ author: t.authorBotId ?? '人', body: t.body })),
    attempt: card.attempt,
    lastFailure: runs[0]?.error ?? '',
    modelRole: card.modelRole,
    maxSteps: card.maxSteps,
    needsBrowser: card.needsBrowser,
    deadlineAt: Date.now() + TIMEOUT_MS,
  }
}

/**
 * 这次回报/心跳报的是不是**当前**那一次执行。
 *
 * 席位不带 `runId`（换版期间的旧席位）时**放行并留一行 warn**：为一个身份字段把一台还
 * 在正常干活的席位的回报全部顶回去，是拿正确性换严格——那些卡会一张不落地卡到失联。
 * 同 routines 那条「旧版席位当这个字段不存在」的口径。
 */
export async function runMatches(db: Db, cardId: string, reported: string): Promise<boolean> {
  const want = (reported || '').trim()
  if (!want) {
    console.warn(`satuwork-gateway: 看板回报没带 runId（${cardId}），认不出是哪一次执行——旧版席位？`)
    return true
  }
  const run = await db.runningCardRun(cardId)
  return !run || run.id === want
}

/**
 * 一轮。
 *
 * 返回这一轮真的派出去几张——调度器只拿它打日志，e2e 拿它当断言。
 */
export async function tickKanban(db: Db, now = Date.now()): Promise<number> {
  // 1. 收依赖。
  await db.promoteReadyCards()

  // 2. 收死的。先心跳后墙钟，两条判据管两种死法。
  for (const card of await db.deadRunningCards(now - STALE_MS, now - TIMEOUT_MS - 60_000)) {
    const stale = (card.heartbeatAt ?? card.startedAt ?? 0) <= now - STALE_MS
    await failCard(
      db,
      card,
      stale ? '席位失联：三分钟没有心跳' : '超过墙钟还没收口',
      stale ? 'stale' : 'error',
    )
  }

  // 3. 选卡：两道并发闸都从这一份现算。
  const load = await db.runningCardLoad()
  const byAccount = new Map<string, number>()
  const bySeat = new Map<string, number>()
  for (const row of load) {
    byAccount.set(row.accountId, (byAccount.get(row.accountId) ?? 0) + row.n)
    bySeat.set(`${row.accountId}/${row.botId}`, row.n)
  }

  let fired = 0
  /**
   * 候选取得比 BATCH 宽：这一轮派不出去的（闸满了、要浏览器而那块屏占着）要能被跳过，
   * 循环才走得到下一张。每个账号最多 `CARD_ACCOUNT_CONCURRENCY * 4` 张，谁都占不满窗口。
   */
  for (const card of await db.dueCards(now, BATCH * 4, CARD_ACCOUNT_CONCURRENCY * 4)) {
    if (fired >= BATCH) break
    const bot = card.assigneeBotId
    if (!bot) continue
    /**
     * **人的主会话不计入这两道闸**：人随时会说话，而这颗 Bot 因为在跑一张卡就不理他，
     * 是最糟的一种表现。这里数的只有卡。
     */
    if ((byAccount.get(card.accountId) ?? 0) >= CARD_ACCOUNT_CONCURRENCY) continue
    if ((bySeat.get(`${card.accountId}/${bot}`) ?? 0) >= CARD_SEAT_CONCURRENCY) continue

    // 4. 抢。抢不到说明另一代进程刚派过了，跳过。
    if (!(await db.claimCard(card.id))) continue
    byAccount.set(card.accountId, (byAccount.get(card.accountId) ?? 0) + 1)
    bySeat.set(`${card.accountId}/${bot}`, (bySeat.get(`${card.accountId}/${bot}`) ?? 0) + 1)

    /**
     * **执行包要在开这一条流水之前组好。**
     *
     * `packOf` 里那句「上一次是怎么失败的」读的是最近一条 `card_runs`——先把这一次的
     * 插进去，读到的就是刚开的这一条（error 是空的），于是重试的包里永远带不上上次的
     * 报错，而模型会一字不差地重演第一次，包括那个错。这个顺序是判据的一部分。
     */
    const pack = await packOf(db, card)
    const run = await db.insertCardRun({ cardId: card.id, attempt: card.attempt, botId: bot })
    /**
     * **`runId` 跟着执行包一起下去**，席位回报和心跳时原样带回来。
     *
     * 没有它的话，`/result` 只能判「这张卡现在是不是 running」——而那句判据认不出**是哪
     * 一次**。一个断网三分钟被判失联、五分钟后重派、然后旧那一轮恢复过来的席位，会拿着
     * 上一次的结论把全新的一次盖掉，而新那一轮变成没人认领的孤儿。
     */
    const got = await deliver(db, card, { ...pack, runId: run.id })
    if (got.ok) {
      fired += 1
      await sysLine(db, card.id, `派给了 ${bot}（第 ${card.attempt + 1} 次）`)
      continue
    }
    // 派不出去：把刚开的那条流水收掉，别留一条永远 running 的。
    await db.finishCardRun(run.id, { status: 'aborted', error: 'retry' in got ? got.retry : got.failed })
    byAccount.set(card.accountId, (byAccount.get(card.accountId) ?? 1) - 1)
    bySeat.set(`${card.accountId}/${bot}`, (bySeat.get(`${card.accountId}/${bot}`) ?? 1) - 1)
    if ('retry' in got) await requeueCard(db, card, got.retry)
    else await failCard(db, card, got.failed, 'error')
  }
  return fired
}

/**
 * 席位回报「这张卡跑完了」时走的那一段。
 *
 * 放在这里而不是路由里，是因为**失败的处理和调度器那一份必须是同一份**：重试几次、
 * 退避多久、什么时候转 blocked——两处各写一遍的话，「席位报的错」和「席位失联」会走出
 * 两套不一样的重试规则，而没有任何东西会提醒任何人。
 */
export async function settleCard(
  db: Db,
  card: Card,
  result: { status: 'ok' | 'blocked' | 'error'; summary?: string; metadata?: Record<string, unknown> | null; error?: string; steps?: number; toolCalls?: number; sessionId?: string },
): Promise<Card | undefined> {
  const run = await db.runningCardRun(card.id)
  if (result.status === 'ok') {
    if (run) {
      await db.finishCardRun(run.id, {
        status: 'ok',
        steps: result.steps ?? null,
        toolCalls: result.toolCalls ?? null,
        sessionId: result.sessionId ?? null,
      })
    }
    const next = await db.updateCard(card.id, {
      state: 'done',
      summary: result.summary ?? '',
      metadata: result.metadata ?? null,
      endedAt: Date.now(),
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    })
    await sysLine(db, card.id, '做完了')
    /**
     * 做完了要不要吭一声，看卡上那一格。**默认什么都不做**：结论在卡上，而人挂完就走
     * 的那些才需要有人喊他一声。
     *
     * 不 await：一条发不出去的招呼不该把这张卡的收口拖在那儿（席位可能正在重启）。
     */
    if (next) void reportToOwner(db, next)
    return next
  }
  if (result.status === 'blocked') {
    if (run) await db.finishCardRun(run.id, { status: 'ok', steps: result.steps ?? null, toolCalls: result.toolCalls ?? null })
    /**
     * 模型自己说卡住了。**不算失败、不占 attempt**——它没做错什么，是这件事需要人。
     * 重试它只会让同一句「我需要人」再说一遍，每次都花钱。
     */
    const next = await db.updateCard(card.id, {
      state: 'blocked',
      blockedKind: 'by-model',
      blockedReason: result.error ?? '（没写原因）',
      endedAt: Date.now(),
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    })
    await sysLine(db, card.id, `卡住了：${result.error ?? '（没写原因）'}`)
    if (next) void notifyBlocked(db, next)
    return next
  }
  await failCard(db, card, result.error || '席位没说原因', 'error')
  return db.card(card.id)
}
