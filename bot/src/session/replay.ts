import type { SessionEvent } from './types.ts'

/**
 * 历史重放要发的那一段。
 *
 * 以前是整段推：一条 8 轮的对话 789 条事件，实测长会话到过 1078 条。每次打开页面、
 * 每次刷新都从头灌一遍。两个代价：慢，以及**尾巴容易压在下游缓冲里出不来**——那正是
 * 「历史缺一截 + 永远正在处理」的成因。
 *
 * 这里砍两刀：
 *
 * **一、只发最近几轮。** 人打开对话是来看最近说了什么的，几个月前那一轮等他往上翻
 * 再取。往前翻用 `before` 游标一页页推。
 *
 * **二、跳过已经作废的流式 chunk。** 这一刀几乎是白捡的：789 条里 706 条是 chunk
 * （89%）。而客户端 fold 的写法是——chunk 追加、最终的 `assistant/message` **覆盖**：
 *
 *     assistant/message → assistant.text = text     // 覆盖
 *     assistant/chunk   → assistant.text += delta   // 追加
 *
 * 也就是说一轮跑完之后，那一步的 chunk 全是废的：客户端收下来只为了被下一行盖掉。
 * 按 `turn:step` 配对，有最终正文的就把 chunk 丢掉，没有的（正在跑的那一步）留着。
 *
 * 审计那条路（/internal/sessions/:id）不走这里——它要的是全量原文。
 */

export interface HistorySlice {
  events: SessionEvent[]
  /** 这一段最靠前那条的 seq。客户端拿它当「再往前翻」的游标。 */
  firstSeq: number | null
  /** 前面还有没有。有就该给一个「加载更多」。 */
  hasMore: boolean
}

function stepKey(ev: SessionEvent): string {
  const d = (ev.data ?? {}) as { turn?: number; step?: number }
  return `${d.turn ?? -1}:${d.step ?? -1}`
}

/** 这条最终消息有没有正文。没有的话它盖不住 chunk，chunk 就还得留着。 */
function hasText(ev: SessionEvent): boolean {
  const msg = (ev.data as { message?: { content?: unknown } } | undefined)?.message
  const content = msg?.content
  if (typeof content === 'string') return content.trim().length > 0
  if (!Array.isArray(content)) return false
  return content.some((c) => {
    const b = c as { type?: string; text?: string }
    return (b?.type === 'text' || b?.type === 'reasoning') && Boolean(b.text?.trim())
  })
}

export function historySlice(
  all: readonly SessionEvent[],
  opts: { turns?: number; before?: number } = {},
): HistorySlice {
  const turns = Math.max(0, Math.trunc(opts.turns ?? 0))
  // 往前翻：只看这条之前的。
  const events = opts.before ? all.filter((e) => e.seq < opts.before!) : all.slice()

  let start = 0
  if (turns > 0) {
    let seen = 0
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type !== 'turn/start') continue
      seen++
      if (seen === turns) {
        start = i
        break
      }
    }
    // 提问是在 turn/start **之前**写的，捎上它——否则这一页开头是个没有问题的回答。
    while (start > 0 && events[start - 1].type === 'user/message') start--
  }

  const slice = events.slice(start)

  // 哪些「轮:步」已经有最终正文了。
  const settled = new Set<string>()
  for (const ev of slice) {
    if (ev.type === 'assistant/message' && hasText(ev)) settled.add(stepKey(ev))
  }

  const out = slice.filter((ev) => !(ev.type === 'assistant/chunk' && settled.has(stepKey(ev))))
  return {
    events: out,
    firstSeq: out.length ? out[0].seq : null,
    // 判据是有没有**切掉**东西，不是切完还剩多少：chunk 被丢掉不代表前面还有内容可翻。
    hasMore: start > 0,
  }
}
