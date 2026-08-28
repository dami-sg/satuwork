/**
 * 席位上跑一张看板卡（docs/kanban.md §9）。探针在 bot/e2e-card.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 为什么值得单开一个套件：这一段**坏了大半都不报错**。卡片会话混进侧栏、收口报了两遍、
 * 提示词里少了那句「你面前没有人」、上游卡的结论没进交底书——每一种的表现都是「卡跑完
 * 了，结论看起来也有」，而错在哪儿要等下游那张卡做出个荒唐结果才被看见。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-card.mjs', { timeout: 60_000 })

/** 把一组「断言名 → 真假」逐条报出来。名字就是断言，红的时候不用回头翻代码。 */
const each = (test, assert, group, obj) =>
  Object.entries(obj).map(([k, v]) => () => test(`${group}：${k}`, () => assert(v === true, `${k} 不成立`)))

export async function runCard({ root, test, assert, log }) {
  log('\n# card')
  const r = await runProbe(root)

  const groups = [
    // 卡片会话不是「这个人的对话」：混进 list() 的后果最狠——席位重装之后，
    // ensureSession 认领的会是昨天某张卡的现场。
    ['会话', r.会话],
    // 做这张卡的 Bot 看不见任何一段对话，交底书少一样它就得靠猜。
    ['交底书', r.交底书],
    // 减三加三：history_* 读的是「这场对话」，而一张卡不属于任何一场对话。
    ['工具表', r.工具表],
    ['提示词', r.提示词],
    // 收口是 kanban_complete 那次调用本身，不是那一轮结束。
    ['收口', r.收口],
    // 编一段摘要出来是最糟的选项——下游卡会拿它当交底书继续做。
    ['没交结论', r.没交结论],
    ['重试', r.重试],
    ['主会话', r.主会话],
  ]
  for (const [name, obj] of groups) {
    for (const one of each(test, assert, name, obj ?? {})) await one()
  }
}
