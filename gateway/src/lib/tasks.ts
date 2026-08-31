/**
 * 任务看板的归属判定与那一次合并（见 docs/task-board.md）。
 *
 * 这个文件存在的理由和它替掉的 lib/kanban.ts 一样：**把口径收在一处**。这里有两处口径：
 *
 * 1. 一条任务只有它的主人看得见，管理员和平台 owner 也不例外，别人碰它一律 **404，不是
 *    403**。写在每条路由里的话，第五条路由必然会漏，而漏的表现是别人能看见一条本该不
 *    存在的任务
 * 2. **抽取器写不过人**：人碰过的字段（`humanFields`）永远保留人那一份。这一条要是散在
 *    路由里，某一天新加的字段就会悄悄绕过它——人改完标题，第二天又被模型改回去，而他不会
 *    再改第二次，他会不再相信这块板
 */
import { HttpError } from '../http.ts'
import {
  TASK_EVIDENCE_MAX,
  TASK_KEY_MAX,
  TASK_SUMMARY_MAX,
  TASK_TITLE_MAX,
  type Account,
  type Db,
  type Task,
  type TaskField,
  type TaskState,
} from '../db.ts'

/** 我的任务。别人的、不存在的、已经删掉的，**一律 404**（口径 1）。 */
export async function ownTaskOf(db: Db, account: Account, id: string): Promise<Task> {
  const row = await db.task((id || '').trim())
  if (!row || row.accountId !== account.id) throw new HttpError(404, '没有这条任务')
  return row
}

/**
 * 一行文本进库前的清洗：折空白、去首尾、砍到上限。
 *
 * **控制字符要剥掉**，不只是换行：标题要进一行 HTML、进列表、进按钮的 title 属性，
 * 而这段文本是模型读着一封外人写的邮件生成的。
 */
export function oneLine(raw: unknown, max: number): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

/** key 是拿来当唯一键的，形状要定死：小写、数字、连字符。 */
export function normalizeKey(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, TASK_KEY_MAX)
}

/** 抽取器报上来的一条，清洗之后的样子。字段全是**服务端**算出来的，不是照抄 body。 */
export interface ExtractedTask {
  key: string
  title: string
  summary: string
  state: TaskState
  evidence: string
  firstSeq: number
  lastSeq: number
}

/**
 * 抽取器的一条 → 库里的一条：**新的就建，认识的就并**。
 *
 * 合并的规矩只有一条，但它有三个面：
 *
 * · **人碰过的字段原样保留**（口径 2）
 * · **`stateAt` 只在状态真的变了的时候动**。抽取器每一轮都会把 `lastSeq` 往后推，跟着动
 *   `stateAt` 的话，界面上「停滞 N 天」永远不会出现，而那一行正是这块板要人看见的东西
 * · **`firstSeq` 只往前收，`lastSeq` 只往后推**。同一件事被两次抽取从两头认出来是常态
 *   （一次看见「人要求了」，一次看见「发出去了」），取并集才是这件事真正的跨度
 *
 * 返回值带上 `changed`：没变化的那些**不写库**。一条长会话里大部分任务每轮都会被原样
 * 回报一次，照写的话 `updatedAt` 每 20 秒跳一次，而界面上「什么时候动过」就此没了意义。
 */
export async function mergeExtracted(
  db: Db,
  existing: Task,
  next: ExtractedTask,
  meta: { model: string; version: number },
): Promise<{ task: Task; changed: boolean; stateChanged: boolean }> {
  const human = existing.humanFields
  const patch: Parameters<Db['updateTask']>[1] = {}

  if (!human.includes('title') && next.title && next.title !== existing.title) patch.title = next.title
  if (!human.includes('summary') && next.summary && next.summary !== existing.summary) patch.summary = next.summary

  const stateChanged = !human.includes('state') && next.state !== existing.state
  if (stateChanged) {
    patch.state = next.state
    patch.stateAt = Date.now()
    // 从 done 退回去的时候要把 doneAt 清掉，否则那条任务在「完成于」那一栏上永远留着
    // 一个它已经不再成立的时刻。
    patch.doneAt = next.state === 'done' ? Date.now() : null
  }

  if (next.firstSeq > 0 && next.firstSeq < existing.firstSeq) patch.firstSeq = next.firstSeq
  if (next.lastSeq > existing.lastSeq) patch.lastSeq = next.lastSeq
  // 证据跟着状态走：状态没变就别改它——旧那句说的是「凭什么判成现在这个状态」，
  // 换成新一轮的说法只会让人对不上号。
  if (stateChanged && next.evidence) patch.evidence = next.evidence

  if (Object.keys(patch).length === 0) return { task: existing, changed: false, stateChanged: false }

  patch.extractModel = meta.model
  patch.extractVersion = meta.version
  const updated = (await db.updateTask(existing.id, patch)) ?? existing
  if (stateChanged) {
    await db.insertTaskEvent({
      taskId: existing.id,
      kind: 'extract',
      fromState: existing.state,
      toState: next.state,
      note: next.evidence,
    })
  }
  return { task: updated, changed: true, stateChanged }
}

/** 人改一条：记下他碰过哪几个字段，之后抽取器绕开它们（口径 2）。 */
export function withHumanField(fields: TaskField[], field: TaskField): TaskField[] {
  return fields.includes(field) ? fields : [...fields, field]
}

/** 清洗一条抽取结果。**长度上限在这儿，不在路由里**——两个入口（抽取、人改）共用。 */
export function cleanExtracted(raw: unknown, fallback: { firstSeq: number; lastSeq: number }): ExtractedTask | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const key = normalizeKey(r.key)
  const title = oneLine(r.title, TASK_TITLE_MAX)
  // key 或 title 缺一条就整条丢掉。没有 key 的那条并不进任何一件事，没有标题的那条在板上
  // 是一张空白卡——两种都不如不要。
  if (!key || !title) return null
  const state = r.state === 'proposed' || r.state === 'doing' || r.state === 'done' ? (r.state as TaskState) : null
  if (!state) return null
  const first = Number(r.firstSeq)
  const last = Number(r.lastSeq)
  return {
    key,
    title,
    summary: oneLine(r.summary, TASK_SUMMARY_MAX),
    state,
    evidence: oneLine(r.evidence, TASK_EVIDENCE_MAX),
    // 模型报的 seq 一律不可信（它数不清）：不是有限正整数就退到这次窗口的两端。
    firstSeq: Number.isFinite(first) && first > 0 ? Math.trunc(first) : fallback.firstSeq,
    lastSeq: Number.isFinite(last) && last > 0 ? Math.trunc(last) : fallback.lastSeq,
  }
}
