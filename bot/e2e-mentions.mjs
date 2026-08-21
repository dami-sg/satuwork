/**
 * `@` 点名与排队。探针，结果打在 `__RESULT__` 那一行上（见 e2e/mentions.mjs）。
 *
 * 验四件事：
 *
 *   1. 点名落进 JSONL 是**结构**（`mention` 块），进模型是**一句话**（`[本轮指定：…]`）；
 *   2. `mentionOnly` 的连接平时不在工具表里，被点名那一轮才在；
 *   3. 点名不是过滤：别的工具一个都没少，被点的排最前；
 *   4. 上一轮还在跑时，带 `@` 的消息**排队**而不是插话，跑完自动接上，也能取消。
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
import { AssistantMessageEventStream, emptyAssistant } from './src/llm/stream.ts'
import { viaMentionOf } from './src/catalog/index.ts'
import { SESSION_FORMAT_VERSION } from './src/session/types.ts'

const home = mkdtempSync(join(tmpdir(), 'satu-mention-'))
const work = mkdtempSync(join(tmpdir(), 'satu-mention-work-'))

/**
 * 假目录：两台「服务器」，personal 那台是「仅 @ 时可用」。
 *
 * 真的 CatalogService 要连 Gateway，这里只用到 servers / toolNamesFor 两处。
 */
class FakeCatalog extends Service {
  constructor(ctx) {
    super(ctx, 'catalog')
    this.tools = {
      'conn-default': ['mcp_gmail_default_send_email'],
      'conn-personal': ['mcp_gmail_person_send_email'],
      'srv-notion': ['mcp_notion_create_page'],
    }
    this.mentionOnlyIds = new Set(['conn-personal'])
    /** 重拉了几次。点名却没工具时 agent 会补拉一次目录（见 agent/index.ts）。 */
    this.pulls = 0
    /** 这一把「重拉之后才出现」——刚在浏览器里授权完、席位还没同步到的那个时序。 */
    this.appearOnPull = ''
  }
  /** 真的 CatalogService 会去打 Gateway；这里只记一笔，顺便把「迟到的那把」放出来。 */
  async pull() {
    this.pulls += 1
    const late = this.appearOnPull
    if (!late) return true
    this.appearOnPull = ''
    const name = `mcp_${late.replace(/-/g, '_')}_send_email`
    this.tools[late] = [name]
    this.ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {} }, execute: async () => ({ text: 'ok' }) })
    return true
  }
  get servers() {
    return Object.keys(this.tools).map((id) => ({ id, name: id, kind: 'HTTP', enabled: true, connected: true, tools: this.tools[id] }))
  }
  toolNamesFor(ids, mentioned = []) {
    const allow = new Set(ids)
    const named = new Set(mentioned)
    const out = []
    for (const [id, names] of Object.entries(this.tools)) {
      if (!allow.has(id)) continue
      if (this.mentionOnlyIds.has(id) && !named.has(id)) continue
      out.push(...names)
    }
    return out
  }
}

const ctx = new Context()
ctx.plugin(storagePlugin, { path: join(home, 'db.sqlite') })
ctx.plugin(sessionsPlugin, { root: join(home, 'sessions') })
ctx.plugin(workspacePlugin, { root: work })
ctx.plugin(toolsPlugin)
ctx.plugin(FakeCatalog)
ctx.plugin(llmPlugin)
ctx.plugin(agentPlugin)
await new Promise((r) => setTimeout(r, 300))

// 三个工具都注册上，好让 toolSchemasFor 有东西可挑。
for (const name of ['mcp_gmail_default_send_email', 'mcp_gmail_person_send_email', 'mcp_notion_create_page']) {
  ctx.tools.register({ name, description: name, parameters: { type: 'object', properties: {} }, execute: async () => ({ text: 'ok' }) })
}

/** 捕获真正送进模型的那一份，并控制这一轮什么时候结束。 */
let captured = null
let hold = null
ctx.llm.streamFn = (model, context) => {
  captured = context
  const stream = new AssistantMessageEventStream()
  const finish = () => {
    stream.push({ type: 'error', reason: 'error', error: emptyAssistant(model, '探针不跑模型') })
    stream.end()
  }
  if (hold) hold.then(finish)
  else queueMicrotask(finish)
  return stream
}

