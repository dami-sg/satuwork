import type { Context } from '@deepseek-ai/cordis'
import { agents, groupOptions, guards, kbOptions, mcpOptions, memories, skillOptions } from './mock.ts'

/**
 * Agent 配置屏。
 *
 * `/api/agents` 归这里——会话屏与定时任务屏都只是**消费者**。这条界线现在就划好，
 * 等 `satu-agent-registry` 落地时改的只有这个文件。
 */
export const name = 'satu-view-agents'
export const inject = ['client', 'server']

export function apply(ctx: Context) {
  ctx.client.register({ id: 'agents', entry: new URL('./client.js', import.meta.url) })

  ctx.server.get('/api/agents', async (req, res) =>
    // 列表只给别的屏用得上的那几个字段：名字、角色、图标、上线与否。
    res.json({
      mock: true,
      agents: agents.map(({ id, name, role, icon, enabled, usage, skills, mcps }) => ({
        id,
        name,
        role,
        icon,
        enabled,
        usage,
        skillCount: skills.length,
        mcpCount: mcps.length,
      })),
    }),
  )

  ctx.server.get('/api/agents/options', async (req, res) =>
    res.json({ mock: true, skills: skillOptions, mcps: mcpOptions, groups: groupOptions, kbs: kbOptions }),
  )

  ctx.server.get('/api/agents/:id', async (req, res) => {
    const agent = agents.find((a) => a.id === req.params.id)
    if (!agent) {
      res.status = 404
      return res.json({ error: `没有这个 Agent：${req.params.id}` })
    }
    return res.json({ mock: true, agent, guards, memories })
  })
}
