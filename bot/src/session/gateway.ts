import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { gatewayToken, gatewayUrl } from '../llm/gateway.ts'
import type { SessionEvent, SessionOrigin, Usage } from './types.ts'

export const name = 'satu-session-gateway'
export const inject = ['server', 'sessions', 'catalog', 'storage']

function pinnedBotId(): string {
  return (process.env.SATUWORK_BOT_ID || '').trim()
}

function bearer(header: string | null): string | undefined {
  if (!header?.startsWith('Bearer ')) return
  const token = header.slice(7).trim()
  return token || undefined
}

function timingSafeToken(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const OUTBOX = 'gateway-outbox'
const READY_CAP_MS = 30_000

type OutboxItem =
  | { kind: 'index'; sessionId: string; createdAt: number; attempts: number; lastError?: string }
  | {
      kind: 'usage'
      accountId?: string
      provider: string
      model: string
      promptTokens: number
      completionTokens: number
      botId: string | null
      createdAt: number
      attempts: number
      lastError?: string
    }

/**
 * 给 Gateway 拉全文，以及把会话索引报到控制面。
 *
 * 正文只活在本机 JSONL。上报失败落本地队列重试，不能挡住聊天。
 */
export function apply(ctx: Context) {
  ctx.server.get('/internal/sessions/:sessionId', async (req, res) => {
    const token = bearer(req.headers.get('authorization'))
    // 只认席位票。Gateway 拉全文时在 authorization 上带的就是这一把（管家那一跳认的是
    // 另一个头 x-satuwork-machine），所以不需要再认机器票。
    const seat = gatewayToken()
    const ok = Boolean(token) && Boolean(seat) && timingSafeToken(token!, seat)
    if (!ok) {
      res.status = 404
      return res.json({ error: 'not found' })
    }
    try {
      const events = await ctx.sessions.events(req.params.sessionId)
      return res.json({ events })
    } catch {
      res.status = 404
      return res.json({ error: 'not found' })
    }
  })

  let me: { accountId: string; companyId: string; machineId: string | null; at: number } | null = null
  let fetchingMe: Promise<typeof me> | null = null
  const outbox = ctx.storage.collection<OutboxItem>(OUTBOX)
  let flushing = false

  async function loadMe(): Promise<typeof me> {
    const base = gatewayUrl()
    const token = gatewayToken()
    if (!base || !token) return null
    try {
      const r = await fetch(base + '/me', {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(8000),
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const body = (await r.json()) as {
        account?: { id?: string }
        company?: { id?: string; machineId?: string | null }
      }
      const accountId = typeof body.account?.id === 'string' ? body.account.id : ''
      const companyId = typeof body.company?.id === 'string' ? body.company.id : ''
      if (!accountId || !companyId) return null
      // machineId 只从 GET /me 的 company.machineId 取。sat_ 调 /orgs/:id/machine 会 401。
      const machineId = typeof body.company?.machineId === 'string' ? body.company.machineId : null
      return { accountId, companyId, machineId, at: Date.now() }
    } catch (e) {
      ctx.logger?.warn?.(`session index: /me 失败 ${(e as Error).message}`)
      return null
    }
  }

  async function cachedMe() {
    if (me && Date.now() - me.at < 60_000) return me
    if (!fetchingMe) {
      fetchingMe = loadMe().then((row) => {
        me = row
        fetchingMe = null
        return row
      })
    }
    return fetchingMe
  }

  function configured(): boolean {
    return Boolean(gatewayUrl() && gatewayToken())
  }

  async function postInternal(path: string, body: unknown): Promise<void> {
    const base = gatewayUrl()
    // 用席位票上报。Gateway 侧的 requireInternalCaller 认 `sat_`，并且**只允许它报自己
    // 这个账号**——body 里的 accountId 对席位票不作数。
    const token = gatewayToken()
    if (!base || !token) throw new Error('未配置 GATEWAY_URL / GATEWAY_TOKEN')
    const r = await fetch(base + path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    })
    if (!r.ok) {
      const text = await r.text().catch(() => '')
      throw new Error(`HTTP ${r.status}${text ? ` ${text.slice(0, 120)}` : ''}`)
    }
  }

  function enqueue(item: OutboxItem) {
    outbox.put(randomUUID(), item)
    void flushOutbox()
  }

  async function flushOutbox() {
    if (flushing || !configured()) return
    flushing = true
    try {
      for (const row of outbox.list()) {
        try {
          if (row.value.kind === 'index') {
            await sendIndex(row.value.sessionId)
          } else {
            const who = await cachedMe()
            if (!who) throw new Error('/me 未就绪')
            await postInternal('/internal/usage', {
              accountId: row.value.accountId || who.accountId,
              provider: row.value.provider,
              model: row.value.model,
              promptTokens: row.value.promptTokens,
              completionTokens: row.value.completionTokens,
              botId: row.value.botId,
            })
          }
          outbox.delete(row.id)
        } catch (e) {
          outbox.put(row.id, {
            ...row.value,
            attempts: row.value.attempts + 1,
            lastError: (e as Error).message,
          })
          if (row.value.attempts + 1 === 1 || (row.value.attempts + 1) % 8 === 0) {
            ctx.logger?.warn?.(`gateway outbox: ${row.value.kind} 重试失败 ${(e as Error).message}`)
          }
        }
      }
    } finally {
      flushing = false
    }
  }

  async function sendIndex(sessionId: string) {
    const who = await cachedMe()
    if (!who) throw new Error('/me 未就绪')
    const events = await ctx.sessions.events(sessionId)
    const root = events.find((e) => e.type === 'session')
    if (!root) throw new Error('没有 session 根事件')
    const titled = [...events].reverse().find((e) => e.type === 'session/title')
    const data = root.data as {
      title?: string
      createdAt: number
      botId?: string
      origin?: SessionOrigin
      remoteId?: string
    }
    const title = (titled?.data as { title?: string } | undefined)?.title ?? data.title ?? null
    // messageCount：用户+助手消息条数（不含 tool/chunk/turn 信封）。
    const messageCount = events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message').length
    await postInternal('/internal/sessions/index', {
      sessionId,
      companyId: who.companyId,
      accountId: who.accountId,
      botId: data.botId || null,
      origin: data.origin || null,
      remoteId: data.remoteId ?? null,
      machineId: who.machineId,
      title,
      createdAt: data.createdAt,
      updatedAt: Date.now(),
      messageCount,
    })
  }

  async function report(sessionId: string) {
    if (!configured()) return
    try {
      await sendIndex(sessionId)
    } catch (e) {
      ctx.logger?.warn?.(`session index: 上报失败 ${(e as Error).message}`)
      enqueue({ kind: 'index', sessionId, createdAt: Date.now(), attempts: 0, lastError: (e as Error).message })
    }
  }

  async function reportUsage(sessionId: string, turn: number) {
    if (!configured()) return
    const events = await ctx.sessions.events(sessionId)
    const root = events.find((e) => e.type === 'session')
    const botId = (root?.data as { botId?: string } | undefined)?.botId || pinnedBotId() || null
    let promptTokens = 0
    let completionTokens = 0
    for (const ev of events) {
      if (ev.type !== 'assistant/message') continue
      if ((ev.data as { turn: number }).turn !== turn) continue
      const usage = (ev.data as { usage?: Usage }).usage
      promptTokens += usage?.inputTokens ?? 0
      completionTokens += usage?.outputTokens ?? 0
    }
    // 没有真实 token 就不报，避免把 0 当成用量。
    if (promptTokens <= 0 && completionTokens <= 0) return
    const header = [...events]
      .reverse()
      .find((e) => e.type === 'request/header' && (e.data as { turn: number }).turn === turn)
    const provider = header ? String((header.data as { provider?: string }).provider || '') : ''
    const model = header ? String((header.data as { model?: string }).model || '') : ''
    if (!provider || !model) return
    const who = await cachedMe()
    const body = {
      accountId: who?.accountId,
      provider,
      model,
      promptTokens,
      completionTokens,
      botId,
    }
    try {
      if (!who) throw new Error('/me 未就绪')
      await postInternal('/internal/usage', { ...body, accountId: who.accountId })
    } catch (e) {
      ctx.logger?.warn?.(`usage: 上报失败 ${(e as Error).message}`)
      enqueue({
        kind: 'usage',
        ...body,
        createdAt: Date.now(),
        attempts: 0,
        lastError: (e as Error).message,
      })
    }
  }

  ctx.on('session/event', (sessionId: string, event: SessionEvent) => {
    if (
      event.type === 'session' ||
      event.type === 'user/message' ||
      event.type === 'session/title' ||
      event.type === 'turn/end'
    ) {
      void report(sessionId)
    }
    if (event.type === 'turn/end') {
      void reportUsage(sessionId, event.data.turn)
    }
  })

  const flushTimer = setInterval(() => void flushOutbox(), 5000)
  ctx.effect(() => () => clearInterval(flushTimer))

  async function announceReady() {
    const base = gatewayUrl()
    const botId = pinnedBotId()
    if (!base || !gatewayToken() || !botId) return
    if (!ctx.catalog.pinSucceeded) {
      const ok = await ctx.catalog.pull()
      if (!ok || !ctx.catalog.pinSucceeded) throw new Error('目录尚未钉住 SATUWORK_BOT_ID')
    }
    const who = await cachedMe()
    if (!who) throw new Error('/me 未就绪')
    const host = String(ctx.server.baseUrl || '').replace(/\/$/, '')
    if (!host) throw new Error('server.baseUrl 为空')
    await postInternal(`/internal/instances/${encodeURIComponent(who.accountId)}/ready`, { host, botId })
  }

  const botId = pinnedBotId()
  if (!botId) {
    if (gatewayUrl() && gatewayToken()) {
      ctx.logger?.warn?.('instance ready: 未设 SATUWORK_BOT_ID，不上报 ready')
    }
    return
  }

  const started = Date.now()
  let delay = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const tick = () => {
    if (stopped) return
    void announceReady().catch((e: Error) => {
      ctx.logger?.warn?.(`instance ready 失败 ${e.message}`)
      const elapsed = Date.now() - started
      if (elapsed >= READY_CAP_MS) {
        ctx.logger?.warn?.('instance ready: 已超过 30 秒仍未钉住目录或上报，停止重试')
        return
      }
      delay = delay === 0 ? 400 : Math.min(3000, Math.max(400, delay * 2))
      const wait = Math.min(delay, READY_CAP_MS - elapsed)
      timer = setTimeout(tick, wait)
    })
  }
  timer = setTimeout(tick, 0)
  ctx.effect(() => () => {
    stopped = true
    if (timer) clearTimeout(timer)
  })
}
