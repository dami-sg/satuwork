/**
 * 看板的通知（见 docs/kanban.md §14）。
 *
 * 复用[交接单那三层](./handoff-sweep.ts)，一层都不新造：
 *
 * | 层 | 场景 | 怎么做 |
 * |---|---|---|
 * | 1 | 人正看着板 | 板上那张卡自己变色（轮询，界面那边） |
 * | 2 | 人在别的屏 | 顶栏那个计数**同时数**交接单和 blocked 卡 |
 * | 3 | 人不在场 | 公司那条 webhook |
 *
 * 第 2 层是关键：**一张 blocked 的卡和一张开着的交接单，对人是同一件事**——「有活等着
 * 你」。分成两个数字、两页清单的话，人要学会看两个地方，而他只会记住一个。
 */
import { blockedNeedsAttention, type Card, type Db } from './db.ts'
import { webhookPayload } from './handoff-sweep.ts'
import { machineTokenFor, seatBearer } from './lib/runtime.ts'

/** webhook 等多久。它在收口的关键路径上，一条挂死的地址不能拖住那张卡的状态流转。 */
const POST_TIMEOUT_MS = 8000

/**
 * 卡住了，推一条出去。
 *
 * **只推三档**（`by-model` / `failed` / `reopen-cap`），**人自己按停止的那些不推**：
 * 他点一下停止、下一秒收到一条「你有一张卡卡住了」——他刚按的那一下就是原因，而系统
 * 回头把它当成一件要他处理的事报给他。这是这套通知最容易失去信任的方式。
 *
 * **连标题都不带。** 这条 URL 是公司级的，而板只有主人看得见（口径〇）：带上标题就是
 * 把一块私人板的内容一天几条地倒进公司群，而板名和卡名恰恰是最能说明问题的两样东西
 * （「离职交接」「面试候选人筛选」）。
 *
 * 看着没用，其实正好够：**这一层的作用是把人叫回来，不是让他在群里把事读完。**
 *
 * 失败只记一笔，不抛：通知发不出去不该影响卡本身的状态——那张卡已经 blocked 了，
 * 站内照样看得见。
 */
export async function notifyBlocked(db: Db, card: Card): Promise<boolean> {
  if (!blockedNeedsAttention(card.blockedKind)) return false
  const company = await db.company(card.companyId)
  const url = (company?.handoffWebhook || '').trim()
  if (!url || /^https:\/\//i.test(url) === false) return false
  const owner = await db.account(card.accountId)
  const base = (company?.accessUrl || '').replace(/\/$/, '')
  const text = [
    '【看板】有一张卡停住了，等人处理',
    `谁的板：${owner?.name || owner?.email || card.accountId}`,
    `卡号：${card.id}`,
    base ? `去看看：${base}/kanban` : '',
  ]
    .filter(Boolean)
    .join('\n')
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(webhookPayload(text)),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return true
  } catch (e) {
    console.warn(`kanban: 通知没发出去（${card.id}）：${(e as Error).message}`)
    return false
  }
}

/**
 * `notify: 'report'` —— 做完了往**做完这张卡的那颗 Bot** 的主会话里说一声。
 *
 * **为什么是 assignee 那颗，不是建卡的人常用的那颗。** 人看到汇报之后第一句多半是追问
 * （「那第三家呢」），而唯一还能接住这句的是刚做完那件事的那颗——它至少在自己主会话里
 * 拿得到那段结论，还能 `kanban_list` 找回这张卡。发给别的 Bot 的话，人问出去的那句话
 * 砸在一颗完全不知情的 Bot 身上，它只能回一句「我不清楚」。
 *
 * 走的是[交接单交还](../docs/handoff.md)那条现成的路：**新起一轮**，而不是试图接回卡片
 * 会话——那条会话早就收口了，而且人在界面上根本看不见它。
 *
 * 发不出去只记一笔：结论已经在卡上了，少的只是一句招呼。
 */
export async function reportToOwner(db: Db, card: Card): Promise<boolean> {
  if (card.notify !== 'report' || !card.assigneeBotId) return false
  try {
    const row = await db.instance(card.accountId, card.assigneeBotId)
    const host = (row?.host || '').trim().replace(/\/$/, '')
    if (!host) return false
    const account = await db.account(card.accountId)
    if (!account) return false
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${await seatBearer(db, card.accountId)}`,
    }
    const machine = await machineTokenFor(db, account, card.assigneeBotId)
    if (machine) headers['x-satuwork-machine'] = machine
    // 这颗 Bot 的长会话。席位那边没有就现建一个，和界面走的是同一条路。
    const got = await fetch(`${host}/api/bots/${encodeURIComponent(card.assigneeBotId)}/session`, { headers })
    const sessionId = ((await got.json().catch(() => null)) as { sessionId?: string } | null)?.sessionId
    if (!sessionId) return false
    const text = [
      `板上那张卡「${card.title}」做完了。`,
      '',
      card.summary || '（没留下结论）',
      '',
      `卡号 ${card.id}。要看上下文或者接着往下派，用 kanban_list。`,
    ].join('\n')
    const r = await fetch(`${host}/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'POST',
      headers,
      /**
       * `source` 说清这条不是人打的字。界面上那条消息因此画成一张卡而不是一个气泡，
       * 审计和重放里也认得出它的出处（同 routines / handoff 交还那两条路）。
       */
      body: JSON.stringify({ text, source: { kind: 'plugin', plugin: 'kanban', form: card.id } }),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
    })
    return r.ok
  } catch (e) {
    console.warn(`kanban: 完成通知没发出去（${card.id}）：${(e as Error).message}`)
    return false
  }
}
