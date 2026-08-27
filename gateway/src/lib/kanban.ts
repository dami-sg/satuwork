/**
 * 看板的归属判定与几个小算子（见 docs/kanban.md）。
 *
 * 这个文件存在的全部理由是**把口径〇收在一处**：一块板只有它的主人看得见，管理员和
 * 平台 owner 也不例外，而别人碰它一律回 **404，不是 403**。写在每条路由里的话，第
 * 十七条路由必然会漏——而漏的表现是别人能看见一块本该不存在的板。
 */
import { createHash } from 'node:crypto'
import { HttpError } from '../http.ts'
import { visibleBotOf } from './runtime.ts'
import { CARD_DEDUPE_WINDOW_MS, type Account, type Board, type Card, type CardState, type Db } from '../db.ts'

/** 板名、卡的标题和正文的上限。真要长文，写进 Skill 或者板的 brief 里。 */
export const BOARD_NAME_MAX = 60
export const BOARD_BRIEF_MAX = 2000
export const CARD_TITLE_MAX = 120
export const CARD_BODY_MAX = 8000
export const CARD_COMMENT_MAX = 4000
/** 成员那一行「它在这块板上干什么」。一句话，模型靠它挑人，不是简介。 */
export const MEMBER_ROLE_MAX = 40

/**
 * 我的板。别人的、不存在的、已经删掉的，**一律 404**。
 *
 * 403 等于告诉他这块板存在、只是他进不去——而板名本身就是内容（「面试候选人筛选」
 * 「离职交接」）。同 routines 那条。
 */
export async function ownBoardOf(db: Db, account: Account, id: string): Promise<Board> {
  const row = await db.board((id || '').trim())
  if (!row || row.accountId !== account.id) throw new HttpError(404, '没有这块板')
  return row
}

/** 我的卡。判据是卡上那一列 accountId（它从板上冗余下来，见迁移里的注释）。 */
export async function ownCardOf(db: Db, account: Account, id: string): Promise<Card> {
  const row = await db.card((id || '').trim())
  if (!row || row.accountId !== account.id) throw new HttpError(404, '没有这张卡')
  return row
}

/**
 * 要往板里加的这颗 Bot：**必须是这个人自己看得见的那几颗之一**。
 *
 * 判据和 routines 一样走 `visibleBotOf`——归属是 (accountId, botId) 那一对，卡最后要
 * 派到这一对指向的席位上，落在别人名下的 Bot 上根本没有席位可派。
 */
export async function ownBotOf(db: Db, account: Account, botId: string) {
  return visibleBotOf(db, account, botId)
}

/**
 * 派活的目标：必须在这块板的成员名单里。
 *
 * 名单不再是安全边界（板整个关在一个账号里），但它仍然是**人的一次显式圈定**——一个人
 * 名下多半有一颗只处理私事的 Bot，哪几颗进这块板是他的决定，不是模型每次现挑。
 *
 * 拒绝时**把名单原样带回去**：告诉模型有哪些选项，比告诉它「你错了」有用得多，它下一步
 * 就能改对。
 */
export async function assertBoardMember(db: Db, board: Board, botId: string): Promise<void> {
  const hit = await db.boardMember(board.id, botId)
  if (hit) return
  const members = await db.boardMembers(board.id)
  const list = members.map((m) => (m.role ? `${m.botId}（${m.role}）` : m.botId)).join('、')
  throw new HttpError(400, list ? `这颗 Bot 不在这块板上。板上有：${list}` : '这块板上还没有成员，先把 Bot 加进来')
}

/**
 * 建卡时的初始状态。
 *
 * **没有父卡的直接 `ready`**，不经过 `todo`：`todo` 的定义是「还有父卡没做完」，一张没有
 * 依赖的卡待在那儿，只会让人以为还差点什么。
 */
export function initialCardState(parentCount: number): CardState {
  return parentCount > 0 ? 'todo' : 'ready'
}

/** 标题指纹前先归一：空白折叠、去掉首尾。模型换个空格不该算成另一件事。 */
function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * 去重指纹：同一颗 Bot、同一个标题、**同一个 5 分钟时间桶**只建一张。
 *
 * **桶号必须进指纹。** 库上那条是 `unique (boardId, dedupeKey)`——**永久**约束，而去重是
 * 一个窗口。不带桶的话，同一个标题隔一天再建会撞唯一键，回的是一次数据库错误，而人做的
 * 事完全正当（一张每天都要建的卡，标题当然一样）。
 *
 * **为什么是唯一索引而不是先查一遍**（handoff 那边是查询式）：那边一张单来自一次
 * escalate，天然串行；这边模型可以在**一次调用**里给出五张卡，它们同一毫秒落库，先查后插
 * 拦不住自己。
 *
 * 桶边界会漏一次（4:59 和 5:01 算两张）。接受：这条防的是「模型换个措辞连着撞几次」，
 * 那几次全在几秒之内；而漏一次的代价是板上多一张重复卡，人一眼看得见、删得掉。
 *
 * **人在界面上建卡不走这条**（`bot` 传 null）：他刚敲完标题、看着屏幕，重复不重复他自己
 * 知道；而把他挡在唯一键上，是拿一个防模型的机制去管人。
 */
export function dedupeKeyOf(botId: string | null, title: string, at = Date.now()): string | null {
  if (!botId) return null
  const bucket = Math.floor(at / CARD_DEDUPE_WINDOW_MS)
  return createHash('sha1').update(`${botId}\n${normalizeTitle(title)}\n${bucket}`).digest('hex')
}

/**
 * 档位和理由：**没写理由的 `utility` 一律降成 `daily`**。
 *
 * 抄 delegation §8.3。先蹦出档位再补理由，写出来的是事后合理化；而这一档真正的代价是
 * 「做错了看结论看不出来」，没人给过理由的时候，拿不准就该按贵的那档跑。
 *
 * 降级要**留痕**（`downgraded`），否则人在板上看到 `daily` 会以为那是模型选的。
 */
export function resolveModelRole(
  role: unknown,
  reason: string,
): { modelRole: 'daily' | 'utility'; modelReason: string; modelDowngraded: boolean } {
  const wanted = String(role ?? '') === 'utility' ? 'utility' : 'daily'
  const trimmed = reason.trim()
  if (wanted === 'utility' && !trimmed) {
    return { modelRole: 'daily', modelReason: '没给理由，按拿不准处理', modelDowngraded: true }
  }
  return { modelRole: wanted, modelReason: trimmed, modelDowngraded: false }
}
