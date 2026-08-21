import { cpus, freemem, loadavg, totalmem, uptime } from 'node:os'
import { readFileSync, statfsSync } from 'node:fs'

/**
 * 机器的负载快照：CPU、内存、各块盘、出网流量。
 *
 * **为什么要有它**：没有 SSH（那正是管家取代 SSH 的意义），「这台机器还剩多少余量」
 * 谁也看不见。diag.ts 答的是某个席位的现场，logs.ts 答的是它卡在哪一步，两者都答不了
 * 「机器本身是不是要撑不住了」——而这一层的故障恰恰是**先慢、后崩**：盘写满之后
 * bot 起不来、桌面黑屏、journal 也写不进去，等到有人发现时连日志都没有。
 *
 * 采样是**自己定时做的**，不是收到请求才现算：
 *
 * - CPU 占用只有「两次之间的差」才有意义。请求进来才采样的话，第一次永远给不出数，
 *   或者只能给一个开机以来的平均值——那个数在一台跑了三个月的机器上永远是 3%。
 * - 出网流量同理：`/proc/net/dev` 给的是开机以来的累计字节，速率要靠两次相减。
 *
 * 所以这里维护一份**最近一次快照**，心跳和 `/metrics` 都只是把它读走。
 *
 * 数字都是**尽力而为**：拿不到的那一项报 null，绝不编一个出来——「取不到」和
 * 「是 0」在这一页上是完全不同的两件事（一块读不出来的盘 vs 一块空盘）。
 */

export interface DiskUsage {
  /** 挂载点。`/`、`/home`、`/var/log`… */
  mount: string
  total: number
  used: number
  /** 普通用户可用的那部分（`df` 的 Avail），不含预留给 root 的 5%。 */
  free: number
  /** 0–1。按 `df` 的口径算：used / (used + avail)，所以和 `df -h` 的百分比对得上。 */
  usage: number
}

export interface MachineMetrics {
  /** 采样时刻（机器本地时钟）。**Gateway 不采信它**，那边按收到的时刻记。 */
  at: number
  /** 开机多久了，秒。心跳里看到它变小 = 机器重启过。 */
  uptime: number
  cpu: {
    cores: number
    /** 0–1，**两次采样之间**的占用。第一次采样时是 null，不是 0。 */
    usage: number | null
    load1: number
  }
  memory: {
    total: number
    /** 已用 = total − 可用。Linux 上「可用」取 MemAvailable（含可回收的缓存），
     *  不是 MemFree——按 MemFree 算的话，任何一台正常跑着的 Linux 都显示 95% 已用。 */
    used: number
    usage: number
    swapTotal: number
    swapUsed: number
  }
  disks: DiskUsage[]
  net: {
    /** 开机以来的累计出网字节。跨重启会归零，所以速率那一格才是主角。 */
    txBytes: number
    rxBytes: number
    /** 字节每秒，两次采样之间的均值。第一次采样、或者计数器回绕时是 null。 */
    txRate: number | null
    rxRate: number | null
    /** 参与统计的网卡。回环、docker、veth 这些不算——它们不是「出网」。 */
    interfaces: string[]
  }
}

/** CPU 时间的上一次读数。usage 是两次之差，第一次只能存下来等下一轮。 */
let prevCpu: { idle: number; total: number } | undefined
/** 网卡计数器的上一次读数，连同读它的时刻。 */
let prevNet: { tx: number; rx: number; at: number } | undefined

let latest: MachineMetrics | undefined

/** 最近一次快照。还没采过就是 undefined——**不现算**，理由见文件头。 */
export const metrics = (): MachineMetrics | undefined => latest

/**
 * CPU 占用。
 *
 * 用 `os.cpus()` 的累计时间而不是 `/proc/stat`：两者同源（Node 在 Linux 上就是去读
 * 它），但 `os.cpus()` 在开发机上也有值，于是 e2e 能在 mac 上验到真数字，而不是一路
 * null 把这条路测成空壳。
 */
function sampleCpu(): { cores: number; usage: number | null; load1: number } {
  const list = cpus() || []
  let idle = 0
  let total = 0
  for (const c of list) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  const prev = prevCpu
  prevCpu = { idle, total }
  const dTotal = total - (prev?.total ?? 0)
  const dIdle = idle - (prev?.idle ?? 0)
  // 没有上一次、时间没往前走（同一毫秒采两次）、或者计数器倒退（换了 CPU 拓扑）
  // 都给 null：这三种情况下算出来的都是假数。
  const usage = !prev || dTotal <= 0 || dIdle < 0 ? null : Math.min(1, Math.max(0, 1 - dIdle / dTotal))
  return { cores: list.length || 1, usage, load1: Number(loadavg()[0]?.toFixed(2)) || 0 }
}

/** `/proc/meminfo` 的一行，单位 kB → 字节。取不到给 undefined，不给 0。 */
function meminfo(): Map<string, number> | undefined {
  try {
    const map = new Map<string, number>()
    for (const line of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const m = /^(\w+):\s+(\d+)\s*kB$/.exec(line.trim())
      if (m) map.set(m[1], Number(m[2]) * 1024)
    }
    return map.size ? map : undefined
  } catch {
    return undefined
  }
}

function sampleMemory(): MachineMetrics['memory'] {
  const info = meminfo()
  const total = info?.get('MemTotal') ?? totalmem()
  // MemAvailable 是内核自己算的「不换出就能拿到多少」，它把可回收的页缓存算进去了。
  // 退回 MemFree（os.freemem）只是兜底：那个数在任何一台正常的 Linux 上都吓人。
  const available = info?.get('MemAvailable') ?? freemem()
  const used = Math.max(0, total - available)
  const swapTotal = info?.get('SwapTotal') ?? 0
  const swapUsed = Math.max(0, swapTotal - (info?.get('SwapFree') ?? swapTotal))
  return { total, used, usage: total > 0 ? Math.min(1, used / total) : 0, swapTotal, swapUsed }
}

