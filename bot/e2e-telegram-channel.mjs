import {
  channelCommand, channelMentionHelp, channelTodoMarkdown, parseChannelMentions,
} from './src/web/channel.ts'
import { channelDraft, channelFiles } from './src/web/index.ts'

const candidates = [
  { id: 'gmail-personal', label: 'Gmail (personal)' },
  { id: 'gmail-work', label: 'Gmail (work)' },
  { id: 'notion', label: 'Notion' },
]
const parsed = parseChannelMentions('@Gmail_personal @Notion 查邮件并建立页面', candidates)
const ambiguous = parseChannelMentions('@Gmail 查邮件', candidates)
const todos = channelTodoMarkdown([
  { id: '1', task: '读取邮件', status: 'completed' },
  { id: '2', task: '建立 **页面**', status: 'in_progress' },
  { id: '3', task: '旧步骤', status: 'cancelled' },
])
const draft = channelDraft([
  { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'channel', form: 'update-7' } } },
  { type: 'turn/start', data: { turn: 7 } },
  { type: 'assistant/chunk', data: { turn: 7, step: 1, chunk: { type: 'text-delta', text: '我先' } } },
  { type: 'assistant/chunk', data: { turn: 7, step: 1, chunk: { type: 'text-delta', text: '查行情' } } },
  // 完整消息会替代同一步的 chunks，不能再重复拼一次「我先查行情」。
  { type: 'assistant/message', data: { turn: 7, step: 1, message: { content: [{ type: 'text', text: '我先查行情。' }] } } },
  { type: 'assistant/chunk', data: { turn: 7, step: 2, chunk: { type: 'text-delta', text: '正在生成报告' } } },
], 'update-7')
const toolDraft = channelDraft([
  { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'channel', form: 'update-tools' } } },
  { type: 'turn/start', data: { turn: 8 } },
  { type: 'assistant/message', data: { turn: 8, step: 1, message: { content: [{ type: 'text', text: '我先查一下。' }] } } },
  { type: 'tool/call', data: { turn: 8, step: 1, callId: 'call-search', name: 'web_search', arguments: '{"q":"ETH"}' } },
  { type: 'tool/result', data: { turn: 8, step: 1, callId: 'call-search', text: '找到了', failed: false } },
  { type: 'tool/call', data: { turn: 8, step: 2, callId: 'call-extract', name: 'web_extract', arguments: '{"url":"https://example.test"}' } },
  { type: 'tool/call', data: { turn: 8, step: 2, callId: 'call-failed', name: 'browser_navigate', arguments: '{}' } },
  { type: 'tool/result', data: { turn: 8, step: 2, callId: 'call-failed', text: '超时', failed: true } },
  // 参数和结果可能含敏感内容，只能展示名称和状态。
  { type: 'tool/result', data: { turn: 8, step: 2, callId: 'orphan', text: '不能露出来的结果', failed: false } },
], 'update-tools')
const files = channelFiles([
  { type: 'user/message', data: { source: { kind: 'plugin', plugin: 'channel', form: 'update-7' } } },
  { type: 'turn/start', data: { turn: 7 } },
  { type: 'tool/result', data: { turn: 7, files: [
    { path: 'reports/eth.html', name: 'eth.html' },
    { path: 'reports/eth.html', name: 'eth.html' },
    { path: 'reports/summary.pdf', name: 'summary.pdf' },
  ] } },
  // 别轮的产出不能跟进这一条 Telegram 回复。
  { type: 'tool/result', data: { turn: 8, files: [{ path: 'later.txt', name: 'later.txt' }] } },
], 'update-7')

console.log('__RESULT__' + JSON.stringify({
  commands: [channelCommand('/new'), channelCommand('/new@satuwork_bot'), channelCommand('/tasks'), channelCommand('/mentions')],
  parsed,
  ambiguous,
  help: channelMentionHelp(candidates),
  todos,
  draft,
  toolDraft,
  files,
}))
