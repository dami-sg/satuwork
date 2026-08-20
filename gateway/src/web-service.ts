/**
 * 网页工具的业务层：配置取用、后端派发、计量计价。
 *
 * 路由层只负责鉴权和收参数，这里负责「用哪家后端、拿哪把密钥、这一次算多少钱」。
 * 摆成单独一层是因为这三件事在自检、搜索、提取三条路上是同一套，而它们的鉴权各不
 * 相同（自检是 owner，另两条是席位票）。
 */
import type { Account, Db, WebCallKind, WebToolsSettings } from './db.ts'
import { emptyWebTools, parsePriceMultiplier } from './db.ts'
import {
  WebToolError,
  applyFilters,
  backendOf,
  fetchDocument,
  looksLikeDocument,
  stubFetchDocument,
  needsSecret,
  type BackendConfig,
  type Extracted,
  type SearchHit,
  type SearchQuery,
} from './web-tools.ts'

/** 一次 extract 最多几个 URL；单次搜索最多几条。和工具 schema 上写给模型的一致。 */
export const MAX_EXTRACT_URLS = 5
export const MAX_SEARCH_COUNT = 10
export const DEFAULT_SEARCH_COUNT = 5

export interface ResolvedBackend {
  id: string
  cfg: BackendConfig
}

/** 缓存活多久、最多存几条。 */
const CACHE_TTL_MS = 15 * 60_000
const CACHE_MAX = 64

/**
 * 进程内 LRU。
 *
 * 模型在一轮里反复 extract 同一页是常事——它会忘。不该为此反复付钱，也不该让上游
 * 反复限流我们。**命中不记 web_calls**：没打后端就没有这笔成本，记上去是虚报。
 *
 * 只在内存里，重启即空，多实例各存各的。这是刻意的：为一层 15 分钟的缓存引一个
 * 共享存储，运维成本比它省下的钱高。
 */
const cache = new Map<string, { at: number; value: unknown }>()

function cacheGet<T>(key: string): T | undefined {
  const hit = cache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key)
    return undefined
  }
  // 读一次挪到队尾——Map 保插入序，删了再插就是 LRU。
  cache.delete(key)
  cache.set(key, hit)
  return hit.value as T
}

function cachePut(key: string, value: unknown) {
  cache.delete(key)
  cache.set(key, { at: Date.now(), value })
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** e2e 用：把缓存清空。生产没人调。 */
export function clearWebCache() {
  cache.clear()
}

async function settingsOf(db: Db): Promise<{ web: WebToolsSettings; multiplier: number }> {
  const s = await db.platformSettings()
  return { web: s.webTools ?? emptyWebTools(), multiplier: parsePriceMultiplier(s.priceMultiplier) }
}

/**
 * 挑后端并把它要的东西配齐。**不做自动检测**：没配就是没配，说出来。
 *
 * 每一步失败都是 WebToolError——它们最终都会变成一句给模型看的话，而不是 500。
 * 模型看到「让管理员去配」才知道这条路这一轮走不通，看到 500 只会重试。
 */
export async function resolveBackend(db: Db, kind: WebCallKind): Promise<ResolvedBackend> {
  const { web } = await settingsOf(db)
  const id = kind === 'search' ? web.searchBackend : web.extractBackend
  if (!id) {
    throw new WebToolError(
      `no ${kind} backend`,
      `还没有配置网页${kind === 'search' ? '搜索' : '提取'}后端，让系统管理员去「工具配置 → 网页与搜索」配一个。`,
    )
  }
  const backend = backendOf(id)
  if (!backend) throw new WebToolError(`backend ${id} not implemented`, `后端 ${id} 还没接入，让系统管理员换一个。`)
  if (kind === 'search' && !backend.search) {
    throw new WebToolError(`${id} cannot search`, `当前搜索后端 ${id} 不支持搜索，让系统管理员换一个。`)
  }
  if (kind === 'extract' && !backend.extract) {
    throw new WebToolError(
      `${id} cannot extract`,
      `当前提取后端 ${id} 只支持搜索。让系统管理员在「工具配置 → 网页与搜索」里换一个支持提取的后端。`,
    )
  }
  const cfg: BackendConfig = { searxngUrl: web.searxngUrl }
  if (needsSecret(id)) {
    const cred = await db.platformCredential(id)
    if (!cred?.secret) {
      throw new WebToolError(`${id} no secret`, `还没有配置 ${id} 的密钥，让系统管理员去「工具配置 → 网页与搜索」配上。`)
    }
    cfg.secret = cred.secret
  }
  return { id, cfg }
}

/**
 * 报价。**写行的那一刻定死**，不回头重算。
 *
 * 模型的单价来自 pi-ai 目录，是外部事实，重算还是那个数；搜索单价是人在配置屏里
 * 手填的，管理员一改，重算会把上个月的账单也改掉。
 */
export function quoteMils(web: WebToolsSettings, backend: string, kind: WebCallKind, units: number, multiplier: number): number {
  const unit = web.pricing?.[backend]?.[kind] ?? 0
  if (!unit || units <= 0) return 0
  return Math.round(unit * units * multiplier)
}

async function meter(
  db: Db,
  account: Account,
  kind: WebCallKind,
  backend: string,
  units: number,
): Promise<number> {
  if (units <= 0) return 0
  const { web, multiplier } = await settingsOf(db)
  const mils = quoteMils(web, backend, kind, units, multiplier)
  await db.insertWebCall({
    accountId: account.id,
    companyId: account.companyId,
    kind,
    backend,
    units,
    mils,
  })
  return mils
}

/**
 * 公司一天最多几次。0 = 不限。
 *
 * 按**自然日**数，用的是服务器时区——公司分布在哪个时区我们不知道，而这个闸的用途
 * 是防跑飞，不是精确到小时的计费，切错一小时没有后果。
 */
async function checkQuota(db: Db, companyId: string | null, web: WebToolsSettings): Promise<void> {
  const limit = web.dailyLimit ?? 0
  if (!limit || !companyId) return
  const since = new Date()
  since.setHours(0, 0, 0, 0)
  const used = await db.webCallCountSince(companyId, since.getTime())
  if (used >= limit) {
    throw new WebToolError(
      `quota ${used}/${limit}`,
      `今天这家公司的网页调用已经用满 ${limit} 次了，明天再试，或者让系统管理员调高上限。`,
    )
  }
}

export interface SearchArgs {
  query: string
  count?: number
  domains?: string[]
  exclude?: string[]
  freshness?: string
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean).slice(0, 10)
}