/**
 * 要报哪几块盘。
 *
 * 从 `/proc/mounts` 里挑**真的块设备**（`/dev/…`），并**按设备去重**：`/` 和
 * `/home` 常常是同一块盘，报两遍会让人以为机器上有两块 80% 的盘。tmpfs、overlay、
 * bind mount 一律不要——它们占的不是这台机器的硬盘。
 *
 * 读不到 `/proc/mounts`（开发机）就只报 `/`，那至少是真的。
 */
function mountPoints(): string[] {
  try {
    const seen = new Set<string>()
    const out: string[] = []
    for (const line of readFileSync('/proc/mounts', 'utf8').split('\n')) {
      const [dev, rawMount] = line.split(/\s+/)
      if (!dev?.startsWith('/dev/') || !rawMount) continue
      if (seen.has(dev)) continue
      seen.add(dev)
      // 挂载点里的空格等字符在 /proc/mounts 里是八进制转义的，解回来才 statfs 得到。
      const mount = rawMount.replace(/\\(\d{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)))
      out.push(mount)
      if (out.length >= 8) break
    }
    return out.length ? out : ['/']
  } catch {
    return ['/']
  }
}

function sampleDisks(): DiskUsage[] {
  const rows: DiskUsage[] = []
  for (const mount of mountPoints()) {
    try {
      const st = statfsSync(mount)
      const bsize = Number(st.bsize) || 0
      const total = Number(st.blocks) * bsize
      const free = Number(st.bavail) * bsize
      const used = (Number(st.blocks) - Number(st.bfree)) * bsize
      if (!(total > 0)) continue
      rows.push({
        mount,
        total,
        used,
        free,
        // df 的口径：分母是 used + avail，不是 total。root 预留的那 5% 不算在里头，
        // 所以这个百分比和人在机器上 `df -h` 看到的是同一个数。
        usage: used + free > 0 ? Math.min(1, used / (used + free)) : 0,
      })
    } catch {
      /* 某个挂载点读不了（权限、正在卸载）不该带垮整份快照。 */
    }
  }
  return rows
}

/** 这块网卡算不算「出网」。回环和各种虚拟网桥不算——它们的流量不出这台机器。 */
function realInterface(name: string): boolean {
  return !/^(lo|docker|veth|br-|virbr|vmnet|tun|tap|wg|kube|cni|flannel|dummy)/.test(name)
}

function sampleNet(at: number): MachineMetrics['net'] {
  let tx = 0
  let rx = 0
  const names: string[] = []
  try {
    for (const line of readFileSync('/proc/net/dev', 'utf8').split('\n')) {
      const m = /^\s*([^:\s]+):\s*(.+)$/.exec(line)
      if (!m) continue
      const name = m[1]
      if (!realInterface(name)) continue
      const cols = m[2].trim().split(/\s+/).map(Number)
      // 列序见 /proc/net/dev 的表头：接收 8 列（第 1 列是字节），随后发送 8 列。
      if (cols.length < 9 || !Number.isFinite(cols[0]) || !Number.isFinite(cols[8])) continue
      rx += cols[0]
      tx += cols[8]
      names.push(name)
    }
  } catch {
    /* 不是 Linux，或者被容器挡住了：下面按「没有计数器」处理。 */
  }
  const prev = prevNet
  prevNet = names.length ? { tx, rx, at } : undefined
  if (!names.length) return { txBytes: 0, rxBytes: 0, txRate: null, rxRate: null, interfaces: [] }
  const dt = prev ? (at - prev.at) / 1000 : 0
  // 计数器倒退 = 机器重启或者网卡被重建了，这一轮没有可用的速率，等下一轮。
  const rate = (now: number, before: number) => (prev && dt > 0 && now >= before ? Math.round((now - before) / dt) : null)
  return {
    txBytes: tx,
    rxBytes: rx,
    txRate: prev ? rate(tx, prev.tx) : null,
    rxRate: prev ? rate(rx, prev.rx) : null,
    interfaces: names.slice(0, 8),
  }
}

/** 采一次，存成「最近一次」。定时器和启动时各调一次，别处只读 `metrics()`。 */
export function sampleMetrics(): MachineMetrics {
  const at = Date.now()
  latest = {
    at,
    uptime: Math.round(uptime()),
    cpu: sampleCpu(),
    memory: sampleMemory(),
    disks: sampleDisks(),
    net: sampleNet(at),
  }
  return latest
}

/**
 * 采样间隔。和心跳同频（30 秒）——心跳带走的就是这一份，采得更密只会让 CPU 那格
 * 是「最近 5 秒」而不是「最近 30 秒」，尖峰反而更容易被平均掉之后还错过。
 */
export const SAMPLE_MS = 30_000

/**
 * 起采样器。
 *
 * **先采一次再定时**：第一次采样只是为 CPU 和网卡存下基准（那两项要差值），所以
 * 紧接着补第二次——不然管家刚起来的头 30 秒里，心跳上报的 CPU 一直是 null，而那
 * 恰恰是人盯着看的时候（刚部署完、刚重启完）。
 */
export function startMetrics(): NodeJS.Timeout {
  sampleMetrics()
  setTimeout(() => sampleMetrics(), 1000).unref()
  const timer = setInterval(() => sampleMetrics(), SAMPLE_MS)
  timer.unref()
  return timer
}
