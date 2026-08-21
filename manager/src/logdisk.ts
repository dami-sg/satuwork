import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { bootConfig } from './config.ts'
import { run } from './run.ts'

/**
 * 日志占了多少盘，以及大到该清的时候把它清掉。
 *
 * **这台机器上的日志只有一个去处：journald。** bot、桌面、管家三个 systemd 单元都
 * 不写日志文件（见 satuwork-bot@.service / slim-desktop@.service），全靠 `journalctl`
 * 读——`/seats/:id/logs` 和 `/logs` 两条路取的也是它。所以「日志把盘吃满了」这件事
 * 在这台机器上等价于「journal 太大了」，清理也就只有一个动作：`journalctl --vacuum-size`。
 *
 * 为什么非清不可：一个话多的 bot 一天能写几百兆，而 journald 的默认上限是**盘的
 * 10%**——一块 40G 的盘上就是 4G，装完系统和桌面栈之后剩不了多少。盘写满的表现不是
 * 一句报错，而是 bot 起不来、桌面黑屏，**而且那时连日志都写不进去**，事后连查都没得查。
 *
 * **只动 journal，不碰 `/var/log` 下别的文件。** 那些归 logrotate 管，是这台 Debian
 * 上别的软件的东西；管家伸手进去删，等于和系统自己的轮转策略打架。所以别的文件只
 * **报**大小（大得离谱时人看得见），删不删由人决定。
 *
 * 上限从哪来（优先级从高到低）：
 *
 * 1. `SATUWORK_LOG_CAP_MB` —— 机器上的本地钉子，出事时不必等 Gateway 就能改
 * 2. Gateway 心跳下发的期望值 —— 和时区、管家版本同一条路：**心跳驱动、最终收敛**
 * 3. 默认 1024 MB
 *
 * `0` = 只测量不清理。**空着不等于 0**：空是「没人指定过」，走默认；0 是「明确不要
 * 管家动我的 journal」。
 */

export interface VacuumResult {
  at: number
  /** 清之前 / 之后的 journal 占用。差值就是腾出来的。 */
  before: number
  after: number
  freed: number
  /** 清到多大（MB）。 */
  keepMb: number
  /** 空 = 成功。失败时是一句能看懂的话，会跟着心跳上报。 */
  error: string
}

export interface LogUsage {
  at: number
  /** journald 占的字节：`/var/log/journal` + `/run/log/journal`（易失日志）。 */
  journalBytes: number
  /** 整个 `/var/log`，含 journal。两个数一起看才知道大头在不在 journal 上。 */
  varLogBytes: number
  /** 当前生效的上限，MB。0 = 只报不清。 */
  capMb: number
  /** 上限从哪儿来的：本机钉的 / Gateway 下发的 / 默认。界面上要说得出。 */
  capSource: 'env' | 'gateway' | 'default'
  /** `/var/log` 底下最大的几个**非 journal** 文件。只报，不删。 */
  top: { path: string; size: number }[]
  lastVacuum: VacuumResult | null
}

const DEFAULT_CAP_MB = 1024
/** 上限的合法区间。上界只是防呆——写一个 EB 进来不是配置，是打错字。 */
const MAX_CAP_MB = 1024 * 1024

/** Gateway 下发的期望上限。null = 它没说过，走默认。 */
let desiredCapMb: number | null = null
let lastVacuum: VacuumResult | null = null
let usage: LogUsage | undefined
/** 正在跑的那一轮清理。同一时刻只跑一轮，见 vacuum()。 */
let running: Promise<VacuumResult> | null = null

function envCapMb(): number | null {
  const raw = (process.env.SATUWORK_LOG_CAP_MB || '').trim()
  if (!raw) return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= 0 && n <= MAX_CAP_MB ? n : null
}

function capOf(): { capMb: number; capSource: LogUsage['capSource'] } {
  const env = envCapMb()
  if (env != null) return { capMb: env, capSource: 'env' }
  if (desiredCapMb != null) return { capMb: desiredCapMb, capSource: 'gateway' }
  return { capMb: DEFAULT_CAP_MB, capSource: 'default' }
}

/**
 * 收下 Gateway 心跳响应里的期望上限。返回「这一轮变了没有」。
 *
 * **收的是整个响应，不是那个值**——因为「没带这一格」和「带了个 null」是两件事，
 * 而分不开的话必然有一头是错的：
 *
 * - 老 Gateway 根本不带 `logCapMb`。当成「不指定」的话，一台本来钉着 500M 的机器
 *   会在 Gateway 回滚版本之后悄悄回到 1G。
 * - 新 Gateway 上有人把上限清空了，带下来的就是 null。当成「没带」的话，那个数
 *   一直留到管家重启为止——界面上写着「跟默认走」，机器上还钉着旧值。
 */
