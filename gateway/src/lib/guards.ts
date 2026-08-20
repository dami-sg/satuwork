/**
 * 鉴权守卫、邀请、登录票，以及用量口径。
 *
 * 从 routes.ts 拆出来的——那个文件曾经是 5700 行，前 1900 行全是这类帮手。
 */
import { HttpError, type Req, bearer } from '../http.ts'
import { JWT_TTL, KIND } from './validate.ts'
import { type Account, type AccountStatus, type CatalogKind, type Db, type Machine, type Role } from '../db.ts'
import { type JwtKeys, type JwtPayload, randomInviteToken, sha256Hex, signJwt, timingSafeToken, verifyJwt } from '../crypto.ts'

export function gateAccount(account: Account | undefined): Account {
  if (!account) throw new HttpError(401, '需要登录')
  if (account.status === 'disabled') throw new HttpError(401, '这个账号已被停用，请联系管理员')
  if (account.status === 'invited') throw new HttpError(401, '请先用邀请链接设置口令')
  return account
}

/**
 * 公司停用就整家挡在门外——账号自己没停用也一样，省得一家家去停人。
 * owner 不属于任何公司，不受这条影响，否则停完就没人能把它开回来了。
 */
export async function gateCompany(db: Db, account: Account): Promise<Account> {
  if (!account.companyId) return account
  const company = await db.company(account.companyId)
  if (company && company.status === 'disabled') throw new HttpError(403, '这家公司已被停用，请联系平台管理员')
  return account
}

export async function accountFromJwt(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '需要登录')
  if (token.startsWith('sk_sw_') || token.startsWith('sat_')) throw new HttpError(401, '需要登录')
  let payload: JwtPayload
  try {
    payload = verifyJwt(keys, token)
  } catch (e) {
    throw new HttpError(401, (e as Error).message)
  }
  const account = await db.account(payload.accountId)
  if (!account) throw new HttpError(401, '账号不存在')
  if (account.tokenRevokedAt && payload.iat < Math.floor(account.tokenRevokedAt / 1000)) {
    throw new HttpError(401, '登录已失效，请重新登录')
  }
  return gateCompany(db, gateAccount(account))
}

/** 控制台写操作：只要登录 JWT。sat_ / sk_sw_ 都不行。 */
export async function requireUser(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  return await accountFromJwt(req, db, keys)
}

/** Bot 拉目录：登录 JWT 或席位 sat_。sk_sw_ 不行。 */
export async function requireSeatOrUser(req: Req, db: Db, keys: JwtKeys): Promise<Account> {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '需要登录')
  if (token.startsWith('sk_sw_')) throw new HttpError(401, '需要登录')
  if (token.startsWith('sat_')) return gateCompany(db, gateAccount(await db.accountByAccessToken(token)))
  return await accountFromJwt(req, db, keys)
}

/**
 * 只认席位 sat_。**浏览器的登录 JWT 不行**——这条路会带出 MCP 明文 token 与 env，
 * 那是给实例进程用的，不是给某个成员的浏览器用的。
 */
export async function requireSeatOnly(req: Req, db: Db): Promise<Account> {
  const token = bearer(req)
  if (!token || !token.startsWith('sat_')) throw new HttpError(401, '需要席位凭证')
  return gateCompany(db, gateAccount(await db.accountByAccessToken(token)))
}

export function headerOf(req: Req, name: string): string | undefined {
  const v = req.headers[name]
  if (Array.isArray(v)) return v[0]
  return typeof v === 'string' ? v : undefined
}

/**
 * 这个 Gateway 对外的地址。
 *
 * 从请求头推，不从配置里读——同一份部署可能同时挂在内网 IP 和公网域名上，写死一个
 * 就会有一半的链接打不开。**回调地址也走这条**：连接器的 OAuth 回调必须落在用户
 * 刚才所在的那个域名上，否则浏览器带回来的是另一个源。
 */
export function originOf(req: Req): string {
  const host = headerOf(req, 'x-forwarded-host') || headerOf(req, 'host') || '127.0.0.1:3080'
  const proto = headerOf(req, 'x-forwarded-proto') || 'http'
  return `${proto}://${host}`
}

export function inviteLinkOf(req: Req, token: string): string {
  return `${originOf(req)}/join/${token}`
}

