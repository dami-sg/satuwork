/**
 * 带配对码重跑装机脚本时，管家该拿哪个身份。
 *
 * 这一组是补票：机器在平台上被删掉之后，人带着新配对码重跑装机脚本——脚本打印
 * 「Paired」，Gateway 那边一次 `POST /machines/pair` 都没收到（配对码的 usedAt 至今是
 * 空的），界面上始终没有这台机器。两处叠在一起造成的：管家看见本地已有 manager.json
 * 就直接说「已配对」、配对码看都不看，而装机脚本判成功的唯一依据又是那个文件在不在。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'manager/e2e-pairing.mjs')

export async function runPairing({ root, test, assert, log }) {
  log('\n# pairing')
  const r = await runProbe(root)

  await test('本地已有身份、又给了配对码 → 按码重配，不是「已配对」了事', async () => {
    // 这就是那次真实故障：机器在平台上被删了，人带新码重跑，管家一次都没去找 Gateway。
    assert(r.staleThenCode.pairCalls === 1, `没去配对：${r.staleThenCode.pairCalls} 次请求`)
    assert(r.staleThenCode.onDisk === 'new-machine-id', `身份没换成新的：${r.staleThenCode.onDisk}`)
    assert(r.staleThenCode.token === 'smt_new', `票没换：${r.staleThenCode.token}`)
  })

  await test('码用过了或过期了 → 退回本地那个身份，不炸也不丢机器', async () => {
    // 先弃后换的话，一张打错的码就能把一台好好的机器变成没人认领的孤儿，
    // 而这台机器没有 SSH。所以落盘必须是最后一步。
    assert(r.staleThenBadCode.error === null, `不该抛：${r.staleThenBadCode.error}`)
    assert(r.staleThenBadCode.onDisk === 'old-machine-id', `旧身份被冲掉了：${r.staleThenBadCode.onDisk}`)
    assert(r.staleThenBadCode.token === 'smt_old', `旧票被冲掉了：${r.staleThenBadCode.token}`)
  })

  await test('没给码 → 一次请求都不发，身份不动', async () => {
    // 「重跑装机脚本不会把机器搞乱」是这个脚本的立身之本，不能为了修上面那条把它换掉。
    assert(r.staleNoCode.pairCalls === 0, `不该去配对，却发了 ${r.staleNoCode.pairCalls} 次`)
    assert(r.staleNoCode.onDisk === 'old-machine-id', `身份被动了：${r.staleNoCode.onDisk}`)
  })

  await test('全新机器带码 → 照旧配上', async () => {
    assert(r.freshWithCode.onDisk === 'new-machine-id', `${JSON.stringify(r.freshWithCode)}`)
  })

  await test('全新机器、码不认 → 没有可退回的身份，该抛就抛', async () => {
    // 装机脚本会把 journalctl 那句话打给人看；这里咽下去的话，人只会看到一句「Paired」。
    assert(r.freshBadCode.error && r.freshBadCode.error.includes('401'), `${JSON.stringify(r.freshBadCode)}`)
    assert(r.freshBadCode.onDisk === null, '不该留下半份身份')
  })
}
