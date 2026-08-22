import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { canonicalTimezone, isUniqueViolation, releaseArch, type Account, type BotRelease, type Db, type Machine, type SeatRuntime } from './db.ts'
import { signDesktopTicket, type JwtKeys } from './crypto.ts'
import { botReleaseFile } from './releases.ts'

/** 管家握手协议。低于这个数的机器不给下发部署——字段对不上会失败得很难看。 */
export const MIN_MANAGER_PROTOCOL = 1

/**
 * 桌面反代要求的管家协议。**和 MIN_MANAGER_PROTOCOL 分开**：管家旧一点，部署、聊天、
 * 日志都还照常能用，只有「从 Gateway 同域看桌面」这一件事做不了。把总门槛抬到 2
 * 会把那些功能一起停掉，代价远大于收益。
 */
export const MIN_DESKTOP_PROTOCOL = 2

export interface SeatPorts {
  display: number
  vncPort: number
  novncPort: number
  botPort: number
  cdpPort: number
}

/**
 * `sw-` + first 12 hex of sha256(accountId). **一个员工一个 Linux 账号**，他名下的
 * 所有 bot 共用这个账号——这正是「同一个人的多个 bot 能看见同一批文件」的实现方式：
 * 共享靠 uid 相同，不靠任何代码。
 *
 * 前缀从 `bot-` 换成 `sw-` 是故意的：老机器上残留的 `bot-xxxxxxxx` 账号是按
 * (account, bot) 建的，两套命名不会互相覆盖，也一眼看得出哪些是待清理的旧账号。
 */
export function linuxUserOf(accountId: string): string {
  return 'sw-' + createHash('sha256').update(accountId).digest('hex').slice(0, 12)
}

/**
 * 席位标识 `<linuxUser>-<botId 前 12 hex>`：systemd 实例名、席位私有目录、
 * `XDG_RUNTIME_DIR` 都用它。
 *
 * **不能再拿 Linux 用户名当实例名**——同一个员工现在有多个席位，用户名不唯一了。
 * 单元模板里原来的 `User=%i` 改成由 drop-in 提供 `User=`，实例名和账号就此解耦。
 */
export function seatIdOf(accountId: string, botId: string): string {
  return linuxUserOf(accountId) + '-' + createHash('sha256').update(botId).digest('hex').slice(0, 12)
}

export function homeDirOf(linuxUser: string): string {
  return '/home/' + linuxUser
}

/** 共享工作区。同一员工的所有席位都挂着它——放共享资料的地方。 */
export function workDirOf(linuxUser: string): string {
  return homeDirOf(linuxUser) + '/work'
}

/** 席位私有目录。`$SATUWORK_HOME`、Chrome profile、XDG 各目录全在这底下。 */
export function seatDirOf(linuxUser: string, seatId: string): string {
  return homeDirOf(linuxUser) + '/.satuwork/' + seatId
}

/**
 * 每台机器的槽位上限（0..MAX_SLOT）。
 *
 * 端口全是从槽位算出来的，四段基址里挨得最近的两段只差 171——RFB 5910+N 和
 * noVNC 6081+N。于是 slot 171 的 vncPort 正好等于 slot 0 的 novncPort：两个席位抢同
 * 一个口，先起的赢，后起的那个桌面连不上，而两边的记录看着都正常。槽位必须卡在这
 * 个差值之内，并且要在**分配的时候**就报错，不能等到机器上端口冲突了才发现。
 */
export const MAX_SLOT = 170

/** 槽位用尽。deploySeat 把它翻成 409，不让它变成一个 500。 */
export class SlotsExhausted extends Error {
  constructor() {
    super(`这台机器的席位槽位已用满（每台上限 ${MAX_SLOT + 1} 个）`)
  }
}

/** Slot N=0..MAX_SLOT DISPLAY=10+N RFB=5910+N HTTP=6081+N CDP=9222+N Bot=3200+N */
export function portsOf(slot: number): SeatPorts {
  const n = Math.max(0, Math.trunc(slot))
  return {
    display: 10 + n,
    vncPort: 5910 + n,
    novncPort: 6081 + n,
    botPort: 3200 + n,
    cdpPort: 9222 + n,
  }
}

/**
 * 桌面地址。**Gateway 同域的一条路径，不再是管家的地址。**
 *
 * 一路走过来：先是 `http://<sshHost>:<6081+N>/vnc.html`（每个席位一个对外端口，明
 * 文），然后收成 `{machine.host}/seats/:id/vnc/`（noVNC 回到 127.0.0.1，浏览器只打
 * 管家一个口），现在再收一层到 `/desktop/:seatId/`，由 Gateway 反代过去。
 *
 * **为什么还要再收一层。** 桌面现在内嵌在右栏的 iframe 里。管家发的那张 cookie 是
 * `SameSite=Lax`：顶层跳转（原来那种新标签页）放行，跨站 iframe 里连存都不给存，于
 * 是画面永远出不来，而且不报错。同域之后 cookie 是第一方的，问题从根上没了；顺带
 * 浏览器也不再需要能连到管家——只要 Gateway 连得到就行。
 *
 * `managerHost` 留着不是摆设：它为空表示这块屏还没落到任何一台机器上，那就没有地址
 * 可给。没有票时只返回入口路径，给 owner 在后台看一眼用，点不进去。
 */
