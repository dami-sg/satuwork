import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl } from '../llm/gateway.ts'
import type { SessionEvent, SessionOrigin } from './types.ts'
import type { Handoff } from '../policy/handoff.ts'

export const name = 'satu-session-gateway'
export const inject = ['server', 'sessions', 'catalog', 'storage']

function pinnedBotId(): string {
  return (process.env.SATUWORK_BOT_ID || '').trim()
}

function bearer(header: string | null): string | undefined {
  if (!header?.startsWith('Bearer ')) return
  const token = header.slice(7).trim()
  return token || undefined
}

function timingSafeToken(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const OUTBOX = 'gateway-outbox'
const READY_CAP_MS = 30_000

/**
 * 只剩 index 一种了。
 *
 * 以前还有 `kind: 'usage'`——每轮结束把这轮的 token 报去 `/internal/usage`。那是
 * **重复记账**：调用本来就是走 Gateway 的 `/v1/chat/completions` 出去的，代理那一侧
 * 已经按每次请求写了一行 llm_calls，bot 再报一次就是同一次调用记两遍。实测 8/19
 * 那天 11 行里有 4 对是完全重复的（token 数一样，createdAt 一个是请求开始、一个是
 * 收流结束）。留代理侧那一份：它拿的是上游返回的原始 usage，而且第三方直接用
 * API key 调 `/v1/*` 的那些请求只有它看得见。
 *
 * 老队列里可能还压着 usage 项，flushOutbox 会把它们直接丢掉，不再往外发。
 */
type OutboxItem =
  | { kind: 'index'; sessionId: string; createdAt: number; attempts: number; lastError?: string }
  /**
   * 一次行为边界的表态（policy/decision）。
   *
   * **为什么要上报**：这三个开关对管理员的全部价值就是「它到底拦住过什么」。只拦不报
   * 的话，开关开着、界面上画着开着的样子，而没有任何一处能回答「上个月拦了几次、拦的
   * 是谁」——那时候它是个心理安慰，不是一条合规证据。
   *
   * 走这条队列而不是当场 fetch：拦截发生在工具执行的关键路径上，一次网络超时就是一次
   * 卡住的对话。落队列、失败重试，Gateway 挂了也只是记录晚到。
   */
  | {
      kind: 'guard'
      sessionId: string
      createdAt: number
      attempts: number
      lastError?: string
      decision: GuardDecision
    }
  /**
   * 一张交接单的状态（见 docs/handoff.md）。
   *
   * **必须能重试**，这是它和 guard 上报最不一样的地方：一张没报上去的单子，在待办页上
   * 就是不存在——人不会去翻会话日志找活干。而报单最常见的失败时刻恰恰是 Gateway 正在
   * 升级换版，那几十秒里开出来的单子不能就这么丢了。
   */
  | {
      kind: 'handoff'
      sessionId: string
      createdAt: number
      attempts: number
      lastError?: string
      handoff: Handoff
    }

/** 与 bot/src/policy/index.ts 的 PolicyDecision 同形。这里只搬运，不解释。 */
interface GuardDecision {
  sessionId: string
  botId: string
  callId: string
  tool: string
  guard: string
  outcome: string
  reason: string
  at: number
}

/**
 * 给 Gateway 拉全文，以及把会话索引报到控制面。
 *
 * 正文只活在本机 JSONL。上报失败落本地队列重试，不能挡住聊天。
 */
export function apply(ctx: Context) {
  ctx.server.get('/internal/sessions/:sessionId', async (req, res) => {
    const token = bearer(req.headers.get('authorization'))
    // 只认席位票。Gateway 拉全文时在 authorization 上带的就是这一把（管家那一跳认的是
    // 另一个头 x-satuwork-machine），所以不需要再认机器票。
    const seat = gatewayToken()
    const ok = Boolean(token) && Boolean(seat) && timingSafeToken(token!, seat)
    if (!ok) {
      res.status = 404
      res.json({ error: 'not found' })
      return
    }
    try {
      const events = await ctx.sessions.events(req.params.sessionId)
      res.json({ events })
    } catch {
      res.status = 404
      res.json({ error: 'not found' })
    }
  })

  // 写成具名类型，不要用类型查询：me 的初值是 null，控制流分析会把那处查询收窄成
  // null，fetchingMe 于是成了 Promise<null>，赋真值时报错。
  type Me = { accountId: string; companyId: string; machineId: string | null; at: number }
  let me: Me | null = null
  let fetchingMe: Promise<Me | null> | null = null
  const outbox = ctx.storage.collection<OutboxItem>(OUTBOX)
  let flushing = false

  async function loadMe(): Promise<Me | null> {
    const base = gatewayUrl()
    const token = gatewayToken()
    if (!base || !token) return null
    try {
      const r = await fetch(base + '/me', {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = (await r.json()) as {
        account?: { id?: string }
        company?: { id?: string; machineId?: string | null }
      }
      const accountId = typeof body.account?.id === 'string' ? body.account.id : ''
      const companyId = typeof body.company?.id === 'string' ? body.company.id : ''
      if (!accountId || !companyId) return null
      // machineId 只从 GET /me 的 company.machineId 取。sat_ 调 /orgs/:id/machine 会 401。
      const machineId = typeof body.company?.machineId === 'string' ? body.company.machineId : null
      return { accountId, companyId, machineId, at: Date.now() }
    } catch (e) {
      ctx.logger?.warn?.(`session index: /me 失败 ${(e as Error).message}`)
      return null
    }
  }

  async function cachedMe() {
    if (me && Date.now() - me.at < 60_000) return me
    if (!fetchingMe) {
      fetchingMe = loadMe().then((row) => {
        me = row
        fetchingMe = null
        return row
      })
    }
    return fetchingMe
  }

  function configured(): boolean {
    return Boolean(gatewayUrl() && gatewayToken())
  }

  async function postInternal(path: string, body: unknown): Promise<void> {
    const base = gatewayUrl()
    // 用席位票上报。Gateway 侧的 requireInternalCaller 认 `sat_`，并且**只允许它报自己
    // 这个账号**——body 里的 accountId 对席位票不作数。
    const token = gatewayToken()
    if (!base || !token) throw new Error('未配置 GATEWAY_URL / GATEWAY_TOKEN')
    const r = await fetch(base + path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      throw new Error(`HTTP ${r.status}${text ? ` ${text.slice(0, 120)}` : ''}`)
    }
  }

  function enqueue(item: OutboxItem) {
    /**
     * **`index` 这一类按 sessionId 去重。**
     *
     * 它报的是「这条会话现在是什么样」——一份快照，不是一件件要补发的事。而触发它的
     * 事件（user/message、turn/end、session、session/title）在一次忙碌的会话里几十条
     * 起步：Gateway 断开一小时，同一条会话就能压出几十行一模一样的待发项。之后每一轮
     * flush 都要把它们挨个发一遍（每条 8 秒超时，`flushing` 期间新的还进不来），而
     * Gateway 那边收到的是同一份快照重复几十次。留最新的一条就够。
     */
    if (item.kind === 'index') {
      for (const row of outbox.list()) {
        if (row.value.kind === 'index' && row.value.sessionId === item.sessionId) outbox.delete(row.id)
      }
    }
    outbox.put(randomUUID(), item)
    void flushOutbox()
  }

  async function flushOutbox() {
    if (flushing || !configured()) return
    flushing = true
    try {
      for (const row of outbox.list()) {
        // 升级前压在队列里的 usage 项：丢掉，别发。留着只会重复计费，
        // 而且 Gateway 那条 /internal/usage 已经拆掉了，发出去只会 404。
        if (row.value.kind !== 'index' && row.value.kind !== 'guard' && row.value.kind !== 'handoff') {
          outbox.delete(row.id)
          continue
        }
        try {
          if (row.value.kind === 'guard') await sendGuard(row.value.decision)
          else if (row.value.kind === 'handoff') await sendHandoff(row.value.handoff)
          else await sendIndex(row.value.sessionId)
          outbox.delete(row.id)
        } catch (e) {
          outbox.put(row.id, {
            ...row.value,
            attempts: row.value.attempts + 1,
            lastError: (e as Error).message,
          })
          if (row.value.attempts + 1 === 1 || (row.value.attempts + 1) % 8 === 0) {
            ctx.logger?.warn?.(`gateway outbox: ${row.value.kind} 重试失败 ${(e as Error).message}`)
          }
        }
      }
    } finally {
      flushing = false
    }
  }

  async function sendIndex(sessionId: string) {
    const who = await cachedMe()
    if (!who) throw new Error('/me 未就绪')
    const events = await ctx.sessions.events(sessionId)
    const root = events.find((e) => e.type === 'session')
    if (!root) throw new Error('没有 session 根事件')
    const titled = [...events].reverse().find((e) => e.type === 'session/title')
    const data = root.data as {
      title?: string
      createdAt: number
      botId?: string
      origin?: SessionOrigin
      remoteId?: string
    }
    const title = (titled?.data as { title?: string } | undefined)?.title ?? data.title ?? null
    // messageCount：用户+助手消息条数（不含 tool/chunk/turn 信封）。
    const messageCount = events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message').length
    await postInternal('/internal/sessions/index', {
      sessionId,
      companyId: who.companyId,
      accountId: who.accountId,
      botId: data.botId || null,
      origin: data.origin || null,
      remoteId: data.remoteId ?? null,
      machineId: who.machineId,
      title,
      createdAt: data.createdAt,
      updatedAt: Date.now(),
      messageCount,
    })
  }

  async function sendGuard(decision: GuardDecision) {
    const who = await cachedMe()
    if (!who) throw new Error('/me 未就绪')
    await postInternal('/internal/guard-events', {
      companyId: who.companyId,
      accountId: who.accountId,
      ...decision,
    })
  }

  /**
   * 报一张单。
   *
   * **`assignee` 不在这里算**：席位只认得自己那一个账号，"这件事该谁处理"要读公司模版
   * 和成员表，那两样都在 Gateway。这边只报事实（哪张单、什么状态、谁接的）。
   */
  async function sendHandoff(h: Handoff) {
    const who = await cachedMe()
    if (!who) throw new Error('/me 未就绪')
    await postInternal('/internal/handoffs', {
      companyId: who.companyId,
      accountId: who.accountId,
      id: h.id,
      sessionId: h.sessionId,
      botId: h.botId,
      state: h.state,
      // 这边的 claimedBy 是个带名字的对象，Gateway 那张表只认 accountId。
      claimedBy: h.claimedBy?.accountId ?? '',
      blocking: h.blocking,
      repeats: h.repeats ?? 0,
      reason: h.reason,
      ask: h.ask,
      createdAt: h.createdAt,
      updatedAt: h.updatedAt,
    })
  }

  /**
   * 每一次状态流转都往控制面报一条。
   *
   * 同 `policy/decision`：**不 await、不挡路**，失败落队列自己重试。人点「接手」那一下
   * 等的是席位的响应，不该再等一次 Gateway 的往返。
   */
  ctx.on('handoff/change', (h: Handoff) => {
    if (!configured()) return
    /**
     * 认不出这条会话属于哪颗 Bot 时**不报**（`botOf` 读不到会话、名册里没有）。
     *
     * 报上去的话，Gateway 那张表里会多出一行 botId 为空的单子：待办页上「去处理」
     * 点不开，接手 / 交还也够不着席位（按 accountId + botId 取地址），而它长得和正常
     * 的一模一样。会话里那张卡不受影响，本来就在席位自己这边。
     */
    if (!h.botId) {
      ctx.logger?.warn?.(`交接单 ${h.id} 认不出所属 Bot，不上报（会话里那张卡照常）`)
      return
    }
    void sendHandoff(h).catch((e: Error) => {
      ctx.logger?.warn?.(`交接单上报失败，转入队列：${e.message}`)
      enqueue({ kind: 'handoff', sessionId: h.sessionId, createdAt: Date.now(), attempts: 0, handoff: h })
    })
  })

  async function report(sessionId: string) {
    if (!configured()) return
    try {
      await sendIndex(sessionId)
    } catch (e) {
      ctx.logger?.warn?.(`session index: 上报失败 ${(e as Error).message}`)
      enqueue({ kind: 'index', sessionId, createdAt: Date.now(), attempts: 0, lastError: (e as Error).message })
    }
  }

  /**
   * 边界的每一次表态都往控制面报一条。
   *
   * **不 await、不挡路**：这个监听器跑在 `ctx.emit` 上（同步派发、不收返回值），
   * 而 emit 它的地方正是工具执行的关键路径。发失败就落队列，五秒一轮自己重试。
   */
  ctx.on('policy/decision', (decision: GuardDecision) => {
    if (!configured()) return
    void sendGuard(decision).catch((e: Error) => {
      ctx.logger?.warn?.(`guard 上报失败，转入队列：${e.message}`)
      enqueue({ kind: 'guard', sessionId: decision.sessionId, createdAt: Date.now(), attempts: 0, decision })
    })
  })

  /**
   * 委派开出来的子会话**不进索引**。
   *
   * 控制面那张表回答的是「这个人有哪几条对话」，而一次子任务不是一条对话——它是某条
   * 对话里的一次工具调用的内部过程。报上去的话，侧栏和会话列表里会冒出一堆标题为
   * 「子任务：…」的行，而点进去看到的是一段没头没尾的执行记录。
   *
   * 判据是根事件的 `kind`，不是 id 前缀（理由见 session/types.ts）。
   *
   * **两头都要记。** `events()` 返回的是整条会话事件数组的一份拷贝，而一条长会话能有几万
   * 条；只记「是子会话」的话，主会话每来一条要上报的事件都会重新拷一遍整条历史——而主会话
   * 正是天天在长的那一条。会话的 kind 是根事件上的东西，一旦定下就不会变，缓存不会过期。
   */
  const sessionKind = new Map<string, boolean>()
  /**
   * 这条会话是不是**旁支**（委派的子会话、看板的卡片会话）——旁支不上报索引。
   *
   * **判据是「不是 main」，不是「是 task」。** 照后者写的话，卡片会话会一条条报上控制面，
   * 而那份索引回答的是「这个人有哪几条对话」（docs/kanban.md 口径二）。
   */
  const isSideSession = async (sessionId: string): Promise<boolean> => {
    const known = sessionKind.get(sessionId)
    if (known !== undefined) return known
    const root = (await ctx.sessions.events(sessionId)).find((e) => e.type === 'session')
    const kind = (root?.data as { kind?: string } | undefined)?.kind
    const side = !!kind && kind !== 'main'
    sessionKind.set(sessionId, side)
    return side
  }

  ctx.on('session/event', (sessionId: string, event: SessionEvent) => {
    if (
      event.type === 'session' ||
      event.type === 'user/message' ||
      event.type === 'session/title' ||
      event.type === 'turn/end'
    ) {
      /**
       * **catch 不能省。** 这是个浮在外面的 promise，而 Node 15 起未处理的拒绝会直接把
       * 进程带走——一次读盘异常就能让整台席位在人说话说到一半时消失。上报失败远没有那么
       * 严重：它本来就有重试队列。
       */
      void isSideSession(sessionId)
        .then((task) => {
          if (!task) void report(sessionId)
        })
        .catch((e: Error) => ctx.logger?.warn?.(`session index: 认不出 ${sessionId} 是不是子会话，这次不报：${e.message}`))
    }
    // turn/end 不再上报用量：那一份由 Gateway 代理侧记，见 OutboxItem 上的说明。
  })

  const flushTimer = setInterval(() => void flushOutbox(), 5000)
  ctx.effect(() => () => clearInterval(flushTimer))

  async function announceReady() {
    const base = gatewayUrl()
    const botId = pinnedBotId()
    if (!base || !gatewayToken() || !botId) return
    if (!ctx.catalog.pinSucceeded) {
      const ok = await ctx.catalog.pull()
      if (!ok || !ctx.catalog.pinSucceeded) throw new Error('目录尚未钉住 SATUWORK_BOT_ID')
    }
    const who = await cachedMe()
    if (!who) throw new Error('/me 未就绪')
    const host = String(ctx.server.baseUrl || '').replace(/\/$/, '')
    if (!host) throw new Error('server.baseUrl 为空')
    await postInternal(`/internal/instances/${encodeURIComponent(who.accountId)}/ready`, { host, botId })
  }

  const botId = pinnedBotId()
  if (!botId) {
    if (gatewayUrl() && gatewayToken()) {
      ctx.logger?.warn?.('instance ready: 未设 SATUWORK_BOT_ID，不上报 ready')
    }
    return
  }

  const started = Date.now()
  let delay = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const tick = () => {
    if (stopped) return
    void announceReady().catch((e: Error) => {
      ctx.logger?.warn?.(`instance ready 失败 ${e.message}`)
      const elapsed = Date.now() - started
      if (elapsed >= READY_CAP_MS) {
        ctx.logger?.warn?.('instance ready: 已超过 30 秒仍未钉住目录或上报，停止重试')
        return
      }
      delay = delay === 0 ? 400 : Math.min(3000, Math.max(400, delay * 2))
      const wait = Math.min(delay, READY_CAP_MS - elapsed)
      timer = setTimeout(tick, wait)
    })
  }
  timer = setTimeout(tick, 0)
  ctx.effect(() => () => {
    stopped = true
    if (timer) clearTimeout(timer)
  })
}
