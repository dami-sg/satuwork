import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { randomAccessToken, randomApiKey, randomMachineToken } from './crypto.ts'
import { migrate, migrationState, type MigrateResult } from './db/migrate.ts'
import { type Account, type AccountSecrets, type AccountStatus, type AuditEvent, type BotRelease, type CatalogItem, type CatalogKind, type Company, type CompanyModelUsage, type ConnectionScope, type ConnectionStatus, type ConnectorCall, type ConnectorCallStatus, type ConnectorConnection, type ConnectorInstall, type CompanySettings, type Credential, DEFAULT_MAX_ACCOUNTS, type Group, type Instance, type Invite, type Invoice, type LlmCall, type LlmUsage, type Machine, type MachineMetricMinute, type MachinePairing, type Plan, type PlanOrder, type PlanPeriod, type PlanSku, type PlatformSettings, type ReleaseKind, type Role, type Routine, type RoutineRun, type RoutineRunTrigger, type RoutineRunStatus, ROUTINE_RUNS_KEEP, type RoutineTrigger, SESSION_PAGE_DEFAULT, SESSION_PAGE_MAX, type Scope, type SeatRuntime, type SessionIndex, type Topup, type UsageCharge, type ChargeKind, type ChargeStatus, CHARGE_PAGE_DEFAULT, CHARGE_PAGE_MAX, type WebCall, type WebCallKind, emptyPlatformSettings, emptySettings, parseBilling, parseConnectorPricing, parseModelPricing, parsePriceMultiplier, parseWebTools, releaseArch } from './db/types.ts'
import { type Row, accountOf, auditOf, botReleaseOf, catalogOf, companyOf, connectorCallOf, connectorConnectionOf, connectorInstallOf, credOf, groupOf, instanceOf, inviteOf, invoiceOf, isUniqueViolation, jsonOf, machineMetricMinuteOf, machineOf, machinePairingOf, nameFromEmail, num, numOrNull, parsePlatformPayload, planOf, planOrderOf, planSkuOf, routineOf, routineRunOf, seatRuntimeOf, sessionIndexOf, str, strOrNull, toPg, topupOf, usageChargeOf } from './db/rows.ts'

/**
 * 类型、常量和行解析都在 `db/` 底下；这里原样再导出，调用点仍然
 * `import { type Account, type Db } from './db.ts'`，一行都不用改。
 */
export * from './db/types.ts'
export * from './db/rows.ts'

const { Pool } = pg
type PoolClient = pg.PoolClient

/** schema 名只允许普通标识符：它要拼进 SQL，不能走参数。 */
export function safeSchema(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`不合法的 schema 名：${name}`)
  return name
}

export interface DbOptions {
  url: string
  schema?: string
}

export function databaseUrl(): string {
  const url = (process.env.GATEWAY_DATABASE_URL || '').trim()
  if (!url) {
    throw new Error(
      '未配置 GATEWAY_DATABASE_URL。示例：postgres://satuwork:satuwork@127.0.0.1:5434/satuwork（docker compose up -d postgres）',
    )
  }
  return url
}

/**
 * Gateway 自己的库（PostgreSQL）。跟 Bot 的 satuwork.db 不是同一份——
 * 聊天正文永远不该出现在这里。
 *
 * 驼峰列名一律加引号：PG 不加引号会折成小写，而 `select *` 的结果直接喂给上面那些
 * mapper。加了引号，写漏的那一刻 PG 就报 column does not exist，不会静默变 undefined。
 */
export class Db {
  private pool: pg.Pool
  private schema: string
  /** 事务期间把 client 放这儿，`db.tx(() => db.xxx())` 里的每条语句才走同一个连接。 */
  private txClient = new AsyncLocalStorage<PoolClient>()

  constructor(opts: DbOptions | string) {
    const o = typeof opts === 'string' ? { url: opts } : opts
    this.schema = safeSchema(o.schema || process.env.GATEWAY_PG_SCHEMA || 'public')
    // search_path 走连接启动参数，不走 connect 事件里补一条 `set`——后者不等它跑完
    // 就可能先发业务查询，是条竞态。
    this.pool = new Pool({
      connectionString: o.url,
      max: 10,
      options: `-c search_path=${this.schema}`,
    })
    this.pool.on('error', (e) => {
      console.error(`satuwork-gateway: 连接池错误 ${e.message}`)
    })
  }

  private async query(text: string, params: unknown[] = []): Promise<pg.QueryResult> {
    const client = this.txClient.getStore()
    if (client) return client.query(toPg(text), params)
    return this.pool.query(toPg(text), params)
  }

  private async one(text: string, params: unknown[] = []): Promise<Row | undefined> {
    const r = await this.query(text, params)
    return r.rows[0] as Row | undefined
  }

  private async many(text: string, params: unknown[] = []): Promise<Row[]> {
    const r = await this.query(text, params)
    return r.rows as Row[]
  }

  private async run(text: string, params: unknown[] = []): Promise<number> {
    const r = await this.query(text, params)
    return r.rowCount ?? 0
  }

  /**
   * 把库升到最新。**每次起进程都跑一遍**，跑完才对外服务。
   *
   * 空库从 0001 建全套；存量库第一次带着这套代码起来时，0001 是幂等的、跑起来等于
   * 空转，然后记一行 `schema_migrations`——不需要任何人工基线（见 db/migrate.ts）。
   * 返回这一轮真正跑掉的编号，由 index.ts 打进日志。
   */
  async init(): Promise<MigrateResult> {
    if (this.schema !== 'public') {
      // e2e 每轮要干净的库。**只对非 public schema 生效**——生产跑在 public 上，
      // 这个开关碰不到它。
      if (process.env.GATEWAY_PG_RESET === '1') {
        await this.pool.query(`drop schema if exists "${this.schema}" cascade`)
      }
      await this.pool.query(`create schema if not exists "${this.schema}"`)
    }
    // 独占一条连接：advisory lock 是会话级的，拿和放必须在同一条上。
    const client = await this.pool.connect()
    try {
      return await migrate(client, this.schema)
    } finally {
      client.release()
    }
  }

  /** 库停在哪一号、代码里最新是哪一号、还差哪几条。给排查和 `/health` 用。 */
  migrations(): Promise<{ current: string | null; latest: string | null; pending: string[] }> {
    return migrationState(this.pool)
  }