export function novncUrlOf(managerHost: string | null, seatId: string, ticket?: string): string {
  if (!(managerHost || '').trim() || !seatId) return ''
  const url = `/desktop/${encodeURIComponent(seatId)}/`
  return ticket ? `${url}?ticket=${encodeURIComponent(ticket)}` : url
}

/**
 * 单个席位的部署超时。第一次部署要 apt 装一整套桌面栈，十五分钟是给它的。
 *
 * 重铺一个已经 ready 的席位用不了这么久，批量那条路自己传一个短的（见 managerDeploy）。
 */
export const DEPLOY_TIMEOUT_MS = 900_000

/** Gateway 反代聊天时打的地址。管家按 seatId 转到本机的 bot 口。 */
export function botBaseOf(managerHost: string | null, seatId: string): string {
  const base = (managerHost || '').trim().replace(/\/$/, '')
  if (!base || !seatId) return ''
  return `${base}/seats/${encodeURIComponent(seatId)}/bot`
}

export function randomVncPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const buf = randomBytes(16)
  let out = ''
  for (let i = 0; i < 16; i++) out += alphabet[buf[i]! % alphabet.length]
  return out
}

/**
 * 管家的心跳周期。**和 manager/src/index.ts 的 `HEARTBEAT_MS` 是同一个数**，改一边
 * 要改另一边——下面「多久算失联」全是按它的倍数定的，两边分叉的话灯会在机器好好的
 * 时候变黄。
 */
export const MANAGER_HEARTBEAT_MS = 30_000

/**
 * 墓碑最多躺多久。
 *
 * 移除一台在线的机器时，Gateway 留一行 `removedAt` 不删，等管家下一轮心跳来取信、
 * 收拾完回执了才真删。机器要是再也不回来（已经关机、网线拔了、重装过），这一行不
 * 能永远躺着——超过这个时限就当它收不到了，扫掉。
 *
 * 10 分钟 = 20 轮心跳。够一次重启加一段网络抖动，又不至于让人在列表里等太久才看到
 * 那台机器彻底消失（其实界面上第一时间就看不见它了，墓碑只对库可见）。
 */
export const MACHINE_TOMBSTONE_TTL = 10 * 60_000

/** 通联状态。界面上那盏灯只认这四个值。 */
export type MachineLink = 'unpaired' | 'online' | 'stale' | 'offline'

/**
 * 这台机器现在通不通。
 *
 * 判据只有一个：**最近一次心跳有多久了**。不看 `lastError`——那是「机器说它自己哪儿
 * 不对」，能报错恰恰说明线是通的；把两件事混进一盏灯，管理员就分不出「机器失联」和
 * 「机器在线但升级失败」，而这两种的处置完全不同。
 *
 * 三级而不是两级，是因为**换版重启本身就会断一下**：`systemd-run --on-active=2s` 加
 * 上进程起来、跑完第一轮心跳，几十秒很正常。一超时就报「失联」会让每次自升级都闪一
 * 次红灯，几次之后没人再信这盏灯。所以中间留一档 `stale`：过了 3 轮心跳还没消息，
 * 值得看一眼，但还不到「这台机器没了」。
 */
export function machineLink(m: Machine, now = Date.now()): MachineLink {
  // 没配对就没有心跳可言——这一档要和「配对过但失联」分开：前者是还没装，后者是出事了。
  if (!machinePaired(m)) return 'unpaired'
  if (!m.lastHeartbeatAt) return 'offline'
  const age = now - m.lastHeartbeatAt
  if (age <= MANAGER_HEARTBEAT_MS * 3) return 'online'
  if (age <= MANAGER_HEARTBEAT_MS * 20) return 'stale'
  return 'offline'
}

export function publicMachine(m: Machine) {
  const now = Date.now()
  return {
    id: m.id,
    host: m.host,
    paired: Boolean(m.pairedAt && m.host),
    pairedAt: m.pairedAt,
    managerVersion: m.managerVersion,
    protocol: m.protocol,
    protocolTooOld: Boolean(m.pairedAt) && m.protocol < MIN_MANAGER_PROTOCOL,
    lastError: m.lastError,
    lastHeartbeatAt: m.lastHeartbeatAt,
    link: machineLink(m, now),
    /**
     * 距最近一次心跳多少毫秒。没心跳过就是 null。
     *
     * 界面**不能**拿 `lastHeartbeatAt` 自己减本地时钟：管理员的机器和 Gateway 差几分钟
     * 是常事，那样会显示出「-3 分钟前」这种东西，而这盏灯要答的恰恰是时间问题。
     * 算好了给它。
     */
    heartbeatAge: m.lastHeartbeatAt ? Math.max(0, now - m.lastHeartbeatAt) : null,
    // 期望时区和机器自报的实际时区都给出去：只给一个的话，界面分不出「已经改上了」
    // 和「指令下了、机器还没心跳回来」。
    timezone: m.timezone,
    currentTimezone: m.currentTimezone,
  }
}

