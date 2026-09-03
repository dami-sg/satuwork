import { randomUUID } from 'node:crypto'
import type { Db, ChannelEvent } from './db.ts'
import { decryptChannelSecret, encryptChannelSecret, timingSafeToken } from './crypto.ts'
import { machineTokenFor, seatBearer } from './lib/runtime.ts'
import { pairingCodeHash } from './channels/pairing.ts'
import {
  TelegramError, normalizeTelegramCallback, normalizeTelegramUpdate, telegramAnswerCallbackQuery,
  telegramClearApprovalButtons, telegramGetUpdates, telegramJoinedSharedChat, telegramSendApproval,
  startTelegramTyping, telegramLeaveChat, telegramSendText, telegramSetMyCommands,
} from './channels/telegram.ts'

interface StoredSecret { token: string; pairingCode: string }

interface ChannelApprovalField {
  key?: string
  label?: string
  value?: string
  editable?: boolean
  multiline?: boolean
}

const TICK_MS = Math.max(250, Math.trunc(Number(process.env.GATEWAY_CHANNEL_TICK_MS ?? 2000)))
const TURN_TIMEOUT_MS = Math.max(60_000, Math.trunc(Number(process.env.GATEWAY_CHANNEL_TURN_TIMEOUT_MS ?? 20 * 60_000)))
/**
 * 处理一轮可以很久，但租约不能跟着长达二十分钟：Gateway 热重启后会留下孤儿租约。
 * 短租约靠心跳续命，进程一没了，接管最多等这一小段。
 */
const EVENT_LEASE_MS = Math.max(15_000, Math.trunc(Number(process.env.GATEWAY_CHANNEL_EVENT_LEASE_MS ?? 30_000)))
const EVENT_LEASE_RENEW_MS = Math.max(1000, Math.min(
  Math.trunc(EVENT_LEASE_MS / 3),
  Math.trunc(Number(process.env.GATEWAY_CHANNEL_EVENT_LEASE_RENEW_MS ?? 10_000)),
))
const MAX_ATTEMPTS = 8
const POLL_SCAN_MS = Math.max(250, Math.trunc(Number(process.env.GATEWAY_CHANNEL_POLL_SCAN_MS ?? 1000)))
const POLL_TIMEOUT_SECONDS = Math.min(50, Math.max(1, Math.trunc(Number(process.env.GATEWAY_CHANNEL_POLL_TIMEOUT_SECONDS ?? 30))))
const POLL_LEASE_MS = (POLL_TIMEOUT_SECONDS + 20) * 1000
/** 长轮询/API 暂时失败后不要每秒轰 Telegram；429 给的 retry_after 优先。 */
const POLL_RETRY_MS = Math.max(1000, Math.trunc(Number(process.env.GATEWAY_CHANNEL_POLL_RETRY_MS ?? 5000)))
let wakeCurrent: (() => void) | null = null
/** 本进程已经给哪些存量绑定补过私聊命令菜单。失败不记，下一轮继续试。 */
const commandsConfigured = new Set<string>()

export function kickChannelDispatcher(): void { wakeCurrent?.() }

function retryDelay(attempts: number): number {
  return Math.min(5 * 60_000, 5000 * Math.pow(2, Math.min(6, Math.max(0, attempts - 1))))
}

interface ChannelApprovalSnapshot {
  key: string
  callId: string
  name: string
  arguments: string
  reason: string
  form?: {
    kind?: string
    tool?: string
    fields?: ChannelApprovalField[]
  }
}

interface SeatAccess {
  host: string
  headers: Record<string, string>
}

async function seatAccess(db: Db, binding: NonNullable<Awaited<ReturnType<Db['channelBinding']>>>): Promise<SeatAccess> {
  const instance = await db.instance(binding.accountId, binding.botId)
  const host = String(instance?.host || '').trim().replace(/\/$/, '')
  if (!host) throw new Error('telegram bot 还没有部署完成')
  const account = await db.account(binding.accountId)
  if (!account) throw new Error('渠道所属账号不存在')
  const bearer = await seatBearer(db, binding.accountId)
  const machine = await machineTokenFor(db, account, binding.botId)
  return {
    host,
    headers: {
      accept: 'application/json', 'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(machine ? { 'x-satuwork-machine': machine } : {}),
    },
  }
}

