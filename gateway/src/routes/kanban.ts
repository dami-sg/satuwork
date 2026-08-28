/**
 * 看板的用户那一组路由（见 docs/kanban.md §15.2）。
 *
 * **每一条都按「是不是我的板」认一次**，别人一律 404——`admin` 和 `owner` 也一样，这里
 * 没有「管理员除外」这个分支（口径〇）。判据收在 lib/kanban.ts 的 `ownBoardOf` /
 * `ownCardOf` 里，不要在路由里各写一遍。
 *
 * 模型那一组（`kanban_*` 工具的落点）不在这个文件里：它走 `/runtime/kanban/*` + 席位那把
 * runtime 票，和私有档 Skill、长期记忆同一条路。判据是「谁在说话」——这里是人，那里是
 * 模型。
 */
import type { RouteCtx } from './ctx.ts'
import { runMatches, settleCard } from '../kanban-tick.ts'
import { notifyBlocked } from '../kanban-notify.ts'
import { abortOnSeat } from '../kanban-tick.ts'
import { HttpError, json, type Router } from '../http.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { requireInternalCaller, requireSeatOnly, requireUser, type InternalCaller } from '../lib/guards.ts'
import {
  BOARD_BRIEF_MAX,
  BOARD_NAME_MAX,
  CARD_BODY_MAX,
  CARD_COMMENT_MAX,
  CARD_TITLE_MAX,
  MEMBER_ROLE_MAX,
  assertBoardMember,
  dedupeKeyOf,
  initialCardState,
  ownBoardOf,
  ownBotOf,
  ownCardOf,
  resolveModelRole,
} from '../lib/kanban.ts'
import {
  CARD_CREATE_MAX,
  CARD_MAX_STEPS,
  CARD_REOPEN_LIMIT,
  type Account,
  type Board,
  type BoardMember,
  type Card,
  type CardComment,
  type CardRun,
  type Db,
} from '../db.ts'

/** 卡详情里带多少条流水。再多就不是「最近跑得怎么样」了。 */
const RUNS_SHOWN = 10

function publicBoard(board: Board, counts?: Record<string, number>) {
  return {
    id: board.id,
    name: board.name,
    brief: board.brief,
    archived: board.archived,
    counts: counts ?? null,
    createdAt: board.createdAt,
    updatedAt: board.updatedAt,
  }
}

function publicMember(m: BoardMember, name?: string) {
  return { botId: m.botId, name: name ?? '', role: m.role, addedAt: m.addedAt }
}

function publicCard(card: Card) {
  return {
    id: card.id,
    boardId: card.boardId,
    title: card.title,
    body: card.body,
    assigneeBotId: card.assigneeBotId,
    state: card.state,
    priority: card.priority,
    createdByBotId: card.createdByBotId,
    modelRole: card.modelRole,
    modelReason: card.modelReason,
    modelDowngraded: card.modelDowngraded,
    needsBrowser: card.needsBrowser,
    maxSteps: card.maxSteps,
    notify: card.notify,
    sessionId: card.sessionId,
    attempt: card.attempt,
    reopens: card.reopens,
    summary: card.summary,
    metadata: card.metadata,
    blockedKind: card.blockedKind,
    blockedReason: card.blockedReason,
    createdAt: card.createdAt,
    startedAt: card.startedAt,
    endedAt: card.endedAt,
    updatedAt: card.updatedAt,
  }
}

function publicComment(c: CardComment) {
  return {
    id: c.id,
    kind: c.kind,
    authorAccountId: c.authorAccountId,
    authorBotId: c.authorBotId,
    body: c.body,
    createdAt: c.createdAt,
  }
}

function publicRun(r: CardRun) {
  return {
    id: r.id,
    attempt: r.attempt,
    sessionId: r.sessionId,
    botId: r.botId,
    status: r.status,
    steps: r.steps,
    toolCalls: r.toolCalls,
    error: r.error,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
  }
}

/**
 * 这个内部调用方能不能替这张卡说话。
 *
 * 席位票**只能是自己那个账号**；机器票能替本机任意席位报（管家那一层），所以只验公司。
 * 判据一律服务端算，不收 body——同会话索引那条（`assignee` 和 `machineId` 服务端算）。
 */
function callerOwns(caller: InternalCaller, card: Card): boolean {
  if (caller.companyId !== card.companyId) return false
  return caller.kind !== 'seat' || caller.account.id === card.accountId
}

/** 板上按状态数一下。列表那一行只要这几个数，不用把卡全拉出来。 */
function countByState(cards: Card[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const c of cards) out[c.state] = (out[c.state] ?? 0) + 1
  return out
}

/**
 * 时间线上那一行「系统说的话」。
 *
 * 状态变更不进审计（审计回答的是另一个问题：这颗 Bot 会不会自己动），所以这一行漏了，
 * 「这张卡昨天为什么从 running 回到 ready」事后就查不出来了。
 */
async function sysLine(db: Db, cardId: string, body: string) {
  await db.insertCardComment({ cardId, kind: 'system', body })
}

