/**
 * 公司密钥、会话索引与按需拉全文、审计流水。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { PULL_ERROR, pullSessionEvents } from '../lib/machines.ts'
import { companyMachineOf } from '../deploy.ts'
import { intField } from '../lib/validate.ts'
import { publicPlatformCred, publicSessionIndex, sessionCursorOf } from '../lib/org.ts'
import { rangeQuery, requireOrg, requireUser } from '../lib/guards.ts'
import { seatBearer } from '../lib/runtime.ts'
import { sessionPageLimit } from '../db.ts'

export function attachSessions(router: Router, ctx: RouteCtx) {
  const { db, keys } = ctx

  // ── 公司密钥。列表/详情只回 configured: true ────────────────────────

  router.get('/orgs/:id/credentials', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    json(res, 200, { credentials: (await db.platformCredentials()).map(publicPlatformCred) })
  })

  router.post('/orgs/:id/credentials', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '供应商由系统管理员配置')
  })

  router.get('/orgs/:id/credentials/:credId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const provider = req.params.credId.startsWith('platform:') ? req.params.credId.slice('platform:'.length) : req.params.credId
    const row = await db.platformCredential(provider)
    if (!row) throw new HttpError(404, '密钥不存在')
    json(res, 200, { credential: publicPlatformCred(row) })
  })

  router.put('/orgs/:id/credentials/:credId', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '供应商由系统管理员配置')
  })

  router.delete('/orgs/:id/credentials/:credId', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '供应商由系统管理员配置')
  })

  // ── 会话索引 / 按需拉全文。Gateway 只存指针，正文留在机器上。────────

  router.get('/orgs/:id/sessions', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const accountId = (req.query.get('accountId') || '').trim()
    const botId = (req.query.get('botId') || '').trim()
    const range = rangeQuery(req)
    const limit = sessionPageLimit(intField({ limit: req.query.get('limit') ?? undefined }, 'limit'))
    const before = sessionCursorOf(req.query.get('cursor'))
    // 多取一条来判断后面还有没有。静默截断比没有上限还糟：调用方看到的是一份「看起来
    // 很完整」的列表，然后据此得出「这些会话不存在」的结论。
    const rows = await db.listSessionIndex(company.id, {
      accountId: accountId || undefined,
      botId: botId || undefined,
      from: range.from,
      to: range.to,
      limit: limit + 1,
      before,
    })
    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    const nextCursor = hasMore && last ? `${last.updatedAt}:${last.sessionId}` : null
    // 名字一次性查齐，不要每行两次。
    const names = {
      accounts: new Map((await db.accountsOf(company.id)).map((a) => [a.id, a])),
      bots: new Map((await db.visibleCatalog('bot', company.id)).map((b) => [b.id, b])),
    }
    json(res, 200, {
      sessions: await Promise.all(page.map((row) => publicSessionIndex(db, row, names))),
      limit,
      hasMore,
      nextCursor,
    })
  })

  router.get('/orgs/:id/sessions/:sessionId', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const row = await db.sessionIndex(req.params.sessionId)
    if (!row || row.companyId !== company.id) throw new HttpError(404, '会话不存在')
    const session = await publicSessionIndex(db, row)
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'session.pull',
      detail: { sessionId: row.sessionId },
    })
    const machineId = row.machineId || company.machineId
    const machine = machineId ? await db.machine(machineId) : await companyMachineOf(db, company.id)
    const instance = row.botId ? await db.instance(row.accountId, row.botId) : undefined
    const host = (instance?.host || machine?.host || '').trim()
    if (!host) {
      json(res, 200, { session, events: null, pullError: PULL_ERROR })
      return
    }
    const pulled = await pullSessionEvents(host, row.sessionId, {
      seat: await seatBearer(db, row.accountId),
      machine: machine?.token || '',
    })
    if (!pulled.ok) {
      json(res, 200, { session, events: null, pullError: PULL_ERROR })
      return
    }
    json(res, 200, { session, events: pulled.events })
  })

  router.get('/orgs/:id/audit', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    json(res, 200, {
      events: (await db.auditsOf(req.params.id)).map((e) => ({
        id: e.id,
        accountId: e.accountId,
        action: e.action,
        detail: e.detail,
        createdAt: e.createdAt,
      })),
    })
  })
}
