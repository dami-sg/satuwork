import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { randomAccessToken, randomApiKey, randomMachineToken } from './crypto.ts'
import { gatewayHome } from './home.ts'

export type Role = 'owner' | 'admin' | 'member'
export type Scope = 'global' | 'company'
export type CatalogKind = 'model' | 'skill' | 'mcp' | 'bot'

export interface Company {
  id: string
  slug: string
  name: string
  machineId: string | null
  accessUrl: string | null
  createdAt: number
  updatedAt: number
}

export type AccountStatus = 'active' | 'disabled' | 'invited'

export type Theme = 'light' | 'dark' | 'system'
export type Locale = 'zh' | 'en'

export interface Account {
  id: string
  companyId: string | null
  email: string
  name: string
  title: string
  phone: string
  theme: Theme
  locale: Locale
  passwordHash: string
  role: Role
  status: AccountStatus
  lastSeenAt: number | null
  passwordChangedAt: number | null
  /** 早于此时签发的 JWT 一律作废。Gateway 没有会话表，靠这个补「立刻踢下线」。 */
  tokenRevokedAt: number | null
  createdAt: number
  updatedAt: number
}

export interface Invite {
  id: string
  userId: string
  companyId: string
  createdBy: string
  createdAt: number
  expiresAt: number
}

export interface Plan {
  companyId: string
  seats: number
  updatedAt: number
}

export interface Group {
  id: string
  companyId: string
  name: string
  desc: string
  icon: string
  role: 'admin' | 'member'
  members: string[]
  agents: string[]
  createdAt: number
}

export interface Machine {
  id: string
  host: string | null
  companyId: string | null
  lastHeartbeatAt: number | null
  createdAt: number
  sshHost: string | null
  sshPort: number
  sshUser: string
  sshAuth: 'password' | 'key'
  sshSecret: string | null
  token: string
}

export type SeatRuntimeStatus = 'none' | 'deploying' | 'ready' | 'error'

export interface SeatRuntime {
  accountId: string
  botId: string
  companyId: string
  linuxUser: string
  slot: number
  display: number
  vncPort: number
  novncPort: number
  botPort: number
  vncPassword: string
  status: SeatRuntimeStatus
  lastError: string | null
  deployedAt: number | null
  updatedAt: number
  botVersion: string | null
}

export interface BotRelease {
  version: string
  sha256: string
  size: number
  createdAt: number
  note: string
}

export interface CatalogItem {
  id: string
  kind: CatalogKind
  scope: Scope
  companyId: string | null
  name: string
  definition: unknown
  createdAt: number
  updatedAt: number
}

export interface Credential {
  id: string
  companyId: string
  provider: string
  secret: string
  createdAt: number
  updatedAt: number
}

export interface AuditEvent {
  id: string
  companyId: string
  accountId: string | null
  action: string
  detail: unknown
  createdAt: number
}

/** Gateway 只存指针。正文永远不该出现在这张表里。 */
export interface SessionIndex {
  sessionId: string
  companyId: string
  accountId: string
  botId: string | null
  machineId: string | null
  origin: string | null
  remoteId: string | null
  messageCount: number | null
  title: string | null
  createdAt: number
  updatedAt: number
}

export interface Instance {
  accountId: string
  botId: string
  companyId: string | null
  host: string
  lastReadyAt: number
}

export interface AccountSecrets {
  accountId: string
  apiKey: string
  accessToken: string
  createdAt: number
}

export interface LlmCall {
  id: string
  accountId: string
  companyId: string | null
  provider: string
  model: string
  promptTokens: number
  completionTokens: number
  createdAt: number
}

export interface LlmUsageByAccount {
  accountId: string
  calls: number
  promptTokens: number
  completionTokens: number
  lastAt: number | null
}

export interface LlmUsage {
  calls: number
  promptTokens: number
  completionTokens: number
  byAccount: LlmUsageByAccount[]
}

export interface ModelRole {
  provider: string
  model: string
}

export interface CompanySettings {
  daily: ModelRole
  utility: ModelRole
}

export interface PlatformSettings {
  daily: ModelRole
  utility: ModelRole
  enabledModels?: string[]
}

export function emptySettings(): CompanySettings {
  return { daily: { provider: '', model: '' }, utility: { provider: '', model: '' } }
}

export function emptyPlatformSettings(): PlatformSettings {
  return { daily: { provider: '', model: '' }, utility: { provider: '', model: '' }, enabledModels: [] }
}

type Row = Record<string, unknown>

function str(v: unknown): string {
  return String(v)
}

export function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /UNIQUE constraint failed/i.test(msg) || /SQLITE_CONSTRAINT_UNIQUE/i.test(msg)
}
function strOrNull(v: unknown): string | null {
  return v == null ? null : String(v)
}
function num(v: unknown): number {
  return Number(v)
}
function numOrNull(v: unknown): number | null {
  return v == null ? null : Number(v)
}

function companyOf(r: Row): Company {
  return {
    id: str(r.id),
    slug: str(r.slug),
    name: str(r.name),
    machineId: strOrNull(r.machineId),
    accessUrl: strOrNull(r.accessUrl),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}
function themeOf(v: unknown): Theme {
  const t = str(v || 'system')
  return t === 'light' || t === 'dark' || t === 'system' ? t : 'system'
}
function localeOf(v: unknown): Locale {
  return str(v || 'zh') === 'en' ? 'en' : 'zh'
}
function accountOf(r: Row): Account {
  const email = str(r.email)
  const status = str(r.status || 'active')
  return {
    id: str(r.id),
    companyId: strOrNull(r.companyId),
    email,
    name: str(r.name || email.split('@')[0] || email),
    title: str(r.title || ''),
    phone: str(r.phone || ''),
    theme: themeOf(r.theme),
    locale: localeOf(r.locale),
    passwordHash: str(r.passwordHash),
    role: str(r.role) as Role,
    status: status === 'disabled' || status === 'invited' ? status : 'active',
    lastSeenAt: numOrNull(r.lastSeenAt),
    passwordChangedAt: numOrNull(r.passwordChangedAt),
    tokenRevokedAt: numOrNull(r.tokenRevokedAt),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}

function inviteOf(r: Row): Invite {
  return {
    id: str(r.id),
    userId: str(r.userId),
    companyId: str(r.companyId),
    createdBy: str(r.createdBy),
    createdAt: num(r.createdAt),
    expiresAt: num(r.expiresAt),
  }
}

function nameFromEmail(email: string): string {
  const local = email.split('@')[0]?.trim()
  return local || email
}

function parseModelRole(raw: Partial<ModelRole> | undefined): ModelRole {
  return { provider: String(raw?.provider ?? ''), model: String(raw?.model ?? '') }
}

function parsePlatformPayload(raw: string): PlatformSettings {
  try {
    const o = JSON.parse(raw) as Partial<PlatformSettings>
    const enabled = Array.isArray(o.enabledModels) ? o.enabledModels.map((x) => String(x)).filter(Boolean) : []
    return { daily: parseModelRole(o.daily), utility: parseModelRole(o.utility), enabledModels: enabled }
  } catch {
    return emptyPlatformSettings()
  }
}
function planOf(r: Row): Plan {
  return { companyId: str(r.companyId), seats: num(r.seats), updatedAt: num(r.updatedAt) }
}

function parseIdList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x))
  try {
    const v = JSON.parse(String(raw ?? '[]'))
    return Array.isArray(v) ? v.map((x) => String(x)) : []
  } catch {
    return []
  }
}

