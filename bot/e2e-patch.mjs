/**
 * `patch` 的模糊匹配。探针要 tsx 才 import 得了 .ts。
 *
 * 这里钉的是**放宽到哪儿为止**：七条策略各放宽一样排版，而第八样——「差不多像」——
 * 一条都不许有。相似度匹配的失败是静默的：匹配到了、改下去了、返回成功，只是改错了
 * 地方，没有任何东西会提醒任何人。所以「找不到就要失败」和「找得到」同样重要。
 */
import { fuzzyReplace, hasLineNumbers, stripLineNumbers } from './src/tools/fuzzy.ts'

const out = {}
const run = (content, oldS, newS, all = false) => fuzzyReplace('t.txt', content, oldS, newS, all)

// ── 1. 五条策略各一例 ─────────────────────────────────────────────────
/**
 * 每条都要**由它自己**命中，前面那些更严的接不住——不然它就是死代码。策略名一起断言，
 * 就是为了把这件事钉住：`indentation_flexible` 和 `trimmed_boundary` 当初就是这么被
 * 发现从来没跑过的（`line_trimmed` 排在前面且严格更宽）。
 */
const hit = (content, oldS, newS) => {
  const r = run(content, oldS, newS)
  return r.ok ? { strategy: r.strategy, text: r.text } : { error: r.message }
}

out.strategies = {
  exact: hit('const a = 1\nconst b = 2\n', 'const b = 2', 'const b = 3'),
  // 模型写四格、文件是两格：exact 找不到（文件里没有那么深的缩进）
  line_trimmed: hit('f() {\n  const a = 1\n}\n', '    const a = 1', '    const a = 2'),
  // 行内空白对不上，光剥首尾没用
  whitespace_normalized: hit('const   a    =  1\n', 'const a = 1', 'const a = 2'),
  // 工具参数序列化时多留了一层转义
  escape_normalized: hit('const a = 1\nconst b = 2\n', 'const a = 1\\nconst b = 2', 'const a = 7\nconst b = 8'),
  // 中文排版：弯引号 + 全角空格 + 破折号，模型手里全是 ASCII
  unicode_normalized: hit(
    '第一段。\n本季度“净利”同比增长　12%——见附表。\n第三段。\n',
    '本季度"净利"同比增长 12%--见附表。',
    '本季度"净利"同比增长 15%--见附表。',
  ),
}

// ── 2. 排版字符不许被静默换成半角 ─────────────────────────────────────
/**
 * 命中之后照 new_string 原样写回去，等于把整段排版换成 ASCII——中文文档里那是没人
 * 会发现的破坏。改动只该落在模型真正改的那几个字上。
 */
out.unicodePreserved = out.strategies.unicode_normalized.text

// ── 3. 缩进跟着文件走 ─────────────────────────────────────────────────
// 非 exact 命中意味着文件的缩进和模型手里那份不一样。照原样写回去，改过的那几行就和
// 周围对不上了。
out.reindent = out.strategies.line_trimmed.text

// ── 4. 行号前缀 ───────────────────────────────────────────────────────
out.lineNumbers = {
  剥干净: stripLineNumbers('  12|const a = 1\n  13|const b = 2'),
  表格不动: stripLineNumbers('| 名称 | 数量 |\n| 甲 | 12|'),
  /**
   * **首列是编号的表不许被当成行号剥掉。** 只看「每行都是数字加竖线」的话，
   * `1001|甲` 这种表会被砍掉首列——那是把用户的数据当成显示格式扔了。真正的行号一定
   * 是连着的 n、n+1。
   */
  编号表不动: stripLineNumbers('1001|甲\n1005|乙\n1200|丙'),
  连号才算行号: hasLineNumbers('12|a\n13|b') && !hasLineNumbers('1001|甲\n1005|乙'),
  整段复制粘贴能命中: run('const a = 1\nconst b = 2\n', '1|const a = 1\n2|const b = 2', 'const a = 9').ok,
}