export function attachKanban(router: Router, ctx: RouteCtx) {
  const { db, keys } = ctx

  // ── 板 ────────────────────────────────────────────────────────────────

  router.get('/kanban/boards', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const boards = await db.boardsOf(account.id)
    const out = await Promise.all(boards.map(async (b) => publicBoard(b, countByState(await db.cardsOf(b.id)))))
    json(res, 200, { boards: out, blocked: await db.blockedCardCount(account.id) })
  })

  router.post('/kanban/boards', async (req, res) => {
    const account = await requireUser(req, db, keys)
    if (!account.companyId) throw new HttpError(400, '这个账号不属于任何公司，建不了板')
    const body = bodyOf(req)
    const board = await db.insertBoard({
      accountId: account.id,
      companyId: account.companyId,
      name: strField(body, 'name', false).slice(0, BOARD_NAME_MAX),
      brief: strField(body, 'brief', false).slice(0, BOARD_BRIEF_MAX),
    })
    /**
     * 建板进审计，口径抄 routines：审计那一栏只记「这个 Bot 会不会自己动」——一块板
     * 就是让它会自己动的那个东西。卡的状态流转不记，那是每天几十条，会把这一行淹掉。
     */
    await db.audit({
      companyId: account.companyId,
      accountId: account.id,
      action: 'kanban.board.create',
      detail: { id: board.id, name: board.name },
    })
    json(res, 201, { board: publicBoard(board) })
  })

  router.get('/kanban/boards/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const board = await ownBoardOf(db, account, req.params.id)
    const members = await db.boardMembers(board.id)
    const bots = await db.botsFor(account.companyId, account.id)
    const nameOf = new Map(bots.map((b) => [b.id, b.name]))
    const cards = await db.cardsOf(board.id)
    json(res, 200, {
      board: publicBoard(board, countByState(cards)),
      members: members.map((m) => publicMember(m, nameOf.get(m.botId))),
      cards: cards.map(publicCard),
    })
  })

  router.patch('/kanban/boards/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const board = await ownBoardOf(db, account, req.params.id)
    const body = bodyOf(req)
    const patch: Parameters<Db['updateBoard']>[1] = {}
    if (body.name !== undefined) patch.name = strField(body, 'name', false).slice(0, BOARD_NAME_MAX)
    if (body.brief !== undefined) patch.brief = strField(body, 'brief', false).slice(0, BOARD_BRIEF_MAX)
    if (body.archived !== undefined) patch.archived = body.archived === true
    const next = await db.updateBoard(board.id, patch)
    if (!next) throw new HttpError(404, '没有这块板')
    json(res, 200, { board: publicBoard(next) })
  })

  router.delete('/kanban/boards/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const board = await ownBoardOf(db, account, req.params.id)
    await db.deleteBoard(board.id)
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'kanban.board.delete',
      detail: { id: board.id, name: board.name },
    })
    json(res, 200, { deleted: true, id: board.id })
  })

  // ── 成员：只有人能改，改动进审计 ──────────────────────────────────────

  router.post('/kanban/boards/:id/members', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const board = await ownBoardOf(db, account, req.params.id)
    const body = bodyOf(req)
    // **只能加自己名下的 Bot**：ownBotOf 走 visibleBotOf，别人的一律 404。
    const bot = await ownBotOf(db, account, strField(body, 'botId'))
    const member = await db.addBoardMember(board.id, bot.id, strField(body, 'role', false).slice(0, MEMBER_ROLE_MAX))
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'kanban.member.add',
      detail: { boardId: board.id, botId: bot.id, role: member.role },
    })
    json(res, 201, { member: publicMember(member, bot.name) })
  })

  router.delete('/kanban/boards/:id/members/:botId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const board = await ownBoardOf(db, account, req.params.id)
    const botId = (req.params.botId || '').trim()
    if (!(await db.removeBoardMember(board.id, botId))) throw new HttpError(404, '这颗 Bot 不在这块板上')
    await db.audit({
      companyId: account.companyId!,
      accountId: account.id,
      action: 'kanban.member.remove',
      detail: { boardId: board.id, botId },
    })
    json(res, 200, { removed: true, botId })
  })

  // ── 卡 ────────────────────────────────────────────────────────────────

  router.post('/kanban/boards/:id/cards', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const board = await ownBoardOf(db, account, req.params.id)
    const body = bodyOf(req)
    const title = strField(body, 'title').slice(0, CARD_TITLE_MAX)
    const assignee = strField(body, 'assigneeBotId', false)
    if (assignee) await assertBoardMember(db, board, assignee)
    const model = resolveModelRole(body.modelRole, strField(body, 'modelReason', false))
    const card = await db.insertCard({
      boardId: board.id,
      accountId: board.accountId,
      companyId: board.companyId,
      title,
      body: strField(body, 'body', false).slice(0, CARD_BODY_MAX),
      assigneeBotId: assignee || null,
      // 人建的卡不参与去重（dedupeKeyOf 的 bot 传 null）：他刚敲完标题、看着屏幕，
      // 重复不重复自己知道；把他挡在唯一键上，是拿一个防模型的机制去管人。
      dedupeKey: null,
      state: initialCardState(0),
      priority: Math.trunc(Number(body.priority) || 0),
      needsBrowser: body.needsBrowser === true,
      maxSteps: Math.max(1, Math.trunc(Number(body.maxSteps) || CARD_MAX_STEPS)),
      notify: String(body.notify ?? '') === 'report' ? 'report' : 'none',
      ...model,
    })
    if (!card) throw new HttpError(409, '这张卡刚刚已经建过了')
    json(res, 201, { card: publicCard(card) })
  })

  router.get('/kanban/cards/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const card = await ownCardOf(db, account, req.params.id)
    json(res, 200, {
      card: publicCard(card),
      parents: (await db.cardParents(card.id)).map(publicCard),
      children: (await db.cardChildren(card.id)).map(publicCard),
      timeline: (await db.cardComments(card.id)).map(publicComment),
      runs: (await db.cardRuns(card.id, RUNS_SHOWN)).map(publicRun),
    })
  })

  /**
   * 改一张卡。**正在跑的只让改优先级**——标题和正文已经随执行包发到席位上了，这时候改
   * 它，界面上写着一件事、席位在做另一件事，而两边都不知道。
   */
  router.patch('/kanban/cards/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const card = await ownCardOf(db, account, req.params.id)
    const board = await ownBoardOf(db, account, card.boardId)
    const body = bodyOf(req)
    const running = card.state === 'running'
    const patch: Parameters<Db['updateCard']>[1] = {}
    if (body.priority !== undefined) patch.priority = Math.trunc(Number(body.priority) || 0)
    if (!running) {
      if (body.title !== undefined) patch.title = strField(body, 'title').slice(0, CARD_TITLE_MAX)
      if (body.body !== undefined) patch.body = strField(body, 'body', false).slice(0, CARD_BODY_MAX)
      if (body.needsBrowser !== undefined) patch.needsBrowser = body.needsBrowser === true
      if (body.maxSteps !== undefined) patch.maxSteps = Math.max(1, Math.trunc(Number(body.maxSteps) || CARD_MAX_STEPS))
      if (body.notify !== undefined) patch.notify = String(body.notify) === 'report' ? 'report' : 'none'
      if (body.assigneeBotId !== undefined) {
        const next = strField(body, 'assigneeBotId', false)
        if (next) await assertBoardMember(db, board, next)
        patch.assigneeBotId = next || null
        if (next !== card.assigneeBotId) await sysLine(db, card.id, next ? `改派给了 ${next}` : '取消了指派')
      }
      if (body.modelRole !== undefined) {
        const model = resolveModelRole(body.modelRole, strField(body, 'modelReason', false) || card.modelReason)
        Object.assign(patch, model)
      }
    } else if (Object.keys(body).some((k) => k !== 'priority')) {
      throw new HttpError(409, '这张卡正在跑，只能改优先级——要改内容先按停止')
    }
    const next = await db.updateCard(card.id, patch)
    if (!next) throw new HttpError(404, '没有这张卡')
    json(res, 200, { card: publicCard(next) })
  })

  router.post('/kanban/cards/:id/comments', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const card = await ownCardOf(db, account, req.params.id)
    const text = strField(bodyOf(req), 'body').slice(0, CARD_COMMENT_MAX)
    const comment = await db.insertCardComment({
      cardId: card.id,
      kind: 'comment',
      authorAccountId: account.id,
      body: text,
    })
    json(res, 201, { comment: publicComment(comment) })
  })

  /**
   * 解锁。**只有人能做**——`blocked` 的定义就是「要人」，给模型这把工具等于让它把一件
   * 自己已经承认干不了的事再干一遍。
   *
   * 解锁顺手把 `attempt` 清零：人处理过了（改了正文、加了条评论、把要登录的那个页面
   * 登好了），这就是新的一次机会，而不是接着上次的第二次。
   *
   * **放回哪一档现算，不写死 `ready`**（`queueStateOf`）：它卡住的这段时间里，上游完全
   * 可能被人打回重做。写死 `ready` 就是让它插到自己的依赖前面去跑，拿的还是那份作废的
   * 输入——而 `promoteReadyCards` 只推 todo → ready，推不回来。
   */
  router.post('/kanban/cards/:id/unblock', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const card = await ownCardOf(db, account, req.params.id)
    if (card.state !== 'blocked') throw new HttpError(409, '这张卡没有卡住')
    const state = await queueStateOf(db, card.id)
    const next = await db.updateCard(card.id, {
      state,
      blockedKind: null,
      blockedReason: '',
      attempt: 0,
      retryAfter: null,
    })
    await sysLine(db, card.id, state === 'ready' ? '人解锁了，回到待派' : '人解锁了，先回去等上游那几张')
    json(res, 200, { card: publicCard(next!) })
  })

  /**
   * 打回一张 done 的卡。上限 2——没有这个数，「评审卡打回干活卡 → 干活卡重做 → 评审卡
   * 重跑 → 又打回」就是一个每轮都在花钱的死循环，而它在板上看起来一直很忙。
   */
  router.post('/kanban/cards/:id/reopen', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const card = await ownCardOf(db, account, req.params.id)
    if (card.state !== 'done') throw new HttpError(409, '只有做完的卡才谈得上打回')
    const reason = strField(bodyOf(req), 'reason').slice(0, CARD_COMMENT_MAX)
    if (card.reopens >= CARD_REOPEN_LIMIT) {
      const stuck = await db.updateCard(card.id, {
        state: 'blocked',
        blockedKind: 'reopen-cap',
        blockedReason: `被打回 ${card.reopens} 次，需要人看一眼`,
      })
      await sysLine(db, card.id, `第 ${card.reopens + 1} 次打回被拒：转人处理`)
      if (stuck) void notifyBlocked(db, stuck)
      throw new HttpError(409, `这张卡已经被打回 ${card.reopens} 次了，再打回也是同一个结果——它现在等人处理`, {
        card: publicCard(stuck!),
      })
    }
    // 被打回的这张自己也要现算：它的上游可能同样被打回过（`invalidateDownstream` 走的是
    // 整条下游链，一次打回能连推好几层）。
    const next = await db.updateCard(card.id, {
      state: await queueStateOf(db, card.id),
      reopens: card.reopens + 1,
      attempt: 0,
      retryAfter: null,
      // body 后面追加打回意见：下一次跑的时候它就在交底书里，不用模型自己回头翻时间线。
      body: `${card.body}\n\n【第 ${card.reopens + 1} 次打回】${reason}`.slice(0, CARD_BODY_MAX),
    })
    await sysLine(db, card.id, `被打回：${reason}`)
    /**
     * **下游那些还没跑或者已经跑完的都要打回去等。**
     *
     * 文档 §3 推荐的评审流水线就是「干活卡 A → 评审卡 B」，而 B 说不行时打回的正是 A。
     * 不动 B 的话：A 重做、再次 done，而 B 早就是 done 了、永远不会再跑——这条流水线
     * 停在 B 上一次那份「不合格」的结论上，板上四列全绿，没有任何迹象表明重做之后
     * 根本没人复核。
     *
     * **`ready` 的那些一样要推回去**：B 正等着被派（一颗 Bot 一张的并发闸，等上几轮是
     * 常态）时打回 A，只推 `done` 的话 B 会在下一个 tick 带着 A 刚被否掉的结论跑出去，
     * 跑完就是 `done`——等 A 真的重做完，它已经不在打回名单里了。判据见
     * `invalidateDownstream`。
     *
     * 一律推 `todo` 而不是 `ready`：它要等 A 重新做完，`promoteReadyCards` 会在那之后
     * 放它出来。`attempt` 清零——这是新的一次机会，不是接着上次的第二次。
     */
    const stale = await invalidateDownstream(db, card.id)
    json(res, 200, { card: publicCard(next!), rerun: stale })
  })

  /**
   * 人在板上按了停止。
   *
   * **先把卡收成 `blocked/stopped`，再去掐席位。顺序是判据的一部分。**
   *
   * 反过来的话有一条静默的抢跑：席位被掐掉之后，`runCard` 的收尾会自己报一次
   * `status: 'error'`（模型一句收口的话都没说）。那条回报要是抢在这里的 `updateCard`
   * 前面到达 Gateway，卡此刻还是 `running`，于是走的是 `failCard`——**人按一下停止就
   * 占掉一次 attempt**，时间线上多一行「第 1 次失败」；而如果这张卡此前已经失败过一次，
   * 它会直接转 `blocked/failed` 并**推一条 webhook 出去**：他刚按完停止就收到「你有一张
   * 卡卡住了」，正是 `stopped` 这一档存在的全部理由要避免的事。
   *
   * 先落状态就没有这条缝：`/result` 那边第一句判的就是「这张卡是不是 running」，卡已经
   * 是 `blocked` 了，那条迟到的回报拿 409 收场，什么都改不动。
   *
   * `blockedKind: 'stopped'` 这一档**不推通知、不进待办计数**；**不算失败、不占
   * attempt**——人停它是因为他要改点什么，不是因为它做错了。
   */
  router.post('/kanban/cards/:id/abort', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const card = await ownCardOf(db, account, req.params.id)
    if (card.state !== 'running') throw new HttpError(409, '这张卡没在跑')
    /**
     * **状态排在收流水之前。** 反过来的话，`finishCardRun` 和 `updateCard` 之间那一次
     * DB 往返里，卡还是 `running` 而流水已经收掉了——一条迟到的回报正好从这个缝钻进去。
     */
    const next = await db.updateCard(card.id, {
      state: 'blocked',
      blockedKind: 'stopped',
      blockedReason: '人停的',
      endedAt: Date.now(),
    })
    const run = await db.runningCardRun(card.id)
    if (run) await db.finishCardRun(run.id, { status: 'aborted', error: '人停的' })
    await sysLine(db, card.id, '人按了停止')
    // 掐不掉也照样算数：席位可能刚好死了，而那时更该把卡收掉——它已经没人在跑了。
    await abortOnSeat(db, card).catch(() => false)
    json(res, 200, { card: publicCard(next!) })
  })

  /**
   * 撤销。**正在跑的先按停止**——撤一张正在跑的卡而不掐掉那一轮，留下的是一个没人认领
   * 的进程（同 delegation 那件事）。
   */
  router.post('/kanban/cards/:id/cancel', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const card = await ownCardOf(db, account, req.params.id)
    if (card.state === 'running') throw new HttpError(409, '这张卡正在跑，先按停止')
    if (card.state === 'cancelled' || card.state === 'archived') throw new HttpError(409, '这张卡已经不在板上了')
    const next = await db.updateCard(card.id, { state: 'cancelled', endedAt: Date.now() })
    await sysLine(db, card.id, '人撤销了这张卡')
    /**
     * **下游还没开跑的那些一起撤掉。**
     *
     * 它们等的那份产出永远不会来了。留着的话，人看到的是一张收在「等依赖」折叠区里的
     * 卡，界面上只写着「还在等」——而它等的东西已经不存在了。
     *
     * 只撤 `todo` / `ready`：已经在跑的那张有人在做（要停有停止按钮），已经 done 的
     * 产出是真的。
     */
    const dropped = await cancelDownstream(db, card.id)
    json(res, 200, { card: publicCard(next!), cancelled: dropped })
  })

  /** 归档一张做完的卡。**不自动**：N 天那个数字定成多少都会在某个人身上出错。 */
  router.post('/kanban/cards/:id/archive', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const card = await ownCardOf(db, account, req.params.id)
    if (card.state !== 'done') throw new HttpError(409, '只有做完的卡才谈得上归档')
    const next = await db.updateCard(card.id, { state: 'archived' })
    json(res, 200, { card: publicCard(next!) })
  })

  // ── 依赖：不跨板 ──────────────────────────────────────────────────────

  router.post('/kanban/links', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const body = bodyOf(req)
    const parent = await ownCardOf(db, account, strField(body, 'parentId'))
    const child = await ownCardOf(db, account, strField(body, 'childId'))
    if (parent.id === child.id) throw new HttpError(400, '一张卡不能依赖自己')
    // **不跨板**：一条依赖链要能被一屏看完。
    if (parent.boardId !== child.boardId) throw new HttpError(400, '依赖不能跨板')
    if (await hasPath(db, child.id, parent.id)) throw new HttpError(400, '这条依赖会绕成一个圈')
    await db.linkCards(parent.id, child.id)
    // 加了父卡，子卡就不再是「随时可派」了——除非那位父卡已经做完。
    if (child.state === 'ready' && parent.state !== 'done') {
      await db.updateCard(child.id, { state: 'todo' })
    }
    await sysLine(db, child.id, `加了依赖：要等《${parent.title}》`)
    json(res, 201, { linked: true })
  })

  router.delete('/kanban/links/:parentId/:childId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const parent = await ownCardOf(db, account, req.params.parentId)
    const child = await ownCardOf(db, account, req.params.childId)
    if (!(await db.unlinkCards(parent.id, child.id))) throw new HttpError(404, '没有这条依赖')
    // 拆完之后可能已经没有父卡了：那它就该回到待派，不然它会永远停在 todo。
    if (child.state === 'todo' && (await db.cardParents(child.id)).every((p) => p.state === 'done')) {
      await db.updateCard(child.id, { state: 'ready' })
    }
    await sysLine(db, child.id, `拆了依赖：不再等《${parent.title}》`)
    json(res, 200, { unlinked: true })
  })
}

