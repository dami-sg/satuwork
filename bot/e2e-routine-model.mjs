/**
 * 日常任务选的那个模型，**真的用在了那一轮上**（见 docs/routines.md §4）。
 *
 * 为什么值得单开一个探针：这一层坏了**不报错**。任务照样跑、对话照样出、流水照样绿，
 * 只是每一次都按贵的那一档计费——而「省 token」正是这个开关唯一的目的。要发现它没生效，
 * 得有人去翻账单，然后把那笔钱和某条定时任务对上。
 *
 * 钉四件事：
 *
 *   1. `modelRole: 'utility'` 那一轮，进模型的是**平台钉的 utility 模型**，不是 Bot 自己的；
 *   2. `daily` 和不给这个值一样——**不覆盖**，跟这颗 Bot 平时那个模型走（管理员给它
 *      单独挑过模型时，那句挑选在定时任务里同样作数）；
 *   3. 平台**没配 utility** 时不是不跑，而是照 Bot 自己的模型跑：省钱是目的，不是前提；
 *   4. **会话装不进钉的那个模型时，这一轮退回 Bot 自己的模型**，而不是拿便宜模型的小
 *      窗口去压这条会话——那条会话是人和定时任务共用的一条，压缩会写进日志，人第二天
 *      回来上下文就没了。这条同时钉住「压缩按 Bot 自己的窗口算」：真按 utility 的窗口
 *      判，这一轮会先跑一次摘要模型，模型调用就不止一次了。
 *
 * 探针要 tsx 才 import 得了 .ts，所以由 e2e/routine-model.mjs 另起一个进程跑。
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

const home = mkdtempSync(join(tmpdir(), 'satu-rtmodel-'))
const work = mkdtempSync(join(tmpdir(), 'satu-rtmodel-work-'))

/**
 * 假目录：只提供两个模型角色。真的 CatalogService 要连 Gateway，而这一层用到的
 * 就只有 `models` 一个字段（agent 取 utility 的地方见 agent/index.ts 的 roleModel）。
 */
class FakeCatalog extends Service {
  constructor(ctx) {
    super(ctx, 'catalog')
    this.models = { daily: { provider: 'p-daily', model: 'm-daily' }, utility: { provider: 'p-util', model: 'm-util' } }
  }
  async pull() {
    return true
  }
  /**
   * 这颗 Bot 在哪几块板上（docs/kanban.md §10.1）。
   *
   * **假目录也要有它**：`toolSchemasFor` 拿它判「看板那几把进不进表」，缺了这一格
   * 整张工具表当场抛错——表现是这个探针里**每一把工具都不见了**，而报出来的是一句
   * 和看板毫不相干的话。
   */
  boards = []

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
// Bot 自己那一对：下面「不覆盖」的几条就是拿它比的。
ctx.plugin(agentPlugin, { provider: 'p-bot', model: 'm-bot' })
await new Promise((r) => setTimeout(r, 300))

/**
 * 两个模型的窗口。真的 llm.catalog() 从 Gateway 的 /v1/models 拉，这里没有 Gateway，
 * 直接摆一份：**utility 的窗口比 Bot 自己的小得多**——便宜的那一档本来就是这样，
 * 而下面第 4 条要验的正是这个落差。
 */
ctx.llm.catalog = () => [
  { provider: 'p-bot', models: [{ id: 'm-bot', contextWindow: 200000 }] },
  { provider: 'p-util', models: [{ id: 'm-util', contextWindow: 4000 }] },
  { provider: 'p-daily', models: [{ id: 'm-daily', contextWindow: 200000 }] },
]

/**
 * 捕获真正送进模型的那几次。这一轮一律以错误收口——探针不跑模型。
 *
 * **记的是每一次，不只是最后一次**：压缩自己也要跑一次模型（summarize），所以
 * 「这一轮打了几次模型」正好是「有没有偷偷压过一次」的探子。
 */
let calls = []
ctx.llm.streamFn = (model) => {
  calls.push({ provider: model.provider, model: model.id })
  const stream = new AssistantMessageEventStream()
  queueMicrotask(() => {
    stream.push({ type: 'error', reason: 'error', error: emptyAssistant(model, '探针不跑模型') })
    stream.end()
  })
  return stream
}

const sessionId = await ctx.sessions.create({ title: '探针', botId: 'default' })

/** 跑一轮，把「这一轮用了哪个模型」带回来。`calls` 里留着这一轮打过的每一次。 */
async function turnWith(modelRole, text = '到点了') {
  calls = []
  await ctx.agents.send(sessionId, text, [], [], { kind: 'user' }, modelRole).catch(() => {})
  return calls[calls.length - 1] ?? null
}

const out = {}

const util = await turnWith('utility')
out.utility = {
  换成了平台那一对: util?.provider === 'p-util' && util?.model === 'm-util',
  用的不是Bot自己的: util?.model !== 'm-bot',
}

const daily = await turnWith('daily')
const none = await turnWith(undefined)
out.notPinned = {
  daily不覆盖: daily?.provider === 'p-bot' && daily?.model === 'm-bot',
  不给也不覆盖: none?.provider === 'p-bot' && none?.model === 'm-bot',
  // 「daily」不等于「平台的日常模型」：Bot 自己那一对才是它的意思。
  daily不是平台日常: daily?.model !== 'm-daily',
}

// 平台没钉 utility：照旧按 Bot 自己的跑，不是不跑。
ctx.catalog.models = { daily: { provider: '', model: '' }, utility: { provider: '', model: '' } }
const empty = await turnWith('utility')
out.noRole = { 照旧跑得起来: Boolean(empty), 用的是Bot自己的: empty?.provider === 'p-bot' && empty?.model === 'm-bot' }
ctx.catalog.models = { daily: { provider: 'p-daily', model: 'm-daily' }, utility: { provider: 'p-util', model: 'm-util' } }

/**
 * 把会话撑到**比 utility 的窗口大、比 Bot 自己的窗口小**：4 万个 ASCII 字符 ≈ 1.1 万
 * token（estTokens 是 length / 3.6），而两个窗口分别是 4000 和 200000。
 *
 * 这一句自己按 Bot 的模型跑（不钉），落进历史；下一句才是要验的那一轮。
 */
await turnWith(undefined, 'x'.repeat(40000))
const tooBig = await turnWith('utility')
out.tooBig = {
  这一轮退回Bot自己的: tooBig?.provider === 'p-bot' && tooBig?.model === 'm-bot',
  // 压缩按 Bot 自己的窗口算 → 11k < 180k，压根不该压。压了的话这里会有两次调用：
  // 先是 summarize，然后才是这一轮。
  没有偷偷压一次: calls.length === 1,
}
// 这里**不**去数 session/compact 事件：探针的模型一律以错误收口，summarize 拿不到
// 摘要，压缩会停在 no-summary 上、什么都不写——那条断言永远绿，红不起来的断言比没有
// 更糟。真按 utility 的窗口判过，上面那次模型调用是躲不掉的。

console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
