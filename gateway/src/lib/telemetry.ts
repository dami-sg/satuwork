/**
 * 机器心跳里那两份自报数据的收口：负载（CPU / 内存 / 盘 / 出网）与日志占用。
 *
 * **这是网络边界，不是内部函数调用。** 这份 JSON 由席位机器上的管家发上来，会原样
 * 存进 jsonb、再原样发给浏览器画界面。所以每一项都按形状收：
 *
 * - 数字必须**有限且非负**。`NaN` / `Infinity` 进了 jsonb 会让 JSON.stringify 变成
 *   `null`（安静地），百分比字段里的负数会画出一根倒着长的条。
 * - 百分比一律夹到 0–1。管家算错、或者两个版本口径不一致时，界面上顶多是个满格，
 *   不会是「占用 340%」这种谁也不信的数。
 * - 数组有长度上限，字符串有长度上限并且**去掉控制字符**：挂载点和文件路径是机器上
 *   的字符串，一个换行就能在日志里伪造出一行。
 *
 * 收不下来的那一项返回 `null`（= 这台机器没报），**不是**用 0 顶上——「没报」和
 * 「是 0」在界面上是完全不同的两件事：前者要人去看机器还在不在，后者是一台空闲机器。
 */

export interface DiskUsage {
  mount: string
  total: number
  used: number
  free: number
  usage: number
}

export interface MachineMetrics {
  uptime: number
  cpu: { cores: number; usage: number | null; load1: number }
  memory: { total: number; used: number; usage: number; swapTotal: number; swapUsed: number }
  disks: DiskUsage[]
  net: { txBytes: number; rxBytes: number; txRate: number | null; rxRate: number | null; interfaces: string[] }
}

export interface LogUsage {
  journalBytes: number
  varLogBytes: number
  capMb: number
  capSource: 'env' | 'gateway' | 'default'
  top: { path: string; size: number }[]
  lastVacuum: { at: number; before: number; after: number; freed: number; keepMb: number; error: string } | null
}

/** 一台机器的全部自报数据。两份一起存一格，它们同一时刻来、同一时刻过期。 */
export interface MachineTelemetry {
  metrics: MachineMetrics | null
  logs: LogUsage | null
}

/** 日志上限的合法区间，MB。和管家那边同一套（见 manager/src/logdisk.ts）。 */
export const MAX_LOG_CAP_MB = 1024 * 1024

/**
 * 等管家清完一次 journal 最多等多久。
 *
 * 管家自己给 `journalctl --rotate` 和 `--vacuum-size` 的预算是 60 + 120 秒，加上前后
 * 两次量盘——这里取 240 秒，比它多一点余量。**比那个数小就是在制造假失败**：连接被
 * Gateway 掐断时机器上的清理照跑不误，界面却报「实例还没上线」。
 */
export const MANAGER_VACUUM_TIMEOUT_MS = 240_000

const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null

/** 非负有限数，越界给 0。`max` 挡的是「一块 9 EB 的盘」这种明显不是真事的值。 */
function n(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const x = Number(v)
  return Number.isFinite(x) && x >= 0 ? Math.min(x, max) : 0
}

/** 允许「没有」的数（CPU 首次采样、计数器回绕时的速率）。**null 要留住**。 */
function nOrNull(v: unknown): number | null {
  if (v == null) return null
  const x = Number(v)
  return Number.isFinite(x) && x >= 0 ? x : null
}

/** 0–1。夹紧而不是拒收：一个越界的百分比不该让整份快照作废。 */
function ratio(v: unknown): number {
  const x = Number(v)
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
}

/** 机器上来的字符串：截断 + 去控制字符。它最终会被画进 HTML。 */
function text(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .slice(0, max)
}

export function normalizeMetrics(raw: unknown): MachineMetrics | null {
  const m = obj(raw)
  if (!m) return null
  const cpu = obj(m.cpu) ?? {}
  const mem = obj(m.memory) ?? {}
  const net = obj(m.net) ?? {}
  const disks = Array.isArray(m.disks) ? m.disks : []
  return {
    uptime: n(m.uptime),
    cpu: {
      // 核数是个位数到三位数的量级；一台报出 10 万核的机器是在报错，不是在报数。
      cores: Math.min(4096, Math.round(n(cpu.cores))),
      usage: cpu.usage == null ? null : ratio(cpu.usage),
      load1: n(cpu.load1, 100_000),
    },
    memory: {
      total: n(mem.total),
      used: n(mem.used),
      usage: ratio(mem.usage),
      swapTotal: n(mem.swapTotal),
      swapUsed: n(mem.swapUsed),
    },
    // 12 块盘够任何一台席位机器了。多出来的不是盘，是管家那边的筛选出了问题。
    disks: disks.slice(0, 12).map((d) => {
      const row = obj(d) ?? {}
      return {
        mount: text(row.mount, 64),
        total: n(row.total),
        used: n(row.used),
        free: n(row.free),
        usage: ratio(row.usage),
      }
    }),
    net: {
      txBytes: n(net.txBytes),
      rxBytes: n(net.rxBytes),
      txRate: nOrNull(net.txRate),
      rxRate: nOrNull(net.rxRate),
      interfaces: (Array.isArray(net.interfaces) ? net.interfaces : []).slice(0, 8).map((x) => text(x, 32)),
    },
  }
}

export function normalizeLogUsage(raw: unknown): LogUsage | null {
  const l = obj(raw)
  if (!l) return null
  const v = obj(l.lastVacuum)
  const source = l.capSource === 'env' || l.capSource === 'gateway' ? l.capSource : 'default'
  return {
    journalBytes: n(l.journalBytes),
    varLogBytes: n(l.varLogBytes),
    capMb: Math.min(MAX_LOG_CAP_MB, Math.round(n(l.capMb))),
    capSource: source,
    top: (Array.isArray(l.top) ? l.top : []).slice(0, 5).map((f) => {
      const row = obj(f) ?? {}
      return { path: text(row.path, 200), size: n(row.size) }
    }),
    lastVacuum: v
      ? {
          at: n(v.at),
          before: n(v.before),
          after: n(v.after),
          freed: n(v.freed),
          keepMb: Math.min(MAX_LOG_CAP_MB, Math.round(n(v.keepMb))),
          error: text(v.error, 300),
        }
      : null,
  }
}

/**
 * 心跳里的两份自报数据 → 一格 telemetry。`prev` 是库里现存的那一份。
 *
 * 两份**都没有**（老管家）时返回 undefined，调用方据此**整格不动**——写一份两边都
 * 是 null 的 telemetry 进去，会把上一轮好好的数据抹成空白，界面上看起来就是「这台
 * 机器突然什么都不报了」。
 *
 * **只报了一半时，另一半沿用上一轮**，同一个道理，只是更容易撞上：管家重启之后，
 * 负载是同步采的（立刻就有），而日志占用要异步走一遍目录树才出得来。中间那几百毫
 * 秒里正好打了一轮心跳的话，`logs` 就是空的——照直存下去，机器每重启一次，界面上
 * 的日志占用就空一次，而它其实一直好好的。
 */
export function telemetryOf(body: Record<string, unknown>, prev?: MachineTelemetry | null): MachineTelemetry | undefined {
  const metrics = normalizeMetrics(body.metrics)
  const logs = normalizeLogUsage(body.logs)
  if (!metrics && !logs) return undefined
  return { metrics: metrics ?? prev?.metrics ?? null, logs: logs ?? prev?.logs ?? null }
}