/**
 * `from` 顺着依赖往下走，到得了 `to` 吗。
 *
 * 建链之前要问一次：A→B 已经存在时再建 B→A，两张卡会永远互相等着，而板上看起来只是
 * 「还有父卡没做完」——一个查不出原因的僵局。深度有限（一块板上的卡就那么多），走完
 * 就完了，不用怕。
 */
/**
 * 从一张卡出发，把整条下游走一遍（广度优先，`seen` 兜住任何意外的环）。
 *
 * 两个用处都在「上游变了，下游得跟着动」这件事上：撤销时把没开跑的一起撤，打回时把
 * 已经做完的打回去等。**都要走整条链**，不只是直接子卡——A→B→C 里 A 变了，C 手上那份
 * 输入同样是旧的。
 */
async function walkDownstream(db: Db, from: string): Promise<Card[]> {
  const seen = new Set<string>([from])
  const out: Card[] = []
  const queue = [from]
  while (queue.length) {
    for (const child of await db.cardChildren(queue.shift()!)) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      out.push(child)
      queue.push(child.id)
    }
  }
  return out
}

/** 撤销：下游还没开跑的一起撤。在跑的和做完的不动。 */
async function cancelDownstream(db: Db, from: string): Promise<string[]> {
  const out: string[] = []
  for (const child of await walkDownstream(db, from)) {
    if (child.state !== 'todo' && child.state !== 'ready') continue
    await db.updateCard(child.id, { state: 'cancelled', endedAt: Date.now() })
    await sysLine(db, child.id, '上游那张被撤销了，这张跟着一起收掉')
    out.push(child.id)
  }
  return out
}

