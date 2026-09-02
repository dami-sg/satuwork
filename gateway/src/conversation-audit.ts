/** 自动对话审计的窗口调度、席位派发与 Bot 删除状态机。 */
import type { Db, ConversationAuditBatch, ConversationAuditSettings } from './db.ts'
import { createHash } from 'node:crypto'
import { fromZoned, partsIn } from './lib/schedule.ts'
import { machineHeader, seatBearer } from './lib/runtime.ts'
import { purgeBot } from './deploy.ts'

const GRACE_MS = Math.max(0, Math.trunc(Number(process.env.GATEWAY_AUDIT_GRACE_MS ?? 5 * 60_000)))
const LEASE_MS = Math.max(60_000, Math.trunc(Number(process.env.GATEWAY_AUDIT_LEASE_MS ?? 10 * 60_000)))
const QUIET_MS = 5 * 60_000
const FORCE_ABORT_MS = 2 * 60_000
const DISPATCH_LIMIT = 20
const RETRIES = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]
let lastPruneAt = 0

function addDays(y: number, mo: number, d: number, n: number) {
  const at = new Date(Date.UTC(y, mo - 1, d + n))
  return { year: at.getUTCFullYear(), month: at.getUTCMonth() + 1, day: at.getUTCDate() }
}

/** 最近若干个已关闭的 8 小时窗口，旧到新。 */
export function closedAuditWindows(tz: string, now = Date.now(), count = 24): { start: number; end: number }[] {
  // 先让 Intl 验时区；非法值要在设置接口被挡，这里仍不能让整个调度 tick 崩掉。
  const p = partsIn(tz, now)
  const boundaries: number[] = []
  const daysBack = Math.ceil(Math.max(3, count) / 3) + 3
  for (let delta = -daysBack; delta <= 2; delta++) {
    const day = addDays(p.year, p.month, p.day, delta)
    for (const hour of [1, 9, 17]) boundaries.push(fromZoned(tz, day.year, day.month, day.day, hour, 0))
  }
  boundaries.sort((a, b) => a - b)
  const cutoff = now - GRACE_MS
  const out: { start: number; end: number }[] = []
  for (let i = 1; i < boundaries.length; i++) {
    if (boundaries[i]! <= cutoff) out.push({ start: boundaries[i - 1]!, end: boundaries[i]! })
  }
  return out.slice(-Math.max(1, count))
}

function pickedModel(platform: Awaited<ReturnType<Db['platformSettings']>>, settings: ConversationAuditSettings) {
  const role = settings.modelRole
  const picked = platform[role]
  if (!picked.provider || !picked.model) return null
  return { role, provider: picked.provider, model: picked.model, reasoningEffort: picked.reasoningEffort }
}

function emptyResult(fromSeq: number) {
  const sourceHash = createHash('sha256').update('').digest('hex')
  const canonical = JSON.stringify({
    fromSeq,
    toSeq: fromSeq,
    eventCount: 0,
    turnCount: 0,
    sourceHash,
    items: [],
  })
  return {
    sourceHash,
    resultHash: createHash('sha256').update(canonical).digest('hex'),
  }
}