const out = {}
const sessionId = await ctx.sessions.create({ title: '探针', botId: 'default' })
const toolNames = () => (captured?.tools ?? []).map((t) => t.name)
const lastUser = () => {
  const users = (captured?.messages ?? []).filter((m) => m.role === 'user')
  const last = users[users.length - 1]
  if (!last) return []
  return typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : (last.content ?? [])
}

// ── 1. 不点名：mentionOnly 的那台不在工具表里 ─────────────────────────
captured = null
await ctx.agents.send(sessionId, '看看我的邮件').catch(() => {})
out.plain = {
  有默认那把: toolNames().includes('mcp_gmail_default_send_email'),
  没有仅点名那把: !toolNames().includes('mcp_gmail_person_send_email'),
  有别的工具: toolNames().includes('mcp_notion_create_page'),
}

// ── 2. 点名：那把进来了，别的一个没少，而且排在最前 ───────────────────
captured = null
await ctx.agents
  .send(sessionId, '查看最新邮件', [], [{ kind: 'connector', id: 'conn-personal', label: 'Gmail (personal)' }])
  .catch(() => {})
{
  const names = toolNames()
  const blocks = lastUser()
  out.mentioned = {
    仅点名那把进来了: names.includes('mcp_gmail_person_send_email'),
    别的工具没被拿掉: names.includes('mcp_notion_create_page') && names.includes('mcp_gmail_default_send_email'),
    被点的排最前: names[0] === 'mcp_gmail_person_send_email',
    进模型的是一句话: blocks.some((c) => c.type === 'text' && c.text.includes('[本轮指定：Gmail (personal)]')),
    正文还在: blocks.some((c) => c.type === 'text' && c.text.includes('查看最新邮件')),
  }
}

// ── 3. 落盘是结构，不是那句话 ─────────────────────────────────────────
{
  const events = await ctx.sessions.events(sessionId)
  const users = events.filter((e) => e.type === 'user/message')
  const blocks = users[users.length - 1].data.message.content
  const root = events.find((e) => e.type === 'session')
  out.jsonl = {
    '有 mention 块': blocks.some((c) => c.type === 'mention' && c.id === 'conn-personal'),
    '块里带 label': blocks.some((c) => c.type === 'mention' && c.label === 'Gmail (personal)'),
    正文另存一块: blocks.some((c) => c.type === 'text' && c.text === '查看最新邮件'),
    没把那句话写进正文: !blocks.some((c) => c.type === 'text' && c.text.includes('[本轮指定')),
    版本号: root.data.version,
    当前版本: SESSION_FORMAT_VERSION,
  }
}

// ── 4. 上一轮还在跑：带 @ 的排队，不插话 ──────────────────────────────
{
  let release
  hold = new Promise((r) => (release = r))
  const running = ctx.agents.send(sessionId, '这一轮会卡住').catch(() => {})
  // 等它真的开跑（streamFn 已经被调到）。
  for (let i = 0; i < 50 && !ctx.agents.isRunning(sessionId); i++) await new Promise((r) => setTimeout(r, 20))
  out.queue = { 在跑: ctx.agents.isRunning(sessionId) }

  const row = ctx.agents.enqueue(sessionId, '排队的这句', [], [{ kind: 'connector', id: 'conn-personal', label: 'Gmail (personal)' }])
  out.queue.排进去了 = ctx.agents.queued(sessionId).length === 1
  out.queue.取消不存在的会说没这条 = ctx.agents.cancelQueued(sessionId, 'no-such-id') === 'missing'

  const second = ctx.agents.enqueue(sessionId, '第二条', [], [])
  out.queue.能排两条 = ctx.agents.queued(sessionId).length === 2
  out.queue.取消得掉 = ctx.agents.cancelQueued(sessionId, second.id) === 'cancelled'
  out.queue.取消之后剩一条 = ctx.agents.queued(sessionId).length === 1
  out.queue.先进的排在前 = ctx.agents.queued(sessionId)[0].id === row.id

  captured = null
  release()
  await running
  // 队列在上一轮收口之后自己接上，给它一点时间跑完。
  for (let i = 0; i < 100 && ctx.agents.queued(sessionId).length; i++) await new Promise((r) => setTimeout(r, 20))
  await new Promise((r) => setTimeout(r, 200))
  out.queue.队列清空了 = ctx.agents.queued(sessionId).length === 0
  const blocks = lastUser()
  out.queue.排队那条真的跑了 = blocks.some((c) => c.type === 'text' && c.text.includes('排队的这句'))
  out.queue.排队那条带着点名 = toolNames().includes('mcp_gmail_person_send_email')
}

