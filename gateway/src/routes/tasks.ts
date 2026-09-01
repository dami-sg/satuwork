/**
 * 任务看板的路由（见 docs/task-board.md §9）。
 *
 * **一共五条。没有 `/run`、没有 `/assign`、没有 `/retry`。** 那三条不存在，是不变量 1
 * （「看板是只读的执行面」）的**实现**，不是它的注释：只要还剩一个能触发执行的端点，这张
 * 由小模型读着外部文本写出来的表，就又成了一条能被点着跑起来的指令。
 *
 * 四条给人（用户 JWT，别人的一律 404），一条给席位的运行面（`requireInternalCaller`，
 * 同会话索引、guard-events、ready、用量）。**判据是「谁在说话」**：抽取是这台机器在汇报，
 * 不是模型在说话——所以它走 `/internal`，而不是模型那一组 `/runtime`。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { requireInternalCaller, requireUser } from '../lib/guards.ts'
import { visibleBotOf } from '../lib/runtime.ts'
import { cleanExtracted, mergeExtracted, oneLine, ownTaskOf, withHumanField } from '../lib/tasks.ts'
import {
  TASK_EXTRACT_MAX,
  TASK_PAGE_DEFAULT,
  TASK_PAGE_MAX,
  TASK_PER_SESSION_MAX,
  TASK_SUMMARY_MAX,
  TASK_TITLE_MAX,
  type Task,
  type TaskEvent,
  type TaskExtractLog,
  type TaskExtractOutcome,
  type TaskField,
  type TaskState,
} from '../db.ts'

/** 抽取的响应里回喂给席位多少条。它最终会进模型的提示词，长了只会挤掉正文。 */
const OPEN_FED_BACK = 20

function publicTask(t: Task) {
  return {
    id: t.id,
    botId: t.botId,
    sessionId: t.sessionId,
    title: t.title,
    summary: t.summary,
    state: t.state,
    evidence: t.evidence,
    // 前端要拿它去席位翻那一段全文（`/runtime/sessions/:id/history?before=`）。
    firstSeq: t.firstSeq,
    lastSeq: t.lastSeq,
    humanFields: t.humanFields,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    stateAt: t.stateAt,
    doneAt: t.doneAt,
  }
}

function publicTaskEvent(e: TaskEvent) {
  return { id: e.id, kind: e.kind, fromState: e.fromState, toState: e.toState, note: e.note, createdAt: e.createdAt }
}

function publicTaskExtractLog(x: TaskExtractLog) {
  return {
    id: x.id,
    botId: x.botId,
    sessionId: x.sessionId,
    outcome: x.outcome,
    reason: x.reason,
    detail: x.detail,
    createdCount: x.createdCount,
    updatedCount: x.updatedCount,
    taskCount: x.taskCount,
    fromSeq: x.fromSeq,
    toSeq: x.toSeq,
    model: x.model,
    version: x.version,
    createdAt: x.createdAt,
  }
}

function extractOutcome(raw: unknown): TaskExtractOutcome {
  const s = String(raw ?? '')
  if (s === 'created' || s === 'updated' || s === 'unchanged' || s === 'no_task' || s === 'skipped' || s === 'failed') return s
  throw new HttpError(400, 'outcome 不合法')
}