async function createScheduledBatches(db: Db, now = Date.now()): Promise<number> {
  const platform = await db.platformSettings()
  let created = 0
  for (const company of await db.companies()) {
    const settings = (await db.settings(company.id)).conversationAudit
    if (!settings.enabled) continue
    let windows: { start: number; end: number }[]
    try {
      // 停机后的缺口补到保留期边界；更老的摘要即使生成也会立刻过期，没有回填价值。
      windows = closedAuditWindows(settings.timezone, now, settings.retentionDays * 3 + 3)
    } catch (e) {
      console.error(`satuwork-gateway: 公司 ${company.id} 的审计时区不可用：${(e as Error).message}`)
      continue
    }
    const latest = windows.at(-1)
    if (!latest) continue
    for (const target of await db.conversationAuditTargets(company.id)) {
      const coverage = await db.conversationAuditCoverage(target.accountId, target.botId || '')
      // 第一次启用不回填整段历史，只从最近刚关闭的窗口开始；一旦有水位，停机期间的缺口全补。
      const eligible = coverage.windowEnd
        ? windows.filter((w) => w.end > coverage.windowEnd)
        : [latest]
      // 同一 pair 串行推进水位；后一个窗口不能拿着前一个尚未确认的 fromSeq 抢跑。
      for (const window of eligible.slice(0, 1)) {
        const before = await db.conversationAuditCoverage(target.accountId, target.botId || '')
        // session_index 会在用户消息和 turn/end 时更新。若它在整段窗口里都没有动过，
        // 这个窗口不可能有新对话；messageCount=0 则连首次启用也可以直接判空。
        // 仍落一个 empty 水位，避免 Gateway 重启后反复检查同一窗口，但不派发 Bot、
        // 不读会话正文，也不会产生模型调用。删除前终审不走这里，不能被该优化绕过。
        const skipEmpty = target.messageCount === 0 || target.updatedAt < window.start
        const model = pickedModel(platform, settings)
        if (!model && !skipEmpty) {
          console.error(`satuwork-gateway: 公司 ${company.id} 的审计模型 ${settings.modelRole} 尚未配置`)
          continue
        }
        const selected = model ?? {
          role: settings.modelRole,
          provider: platform[settings.modelRole].provider,
          model: platform[settings.modelRole].model,
          reasoningEffort: platform[settings.modelRole].reasoningEffort,
        }
        const batch = await db.insertConversationAuditBatch({
          companyId: company.id,
          accountId: target.accountId,
          botId: target.botId || '',
          sessionId: target.sessionId,
          kind: 'scheduled',
          windowStart: window.start,
          windowEnd: window.end,
          timezone: settings.timezone,
          fromSeq: before.toSeq,
          modelRole: selected.role,
          provider: selected.provider,
          model: selected.model,
          reasoningEffort: selected.reasoningEffort,
          promptVersion: settings.promptVersion,
        })
        if (batch.createdAt >= now - 1000) created++
        if (skipEmpty && batch.status === 'queued' && batch.attempts === 0) {
          const hashes = emptyResult(before.toSeq)
          const account = await db.account(target.accountId)
          const bot = await db.catalog(target.botId || '')
          await db.completeConversationAuditBatch({
            id: batch.id,
            status: 'empty',
            fromSeq: before.toSeq,
            toSeq: before.toSeq,
            eventCount: 0,
            turnCount: 0,
            sourceHash: hashes.sourceHash,
            resultHash: hashes.resultHash,
            botName: bot?.name || target.botId || '',
            accountName: account?.name || account?.email || target.accountId,
            retentionDays: settings.retentionDays,
            items: [],
          })
        }
      }
    }
  }
  return created
}

async function targetHeaders(db: Db, batch: ConversationAuditBatch) {
  const instance = await db.instance(batch.accountId, batch.botId)
  if (!instance?.host) throw new Error('实例还没上线')
  const seat = await db.seatRuntime(batch.accountId, batch.botId)
  const machine = seat?.machineId ? await db.machine(seat.machineId) : undefined
  const bearer = await seatBearer(db, batch.accountId)
  if (!bearer) throw new Error('席位凭证不存在')
  return {
    url: `${instance.host.replace(/\/$/, '')}/api/audit-jobs/${encodeURIComponent(batch.id)}`,
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      ...machineHeader(machine?.token || undefined),
    },
  }
}

