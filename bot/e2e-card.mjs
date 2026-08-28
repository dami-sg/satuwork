/**
 * 席位上跑一张看板卡（见 docs/kanban.md §9）。
 *
 * 为什么值得单开一个探针：这一段**坏了大半都不报错**。卡片会话混进侧栏、收口报了两遍、
 * 提示词里少了那句「你面前没有人」、上游卡的结论没进交底书——每一种的表现都是「卡跑完
 * 了，结论看起来也有」，而错在哪儿要等下游那张卡做出个荒唐结果才被看见。
 *
 * 钉六件事：
 *
 *   1. **卡片会话不是「这个人的对话」**：`c-` 前缀、`kind: 'card'`、不进 sessions.list()
 *   2. **交底书自足**：板的 brief、上游卡的结论和产出路径、留言、上次为什么失败，全在
 *      第一条消息里——做这张卡的 Bot 看不见任何一段对话
 *   3. **工具表减三加三**：没有 history_* / escalate_to_human / memory_write，有卡上那三把
 *   4. **收口是 kanban_complete 那次调用本身**，不是那一轮结束：一调就报，而且只报一次
 *   5. **一句收口的话都没说 = 一次失败**，而且**不把最后那段话当成结论**（那是编）
 *   6. **提示词里有那三条口径**：问不了人、怎么收口、草稿写哪儿
 *
 * 探针要 tsx 才 import 得了 .ts，所以由 e2e/card.mjs 另起一个进程跑。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import * as storagePlugin from './src/storage/index.ts'
import * as sessionsPlugin from './src/session/index.ts'
import * as workspacePlugin from './src/workspace/index.ts'
import * as toolsPlugin from './src/tools/index.ts'
import * as llmPlugin from './src/llm/index.ts'
import * as agentPlugin from './src/agent/index.ts'
import * as kanbanReportPlugin from './src/tools/kanban-report.ts'
import * as kanbanPlugin from './src/tools/kanban.ts'
import { AssistantMessageEventStream, emptyAssistant } from './src/llm/stream.ts'

// 席位钉的那颗 Bot。runCard 拿它开会话——没有它整条路走不通（也是一条用例）。
process.env.SATUWORK_BOT_ID = 'bot-1'

const home = mkdtempSync(join(tmpdir(), 'satu-card-'))
const work = mkdtempSync(join(tmpdir(), 'satu-card-work-'))

/** 假目录：这颗 Bot 在一块板上（不然 toolSchemasFor 会把 kanban_* 整组遮掉）。 */
class FakeCatalog extends Service {
  constructor(ctx) {
    super(ctx, 'catalog')
    this.models = { daily: { provider: 'p-daily', model: 'm-daily' }, utility: { provider: 'p-util', model: 'm-util' } }
    this.boards = [{ id: 'b1', name: '新品上线', brief: '板的交底书', role: '出图' }]
  }
  async pull() {
    return true
  }
  get servers() {
    return []
  }
  toolNamesFor() {
    return []
  }
}

const ctx = new Context()
ctx.plugin(storagePlugin, { path: join(home, 'db.sqlite') })
ctx.plugin(sessionsPlugin, { root: join(home, 'sessions') })
ctx.plugin(workspacePlugin, { root: work })
ctx.plugin(toolsPlugin)
ctx.plugin(FakeCatalog)
ctx.plugin(llmPlugin)
ctx.plugin(kanbanReportPlugin)
ctx.plugin(agentPlugin, { provider: 'p-bot', model: 'm-bot' })
ctx.plugin(kanbanPlugin)
await new Promise((r) => setTimeout(r, 300))

ctx.llm.catalog = () => [
  { provider: 'p-bot', models: [{ id: 'm-bot', contextWindow: 200000 }] },
  { provider: 'p-util', models: [{ id: 'm-util', contextWindow: 32000 }] },
]

/**
 * 换掉上报服务：探针要验的正是「什么时候报、报了什么」，而那本来要打一个真 Gateway。
 * 这也是把它做成服务而不是两个自由函数的理由之一。
 */
const reports = []
ctx.kanban.report = async (cardId, body) => {
  reports.push({ cardId, ...body })
}
ctx.kanban.beat = async () => true

