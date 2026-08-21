import type { Context } from '@deepseek-ai/cordis'
import type { ToolCall } from '../tools/index.ts'

/** 一条还等着人拍板的调用。刷新页面之后界面靠它把卡片摆回来。 */
export interface PendingApproval {
  sessionId: string
  callId: string
  name: string
  arguments: string
  reason: string
  createdAt: number
  expiresAt: number
}

export type Verdict = 'approved' | 'denied' | 'timeout' | 'aborted'

/**
 * 一次确认的结果。
 *
 * 光有 verdict 不够：**「谁批的、按哪种范围批的」得能从日志重建**，而
 * 「这次对话都批准」之后的调用连卡片都不会出现——不带出 `viaGrant`，事后看到的
 * 就是一串没有来由的 approved。
 */
export interface Decision {
  verdict: Verdict
  /** 人点的是「这一次」还是「这次对话都批准」。没人点（超时、被停止）时没有这一项。 */
  scope?: 'once' | 'session'
  /** 这次是被此前那条「本会话都批准」直接放行的，没有再问过人。 */
  viaGrant?: boolean
}

/**
 * 等多久。到点按**拒绝**处理，不是按批准。
 *
 * 五分钟：人正坐在对面时够他看清参数再点，人已经离开时也不至于让那一轮挂到天荒地老
 * ——工具那边是真的 await 在这儿，会话上那一轮一直开着。
 */
const TIMEOUT_MS = Math.max(10_000, Math.trunc(Number(process.env.SATUWORK_APPROVAL_TIMEOUT_MS) || 5 * 60_000))

/**
 * 高风险操作的确认往返。
 *
 * **拦下来告诉模型「你需要先问用户」是不够的**：模型会去问，用户会说「好」，然后模型
 * 原样再调一次——而那一次和上一次在这里长得一模一样，于是再被拦一次。要么陷在循环里
 * 撞步数硬顶，要么就得让模型自己声明「我已经问过了」，那等于把边界交回给它。
 *
 * 所以确认是**一次真的往返**：调用停在这里等，人在界面上点批准，这次调用继续跑下去。
 * 决定权和执行点之间没有中间人。
 */
export class ApprovalGate {
  private waiting = new Map<string, { rec: PendingApproval; settle: (v: Verdict, scope?: 'once' | 'session') => void }>()
  /**
   * 「本会话内都批准」的口子：sessionId → 工具名。
   *
   * **只在内存里，进程一重启就没了。** 落盘的话，一次「今天下午都别问我了」会跨过
   * 重启、跨过第二天，而那时候点它的人早就不在了。丢失的方向是多问一次，安全。
   */
  private grants = new Map<string, Set<string>>()

  constructor(private ctx: Context) {}

  /** 这条会话上还等着的那几条。界面刷新后靠它恢复。 */
  list(sessionId: string): PendingApproval[] {
    return [...this.waiting.values()].filter((w) => w.rec.sessionId === sessionId).map((w) => w.rec)
  }

  /**
   * 停在这儿等人拍板。
   *
   * 三条出路都要走到：人点了、这一轮被中止（停止按钮）、等到超时。少任何一条，
   * 那次调用就会挂着不动——而它挂着的时候，整条会话都在等它。
   */
  async ask(call: ToolCall, reason: string): Promise<Decision> {
    const granted = this.grants.get(call.sessionId)
    if (granted?.has(call.name)) return { verdict: 'approved', scope: 'session', viaGrant: true }

    const key = `${call.sessionId}:${call.callId}`
    const now = Date.now()
    const rec: PendingApproval = {
      sessionId: call.sessionId,
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
      reason,
      createdAt: now,
      expiresAt: now + TIMEOUT_MS,
    }

    /**
     * **先登记，再广播。**
     *
     * 反过来的话，pending 事件已经推到浏览器、而这条还没进 `waiting`：那一瞬间点下
     * 「批准」拿到的是「这条确认已经结束了」，而它其实才刚开始。窗口只有一个微任务，
     * 但它是真的，而且只会在人手最快的时候发作——最难复现的那一类。
     */
    const settled = new Promise<Decision>((resolve) => {
      let done = false
      const finish = (v: Verdict, scope?: 'once' | 'session') => {
        if (done) return
        done = true
        clearTimeout(timer)
        call.signal?.removeEventListener('abort', onAbort)
        this.waiting.delete(key)
        resolve(scope ? { verdict: v, scope } : { verdict: v })
      }
      const onAbort = () => finish('aborted')
      const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS)
      // 已经是 aborted 的信号不会再发事件——那种情况要当场收，否则这次确认会挂在一个
      // 早就被喊停的轮次里等满五分钟。
      this.waiting.set(key, { rec, settle: finish })
      if (call.signal?.aborted) return finish('aborted')
      call.signal?.addEventListener('abort', onAbort, { once: true })
    })

    await this.append(rec.sessionId, {
      callId: rec.callId,
      name: rec.name,
      arguments: rec.arguments,
      reason,
      state: 'pending',
      expiresAt: rec.expiresAt,
    })

    const decision = await settled
    await this.append(rec.sessionId, {
      callId: rec.callId,
      name: rec.name,
      arguments: rec.arguments,
      reason,
      state: decision.verdict,
      // **范围要落进终态事件。** 少了它，「这次对话都批准」在日志里跟「只批这一次」
      // 长得一模一样，而后面那些不再弹卡片的调用就成了没有出处的放行。
      ...(decision.scope ? { scope: decision.scope } : {}),
    })
    return decision
  }

  /**
   * 人点了。
   *
   * 返回三种结果而不是布尔：「批准了」「这条早就不在了」对用户是完全不同的两句话——
   * 两个标签页各点一次，后点的那个必须知道自己点的是一条已经结束的确认，而不是以为
   * 自己批准了什么。
   */
  decide(
    sessionId: string,
    callId: string,
    decision: 'approve' | 'deny',
    scope: 'once' | 'session' = 'once',
  ): 'ok' | 'gone' {
    const hit = this.waiting.get(`${sessionId}:${callId}`)
    if (!hit) return 'gone'
    if (decision === 'approve' && scope === 'session') {
      const set = this.grants.get(sessionId) ?? new Set<string>()
      set.add(hit.rec.name)
      this.grants.set(sessionId, set)
    }
    // 拒绝没有「范围」可言——带上一个 scope: 'once' 只会让日志读起来像「他只拒了这一次」。
    hit.settle(decision === 'approve' ? 'approved' : 'denied', decision === 'approve' ? scope : undefined)
    return 'ok'
  }

  /** 这条会话上「本会话内都批准」过的工具。给 /api/sessions/:id/approvals 报出去。 */
  grantedIn(sessionId: string): string[] {
    return [...(this.grants.get(sessionId) ?? new Set<string>())]
  }

  private async append(sessionId: string, data: {
    callId: string
    name: string
    arguments: string
    reason: string
    state: 'pending' | Verdict
    scope?: 'once' | 'session'
    expiresAt?: number
  }): Promise<void> {
    try {
      await this.ctx.sessions.append(sessionId, 'tool/approval', data)
    } catch (e) {
      // 写不进日志不能让这次确认失效：等还是要等的，只是界面上那张卡片没了。
      this.ctx.logger?.warn?.(`policy: 确认事件写不进会话 ${(e as Error).message}`)
    }
  }
}