export async function inviteeOf(db: Db, token: string) {
  const id = sha256Hex(token)
  const row = await db.invite(id)
  if (!row) return null
  if (row.expiresAt < Date.now()) {
    await db.deleteInvite(id)
    return null
  }
  const user = await db.account(row.userId)
  if (!user || user.status === 'disabled') return null
  return { user, invite: row, id }
}

export async function issueInvite(db: Db, user: Account, createdBy: string, ttl: number) {
  await db.deleteInvitesForUser(user.id)
  const token = randomInviteToken()
  const now = Date.now()
  await db.putInvite({
    id: sha256Hex(token),
    userId: user.id,
    companyId: user.companyId ?? '',
    createdBy,
    createdAt: now,
    expiresAt: now + ttl,
  })
  return { token, expiresAt: now + ttl }
}

export async function noteLogin(db: Db, account: Account): Promise<Account> {
  return await db.updateAccount(account.id, {
    lastSeenAt: Date.now(),
    status: account.status === 'invited' ? 'active' : account.status,
  })
}

export function statusOf(v: unknown): AccountStatus {
  if (v !== 'active' && v !== 'disabled' && v !== 'invited') throw new HttpError(400, 'status 只能是 active、disabled 或 invited')
  return v
}

export function losingAdmin(row: Account, nextRole: Role, nextStatus: AccountStatus): boolean {
  return row.role === 'admin' && row.status !== 'disabled' && (nextRole !== 'admin' || nextStatus === 'disabled')
}

export function requireOrg(account: Account, orgId: string, admin = false): void {
  if (account.role === 'owner') return
  if (account.companyId !== orgId) throw new HttpError(403, '不属于这家公司')
  if (admin && account.role !== 'admin') throw new HttpError(403, '需要管理员')
}

export function requireOwner(account: Account): void {
  if (account.role !== 'owner') throw new HttpError(403, '需要系统管理员')
}

export function rangeQuery(req: Req): { from?: number; to?: number } {
  const fromRaw = req.query.get('from')
  const toRaw = req.query.get('to')
  const from = fromRaw != null && fromRaw !== '' ? Number(fromRaw) : undefined
  const to = toRaw != null && toRaw !== '' ? Number(toRaw) : undefined
  if (fromRaw && fromRaw !== '' && !Number.isFinite(from)) throw new HttpError(400, 'from 必须是 unix 毫秒')
  if (toRaw && toRaw !== '' && !Number.isFinite(to)) throw new HttpError(400, 'to 必须是 unix 毫秒')
  return { from, to }
}

export function usagePayload(
  usage: { calls: number; promptTokens: number; completionTokens: number; byAccount: { accountId: string; calls: number; promptTokens: number; completionTokens: number; lastAt: number | null }[] },
  opts: { seats: number; members: Account[]; includeMembers: boolean },
) {
  const byAccount = new Map(usage.byAccount.map((row) => [row.accountId, row]))
  /**
   * 名册上已经没有、但用量记录还在的那些人。
   *
   * 删员工时他的 llm_calls 是**留着**的（留档要求），所以公司总数里一直含着这部分，
   * 而下面「按成员」只列现有成员。不把这一行兜出来，顶部的总数就大于各行相加，差额
   * 没有出处——看的人只会以为哪里算错了。
   */
  const departed = usage.byAccount.filter((row) => !opts.members.some((m) => m.id === row.accountId))
  const departedRow =
    departed.length === 0
      ? null
      : {
          id: '',
          departed: true,
          count: departed.length,
          name: '已离职员工',
          initial: '·',
          tasks: String(departed.reduce((n, r) => n + r.calls, 0)),
          tokens: String(departed.reduce((n, r) => n + r.promptTokens + r.completionTokens, 0)),
          fail: '—',
          last: '—',
        }
  return {
    stats: [
      { label: '任务执行', value: String(usage.calls), delta: '—' },
      { label: '输入 Tokens', value: String(usage.promptTokens), delta: '—' },
      { label: '输出 Tokens', value: String(usage.completionTokens), delta: '—' },
      { label: '费用', value: '—', delta: '—' },
    ],
    daily: [] as unknown[],
    byAgent: [] as unknown[],
    byModel: [] as unknown[],
    quota: [] as unknown[],
    seats: opts.seats,
    ...(opts.includeMembers
      ? {
          byMember: [
            ...opts.members.map((m) => {
              const name = m.name || m.email
              const initial = (name || '·').trim().slice(0, 1).toUpperCase()
              const row = byAccount.get(m.id)
              const tokens = row ? row.promptTokens + row.completionTokens : 0
              return {
                id: m.id,
                departed: false,
                count: 0,
                name,
                initial,
                tasks: String(row?.calls ?? 0),
                tokens: String(tokens),
                fail: '—',
                last: '—',
              }
            }),
            ...(departedRow ? [departedRow] : []),
          ],
        }
      : {}),
  }
}