function groupOf(r: Row): Group {
  return {
    id: str(r.id),
    companyId: str(r.companyId),
    name: str(r.name),
    desc: str(r.desc || ''),
    icon: str(r.icon || 'chat'),
    role: str(r.role) === 'admin' ? 'admin' : 'member',
    members: parseIdList(r.members),
    agents: parseIdList(r.agents),
    createdAt: num(r.createdAt),
  }
}
function machineOf(r: Row): Machine {
  const auth = str(r.sshAuth || 'password')
  return {
    id: str(r.id),
    host: strOrNull(r.host),
    companyId: strOrNull(r.companyId),
    lastHeartbeatAt: numOrNull(r.lastHeartbeatAt),
    createdAt: num(r.createdAt),
    sshHost: strOrNull(r.sshHost),
    sshPort: r.sshPort == null ? 22 : num(r.sshPort),
    sshUser: str(r.sshUser || 'debian') || 'debian',
    sshAuth: auth === 'key' ? 'key' : 'password',
    sshSecret: strOrNull(r.sshSecret),
    token: str(r.token || ''),
  }
}

function seatStatusOf(v: unknown): SeatRuntimeStatus {
  const s = str(v || 'none')
  if (s === 'deploying' || s === 'ready' || s === 'error' || s === 'none') return s
  return 'error'
}

