/**
 * 一家公司自己的那一摊：资料、模型角色、员工与分组、订阅、账单、用量、机器。
 */
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { INVITE_TTL, MIN_PASSWORD, RESET_LINK_TTL, hashPassword } from '../crypto.ts'
import { accessUrlFor } from '../lib/catalog.ts'
import { balanceOf } from '../lib/billing.ts'
import { bodyOf, deployOptsOf, strField, usd } from '../lib/validate.ts'
import { companyMachineOf, deploySeat, listSeatRuntime, publicMachine, publicSeatRuntime, releaseSeats } from '../deploy.ts'
import { companyStatusOf, emailOf, groupRoleOf, membersInCompany, phoneOf, publicAccount, publicCompany, publicGroup, publicPlan, publicSettings, roleOf, slugOf, stringIds, websiteOf } from '../lib/org.ts'
import { desktopTicketFor, machineHostOf, machineHostResolver } from '../lib/machines.ts'
import { inviteLinkOf, issueInvite, losingAdmin, rangeQuery, requireOrg, requireOwner, requireUser, statusOf, usagePayload } from '../lib/guards.ts'
import { randomUUID } from 'node:crypto'
import { type AccountStatus, type CompanyStatus, type Group, type Role } from '../db.ts'

export function attachCompany(router: Router, ctx: RouteCtx) {
  const { db, keys, llm } = ctx

  // ── 公司 ────────────────────────────────────────────────────────────

  router.get('/orgs/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const plan = (await db.plan(company.id))!
    json(res, 200, {
      company: publicCompany(company),
      plan: await publicPlan(db, plan, await db.accountCount(company.id)),
      // 套餐赠送和单独充值分开报，界面上也分开显示——两者的有效期规矩不一样。
      balance: await balanceOf(db, company.id),
    })
  })

  router.patch('/orgs/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const patch: {
      name?: string
      slug?: string
      status?: CompanyStatus
      contactName?: string
      contactPhone?: string
      contactEmail?: string
      address?: string
      website?: string
      machineId?: string | null
      accessUrl?: string | null
    } = {}
    if (body.name != null) patch.name = strField(body, 'name')
    if (body.status != null) {
      // 停用是把整家公司关在门外，公司管理员不能自己停自己——停完谁也开不回来。
      requireOwner(account)
      patch.status = companyStatusOf(body.status)
    }
    if (body.contactName != null) patch.contactName = strField(body, 'contactName')
    if (body.contactPhone != null) patch.contactPhone = phoneOf(strField(body, 'contactPhone'))
    if (body.contactEmail != null) patch.contactEmail = emailOf(strField(body, 'contactEmail'))
    // 地址和网站可以清空，空串就是清空。
    if (body.address !== undefined) patch.address = strField(body, 'address', false)
    if (body.website !== undefined) patch.website = websiteOf(strField(body, 'website', false))
    if (body.accessUrl !== undefined) {
      if (body.accessUrl === null || body.accessUrl === '') patch.accessUrl = null
      else patch.accessUrl = strField(body, 'accessUrl')
    }
    if (body.slug != null) {
      patch.slug = slugOf(strField(body, 'slug'))
      if (patch.slug !== company.slug && await db.companyBySlug(patch.slug)) throw new HttpError(409, '这个 slug 已被占用')
    }
    if (body.machineId !== undefined) {
      if (body.machineId === null || body.machineId === '') {
        const prev = company.machineId
        if (prev) await db.updateMachine(prev, { companyId: null })
        patch.machineId = null
      } else {
        const machineId = strField(body, 'machineId')
        const machine = await db.machine(machineId)
        if (!machine) throw new HttpError(404, '机器不存在')
        if (machine.companyId && machine.companyId !== company.id) throw new HttpError(409, '这台机器已经派给别的公司')
        if (company.machineId && company.machineId !== machine.id) await db.updateMachine(company.machineId, { companyId: null })
        await db.updateMachine(machine.id, { companyId: company.id })
        patch.machineId = machine.id
        // 派机器时写入访问地址。换机器只改解析，地址按 slug 保持。
        const slug = patch.slug ?? company.slug
        patch.accessUrl = company.accessUrl && !(body.slug != null && patch.slug !== company.slug) ? company.accessUrl : accessUrlFor(slug)
      }
    }
    if (patch.slug && patch.slug !== company.slug && (company.accessUrl || patch.machineId || company.machineId)) {
      patch.accessUrl = accessUrlFor(patch.slug)
    }
    const next = await db.updateCompany(company.id, patch)
    await db.audit({ companyId: company.id, accountId: account.id, action: 'org.update', detail: patch })
    json(res, 200, { company: publicCompany(next) })
  })

  router.delete('/orgs/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    // 删公司是**硬删**：账号、审计、发票、订单、充值、用量一起没。这不是公司管理员
    // 该有的权限——「停用」才是公司层面的动作，而且那条已经是 owner-only 了；删除比
    // 停用更不可逆，权限却更松，是说不通的。
    requireOwner(account)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    // 账单**和用量**都要留档，硬删和留档直接冲突：有过任何一条的公司只能停用，不能删。
    // 用量算进来的代价是「发过一条消息的公司就删不掉了」——这是留档要求的必然结果，
    // 不是遗漏。要清理这类公司，走「停用」；真要腾库存得先有一套留存期到期后的归档
    // 流程，那是另一件事，不能靠这个接口顺手做掉。
    const footprint = await db.billingFootprint(company.id)
    const kept = footprint.invoices + footprint.orders + footprint.topups + footprint.llmCalls
    if (kept > 0) {
      throw new HttpError(409, '这家公司有账单或用量记录，必须留档；请改用「停用」而不是删除', footprint)
    }
    /**
     * **先把机器上的席位拆掉。**
     *
     * `deleteCompany` 只是 `delete from seat_runtimes`，随后把 machines.companyId
     * 置空。机器上那套 systemd 单元、noVNC、以及 3200+N / 6081+N 那组端口会继续跑，
     * 而库里再也没有任何指针能找回它们——这台机器改派给别的公司之后，allocateSlot
     * 扫的是一张空表，会把同一批槽位再分出去，新席位起不来。
     *
     * 删账号那条一直是这么做的（见下面的 DELETE /orgs/:id/accounts/:accountId），
     * 删公司这条以前漏了。有账单或用量的公司走不到这里（上面 409 挡着），但
     * 「配了机器、部署了席位、还没发过一条消息」的公司恰好一条记录都没有，删得掉。
     */
    const seats = await db.seatRuntimesOf(company.id)
    try {
      await releaseSeats(db, seats)
    } catch (e) {
      throw new HttpError(502, (e as Error).message)
    }
    await db.tx(() => db.deleteCompany(company.id))
    // 审计写在事务**之后**：deleteCompany 会把这家公司的 audit_events 一起删掉，写在
    // 事务里等于白写。audit_events 没有指向 companies 的外键，公司没了这条也留得住。
    await db.audit({
      companyId: company.id,
      accountId: account.id,
      action: 'org.delete',
      detail: { name: company.name, slug: company.slug, seats: seats.map((x) => x.seatId) },
    })
    json(res, 200, { deleted: true, id: company.id })
  })

  // ── 公司模型角色（日常 / utility）。不存密钥。──────────────────────

  router.get('/orgs/:id/settings', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    json(res, 200, publicSettings(await db.platformSettings()))
  })

  router.put('/orgs/:id/settings', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '日常和 utility 由系统管理员配置')
  })

  // ── 连通性探测。用公司密钥打一枪上游，永不回显 secret。────────────
  router.post('/orgs/:id/llm/test', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    if (!await db.company(req.params.id)) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    let provider = ''
    let model = ''
    const role = body.role
    if (role === 'daily' || role === 'utility') {
      const cur = (await db.platformSettings())[role]
      if (!cur.provider || !cur.model) throw new HttpError(400, `${role === 'daily' ? '日常' : 'utility'} 模型还没设置`)
      provider = cur.provider
      model = cur.model
    } else {
      provider = strField(body, 'provider')
      model = strField(body, 'model', false)
      if (!model) {
        const cur = await db.platformSettings()
        if (cur.daily.provider === provider && cur.daily.model) model = cur.daily.model
        else if (cur.utility.provider === provider && cur.utility.model) model = cur.utility.model
        else model = await llm.firstModel(req.params.id, provider)
      }
      if (!model) throw new HttpError(400, '这个供应商没有可测的模型')
    }
    const result = await llm.probe(req.params.id, provider, model)
    if (!result.ok && result.error === '模型不在可见目录里') {
      throw new HttpError(404, result.error, { model: `${result.provider}/${result.model}` })
    }
    if (!result.ok && result.error?.startsWith('没有 ') && result.error.endsWith(' 的密钥')) {
      throw new HttpError(402, result.error, { provider: result.provider })
    }
    json(res, 200, result)
  })

  // ── 席位 / 账号 ─────────────────────────────────────────────────────

  router.get('/orgs/:id/accounts', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const plan = await db.plan(company.id)
    const runtimes = account.role === 'owner' ? await db.seatRuntimesOf(company.id) : []
    const byAccount = new Map<string, typeof runtimes>()
    for (const rt of runtimes) {
      const list = byAccount.get(rt.accountId) || []
      list.push(rt)
      byAccount.set(rt.accountId, list)
    }
    const hostOf = machineHostResolver(db)
    const members = await Promise.all(
      (await db.accountsOf(req.params.id)).map(async (row) => {
        const pub = publicAccount(row)
        if (account.role !== 'owner') return pub
        const list = byAccount.get(row.id) || []
        return { ...pub, runtimes: await Promise.all(list.map(async (rt) => listSeatRuntime(rt, await hostOf(rt)))) }
      }),
    )
    json(res, 200, {
      members,
      // 「全体成员」是算出来的，不落库：新人进来自动在里面。
      groups: [
        {
          id: 'all',
          builtin: true,
          name: '全体成员',
          desc: '所有已加入的成员，自动维护',
          icon: 'users',
          role: null,
          members: members.map((m) => m.id),
          agents: [],
          createdAt: members[0]?.createdAt ?? Date.now(),
        },
        ...(await db.groupsOf(company.id)).map(publicGroup),
      ],
      seats: { total: plan?.seats ?? 0, used: await db.accountCount(company.id) },
      me: publicAccount(account),
    })
  })

  router.post('/orgs/:id/accounts', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const password = strField(body, 'password')
    if (password.length < MIN_PASSWORD) throw new HttpError(400, `口令至少 ${MIN_PASSWORD} 位`)
    const role = roleOf(body.role, 'member')
    const name = strField(body, 'name', false)
    if (await db.accountByEmail(email)) throw new HttpError(409, '这个邮箱已经注册')
    const passwordHash = await hashPassword(password)
    const created = await db.tx(async () => {
      await db.lockPlan(company.id)
      const plan = await db.plan(company.id)
      const used = await db.accountCount(company.id)
      const seats = plan?.seats ?? 0
      if (used >= seats) throw new HttpError(409, '席位已满', { seats, used })
      const row = await db.insertAccount({ companyId: company.id, email, passwordHash, role, name, status: 'active' })
      await db.audit({ companyId: company.id, accountId: actor.id, action: 'account.create', detail: { id: row.id, email, role } })
      return row
    })
    json(res, 201, { account: publicAccount(created) })
  })

  /**
   * 建号并发一条邀请链接。账号当场建出来（待接受），链接只负责让本人设口令。
   * 必须写在 /accounts/:accountId 前面，否则 members 会被当成 accountId。
   */
  router.post('/orgs/:id/accounts/members', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const email = emailOf(strField(body, 'email'))
    const name = strField(body, 'name', false)
    const role = roleOf(body.role, 'member')
    const days = Math.min(Math.max(Number(body.ttlDays) || 7, 1), 30)
    if (await db.accountByEmail(email)) throw new HttpError(409, '这个邮箱已经注册')
    const passwordHash = await hashPassword(randomUUID())
    const created = await db.tx(async () => {
      await db.lockPlan(company.id)
      const plan = await db.plan(company.id)
      const used = await db.accountCount(company.id)
      const seats = plan?.seats ?? 0
      if (used >= seats) throw new HttpError(409, '席位已满', { seats, used })
      const row = await db.insertAccount({
        companyId: company.id,
        email,
        passwordHash,
        role,
        name,
        status: 'invited',
      })
      const invite = await issueInvite(db, row, actor.id, days * 24 * 3600 * 1000)
      await db.audit({
        companyId: company.id,
        accountId: actor.id,
        action: 'account.invite',
        detail: { id: row.id, email, role, expiresAt: invite.expiresAt },
      })
      return { row, invite }
    })
    json(res, 201, {
      user: publicAccount(created.row),
      invite: { url: inviteLinkOf(req, created.invite.token), expiresAt: created.invite.expiresAt },
    })
  })

  /**
   * 分组。必须写在 /accounts/:accountId 前面，否则 groups 会被当成 accountId。
   * 默认角色只影响以后加进组的人，不改已有成员的账号角色。
   */
  router.post('/orgs/:id/accounts/groups', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) throw new HttpError(400, '分组要有名字')
    const desc = typeof body.desc === 'string' ? body.desc.trim() : ''
    const icon = (typeof body.icon === 'string' && body.icon.trim()) || 'chat'
    const role = groupRoleOf(body.role)
    const members = await membersInCompany(db, company.id, body.members)
    const agents = stringIds(body.agents)
    const group = await db.insertGroup({ companyId: company.id, name, desc, icon, role, members, agents })
    await db.audit({ companyId: company.id, accountId: actor.id, action: 'group.create', detail: { id: group.id, name } })
    json(res, 201, { group: publicGroup(group) })
  })

  router.patch('/orgs/:id/accounts/groups/:groupId', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    if (req.params.groupId === 'all') throw new HttpError(400, '「全体成员」是系统固定分组')
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const cur = await db.group(req.params.groupId)
    if (!cur || cur.companyId !== company.id) throw new HttpError(404, '没有这个分组')
    const body = bodyOf(req)
    const patch: Partial<Pick<Group, 'name' | 'desc' | 'icon' | 'role' | 'members' | 'agents'>> = {}
    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : ''
      if (!name) throw new HttpError(400, '分组要有名字')
      patch.name = name
    }
    if (typeof body.desc === 'string') patch.desc = body.desc.trim()
    if (typeof body.icon === 'string' && body.icon.trim()) patch.icon = body.icon.trim()
    if (body.role === 'admin' || body.role === 'member') patch.role = body.role
    if (Array.isArray(body.members)) patch.members = await membersInCompany(db, company.id, body.members)
    if (Array.isArray(body.agents)) patch.agents = stringIds(body.agents)
    const group = await db.updateGroup(cur.id, patch)
    await db.audit({ companyId: company.id, accountId: actor.id, action: 'group.update', detail: { id: group.id } })
    json(res, 200, { group: publicGroup(group) })
  })

  router.delete('/orgs/:id/accounts/groups/:groupId', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    if (req.params.groupId === 'all') throw new HttpError(400, '「全体成员」是系统固定分组')
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const cur = await db.group(req.params.groupId)
    if (!cur || cur.companyId !== company.id) throw new HttpError(404, '没有这个分组')
    await db.deleteGroup(cur.id)
    await db.audit({ companyId: company.id, accountId: actor.id, action: 'group.delete', detail: { id: cur.id, name: cur.name } })
    json(res, 200, { ok: true })
  })

  router.get('/orgs/:id/accounts/:accountId', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    json(res, 200, { account: publicAccount(row) })
  })

  router.patch('/orgs/:id/accounts/:accountId', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    const body = bodyOf(req)
    if (row.id === actor.id && (body.role || body.status)) throw new HttpError(400, '不能改自己的角色或状态')
    const patch: { name?: string; role?: Role; status?: AccountStatus; tokenRevokedAt?: number | null } = {}
    if (body.name != null) {
      const name = strField(body, 'name')
      if (!name) throw new HttpError(400, 'name 不能为空')
      patch.name = name
    }
    if (body.role !== undefined && body.role !== '') patch.role = roleOf(body.role)
    if (body.status !== undefined && body.status !== '') patch.status = statusOf(body.status)
    const nextRole = patch.role ?? row.role
    const nextStatus = patch.status ?? row.status
    if (patch.status === 'invited' && row.status !== 'invited') {
      throw new HttpError(400, '已激活的账号不能退回待接受，需要重设口令请用重置链接')
    }
    if (patch.status === 'active' && row.status === 'invited') {
      throw new HttpError(400, '待接受的账号不能由管理员直接激活，对方需用邀请链接设置口令')
    }
    if (losingAdmin(row, nextRole, nextStatus) && await db.adminCount(row.companyId!) <= 1) {
      throw new HttpError(409, '至少要留一个管理员')
    }
    if (patch.status === 'disabled') patch.tokenRevokedAt = Date.now()
    // 停用的人重新激活会多占一个席位。满了就不让激活——先加席位，或者停掉别人。
    // 检查和写入放在同一个事务里，并先锁住套餐行，否则两个人同时激活会一起挤进来。
    const next = await db.tx(async () => {
      if (patch.status === 'active' && row.status === 'disabled') {
        await db.lockPlan(row.companyId!)
        const seats = (await db.plan(row.companyId!))?.seats ?? 0
        const used = await db.accountCount(row.companyId!)
        if (used >= seats) throw new HttpError(409, '席位已满，先加席位或停用其他成员', { seats, used })
      }
      return db.updateAccount(row.id, patch)
    })
    await db.audit({
      companyId: row.companyId,
      accountId: actor.id,
      action: 'account.update',
      detail: { id: row.id, name: patch.name, role: patch.role, status: patch.status },
    })
    json(res, 200, { account: publicAccount(next) })
  })

  /**
   * 重发邀请 / 重置口令，都落成一条新链接。旧邀请删掉，tokenRevokedAt 立刻作废旧 JWT。
   * Gateway 没有会话表：未过期的 JWT 若签发于 tokenRevokedAt 之后仍可用；登录会因 disabled 被拒。
   */
  router.post('/orgs/:id/accounts/:accountId/reset', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '没有这个成员')
    await db.updateAccount(row.id, { tokenRevokedAt: Date.now() })
    const ttl = row.status === 'invited' ? INVITE_TTL : RESET_LINK_TTL
    const invite = await issueInvite(db, row, actor.id, ttl)
    await db.audit({
      companyId: row.companyId,
      accountId: actor.id,
      action: 'account.reset',
      detail: { id: row.id, expiresAt: invite.expiresAt },
    })
    json(res, 200, { invite: { url: inviteLinkOf(req, invite.token), expiresAt: invite.expiresAt } })
  })

  router.post('/orgs/:id/accounts/:accountId/deploy', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    if (row.role === 'owner') throw new HttpError(403, '系统管理员没有席位')
    const out = await deploySeat(db, keys, row, deployOptsOf(req))
    const rt = out.ok ? out.result.runtime : out.runtime
    await db.audit({
      companyId: req.params.id,
      accountId: actor.id,
      action: 'runtime.deploy',
      detail: {
        targetAccountId: row.id,
        botId: rt?.botId,
        linuxUser: rt?.linuxUser,
        seatId: rt?.seatId,
        slot: rt?.slot,
        status: rt?.status,
      },
    })
    if (!out.ok) throw new HttpError(out.status, out.error)
    json(res, 200, publicSeatRuntime(out.result.runtime, out.result.machine.host, {
      includePassword: actor.role === 'owner' || actor.id === row.id,
      ticket: desktopTicketFor(keys, out.result.machine, out.result.runtime),
    }))
  })

  router.delete('/orgs/:id/accounts/:accountId', async (req, res) => {
    const actor = await requireUser(req, db, keys)
    requireOrg(actor, req.params.id, true)
    const row = await db.account(req.params.accountId)
    if (!row || row.companyId !== req.params.id) throw new HttpError(404, '账号不存在')
    if (row.id === actor.id) throw new HttpError(400, '不能删除自己')
    if (row.role === 'admin' && row.status !== 'disabled' && row.companyId && await db.adminCount(row.companyId) <= 1) {
      throw new HttpError(409, '不能删掉最后一个管理员')
    }
    // **先拆机器上的席位，再删库里的行。** 理由见 deploy.ts 的 releaseSeats——
    // 删公司走的是同一条。
    const seats = await db.seatRuntimesOfAccount(row.id)
    try {
      await releaseSeats(db, seats)
    } catch (e) {
      throw new HttpError(502, (e as Error).message)
    }
    await db.deleteAccount(row.id)
    await db.audit({
      companyId: row.companyId,
      accountId: actor.id,
      action: 'account.delete',
      detail: { id: row.id, email: row.email, seats: seats.map((x) => x.seatId) },
    })
    json(res, 200, { deleted: true, id: row.id })
  })

  router.get('/orgs/:id/plan', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const plan = await db.plan(req.params.id)
    if (!plan) throw new HttpError(404, '套餐不存在')
    json(res, 200, await publicPlan(db, plan, await db.accountCount(req.params.id)))
  })

  /**
   * 公司账单。席位来自 db.plan，是真的。发票、充值、扣款都还没接——空列表，不编数字。
   */
  router.get('/orgs/:id/billing', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const plan = await db.plan(company.id)
    if (!plan) throw new HttpError(404, '套餐不存在')
    const used = await db.accountCount(company.id)
    // 订阅和账单都来自订单：已付款且在期内的那条订单就是「现在订的是什么」。
    const active = await db.activePaidOrder(company.id)
    const expired = plan.expiresAt != null && plan.expiresAt < Date.now()
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
    const invoices = await db.invoicesOfCompany(company.id)
    const topups = await db.topupsOfCompany(company.id)
    const balance = await balanceOf(db, company.id)
    json(res, 200, {
      plan: {
        name: active?.planName || '席位套餐',
        status: active ? '生效中' : expired ? '已到期' : '未订阅',
        cycle: '—',
        seats: `${plan.seats} 个席位`,
        used,
        period: active ? `${day(active.startAt)} → ${day(active.endAt)}` : '—',
        renew: plan.expiresAt == null ? '—' : day(plan.expiresAt),
        amount: active ? usd(active.amountMils) : '—',
        autoRenew: false,
      },
      // 客户这边只看已付款的：没付的单子是「还没成交」，摆在账单里像已经欠着钱。
      // 界面那张表按 period / amount / status / paid 四列画，这里就按它的形状给。
      invoices: invoices
        .filter((v) => v.status === 'paid')
        .map((v) => ({
          id: v.id,
          period: `${day(v.periodStart)} → ${day(v.periodEnd)}`,
          amount: usd(v.amountMils),
          status: '已付款',
          paid: v.paidAt ? day(v.paidAt) : '—',
        })),
      // 两笔额度分开报：赠送的跟着套餐到期清零，充的不过期。合计只是给一眼看的。
      balance: {
        amount: usd(balance.planBonusMils + balance.topupMils),
        planBonus: usd(balance.planBonusMils),
        planBonusExpires: balance.planBonusExpiresAt ? day(balance.planBonusExpiresAt) : '—',
        topup: usd(balance.topupMils),
        // 按量扣费还没接，用了多少、预警线都还没有真数字，不编。
        spentThisMonth: '—',
        alertAt: '—',
      },
      topups: topups.map((v) => ({
        id: v.id,
        time: day(v.createdAt),
        amount: usd(v.amountMils),
        note: v.note || '—',
      })),
    })
  })

  /**
   * 公司用量。费用没有真实账单，永远是 —，不编钱。
   * 有 llm_calls 就报真实调用次数和 token 合计；没有就 0 / —。
   * 管理员；员工走 GET /me/stats。
   */
  router.get('/orgs/:id/usage', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const range = rangeQuery(req)
    const plan = await db.plan(company.id)
    const seats = plan?.seats ?? 0
    const members = (await db.accountsOf(company.id)).filter((a) => a.role !== 'owner')
    const usage = await db.llmUsageOfCompany(company.id, range)
    json(res, 200, usagePayload(usage, { seats, members, includeMembers: true }))
  })

  router.get('/me/stats', async (req, res) => {
    const account = await requireUser(req, db, keys)
    const range = rangeQuery(req)
    const usage = await db.llmUsageOfAccount(account.id, range)
    json(res, 200, usagePayload(usage, { seats: 0, members: [account], includeMembers: false }))
  })

  router.put('/orgs/:id/plan', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '席位由系统管理员分配')
  })

  router.patch('/orgs/:id/plan', async (req, res) => {
    await requireUser(req, db, keys)
    throw new HttpError(403, '席位由系统管理员分配')
  })

  // ── 机器 / 访问地址 ─────────────────────────────────────────────────

  router.get('/orgs/:id/machine', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const machine = company.machineId ? await db.machine(company.machineId) : await companyMachineOf(db, company.id)
    json(res, 200, { machine: machine ? publicMachine(machine) : null, accessUrl: company.accessUrl })
  })

  router.post('/orgs/:id/machine', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOrg(account, req.params.id, true)
    const company = await db.company(req.params.id)
    if (!company) throw new HttpError(404, '公司不存在')
    const body = bodyOf(req)
    // 机器地址是平台的事：登记走 POST /internal/machines（引导票），改走
    // PUT /platform/orgs/:id/machine（owner）。公司管理员只能把已有机器认领过来。
    // 否则管理员能把 host 指到自己的服务器上，让 Gateway 带着 smt_ 打过去。
    const rawHost = body.host != null ? strField(body, 'host', false) : ''
    if (rawHost && account.role !== 'owner') throw new HttpError(403, '机器地址由系统管理员配置')
    const host = rawHost ? machineHostOf(rawHost) : null
    const id = body.id != null ? strField(body, 'id', false) || undefined : undefined
    const existing = id ? await db.machine(id) : undefined
    if (existing && existing.companyId && existing.companyId !== company.id) {
      throw new HttpError(409, '这台机器已经派给别的公司')
    }
    // **配过对的机器不是「谁先认领谁得」。** companyId 为空不代表这台是干净的新机器：
    // 公司被删时 machines.companyId 会被置空，而那台机器上的席位还在跑。这种机器只能
    // 由 owner 重新指派，或者由**当初配对它的那家公司**认回去。没配过对的预登记机器
    // （平台先 POST /internal/machines 建好、再交给公司）不受影响，照旧可以认领。
    if (
      existing &&
      !existing.companyId &&
      existing.pairedAt &&
      account.role !== 'owner' &&
      !(await db.machinePairedBy(existing.id, company.id))
    ) {
      throw new HttpError(403, '这台机器不是本公司配对的，请让系统管理员指派')
    }
    const { machine, next } = await db.tx(async () => {
      // **认领是「加一台」，不是「换一台」。** 以前这里会把 company.machineId 指向的
      // 那台解绑——单机时代那是对的，多机之后会把已经在跑的机器连同它上面的席位一起
      // 踢出公司，容量凭空缩水。
      const machine = existing
        ? await db.updateMachine(existing.id, { companyId: company.id, host: host ?? existing.host })
        : await db.insertMachine({ id, host, companyId: company.id })
      const accessUrl = company.accessUrl ?? accessUrlFor(company.slug)
      // 认领是个明确动作，把这台设成公司的默认机器是合理的。但**只是改默认**——
      // 上面那台仍然属于这家公司、仍然在跑、仍然算容量。
      const next = await db.updateCompany(company.id, { machineId: machine.id, accessUrl })
      await db.audit({ companyId: company.id, accountId: account.id, action: 'machine.assign', detail: { machineId: machine.id, accessUrl } })
      return { machine, next }
    })
    json(res, 201, { machine: publicMachine(machine), company: publicCompany(next) })
  })
}
