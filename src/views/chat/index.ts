import type { Context } from '@deepseek-ai/cordis'
import { suggestions } from './mock.ts'

/**
 * 会话屏。
 *
 * 会话本身接的是**真** API（`/api/sessions*`，现在归 satu-web）。AI 员工名册归
 * Agent 配置屏（`/api/agents`），这里只是消费者。剩下没有后端的只有常用任务卡。
 */
export const name = 'satu-view-chat'
export const inject = ['client', 'server']

export function apply(ctx: Context) {
  ctx.client.register({
    id: 'chat',
    entry: new URL('./client.js', import.meta.url),
    immediately: true,
  })

  ctx.server.get('/api/suggestions', async (req, res) => res.json({ mock: true, suggestions }))
}
