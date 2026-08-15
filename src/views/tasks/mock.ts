/**
 * 「我的定时任务」的假数据，取自设计稿。
 *
 * 单独一个文件，是为了让**真接后端那一刻的动作足够小**：`index.ts` 里把读这份
 * 数据的两行换成 `ctx.jobs` 的查询，然后删掉这个文件，浏览器那边一个字不用改。
 * 假数据散进视图里就没有这条界线了——那时候每一屏都得重写一遍才能接上真数据。
 */

export interface Task {
  id: string
  name: string
  desc: string
  freq: string
  next: string
  /** 上次结果：成功 / 失败 / 未运行。 */
  result: string
  enabled: boolean
}

export const tasks: Task[] = [
  { id: 'daily-ticket-digest', name: '客服工单日报', desc: '归类前一日工单并生成摘要邮件', freq: '每天 09:00', next: '明天 09:00', result: '成功', enabled: true },
  { id: 'price-watch', name: '竞品定价监控', desc: '抓取 6 家竞品价格变化写入知识库', freq: '每 4 小时', next: '今天 16:00', result: '成功', enabled: true },
  { id: 'weekly-metrics', name: '业务指标周报', desc: '汇总核心指标并输出图表到 Notion', freq: '每周一 08:30', next: '下周一 08:30', result: '成功', enabled: true },
  { id: 'invoice-recon', name: '发票对账', desc: '核对供应商发票与付款记录', freq: '每月 1 日 10:00', next: '9 月 1 日 10:00', result: '失败', enabled: true },
  { id: 'kb-dedupe', name: '知识库去重', desc: '扫描重复文档并合并版本', freq: '每周五 20:00', next: '已暂停', result: '未运行', enabled: false },
]

export const stats = { enabled: 4, ranToday: 11, failed7d: 1 }

export interface Run {
  id: string
  start: string
  duration: string
  result: string
  output: string
}

/** 运行历史。真实现里一次运行 = 一个 session，这里先给一份固定的。 */
export const runs: Run[] = [
  { id: 'run_7ab318', start: '今天 09:00', duration: '1m 42s', result: '成功', output: '摘要已发送至 admin@satuwork.com' },
  { id: 'run_7ab317', start: '昨天 09:00', duration: '1m 58s', result: '成功', output: '摘要已发送至 admin@satuwork.com' },
  { id: 'run_9f2c41', start: '8月12日 09:00', duration: '12s', result: '失败', output: '数据源鉴权失败，已重试 2 次' },
  { id: 'run_7ab315', start: '8月11日 09:00', duration: '2m 04s', result: '成功', output: '摘要已发送至 admin@satuwork.com' },
  { id: 'run_7ab314', start: '8月10日 09:00', duration: '1m 36s', result: '成功', output: '摘要已发送至 admin@satuwork.com' },
]

/** 详情页比列表多出来的那些字段。 */
export function detail(task: Task) {
  return {
    ...task,
    prompt: `${task.desc}。每次执行读取相关数据源与知识库，产出结构化结果；若出现异常自动重试，仍失败则通知负责人。`,
    successRate: task.result === '失败' ? '92%' : '98%',
    avgDuration: '1m 47s',
    agent: '客服助手',
    mode: 'ask',
    notify: ['邮件'],
    retry: '最多 2 次',
    timeout: '10 分钟',
    createdAt: '2026-07-02',
    runs,
  }
}