export function setDesiredCapMb(reply: Record<string, unknown>): boolean {
  if (!('logCapMb' in reply)) return false
  const raw = reply.logCapMb
  const next = raw == null ? null : Number(raw)
  if (next != null && (!Number.isInteger(next) || next < 0 || next > MAX_CAP_MB)) return false
  if (desiredCapMb === next) return false
  desiredCapMb = next
  return true
}

/**
 * 一棵目录有多大。
 *
 * 自己走一遍而不是 `du -sh`：`du` 的输出要按区域设置解析（人类可读单位、千分位），
 * 而且 journal 目录下几百个文件，起一个子进程比读一遍目录贵。
 *
 * **必须是异步的。** 管家这个进程同时是席位 bot 和 noVNC 的反代——同步走目录树会把
 * 事件循环整个占住，那几百毫秒里这台机器上所有人的聊天流和桌面画面一起卡住。而最可
 * 能卡久的，恰恰是 `/var/log` 底下堆了几万个轮转文件的那台机器，也就是最需要有人盯
 * 着看的那台。
 *
 * 每一层目录内的 stat 一起发（`Promise.all`），层与层之间串着走：既不至于一个文件一
 * 个来回，也不会一口气开出几万个句柄。
 *
 * **不跟符号链接**，并且有条数上限——上限之外的字节数不再计入，量准没有意义，量到
 * 把管家拖住反而有害。
 */
async function treeSize(root: string, limit = 20_000): Promise<{ bytes: number; files: { path: string; size: number }[] }> {
  let bytes = 0
  let seen = 0
  const files: { path: string; size: number }[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 6 || seen >= limit) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    const here = entries.filter((e) => e.isFile() && !e.isSymbolicLink()).slice(0, Math.max(0, limit - seen))
    seen += here.length
    const sized = await Promise.all(
      here.map(async (e) => {
        const path = join(dir, e.name)
        try {
          return { path, size: (await stat(path)).size }
        } catch {
          // 正在被轮转掉的文件会在这一步消失，跳过就是了。
          return null
        }
      }),
    )
    for (const f of sized) {
      if (!f) continue
      bytes += f.size
      files.push(f)
    }
    for (const e of entries) {
      if (seen >= limit) return
      if (!e.isDirectory() || e.isSymbolicLink()) continue
      await walk(join(dir, e.name), depth + 1)
    }
  }
  await walk(root, 0)
  return { bytes, files }
}

const JOURNAL_DIRS = ['/var/log/journal', '/run/log/journal']

/** 量一遍。**不清理**，清理是 vacuum 的事——两者分开，才能先看再动手。 */
export async function measureLogs(): Promise<LogUsage> {
  const { capMb, capSource } = capOf()
  let journalBytes = 0
  for (const dir of JOURNAL_DIRS) journalBytes += (await treeSize(dir)).bytes
  const varLog = await treeSize('/var/log')
  const top = varLog.files
    .filter((f) => !f.path.startsWith('/var/log/journal/'))
    .sort((a, b) => b.size - a.size)
    .slice(0, 5)
  usage = {
    at: Date.now(),
    journalBytes,
    varLogBytes: varLog.bytes,
    capMb,
    capSource,
    top,
    lastVacuum,
  }
  return usage
}

/** 最近一次量出来的结果。心跳读它，不现量——量一遍要走几千个文件。 */
export const logUsage = (): LogUsage | undefined => usage

/**
 * 清到多大。**不是清到上限本身**，是清到上限的六成。
 *
 * 清到上限的话，下一条日志写进去就又超了，于是每半小时清一次、每次只腾出几兆——
 * 而清理会把最老的那截日志永久删掉。留出四成余量，才能让两次清理之间隔着一段真正
 * 的写入时间，journal 里也就留得住足够长的历史。
 */
function keepFor(capMb: number): number {
  return Math.max(64, Math.floor(capMb * 0.6))
}

/**
 * 清一次 journal。
 *
 * **同一时刻只跑一轮。** 已经有一轮在跑就搭它的车，返回同一个 promise：手动那条路
 * 会被人重复点（Gateway 侧超时、或者干脆手抖），自动那条也可能正好撞上来，而两个
 * `journalctl --rotate` 叠着跑只会更慢，还会把 `lastVacuum` 搅成前一轮的 before 配
 * 后一轮的 after。
 */
export function vacuum(keepMb: number): Promise<VacuumResult> {
  if (running) return running
  const p = runVacuum(keepMb).finally(() => {
    if (running === p) running = null
  })
  running = p
  return p
}

/**
 * **先 rotate 再 vacuum**：vacuum 只删得掉已归档的日志文件，而当前正在写的那个
 * （通常也是最大的那个）不归档就一直留着。少了 rotate 那一步，一台刚写满的机器上
 * 「清理成功、一个字节没少」，比报错还难查。
 */
