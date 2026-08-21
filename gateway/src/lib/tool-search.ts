/**
 * 工具搜索：工具多到装不下时，那一把连接改为下发三个元工具。
 *
 * 见 docs/tool-search.md。这里只有纯函数——分档、估长度、搜、渲染清单，路由那边
 * （routes/mcp.ts）负责接进 JSON-RPC 和计费。分开是为了 e2e 能直接对着算术验，
 * 不用先架一台假 Composio。
 */
import type { ToolDef } from '../connectors/index.ts'
import { MAX_TOOLS } from './connectors.ts'

/**
 * 元工具的名字。
 *
 * `SW_` 是我们的命名空间，**为的是不跟供应商的真工具撞**：Composio 的 GitHub 里就有
 * 一堆 `GITHUB_SEARCH_*`。更要紧的是 `resolveToolSlug` 会给不带前缀的名字**无条件补**
 * toolkit 前缀，叫 `SEARCH` 的话会被还原成 `GITHUB_SEARCH`——一个真实存在、完全不相干
 * 的工具。那种 bug 跑得通、结果全错、日志上还看不出来。
 */
export const SEARCH_TOOL = 'SW_SEARCH'
export const DESCRIBE_TOOL = 'SW_DESCRIBE'
export const RUN_TOOL = 'SW_RUN'

/**
 * 这一把连接这一轮下发哪一档。
 *
 * - `direct`：全量工具，今天的行为
 * - `listing`：三个元工具 + 完整清单（名字 + 一句话）嵌在 `SW_SEARCH` 的说明里
 * - `search`：三个元工具 + 一行摘要，清单本身也塞不下了
 */
export type ToolMode = 'direct' | 'listing' | 'search'

/** `auto` 按工具数分档；`on` 强制降级（评测用）；`off` 退回截断。 */
const MODE_SETTING = (() => {
  const raw = (process.env.CONNECTOR_TOOL_SEARCH || 'auto').trim().toLowerCase()
  return raw === 'on' || raw === 'off' ? raw : 'auto'
})()

/** 第 1 档和第 2 档的分界。 */
const LISTING_MAX_TOKENS = Math.max(0, Math.trunc(Number(process.env.CONNECTOR_LISTING_MAX_TOKENS) || 4000))

/** `SW_SEARCH` 默认返回几条，以及模型传再大也压到几条。 */
export const SEARCH_LIMIT = Math.max(1, Math.trunc(Number(process.env.CONNECTOR_SEARCH_LIMIT) || 5))
export const SEARCH_MAX_LIMIT = Math.max(SEARCH_LIMIT, Math.trunc(Number(process.env.CONNECTOR_SEARCH_MAX_LIMIT) || 20))

/**
 * 长度粗估。
 *
 * **故意不引 tokenizer**：这里只要「塞不塞得下」的量级判断，为它多一个依赖、还得跟着
 * 模型换，不值。三个字符一个 token 是中英混排的保守值，宁可高估。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3)
}

/** 描述取第一行、截到 120 字：清单是目录，不是文档。要细节去 `SW_DESCRIBE`。 */
function oneLine(text: string): string {
  const line = String(text || '').split('\n')[0]!.trim()
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/** 清单正文：一行一个工具。`listing` 档把它整个嵌进 `SW_SEARCH` 的说明里。 */
export function renderListing(tools: ToolDef[]): string {
  return tools.map((t) => `${t.slug} — ${oneLine(t.description || t.name)}`).join('\n')
}

export function toolModeOf(tools: ToolDef[]): ToolMode {
  if (MODE_SETTING === 'off') return 'direct'
  if (MODE_SETTING === 'auto' && tools.length <= MAX_TOOLS) return 'direct'
  return estimateTokens(renderListing(tools)) <= LISTING_MAX_TOKENS ? 'listing' : 'search'
}

/** 席位传回来的名字是不是元工具。**这一步必须排在 `resolveToolSlug` 前面。** */
export function metaToolOf(name: string): 'search' | 'describe' | 'run' | null {
  const upper = String(name || '').trim().toUpperCase()
  if (upper === SEARCH_TOOL) return 'search'
  if (upper === DESCRIBE_TOOL) return 'describe'
  if (upper === RUN_TOOL) return 'run'
  return null
}

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * 三个元工具的定义。
 *
 * 说明是写给模型看的，所以把「这里一共多少个、该怎么找」说全：模型看不到工具表之外的
 * 任何东西，说明里没写的它就不知道。
 */
export function metaToolDefs(toolkit: string, tools: ToolDef[], mode: ToolMode): McpTool[] {
  const name = toolkit.toUpperCase()
  const listing = mode === 'listing' ? `\n\n这把连接的全部工具：\n${renderListing(tools)}` : ''
  return [
    {
      name: SEARCH_TOOL,
      description:
        `在 ${name} 这把连接里找工具。它一共有 ${tools.length} 个工具，太多了装不进工具表，` +
        `所以先用这个搜，再用 ${DESCRIBE_TOOL} 看参数，最后用 ${RUN_TOOL} 调。` +
        `查询用英文关键词效果最好（工具名是英文的）。${listing}`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要找什么，例如 send email / create issue' },
          limit: { type: 'integer', description: `返回几条，默认 ${SEARCH_LIMIT}，最多 ${SEARCH_MAX_LIMIT}` },
        },
        required: ['query'],
      },
    },
    {
      name: DESCRIBE_TOOL,
      description: `看 ${name} 里某一个工具的完整参数。工具名从 ${SEARCH_TOOL} 的结果里来。`,
      inputSchema: {
        type: 'object',
        properties: { tool: { type: 'string', description: `工具名，例如 ${tools[0]?.slug ?? `${name}_SOMETHING`}` } },
        required: ['tool'],
      },
    },
    {
      name: RUN_TOOL,
      description: `真正调用 ${name} 里的一个工具。参数先用 ${DESCRIBE_TOOL} 看清楚，不要猜。`,
      inputSchema: {
        type: 'object',
        properties: {
          tool: { type: 'string', description: '工具名' },
          args: { type: 'object', description: '这个工具自己的参数，形状以 ' + DESCRIBE_TOOL + ' 给的为准' },
        },
        required: ['tool', 'args'],
      },
    },
  ]
}

