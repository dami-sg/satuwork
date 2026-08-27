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
import { HttpError, json, type Router } from '../http.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { requireUser } from '../lib/guards.ts'
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
  CARD_MAX_STEPS,
  CARD_REOPEN_LIMIT,
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
   */
  router.post('/kanban/cards/:id/unblock', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const card = await ownCardOf(db, account, req.params.id)
    if (card.state !== 'blocked') throw new HttpError(409, '这张卡没有卡住')
    const next = await db.updateCard(card.id, {
      state: 'ready',
      blockedKind: null,
      blockedReason: '',
      attempt: 0,
      retryAfter: null,
    })
    await sysLine(db, card.id, '人解锁了，回到待派')
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
      throw new HttpError(409, `这张卡已经被打回 ${card.reopens} 次了，再打回也是同一个结果——它现在等人处理`, {
        card: publicCard(stuck!),
      })
    }
    const next = await db.updateCard(card.id, {
      state: 'ready',
      reopens: card.reopens + 1,
      attempt: 0,
      retryAfter: null,
      // body 后面追加打回意见：下一次跑的时候它就在交底书里，不用模型自己回头翻时间线。
      body: `${card.body}\n\n【第 ${card.reopens + 1} 次打回】${reason}`.slice(0, CARD_BODY_MAX),
    })
    await sysLine(db, card.id, `被打回：${reason}`)
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
    json(res, 200, { card: publicCard(next!) })
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
