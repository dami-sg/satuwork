import { Service, type Context } from '@deepseek-ai/cordis'
import { createHash, randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb) as (pw: string | Buffer, salt: string | Buffer, len: number) => Promise<Buffer>

declare module '@deepseek-ai/cordis' {
  interface Context {
    auth: AuthService
  }
}

/**
 * 角色只有两档：管理员与成员。**没有「所有者」**——第一个账号是管理员，不是另一
 * 种更高的身份。
 */
export type Role = 'admin' | 'member'
/** 状态。同样按稿子：已激活 / 待接受 / 已停用。 */
export type Status = 'active' | 'disabled' | 'invited'

export interface User {
  id: string
  email: string
  name: string
  role: Role
  status: Status
  createdAt: number
  /** 最近一次成功登录。没登录过就是 undefined，不是 0。 */
  lastSeenAt?: number
  /** 口令最后一次变更。个人设置里「上次修改于」读它。 */
  passwordChangedAt?: number
  title?: string
  phone?: string
  /** 界面偏好。跟着账号走，换台机器登录能带过去。 */
  theme?: 'light' | 'dark' | 'system'
  locale?: 'zh' | 'en'
  /** `scrypt$N$r$p$salt$hash`，全部十六进制。**永远不出现在任何响应里。** */
  password: string
}

/**
 * 邀请记录。id 是**令牌的 sha256**，和会话同一个道理：库被拿走也换不出一条能用
 * 的邀请。一次性——用掉就删，不留 usedAt 之类的痕迹给人猜。
 */
interface InviteRow {
  userId: string
  createdBy: string
  createdAt: number
  expiresAt: number
}

/** 会话记录。id 是 token 的 sha256，不是 token 本身。 */
interface SessionRow {
  userId: string
  createdAt: number
  expiresAt: number
  /** 登录时的 User-Agent。设备列表靠它说人话，没有就是「未知设备」。 */
  agent?: string
}

/** 给外面看的用户。凡是往响应里写用户，都必须经过它。 */
export interface PublicUser {
  id: string
  email: string
  name: string
  role: Role
  status: Status
  createdAt: number
  lastSeenAt?: number
  passwordChangedAt?: number
  title?: string
  phone?: string
  theme?: 'light' | 'dark' | 'system'
  locale?: 'zh' | 'en'
}

/**
 * 令牌有效期。两种用途给两个值：
 * - **邀请新成员** 7 天——对方可能不在工位上，太短就变成反复重发
 * - **重置口令** 1 小时——那是一把能改现有账号口令的钥匙，越短越好
 */
const INVITE_TTL = 7 * 24 * 3600 * 1000
const RESET_TTL = 3600 * 1000

const COOKIE = 'satu_session'
const SESSION_TTL = 30 * 24 * 3600 * 1000
/** 口令下限。界面上写的要求就是这一条，不多写一条服务端不检查的。 */
const MIN_PASSWORD = 10

/** scrypt 参数。N 越大越慢越安全；16384 在本机登录约 50–80ms，够用且不刺痛。 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** 公开路由。除这些之外的 `/api/*` 一律要登录。 */
const PUBLIC = new Set([
  '/api/auth/state',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/health',
])
/** 邀请是给还没登录的人用的，按前缀放行。 */
const PUBLIC_PREFIX = '/api/invites/'
/** Gateway 用机器凭证拉全文，不走用户 cookie。令牌在路由里验。 */
const INTERNAL_SESSIONS = '/internal/sessions/'

/**
 * 账号与会话。
 *
 * 三条不让步的线：
 *
 * 1. **口令只以派生值存在**。scrypt + 每用户随机盐，比对用 `timingSafeEqual`。
 *    数据库里没有任何可还原成口令的东西。
 * 2. **会话表里存的是 token 的哈希**，不是 token。库被人拿走也换不出一个能用的
 *    会话——这跟口令不明文存是同一条理由。
 * 3. **拦截在服务端**。前端跳转只是体验；没有会话的请求在路由之前就被挡住，
 *    浏览器改地址栏、直接 curl 都一样。
 */