/**
 * IANA 时区名的校验与归一。空串 = 清掉，表示「不管这台机器的时区」。
 *
 * 两道关，缺一不可：
 *
 * - **形状**。这个值会一路传到管家、变成 `timedatectl set-timezone` 的参数，还会被
 *   当成 `/usr/share/zoneinfo` 底下的路径去查。所以先卡死字符集，并挡掉 `..`。
 * - **认不认识**。形状对但不存在的名字（`Asia/Shanghi`）过了 Gateway 这关，就只能
 *   在机器上失败——而那里的错误要等一轮心跳才看得见。用 Intl 当权威表，就地回绝。
 *
 * 返回 `undefined` = 不合法，调用方去报 400。
 */
export function normalizeTimezone(raw: string): string | null | undefined {
  const tz = raw.trim()
  if (!tz) return null
  // 形状与「Intl 认不认」这两关都在 canonicalTimezone 里（日常任务的触发器用的是
  // 同一个）。分两份写的话，两条路对同一个名字给出不同答案只是时间问题。
  //
  // 归一到规范拼写的代价是别名会被换掉（`Asia/Calcutta` → `Asia/Kolkata`），而规范名
  // 有的是 tzdata 的 backward 链接。Debian 的 tzdata 是全的；真裁过的机器上，管家会先
  // 查 /usr/share/zoneinfo 并把「这台机器上没有这个时区」报回心跳，不会静默改不上。
  return canonicalTimezone(tz) || undefined
}

/**
 * owner 机器详情：像账号密钥一样带一次 token。公司 admin 的 publicMachine 永不带。
 *
 * `arch` 也只在这一侧给：它是选发布包的依据（包里带原生二进制，架构不对就起不来），
 * 平台侧排查「为什么这台升不上去」第一眼看的就是它。公司管理员用不着，也不该看。
 *
 * **负载和日志占用同理，也只在这一侧。** `GET /orgs/:id/machine` 是给公司里任何一个
 * 成员看的（他们要拿访问地址），而那份自报数据里有挂载点、网卡名、`/var/log` 底下
 * 的文件路径——运维要看的机器内情，不是员工该拿到的东西。
 */
export function ownerMachine(m: Machine) {
  const now = Date.now()
  return {
    ...publicMachine(m),
    arch: m.arch,
    telemetry: m.telemetry,
    telemetryAt: m.telemetryAt,
    /**
     * 这份自报数据收到多久了。
     *
     * 年龄由这里算，不留给界面拿 telemetryAt 去减本地时钟——理由和 heartbeatAge 一样：
     * 管理员的机器和 Gateway 差几分钟是常事，而这一格答的恰恰是「这份数还新不新」，
     * 算错了整块就是在骗人。
     */
    telemetryAge: m.telemetryAt ? Math.max(0, now - m.telemetryAt) : null,
    /**
     * 期望的日志上限。空 = 没人指定过，跟管家默认走；0 = 明确不清。
     *
     * 机器**实际**在用的那个数在 `telemetry.logs.capMb` 里——两格分开，界面才说得清
     * 「指令下了」和「机器认了」（机器上还可以用 SATUWORK_LOG_CAP_MB 本地钉死，那时
     * 两个数就是对不上的，而那正是要看得见的事）。
     */
    logCapMb: m.logCapMb,
    token: m.token || null,
  }
}

export function publicSeatRuntime(
  row: SeatRuntime,
  managerHost: string | null,
  opts: { includePassword: boolean; ticket?: string },
) {
  const ports = portsOf(row.slot)
  return {
    accountId: row.accountId,
    botId: row.botId,
    companyId: row.companyId,
    linuxUser: row.linuxUser,
    seatId: row.seatId,
    // 员工要知道往哪儿放共享文件：同一个账号下的所有 bot 都看得见这个目录。
    sharedDir: workDirOf(row.linuxUser),
    display: row.display,
    vncPort: row.vncPort,
    novncPort: row.novncPort,
    novncUrl: novncUrlOf(managerHost, row.seatId, opts.ticket),
    status: row.status,
    lastError: row.lastError,
    deployedAt: row.deployedAt,
    updatedAt: row.updatedAt,
    botVersion: row.botVersion ?? null,
    // 席位自报的模版版本。和 botVersion 并排给出来，界面上那两个「版本」问的是两件事：
    // 装的是哪个发布包、跑的是哪一版模版。
    tplVersion: row.tplVersion ?? null,
    tplSyncedAt: row.tplSyncedAt ?? null,
    ...(opts.includePassword ? { vncPassword: row.vncPassword } : {}),
    ports: {
      display: ports.display,
      vncPort: ports.vncPort,
      novncPort: ports.novncPort,
    },
  }
}

export function listSeatRuntime(row: SeatRuntime, managerHost: string | null) {
  return {
    botId: row.botId,
    status: row.status,
    linuxUser: row.linuxUser,
    seatId: row.seatId,
    // 列表里不签票：这是给管理员看的引用，点进去要走 /runtime/desktop 现签一张。
    novncUrl: novncUrlOf(managerHost, row.seatId) || null,
    botVersion: row.botVersion ?? null,
    tplVersion: row.tplVersion ?? null,
    tplSyncedAt: row.tplSyncedAt ?? null,
  }
}

