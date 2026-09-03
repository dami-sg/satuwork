/**
 * 从日志重建给模型的历史时，**时间必须跟着一起回去**。
 *
 * 这一层坏了不报错、不丢消息，只会让模型对「昨天」一无所知——线上就出过：
 * 一条从 8/18 晚上写到 8/19 中午的长会话，问它「我昨天发给你的消息总结一下」，
 * 它答「本次对话是今天开始的」。历史确实进了上下文，但每条都盖着重建那一刻的
 * 时间戳，看上去全是刚刚说的。
 *
 * 纯函数，不起服务——探针要 tsx 才 import 得了 .ts。
 */
import { schedulingBlock, toAgentMessages } from './src/agent/index.ts'

const DAY1 = Date.parse('2026-08-18T14:10:00Z') // 昨天
const DAY2 = Date.parse('2026-08-19T03:20:00Z') // 今天

let seq = 0
const ev = (type, time, data) => ({ seq: ++seq, time, type, data })
const msg = (text) => ({ id: 'm' + seq, role: 'user', content: [{ type: 'text', text }] })

const events = [
  ev('session', DAY1, { version: 3, id: 's', createdAt: DAY1, botId: 'b' }),
  ev('user/message', DAY1, { message: msg('昨天的问题'), source: { kind: 'user' } }),
  ev('turn/start', DAY1, { turn: 1 }),
  ev('assistant/message', DAY1 + 1000, {
    turn: 1,
    step: 1,
    message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '昨天的回答' }] },
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0 },
  }),
  ev('turn/end', DAY1 + 1000, { turn: 1, reason: 'completed' }),
  ev('user/message', DAY2, { message: msg('今天的问题'), source: { kind: 'user' } }),
  ev('turn/start', DAY2, { turn: 2 }),
  ev('assistant/message', DAY2 + 1000, {
    turn: 2,
    step: 1,
    message: { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '今天的回答' }] },
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0 },
  }),
  ev('turn/end', DAY2 + 1000, { turn: 2, reason: 'completed' }),
]

const rebuilt = await toAgentMessages(events, { api: 'openai-completions', provider: 'p', model: 'm' })
const users = rebuilt.filter((m) => m.role === 'user')

// 带图的消息也要盖上时间。有图时内容是数组而不是字符串，只处理字符串的话
// 带图那几条就没有时间——而它们往往正是之后会被问起的「上周发你的那张图」。
const withImage = [
  ev('session', DAY1, { version: 4, id: 's2', createdAt: DAY1, botId: 'b' }),
  ev('user/message', DAY1, {
    message: {
      id: 'ui',
      role: 'user',
      content: [
        { type: 'image', path: 'shots/a.png', mime: 'image/png' },
        { type: 'text', text: '看看这张图' },
      ],
    },
    source: { kind: 'user' },
  }),
]
const imageMsg = (await toAgentMessages(withImage))[0]

console.log(
  '__RESULT__' +
    JSON.stringify({
      image: {
        isArray: Array.isArray(imageMsg?.content),
        firstBlockIsTime: /^\[.+\]$/.test(imageMsg?.content?.[0]?.text ?? ''),
        blockCount: Array.isArray(imageMsg?.content) ? imageMsg.content.length : 0,
        keepsText: JSON.stringify(imageMsg?.content ?? '').includes('看看这张图'),
      },
      timestamps: rebuilt.map((m) => m.timestamp),
      expected: [DAY1, DAY1 + 1000, DAY2, DAY2 + 1000],
      // 时间要能进**正文**——pi 的 timestamp 字段停在 pi 那一层，
      // llm/gateway.ts 往请求体里只放 role 和 content。
      userContents: users.map((m) => m.content),
      schedulingPrompt: {
        deadlineIsNotTimer: schedulingBlock().includes('截止时间不等于要求你在那个时刻自动唤醒'),
        noMemoryForTasks: schedulingBlock().includes('绝不能用 `memory_write` 保存'),
        noSilentQueue: schedulingBlock().includes('不要声称系统会在后台记录、排队或稍后自动完成'),
      },
    }),
)
