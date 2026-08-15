import type { Context } from '@deepseek-ai/cordis'
import { detail, stats, tasks } from './mock.ts'

/**
 * 定时任务屏。
 *
 * **后端还没有**：路由回的是 `mock.ts` 里的假数据。这么做而不是把假数据写进
 * 浏览器那半边，是因为界线要划在 HTTP 上——视图从第一天起就走真 fetch，等
 * `satu-scheduler` 做出来，改的是这个文件里的两行，前端一个字不用动。
 *
 * 已经是 mock 的地方都标着 `mock: true`，别让「跑起来了」看着像「做完了」。
 */
export const name = 'satu-view-tasks'
export const inject = ['client', 'server']

export function apply(ctx: Context) {
  ctx.client.register({ id: 'tasks', entry: new URL('./client.js', import.meta.url) })

  ctx.server.get('/api/tasks', async (req, res) => res.json({ mock: true, stats, tasks }))

  ctx.server.get('/api/tasks/:id', async (req, res) => {
    const task = tasks.find((t) => t.id === req.params.id)
    // 不存在就是 404，不是一份空详情——详情页据此画「没这个任务」而不是画空表格。
    if (!task) {
      res.status = 404
      return res.json({ error: `没有这个定时任务：${req.params.id}` })
    }
    return res.json({ mock: true, task: detail(task) })
  })
}
