import {
  channelCommand, channelMentionHelp, channelTodoMarkdown, parseChannelMentions,
} from './src/web/channel.ts'

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

console.log('__RESULT__' + JSON.stringify({
  commands: [channelCommand('/new'), channelCommand('/new@satuwork_bot'), channelCommand('/tasks'), channelCommand('/mentions')],
  parsed,
  ambiguous,
  help: channelMentionHelp(candidates),
  todos,
}))
