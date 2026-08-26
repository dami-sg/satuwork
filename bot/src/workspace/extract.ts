import { stat } from 'node:fs/promises'
import { extname } from 'node:path'

/**
 * 把 PDF / Word / Excel 提取成纯文本，好让 `read` 能读它们。
 *
 * **在 read 的时候转，不在上传的时候转。** 一份 50 页的 PDF 转出来几万 token，上传即转
 * 等于每次对话都把它整个灌进上下文；而 `read` 本来就有 offset/limit，模型想读哪段读
 * 哪段。原文件也照旧留着，要用 terminal 另做处理还有得用。
 *
 * 三个库都是**动态 import**：它们加起来不小，而绝大多数会话一个文档都不会读。放在
 * 模块顶上会让每个 bot 进程的启动都为此付钱。
 *
 * 有一类文件这里救不了：**扫描件 PDF 没有文本层**，提取出来是空的。那种要么 OCR、
 * 要么渲染成图走视觉——都不在这一层，所以下面遇到空结果时会明说，而不是返回一片空白
 * 让人以为文件坏了。
 */

export type DocKind = 'pdf' | 'docx' | 'xlsx' | 'pptx'

const KINDS: Record<string, DocKind> = {
  '.pdf': 'pdf',
  '.docx': 'docx',
  '.xlsx': 'xlsx',
  '.xlsm': 'xlsx',
  '.pptx': 'pptx',
}

/** 这个文件名要不要走提取。`.doc` / `.xls` 那两种老二进制格式不在内。 */
export function docKindOf(name: string): DocKind | null {
  return KINDS[extname(name).toLowerCase()] ?? null
}

export interface Extracted {
  /** 提取出来的纯文本，段之间已经插好分隔标记。 */
  text: string
  /** 分成了几段。 */
  parts: number
  /** 段的称呼，用在给模型的说明里。 */
  unit: string
  /** 因为超限被截掉了尾巴。 */
  truncated: boolean
}

/** PDF 页数上限。再多的文档，模型也不会一次读完，先给前面这些。 */
const MAX_PAGES = 300
/** 每个工作表的行数上限。 */
const MAX_ROWS = 5000
/** 幻灯片页数上限。理由同 MAX_PAGES。 */
const MAX_SLIDES = 300

/**
 * 肯提取的文件大小上限。
 *
 * 这三个库都是**整个文件读进内存再解析**，而 exceljs 把工作簿摊成对象图之后常常是
 * 原文件的五到十倍。上传上限默认 100 MiB，也就是说不设这道闸，任何人传一个 90 MB 的
 * xlsx 再让 Bot read 一下，就能把这个席位的进程撑爆——而 MAX_PAGES / MAX_ROWS 是解析
 * 完才生效的，拦不住这一步。
 *
 * 超限不是「读不了」，只是「不给自动转」：原文件还在，模型仍可以用 terminal 自己处理。
 */
const MAX_DOC_BYTES = 25 * 1024 * 1024

/**
 * 提取结果的小缓存。
 *
 * 模型读一份长 PDF 会分好几次（offset 一页页往后翻），每次都重新解析一遍整个文件既慢
 * 又白烧 CPU。键里带 mtime 和 size：文件被改过就自然不命中，不需要额外的失效逻辑。
 */
const CACHE = new Map<string, Extracted>()
const CACHE_MAX = 4

function cacheGet(key: string): Extracted | undefined {
  const hit = CACHE.get(key)
  // 命中就挪到末尾，让 CACHE_MAX 那一刀砍的总是最久没用的那份。
  if (hit) {
    CACHE.delete(key)
    CACHE.set(key, hit)
  }
  return hit
}

function cachePut(key: string, value: Extracted) {
  CACHE.set(key, value)
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value as string)
}

export async function extractDocument(file: string, kind: DocKind): Promise<Extracted> {
  const info = await stat(file)
  if (info.size > MAX_DOC_BYTES) {
    return {
      text:
        `这个文件有 ${(info.size / 1024 / 1024).toFixed(1)} MB，超过了自动转文本的上限` +
        `（${MAX_DOC_BYTES / 1024 / 1024} MB），没有解析。\n` +
        '文件本身还在，可以用 terminal 里的命令行工具挑需要的部分出来。',
      parts: 0,
      unit: '段',
      truncated: true,
    }
  }
  const key = `${kind}|${file}|${info.mtimeMs}|${info.size}`
  const hit = cacheGet(key)
  if (hit) return hit
  const out =
    kind === 'pdf'
      ? await fromPdf(file)
      : kind === 'docx'
        ? await fromDocx(file)
        : kind === 'pptx'
          ? await fromPptx(file)
          : await fromXlsx(file)
  cachePut(key, out)
  return out
}