/**
 * 打回：下游**还没跑或者已经跑完**的一律推回去等——它们手上那份输入作废了。
 *
 * **`ready` 和 `todo` 一样要推**，不能只推 `done`。一张 `ready` 的下游卡是「父卡都做完了、
 * 就等调度器来派」——而调度器随时会来（半分钟一轮，还要过一颗 Bot 一张的并发闸，等上几轮
 * 是常态）。只推 `done` 的话，那张 `ready` 的卡会在下一个 tick 带着**刚被人否掉的**上游
 * 结论跑出去（`packOf` 里 `parents[].summary` 取的就是它），而且跑完就是 `done`——等上游
 * 真的重做完，它已经不在打回名单里了，再也不会跑第二次。
 *
 * `todo` 的那些照理已经在等，但它们的 `attempt` / `retryAfter` 也该跟着清：这是新的一次
 * 机会，不是接着上次那第二次。
 *
 * `running` 不动：那张有人在做，要停有停止按钮（同 cancelDownstream 的口径）。
 */
async function invalidateDownstream(db: Db, from: string): Promise<string[]> {
  const out: string[] = []
  for (const child of await walkDownstream(db, from)) {
    if (child.state !== 'done' && child.state !== 'ready' && child.state !== 'todo') continue
    await db.updateCard(child.id, { state: 'todo', attempt: 0, retryAfter: null, endedAt: null })
    // 已经在等的那些不用再说一遍，人读时间线要的是「发生了什么变化」。
    if (child.state !== 'todo') await sysLine(db, child.id, '上游那张被打回重做了，这张要等它做完再跑一次')
    out.push(child.id)
  }
  return out
}

