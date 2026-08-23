/**
 * 管家自升级要不要等席位把会话跑完。**不走 HTTP 控制面**——要钉的是 maybeUpgrade
 * 里那道闸：席位在跑就先不换，等太久了就照换。
 *
 * 由 e2e/upgrade-drain.mjs 用 `node --import tsx` 拉起，结果以 __RESULT__ 一行 JSON 回去。
 *
 * 放 manager/ 而不是 e2e/：和别的探针同一个理由，裸导入按文件所在目录往上找。
 */
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 环境要在**导入之前**摆好：config.ts 里那几个路径是在调用时读 env 的，但
// 早读一步更保险，也让这份探针不碰宿主机的 /etc 和 /opt。
const HOME = mkdtempSync(join(tmpdir(), 'satuwork-drain-home-'))
const ROOT = mkdtempSync(join(tmpdir(), 'satuwork-drain-root-'))
process.env.SATUWORK_MANAGER_HOME = HOME
process.env.SATUWORK_MANAGER_ROOT = ROOT

const { maybeUpgrade, upgradeDeferred, upgradeError } = await import('./src/upgrade.ts')

function listen(server) {
  return new Promise((ok, bad) => {
    server.once('error', bad)
    server.listen(0, '127.0.0.1', () => ok(server.address().port))
  })
}

/** 假席位：只答 /api/health，忙不忙由外面改。 */
const health = { ok: true, busy: true, running: 1, queued: 0 }
const seat = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(health))
})
const seatPort = await listen(seat)

/** 假发布包地址：只数有没有人来拉。真去拉了，就说明那道闸没拦住。 */
let downloads = 0
const releases = createServer((req, res) => {
  downloads += 1
  res.writeHead(404).end('not here')
})
const relPort = await listen(releases)

writeFileSync(
  join(HOME, 'seats.json'),
  JSON.stringify({
    'sw-probe-0001': {
      seatId: 'sw-probe-0001',
      linuxUser: 'sw-probe',
      seatDir: `/home/sw-probe/.satuwork/sw-probe-0001`,
      botId: 'bot-probe',
      botVersion: '0.0.0-probe',
      botPort: seatPort,
      novncPort: 6081,
      deployedAt: Date.now(),
      status: 'ready',
      lastError: null,
    },
  }),
)

const offer = {
  desiredManagerVersion: 'drain-9.9.9',
  url: `http://127.0.0.1:${relPort}/pkg.tgz`,
  sha256: 'f'.repeat(64),
}

const out = {}

// 一、席位在跑：一步都不该往下走，连包都不许去拉。
await maybeUpgrade(offer, 'smt_probe')
out.busyDownloads = downloads
out.busyDeferred = upgradeDeferred()
// 「等」不是错——报成 lastError 的话，界面上会给一台好好的机器画一行红字。
out.busyError = upgradeError()

// 二、席位空下来了：这一轮就该真的去拉包（拉到 404，随它失败，我们要的是「动了」）。
health.busy = false
health.running = 0
await maybeUpgrade(offer, 'smt_probe')
out.idleDownloads = downloads
out.idleDeferred = upgradeDeferred()

/**
 * 三、等过头了就不再等。
 *
 * 一台天天有人用的机器上，「所有席位都空着」的时刻可能整天都不出现；无限等下去
 * 就等于这台机器再也不升级了——而升级里往往正躺着修这类问题的补丁。窗口调到 50ms
 * 之后跑两轮：第一轮开始等（一个包都不许拉），睡过窗口再跑第二轮，这次照换。
 */
health.busy = true
health.running = 2
process.env.SATUWORK_UPGRADE_DEFER_MS = '50'
const before = downloads
await maybeUpgrade({ ...offer, desiredManagerVersion: 'drain-9.9.10' }, 'smt_probe')
out.holdDownloads = downloads - before
await new Promise((r) => setTimeout(r, 120))
await maybeUpgrade({ ...offer, desiredManagerVersion: 'drain-9.9.10' }, 'smt_probe')
out.forcedDownloads = downloads - before
// 认了之后那个「在等」的记号要清掉，否则界面上会一直说它在等一件已经做过的事。
out.forcedDeferred = upgradeDeferred()

seat.close()
releases.close()
console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