async function fromPdf(file: string): Promise<Extracted> {
  const { readFile } = await import('node:fs/promises')
  const { extractText, getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(await readFile(file)))
  const { text } = await extractText(pdf, { mergePages: false })
  const pages = Array.isArray(text) ? text : [String(text)]
  const truncated = pages.length > MAX_PAGES
  const use = truncated ? pages.slice(0, MAX_PAGES) : pages
  const body = use.map((p, i) => `${divider(`第 ${i + 1} 页 / 共 ${pages.length} 页`)}\n${String(p ?? '').trim()}`).join('\n\n')
  // 一个字都没提出来，几乎一定是扫描件。说清楚，否则看起来像文件坏了，模型会去
  // 反复重试同一个 read。
  const blank = use.every((p) => !String(p ?? '').trim())
  return {
    text: blank
      ? `${body}\n\n（这份 PDF 里没有文字层，多半是扫描件或者纯图片。它的内容读不出来——要看的话得用能识图的办法。）`
      : body,
    parts: pages.length,
    unit: '页',
    truncated,
  }
}

/**
 * PowerPoint。
 *
 * pptx 就是一个 zip：正文在 `ppt/slides/slideN.xml` 里，文字落在 `<a:t>` 元素上，
 * `<a:p>` 是一个段落。**不引 XML 解析器**——这里只需要按标签取文本，而这些文件是
 * PowerPoint 自己生成的、结构固定；引一个完整的解析器要多背一个依赖，还得处理它对
 * 命名空间的那套脾气。
 *
 * 排序必须**按数字**取：`slide10.xml` 在字典序里排在 `slide2.xml` 前面，直接 sort
 * 出来的页码是乱的。
 *
 * 备注（`notesSlides/`）不取：那是讲稿，跟版面上的内容常常重复，而且一份带备注的
 * 演示文稿提出来会翻一倍。要看备注的话原文件还在。
 */
async function fromPptx(file: string): Promise<Extracted> {
  const { readFile } = await import('node:fs/promises')
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(await readFile(file))
  const slides = Object.keys(zip.files)
    .map((name) => ({ name, n: Number(/^ppt\/slides\/slide(\d+)\.xml$/.exec(name)?.[1] ?? NaN) }))
    .filter((x) => Number.isFinite(x.n))
    .sort((a, b) => a.n - b.n)
  if (!slides.length) {
    return { text: '（这个 pptx 里没有幻灯片，或者它不是标准的 Office Open XML 文件。）', parts: 0, unit: '页', truncated: false }
  }
  const truncated = slides.length > MAX_SLIDES
  const use = truncated ? slides.slice(0, MAX_SLIDES) : slides
  const parts: string[] = []
  for (let i = 0; i < use.length; i++) {
    const xml = await zip.files[use[i].name].async('string')
    // 页码用**位置**而不是文件名里那个数字，和 fromPdf 一致。编号万一不连续
    // （手工拼出来的包会这样），拿文件名里的数字就会写出「第 10 页 / 共 3 页」。
    parts.push(`${divider(`第 ${i + 1} 页 / 共 ${slides.length} 页`)}\n${slideText(xml)}`)
  }
  const body = parts.join('\n\n')
  const blank = !body.replace(/第 \d+ 页[^\n]*/g, '').trim()
  return {
    text: blank
      ? `${body}\n\n（这份演示文稿里没有可提取的文字，多半整页都是图片。）`
      : body,
    parts: slides.length,
    unit: '页',
    truncated,
  }
}

/** 一页幻灯片的 XML → 文本。`<a:p>` 一段一行，段内的 `<a:t>` 直接拼起来。 */
function slideText(xml: string): string {
  const lines: string[] = []
  for (const para of xml.match(/<a:p[ >][\s\S]*?<\/a:p>/g) ?? []) {
    const line = [...para.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
      .map((m) => unxml(m[1]))
      .join('')
      .trim()
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

/** XML 实体还原。只有这五个——Office 写出来的正文里不会有别的。 */
function unxml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

async function fromDocx(file: string): Promise<Extracted> {
  const mammoth = (await import('mammoth')).default
  /**
   * 走 HTML 再自己转，**不用 mammoth 的 convertToMarkdown**。
   *
   * 那个 API 官方标了 deprecated，而且实测会把表格拍平：`<table>` 里的行列关系没了，
   * 变成一列孤零零的文本。`extractRawText` 同样。业务文档里表格恰恰是最该留住的东西，
   * 所以只能从 HTML 转——那是唯一保住了结构的输出。
   *
   * `convertImage` 必须给：默认会把嵌入图片转成 base64 data URI 塞进 HTML，一份带图的
   * 文档能撑出几 MB，而那些字节对模型一点用都没有。
   */
  const { value } = await mammoth.convertToHtml(
    { path: file },
    { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: '' })) },
  )
  const text = htmlToMarkdown(String(value ?? '')).trim()
  return { text: text || '（这个文档里没有正文。）', parts: 1, unit: '篇', truncated: false }
}

