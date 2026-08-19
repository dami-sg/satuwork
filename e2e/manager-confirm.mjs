/**
 * 回滚脚本的判断逻辑：`manager/src/seat/manager-confirm.sh`。
 *
 * 这份脚本是自升级的兜底——新版本起来了却连不上 Gateway 时，把 current 搬回去。它出过
 * 一个竞态，而那次的表现极具迷惑性：一次**本来好好的**升级被判成失败、搬回旧版，然后
 * 管家的熔断报出「发布包里的 VERSION 和登记的版本号不一致」，把人引去查打包链路。
 *
 * 只测**判断**（`SATUWORK_CONFIRM_DECIDE_ONLY=1`），不测动手那几行：判断正是出过 bug 的
 * 地方，而换链接、重启是四条众所周知的命令，还依赖 GNU mv 和 systemd，在开发机上跑不了。
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'

const HOME = '/tmp/satuwork-e2e-confirm'

function decide(script, { current, previous = true, state }) {
  const root = join(HOME, 'root')
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(join(root, 'releases', current), { recursive: true })
  symlinkSync(join(root, 'releases', current), join(root, 'current'))
  if (previous) {
    mkdirSync(join(root, 'releases', 'old-1.0.0'), { recursive: true })
    symlinkSync(join(root, 'releases', 'old-1.0.0'), join(root, 'previous'))
  }
  const statePath = join(HOME, 'manager.json')
  if (state) writeFileSync(statePath, JSON.stringify(state))
  return new Promise((resolve, reject) => {
    execFile(
      'bash',
      [script],
      {
        env: {
          ...process.env,
          SATUWORK_MANAGER_ROOT: root,
          SATUWORK_MANAGER_STATE: statePath,
          SATUWORK_CONFIRM_DECIDE_ONLY: '1',
        },
      },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim())),
    )
  })
}

export async function runManagerConfirm({ root, test, assert, log }) {
  const script = join(root, 'manager/src/seat/manager-confirm.sh')
  log('\n# manager-confirm')
  const now = Date.now()

  try {
    await test('刚换完版还在宽限期里：不回滚', async () => {
      // **这一条就是那次事故。** 定时器每 120 秒敲一次，不管有没有在升级；而每次升级都
      // 必然经过一段「current 已是新版、confirmedVersion 还是旧版」的窗口（换链接 → 延迟
      // 重启 → 新进程第一次心跳，六到三十秒）。撞进去就会把好升级判成失败。
      const out = await decide(script, {
        current: 'new-2.0.0',
        state: { confirmedVersion: 'old-1.0.0', lastUpgradeAt: now - 5_000 },
      })
      assert(out.startsWith('keep'), `换版 5 秒就判失败了：${out}`)
    })

    await test('过了宽限期还没确认：回滚', async () => {
      // 兜底本身不能失效。新版本真的起不来 / 连不上 Gateway 时，必须搬回去——
      // 这套架构里没有 SSH 可以上去救。
      const out = await decide(script, {
        current: 'new-2.0.0',
        state: { confirmedVersion: 'old-1.0.0', lastUpgradeAt: now - 10 * 60_000 },
      })
      assert(out.startsWith('rollback'), `新版本十分钟没吭声，该回滚：${out}`)
    })

    await test('新版本已经确认过：不回滚', async () => {
      const out = await decide(script, {
        current: 'new-2.0.0',
        state: { confirmedVersion: 'new-2.0.0', lastUpgradeAt: now - 10 * 60_000 },
      })
      assert(out.startsWith('keep'), `已经确认了还回滚：${out}`)
    })

    await test('从没配对过的机器：不回滚', async () => {
      // 没有 confirmedVersion 可比。把「还没配对」当成「升级失败」会让装机当场变砖。
      const out = await decide(script, {
        current: 'new-2.0.0',
        state: { confirmedVersion: '', lastUpgradeAt: 0 },
      })
      assert(out.startsWith('keep'), `没配对过的机器被回滚了：${out}`)
    })

    await test('老管家不写 lastUpgradeAt：退回原来的立刻判定', async () => {
      // 新脚本会落到还在跑老管家的机器上（管家启动时刷新它）。那时状态文件里没有
      // lastUpgradeAt，不能因此就永远不回滚——兜底会整个失效。
      const out = await decide(script, {
        current: 'new-2.0.0',
        state: { confirmedVersion: 'old-1.0.0' },
      })
      assert(out.startsWith('rollback'), `老状态该退回老行为：${out}`)
    })

    await test('没有 previous 就没得回滚', async () => {
      const out = await decide(script, {
        current: 'new-2.0.0',
        previous: false,
        state: { confirmedVersion: 'old-1.0.0', lastUpgradeAt: 0 },
      })
      assert(out.startsWith('keep'), `没有 previous 还想回滚：${out}`)
    })
  } finally {
    rmSync(HOME, { recursive: true, force: true })
  }
}
