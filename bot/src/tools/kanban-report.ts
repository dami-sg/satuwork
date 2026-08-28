import { Service, type Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl } from '../llm/gateway.ts'

/**
 * 席位向 Gateway 回报看板卡的那条路（见 docs/kanban.md §15.2）。
 *
 * **单独一个插件**，而且它谁都不 inject：报收口的地方有两处——`kanban_complete` /
 * `kanban_block` 那两把工具，和 `runCard` 的收尾（模型一句收口的话都没说）——而那两处
 * 一个在 tools 里、一个在 agent 里。做成服务，两边各自 `inject: ['kanban']` 就够；
 * 塞进 tools/kanban.ts 的话，agent 要用它就得反过来 inject 那个插件，而那个插件
 * inject 着 agents，转一个圈谁都起不来。
 */
export const name = 'satu-kanban-report'

declare module '@deepseek-ai/cordis' {
  interface Context {
    kanban: KanbanService
  }
}

/**
 * 席位向 Gateway 回报一张卡：收口和心跳两件事。
 *
 * **做成服务而不是两个自由函数**，是因为报收口的地方有两处——`kanban_complete` /
 * `kanban_block` 那两把工具（模型说「我做完了」），和 `runCard` 的收尾（模型一句收口的
 * 话都没说）。两处各拼一份 fetch 的话，重试怎么算、409 算不算错、超时多久，会在某一天
 * 分叉成两套；而分叉的那半边没有任何东西会提醒任何人。
 *
 * 顺带它让席位那一侧**测得了**：探针换掉这一个服务，就能验「什么时候报、报了什么」，
 * 不用起一个真的 Gateway。
 */
export class KanbanService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'kanban')
  }

  /**
   * 席位的**运行面**向 Gateway 回报一张卡的收口。
 *
 * 走 `/internal`，不走 `/runtime`——**判据是「谁在说话」**：这一条是这台机器在汇报
 * （和「这条会话结束了」「这次用了多少 token」同一类），不是模型在说话。混进模型那一组
 * 的话，模型有一天就能自己报一句「这张卡跑完了」。
 *
 * 这里用的是席位票（`sat_`），Gateway 那边 `requireInternalCaller` 认它，并且只允许它
 * 替**自己那个账号**说话。
 */
  async report(cardId: string, body: Record<string, unknown>): Promise<void> {
    const base = gatewayUrl()
    const token = gatewayToken()
    if (!base || !token) return
    const r = await fetch(`${base}/internal/kanban/cards/${encodeURIComponent(cardId)}/result`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    })
    // 409 = 那边已经收过口了（比如 kanban_complete 报过一次，收尾这条又报了一次）。
    // **不是错**：正是我们要的那个「只收一次」。
    if (!r.ok && r.status !== 409) {
      throw new Error(`回报卡 ${cardId} 失败：HTTP ${r.status}`)
    }
  }

/**
 * 心跳：席位每 60 秒替正在跑的卡报一次「还活着」。
 *
 * **模型不管这件事**（所以没有 `kanban_heartbeat` 这把工具）：让模型负责保活，是把一个
 * 运维问题伪装成一个提示词问题——它会忘，而忘了的表现是一张明明在跑的卡被判成崩了。
 *
 * 返回 false = Gateway 那边说这张卡已经不在了（人撤了、板删了、或者被判失联收掉了），
 * 席位据此掐掉那一轮，而不是继续跑一个没人认领的活。
 */
  async beat(cardId: string, runId?: string): Promise<boolean> {
    const base = gatewayUrl()
    const token = gatewayToken()
    if (!base || !token) return true
    try {
      const r = await fetch(`${base}/internal/kanban/cards/${encodeURIComponent(cardId)}/heartbeat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ runId: runId ?? '' }),
        signal: AbortSignal.timeout(15_000),
      })
      // 连不上不当作「卡没了」：网络抖一下就掐掉一轮正在跑的活，代价比多跑一会儿大得多。
      return r.ok || r.status >= 500
    } catch {
      return true
    }
  }
}

export function apply(ctx: Context) {
  ctx.plugin(KanbanService)
}
