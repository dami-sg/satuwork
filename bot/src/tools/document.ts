import type { Context } from '@deepseek-ai/cordis'
import { fetchDocuments, WebFailure, type DocumentPage } from '../web-search/index.ts'
import type { WorkspaceFile } from './index.ts'

/**
 * `document_read`：读一份**网上的**文档（PDF / Word / Excel）。
 *
 * **为什么不和 `web_extract` 合成一把。** 它们只是「都从一个网址开始」，此外没有一处
 * 相同：
 *
 * - **成本不同。** 网页正文是买来的提取后端给的，按它的额度算钱；文档是我们自己下的，
 *   花的是带宽。合成一把，账就只能记在一个名义下，而那个名义必然有一半是假的。
 * - **依赖不同。** 这把工具**不需要配任何后端**——一套刚装好、还没买 key 的部署，读
 *   PDF 也是通的。合在一起的话，「没配提取后端」会把读文档一起挡住，而它本来不该被挡。
 * - **失败方式不同。** 网页失败是「抓不到正文」，文档失败是「没有文字层」（扫描件）
 *   或「这格式我们解不了」。两种失败要说给模型听的话完全不一样。
 * - **给模型的语义不同。** 一把工具一件事，模型选起来才准。`web_extract` 的描述里写
 *   「只管网页，文档用 document_read」，比在一把工具的描述里塞两种行为可靠得多。
 *
 * **只接网址。** 工作区里已经有的文件归 `read` 管——它自带 offset/limit 分页，对一份
 * 三百页的 PDF 比这把好用。两把工具不该抢同一件事。
 *
 * 原件**一定落盘**：它本身就是产出，人多半还要自己打开看；而提取那条路
 * （`workspace/extract.ts` 的 unpdf / mammoth / exceljs）本来也得先有个文件。
 */
export const name = 'satu-tools-document'
export const inject = ['tools', 'websearch']

/** 一次调用整体进上下文的量。和 web_extract 同一条闸。 */
const TOTAL_MAX = 12_000

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/**
 * 文档正文和网页正文一样，是**从外面取回来的数据，不是指令**——一份 PDF 里同样可以
 * 写「忽略你之前的指示」。所以用同一个标签包起来，system 里那句定性对它一并生效。
 */
function wrap(url: string, body: string): string {
  return `<web_content url="${url}">\n${body}\n</web_content>`
}

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'document_read',
    description:
      '读一份网上的文档：PDF、Word（.docx）、Excel（.xlsx/.xlsm）。原件会存进工作区 web/ 目录，正文取出来给你，太长时先摘要——用 goal 说明你关心什么。网页请用 web_extract；工作区里已经有的文件请用 read（它能分页读）。',
    parameters: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: '1–5 个文档地址。' },
        goal: { type: 'string', description: '你要从这些文档里找什么。摘要时会围着它取舍。' },
      },
      required: ['urls'],
    },
    async execute(args) {
      const a = (args ?? {}) as { urls?: unknown; goal?: string }
      const urls = Array.isArray(a.urls) ? a.urls.map(String) : typeof a.urls === 'string' ? [a.urls] : []
      if (!urls.length) return { text: 'urls 不能为空。' }
      const goal = oneLine(String(a.goal ?? ''))
      try {
        const out = await fetchDocuments(urls)
        const files: WorkspaceFile[] = []
        const blocks: string[] = []
        let budget = TOTAL_MAX
        for (const page of out.pages) {
          const block = await renderDocument(ctx, page, goal, files, budget)
          budget -= block.length
          blocks.push(block)
          if (budget <= 0 && page !== out.pages[out.pages.length - 1]) {
            blocks.push(`（其余 ${out.pages.length - blocks.length} 份没有展开：一次能进上下文的量到顶了。原件都在工作区里，用 read 自己翻。）`)
            break
          }
        }
        return { text: blocks.join('\n\n'), ...(files.length ? { files } : {}) }
      } catch (e) {
        // 业务失败（配额、地址不对、上游 404）都是文本：模型看到文本才知道该改什么。
        if (e instanceof WebFailure) return { text: e.message }
        return { text: `读文档失败：${(e as Error).message}`, failed: true }
      }
    },
  })
}

/** 一份一段。**部分失败不是失败**：失败那份写清楚，其余照常。 */
async function renderDocument(
  ctx: Context,
  page: DocumentPage,
  goal: string,
  files: WorkspaceFile[],
  budget: number,
): Promise<string> {
  const head = `── ${page.url} ──`
  if (!page.ok || !page.document) return `${head}\n${page.error ?? '取不到这份文档'}`

  const title = oneLine(page.title ?? '') || page.url
  let saved: { path: string; name: string; text: string }
  try {
    saved = await ctx.websearch.document(page.url, title, page.document)
  } catch (e) {
    return `${head}\n标题：${title}\n文档取回来了，但存不进工作区：${(e as Error).message}`
  }
  files.push({ path: saved.path, name: saved.name })

  const size = `${Math.round((page.document.bytes / 1024) * 10) / 10} KB`
  const lines = [head, `标题：${title} · ${size} · 已保存：${saved.path}`]
  if (!saved.text.trim()) {
    // 扫描件没有文字层，提取出来是空的。这里必须明说——返回一片空白会让模型以为
    // 文件坏了，反复重试同一条路；说清楚它才会换个办法（比如让人看一眼）。
    lines.push('', '这份文档提不出文字（扫描件多半没有文字层）。原件已经在工作区里，可以用 bash 另想办法。')
    return lines.join('\n')
  }
  const condensed = await ctx.websearch.condense(saved.text, goal)
  lines[1] += ` · ${condensed.summarized ? '已摘要' : condensed.note || '原文'}`
  lines.push('', wrap(page.url, clip(condensed.text, Math.max(budget, 1_000))))
  return lines.join('\n')
}
