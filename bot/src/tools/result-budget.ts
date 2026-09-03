import { createHash } from 'node:crypto'

/**
 * 单次工具结果允许进入模型上下文的最大字符数。
 *
 * 这不是工具自身的返回上限：原文仍落在会话日志。它只是一道上下文边界，防止一次列表
 * 查询把几十封邮件正文（甚至同一正文的 text + base64 两份）塞进此后每一次模型请求。
 */
export const MODEL_TOOL_RESULT_MAX_CHARS = 48_000

const MAX_GENERIC_STRING = 6_000
const MAX_GENERIC_ARRAY = 60
const MAX_JSON_DEPTH = 8
const MAIL_PREVIEW_CHARS = 800

export interface BudgetedToolText {
  /** 真正给模型看的文本。 */
  text: string
  /** 发生了瘦身时保留的原文；只用于日志与界面，绝不能回放给模型。 */
  rawText?: string
}

/**
 * 给工具结果做最后一道统一预算。
 *
 * Gmail 两类查询先做语义瘦身；其余工具超过硬上限时做结构化裁剪。返回的 rawText 让
 * 上层可以保留完整审计原文，而不把它重新送进上下文。
 */
export function budgetToolText(name: string, rawText: string): BudgetedToolText {
  const mail = compactMailResult(name, rawText)
  if (mail !== undefined && mail !== rawText) return { text: fit(name, rawText, mail), rawText }
  if (rawText.length <= MODEL_TOOL_RESULT_MAX_CHARS) return { text: rawText }
  return { text: fit(name, rawText, compactGeneric(rawText)), rawText }
}

function compactMailResult(name: string, raw: string): string | undefined {
  if (!/(?:^|_)fetch_emails$/i.test(name) && !/(?:^|_)fetch_message_by_message_id$/i.test(name)) {
    return undefined
  }
  const parsed = parseJson(raw)
  if (parsed === undefined) return undefined

  if (/(?:^|_)fetch_emails$/i.test(name)) {
    const root = asRecord(parsed)
    const messages = Array.isArray(parsed) ? parsed : Array.isArray(root?.messages) ? root.messages : undefined
    if (!messages) return undefined
    const slim = messages.map((message) => slimMail(message, true))
    const output: Record<string, unknown> = {
      _satuwork_notice:
        '邮件列表已省略正文和原始 payload。需要完整内容时，请用 messageId 调用 fetch_message_by_message_id。',
      messages: slim,
    }
    if (root) copyKeys(root, output, ['nextPageToken', 'resultSizeEstimate', 'total', 'count'])
    return JSON.stringify(output)
  }

  // 单封邮件通常同时带规范化 messageText 和 payload.body.data(base64)，两份内容近乎
  // 重复。保留可读正文与元数据，移除 MIME/base64 原包；正文若仍异常巨大再走统一硬上限。
  const root = asRecord(parsed)
  if (!root) return undefined
  return JSON.stringify({
    _satuwork_notice: '已省略重复的原始 MIME/base64 payload，保留规范化邮件正文。',
    ...slimMail(root, false),
  })
}

function slimMail(value: unknown, list: boolean): Record<string, unknown> {
  const src = asRecord(value) ?? {}
  const out: Record<string, unknown> = {}
  copyKeys(src, out, [
    'messageId',
    'id',
    'threadId',
    'sender',
    'from',
    'to',
    'cc',
    'bcc',
    'subject',
    'messageTimestamp',
    'timestamp',
    'date',
    'internalDate',
    'labelIds',
    'labels',
    'snippet',
    'preview',
    'hasAttachments',
    'attachmentList',
  ])

  const body = firstString(src, ['messageText', 'body', 'text', 'content'])
  if (body) {
    if (list) {
      // 列表只需要足够用于筛选的一小段；完整正文按 messageId 再取。
      out.preview = typeof out.preview === 'string' && out.preview ? out.preview : clampString(body, MAIL_PREVIEW_CHARS)
    } else {
      out.messageText = body
    }
  }
  return out
}

function compactGeneric(raw: string): string {
  const parsed = parseJson(raw)
  if (parsed === undefined) return clampText(raw, MODEL_TOOL_RESULT_MAX_CHARS)
  return JSON.stringify(pruneJson(parsed, 0))
}

function pruneJson(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return clampString(value, MAX_GENERIC_STRING)
  if (value === null || typeof value !== 'object') return value
  if (depth >= MAX_JSON_DEPTH) return '[更深层结构已省略]'
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_GENERIC_ARRAY).map((item) => pruneJson(item, depth + 1))
    if (value.length > MAX_GENERIC_ARRAY) items.push(`[其余 ${value.length - MAX_GENERIC_ARRAY} 项已省略]`)
    return items
  }
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = pruneJson(item, depth + 1)
  }
  return out
}

function fit(name: string, raw: string, candidate: string): string {
  if (candidate.length <= MODEL_TOOL_RESULT_MAX_CHARS) return candidate
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16)
  const header = [
    `[Satuwork 工具结果预算：${name || 'unknown'} 原文 ${raw.length.toLocaleString('en-US')} 字符，sha256 ${digest}]`,
    '以下仅为受控摘录；完整原文已保留在会话日志。请缩小查询范围，或按具体 ID 再读取所需对象。',
    '',
  ].join('\n')
  return header + clampText(candidate, MODEL_TOOL_RESULT_MAX_CHARS - header.length)
}

function clampText(text: string, max: number): string {
  if (text.length <= max) return text
  const marker = `\n…[中间 ${text.length - max} 字符已从模型上下文省略]…\n`
  const room = Math.max(0, max - marker.length)
  const head = Math.ceil(room * 0.7)
  return text.slice(0, head) + marker + text.slice(text.length - (room - head))
}

function clampString(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}…[其余 ${text.length - max} 字符已省略]`
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function copyKeys(src: Record<string, unknown>, dst: Record<string, unknown>, keys: string[]) {
  for (const key of keys) if (src[key] !== undefined) dst[key] = src[key]
}

function firstString(src: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof src[key] === 'string' && src[key]) return src[key] as string
  return undefined
}