function seatRuntimeOf(r: Row): SeatRuntime {
  return {
    accountId: str(r.accountId),
    botId: str(r.botId),
    companyId: str(r.companyId),
    linuxUser: str(r.linuxUser),
    slot: num(r.slot),
    display: num(r.display),
    vncPort: num(r.vncPort),
    novncPort: num(r.novncPort),
    botPort: num(r.botPort),
    vncPassword: str(r.vncPassword),
    status: seatStatusOf(r.status),
    lastError: strOrNull(r.lastError),
    deployedAt: numOrNull(r.deployedAt),
    updatedAt: num(r.updatedAt),
    botVersion: strOrNull(r.botVersion),
  }
}
function botReleaseOf(r: Row): BotRelease {
  return {
    version: str(r.version),
    sha256: str(r.sha256),
    size: num(r.size),
    createdAt: num(r.createdAt),
    note: str(r.note || ''),
  }
}
function catalogOf(r: Row): CatalogItem {
  return {
    id: str(r.id),
    kind: str(r.kind) as CatalogKind,
    scope: str(r.scope) as Scope,
    companyId: strOrNull(r.companyId),
    name: str(r.name),
    definition: JSON.parse(str(r.definition)),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}
function credOf(r: Row): Credential {
  return {
    id: str(r.id),
    companyId: str(r.companyId),
    provider: str(r.provider),
    secret: str(r.secret),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}
function auditOf(r: Row): AuditEvent {
  return {
    id: str(r.id),
    companyId: str(r.companyId),
    accountId: strOrNull(r.accountId),
    action: str(r.action),
    detail: JSON.parse(str(r.detail)),
    createdAt: num(r.createdAt),
  }
}
function sessionIndexOf(r: Row): SessionIndex {
  return {
    sessionId: str(r.sessionId),
    companyId: str(r.companyId),
    accountId: str(r.accountId),
    botId: strOrNull(r.botId),
    machineId: strOrNull(r.machineId),
    origin: strOrNull(r.origin),
    remoteId: strOrNull(r.remoteId),
    messageCount: numOrNull(r.messageCount),
    title: strOrNull(r.title),
    createdAt: num(r.createdAt),
    updatedAt: num(r.updatedAt),
  }
}

function instanceOf(r: Row): Instance {
  return {
    accountId: str(r.accountId),
    botId: str(r.botId),
    companyId: strOrNull(r.companyId),
    host: str(r.host),
    lastReadyAt: num(r.lastReadyAt),
  }
}

/**
 * Gateway 自己的库。跟 Bot 的 satuwork.db 不是同一份——聊天正文永远不该出现在这里。
 */
export class Db {
  readonly sqlite: DatabaseSync

  constructor(path = gatewayHome('gateway.db')) {
    mkdirSync(dirname(path), { recursive: true })
    this.sqlite = new DatabaseSync(path)
    this.sqlite.exec('pragma journal_mode = WAL')
    this.sqlite.exec('pragma foreign_keys = ON')
    this.sqlite.exec(`
      create table if not exists companies (
        id        text primary key,
        slug      text not null unique,
        name      text not null,
        machineId text,
        accessUrl text,
        createdAt integer not null,
        updatedAt integer not null
      );
      create table if not exists accounts (
        id                 text primary key,
        companyId          text references companies(id),
        email              text not null unique,
        name               text not null default '',
        title              text not null default '',
        phone              text not null default '',
        theme              text not null default 'system',
        locale             text not null default 'zh',
        passwordHash       text not null,
        role               text not null check (role in ('owner', 'admin', 'member')),
        status             text not null default 'active' check (status in ('active', 'disabled', 'invited')),
        lastSeenAt         integer,
        passwordChangedAt  integer,
        tokenRevokedAt     integer,
        createdAt          integer not null,
        updatedAt          integer not null
      );
      create table if not exists invites (
        id        text primary key,
        userId    text not null,
        companyId text not null,
        createdBy text not null,
        createdAt integer not null,
        expiresAt integer not null
      );
      create index if not exists invites_user on invites (userId);
      create table if not exists plans (
        companyId text primary key references companies(id),
        seats     integer not null,
        updatedAt integer not null
      );
      create table if not exists machines (
        id              text primary key,
        host            text,
        companyId       text references companies(id),
        lastHeartbeatAt integer,
        createdAt       integer not null
      );
      create table if not exists catalog_items (
        id         text primary key,
        kind       text not null check (kind in ('model', 'skill', 'mcp', 'bot')),
        scope      text not null check (scope in ('global', 'company')),
        companyId  text references companies(id),
        name       text not null,
        definition text not null,
        createdAt  integer not null,
        updatedAt  integer not null
      );
      create table if not exists credentials (
        id        text primary key,
        companyId text not null references companies(id),
        provider  text not null,
        secret    text not null,
        createdAt integer not null,
        updatedAt integer not null,
        unique (companyId, provider)
      );
      create table if not exists audit_events (
        id        text primary key,
        companyId text not null,
        accountId text,
        action    text not null,
        detail    text not null,
        createdAt integer not null
      );
      create index if not exists audit_company on audit_events (companyId, createdAt desc);
      create index if not exists catalog_scope on catalog_items (kind, scope, companyId);
      create table if not exists settings (
        companyId text primary key references companies(id),
        payload   text not null,
        updatedAt integer not null
      );
      create table if not exists platform_credentials (
        provider  text primary key,
        secret    text not null,
        createdAt integer not null,
        updatedAt integer not null
      );
      create table if not exists platform_settings (
        id        text primary key,
        payload   text not null,
        updatedAt integer not null
      );
      create table if not exists groups (
        id        text primary key,
        companyId text not null references companies(id),
        name      text not null,
        desc      text not null default '',
        icon      text not null default 'chat',
        role      text not null check (role in ('admin', 'member')),
        members   text not null default '[]',
        agents    text not null default '[]',
        createdAt integer not null
      );
      create index if not exists groups_company on groups (companyId);
      create table if not exists skill_tags (
        companyId text not null,
        tag text not null,
        primary key (companyId, tag)
      );
      create table if not exists session_index (
        sessionId  text primary key,
        companyId  text not null,
        accountId  text not null,
        botId      text,
        machineId  text,
        title      text,
        createdAt  integer,
        updatedAt  integer
      );
      create index if not exists session_index_company on session_index (companyId, updatedAt desc);
      create table if not exists instances (
        accountId   text not null,
        botId       text not null,
        companyId   text,
        host        text not null,
        lastReadyAt integer not null,
        primary key (accountId, botId)
      );
      create table if not exists seat_runtimes (
        accountId    text not null,
        botId        text not null,
        companyId    text not null,
        linuxUser    text not null,
        slot         integer not null,
        display      integer not null,
        vncPort      integer not null,
        novncPort    integer not null,
        botPort      integer not null,
        vncPassword  text not null,
        status       text not null check (status in ('none', 'deploying', 'ready', 'error')),
        lastError    text,
        deployedAt   integer,
        updatedAt    integer not null,
        botVersion   text,
        primary key (accountId, botId),
        unique (companyId, slot),
        unique (companyId, linuxUser)
      );
      create index if not exists seat_runtimes_account on seat_runtimes (accountId);
      create table if not exists bot_releases (
        version   text primary key,
        sha256    text not null,
        size      integer not null,
        createdAt integer not null,
        note      text not null default ''
      );
      create table if not exists account_secrets (
        accountId    text primary key references accounts(id),
        apiKey       text not null unique,
        accessToken  text not null unique,
        createdAt    integer not null
      );
      create table if not exists llm_calls (
        id               text primary key,
        accountId        text not null,
        companyId        text,
        provider         text not null,
        model            text not null,
        promptTokens     integer not null default 0,
        completionTokens integer not null default 0,
        createdAt        integer not null
      );
      create index if not exists llm_calls_company on llm_calls (companyId, createdAt desc);
      create index if not exists llm_calls_account on llm_calls (accountId);
    `)
    this.migrateAccounts()
    this.migrateAccountMemberFields()
    this.migrateProfileFields()
    this.migrateMachineSsh()
    this.migrateSeatBotVersion()
    this.migrateSeatPairPk()
    this.migrateAccountSecrets()
    this.migrateMachineToken()
    this.migrateSessionIndexFields()
  }

  /**
   * 旧库 accounts.companyId 是 not null、role 没有 owner。
   * 建新表拷过去再换名。周围关掉 foreign_keys，避免重建时约束绊脚。
   */
  private migrateAccounts() {
    const row = this.sqlite.prepare("select sql from sqlite_master where type='table' and name='accounts'").get() as
      | { sql?: string }
      | undefined
    const sql = row?.sql ?? ''
    const companyNotNull = /companyId\s+text\s+not null/i.test(sql)
    const hasOwner = sql.includes("'owner'")
    if (!companyNotNull && hasOwner) return
    this.sqlite.exec('pragma foreign_keys = OFF')
    try {
      this.sqlite.exec('drop table if exists accounts_new')
      this.sqlite.exec(`
        create table accounts_new (
          id           text primary key,
          companyId    text references companies(id),
          email        text not null unique,
          passwordHash text not null,
          role         text not null check (role in ('owner', 'admin', 'member')),
          createdAt    integer not null,
          updatedAt    integer not null
        );
      `)
      this.sqlite.exec(
        'insert into accounts_new (id, companyId, email, passwordHash, role, createdAt, updatedAt) select id, companyId, email, passwordHash, role, createdAt, updatedAt from accounts',
      )
      this.sqlite.exec('drop table accounts')
      this.sqlite.exec('alter table accounts_new rename to accounts')
    } finally {
      this.sqlite.exec('pragma foreign_keys = ON')
    }
  }

  /**
   * 给已有库补成员管理字段。name 默认邮箱 @ 前面那一段，status 默认已激活。
   */
  private migrateAccountMemberFields() {
    const cols = this.sqlite.prepare('pragma table_info(accounts)').all() as { name: string }[]
    const names = new Set(cols.map((c) => c.name))
    if (!names.has('name')) this.sqlite.exec("alter table accounts add column name text not null default ''")
    if (!names.has('status')) this.sqlite.exec("alter table accounts add column status text not null default 'active'")
    if (!names.has('lastSeenAt')) this.sqlite.exec('alter table accounts add column lastSeenAt integer')
    if (!names.has('passwordChangedAt')) this.sqlite.exec('alter table accounts add column passwordChangedAt integer')
    if (!names.has('tokenRevokedAt')) this.sqlite.exec('alter table accounts add column tokenRevokedAt integer')
    this.sqlite.exec(`
      update accounts set name = case
        when instr(email, '@') > 1 then substr(email, 1, instr(email, '@') - 1)
        else email
      end
      where name is null or name = ''
    `)
    this.sqlite.exec("update accounts set status = 'active' where status is null or status = ''")
  }

  /**
   * 个人设置字段。职位、手机、外观、语言跟账号走，换机器登录能带过去。
   * 只 ADD COLUMN，不重建表。
   */
  private migrateProfileFields() {
    const cols = this.sqlite.prepare('pragma table_info(accounts)').all() as { name: string }[]
    const names = new Set(cols.map((c) => c.name))
    if (!names.has('title')) this.sqlite.exec("alter table accounts add column title text not null default ''")
    if (!names.has('phone')) this.sqlite.exec("alter table accounts add column phone text not null default ''")
    if (!names.has('theme')) this.sqlite.exec("alter table accounts add column theme text not null default 'system'")
    if (!names.has('locale')) this.sqlite.exec("alter table accounts add column locale text not null default 'zh'")
  }

  /**
   * 公司机器 SSH 登录。只 ADD COLUMN，不重建表，不碰已有 host/heartbeat。
   */
  private migrateMachineSsh() {
    const cols = this.sqlite.prepare('pragma table_info(machines)').all() as { name: string }[]
    const names = new Set(cols.map((c) => c.name))
    if (!names.has('sshHost')) this.sqlite.exec('alter table machines add column sshHost text')
    if (!names.has('sshPort')) this.sqlite.exec('alter table machines add column sshPort integer not null default 22')
    if (!names.has('sshUser')) this.sqlite.exec("alter table machines add column sshUser text not null default 'debian'")
    if (!names.has('sshAuth')) this.sqlite.exec("alter table machines add column sshAuth text not null default 'password'")
    if (!names.has('sshSecret')) this.sqlite.exec('alter table machines add column sshSecret text')
  }

  /**
   * 席位已部署的 Bot 版本。只 ADD COLUMN，不重建表。
   */
  private migrateSeatBotVersion() {
    const cols = this.sqlite.prepare('pragma table_info(seat_runtimes)').all() as { name: string }[]
    const names = new Set(cols.map((c) => c.name))
    if (!names.has('botVersion')) this.sqlite.exec('alter table seat_runtimes add column botVersion text')
  }

  /**
   * 席位从「一人一台」改成「(账号, botId) 一对一台」。
   * 旧行没法映射到 botId，丢掉；账号和密钥不动。已部署的席位要按 Bot 再部署一次。
   */
  private migrateSeatPairPk() {
    const seatCols = this.sqlite.prepare('pragma table_info(seat_runtimes)').all() as { name: string }[]
    const instCols = this.sqlite.prepare('pragma table_info(instances)').all() as { name: string }[]
    const seatHas = seatCols.some((c) => c.name === 'botId')
    const instHas = instCols.some((c) => c.name === 'botId')
    if (seatHas && instHas) {
      this.sqlite.exec('create index if not exists seat_runtimes_account on seat_runtimes (accountId)')
      return
    }
    this.sqlite.exec('pragma foreign_keys = OFF')
    try {
      if (!seatHas) {
        this.sqlite.exec('drop table if exists seat_runtimes_new')
        this.sqlite.exec(`
          create table seat_runtimes_new (
            accountId    text not null,
            botId        text not null,
            companyId    text not null,
            linuxUser    text not null,
            slot         integer not null,
            display      integer not null,
            vncPort      integer not null,
            novncPort    integer not null,
            botPort      integer not null,
            vncPassword  text not null,
            status       text not null check (status in ('none', 'deploying', 'ready', 'error')),
            lastError    text,
            deployedAt   integer,
            updatedAt    integer not null,
            botVersion   text,
            primary key (accountId, botId),
            unique (companyId, slot),
            unique (companyId, linuxUser)
          );
        `)
        this.sqlite.exec('drop table seat_runtimes')
        this.sqlite.exec('alter table seat_runtimes_new rename to seat_runtimes')
      }
      if (!instHas) {
        this.sqlite.exec('drop table if exists instances_new')
        this.sqlite.exec(`
          create table instances_new (
            accountId   text not null,
            botId       text not null,
            companyId   text,
            host        text not null,
            lastReadyAt integer not null,
            primary key (accountId, botId)
          );
        `)
        this.sqlite.exec('drop table instances')
        this.sqlite.exec('alter table instances_new rename to instances')
      }
      this.sqlite.exec('create index if not exists seat_runtimes_account on seat_runtimes (accountId)')
    } finally {
      this.sqlite.exec('pragma foreign_keys = ON')
    }
  }

  /**
   * 席位密钥与调用记录。不往 accounts 加列，避免 SELECT * 把 secret 喂进 Account。
   * 已有 admin/member 补发一对；owner 不占席位，不发。
   */
  private migrateAccountSecrets() {
    this.sqlite.exec(`
      create table if not exists account_secrets (
        accountId    text primary key references accounts(id),
        apiKey       text not null unique,
        accessToken  text not null unique,
        createdAt    integer not null
      );
      create table if not exists llm_calls (
        id               text primary key,
        accountId        text not null,
        companyId        text,
        provider         text not null,
        model            text not null,
        promptTokens     integer not null default 0,
        completionTokens integer not null default 0,
        createdAt        integer not null
      );
      create index if not exists llm_calls_company on llm_calls (companyId, createdAt desc);
      create index if not exists llm_calls_account on llm_calls (accountId);
    `)
    const rows = this.sqlite.prepare("select id from accounts where role in ('admin', 'member')").all() as Row[]
    for (const row of rows) this.issueAccountSecrets(str(row.id))
  }

  /**
   * 每台机器一把 smt_ 票。只 ADD COLUMN，已有行补发互不相同的 token。
   */
  private migrateMachineToken() {
    const cols = this.sqlite.prepare('pragma table_info(machines)').all() as { name: string }[]
    const names = new Set(cols.map((c) => c.name))
    if (!names.has('token')) this.sqlite.exec('alter table machines add column token text')
    const rows = this.sqlite.prepare("select id from machines where token is null or token = ''").all() as Row[]
    for (const row of rows) {
      for (let i = 0; i < 8; i++) {
        try {
          this.sqlite.prepare('update machines set token=? where id=?').run(randomMachineToken(), str(row.id))
          break
        } catch (e) {
          if (i === 7 || !isUniqueViolation(e)) throw e
        }
      }
    }
    this.sqlite.exec('create unique index if not exists machines_token on machines(token)')
  }

  /**
   * 会话索引补 origin / remoteId / messageCount。只 ADD COLUMN。
   */
  private migrateSessionIndexFields() {
    const cols = this.sqlite.prepare('pragma table_info(session_index)').all() as { name: string }[]
    const names = new Set(cols.map((c) => c.name))
    if (!names.has('origin')) this.sqlite.exec('alter table session_index add column origin text')
    if (!names.has('remoteId')) this.sqlite.exec('alter table session_index add column remoteId text')
    if (!names.has('messageCount')) this.sqlite.exec('alter table session_index add column messageCount integer')
  }

  close() {
    this.sqlite.close()
  }

  tx<T>(fn: () => T): T {
    this.sqlite.exec('begin immediate')
    try {
      const out = fn()
      this.sqlite.exec('commit')
      return out
    } catch (e) {
      this.sqlite.exec('rollback')
      throw e
    }
  }

  // ── 公司 ──────────────────────────────────────────────────────────────

  insertCompany(input: { slug: string; name: string }): Company {
    const now = Date.now()
    const row: Company = {
      id: randomUUID(),
      slug: input.slug,
      name: input.name,
      machineId: null,
      accessUrl: null,
      createdAt: now,
      updatedAt: now,
    }
    this.sqlite
      .prepare('insert into companies (id, slug, name, machineId, accessUrl, createdAt, updatedAt) values (?,?,?,?,?,?,?)')
      .run(row.id, row.slug, row.name, row.machineId, row.accessUrl, row.createdAt, row.updatedAt)
    return row
  }

  company(id: string): Company | undefined {
    const r = this.sqlite.prepare('select * from companies where id = ?').get(id) as Row | undefined
    return r ? companyOf(r) : undefined
  }

  companyBySlug(slug: string): Company | undefined {
    const r = this.sqlite.prepare('select * from companies where slug = ?').get(slug) as Row | undefined
    return r ? companyOf(r) : undefined
  }

  updateCompany(id: string, patch: Partial<Pick<Company, 'name' | 'slug' | 'machineId' | 'accessUrl'>>): Company {
    const cur = this.company(id)
    if (!cur) throw new Error('公司不存在')
    const next: Company = {
      ...cur,
      name: patch.name ?? cur.name,
      slug: patch.slug ?? cur.slug,
      machineId: patch.machineId === undefined ? cur.machineId : patch.machineId,
      accessUrl: patch.accessUrl === undefined ? cur.accessUrl : patch.accessUrl,
      updatedAt: Date.now(),
    }
    this.sqlite
      .prepare('update companies set slug=?, name=?, machineId=?, accessUrl=?, updatedAt=? where id=?')
      .run(next.slug, next.name, next.machineId, next.accessUrl, next.updatedAt, id)
    return next
  }

  deleteCompany(id: string) {
    this.sqlite.prepare('delete from groups where companyId = ?').run(id)
    this.sqlite.prepare('delete from skill_tags where companyId = ?').run(id)
    this.sqlite.prepare('delete from session_index where companyId = ?').run(id)
    this.sqlite.prepare('delete from instances where companyId = ?').run(id)
    this.sqlite.prepare('delete from seat_runtimes where companyId = ?').run(id)
    this.sqlite.prepare('delete from audit_events where companyId = ?').run(id)
    this.sqlite.prepare('delete from settings where companyId = ?').run(id)
    this.sqlite.prepare('delete from credentials where companyId = ?').run(id)
    this.sqlite.prepare('delete from catalog_items where companyId = ?').run(id)
    this.sqlite.prepare('update machines set companyId = null where companyId = ?').run(id)
    this.sqlite.prepare('delete from invites where companyId = ?').run(id)
    this.sqlite.prepare('delete from llm_calls where companyId = ?').run(id)
    this.sqlite.prepare('delete from account_secrets where accountId in (select id from accounts where companyId = ?)').run(id)
    this.sqlite.prepare('delete from accounts where companyId = ?').run(id)
    this.sqlite.prepare('delete from plans where companyId = ?').run(id)
    this.sqlite.prepare('delete from companies where id = ?').run(id)
  }

  companies(): Company[] {
    const rows = this.sqlite.prepare('select * from companies order by createdAt').all() as Row[]
    return rows.map(companyOf)
  }

  // ── 账号 ──────────────────────────────────────────────────────────────

  insertAccount(input: {
    companyId: string | null
    email: string
    passwordHash: string
    role: Role
    name?: string
    status?: AccountStatus
  }): Account {
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
    this.sqlite
      .prepare(
        'insert into accounts (id, companyId, email, name, title, phone, theme, locale, passwordHash, role, status, lastSeenAt, passwordChangedAt, tokenRevokedAt, createdAt, updatedAt) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
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
      )
    if (row.role === 'admin' || row.role === 'member') this.issueAccountSecrets(row.id)
    return row
  }

  account(id: string): Account | undefined {
    const r = this.sqlite.prepare('select * from accounts where id = ?').get(id) as Row | undefined
    return r ? accountOf(r) : undefined
  }

  accountByEmail(email: string): Account | undefined {
    const r = this.sqlite.prepare('select * from accounts where email = ?').get(email) as Row | undefined
    return r ? accountOf(r) : undefined
  }

  accountsOf(companyId: string): Account[] {
    const rows = this.sqlite.prepare('select * from accounts where companyId = ? order by createdAt').all(companyId) as Row[]
    return rows.map(accountOf)
  }

  accountsAll(): Account[] {
    const rows = this.sqlite.prepare('select * from accounts order by createdAt').all() as Row[]
    return rows.map(accountOf)
  }

  owners(): Account[] {
    const rows = this.sqlite.prepare("select * from accounts where role = 'owner' order by createdAt").all() as Row[]
    return rows.map(accountOf)
  }

  /** 占用席位：本公司非停用账号（owner 本来就不属于公司）。 */
  accountCount(companyId: string): number {
    const r = this.sqlite
      .prepare("select count(*) as n from accounts where companyId = ? and status != 'disabled' and role != 'owner'")
      .get(companyId) as { n: number }
    return Number(r.n)
  }

  /** 还能管事的管理员：未停用的 admin（含待接受）。最后一个管理员靠它守门。 */
  adminCount(companyId: string): number {
    const r = this.sqlite
      .prepare("select count(*) as n from accounts where companyId = ? and role = 'admin' and status != 'disabled'")
      .get(companyId) as { n: number }
    return Number(r.n)
  }

  updateAccount(
    id: string,
    patch: Partial<
      Pick<
        Account,
        'name' | 'title' | 'phone' | 'theme' | 'locale' | 'role' | 'status' | 'lastSeenAt' | 'passwordHash' | 'passwordChangedAt' | 'tokenRevokedAt'
      >
    >,
  ): Account {
    const cur = this.account(id)
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
    this.sqlite
      .prepare(
        'update accounts set name=?, title=?, phone=?, theme=?, locale=?, role=?, status=?, lastSeenAt=?, passwordHash=?, passwordChangedAt=?, tokenRevokedAt=?, updatedAt=? where id=?',
      )
      .run(
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
      )
    return next
  }

  deleteAccount(id: string) {
    this.tx(() => {
      const cur = this.account(id)
      this.deleteInvitesForUser(id)
      this.sqlite.prepare('delete from session_index where accountId = ?').run(id)
      this.sqlite.prepare('delete from instances where accountId = ?').run(id)
      this.sqlite.prepare('delete from seat_runtimes where accountId = ?').run(id)
      this.sqlite.prepare('delete from llm_calls where accountId = ?').run(id)
      this.sqlite.prepare('delete from account_secrets where accountId = ?').run(id)
      if (cur?.companyId) {
        for (const g of this.groupsOf(cur.companyId)) {
          if (!g.members.includes(id)) continue
          this.updateGroup(g.id, { members: g.members.filter((m) => m !== id) })
        }
      }
      this.sqlite.prepare('delete from accounts where id = ?').run(id)
    })
  }

  // ── 席位密钥。明文存，详情页给 owner 看；列表接口不许带出去。────────

  accountSecrets(accountId: string): { apiKey: string; accessToken: string; createdAt: number } | undefined {
    const r = this.sqlite.prepare('select apiKey, accessToken, createdAt from account_secrets where accountId = ?').get(accountId) as
      | Row
      | undefined
    if (!r) return undefined
    return { apiKey: str(r.apiKey), accessToken: str(r.accessToken), createdAt: num(r.createdAt) }
  }

  issueAccountSecrets(accountId: string): { apiKey: string; accessToken: string; createdAt: number } | undefined {
    const existing = this.accountSecrets(accountId)
    if (existing) return existing
    const account = this.account(accountId)
    if (!account || account.role === 'owner') return undefined
    for (let i = 0; i < 8; i++) {
      const apiKey = randomApiKey()
      const accessToken = randomAccessToken()
      const createdAt = Date.now()
      try {
        this.sqlite
          .prepare('insert into account_secrets (accountId, apiKey, accessToken, createdAt) values (?,?,?,?)')
          .run(accountId, apiKey, accessToken, createdAt)
        return { apiKey, accessToken, createdAt }
      } catch (e) {
        if (i === 7 || !isUniqueViolation(e)) throw e
      }
    }
    return undefined
  }

  /** 旧席位部署时补发。已有则原样返回。 */
  ensureAccountSecrets(accountId: string): { apiKey: string; accessToken: string; createdAt: number } | undefined {
    return this.issueAccountSecrets(accountId)
  }

  accountByApiKey(key: string): Account | undefined {
    if (!key) return undefined
    const r = this.sqlite.prepare('select accountId from account_secrets where apiKey = ?').get(key) as Row | undefined
    return r ? this.account(str(r.accountId)) : undefined
  }

  accountByAccessToken(token: string): Account | undefined {
    if (!token) return undefined
    const r = this.sqlite.prepare('select accountId from account_secrets where accessToken = ?').get(token) as Row | undefined
    return r ? this.account(str(r.accountId)) : undefined
  }

  insertLlmCall(input: {
    accountId: string
    companyId?: string | null
    provider: string
    model: string
    promptTokens?: number
    completionTokens?: number
  }): LlmCall {
    const row: LlmCall = {
      id: randomUUID(),
      accountId: input.accountId,
      companyId: input.companyId ?? null,
      provider: input.provider,
      model: input.model,
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
      createdAt: Date.now(),
    }
    this.sqlite
      .prepare(
        'insert into llm_calls (id, accountId, companyId, provider, model, promptTokens, completionTokens, createdAt) values (?,?,?,?,?,?,?,?)',
      )
      .run(
        row.id,
        row.accountId,
        row.companyId,
        row.provider,
        row.model,
        row.promptTokens,
        row.completionTokens,
        row.createdAt,
      )
    return row
  }

  updateLlmCallTokens(id: string, promptTokens: number, completionTokens: number) {
    this.sqlite
      .prepare('update llm_calls set promptTokens=?, completionTokens=? where id=?')
      .run(promptTokens, completionTokens, id)
  }

  llmCallsOfCompany(companyId: string): LlmCall[] {
    const rows = this.sqlite
      .prepare('select * from llm_calls where companyId = ? order by createdAt desc')
      .all(companyId) as Row[]
    return rows.map((r) => ({
      id: str(r.id),
      accountId: str(r.accountId),
      companyId: strOrNull(r.companyId),
      provider: str(r.provider),
      model: str(r.model),
      promptTokens: num(r.promptTokens),
      completionTokens: num(r.completionTokens),
      createdAt: num(r.createdAt),
    }))
  }

  private llmRangeSql(alias: string, range?: { from?: number; to?: number }): { sql: string; args: number[] } {
    let sql = ''
    const args: number[] = []
    if (range?.from != null) {
      sql += ` and ${alias}createdAt >= ?`
      args.push(range.from)
    }
    if (range?.to != null) {
      sql += ` and ${alias}createdAt <= ?`
      args.push(range.to)
    }
    return { sql, args }
  }

  llmUsageOfCompany(companyId: string, range?: { from?: number; to?: number }): LlmUsage {
    const r = this.llmRangeSql('', range)
    const total = this.sqlite
      .prepare(
        `select count(*) as calls, coalesce(sum(promptTokens), 0) as promptTokens, coalesce(sum(completionTokens), 0) as completionTokens from llm_calls where companyId = ?${r.sql}`,
      )
      .get(companyId, ...r.args) as Row
    const by = this.sqlite
      .prepare(
        `select accountId, count(*) as calls, coalesce(sum(promptTokens), 0) as promptTokens, coalesce(sum(completionTokens), 0) as completionTokens, max(createdAt) as lastAt from llm_calls where companyId = ?${r.sql} group by accountId`,
      )
      .all(companyId, ...r.args) as Row[]
    return {
      calls: num(total.calls),
      promptTokens: num(total.promptTokens),
      completionTokens: num(total.completionTokens),
      byAccount: by.map((row) => ({
        accountId: str(row.accountId),
        calls: num(row.calls),
        promptTokens: num(row.promptTokens),
        completionTokens: num(row.completionTokens),
        lastAt: numOrNull(row.lastAt),
      })),
    }
  }

  llmUsageOfAccount(accountId: string, range?: { from?: number; to?: number }): LlmUsage {
    const r = this.llmRangeSql('', range)
    const total = this.sqlite
      .prepare(
        `select count(*) as calls, coalesce(sum(promptTokens), 0) as promptTokens, coalesce(sum(completionTokens), 0) as completionTokens from llm_calls where accountId = ?${r.sql}`,
      )
      .get(accountId, ...r.args) as Row
    const by = this.sqlite
      .prepare(
        `select accountId, count(*) as calls, coalesce(sum(promptTokens), 0) as promptTokens, coalesce(sum(completionTokens), 0) as completionTokens, max(createdAt) as lastAt from llm_calls where accountId = ?${r.sql} group by accountId`,
      )
      .all(accountId, ...r.args) as Row[]
    return {
      calls: num(total.calls),
      promptTokens: num(total.promptTokens),
      completionTokens: num(total.completionTokens),
      byAccount: by.map((row) => ({
        accountId: str(row.accountId),
        calls: num(row.calls),
        promptTokens: num(row.promptTokens),
        completionTokens: num(row.completionTokens),
        lastAt: numOrNull(row.lastAt),
      })),
    }
  }

  // ── 分组。全体成员是算出来的，不进这张表。──────────────────────────

  groupsOf(companyId: string): Group[] {
    const rows = this.sqlite.prepare('select * from groups where companyId = ? order by createdAt').all(companyId) as Row[]
    return rows.map(groupOf)
  }

  group(id: string): Group | undefined {
    const r = this.sqlite.prepare('select * from groups where id = ?').get(id) as Row | undefined
    return r ? groupOf(r) : undefined
  }

  insertGroup(input: {
    companyId: string
    name: string
    desc?: string
    icon?: string
    role: 'admin' | 'member'
    members?: string[]
    agents?: string[]
  }): Group {
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
    this.sqlite
      .prepare(
        'insert into groups (id, companyId, name, desc, icon, role, members, agents, createdAt) values (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        row.id,
        row.companyId,
        row.name,
        row.desc,
        row.icon,
        row.role,
        JSON.stringify(row.members),
        JSON.stringify(row.agents),
        row.createdAt,
      )
    return row
  }

  updateGroup(
    id: string,
    patch: Partial<Pick<Group, 'name' | 'desc' | 'icon' | 'role' | 'members' | 'agents'>>,
  ): Group {
    const cur = this.group(id)
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
    this.sqlite
      .prepare('update groups set name=?, desc=?, icon=?, role=?, members=?, agents=? where id=?')
      .run(next.name, next.desc, next.icon, next.role, JSON.stringify(next.members), JSON.stringify(next.agents), id)
    return next
  }

  deleteGroup(id: string): boolean {
    const r = this.sqlite.prepare('delete from groups where id = ?').run(id)
    return Number(r.changes) > 0
  }

  // ── 邀请 ──────────────────────────────────────────────────────────────

  putInvite(row: Invite): Invite {
    this.sqlite
      .prepare('insert into invites (id, userId, companyId, createdBy, createdAt, expiresAt) values (?,?,?,?,?,?)')
      .run(row.id, row.userId, row.companyId, row.createdBy, row.createdAt, row.expiresAt)
    return row
  }

  invite(id: string): Invite | undefined {
    const r = this.sqlite.prepare('select * from invites where id = ?').get(id) as Row | undefined
    return r ? inviteOf(r) : undefined
  }

  deleteInvitesForUser(userId: string) {
    this.sqlite.prepare('delete from invites where userId = ?').run(userId)
  }

  deleteInvite(id: string) {
    this.sqlite.prepare('delete from invites where id = ?').run(id)
  }

  // ── 套餐 ──────────────────────────────────────────────────────────────

  upsertPlan(companyId: string, seats: number): Plan {
    const now = Date.now()
    this.sqlite
      .prepare(
        'insert into plans (companyId, seats, updatedAt) values (?,?,?) on conflict(companyId) do update set seats=excluded.seats, updatedAt=excluded.updatedAt',
      )
      .run(companyId, seats, now)
    return { companyId, seats, updatedAt: now }
  }

  plan(companyId: string): Plan | undefined {
    const r = this.sqlite.prepare('select * from plans where companyId = ?').get(companyId) as Row | undefined
    return r ? planOf(r) : undefined
  }

  // ── 机器 ──────────────────────────────────────────────────────────────

  insertMachine(input: {
    id?: string
    host?: string | null
    companyId?: string | null
    sshHost?: string | null
    sshPort?: number
    sshUser?: string
    sshAuth?: 'password' | 'key'
    sshSecret?: string | null
  }): Machine {
    const base = {
      id: input.id ?? randomUUID(),
      host: input.host ?? null,
      companyId: input.companyId ?? null,
      lastHeartbeatAt: null as number | null,
      createdAt: Date.now(),
      sshHost: input.sshHost ?? null,
      sshPort: input.sshPort ?? 22,
      sshUser: input.sshUser ?? 'debian',
      sshAuth: (input.sshAuth ?? 'password') as 'password' | 'key',
      sshSecret: input.sshSecret ?? null,
    }
    for (let i = 0; i < 8; i++) {
      const row: Machine = { ...base, token: randomMachineToken() }
      try {
        this.sqlite
          .prepare(
            'insert into machines (id, host, companyId, lastHeartbeatAt, createdAt, sshHost, sshPort, sshUser, sshAuth, sshSecret, token) values (?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            row.id,
            row.host,
            row.companyId,
            row.lastHeartbeatAt,
            row.createdAt,
            row.sshHost,
            row.sshPort,
            row.sshUser,
            row.sshAuth,
            row.sshSecret,
            row.token,
          )
        return row
      } catch (e) {
        if (i === 7 || !isUniqueViolation(e)) throw e
      }
    }
    throw new Error('无法签发机器凭证')
  }

  machine(id: string): Machine | undefined {
    const r = this.sqlite.prepare('select * from machines where id = ?').get(id) as Row | undefined
    return r ? machineOf(r) : undefined
  }

  machineByToken(token: string): Machine | undefined {
    if (!token) return undefined
    const r = this.sqlite.prepare('select * from machines where token = ?').get(token) as Row | undefined
    return r ? machineOf(r) : undefined
  }

  machineOfCompany(companyId: string): Machine | undefined {
    const r = this.sqlite.prepare('select * from machines where companyId = ?').get(companyId) as Row | undefined
    return r ? machineOf(r) : undefined
  }

  updateMachine(
    id: string,
    patch: Partial<
      Pick<Machine, 'host' | 'companyId' | 'lastHeartbeatAt' | 'sshHost' | 'sshPort' | 'sshUser' | 'sshAuth' | 'sshSecret'>
    >,
  ): Machine {
    const cur = this.machine(id)
    if (!cur) throw new Error('机器不存在')
    const next: Machine = {
      ...cur,
      host: patch.host === undefined ? cur.host : patch.host,
      companyId: patch.companyId === undefined ? cur.companyId : patch.companyId,
      lastHeartbeatAt: patch.lastHeartbeatAt === undefined ? cur.lastHeartbeatAt : patch.lastHeartbeatAt,
      sshHost: patch.sshHost === undefined ? cur.sshHost : patch.sshHost,
      sshPort: patch.sshPort === undefined ? cur.sshPort : patch.sshPort,
      sshUser: patch.sshUser === undefined ? cur.sshUser : patch.sshUser,
      sshAuth: patch.sshAuth === undefined ? cur.sshAuth : patch.sshAuth,
      sshSecret: patch.sshSecret === undefined ? cur.sshSecret : patch.sshSecret,
    }
    this.sqlite
      .prepare(
        'update machines set host=?, companyId=?, lastHeartbeatAt=?, sshHost=?, sshPort=?, sshUser=?, sshAuth=?, sshSecret=? where id=?',
      )
      .run(
        next.host,
        next.companyId,
        next.lastHeartbeatAt,
        next.sshHost,
        next.sshPort,
        next.sshUser,
        next.sshAuth,
        next.sshSecret,
        id,
      )
    return next
  }

  // ── 实例。(账号, botId) 一对一台 Bot 运行时。只存 host，不存聊天正文。──

  instance(accountId: string, botId: string): Instance | undefined {
    const r = this.sqlite.prepare('select * from instances where accountId = ? and botId = ?').get(accountId, botId) as
      | Row
      | undefined
    return r ? instanceOf(r) : undefined
  }

  seatRuntime(accountId: string, botId: string): SeatRuntime | undefined {
    const r = this.sqlite
      .prepare('select * from seat_runtimes where accountId = ? and botId = ?')
      .get(accountId, botId) as Row | undefined
    return r ? seatRuntimeOf(r) : undefined
  }

  seatRuntimesOf(companyId: string): SeatRuntime[] {
    const rows = this.sqlite.prepare('select * from seat_runtimes where companyId = ? order by slot').all(companyId) as Row[]
    return rows.map(seatRuntimeOf)
  }

  seatRuntimesOfAccount(accountId: string): SeatRuntime[] {
    const rows = this.sqlite
      .prepare('select * from seat_runtimes where accountId = ? order by slot')
      .all(accountId) as Row[]
    return rows.map(seatRuntimeOf)
  }

  upsertSeatRuntime(row: SeatRuntime): SeatRuntime {
    this.sqlite
      .prepare(
        `insert into seat_runtimes (
           accountId, botId, companyId, linuxUser, slot, display, vncPort, novncPort, botPort,
           vncPassword, status, lastError, deployedAt, updatedAt, botVersion
         ) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         on conflict(accountId, botId) do update set
           companyId=excluded.companyId,
           linuxUser=excluded.linuxUser,
           slot=excluded.slot,
           display=excluded.display,
           vncPort=excluded.vncPort,
           novncPort=excluded.novncPort,
           botPort=excluded.botPort,
           vncPassword=excluded.vncPassword,
           status=excluded.status,
           lastError=excluded.lastError,
           deployedAt=excluded.deployedAt,
           updatedAt=excluded.updatedAt,
           botVersion=excluded.botVersion`,
      )
      .run(
        row.accountId,
        row.botId,
        row.companyId,
        row.linuxUser,
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
      )
    return this.seatRuntime(row.accountId, row.botId)!
  }

  deleteSeatRuntime(accountId: string) {
    this.sqlite.prepare('delete from seat_runtimes where accountId = ?').run(accountId)
  }

  // ── Bot 发布包。只存元数据，tarball 在 $SATUWORK_GATEWAY_HOME/releases。──

  insertBotRelease(row: BotRelease): BotRelease {
    this.sqlite
      .prepare('insert into bot_releases (version, sha256, size, createdAt, note) values (?,?,?,?,?)')
      .run(row.version, row.sha256, row.size, row.createdAt, row.note)
    return row
  }

  botRelease(version: string): BotRelease | undefined {
    const r = this.sqlite.prepare('select * from bot_releases where version = ?').get(version) as Row | undefined
    return r ? botReleaseOf(r) : undefined
  }

  botReleases(): BotRelease[] {
    const rows = this.sqlite.prepare('select * from bot_releases order by createdAt desc').all() as Row[]
    return rows.map(botReleaseOf)
  }

  latestBotRelease(): BotRelease | undefined {
    const r = this.sqlite.prepare('select * from bot_releases order by createdAt desc limit 1').get() as Row | undefined
    return r ? botReleaseOf(r) : undefined
  }

  upsertInstance(input: { accountId: string; botId: string; companyId?: string | null; host: string }): Instance {
    const now = Date.now()
    const companyId = input.companyId === undefined ? null : input.companyId
    const botId = input.botId
    this.sqlite
      .prepare(
        `insert into instances (accountId, botId, companyId, host, lastReadyAt) values (?,?,?,?,?)
         on conflict(accountId, botId) do update set
           companyId=excluded.companyId,
           host=excluded.host,
           lastReadyAt=excluded.lastReadyAt`,
      )
      .run(input.accountId, botId, companyId, input.host, now)
    return { accountId: input.accountId, botId, companyId, host: input.host, lastReadyAt: now }
  }

  // ── 目录 ──────────────────────────────────────────────────────────────

  insertCatalog(input: {
    kind: CatalogKind
    scope: Scope
    companyId: string | null
    name: string
    definition?: unknown
  }): CatalogItem {
    const now = Date.now()
    const row: CatalogItem = {
      id: randomUUID(),
      kind: input.kind,
      scope: input.scope,
      companyId: input.scope === 'global' ? null : input.companyId,
      name: input.name,
      definition: input.definition ?? {},
      createdAt: now,
      updatedAt: now,
    }
    this.sqlite
      .prepare('insert into catalog_items (id, kind, scope, companyId, name, definition, createdAt, updatedAt) values (?,?,?,?,?,?,?,?)')
      .run(row.id, row.kind, row.scope, row.companyId, row.name, JSON.stringify(row.definition), row.createdAt, row.updatedAt)
    return row
  }

  catalog(id: string): CatalogItem | undefined {
    const r = this.sqlite.prepare('select * from catalog_items where id = ?').get(id) as Row | undefined
    return r ? catalogOf(r) : undefined
  }

  visibleCatalog(kind: CatalogKind, companyId: string | null): CatalogItem[] {
    if (!companyId) {
      const rows = this.sqlite
        .prepare("select * from catalog_items where kind = ? and scope = 'global' order by name")
        .all(kind) as Row[]
      return rows.map(catalogOf)
    }
    const rows = this.sqlite
      .prepare(
        "select * from catalog_items where kind = ? and (scope = 'global' or (scope = 'company' and companyId = ?)) order by scope, name",
      )
      .all(kind, companyId) as Row[]
    return rows.map(catalogOf)
  }

  companyCatalog(kind: CatalogKind, companyId: string): CatalogItem[] {
    const rows = this.sqlite
      .prepare("select * from catalog_items where kind = ? and scope = 'company' and companyId = ? order by name")
      .all(kind, companyId) as Row[]
    return rows.map(catalogOf)
  }

  updateCatalog(id: string, patch: { name?: string; definition?: unknown }): CatalogItem {
    const cur = this.catalog(id)
    if (!cur) throw new Error('目录项不存在')
    const next: CatalogItem = {
      ...cur,
      name: patch.name ?? cur.name,
      definition: patch.definition === undefined ? cur.definition : patch.definition,
      updatedAt: Date.now(),
    }
    this.sqlite
      .prepare('update catalog_items set name=?, definition=?, updatedAt=? where id=?')
      .run(next.name, JSON.stringify(next.definition), next.updatedAt, id)
    return next
  }

  deleteCatalog(id: string) {
    this.sqlite.prepare('delete from catalog_items where id = ?').run(id)
  }

  // ── 密钥 ──────────────────────────────────────────────────────────────

  insertCredential(input: { companyId: string; provider: string; secret: string }): Credential {
    const now = Date.now()
    const row: Credential = {
      id: randomUUID(),
      companyId: input.companyId,
      provider: input.provider,
      secret: input.secret,
      createdAt: now,
      updatedAt: now,
    }
    this.sqlite
      .prepare('insert into credentials (id, companyId, provider, secret, createdAt, updatedAt) values (?,?,?,?,?,?)')
      .run(row.id, row.companyId, row.provider, row.secret, row.createdAt, row.updatedAt)
    return row
  }

  credential(id: string): Credential | undefined {
    const r = this.sqlite.prepare('select * from credentials where id = ?').get(id) as Row | undefined
    return r ? credOf(r) : undefined
  }

  credentialsOf(companyId: string): Credential[] {
    const rows = this.sqlite.prepare('select * from credentials where companyId = ? order by provider').all(companyId) as Row[]
    return rows.map(credOf)
  }

  credentialByProvider(companyId: string, provider: string): Credential | undefined {
    const r = this.sqlite
      .prepare('select * from credentials where companyId = ? and provider = ?')
      .get(companyId, provider) as Row | undefined
    return r ? credOf(r) : undefined
  }

  platformCredential(provider: string): Credential | undefined {
    const r = this.sqlite.prepare('select * from platform_credentials where provider = ?').get(provider) as Row | undefined
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

  upsertPlatformCredential(provider: string, secret: string): Credential {
    const now = Date.now()
    this.sqlite
      .prepare(
        'insert into platform_credentials (provider, secret, createdAt, updatedAt) values (?,?,?,?) on conflict(provider) do update set secret=excluded.secret, updatedAt=excluded.updatedAt',
      )
      .run(provider, secret, now, now)
    return this.platformCredential(provider)!
  }

  platformCredentials(): Credential[] {
    const rows = this.sqlite.prepare('select * from platform_credentials order by provider').all() as Row[]
    return rows.map((r) => ({
      id: `platform:${str(r.provider)}`,
      companyId: '',
      provider: str(r.provider),
      secret: str(r.secret),
      createdAt: num(r.createdAt),
      updatedAt: num(r.updatedAt),
    }))
  }

  deletePlatformCredential(provider: string) {
    this.sqlite.prepare('delete from platform_credentials where provider = ?').run(provider)
  }

  updateCredential(id: string, secret: string): Credential {
    const cur = this.credential(id)
    if (!cur) throw new Error('密钥不存在')
    const next = { ...cur, secret, updatedAt: Date.now() }
    this.sqlite.prepare('update credentials set secret=?, updatedAt=? where id=?').run(next.secret, next.updatedAt, id)
    return next
  }

  deleteCredential(id: string) {
    this.sqlite.prepare('delete from credentials where id = ?').run(id)
  }

  // ── 审计 ──────────────────────────────────────────────────────────────

  audit(input: { companyId: string; accountId?: string | null; action: string; detail?: unknown }): AuditEvent {
    const row: AuditEvent = {
      id: randomUUID(),
      companyId: input.companyId,
      accountId: input.accountId ?? null,
      action: input.action,
      detail: input.detail ?? {},
      createdAt: Date.now(),
    }
    this.sqlite
      .prepare('insert into audit_events (id, companyId, accountId, action, detail, createdAt) values (?,?,?,?,?,?)')
      .run(row.id, row.companyId, row.accountId, row.action, JSON.stringify(row.detail), row.createdAt)
    return row
  }

  auditsOf(companyId: string, limit = 100): AuditEvent[] {
    const rows = this.sqlite
      .prepare('select * from audit_events where companyId = ? order by createdAt desc limit ?')
      .all(companyId, limit) as Row[]
    return rows.map(auditOf)
  }

  // ── 会话索引。只存指针，不存 user/message 或 assistant/message 正文。──

  upsertSessionIndex(input: {
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
  }): SessionIndex {
    const cur = this.sessionIndex(input.sessionId)
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
    this.sqlite
      .prepare(
        `insert into session_index (sessionId, companyId, accountId, botId, machineId, origin, remoteId, messageCount, title, createdAt, updatedAt)
         values (?,?,?,?,?,?,?,?,?,?,?)
         on conflict(sessionId) do update set
           companyId=excluded.companyId,
           accountId=excluded.accountId,
           botId=excluded.botId,
           machineId=excluded.machineId,
           origin=excluded.origin,
           remoteId=excluded.remoteId,
           messageCount=excluded.messageCount,
           title=excluded.title,
           createdAt=excluded.createdAt,
           updatedAt=excluded.updatedAt`,
      )
      .run(
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
      )
    return row
  }

  sessionIndex(sessionId: string): SessionIndex | undefined {
    const r = this.sqlite.prepare('select * from session_index where sessionId = ?').get(sessionId) as Row | undefined
    return r ? sessionIndexOf(r) : undefined
  }

  listSessionIndex(
    companyId: string,
    filter: { accountId?: string; botId?: string; from?: number; to?: number } = {},
  ): SessionIndex[] {
    let sql = 'select * from session_index where companyId = ?'
    const args: (string | number)[] = [companyId]
    if (filter.accountId) {
      sql += ' and accountId = ?'
      args.push(filter.accountId)
    }
    if (filter.botId) {
      sql += ' and botId = ?'
      args.push(filter.botId)
    }
    if (filter.from != null) {
      sql += ' and updatedAt >= ?'
      args.push(filter.from)
    }
    if (filter.to != null) {
      sql += ' and updatedAt <= ?'
      args.push(filter.to)
    }
    sql += ' order by updatedAt desc'
    const rows = this.sqlite.prepare(sql).all(...args) as Row[]
    return rows.map(sessionIndexOf)
  }

  // ── 公司模型角色（日常 / utility）。不存密钥。────────────────────────

  settings(companyId: string): CompanySettings {
    const r = this.sqlite.prepare('select payload from settings where companyId = ?').get(companyId) as Row | undefined
    if (!r) return emptySettings()
    try {
      const raw = JSON.parse(str(r.payload)) as Partial<CompanySettings>
      return {
        daily: { provider: String(raw.daily?.provider ?? ''), model: String(raw.daily?.model ?? '') },
        utility: { provider: String(raw.utility?.provider ?? ''), model: String(raw.utility?.model ?? '') },
      }
    } catch {
      return emptySettings()
    }
  }

  putSettings(companyId: string, next: CompanySettings): CompanySettings {
    const now = Date.now()
    const payload = JSON.stringify({
      daily: { provider: next.daily.provider, model: next.daily.model },
      utility: { provider: next.utility.provider, model: next.utility.model },
    })
    this.sqlite
      .prepare(
        'insert into settings (companyId, payload, updatedAt) values (?,?,?) on conflict(companyId) do update set payload=excluded.payload, updatedAt=excluded.updatedAt',
      )
      .run(companyId, payload, now)
    return this.settings(companyId)
  }

  platformSettings(): PlatformSettings {
    const r = this.sqlite.prepare("select payload from platform_settings where id = 'platform'").get() as Row | undefined
    if (!r) return emptyPlatformSettings()
    return parsePlatformPayload(str(r.payload))
  }

  putPlatformSettings(next: PlatformSettings): PlatformSettings {
    const now = Date.now()
    const enabled = Array.isArray(next.enabledModels) ? next.enabledModels.map((x) => String(x)).filter(Boolean) : []
    const payload = JSON.stringify({
      daily: { provider: next.daily.provider, model: next.daily.model },
      utility: { provider: next.utility.provider, model: next.utility.model },
      enabledModels: enabled,
    })
    this.sqlite
      .prepare(
        "insert into platform_settings (id, payload, updatedAt) values ('platform', ?, ?) on conflict(id) do update set payload=excluded.payload, updatedAt=excluded.updatedAt",
      )
      .run(payload, now)
    return this.platformSettings()
  }

  /**
   * 一次性：公司日常/utility 升到平台设置（平台还空时）；
   * 公司密钥升到 platform_credentials（该 provider 还没有平台密钥时）。
   */
  liftCompanyDataToPlatform(): { settings: boolean; providers: string[] } {
    const lifted = { settings: false, providers: [] as string[] }
    const cur = this.platformSettings()
    const empty = !cur.daily.provider && !cur.daily.model && !cur.utility.provider && !cur.utility.model
    if (empty) {
      const rows = this.sqlite.prepare('select payload from settings order by updatedAt desc').all() as Row[]
      for (const row of rows) {
        const s = parsePlatformPayload(str(row.payload))
        if (s.daily.provider || s.daily.model || s.utility.provider || s.utility.model) {
          this.putPlatformSettings({ daily: s.daily, utility: s.utility, enabledModels: cur.enabledModels })
          lifted.settings = true
          break
        }
      }
    }
    const have = new Set(this.platformCredentials().map((c) => c.provider))
    const creds = this.sqlite.prepare('select provider, secret from credentials').all() as Row[]
    for (const row of creds) {
      const provider = str(row.provider)
      if (!provider || have.has(provider)) continue
      this.upsertPlatformCredential(provider, str(row.secret))
      have.add(provider)
      lifted.providers.push(provider)
    }
    return lifted
  }

  // ── Skill 标签。稿子上那八个是初值，建了新的就进这张表。──────────────

  skillTags(companyId: string): string[] {
    const rows = this.sqlite.prepare('select tag from skill_tags where companyId = ? order by rowid').all(companyId) as Row[]
    return rows.map((r) => str(r.tag))
  }

  insertSkillTag(companyId: string, tag: string) {
    this.sqlite.prepare('insert or ignore into skill_tags (companyId, tag) values (?, ?)').run(companyId, tag)
  }

  deleteSkillTag(companyId: string, tag: string): boolean {
    const r = this.sqlite.prepare('delete from skill_tags where companyId = ? and tag = ?').run(companyId, tag)
    return Number(r.changes) > 0
  }
}