/**
 * 这张卡现在该是 `ready` 还是 `todo`——**按父卡现在的状态现算**。
 *
 * 「解锁」「打回」这类把卡放回队列的动作不能一律写 `ready`：`ready` 的意思是「父卡都收口
 * 了，随时可派」，而一张卡被挡住的这段时间里上游完全可能被打回重做。写死 `ready` 就是让
 * 它插到自己的依赖前面去跑，拿的还是那份作废的输入。
 *
 * 挡路的判据和 `promoteReadyCards` 那条 SQL 一字不差（`done` / `archived` / `cancelled`
 * 都算收口了）——两处对不上的话，这里放出去的卡会在下一轮被那条 SQL 判成还该等着，而它
 * 只推 todo → ready，推不回来。
 */
async function queueStateOf(db: Db, cardId: string): Promise<'ready' | 'todo'> {
  const parents = await db.cardParents(cardId)
  const settled = (s: string) => s === 'done' || s === 'archived' || s === 'cancelled'
  return parents.every((p) => settled(p.state)) ? 'ready' : 'todo'
}

async function hasPath(db: Db, from: string, to: string): Promise<boolean> {
  const seen = new Set<string>([from])
  const queue = [from]
  while (queue.length) {
    const cur = queue.shift()!
    for (const child of await db.cardChildren(cur)) {
      if (child.id === to) return true
      if (seen.has(child.id)) continue
      seen.add(child.id)
      queue.push(child.id)
    }
  }
  return false
}

