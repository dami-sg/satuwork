/**
 * `patch` 的模糊匹配。探针在 bot/e2e-patch.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 这一组分两半，两半同样重要：
 *
 *  - **放宽了什么**：五条策略各一例，而且每条都要**由它自己**命中。策略名一起断言，
 *    是因为一条被更宽的策略挡在前面的策略等于不存在，而从行为上完全看不出来
 *  - **没放宽什么**：内容对不上时必须失败。相似度匹配的失败是静默的——匹配到了、改
 *    下去了、返回成功，只是改错了地方。这类错不会有人报 bug，只会在某天变成一句
 *    「它把我的文件改乱了」
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

function runProbe(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'bot/e2e-patch.mjs')], {
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

export async function runPatch({ root, test, assert, log }) {
  log('\n# patch')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.strategies && r.mustFail, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('五条策略各自都真的会跑到', () => {
    const want = {
      exact: 'exact',
      line_trimmed: 'line_trimmed',
      whitespace_normalized: 'whitespace_normalized',
      escape_normalized: 'escape_normalized',
      unicode_normalized: 'unicode_normalized',
    }
    for (const [key, strategy] of Object.entries(want)) {
      const got = r.strategies[key]
      assert(!got.error, `${key} 没命中：${got.error}`)
      // 命中的策略名不对，说明这条被前面更宽的接住了——那它就是死代码。
      assert(got.strategy === strategy, `${key} 是被 ${got.strategy} 接住的，它自己没跑到`)
    }
  })

  await test('中文排版不会被静默换成半角', () => {
    // 命中之后照 new_string 原样写回去，等于把整段排版换成 ASCII。这类破坏没人会发现：
    // 文档看着还是那份文档，只是引号和空格全变了。
    const text = r.unicodePreserved
    assert(text.includes('“净利”'), `弯引号被换掉了：${JSON.stringify(text)}`)
    assert(text.includes('　'), `全角空格被换掉了：${JSON.stringify(text)}`)
    assert(text.includes('——'), `破折号被换掉了：${JSON.stringify(text)}`)
    assert(text.includes('15%'), '该改的那处没改')
    assert(!text.includes('12%'), '旧数字还在')
  })

  await test('缩进跟着文件走，不跟着模型写的走', () => {
    // 模型写四格、文件是两格。照它写的落下去，改过的那行就和周围对不上了。
    assert(r.reindent === 'f() {\n  const a = 2\n}\n', `缩进没对齐文件：${JSON.stringify(r.reindent)}`)
  })

  await test('行号前缀自动剥掉，但认得出什么不是行号', () => {
    // 模型从 read_file 的输出里整段复制粘贴是常态，带着 `123|` 的 old_string 在文件里
    // 永远找不到，而报出来的是「没找到那段文本」——最难自己走出来的一类失败。
    assert(r.lineNumbers.剥干净 === 'const a = 1\nconst b = 2', `没剥干净：${JSON.stringify(r.lineNumbers.剥干净)}`)
    assert(r.lineNumbers.整段复制粘贴能命中, '带行号前缀的 old_string 没能命中')
    assert(r.lineNumbers.表格不动.includes('| 甲 | 12|'), `把表格当行号剥了：${r.lineNumbers.表格不动}`)
    // 首列是编号的表：只看「数字加竖线」的话会被砍掉首列，那是把用户的数据当显示格式扔了。
    assert(r.lineNumbers.编号表不动 === '1001|甲\n1005|乙\n1200|丙', `把编号表当行号剥了：${r.lineNumbers.编号表不动}`)
    assert(r.lineNumbers.连号才算行号, '判据里少了「行号必须连着」这一条')
  })

  await test('new_string 里的行号前缀要当场拦下，不能写进文件', () => {
    // new_string 是要落盘的字节，不敢替模型决定 `12|` 是格式还是正文，所以不剥；但两边
    // 都带前缀是模型最自然的动作（整块复制、改一行、贴回去），照写下去就是把行号写进
    // 文件还报成功——文件被改坏了，没有任何东西会提醒任何人。
    assert(r.newStringPrefix.两边都带就拒, 'new_string 带着行号前缀也照写进文件了')
    assert(/new_string/.test(r.newStringPrefix.说清楚是哪一侧), `没说清楚是哪一侧的问题：${r.newStringPrefix.说清楚是哪一侧}`)
    assert(r.newStringPrefix.只有old带的照常, '只有 old_string 带前缀的正常情况被误伤了')
  })

  await test('多处命中要么说清楚，要么全换', () => {
    assert(r.unique.多处不给改, '不唯一的匹配被默默改了一处')
    assert(/第 2 行/.test(r.unique.说清楚在哪几行), `没说在哪几行：${r.unique.说清楚在哪几行}`)
    assert(r.unique.全替换 === 'x\nDONE\ny\nDONE\n' && r.unique.次数 === 2, `replace_all → ${r.unique.全替换}`)
  })

  await test('内容对不上时**必须**失败', () => {
    // 这一条是整份探针存在的理由：放宽的是排版，不是内容。
    assert(r.mustFail.改了标识符, '标识符都改了还能命中，说明在按相似度猜位置')
    assert(r.mustFail.少了一行, '中间一行不一样还能命中')
    assert(r.mustFail.凭空一段, '文件里根本没有的文本被兜到别处去了')
    assert(r.mustFail.连成一行, '把换行全删掉还能命中——那已经是另一段文本了')
    assert(r.mustFail.没找到时指路, '失败文本里没说下一步该干什么，模型只会原样重试')
  })

  await test('重复发同一次编辑不算失败', () => {
    // 模型把落过盘的编辑又发一遍是最常见的一类 patch 失败。报失败它会回去重读、再改
    // 一次；报「已经在了」它才走得下去。
    assert(r.already.不是命中 && r.already.认出来了, '没认出这次编辑已经落过盘')
    assert(r.alreadyStrict.短文本不算, '短文本的巧合被当成了「已经改过」，真正的手滑会被它盖住')
  })

  await test('转义漂移拦下来', () => {
    // 非 exact 命中时 new_string 里的 \' \" 多半是传输层加的。照写下去就是往文件里塞
    // 垃圾，而写坏的文件没有任何东西会提醒它。
    assert(r.drift.拒绝, '带着多余转义的替换被写进文件了')
    assert(/read_file/.test(r.drift.说了为什么), `拒绝时没给出路：${r.drift.说了为什么}`)
  })

  await test('返回统一差异格式', () => {
    // 差异比「已修改 X（替换 1 处）」有用得多：模型能当场看出自己改的是不是想改的那段。
    assert(r.diff.startsWith('--- a/t.txt\n+++ b/t.txt'), `差异头不对：${JSON.stringify(r.diff.slice(0, 40))}`)
    assert(r.diff.includes('@@ -1,7 +1,7 @@'), `hunk 头不对：${r.diff}`)
    assert(r.diff.includes('-d\n+D'), `改动行不对：${r.diff}`)
  })
}
