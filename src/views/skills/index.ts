import type { Context } from '@deepseek-ai/cordis'
import { servers, skills } from './mock.ts'

/**
 * Skill 与 MCP 屏。
 *
 * 有一段是**真的**：`/api/tools` 直接读工具注册表（`ctx.tools`）。这一屏因此不是
 * 全假——真正跑着的工具就那两个，界面照实说，而不是拿五个漂亮的 MCP 服务器
 * 把它盖过去。
 */
export const name = 'satu-view-skills'
export const inject = ['client', 'server', 'tools']

export function apply(ctx: Context) {
  ctx.client.register({ id: 'skills', entry: new URL('./client.js', import.meta.url) })

  /** 真数据：这台机器上此刻注册着的工具。 */
  ctx.server.get('/api/tools', async (req, res) => res.json({ tools: ctx.tools.schemas() }))

  ctx.server.get('/api/skills', async (req, res) => res.json({ mock: true, skills, servers }))
}