/**
 * 模型那一组：`kanban_*` 工具的落点。
 *
 * **走 `/runtime/*` + 席位那把 runtime 票 + `?botId=`，不走 `/internal`。** 这一条照抄
 * 私有档 Skill 和长期记忆刚趟出来的那条路，判据是「谁在说话」：这里说话的是模型（一次
 * 工具调用），而 `/internal` 那一组是**席位的运行面**在汇报（收口、心跳），和「这条会话
 * 结束了」「这次用了多少 token」同一类。混成一组的话，模型有一天就能自己报一句「这张卡
 * 跑完了」。
 *
 * **botId 从 query 取，而且服务端验它真是这个账号的**（`seatBotOf`）。理由和 memory.md
 * §5 那句一字不差：请求体是模型拼的——不验的话，一个编出来的 botId 就能拿别人的 Bot
 * 身份往板上建卡。`board` 同理：验它属于这个账号，并且这颗 Bot 在它的成员名单里。
 */
export function attachKanbanRuntime(router: Router, ctx: RouteCtx) {
  const { db } = ctx

  /** 这次调用钉的是哪颗 Bot，并且确认它真是这个账号的。 */
  async function seatBotOf(req: Parameters<Parameters<Router['get']>[1]>[0], account: Account): Promise<string> {
    const botId = (req.query.get('botId') || '').trim()
    if (!botId) throw new HttpError(400, '要带 botId')
    const bots = await db.botsFor(account.role === 'owner' ? null : account.companyId, account.id)
    if (!bots.some((b) => b.id === botId)) throw new HttpError(404, '没有这个 Bot')
    return botId
  }

  /**
   * 这次要往哪块板上做事。
   *
   * 一个人可以有好几块板，一颗 Bot 可以同时在其中几块上，而**主会话里没有「当前这块板」
   * 这个东西**——人上一句在聊别的，下一句说「派给设计 Bot」，谁也说不出他指的是哪块。
   * 所以模型必须点名；只在一块板上时替它省掉这一步（那时没有歧义）。
   */
  async function boardFor(account: Account, botId: string, want: string) {
    const mine = await db.boardsForBot(account.id, botId)
    if (!mine.length) throw new HttpError(400, '这颗 Bot 还没有被加进任何一块板，建不了卡')
    const id = (want || '').trim()
    if (!id) {
      if (mine.length === 1) return mine[0].board
      const list = mine.map((m) => `${m.board.id}（${m.board.name}）`).join('、')
      throw new HttpError(400, `你在好几块板上，要点名往哪一块建：${list}`)
    }
    const hit = mine.find((m) => m.board.id === id)
    if (!hit) {
      const list = mine.map((m) => `${m.board.id}（${m.board.name}）`).join('、')
      throw new HttpError(400, `你不在这块板上。你能用的是：${list}`)
    }
    return hit.board
  }

  /** 这颗 Bot 够得着的一张卡：必须在它所在的某块板上。 */
  async function cardFor(account: Account, botId: string, cardId: string): Promise<Card> {
    const card = await db.card((cardId || '').trim())
    if (!card || card.accountId !== account.id) throw new HttpError(404, '没有这张卡')
    await boardFor(account, botId, card.boardId)
    return card
  }

  /**
   * `kanban_list`：这颗 Bot 所在的板、板上有谁、板上有什么卡。
   *
   * **一把工具答完三个问题**，因为模型只有这一条路可以问路：不给成员名单，它挑 assignee
   * 只能按名字猜；不给板 id，它下一步建卡不知道往哪块建。
   */
  router.get('/runtime/kanban/boards', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const botId = await seatBotOf(req, account)
    const mine = await db.boardsForBot(account.id, botId)
    const bots = await db.botsFor(account.companyId, account.id)
    const nameOf = new Map(bots.map((b) => [b.id, b.name]))
    const out = await Promise.all(
      mine.map(async ({ board, role }) => ({
        id: board.id,
        name: board.name,
        brief: board.brief,
        myRole: role,
        members: (await db.boardMembers(board.id)).map((m) => publicMember(m, nameOf.get(m.botId))),
        // 已经收口的不列：模型要的是「现在还有什么活」，一屏历史只会挤掉那几条。
        cards: (await db.cardsOf(board.id)).filter((c) => c.state !== 'archived' && c.state !== 'cancelled').map(publicCard),
      })),
    )
    json(res, 200, { boards: out })
  })

  /** `kanban_show`：一张卡的全部——正文、父卡的结论、评论。 */
  router.get('/runtime/kanban/cards/:id', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const botId = await seatBotOf(req, account)
    const card = await cardFor(account, botId, req.params.id)
    json(res, 200, {
      card: publicCard(card),
      parents: (await db.cardParents(card.id)).map(publicCard),
      children: (await db.cardChildren(card.id)).map(publicCard),
      timeline: (await db.cardComments(card.id)).map(publicComment),
    })
  })

  /**
   * `kanban_create`：一次最多 CARD_CREATE_MAX 张，**整次调用一块板**。
   *
   * 允许一次调用里的几张卡散到不同板上，只会让模型有机会把一条流水线拆到两块板上，而
   * 依赖不跨板——那条链子当场断掉。
   */
  router.post('/runtime/kanban/cards', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const botId = await seatBotOf(req, account)
    const body = bodyOf(req)
    const board = await boardFor(account, botId, strField(body, 'board', false))
    const raw = Array.isArray(body.cards) ? body.cards : null
    if (!raw) throw new HttpError(400, 'cards 必须是数组——只有这一种形状，单张也写成一个元素')
    if (!raw.length) throw new HttpError(400, 'cards 是空的')
    if (raw.length > CARD_CREATE_MAX) throw new HttpError(400, `一次最多 ${CARD_CREATE_MAX} 张，拆成两次`)

    const out: ReturnType<typeof publicCard>[] = []
    const merged: string[] = []
    for (const item of raw as Record<string, unknown>[]) {
      const title = strField(item, 'title').slice(0, CARD_TITLE_MAX)
      const assignee = strField(item, 'assignee', false)
      if (!assignee) throw new HttpError(400, `《${title}》没写 assignee：这张卡要交给谁？`)
      await assertBoardMember(db, board, assignee)
      const parents = Array.isArray(item.parents) ? item.parents.map((p) => String(p)) : []
      for (const pid of parents) {
        const parent = await db.card(pid)
        if (!parent || parent.boardId !== board.id) throw new HttpError(400, `父卡 ${pid} 不在这块板上`)
      }
      const model = resolveModelRole(item.model_role, strField(item, 'model_reason', false))
      const key = dedupeKeyOf(botId, title)
      const card = await db.insertCard({
        boardId: board.id,
        accountId: board.accountId,
        companyId: board.companyId,
        title,
        body: strField(item, 'body', false).slice(0, CARD_BODY_MAX),
        assigneeBotId: assignee,
        state: initialCardState(parents.length),
        createdByBotId: botId,
        needsBrowser: item.needs_browser === true,
        maxSteps: Math.max(1, Math.trunc(Number(item.max_steps) || CARD_MAX_STEPS)),
        dedupeKey: key,
        ...model,
      })
      if (!card) {
        /**
         * 指纹撞上了：**合并进已有那张，把它的卡号回给模型**，不是报错。
         *
         * 模型换个措辞又撞一次是常态（同 handoff 的去重），而板上出现三张一模一样的卡，
         * 人会把三张都派出去。
         */
        const had = key ? await db.cardByDedupe(board.id, key) : undefined
        if (had) {
          merged.push(had.id)
          out.push(publicCard(had))
          continue
        }
        throw new HttpError(409, `《${title}》建不出来`)
      }
      for (const pid of parents) await db.linkCards(pid, card.id)
      await sysLine(db, card.id, `${botId} 建了这张卡`)
      out.push(publicCard(card))
    }
    json(res, 201, { cards: out, merged })
  })

  /** `kanban_link`：加一条依赖。不跨板、不成圈——判据和人那一组是同一套。 */
  router.post('/runtime/kanban/cards/:id/links', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const botId = await seatBotOf(req, account)
    const child = await cardFor(account, botId, req.params.id)
    const parent = await cardFor(account, botId, strField(bodyOf(req), 'parentId'))
    if (parent.id === child.id) throw new HttpError(400, '一张卡不能依赖自己')
    if (parent.boardId !== child.boardId) throw new HttpError(400, '依赖不能跨板')
    if (await hasPath(db, child.id, parent.id)) throw new HttpError(400, '这条依赖会绕成一个圈')
    await db.linkCards(parent.id, child.id)
    if (child.state === 'ready' && parent.state !== 'done') await db.updateCard(child.id, { state: 'todo' })
    await sysLine(db, child.id, `${botId} 加了依赖：要等《${parent.title}》`)
    json(res, 201, { linked: true })
  })

  /**
   * 席位的**运行面**在汇报，不是模型在说话——所以这两条走 `/internal`，认的是
   * `requireInternalCaller`（同会话索引、guard-events、ready、用量）。
   *
   * 混进 `/runtime` 那一组的话，模型有一天就能自己报一句「这张卡跑完了」。
   */
  router.post('/internal/kanban/cards/:id/result', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const card = await db.card((req.params.id || '').trim())
    if (!card || !callerOwns(caller, card)) throw new HttpError(404, '没有这张卡')
    /**
     * **已经收口的再报一次回 409，不静静覆盖。** 两段不一样的结论，后写的那段未必是
     * 对的那段；而模型看到 409 才知道自己重复调了 kanban_complete。
     */
    if (card.state !== 'running') throw new HttpError(409, `这张卡已经是「${card.state}」了，收不了第二次`)
    const body = bodyOf(req)
    /**
     * **还要认是哪一次执行。** 「这张卡是 running」这句话认不出是哪一轮：一个断网被判
     * 失联、之后重派的卡，旧那一轮恢复过来时看到的正是一张 running 的卡，报进去就把全新
     * 的一次盖掉了，而新那一轮成了没人认领的孤儿。
     */
    if (!(await runMatches(db, card.id, strField(body, 'runId', false)))) {
      throw new HttpError(409, '这一次执行已经不算数了（这张卡后来重派过），你这一轮可以停了')
    }
    const status = String(body.status ?? '')
    if (status !== 'ok' && status !== 'blocked' && status !== 'error') throw new HttpError(400, 'status 只能是 ok / blocked / error')
    const next = await settleCard(db, card, {
      status,
      summary: strField(body, 'summary', false).slice(0, CARD_BODY_MAX),
      metadata: body.metadata && typeof body.metadata === 'object' ? (body.metadata as Record<string, unknown>) : null,
      error: strField(body, 'error', false).slice(0, CARD_COMMENT_MAX),
      steps: Number.isFinite(Number(body.steps)) ? Math.trunc(Number(body.steps)) : undefined,
      toolCalls: Number.isFinite(Number(body.toolCalls)) ? Math.trunc(Number(body.toolCalls)) : undefined,
      sessionId: strField(body, 'sessionId', false) || undefined,
    })
    json(res, 200, { card: next ? publicCard(next) : null })
  })

  /**
   * 心跳。**只动一列，不写流水**——一张跑一小时的卡会报 60 次，落成 60 行 card_runs
   * 的话，人点开那张卡看到的是一屏「还活着」，而他要找的那行结论被顶到了最后。
   *
   * 卡不在了（人撤了、板删了）回 404：席位据此掐掉那一轮，而不是继续跑一个没人认领的活。
   */
  router.post('/internal/kanban/cards/:id/heartbeat', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const card = await db.card((req.params.id || '').trim())
    if (!card || !callerOwns(caller, card)) throw new HttpError(404, '没有这张卡')
    // 心跳同理：一个旧那一轮的心跳不该把**新**那一次的失联判据一直续着。
    if (!(await runMatches(db, card.id, strField(bodyOf(req), 'runId', false)))) {
      throw new HttpError(409, '这一次执行已经不算数了（这张卡后来重派过），你这一轮可以停了')
    }
    if (!(await db.noteCardHeartbeat(card.id))) throw new HttpError(409, `这张卡已经是「${card.state}」了，别再跑了`)
    json(res, 200, { ok: true })
  })

  /** `kanban_comment`：往时间线上留一句。Bot 之间说话，人也看得见。 */
  router.post('/runtime/kanban/cards/:id/comments', async (req, res) => {
    const account = await requireSeatOnly(req, db)
    const botId = await seatBotOf(req, account)
    const card = await cardFor(account, botId, req.params.id)
    const comment = await db.insertCardComment({
      cardId: card.id,
      kind: 'comment',
      authorBotId: botId,
      body: strField(bodyOf(req), 'body').slice(0, CARD_COMMENT_MAX),
    })
    json(res, 201, { comment: publicComment(comment) })
  })
}