  /** e2e 用：把本 schema 整个丢掉重建。生产不会走到。 */
  async dropSchema(): Promise<void> {
    if (this.schema === 'public') throw new Error('拒绝 drop public schema')
    await this.pool.query(`drop schema if exists "${this.schema}" cascade`)
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async tx<T>(fn: () => Promise<T> | T): Promise<T> {
    const existing = this.txClient.getStore()
    // 已经在事务里就直接跑，不开嵌套事务。
    if (existing) return fn()
    const client = await this.pool.connect()
    try {
      await client.query('begin')
      const out = await this.txClient.run(client, async () => fn())
      await client.query('commit')
      return out
    } catch (e) {
      try {
        await client.query('rollback')
      } catch {}
      throw e
    } finally {
      client.release()
    }
  }

  // ── 公司 ──────────────────────────────────────────────────────────────

  async insertCompany(
    input: {
      slug: string
      name: string
    } & Partial<Pick<Company, 'contactName' | 'contactPhone' | 'contactEmail' | 'address' | 'website'>>,
  ): Promise<Company> {
    const now = Date.now()
    const row: Company = {
      id: randomUUID(),
      slug: input.slug,
      name: input.name,
      status: 'active',
      contactName: input.contactName ?? '',
      contactPhone: input.contactPhone ?? '',
      contactEmail: input.contactEmail ?? '',
      address: input.address ?? '',
      website: input.website ?? '',
      machineId: null,
      accessUrl: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into companies (id, slug, name, status, "contactName", "contactPhone", "contactEmail", address, website, "machineId", "accessUrl", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.slug,
        row.name,
        row.status,
        row.contactName,
        row.contactPhone,
        row.contactEmail,
        row.address,
        row.website,
        row.machineId,
        row.accessUrl,
        row.createdAt,
        row.updatedAt,
      ],
    )
    return row
  }

  async company(id: string): Promise<Company | undefined> {
    const r = await this.one('select * from companies where id = ?', [id])
    return r ? companyOf(r) : undefined
  }

  async companyBySlug(slug: string): Promise<Company | undefined> {
    const r = await this.one('select * from companies where slug = ?', [slug])
    return r ? companyOf(r) : undefined
  }

  async updateCompany(
    id: string,
    patch: Partial<
      Pick<
        Company,
        | 'name'
        | 'slug'
        | 'status'
        | 'contactName'
        | 'contactPhone'
        | 'contactEmail'
        | 'address'
        | 'website'
        | 'machineId'
        | 'accessUrl'
      >
    >,
  ): Promise<Company> {
    const cur = await this.company(id)
    if (!cur) throw new Error('公司不存在')
    const next: Company = {
      ...cur,
      name: patch.name ?? cur.name,
      slug: patch.slug ?? cur.slug,
      status: patch.status ?? cur.status,
      contactName: patch.contactName ?? cur.contactName,
      contactPhone: patch.contactPhone ?? cur.contactPhone,
      contactEmail: patch.contactEmail ?? cur.contactEmail,
      address: patch.address ?? cur.address,
      website: patch.website ?? cur.website,
      machineId: patch.machineId === undefined ? cur.machineId : patch.machineId,
      accessUrl: patch.accessUrl === undefined ? cur.accessUrl : patch.accessUrl,
      updatedAt: Date.now(),
    }
    await this.run(
      'update companies set slug=?, name=?, status=?, "contactName"=?, "contactPhone"=?, "contactEmail"=?, address=?, website=?, "machineId"=?, "accessUrl"=?, "updatedAt"=? where id=?',
      [
        next.slug,
        next.name,
        next.status,
        next.contactName,
        next.contactPhone,
        next.contactEmail,
        next.address,
        next.website,
        next.machineId,
        next.accessUrl,
        next.updatedAt,
        id,
      ],
    )
    return next
  }

  async deleteCompany(id: string): Promise<void> {
    await this.run('delete from groups where "companyId" = ?', [id])
    await this.run('delete from skill_tags where "companyId" = ?', [id])
    await this.run('delete from session_index where "companyId" = ?', [id])
    await this.run('delete from instances where "companyId" = ?', [id])
    await this.run('delete from seat_runtimes where "companyId" = ?', [id])
    await this.run('delete from audit_events where "companyId" = ?', [id])
    await this.run('delete from settings where "companyId" = ?', [id])
    await this.run('delete from credentials where "companyId" = ?', [id])
    await this.run('delete from catalog_items where "companyId" = ?', [id])
    await this.run('update machines set "companyId" = null where "companyId" = ?', [id])
    // machine_pairings."companyId" 有真外键指向 companies(id)。漏了这一条，最后那句
    // `delete from companies` 对**任何配对过机器的公司**都会外键报错，整条删除永远
    // 走不通。machines 那行是解绑（机器要留着重派），配对码则是一次性的，直接删。
    await this.run('delete from machine_pairings where "companyId" = ?', [id])
    await this.run('delete from invites where "companyId" = ?', [id])
    // **用量不删。** llm_calls 属于必须留档的记录，路由那道闸已经挡住「有用量的公司
    // 不许硬删」；这里不留销毁语句，免得将来有别的调用方绕过闸把它抹掉。表上没有指向
    // companies 的外键，公司行没了这些记录照样留得住。
    await this.run('delete from account_secrets where "accountId" in (select id from accounts where "companyId" = ?)', [id])
    await this.run('delete from accounts where "companyId" = ?', [id])
    await this.run('delete from plans where "companyId" = ?', [id])
    // 账单挂在订单上，先账单后订单，否则外键把订单卡住。
    await this.run('delete from topups where "companyId" = ?', [id])
    await this.run('delete from invoices where "companyId" = ?', [id])
    await this.run('delete from plan_orders where "companyId" = ?', [id])
    await this.run('delete from companies where id = ?', [id])
  }

  /**
   * 这家公司还剩多少条**要留档**的记录。
   *
   * 账单和用量有留存要求，而 deleteCompany 是硬删——两者冲突时以留档为准，
   * 所以删除路由拿它来决定是不是该改走「停用」。
   */
  async billingFootprint(id: string): Promise<{ invoices: number; orders: number; topups: number; llmCalls: number }> {
    const n = (r: Row | undefined) => Number((r as { n?: unknown } | undefined)?.n ?? 0)
    // 表名写死在四条语句里，不拼字符串——这个文件里的 SQL 一律只有占位符是变的。
    return {
      invoices: n(await this.one('select count(*)::int as n from invoices where "companyId" = ?', [id])),
      orders: n(await this.one('select count(*)::int as n from plan_orders where "companyId" = ?', [id])),
      topups: n(await this.one('select count(*)::int as n from topups where "companyId" = ?', [id])),
      llmCalls: n(await this.one('select count(*)::int as n from llm_calls where "companyId" = ?', [id])),
    }
  }

  async companies(): Promise<Company[]> {
    const rows = await this.many('select * from companies order by "createdAt"')
    return rows.map(companyOf)
  }

  // ── 账号 ──────────────────────────────────────────────────────────────

  async insertAccount(input: {
    companyId: string | null
    email: string
    passwordHash: string
    role: Role
    name?: string
    status?: AccountStatus
  }): Promise<Account> {
    let companyId = input.companyId
    if (input.role === 'owner') {
      if (companyId) throw new Error('owner 不能属于公司')
      companyId = null
    } else if (input.role === 'admin' || input.role === 'member') {
      if (!companyId) throw new Error('admin/member 必须属于公司')
    } else {
      throw new Error('未知角色')
    }
    const now = Date.now()
    const email = input.email
    const row: Account = {
      id: randomUUID(),
      companyId,
      email,
      name: (input.name ?? '').trim() || nameFromEmail(email),
      title: '',
      phone: '',
      theme: 'system',
      locale: 'zh',
      passwordHash: input.passwordHash,
      role: input.role,
      status: input.status ?? 'active',
      lastSeenAt: null,
      passwordChangedAt: null,
      tokenRevokedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into accounts (id, "companyId", email, name, title, phone, theme, locale, "passwordHash", role, status, "lastSeenAt", "passwordChangedAt", "tokenRevokedAt", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.companyId,
        row.email,
        row.name,
        row.title,
        row.phone,
        row.theme,
        row.locale,
        row.passwordHash,
        row.role,
        row.status,
        row.lastSeenAt,
        row.passwordChangedAt,
        row.tokenRevokedAt,
        row.createdAt,
        row.updatedAt,
      ],
    )
    if (row.role === 'admin' || row.role === 'member') await this.issueAccountSecrets(row.id)
    return row
  }

  async account(id: string): Promise<Account | undefined> {
    const r = await this.one('select * from accounts where id = ?', [id])
    return r ? accountOf(r) : undefined
  }

  async accountByEmail(email: string): Promise<Account | undefined> {
    const r = await this.one('select * from accounts where email = ?', [email])
    return r ? accountOf(r) : undefined
  }

  async accountsOf(companyId: string): Promise<Account[]> {
    const rows = await this.many('select * from accounts where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(accountOf)
  }

  async accountsAll(): Promise<Account[]> {
    const rows = await this.many('select * from accounts order by "createdAt"')
    return rows.map(accountOf)
  }

  async owners(): Promise<Account[]> {
    const rows = await this.many("select * from accounts where role = 'owner' order by \"createdAt\"")
    return rows.map(accountOf)
  }

  /** 占用席位：本公司非停用账号（owner 本来就不属于公司）。 */
  /**
   * 占席位这件事要串起来做：在事务里先锁住这家公司的套餐行，再数人、再写人。
   * 不锁的话两个请求可能同时读到「还剩一个席位」，各自放行，超出上限。
   */
  async lockPlan(companyId: string): Promise<void> {
    await this.one('select 1 from plans where "companyId" = ? for update', [companyId])
  }

  /** 占着席位的人：算 active 和 invited（邀请也占位），不算停用的，也不算 owner。 */
  async accountCount(companyId: string): Promise<number> {
    const r = await this.one(
      "select count(*) as n from accounts where \"companyId\" = ? and status != 'disabled' and role != 'owner'",
      [companyId],
    )
    return Number(r?.n ?? 0)
  }

  /** 还能管事的管理员：未停用的 admin（含待接受）。最后一个管理员靠它守门。 */
  async adminCount(companyId: string): Promise<number> {
    const r = await this.one(
      "select count(*) as n from accounts where \"companyId\" = ? and role = 'admin' and status != 'disabled'",
      [companyId],
    )
    return Number(r?.n ?? 0)
  }

  async updateAccount(
    id: string,
    patch: Partial<
      Pick<
        Account,
        | 'name'
        | 'title'
        | 'phone'
        | 'theme'
        | 'locale'
        | 'role'
        | 'status'
        | 'lastSeenAt'
        | 'passwordHash'
        | 'passwordChangedAt'
        | 'tokenRevokedAt'
      >
    >,
  ): Promise<Account> {
    const cur = await this.account(id)
    if (!cur) throw new Error('账号不存在')
    const next: Account = {
      ...cur,
      name: patch.name !== undefined ? patch.name : cur.name,
      title: patch.title !== undefined ? patch.title : cur.title,
      phone: patch.phone !== undefined ? patch.phone : cur.phone,
      theme: patch.theme ?? cur.theme,
      locale: patch.locale ?? cur.locale,
      role: patch.role ?? cur.role,
      status: patch.status ?? cur.status,
      lastSeenAt: patch.lastSeenAt !== undefined ? patch.lastSeenAt : cur.lastSeenAt,
      passwordHash: patch.passwordHash ?? cur.passwordHash,
      passwordChangedAt: patch.passwordChangedAt !== undefined ? patch.passwordChangedAt : cur.passwordChangedAt,
      tokenRevokedAt: patch.tokenRevokedAt !== undefined ? patch.tokenRevokedAt : cur.tokenRevokedAt,
      updatedAt: Date.now(),
    }
    await this.run(
      'update accounts set name=?, title=?, phone=?, theme=?, locale=?, role=?, status=?, "lastSeenAt"=?, "passwordHash"=?, "passwordChangedAt"=?, "tokenRevokedAt"=?, "updatedAt"=? where id=?',
      [
        next.name,
        next.title,
        next.phone,
        next.theme,
        next.locale,
        next.role,
        next.status,
        next.lastSeenAt,
        next.passwordHash,
        next.passwordChangedAt,
        next.tokenRevokedAt,
        next.updatedAt,
        id,
      ],
    )
    return next
  }

  async deleteAccount(id: string): Promise<void> {
    await this.tx(async () => {
      const cur = await this.account(id)
      await this.deleteInvitesForUser(id)
      await this.run('delete from session_index where "accountId" = ?', [id])
      await this.run('delete from instances where "accountId" = ?', [id])
      await this.run('delete from seat_runtimes where "accountId" = ?', [id])
      // 同上：删员工也不销毁他的用量记录。少了它，公司的历史用量会凭空缺一块，而
      // 「谁烧了多少」正是要留档的东西。accountId 变成悬空引用，统计里按 id 显示。
      await this.run('delete from account_secrets where "accountId" = ?', [id])
      // 他自己建的 Bot 跟着他走。catalog_items."accountId" 是真外键，留着这几行的话
      // 最后那句 delete from accounts 会直接外键报错，删员工整条路走不通。
      await this.run('delete from catalog_items where scope = \'user\' and "accountId" = ?', [id])
      if (cur?.companyId) {
        for (const g of await this.groupsOf(cur.companyId)) {
          if (!g.members.includes(id)) continue
          await this.updateGroup(g.id, { members: g.members.filter((m) => m !== id) })
        }
      }
      await this.run('delete from accounts where id = ?', [id])
    })
  }

  // ── 席位密钥。明文存，详情页给 owner 看；列表接口不许带出去。────────

  async accountSecrets(accountId: string): Promise<AccountSecrets | undefined> {
    const r = await this.one('select * from account_secrets where "accountId" = ?', [accountId])
    if (!r) return undefined
    return {
      accountId: str(r.accountId),
      apiKey: str(r.apiKey),
      accessToken: str(r.accessToken),
      createdAt: num(r.createdAt),
    }
  }

  async issueAccountSecrets(accountId: string): Promise<AccountSecrets | undefined> {
    const existing = await this.accountSecrets(accountId)
    if (existing) return existing
    const account = await this.account(accountId)
    if (!account || account.role === 'owner') return undefined
    for (let i = 0; i < 8; i++) {
      const apiKey = randomApiKey()
      const accessToken = randomAccessToken()
      const createdAt = Date.now()
      try {
        await this.run(
          'insert into account_secrets ("accountId", "apiKey", "accessToken", "createdAt") values (?,?,?,?)',
          [accountId, apiKey, accessToken, createdAt],
        )
        return { accountId, apiKey, accessToken, createdAt }
      } catch (e) {
        if (i === 7 || !isUniqueViolation(e)) throw e
      }
    }
    return undefined
  }

  /** 旧席位部署时补发。已有则原样返回。 */
  async ensureAccountSecrets(accountId: string): Promise<AccountSecrets | undefined> {
    return this.issueAccountSecrets(accountId)
  }

  async accountByApiKey(key: string): Promise<Account | undefined> {
    if (!key) return undefined
    const r = await this.one('select "accountId" from account_secrets where "apiKey" = ?', [key])
    return r ? this.account(str(r.accountId)) : undefined
  }

  async accountByAccessToken(token: string): Promise<Account | undefined> {
    if (!token) return undefined
    const r = await this.one('select "accountId" from account_secrets where "accessToken" = ?', [token])
    return r ? this.account(str(r.accountId)) : undefined
  }

  async insertLlmCall(input: {
    accountId: string
    companyId?: string | null
    provider: string
    model: string
    promptTokens?: number
    completionTokens?: number
    cachedTokens?: number
    cacheWriteTokens?: number
  }): Promise<LlmCall> {
    const row: LlmCall = {
      id: randomUUID(),
      accountId: input.accountId,
      companyId: input.companyId ?? null,
      provider: input.provider,
      model: input.model,
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
      cachedTokens: input.cachedTokens ?? 0,
      cacheWriteTokens: input.cacheWriteTokens ?? 0,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "cachedTokens", "cacheWriteTokens", "createdAt") values (?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.accountId,
        row.companyId,
        row.provider,
        row.model,
        row.promptTokens,
        row.completionTokens,
        row.cachedTokens,
        row.cacheWriteTokens,
        row.createdAt,
      ],
    )
    return row
  }

  async updateLlmCallTokens(
    id: string,
    usage: { prompt_tokens: number; completion_tokens: number; cached_tokens?: number; cache_write_tokens?: number },
  ): Promise<void> {
    await this.run(
      'update llm_calls set "promptTokens"=?, "completionTokens"=?, "cachedTokens"=?, "cacheWriteTokens"=? where id=?',
      [usage.prompt_tokens, usage.completion_tokens, usage.cached_tokens ?? 0, usage.cache_write_tokens ?? 0, id],
    )
  }

  async insertWebCall(input: {
    accountId: string
    companyId?: string | null
    kind: WebCallKind
    backend: string
    units: number
  }): Promise<WebCall> {
    const row: WebCall = {
      id: randomUUID(),
      accountId: input.accountId,
      companyId: input.companyId ?? null,
      kind: input.kind,
      backend: input.backend,
      units: input.units,
      // 同 connector_calls：钱在账本里，这一列留给老行，新行恒为 0。
      mils: 0,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into web_calls (id, "accountId", "companyId", kind, backend, units, mils, "createdAt") values (?,?,?,?,?,?,?,?)',
      [row.id, row.accountId, row.companyId, row.kind, row.backend, row.units, row.mils, row.createdAt],
    )
    return row
  }

  /** 按公司 × 后端 × 类型汇总。金额直接求和——它已经是当时的报价，不重算。 */
  async webUsageByCompanyBackend(
    range?: { from?: number; to?: number },
    companyId?: string,
  ): Promise<{ companyId: string | null; backend: string; kind: string; calls: number; units: number; amountMicros: number; lastAt: number | null }[]> {
    const r = this.llmRangeSql(range)
    const args: unknown[] = [...r.args]
    let where = `where 1=1${r.sql}`
    if (companyId) {
      where += ' and "companyId" = ?'
      args.push(companyId)
    }
    // 金额按 refId 从账本接回来。web_calls 有 backend / kind / units 这些账本里没有的
    // 维度，账本有钱——两边各出各的那一半（docs/billing.md §2）。老行的钱还在 mils 上，
    // 回填脚本会把它们翻成账本行，所以这里只认账本，不再 `sum(mils)`。
    const rows = await this.many(
      `select w."companyId", w.backend, w.kind, count(*) as calls,
              coalesce(sum(w.units), 0) as units,
              coalesce(sum(u."amountMicros"), 0) as micros,
              max(w."createdAt") as "lastAt"
       from web_calls w left join usage_charges u on u."refId" = w.id
       ${where.replace(/"companyId"/g, 'w."companyId"').replace(/"createdAt"/g, 'w."createdAt"')}
       group by w."companyId", w.backend, w.kind`,
      args,
    )
    return rows.map((row) => ({
      companyId: strOrNull(row.companyId),
      backend: str(row.backend),
      kind: str(row.kind),
      calls: num(row.calls),
      units: num(row.units),
      amountMicros: num(row.micros),
      lastAt: row.lastAt == null ? null : num(row.lastAt),
    }))
  }

  /** 这家公司从某个时刻起用了多少次。配额闸用它，所以只数条数不取行。 */
  async webCallCountSince(companyId: string, since: number): Promise<number> {
    const r = await this.one('select count(*)::int as n from web_calls where "companyId" = ? and "createdAt" >= ?', [
      companyId,
      since,
    ])
    return num(r?.n ?? 0)
  }

  async webCallsOfCompany(companyId: string): Promise<WebCall[]> {
    const rows = await this.many('select * from web_calls where "companyId" = ? order by "createdAt" desc', [companyId])
    return rows.map((r) => ({
      id: str(r.id),
      accountId: str(r.accountId),
      companyId: strOrNull(r.companyId),
      kind: str(r.kind) as WebCallKind,
      backend: str(r.backend),
      units: num(r.units),
      mils: num(r.mils),
      createdAt: num(r.createdAt),
    }))
  }

  async llmCallsOfCompany(companyId: string): Promise<LlmCall[]> {
    const rows = await this.many('select * from llm_calls where "companyId" = ? order by "createdAt" desc', [companyId])
    return rows.map((r) => ({
      id: str(r.id),
      accountId: str(r.accountId),
      companyId: strOrNull(r.companyId),
      provider: str(r.provider),
      model: str(r.model),
      promptTokens: num(r.promptTokens),
      completionTokens: num(r.completionTokens),
      cachedTokens: num(r.cachedTokens),
      cacheWriteTokens: num(r.cacheWriteTokens),
      createdAt: num(r.createdAt),
    }))
  }

  private llmRangeSql(range?: { from?: number; to?: number }): { sql: string; args: number[] } {
    let sql = ''
    const args: number[] = []
    if (range?.from != null) {
      sql += ' and "createdAt" >= ?'
      args.push(range.from)
    }
    if (range?.to != null) {
      sql += ' and "createdAt" <= ?'
      args.push(range.to)
    }
    return { sql, args }
  }

  private async llmUsageBy(
    column: 'companyId' | 'accountId',
    value: string,
    range?: { from?: number; to?: number },
  ): Promise<LlmUsage> {
    const r = this.llmRangeSql(range)
    const total = await this.one(
      `select count(*) as calls, coalesce(sum("promptTokens"), 0) as "promptTokens", coalesce(sum("completionTokens"), 0) as "completionTokens" from llm_calls where "${column}" = ?${r.sql}`,
      [value, ...r.args],
    )
    const by = await this.many(
      `select "accountId", count(*) as calls, coalesce(sum("promptTokens"), 0) as "promptTokens", coalesce(sum("completionTokens"), 0) as "completionTokens", max("createdAt") as "lastAt" from llm_calls where "${column}" = ?${r.sql} group by "accountId"`,
      [value, ...r.args],
    )
    return {
      calls: num(total?.calls ?? 0),
      promptTokens: num(total?.promptTokens ?? 0),
      completionTokens: num(total?.completionTokens ?? 0),
      byAccount: by.map((row) => ({
        accountId: str(row.accountId),
        calls: num(row.calls),
        promptTokens: num(row.promptTokens),
        completionTokens: num(row.completionTokens),
        lastAt: numOrNull(row.lastAt),
      })),
    }
  }

  /**
   * 每日调用数，给用量屏那根日线。
   *
   * **按看的人所在时区切天。** 服务端不知道那是哪个时区（同 `/platform/stats` 的窗口
   * 一样由前端算好传上来），所以切桶之前先把时间平移 `offsetMs`——不平移的话，东八区
   * 早上八点之前的调用会落进前一天，整条日线左移一格，而这种错在图上看不出来。
   *
   * 返回的是桶号（平移之后的天序号），不是日期字符串：日期怎么写是显示的事，
   * 而且 SQL 里格式化日期还得再引入一次时区。
   */
  async llmDailyBy(
    column: 'companyId' | 'accountId',
    value: string,
    range?: { from?: number; to?: number },
    offsetMs = 0,
  ): Promise<{ bucket: number; calls: number }[]> {
    const r = this.llmRangeSql(range)
    const rows = await this.many(
      `select floor(("createdAt" + ?) / 86400000.0)::bigint as bucket, count(*) as calls
       from llm_calls where "${column}" = ?${r.sql}
       group by bucket order by bucket`,
      [offsetMs, value, ...r.args],
    )
    return rows.map((row) => ({ bucket: num(row.bucket), calls: num(row.calls) }))
  }

  llmUsageOfCompany(companyId: string, range?: { from?: number; to?: number }): Promise<LlmUsage> {
    return this.llmUsageBy('companyId', companyId, range)
  }

  llmUsageOfAccount(accountId: string, range?: { from?: number; to?: number }): Promise<LlmUsage> {
    return this.llmUsageBy('accountId', accountId, range)
  }

  /**
   * 平台统计的底表：按 (公司, 供应商, 模型) 汇总。
   *
   * 折成金额要按模型单价算，所以必须细到模型这一层再聚合——只按公司汇总的话
   * 拿不回每条调用用的是哪个模型，价就算不出来。
   * companyId 为 null 的是 owner 自己的调用，原样留着，由上层标成「平台」。
   *
   * **`cachedTokens` 必须一起汇总。** 它是 `promptTokens` 的子集，而缓存读的单价
   * 低得多（Anthropic 是输入价的十分之一）。少了这一列，上层只能把整个提示词按
   * 输入价算——一个 Bot 一条长会话、系统提示词稳定，正是缓存命中率最高的形态，
   * 于是缓存命中率越高、账面越虚，而 quotedUsd 是报给公司的价。
   */
  async llmUsageByCompanyModel(
    range?: { from?: number; to?: number },
    companyId?: string,
    accountId?: string,
  ): Promise<CompanyModelUsage[]> {
    const r = this.llmRangeSql(range)
    let where = `where 1=1${r.sql}`
    const args: (number | string)[] = [...r.args]
    if (companyId) {
      where += ' and "companyId" = ?'
      args.push(companyId)
    }
    // 员工自己那一屏按人过滤：同一段聚合，只是范围小一圈。
    if (accountId) {
      where += ' and "accountId" = ?'
      args.push(accountId)
    }
    /**
     * `unledgeredCalls`：这一组里**账本上根本没有对应行**的调用数。
     *
     * 金额只从账本来之后，「按 $0 收了」和「压根没记过账」在结果里长得一模一样，
     * 而后者恰恰是升级前所有历史调用的样子（回填脚本刻意不给模型调用补金额）。
     * 不把它数出来的话，翻上个月看到的是真实的 token 配一个 $0.00 加零句提示——
     * 那正是这套代码一直在防的「$0.00 被读成免费」。
     */
    const rows = await this.many(
      `select l."companyId", l.provider, l.model, count(*) as calls,
              coalesce(sum(l."promptTokens"), 0) as "promptTokens",
              coalesce(sum(l."completionTokens"), 0) as "completionTokens",
              coalesce(sum(l."cachedTokens"), 0) as "cachedTokens",
              coalesce(sum(l."cacheWriteTokens"), 0) as "cacheWriteTokens",
              coalesce(sum(case when u.id is null then 1 else 0 end), 0) as "unledgeredCalls",
              max(l."createdAt") as "lastAt"
       from llm_calls l left join usage_charges u on u."refId" = l.id
       ${where.replace(/"(companyId|accountId|createdAt)"/g, 'l."$1"')}
       group by l."companyId", l.provider, l.model
       order by l."companyId", l.provider, l.model`,
      args,
    )
    return rows.map((row) => ({
      companyId: strOrNull(row.companyId),
      provider: str(row.provider),
      model: str(row.model),
      calls: num(row.calls),
      promptTokens: num(row.promptTokens),
      completionTokens: num(row.completionTokens),
      cachedTokens: num(row.cachedTokens),
      cacheWriteTokens: num(row.cacheWriteTokens),
      unledgeredCalls: num(row.unledgeredCalls),
      lastAt: numOrNull(row.lastAt),
    }))
  }

  // ── 连接器：安装、连接、调用流水。见 docs/connectors.md §10。────────

  async connectorInstalls(accountId: string): Promise<ConnectorInstall[]> {
    const rows = await this.many('select * from connector_installs where "accountId" = ? order by "createdAt"', [accountId])
    return rows.map(connectorInstallOf)
  }

  /** 一家公司谁装了什么。admin 那一屏唯一能看清攻击面的地方。 */
  async connectorInstallsOfCompany(companyId: string): Promise<ConnectorInstall[]> {
    const rows = await this.many('select * from connector_installs where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(connectorInstallOf)
  }

  async connectorInstall(connectorId: string, accountId: string): Promise<ConnectorInstall | undefined> {
    const r = await this.one('select * from connector_installs where "connectorId" = ? and "accountId" = ?', [connectorId, accountId])
    return r ? connectorInstallOf(r) : undefined
  }

  /**
   * 装一个。**已经装了就原样返回**，不报错也不重置工具开关——重复点「安装」是
   * 用户会做的事（网络慢、手抖），把它变成一次静默的配置重置就太狠了。
   */
  async installConnector(input: {
    connectorId: string
    accountId: string
    companyId: string
    /**
     * 装上默认开哪几个。空 = 写 `[]`，也就是全开。
     *
     * **`[]` = 全开这个口径不动。** 已经装好的那些存的就是 `[]`，改口径等于让现存
     * 用户的工具悄悄少掉一批。改的只是「新装的时候写什么进去」（docs/tool-search.md §2）。
     */
    enabledTools?: string[]
  }): Promise<ConnectorInstall> {
    const cur = await this.connectorInstall(input.connectorId, input.accountId)
    if (cur) return cur
    const now = Date.now()
    const row: ConnectorInstall = {
      id: randomUUID(),
      connectorId: input.connectorId,
      accountId: input.accountId,
      companyId: input.companyId,
      enabledTools: input.enabledTools ?? [],
      createdAt: now,
      updatedAt: now,
    }
    try {
      await this.run(
        'insert into connector_installs (id, "connectorId", "accountId", "companyId", "enabledTools", "createdAt", "updatedAt") values (?,?,?,?,?,?,?)',
        [row.id, row.connectorId, row.accountId, row.companyId, JSON.stringify(row.enabledTools), row.createdAt, row.updatedAt],
      )
    } catch (e) {
      // 两次点击撞在一起：唯一索引兜住，取回已有的那条。
      if (!isUniqueViolation(e)) throw e
      return (await this.connectorInstall(input.connectorId, input.accountId))!
    }
    return row
  }

  async setInstallTools(id: string, enabledTools: string[]): Promise<ConnectorInstall | undefined> {
    await this.run('update connector_installs set "enabledTools" = ?, "updatedAt" = ? where id = ?', [
      JSON.stringify(enabledTools),
      Date.now(),
      id,
    ])
    const r = await this.one('select * from connector_installs where id = ?', [id])
    return r ? connectorInstallOf(r) : undefined
  }

  async deleteConnectorInstall(id: string): Promise<void> {
    await this.run('delete from connector_installs where id = ?', [id])
  }

  async connectorConnection(id: string): Promise<ConnectorConnection | undefined> {
    const r = await this.one('select * from connector_connections where id = ?', [id])
    return r ? connectorConnectionOf(r) : undefined
  }

  /**
   * 这个账号能用的所有连接：自己的，加上本公司共用的那些。
   *
   * 合成工具表、`@` 选单、计费归属都从这一条出发——「能用哪些」只有一个来源，
   * 免得三处各写一遍再慢慢分叉。
   */
  async connectionsFor(accountId: string, companyId: string | null): Promise<ConnectorConnection[]> {
    const rows = companyId
      ? await this.many(
          'select * from connector_connections where ("accountId" = ? and scope = \'user\') or ("companyId" = ? and scope = \'company\') order by "createdAt"',
          [accountId, companyId],
        )
      : await this.many('select * from connector_connections where "accountId" = ? and scope = \'user\' order by "createdAt"', [accountId])
    return rows.map(connectorConnectionOf)
  }

  async connectionsOfCompany(companyId: string): Promise<ConnectorConnection[]> {
    const rows = await this.many('select * from connector_connections where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(connectorConnectionOf)
  }

  async insertConnectorConnection(input: {
    connectorId: string
    vendor: string
    scope: ConnectionScope
    label: string
    accountId: string | null
    companyId: string
    externalUserId: string
    mentionOnly?: boolean
  }): Promise<ConnectorConnection> {
    const now = Date.now()
    const row: ConnectorConnection = {
      id: randomUUID(),
      connectorId: input.connectorId,
      vendor: input.vendor,
      scope: input.scope,
      label: input.label,
      accountId: input.accountId,
      companyId: input.companyId,
      externalUserId: input.externalUserId,
      externalId: null,
      status: 'pending',
      mentionOnly: input.mentionOnly ?? false,
      lastError: null,
      connectedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into connector_connections (id, "connectorId", vendor, scope, label, "accountId", "companyId", "externalUserId", "externalId", status, "mentionOnly", "lastError", "connectedAt", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.connectorId,
        row.vendor,
        row.scope,
        row.label,
        row.accountId,
        row.companyId,
        row.externalUserId,
        row.externalId,
        row.status,
        row.mentionOnly,
        row.lastError,
        row.connectedAt,
        row.createdAt,
        row.updatedAt,
      ],
    )
    return row
  }

  async updateConnectorConnection(
    id: string,
    patch: {
      label?: string
      externalId?: string | null
      status?: ConnectionStatus
      mentionOnly?: boolean
      lastError?: string | null
      connectedAt?: number | null
    },
  ): Promise<ConnectorConnection | undefined> {
    const cur = await this.connectorConnection(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    await this.run(
      'update connector_connections set label=?, "externalId"=?, status=?, "mentionOnly"=?, "lastError"=?, "connectedAt"=?, "updatedAt"=? where id=?',
      [next.label, next.externalId, next.status, next.mentionOnly, next.lastError, next.connectedAt, next.updatedAt, id],
    )
    return next
  }

  async deleteConnectorConnection(id: string): Promise<void> {
    await this.run('delete from connector_connections where id = ?', [id])
  }

  async insertConnectorCall(input: {
    companyId: string | null
    accountId: string
    connectionId?: string | null
    botId?: string | null
    sessionId?: string | null
    vendor: string
    connector: string
    label?: string
    tool: string
    status: ConnectorCallStatus
    latencyMs?: number
    viaMention?: boolean
  }): Promise<ConnectorCall> {
    const row: ConnectorCall = {
      id: randomUUID(),
      companyId: input.companyId,
      accountId: input.accountId,
      connectionId: input.connectionId ?? null,
      botId: input.botId ?? null,
      sessionId: input.sessionId ?? null,
      vendor: input.vendor,
      connector: input.connector,
      label: input.label ?? '',
      tool: input.tool,
      status: input.status,
      // 钱不在这张表里了，见 docs/billing.md §2：账本（usage_charges）是唯一的钱。
      // 这两列留着是为了老行，新行恒为 0——统计要金额时按 refId 去账本上取。
      amountMicros: 0,
      bonusMicros: 0,
      latencyMs: Math.max(0, Math.trunc(input.latencyMs ?? 0)),
      viaMention: input.viaMention ?? false,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into connector_calls (id, "companyId", "accountId", "connectionId", "botId", "sessionId", vendor, connector, label, tool, status, "amountMicros", "bonusMicros", "latencyMs", "viaMention", "createdAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.companyId,
        row.accountId,
        row.connectionId,
        row.botId,
        row.sessionId,
        row.vendor,
        row.connector,
        row.label,
        row.tool,
        row.status,
        row.amountMicros,
        row.bonusMicros,
        row.latencyMs,
        row.viaMention,
        row.createdAt,
      ],
    )
    return row
  }

  /**
   * 连接器用量：一次查询给出四种切法。
   *
   * 按 (谁 / 连接器 / 工具 / 状态) 分别 group by，而不是把原始行拉回来在 JS 里算——
   * 一天几万行，拉回来就是拿内存换一句 SQL。
   *
   * 金额直接 `sum(amountMicros)`，**不按当前单价现折**：单价改过之后，历史账不能跟着
   * 一起变（docs/connectors.md §9）。
   */
  async connectorUsage(
    scope: { companyId?: string | null; accountId?: string },
    range?: { from?: number; to?: number },
  ): Promise<{
    total: { calls: number; amountMicros: number; lastAt: number | null }
    byStatus: { status: string; calls: number; amountMicros: number }[]
    byAccount: { accountId: string; calls: number; amountMicros: number; lastAt: number | null }[]
    byConnector: { connector: string; label: string; calls: number; amountMicros: number }[]
    byTool: { connector: string; tool: string; calls: number; amountMicros: number }[]
  }> {
    const where: string[] = ['1=1']
    const args: (string | number)[] = []
    if (scope.accountId) {
      where.push('"accountId" = ?')
      args.push(scope.accountId)
    }
    if (scope.companyId) {
      where.push('"companyId" = ?')
      args.push(scope.companyId)
    }
    if (range?.from != null) {
      where.push('"createdAt" >= ?')
      args.push(range.from)
    }
    if (range?.to != null) {
      where.push('"createdAt" <= ?')
      args.push(range.to)
    }
    // 维度在 connector_calls（label / tool / 状态），钱在账本，按 refId 接起来。
    const w = where.join(' and ').replace(/"(accountId|companyId|createdAt)"/g, 'c."$1"')
    const from = 'from connector_calls c left join usage_charges u on u."refId" = c.id'
    const g = async (cols: string, group: string) =>
      this.many(
        `select ${cols}, count(*) as calls, coalesce(sum(u."amountMicros"), 0) as micros, max(c."createdAt") as "lastAt" ${from} where ${w} group by ${group}`,
        args,
      )

    const total = await this.one(
      `select count(*) as calls, coalesce(sum(u."amountMicros"), 0) as micros, max(c."createdAt") as "lastAt" ${from} where ${w}`,
      args,
    )
    const byStatus = await g('c.status', 'c.status')
    const byAccount = await g('c."accountId"', 'c."accountId"')
    const byConnector = await g('c.connector, c.label', 'c.connector, c.label')
    const byTool = await g('c.connector, c.tool', 'c.connector, c.tool')
    return {
      total: { calls: num(total?.calls ?? 0), amountMicros: num(total?.micros ?? 0), lastAt: numOrNull(total?.lastAt) },
      byStatus: byStatus.map((r) => ({ status: str(r.status), calls: num(r.calls), amountMicros: num(r.micros) })),
      byAccount: byAccount.map((r) => ({
        accountId: str(r.accountId),
        calls: num(r.calls),
        amountMicros: num(r.micros),
        lastAt: numOrNull(r.lastAt),
      })),
      byConnector: byConnector.map((r) => ({
        connector: str(r.connector),
        label: str(r.label || ''),
        calls: num(r.calls),
        amountMicros: num(r.micros),
      })),
      byTool: byTool.map((r) => ({
        connector: str(r.connector),
        tool: str(r.tool),
        calls: num(r.calls),
        amountMicros: num(r.micros),
      })),
    }
  }

  /** 平台统计的底表：按 (公司, 连接器) 汇总。owner 的调用 companyId 为 null，原样留着。 */
  async connectorUsageByCompany(range?: { from?: number; to?: number }): Promise<
    { companyId: string | null; connector: string; calls: number; amountMicros: number; lastAt: number | null }[]
  > {
    const where: string[] = ['1=1']
    const args: number[] = []
    if (range?.from != null) {
      where.push('"createdAt" >= ?')
      args.push(range.from)
    }
    if (range?.to != null) {
      where.push('"createdAt" <= ?')
      args.push(range.to)
    }
    const rows = await this.many(
      `select c."companyId", c.connector, count(*) as calls,
              coalesce(sum(u."amountMicros"), 0) as micros, max(c."createdAt") as "lastAt"
       from connector_calls c left join usage_charges u on u."refId" = c.id
       where ${where.join(' and ').replace(/"createdAt"/g, 'c."createdAt"')}
       group by c."companyId", c.connector order by c."companyId", c.connector`,
      args,
    )
    return rows.map((r) => ({
      companyId: strOrNull(r.companyId),
      connector: str(r.connector),
      calls: num(r.calls),
      amountMicros: num(r.micros),
      lastAt: numOrNull(r.lastAt),
    }))
  }

  // ── 计费账本。**钱只在这张表里**，领域表只记事实。见 docs/billing.md。───

  async insertUsageCharge(input: {
    companyId: string | null
    accountId: string
    botId?: string | null
    sessionId?: string | null
    kind: ChargeKind
    subject: string
    status: ChargeStatus
    quantity?: Record<string, number>
    unitPrice?: Record<string, number>
    multiplier?: number
    amountMicros?: number
    bonusMicros?: number
    unpriced?: boolean
    refId?: string | null
  }): Promise<UsageCharge> {
    const amount = Math.max(0, Math.trunc(input.amountMicros ?? 0))
    const row: UsageCharge = {
      id: randomUUID(),
      companyId: input.companyId,
      accountId: input.accountId,
      botId: input.botId ?? null,
      sessionId: input.sessionId ?? null,
      kind: input.kind,
      subject: input.subject,
      status: input.status,
      quantity: input.quantity ?? {},
      unitPrice: input.unitPrice ?? {},
      multiplier: input.multiplier ?? 1,
      amountMicros: amount,
      // 赠送承担的不可能超过总额——脏数据也不能算出负的「充值承担」（同 0005 的处理）。
      bonusMicros: Math.min(Math.max(0, Math.trunc(input.bonusMicros ?? 0)), amount),
      unpriced: input.unpriced === true,
      refId: input.refId ?? null,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into usage_charges (id, "companyId", "accountId", "botId", "sessionId", kind, subject, status, quantity, "unitPrice", multiplier, "amountMicros", "bonusMicros", unpriced, "refId", "createdAt") values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.companyId,
        row.accountId,
        row.botId,
        row.sessionId,
        row.kind,
        row.subject,
        row.status,
        JSON.stringify(row.quantity),
        JSON.stringify(row.unitPrice),
        row.multiplier,
        row.amountMicros,
        row.bonusMicros,
        row.unpriced,
        row.refId,
        row.createdAt,
      ],
    )
    return row
  }

  /**
   * 这家公司在两个桶上各花了多少（微元）。**三条计费路一起算**——账本是唯一的钱。
   *
   * - **套餐赠送**跟着账期，到期作废，所以只统计 `bonusSince`（当前账期起点）之后的。
   * - **充值**不过期，累计全部历史。
   *
   * 合成一个数的话，套餐一到期，它已经花掉的部分会从充值余额上再扣一遍（见迁移 0005）。
   */
  async chargeSpend(companyId: string, bonusSince: number | null): Promise<{ bonusMicros: number; topupMicros: number }> {
    const topup = await this.one(
      'select coalesce(sum("amountMicros" - "bonusMicros"), 0) as spent from usage_charges where "companyId" = ?',
      [companyId],
    )
    const bonus =
      bonusSince == null
        ? undefined
        : await this.one(
            'select coalesce(sum("bonusMicros"), 0) as spent from usage_charges where "companyId" = ? and "createdAt" >= ?',
            [companyId, bonusSince],
          )
    return { bonusMicros: num(bonus?.spent ?? 0), topupMicros: num(topup?.spent ?? 0) }
  }

  /** 从某个时刻起一共扣了多少微元。账单屏的「本期已扣」用它。 */
  async chargeSpentSince(companyId: string, since: number): Promise<number> {
    const r = await this.one(
      'select coalesce(sum("amountMicros"), 0) as spent from usage_charges where "companyId" = ? and "createdAt" >= ?',
      [companyId, since],
    )
    return num(r?.spent ?? 0)
  }

  async usageCharge(id: string): Promise<UsageCharge | undefined> {
    const r = await this.one('select * from usage_charges where id = ?', [id])
    return r ? usageChargeOf(r) : undefined
  }

  /**
   * 计费明细一页。游标是 `${createdAt}:${id}`，和会话索引那套一样（routes/sessions.ts）。
   *
   * **必须接口分页。** 平台那四张长表是前端切页的（一次拉齐、切的是已经拿到的数据），
   * 理由是「问题不在拉不动，在一屏塞不下」。账本不一样：一家公司一天就能产生几千行，
   * 一次拉齐是真的拉不动。
   */
  async listUsageCharges(filter: {
    companyId?: string
    accountId?: string
    botId?: string
    kind?: ChargeKind
    status?: ChargeStatus
    from?: number
    to?: number
    limit?: number
    before?: { createdAt: number; id: string }
  }): Promise<UsageCharge[]> {
    let sql = 'select * from usage_charges where 1=1'
    const args: unknown[] = []
    // companyId 为 null 的是 owner 自己的调用。传了 companyId 就只看这一家，
    // 不传就是全平台（含平台自己那些）。
    if (filter.companyId) {
      sql += ' and "companyId" = ?'
      args.push(filter.companyId)
    }
    if (filter.accountId) {
      sql += ' and "accountId" = ?'
      args.push(filter.accountId)
    }
    if (filter.botId) {
      sql += ' and "botId" = ?'
      args.push(filter.botId)
    }
    if (filter.kind) {
      sql += ' and kind = ?'
      args.push(filter.kind)
    }
    if (filter.status) {
      sql += ' and status = ?'
      args.push(filter.status)
    }
    if (filter.from != null) {
      sql += ' and "createdAt" >= ?'
      args.push(filter.from)
    }
    if (filter.to != null) {
      sql += ' and "createdAt" <= ?'
      args.push(filter.to)
    }
    if (filter.before) {
      // 同一毫秒里可能有好几行，光比时间会漏掉或重复。带上 id 当第二把钥匙。
      sql += ' and ("createdAt", id) < (?, ?)'
      args.push(filter.before.createdAt, filter.before.id)
    }
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? CHARGE_PAGE_DEFAULT), 1), CHARGE_PAGE_MAX + 1)
    sql += ' order by "createdAt" desc, id desc limit ?'
    args.push(limit)
    return (await this.many(sql, args)).map(usageChargeOf)
  }