/** 模型这一轮说什么，由用例现设。 */
let script = () => ({ text: '随便说一句' })
const seen = []
ctx.llm.streamFn = (model, context) => {
  seen.push({ system: String(context?.systemPrompt ?? ''), messages: JSON.stringify(context?.messages ?? []), tools: (context?.tools ?? []).map((t) => t.name) })
  const stream = new AssistantMessageEventStream()
  setTimeout(() => {
    const partial = emptyAssistant(model)
    const said = script(seen.length)
    if (said.text) partial.content.push({ type: 'text', text: said.text })
    if (said.tool) {
      // 内部形状是 `toolCall` + `arguments`（`tool_use` 是往 provider 那边发的时候才换的），
      // stopReason 是 `toolUse`。写错任何一样，这一轮会安静地当成「它只是说了句话」。
      partial.content.push({ type: 'toolCall', id: `call-${seen.length}`, name: said.tool, arguments: said.input ?? {} })
      partial.stopReason = 'toolUse'
    } else {
      partial.stopReason = 'stop'
    }
    stream.push({ type: 'done', reason: partial.stopReason, message: partial })
    stream.end()
  }, 5)
  return stream
}

const spec = (over = {}) => ({
  cardId: 'c_probe',
  boardId: 'b1',
  title: '把三家报价整理成对比表',
  body: '三家的链接在留言里',
  brief: '这块板跑的是新品的物料',
  parents: [{ id: 'c_up', title: '收集报价', summary: '三家都拿到了', metadata: { changed_files: ['work/quotes.md'] } }],
  comments: [{ author: '张三', body: '第三家要登录，跳过' }],
  attempt: 0,
  lastFailure: '',
  modelRole: 'daily',
  maxSteps: 5,
  needsBrowser: false,
  deadlineAt: Date.now() + 60_000,
  runId: 'run-1',
  ...over,
})

const out = {}

// ── 1. 模型调 kanban_complete：一调就报，而且只报一次 ──────────────────
script = (n) => (n === 1 ? { tool: 'kanban_complete', input: { summary: '表在 work/table.md', metadata: { changed_files: ['work/table.md'] } } } : { text: '收尾了' })
await ctx.agents.runCard(spec())

const sessions = await ctx.sessions.list({ tasks: true })
const card = sessions.find((s) => s.kind === 'card')
out.会话 = {
  开出来了: !!card,
  前缀是c: !!card && card.id.startsWith('c-'),
  不进列表: !(await ctx.sessions.list()).some((s) => s.id === card?.id),
  标题说得清: card?.title?.startsWith('卡：') ?? false,
}

const first = seen[0]
out.交底书 = {
  带板的brief: first.messages.includes('这块板跑的是新品的物料'),
  带上游结论: first.messages.includes('三家都拿到了'),
  带上游产出路径: first.messages.includes('work/quotes.md'),
  带留言: first.messages.includes('第三家要登录'),
}
out.工具表 = {
  没有history: !first.tools.some((t) => t.startsWith('history_')),
  没有转人工: !first.tools.includes('escalate_to_human'),
  不许写记忆: !first.tools.includes('memory_write'),
  有卡上那三把: ['kanban_show', 'kanban_complete', 'kanban_block'].every((t) => first.tools.includes(t)),
  还能建卡: first.tools.includes('kanban_create'),
}
out.提示词 = {
  说了没人: first.system.includes('你面前没有人'),
  说了怎么收口: first.system.includes('kanban_complete') && first.system.includes('kanban_block'),
  说了草稿写哪: first.system.includes('cards/c_probe/'),
}
out.收口 = {
  报了一次: reports.length === 1,
  // Gateway 靠它认「这是哪一次执行」——不带的话，一条迟到的旧回报能把新那一轮盖掉。
  带回了runId: reports[0]?.runId === 'run-1',

  是做完了: reports[0]?.status === 'ok',
  结论对得上: reports[0]?.summary === '表在 work/table.md',
  带交付证据: JSON.stringify(reports[0]?.metadata ?? {}).includes('work/table.md'),
}

// ── 2. 一句收口的话都没说：算一次失败，且不把那段话当结论 ────────────────
reports.length = 0
seen.length = 0
script = () => ({ text: '我觉得应该差不多了吧' })
await ctx.agents.runCard(spec({ cardId: 'c_silent' }))
out.没交结论 = {
  报了一次: reports.length === 1,
  记成失败: reports[0]?.status === 'error',
  不当成结论: !reports[0]?.summary,
  把它说的话附上了: String(reports[0]?.error ?? '').includes('我觉得应该差不多了吧'),
}