/** 给某个席位现签一张桌面票，拼成能直接点开的地址。 */
export function desktopUrlOf(keys: JwtKeys, machine: Machine | undefined, row: SeatRuntime): string {
  if (!machinePaired(machine)) return ''
  // 口令随票走，人点开就进桌面，不用再去右栏抄一遍。
  return novncUrlOf(machine.host, row.seatId, signDesktopTicket(keys, row.seatId, row.vncPassword))
}

function gatewayPublicUrl(): string {
  const explicit = (process.env.GATEWAY_PUBLIC_URL || '').trim().replace(/\/$/, '')
  if (explicit) return explicit
  const host = process.env.GATEWAY_HOST || '127.0.0.1'
  const port = process.env.GATEWAY_PORT || '3080'
  return `http://${host}:${port}`
}

/** 槽位**按机器**分配，不是按公司：端口从槽位算出来，两台机器上的 slot 0 互不冲突。 */
async function allocateSlot(db: Db, machineId: string, keep?: number): Promise<number> {
  if (keep != null && keep >= 0) return keep
  const used = new Set((await db.seatRuntimesOfMachine(machineId)).map((r) => r.slot))
  let i = 0
  while (used.has(i)) i += 1
  if (i > MAX_SLOT) throw new SlotsExhausted()
  return i
}

/** 一台机器上「激活账号」的数量：有已部署席位的不同账号。 */
export function activeAccountsOf(seats: SeatRuntime[]): Set<string> {
  return new Set(seats.filter((r) => r.status !== 'none').map((r) => r.accountId))
}

export interface MachineLoad {
  machine: Machine
  /**
   * 这台机器上的席位行。
   *
   * **算负载的时候本来就查过一遍**，所以顺手带出来：下游要画席位清单的地方（机器
   * 卡片）不必再查一次同一批行。少一次往返事小，两份可能对不上的数据事大——负载
   * 数字和席位清单出自同一次查询，界面上「账号位 3/10」和底下那张表就永远一致。
   */
  seatRows: SeatRuntime[]
  accounts: number
  seats: number
  full: boolean
}

export async function machineLoads(db: Db, companyId: string): Promise<MachineLoad[]> {
  const machines = await db.machinesOfCompany(companyId)
  return Promise.all(machines.map((machine) => machineLoadOf(db, machine)))
}

/** 单台机器的负载。多机公司走 machineLoads，平台侧按 id 拿单台的走这条。 */
export async function machineLoadOf(db: Db, machine: Machine): Promise<MachineLoad> {
  const seatRows = await db.seatRuntimesOfMachine(machine.id)
  const accounts = activeAccountsOf(seatRows).size
  return { machine, seatRows, accounts, seats: seatRows.length, full: accounts >= machine.maxAccounts }
}

/**
 * 这个账号该落在哪台机器上。
 *
 * 两条规则：
 *
 * 1. **粘住。** 账号已经有席位了就还用那台机器——同一个员工的所有 bot 共用一个 uid
 *    和 `~/work`，拆到两台机器上「共享文件」就不成立了。
 * 2. **填满一台再用下一台。** 在没满的机器里挑**已用最多**的那台（并列按登记先后）。
 *    不是最闲优先——那样会把账号摊平到所有机器上，谁也没满，反而没法把空机器腾出来
 *    下线或者转给别的公司。
 */
export async function machineForAccount(
  db: Db,
  companyId: string,
  accountId: string,
): Promise<{ ok: true; machine: Machine } | { ok: false; status: number; error: string }> {
  const loads = await machineLoads(db, companyId)
  const paired = loads.filter((l) => machinePaired(l.machine))
  if (!paired.length) return { ok: false, status: 409, error: '公司还没有配对任何运行机器' }

  /**
   * 粘住是**不变量，不是优化**。
   *
   * 以前这里只有 `if (hit) return …`：找到了这个账号的机器、但它此刻不可用
   * （没配对好、换过地址、token 轮换失败、正在重装），就直接往下走「填满一台再用
   * 下一台」，把这个人的新 bot 部署到另一台机器上。共享 `~/work` 靠的是同一个 uid
   * 在同一台机器上，劈开之后这条就不成立了——而且没有任何告警，人只是从此看不见
   * 自己在另一台机器上的文件。
   *
   * 更糟的是下一次：seatRuntimesOfAccount 按 slot 排序，而 slot 是**按机器**分配的，
   * 跨机器排序没有语义——一旦劈开，挑哪台就变成任意的。
   *
   * 所以找到了就必须用那台；那台不行就报出来，让人先去修机器。
   */
  const mine = (await db.seatRuntimesOfAccount(accountId)).find((r) => r.machineId)
  if (mine) {
    const hit = paired.find((l) => l.machine.id === mine.machineId)
    // 粘住的机器就算已经满了也继续用：它的容量早就把这个账号算进去了。
    if (hit) return { ok: true, machine: hit.machine }
    const stale = loads.find((l) => l.machine.id === mine.machineId)?.machine
    return {
      ok: false,
      status: 409,
      error: stale
        ? `这个账号的席位在机器 ${stale.id.slice(0, 8)}（${stale.host || '地址未知'}）上，那台还没配对好。` +
          '先把它修好再部署——换一台会让这个人的共享文件对不上。'
        : '这个账号的席位所在的机器已经不在这家公司名下了。先把它派回来，或者删掉这个账号的旧席位。',
    }
  }

  const open = paired.filter((l) => !l.full).sort((a, b) => b.accounts - a.accounts || a.machine.createdAt - b.machine.createdAt)
  if (!open.length) {
    const total = paired.reduce((n, l) => n + l.machine.maxAccounts, 0)
    return { ok: false, status: 409, error: `所有运行机器都满了（${paired.length} 台，共 ${total} 个账号位）` }
  }
  return { ok: true, machine: open[0].machine }
}