// ── 5. 出队之后、agent 建出来之前，isRunning 必须一直是 true ─────────
//
// runTurn 走到 live.set 之前有好几个 await（读日志、重建历史、两次 append）。那期间
// 要是 isRunning() 返回 false，同一条会话就会被开出第二轮并发 agent——事件交错写进
// 同一份 JSONL，用量也记两遍。这里把 sessions.events 卡住，正好停在那个窗口上。
{
  const origEvents = ctx.sessions.events.bind(ctx.sessions)
  let gate = null
  ctx.sessions.events = async (...args) => {
    if (gate) await gate
    return origEvents(...args)
  }

  let release
  hold = new Promise((r) => (release = r))
  const running = ctx.agents.send(sessionId, '卡住这一轮').catch(() => {})
  for (let i = 0; i < 50 && !ctx.agents.isRunning(sessionId); i++) await new Promise((r) => setTimeout(r, 20))

  ctx.agents.enqueue(sessionId, '接在后面的那条', [], [])
  let openGate
  gate = new Promise((r) => (openGate = r))
  hold = null
  release()
  /**
   * **不能在这里 await running**：send() 的最后一步是 drainQueue，而队列里那条正卡在
   * gate 上，这个 promise 要等到闸放开才会落地。
   *
   * 等的是「队列已经出队」——那一刻 runTurn 正停在 sessions.events 上，也就是 agent
   * 还没建出来的那个窗口，正是要检查的地方。
   */
  for (let i = 0; i < 100 && ctx.agents.queued(sessionId).length; i++) await new Promise((r) => setTimeout(r, 10))
  await new Promise((r) => setTimeout(r, 50))
  out.window = { 出队之后仍然算在跑: ctx.agents.isRunning(sessionId) }
  openGate()
  gate = null
  await running
  ctx.sessions.events = origEvents
}

// ── 6. 队列里一条跑失败，后面的照跑 ──────────────────────────────────
{
  const failId = await ctx.sessions.create({ title: '失败探针', botId: 'default' })
  let release
  hold = new Promise((r) => (release = r))
  const running = ctx.agents.send(failId, '卡住').catch(() => {})
  for (let i = 0; i < 50 && !ctx.agents.isRunning(failId); i++) await new Promise((r) => setTimeout(r, 20))

  // 第一条排队的必然失败：图片路径不存在，toAgentMessages 会抛。
  ctx.agents.enqueue(failId, '这条会失败', [{ path: 'nope/missing.png', mime: 'image/png' }], [])
  ctx.agents.enqueue(failId, '这条应该照跑', [], [])
  hold = null
  release()
  await running
  for (let i = 0; i < 150 && ctx.agents.queued(failId).length; i++) await new Promise((r) => setTimeout(r, 20))
  await new Promise((r) => setTimeout(r, 300))
  const events = await ctx.sessions.events(failId)
  const texts = JSON.stringify(events)
  out.keepGoing = {
    队列清空了: ctx.agents.queued(failId).length === 0,
    失败那条不挡后面的: texts.includes('这条应该照跑'),
  }
}

// ── 7. 取消要分得清「没这条」和「已经开跑」 ──────────────────────────
{
  const cancelId = await ctx.sessions.create({ title: '取消探针', botId: 'default' })
  let release
  hold = new Promise((r) => (release = r))
  const running = ctx.agents.send(cancelId, '卡住').catch(() => {})
  for (let i = 0; i < 50 && !ctx.agents.isRunning(cancelId); i++) await new Promise((r) => setTimeout(r, 20))
  const row = ctx.agents.enqueue(cancelId, '要被取消的', [], [])
  out.cancelKinds = {
    没这条: ctx.agents.cancelQueued(cancelId, 'never-existed') === 'missing',
    取消成功: ctx.agents.cancelQueued(cancelId, row.id) === 'cancelled',
    取消过的再取消还是没这条: ctx.agents.cancelQueued(cancelId, row.id) === 'missing',
  }
  const started = ctx.agents.enqueue(cancelId, '会被跑掉的', [], [])
  hold = null
  release()
  await running
  for (let i = 0; i < 100 && ctx.agents.queued(cancelId).length; i++) await new Promise((r) => setTimeout(r, 20))
  await new Promise((r) => setTimeout(r, 200))
  // 已经出队开跑的那条：不能报「没这条」，那会让用户以为自己拦住了。
  out.cancelKinds.已经开跑 = ctx.agents.cancelQueued(cancelId, started.id) === 'started'
}