// ── 3. 重试那次：上一次为什么失败要进交底书 ───────────────────────────
reports.length = 0
seen.length = 0
script = (n) => (n === 1 ? { tool: 'kanban_block', input: { reason: '第三家要登录' } } : { text: '停' })
await ctx.agents.runCard(spec({ cardId: 'c_retry', attempt: 1, lastFailure: '上次跑到步数上限' }))
out.重试 = {
  带上次的错: seen[0].messages.includes('上次跑到步数上限'),
  劝它别重演: seen[0].messages.includes('别一字不差地再来一遍'),
  卡住报blocked: reports[0]?.status === 'blocked',
  原因原样带上: reports[0]?.error === '第三家要登录',
}

// ── 4. 主会话里没有卡上那三把 ────────────────────────────────────────
const mainSession = await ctx.sessions.create({ botId: 'bot-1', title: '主会话' })
out.主会话 = {
  没有卡上那三把: !(await (async () => {
    // 走一遍真的发消息路径，看这一轮的工具表里有没有它们。
    seen.length = 0
    script = () => ({ text: '好的' })
    await ctx.agents.send(mainSession, '你好', [], [], undefined)
    return seen[0]?.tools ?? []
  })()).some((t) => ['kanban_show', 'kanban_complete', 'kanban_block'].includes(t)),
}

// ── 5. 「要人拍板」的事往哪儿投：主会话，不是卡片会话自己 ─────────────────
//
// 卡片会话 `kind: 'card'`，侧栏里不列（上面「不进列表」那条验的就是它）——审批卡开在它
// 身上等于开在一间没有门的屋子里：五分钟后按超时收口，而人从头到尾不知道有人问过他。
// 一张要发邮件的卡会在每一次 external+write 上白等五分钟，几次就撞穿 Gateway 那道墙钟。
// 这里钉的是 approvals.ts 依赖的那条线（`cardHomeOf`），不是审批本身。
reports.length = 0
seen.length = 0
script = (n) => (n === 1 ? { tool: 'kanban_complete', input: { summary: '好了' } } : { text: '收尾' })
await ctx.agents.runCard(spec({ cardId: 'c_home' }))
// 卡片会话的 id 从回报里拿：kanban_complete 带的就是 `call.sessionId`。
const cardSession = reports[0]?.sessionId
out.审批投哪儿 = {
  认得出卡片会话: typeof cardSession === 'string' && cardSession.length > 0,
  记下了主会话: ctx.agents.cardHomeOf(cardSession) === mainSession,
  不是卡片会话自己: ctx.agents.cardHomeOf(cardSession) !== cardSession,
}

// ── 6. 收口那一跳没送到：旗子要放回去，结论不能丢 ────────────────────────
//
// 「已收口」是在打 Gateway **之前**占的（收口的判据是这次调用本身，不是 turn/end）。占了
// 之后那一跳要是没成，旗子还落着的话两条路一起堵死：模型重试拿到「已经收过口了」，收尾
// 那条兜底也被同一面旗子关掉——这段结论就此丢了，卡在 Gateway 那边停在 running 直到三分钟
// 后被判「席位失联」，白占一次 attempt 再把整张卡重跑一遍。
reports.length = 0
seen.length = 0
const tried = []
ctx.kanban.report = async (cardId, body) => {
  tried.push({ cardId, ...body })
  // 第一次当成管道故障（连不上 / 超时 / 5xx）：**可重试**，所以旗子该被放回去。
  if (tried.length === 1) throw new kanbanReportPlugin.ReportError('回报卡 c_flaky 没送到：fetch failed', true)
  reports.push({ cardId, ...body })
}
script = (n) => (n <= 2 ? { tool: 'kanban_complete', input: { summary: '这段结论不能丢' } } : { text: '收尾' })
await ctx.agents.runCard(spec({ cardId: 'c_flaky' }))
out.收口没送到 = {
  第一次真的试过: tried.length >= 1 && tried[0]?.summary === '这段结论不能丢',
  模型能再报一次: tried.length >= 2,
  结论没丢: reports.some((r) => r.status === 'ok' && r.summary === '这段结论不能丢'),
  没被记成失败: !reports.some((r) => r.status === 'error'),
}

// `__RESULT__` 前缀是探针和 e2e/probe.mjs 之间的约定：那一行之外的全是噪声（日志、警告）。
console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
