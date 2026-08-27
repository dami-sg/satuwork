/**
 * 重建历史时时间跟不跟着回去。探针在 bot/e2e-history-time.mjs（纯函数，要 tsx）。
 *
 * 这一层的错不会报错、不会丢消息，只会让模型对「昨天」一无所知——所以必须钉住。
 * 探针里用 SATUWORK_TZ 把时区钉死，否则断言会跟着跑测试的机器漂。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const TZ = 'Asia/Shanghai'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-history-time.mjs', { env: { SATUWORK_TZ: TZ } })

export async function runHistoryTime({ root, test, assert, log }) {
  log('\n# history-time')
  const r = await runProbe(root)

  await test('每条消息带自己的时间，不是重建那一刻的时间', () => {
    assert(
      JSON.stringify(r.timestamps) === JSON.stringify(r.expected),
      `时间戳应为 ${JSON.stringify(r.expected)}，实际 ${JSON.stringify(r.timestamps)}`,
    )
    // 全等于同一个值 = 又被 Date.now() 盖平了。这正是线上那次的症状。
    assert(new Set(r.timestamps).size > 1, '所有消息盖着同一个时间戳')
  })

  await test('时间要写进正文——只改 timestamp 字段模型是看不见的', () => {
    assert(r.userContents.length === 2, `用户消息应为 2 条，实际 ${r.userContents.length}`)
    for (const c of r.userContents) {
      assert(/^\[[^\]]+\]\n/.test(c), `用户消息正文缺时间前缀：${JSON.stringify(c)}`)
    }
  })

  await test('带图的消息一样盖时间，图和正文都不丢', () => {
    // 有图时内容是数组而不是字符串。只处理字符串的话，带图那几条就没有时间——
    // 而「上周发你的那张图」恰恰是最常被问起的。
    assert(r.image.isArray, '带图的消息内容不是数组')
    assert(r.image.firstBlockIsTime, '第一块不是时间戳')
    assert(r.image.blockCount === 3, `应为 时间 + 图 + 正文 三块，实为 ${r.image.blockCount}`)
    assert(r.image.keepsText, '盖完时间正文丢了')
  })

  await test('跨天的两条能被区分出昨天和今天', () => {
    const [yesterday, today] = r.userContents
    assert(yesterday.includes('8月18日'), `昨天那条应带 8月18日，实际 ${JSON.stringify(yesterday)}`)
    assert(today.includes('8月19日'), `今天那条应带 8月19日，实际 ${JSON.stringify(today)}`)
    assert(yesterday.endsWith('昨天的问题'), `正文被改坏了：${JSON.stringify(yesterday)}`)
    assert(today.endsWith('今天的问题'), `正文被改坏了：${JSON.stringify(today)}`)
  })
}