// ── 8. 队列不进 JSONL：取消掉的那条一个字都不留 ───────────────────────
{
  const events = await ctx.sessions.events(sessionId)
  const all = JSON.stringify(events)
  out.cancelled = { 取消的那条没进日志: !all.includes('第二条') }
}

// ── 9. 点名了却没工具：先补拉一次目录，还是没有就把实情说给模型听 ────
{
  const say = async (id, label) => {
    captured = null
    await ctx.agents.send(sessionId, '查看邮件', [], [{ kind: 'connector', id, label }]).catch(() => {})
    return { tools: toolNames(), system: captured?.systemPrompt ?? '' }
  }

  // 9a. 刚授权完、席位还没同步：补拉一次就该有了，也就不用跟模型解释什么。
  ctx.catalog.appearOnPull = 'conn-late'
  const before = ctx.catalog.pulls
  const late = await say('conn-late', 'Gmail (late)')
  out.late = {
    补拉了一次: ctx.catalog.pulls === before + 1,
    工具补回来了: late.tools.includes('mcp_conn_late_send_email'),
    不用再跟模型解释: !late.system.includes('本轮被点名、但没挂上的连接'),
  }

  // 9b. 补拉了还是没有：**必须说出来**。不说的话模型会自己编一个替代方案——
  // 线上真发生过，它开始教用户用虚拟桌面里的 Chrome 登邮箱。
  const at = ctx.catalog.pulls
  const ghost = await say('conn-ghost', 'Gmail (ghost)')
  out.gap = {
    也补拉了一次: ctx.catalog.pulls === at + 1,
    跟模型说清楚了: ghost.system.includes('本轮被点名、但没挂上的连接'),
    点了名的那把写出来了: ghost.system.includes('Gmail (ghost)'),
    这一轮照样跑: ghost.tools.includes('mcp_notion_create_page'),
  }
}

// ── 10. 「这一次是不是点名调的」这个标记，绝不许把工具调用弄失败 ─────
//
// 线上就是这么坏的：目录插件不能 inject agents（会绕出依赖环），原来写成
// `ctx.agents?.mentionedIn?.()`，以为 `?.` 能兜住——可 cordis 的守卫是在**取属性那一刻**
// 抛的，`?.` 挡的是取到之后的 null。于是 Gmail 的每一次调用都返回一句
// `cannot get property "agents" without inject`，一个流水上的附加标记把整把工具打死了。
{
  const poisoned = { get agents() { throw new Error('cannot get property "agents" without inject') } }
  const viaThrows = { reflect: { get() { throw new Error('炸') } } }
  const viaOk = { reflect: { get: (n) => (n === 'agents' ? { mentionedIn: () => new Set(['srv-1']) } : undefined) } }
  const noReflect = {}
  // 抛出来也要接住：不接的话探针自己先死了，报出来的是「读不到 viaMention」，
  // 而真正的失败（它抛了）反倒看不见。
  const call = (c, sid, srv) => {
    try {
      return viaMentionOf(c, sid, srv)
    } catch (e) {
      return 'THROW: ' + e.message
    }
  }
  out.viaMention = {
    取不到就当没点名: call(poisoned, 's1', 'srv-1') === false,
    reflect自己炸了也不许抛: call(viaThrows, 's1', 'srv-1') === false,
    没有reflect也不许抛: call(noReflect, 's1', 'srv-1') === false,
    点了名的照样认得出: call(viaOk, 's1', 'srv-1') === true,
    没点那台不算: call(viaOk, 's1', 'srv-2') === false,
  }
}

hold = null
console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
