import type { Mention } from '../agent/index.ts'
import type { TodoItem } from '../tools/todo.ts'

export interface ChannelMentionCandidate {
  id: string
  label: string
}

export type ChannelCommand = 'new' | 'tasks' | 'mentions'

/** Telegram 的命令可以带 Bot username（群里常见）；私聊也按同一形状兼容。 */
export function channelCommand(text: string): ChannelCommand | null {
  const hit = /^\/(new|tasks|mentions)(?:@[A-Za-z0-9_]+)?$/i.exec(String(text || '').trim())
  return hit ? hit[1].toLowerCase() as ChannelCommand : null
}

function markdownInline(text: string): string {
  return String(text || '').replace(/([\\`*_[\]<>~])/g, '\\$1')
}

/** Telegram 里可直接输入的、不含空格和标点的 @ 名字。 */
export function channelMentionAlias(label: string): string {
  return String(label || '')
    .normalize('NFKC')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64)
}

interface AliasRow { alias: string; candidate: ChannelMentionCandidate }

function canonicalAliases(candidates: ChannelMentionCandidate[]): AliasRow[] {
  const bases = candidates.map((candidate) => channelMentionAlias(candidate.label) || 'connection')
  const totals = new Map<string, number>()
  for (const base of bases) totals.set(base.toLocaleLowerCase(), (totals.get(base.toLocaleLowerCase()) || 0) + 1)
  const seen = new Map<string, number>()
  return candidates.map((candidate, i) => {
    const base = bases[i]
    const key = base.toLocaleLowerCase()
    const nth = (seen.get(key) || 0) + 1
    seen.set(key, nth)
    return { alias: (totals.get(key) || 0) > 1 ? `${base}_${nth}` : base, candidate }
  })
}

function aliasesOf(candidates: ChannelMentionCandidate[]): AliasRow[] {
  const byAlias = new Map<string, ChannelMentionCandidate[]>()
  const add = (alias: string, candidate: ChannelMentionCandidate) => {
    const key = alias.trim().toLocaleLowerCase()
    if (!key) return
    const list = byAlias.get(key) || []
    if (!list.some((x) => x.id === candidate.id)) list.push(candidate)
    byAlias.set(key, list)
  }
  for (const candidate of candidates) {
    add(candidate.label, candidate)
    add(channelMentionAlias(candidate.label), candidate)
    // `Gmail (personal)` 只有一把时允许简写 @Gmail；有两把时因歧义不会加入。
    add(candidate.label.replace(/\s*[（(][^）)]*[）)]\s*$/, ''), candidate)
  }
  // 标签完全相同也必须各有一个可输入的名字；编号只在这种冲突时出现。
  for (const row of canonicalAliases(candidates)) add(row.alias, row.candidate)
  return [...byAlias.entries()]
    .filter(([, rows]) => rows.length === 1)
    .map(([alias, rows]) => ({ alias, candidate: rows[0] }))
    .sort((a, b) => b.alias.length - a.alias.length)
}

function boundary(rest: string, length: number): boolean {
  const next = rest.slice(length, length + 1)
  return !next || /[\s,，。.!！?？:：;；]/u.test(next)
}

/**
 * Telegram 没有 Web 的 @ 选单药丸，约定点名写在消息开头：
 * `@Gmail_personal @Notion 查邮件并建页`。解析后仍传结构化 Mention，不把名字混进正文。
 */
export function parseChannelMentions(text: string, candidates: ChannelMentionCandidate[]): {
  text: string
  mentions: Mention[]
  unknown: string
} {
  let rest = String(text || '').trim()
  const aliases = aliasesOf(candidates)
  const mentions: Mention[] = []
  let unknown = ''
  while (rest.startsWith('@')) {
    const lower = rest.slice(1).toLocaleLowerCase()
    const hit = aliases.find((row) => lower.startsWith(row.alias) && boundary(lower, row.alias.length))
    if (!hit) {
      unknown = /^@([^\s,，。.!！?？:：;；]+)/u.exec(rest)?.[1] || rest.slice(1)
      break
    }
    if (!mentions.some((m) => m.id === hit.candidate.id)) {
      mentions.push({ kind: 'connector', id: hit.candidate.id, label: hit.candidate.label })
    }
    rest = rest.slice(hit.alias.length + 1).replace(/^[\s,，:：;；]+/u, '')
  }
  return { text: rest, mentions, unknown }
}

export function channelMentionHelp(candidates: ChannelMentionCandidate[]): string {
  if (!candidates.length) return '当前没有可用的 @ 连接。请先在 Web 的「连接器」页面完成连接。'
  return [
    '## 可用的 @ 连接',
    '',
    ...canonicalAliases(candidates).map((row) => `- \`@${row.alias}\` — ${markdownInline(row.candidate.label)}`),
    '',
    '把一个或多个 @ 名字写在消息开头，然后接正文。',
  ].join('\n')
}

/** Web 用固定 dock；Telegram 在每轮最终回复底部发送同一份持久化任务状态。 */
export function channelTodoMarkdown(items: TodoItem[]): string {
  if (!items.length) return ''
  const done = items.filter((item) => item.status === 'completed').length
  const mark: Record<TodoItem['status'], string> = {
    pending: '',
    in_progress: '▶ ',
    completed: '',
    cancelled: '✗ ',
  }
  return [
    `## 任务 · ${done}/${items.length} 已完成`,
    '',
    ...items.map((item) => {
      const checked = item.status === 'completed' ? 'x' : ' '
      const task = markdownInline(item.task)
      return `- [${checked}] ${mark[item.status]}${item.status === 'cancelled' ? `~~${task}~~` : task}`
    }),
  ].join('\n')
}

export function withChannelTodos(reply: string, items: TodoItem[]): string {
  const list = channelTodoMarkdown(items)
  return list ? `${String(reply || '').trim()}\n\n---\n\n${list}`.trim() : String(reply || '').trim()
}
