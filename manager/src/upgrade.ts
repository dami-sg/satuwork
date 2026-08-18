import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installRoot, managerVersion, readState, writeState } from './config.ts'
import { run } from './run.ts'
import { busy } from './seats.ts'

/**
 * 自升级。
 *
 * 删掉 SSH 之后这是必做项：管家不能自己换版，就意味着每次更新都要有人跑到每台机器
 * 前面。心跳驱动而不是 Gateway 推送——推送要求推的那一刻机器在线且可达，心跳驱动
 * 只要机器最终上线就会收敛，灰度也只是改一个数字。
 *
 *   /opt/satuwork/manager/releases/<version>/
 *   /opt/satuwork/manager/current  -> releases/X   systemd ExecStart 指这里
 *   /opt/satuwork/manager/previous -> releases/W   回滚指回它
 *
 * 每一步失败都就地放弃、把原因报回心跳、**不动 current**。
 */

export interface UpgradeOffer {
  desiredManagerVersion?: string
  url?: string
  sha256?: string
  minNode?: number
}

let lastError = ''
let upgrading = false

export const upgradeError = () => lastError

function nodeMajor(): number {
  return Number((process.versions.node || '0').split('.')[0]) || 0
}

/** 先建临时链接再 rename：换版这一步必须是原子的，否则断电会留下一个指向空处的 current。 */
function relink(name: string, target: string): void {
  const root = installRoot()
  const tmp = join(root, `.${name}.tmp`)
  rmSync(tmp, { force: true })
  symlinkSync(target, tmp)
  renameSync(tmp, join(root, name))
}

function currentTarget(): string {
  try {
    return readlinkSync(join(installRoot(), 'current'))
  } catch {
    return ''
  }
}

export async function maybeUpgrade(offer: UpgradeOffer, token: string): Promise<void> {
  const want = (offer.desiredManagerVersion || '').trim()
  if (!want || want === managerVersion() || upgrading) return
  if (!/^[A-Za-z0-9._+-]{1,64}$/.test(want) || want.startsWith('.')) return
  // 部署跑到一半换版会重启进程，把建了一半的席位一起打断。等下一轮心跳。
  if (busy()) return

  // 熔断：上次已经换到过这个版本，重启回来自报的却还是别的——包里的 VERSION 和
  // Gateway 上登记的版本号对不上。再试也是一样的结果，而每试一次就重启一次、掐断
  // 一次聊天。停手，把原因报上去让人去修发布包。
  const state = readState()
  if (state?.lastUpgradeTo === want) {
    lastError = `已换到 ${want} 但进程自报 ${managerVersion()}：发布包里的 VERSION 和登记的版本号不一致，不再重试`
    return
  }

  // Node 太老就**不升**。升到起不来比不升坏得多——没有 SSH 可以救。
  if (offer.minNode && nodeMajor() < offer.minNode) {
    lastError = `needs Node ${offer.minNode}+, this box has ${process.versions.node}; re-run the installer`
    return
  }
  if (!offer.url) return

  upgrading = true
  try {
    const root = installRoot()
    const dir = join(root, 'releases', want)
    mkdirSync(join(root, 'releases'), { recursive: true })

    const res = await fetch(offer.url, {
      headers: { authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(300_000),
    })
    if (!res.ok) throw new Error(`downloading the manager package failed: ${res.status}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    if (offer.sha256) {
      const got = createHash('sha256').update(bytes).digest('hex')
      if (got !== offer.sha256) throw new Error('manager package checksum mismatch')
    }

    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const tgz = join(root, `.${want}.tgz`)
    writeFileSync(tgz, bytes)
    try {
      const untar = await run('tar', ['-xzf', tgz, '-C', dir], { timeout: 300_000 })
      if (untar.code !== 0) throw new Error('cannot untar the manager package')
    } finally {
      rmSync(tgz, { force: true })
    }

    const entry = join(dir, 'bin', 'satuwork-manager.mjs')
    if (!existsSync(entry)) throw new Error('manager package has no bin/satuwork-manager.mjs')

    // 自检：让新版本自己起一次、答一次 /health、退出。挡掉「包坏了 / 语法错 /
    // 依赖缺失」这一类——占换版事故的绝大多数。它证明不了「能连上 Gateway」，
    // 那一层由 confirm timer 兜。
    const self = await run(process.execPath, ['--import', 'tsx', entry, '--selftest'], {
      timeout: 60_000,
      // cwd 必须是新版本自己的目录：`--import tsx` 是裸说明符，Node 按工作目录解析，
      // 不按脚本位置。少了这一行，自检会以 ERR_MODULE_NOT_FOUND 失败，而真正的原因
      // 和包本身没关系——换版会被永远挡在这一步。
      cwd: dir,
      env: { SATUWORK_MANAGER_PORT: '0', SATUWORK_MANAGER_HOST: '127.0.0.1' },
    })
    if (self.code !== 0) throw new Error(`selftest of the new build failed: ${(self.stderr || self.stdout).slice(-200)}`)

    const prev = currentTarget()
    if (prev) relink('previous', prev)
    // 先记下「要换到哪个版本」再真的换：进程马上就要被重启，记晚了就丢了。
    if (state) writeState({ ...state, lastUpgradeTo: want })
    relink('current', dir)

    // 重启必须由**分离的**单元发起：管家的子进程去 systemctl restart 会连自己一起
    // 被杀（同一个 cgroup），命令根本发不出去。瞬态单元跳出去。
    await run('systemd-run', [
      '--on-active=2s',
      '--unit=satuwork-manager-restart',
      'systemctl',
      'restart',
      'satuwork-manager.service',
    ], { timeout: 15_000 })
    lastError = ''
    console.log(`satuwork-manager: swapped to ${want}, restarting in 2s`)
  } catch (e) {
    lastError = (e instanceof Error ? e.message : String(e)).slice(0, 300)
    console.error('satuwork-manager: upgrade failed: ' + lastError)
  } finally {
    upgrading = false
  }
}

/**
 * 心跳成功一次之后调它。confirm timer 靠这个标记判断新版本到底活没活过来——
 * 自检只能证明「能起来」，证明不了「能跟 Gateway 说上话」，而后者失败 = 机器失联。
 */
export function confirmVersion(): void {
  const state = readState()
  if (!state) return
  const v = managerVersion()
  if (state.confirmedVersion === v) return
  // 版本对上了，熔断标记也就没用了，一并清掉。
  writeState({ ...state, confirmedVersion: v, lastUpgradeTo: state.lastUpgradeTo === v ? '' : state.lastUpgradeTo })
}