export const RESET_LINK_TTL = RESET_TTL

export class AuthService extends Service {
  private users
  private sessions
  private invites
  /** 登录失败计数，进程内。重启即清零——它是减速带，不是审计。 */
  private attempts = new Map<string, { n: number; until: number }>()

  constructor(ctx: Context) {
    super(ctx, 'auth')
    this.users = ctx.storage.collection<User>('users')
    this.sessions = ctx.storage.collection<SessionRow>('auth_sessions')
    this.invites = ctx.storage.collection<InviteRow>('auth_invites')
  }

  /**
   * 给某个账号发一条邀请令牌。
   *
   * 同一个人重复发（「重发邀请」）会**作废旧的那条**——否则一个人手上同时有好几
   * 条能用的链接，撤销就成了一件说不清的事。
   */
  invite(userId: string, createdBy: string, ttl = INVITE_TTL) {
    for (const row of this.invites.list()) {
      if (row.value.userId === userId) this.invites.delete(row.id)
    }
    const token = randomBytes(24).toString('base64url')
    const expiresAt = Date.now() + ttl
    this.invites.put(sha256(token), { userId, createdBy, createdAt: Date.now(), expiresAt })
    return { token, expiresAt }
  }

  /** 令牌 → 待加入的人。过期的当场删掉。 */
  inviteeOf(token: string) {
    const id = sha256(token)
    const row = this.invites.get(id)
    if (!row) return null
    if (row.expiresAt < Date.now()) {
      this.invites.delete(id)
      return null
    }
    const user = this.users.get(row.userId)
    if (!user || user.status === 'disabled') return null
    return { user, invite: row, id }
  }

  /**
   * 接受邀请：设口令、转为已激活、令牌作废。
   *
   * 令牌**用掉即删**，所以同一条链接第二次打开就是失效——转发出去的链接不会变成
   * 一把长期可用的钥匙。
   */
  async acceptInvite(token: string, input: { name?: string; password: string }) {
    const found = this.inviteeOf(token)
    if (!found) throw new Error('这条邀请链接不可用')
    if (input.password.length < MIN_PASSWORD) throw new Error(`口令至少 ${MIN_PASSWORD} 位`)
    const next: User = {
      ...found.user,
      name: input.name?.trim() || found.user.name,
      status: 'active',
      password: await this.hash(input.password),
      passwordChangedAt: Date.now(),
    }
    this.users.put(next.id, next)
    this.invites.delete(found.id)
    return next
  }

  /** 一个用户都没有 —— 这时登录页变成「创建管理员」。 */
  needsSetup() {
    return this.users.list().length === 0
  }