async function runVacuum(keepMb: number): Promise<VacuumResult> {
  // 16 MB 的下限：`--vacuum-size=0M` 会把**正在写的**那个也算进去删，机器于是连
  // 「刚才为什么清空了」这句都留不下来。要真清空得上机器手动做，不从这条路走。
  const keep = Math.max(16, Math.min(MAX_CAP_MB, Math.floor(keepMb) || 0))
  const before = (await measureLogs()).journalBytes
  const at = Date.now()

  if (bootConfig().dryRun) {
    // 开发机上没有 journalctl，也不该去动它的 /var/log。给一份形状完整的结果，
    // 让整条路（接口、上报、界面）在 e2e 里走得通。
    lastVacuum = { at, before, after: before, freed: 0, keepMb: keep, error: '' }
    return remember(lastVacuum)
  }

  const rotate = await run('journalctl', ['--rotate'], { timeout: 60_000 })
  const r = await run('journalctl', [`--vacuum-size=${keep}M`], { timeout: 120_000 })
  const after = (await measureLogs()).journalBytes
  const error =
    r.code === 0
      ? rotate.code === 0
        ? ''
        : // rotate 失败不算整件事失败：vacuum 照样能清掉已归档的部分，只是清得少。
          `journalctl --rotate 没成功（${(rotate.stderr || rotate.stdout).replace(/\s+/g, ' ').trim().slice(-160)}），只清掉了已归档的部分`
      : `journalctl --vacuum-size=${keep}M failed: ${(r.stderr || r.stdout).replace(/\s+/g, ' ').trim().slice(-200)}`
  lastVacuum = { at, before, after, freed: Math.max(0, before - after), keepMb: keep, error }
  if (error) console.error('satuwork-manager: ' + error)
  else console.log(`satuwork-manager: journal ${fmt(before)} -> ${fmt(after)}（清到 ${keep}M）`)
  return remember(lastVacuum)
}

/**
 * 把这一次的结果贴进最近一份快照里。
 *
 * **不再量一遍**：上面那次 `measureLogs()` 已经是清完之后的字节数了，差的只是这份
 * 快照里的 `lastVacuum` 那一格。为它再走一遍 `/var/log` 是白花一趟目录树。
 */
function remember(result: VacuumResult): VacuumResult {
  if (usage) usage = { ...usage, lastVacuum: result }
  return result
}

function fmt(bytes: number): string {
  return bytes >= 1024 ** 3 ? (bytes / 1024 ** 3).toFixed(1) + 'G' : Math.round(bytes / 1024 ** 2) + 'M'
}

/** 两次自动清理之间至少隔这么久。量错了也不至于变成一个删日志的死循环。 */
const VACUUM_COOLDOWN_MS = 10 * 60_000

/** 定时检查的间隔。日志是**慢变量**，30 分钟一次足够，而每次都要走一遍目录树。 */
export const CHECK_MS = 30 * 60_000

/**
 * 量一遍，超了就清。
 *
 * 返回这一轮有没有真动手，给日志和 e2e 看。
 */
export async function checkLogs(): Promise<{ usage: LogUsage; vacuumed: boolean }> {
  const now = await measureLogs()
  const overCap = now.capMb > 0 && now.journalBytes > now.capMb * 1024 * 1024
  const cooling = lastVacuum != null && Date.now() - lastVacuum.at < VACUUM_COOLDOWN_MS
  if (!overCap || cooling) return { usage: now, vacuumed: false }
  console.log(`satuwork-manager: journal ${fmt(now.journalBytes)} 超过上限 ${now.capMb}M，开始清理`)
  await vacuum(keepFor(now.capMb))
  return { usage: logUsage() ?? now, vacuumed: true }
}

/**
 * 手动清理时的默认目标：和自动那次同一个算法，免得两条路清出两种结果。
 *
 * 上限是 0（「别自动清这台机器」）时按**默认上限**算，不是按 0 算——按 0 算会得到
 * 那条 64 MB 的下限，于是人点一下「立刻清理」就把 journal 削到几乎不剩。关掉自动
 * 清理的人要的是「别自己动手」，不是「动手时往死里删」。
 */
export const defaultKeepMb = (): number => keepFor(capOf().capMb || DEFAULT_CAP_MB)

/**
 * 起日志看守。
 *
 * 启动时先量一次（心跳第一轮就有数可报），之后按 CHECK_MS 走。**启动那次不清**：
 * 管家刚起来（多半是刚换过版）就删日志，会把「上一版为什么起不来」的证据一起删掉。
 */
export function startLogWatch(): NodeJS.Timeout {
  // 不 await：量一遍是异步的，没必要把启动挡在它前面。头一两轮心跳可能还没有这一格
  // ——Gateway 那边只报了一半时会沿用上一轮（见 telemetryOf），不会把界面刷成空白。
  void measureLogs()
  const timer = setInterval(() => void checkLogs(), CHECK_MS)
  timer.unref()
  return timer
}