export async function companyMachineOf(db: Db, companyId: string): Promise<Machine | undefined> {
  const company = await db.company(companyId)
  if (!company) return
  if (company.machineId) {
    const m = await db.machine(company.machineId)
    if (m) return m
  }
  return db.machineOfCompany(companyId)
}

/**
 * 这台机器装好管家并配对过了吗。
 *
 * 取代了原来的 `machineBound` + `machineHasSshAuth` 两级判断。以前「有地址」和
 * 「有登录凭据」是分开的两件事，现在配对是一次原子的事：要么两样都有，要么这台
 * 机器根本不存在。
 */
export function machinePaired(m: Machine | undefined): m is Machine {
  return Boolean(m && m.pairedAt && (m.host || '').trim() && m.token)
}

export interface DeployResult {
  runtime: SeatRuntime
  machine: Machine
}

/**
 * 分配（或复用）一个槽，把这个席位部署出去。
 *
 * Stub：`SATUWORK_DEPLOY_STUB=1` 直接写 ready，不联系管家。
 * Live：`PUT {machine.host}/seats/{seatId}`，机器上的活儿全由管家做。
 */
export async function deploySeat(
  db: Db,
  keys: JwtKeys,
  account: Account,
  opts: { botId: string; version?: string; update?: boolean; force?: boolean; timeoutMs?: number },
): Promise<
  | { ok: true; result: DeployResult }
  | { ok: false; status: number; error: string; runtime: SeatRuntime | undefined }
