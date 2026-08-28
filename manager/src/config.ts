import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 管家的落盘状态。
 *
 * 两份东西分开放，因为寿命不一样：
 *
 * - `/etc/satuwork/manager.env`  安装脚本写的**启动参数**（Gateway 地址、配对码、监听口）。
 *   配对成功后安装脚本会把配对码从里面抹掉。
 * - `/etc/satuwork/manager.json` 配对**结果**（machineId、smt_ 票、Gateway 的公钥）。
 *   0600，只有 root 读得到。这是机器的身份，丢了就得重新配对。
 *
 * 目录可以用 `SATUWORK_MANAGER_HOME` 整体挪走——e2e 靠它在 /tmp 里跑，不碰 /etc。
 */

/**
 * 管家协议版本。**加了 Gateway 那侧要依赖的能力就 +1。**
 *
 * 2：`/seats/:id/vnc/*` 认机器票，桌面因此能从 Gateway 同域反代出去。1 号管家在这
 * 条路上只认票和 cookie，而反代过来的请求两样都没有——表现是浏览器上一句
 * 「桌面票无效或已过期」，跟票真的过期长得一模一样。Gateway 拿这个号数把两者分开。
 *
 * 3：`/seats/:id/progress` 报「这次部署走到第几步了」。号数在这里只用来**省一次
 * 白问**：老管家没有这条路，Gateway 照它决定要不要发那个请求，界面上退回到只有
 * 「已经装了几分钟」的粗进度（见 gateway 的 MIN_PROGRESS_PROTOCOL）。
 */
export const PROTOCOL = 3

export interface ManagerState {
  machineId: string
  /** 该机器的 `smt_`。调 Gateway 用它，也是 Gateway 调管家时要出示的那一把。 */
  token: string
  gatewayUrl: string
  pairedAt: number
  /** Gateway 的 JWKS，验桌面 ticket 用。配对时抓一次，kid 对不上时再抓。 */
  jwks: { keys: Record<string, unknown>[] } | null
  /** 自升级成功并且**心跳通过一次**之后才写。confirm timer 靠它判断要不要回滚。 */
  confirmedVersion: string
  /**
   * 上一次换版换到了哪个版本号。
   *
   * 用来熔断死循环：如果换完重启回来，自报版本仍然不是它，说明**包里的 VERSION 和
   * Gateway 上登记的版本号对不上**——再试一万次也一样，而每次尝试都要重启一次进程、
   * 掐断一次聊天。记下来，认出这种情况就停手并把原因报上去。
   */
  lastUpgradeTo: string
  /**
   * 上一次换版是什么时候（epoch 毫秒）。
   *
   * 回滚脚本靠它分辨「新版本连不上 Gateway」和「新版本还没来得及起来」。少了它，
   * 那个每 120 秒敲一次的定时器会把撞进升级窗口的一次好升级判成失败——见
   * src/seat/manager-confirm.sh 里的宽限期那一段。
   */
  lastUpgradeAt: number
}

export function managerHome(...segments: string[]): string {
  const root = process.env.SATUWORK_MANAGER_HOME
    ? resolve(process.env.SATUWORK_MANAGER_HOME)
    : '/etc/satuwork'
  return segments.length ? join(root, ...segments) : root
}

export const statePath = () => managerHome('manager.json')

/** 席位名册。反代要靠它把 seatId 翻成端口，重启之后不能丢，所以落盘不放内存。 */
export const seatsPath = () => managerHome('seats.json')

/** 管家自己的安装根。`current` 符号链接指向当前版本，自升级换的就是它。 */
export function installRoot(): string {
  return resolve(process.env.SATUWORK_MANAGER_ROOT || '/opt/satuwork/manager')
}

/** 发布包缓存。bot 的 tgz 按版本解在这儿，全机共享——同一版本第二个席位不再重解。 */
export function releaseRoot(): string {
  return resolve(process.env.SATUWORK_RELEASE_ROOT || '/opt/satuwork/releases')
}

/** 本包里的 seat 资源目录（两个 .service 模板、两个启动脚本、两个部署脚本）。 */
export function seatAssets(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'seat')
}

/** 包自带的 VERSION 文件（pack.mjs 写的）。开发树里没有，回落到 dev。 */
export function managerVersion(): string {
  const root = dirname(dirname(fileURLToPath(import.meta.url)))
  try {
    return readFileSync(join(root, 'VERSION'), 'utf8').trim() || 'dev'
  } catch {
    return 'dev'
  }
}

export function readState(): ManagerState | undefined {
  const path = statePath()
  if (!existsSync(path)) return
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<ManagerState>
    if (!raw.machineId || !raw.token || !raw.gatewayUrl) return
    return {
      machineId: raw.machineId,
      token: raw.token,
      gatewayUrl: raw.gatewayUrl.replace(/\/$/, ''),
      pairedAt: Number(raw.pairedAt) || 0,
      jwks: raw.jwks ?? null,
      confirmedVersion: raw.confirmedVersion ?? '',
      lastUpgradeTo: raw.lastUpgradeTo ?? '',
      lastUpgradeAt: Number(raw.lastUpgradeAt) || 0,
    }
  } catch {
    return
  }
}

/** 先写临时文件再 rename：断电或并发都不会留下半个 JSON，而半个 JSON = 机器失联。 */
export function writeState(state: ManagerState): void {
  const path = statePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export interface BootConfig {
  gatewayUrl: string
  pairingCode: string
  host: string
  port: number
  /** 跳过 deploy-seat.sh 与 systemd，用内存里的假席位状态作答。e2e 用。 */
  dryRun: boolean
}

export function bootConfig(): BootConfig {
  return {
    gatewayUrl: (process.env.GATEWAY_URL || '').trim().replace(/\/$/, ''),
    pairingCode: (process.env.SATUWORK_PAIRING_CODE || '').trim(),
    // 默认听所有网卡：Gateway 在别的机器上，这一个口就是全部对外面。
    host: process.env.SATUWORK_MANAGER_HOST || '0.0.0.0',
    port: Number(process.env.SATUWORK_MANAGER_PORT || 8443),
    dryRun: process.env.SATUWORK_MANAGER_DRYRUN === '1',
  }
}
