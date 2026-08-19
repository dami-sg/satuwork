/**
 * historySlice 的语义。纯函数，不起服务——探针要 tsx 才 import 得了 .ts。
 */
import { historySlice } from './src/session/replay.ts'

let seq = 0
const ev = (type, data) => ({ seq: ++seq, time: 1, type, data })
const msg = (text) => ({ content: text ? [{ type: 'text', text }] : [] })

/** 造 n 轮完整对话，每轮：提问 → turn/start → 5 个 chunk → 最终消息 → turn/end。 */
function conversation(n) {
  seq = 0
  const out = [ev('session', { version: 2, id: 's', createdAt: 1, botId: 'b' })]
  for (let turn = 1; turn <= n; turn++) {
    out.push(ev('user/message', { message: msg('问题' + turn), source: { kind: 'user' } }))
    out.push(ev('turn/start', { turn }))
    for (let i = 0; i < 5; i++) out.push(ev('assistant/chunk', { turn, step: 0, chunk: { type: 'text-delta', text: 'x' } }))
    out.push(ev('assistant/message', { turn, step: 0, message: msg('回答' + turn) }))
    out.push(ev('turn/end', { turn, reason: 'completed' }))
  }
  return out
}

const out = {}

// 1. 作废的 chunk 要丢掉
{
  const all = conversation(3)
  const r = historySlice(all, { turns: 0 })
  out.dropChunks = {
    原始: all.length,
    剩下: r.events.length,
    还有chunk: r.events.some((e) => e.type === 'assistant/chunk'),
    正文条数: r.events.filter((e) => e.type === 'assistant/message').length,
  }
}

// 2. 正在跑的那一步，chunk 要留着（还没有最终正文盖它）
{
  const all = conversation(1)
  all.push(ev('user/message', { message: msg('问题2'), source: { kind: 'user' } }))
  all.push(ev('turn/start', { turn: 2 }))
  all.push(ev('assistant/chunk', { turn: 2, step: 0, chunk: { type: 'text-delta', text: '正在' } }))
  const r = historySlice(all, { turns: 0 })
  out.keepLive = { 留下的chunk: r.events.filter((e) => e.type === 'assistant/chunk').length }
}

// 3. 最终消息是空的，盖不住，chunk 得留
{
  const all = conversation(0)
  all.push(ev('turn/start', { turn: 1 }))
  all.push(ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', text: 'a' } }))
  all.push(ev('assistant/message', { turn: 1, step: 0, message: msg('') }))
  const r = historySlice(all, { turns: 0 })
  out.emptyFinal = { 留下的chunk: r.events.filter((e) => e.type === 'assistant/chunk').length }
}

// 4. 只取最近 N 轮，且提问要跟着回答走
{
  const all = conversation(10)
  const r = historySlice(all, { turns: 3 })
  out.tail = {
    轮数: r.events.filter((e) => e.type === 'turn/start').length,
    第一条: r.events[0]?.type,
    还有更早的: r.hasMore,
    firstSeq: r.firstSeq,
  }
}

// 5. 往前翻一页：接着上一页的 firstSeq 往前
{
  const all = conversation(10)
  const page1 = historySlice(all, { turns: 3 })
  const page2 = historySlice(all, { turns: 3, before: page1.firstSeq })
  const seqs1 = page1.events.map((e) => e.seq)
  const seqs2 = page2.events.map((e) => e.seq)
  out.paging = {
    第二页轮数: page2.events.filter((e) => e.type === 'turn/start').length,
    不重叠: Math.max(...seqs2) < Math.min(...seqs1),
    还有更早的: page2.hasMore,
  }
}

// 6. 翻到头：hasMore 该是 false
{
  const all = conversation(2)
  const r = historySlice(all, { turns: 5 })
  out.exhausted = { hasMore: r.hasMore, 轮数: r.events.filter((e) => e.type === 'turn/start').length }
}

console.log('__RESULT__' + JSON.stringify(out))