> {
  const companyId = account.companyId
  if (!companyId) return { ok: false, status: 403, error: '没有公司席位', runtime: undefined }
  const botId = (opts.botId || '').trim()
  if (!botId) return { ok: false, status: 400, error: 'botId 不能为空', runtime: undefined }
  // 按**主人**取名册：员工自己建的 Bot 只有他自己部署得了，别人拿到 id 也不行。
  const visible = await db.botsFor(companyId, account.id)
  if (!visible.some((b) => b.id === botId)) {
    return { ok: false, status: 404, error: '没有这个 Bot', runtime: undefined }
  }
  const picked = await machineForAccount(db, companyId, account.id)
  if (!picked.ok) return { ok: false, status: picked.status, error: picked.error, runtime: undefined }
  const machine = picked.machine
  if (machine.protocol < MIN_MANAGER_PROTOCOL) {
    return { ok: false, status: 409, error: '这台机器的管家版本过旧，等它自己升级或重跑安装脚本', runtime: undefined }
  }

  const requested = (opts.version || '').trim()
  let release: BotRelease
  if (requested) {
    const rel = await db.botRelease(requested)
    if (!rel) return { ok: false, status: 404, error: '没有这个 Bot 版本', runtime: await db.seatRuntime(account.id, botId) }
    // 显式指定也要挡：包里带 esbuild 的原生二进制，装错架构的后果是席位「部署成功」
    // 但 bot 起不来，表现是聊天 503——从部署结果上完全看不出来。两边架构都认得出来
    // 且不一样才拦，认不出来的（老版本号没后缀）放行。
    const want = machine.arch?.trim()
    const got = releaseArch(rel.version)
    if (want && got && got !== want) {
      return {
        ok: false,
        status: 409,
        error: `这台机器是 ${want}，而 ${rel.version} 是 ${got} 的包`,
        runtime: await db.seatRuntime(account.id, botId),
      }
    }
    release = rel
  } else {
    const latest = await db.latestBotRelease('bot', machine.arch)
    if (!latest) return { ok: false, status: 409, error: '还没有发布 Bot 版本', runtime: await db.seatRuntime(account.id, botId) }
    release = latest
  }
  const version = release.version

  const linuxUser = linuxUserOf(account.id)
  const seatId = seatIdOf(account.id, botId)
  const existing = await db.seatRuntime(account.id, botId)
  // 已经是这个版本、而且好着 → 不重装。**但 force 必须能穿过这道门。**
  //
  // 界面上「重新部署」按钮发的就是不带 force 的请求，于是它一直什么都没做：确认框写
  // 着「会把席位重装一遍并重启」，接口返回 200 和 ready，deployedAt 一秒都没动。
  // 而人按这个按钮的时候，要的恰恰是「现在这台机器上的东西不对，重新铺一遍」——
  // 席位状态 ready、版本没变，正是那种情况最典型的样子（VNC 口令没同步、dock 少一格、
  // 桌面服务还是老进程）。这道门把唯一的自助修复手段变成了一个安慰剂。
  if (existing?.status === 'ready' && existing.botVersion === version && !opts.update && !opts.force) {
    return { ok: true, result: { runtime: existing, machine } }
  }

  const vncPassword = existing?.vncPassword || randomVncPassword()
  let row: SeatRuntime | undefined
  try {
    for (let i = 0; i < 8; i++) {
      try {
        row = await db.tx(async () => {
          const slot = await allocateSlot(db, machine.id, i === 0 ? existing?.slot : undefined)
          const ports = portsOf(slot)
          const now = Date.now()
          return await db.upsertSeatRuntime({
            accountId: account.id,
            botId,
            companyId,
            linuxUser,
            seatId,
            machineId: machine.id,
            slot,
            display: ports.display,
            vncPort: ports.vncPort,
            novncPort: ports.novncPort,
            botPort: ports.botPort,
            vncPassword,
            status: 'deploying',
            lastError: null,
            deployedAt: existing?.deployedAt ?? null,
            updatedAt: now,
            botVersion: existing?.botVersion ?? null,
            // 席位自报的那两列不由这条路写（见 db.noteSeatTemplate）。带上旧值只是为了
            // 让这个对象是一整行；upsert 的列表里没有它们，写不进去也盖不掉。
            tplVersion: existing?.tplVersion ?? null,
            tplSyncedAt: existing?.tplSyncedAt ?? null,
          })
        })
        break
      } catch (e) {
        // 槽位是 unique(machineId, slot)：并发部署撞号了就重扫一遍再试。
        if (i === 7 || !isUniqueViolation(e)) throw e
      }
    }
  } catch (e) {
    if (e instanceof SlotsExhausted) return { ok: false, status: 409, error: e.message, runtime: existing }
    throw e
  }
  if (!row) return { ok: false, status: 500, error: '无法分配席位槽', runtime: existing }

  if (process.env.SATUWORK_DEPLOY_STUB === '1') {
    const ready = await db.upsertSeatRuntime({
      ...row,
      status: 'ready',
      lastError: null,
      deployedAt: Date.now(),
      updatedAt: Date.now(),
      botVersion: version,
    })
    await db.upsertInstance({
      accountId: account.id,
      botId,
      companyId,
      host: `http://127.0.0.1:${row.botPort}`,
    })
    return { ok: true, result: { runtime: ready, machine } }
  }

  // `url` 非空 = 只登记了地址、字节不在本机（registerRemoteRelease 那种）。这种包由
  // openRelease 在下发时现取，本机**本来就没有** .tgz。以前这里无条件 existsSync，
  // 于是一旦最新版本是远程登记的，所有席位的部署都会卡在「发布包文件不存在」。
  if (!release.url && !existsSync(botReleaseFile(version))) {
    const failed = await db.upsertSeatRuntime({
      ...row,
      status: 'error',
      lastError: '发布包文件不存在',
      updatedAt: Date.now(),
    })
    return { ok: false, status: 502, error: '发布包文件不存在', runtime: failed }
  }

  const secrets = await db.ensureAccountSecrets(account.id)
  if (!secrets) {
    const failed = await db.upsertSeatRuntime({
      ...row,
      status: 'error',
      lastError: '没有席位密钥',
      updatedAt: Date.now(),
    })
    return { ok: false, status: 500, error: '没有席位密钥', runtime: failed }
  }

  const spec: SeatSpec = {
    seatId,
    linuxUser,
    homeDir: homeDirOf(linuxUser),
    workDir: workDirOf(linuxUser),
    seatDir: seatDirOf(linuxUser, seatId),
    botId,
    botVersion: version,
    vncPassword,
    gatewayUrl: gatewayPublicUrl(),
    gatewayToken: secrets.accessToken,
    gatewayApiKey: secrets.apiKey,
    ports: portsOf(row.slot),
  }
  try {
    await managerDeploy(machine, spec, opts.timeoutMs)
  } catch (e) {
    const message = sanitizeError(e, [machine.token, secrets.accessToken, secrets.apiKey, vncPassword])
    const failed = await db.upsertSeatRuntime({
      ...row,
      status: 'error',
      lastError: message,
      updatedAt: Date.now(),
    })
    return { ok: false, status: 502, error: message, runtime: failed }
  }

  const ready = await db.upsertSeatRuntime({
    ...row,
    status: 'ready',
    lastError: null,
    deployedAt: Date.now(),
    updatedAt: Date.now(),
    botVersion: version,
  })
  await db.upsertInstance({
    accountId: account.id,
    botId,
    companyId,
    // 反代地址，不是 bot 的直连地址。席位端口只听 127.0.0.1，只有管家够得着。
    host: botBaseOf(machine.host, seatId),
  })
  return { ok: true, result: { runtime: ready, machine } }
}

/** Gateway 下发给管家的席位规格。字段和 manager/src/seats.ts 的 SeatSpec 一一对应。 */
export interface SeatSpec {
  seatId: string
  linuxUser: string
  homeDir: string
  workDir: string
  seatDir: string
  botId: string
  botVersion: string
  vncPassword: string
  gatewayUrl: string
  gatewayToken: string
  gatewayApiKey: string
  ports: SeatPorts
}