// ── 4b. 行号前缀只从 old_string 剥，new_string 不剥 ───────────────────
/**
 * `new_string` 是要写进文件的字节，谁也不敢替模型决定 `12|` 是显示格式还是正文，所以
 * 不剥。但两边都带前缀时必须**当场拦下**：模型整块复制下来、改一行、两个参数都贴回去
 * 是它最自然的动作，而照着写下去就是把 `12|const a = 1` 落进文件，还报成功——文件被
 * 改坏了，没有任何东西会提醒任何人。
 */
{
  const both = run('const a = 1\nconst b = 2\n', '1|const a = 1\n2|const b = 2', '1|const a = 9\n2|const b = 9')
  const onlyOld = run('const a = 1\nconst b = 2\n', '1|const a = 1\n2|const b = 2', 'const a = 9\nconst b = 9')
  out.newStringPrefix = {
    两边都带就拒: !both.ok,
    说清楚是哪一侧: both.ok ? '' : both.message,
    只有old带的照常: onlyOld.ok && onlyOld.text === 'const a = 9\nconst b = 9\n',
  }
}

// ── 5. 唯一性与 replace_all ───────────────────────────────────────────
const many = 'x\nTODO\ny\nTODO\n'
const notUnique = run(many, 'TODO', 'DONE')
const all = run(many, 'TODO', 'DONE', true)
out.unique = {
  多处不给改: !notUnique.ok,
  说清楚在哪几行: notUnique.ok ? '' : notUnique.message,
  全替换: all.ok ? all.text : all.message,
  次数: all.ok ? all.count : 0,
}

// ── 6. 找不到就要失败 ─────────────────────────────────────────────────
/**
 * **这一组是这份探针存在的理由。** 前面那些放宽的是排版，这些是内容——内容对不上还能
 * 命中，就说明有一条策略在按「差不多像」猜位置。
 */
const near = 'function calcTotal(items) {\n  return items.length\n}\n'
out.mustFail = {
  改了标识符: !run(near, 'function calcTotals(items) {', 'x').ok,
  少了一行: !run(near, 'function calcTotal(items) {\n  return items.size\n}', 'x').ok,
  凭空一段: !run(near, 'const zzz = 44', 'x').ok,
  // 空白全删光不算「排版差异」，那是另一段文本了
  连成一行: !run(near, 'function calcTotal(items){return items.length}', 'x').ok,
  没找到时指路: /read_file/.test(run(near, 'const zzz = 44', 'x').message),
}

// ── 7. 重复发同一次编辑 ───────────────────────────────────────────────
// 生产上最常见的一类失败：模型把落过盘的编辑又发了一遍。报失败会让它回去重读、再改
// 一次；报「已经在了」它才走得下去。
const done = run('const answer = 42\n', 'const answer = 41', 'const answer = 42')
out.already = { 不是命中: !done.ok, 认出来了: Boolean(done.applied) }
const coincidence = run('a = 1\n', 'a = 2', 'a = 1')
out.alreadyStrict = { 短文本不算: !coincidence.applied }

// ── 8. 转义漂移 ───────────────────────────────────────────────────────
// 非 exact 命中时 new_string 里的 \' \" 多半是传输层加的。照写下去就是往文件里塞垃圾，
// 而写坏的文件没有任何东西会提醒它。
const drift = run("\tmsg = 'hi'\n", "  msg = 'hi'", "  msg = \\'bye\\'")
out.drift = { 拒绝: !drift.ok, 说了为什么: drift.ok ? '' : drift.message }

// ── 9. 差异格式 ───────────────────────────────────────────────────────
const diffed = run('a\nb\nc\nd\ne\nf\ng\n', 'd', 'D')
out.diff = diffed.ok ? diffed.diff : diffed.message

console.log('__RESULT__' + JSON.stringify(out))
