/**
 * 部署失败时报回去的那句话。
 *
 * 这一组是补票：一次真实的部署失败在界面上只显示到「Adding new group (1003) .」就断了，
 * 而真正的原因——脚本在哪一步、退出码多少——一个字都没有。两处叠在一起造成的：管家把
 * 退出码藏在只在两流皆空时才用的兜底里，Gateway 又在 JSON.parse 之前把响应体砍到 400 字。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

function runProbe(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'manager/e2e-deploy-errors.mjs')], {
      cwd: join(root, 'manager'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('__RESULT__'))
      if (code !== 0 || !line) {
        reject(new Error(`探针退出 ${code}\n${err || out}`))
        return
      }
      resolve(JSON.parse(line.slice('__RESULT__'.length)))
    })
  })
}

export async function runDeployErrors({ root, test, assert, log }) {
  log('\n# deploy-errors')
  const r = await runProbe(root)

  await test('失败的命令一声不吭时，退出码必须还在', async () => {
    // 这就是那次真实故障：脚本非零退出，stderr 空，stdout 里全是无关的正常进度。
    // 原先的取法是 `stderr || stdout || fallback`——stdout 非空，于是兜底里那句
    // 「exited 3」永远轮不上，界面上只剩一堆进度。
    assert(r.silentFailure.includes('exited 3'), `没带退出码：${r.silentFailure}`)
    assert(r.silentFailure.includes('chrome: 已在位'), `没带上走到哪儿了：${r.silentFailure}`)
  })

  await test('两个流都空：至少说得出退出码', async () => {
    assert(r.bothEmpty.includes('exited 137'), `${r.bothEmpty}`)
  })

  await test('stderr 有内容也不丢 stdout——一个说为什么，一个说走到哪儿', async () => {
    assert(r.bothStreams.includes('第 42 行失败'), `丢了 stderr：${r.bothStreams}`)
    assert(r.bothStreams.includes('进度B'), `丢了 stdout：${r.bothStreams}`)
  })

  await test('超长输出留尾不留头', async () => {
    assert(r.longTail.includes('最后一句'), `把结尾截掉了：${r.longTail.slice(0, 80)}…`)
    assert(!r.longTail.includes('OUT-0 '), '把开头留下了，那儿没有原因')
  })

  await test('退出码为 0 时不硬说 exited 0，走兜底', async () => {
    assert(r.code0 === '兜底', `${r.code0}`)
  })

  // ── 端口被占着时，敢不敢清 ────────────────────────────────────────
  // 现场：席位部署 exited 43，5910 上蹲着一个已经拆掉的席位的 x11vnc——单元停了，
  // 进程从 logind session 里逃了出来（PAMName=login + KillUserProcesses=no）。
  // 四种占口的东西处置完全不同，判错的代价不对称，所以逐种钉住。

  await test('已经不在名册里的席位占着口 → 清掉它，这次部署不该失败', async () => {
    assert(r.orphan.action === 'retire-seat', `${JSON.stringify(r.orphan)}`)
    assert(r.orphan.seatId === 'sw-gone-7bbe', `清错了对象：${r.orphan.seatId}`)
  })

  await test('名册里还挂着、但 Gateway 把槽位给了别人 → 以 Gateway 为准，清掉并标出来', async () => {
    // 结构上不可能是「两个活席位撞了槽位」：seat_runtimes 上有 unique(machineId, slot)。
    // 只可能是本机名册旧了。报错在这儿是个死局——心跳不带席位清单，Gateway 不知道
    // 这个席位存在，界面上没有任何按钮能动它，而这台机器没有 SSH。
    assert(r.staleRoster.action === 'retire-seat', `${JSON.stringify(r.staleRoster)}`)
    assert(r.staleRoster.stale === true, '得标出「名册旧了」，日志里那句话要说得更响')
  })

  await test('清掉的席位要销号，不能留在名册里', async () => {
    // 留着的话，下次撞上同一个口，会把一个已经被停掉的席位当成「活着的」——
    // 判断依据成了一份自己造出来的假象。
    assert(r.pruneChanged === true, 'pruneRetired 没说自己改过名册，调用方于是不落盘')
    assert(!r.pruneLeft.includes('sw-old-0009'), `被停掉的席位还留在名册里：${r.pruneLeft}`)
    assert(r.pruneLeft.includes('sw-me-0001'), `把不该动的席位一起删了：${r.pruneLeft}`)
  })

  await test('清掉的是名册里本来就没有的孤儿 → 不白写一次盘', async () => {
    // 孤儿正是这条路最常见的入口，照着 retired.length 落盘等于每次回收都多写一遍。
    assert(r.pruneNoop === false, '名册没变还说改过了')
  })

  await test('活席位换槽位之前那一代的进程 → 只杀这一个，别按席位杀', async () => {
    // 按席位杀会把它现在正在服务的那一套一起带走。
    assert(r.staleGeneration.action === 'kill-pid', `${JSON.stringify(r.staleGeneration)}`)
  })

  await test('显示号和端口走同一套判断——Xvfb 一个 TCP 口都不占', async () => {
    // 上一个席位只剩 Xvfb 活着时，三个端口全是空的，只有 /tmp/.X10-lock 挡着路；
    // 不查这一格，部署会「成功」而桌面永远黑着。
    assert(r.displayOrphan.action === 'retire-seat', `${JSON.stringify(r.displayOrphan)}`)
    assert(r.displayStaleGeneration.action === 'kill-pid', `${JSON.stringify(r.displayStaleGeneration)}`)
  })

  await test('不是 satuwork 的进程 → 不动，把话说准', async () => {
    assert(r.foreign.action === 'blocked', `${JSON.stringify(r.foreign)}`)
    assert(r.foreign.reason.includes('不是任何一个 satuwork 席位'), `${r.foreign.reason}`)
  })

  await test('自己上一轮的残留不在这一层清——交给 slim-desktop.sh', async () => {
    // 在部署最前面清掉自己的桌面，后面 apt 一失败，本来还在服务的那一套白死一回。
    assert(r.ownStale.action === 'ours', `${JSON.stringify(r.ownStale)}`)
  })
}
