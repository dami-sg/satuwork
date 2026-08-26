/**
 * `patch` 的匹配层：五条策略，按顺序试，命中即停。
 *
 * 为什么要有它：今天的 `edit` 要求 `old_string` 与文件里的内容**逐字相同**，缩进差一格
 * 就是「没找到那段文本」。模型于是回去重读、重试，一次编辑烧掉两三步——而它想改的那
 * 一段其实就在那儿，只是它记着的缩进和文件里的不一样。这里放宽的全是**排版**，不是
 * 内容。
 *
 * **上游有两条按相似度猜位置的，我们不要**（`block_anchor` 只对齐首尾行、
 * `context_aware` 按 50% 行相似度）。它们的失败是**静默的**：匹配到了、改下去了、
 * 返回成功，只是改错了地方。这五条要么命中要么不命中，不命中就让模型重读一遍文件再
 * 来——多一步，换一个不会悄悄改坏文件的编辑工具。
 *
 * 口径抄自 Hermes Agent 的 `tools/fuzzy_match.py`（MIT），实现是我们自己的。
 */

/** 文件里的一段，`[起, 止)`，按字符偏移。 */
type Span = [number, number]

export interface PatchOk {
  ok: true
  /** 改完之后的全文。 */
  text: string
  /** 替换了几处。 */
  count: number
  /** 哪条策略命中的。`exact` 之外的都意味着放宽了排版。 */
  strategy: string
  /** 统一差异格式，给模型和界面看。 */
  diff: string
}

export interface PatchErr {
  ok: false
  message: string
  /** 这次编辑其实已经在文件里了（模型重发了一遍）。调用方据此报成功形状的空操作。 */
  applied?: boolean
}

/**
 * 排版字符 → ASCII。
 *
 * **这一张表对中文文档比对上游更要紧。** 工作区里是中文的报告和纪要：全角空格、
 * 中文引号、`——` 到处都是，而模型写 `old_string` 时打的是 ASCII。少了这一条，中文
 * 文档的每一次编辑都要靠模型逐字复刻排版字符。
 */
const UNICODE_MAP: Record<string, string> = {
  '“': '"', '”': '"', '‘': "'", '’': "'",
  // 破折号一律折成**一个** `-`，不是上游那个 `--`。归一化是两边一起做的，所以要的是
  // 「两种写法能撞上」：中文里的破折号是 `——`（两个 U+2014），折成 `--` 正好接住模型
  // 打的 ASCII；折成 `--` 的话它会变成 `----`，谁也撞不上。单个 `—` 两种折法都能撞。
  '—': '-', '–': '-', '−': '-',
  // `…` 反过来：单个撞得上，中文里那个 `……` 折成什么都接不住模型的 `...`。不值得为它
  // 再拧一次表——那一档留给 exact 和 line_trimmed。
  '…': '...',
  // Zs 空格族。中文排版里的全角空格 U+3000、法文里的窄不换行空格 U+202F 都在这儿。
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', '　': ' ',
}

// 上面那几行里的键是**看不见的字符**（各种宽度的空格），删一个改一个都不会有人发现，
// 所以有 e2e 逐个钉着它们。
//
// 字符类按码位拼，不把字符原样塞进 `[...]`：里面一旦出现 `-` 就成了范围，而那种错要等
// 到某天多加一个字符才发作。
const UNICODE_RE = new RegExp(
  `[${Object.keys(UNICODE_MAP)
    .map((c) => `\\u${c.codePointAt(0)!.toString(16).padStart(4, '0')}`)
    .join('')}]`,
  'g',
)

function unicodeNormalize(text: string): string {
  return text.replace(UNICODE_RE, (c) => UNICODE_MAP[c] ?? c)
}

/** 一个字符归一化之后有多长。`—` 会变成两个字符，所以偏移不是一一对应的。 */
function normWidth(c: string): number {
  return (UNICODE_MAP[c] ?? c).length
}

