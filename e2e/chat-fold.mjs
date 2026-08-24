/**
 * gateway/ui/chat.js 里两组纯函数：把事件折成气泡（fold），以及认斜杠命令
 * （parseCommand / commandQueryAt）。
 *
 * 不起服务、不开浏览器——照 markdown.mjs 那条路，装一层最小垫片在 node 里跑。
 * chat.js 顶层只有两处 `window.addEventListener` 和一堆声明，垫住就能加载。
 *
 * 钉的是两件在真浏览器里**很难复现、复现了也看不出为什么**的事：
 *
 *   1. 上下文边界事件落在一个正在跑的轮次中间（轮末那次自动压缩是 `void`，不 await，
 *      还要跑一次摘要模型调用）。fold 这时要是把 `tools` 换成新数组，该轮后到的
 *      tool/result 就认不回它的药丸——界面上留一颗永远停在「调用中」的药丸。
 *   2. `/etc/hosts` 这种整条就是一个路径的消息，不能被当成「没有这条命令」拦下来。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createContext, runInContext } from 'node:vm'

/** 让 chat.js 在 node 里加载起来的最小垫片。这两组函数一个 DOM API 都不碰。 */
function loadChat(root) {
  const noNode = { style: {}, setAttribute() {}, appendChild() {}, querySelector: () => null, querySelectorAll: () => [] }
  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    Map,
    Set,
    URL,
    Blob: function Blob() {},
    AbortController: function AbortController() {},
    // chat.js 从别的分片拿的那几个：只留这两组函数真正会走到的。
    state: { chatEvents: [], chatSessionId: 's1', chatPending: [], catalog: [], runtimeBots: [], me: {} },
    t: (s) => s,
    esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    svg: () => '',
    api: async () => ({}),
    flash() {},
    render() {},
    initialOf: () => 'X',
    chatBotIdOf: () => 'b',
    fmtTime: (n) => new Date(n).toISOString(),
    document: { getElementById: () => null, addEventListener() {}, createElement: () => noNode },
    // 顶层挂的那几个监听（resize、keydown）：收下就扔。
    addEventListener() {},
    removeEventListener() {},
  }
  ctx.window = ctx
  ctx.globalThis = ctx
  createContext(ctx)
  runInContext(readFileSync(join(root, 'gateway/ui/chat.js'), 'utf8'), ctx, { filename: 'chat.js' })
  return ctx
}

const T = Date.parse('2026-08-24T02:00:00Z')
const ev = (seq, type, data) => ({ seq, time: T + seq * 1000, type, data })
const um = (s) => ({ id: 'u' + s, role: 'user', content: [{ type: 'text', text: s }] })
const am = (s) => ({ id: 'a' + s, role: 'assistant', content: [{ type: 'text', text: s }] })
const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }
const COMPACT = { from: T, to: T + 6000, summary: 's', droppedMessages: 2, tokensBefore: 90500, tokensAfter: 3200 }

/** 一轮完整的问答，第 2 轮带一次工具调用。 */
function twoTurns() {
  return [
    ev(1, 'session', { version: 5, id: 's1', botId: 'b', createdAt: T }),
    ev(2, 'user/message', { message: um('问一'), source: { kind: 'user' } }),
    ev(3, 'turn/start', { turn: 1 }),
    ev(4, 'assistant/message', { turn: 1, step: 1, message: am('答一'), usage }),
    ev(5, 'turn/end', { turn: 1, reason: 'completed' }),
  ]
}

