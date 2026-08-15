/**
 * AI 员工名册。
 *
 * 后端是 `satu-agent-registry`：把这里的定义编译成 per-session 的能力组合
 * （preset）。在那之前，这份数据是 mock，但**归属是真的**——会话屏与定时任务屏
 * 都从 `/api/agents` 读它，谁也不再自己抄一份。
 */

export interface Agent {
  id: string
  name: string
  role: string
  /** 头像图标键，见 ui/shell/icons.js 的 AGENT_ICONS。 */
  icon: string
  enabled: boolean
  usage: string
  model: string
  fallback: string
  temperature: number
  prompt: string
  greeting: string
  skills: string[]
  mcps: string[]
  groups: string[]
  kbs: string[]
}

export const agents: Agent[] = [
  {
    id: 'support',
    name: '客服助手',
    role: '客服',
    icon: 'chat',
    enabled: true,
    usage: '412 次',
    model: 'deepseek-v4-flash',
    fallback: 'deepseek-v4-pro',
    temperature: 0.3,
    prompt:
      '你是 Acme 的客服助手。用简洁、专业、友好的语气回复客户咨询。\n\n原则：\n1. 先确认客户诉求，再给出结论与下一步。\n2. 涉及退款、赔付、合同条款时，先检索知识库，不要凭记忆回答。\n3. 无法确认的信息不要猜测，转交人工并说明已收集的上下文。',
    greeting: '你好，我是 Acme 客服助手，请问遇到什么问题？',
    skills: ['工单归类与摘要'],
    mcps: ['zendesk-mcp', 'knowledge-mcp'],
    groups: ['客服组'],
    kbs: ['客服工单规范', '产品手册'],
  },
  {
    id: 'analyst',
    name: '数据分析师',
    role: '数据分析',
    icon: 'chart',
    enabled: true,
    usage: '86 次',
    model: 'deepseek-v4-pro',
    fallback: 'deepseek-v4-flash',
    temperature: 0.2,
    prompt:
      '你是数据分析师。围绕业务指标做归因分析，结论先行、数据支撑。\n\n原则：\n1. 每个结论必须给出数据来源与统计口径。\n2. 指标异常时给出至少两种可能解释与验证方式。\n3. 不确定的推断标注置信度。',
    greeting: '需要看哪个指标？我可以拉数据并做归因。',
    skills: ['指标周报生成', '线索评分与跟进'],
    mcps: ['postgres-mcp', 'notion-mcp'],
    groups: ['数据组'],
    kbs: ['指标口径手册'],
  },
  {
    id: 'content',
    name: '内容运营助手',
    role: '内容运营',
    icon: 'pen',
    enabled: false,
    usage: '164 次',
    model: 'deepseek-v4-flash',
    fallback: '无',
    temperature: 0.7,
    prompt: '你是内容运营助手。按品牌调性产出多渠道内容，避免夸张与绝对化表述。',
    greeting: '想写什么内容？告诉我渠道和目标人群。',
    skills: ['社媒内容改写'],
    mcps: ['notion-mcp'],
    groups: ['全体成员'],
    kbs: ['品牌调性指南'],
  },
  {
    id: 'sales',
    name: '销售顾问',
    role: '销售',
    icon: 'deal',
    enabled: true,
    usage: '128 次',
    model: 'deepseek-v4-flash',
    fallback: 'deepseek-v4-pro',
    temperature: 0.4,
    prompt: '你是销售顾问。基于历史成交案例给出报价建议与异议处理策略。',
    greeting: '在跟哪个客户？我帮你梳理策略。',
    skills: ['线索评分与跟进'],
    mcps: ['salesforce-mcp', 'knowledge-mcp'],
    groups: ['全体成员'],
    kbs: ['成交案例库'],
  },
]

/** 行为边界。真实现是 `ctx.approval` 加工具守卫，这里先给出词汇。 */
export const guards = [
  { id: 'approve-write', title: '写入前需确认', desc: '修改工单、发送邮件、写入数据库前先征求同意', on: true },
  { id: 'no-external', title: '禁止访问未授权的外部系统', desc: '只允许调用已勾选的 MCP 与连接器', on: true },
  { id: 'cite-kb', title: '回答须给出知识库出处', desc: '涉及规则与条款时必须标注来源切片', on: false },
]

/** 已存记忆。真实现是 `satu-memory`，注入预算挂在 agent/pre-step 上。 */
export const memories = [
  { id: 'm1', kind: '偏好', text: '客户「远洋科技」要求所有沟通抄送 ops@yuanyang.com', time: '3 天前' },
  { id: 'm2', kind: '事实', text: '退款审批阈值为 2000 元，超出需财务复核', time: '上周' },
  { id: 'm3', kind: '流程', text: '工单超过 48 小时未响应自动升级到客服主管', time: '2 周前' },
]

export const skillOptions = ['工单归类与摘要', '指标周报生成', '线索评分与跟进', '社媒内容改写', '合同要点提取']
export const mcpOptions = ['zendesk-mcp', 'knowledge-mcp', 'postgres-mcp', 'notion-mcp', 'salesforce-mcp']
export const groupOptions = ['全体成员', '客服组', '数据组', '销售组']
export const kbOptions = ['客服工单规范', '产品手册', '指标口径手册', '品牌调性指南', '成交案例库']