/**
 * 本地搜。**不打上游**——清单本来就在 `toolsOf()` 那份五分钟缓存里，为一次搜索多一趟
 * 网络往返没有道理，还会牵出「搜索算不算一次调用」的计费争论（docs/tool-search.md §7）。
 *
 * 打分：命中 slug 最重，其次 name，最后 description。命中的**不同词**越多越靠前——
 * 「send email」应该排在只中一个 send 的前面。同分按 slug 排，**结果必须是确定的**，
 * 不然 e2e 只能验条数验不了内容。
 */
export function searchTools(tools: ToolDef[], query: string, limit: number): ToolDef[] {
  const terms = [...new Set(String(query || '').toLowerCase().split(/[^a-z0-9一-鿿]+/i).filter(Boolean))]
  if (!terms.length) return []
  const scored: { tool: ToolDef; score: number }[] = []
  for (const tool of tools) {
    const slug = tool.slug.toLowerCase()
    const name = (tool.name || '').toLowerCase()
    const desc = (tool.description || '').toLowerCase()
    let score = 0
    let hits = 0
    for (const term of terms) {
      const point = slug.includes(term) ? 8 : name.includes(term) ? 4 : desc.includes(term) ? 1 : 0
      if (point) hits++
      score += point
    }
    if (score > 0) scored.push({ tool, score: score + hits * 2 })
  }
  scored.sort((a, b) => b.score - a.score || a.tool.slug.localeCompare(b.tool.slug))
  return scored.slice(0, Math.max(1, Math.min(limit, SEARCH_MAX_LIMIT))).map((s) => s.tool)
}

/** 搜索结果的正文。命中了就一行一个「名字 — 一句话」。 */
export function renderHits(hits: ToolDef[]): string {
  return `找到 ${hits.length} 个：\n${renderListing(hits)}\n\n用 ${DESCRIBE_TOOL} 看参数，再用 ${RUN_TOOL} 调。`
}

/**
 * 搜不到时说的话。
 *
 * **不许回空数组。** 空结果在模型眼里等于「这个工具不存在」，它会转头告诉用户做不到——
 * 这就是静默截断换了个马甲，要在同一个地方掐掉。所以这句里必须有三样东西：一共多少个、
 * 刚才搜的是什么、下一步该怎么试。
 */
export function renderMiss(toolkit: string, tools: ToolDef[], query: string): string {
  const sample = tools.slice(0, 5).map((t) => t.slug).join('、')
  return (
    `${toolkit} 这把连接有 ${tools.length} 个工具，「${query}」没有命中任何一个。` +
    `换几个英文关键词再试一次（工具名是英文的）。` +
    (sample ? `这里有几个例子，可以照着感觉一下命名习惯：${sample}。` : '')
  )
}
