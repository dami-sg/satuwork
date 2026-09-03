import { createServer } from 'node:http'

const token = '123456789:telegram-rich-e2e'
const seen = []
let rejectRich = false

const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    const method = new URL(req.url, 'http://telegram.test').pathname.replace(`/bot${token}/`, '')
    const body = JSON.parse(raw || '{}')
    seen.push({ method, body })
    res.setHeader('content-type', 'application/json')
    if (method === 'sendRichMessage' && rejectRich) {
      res.statusCode = 404
      res.end(JSON.stringify({ ok: false, error_code: 404, description: 'Method not found' }))
      return
    }
    res.end(JSON.stringify({ ok: true, result: { message_id: seen.length } }))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${address.port}`

try {
  const {
    normalizeTelegramCallback, startTelegramTyping, telegramAnswerCallbackQuery,
    telegramClearApprovalButtons, telegramRichTextParts, telegramSendApproval, telegramSendText,
  } = await import('./src/channels/telegram.ts')
  const stopTyping = startTelegramTyping(token, '456', { intervalMs: 20 })
  await new Promise((resolve) => setTimeout(resolve, 75))
  stopTyping()
  const typingAtStop = seen.filter((entry) => entry.method === 'sendChatAction')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const typingAfterStop = seen.filter((entry) => entry.method === 'sendChatAction')
  seen.length = 0
  const markdown = [
    '# 周报',
    '',
    '- [x] **已完成**',
    '- [ ] 待处理',
    '',
    '| 指标 | 值 |',
    '| --- | ---: |',
    '| 速度 | 42 |',
    '',
    '> 原生 RichMessage 引用',
    '',
    '```ts',
    'const answer = 42',
    '```',
  ].join('\n')
  await telegramSendText(token, '456', markdown, '88')
  const native = seen[0]

  rejectRich = true
  await telegramSendText(token, '456', '**旧 API 降级**', '88')
  const fallback = seen.slice(1)

  rejectRich = false
  seen.length = 0
  const approvalKey = 'AbCdEfGhIjKlMnOpQrStUv'
  const approvalMessageId = await telegramSendApproval(token, '456', '## 需要批准\n\n请确认。', approvalKey)
  const approval = seen[0]
  await telegramAnswerCallbackQuery(token, 'query-1', '已批准这一次。')
  await telegramClearApprovalButtons(token, '456', approvalMessageId)
  const answer = seen[1]
  const cleared = seen[2]
  const callback = normalizeTelegramCallback({
    update_id: 99,
    callback_query: {
      id: 'query-1', data: `swa:${approvalKey}:a1`, from: { id: 456 },
      message: { message_id: approvalMessageId, chat: { id: 456, type: 'private' } },
    },
  })
  const callbackData = approval?.body?.reply_markup?.inline_keyboard
    ?.flatMap((row) => row.map((button) => button.callback_data)) || []

  seen.length = 0
  const longApprovalTail = '——长邮件正文结尾——'
  const longApproval = `## 需要批准\n\n### 正文\n\n> ${'完整正文 '.repeat(7_000)}\n>\n> ${longApprovalTail}\n\n请选择审批范围。`
  const longApprovalMessageId = await telegramSendApproval(token, '456', longApproval, approvalKey)
  const longApprovalMessages = [...seen]

  rejectRich = true
  seen.length = 0
  const fallbackApprovalTail = '——旧接口完整正文结尾——'
  const fallbackApproval = `## 需要批准\n\n### 正文\n\n${'旧接口正文 '.repeat(2_000)}\n\n${fallbackApprovalTail}`
  const fallbackApprovalMessageId = await telegramSendApproval(token, '456', fallbackApproval, approvalKey)
  const fallbackApprovalMessages = seen.filter((entry) => entry.method === 'sendMessage')
  rejectRich = false

  const huge = `\`\`\`txt\n${'x'.repeat(31_000)}\n\`\`\``
  const parts = telegramRichTextParts(huge)
  console.log('__RESULT__' + JSON.stringify({
    nativeMethod: native?.method,
    nativeMarkdown: native?.body?.rich_message?.markdown,
    nativeThread: native?.body?.message_thread_id,
    fallbackMethods: fallback.map((entry) => entry.method),
    fallbackText: fallback.at(-1)?.body?.text,
    typingCount: typingAtStop.length,
    typingStopped: typingAfterStop.length === typingAtStop.length,
    typingValid: typingAtStop.every((entry) => entry.body?.chat_id === '456' && entry.body?.action === 'typing'),
    approvalMethod: approval?.method,
    approvalButtons: callbackData,
    approvalButtonsFit: callbackData.every((data) => Buffer.byteLength(data, 'utf8') <= 64),
    longApprovalParts: longApprovalMessages.length,
    longApprovalComplete: longApprovalMessages.some((entry) => entry.body?.rich_message?.markdown?.includes(longApprovalTail)),
    longApprovalQuoted: longApprovalMessages.filter((entry) => entry.method === 'sendRichMessage')
      .every((entry) => String(entry.body?.rich_message?.markdown || '').split('\n').filter((line) => line.includes('完整正文')).every((line) => line.startsWith('> '))),
    longApprovalButtonsOnlyLast: longApprovalMessages.slice(0, -1).every((entry) => !entry.body?.reply_markup)
      && Boolean(longApprovalMessages.at(-1)?.body?.reply_markup),
    longApprovalMessageIdIsLast: longApprovalMessageId === longApprovalMessages.length,
    fallbackApprovalParts: fallbackApprovalMessages.length,
    fallbackApprovalComplete: fallbackApprovalMessages.some((entry) => entry.body?.text?.includes(fallbackApprovalTail)),
    fallbackApprovalButtonsOnlyLast: fallbackApprovalMessages.slice(0, -1).every((entry) => !entry.body?.reply_markup)
      && Boolean(fallbackApprovalMessages.at(-1)?.body?.reply_markup),
    fallbackApprovalMessageIdIsLast: fallbackApprovalMessageId === seen.length,
    callback,
    answerMethod: answer?.method,
    answerId: answer?.body?.callback_query_id,
    clearMethod: cleared?.method,
    clearKeyboard: cleared?.body?.reply_markup?.inline_keyboard,
    hugeParts: parts.length,
    hugePartsValid: parts.every((part) => part.startsWith('```txt\n') && part.endsWith('\n```') && Array.from(part).length <= 30_000),
  }))
} finally {
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}
