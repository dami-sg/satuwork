import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { AuthService, RESET_LINK_TTL } from '../../auth/index.ts'

/**
 * 账号管理屏。
 *
 * 成员是**真的**：底下就是 satu-auth 的用户表。这一屏owns 的是「管理面」——
 * 谁能改谁、改成什么样；身份本身（口令、会话）归 satu-auth，两者不混。
 *
 * **发不出邮件**，所以邀请不是发链接，而是当场建号并给出一次性口令，由管理员
 * 自己转交。这比画一个「邀请邮件已发送」然后什么都没发生要诚实。
 */
export const name = 'satu-view-accounts'
export const inject = ['client', 'server', 'auth', 'storage']

interface Group {
  id: string
  name: string
  desc: string
  /** 图标。只存 key，画什么由界面那份图标表决定，对不上就落到默认那个。 */
  icon: string
  /** 默认角色。它只影响「新人进这个组时给什么角色」，不覆盖成员自己的角色。 */
  role: 'admin' | 'member'
  members: string[]
  agents: string[]
  createdAt: number
}

const SEATS = 10

export function apply(ctx: Context) {
  ctx.client.register({ id: 'accounts', entry: new URL('./client.js', import.meta.url) })

  const groups = ctx.storage.collection<Group>('groups')
  /** 出错就是 400 + 一句人话。管理面的失败都是可以直接给用户看的。 */
  const guard = async (req: any, res: any, run: () => unknown) => {
    try {
      ctx.auth.requireAdmin(req)
      return res.json((await run()) ?? { ok: true })
    } catch (e) {
      res.status = (e as Error).message === '需要管理员权限' ? 403 : 400
      return res.json({ error: (e as Error).message })
    }
  }

  /** 读也要管理员：成员名单、角色、最近活跃是管理面的东西，不是团队通讯录。 */
  ctx.server.get('/api/accounts', async (req, res) => {
    try {
      ctx.auth.requireAdmin(req)
    } catch (e) {
      res.status = 403
      return res.json({ error: (e as Error).message })
    }
    const members = ctx.auth.list().map((u) => AuthService.publicOf(u))
    return res.json({
      members,
      // 「全体成员」是**算出来的**，不落库：它的成员就是全部成员，没有可编辑的
      // 状态。存一份反而要操心「新人加进来了它同步了吗」。
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
        ...groups.list().map((row) => ({ id: row.id, builtin: false, ...row.value })),
      ],
      seats: { total: SEATS, used: members.filter((m) => m.status !== 'disabled').length },
      me: AuthService.publicOf(ctx.auth.userOf(req)!),
    })
  })

  /** 邀请链接。origin 从请求头取——同一台实例可能挂在不同域名下。 */
  const linkOf = (req: any, token: string) => {
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '127.0.0.1:3082'
    const proto = req.headers.get('x-forwarded-proto') ?? 'http'
    return `${proto}://${host}/join/${token}`
  }

  /**
   * 建号并发一条邀请链接。
   *
   * 账号当场就建出来（状态「待接受」），链接只负责让本人设口令——这样成员列表里
   * 立刻能看到这个人，而不是等他点了链接才凭空出现。
   */
  ctx.server.post('/api/accounts/members', async (req, res) =>
    guard(req, res, async () => {
      const body = (await req.json().catch(() => ({}))) as Record<string, string>
      const me = ctx.auth.userOf(req)!
      if (ctx.auth.list().filter((u) => u.status !== 'disabled').length >= SEATS) {
        throw new Error(`席位已满（${SEATS} 个），先停用一个成员再邀请`)
      }
      const user = await ctx.auth.create({
        email: body.email ?? '',
        name: body.name ?? '',
        // 只有两档，别的一律落到成员。
        role: body.role === 'admin' ? 'admin' : 'member',
        // 建号时先塞一把随机口令：这个账号在本人设口令之前**不该能登录**，
        // 而空口令会让「有没有设过」这件事变成一个可以试出来的状态。
        password: randomUUID(),
        status: 'invited',
      })
      // 有效期由界面给，但**范围在这里定**：界面传什么都不能越过 30 天。
      const days = Math.min(Math.max(Number(body.ttlDays) || 7, 1), 30)
      const { token, expiresAt } = ctx.auth.invite(user.id, me.id, days * 24 * 3600 * 1000)
      return { user: AuthService.publicOf(user), invite: { url: linkOf(req, token), expiresAt } }
    }),
  )

  ctx.server.patch('/api/accounts/members/:id', async (req, res) =>
    guard(req, res, async () => {
      const body = (await req.json().catch(() => ({}))) as Record<string, string>
      const me = ctx.auth.userOf(req)!
      // 不能改自己的角色或状态：手滑一次就把自己关在门外，而门在服务器上。
      if (req.params.id === me.id && (body.role || body.status)) throw new Error('不能改自己的角色或状态')
      const patch: Record<string, string> = {}
      for (const key of ['name', 'role', 'status']) if (body[key]) patch[key] = body[key]
      return { user: AuthService.publicOf(ctx.auth.update(req.params.id, patch as never)) }
    }),
  )

  /**
   * 重发邀请 / 重置口令，两者都落成**一条新链接**。
   *
   * 对「待接受」的人这就是重发；对已激活的人，这是「让他自己重设」——比管理员
   * 生成一把明文口令再转告一遍更少经手一次秘密。旧链接与旧会话一并作废。
   */
  ctx.server.post('/api/accounts/members/:id/reset', async (req, res) =>
    guard(req, res, async () => {
      const me = ctx.auth.userOf(req)!
      const user = ctx.auth.get(req.params.id)
      if (!user) throw new Error('没有这个成员')
      ctx.auth.endAllSessions(user.id)
      const { token, expiresAt } = ctx.auth.invite(user.id, me.id, user.status === 'invited' ? undefined : RESET_LINK_TTL)
      return { invite: { url: linkOf(req, token), expiresAt } }
    }),
  )

  ctx.server.delete('/api/accounts/members/:id', async (req, res) =>
    guard(req, res, async () => {
      if (req.params.id === ctx.auth.userOf(req)!.id) throw new Error('不能移除自己')
      ctx.auth.remove(req.params.id)
    }),
  )

  ctx.server.post('/api/accounts/groups', async (req, res) =>
    guard(req, res, async () => {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      const name = String(body.name ?? '').trim()
      if (!name) throw new Error('分组要有名字')
      const id = `g-${randomUUID()}`
      const group: Group = {
        id,
        name,
        desc: String(body.desc ?? '').trim(),
        icon: String(body.icon ?? 'chat').trim() || 'chat',
        role: body.role === 'admin' ? 'admin' : 'member',
        members: Array.isArray(body.members) ? (body.members as string[]) : [],
        agents: Array.isArray(body.agents) ? (body.agents as string[]) : [],
        createdAt: Date.now(),
      }
      groups.put(id, group)
      return { group }
    }),
  )

  ctx.server.patch('/api/accounts/groups/:id', async (req, res) =>
    guard(req, res, async () => {
      // 固定分组是算出来的，没有可改的东西，也不该被删。
      if (req.params.id === 'all') throw new Error('「全体成员」是系统固定分组')
      const current = groups.get(req.params.id)
      if (!current) throw new Error('没有这个分组')
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
      const next = { ...current }
      if (typeof body.name === 'string' && body.name.trim()) next.name = body.name.trim()
      if (typeof body.desc === 'string') next.desc = body.desc.trim()
      if (typeof body.icon === 'string' && body.icon.trim()) next.icon = body.icon.trim()
      if (body.role === 'admin' || body.role === 'member') next.role = body.role
      if (Array.isArray(body.members)) next.members = body.members as string[]
      groups.put(req.params.id, next)
      return { group: next }
    }),
  )

  ctx.server.delete('/api/accounts/groups/:id', async (req, res) =>
    guard(req, res, async () => {
      // 固定分组是算出来的，没有可改的东西，也不该被删。
      if (req.params.id === 'all') throw new Error('「全体成员」是系统固定分组')
      if (!groups.delete(req.params.id)) throw new Error('没有这个分组')
    }),
  )
}
