/**
 * 网页搜索与提取的后端适配层。
 *
 * **为什么在 Gateway 不在 Bot。** 密钥在这里，抓取也就顺势在这里做完；Bot 侧只剩
 * 「调一次 /runtime/web/*、按长度决定要不要摘要、要不要落盘」。Bot 版本的推进比
 * Gateway 慢得多——把后端适配放进跑得慢的那一半，等于每换一家后端都要重新出包、
 * 重新部署所有席位。
 *
 * 四家：
 * - **tavily**：搜索 + 提取都有，返回的已经是清好的正文。默认后端。
 * - **duckduckgo**：无密钥、零配置，只有搜索。兜底用——它是抓公开页面拿结果，没有
 *   商务约定，限流和封 IP 都可能发生，所以自带节流、被 429 直接认输不重试。
 * - **searxng**：自托管，只有搜索，地址由管理员填（SSRF 闸的明示例外）。
 * - **firecrawl**：搜索 + 提取都有，提取那头是真渲染的浏览器，SPA 页面它拿得到。
 *
 * 搜索和提取**各配各的**（`searchBackend` / `extractBackend`）：自托管 SearXNG 搜索
 * 配 Firecrawl 提取是很实在的组合——查询词不出自己的网，正文又要浏览器才渲染得出来。
 *
 * 每个方法**要么返回结果，要么抛 WebToolError**。上游 401/429/超时都是
 * WebToolError，路由层把它翻成一句给模型看的话，不是 500——模型看到文本才知道
 * 该改什么或者该放弃。
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class WebToolError extends Error {
  constructor(
    message: string,
    /** 给模型看的那一句。路由层原样透出去。 */
    readonly hint: string,
  ) {
    super(message)
  }
}

export interface SearchQuery {
  query: string
  count: number
  domains: string[]
  exclude: string[]
  freshness: '' | 'day' | 'week' | 'month' | 'year'
}

export interface SearchHit {
  title: string
  url: string
  snippet: string
  publishedAt?: string
}

export interface Extracted {
  url: string
  title: string
  markdown: string
  contentType: string
}

export interface BackendConfig {
  secret?: string
  searxngUrl?: string
}

export interface WebBackend {
  readonly id: string
  search?(q: SearchQuery, cfg: BackendConfig): Promise<SearchHit[]>
  extract?(url: string, cfg: BackendConfig): Promise<Extracted>
}

/** 单次上游请求的耐心。搜索该快，提取要等页面。 */
const SEARCH_TIMEOUT_MS = 20_000
const EXTRACT_TIMEOUT_MS = 30_000

/**
 * URL 闸。放行之前要过三关：协议、主机名解析出的 IP、以及每一跳跳转。
 *
 * 这道闸在 Gateway 上跑，而 Gateway 手里有库和平台凭证——「让模型给一个 URL、
 * 我们照着打」本身就是 SSRF 的定义，不设闸的话内网里任何一个没有鉴权的服务都在
 * 射程内。自托管 SearXNG 的地址是**管理员明示的例外**，只对那一个地址放行。
 */
export async function guardUrl(raw: string, allowHost?: string): Promise<URL> {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new WebToolError(`bad url ${raw}`, `不是合法的地址：${raw}`)
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new WebToolError(`bad protocol ${u.protocol}`, `只支持 http/https 地址：${raw}`)
  }
  if (allowHost && u.host === allowHost) return u
  const host = u.hostname.replace(/^\[|\]$/g, '')
  const ips: string[] = []
  if (isIP(host)) ips.push(host)
  else {
    try {
      const found = await lookup(host, { all: true })
      ips.push(...found.map((f) => f.address))
    } catch {
      throw new WebToolError(`dns failed ${host}`, `解析不了这个域名：${host}`)
    }
  }
  if (!ips.length) throw new WebToolError(`no ip ${host}`, `解析不了这个域名：${host}`)
  for (const ip of ips) {
    if (isPrivateIp(ip)) throw new WebToolError(`private ip ${ip}`, `拒绝访问内网地址：${raw}`)
  }
  return u
}