/** 切行，同时留下每行的起始偏移。行尾的 `\n` 不算进这一行。 */
function splitLines(text: string): { lines: string[]; starts: number[] } {
  const lines: string[] = []
  const starts: number[] = []
  let i = 0
  for (;;) {
    starts.push(i)
    const nl = text.indexOf('\n', i)
    if (nl === -1) {
      lines.push(text.slice(i))
      break
    }
    lines.push(text.slice(i, nl))
    i = nl + 1
  }
  return { lines, starts }
}

/** 逐行归一化的比较器。`i` 是窗口内的行号，`last` 是窗口最后一行的行号。 */
type LineNorm = (line: string, i: number, last: number) => string

/**
 * 按行滑窗找匹配。
 *
 * 只在**整行边界**上匹配——`old_string` 从半行开始的那种写法交给 `exact`。这一条限制
 * 是有意的：跨行的部分匹配一旦允许归一化，命中位置就开始靠猜了。
 */
function lineStrategy(content: string, pattern: string, norm: LineNorm): Span[] {
  const c = splitLines(content)
  const p = splitLines(pattern)
  const n = p.lines.length
  if (!n || n > c.lines.length) return []
  const want = p.lines.map((l, i) => norm(l, i, n - 1))
  const spans: Span[] = []
  for (let i = 0; i + n <= c.lines.length; i++) {
    let hit = true
    for (let j = 0; j < n; j++) {
      if (norm(c.lines[i + j], j, n - 1) !== want[j]) {
        hit = false
        break
      }
    }
    if (!hit) continue
    spans.push([c.starts[i], c.starts[i + n - 1] + c.lines[i + n - 1].length])
    // 窗口不重叠：重叠的命中在 replace_all 下会按过期偏移倒着写回去，把文件改花。
    i += n - 1
  }
  return spans
}

/** 策略一：原样。**只有它不放宽任何东西**，所以只有它之后不需要重新缩进。 */
function exact(content: string, pattern: string): Span[] {
  const spans: Span[] = []
  let at = 0
  for (;;) {
    const pos = content.indexOf(pattern, at)
    if (pos === -1) break
    spans.push([pos, pos + pattern.length])
    // 跳过整个命中，不是跳一个字符——`aa` 在 `aaaa` 里应当是两处，不是三处。
    at = pos + pattern.length
  }
  return spans
}

const trimEnds: LineNorm = (l) => l.trim()
const collapse: LineNorm = (l) => l.replace(/[ \t]+/g, ' ').trim()
const unicoded: LineNorm = (l) => unicodeNormalize(l).trim()

/** 字面量转义 → 真字符。模型把工具参数序列化成 JSON 时常常多留一层。 */
function unescapeLiteral(text: string): string {
  return text.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
}

/**
 * 五条，按**放宽的程度**从严到宽排，命中即停。
 *
 * 上游那份列了九条，我们只留五条，砍掉的四条分两类：
 *
 *  - `block_anchor` / `context_aware` 按相似度猜位置。**故意不要**——见文件顶上那段
 *  - `indentation_flexible`（只剥行首空白）和 `trimmed_boundary`（只放宽首尾两行）
 *    是**死代码**：`line_trimmed` 排在它们前面，而且严格更宽——凡是它俩能命中的，
 *    上一条已经命中了。留着只会让人以为多了两层保险
 */
const STRATEGIES: { name: string; find: (content: string, pattern: string) => Span[] }[] = [
  { name: 'exact', find: exact },
  { name: 'line_trimmed', find: (c, p) => lineStrategy(c, p, trimEnds) },
  { name: 'whitespace_normalized', find: (c, p) => lineStrategy(c, p, collapse) },
  {
    name: 'escape_normalized',
    find: (c, p) => {
      const unescaped = unescapeLiteral(p)
      if (unescaped === p) return []
      const hit = exact(c, unescaped)
      return hit.length ? hit : lineStrategy(c, unescaped, trimEnds)
    },
  },
  { name: 'unicode_normalized', find: (c, p) => lineStrategy(c, p, unicoded) },
]