export function requireBootstrapMachine(req: Req) {
  const expected = process.env.GATEWAY_MACHINE_TOKEN ?? ''
  const token = bearer(req)
  if (!expected || !token || !timingSafeToken(token, expected)) {
    throw new HttpError(401, '无效的机器凭证')
  }
}

export async function requireMachine(req: Req, db: Db): Promise<Machine> {
  const token = bearer(req)
  if (!token) throw new HttpError(401, '无效的机器凭证')
  const machine = await db.machineByToken(token)
  if (!machine || !machine.token || !timingSafeToken(token, machine.token)) {
    throw new HttpError(401, '无效的机器凭证')
  }
  return machine
}

/**
 * `/internal/*` 里**由 bot 发起**的那几条（ready / sessions.index / usage）的调用方。
 *
 * 两种凭据都收，但权限不一样：
 *
 *  - `sat_` 席位票：bot 进程自己。只能报**它自己那个账号**的事，body 里的 accountId 不作数。
 *  - `smt_` 机器票：管家。能替本机任意席位报。
 *
 * 加 `sat_` 这条路是为了让 bot 不再需要机器票。`smt_` 同时是管家的 root 控制面凭据
 * （`PUT /seats/:id` 就是拿它鉴权的），以前却被写进席位 Linux 用户读得到的 `bot.env`，
 * 于是员工桌面上一句 `cat` 就能拿到整台机器的控制权。现在它不再离开
 * `/etc/satuwork/manager.json`。
 */
export type InternalCaller =
  | { kind: 'machine'; machine: Machine; companyId: string }
  | { kind: 'seat'; account: Account; companyId: string }

export async function requireInternalCaller(req: Req, db: Db): Promise<InternalCaller> {
  const token = bearer(req)
  if (token && token.startsWith('sat_')) {
    const account = await gateCompany(db, gateAccount(await db.accountByAccessToken(token)))
    if (!account.companyId) throw new HttpError(403, '没有公司席位')
    return { kind: 'seat', account, companyId: account.companyId }
  }
  const machine = await requireMachine(req, db)
  if (!machine.companyId) throw new HttpError(403, '机器还没有派给公司')
  return { kind: 'machine', machine, companyId: machine.companyId }
}

/** 调用方能替哪个账号说话。席位票只能是自己，机器票由 body 指定。 */
export function callerAccountId(caller: InternalCaller, fromBody: () => string): string {
  return caller.kind === 'seat' ? caller.account.id : fromBody()
}

export function requirePlatformToken(req: Req) {
  const expected = process.env.GATEWAY_PLATFORM_TOKEN ?? ''
  const token = bearer(req)
  if (!expected || !token || !timingSafeToken(token, expected)) {
    throw new HttpError(401, '无效的平台凭证')
  }
}

/**
 * 谁能发布 Bot 版本：CI 拿平台令牌，人拿 owner 登录态。
 * 返回 accountId（平台令牌没有账号，返回空串）。
 */
export async function requireReleaseAuthor(req: Req, db: Db, keys: JwtKeys): Promise<string> {
  const expected = process.env.GATEWAY_PLATFORM_TOKEN ?? ''
  const token = bearer(req)
  if (expected && token && timingSafeToken(token, expected)) return ''
  const account = await requireUser(req, db, keys)
  requireOwner(account)
  return account.id
}

export function issue(keys: JwtKeys, account: Account) {
  return signJwt(
    keys,
    {
      sub: account.id,
      accountId: account.id,
      companyId: account.role === 'owner' ? '' : (account.companyId ?? ''),
      role: account.role,
    },
    JWT_TTL,
  )
}

export function kindOf(name: string): CatalogKind {
  const k = KIND[name]
  if (!k) throw new HttpError(404, '未知目录')
  return k
}