async function runSeatTurn(
  db: Db,
  event: ChannelEvent,
  binding: NonNullable<Awaited<ReturnType<Db['channelBinding']>>>,
  hooks: { onApproval?: (approval: ChannelApprovalSnapshot) => Promise<void>; onRunning?: () => void } = {},
) {
  const access = await seatAccess(db, binding)
  const deadline = Date.now() + TURN_TIMEOUT_MS
  while (Date.now() < deadline) {
    const r = await fetch(`${access.host}/api/channels/${encodeURIComponent(binding.id)}/messages`, {
      method: 'POST', headers: access.headers,
      body: JSON.stringify({
        botId: binding.botId,
        eventId: event.externalEventId,
        conversationId: event.externalConversationId,
        title: event.title,
        text: event.text,
      }),
      signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
    })
    const data = await r.json().catch(() => null) as {
      status?: 'running' | 'approval'
      sessionId?: string
      reply?: string
      approval?: ChannelApprovalSnapshot
      error?: string
    } | null
    if (!r.ok && r.status !== 202) throw new Error(data?.error || `席位 HTTP ${r.status}`)
    if (r.status !== 202) {
      if (!data?.sessionId) throw new Error('席位没有返回渠道会话 id')
      return { sessionId: data.sessionId, reply: String(data.reply || '').trim() || '已处理，但没有可发送的文本回复。' }
    }
    if (data?.status === 'approval' && data.approval?.key) await hooks.onApproval?.(data.approval)
    else hooks.onRunning?.()
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('席位处理渠道消息超时')
}

async function decideSeatApproval(
  db: Db,
  binding: NonNullable<Awaited<ReturnType<Db['channelBinding']>>>,
  approvalKey: string,
  decision: 'approve' | 'deny',
  scope: 'once' | 'turn',
): Promise<'ok' | 'gone'> {
  const access = await seatAccess(db, binding)
  const r = await fetch(`${access.host}/api/channels/${encodeURIComponent(binding.id)}/approvals/${encodeURIComponent(approvalKey)}`, {
    method: 'POST', headers: access.headers,
    body: JSON.stringify({ botId: binding.botId, decision, scope }),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await r.json().catch(() => null) as { error?: string } | null
  if (r.status === 409) return 'gone'
  if (!r.ok) throw new Error(data?.error || `席位 HTTP ${r.status}`)
  return 'ok'
}

function compactMarkdown(value: unknown, max: number): string {
  const chars = Array.from(String(value ?? '').replace(/```/g, "'''"))
  return chars.length <= max ? chars.join('') : `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

function quotedMarkdown(value: unknown): string {
  const text = String(value ?? '').replace(/\r\n?/g, '\n')
  if (!text) return '> （空）'
  return text.split('\n').map((line) => line ? `> ${line}` : '>').join('\n')
}

function emailApprovalDetails(fields: ChannelApprovalField[]): string {
  const body = fields.find((field) => field.multiline)
  const metadata = fields.filter((field) => field !== body).map((field) => {
    const label = compactMarkdown(field.label || field.key || '参数', 80).replace(/[*_`]/g, '')
    const value = compactMarkdown(field.value, 600).replace(/\s+/g, ' ').replace(/`/g, "'") || '（空）'
    return `- **${label}**：\`${value}\``
  })
  const sections = ['### 邮件内容']
  if (metadata.length) sections.push(metadata.join('\n'))
  sections.push(
    '',
    '### 正文',
    // 正文不截断。引用块既保留原始段落和列表，也把正文与审批说明清楚地区分开。
    quotedMarkdown(body?.value),
  )
  return sections.join('\n')
}

export function approvalMarkdown(approval: ChannelApprovalSnapshot): string {
  const tool = compactMarkdown(approval.form?.tool || approval.name || '未知操作', 160).replace(/`/g, "'")
  const fields = Array.isArray(approval.form?.fields) ? approval.form.fields : []
  const details = approval.form?.kind === 'email' && fields.length
    ? emailApprovalDetails(fields)
    : fields.length
    ? [
      ...fields.slice(0, 4).map((field) => {
      const label = compactMarkdown(field.label || field.key || '参数', 80).replace(/[*_`]/g, '')
      const value = compactMarkdown(field.value, field.multiline ? 400 : 200)
      return field.multiline ? `**${label}**\n\`\`\`text\n${value}\n\`\`\`` : `- **${label}**：\`${value.replace(/`/g, "'")}\``
      }),
      ...(fields.length > 4 ? [`_还有 ${fields.length - 4} 项参数，请在 Web 中查看完整内容。_`] : []),
    ].join('\n\n')
    : `\`\`\`json\n${compactMarkdown(approval.arguments || '{}', 2200)}\n\`\`\``
  const parameterSection = approval.form?.kind === 'email' && fields.length
    ? details
    : `**参数**\n${details}`
  return [
    '## 需要你的批准',
    '',
    compactMarkdown(approval.reason || 'Bot 准备执行一个需要确认的操作。', 600),
    '',
    `**操作**：\`${tool}\``,
    '',
    parameterSection,
    '',
    '请选择下面的批准范围。Telegram 暂不支持编辑参数；如需修改，请在 Web 中审批。',
  ].join('\n')
}

async function processOne(db: Db, key: Buffer, event: ChannelEvent): Promise<void> {
  const leaseToken = randomUUID()
  if (!await db.claimChannelEvent(event.id, Date.now(), Date.now() + EVENT_LEASE_MS, leaseToken)) return
  let renewing = false
  const renew = async () => {
    if (renewing) return
    renewing = true
    try {
      await db.renewChannelEventLease(event.id, leaseToken, Date.now() + EVENT_LEASE_MS)
    } catch (e) {
      // 数据库短抖时保留本地工作；fencing update 会阻止已经失去租约的进程提交。
      console.warn(`satuwork-gateway: 渠道事件 ${event.id} 续租失败：${(e as Error).message}`)
    } finally {
      renewing = false
    }
  }
  const renewTimer = setInterval(() => { void renew() }, EVENT_LEASE_RENEW_MS)
  renewTimer.unref?.()
  try {
    const current = await db.channelEvent(event.id)
    const binding = current ? await db.channelBinding(current.bindingId) : undefined
    if (!current) return
    if (!binding || binding.status !== 'active') {
      await db.updateClaimedChannelEvent(current.id, leaseToken, {
        status: 'pending', nextTryAt: Date.now(), leaseUntil: null,
      })
      return
    }
    let reply = current.reply
    let sessionId = current.sessionId
    const secret = decryptChannelSecret<StoredSecret>(key, binding.credentialCiphertext)
    try {
      if (!reply) {
        let typingWarned = false
        let stopTyping: (() => void) | null = null
        const startTyping = () => {
          if (stopTyping) return
          stopTyping = startTelegramTyping(secret.token, current.externalConversationId, {
            onError: (error) => {
              if (typingWarned) return
              typingWarned = true
              console.warn(`satuwork-gateway: Telegram 正在输入状态发送失败：${error.message}`)
            },
          })
        }
        const pauseTyping = () => {
          stopTyping?.()
          stopTyping = null
        }
        startTyping()
        let ran: Awaited<ReturnType<typeof runSeatTurn>>
        try {
          ran = await runSeatTurn(db, current, binding, {
            onRunning: startTyping,
            onApproval: async (approval) => {
              pauseTyping()
              const latest = await db.channelEvent(current.id)
              if (latest?.approvalKey === approval.key && latest.approvalMessageId != null) return
              const messageId = await telegramSendApproval(
                secret.token, current.externalConversationId, approvalMarkdown(approval), approval.key,
              )
              if (!await db.recordChannelApprovalPrompt(current.id, leaseToken, approval.key, messageId)) {
                throw new Error('渠道事件租约已经转交')
              }
            },
          })
        } finally {
          pauseTyping()
        }
        reply = ran.reply
        sessionId = ran.sessionId
        // AI 已经跑完，先把结果落盘，但继续持有租约。进程若在发送前崩溃，接管者只会
        // 重发这份 reply，绝不会再烧一轮模型。
        const saved = await db.updateClaimedChannelEvent(current.id, leaseToken, {
          status: 'processing', attempts: current.attempts, nextTryAt: Date.now(),
          sessionId, reply, lastError: null,
        })
        if (!saved) return
      }
      // 出站最多 20 秒；发送前把 30 秒窗口重新撑满，正常情况下不会被另一进程并发重发。
      if (!await db.renewChannelEventLease(current.id, leaseToken, Date.now() + EVENT_LEASE_MS)) return
      // 渠道只接受私聊，conversationId 就是唯一配对用户的 chat id。
      await telegramSendText(secret.token, current.externalConversationId, reply)
      const delivered = await db.updateClaimedChannelEvent(current.id, leaseToken, {
        status: 'delivered', attempts: current.attempts, nextTryAt: null, leaseUntil: null,
        sessionId, reply, lastError: null, deliveredAt: Date.now(),
      })
      if (delivered) await db.updateChannelBinding(binding.id, { lastError: null })
    } catch (e) {
      const attempts = current.attempts + 1
      const tg = e instanceof TelegramError ? e : null
      const dead = attempts >= MAX_ATTEMPTS || Boolean(tg?.permanent)
      const message = (e as Error).message.slice(0, 300)
      const updated = await db.updateClaimedChannelEvent(current.id, leaseToken, {
        status: dead ? 'dead' : 'retry', attempts,
        nextTryAt: dead ? null : Date.now() + (tg?.retryAfterMs || retryDelay(attempts)),
        leaseUntil: null, sessionId, reply, lastError: message,
      })
      if (updated) {
        await db.updateChannelBinding(binding.id, {
          ...(tg?.permanent ? { status: 'error' as const } : {}),
          lastError: message,
        })
      }
    }
  } finally {
    clearInterval(renewTimer)
  }
}

function rawUpdateId(raw: unknown): number | null {
  const n = Number(raw && typeof raw === 'object' ? (raw as { update_id?: unknown }).update_id : NaN)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

const APPROVAL_CALLBACK = /^swa:([A-Za-z0-9_-]{22}):(a1|at|d1|dt)$/

async function processTelegramApprovalCallback(
  db: Db,
  key: Buffer,
  binding: NonNullable<Awaited<ReturnType<Db['channelBinding']>>>,
  raw: unknown,
): Promise<boolean> {
  const callback = normalizeTelegramCallback(raw)
  if (!callback) return false
  const secret = decryptChannelSecret<StoredSecret>(key, binding.credentialCiphertext)
  /**
   * callback_query 是一次性、短时效的确认。审批本身已经有结果之后，给 Telegram 回提示
   * 只是 UI 收尾，失败绝不能让同一个 update 永远卡住 getUpdates offset。
   */
  const answer = async (text: string, showAlert = false) => {
    try {
      await telegramAnswerCallbackQuery(secret.token, callback.queryId, text, showAlert)
    } catch (e) {
      const error = e as Error
      console.warn(`satuwork-gateway: Telegram 回调 ${callback.queryId} 已无法应答，继续确认该 update：${error.message}`)
    }
  }
  const parsed = APPROVAL_CALLBACK.exec(callback.data)
  const identity = await db.channelIdentity(binding.id)
  if (!parsed || !identity || identity.externalUserId !== callback.remoteUserId || callback.chatId !== callback.remoteUserId) {
    await answer('你不能处理这条审批。', true)
    return true
  }
  const action = parsed[2]
  const decision = action.startsWith('a') ? 'approve' : 'deny'
  const scope = action.endsWith('t') ? 'turn' : 'once'
  let result: 'ok' | 'gone'
  try {
    result = await decideSeatApproval(db, binding, parsed[1], decision, scope)
  } catch (e) {
    console.warn(`satuwork-gateway: Telegram 审批失败：${(e as Error).message}`)
    await answer('审批失败，请重试。', true)
    return true
  }
  const message = result === 'gone'
    ? '这条审批已经结束。'
    : decision === 'approve' ? (scope === 'turn' ? '已批准这一轮。' : '已批准这一次。')
      : (scope === 'turn' ? '这一轮已拒绝同类操作。' : '已拒绝这一次。')
  await answer(message, result === 'gone')
  await telegramClearApprovalButtons(secret.token, callback.chatId, callback.messageId).catch(() => undefined)
  return true
}

async function processTelegramUpdate(db: Db, key: Buffer, binding: NonNullable<Awaited<ReturnType<Db['channelBinding']>>>, raw: unknown): Promise<void> {
  const live = await db.channelBinding(binding.id)
  if (!live || live.status !== 'active') return
  if (await processTelegramApprovalCallback(db, key, live, raw)) return
  const sharedChat = telegramJoinedSharedChat(raw)
  if (sharedChat) {
    // Telegram 没有 Bot API 可以全局关闭「被加群」；收到成员更新或群消息后立即退出。
    // 退出失败不能卡住 update 游标，否则后续合法私聊也会永远收不到。
    const secret = decryptChannelSecret<StoredSecret>(key, live.credentialCiphertext)
    try { await telegramLeaveChat(secret.token, sharedChat.chatId) }
    catch (e) { console.warn(`satuwork-gateway: Telegram 私人 Bot 退出 ${sharedChat.chatType} ${sharedChat.chatId} 失败：${(e as Error).message}`) }
    return
  }
  const message = normalizeTelegramUpdate(raw, live)
  if (!message) return
  const identity = await db.channelIdentity(binding.id)
  if (!identity) {
    // 配对只在私聊里受理，避免有人在群里把一次性口令公开贴出来。
    const matches = live.pairingCodeHash
      && timingSafeToken(pairingCodeHash(message.text), live.pairingCodeHash)
    if (message.chatType !== 'private' || !matches) {
      if (message.chatType === 'private') {
        const secret = decryptChannelSecret<StoredSecret>(key, live.credentialCiphertext)
        await telegramSendText(secret.token, message.chatId, '此 Bot 尚未配对。请在 Satuwork「渠道」页面复制配对码并发送到这里。')
      }
      return
    }
    const pairedToken = await db.tx(async () => {
      // 长轮询租约保证正常情况下只有一个消费者；事务内再读一次，挡住租约接管的极小窗口。
      await db.lockChannelBinding(binding.id)
      if (await db.channelIdentity(binding.id)) return ''
      const fresh = await db.channelBinding(binding.id)
      if (fresh?.status !== 'active' || !fresh.pairingCodeHash || !timingSafeToken(pairingCodeHash(message.text), fresh.pairingCodeHash)) return ''
      const secret = decryptChannelSecret<StoredSecret>(key, fresh.credentialCiphertext)
      await db.pairChannelIdentity({
        bindingId: binding.id, externalUserId: message.remoteUserId,
        externalUsername: String((raw as any)?.message?.from?.username || ''),
        externalDisplayName: message.remoteDisplayName, pairedEventId: message.externalEventId,
      })
      await db.updateChannelBinding(binding.id, {
        pairingCodeHash: '',
        credentialCiphertext: encryptChannelSecret(key, { ...secret, pairingCode: '' } satisfies StoredSecret),
        lastError: null,
      })
      return secret.token
    })
    if (pairedToken) await telegramSendText(pairedToken, message.chatId, '配对成功。现在可以直接给我发消息了。')
    return
  }
  // 同一个 bot 用户名可能被任何人搜到；只接受已配对 Telegram 身份发出的消息。
  if (identity.externalUserId !== message.remoteUserId) return
  // 配对成功回包之后进程崩溃时，Telegram 会重送那条口令。它不能进入模型。
  if (identity.pairedEventId === message.externalEventId) return
  const inserted = await db.tx(async () => {
    await db.lockChannelBinding(binding.id)
    const currentBinding = await db.channelBinding(binding.id)
    if (currentBinding?.status !== 'active') return null
    const stillPaired = await db.channelIdentityForUser(binding.id, message.remoteUserId)
    if (!stillPaired || stillPaired.pairedEventId === message.externalEventId) return null
    await db.touchChannelIdentity(stillPaired.id)
    return db.insertChannelEvent({
      bindingId: binding.id, externalEventId: message.externalEventId,
      externalConversationId: message.externalConversationId, remoteUserId: message.remoteUserId,
      remoteDisplayName: message.remoteDisplayName, title: message.title, text: message.text,
    })
  })
  if (!inserted) return
  await db.updateChannelBinding(binding.id, { lastReceivedAt: Date.now() })
  if (inserted.created) kickChannelDispatcher()
}

async function pollOne(db: Db, key: Buffer, candidate: Awaited<ReturnType<Db['channelBinding']>>): Promise<void> {
  if (!candidate) return
  const now = Date.now()
  if (!await db.claimChannelPoll(candidate.id, now, now + POLL_LEASE_MS)) return
  const binding = await db.channelBinding(candidate.id)
  if (!binding || binding.status !== 'active') return
  let nextOffset = binding.pollOffset
  try {
    const secret = decryptChannelSecret<StoredSecret>(key, binding.credentialCiphertext)
    if (!commandsConfigured.has(binding.id)) {
      try {
        await telegramSetMyCommands(secret.token)
        commandsConfigured.add(binding.id)
      } catch (e) {
        // 菜单只是发现入口，命令解析本身仍然可用；不能因为它暂时失败就停收消息。
        console.warn(`satuwork-gateway: Telegram 命令菜单注册失败：${(e as Error).message}`)
      }
    }
    const updates = await telegramGetUpdates(secret.token, binding.pollOffset, POLL_TIMEOUT_SECONDS)
    for (const raw of updates) {
      const updateId = rawUpdateId(raw)
      if (updateId == null || updateId < nextOffset) continue
      try {
        await processTelegramUpdate(db, key, binding, raw)
      } catch (e) {
        const tg = e instanceof TelegramError ? e : null
        if (!tg || tg.retryable) throw e
        /**
         * 一条 update 引发了不可重试的 Telegram 4xx。原样重放不会变好，反而会把它后面
         * 所有私聊永久堵死（过期 callback_query 就是线上这次事故）。跳过的是这一个
         * update，不是整个 binding；401/403 若真是 token 失效，下一次 getUpdates 会在
         * 外层被识别并把渠道标红。
         */
        console.warn(
          `satuwork-gateway: Telegram update ${updateId} 的 ${tg.method || 'API 调用'} 不可重试，` +
            `跳过毒消息继续收取后续 update：${tg.message}`,
        )
      }
      nextOffset = updateId + 1
      // 每条处理完就落游标：后面某条失败时，前面的不会跟着重放。
      await db.advanceChannelPollOffset(binding.id, nextOffset)
    }
    await db.finishChannelPoll(binding.id, { pollOffset: nextOffset, pollLastError: null })
  } catch (e) {
    const tg = e instanceof TelegramError ? e : null
    await db.finishChannelPoll(binding.id, {
      pollOffset: nextOffset, pollLastError: (e as Error).message.slice(0, 300),
      nextPollAt: tg?.permanent ? null : Date.now() + Math.min(5 * 60_000, Math.max(POLL_RETRY_MS, tg?.retryAfterMs ?? 0)),
      ...(tg?.permanent ? { status: 'error' as const, lastError: (e as Error).message.slice(0, 300) } : {}),
    })
  }
}

export function startChannelDispatcher(db: Db, key: Buffer): () => void {
  let scanning = false
  let stopped = false
  const activeEvents = new Set<string>()
  const tick = () => {
    if (scanning || stopped) return
    scanning = true
    void db.dueChannelEvents(Date.now(), 10)
      .then((events) => {
        for (const event of events) {
          if (activeEvents.has(event.id)) continue
          activeEvents.add(event.id)
          // 扫描只负责派活，不等最长二十分钟的模型轮次。一个慢会话不能挡住其它渠道
          // 或其它会话的新消息；同一远端会话的顺序仍由 dueChannelEvents 的前驱条件保证。
          void processOne(db, key, event)
            .catch((e: Error) => console.error(`satuwork-gateway: 渠道事件 ${event.id} 处理失败：${e.message}`))
            .finally(() => activeEvents.delete(event.id))
        }
      })
      .catch((e: Error) => console.error(`satuwork-gateway: 渠道投递扫描失败：${e.message}`))
      .finally(() => { scanning = false })
  }
  wakeCurrent = tick
  const timer = setInterval(tick, TICK_MS)
  timer.unref?.()
  let polling = false
  const poll = () => {
    if (polling || stopped) return
    polling = true
    void db.dueChannelPolls(Date.now(), 10)
      .then((bindings) => Promise.all(bindings.map((binding) => pollOne(db, key, binding))))
      .catch((e: Error) => console.error(`satuwork-gateway: Telegram 长轮询失败：${e.message}`))
      .finally(() => { polling = false })
  }
  const pollTimer = setInterval(poll, POLL_SCAN_MS)
  pollTimer.unref?.()
  tick()
  poll()
  return () => {
    stopped = true
    clearInterval(timer)
    clearInterval(pollTimer)
    if (wakeCurrent === tick) wakeCurrent = null
  }
}