/**
 * 这段文本是不是整段从 `read_file` 的输出里复制粘贴来的（每行都带 `123|` 行号前缀）。
 *
 * 判据有两条，第二条是为了不误伤：**行号必须是连着的**。只看「每行都是数字加竖线」的话，
 * 一张首列是编号的表（`1001|甲`、`1005|乙`）会被当成行号剥掉首列——那是把用户的数据
 * 当成显示格式扔了。真正的行号一定是 n、n+1、n+2。
 *
 * 只有一行时判不出连不连，按「是」算：整段复制粘贴一行也是常事，而单独一行 `12|甲`
 * 恰好是表格行的概率远低于它是复制来的行号。
 */
export function hasLineNumbers(text: string): boolean {
  const body = text.split('\n').filter((l) => l.trim() !== '')
  if (!body.length) return false
  const nums: number[] = []
  for (const line of body) {
    const m = /^\s*(\d+)\|/.exec(line)
    if (!m) return false
    nums.push(Number(m[1]))
  }
  for (let i = 1; i < nums.length; i++) if (nums[i] !== nums[i - 1] + 1) return false
  return true
}

/**
 * 剥掉行号前缀。
 *
 * 带着 `123|` 的 `old_string` 在文件里**永远**找不到，而报出来的却是「没找到那段文本」
 * ——最难自己走出来的一类失败。
 */
export function stripLineNumbers(text: string): string {
  if (!hasLineNumbers(text)) return text
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*\d+\|/, ''))
    .join('\n')
}

/**
 * 这次编辑是不是已经做过了。
 *
 * 生产上最常见的一类 `patch` 失败就是模型把落过盘的那次编辑又发了一遍。它的意图是
 * 「让文件里有这段话」，而文件里已经有了——报失败会让它回去重读、再改一次。
 *
 * 判据故意收得很紧：新文本要够长（短文本撞上是巧合，不是证据）、要**原样**出现在文件
 * 里（模糊出现不算），并且旧文本必须已经不在了（还在就说明只改了一半）。
 */
function alreadyApplied(content: string, oldString: string, newString: string): boolean {
  if (newString.trim().length < 8) return false
  if (!content.includes(newString)) return false
  if (oldString === newString) return true
  return !content.includes(oldString)
}

/**
 * 转义漂移：非 `exact` 命中时，`new_string` 里的 `\'` / `\"` 多半是传输层加的。
 *
 * 文件那一段里没有反斜杠转义，而替换文本里有——照写下去就是往文件里塞垃圾。这种情况
 * 宁可失败：模型重读一遍就好了，而写坏的文件没有任何东西会提醒它。
 */
