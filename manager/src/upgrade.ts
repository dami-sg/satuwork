import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { installRoot, managerVersion, readState, seatAssets, writeState } from './config.ts'
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

/**
 * 把回滚脚本刷成自己包里的这一份。
 *
 * **这是让这类兜底脚本修得动的唯一办法。** 它装在 /usr/local/bin，由装机脚本写下——
 * 也就是说机器装好那天是什么样，以后就一直是什么样。里面出过一个竞态（见
 * src/seat/manager-confirm.sh 开头），要是只改装机脚本，现有机器得**重装**才拿得到
 * 修复，而重装是这套架构里最不想做的事。跟着包走、每次启动刷一遍，一次正常升级就
 * 到位了。
 *
 * 只在内容不同时写，省掉每次启动一次无谓的写盘；写不动（只读根、权限不对）就算了，
 * 记一行日志——它是兜底，不该反过来把管家启动搞挂。
 */
export function refreshConfirmScript(): void {
  const src = join(seatAssets(), 'manager-confirm.sh')
  const dst = '/usr/local/bin/satuwork-manager-confirm.sh'
  try {
    const want = readFileSync(src, 'utf8')
    let have = ''
    try {
      have = readFileSync(dst, 'utf8')
    } catch {
      /* 还没有就是要写。 */
    }
    if (have === want) return
    writeFileSync(dst, want, { mode: 0o755 })
    console.log('satuwork-manager: 已更新回滚脚本 ' + dst)
  } catch (e) {
    console.error('satuwork-manager: 回滚脚本没刷成：' + (e instanceof Error ? e.message : String(e)))
  }
}

/** 回滚脚本留下的记号：它把 current 从哪个版本搬回去了。见 src/seat/manager-confirm.sh。 */
function rolledBackPath(): string {
  return join(installRoot(), 'rolled-back')
}

function rolledBackFrom(): string {
  try {
    return readFileSync(rolledBackPath(), 'utf8').trim()
  } catch {
    return ''
  }
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

  // 熔断：上次已经换到过这个版本，重启回来自报的却还是别的。再试也是一样的结果，
  // 而每试一次就重启一次、掐断一次聊天。停手，把原因报上去。
  //
  // **原因有两种，处置完全不同，所以必须分开说。** 早先这里一律报成「发布包里的
  // VERSION 写错了」，而更常见的其实是另一种：回滚脚本把 current 搬回去了。那时人
  // 会照着这句话去查打包链路，怎么查都是对的——真正该看的是那台机器连不连得上
  // Gateway。分不出来就不要猜：回滚脚本会留一个记号，认它。
  const state = readState()
  if (state?.lastUpgradeTo === want) {
    lastError =
      rolledBackFrom() === want
        ? `升级到 ${want} 之后被回滚了：新版本起来了，但没能在宽限期内连上 Gateway。现在跑的是 ${managerVersion()}，不再自动重试——先查这台机器到 Gateway 的网络。`
        : `已换到 ${want} 但进程自报 ${managerVersion()}：发布包里的 VERSION 和登记的版本号不一致，不再重试`
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
    // 先记下「要换到哪个版本、什么时候换的」再真的换：进程马上就要被重启，记晚了就丢了。
    // 时刻是给回滚脚本用的——它靠这个才分得出「连不上 Gateway」和「还没来得及起来」。
    if (state) writeState({ ...state, lastUpgradeTo: want, lastUpgradeAt: Date.now() })
    // 上一次回滚的记号跟这次无关了，清掉；留着会让下一次熔断报出错的原因。
    rmSync(rolledBackPath(), { force: true })
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