export async function runChatFold({ root, test, assert, log }) {
  const { fold, threadRows, parseCommand, commandQueryAt, ctxDivText, state } = loadChat(root)
  log('\n# chat-fold')

  await test('压缩事件落在轮次中间：工具结果照样认得回它的药丸', async () => {
    /**
     * 时序取自线上会发生的那一种：轮 1 结束 → 轮末 `void maybeCompact` 开跑 → 人立刻
     * 发了下一句 → 轮 2 开跑并调了工具 → 摘要写完，session/compact 落在 tool/call 和
     * tool/result **之间**。
     */
    const events = twoTurns().concat([
      ev(6, 'user/message', { message: um('问二'), source: { kind: 'user' } }),
      ev(7, 'turn/start', { turn: 2 }),
      ev(8, 'tool/call', { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
      ev(9, 'session/compact', { throughSeq: 5, ...COMPACT }),
      ev(10, 'tool/result', { turn: 2, step: 1, callId: 'c1', text: '跑完了', failed: false }),
      ev(11, 'assistant/message', { turn: 2, step: 1, message: am('答二'), usage }),
      ev(12, 'turn/end', { turn: 2, reason: 'completed' }),
    ])
    const blocks = fold(events).blocks
    const pills = blocks.flatMap((b) => b.tools || [])
    assert(pills.length === 1, `应有一颗工具药丸，实际 ${pills.length}`)
    // 这一条挂了 = 界面上留一颗永远停在「调用中」的药丸，刷新也回不来。
    assert(pills[0].result === '跑完了', `工具结果没认回药丸：${JSON.stringify(pills[0])}`)
    assert(pills[0].failed === false, '一次成功的调用被标成了失败')
    // 这一轮的工具药丸和这一轮的回答必须还在同一个气泡里——断开的话，边界之后到的
    // 正文会另起一块，屏幕上就是一个空的「正在想」气泡加一段无主的回答。
    const owner = blocks.find((b) => (b.tools || []).some((x) => x.callId === 'c1'))
    assert(owner && owner.text === '答二', `工具药丸和它那一轮的回答被劈到了两个气泡里：${JSON.stringify(owner?.text)}`)
  })

  await test('两轮之间的边界：自己成块，下一轮另起气泡', async () => {
    const events = twoTurns().concat([
      ev(6, 'session/compact', { throughSeq: 5, ...COMPACT }),
      ev(7, 'user/message', { message: um('问二'), source: { kind: 'user' } }),
      ev(8, 'turn/start', { turn: 2 }),
      ev(9, 'assistant/message', { turn: 2, step: 1, message: am('答二'), usage }),
      ev(10, 'turn/end', { turn: 2, reason: 'completed' }),
    ])
    const kinds = fold(events).blocks.map((b) => (b.kind === 'mark' ? 'mark:' + b.mark : b.kind))
    assert(
      JSON.stringify(kinds) === JSON.stringify(['user', 'assistant', 'mark:compact', 'user', 'assistant']),
      `块的顺序不对：${JSON.stringify(kinds)}`,
    )
  })

  await test('分割线走 html 行，不套气泡的壳', async () => {
    const events = twoTurns().concat([ev(6, 'session/reset', { throughSeq: 5, from: T, to: T + 5000, droppedMessages: 2, by: 'user' })])
    state.chatEvents = events
    const row = threadRows(fold(events), 's1').find((r) => r.kind === 'mark')
    assert(row, '没有画出分割线那一行')
    assert(row.html && !('block' in row), '分割线该是 html 行，套 rowShell 会画出一个空壳')
    assert(row.key === 'k6', `key 要跟着事件的 seq 走，实际 ${row.key}`)
  })

  await test('分割线的字：重置说清楚记录还在，自动压缩和手动压缩分得开', async () => {
    const reset = ctxDivText({ kind: 'mark', mark: 'reset', by: 'user' })
    // 「已清空」会让人以为历史没了，而 JSONL 一条没删。
    assert(reset.includes('不再进上下文'), `重置那条话没说清：${reset}`)
    const auto = ctxDivText({ kind: 'mark', mark: 'compact', by: 'auto', tokensBefore: 90500, tokensAfter: 3200 })
    const manual = ctxDivText({ kind: 'mark', mark: 'compact', by: 'user', tokensBefore: 90500, tokensAfter: 3200 })
    assert(auto !== manual, '自动压缩和人点的压缩画出了同一句话')
    assert(auto.includes('自动'), `自动那条该说明是它自己压的：${auto}`)
    assert(manual.includes('90.5k → 3.2k'), `压缩前后的数字没画出来：${manual}`)
    // 老日志没有 tokens 字段——那就不摆一个假的 0 → 0。
    assert(!ctxDivText({ kind: 'mark', mark: 'compact', by: 'auto' }).includes('0'), '老日志缺字段时编了个数字出来')
  })

  await test('认命令：typo 和参数都拦下，路径放行', async () => {
    assert(parseCommand('/compact')?.cmd?.name === 'compact', '/compact 没认出来')
    assert(parseCommand('  /NEW  ')?.cmd?.name === 'new', '大小写和空白该宽容')
    assert(parseCommand('/copmact')?.unknown === '/copmact', 'typo 该被拦下')
    // 拦不住的话，一个手滑的 typo 就发给模型了，它会礼貌地回一段「你是想…吗」，
    // 而人以为自己压缩过了。
    const withArgs = parseCommand('/compact 只留三轮')
    assert(withArgs?.cmd?.name === 'compact' && withArgs.extra, `带参数该单独认出来：${JSON.stringify(withArgs)}`)
    // 整条就是一个路径：命令名里不会有第二个斜杠，这条必须照常当消息发出去。
    assert(parseCommand('/etc/hosts') === null, '/etc/hosts 被当成命令拦下了')
    assert(parseCommand('看下 /compact 是什么') === null, '正文里提到命令不该被拦')
    assert(parseCommand('你好') === null, '普通消息被当成命令了')
  })

  await test('选单只在输入框最开头弹', async () => {
    const q = (v) => commandQueryAt({ value: v, selectionStart: v.length })
    assert(q('/co')?.q === 'co', '开头打 /co 该弹选单')
    assert(q('/')?.q === '', '刚打一个斜杠就该弹')
    assert(q('看下 /compact') === null, '正文中间的斜杠不该弹选单')
    assert(q('/etc/hosts') === null, '路径不该弹选单')
  })
}