function escapeDrift(region: string, newString: string): boolean {
  return /\\['"]/.test(newString) && !/\\['"]/.test(region)
}

const INDENT_RE = /^[ \t]*/

/**
 * 按文件的实际缩进重排替换文本。
 *
 * 非 `exact` 命中意味着文件的缩进和模型手里那份不一样（它写两格、文件是四格）。照原样
 * 写回去，改过的那几行缩进就和周围对不上了。
 */
function reindent(region: string, pattern: string, replacement: string): string {
  const fileIndent = INDENT_RE.exec(region.split('\n')[0] ?? '')?.[0] ?? ''
  const patIndent = INDENT_RE.exec(pattern.split('\n')[0] ?? '')?.[0] ?? ''
  if (fileIndent === patIndent) return replacement
  // 一方是另一方的前缀才动。不是前缀（一个用制表符一个用空格）就别猜，原样写。
  if (fileIndent.startsWith(patIndent)) {
    const add = fileIndent.slice(patIndent.length)
    return replacement
      .split('\n')
      .map((l) => (l.trim() === '' ? l : add + l))
      .join('\n')
  }
  if (patIndent.startsWith(fileIndent)) {
    const drop = patIndent.slice(fileIndent.length)
    return replacement
      .split('\n')
      .map((l) => (l.startsWith(drop) ? l.slice(drop.length) : l))
      .join('\n')
  }
  return replacement
}

/**
 * 排版字符保留：`unicode_normalized` 命中时，文件里是全角空格和中文引号，模型手里是
 * ASCII。照 `new_string` 原样写回去，等于把整段排版**静默**换成半角——那是没人会发现
 * 的破坏。
 *
 * 做法是掐头去尾：`new_string` 与归一化后的 `old_string` 的公共前后缀是「没改的部分」，
 * 那两段从**文件原文**里取；中间那段是模型真正要改的，用它写的。
 *
 * 上游用 SequenceMatcher 逐段对齐，能保住交错未改部分的排版；我们这版在头尾之外会丢。
 * 换来的是没有 LCS、没有长度上限、结果完全可预测——而真实的编辑，未改的部分几乎总在
 * 头尾。
 */
function preserveUnicode(region: string, oldString: string, newString: string): string {
  const normOld = unicodeNormalize(oldString)
  const normRegion = unicodeNormalize(region)
  // 归一化之后对不上，说明这条策略本不该命中。别猜，原样返回。
  if (normOld.trim() !== normRegion.trim()) return newString

  const max = Math.min(normRegion.length, newString.length)
  let head = 0
  while (head < max && normRegion[head] === newString[head]) head++
  let tail = 0
  while (
    tail < max - head &&
    normRegion[normRegion.length - 1 - tail] === newString[newString.length - 1 - tail]
  ) {
    tail++
  }

  // 归一化会让长度变，所以头尾在**原文**里的位置要边走边数。
  let headEnd = 0
  for (let seen = 0; headEnd < region.length && seen < head; headEnd++) {
    seen += normWidth(region[headEnd])
  }
  let back = 0
  for (let seen = 0; back < region.length && seen < tail; back++) {
    seen += normWidth(region[region.length - 1 - back])
  }
  const tailStart = Math.max(headEnd, region.length - back)
  return region.slice(0, headEnd) + newString.slice(head, newString.length - tail) + region.slice(tailStart)
}

/** 偏移 → 行号（0 起）。 */
function lineOf(starts: number[], offset: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return lo
}

const DIFF_CONTEXT = 3
const MAX_DIFF_CHARS = 4000

/**
 * 统一差异格式。
 *
 * 不跑通用 diff 算法：我们**确切知道**哪几段被换了（`spans`），行号和内容直接算得出来。
 * 顺带也就没有「大文件跑不动」这回事。
 */
function unifiedDiff(path: string, before: string, spans: Span[], parts: string[]): string {
  const { lines, starts } = splitLines(before)
  const lineEnd = (i: number) => starts[i] + lines[i].length

  // 每一段展开成整行，连同换出去的新行一起。
  const edits = spans.map(([s, e], i) => {
    const a = lineOf(starts, s)
    const b = lineOf(starts, Math.max(s, e - 1))
    const head = before.slice(starts[a], s)
    const tail = before.slice(e, lineEnd(b))
    return { a, b, old: lines.slice(a, b + 1), new: (head + parts[i] + tail).split('\n') }
  })

  // 上下文挨上的合并成一个 hunk，否则同一行会在两个 hunk 里各出现一次。
  const groups: (typeof edits)[] = []
  for (const ed of edits) {
    const last = groups[groups.length - 1]
    const prev = last?.[last.length - 1]
    if (last && prev && ed.a - prev.b <= DIFF_CONTEXT * 2) last.push(ed)
    else groups.push([ed])
  }

  const out: string[] = [`--- a/${path}`, `+++ b/${path}`]
  let drift = 0
  for (const g of groups) {
    const from = Math.max(0, g[0].a - DIFF_CONTEXT)
    const to = Math.min(lines.length - 1, g[g.length - 1].b + DIFF_CONTEXT)
    const body: string[] = []
    let cursor = from
    for (const ed of g) {
      for (; cursor < ed.a; cursor++) body.push(` ${lines[cursor]}`)
      for (const l of ed.old) body.push(`-${l}`)
      for (const l of ed.new) body.push(`+${l}`)
      cursor = ed.b + 1
    }
    for (; cursor <= to; cursor++) body.push(` ${lines[cursor]}`)
    const oldCount = to - from + 1
    const newCount = body.filter((l) => l[0] !== '-').length
    out.push(`@@ -${from + 1},${oldCount} +${from + 1 + drift},${newCount} @@`, ...body)
    drift += newCount - oldCount
  }
  const text = out.join('\n')
  return text.length <= MAX_DIFF_CHARS
    ? text
    : `${text.slice(0, MAX_DIFF_CHARS)}\n…（差异太长已截断）`
}

/**
 * 找到并替换。永远不抛——失败是业务结果，由调用方写成给模型看的一句话。
 */
export function fuzzyReplace(
  path: string,
  content: string,
  rawOld: string,
  newString: string,
  replaceAll: boolean,
): PatchOk | PatchErr {
  const numbered = hasLineNumbers(rawOld)
  const oldString = numbered ? stripLineNumbers(rawOld) : rawOld
  /**
   * `old_string` 剥了前缀，`new_string` **不剥**——那一侧是要写进文件的字节，谁也不敢
   * 替模型决定 `12|` 是显示格式还是正文。
   *
   * 但两边都带前缀时必须当场拦下：模型整块复制下来、改一行、两个参数都贴回来，是它
   * 最自然的动作，而照着写下去就是把 `12|const a = 1` 落进文件，还报成功——文件被改坏
   * 了，没有任何东西会提醒任何人。
   */
  if (numbered && hasLineNumbers(newString)) {
    return {
      ok: false,
      message:
        'new_string 里也带着行号前缀（`123|`）。那是 read_file 的显示格式，不是文件里的内容——' +
        '照写下去会把行号落进文件。old_string 可以带（会自动剥掉），new_string 要按文件里真正该有的样子写。',
    }
  }
  if (oldString === newString) {
    return {
      ok: false,
      message:
        'old_string 与 new_string 相同，没有可改的东西。old_string 写要被替换掉的原文，new_string 写改成什么样。',
    }
  }

  const starts = splitLines(content).starts
  for (const { name, find } of STRATEGIES) {
    const spans = find(content, oldString)
    if (!spans.length) continue

    if (spans.length > 1 && !replaceAll) {
      const where = spans.slice(0, 5).map(([s]) => `第 ${lineOf(starts, s) + 1} 行`).join('、')
      return {
        ok: false,
        message:
          `那段文本出现了 ${spans.length} 次（${where}${spans.length > 5 ? ' …' : ''}）。` +
          '多带几行上下文让它唯一，或者置 replace_all=true 全部替换。',
      }
    }

    const parts: string[] = []
    for (const [s, e] of spans) {
      const region = content.slice(s, e)
      if (name !== 'exact' && escapeDrift(region, newString)) {
        return {
          ok: false,
          message:
            'new_string 里带着 \\\' 或 \\" 这样的转义，而文件里那一段没有——照写下去会把反斜杠留在文件里。' +
            '先用 read_file 看一眼原文，把引号按原样写进来再试。',
        }
      }
      let piece = newString
      if (name === 'escape_normalized') piece = unescapeLiteral(piece)
      if (name !== 'exact') piece = reindent(region, oldString, piece)
      if (name === 'unicode_normalized') piece = preserveUnicode(region, oldString, piece)
      parts.push(piece)
    }

    // 倒着写回去，前面那些命中的偏移才不会失效。
    let text = content
    for (let i = spans.length - 1; i >= 0; i--) {
      text = text.slice(0, spans[i][0]) + parts[i] + text.slice(spans[i][1])
    }
    return {
      ok: true,
      text,
      count: spans.length,
      strategy: name,
      diff: unifiedDiff(path, content, spans, parts),
    }
  }

  if (alreadyApplied(content, oldString, newString)) {
    return { ok: false, applied: true, message: '这段改动已经在文件里了，没有重复写入。' }
  }
  return {
    ok: false,
    message:
      `没找到那段文本。先用 read_file 确认 ${path} 里的原文——空白和缩进可以对不上，` +
      '但字要一个不差；**old_string** 里的行号前缀（`123|`）会自动剥掉，new_string 不会，' +
      '那一侧要按文件里真正该有的样子写。',
  }
}
