import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import * as pkg from './files.ts'

/**
 * Skill 与 MCP 屏。
 *
 * 三段东西，真实程度**各不相同，界面上也照实说**：
 *
 * - 内置工具（`/api/tools`）是真的：直接读工具注册表，Agent 此刻能调的就是这些。
 * - Skill 与 MCP 服务器的**定义**是真的：建了就落库，改了就生效，删了就没了。
 * - Skill 的**执行**和 MCP 的**连接**都还没有。所以这里不报「本月调用 218 次」，
 *   也不报某台服务器「提供 12 个工具」——那两个数字要等真跑起来才知道，先编一个
 *   出来，比空着更难发现它是假的。
 *
 * 也就是说这一屏管的是**配置**：把方法和服务器登记下来，等执行与连接接上之后
 * 直接用这份登记，而不是到时候再造一遍。
 */
export const name = 'satu-view-skills'
export const inject = ['client', 'server', 'tools', 'storage', 'auth']

interface Skill {
  id: string
  name: string
  /** 定义正文。手动编写就是这段文字；单文件导入就是那份文件的内容。 */
  body: string
  tags: string[]
  /** 怎么来的。单文件导入时连原始文件名一起记下，编辑时标题栏显示它。 */
  source: '手动编写' | '单文件 Skill' | 'ZIP 包'
  fileName?: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

interface Server {
  id: string
  name: string
  kind: 'stdio' | 'SSE' | 'HTTP'
  /** SSE/HTTP 是 URL，stdio 是启动命令。同一个字段，因为它们是同一件事的两种写法。 */
  endpoint: string
  env: Record<string, string>
  perm: '只读' | '可写' | '需审批'
  enabled: boolean
  createdAt: number
  updatedAt: number
}

const KINDS = ['stdio', 'SSE', 'HTTP'] as const
const PERMS = ['只读', '可写', '需审批'] as const
/** 鉴权 token 不和其余配置放一起：那一份要发给浏览器，这一份不发。 */
const TOKEN_NS = 'mcp-tokens'
/** 标签表。稿子上那八个是**初值**，不是上限——建了新的就进这张表。 */
const TAG_NS = 'skills'
const TAG_KEY = 'tags'
const DEFAULT_TAGS = ['客服', '数据分析', '内容运营', '销售', '研发支持', '行政支持', '自动化', '需复核']

/**
 * ZIP 包的两条硬线。
 *
 * 稿子上写的是 50 MB。这里收到 5 MB，因为包是**当成 JSON 传上来的**（浏览器先解开
 * 再传清单），50 MB 的文件会变成一条七十多 MB 的请求体——那条线不该由这一屏第一个
 * 撞上。真要放开，先给包一条自己的上传通道，而不是把这个数字改大。
 */
const MAX_PACKAGE_BYTES = 5 * 1024 * 1024
const MAX_PACKAGE_FILES = 200

/**
 * 「几个步骤」是**数出来的**，不是填的。
 *
 * 数的是正文里的列表项——有序无序都算。Skill 的正文本来就是「按什么步骤做」，
 * 让人再手填一个数字，只会得到一个和正文对不上的数字。
 */
const stepsOf = (body: string) => body.split('\n').filter((line) => /^\s*(?:\d+[.)]|[-*+])\s+/.test(line)).length