export function parseSearchArgs(raw: SearchArgs): SearchQuery {
  const query = String(raw.query ?? '').trim()
  if (!query) throw new WebToolError('empty query', 'query 不能为空。')
  if (query.length > 400) throw new WebToolError('query too long', '搜索词太长了，说重点就行。')
  const n = raw.count == null ? DEFAULT_SEARCH_COUNT : Number(raw.count)
  if (!Number.isFinite(n) || n < 1 || n > MAX_SEARCH_COUNT) {
    throw new WebToolError('bad count', `count 只能是 1 到 ${MAX_SEARCH_COUNT}。`)
  }
  const fresh = String(raw.freshness ?? '').trim()
  if (fresh && !['day', 'week', 'month', 'year'].includes(fresh)) {
    throw new WebToolError('bad freshness', 'freshness 只能是 day / week / month / year。')
  }
  return {
    query,
    count: Math.floor(n),
    domains: strList(raw.domains),
    exclude: strList(raw.exclude),
    freshness: (fresh || '') as SearchQuery['freshness'],
  }
}

export interface SearchResult {
  backend: string
  hits: SearchHit[]
  /** 这一次是缓存给的，没打后端，也没记账。 */
  cached?: boolean
  /** 结果是在我们这边滤过的（后端不原生支持那几个约束）。要报给模型。 */
  filtered: boolean
  elapsedMs: number
  mils: number
}

export async function runSearch(db: Db, account: Account, raw: SearchArgs): Promise<SearchResult> {
  const q = parseSearchArgs(raw)
  const { id, cfg } = await resolveBackend(db, 'search')
  const { web } = await settingsOf(db)
  await checkQuota(db, account.companyId, web)
  const key = `search:${id}:${JSON.stringify(q)}`
  const cached = cacheGet<SearchHit[]>(key)
  const started = Date.now()
  const hits = cached ?? (await backendOf(id)!.search!(q, cfg))
  if (!cached) cachePut(key, hits)
  const elapsedMs = Date.now() - started
  // Tavily 原生支持域名过滤，DuckDuckGo 不支持——不支持的在这里补上，
  // 并把「滤过」这件事报出去。悄悄忽略模型给的约束比不支持更糟。
  const post = id === 'tavily' ? { hits, filtered: false } : applyFilters(hits, q)
  // 命中缓存不记账：这一次没打后端，也就没有这笔成本。
  const mils = cached ? 0 : await meter(db, account, 'search', id, 1)
  return { backend: id, hits: post.hits.slice(0, q.count), filtered: post.filtered, elapsedMs, mils, cached: Boolean(cached) }
}