function nonNegative(raw: unknown): number {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/** 翻页游标：`stateAt:id`。第二把钥匙不能省——同一毫秒推两条状态是常态。 */
function taskCursorOf(raw: string | null): { stateAt: number; id: string } | undefined {
  const text = (raw || '').trim()
  if (!text) return undefined
  const i = text.indexOf(':')
  const stateAt = Number(text.slice(0, i))
  const id = i < 0 ? '' : text.slice(i + 1)
  if (i < 0 || !Number.isFinite(stateAt) || !id) throw new HttpError(400, 'cursor 不合法')
  return { stateAt, id }
}

function stateQuery(raw: string | null): TaskState | undefined {
  const s = (raw || '').trim()
  if (!s) return undefined
  if (s !== 'proposed' && s !== 'doing' && s !== 'done' && s !== 'dropped') throw new HttpError(400, 'state 不合法')
  return s
}

export function attachTasks(router: Router, ctx: RouteCtx) {
  const { db, keys } = ctx

  /**
   * 板上那一屏。
   *
   * **没有「哪块板」这个参数**：板的概念随执行面一起删了（§10）。任务是派生的，没有任何
   * 人能选它落在哪块板上，那一层就是个恒等映射。这里只按 Bot 和状态过滤。
   */
  router.get('/tasks', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const botId = (req.query.get('bot') || '').trim()
    const state = stateQuery(req.query.get('state'))
    /**
     * **`Number(null)` 是 0，不是 NaN。** 直接 `Number(req.query.get('limit'))` 的话，
     * 没带 limit 的请求会算出 0，再被夹到下限 1——整块板每次只回一条，而它看起来完全
     * 像是「板上只有一条任务」。先看那个字符串在不在，再转数。
     */
    const askedRaw = (req.query.get('limit') || '').trim()
    const asked = Number(askedRaw)
    const limit = Math.min(Math.max(askedRaw && Number.isFinite(asked) ? Math.trunc(asked) : TASK_PAGE_DEFAULT, 1), TASK_PAGE_MAX)
    // 多要一条判 hasMore（同会话列表）。卡在 limit 上的话最后一页永远报「还有更多」。
    const rows = await db.tasksOf(account.id, {
      botId: botId || undefined,
      state,
      limit: limit + 1,
      before: taskCursorOf(req.query.get('cursor')),
    })
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    json(res, 200, {
      tasks: page.map(publicTask),
      counts: await db.taskCounts(account.id, botId || undefined),
      cursor: rows.length > limit && last ? `${last.stateAt}:${last.id}` : null,
    })
  })

  /**
   * 为什么建了 / 没建任务。必须放在 `/tasks/:id` 前面，否则 `logs` 会被当成任务 id。
   */
  router.get('/tasks/logs', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const botId = (req.query.get('bot') || '').trim()
    const asked = Number(req.query.get('limit'))
    const limit = Number.isFinite(asked) && asked > 0 ? Math.min(Math.trunc(asked), 200) : 100
    json(res, 200, { logs: (await db.taskExtractLogs(account.id, botId || undefined, limit)).map(publicTaskExtractLog) })
  })

  router.get('/tasks/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const task = await ownTaskOf(db, account, req.params.id)
    json(res, 200, { task: publicTask(task), events: (await db.taskEvents(task.id)).map(publicTaskEvent) })
  })

  /**
   * 人改一条。
   *
   * **每一个被改的字段都记进 `humanFields`**，之后抽取器绕开它（lib/tasks.ts 口径 2）。
   * 不记的话，人今天把一条改成「完成」，明天抽取器读到同一段对话又把它推回「进行中」——
   * 而他不会再改第二次，他会不再相信这块板。
   *
   * 人能推到 `dropped`，抽取器不能（§5）：一件真被放弃的事和一件被忘掉的事，在会话里
   * 长得一模一样。
   *
   * **只有真的改了才算「人碰过」。** 提交一个和现在一模一样的值不进 `humanFields`——
   * 详情弹窗把当前那一档画成 primary，人点一下它是想确认，界面上什么都不会变、时间线上
   * 也不留痕；照「提交了就算」写的话，那一次毫无反馈的点击会永久关掉抽取器对这条任务的
   * 更新，而这件事后来真办完了，板上它还停在「进行中」。
   */
  router.patch('/tasks/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const task = await ownTaskOf(db, account, req.params.id)
    const body = bodyOf(req)
    const patch: Parameters<typeof db.updateTask>[1] = {}
    let fields: TaskField[] = task.humanFields
    let nextState: TaskState | null = null

    if (body.title !== undefined) {
      const title = oneLine(strField(body, 'title'), TASK_TITLE_MAX)
      if (!title) throw new HttpError(400, '标题不能为空')
      if (title !== task.title) {
        patch.title = title
        fields = withHumanField(fields, 'title')
      }
    }
    if (body.summary !== undefined) {
      const summary = oneLine(strField(body, 'summary', false), TASK_SUMMARY_MAX)
      if (summary !== task.summary) {
        patch.summary = summary
        fields = withHumanField(fields, 'summary')
      }
    }
    if (body.state !== undefined) {
      const s = strField(body, 'state')
      if (s !== 'proposed' && s !== 'doing' && s !== 'done' && s !== 'dropped') {
        throw new HttpError(400, 'state 只能是 proposed / doing / done / dropped')
      }
      if (s !== task.state) {
        nextState = s
        patch.state = s
        patch.stateAt = Date.now()
        patch.doneAt = s === 'done' ? Date.now() : null
        fields = withHumanField(fields, 'state')
      }
    }
    if (fields !== task.humanFields) patch.humanFields = fields
    if (Object.keys(patch).length === 0) {
      json(res, 200, { task: publicTask(task) })
      return
    }
    const next = await db.updateTask(task.id, patch)
    if (!next) throw new HttpError(404, '没有这条任务')
    if (nextState) {
      await db.insertTaskEvent({ taskId: task.id, kind: 'human', fromState: task.state, toState: nextState })
    }
    json(res, 200, { task: publicTask(next) })
  })

  /** 认错的那一条，人删得掉。时间线跟着走（外键 cascade）。 */
  router.delete('/tasks/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const task = await ownTaskOf(db, account, req.params.id)
    await db.deleteTask(task.id)
    json(res, 200, { ok: true })
  })

  /**
   * 席位抽完一段之后报上来的那一批（§7、§9）。
   *
   * 归属**全部服务端现算**：账号从票上取，公司从票上取，会话必须已经在 `session_index`
   * 里而且是这个账号的。body 里报上来的一概不作数——不然一台席位报一个别人的 sessionId
   * 就能往别人名下塞任务（同会话索引那条判据）。
   */
  router.post('/internal/tasks/extract', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const body = bodyOf(req)
    const sessionId = strField(body, 'sessionId')
    const index = await db.sessionIndex(sessionId)
    if (!index || index.companyId !== caller.companyId) throw new HttpError(404, '没有这条会话')
    // 席位票只能替自己那个账号说话；机器票替本机任意席位报（管家那一层），所以只验公司。
    if (caller.kind === 'seat' && index.accountId !== caller.account.id) throw new HttpError(404, '没有这条会话')
    const account = caller.kind === 'seat' ? caller.account : await db.account(index.accountId)
    if (!account?.companyId) throw new HttpError(404, '没有这条会话')

    /**
     * `botId` 一样要验，验的是**这颗 Bot 属不属于这个账号**（同 memory / skill 那条）。
     *
     * 不验的话，一个编出来的 botId 就能让板上出现一条挂在别人 Bot 名下的任务。会话索引
     * 上那颗优先——它是会话根事件带上来的，比这次 body 里的更早、更该被信。
     */
    const wanted = index.botId || strField(body, 'botId', false)
    const bot = wanted ? await visibleBotOf(db, account, wanted) : null
    if (!bot) throw new HttpError(400, '这条会话还没认领到哪颗 Bot 上，抽不了任务')

    const raw = Array.isArray(body.tasks) ? body.tasks : []
    const known = await db.tasksOfSession(sessionId)
    /**
     * **每会话上限：超了拒收整批**（不是截断）。
     *
     * 这是抽取器失控时的闸。到了这儿要看的是它为什么在把每一轮都认成新任务，而不是让板
     * 继续长——截断的话，板上留下的是一半失控的结果，而没有任何东西会响。
     */
    if (known.length >= TASK_PER_SESSION_MAX) {
      console.warn(`tasks: 会话 ${sessionId} 已经挂了 ${known.length} 条任务，拒收这一批（抽取器可能失控了）`)
      throw new HttpError(409, `这条会话的任务数已经到上限（${TASK_PER_SESSION_MAX}）`)
    }
    if (raw.length > TASK_EXTRACT_MAX) {
      console.warn(`tasks: 会话 ${sessionId} 一次报了 ${raw.length} 条，截到 ${TASK_EXTRACT_MAX} 条`)
    }

    const upto = Number(body.upto)
    const fallback = {
      firstSeq: Number.isFinite(upto) && upto > 0 ? Math.trunc(upto) : 0,
      lastSeq: Number.isFinite(upto) && upto > 0 ? Math.trunc(upto) : 0,
    }
    const model = oneLine(body.model, 80)
    const version = Number.isFinite(Number(body.version)) ? Math.trunc(Number(body.version)) : 0
    const byKey = new Map(known.map((t) => [t.key, t]))
    const out: Task[] = []
    let created = 0
    let updated = 0
    let unchanged = 0
    let accepted = 0

    for (const item of raw.slice(0, TASK_EXTRACT_MAX)) {
      const next = cleanExtracted(item, fallback)
      if (!next) continue
      accepted += 1
      const existing = byKey.get(next.key)
      if (existing) {
        const merged = await mergeExtracted(db, existing, next, { model, version })
        if (merged.changed) updated += 1
        else unchanged += 1
        out.push(merged.task)
        continue
      }
      if (known.length + created >= TASK_PER_SESSION_MAX) break
      const row = await db.insertTask({
        accountId: account.id,
        companyId: account.companyId,
        botId: bot.id,
        sessionId,
        key: next.key,
        title: next.title,
        summary: next.summary,
        state: next.state,
        firstSeq: next.firstSeq,
        lastSeq: next.lastSeq,
        evidence: next.evidence,
        extractModel: model,
        extractVersion: version,
      })
      /**
       * **撞唯一键不是错**：两次抽取重叠时（席位重启后水位倒回去，或者去抖没拦住），
       * 两边给的是同一个 key。捞回来并进去，而不是把一次正常的竞态报成故障。
       */
      const settled = row ?? (await db.taskByKey(sessionId, next.key))
      if (!settled) continue
      if (row) {
        created += 1
        await db.insertTaskEvent({ taskId: row.id, kind: 'extract', toState: row.state, note: next.evidence })
        out.push(row)
      } else {
        const merged = await mergeExtracted(db, settled, next, { model, version })
        if (merged.changed) updated += 1
        else unchanged += 1
        out.push(merged.task)
      }
    }
    /**
     * 回的是**这条会话现在挂着的全部任务**，不只是这次动过的那几条。
     *
     * 席位把它收下来，下一次抽取时回喂给模型——那是「先并、再开」唯一的依据（§4.3）。
     * 只回这次动过的话，席位手上那份清单会一次比一次残，而模型看不见的那几条，它就会
     * 用一个新 key 再开一遍。
     *
     * 顺带它是**人改动的回流路**：人删掉的、改了标题的、拖到别的列的，下一次抽取时模型
     * 看到的就是人改过之后的样子。
     */
    const open = await db.tasksOfSession(sessionId)
    const outcome: TaskExtractOutcome = created > 0 ? 'created' : updated > 0 ? 'updated' : accepted > 0 ? 'unchanged' : 'no_task'
    const reason = created > 0
      ? 'tasks_created'
      : updated > 0
        ? 'tasks_updated'
        : accepted > 0
          ? 'existing_unchanged'
          : raw.length > 0
            ? 'invalid_model_tasks'
            : 'model_no_task'
    await db.insertTaskExtractLog({
      accountId: account.id,
      companyId: account.companyId,
      botId: bot.id,
      sessionId,
      outcome,
      reason,
      createdCount: created,
      updatedCount: updated,
      taskCount: accepted,
      fromSeq: nonNegative(body.from),
      toSeq: nonNegative(body.upto),
      model,
      version,
      detail: unchanged ? `${unchanged} 条已有任务没有变化` : '',
    })
    json(res, 200, {
      tasks: out.map(publicTask),
      // 按最近推进过的排在前面，截到 20 条：一份回喂给模型的清单，长了只会挤掉正文。
      open: open
        .filter((t) => t.state !== 'dropped')
        .sort((a, b) => b.lastSeq - a.lastSeq)
        .slice(0, OPEN_FED_BACK)
        .map((t) => ({ key: t.key, title: t.title, state: t.state })),
    })
  })

  /**
   * 席位本地就结束的判定（预过滤、没配置模型、模型失败）不会走 extract，单独报一行。
   * body 里没有对话正文；归属仍从席位票和 session_index 现算。
   */
  router.post('/internal/tasks/extract-log', async (req, res) => {
    const caller = await requireInternalCaller(req, db)
    const body = bodyOf(req)
    const sessionId = strField(body, 'sessionId')
    const index = await db.sessionIndex(sessionId)
    if (!index || index.companyId !== caller.companyId) throw new HttpError(404, '没有这条会话')
    if (caller.kind === 'seat' && index.accountId !== caller.account.id) throw new HttpError(404, '没有这条会话')
    const account = caller.kind === 'seat' ? caller.account : await db.account(index.accountId)
    if (!account?.companyId) throw new HttpError(404, '没有这条会话')
    const wanted = index.botId || strField(body, 'botId', false)
    const bot = wanted ? await visibleBotOf(db, account, wanted) : null
    if (!bot) throw new HttpError(400, '这条会话还没认领到哪颗 Bot 上，记不了日志')

    const log = await db.insertTaskExtractLog({
      accountId: account.id,
      companyId: account.companyId,
      botId: bot.id,
      sessionId,
      outcome: extractOutcome(body.outcome),
      reason: oneLine(body.reason, 80) || 'unknown',
      detail: oneLine(body.detail, 300),
      createdCount: nonNegative(body.createdCount),
      updatedCount: nonNegative(body.updatedCount),
      taskCount: nonNegative(body.taskCount),
      fromSeq: nonNegative(body.fromSeq),
      toSeq: nonNegative(body.toSeq),
      model: oneLine(body.model, 80),
      version: nonNegative(body.version),
    })
    json(res, 201, { log: publicTaskExtractLog(log) })
  })
}