async function dispatchBatch(db: Db, batch: ConversationAuditBatch): Promise<void> {
  const target = await targetHeaders(db, batch)
  const deletion = batch.deletionRequestId ? await db.botDeletion(batch.deletionRequestId) : undefined
  const r = await fetch(target.url, {
    method: 'POST',
    headers: target.headers,
    body: JSON.stringify({
      id: batch.id,
      sessionId: batch.sessionId,
      botId: batch.botId,
      kind: batch.kind,
      windowStart: batch.windowStart,
      windowEnd: batch.windowEnd,
      timezone: batch.timezone,
      fromSeq: batch.fromSeq,
      modelRole: batch.modelRole,
      provider: batch.provider,
      model: batch.model,
      reasoningEffort: batch.reasoningEffort,
      promptVersion: batch.promptVersion,
      quiesceMs: batch.kind === 'pre_delete' ? QUIET_MS : 0,
      forceAbort: Boolean(deletion && Date.now() - deletion.requestedAt >= FORCE_ABORT_MS),
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`席位返回 HTTP ${r.status}${body ? ` ${body.slice(0, 160)}` : ''}`)
  }
  await db.markConversationAuditProcessing(batch.id, Date.now() + LEASE_MS)
}

async function dispatchDueBatches(db: Db): Promise<number> {
  let dispatched = 0
  for (let i = 0; i < DISPATCH_LIMIT; i++) {
    const batch = await db.claimConversationAuditBatch(Date.now(), LEASE_MS)
    if (!batch) break
    try {
      await dispatchBatch(db, batch)
      dispatched++
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      const retry = RETRIES[Math.min(batch.attempts - 1, RETRIES.length - 1)]!
      // 自动审计不能在第八次失败后永久静默；封顶为每小时重试，直到席位或模型恢复。
      // dead 只留给“删除终审已经接管了这个普通批次”的明确终止情形。
      await db.retryConversationAuditBatch(batch.id, message, Date.now() + retry, false)
    }
  }
  return dispatched
}

/** 每个 Gateway tick 调一次。 */
export async function tickConversationAudits(db: Db): Promise<{ created: number; dispatched: number }> {
  const now = Date.now()
  if (now - lastPruneAt >= 60 * 60_000) {
    await db.deleteExpiredConversationAudits(now)
    lastPruneAt = now
  }
  const created = await createScheduledBatches(db, now)
  const dispatched = await dispatchDueBatches(db)
  return { created, dispatched }
}

async function createDeletionBatches(db: Db, request: Awaited<ReturnType<Db['botDeletion']>> & object): Promise<number> {
  const targets = await db.conversationAuditTargets(undefined, request.botId, true)
  const platform = await db.platformSettings()
  // 没有主会话也留下一笔明确的 empty 终审。物理删除的数据库防线要求终审批次必须存在，
  // 因此“这颗 Bot 从未对话过”是可核验的结论，而不是绕过审计状态机的特殊通道。
  if (!targets.length) {
    const settings = (await db.settings(request.companyId)).conversationAudit
    const picked = platform[settings.modelRole]
    const accountId = request.accountId || request.requestedBy
    const account = await db.account(accountId)
    const batch = await db.insertConversationAuditBatch({
      companyId: request.companyId,
      accountId,
      botId: request.botId,
      sessionId: '',
      deletionRequestId: request.id,
      kind: 'pre_delete',
      windowStart: 0,
      windowEnd: request.cutoffAt,
      timezone: settings.timezone,
      fromSeq: 0,
      modelRole: settings.modelRole,
      provider: picked.provider,
      model: picked.model,
      reasoningEffort: picked.reasoningEffort,
      promptVersion: settings.promptVersion,
    })
    const sourceHash = createHash('sha256').update('').digest('hex')
    const resultHash = createHash('sha256').update(JSON.stringify({ empty: true, sourceHash })).digest('hex')
    await db.completeConversationAuditBatch({
      id: batch.id, status: 'empty', fromSeq: 0, toSeq: 0, eventCount: 0, turnCount: 0,
      sourceHash, resultHash, botName: request.botNameSnapshot,
      accountName: account?.name || account?.email || accountId,
      retentionDays: settings.retentionDays, items: [],
    })
    return 1
  }
  let count = 0
  for (const target of targets) {
    const settings = (await db.settings(target.companyId)).conversationAudit
    const model = pickedModel(platform, settings)
    if (!model) throw new Error(`公司 ${target.companyId} 的审计模型 ${settings.modelRole} 尚未配置`)
    const coverage = await db.conversationAuditCoverage(target.accountId, request.botId)
    await db.insertConversationAuditBatch({
      companyId: target.companyId,
      accountId: target.accountId,
      botId: request.botId,
      sessionId: target.sessionId,
      deletionRequestId: request.id,
      kind: 'pre_delete',
      windowStart: coverage.windowEnd || 0,
      windowEnd: request.cutoffAt,
      timezone: settings.timezone,
      fromSeq: coverage.toSeq,
      modelRole: model.role,
      provider: model.provider,
      model: model.model,
      reasoningEffort: model.reasoningEffort,
      promptVersion: settings.promptVersion,
    })
    count++
  }
  return count
}

async function advanceDeletion(db: Db, request: NonNullable<Awaited<ReturnType<Db['botDeletion']>>>): Promise<void> {
  try {
    if (request.status === 'freezing' || request.status === 'failed') {
      const count = await createDeletionBatches(db, request)
      if (!count) {
        await db.updateBotDeletion(request.id, { status: 'ready_to_purge', targetCount: 0, auditedCount: 0, nextTryAt: Date.now() })
      } else {
        await db.updateBotDeletion(request.id, { status: 'auditing', targetCount: count, lastError: null, nextTryAt: Date.now() + 5000 })
      }
      return
    }
    if (request.status === 'auditing') {
      const batches = await db.conversationAuditBatchesOfDeletion(request.id)
      const done = batches.filter((b) => b.status === 'succeeded' || b.status === 'empty').length
      if (done < batches.length) {
        await db.updateBotDeletion(request.id, { auditedCount: done, nextTryAt: Date.now() + 5000 })
        return
      }
      await db.updateBotDeletion(request.id, {
        status: 'ready_to_purge', auditedCount: done, auditCompletedAt: Date.now(), nextTryAt: Date.now(),
      })
      return
    }
    if (request.status === 'ready_to_purge' || request.status === 'purging') {
      await db.updateBotDeletion(request.id, { status: 'purging', attempts: request.attempts + 1, nextTryAt: Date.now() + 60_000 })
      const { released, failed } = await purgeBot(db, request.botId)
      const orphans = failed.map((f) => ({ seatId: f.seat.seatId, error: f.error }))
      await db.updateBotDeletion(request.id, {
        status: 'completed', orphans, deletedAt: Date.now(), nextTryAt: null, lastError: null,
      })
      await db.audit({
        companyId: request.companyId,
        accountId: request.requestedBy,
        action: 'bot.delete.completed',
        detail: { requestId: request.id, botId: request.botId, seats: released.length, orphans },
      })
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    await db.updateBotDeletion(request.id, {
      status: 'failed', attempts: request.attempts + 1, lastError: message.slice(0, 500), nextTryAt: Date.now() + 60_000,
    })
  }
}

export async function tickBotDeletions(db: Db): Promise<number> {
  const rows = await db.dueBotDeletions()
  for (const row of rows) await advanceDeletion(db, row)
  return rows.length
}

export async function requestBotDeletion(db: Db, input: {
  companyId: string
  accountId?: string | null
  botId: string
  botName: string
  requestedBy: string
}) {
  const existing = await db.liveBotDeletion(input.botId)
  if (existing) return existing
  const request = await db.createBotDeletion(input)
  await db.audit({
    companyId: input.companyId,
    accountId: input.requestedBy,
    action: 'bot.delete.requested',
    detail: { requestId: request.id, botId: input.botId, name: input.botName },
  })
  // 不等下一次 30 秒 tick，至少同步建好终审批次；真正联系席位和调用模型仍在后台跑。
  await advanceDeletion(db, request)
  let current = (await db.botDeletion(request.id))!
  const batches = await db.conversationAuditBatchesOfDeletion(request.id)
  const seats = await db.seatRuntimesOfBot(input.botId)
  // 从未有会话、也没有席位的 Bot 不需要人为等两个 scheduler tick：empty 终审已经落库，
  // 直接把状态机走完。它仍然经过同一条数据库删除防线，不是兼容旧接口的旁路。
  if (batches.length === 1 && batches[0]?.sessionId === '' && batches[0].status === 'empty') {
    await db.updateBotDeletion(current.id, { nextTryAt: Date.now() })
    await advanceDeletion(db, (await db.botDeletion(current.id))!)
    current = (await db.botDeletion(current.id))!
    await db.updateBotDeletion(current.id, { nextTryAt: Date.now() })
    await advanceDeletion(db, (await db.botDeletion(current.id))!)
    current = (await db.botDeletion(current.id))!
    return { ...current, releasedSeats: Math.max(0, seats.length - current.orphans.length) }
  }
  return current
}