/**
 * 把一个席位交给管家去建。
 *
 * 这一整个函数取代了原来的 scp + ssh：发布包不再逐席位推过去，管家自己按版本从
 * Gateway 拉一次、全机共享；`smt_` 走 `x-satuwork-machine` 头，和管家转发给 bot 的
 * `authorization` 分开——两层鉴权互不干扰。
 *
 * 15 分钟超时：第一次部署要 apt 装一整套桌面栈，慢是正常的。
 *
 * 批量重铺那条路（模版的「立即下发」）会传一个**短得多**的超时：那些席位都已经
 * ready，桌面栈早装好了，不该让一台卡住的机器把整条请求拖到十五分钟。
 */
async function managerDeploy(machine: Machine, spec: SeatSpec, timeoutMs = DEPLOY_TIMEOUT_MS): Promise<void> {
  const url = `${machine.host!.replace(/\/$/, '')}/seats/${encodeURIComponent(spec.seatId)}`
  let res: Response
  try {
    res = await fetch(url, {
      method: 'PUT',
      // 两个头都带：`x-satuwork-machine` 是反代那条路径上用来和 bot 的 `authorization`
      // 区分开的；控制类调用没有这个冲突，带上 `authorization` 让 curl 和旧版管家也认。
      headers: {
        'content-type': 'application/json',
        'x-satuwork-machine': machine.token,
        authorization: 'Bearer ' + machine.token,
      },
      body: JSON.stringify(spec),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new Error('联系不上机器管家: ' + (e instanceof Error ? e.message : String(e)))
  }
  if (res.ok) return
  /**
   * **先读完再解析，最后才截。** 原先是 `text().slice(0, 400)` 之后再 JSON.parse——
   * 而真出错时这个响应体一定超过 400 字（里面整个席位记录都在），于是 JSON 被砍断、
   * parse 必然失败、回退成「把那段残缺 JSON 当错误存起来」。也就是说：**越是有内容的
   * 错误，越是拿不到内容**，界面上看到的是半句话加一个没闭合的花括号。真发生过。
   *
   * 上限放到 16 KiB：管家那侧已经把输出裁到 500 字级别，这里只需要够装下整个 JSON。
   */
  const text = (await res.text()).slice(0, 16_000)
  let message = text
  try {
    const body = JSON.parse(text) as { error?: string; seat?: { lastError?: string } }
    message = body.seat?.lastError || body.error || text
  } catch {}
  throw new Error(`管家部署失败 ${res.status}: ${tailOf(message, 900)}`)
}

/** 拆席位：停单元、删 drop-in、删席位目录。账号和 ~/work 留着，别的席位还在用。 */
export async function managerRemoveSeat(machine: Machine, seatId: string): Promise<void> {
  if (!machinePaired(machine)) return
  const url = `${machine.host!.replace(/\/$/, '')}/seats/${encodeURIComponent(seatId)}`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: { 'x-satuwork-machine': machine.token, authorization: 'Bearer ' + machine.token },
    signal: AbortSignal.timeout(120_000),
  })
  if (!res.ok && res.status !== 404) throw new Error(`管家拆席位失败 ${res.status}`)
}

/**
 * 把一批席位从它们所在的机器上拆掉。**删账号和删公司走的是同一条**。
 *
 * 为什么不能只删库里的行：`seat_runtimes` 一没，slot 立刻能被下一个账号分走
 * （`allocateSlot` 就是扫这张表找第一个空号），而机器上那套 systemd 单元还在跑、
 * 还占着同一组端口（3200+N / 6081+N）。下一个人的席位于是起不来，现象是「新员工
 * 的 bot 一直起不来」，谁也不会想到是几个月前删掉的那家公司留下的。
 *
 * 拆不掉就抛，由调用方翻成 502 并劝人先「停用」——那是现成的非破坏性动作，机器
 * 回来之后再删也不迟。硬删下去只会留下一批谁也看不见、还占着端口的席位。
 *
 * 没配对的机器（还没装管家、或者已经注销）跳过：那上面本来就没有我们放上去的东西。
 *
 * **删 Bot 不走这条**，走下面的 purgeBot：那条路上「拆不掉」不该把删除一起否掉。
 */
export async function releaseSeats(db: Db, seats: SeatRuntime[]): Promise<void> {
  const { failed } = await releaseSeatsBestEffort(db, seats)
  if (failed.length) throw new Error(failed[0].error)
}

/** 拆不掉的那些。`error` 已经脱敏，可以原样给人看。 */
export interface SeatReleaseResult {
  released: SeatRuntime[]
  failed: { seat: SeatRuntime; error: string }[]
}

/**
 * 同上，但**逐个记账而不是第一个失败就停**。
 *
 * 删 Bot 走这条：那条路上「拆席位」失败不能把「删 Bot」一起否掉。管家拆席位的顺序
 * 是先停单元再收拾目录，中间任何一步出岔子（单元卡在 stopping、目录不在它该在的
 * 位置、120 秒超时），Bot 都已经聊不了了，而删除每次都以同一个理由失败——那颗 Bot
 * 于是既用不了也删不掉，界面上还一直列着。这是真发生过的现场。
 *
 * 拆不掉的席位由调用方留成墓碑（见 db.orphanSeatRuntime）：行留着，slot 就不会被
 * 下一个人分走，而 Bot 那边该删的全删。
 */
