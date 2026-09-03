import type { ChannelBinding } from '../db.ts'

const BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, '')

export class TelegramError extends Error {
  constructor(
    message: string,
    public status = 502,
    public retryAfterMs = 0,
    /** 哪个 Bot API 方法失败。轮询器据此区分“token 坏了”和“某一条消息回不出去”。 */
    public method = '',
  ) {
    super(message)
  }
  get permanent(): boolean { return this.status === 401 || this.status === 403 || this.status === 404 }
  /** 同一请求原样再试有机会恢复；其余 4xx 是这条 update 自身的毒消息。 */
  get retryable(): boolean { return this.status === 429 || this.status >= 500 }
}

async function call<T>(token: string, method: string, body: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<T> {
  let r: Response
  try {
    r = await fetch(`${BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch {
    throw new TelegramError('Telegram 暂时连接不上', 502, 0, method)
  }
  const data = await r.json().catch(() => null) as {
    ok?: boolean
    result?: T
    description?: string
    error_code?: number
    parameters?: { retry_after?: number }
  } | null
  if (!r.ok || !data?.ok) {
    const status = Number(data?.error_code) || r.status || 502
    throw new TelegramError(
      data?.description || `Telegram HTTP ${status}`,
      status,
      Math.max(0, Number(data?.parameters?.retry_after) || 0) * 1000,
      method,
    )
  }
  return data.result as T
}

export interface TelegramBotInfo {
  id: number
  is_bot: boolean
  first_name: string
  username?: string
}

export function telegramGetMe(token: string): Promise<TelegramBotInfo> {
  return call(token, 'getMe')
}

export function telegramDeleteWebhook(token: string, dropPending = false): Promise<boolean> {
  return call(token, 'deleteWebhook', { drop_pending_updates: dropPending })
}

/** 让 Telegram 客户端在 `/` 菜单里直接展示渠道支持的控制命令。 */
export function telegramSetMyCommands(token: string): Promise<boolean> {
  return call(token, 'setMyCommands', {
    commands: [
      { command: 'new', description: '开始新对话（保留记录，不带旧上下文）' },
      { command: 'tasks', description: '查看当前任务列表' },
      { command: 'mentions', description: '查看可用的 @ 连接' },
    ],
    scope: { type: 'all_private_chats' },
  })
}

export function telegramSendTyping(token: string, chatId: string): Promise<boolean> {
  return call(token, 'sendChatAction', { chat_id: chatId, action: 'typing' }, 8_000)
}

/**
 * Telegram 的 chat action 最多显示 5 秒。模型与工具调用可能持续更久，所以处理期间
 * 每 4 秒续一次；同一时刻只允许一个请求在飞，网络慢时不会叠出一串请求。
 */
export function startTelegramTyping(
  token: string,
  chatId: string,
  options: { intervalMs?: number; onError?: (error: Error) => void } = {},
): () => void {
  const intervalMs = Math.max(10, Math.trunc(options.intervalMs ?? 4000))
  let stopped = false
  let sending = false
  const pulse = async () => {
    if (stopped || sending) return
    sending = true
    try {
      await telegramSendTyping(token, chatId)
    } catch (e) {
      options.onError?.(e as Error)
    } finally {
      sending = false
    }
  }
  void pulse()
  const timer = setInterval(() => { void pulse() }, intervalMs)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

export function telegramGetUpdates(token: string, offset: number, timeoutSeconds = 30): Promise<unknown[]> {
  const seconds = Math.min(50, Math.max(1, Math.trunc(timeoutSeconds)))
  return call<unknown[]>(token, 'getUpdates', {
    offset: Math.max(0, Math.trunc(offset)), timeout: seconds, allowed_updates: ['message', 'callback_query', 'my_chat_member'],
  }, (seconds + 10) * 1000)
}

export interface TelegramCallback {
  queryId: string
  data: string
  chatId: string
  messageId: number
  remoteUserId: string
}

export function normalizeTelegramCallback(raw: unknown): TelegramCallback | null {
  const u = raw && typeof raw === 'object' ? raw as Record<string, any> : null
  const q = u?.callback_query
  const chat = q?.message?.chat
  const queryId = String(q?.id ?? '').trim()
  const data = String(q?.data ?? '').trim()
  const chatId = String(chat?.id ?? '').trim()
  const remoteUserId = String(q?.from?.id ?? '').trim()
  const messageId = Number(q?.message?.message_id)
  if (!queryId || !data || !chatId || !remoteUserId || chat?.type !== 'private' || !Number.isSafeInteger(messageId)) return null
  return { queryId, data, chatId, messageId, remoteUserId }
}

function approvalKeyboard(approvalKey: string) {
  const data = (action: 'a1' | 'at' | 'd1' | 'dt') => `swa:${approvalKey}:${action}`
  return {
    inline_keyboard: [
      [
        { text: '批准', callback_data: data('a1') },
        { text: '这一轮都批准', callback_data: data('at') },
      ],
      [
        { text: '拒绝', callback_data: data('d1') },
        { text: '这一轮别再试', callback_data: data('dt') },
      ],
    ],
  }
}

/**
 * 发带内联按钮的 RichMessage 审批内容。长正文会完整拆成多条，按钮只挂在最后一条；
 * 这样回调保存的 message id 始终指向真正带按钮的那条。旧 Bot API 逐段降级为普通文本。
 */
export async function telegramSendApproval(token: string, chatId: string, markdown: string, approvalKey: string): Promise<number> {
  const reply_markup = approvalKeyboard(approvalKey)
  const richParts = telegramRichTextParts(markdown)
  let messageId = NaN
  for (let i = 0; i < richParts.length; i += 1) {
    const part = richParts[i]
    const lastRichPart = i === richParts.length - 1
    let sent: { message_id?: unknown } | undefined
    try {
      sent = await call(token, 'sendRichMessage', {
        chat_id: chatId,
        rich_message: { markdown: part },
        ...(lastRichPart ? { reply_markup } : {}),
      })
    } catch (error) {
      if (!canFallBackToPlain(error)) throw error
      const plainParts = telegramTextParts(part, 4000)
      for (let j = 0; j < plainParts.length; j += 1) {
        const lastPlainPart = j === plainParts.length - 1
        sent = await call(token, 'sendMessage', {
          chat_id: chatId,
          text: plainParts[j],
          ...(lastRichPart && lastPlainPart ? { reply_markup } : {}),
        })
      }
    }
    if (lastRichPart) messageId = Number(sent?.message_id)
  }
  if (!Number.isSafeInteger(messageId)) throw new TelegramError('Telegram 没有返回审批消息 id')
  return messageId
}

export function telegramAnswerCallbackQuery(
  token: string,
  queryId: string,
  text: string,
  showAlert = false,
): Promise<boolean> {
  return call(token, 'answerCallbackQuery', {
    callback_query_id: queryId, text: text.slice(0, 200), show_alert: showAlert,
  }, 8_000)
}

export function telegramClearApprovalButtons(token: string, chatId: string, messageId: number): Promise<unknown> {
  return call(token, 'editMessageReplyMarkup', {
    chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] },
  }, 8_000)
}

/**
 * 私人 Bot 若被拉进群或频道，会收到 message 或 my_chat_member。返回该非私聊 chat，
 * 供轮询器立即 leaveChat；已经离开/被踢的成员更新不必重复调用。
 */
export function telegramJoinedSharedChat(raw: unknown): { chatId: string; chatType: string } | null {
  const u = raw && typeof raw === 'object' ? raw as Record<string, any> : null
  const member = u?.my_chat_member
  if (member && (member.new_chat_member?.status === 'left' || member.new_chat_member?.status === 'kicked')) return null
  const chat = member?.chat || u?.message?.chat
  const chatId = String(chat?.id ?? '').trim()
  const chatType = String(chat?.type ?? '').trim()
  if (!chatId || !chatType || chatType === 'private') return null
  return { chatId, chatType }
}

export function telegramLeaveChat(token: string, chatId: string): Promise<boolean> {
  return call(token, 'leaveChat', { chat_id: chatId })
}

export interface TelegramInbound {
  externalEventId: string
  externalConversationId: string
  chatId: string
  chatType: string
  remoteUserId: string
  remoteDisplayName: string
  title: string
  text: string
}

export function normalizeTelegramUpdate(raw: unknown, binding: ChannelBinding): TelegramInbound | null {
  const u = raw && typeof raw === 'object' ? raw as Record<string, any> : null
  const m = u?.message
  if (!m || typeof m !== 'object' || m.from?.is_bot) return null
  const chat = m.chat
  // Satuwork 的 Telegram Bot 是用户私人渠道：群、超级群、频道和话题都不入库。
  if (!chat || chat.type !== 'private') return null
  const text = String(m.text ?? m.caption ?? '').trim()
  if (!text) return null
  const updateId = String(u?.update_id ?? '').trim()
  const chatId = String(chat.id ?? '').trim()
  if (!updateId || !chatId) return null
  const first = String(m.from?.first_name ?? '').trim()
  const last = String(m.from?.last_name ?? '').trim()
  const username = String(m.from?.username ?? '').trim()
  const display = [first, last].filter(Boolean).join(' ') || (username ? `@${username}` : String(m.from?.id ?? ''))
  const chatTitle = String(chat.title ?? '').trim() || display || `Telegram ${chatId}`
  return {
    externalEventId: updateId,
    externalConversationId: chatId,
    chatId,
    chatType: String(chat.type || ''),
    remoteUserId: String(m.from?.id ?? ''),
    remoteDisplayName: display,
    title: chatTitle,
    text,
  }
}

const EMPTY_REPLY = '已处理，但没有可发送的文本回复。'

function textLength(text: string): number {
  return Array.from(text).length
}

/**
 * 按 Unicode code point 切文本，优先落在换行或空格上，不把代理对劈开。
 * sendMessage 的限额是 4096，这里默认留 96 字符余量。
 */
export function telegramTextParts(text: string, max = 4000): string[] {
  const source = String(text || '').trim() || EMPTY_REPLY
  const out: string[] = []
  let rest = Array.from(source)
  while (rest.length > max) {
    let end = max
    const floor = Math.floor(max * 0.6)
    for (let i = max; i >= floor; i -= 1) {
      if (rest[i - 1] === '\n') { end = i - 1; break }
      if (end === max && /\s/u.test(rest[i - 1] || '')) end = i - 1
    }
    if (end <= 0) end = max
    const part = rest.slice(0, end).join('').trimEnd()
    if (part) out.push(part)
    rest = rest.slice(end)
    while (rest[0] === '\n' || rest[0] === '\r') rest.shift()
  }
  const tail = rest.join('').trim()
  if (tail) out.push(tail)
  return out.length ? out : [EMPTY_REPLY]
}

function markdownBlocks(markdown: string): string[] {
  const lines = markdown.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  let fence = ''
  const flush = () => {
    const block = current.join('\n').trim()
    if (block) blocks.push(block)
    current = []
  }
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1] || ''
    if (!fence && marker) fence = marker[0]
    else if (fence && marker[0] === fence) fence = ''
    if (!fence && !line.trim()) flush()
    else current.push(line)
  }
  flush()
  return blocks
}

function splitOversizedMarkdownBlock(block: string, max: number): string[] {
  const lines = block.split('\n')
  if (lines.every((line) => /^\s*>/.test(line))) {
    const plain = lines.map((line) => line.replace(/^\s*> ?/, '')).join('\n')
    return telegramTextParts(plain, Math.max(1, max - 2)).map((part) =>
      part.split('\n').map((line) => line ? `> ${line}` : '>').join('\n'))
  }
  const opening = /^\s*(`{3,}|~{3,})[^\n]*$/.exec(lines[0] || '')
  const marker = opening?.[1] || ''
  const closed = marker && new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines.at(-1) || '')
  if (!opening || !closed || lines.length < 3) return telegramTextParts(block, max)

  // 一个超大代码块也要每段都有完整 fence，否则后面整条 RichMessage 会解析失败。
  const open = lines[0]
  const close = lines.at(-1) || marker
  const room = Math.max(1, max - textLength(open) - textLength(close) - 2)
  return telegramTextParts(lines.slice(1, -1).join('\n'), room)
    .map((part) => `${open}\n${part}\n${close}`)
}

/**
 * RichMessage 支持最多 32768 个 UTF-8 字符。在 Markdown 块边界组包，
 * 让标题、表格、列表、引用与代码块尽量不被拆开。
 */
export function telegramRichTextParts(text: string, max = 30_000): string[] {
  const source = String(text || '').trim() || EMPTY_REPLY
  const blocks = markdownBlocks(source).flatMap((block) =>
    textLength(block) <= max ? [block] : splitOversizedMarkdownBlock(block, max))
  const out: string[] = []
  let current = ''
  for (const block of blocks) {
    const next = current ? `${current}\n\n${block}` : block
    if (current && textLength(next) > max) {
      out.push(current)
      current = block
    } else current = next
  }
  if (current) out.push(current)
  return out.length ? out : [EMPTY_REPLY]
}

function canFallBackToPlain(error: unknown): boolean {
  return error instanceof TelegramError && (error.status === 400 || error.status === 404)
}

async function telegramSendPlain(token: string, chatId: string, text: string, threadId: string): Promise<void> {
  for (const part of telegramTextParts(text)) await call(token, 'sendMessage', {
    chat_id: chatId,
    text: part,
    ...(threadId ? { message_thread_id: threadId } : {}),
  })
}

export async function telegramSendText(token: string, chatId: string, text: string, threadId = ''): Promise<void> {
  for (const part of telegramRichTextParts(text)) {
    try {
      await call(token, 'sendRichMessage', {
        chat_id: chatId,
        rich_message: { markdown: part },
        ...(threadId ? { message_thread_id: threadId } : {}),
      })
    } catch (error) {
      // 兼容旧版 Bot API，也防止模型生成的半截 Markdown 让回复整体丢失。
      if (!canFallBackToPlain(error)) throw error
      await telegramSendPlain(token, chatId, part, threadId)
    }
  }
}
