import type { Context } from '@deepseek-ai/cordis'

/**
 * 用量统计屏。
 *
 * 现在是 mock，但**它有真来源**：每条 `assistant/message` 都带 usage（token 与
 * 费用），按会话日志聚合就能算出真数。等有了投影（把日志折成统计）这一屏第一个
 * 换成真的——所以这里的字段名刻意跟事件里的对齐，别自造一套。
 */
export const name = 'satu-view-usage'
export const inject = ['client', 'server']

const days = ['8/2', '8/3', '8/4', '8/5', '8/6', '8/7', '8/8', '8/9', '8/10', '8/11', '8/12', '8/13', '8/14', '8/15']
const counts = [42, 58, 51, 63, 88, 71, 34, 29, 76, 92, 68, 81, 95, 47]

export function apply(ctx: Context) {
  ctx.client.register({ id: 'usage', entry: new URL('./client.js', import.meta.url) })

  ctx.server.get('/api/usage', async (req, res) =>
    res.json({
      mock: true,
      stats: [
        { label: '任务执行', value: '895', delta: '+12% 环比' },
        { label: '输入 Tokens', value: '48.2M', delta: '+8% 环比' },
        { label: '输出 Tokens', value: '6.4M', delta: '+15% 环比' },
        { label: '费用', value: '$286.40', delta: '+9% 环比' },
      ],
      daily: days.map((label, i) => ({ label, value: counts[i] })),
      byAgent: [
        { name: '客服助手', value: '412 次', pct: 46 },
        { name: '销售顾问', value: '233 次', pct: 26 },
        { name: '内容运营助手', value: '164 次', pct: 18 },
        { name: '数据分析师', value: '86 次', pct: 10 },
      ],
      byModel: [
        { name: 'deepseek-v4-flash', value: '38.1M tok', pct: 68 },
        { name: 'deepseek-v4-pro', value: '12.4M tok', pct: 22 },
        { name: 'text-embedding-3-large', value: '4.1M tok', pct: 10 },
      ],
      quota: [
        { label: '任务次数', value: '895 / 10,000', pct: 9 },
        { label: 'Tokens', value: '54.6M / 80M', pct: 68 },
      ],
      byMember: [
        { id: 'u1', name: '赵先生', initial: '赵', tasks: '312', tokens: '18.4M', fail: '1.2%', last: '刚刚' },
        { id: 'u2', name: '李文', initial: '李', tasks: '241', tokens: '14.1M', fail: '0.8%', last: '2 小时前' },
        { id: 'u3', name: '王芳', initial: '王', tasks: '198', tokens: '11.7M', fail: '2.1%', last: '昨天' },
        { id: 'u5', name: '孙悦', initial: '孙', tasks: '144', tokens: '10.4M', fail: '0.5%', last: '上周' },
      ],
    }),
  )
}