export async function releaseSeatsBestEffort(db: Db, seats: SeatRuntime[]): Promise<SeatReleaseResult> {
  const out: SeatReleaseResult = { released: [], failed: [] }
  // 一台机器查一次，别为同一台机器上的每个席位都去 db.machine() 一趟。
  const machines = new Map<string, Machine | undefined>()
  /**
   * 已经答不上话的机器。**同一台不再逐个席位重试**：管家那一跳等 120 秒，一台躺着
   * 的机器上有十个席位就是二十分钟，而第一次的答案已经够了。
   */
  const dead = new Map<string, string>()
  for (const seat of seats) {
    // 没配对的机器（还没装管家、或者已经注销）跳过：那上面本来就没有我们放上去的
    // 东西，算「拆掉了」。
    if (!seat.machineId) {
      out.released.push(seat)
      continue
    }
    if (!machines.has(seat.machineId)) machines.set(seat.machineId, await db.machine(seat.machineId))
    const machine = machines.get(seat.machineId)
    if (!machinePaired(machine)) {
      out.released.push(seat)
      continue
    }
    const seen = dead.get(seat.machineId)
    if (seen !== undefined) {
      out.failed.push({ seat, error: `席位 ${seat.seatId}：${seen}` })
      continue
    }
    try {
      await managerRemoveSeat(machine, seat.seatId)
      out.released.push(seat)
    } catch (e) {
      const why = `机器拆不掉（${sanitizeError(e, [machine.token])}）。先把它「停用」，等机器恢复后再删除。`
      dead.set(seat.machineId, why)
      out.failed.push({ seat, error: `席位 ${seat.seatId} 所在的${why}` })
    }
  }
  return out
}

/**
 * 删一颗 Bot：**先拆机器上的席位，再把库里跟它有关的东西清干净**。
 *
 * 两件事的成败是分开的。席位拆掉了就连行一起删；拆不掉就把那行留成墓碑（状态
 * 出错、写明原因），slot 因此不会被下一个人分走，而 Bot 本身照删不误——「删了」和
 * 「界面上还列着但聊不了」之间，用户要的永远是前者。
 *
 * 按 botId 查席位、不按公司：全局 Bot 可能被好几家公司各自部署过。
 */
export async function purgeBot(db: Db, botId: string): Promise<SeatReleaseResult> {
  const seats = await db.seatRuntimesOfBot(botId)
  const result = await releaseSeatsBestEffort(db, seats)
  for (const seat of result.released) await db.deleteSeatRuntimeOf(seat.accountId, seat.botId)
  for (const f of result.failed) await db.orphanSeatRuntime(f.seat.accountId, f.seat.botId, f.error)
  await db.deleteBot(botId)
  return result
}

/** 问管家还活着吗。配对回拨和界面上的「检查连通」都走它。 */
export async function managerHealth(
  host: string,
  opts: { token?: string; challenge?: string; timeoutMs?: number },
): Promise<{ ok: boolean; body?: Record<string, unknown>; error?: string }> {
  const base = host.replace(/\/$/, '')
  const q = opts.challenge ? `?challenge=${encodeURIComponent(opts.challenge)}` : ''
  try {
    const res = await fetch(`${base}/health${q}`, {
      headers: opts.token ? { authorization: 'Bearer ' + opts.token } : {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    })
    if (!res.ok) return { ok: false, error: `管家返回 ${res.status}` }
    return { ok: true, body: (await res.json()) as Record<string, unknown> }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 太长就砍头，不砍尾。
 *
 * 这些消息里装的是脚本输出：进度在前，原因在后。从头截等于把唯一有用的那一段扔掉。
 */
function tailOf(text: string, max: number): string {
  const s = (text || '').replace(/\s+/g, ' ').trim()
  return s.length <= max ? s : '…' + s.slice(-max)
}

export function sanitizeError(e: unknown, secrets: string[] = []): string {
  const raw = e instanceof Error ? e.message : String(e)
  return tailOf(stripSecrets(raw, secrets), 900) || '部署失败'
}
function stripSecrets(text: string, secrets: string | string[] = []): string {
  let s = text
  const list = typeof secrets === 'string' ? (secrets ? [secrets] : []) : secrets
  for (const secret of list) {
    if (secret) s = s.split(secret).join('***')
  }
  s = s.replace(/SSHPASS=\S+/g, 'SSHPASS=***')
  s = s.replace(/gatewayToken[=:]\S+/gi, 'gatewayToken=***')
  s = s.replace(/gatewayApiKey[=:]\S+/gi, 'gatewayApiKey=***')
  s = s.replace(/machineToken[=:]\S+/gi, 'machineToken=***')
  s = s.replace(/vncPassword[=:]\S+/gi, 'vncPassword=***')
  s = s.replace(/\bsat_[A-Za-z0-9_-]+/g, 'sat_***')
  s = s.replace(/\bsk_sw_[A-Za-z0-9_-]+/g, 'sk_sw_***')
  s = s.replace(/\bsmt_[A-Za-z0-9_-]+/g, 'smt_***')
  return s
}