  /**
   * 账本汇总：按公司 × 类型。统计屏用它。
   *
   * **只 sum，不按当前单价重算**——金额在写行那一刻就定死了（docs/billing.md §2）。
   */
  async chargeUsageBy(
    columns: ('companyId' | 'accountId' | 'botId' | 'kind' | 'subject')[],
    range?: { from?: number; to?: number },
    filter?: { companyId?: string; accountId?: string },
  ): Promise<{ companyId: string | null; accountId: string; botId: string | null; kind: string; subject: string; calls: number; amountMicros: number; bonusMicros: number; costMicros: number; unpricedCalls: number; lastAt: number | null }[]> {
    const cols = columns.map((c) => `"${c}"`).join(', ')
    const r = this.llmRangeSql(range)
    let where = `where 1=1${r.sql}`
    const args: unknown[] = [...r.args]
    if (filter?.companyId) {
      where += ' and "companyId" = ?'
      args.push(filter.companyId)
    }
    if (filter?.accountId) {
      where += ' and "accountId" = ?'
      args.push(filter.accountId)
    }
    const rows = await this.many(
      `select ${cols}, count(*) as calls,
              coalesce(sum("amountMicros"), 0) as "amountMicros",
              coalesce(sum("bonusMicros"), 0) as "bonusMicros",
              -- 原价是**倒推**的：成交额 ÷ 当时的倍率。账本存倍率而不是原价，因为
              -- 倍率只有一个数、原价有四项；除法在这里做，历史行各按各的倍率还原。
              coalesce(sum("amountMicros" / greatest(multiplier, 0.0001)), 0) as "costMicros",
              coalesce(sum(case when unpriced then 1 else 0 end), 0) as "unpricedCalls",
              max("createdAt") as "lastAt"
       from usage_charges ${where}
       group by ${cols}`,
      args,
    )
    return rows.map((row) => ({
      companyId: columns.includes('companyId') ? strOrNull(row.companyId) : null,
      accountId: columns.includes('accountId') ? str(row.accountId) : '',
      // 模型那条路还填不上 botId（`/v1/*` 收到的请求里没有会话这个概念，见 lib/meter.ts），
      // 所以这一维只覆盖填得上的那些调用。null 原样留着，由上层决定怎么标。
      botId: columns.includes('botId') ? strOrNull(row.botId) : null,
      kind: columns.includes('kind') ? str(row.kind) : '',
      subject: columns.includes('subject') ? str(row.subject) : '',
      calls: num(row.calls),
      amountMicros: num(row.amountMicros),
      bonusMicros: num(row.bonusMicros),
      costMicros: Math.round(num(row.costMicros)),
      unpricedCalls: num(row.unpricedCalls),
      lastAt: numOrNull(row.lastAt),
    }))
  }