export interface ExtractedPage {
  url: string
  ok: boolean
  title?: string
  markdown?: string
  contentType?: string
  chars?: number
  error?: string
  /**
   * PDF / Word / Excel：给字节，不给正文。
   * 席位那边落盘后交给 workspace/extract.ts——那套逻辑已经处理过扫描件、表格这些坑。
   */
  document?: { contentType: string; ext: string; base64: string; bytes: number }
}

export interface ExtractResult {
  backend: string
  pages: ExtractedPage[]
  elapsedMs: number
  mils: number
}

/** e2e 里不打网络，文档那一步换成假的；生产走真的 fetchDocument。 */
const fetchDoc = process.env.E2E_STUB_WEB === '1' ? async (url: string) => stubFetchDocument(url) : fetchDocument

/** 文档的标题只能从地址里取——PDF 里的元数据不一定有，也不一定对。 */
function docTitle(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() || url)
  } catch {
    return url
  }
}

export function parseExtractUrls(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
  const urls = list.map((x) => String(x ?? '').trim()).filter(Boolean)
  if (!urls.length) throw new WebToolError('no urls', 'urls 不能为空。')
  if (urls.length > MAX_EXTRACT_URLS) {
    throw new WebToolError('too many urls', `一次最多 ${MAX_EXTRACT_URLS} 个地址，你给了 ${urls.length} 个。`)
  }
  return urls
}

export async function runExtract(db: Db, account: Account, rawUrls: unknown): Promise<ExtractResult> {
  const urls = parseExtractUrls(rawUrls)
  const { id, cfg } = await resolveBackend(db, 'extract')
  const { web } = await settingsOf(db)
  await checkQuota(db, account.companyId, web)
  const backend = backendOf(id)!
  const started = Date.now()
  // 逐个抓，互不牵连：**部分失败不是失败**，调用方自己判断够不够用。
  //
  // 每条自己报 `billable`，不靠外面数计数器倒推。倒推那版栽在「后缀骗人」这条路上：
  // 一个 .pdf 结尾却返回 HTML 的地址会把计数器加两次，于是缓存命中数被算成负的，
  // 一条 URL 收两份钱，连同一次调用里真正命中缓存的那几条也一起收了。
  const done = await Promise.all(
    urls.map(async (url): Promise<{ page: ExtractedPage; billable: boolean }> => {
      const key = `extract:${id}:${url}`
      const hit = cacheGet<ExtractedPage>(key)
      // 命中缓存这一次没打后端，也就没有这笔成本。
      if (hit) return { page: hit, billable: false }
      try {
        // 看着像文档就自己取字节：提取后端对着一份 PDF 要么给空、要么给乱码。
        if (looksLikeDocument(url)) {
          const doc = await fetchDoc(url)
          if (doc) {
            // 文档不进缓存：base64 一份就有好几 MB，64 条能把进程撑爆。
            return {
              page: { url, ok: true, title: docTitle(url), contentType: doc.contentType, document: doc },
              billable: true,
            }
          }
          // 后缀骗人（.pdf 结尾其实是 HTML），落回正常那条路——这一趟只读了响应头，
          // 后端那次才是要付钱的那次，所以这里不额外计一笔。
        }
        const got: Extracted = await backend.extract!(url, cfg)
        const page: ExtractedPage = {
          url,
          ok: true,
          title: got.title,
          markdown: got.markdown,
          contentType: got.contentType,
          chars: got.markdown.length,
        }
        cachePut(key, page)
        return { page, billable: true }
      } catch (e) {
        // 失败不进缓存：下一次多半是另一个结果，缓存一条 404 只会把它钉死 15 分钟。
        // 也不计费：没抓着的那条没花后端的钱。
        return {
          page: { url, ok: false, error: e instanceof WebToolError ? e.hint : (e as Error).message },
          billable: false,
        }
      }
    }),
  )
  const pages = done.map((d) => d.page)
  const elapsedMs = Date.now() - started
  const mils = await meter(db, account, 'extract', id, done.filter((d) => d.billable).length)
  return { backend: id, pages, elapsedMs, mils }
}

/**
 * 配置屏上的自检。**不记 web_calls**——这是管理员在验配置，不是公司在用。
 */
export async function testBackend(db: Db, kind: WebCallKind): Promise<{ backend: string; elapsedMs: number; count: number }> {
  const { id, cfg } = await resolveBackend(db, kind)
  const started = Date.now()
  if (kind === 'search') {
    const hits = await backendOf(id)!.search!(
      { query: 'satuwork web search self test', count: 3, domains: [], exclude: [], freshness: '' },
      cfg,
    )
    return { backend: id, elapsedMs: Date.now() - started, count: hits.length }
  }
  const got = await backendOf(id)!.extract!('https://example.com/', cfg)
  return { backend: id, elapsedMs: Date.now() - started, count: got.markdown.length }
}