/** 摘要取正文第一段没被列表符号占住的话——卡片上要一句人话，而不是半行 Markdown。 */
const summaryOf = (body: string) => {
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !/^[#>\-*+\d]/.test(l))
  return line ? (line.length > 90 ? `${line.slice(0, 90)}…` : line) : ''
}

export function apply(ctx: Context) {
  ctx.client.register({ id: 'skills', entry: new URL('./client.js', import.meta.url) })

  const skills = ctx.storage.collection<Skill>('skills')
  const servers = ctx.storage.collection<Server>('mcp-servers')

  /**
   * 写操作要管理员，读不要。
   *
   * 这一屏挂在侧栏的 Admin 那一组里，但**判断在这儿**——藏掉入口只是不碍眼，
   * 拦住改动才是拦住改动。读放开，是因为以后 Agent 配置那屏要列可用的 Skill。
   */
  const guard = async (req: any, res: any, run: () => unknown) => {
    try {
      ctx.auth.requireAdmin(req)
      return res.json((await run()) ?? { ok: true })
    } catch (e) {
      res.status = (e as Error).message === '需要管理员权限' ? 403 : 400
      return res.json({ error: (e as Error).message })
    }
  }

  const body = async (req: any) => (await req.json().catch(() => ({}))) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  const named = (v: unknown) => {
    const name = str(v)
    if (!name) throw new Error('要有名字')
    return name
  }
  const tagsOf = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))].slice(0, 20) : []

  const knownTags = () => ctx.storage.getSetting<string[]>(TAG_NS, TAG_KEY) ?? DEFAULT_TAGS
  /** 用到的标签自动进表：从别处（导入、接口）带进来的标签，下次也要能被选中。 */
  const rememberTags = (tags: string[]) => {
    const known = knownTags()
    const merged = [...known, ...tags.filter((tag) => !known.includes(tag))]
    if (merged.length !== known.length) ctx.storage.setSetting(TAG_NS, TAG_KEY, merged)
  }

  /**
   * 收 ZIP 包解出来的那份清单。
   *
   * 校验放在服务端，尽管解压是在浏览器里做的——浏览器那边是**方便**，这边才是
   * 拦得住的地方：请求可以不经过那个界面。
   */
  const filesOf = (v: unknown): pkg.Incoming[] => {
    if (!Array.isArray(v)) return []
    if (v.length > MAX_PACKAGE_FILES) throw new Error(`包里最多 ${MAX_PACKAGE_FILES} 个文件`)
    let total = 0
    const files = v.map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>
      const path = str(item.path)
      if (!path) throw new Error('包里有一个文件没有路径')
      const text = typeof item.text === 'string' ? item.text : undefined
      const base64 = typeof item.base64 === 'string' ? item.base64 : undefined
      if (text === undefined && base64 === undefined) throw new Error(`${path} 没有内容`)
      total += base64 !== undefined ? Math.ceil(base64.length * 0.75) : Buffer.byteLength(text ?? '')
      return { path, text, base64 }
    })
    if (total > MAX_PACKAGE_BYTES) throw new Error(`包太大了：最多 ${MAX_PACKAGE_BYTES / 1024 / 1024} MB`)
    return files
  }

  /** 环境变量是**一层字符串字典**，不是任意 JSON：进程环境里放不下别的。 */
  const envOf = (v: unknown): Record<string, string> => {
    const text = str(v)
    if (!text) return {}
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('环境变量不是合法的 JSON')
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('环境变量要是一个 JSON 对象')
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof val !== 'string' && typeof val !== 'number') throw new Error(`环境变量 ${k} 的值要是字符串`)
      out[k] = String(val)
    }
    return out
  }

  /**
   * 列表里的 Skill 带上数出来的步骤数与摘要——两个都由正文决定，不单独存。
   *
   * ZIP 包再带上文件数与总大小：这两个也是数出来的，磁盘上此刻是什么样就是什么样，
   * 不存一份可能对不上的计数。
   */
  const publicSkill = (s: Skill) => {
    const base = { ...s, steps: stepsOf(s.body), summary: summaryOf(s.body) }
    if (s.source !== 'ZIP 包') return base
    const files = pkg.list(s.id)
    return { ...base, fileCount: files.length, bytes: files.reduce((n, f) => n + f.size, 0) }
  }
  /** token 只回答**有没有**。存了什么，存进去之后就不再出这台机器。 */
  const publicServer = (s: Server) => ({ ...s, hasToken: !!ctx.storage.getSetting(TOKEN_NS, s.id) })

  /** 真数据：这台机器上此刻注册着的工具。 */
  ctx.server.get('/api/tools', async (req, res) => res.json({ tools: ctx.tools.schemas() }))

  ctx.server.get('/api/skills', async (req, res) =>
    res.json({
      skills: skills.list().map((row) => publicSkill(row.value)),
      servers: servers.list().map((row) => publicServer(row.value)),
      tags: knownTags(),
    }),
  )

  ctx.server.post('/api/skills', async (req, res) =>
    guard(req, res, async () => {
      const b = await body(req)
      const id = `s-${randomUUID()}`
      const now = Date.now()
      const source = b.source === '单文件 Skill' || b.source === 'ZIP 包' ? b.source : '手动编写'
      const files = source === 'ZIP 包' ? filesOf(b.files) : []
      // 包里的 SKILL.md 就是这个 Skill 的正文：步骤数与摘要都从它来，和另外两种
      // 来源走同一条路。找不到就空着，界面会照实说。
      const readme = files.find((f) => f.path.toLowerCase() === 'skill.md')
      const skill: Skill = {
        id,
        name: named(b.name),
        body: source === 'ZIP 包' ? (readme?.text ?? '') : typeof b.body === 'string' ? b.body : '',
        tags: tagsOf(b.tags),
        source,
        ...(str(b.fileName) ? { fileName: str(b.fileName) } : {}),
        enabled: b.enabled !== false,
        createdAt: now,
        updatedAt: now,
      }
      if (files.length) pkg.writeAll(id, files)
      skills.put(id, skill)
      rememberTags(skill.tags)
      return { skill: publicSkill(skill) }
    }),
  )

  ctx.server.patch('/api/skills/:id', async (req, res) =>
    guard(req, res, async () => {
      const current = skills.get(req.params.id)
      if (!current) throw new Error('没有这个 Skill')
      const b = await body(req)
      const next: Skill = { ...current, updatedAt: Date.now() }
      if (b.name !== undefined) next.name = named(b.name)
      if (typeof b.body === 'string') next.body = b.body
      if (Array.isArray(b.tags)) next.tags = tagsOf(b.tags)
      if (typeof b.enabled === 'boolean') next.enabled = b.enabled
      // ZIP 包的正文存在包里的 SKILL.md 上，库里那份是它的副本。改正文就得两边一起
      // 改，否则下次打开文件树，看到的还是旧的那份。
      if (typeof b.body === 'string' && next.source === 'ZIP 包' && pkg.list(next.id).some((f) => f.path === 'SKILL.md')) {
        pkg.writeOne(next.id, 'SKILL.md', b.body)
      }
      skills.put(next.id, next)
      rememberTags(next.tags)
      return { skill: publicSkill(next) }
    }),
  )

  // ── 包内文件 ───────────────────────────────────────────────────────────
  //
  // 只有 ZIP 包来的 Skill 有这些。路径带斜杠，所以走通配段而不是 `:path`。

  ctx.server.get('/api/skills/:id/files', async (req, res) => {
    if (!skills.get(req.params.id)) {
      res.status = 404
      return res.json({ error: '没有这个 Skill' })
    }
    return res.json({ files: pkg.list(req.params.id) })
  })

  /** 单个文件的内容。二进制原样发字节，浏览器那边直接当下载用。 */
  ctx.server.get('/api/skills/:id/files/{*path}', async (req, res) => {
    const rel = decodeURIComponent(req.path.slice(`/api/skills/${req.params.id}/files/`.length))
    try {
      const bytes = pkg.readOne(req.params.id, rel)
      if (pkg.isBinary(bytes)) {
        res.headers.set('content-type', 'application/octet-stream')
        return res.bytes(new Uint8Array(bytes))
      }
      return res.json({ path: rel, text: bytes.toString('utf8') })
    } catch (e) {
      res.status = 404
      return res.json({ error: (e as Error).message })
    }
  })

  ctx.server.put('/api/skills/:id/files/{*path}', async (req, res) =>
    guard(req, res, async () => {
      const skill = skills.get(req.params.id)
      if (!skill) throw new Error('没有这个 Skill')
      const rel = decodeURIComponent(req.path.slice(`/api/skills/${req.params.id}/files/`.length))
      const b = await body(req)
      const text = typeof b.text === 'string' ? b.text : ''
      if (Buffer.byteLength(text) > MAX_PACKAGE_BYTES) throw new Error('这个文件太大了')
      pkg.writeOne(skill.id, rel, text)
      // SKILL.md 是正文那一份，改它等于改正文。
      if (rel.toLowerCase() === 'skill.md') skills.put(skill.id, { ...skill, body: text, updatedAt: Date.now() })
      return { files: pkg.list(skill.id) }
    }),
  )

  ctx.server.delete('/api/skills/:id/files/{*path}', async (req, res) =>
    guard(req, res, async () => {
      const skill = skills.get(req.params.id)
      if (!skill) throw new Error('没有这个 Skill')
      const rel = decodeURIComponent(req.path.slice(`/api/skills/${req.params.id}/files/`.length))
      pkg.removeOne(skill.id, rel)
      if (rel.toLowerCase() === 'skill.md') skills.put(skill.id, { ...skill, body: '', updatedAt: Date.now() })
      return { files: pkg.list(skill.id) }
    }),
  )

  // ── 标签 ──────────────────────────────────────────────────────────────

  ctx.server.post('/api/skills/tags', async (req, res) =>
    guard(req, res, async () => {
      const b = await body(req)
      const tag = named(b.name)
      if (tag.length > 12) throw new Error('标签最多 12 个字')
      const known = knownTags()
      if (!known.includes(tag)) ctx.storage.setSetting(TAG_NS, TAG_KEY, [...known, tag])
      return { tags: knownTags() }
    }),
  )

  /**
   * 删标签**连同用它的 Skill 上那一个一起删**。
   *
   * 只从表里划掉的话，卡片上还挂着它，而选择器里已经没有它了——那个标签从此摘不
   * 掉。所以「删除」就是删除，代价是它动了别的 Skill；界面在按下之前会说清楚动几个。
   */
  ctx.server.delete('/api/skills/tags/{*name}', async (req, res) =>
    guard(req, res, async () => {
      const tag = decodeURIComponent(req.path.slice('/api/skills/tags/'.length))
      ctx.storage.setSetting(TAG_NS, TAG_KEY, knownTags().filter((x) => x !== tag))
      let touched = 0
      for (const row of skills.list()) {
        if (!row.value.tags.includes(tag)) continue
        skills.put(row.id, { ...row.value, tags: row.value.tags.filter((x) => x !== tag), updatedAt: Date.now() })
        touched++
      }
      return { tags: knownTags(), touched }
    }),
  )

  ctx.server.delete('/api/skills/:id', async (req, res) =>
    guard(req, res, async () => {
      if (!skills.delete(req.params.id)) throw new Error('没有这个 Skill')
      // 包里的文件跟着走。留在磁盘上的话，那堆目录再也没有东西指向它们。
      pkg.removeAll(req.params.id)
    }),
  )

  ctx.server.post('/api/mcp-servers', async (req, res) =>
    guard(req, res, async () => {
      const b = await body(req)
      const id = `m-${randomUUID()}`
      const now = Date.now()
      const kind = (KINDS as readonly string[]).includes(str(b.kind)) ? (str(b.kind) as Server['kind']) : 'SSE'
      const endpoint = str(b.endpoint)
      if (!endpoint) throw new Error(kind === 'stdio' ? '要有启动命令' : '要有服务器地址')
      const server: Server = {
        id,
        name: named(b.name),
        kind,
        endpoint,
        env: envOf(b.env),
        perm: (PERMS as readonly string[]).includes(str(b.perm)) ? (str(b.perm) as Server['perm']) : '只读',
        enabled: b.enabled !== false,
        createdAt: now,
        updatedAt: now,
      }
      servers.put(id, server)
      if (str(b.token)) ctx.storage.setSetting(TOKEN_NS, id, str(b.token))
      return { server: publicServer(server) }
    }),
  )

  ctx.server.patch('/api/mcp-servers/:id', async (req, res) =>
    guard(req, res, async () => {
      const current = servers.get(req.params.id)
      if (!current) throw new Error('没有这个 MCP 服务器')
      const b = await body(req)
      const next: Server = { ...current, updatedAt: Date.now() }
      if (b.name !== undefined) next.name = named(b.name)
      if ((KINDS as readonly string[]).includes(str(b.kind))) next.kind = str(b.kind) as Server['kind']
      if (b.endpoint !== undefined) {
        const endpoint = str(b.endpoint)
        if (!endpoint) throw new Error(next.kind === 'stdio' ? '要有启动命令' : '要有服务器地址')
        next.endpoint = endpoint
      }
      if (b.env !== undefined) next.env = envOf(b.env)
      if ((PERMS as readonly string[]).includes(str(b.perm))) next.perm = str(b.perm) as Server['perm']
      if (typeof b.enabled === 'boolean') next.enabled = b.enabled
      servers.put(next.id, next)
      // token 三种意思分开：没带这个字段=不动，带了空串=清掉，带了内容=换新的。
      // 少了「不动」这一档，编辑框每次保存都会把一把看不见的 token 洗掉。
      if (typeof b.token === 'string') {
        if (str(b.token)) ctx.storage.setSetting(TOKEN_NS, next.id, str(b.token))
        else ctx.storage.setSetting(TOKEN_NS, next.id, null)
      }
      return { server: publicServer(next) }
    }),
  )

  ctx.server.delete('/api/mcp-servers/:id', async (req, res) =>
    guard(req, res, async () => {
      if (!servers.delete(req.params.id)) throw new Error('没有这个 MCP 服务器')
      ctx.storage.setSetting(TOKEN_NS, req.params.id, null)
    }),
  )
}
