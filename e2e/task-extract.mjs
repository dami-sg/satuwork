/**
 * 席位上的任务抽取器（docs/task-board.md §3–§7）。探针在 bot/e2e-task-extract.mjs
 * （要 tsx 才 import 得了 .ts）。
 *
 * 为什么值得单开一个套件：这一段**坏了大半都不报错**。预过滤漏了只是账单变贵；邮件正文
 * 漏进提示词只是注入面变大；轮号翻错只是「看原话」指到别处；失败推了水位只是那一段对话
 * 就此没人再看——四种的表现都是「板上看着挺正常」，而错在哪儿要等人某天发现一件办过的事
 * 从来没出现过才被察觉。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-task-extract.mjs', { timeout: 60_000 })

/** 把一组「断言名 → 真假」逐条报出来。名字就是断言，红的时候不用回头翻代码。 */
const each = (test, assert, group, obj) =>
  Object.entries(obj).map(([k, v]) => () => test(`${group}：${k}`, () => assert(v === true, `${k} 不成立`)))

export async function runTaskExtract({ root, test, assert, log }) {
  log('\n# task-extract')
  const r = await runProbe(root)

  const groups = [
    // 「列个目录看看」那一类占日常对话的大头，而它们永远不是一件任务。
    ['预过滤', r.预过滤],
    ['抽一次', r.抽一次],
    // 判「做完没有」用的是动过手的那把工具的返回；读回来的邮件正文一个字都不该进去。
    ['喂进去的', r.喂进去的],
    ['水位', r.水位],
    // 抽取是优化不是正确性的一部分：崩了就当这一段还没抽过。
    ['抽崩了', r.抽崩了],
    // 平台没钉 utility 就整个静默关掉，**不回落到贵模型**。
    ['没钉档位', r.没钉档位],
    ['旁支', r.旁支],
    ['算子', r.算子],
  ]
  for (const [name, obj] of groups) {
    assert(obj && typeof obj === 'object', `探针没给出「${name}」那一组`)
    for (const one of each(test, assert, name, obj)) await one()
  }
}
