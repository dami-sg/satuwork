/**
 * 席位这一侧的 web_search / web_extract。探针在 bot/e2e-web.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 这一层的错**多半不会报错**：摘要静悄悄退化成截原文、落盘失败只少一行提示、网页里
 * 藏的一段指令原样进上下文——都不会有任何一处抛异常。所以每一条都单独钉。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

function runProbe(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'bot/e2e-web.mjs')], {
      cwd: join(root, 'bot'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('__RESULT__'))
      if (code !== 0 || !line) return reject(new Error(`探针退出 ${code}\n${err || out}`))
      try {
        resolve(JSON.parse(line.slice('__RESULT__'.length)))
      } catch (e) {
        reject(new Error(`探针输出解析失败：${e.message}\n${line}`))
      }
    })
  })
}

const all = (o, label, assert) => {
  for (const [k, v] of Object.entries(o)) assert(v === true, `${label}：${k} 不成立`)
}

export async function runWebBot({ root, test, assert, log }) {
  log('\n# web-bot')
  let r

  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.search && r.short && r.long, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('搜索：条数、链接、日期都在，长摘要截得住', () => {
    all(r.search, '搜索', assert)
  })

  await test('零结果 / 没配后端都是业务失败，不置 failed', () => {
    // 置了 failed，模型只会当成管道抖动重试一遍，而重试一百次也还是没配后端。
    all(r.searchEmpty, '零结果', assert)
    all(r.searchNoBackend, '没配后端', assert)
  })

  await test('后端不支持的约束在本地滤，并且说出来', () => {
    all(r.searchFiltered, '本地过滤', assert)
  })

  await test('短页面原样返回，一次模型都不调', () => {
    // 这条是钱：每页都过一遍模型，等于给每次 web_extract 加一笔固定开销。
    all(r.short, '短页面', assert)
  })

  await test('长页面走 utility 摘要，原文不进上下文', () => {
    all(r.long, '长页面', assert)
  })

  await test('摘要模型不可用时退回原文开头，仍然不置 failed', () => {
    all(r.summaryDown, '摘要回退', assert)
  })

  await test('save=true：落盘、files 报出来、文件真在', () => {
    // files 是界面上「Bot 生成了什么」唯一不靠正则猜的一环，报错了就等于没落盘。
    all(r.save, '落盘', assert)
  })

  await test('五个地址一个 404：其余四个照常，失败那条写清楚', () => {
    all(r.partial, '部分失败', assert)
  })

  await test('超大页面拒了，并指一条别的路', () => {
    all(r.huge, '超大页面', assert)
  })

  await test('网页里藏的脚本、注释、零宽和双向控制符都剥掉，正文不动', () => {
    all(r.evil, '清洗', assert)
    all(r.sanitize, 'sanitize', assert)
  })

  await test('参数不对当场说清楚', () => {
    all(r.args, '参数', assert)
  })

  await test('超长页面切块并行摘，再收一次口', () => {
    // 400k 以上单次摘不动：不切块的话，要么超上下文，要么被上游截掉一半还不报错。
    all(r.chunked, '分块摘要', assert)
  })

  await test('PDF：原件一定落盘，正文用文档提取器取出来', () => {
    // 提取后端对着一份 PDF 要么给空、要么给乱码，所以这类地址走的是另一条路。
    all(r.pdf, 'PDF', assert)
  })

  await test('Gateway 给的后缀是外部输入，落盘不能被它带出工作区', () => {
    // 这条挡的不是「模型手滑」，是「上游给了个奇怪的值」：ext 直接拼进文件名，
    // `/../../x` 就能把这次写落到工作区外面。
    all(r.evilExt, '后缀逃逸', assert)
  })

  await test('落盘文件名：日期 + 域名 + 标题；坏地址也出得来', () => {
    assert(/^2026-08-20-nodejs-org-/.test(r.fileName.形状), `文件名不对：${r.fileName.形状}`)
    assert(r.fileName.形状.endsWith('.md'), `没有后缀：${r.fileName.形状}`)
    assert(r.fileName.坏地址也能出名字 === '2026-08-20-page.md', `坏地址：${r.fileName.坏地址也能出名字}`)
  })
}