  // ── 分组。全体成员是算出来的，不进这张表。──────────────────────────

  async groupsOf(companyId: string): Promise<Group[]> {
    const rows = await this.many('select * from groups where "companyId" = ? order by "createdAt"', [companyId])
    return rows.map(groupOf)
  }

  async group(id: string): Promise<Group | undefined> {
    const r = await this.one('select * from groups where id = ?', [id])
    return r ? groupOf(r) : undefined
  }

  async insertGroup(input: {
    companyId: string
    name: string
    desc?: string
    icon?: string
    role: 'admin' | 'member'
    members?: string[]
    agents?: string[]
  }): Promise<Group> {
    const row: Group = {
      id: randomUUID(),
      companyId: input.companyId,
      name: input.name,
      desc: input.desc ?? '',
      icon: input.icon || 'chat',
      role: input.role,
      members: input.members ?? [],
      agents: input.agents ?? [],
      createdAt: Date.now(),
    }
    await this.run(
      'insert into groups (id, "companyId", name, "desc", icon, role, members, agents, "createdAt") values (?,?,?,?,?,?,?,?,?)',
      [
        row.id,
        row.companyId,
        row.name,
        row.desc,
        row.icon,
        row.role,
        JSON.stringify(row.members),
        JSON.stringify(row.agents),
        row.createdAt,
      ],
    )
    return row
  }

  async updateGroup(
    id: string,
    patch: Partial<Pick<Group, 'name' | 'desc' | 'icon' | 'role' | 'members' | 'agents'>>,
  ): Promise<Group> {
    const cur = await this.group(id)
    if (!cur) throw new Error('分组不存在')
    const next: Group = {
      ...cur,
      name: patch.name !== undefined ? patch.name : cur.name,
      desc: patch.desc !== undefined ? patch.desc : cur.desc,
      icon: patch.icon !== undefined ? patch.icon : cur.icon,
      role: patch.role ?? cur.role,
      members: patch.members !== undefined ? patch.members : cur.members,
      agents: patch.agents !== undefined ? patch.agents : cur.agents,
    }
    await this.run('update groups set name=?, "desc"=?, icon=?, role=?, members=?, agents=? where id=?', [
      next.name,
      next.desc,
      next.icon,
      next.role,
      JSON.stringify(next.members),
      JSON.stringify(next.agents),
      id,
    ])
    return next
  }

  async deleteGroup(id: string): Promise<boolean> {
    return (await this.run('delete from groups where id = ?', [id])) > 0
  }

  // ── 邀请 ──────────────────────────────────────────────────────────────

  async putInvite(row: Invite): Promise<Invite> {
    await this.run(
      'insert into invites (id, "userId", "companyId", "createdBy", "createdAt", "expiresAt") values (?,?,?,?,?,?)',
      [row.id, row.userId, row.companyId, row.createdBy, row.createdAt, row.expiresAt],
    )
    return row
  }

  async invite(id: string): Promise<Invite | undefined> {
    const r = await this.one('select * from invites where id = ?', [id])
    return r ? inviteOf(r) : undefined
  }

  async deleteInvitesForUser(userId: string): Promise<void> {
    await this.run('delete from invites where "userId" = ?', [userId])
  }

  async deleteInvite(id: string): Promise<void> {
    await this.run('delete from invites where id = ?', [id])
  }

  // ── 套餐 ──────────────────────────────────────────────────────────────

  /** 套餐和到期时间是可选补丁：不传就保持原样，传 null 才是清空。 */
  async upsertPlan(
    companyId: string,
    seats: number,
    patch: { skuId?: string | null; expiresAt?: number | null } = {},
  ): Promise<Plan> {
    const now = Date.now()
    const cur = await this.plan(companyId)
    const next: Plan = {
      companyId,
      seats,
      skuId: patch.skuId === undefined ? (cur?.skuId ?? null) : patch.skuId,
      expiresAt: patch.expiresAt === undefined ? (cur?.expiresAt ?? null) : patch.expiresAt,
      updatedAt: now,
    }
    await this.run(
      'insert into plans ("companyId", seats, "skuId", "expiresAt", "updatedAt") values (?,?,?,?,?) on conflict ("companyId") do update set seats=excluded.seats, "skuId"=excluded."skuId", "expiresAt"=excluded."expiresAt", "updatedAt"=excluded."updatedAt"',
      [companyId, next.seats, next.skuId, next.expiresAt, next.updatedAt],
    )
    return next
  }

  async plan(companyId: string): Promise<Plan | undefined> {
    const r = await this.one('select * from plans where "companyId" = ?', [companyId])
    return r ? planOf(r) : undefined
  }

  // ── 套餐 SKU（价目表）────────────────────────────────────────────────

  async planSkus(): Promise<PlanSku[]> {
    const rows = await this.many('select * from plan_skus order by "amountMils", "createdAt"')
    return rows.map(planSkuOf)
  }

  async planSku(id: string): Promise<PlanSku | undefined> {
    const r = await this.one('select * from plan_skus where id = ?', [id])
    return r ? planSkuOf(r) : undefined
  }

  /** 按名字找。中英两列都查——重名要挡的是「界面上看着一样」，不分哪一列。 */
  async planSkuByName(name: string): Promise<PlanSku | undefined> {
    const r = await this.one('select * from plan_skus where name = ? or ("nameEn" <> \'\' and "nameEn" = ?)', [name, name])
    return r ? planSkuOf(r) : undefined
  }

  async insertPlanSku(input: {
    name: string
    nameEn?: string
    amountMils: number
    seats: number
    period?: PlanPeriod
    bonusMils?: number
  }): Promise<PlanSku> {
    const now = Date.now()
    const row: PlanSku = {
      id: randomUUID(),
      name: input.name,
      nameEn: input.nameEn ?? '',
      amountMils: input.amountMils,
      seats: input.seats,
      period: input.period ?? 'month',
      bonusMils: input.bonusMils ?? 0,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into plan_skus (id, name, "nameEn", "amountMils", seats, period, "bonusMils", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?)',
      [row.id, row.name, row.nameEn, row.amountMils, row.seats, row.period, row.bonusMils, row.createdAt, row.updatedAt],
    )
    return row
  }

  /** 只改传进来的字段。套餐不存在返回 undefined，由上层决定报 404 还是别的。 */
  async updatePlanSku(
    id: string,
    patch: { name?: string; nameEn?: string; amountMils?: number; seats?: number; period?: PlanPeriod; bonusMils?: number },
  ): Promise<PlanSku | undefined> {
    const cur = await this.planSku(id)
    if (!cur) return undefined
    const r = await this.one(
      'update plan_skus set name=?, "nameEn"=?, "amountMils"=?, seats=?, period=?, "bonusMils"=?, "updatedAt"=? where id=? returning *',
      [
        patch.name ?? cur.name,
        patch.nameEn ?? cur.nameEn,
        patch.amountMils ?? cur.amountMils,
        patch.seats ?? cur.seats,
        patch.period ?? cur.period,
        patch.bonusMils ?? cur.bonusMils,
        Date.now(),
        id,
      ],
    )
    return r ? planSkuOf(r) : undefined
  }

  // ── 订单 ──────────────────────────────────────────────────────────────

  async planOrders(): Promise<PlanOrder[]> {
    const rows = await this.many('select * from plan_orders order by "startAt" desc, "createdAt" desc')
    return rows.map(planOrderOf)
  }

  async planOrder(id: string): Promise<PlanOrder | undefined> {
    const r = await this.one('select * from plan_orders where id = ?', [id])
    return r ? planOrderOf(r) : undefined
  }

  async planOrdersOfCompany(companyId: string): Promise<PlanOrder[]> {
    const rows = await this.many('select * from plan_orders where "companyId" = ? order by "startAt" desc', [companyId])
    return rows.map(planOrderOf)
  }