/** 私网、回环、链路本地、以及 IPv6 那几段。判不了的一律当私网拒。 */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const p = ip.split('.').map(Number)
    if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
    const [a, b] = p as [number, number, number, number]
    if (a === 10 || a === 127 || a === 0) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 169 && b === 254) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a >= 224) return true // 组播与保留段
    return false
  }
  if (v === 6) {
    const s = ip.toLowerCase()
    if (s === '::1' || s === '::') return true
    if (s.startsWith('fe80') || s.startsWith('fc') || s.startsWith('fd')) return true
    // IPv4 映射地址（::ffff:10.0.0.1）按它映射的那个 v4 判。
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s)
    if (m) return isPrivateIp(m[1]!)
    return false
  }
  return true
}

/** 带凭据的请求头。跨主机跳转时必须摘掉——见 safeFetch。 */
const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'cookie', 'proxy-authorization']

export function stripCredentials(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  new Headers(headers).forEach((v, k) => {
    if (!CREDENTIAL_HEADERS.includes(k.toLowerCase())) out[k] = v
  })
  return out
}

/**
 * 逐跳重查的 fetch。只跟 5 次，每一跳都过闸——只查第一跳等于没查。
 *
 * **跨主机的那一跳要把凭据摘掉。** 浏览器和 undici 的自动跳转就是这么做的，而这里
 * 是自己实现的跳转（`redirect: 'manual'`），不摘就等于：上游哪天 302 到别的域名，
 * 我们会带着平台的 Tavily 密钥把同一个 POST 重发过去。SSRF 闸只拦内网，公网目标
 * 一律放行，所以它挡不住这一条。
 *
 * 301/302/303 上把非 GET 降成 GET 并丢掉 body（浏览器的既成行为）；307/308 原样重发，
 * 那是它们的定义。
 */
export async function safeFetch(
  raw: string,
  init: RequestInit & { timeoutMs?: number; allowHost?: string } = {},
): Promise<Response> {
  const { timeoutMs = EXTRACT_TIMEOUT_MS, allowHost, ...rest } = init
  let url = raw
  // origin 从 guardUrl 的返回值里取，不另外 `new URL(raw)`：坏地址要由 guardUrl
  // 抛成 WebToolError（业务失败），自己先解析一遍会变成一个裸 TypeError → 500。
  let origin = ''
  let opts: RequestInit = rest
  for (let hop = 0; hop < 6; hop++) {
    const here = await guardUrl(url, allowHost)
    if (!origin) origin = here.origin
    let res: Response
    try {
      res = await fetch(url, { ...opts, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
    } catch (e) {
      const msg = (e as Error).message || 'fetch failed'
      throw new WebToolError(msg, /timeout|abort/i.test(msg) ? '上游超时了，等一会儿再试。' : `打不通上游：${msg}`)
    }
    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get('location')
      if (!to) return res
      const next = new URL(to, url)
      // 3xx 的正文一律不要。不排空的话 undici 会把这条连接一直挂着。
      await res.body?.cancel().catch(() => {})
      if (next.origin !== origin) {
        opts = { ...opts, headers: stripCredentials(opts.headers) }
        origin = next.origin
      }
      // 301/302/303 上把非 GET 降成 GET 并丢掉 body——这是浏览器的既成行为。
      // **307/308 不降**：它们的语义就是「原样重发」，降了会把一次正常的 POST
      // 变成上游眼里的 405。
      const method = (opts.method || 'GET').toUpperCase()
      if (res.status !== 307 && res.status !== 308 && method !== 'GET' && method !== 'HEAD') {
        opts = { ...opts, method: 'GET', body: undefined }
      }
      url = next.toString()
      continue
    }
    return res
  }
  throw new WebToolError('too many redirects', '这个地址跳转太多次了。')
}

/**
 * 文档类页面：PDF / Word / Excel。
 *
 * 提取后端返回的是「网页正文」，对着一份 PDF 它要么给空、要么给一堆乱码。这类地址
 * 我们自己取回字节，交给席位那边现成的那条路（unpdf / mammoth / exceljs）——
 * 那套逻辑已经处理过扫描件没有文字层、表格不能拍平这些坑，不重复造。
 *
 * 上限 10 MiB：再大的文档，摘要也没有意义，而 base64 之后还要过一遍 JSON。
 */
const DOC_TYPES: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel.sheet.macroenabled.12': '.xlsm',
}

const MAX_DOC_BYTES = 10 * 1024 * 1024