/**
 * mammoth 输出的 HTML → Markdown。
 *
 * **只针对 mammoth 的输出**，不是通用的 HTML 解析器：它产出的标签集很小、良构、几乎
 * 没有属性，所以这里够用。拿去解互联网上的 HTML 会散架。
 *
 * 表格单独先摘出来处理——它是唯一需要看结构的东西，剩下的都能按行内替换做掉。
 */
function htmlToMarkdown(html: string): string {
  const withTables = html.replace(/<table[\s\S]*?<\/table>/gi, (t) => `\n\n${tableToMarkdown(t)}\n\n`)
  return blocksToMarkdown(withTables)
}

function tableToMarkdown(html: string): string {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => inlineText(c[1]).replace(/\|/g, '\\|')),
  )
  if (!rows.length) return ''
  const width = Math.max(...rows.map((r) => r.length))
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')]
  const line = (r: string[]) => `| ${pad(r).join(' | ')} |`
  // Word 的表格第一行几乎总是表头；就算不是，多一行分隔线也不会让人读错。
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n')
}

function blocksToMarkdown(html: string): string {
  let s = html
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, inner) => `\n\n${'#'.repeat(Number(n))} ${inlineText(inner)}\n\n`)
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${inlineText(inner)}`)
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, inner) => `\n\n> ${inlineText(inner)}\n\n`)
  s = s.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_, inner) => `\n\n${inlineText(inner)}\n\n`)
  s = s.replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
  return inlineText(s).replace(/\n{3,}/g, '\n\n')
}

/** 行内标签 → Markdown，剩下的标签一律剥掉。实体也在这里还原。 */
function inlineText(html: string): string {
  let s = html
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) => `**${inner}**`)
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_, __, inner) => `*${inner}*`)
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, inner) => `[${inner}](${href})`)
  // 图片的 src 已经被 convertImage 清空了，这里只留一个记号——不然读的人会以为
  // 文档到这儿断了一截。
  s = s.replace(/<img[^>]*>/gi, '[图片]')
  s = s.replace(/<[^>]+>/g, '')
  return decodeEntities(s).replace(/[ \t]+/g, ' ').trim()
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    // & 放最后，否则 `&amp;lt;` 会被解成 `<`
    .replace(/&amp;/g, '&')
}

async function fromXlsx(file: string): Promise<Extracted> {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(file)
  const blocks: string[] = []
  let truncated = false
  wb.eachSheet((sheet) => {
    const rows: string[] = []
    // CSV 而不是别的表示法：模型见得最多，而且一行一条记录，行号和 read 的分页对得上。
    //
    // 上限按**已经收了多少行**算，不能按回调里的 `n`——那是工作表里的行号，会跳号。
    // 一张数据从第 8000 行才开始的稀疏表，按 n 判断的话第一行就超限，整表被丢空，
    // 输出成「0 行 + 已截断」，而模型会据此回答「这个表是空的」。
    sheet.eachRow({ includeEmpty: false }, (row) => {
      if (rows.length >= MAX_ROWS) {
        truncated = true
        return
      }
      const values = Array.isArray(row.values) ? row.values.slice(1) : []
      rows.push(values.map(cellText).map(csvCell).join(','))
    })
    blocks.push(`${divider(`工作表：${sheet.name}（${rows.length} 行）`)}\n${rows.join('\n')}`)
  })
  return {
    text: blocks.length ? blocks.join('\n\n') : '（这个工作簿是空的。）',
    parts: blocks.length,
    unit: '个工作表',
    truncated,
  }
}

function divider(label: string): string {
  return `───── ${label} ─────`
}

/**
 * 单元格 → 文本。
 *
 * exceljs 的值不只有字符串和数字：公式是 `{formula, result}`、富文本是 `{richText}`、
 * 超链接是 `{text, hyperlink}`。不摊平的话它们会被 String() 成 `[object Object]`，
 * 而那正是**看起来有数据、其实全是垃圾**的那种坏法。
 */
function cellText(v: unknown): string {
  if (v == null) return ''
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>
    // 公式取缓存的计算结果——模型要的是数，不是 `=SUM(A1:A9)`。
    if ('result' in o) return cellText(o.result)
    if ('richText' in o && Array.isArray(o.richText)) return o.richText.map((r: any) => r?.text ?? '').join('')
    if ('text' in o) return cellText(o.text)
    if ('error' in o) return String(o.error)
    return ''
  }
  return String(v)
}

/** CSV 转义。含逗号、引号、换行的要包起来，否则列会错位。 */
function csvCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