  async insertPlanOrder(input: Omit<PlanOrder, 'id' | 'createdAt' | 'updatedAt'>): Promise<PlanOrder> {
    const now = Date.now()
    const row: PlanOrder = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
    await this.run(
      `insert into plan_orders
       (id, "companyId", kind, note, "planId", "planName", "planNameEn", period, seats, "amountMils", "bonusMils", "startAt", "endAt", "payStatus", "createdAt", "updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.companyId, row.kind, row.note, row.planId, row.planName, row.planNameEn, row.period,
        row.seats, row.amountMils, row.bonusMils, row.startAt, row.endAt, row.payStatus, row.createdAt, row.updatedAt,
      ],
    )
    return row
  }

  /** 只改传进来的字段。订单不存在返回 undefined。 */
  async updatePlanOrder(id: string, patch: Partial<Omit<PlanOrder, 'id' | 'createdAt'>>): Promise<PlanOrder | undefined> {
    const cur = await this.planOrder(id)
    if (!cur) return undefined
    const next = { ...cur, ...patch, updatedAt: Date.now() }
    const r = await this.one(
      `update plan_orders set "companyId"=?, kind=?, note=?, "planId"=?, "planName"=?, "planNameEn"=?, period=?,
       seats=?, "amountMils"=?, "bonusMils"=?, "startAt"=?, "endAt"=?, "payStatus"=?, "updatedAt"=? where id=? returning *`,
      [
        next.companyId, next.kind, next.note, next.planId, next.planName, next.planNameEn, next.period,
        next.seats, next.amountMils, next.bonusMils, next.startAt, next.endAt, next.payStatus, next.updatedAt, id,
      ],
    )
    return r ? planOrderOf(r) : undefined
  }

  /**
   * 此刻生效的那条**套餐**订单：已付款、开始时间已到、结束时间未过。充值单不参与订阅。
   * 未付款的订单只是一张待收的账单，不算订阅——钱没到就别开服务。
   * 有重叠就取开始得最晚的一条——续约提前下单时，新订单一生效就顶掉旧的。
   */
  async activePaidOrder(companyId: string, at = Date.now()): Promise<PlanOrder | undefined> {
    const r = await this.one(
      `select * from plan_orders
       where "companyId" = ? and kind = 'plan' and "payStatus" = 'paid' and "startAt" <= ? and "endAt" > ?
       order by "startAt" desc limit 1`,
      [companyId, at, at],
    )
    return r ? planOrderOf(r) : undefined
  }

  /**
   * 把公司的订阅拉齐到订单：**已付款且在期内**的那条订单说了算，没有就把套餐清掉。
   * 未付款的订单只是一张待收的账单，不写订阅。
   * 席位不缩到已有账号数以下——订单少给了席位也不能把人挤掉，先按现有人数保住。
   *
   * 下单/改单之后调它；起进程时也对一遍全量，把「订单到期了没人碰」和历史规则留下的
   * 脏值收干净——plans 里那几列是订单算出来的结果，不是另一份可以自己漂的真相。
   */
  async syncPlanFromOrders(companyId: string): Promise<void> {
    const active = await this.activePaidOrder(companyId)
    const used = await this.accountCount(companyId)
    const cur = await this.plan(companyId)
    if (!active) {
      if (cur?.skuId == null && cur?.expiresAt == null && cur) return
      await this.upsertPlan(companyId, cur?.seats ?? Math.max(used, 1), { skuId: null, expiresAt: null })
      return
    }
    await this.upsertPlan(companyId, Math.max(active.seats, used), { skuId: active.planId, expiresAt: active.endAt })
  }

  /** 起进程时对一遍所有公司的订阅。返回被改动的公司数，只为在日志里说一声。 */
  async syncAllPlansFromOrders(): Promise<number> {
    let changed = 0
    for (const c of await this.companies()) {
      const before = await this.plan(c.id)
      await this.syncPlanFromOrders(c.id)
      const after = await this.plan(c.id)
      if (before?.skuId !== after?.skuId || before?.expiresAt !== after?.expiresAt || before?.seats !== after?.seats) changed++
    }
    return changed
  }

  // ── 单独充值 ──────────────────────────────────────────────────────────

  async topups(): Promise<Topup[]> {
    const rows = await this.many('select * from topups order by "createdAt" desc')
    return rows.map(topupOf)
  }

  async topupsOfCompany(companyId: string): Promise<Topup[]> {
    const rows = await this.many('select * from topups where "companyId" = ? order by "createdAt" desc', [companyId])
    return rows.map(topupOf)
  }

  /** 充值总额。充值不过期，所以是从头累加，不按时间窗口切。 */
  async topupTotal(companyId: string): Promise<number> {
    const r = await this.one('select coalesce(sum("amountMils"), 0) as total from topups where "companyId" = ?', [companyId])
    return num(r?.total)
  }

  async topupByOrder(orderId: string): Promise<Topup | undefined> {
    const r = await this.one('select * from topups where "orderId" = ?', [orderId])
    return r ? topupOf(r) : undefined
  }

  async insertTopup(input: {
    companyId: string
    amountMils: number
    orderId?: string | null
    note?: string
    createdBy?: string | null
  }): Promise<Topup> {
    const row: Topup = {
      id: randomUUID(),
      companyId: input.companyId,
      orderId: input.orderId ?? null,
      amountMils: input.amountMils,
      note: input.note ?? '',
      createdBy: input.createdBy ?? null,
      createdAt: Date.now(),
    }
    await this.run(
      'insert into topups (id, "companyId", "orderId", "amountMils", note, "createdBy", "createdAt") values (?,?,?,?,?,?,?)',
      [row.id, row.companyId, row.orderId, row.amountMils, row.note, row.createdBy, row.createdAt],
    )
    return row
  }

  async updateTopup(id: string, patch: Partial<Pick<Topup, 'companyId' | 'amountMils' | 'note'>>): Promise<Topup | undefined> {
    const cur = await this.one('select * from topups where id = ?', [id])
    if (!cur) return undefined
    const next = { ...topupOf(cur), ...patch }
    const r = await this.one(
      'update topups set "companyId"=?, "amountMils"=?, note=? where id=? returning *',
      [next.companyId, next.amountMils, next.note, id],
    )
    return r ? topupOf(r) : undefined
  }

  /** 充值单退回未付款时，把开出去的那条充值记录撤掉——余额跟着掉回去。 */
  async deleteTopup(id: string): Promise<void> {
    await this.run('delete from topups where id = ?', [id])
  }

  // ── 账单 ──────────────────────────────────────────────────────────────

  async invoicesOfCompany(companyId: string): Promise<Invoice[]> {
    const rows = await this.many('select * from invoices where "companyId" = ? order by "periodStart" desc', [companyId])
    return rows.map(invoiceOf)
  }

  async invoiceByOrder(orderId: string): Promise<Invoice | undefined> {
    const r = await this.one('select * from invoices where "orderId" = ?', [orderId])
    return r ? invoiceOf(r) : undefined
  }

  async insertInvoice(input: Omit<Invoice, 'id' | 'createdAt' | 'updatedAt'>): Promise<Invoice> {
    const now = Date.now()
    const row: Invoice = { ...input, id: randomUUID(), createdAt: now, updatedAt: now }
    await this.run(
      `insert into invoices
       (id, "companyId", "orderId", "planName", "planNameEn", "amountMils", "periodStart", "periodEnd", status, "paidAt", "createdAt", "updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        row.id, row.companyId, row.orderId, row.planName, row.planNameEn, row.amountMils,
        row.periodStart, row.periodEnd, row.status, row.paidAt, row.createdAt, row.updatedAt,
      ],
    )
    return row
  }

  async updateInvoice(id: string, patch: Partial<Omit<Invoice, 'id' | 'createdAt'>>): Promise<Invoice | undefined> {
    const cur = await this.one('select * from invoices where id = ?', [id])
    if (!cur) return undefined
    const next = { ...invoiceOf(cur), ...patch, updatedAt: Date.now() }
    const r = await this.one(
      `update invoices set "companyId"=?, "orderId"=?, "planName"=?, "planNameEn"=?, "amountMils"=?,
       "periodStart"=?, "periodEnd"=?, status=?, "paidAt"=?, "updatedAt"=? where id=? returning *`,
      [
        next.companyId, next.orderId, next.planName, next.planNameEn, next.amountMils,
        next.periodStart, next.periodEnd, next.status, next.paidAt, next.updatedAt, id,
      ],
    )
    return r ? invoiceOf(r) : undefined
  }

  // ── 机器 ──────────────────────────────────────────────────────────────