export interface FetchedDocument {
  contentType: string
  ext: string
  base64: string
  bytes: number
}

/** 看后缀猜。猜错了没关系——真取回来还要再看一次 content-type。 */
export function looksLikeDocument(url: string): boolean {
  try {
    return /\.(pdf|docx|xlsx|xlsm)(\?|#|$)/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

function tooLarge(bytes: number): WebToolError {
  const mb = Math.max(Math.round(bytes / 1024 / 1024), 1)
  return new WebToolError(`doc too large ${bytes}`, `这份文档至少有 ${mb} MB，超过 10 MB 不取。`)
}

export async function fetchDocument(url: string): Promise<FetchedDocument | null> {
  const res = await safeFetch(url, { timeoutMs: EXTRACT_TIMEOUT_MS })
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw new WebToolError(`doc HTTP ${res.status}`, `抓取失败：HTTP ${res.status}`)
  }
  const ctype = (res.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase()
  const ext = DOC_TYPES[ctype]
  if (!ext) {
    // 后缀骗人：调用方会落回正常那条路。这里必须把连接排空，否则 undici 要等 GC 才回收它。
    await res.body?.cancel().catch(() => {})
    return null
  }
  const declared = Number(res.headers.get('content-length') || 0)
  if (declared > MAX_DOC_BYTES) {
    await res.body?.cancel().catch(() => {})
    throw tooLarge(declared)
  }
  const buf = await readCapped(res, MAX_DOC_BYTES)
  return { contentType: ctype, ext, base64: buf.toString('base64'), bytes: buf.length }
}

/**
 * **边读边数**地把响应体读进内存，超限当场掐断。
 *
 * content-length 可以撒谎，也可以根本不给（chunked）。先收完再量长度，等于让任何一个
 * 地址都能拿 Gateway 的内存换一次拒绝——而 Gateway 是所有公司共用的那一个进程。
 * workspace 的 saveUpload 对上传走的是同一条规矩。
 */
export async function readCapped(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let size = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel().catch(() => {})
        throw tooLarge(size)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

function statusHint(status: number, backend: string): string {
  if (status === 401 || status === 403) return `${backend} 的密钥无效或没有权限，让系统管理员去看看。`
  if (status === 402) return `${backend} 欠费了，让系统管理员去看看。`
  if (status === 429) return `${backend} 限流了，等一会儿再试。`
  return `${backend} 返回了 HTTP ${status}。`
}

async function upstreamJson(
  backend: string,
  url: string,
  init: RequestInit & { timeoutMs?: number; allowHost?: string },
): Promise<any> {
  const res = await safeFetch(url, init)
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new WebToolError(`${backend} HTTP ${res.status} ${body.slice(0, 200)}`, statusHint(res.status, backend))
  }
  try {
    return await res.json()
  } catch {
    throw new WebToolError(`${backend} bad json`, `${backend} 返回的不是 JSON，可能配置不对。`)
  }
}

/** 域名过滤：后端原生支持就交给它，不支持的在本地滤——悄悄忽略约束比不支持更糟。 */
export function applyFilters(hits: SearchHit[], q: SearchQuery): { hits: SearchHit[]; filtered: boolean } {
  if (!q.domains.length && !q.exclude.length) return { hits, filtered: false }
  const host = (u: string) => {
    try {
      return new URL(u).hostname.toLowerCase()
    } catch {
      return ''
    }
  }
  const match = (h: string, d: string) => h === d || h.endsWith(`.${d}`)
  const out = hits.filter((hit) => {
    const h = host(hit.url)
    if (!h) return false
    if (q.domains.length && !q.domains.some((d) => match(h, d.toLowerCase()))) return false
    if (q.exclude.length && q.exclude.some((d) => match(h, d.toLowerCase()))) return false
    return true
  })
  return { hits: out, filtered: true }
}

// ── Tavily ───────────────────────────────────────────────────────────────

const TAVILY_RANGE: Record<string, string> = { day: 'day', week: 'week', month: 'month', year: 'year' }

const tavily: WebBackend = {
  id: 'tavily',
  async search(q, cfg) {
    if (!cfg.secret) throw new WebToolError('tavily no key', '还没有配置 Tavily 的密钥，让系统管理员去配。')
    const body: Record<string, unknown> = {
      query: q.query,
      max_results: q.count,
      search_depth: 'basic',
    }
    // 这三个 Tavily 原生就有，交给它，比本地滤完再返回省一次往返。
    if (q.domains.length) body.include_domains = q.domains
    if (q.exclude.length) body.exclude_domains = q.exclude
    if (q.freshness && TAVILY_RANGE[q.freshness]) body.time_range = TAVILY_RANGE[q.freshness]
    const data = await upstreamJson('tavily', 'https://api.tavily.com/search', {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: SEARCH_TIMEOUT_MS,
    })
    const rows = Array.isArray(data?.results) ? data.results : []
    return rows.slice(0, q.count).map((r: any) => ({
      title: String(r?.title ?? '').trim(),
      url: String(r?.url ?? '').trim(),
      snippet: String(r?.content ?? '').trim(),
      publishedAt: r?.published_date ? String(r.published_date) : undefined,
    })).filter((h: SearchHit) => h.url)
  },
  async extract(url, cfg) {
    if (!cfg.secret) throw new WebToolError('tavily no key', '还没有配置 Tavily 的密钥，让系统管理员去配。')
    const data = await upstreamJson('tavily', 'https://api.tavily.com/extract', {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ urls: [url], format: 'markdown' }),
      timeoutMs: EXTRACT_TIMEOUT_MS,
    })
    const row = Array.isArray(data?.results) ? data.results[0] : null
    if (!row) {
      const why = Array.isArray(data?.failed_results) ? data.failed_results[0]?.error : ''
      throw new WebToolError(`tavily extract empty ${why ?? ''}`, `抓不到这一页${why ? `：${String(why).slice(0, 120)}` : ''}`)
    }
    return {
      url,
      title: String(row?.title ?? '').trim(),
      markdown: String(row?.raw_content ?? row?.content ?? ''),
      contentType: 'text/markdown',
    }
  },
}

// ── DuckDuckGo ───────────────────────────────────────────────────────────

/**
 * 无密钥、零配置的兜底。抓的是 html.duckduckgo.com 的无脚本版页面。
 *
 * 没有商务约定，所以：全进程 1 秒一次的节流，429 直接认输不重试到被封 IP，
 * 域名过滤靠本地滤（`site:` 拼进查询词在无脚本版上并不可靠）。
 */
const DDG_INTERVAL_MS = 1000

/**
 * **下一次允许发车的时刻**，不是「上一次发车的时刻」。
 *
 * 记上一次发车时刻是挡不住并发的：同时进来的三个请求都读到同一个旧时间戳，各自算出
 * 同样的等待，睡完在同一刻一起打出去——节流只对第一个生效，而突发并发正是 DDG 拿
 * 429 和封 IP 招呼的那种流量。这里改成每个请求先把闸门往后推一秒再去睡，于是它们
 * 自然排成一队。
 */
let ddgNextAt = 0

/** 占一个车位，返回还要等多久（毫秒）。抽出来是为了能直接对排队行为下断言。 */
export function reserveDdgSlot(now = Date.now()): number {
  const slot = Math.max(now, ddgNextAt)
  ddgNextAt = slot + DDG_INTERVAL_MS
  return slot - now
}

const duckduckgo: WebBackend = {
  id: 'duckduckgo',
  async search(q) {
    const wait = reserveDdgSlot()
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    const params = new URLSearchParams({ q: q.query, kl: 'wt-wt' })
    const df: Record<string, string> = { day: 'd', week: 'w', month: 'm', year: 'y' }
    if (q.freshness && df[q.freshness]) params.set('df', df[q.freshness]!)
    const res = await safeFetch(`https://html.duckduckgo.com/html/?${params}`, {
      headers: {
        // 不带 UA 直接被挡。这里报的是一个普通桌面浏览器，不假装成别的产品。
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      timeoutMs: SEARCH_TIMEOUT_MS,
    })
    if (res.status === 429 || res.status === 202) {
      throw new WebToolError('ddg rate limited', 'DuckDuckGo 限流了，等一会儿再试，或者让系统管理员换一个搜索后端。')
    }
    if (!res.ok) throw new WebToolError(`ddg HTTP ${res.status}`, statusHint(res.status, 'DuckDuckGo'))
    return parseDdg(await res.text(), q.count)
  },
}

/** 从无脚本版 HTML 里挑结果。结构变了就返回空数组，让上面按「没有结果」处理。 */
export function parseDdg(html: string, count: number): SearchHit[] {
  const hits: SearchHit[] = []
  const blocks = html.split('result results_links')
  for (const block of blocks.slice(1)) {
    if (hits.length >= count) break
    const link = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    if (!link) continue
    const url = ddgUrl(link[1]!)
    if (!url) continue
    const snippet = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/.exec(block)
    hits.push({
      title: stripTags(link[2]!),
      url,
      snippet: snippet ? stripTags(snippet[1]!) : '',
    })
  }
  return hits
}

/** DDG 的链接是 /l/?uddg=<编码后的真地址>，也有直接给原地址的。 */
function ddgUrl(href: string): string {
  const raw = href.startsWith('//') ? `https:${href}` : href
  try {
    const u = new URL(raw, 'https://duckduckgo.com')
    const real = u.searchParams.get('uddg')
    const out = real ? decodeURIComponent(real) : u.toString()
    return /^https?:\/\//.test(out) ? out : ''
  } catch {
    return ''
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

// ── SearXNG ──────────────────────────────────────────────────────────────

/**
 * 自托管，只有搜索。地址由管理员填，多半是**内网地址**——所以它是 SSRF 闸的一个
 * 明示例外，而例外只对那一个 host 生效，跳转的下一跳照样要过闸。
 *
 * 它默认不开 JSON 输出：`settings.yml` 的 `formats` 里没有 `json` 时，这个接口
 * 返回的是 HTML。那种情况要说清楚是「实例没开 json」，不是「搜不到」——后者会让人
 * 去改查询词，改到天亮也没用。
 */
const searxng: WebBackend = {
  id: 'searxng',
  async search(q, cfg) {
    const raw = (cfg.searxngUrl || '').replace(/\/$/, '')
    if (!raw) throw new WebToolError('searxng no url', '还没有填 SearXNG 的实例地址，让系统管理员去配。')
    let host: string
    try {
      host = new URL(raw).host
    } catch {
      throw new WebToolError('searxng bad url', 'SearXNG 的实例地址不是合法的 http/https 地址。')
    }
    const params = new URLSearchParams({ q: searxngQuery(q), format: 'json', language: 'zh-CN' })
    if (q.freshness) params.set('time_range', q.freshness === 'day' ? 'day' : q.freshness === 'week' ? 'week' : q.freshness === 'month' ? 'month' : 'year')
    const res = await safeFetch(`${raw}/search?${params}`, { allowHost: host, timeoutMs: SEARCH_TIMEOUT_MS })
    if (!res.ok) throw new WebToolError(`searxng HTTP ${res.status}`, statusHint(res.status, 'SearXNG'))
    const text = await res.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      throw new WebToolError(
        'searxng not json',
        'SearXNG 实例没有开 JSON 输出（settings.yml 的 formats 里加 json 再重启），让系统管理员去开。',
      )
    }
    const rows = Array.isArray(data?.results) ? data.results : []
    return rows.slice(0, q.count).map((r: any) => ({
      title: String(r?.title ?? '').trim(),
      url: String(r?.url ?? '').trim(),
      snippet: String(r?.content ?? '').trim(),
      publishedAt: r?.publishedDate ? String(r.publishedDate).slice(0, 10) : undefined,
    })).filter((h: SearchHit) => h.url)
  },
}

/** SearXNG 认 `site:` 语法，域名限制交给它比抓回来再滤省一半带宽。 */
function searxngQuery(q: SearchQuery): string {
  const sites = q.domains.map((d) => `site:${d}`).join(' OR ')
  const not = q.exclude.map((d) => `-site:${d}`).join(' ')
  return [q.query, sites ? `(${sites})` : '', not].filter(Boolean).join(' ')
}

// ── Firecrawl ────────────────────────────────────────────────────────────

/**
 * 搜索和提取都有。提取那头是真渲染的浏览器，SPA 页面 Tavily 拿不到正文时它能拿到。
 *
 * **只用 markdown 这一个 format。** 它还有 `summary`（他们的 LLM 直接给摘要）和带
 * prompt 的 `json`，但摘要在我们这儿一律走自己的 utility 模型：外包出去，摘要 prompt
 * 里那三条规矩（数字/代码块/引文原样、不复述结构、不加原文没有的结论）就管不到了，
 * 「摘要挂了退回原文开头」这条回退也没了，账还会从 llm_calls 混进 web_calls。
 *
 * 域名限制拼 `site:` / `-site:` 进查询词（他们文档里就是这么用的），拼完仍然在本地
 * 再滤一遍并把「滤过」报出去——`site:` 是搜索引擎的建议，不是保证。
 */
const firecrawl: WebBackend = {
  id: 'firecrawl',
  async search(q, cfg) {
    if (!cfg.secret) throw new WebToolError('firecrawl no key', '还没有配置 Firecrawl 的密钥，让系统管理员去配。')
    const body: Record<string, unknown> = { query: firecrawlQuery(q), limit: q.count }
    // tbs 是 Google 那套时间过滤：qdr:d/w/m/y。
    const tbs: Record<string, string> = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' }
    if (q.freshness && tbs[q.freshness]) body.tbs = tbs[q.freshness]
    const data = await upstreamJson('firecrawl', `${firecrawlBase()}/v2/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: SEARCH_TIMEOUT_MS,
      allowHost: selfHostedFirecrawl(),
    })
    firecrawlOk(data)
    // v2 把结果按来源分桶（web / news / images），我们只要 web 那一桶。
    const rows = Array.isArray(data?.data?.web) ? data.data.web : Array.isArray(data?.results) ? data.results : []
    return rows
      .slice(0, q.count)
      .map((r: any) => ({
        title: String(r?.title ?? '').trim(),
        url: String(r?.url ?? '').trim(),
        // 字段名两版之间变过，按优先级取，取不到就空着——空摘要好过一段 undefined。
        snippet: String(r?.description ?? r?.snippet ?? '').trim(),
        publishedAt: r?.date ? String(r.date).slice(0, 10) : undefined,
      }))
      .filter((h: SearchHit) => h.url)
  },
  async extract(url, cfg) {
    if (!cfg.secret) throw new WebToolError('firecrawl no key', '还没有配置 Firecrawl 的密钥，让系统管理员去配。')
    const data = await upstreamJson('firecrawl', `${firecrawlBase()}/v2/scrape`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.secret}`, 'content-type': 'application/json' },
      // onlyMainContent：去掉导航和页脚。它们对模型是纯噪音，还要占摘要的额度。
      body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
      timeoutMs: EXTRACT_TIMEOUT_MS,
      allowHost: selfHostedFirecrawl(),
    })
    firecrawlOk(data)
    const doc = data?.data
    const markdown = String(doc?.markdown ?? '')
    if (!markdown) {
      const why = String(doc?.warning ?? doc?.metadata?.error ?? '').slice(0, 120)
      throw new WebToolError(`firecrawl empty ${why}`, `抓不到这一页的正文${why ? `：${why}` : ''}`)
    }
    return {
      url,
      title: String(doc?.metadata?.title ?? '').trim(),
      markdown,
      contentType: 'text/markdown',
    }
  },
}

/** 自托管的 Firecrawl 也认这个变量，和上游文档里的 FIRECRAWL_API_URL 同名。 */
function firecrawlBase(): string {
  return (process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev').replace(/\/$/, '')
}

/**
 * 自托管实例的 host，作为 SSRF 闸的**明示例外**——和 SearXNG 那条同一个道理。
 *
 * 自托管的 Firecrawl 官方示例就是 `http://localhost:3002`，多半在内网。不给例外的话
 * 这个后端配了也用不了：每一次都被自家的闸拦成「拒绝访问内网地址」。
 *
 * **只对显式配过 FIRECRAWL_API_URL 的那一个 host 放行。** 默认的公网域名照常过闸——
 * 它没有理由需要例外，而多放一个 host 就多一条 DNS 被劫持后指进内网的路。
 */
function selfHostedFirecrawl(): string | undefined {
  const raw = (process.env.FIRECRAWL_API_URL || '').trim()
  if (!raw) return undefined
  try {
    return new URL(raw).host
  } catch {
    return undefined
  }
}

/**
 * Firecrawl 会在 **HTTP 200 里**用 `success: false` 报错（额度用尽、查询被拒之类）。
 *
 * 不看这一位的话，`data.web` 取不到 → rows 是空数组 → 上层说成「没有结果，换个说法
 * 再试」，于是模型一遍遍换搜索词重试，改到天亮也没用。这正是 SearXNG 那条「不通不能
 * 说成没结果」要避免的情形。
 */
function firecrawlOk(data: any): void {
  if (data?.success === false) {
    const why = String(data?.error ?? '').slice(0, 160)
    throw new WebToolError(`firecrawl success=false ${why}`, `Firecrawl 拒绝了这次请求${why ? `：${why}` : ''}。`)
  }
}

function firecrawlQuery(q: SearchQuery): string {
  const sites = q.domains.map((d) => `site:${d}`).join(' OR ')
  const not = q.exclude.map((d) => `-site:${d}`).join(' ')
  return [q.query, sites ? `(${sites})` : '', not].filter(Boolean).join(' ')
}

// ── 注册表 ────────────────────────────────────────────────────────────────

/**
 * e2e 用的假后端。**只在 E2E_STUB_WEB=1 时顶替 tavily 的实现**，id 和价目照旧——
 * 要验的是路由、计量、计价这条链路，不是 Tavily 的 JSON 长什么样，而真打网络的
 * 测试会因为别人的限流而随机失败。
 */
const stubTavily: WebBackend = {
  id: 'tavily',
  async search(q) {
    if (q.query.includes('empty')) return []
    return Array.from({ length: Math.min(q.count, 2) }, (_, i) => ({
      title: `stub ${i + 1} ${q.query}`,
      url: `https://stub.test/${i + 1}`,
      snippet: 'stub snippet',
    }))
  },
  async extract(url) {
    if (url.includes('fail')) throw new WebToolError('stub fail', '抓取失败：HTTP 404')
    return { url, title: 'stub page', markdown: `# stub\n\n${url}`, contentType: 'text/markdown' }
  },
}

/**
 * e2e 用：把 `.pdf` 结尾其实返回 HTML 的那条路造出来。
 *
 * 真实现里这一步是 fetchDocument 打一次网络看 content-type，测试里不打网络，
 * 所以由这个开关顶替：URL 里带 `fake-doc` 就当成「后缀骗人」，返回 null 让它落回
 * 正常那条路。要钉的是**落回之后只收一次钱**，不是 content-type 怎么读。
 */
export function stubFetchDocument(url: string): FetchedDocument | null {
  if (url.includes('fake-doc')) return null
  const buf = Buffer.from(`%PDF-1.4 stub ${url}`)
  return { contentType: 'application/pdf', ext: '.pdf', base64: buf.toString('base64'), bytes: buf.length }
}

/** e2e 用的第二家。和 stubTavily 长得不一样，好看出「这一次到底走了哪家」。 */
const stubFirecrawl: WebBackend = {
  id: 'firecrawl',
  async search(q) {
    if (q.query.includes('empty')) return []
    return Array.from({ length: Math.min(q.count, 2) }, (_, i) => ({
      title: `firecrawl stub ${i + 1}`,
      url: `https://fc-stub.test/${i + 1}`,
      snippet: 'firecrawl snippet',
    }))
  },
  async extract(url) {
    if (url.includes('fail')) throw new WebToolError('stub fail', '抓取失败：HTTP 404')
    return { url, title: 'firecrawl page', markdown: `# firecrawl\n\n${url}`, contentType: 'text/markdown' }
  },
}

const stubbedBackends = process.env.E2E_STUB_WEB === '1'

const BACKENDS: Record<string, WebBackend> = {
  tavily: stubbedBackends ? stubTavily : tavily,
  firecrawl: stubbedBackends ? stubFirecrawl : firecrawl,
  duckduckgo,
  searxng,
}

export function backendOf(id: string): WebBackend | undefined {
  return BACKENDS[id]
}

/** 这个后端要不要密钥。SearXNG 要的是地址，DuckDuckGo 什么都不要。 */
export function needsSecret(id: string): boolean {
  return id === 'tavily' || id === 'firecrawl'
}

export function canSearch(id: string): boolean {
  return Boolean(backendOf(id)?.search)
}

export function canExtract(id: string): boolean {
  return Boolean(backendOf(id)?.extract)
}
