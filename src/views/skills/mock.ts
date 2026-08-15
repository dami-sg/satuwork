/**
 * Skill 与 MCP 的假数据。
 *
 * 真实现分两半：Skill 是 `ctx.skills`（注册表 + 文件系统 provider），MCP 走
 * `packages/mcp`。**内置工具那一段不在这里**——那份是真的，见 index.ts。
 */

export const skills = [
  { id: 'ticket-digest', name: '工单归类与摘要', desc: '把一段时间的工单按主题聚类，输出摘要与占比变化。', tags: ['客服', '自动化'], steps: 4, source: '手动编写', usage: '218 次', enabled: true },
  { id: 'weekly-metrics', name: '指标周报生成', desc: '按口径手册拉取核心指标，做同比环比并输出图表。', tags: ['数据'], steps: 6, source: '手动编写', usage: '86 次', enabled: true },
  { id: 'lead-scoring', name: '线索评分与跟进', desc: '按成交特征给线索打分，生成跟进话术与优先级。', tags: ['销售'], steps: 5, source: '模板导入', usage: '64 次', enabled: true },
  { id: 'social-rewrite', name: '社媒内容改写', desc: '一份文案按渠道调性改写成多个版本。', tags: ['内容'], steps: 3, source: '手动编写', usage: '132 次', enabled: false },
  { id: 'contract-extract', name: '合同要点提取', desc: '抽取金额、期限、违约与续约条款，输出结构化表格。', tags: ['法务'], steps: 5, source: '模板导入', usage: '41 次', enabled: true },
]

export const servers = [
  { id: 'zendesk-mcp', name: 'zendesk-mcp', desc: '工单读写、宏与客户资料', kind: 'SSE', toolCount: 12, perm: '读写', usage: '840 次', enabled: true },
  { id: 'knowledge-mcp', name: 'knowledge-mcp', desc: '内部知识库全文检索', kind: 'stdio', toolCount: 4, perm: '只读', usage: '1,204 次', enabled: true },
  { id: 'postgres-mcp', name: 'postgres-mcp', desc: '业务库只读查询', kind: 'stdio', toolCount: 6, perm: '只读', usage: '312 次', enabled: true },
  { id: 'notion-mcp', name: 'notion-mcp', desc: '页面创建与数据库写入', kind: 'SSE', toolCount: 9, perm: '读写', usage: '176 次', enabled: true },
  { id: 'salesforce-mcp', name: 'salesforce-mcp', desc: '商机与联系人同步', kind: 'SSE', toolCount: 15, perm: '读写', usage: '0 次', enabled: false },
]
