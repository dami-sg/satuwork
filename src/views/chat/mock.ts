/**
 * 会话屏里还没有后端的那部分。
 *
 * AI 员工名册已经搬去 Agent 配置屏了（`/api/agents`），这里只剩常用任务卡。
 */

/** 常用任务卡。以后是任务模板注册表，现在是四张卡。 */
export const suggestions = [
  { id: 'triage', title: '归类本周工单', hint: '约 2 分钟', prompt: '把本周的客服工单按主题归类，输出一份摘要发到我的邮箱' },
  { id: 'weekly', title: '生成业务周报', hint: '约 5 分钟', prompt: '汇总本周核心业务指标，做归因分析并输出周报' },
  { id: 'social', title: '写一组社媒文案', hint: '约 3 分钟', prompt: '按品牌调性写一组社媒文案，覆盖微博、小红书两个渠道' },
  { id: 'minutes', title: '整理会议纪要', hint: '约 4 分钟', prompt: '把这次会议的录音转写整理成纪要，列出结论与待办' },
]
