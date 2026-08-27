/**
 * 换版之前先等席位把会话跑完。
 *
 * 换版是**打断**：管家自升级会重启自己（Gateway 到席位的每一跳都从它身上过），席位
 * 换版是 `systemctl restart satuwork-bot@<seat>`（正跑着的那一轮当场没命，日志里那条
 * turn/end 根本没写成）。两件事都没有理由非得踩在人正等着回答的那一刻。
 *
 * 席位那一侧由 e2e/manager.mjs 钉（真管家 + 假席位，走 HTTP 控制面）；这一组钉的是
 * 管家**自升级**那道闸——它由心跳驱动，没有一条外部接口能直接触发，所以走探针。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'manager/e2e-upgrade-drain.mjs')

export async function runUpgradeDrain({ root, test, assert, log }) {
  log('\n# upgrade-drain')
  const r = await runProbe(root)

  await test('席位在跑会话时，管家不自升级——连包都不去拉', async () => {
    // 拉包只是第一步，后面紧跟着自检、换 current、systemd-run 重启自己。闸要拦在
    // 最前面：拉了包再决定不换，下一轮又要重拉一遍。
    assert(r.busyDownloads === 0, `席位在跑还是去拉了 ${r.busyDownloads} 次包`)
    assert(r.busyDeferred && r.busyDeferred.version === 'drain-9.9.9', `没记下在等哪个版本：${JSON.stringify(r.busyDeferred)}`)
    assert(
      (r.busyDeferred.seats || []).includes('sw-probe-0001'),
      `没记下在等哪个席位，人无从知道是谁占着：${JSON.stringify(r.busyDeferred)}`,
    )
  })

  await test('「在等」不是错：不进 lastError，界面上不该给一台好机器画红字', async () => {
    // lastError 会顺着心跳变成机器详情页上的一行红字（见 pages-machines.js）。
    // 一台正常工作、只是此刻有人在用的机器不该长成那样。
    assert(!r.busyError, `等待被报成了错误：${JSON.stringify(r.busyError)}`)
  })

  await test('席位空下来就接着换，不用等下一次心跳以外的任何人', async () => {
    assert(r.idleDownloads === 1, `席位空了却没接着换（拉包 ${r.idleDownloads} 次）`)
    assert(!r.idleDeferred, `换过了还挂着「在等」：${JSON.stringify(r.idleDeferred)}`)
  })

  await test('等过头了就照换：不能让一台天天有人用的机器永远停在旧版本', async () => {
    assert(r.holdDownloads === 0, `窗口还没到就换了（拉包 ${r.holdDownloads} 次）`)
    assert(r.forcedDownloads === 1, `等过头了还在等——这台机器再也升不上去了`)
    assert(!r.forcedDeferred, `认了之后还挂着「在等」：${JSON.stringify(r.forcedDeferred)}`)
  })
}