  async insertMachine(input: {
    id?: string
    host?: string | null
    companyId?: string | null
    pairedAt?: number | null
    managerVersion?: string | null
    protocol?: number
    maxAccounts?: number
  }): Promise<Machine> {
    const base = {
      id: input.id ?? randomUUID(),
      host: input.host ?? null,
      companyId: input.companyId ?? null,
      lastHeartbeatAt: null as number | null,
      createdAt: Date.now(),
      pairedAt: input.pairedAt ?? null,
      managerVersion: input.managerVersion ?? null,
      protocol: input.protocol ?? 0,
      lastError: null as string | null,
      // 配对时还不知道架构，等第一次心跳带上来。
      arch: null as string | null,
      desiredManagerVersion: null as string | null,
      maxAccounts: input.maxAccounts ?? DEFAULT_MAX_ACCOUNTS,
      // 时区默认不管：没人指定之前，机器装成什么样就是什么样。
      timezone: null as string | null,
      currentTimezone: null as string | null,
      // 自报数据等第一次心跳；日志上限空着 = 跟管家的默认走（**不是** 0，0 是「别清」）。
      telemetry: null as Machine['telemetry'],
      telemetryAt: null as number | null,
      logCapMb: null as number | null,
      // 新登记的机器当然在册。墓碑只由 markMachineRemoved 立。
      removedAt: null as number | null,
    }
    for (let i = 0; i < 8; i++) {
      const row: Machine = { ...base, token: randomMachineToken() }
      try {
        await this.run(
          'insert into machines (id, host, "companyId", "lastHeartbeatAt", "createdAt", "pairedAt", "managerVersion", protocol, "lastError", arch, "desiredManagerVersion", "maxAccounts", timezone, "currentTimezone", "logCapMb", token) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [
            row.id,
            row.host,
            row.companyId,
            row.lastHeartbeatAt,
            row.createdAt,
            row.pairedAt,
            row.managerVersion,
            row.protocol,
            row.lastError,
            row.arch,
            row.desiredManagerVersion,
            row.maxAccounts,
            row.timezone,
            row.currentTimezone,
            row.logCapMb,
            row.token,
          ],
        )
        return row
      } catch (e) {
        if (i === 7 || !isUniqueViolation(e)) throw e
      }
    }
    throw new Error('无法签发机器凭证')
  }

  /**
   * 换一把新的机器票。重新配对时用——旧管家（或者捡到旧票的人）立刻失效。
   * `insertMachine` 那边 token 是不可更新的，这里是唯一的轮换口子。
   */
  async rotateMachineToken(id: string): Promise<Machine | undefined> {
    for (let i = 0; i < 8; i++) {
      try {
        await this.run('update machines set token = ? where id = ?', [randomMachineToken(), id])
        return this.machine(id)
      } catch (e) {
        if (i === 7 || !isUniqueViolation(e)) throw e
      }
    }
    throw new Error('无法签发机器凭证')
  }

  /**
   * 按 id 取一台**在册**的机器。墓碑当不存在——它对界面来说已经被移除了。
   *
   * 唯一看得见墓碑的是 `machineByToken`（心跳要靠它把「你被移除了」送下去）。
   */
  async machine(id: string): Promise<Machine | undefined> {
    const r = await this.one('select * from machines where id = ? and "removedAt" is null', [id])
    return r ? machineOf(r) : undefined
  }

  /**
   * 按机器票取，**墓碑也返回**。
   *
   * 这是整个库里唯一看得见墓碑的查询，而且必须看得见：移除之后管家还会照常心跳，
   * 那一下正是把「你被移除了」交给它的唯一机会。调用方（心跳）要自己判 `removedAt`。
   */
  async machineByToken(token: string): Promise<Machine | undefined> {
    if (!token) return undefined
    const r = await this.one('select * from machines where token = ?', [token])
    return r ? machineOf(r) : undefined
  }

  /** 立墓碑。席位登记和公司默认机器的指向由调用方在同一个事务里先处理掉。 */
  async markMachineRemoved(id: string, at: number): Promise<void> {
    await this.run('update machines set "removedAt" = ? where id = ?', [at, id])
  }

  /**
   * 收掉过期的墓碑。
   *
   * 管家一直不来收信（机器已经关机、网线拔了、被重装了）时，墓碑不能永远躺着。
   * 不开定时器：读列表和删机器时各扫一次就够——这两处的频率远高于 TTL，而代价是
   * 一条走主键之外单列的 delete。
   */
  async sweepRemovedMachines(before: number): Promise<number> {
    // 归档先走。**这条路才是常态**——机器一直没回来收信的，最后都是从这儿被硬删掉
    // 的；只在 deleteMachine 里清的话，恰恰是「再也没回来那台」的四万多行永远留着。
    // 先删归档再删机器行：反过来的话，机器行没了就再也定位不到它的归档（同
    // deleteSeatRuntimesOfMachine 里 instances 排在前面的理由）。
    await this.run(
      'delete from machine_metric_minutes where "machineId" in (select id from machines where "removedAt" is not null and "removedAt" < ?)',
      [before],
    )
    return this.run('delete from machines where "removedAt" is not null and "removedAt" < ?', [before])
  }

  /**
   * 平台上登记过的所有机器，登记先后。
   *
   * **包括没派给任何公司的那些**（`companyId is null`）：机器管理页要答的是「平台上
   * 现在有哪些机器」，而一台刚配对完还没分配、或者原公司被删之后落单的机器，恰恰是
   * 最需要被人看见的——按公司去列永远列不到它们。
   */
  async allMachines(): Promise<Machine[]> {
    const rows = await this.many('select * from machines where "removedAt" is null order by "createdAt"')
    return rows.map(machineOf)
  }

  /** 这家公司的所有机器，登记先后。多机调度按这个顺序做兜底排序。 */
  async machinesOfCompany(companyId: string): Promise<Machine[]> {
    const rows = await this.many('select * from machines where "companyId" = ? and "removedAt" is null order by "createdAt"', [companyId])
    return rows.map(machineOf)
  }

  /** 按管家基址找机器。重跑装机脚本时靠它认出「还是那一台」，而不是凭空多一台。 */
  async machineByHost(companyId: string, host: string): Promise<Machine | undefined> {
    if (!host) return undefined
    const r = await this.one('select * from machines where "companyId" = ? and host = ? and "removedAt" is null', [companyId, host])
    return r ? machineOf(r) : undefined
  }

  async machineOfCompany(companyId: string): Promise<Machine | undefined> {
    const r = await this.one('select * from machines where "companyId" = ? and "removedAt" is null', [companyId])
    return r ? machineOf(r) : undefined
  }

  /** 只删登记，不碰机器。上面还有席位的话，先走 deleteSeatRuntimesOfMachine。 */
  async deleteMachine(id: string): Promise<void> {
    // 归档跟着一起走。表上没有外键级联（那张表是按 machineId 裸存的），不在这儿删
    // 的话，一台被移除的机器会在库里留下四万多行没人认领的曲线——保留期最终会收掉
    // 它们，但那是三十天之后的事，而且中间谁也查不出这些行属于谁。
    await this.run('delete from machine_metric_minutes where "machineId" = ?', [id])
    await this.run('delete from machines where id = ?', [id])
  }

  /**
   * 抹掉这台机器上所有席位的**登记**（不碰机器上的进程）。
   *
   * 跟 deleteMachine 是一对，必须同进同出：只删机器不删席位的话，那些行会留着一个
   * 指向不存在机器的 machineId，而 machineTokenFor 查不到就会**回落到这家公司的另
   * 一台机器**——聊天请求于是带着别的机器的票发出去，静默打到错的地方。
   *
   * instances 要一起删，而且**得在 seat_runtimes 之前**：那张表没有 machineId，只能
   * 顺着席位行去找；先删席位就没法定位了。它存的是 bot 的反代前缀，留着同样是一个
   * 指向已移除机器的旧地址。
   */
  async deleteSeatRuntimesOfMachine(machineId: string): Promise<number> {
    if (!machineId) return 0
    await this.run(
      'delete from instances i using seat_runtimes s where s."machineId" = ? and i."accountId" = s."accountId" and i."botId" = s."botId"',
      [machineId],
    )
    return this.run('delete from seat_runtimes where "machineId" = ?', [machineId])
  }

  async updateMachine(
    id: string,
    patch: Partial<
      Pick<
        Machine,
        | 'host'
        | 'companyId'
        | 'lastHeartbeatAt'
        | 'pairedAt'
        | 'managerVersion'
        | 'protocol'
        | 'lastError'
        | 'arch'
        | 'desiredManagerVersion'
        | 'maxAccounts'
        | 'timezone'
        | 'currentTimezone'
        | 'telemetry'
        | 'telemetryAt'
        | 'logCapMb'
      >
    >,
  ): Promise<Machine> {
    const cur = await this.machine(id)
    if (!cur) throw new Error('机器不存在')
    const next: Machine = {
      ...cur,
      host: patch.host === undefined ? cur.host : patch.host,
      companyId: patch.companyId === undefined ? cur.companyId : patch.companyId,
      lastHeartbeatAt: patch.lastHeartbeatAt === undefined ? cur.lastHeartbeatAt : patch.lastHeartbeatAt,
      pairedAt: patch.pairedAt === undefined ? cur.pairedAt : patch.pairedAt,
      managerVersion: patch.managerVersion === undefined ? cur.managerVersion : patch.managerVersion,
      protocol: patch.protocol === undefined ? cur.protocol : patch.protocol,
      lastError: patch.lastError === undefined ? cur.lastError : patch.lastError,
      arch: patch.arch === undefined ? cur.arch : patch.arch,
      desiredManagerVersion:
        patch.desiredManagerVersion === undefined ? cur.desiredManagerVersion : patch.desiredManagerVersion,
      maxAccounts: patch.maxAccounts === undefined ? cur.maxAccounts : patch.maxAccounts,
      timezone: patch.timezone === undefined ? cur.timezone : patch.timezone,
      currentTimezone: patch.currentTimezone === undefined ? cur.currentTimezone : patch.currentTimezone,
      telemetry: patch.telemetry === undefined ? cur.telemetry : patch.telemetry,
      telemetryAt: patch.telemetryAt === undefined ? cur.telemetryAt : patch.telemetryAt,
      logCapMb: patch.logCapMb === undefined ? cur.logCapMb : patch.logCapMb,
    }
    await this.run(
      'update machines set host=?, "companyId"=?, "lastHeartbeatAt"=?, "pairedAt"=?, "managerVersion"=?, protocol=?, "lastError"=?, arch=?, "desiredManagerVersion"=?, "maxAccounts"=?, timezone=?, "currentTimezone"=?, telemetry=?, "telemetryAt"=?, "logCapMb"=? where id=?',
      [
        next.host,
        next.companyId,
        next.lastHeartbeatAt,
        next.pairedAt,
        next.managerVersion,
        next.protocol,
        next.lastError,
        next.arch,
        next.desiredManagerVersion,
        next.maxAccounts,
        next.timezone,
        next.currentTimezone,
        // jsonb 那一列要的是文本，pg 的参数绑定不会替我们把对象序列化。
        next.telemetry == null ? null : JSON.stringify(next.telemetry),
        next.telemetryAt,
        next.logCapMb,
        id,
      ],
    )
    return next
  }

  // ── 负载归档。心跳每 30 秒往当前那一分钟的格子里累一笔（见迁移 0012）。──

  /**
   * 把这一轮心跳累进它所属的那一分钟。
   *
   * **一条 upsert，不读不算**：累加是纯 `+`、峰值取 `greatest`，两轮心跳撞在一起也
   * 不会互相盖掉。读出来再改写的话，同一台机器重连时那两笔就会丢一笔。
   *
   * `tx`/`rx` 收的是**这一段时间走了多少字节**（增量），不是计数器快照——调用方拿
   * 相邻两轮的差算，计数器倒退（机器重启）时给 0。
   */
  async addMachineMetricSample(
    machineId: string,
    minuteStart: number,
    s: { cpu: number; mem: number; disk: number; tx: number; rx: number },
  ): Promise<void> {
    await this.run(
      `insert into machine_metric_minutes
         ("machineId", "minuteStart", samples, "cpuSum", "cpuMax", "memSum", "memMax", "diskSum", "diskMax", "txBytes", "rxBytes")
       values (?,?,1,?,?,?,?,?,?,?,?)
       on conflict ("machineId", "minuteStart") do update set
         samples   = machine_metric_minutes.samples + 1,
         "cpuSum"  = machine_metric_minutes."cpuSum"  + excluded."cpuSum",
         "cpuMax"  = greatest(machine_metric_minutes."cpuMax",  excluded."cpuMax"),
         "memSum"  = machine_metric_minutes."memSum"  + excluded."memSum",
         "memMax"  = greatest(machine_metric_minutes."memMax",  excluded."memMax"),
         "diskSum" = machine_metric_minutes."diskSum" + excluded."diskSum",
         "diskMax" = greatest(machine_metric_minutes."diskMax", excluded."diskMax"),
         "txBytes" = machine_metric_minutes."txBytes" + excluded."txBytes",
         "rxBytes" = machine_metric_minutes."rxBytes" + excluded."rxBytes"`,
      [machineId, minuteStart, s.cpu, s.cpu, s.mem, s.mem, s.disk, s.disk, Math.round(s.tx), Math.round(s.rx)],
    )
  }

  /** 一段时间里的分钟格，按时间升序。**没有数据的分钟不会有行**——那是空档，不是 0。 */
  async machineMetricMinutes(machineId: string, from: number, to: number): Promise<MachineMetricMinute[]> {
    const rows = await this.many(
      'select * from machine_metric_minutes where "machineId" = ? and "minuteStart" >= ? and "minuteStart" < ? order by "minuteStart"',
      [machineId, from, to],
    )
    return rows.map(machineMetricMinuteOf)
  }

  /**
   * 收掉过保留期的归档。
   *
   * 一台机器一天 1440 行，三十天四万多行——**这个量必须真的被清**，不像别处那些顺手
   * 扫一扫的表。所以调用点挂在**心跳**上（每台机器整点那一分钟一次，见 internal.ts
   * 的 rollUp），不挂在任何一条要人点开才会走的路上：写入是每 30 秒自动的，清理要是
   * 得等人打开日视图，那句「只留 30 天」在没人看图的部署上就是空话。
   */
  async sweepMachineMetricMinutes(before: number): Promise<number> {
    return this.run('delete from machine_metric_minutes where "minuteStart" < ?', [before])
  }

  // ── 配对码。一次性、30 分钟过期，装管家时拿它换这台机器的 smt_。──

  async insertMachinePairing(row: MachinePairing): Promise<MachinePairing> {
    await this.run(
      'insert into machine_pairings (code, "companyId", "createdBy", "createdAt", "expiresAt", "usedAt", "machineId") values (?,?,?,?,?,?,?)',
      [row.code, row.companyId, row.createdBy, row.createdAt, row.expiresAt, row.usedAt, row.machineId],
    )
    return row
  }

  async machinePairing(code: string): Promise<MachinePairing | undefined> {
    if (!code) return undefined
    const r = await this.one('select * from machine_pairings where code = ?', [code])
    return r ? machinePairingOf(r) : undefined
  }

  /**
   * 认领一个配对码。**未用过才认领得到**——`usedAt is null` 写在 where 里，两台机器
   * 同时拿同一个码时数据库来裁决，不靠先查后写那种竞态。
   */
  async claimMachinePairing(code: string, machineId: string, now: number): Promise<boolean> {
    const n = await this.run(
      'update machine_pairings set "usedAt" = ?, "machineId" = ? where code = ? and "usedAt" is null and "expiresAt" > ?',
      [now, machineId, code, now],
    )
    return n > 0
  }

  /** 同一家公司再生成一个码时，把之前没用掉的作废——桌上不该同时躺着两张有效的票。 */
  /** 这台机器是不是这家公司配对进来的。认领只认自己配对的那台。 */
  async machinePairedBy(machineId: string, companyId: string): Promise<boolean> {
    const r = await this.one(
      'select 1 as n from machine_pairings where "machineId" = ? and "companyId" = ? limit 1',
      [machineId, companyId],
    )
    return Boolean(r)
  }

  async expireMachinePairings(companyId: string, now: number): Promise<void> {
    await this.run('update machine_pairings set "expiresAt" = ? where "companyId" = ? and "usedAt" is null and "expiresAt" > ?', [
      now,
      companyId,
      now,
    ])
  }

  // ── 实例。(账号, botId) 一对一台 Bot 运行时。只存 host，不存聊天正文。──

  async instance(accountId: string, botId: string): Promise<Instance | undefined> {
    const r = await this.one('select * from instances where "accountId" = ? and "botId" = ?', [accountId, botId])
    return r ? instanceOf(r) : undefined
  }

  async seatRuntime(accountId: string, botId: string): Promise<SeatRuntime | undefined> {
    const r = await this.one('select * from seat_runtimes where "accountId" = ? and "botId" = ?', [accountId, botId])
    return r ? seatRuntimeOf(r) : undefined
  }

  /** 按席位 id 反查。桌面反代只认得 URL 里那个 seatId，没有 accountId/botId。 */
  async seatRuntimeBySeatId(seatId: string): Promise<SeatRuntime | undefined> {
    const r = await this.one('select * from seat_runtimes where "seatId" = ?', [seatId])
    return r ? seatRuntimeOf(r) : undefined
  }

  async seatRuntimesOf(companyId: string): Promise<SeatRuntime[]> {
    const rows = await this.many('select * from seat_runtimes where "companyId" = ? order by slot', [companyId])
    return rows.map(seatRuntimeOf)
  }

  /** 某台机器上的席位。算容量和分配槽位都靠它。 */
  async seatRuntimesOfMachine(machineId: string): Promise<SeatRuntime[]> {
    const rows = await this.many('select * from seat_runtimes where "machineId" = ? order by slot', [machineId])
    return rows.map(seatRuntimeOf)
  }

  /**
   * 部署了这一颗 Bot 的全部席位，**不分公司**。
   *
   * 删目录项之前要按它把机器上的东西拆干净。全局 Bot 可能被好几家公司各自部署过，
   * 按公司查会漏掉别家的那些——漏下的席位仍占着 slot 和端口，而库里再没有任何东西
   * 指向它们（理由见 deploy.ts 的 releaseSeats）。
   */
  async seatRuntimesOfBot(botId: string): Promise<SeatRuntime[]> {
    const rows = await this.many('select * from seat_runtimes where "botId" = ?', [botId])
    return rows.map(seatRuntimeOf)
  }

  async seatRuntimesOfAccount(accountId: string): Promise<SeatRuntime[]> {
    const rows = await this.many('select * from seat_runtimes where "accountId" = ? order by slot', [accountId])
    return rows.map(seatRuntimeOf)
  }

  /**
   * 席位报到：它现在跑的是模版第几版。
   *
   * 单独一条窄更新，不走 upsertSeatRuntime：那条是部署路径的整行覆盖，用它写这两列，
   * 等于每次重铺都拿部署那一刻的旧数字把席位刚报上来的盖掉。反过来也一样——这条
   * **只碰这两列**，正在并发跑的部署改的 status / botVersion 一个字都不动。
   *
   * 行不存在就什么都不做（0 行受影响）：席位拆了、库里的行先没了，而那个进程还在最后
   * 探一轮，这不是错误，不该让探针那条路 500。
   */
  async noteSeatTemplate(accountId: string, botId: string, version: number): Promise<void> {
    await this.run(
      'update seat_runtimes set "tplVersion" = ?, "tplSyncedAt" = ? where "accountId" = ? and "botId" = ?',
      [version, Date.now(), accountId, botId],
    )
  }

  async upsertSeatRuntime(row: SeatRuntime): Promise<SeatRuntime> {
    await this.run(
      `insert into seat_runtimes (
         "accountId", "botId", "companyId", "linuxUser", "seatId", "machineId", slot, display, "vncPort", "novncPort",
         "botPort", "vncPassword", status, "lastError", "deployedAt", "updatedAt", "botVersion"
       ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       on conflict ("accountId", "botId") do update set
         "companyId"=excluded."companyId",
         "linuxUser"=excluded."linuxUser",
         "seatId"=excluded."seatId",
         "machineId"=excluded."machineId",
         slot=excluded.slot,
         display=excluded.display,
         "vncPort"=excluded."vncPort",
         "novncPort"=excluded."novncPort",
         "botPort"=excluded."botPort",
         "vncPassword"=excluded."vncPassword",
         status=excluded.status,
         "lastError"=excluded."lastError",
         "deployedAt"=excluded."deployedAt",
         "updatedAt"=excluded."updatedAt",
         "botVersion"=excluded."botVersion"`,
      [
        row.accountId,
        row.botId,
        row.companyId,
        row.linuxUser,
        row.seatId,
        row.machineId,
        row.slot,
        row.display,
        row.vncPort,
        row.novncPort,
        row.botPort,
        row.vncPassword,
        row.status,
        row.lastError,
        row.deployedAt,
        row.updatedAt,
        row.botVersion,
      ],
    )
    return (await this.seatRuntime(row.accountId, row.botId))!
  }

  async deleteSeatRuntime(accountId: string): Promise<void> {
    await this.run('delete from seat_runtimes where "accountId" = ?', [accountId])
  }

  /**
   * 拆掉**一个** Bot 的席位，连同它的实例地址和会话索引。
   *
   * 员工删自己建的 Bot 走这条：他名下别的 Bot 还在跑，上面那条按账号删的会把它们
   * 一起抹掉——slot 立刻能被下一个人分走，而机器上那几套 systemd 单元还占着端口
   * （理由见 deploy.ts 的 releaseSeats）。
   *
   * 会话索引一起删：全文本来就在席位目录里，管家拆席位时跟着没了，留着索引只会让
   * 管理员点进一条永远打不开的会话。
   */
  async deleteSeatRuntimeOf(accountId: string, botId: string): Promise<void> {
    await this.tx(async () => {
      await this.run('delete from seat_runtimes where "accountId" = ? and "botId" = ?', [accountId, botId])
      await this.run('delete from instances where "accountId" = ? and "botId" = ?', [accountId, botId])
      await this.run('delete from session_index where "accountId" = ? and "botId" = ?', [accountId, botId])
    })
  }

  /**
   * 拆不掉的席位：**行留着，但把它和 Bot 之间的东西全清掉**。
   *
   * 机器不在线、或者管家把单元停了却没收拾干净时走这条。行不能删——slot 一空出来
   * 就会被下一个人分走，而那台机器上的单元还占着 3200+N / 6081+N（理由见 deploy.ts
   * 的 releaseSeats）。行留着，机器详情页上就是一条「出错、没有 Bot 名」的席位，
   * 平台侧点一下「清理」重试拆除即可。
   *
   * 实例地址和会话索引照删：Bot 已经删了，它们指向的东西再也打不开。
   */
  async orphanSeatRuntime(accountId: string, botId: string, reason: string): Promise<void> {
    await this.tx(async () => {
      await this.run(
        'update seat_runtimes set status = ?, "lastError" = ?, "updatedAt" = ? where "accountId" = ? and "botId" = ?',
        ['error', reason.slice(0, 500), Date.now(), accountId, botId],
      )
      await this.run('delete from instances where "accountId" = ? and "botId" = ?', [accountId, botId])
      await this.run('delete from session_index where "accountId" = ? and "botId" = ?', [accountId, botId])
    })
  }

  /**
   * 一颗 Bot 名下的全部东西，**账本除外**。
   *
   * 「删掉」得是真的删掉：会话索引、实例地址、分组里对它的引用、目录项自己，一条
   * 都不留。留一半的后果上一次已经见过——目录项还在，界面上那颗 Bot 照常列着，
   * 点进去却聊不了，谁也说不清它是什么。
   *
   * **席位不在这里拆**：那要先和机器说话，删不删得掉库里这行取决于机器答不答应，
   * 由调用点决定（见 deploy.ts 的 purgeBot）。
   *
   * **账本一个字都不动**：usage_charges / llm_calls / connector_calls / web_calls 是
   * 要留档的钱，botId 变成悬空引用没关系，统计里按 id 显示。audit_events 同理——它
   * 记的是「谁在什么时候删了这颗 Bot」，跟着 Bot 一起消失就没有审计可言了。
   */
  async deleteBot(botId: string): Promise<void> {
    await this.tx(async () => {
      await this.run('delete from session_index where "botId" = ?', [botId])
      await this.run('delete from instances where "botId" = ?', [botId])
      // 分组按 jsonb 反查，**不按公司**：全局 Bot 可能被好几家公司各自编进分组，
      // 只扫它自己那家会把别家的引用留成一个指向不存在 Bot 的 id。
      const rows = await this.many('select * from groups where agents @> ?::jsonb', [JSON.stringify([botId])])
      for (const g of rows.map(groupOf)) {
        await this.updateGroup(g.id, { agents: g.agents.filter((a) => a !== botId) })
      }
      await this.run('delete from catalog_items where id = ? and kind = \'bot\'', [botId])
    })
  }

  // ── Bot 发布包。只存元数据，tarball 在 $SATUWORK_GATEWAY_HOME/releases。──

  async insertBotRelease(row: BotRelease): Promise<BotRelease> {
    await this.run(
      'insert into bot_releases (kind, version, sha256, size, "createdAt", note, url) values (?,?,?,?,?,?,?)',
      [row.kind, row.version, row.sha256, row.size, row.createdAt, row.note, row.url],
    )
    return row
  }

  async botRelease(version: string, kind: ReleaseKind = 'bot'): Promise<BotRelease | undefined> {
    const r = await this.one('select * from bot_releases where kind = ? and version = ?', [kind, version])
    return r ? botReleaseOf(r) : undefined
  }

  async botReleases(kind: ReleaseKind = 'bot'): Promise<BotRelease[]> {
    const rows = await this.many('select * from bot_releases where kind = ? order by "createdAt" desc', [kind])
    return rows.map(botReleaseOf)
  }

  /**
   * 最新的发布包，**按架构挑**。
   *
   * `arch` 给了就先找同架构的最新一版；没有同架构的，退回「认不出架构」的版本
   * （老版本号没有后缀，比如 `0.0.1`）；**绝不返回另一个已知架构的包**——那正是
   * 这个参数要挡的事。不给 `arch` 就是老行为：谁新要谁。
   */
  async latestBotRelease(kind: ReleaseKind = 'bot', arch?: string | null): Promise<BotRelease | undefined> {
    if (!arch) {
      const r = await this.one('select * from bot_releases where kind = ? order by "createdAt" desc limit 1', [kind])
      return r ? botReleaseOf(r) : undefined
    }
    const rows = await this.botReleases(kind) // 已按 createdAt desc 排好
    return rows.find((r) => releaseArch(r.version) === arch) ?? rows.find((r) => !releaseArch(r.version))
  }

  async upsertInstance(input: {
    accountId: string
    botId: string
    companyId?: string | null
    host: string
  }): Promise<Instance> {
    const now = Date.now()
    const companyId = input.companyId === undefined ? null : input.companyId
    await this.run(
      `insert into instances ("accountId", "botId", "companyId", host, "lastReadyAt") values (?,?,?,?,?)
       on conflict ("accountId", "botId") do update set
         "companyId"=excluded."companyId",
         host=excluded.host,
         "lastReadyAt"=excluded."lastReadyAt"`,
      [input.accountId, input.botId, companyId, input.host, now],
    )
    return { accountId: input.accountId, botId: input.botId, companyId, host: input.host, lastReadyAt: now }
  }

  // ── 目录 ──────────────────────────────────────────────────────────────

  async insertCatalog(input: {
    kind: CatalogKind
    scope: Scope
    companyId: string | null
    /** 只有 `scope: 'user'` 用得上：这条归谁。别的层级传不传都存 null。 */
    accountId?: string | null
    name: string
    definition?: unknown
  }): Promise<CatalogItem> {
    const now = Date.now()
    const row: CatalogItem = {
      id: randomUUID(),
      kind: input.kind,
      scope: input.scope,
      companyId: input.scope === 'global' ? null : input.companyId,
      accountId: input.scope === 'user' ? (input.accountId ?? null) : null,
      name: input.name,
      definition: input.definition ?? {},
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into catalog_items (id, kind, scope, "companyId", "accountId", name, definition, "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?)',
      [row.id, row.kind, row.scope, row.companyId, row.accountId, row.name, JSON.stringify(row.definition), row.createdAt, row.updatedAt],
    )
    return row
  }

  async catalog(id: string): Promise<CatalogItem | undefined> {
    const r = await this.one('select * from catalog_items where id = ?', [id])
    return r ? catalogOf(r) : undefined
  }

  async visibleCatalog(kind: CatalogKind, companyId: string | null): Promise<CatalogItem[]> {
    if (!companyId) {
      const rows = await this.many("select * from catalog_items where kind = ? and scope = 'global' order by name", [kind])
      return rows.map(catalogOf)
    }
    const rows = await this.many(
      "select * from catalog_items where kind = ? and (scope = 'global' or (scope = 'company' and \"companyId\" = ?)) order by scope, name",
      [kind, companyId],
    )
    return rows.map(catalogOf)
  }

  async companyCatalog(kind: CatalogKind, companyId: string): Promise<CatalogItem[]> {
    const rows = await this.many(
      "select * from catalog_items where kind = ? and scope = 'company' and \"companyId\" = ? order by name",
      [kind, companyId],
    )
    return rows.map(catalogOf)
  }

  async updateCatalog(id: string, patch: { name?: string; definition?: unknown }): Promise<CatalogItem> {
    const cur = await this.catalog(id)
    if (!cur) throw new Error('目录项不存在')
    const next: CatalogItem = {
      ...cur,
      name: patch.name ?? cur.name,
      definition: patch.definition === undefined ? cur.definition : patch.definition,
      updatedAt: Date.now(),
    }
    await this.run('update catalog_items set name=?, definition=?, "updatedAt"=? where id=?', [
      next.name,
      JSON.stringify(next.definition),
      next.updatedAt,
      id,
    ])
    return next
  }

  /**
   * 这家公司那份 Bot 模版。一家公司恰好一条（0002 上有唯一索引）。
   *
   * 查不到不代表出错：公司是在 0003 之后建的，模版由第一次读它的人懒创建
   * （见 lib/catalog.ts 的 ensureBotTemplate）。
   */
  async botTemplate(companyId: string): Promise<CatalogItem | undefined> {
    const r = await this.one(
      'select * from catalog_items where kind = \'bot-template\' and "companyId" = ? limit 1',
      [companyId],
    )
    return r ? catalogOf(r) : undefined
  }

  /**
   * 某个员工的名册：全局 Bot ∪ 本公司的（都是 0003 停用掉的老条目）∪ **他自己建的**。
   *
   * 别人建的 Bot 一律不在里面——用户 Bot 只有主人看得见，这条线由这里的 where 保证，
   * 而不是靠每个调用点自己过滤。
   */
  async botsFor(companyId: string | null, accountId: string): Promise<CatalogItem[]> {
    if (!companyId) {
      const rows = await this.many("select * from catalog_items where kind = 'bot' and scope = 'global' order by name")
      return rows.map(catalogOf)
    }
    const rows = await this.many(
      `select * from catalog_items where kind = 'bot' and (
         scope = 'global'
         or (scope = 'company' and "companyId" = ?)
         or (scope = 'user' and "accountId" = ?)
       ) order by scope, name`,
      [companyId, accountId],
    )
    return rows.map(catalogOf)
  }

  /**
   * 这家公司里的全部 Bot，**不分主人**：全局 + 公司 + 每个员工自己建的。
   *
   * 只给「按 id 换个名字」这类展示用（会话索引、审计）。要判「这个人能不能用它」
   * 一律走 botsFor——那条才带主人这一维。
   */
  async companyBots(companyId: string): Promise<CatalogItem[]> {
    const rows = await this.many(
      `select * from catalog_items where kind = 'bot' and (
         scope = 'global' or "companyId" = ?
       ) order by scope, name`,
      [companyId],
    )
    return rows.map(catalogOf)
  }

  /** 某个员工自己建了几个。配额挡在建之前，见 routes/runtime.ts。 */
  async countUserBots(accountId: string): Promise<number> {
    const r = await this.one(
      'select count(*)::int as n from catalog_items where kind = \'bot\' and scope = \'user\' and "accountId" = ?',
      [accountId],
    )
    return Number((r as { n?: number } | undefined)?.n ?? 0)
  }

  async deleteCatalog(id: string): Promise<void> {
    await this.run('delete from catalog_items where id = ?', [id])
  }

  // ── 密钥 ──────────────────────────────────────────────────────────────

  async insertCredential(input: { companyId: string; provider: string; secret: string }): Promise<Credential> {
    const now = Date.now()
    const row: Credential = {
      id: randomUUID(),
      companyId: input.companyId,
      provider: input.provider,
      secret: input.secret,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into credentials (id, "companyId", provider, secret, "createdAt", "updatedAt") values (?,?,?,?,?,?)',
      [row.id, row.companyId, row.provider, row.secret, row.createdAt, row.updatedAt],
    )
    return row
  }

  async credential(id: string): Promise<Credential | undefined> {
    const r = await this.one('select * from credentials where id = ?', [id])
    return r ? credOf(r) : undefined
  }

  async credentialsOf(companyId: string): Promise<Credential[]> {
    const rows = await this.many('select * from credentials where "companyId" = ? order by provider', [companyId])
    return rows.map(credOf)
  }

  async credentialByProvider(companyId: string, provider: string): Promise<Credential | undefined> {
    const r = await this.one('select * from credentials where "companyId" = ? and provider = ?', [companyId, provider])
    return r ? credOf(r) : undefined
  }

  async platformCredential(provider: string): Promise<Credential | undefined> {
    const r = await this.one('select * from platform_credentials where provider = ?', [provider])
    if (!r) return undefined
    return {
      id: `platform:${str(r.provider)}`,
      companyId: '',
      provider: str(r.provider),
      secret: str(r.secret),
      createdAt: num(r.createdAt),
      updatedAt: num(r.updatedAt),
    }
  }

  async upsertPlatformCredential(provider: string, secret: string): Promise<Credential> {
    const now = Date.now()
    await this.run(
      'insert into platform_credentials (provider, secret, "createdAt", "updatedAt") values (?,?,?,?) on conflict (provider) do update set secret=excluded.secret, "updatedAt"=excluded."updatedAt"',
      [provider, secret, now, now],
    )
    return (await this.platformCredential(provider))!
  }

  async platformCredentials(): Promise<Credential[]> {
    const rows = await this.many('select * from platform_credentials order by provider')
    return rows.map((r) => ({
      id: `platform:${str(r.provider)}`,
      companyId: '',
      provider: str(r.provider),
      secret: str(r.secret),
      createdAt: num(r.createdAt),
      updatedAt: num(r.updatedAt),
    }))
  }

  async deletePlatformCredential(provider: string): Promise<void> {
    await this.run('delete from platform_credentials where provider = ?', [provider])
  }

  async updateCredential(id: string, secret: string): Promise<Credential> {
    const cur = await this.credential(id)
    if (!cur) throw new Error('密钥不存在')
    const next = { ...cur, secret, updatedAt: Date.now() }
    await this.run('update credentials set secret=?, "updatedAt"=? where id=?', [next.secret, next.updatedAt, id])
    return next
  }

  async deleteCredential(id: string): Promise<void> {
    await this.run('delete from credentials where id = ?', [id])
  }

  // ── 审计 ──────────────────────────────────────────────────────────────

  async audit(input: {
    companyId: string
    accountId?: string | null
    action: string
    detail?: unknown
  }): Promise<AuditEvent> {
    const row: AuditEvent = {
      id: randomUUID(),
      companyId: input.companyId,
      accountId: input.accountId ?? null,
      action: input.action,
      detail: input.detail ?? {},
      createdAt: Date.now(),
    }
    await this.run(
      'insert into audit_events (id, "companyId", "accountId", action, detail, "createdAt") values (?,?,?,?,?,?)',
      [row.id, row.companyId, row.accountId, row.action, JSON.stringify(row.detail), row.createdAt],
    )
    return row
  }

  async auditsOf(companyId: string, limit = 100): Promise<AuditEvent[]> {
    const rows = await this.many('select * from audit_events where "companyId" = ? order by "createdAt" desc limit ?', [
      companyId,
      limit,
    ])
    return rows.map(auditOf)
  }

  // ── 会话索引。只存指针，不存 user/message 或 assistant/message 正文。──

  async upsertSessionIndex(input: {
    sessionId: string
    companyId: string
    accountId: string
    botId?: string | null
    machineId?: string | null
    origin?: string | null
    remoteId?: string | null
    messageCount?: number | null
    title?: string | null
    createdAt?: number | null
    updatedAt?: number | null
  }): Promise<SessionIndex> {
    const cur = await this.sessionIndex(input.sessionId)
    const now = Date.now()
    const row: SessionIndex = {
      sessionId: input.sessionId,
      companyId: input.companyId,
      accountId: input.accountId,
      botId: input.botId !== undefined ? input.botId : (cur?.botId ?? null),
      machineId: input.machineId !== undefined ? input.machineId : (cur?.machineId ?? null),
      origin: input.origin !== undefined ? input.origin : (cur?.origin ?? null),
      remoteId: input.remoteId !== undefined ? input.remoteId : (cur?.remoteId ?? null),
      messageCount: input.messageCount !== undefined ? input.messageCount : (cur?.messageCount ?? null),
      title: input.title !== undefined ? input.title : (cur?.title ?? null),
      createdAt: input.createdAt ?? cur?.createdAt ?? now,
      updatedAt: input.updatedAt ?? now,
    }
    await this.run(
      `insert into session_index ("sessionId", "companyId", "accountId", "botId", "machineId", origin, "remoteId", "messageCount", title, "createdAt", "updatedAt")
       values (?,?,?,?,?,?,?,?,?,?,?)
       on conflict ("sessionId") do update set
         "companyId"=excluded."companyId",
         "accountId"=excluded."accountId",
         "botId"=excluded."botId",
         "machineId"=excluded."machineId",
         origin=excluded.origin,
         "remoteId"=excluded."remoteId",
         "messageCount"=excluded."messageCount",
         title=excluded.title,
         "createdAt"=excluded."createdAt",
         "updatedAt"=excluded."updatedAt"`,
      [
        row.sessionId,
        row.companyId,
        row.accountId,
        row.botId,
        row.machineId,
        row.origin,
        row.remoteId,
        row.messageCount,
        row.title,
        row.createdAt,
        row.updatedAt,
      ],
    )
    return row
  }

  async sessionIndex(sessionId: string): Promise<SessionIndex | undefined> {
    const r = await this.one('select * from session_index where "sessionId" = ?', [sessionId])
    return r ? sessionIndexOf(r) : undefined
  }

  /**
   * 会话索引列表。**必须带上限**：这张表随聊天无限增长，没有 LIMIT 的话一家用了一年
   * 的公司点一次「会话」就把几十万行读进内存再序列化成 JSON 发出去。
   */
  async listSessionIndex(
    companyId: string,
    filter: {
      accountId?: string
      botId?: string
      from?: number
      to?: number
      limit?: number
      /** keyset 游标：只要**严格排在它后面**的行。来自上一页最后一行。 */
      before?: { updatedAt: number; sessionId: string }
    } = {},
  ): Promise<SessionIndex[]> {
    let sql = 'select * from session_index where "companyId" = ?'
    const args: (string | number)[] = [companyId]
    if (filter.accountId) {
      sql += ' and "accountId" = ?'
      args.push(filter.accountId)
    }
    if (filter.botId) {
      sql += ' and "botId" = ?'
      args.push(filter.botId)
    }
    if (filter.from != null) {
      sql += ' and "updatedAt" >= ?'
      args.push(filter.from)
    }
    if (filter.to != null) {
      sql += ' and "updatedAt" <= ?'
      args.push(filter.to)
    }
    if (filter.before) {
      // 用 keyset 而不是 OFFSET：两页之间有新会话上报时，OFFSET 会让行整体后移，
      // 翻页要么漏要么重。审计列表漏行是实质问题。
      sql += ' and ("updatedAt" < ? or ("updatedAt" = ? and "sessionId" < ?))'
      args.push(filter.before.updatedAt, filter.before.updatedAt, filter.before.sessionId)
    }
    // 上限放到 MAX+1：路由会多要一条用来判断 hasMore，卡在 MAX 的话最后一页永远
    // 报「没有更多」。真正对外的每页条数由 sessionPageLimit 决定。
    const limit = Math.min(Math.max(Math.trunc(filter.limit ?? SESSION_PAGE_DEFAULT), 1), SESSION_PAGE_MAX + 1)
    sql += ' order by "updatedAt" desc, "sessionId" desc limit ?'
    args.push(limit)
    const rows = await this.many(sql, args)
    return rows.map(sessionIndexOf)
  }

  // ── 公司模型角色（日常 / utility）。不存密钥。────────────────────────

  async settings(companyId: string): Promise<CompanySettings> {
    const r = await this.one('select payload from settings where "companyId" = ?', [companyId])
    if (!r) return emptySettings()
    const raw = (jsonOf(r.payload) ?? {}) as Partial<CompanySettings>
    return {
      daily: { provider: String(raw.daily?.provider ?? ''), model: String(raw.daily?.model ?? '') },
      utility: { provider: String(raw.utility?.provider ?? ''), model: String(raw.utility?.model ?? '') },
    }
  }

  async putSettings(companyId: string, next: CompanySettings): Promise<CompanySettings> {
    const now = Date.now()
    const payload = JSON.stringify({
      daily: { provider: next.daily.provider, model: next.daily.model },
      utility: { provider: next.utility.provider, model: next.utility.model },
    })
    await this.run(
      'insert into settings ("companyId", payload, "updatedAt") values (?,?,?) on conflict ("companyId") do update set payload=excluded.payload, "updatedAt"=excluded."updatedAt"',
      [companyId, payload, now],
    )
    return this.settings(companyId)
  }

  async platformSettings(): Promise<PlatformSettings> {
    const r = await this.one("select payload from platform_settings where id = 'platform'")
    if (!r) return emptyPlatformSettings()
    return parsePlatformPayload(r.payload)
  }

  async putPlatformSettings(next: PlatformSettings): Promise<PlatformSettings> {
    const now = Date.now()
    const enabled = Array.isArray(next.enabledModels) ? next.enabledModels.map((x) => String(x)).filter(Boolean) : []
    const payload = JSON.stringify({
      daily: { provider: next.daily.provider, model: next.daily.model },
      utility: { provider: next.utility.provider, model: next.utility.model },
      enabledModels: enabled,
      priceMultiplier: parsePriceMultiplier(next.priceMultiplier),
      connectorPricing: parseConnectorPricing(next.connectorPricing),
      // **不能漏。** 这一行漏了整整一版：类型上有、路由层收得好好的、界面也能填，
      // 只有这里拼 payload 时把它丢了——于是 PUT 回 200、读出来永远是空。
      // 后果是「全机队钉版本」这一级完全失效：传一个包上去，所有没有逐台钉过的机器
      // 都会在下一次心跳自己升上去，而唯一能拦住它的开关，看起来能设、其实存不进去。
      managerVersion: String(next.managerVersion ?? '').trim(),
      // 同上：这一行漏了，工具配置那一屏就是「能填、回 200、读出来永远是空」。
      webTools: parseWebTools(next.webTools),
      // 同上第三次。这两项漏了的后果更重：单价覆盖存不进去，缺价的模型就永远缺价；
      // 熔断开关存不进去，`enforce` 就成了一个改不动的常量。
      modelPricing: parseModelPricing(next.modelPricing),
      billing: parseBilling(next.billing),
    })
    await this.run(
      "insert into platform_settings (id, payload, \"updatedAt\") values ('platform', ?, ?) on conflict (id) do update set payload=excluded.payload, \"updatedAt\"=excluded.\"updatedAt\"",
      [payload, now],
    )
    return this.platformSettings()
  }

  /**
   * 一次性：公司日常/utility 升到平台设置（平台还空时）；
   * 公司密钥升到 platform_credentials（该 provider 还没有平台密钥时）。
   */
  async liftCompanyDataToPlatform(): Promise<{ settings: boolean; providers: string[] }> {
    const lifted = { settings: false, providers: [] as string[] }
    const cur = await this.platformSettings()
    const empty = !cur.daily.provider && !cur.daily.model && !cur.utility.provider && !cur.utility.model
    if (empty) {
      const rows = await this.many('select payload from settings order by "updatedAt" desc')
      for (const row of rows) {
        const s = parsePlatformPayload(row.payload)
        if (s.daily.provider || s.daily.model || s.utility.provider || s.utility.model) {
          await this.putPlatformSettings({
            daily: s.daily,
            utility: s.utility,
            enabledModels: cur.enabledModels,
            priceMultiplier: cur.priceMultiplier,
            connectorPricing: cur.connectorPricing,
            webTools: cur.webTools,
          })
          lifted.settings = true
          break
        }
      }
    }
    const have = new Set((await this.platformCredentials()).map((c) => c.provider))
    const creds = await this.many('select provider, secret from credentials')
    for (const row of creds) {
      const provider = str(row.provider)
      if (!provider || have.has(provider)) continue
      await this.upsertPlatformCredential(provider, str(row.secret))
      have.add(provider)
      lifted.providers.push(provider)
    }
    return lifted
  }


  // ── 日常任务：定义、排期与流水 ────────────────────────────────────────

  /** 这个人在这颗 Bot 上的全部日常任务。侧栏那一列就是它。 */
  async routinesOf(accountId: string, botId: string): Promise<Routine[]> {
    const rows = await this.many('select * from routines where "accountId" = ? and "botId" = ? order by "createdAt"', [accountId, botId])
    return rows.map(routineOf)
  }

  async routine(id: string): Promise<Routine | undefined> {
    const r = await this.one('select * from routines where id = ?', [id])
    return r ? routineOf(r) : undefined
  }

  async insertRoutine(input: {
    botId: string
    accountId: string
    companyId: string
    name: string
    instruction?: string
    triggers?: RoutineTrigger[]
    nextRunAt?: number | null
  }): Promise<Routine> {
    const now = Date.now()
    const row: Routine = {
      id: randomUUID(),
      botId: input.botId,
      accountId: input.accountId,
      companyId: input.companyId,
      name: input.name,
      instruction: input.instruction ?? '',
      active: true,
      triggers: input.triggers ?? [],
      nextRunAt: input.nextRunAt ?? null,
      createdAt: now,
      updatedAt: now,
    }
    await this.run(
      'insert into routines (id, "botId", "accountId", "companyId", name, instruction, active, triggers, "nextRunAt", "createdAt", "updatedAt") values (?,?,?,?,?,?,?,?,?,?,?)',
      [row.id, row.botId, row.accountId, row.companyId, row.name, row.instruction, row.active, JSON.stringify(row.triggers), row.nextRunAt, row.createdAt, row.updatedAt],
    )
    return row
  }

  /**
   * 改一条。**只改传了的字段**——界面上改名字和改触发时间是两次独立的保存，
   * 整行覆盖会让后到的那次把前一次的输入抹掉。
   */
  async updateRoutine(
    id: string,
    patch: { name?: string; instruction?: string; active?: boolean; triggers?: RoutineTrigger[]; nextRunAt?: number | null },
  ): Promise<Routine | undefined> {
    const sets: string[] = []
    const args: unknown[] = []
    if (patch.name !== undefined) (sets.push('name = ?'), args.push(patch.name))
    if (patch.instruction !== undefined) (sets.push('instruction = ?'), args.push(patch.instruction))
    if (patch.active !== undefined) (sets.push('active = ?'), args.push(patch.active))
    if (patch.triggers !== undefined) (sets.push('triggers = ?'), args.push(JSON.stringify(patch.triggers)))
    if (patch.nextRunAt !== undefined) (sets.push('"nextRunAt" = ?'), args.push(patch.nextRunAt))
    sets.push('"updatedAt" = ?')
    args.push(Date.now(), id)
    await this.run(`update routines set ${sets.join(', ')} where id = ?`, args)
    return this.routine(id)
  }

  async deleteRoutine(id: string): Promise<boolean> {
    return (await this.run('delete from routines where id = ?', [id])) > 0
  }

  /** 到点该跑的那几条。调度器每一轮问一次。 */
  async dueRoutines(nowMs: number, limit = 20): Promise<Routine[]> {
    const rows = await this.many(
      'select * from routines where active and "nextRunAt" is not null and "nextRunAt" <= ? order by "nextRunAt" limit ?',
      [nowMs, Math.max(1, Math.trunc(limit))],
    )
    return rows.map(routineOf)
  }

  /**
   * 抢一条到点的任务：把 `nextRunAt` 从「刚才读到的那个值」换成下一次。
   *
   * **条件里必须带上旧值**，不能只按 id 更新。两个 Gateway 进程（升级时的新旧两代、
   * 或者以后多开）会在同一秒读到同一条，谁都觉得该自己跑——CAS 之后只有一个人的
   * `rowCount` 是 1，另一个拿到 0 就跳过。少了这一句，每天九点的日报会发两份。
   */
  async claimRoutine(id: string, expectedNextRunAt: number, nextRunAt: number | null): Promise<boolean> {
    const n = await this.run('update routines set "nextRunAt" = ?, "updatedAt" = ? where id = ? and "nextRunAt" = ?', [
      nextRunAt,
      Date.now(),
      id,
      expectedNextRunAt,
    ])
    return n > 0
  }

  async insertRoutineRun(input: {
    routineId: string
    botId: string
    accountId: string
    companyId: string
    trigger: RoutineRunTrigger
    sessionId?: string | null
  }): Promise<RoutineRun> {
    const row: RoutineRun = {
      id: randomUUID(),
      routineId: input.routineId,
      botId: input.botId,
      accountId: input.accountId,
      companyId: input.companyId,
      trigger: input.trigger,
      status: 'running',
      sessionId: input.sessionId ?? null,
      error: null,
      startedAt: Date.now(),
      endedAt: null,
    }
    await this.run(
      'insert into routine_runs (id, "routineId", "botId", "accountId", "companyId", trigger, status, "sessionId", error, "startedAt", "endedAt") values (?,?,?,?,?,?,?,?,?,?,?)',
      [row.id, row.routineId, row.botId, row.accountId, row.companyId, row.trigger, row.status, row.sessionId, row.error, row.startedAt, row.endedAt],
    )
    // 只留最近几十条。这张表是「昨晚跑没跑」，留全量只会让侧栏那一列越查越慢。
    await this.run(
      'delete from routine_runs where "routineId" = ? and id not in (select id from routine_runs where "routineId" = ? order by "startedAt" desc limit ?)',
      [input.routineId, input.routineId, ROUTINE_RUNS_KEEP],
    )
    return row
  }

  async finishRoutineRun(id: string, patch: { status: RoutineRunStatus; error?: string | null; sessionId?: string | null }): Promise<void> {
    const sets = ['status = ?', 'error = ?', '"endedAt" = ?']
    const args: unknown[] = [patch.status, patch.error ?? null, patch.status === 'running' ? null : Date.now()]
    if (patch.sessionId !== undefined) (sets.push('"sessionId" = ?'), args.push(patch.sessionId))
    args.push(id)
    await this.run(`update routine_runs set ${sets.join(', ')} where id = ?`, args)
  }

  async routineRuns(routineId: string, limit = 10): Promise<RoutineRun[]> {
    const rows = await this.many('select * from routine_runs where "routineId" = ? order by "startedAt" desc limit ?', [
      routineId,
      Math.max(1, Math.trunc(limit)),
    ])
    return rows.map(routineRunOf)
  }

  /** 这条任务还有没有一次没跑完的。同一条任务不并发跑两次，靠它判。 */
  async routineRunning(routineId: string): Promise<RoutineRun | undefined> {
    const r = await this.one('select * from routine_runs where "routineId" = ? and status = \'running\' order by "startedAt" desc limit 1', [
      routineId,
    ])
    return r ? routineRunOf(r) : undefined
  }

  /**
   * 把没人再管的「正在跑」收干净。
   *
   * 等结果的那个 watcher 是内存里的东西，进程一停就没了；库里那条 `running` 再也不会
   * 有人来改。不收的话，那条任务从此再也跑不起来（并发判据永远认为它还在跑），而界面上
   * 是一个永远转着的圈。
   *
   * **必须按 `startedAt` 划线，不能把所有 `running` 一把收掉。** 这张表不属于某一个
   * 进程：升级换版那几十秒里新旧两代同时在跑，无差别地收，就是新进程把旧进程**正在
   * 等结果**的那一条判成失败——界面当场变红（虽然旧进程跑完会改回来），而且那段窗口里
   * 并发判据也跟着失效，人这时点「试跑」不再被 409 挡住，两条消息进同一个会话。
   *
   * 划线的位置由调用方给：一次运行最多等 `GATEWAY_ROUTINE_TIMEOUT_MS`，比这更老的
   * `running` 意味着**任何**进程里的 watcher 都已经放弃了，收它不会踩到活人。
   */
  async failStaleRoutineRuns(startedBefore: number): Promise<number> {
    return this.run(
      "update routine_runs set status = 'error', error = ?, \"endedAt\" = ? where status = 'running' and \"startedAt\" < ?",
      ['没等到结果就断了（Gateway 重启，或者超过了最长等待时间）', Date.now(), startedBefore],
    )
  }

  // ── Skill 标签。稿子上那八个是初值，建了新的就进这张表。──────────────

  async skillTags(companyId: string): Promise<string[]> {
    const rows = await this.many('select tag from skill_tags where "companyId" = ? order by seq', [companyId])
    return rows.map((r) => str(r.tag))
  }

  async insertSkillTag(companyId: string, tag: string): Promise<void> {
    await this.run('insert into skill_tags ("companyId", tag) values (?, ?) on conflict do nothing', [companyId, tag])
  }

  async deleteSkillTag(companyId: string, tag: string): Promise<boolean> {
    return (await this.run('delete from skill_tags where "companyId" = ? and tag = ?', [companyId, tag])) > 0
  }
}
