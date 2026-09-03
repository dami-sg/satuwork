/**
 * 超大工具结果的上下文预算探针。纯函数，不起服务。
 *
 * 覆盖三条最容易回归的路径：Gmail 列表不能夹带正文、完整原文必须仍可审计、升级前的
 * 老日志没有 modelText 也必须在回放时即时瘦身。
 */
import assert from 'node:assert/strict'
import { budgetToolText, MODEL_TOOL_RESULT_MAX_CHARS } from './src/tools/result-budget.ts'
import { observedPromptHighWater, toAgentMessages } from './src/agent/index.ts'
import { historySlice } from './src/session/replay.ts'

const hugeBody = '邮件正文。'.repeat(12_000)
const hugePayload = 'QUJD'.repeat(30_000)
const listRaw = JSON.stringify({
  messages: Array.from({ length: 20 }, (_, i) => ({
    messageId: `m-${i}`,
    threadId: `t-${i}`,
    sender: `sender-${i}@example.com`,
    subject: `subject ${i}`,
    messageText: hugeBody,
    payload: { body: { data: hugePayload } },
  })),
  nextPageToken: 'next',
})

const list = budgetToolText('mcp_gmail_default_fetch_emails', listRaw)
assert.equal(list.rawText, listRaw)
assert.ok(list.text.length < 30_000, `邮件列表瘦身后仍有 ${list.text.length} 字符`)
assert.ok(!list.text.includes('"payload":'))
assert.ok(list.text.includes('messageId'))
assert.ok(list.text.includes('fetch_message_by_message_id'))

const singleRaw = JSON.stringify({
  messageId: 'm-one',
  sender: 'sender@example.com',
  subject: 'one',
  messageText: '完整可读正文'.repeat(3_000),
  payload: { body: { data: hugePayload } },
})
const single = budgetToolText('mcp_gmail_default_fetch_message_by_message_id', singleRaw)
assert.equal(single.rawText, singleRaw)
assert.ok(single.text.includes('完整可读正文'))
assert.ok(!single.text.includes(hugePayload.slice(0, 100)))
assert.ok(single.text.length <= MODEL_TOOL_RESULT_MAX_CHARS)

const genericRaw = JSON.stringify({ rows: Array.from({ length: 100 }, (_, i) => ({ i, text: 'x'.repeat(20_000) })) })
const generic = budgetToolText('mcp_unknown_big_list', genericRaw)
assert.equal(generic.rawText, genericRaw)
assert.ok(generic.text.length <= MODEL_TOOL_RESULT_MAX_CHARS)

const small = budgetToolText('read_file', 'hello')
assert.deepEqual(small, { text: 'hello' })

let seq = 0
const at = Date.parse('2026-09-02T12:00:00Z')
const event = (type, data) => ({ seq: ++seq, time: at + seq, type, data })
const usage = (inputTokens, cacheReadTokens) => ({
  inputTokens,
  outputTokens: 1,
  cacheReadTokens,
  reasoningTokens: 0,
})
const oldEvents = [
  event('session', { version: 5, id: 's', createdAt: at, botId: 'b', origin: 'local' }),
  event('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'a',
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          callId: 'c',
          name: 'mcp_gmail_default_fetch_emails',
          arguments: '{}',
        },
      ],
    },
    usage: usage(263, 664_960),
  }),
  event('tool/result', { turn: 1, step: 1, callId: 'c', text: listRaw, failed: false }),
]
const replay = await toAgentMessages(oldEvents)
const replayText = replay.find((message) => message.role === 'toolResult').content[0].text
assert.ok(replayText.length < 30_000)
assert.equal(oldEvents[2].data.text, listRaw, '回放不能改写审计原文')
assert.equal(observedPromptHighWater(oldEvents), 665_223)
const publicHistory = historySlice(oldEvents).events
const publicTool = publicHistory.find((item) => item.type === 'tool/result')
assert.ok(publicTool.data.text.length < 30_000)
assert.equal(oldEvents[2].data.text, listRaw, '对外历史瘦身不能改写服务端日志')

// 边界之前的 66 万高水位不能污染压缩后的新上下文；边界后的新 usage 才算。
oldEvents.push(
  event('turn/end', { turn: 1, reason: 'completed' }),
  event('session/compact', {
    throughSeq: seq,
    from: at,
    to: at + seq,
    summary: 'summary',
    by: 'auto',
    tokensBefore: 665_223,
    tokensAfter: 100,
  }),
)
assert.equal(observedPromptHighWater(oldEvents), 0)
oldEvents.push(
  event('assistant/message', {
    turn: 2,
    step: 1,
    message: { id: 'b', role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    usage: usage(100, 2_000),
  }),
)
assert.equal(observedPromptHighWater(oldEvents), 2_100)

console.log(
  JSON.stringify({
    ok: true,
    rawListChars: listRaw.length,
    modelListChars: list.text.length,
    rawSingleChars: singleRaw.length,
    modelSingleChars: single.text.length,
    genericModelChars: generic.text.length,
    oldReplayChars: replayText.length,
  }),
)