  private async hash(password: string) {
    const salt = randomBytes(16)
    const key = await scrypt(password, salt, SCRYPT.keylen)
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`
  }

  private async matches(password: string, stored: string) {
    const [scheme, , , , salt, hash] = stored.split('$')
    if (scheme !== 'scrypt' || !salt || !hash) return false
    const key = await scrypt(password, Buffer.from(salt, 'hex'), SCRYPT.keylen)
    const expected = Buffer.from(hash, 'hex')
    // 长度不等时 timingSafeEqual 会抛，所以先比长度——它本身不是秘密。
    return key.length === expected.length && timingSafeEqual(key, expected)
  }

  /**
   * 往响应里写用户的唯一出口。
   *
   * `status` 补默认值：加这个字段之前写进去的行没有它，而「读到的老行长什么样」
   * 是运行时事实，不是类型能保证的东西。
   */
  static publicOf(user: User): PublicUser {
    const { password, ...rest } = user
    return {
      ...rest,
      status: rest.status ?? 'active',
      // 早前版本有 'owner' 与 'viewer' 两档，都已取消——读到就归到现有的两档里。
      role: (rest.role as string) === 'owner' || rest.role === 'admin' ? 'admin' : 'member',
    }
  }

  /**
   * 建第一个管理员。
   *
   * **只在一个用户都没有时可用**。这条检查在服务端，不在界面上——否则任何人
   * 都能往这个接口再造一个 owner 出来。
   */
  async setup(input: { email: string; name: string; password: string }) {
    if (!this.needsSetup()) throw new Error('已经有账号了，不能再走初始化')
    return this.create({ ...input, role: 'admin' })
  }

  async create(input: { email: string; name: string; password: string; role: Role; status?: Status }) {
    const email = input.email.trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('邮箱格式不对')
    if (input.password.length < MIN_PASSWORD) throw new Error(`口令至少 ${MIN_PASSWORD} 位`)
    if (this.byEmail(email)) throw new Error('这个邮箱已经注册过了')

    const user: User = {
      id: `u-${randomUUID()}`,
      email,
      name: input.name.trim() || email.split('@')[0],
      role: input.role,
      status: input.status ?? 'active',
      createdAt: Date.now(),
      password: await this.hash(input.password),
    }
    this.users.put(user.id, user)
    return user
  }

  list() {
    return this.users
      .list()
      .map((row) => row.value)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  get(id: string) {
    return this.users.get(id)
  }

  /** 还剩几个能管事的人。降级、停用、删除都要先问它。 */
  admins() {
    return this.list().filter((u) => this.roleOf(u) === 'admin' && u.status !== 'disabled')
  }

  /** 老数据里的 'owner' 当 'admin'，'viewer' 当 'member'——这两档都取消了。 */
  roleOf(user: User): Role {
    const role = user.role as string
    if (role === 'owner') return 'admin'
    return role === 'admin' ? 'admin' : 'member'
  }

  update(id: string, patch: Partial<Pick<User, 'name' | 'role' | 'status'>>) {
    const user = this.users.get(id)
    if (!user) throw new Error('没有这个成员')

    const next = { ...user, ...patch, role: patch.role ?? this.roleOf(user) }

    // 「待接受」只出现在**账号刚建出来、本人还没设过口令**的那一段。已经激活过的
    // 账号退不回去：那个状态的含义是「口令还没被人设过」，而它已经被设过了。
    // 想让人重设，用重置链接（会断掉他的会话），不是把状态改回去。
    if (patch.status === 'invited' && user.status !== 'invited') {
      throw new Error('已激活的账号不能退回待接受，需要重设口令请用重置链接')
    }
    // 最后一个管理员不能被降级或停用——否则这台实例会没有人能管，而恢复它要去
    // 改数据库。这条守在这里，不在界面上。
    const losingAdmin =
      this.roleOf(user) === 'admin' && user.status !== 'disabled' && (next.role !== 'admin' || next.status === 'disabled')
    if (losingAdmin && this.admins().length <= 1) throw new Error('至少要留一个管理员')

    this.users.put(id, next)
    // 停用、退回待接受都要立刻断掉他手上的会话，否则那两个状态只是列表上的一个字。
    if (next.status === 'disabled' || next.status === 'invited') this.endAllSessions(id)
    return next
  }

  remove(id: string) {
    const user = this.users.get(id)
    if (!user) throw new Error('没有这个成员')
    if (this.roleOf(user) === 'admin' && this.admins().length <= 1) throw new Error('至少要留一个管理员')
    this.endAllSessions(id)
    this.users.delete(id)
  }

  /** 重置口令。返回明文**只此一次**——它不落库，也不进日志。 */
  async resetPassword(id: string) {
    const user = this.users.get(id)
    if (!user) throw new Error('没有这个成员')
    const password = randomBytes(9).toString('base64url')
    this.users.put(id, { ...user, password: await this.hash(password), status: user.status === 'invited' ? 'invited' : user.status })
    // 换了口令，旧会话一律作废。
    this.endAllSessions(id)
    return password
  }

  byEmail(email: string) {
    const wanted = email.trim().toLowerCase()
    return this.users.list().find((row) => row.value.email === wanted)?.value
  }

  /**
   * 校验口令。
   *
   * 用户不存在时**也跑一遍派生**再失败：否则「这个邮箱有没有注册」可以用响应
   * 快慢问出来。返回值不区分「没这个人」和「口令不对」，同样是这个理由。
   */
  async verify(email: string, password: string) {
    const user = this.byEmail(email)
    if (!user) {
      await scrypt(password, randomBytes(16), SCRYPT.keylen)
      return null
    }
    return (await this.matches(password, user.password)) ? user : null
  }

  /** 失败次数太多就先歇着。粒度是邮箱，够挡住撞库脚本。 */
  throttle(key: string) {
    const row = this.attempts.get(key)
    if (row && row.until > Date.now() && row.n >= 10) {
      return Math.ceil((row.until - Date.now()) / 1000)
    }
    return 0
  }

  noteFailure(key: string) {
    const now = Date.now()
    const row = this.attempts.get(key)
    if (!row || row.until < now) this.attempts.set(key, { n: 1, until: now + 15 * 60 * 1000 })
    else row.n += 1
  }

  clearFailures(key: string) {
    this.attempts.delete(key)
  }

  startSession(userId: string, agent?: string) {
    const token = randomBytes(32).toString('base64url')
    this.sessions.put(sha256(token), { userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL, agent })
    return token
  }

  /** 某人当前还活着的会话。设备列表读它。 */
  sessionsOf(userId: string, currentToken?: string) {
    const currentId = currentToken ? sha256(currentToken) : null
    return this.sessions
      .list()
      .filter((row) => row.value.userId === userId && row.value.expiresAt > Date.now())
      .map((row) => ({
        id: row.id,
        createdAt: row.value.createdAt,
        expiresAt: row.value.expiresAt,
        agent: row.value.agent,
        current: row.id === currentId,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 按会话 id 注销。只允许注销自己的——id 是哈希，猜不出来，但也不能靠这个。 */
  revokeSession(userId: string, id: string) {
    const row = this.sessions.get(id)
    if (!row || row.userId !== userId) throw new Error('没有这个会话')
    this.sessions.delete(id)
  }

  /**
   * 改口令。
   *
   * 必须先验当前口令——否则一个被别人借走的浏览器就能把账号夺走。改完把该用户
   * 的会话**全部**作废（包括当前这个），由调用方立刻给当前浏览器换一个新的：
   * 「改了口令，别处就得重新登录」这句话得是真的。
   */
  async changePassword(userId: string, current: string, next: string) {
    const user = this.users.get(userId)
    if (!user) throw new Error('没有这个账号')
    if (!(await this.matches(current, user.password))) throw new Error('当前口令不对')
    if (next.length < MIN_PASSWORD) throw new Error(`新口令至少 ${MIN_PASSWORD} 位`)
    if (await this.matches(next, user.password)) throw new Error('新口令不能和当前口令相同')
    this.users.put(userId, { ...user, password: await this.hash(next), passwordChangedAt: Date.now() })
    this.endAllSessions(userId)
  }

  /** 改自己的资料与界面偏好。角色与状态不在这里——那是管理面的事。 */
  updateProfile(
    userId: string,
    patch: { name?: string; title?: string; phone?: string; theme?: string; locale?: string },
  ) {
    const user = this.users.get(userId)
    if (!user) throw new Error('没有这个账号')
    const next = { ...user }
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim()
    if (typeof patch.title === 'string') next.title = patch.title.trim()
    if (typeof patch.phone === 'string') next.phone = patch.phone.trim()
    // 只认识的值才存：界面上传来的东西不该原样落库。
    if (['light', 'dark', 'system'].includes(patch.theme!)) next.theme = patch.theme as User['theme']
    if (['zh', 'en'].includes(patch.locale!)) next.locale = patch.locale as User['locale']
    this.users.put(userId, next)
    return next
  }

  /** token → 用户。过期的当场删掉，不留着占地方。 */
  userOfToken(token: string | undefined): User | null {
    if (!token) return null
    const id = sha256(token)
    const row = this.sessions.get(id)
    if (!row) return null
    if (row.expiresAt < Date.now()) {
      this.sessions.delete(id)
      return null
    }
    const user = this.users.get(row.userId)
    // 被停用的人手上就算还有 token 也不算登录——停用必须立刻生效，
    // 不能等到他自己退出。
    if (!user || user.status === 'disabled') return null
    return user
  }

  /** 从请求里认人。路由要判角色时用它。 */
  userOf(req: { headers: Headers }) {
    return this.userOfToken(cookie(req.headers.get('cookie'), COOKIE))
  }

  /** 需要管理权限的操作在入口处调它。**授权判断只在服务端。** */
  requireAdmin(req: { headers: Headers }) {
    const user = this.userOf(req)
    if (!user || this.roleOf(user) !== 'admin') throw new Error('需要管理员权限')
    return user
  }

  noteLogin(id: string) {
    const user = this.users.get(id)
    if (user) this.users.put(id, { ...user, lastSeenAt: Date.now(), status: user.status === 'invited' ? 'active' : user.status })
  }

  endSession(token: string | undefined) {
    if (token) this.sessions.delete(sha256(token))
  }

  /** 把某个用户的全部会话作废。改口令、停用账号时用。 */
  endAllSessions(userId: string) {
    for (const row of this.sessions.list()) {
      if (row.value.userId === userId) this.sessions.delete(row.id)
    }
  }
}

export const name = 'satu-auth'
export const inject = ['server', 'storage']

/** 从 Cookie 头里取一个值。没有 cookie 库，这点活不值得引一个。 */
function cookie(header: string | null, key: string) {
  for (const part of (header ?? '').split(';')) {
    const [k, ...rest] = part.trim().split('=')
    if (k === key) return decodeURIComponent(rest.join('='))
  }
  return undefined
}

function setCookie(res: { headers: Headers }, token: string | null, secure: boolean) {
  const base = `${COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`
  // HttpOnly：脚本读不到它，XSS 也偷不走会话。SameSite=Lax：跨站表单提交带不上。
  res.headers.set('set-cookie', token ? `${base}; Max-Age=${SESSION_TTL / 1000}` : `${base}; Max-Age=0`)
}


/**
 * 席位票（`sat_`）。**这是 bot 认的唯一一把入站凭据。**
 *
 * 以前还认机器票（`smt_`）。那把票同时是管家 `PUT /seats/:id` 的鉴权凭据，也就是整台
 * 机器的 root 控制面；它被写进 `$SEAT_DIR/bot.env`，而那个文件属于席位那个普通 Linux
 * 用户——员工在 noVNC 桌面里 `cat` 一下就拿到了，还能直接拿它读同机其他同事的会话。
 * 席位票是按账号发的，作用域就到这个席位为止。
 */
function seatToken(): string {
  return (process.env.GATEWAY_TOKEN || '').trim()
}

/**
 * 守卫用的路径归一。
 *
 * 路由匹配是 path-to-regexp 生成的正则，**带 `i` 标志、且允许一个尾斜杠**
 * （`/api/sessions` 编译出来是 `/^(?:\/api\/sessions)(?:\/$)?$/i`）。守卫按原样
 * 字符串比就会和路由错位：`GET /API/sessions` 的 `startsWith('/api/')` 不成立 →
 * 守卫直接放行，而路由照样命中 → 整个 /api 面未鉴权。这里先按路由的口径归一，
 * 两边才是同一套判断。
 *
 * 只用于守卫的前缀判断，**不能拿去做路由**：sessionId / botId 在路径里是大小写
 * 敏感的。
 */
function guardPath(raw: string): string {
  const lower = raw.toLowerCase()
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower
}

function runtimeApiPath(path: string) {
  if (path === '/api/health') return true
  if (path === '/api/runtime/status') return true
  if (path === '/api/bots' || path.startsWith('/api/bots/')) return true
  if (path === '/api/sessions' || path.startsWith('/api/sessions/')) return true
  return false
}

function bearerMatches(header: string | null, expected: string): boolean {
  if (!expected || !header?.startsWith('Bearer ')) return false
  const token = header.slice(7).trim()
  if (!token) return false
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function runtimeTokenOk(req: { headers: Headers }) {
  return bearerMatches(req.headers.get('authorization'), seatToken())
}

export function apply(ctx: Context) {
  ctx.plugin(AuthService)

  ctx.inject(['auth'], (ctx: Context) => {
    const tokenOf = (req: { headers: Headers }) => cookie(req.headers.get('cookie'), COOKIE)
    const isSecure = (req: { headers: Headers }) => req.headers.get('x-forwarded-proto') === 'https'

    /**
     * 守卫。
     *
     * `server.use` 是 **prepend** 的，所以它跑在所有路由之前——插件是并发挂载的，
     * 靠注册顺序排在最前面这件事本来不成立，这里不受影响。
     *
     * 只挡 `/api/*`：shell 自己是静态文件，未登录也能拿到，它拿到之后自己去
     * `/api/auth/state` 问，然后画登录页。真正的门在这一层，不在前端那次跳转。
     */
    ctx.server.use(async (req, res, next) => {
      const path = guardPath(req.path)
      if (path.startsWith(INTERNAL_SESSIONS)) return next()
      if (!path.startsWith('/api/') || PUBLIC.has(path) || path.startsWith(PUBLIC_PREFIX)) return next()
      if (runtimeTokenOk(req) && runtimeApiPath(path)) return next()
      if (ctx.auth.userOfToken(tokenOf(req))) return next()
      res.status = 401
      res.json({ error: '需要登录', code: 'unauthenticated' })
    })

    /** 当前状态。**公开**：没登录的浏览器要靠它决定画登录页还是初始化页。 */
    ctx.server.get('/api/auth/state', async (req, res) => {
      const user = ctx.auth.userOfToken(tokenOf(req))
      res.json({
        needsSetup: ctx.auth.needsSetup(),
        user: user ? AuthService.publicOf(user) : null,
      })
    })

    /** 创建第一个管理员。只在一个用户都没有时可用，检查在服务端。 */
    ctx.server.post('/api/auth/setup', async (req, res) => {
      const body = (await req.json().catch(() => ({}))) as Record<string, string>
      try {
        const user = await ctx.auth.setup({
          email: body.email ?? '',
          name: body.name ?? '',
          password: body.password ?? '',
        })
        setCookie(res, ctx.auth.startSession(user.id, req.headers.get('user-agent') ?? undefined), isSecure(req))
        res.json({ user: AuthService.publicOf(user) })
      } catch (e) {
        res.status = 400
        res.json({ error: (e as Error).message })
      }
    })

    ctx.server.post('/api/auth/login', async (req, res) => {
      const body = (await req.json().catch(() => ({}))) as Record<string, string>
      const email = (body.email ?? '').trim().toLowerCase()

      const wait = ctx.auth.throttle(email)
      if (wait) {
        res.status = 429
        res.json({ error: `尝试太频繁，请 ${wait} 秒后再试` })
        return
      }

      const user = await ctx.auth.verify(email, body.password ?? '')
      if (user && user.status === 'disabled') {
        res.status = 403
        res.json({ error: '这个账号已被停用，请联系管理员' })
        return
      }
      if (!user) {
        ctx.auth.noteFailure(email)
        res.status = 401
        // 不说是「没这个人」还是「口令不对」——那等于一个查号台。
        res.json({ error: '邮箱或口令不对' })
        return
      }

      ctx.auth.clearFailures(email)
      ctx.auth.noteLogin(user.id)
      setCookie(res, ctx.auth.startSession(user.id, req.headers.get('user-agent') ?? undefined), isSecure(req))
      res.json({ user: AuthService.publicOf(user) })
    })

    ctx.server.post('/api/auth/logout', async (req, res) => {
      ctx.auth.endSession(tokenOf(req))
      setCookie(res, null, isSecure(req))
      res.json({ ok: true })
    })

    /**
     * 看一条邀请是否还有效。**公开**：点链接的人还没有账号可言。
     *
     * 无效不区分「不存在 / 过期 / 用过」——三者对访客是同一件事，区分开只会
     * 变成一个探测接口。
     */
    ctx.server.get('/api/invites/:token', async (req, res) => {
      const found = ctx.auth.inviteeOf(req.params.token)
      if (!found) {
        res.json({ valid: false })
        return
      }
      res.json({
        valid: true,
        email: found.user.email,
        name: found.user.name,
        expiresAt: found.invite.expiresAt,
      })
    })

    /** 接受邀请：设口令并直接进门。 */
    ctx.server.post('/api/invites/:token/accept', async (req, res) => {
      const body = (await req.json().catch(() => ({}))) as Record<string, string>
      try {
        const user = await ctx.auth.acceptInvite(req.params.token, {
          name: body.name,
          password: body.password ?? '',
        })
        ctx.auth.noteLogin(user.id)
        setCookie(res, ctx.auth.startSession(user.id, req.headers.get('user-agent') ?? undefined), isSecure(req))
        res.json({ user: AuthService.publicOf(user) })
      } catch (e) {
        res.status = 400
        res.json({ error: (e as Error).message })
      }
    })

    /** 当前登录的人。走守卫，所以到这里一定有会话。 */
    ctx.server.get('/api/me', async (req, res) => {
      const user = ctx.auth.userOfToken(tokenOf(req))!
      res.json({ user: AuthService.publicOf(user) })
    })

    /** 改自己的资料。邮箱不在这里——它是登录身份，改它要另一套验证。 */
    ctx.server.patch('/api/me', async (req, res) => {
      const me = ctx.auth.userOfToken(tokenOf(req))!
      const body = (await req.json().catch(() => ({}))) as Record<string, string>
      try {
        res.json({ user: AuthService.publicOf(ctx.auth.updateProfile(me.id, body)) })
      } catch (e) {
        res.status = 400
        res.json({ error: (e as Error).message })
      }
    })

    /** 改口令。成功之后当前浏览器换一个新会话，其余设备一律掉线。 */
    ctx.server.post('/api/me/password', async (req, res) => {
      const me = ctx.auth.userOfToken(tokenOf(req))!
      const body = (await req.json().catch(() => ({}))) as Record<string, string>
      try {
        await ctx.auth.changePassword(me.id, body.current ?? '', body.next ?? '')
        setCookie(res, ctx.auth.startSession(me.id, req.headers.get('user-agent') ?? undefined), isSecure(req))
        res.json({ ok: true })
      } catch (e) {
        res.status = 400
        res.json({ error: (e as Error).message })
      }
    })

    /** 自己的登录设备。 */
    ctx.server.get('/api/me/sessions', async (req, res) => {
      const me = ctx.auth.userOfToken(tokenOf(req))!
      res.json({ sessions: ctx.auth.sessionsOf(me.id, tokenOf(req)) })
    })

    ctx.server.delete('/api/me/sessions/:id', async (req, res) => {
      const me = ctx.auth.userOfToken(tokenOf(req))!
      try {
        ctx.auth.revokeSession(me.id, req.params.id)
        res.json({ ok: true })
      } catch (e) {
        res.status = 400
        res.json({ error: (e as Error).message })
      }
    })
  })
}
