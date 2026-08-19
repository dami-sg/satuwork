import { spawn } from 'node:child_process'
import type { Dirent } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { humanSize, looksBinary, WorkspaceError } from '../workspace/index.ts'
import type { WorkspaceFile } from './index.ts'

/**
 * 工作区工具：read / write / edit / ls / find / grep / bash。
 *
 * 这是 Bot 真正干活的那套手：看文件、改文件、跑命令。形状照 Claude Code 那一套来，
 * 因为模型见过——描述与参数名越接近它熟悉的约定，调用就越准。
 *
 * **根目录**：`$SATUWORK_WORK_DIR`——部署时注入的 `/home/{linuxUser}/work`，同一个员工
 * 的所有席位共用的那个共享工作区。没有这个变量（本地跑）时回落 `$SATUWORK_HOME/work`；
 * 插件 config.root 可以覆盖。**不用 `$SATUWORK_HOME`**：那底下是会话日志和 SQLite，
 * 让模型的手伸进自己的记忆里，一条 `bash rm -rf` 就能把历史抹了。
 *
 * 路径参数一律相对根目录解析，越界（`..`、绝对路径指到外面）直接拒。
 *
 * 但要把话说清楚：**这不是沙箱**。`bash` 拿到的是一个真 shell，它 `cd /` 就出去了，
 * 符号链接也能指到外面。路径检查挡的是「模型手滑写错路径」，不是「模型想跑出去」。
 * 真正的边界在操作系统那层——专用系统用户、systemd 的 ProtectSystem/ReadWritePaths、
 * 或者容器；策略性的拦截（审批、白名单）挂 `tools/pre-execute` 的 waterfall，那里
 * 短路才是强制执行。别指望这里的 resolve() 顶那两层的用。
 */
export const name = 'satu-tools-workspace'
export const inject = ['tools', 'workspace']

export interface Config {
  /** bash 默认超时（毫秒）。 */
  timeout?: number
}

/** 输出上限。喂回模型的东西必须有界，否则一次 `grep .` 就能把上下文冲掉。 */
const MAX_READ_LINES = 2000
const MAX_LINE_CHARS = 2000
const MAX_TEXT_CHARS = 120_000
const MAX_OUTPUT_CHARS = 30_000
const MAX_LIST_ENTRIES = 300
const MAX_FIND_RESULTS = 200
const MAX_GREP_MATCHES = 100
const MAX_WALK_FILES = 20_000
const MAX_GREP_FILE_BYTES = 2 * 1024 * 1024
const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000

/** 遍历时跳过的目录。命中一次 node_modules 就没有下文了。 */
const SKIPPED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out',
  '.next', '.nuxt', '.cache', '.turbo', 'coverage',
  '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', 'target',
])

/** 业务失败：参数不对、文件不存在、命令没找到。**不是**管道故障，照常返回文本。 */
class ToolFailure extends Error {}

function fail(message: string): never {
  throw new ToolFailure(message)
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`
}

/**
 * glob → 正则。支持 `**`（跨目录）、`*`、`?`。
 * 自带 glob 而不是拉个依赖：这三个元字符覆盖了模型实际会写的绝大多数模式。
 */
function globToRegExp(glob: string): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` 匹配零级或多级目录，所以 `**/*.ts` 也能命中根下的文件。
        if (glob[i + 2] === '/') {
          out += '(?:[^/]+/)*'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if ('\\^$+.()|[]{}'.includes(c)) {
      out += `\\${c}`
    } else {
      out += c
    }
  }
  return new RegExp(`^${out}$`)
}

/** 没有 `/` 的模式按文件名匹配——`*.ts` 应该找到所有 .ts，不只是根下那几个。 */
function globMatcher(glob: string): (rel: string) => boolean {
  const re = globToRegExp(glob)
  const bare = !glob.includes('/')
  return (rel) => re.test(rel) || (bare && re.test(rel.split('/').pop() ?? rel))
}

/** 递归列出普通文件。符号链接不跟——跟了会绕圈，也会绕出工作区。 */
async function* walkFiles(dir: string, budget: { left: number }): AsyncGenerator<string> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (budget.left <= 0) return
    const full = join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue
      yield* walkFiles(full, budget)
    } else if (entry.isFile()) {
      budget.left -= 1
      yield full
    }
  }
}

/** 起点可以是文件（grep 单文件）也可以是目录。 */
async function* filesUnder(target: string): AsyncGenerator<string> {
  const info = await stat(target).catch(() => fail(`路径不存在：${target}`))
  if (info.isFile()) {
    yield target
    return
  }
  yield* walkFiles(target, { left: MAX_WALK_FILES })
}

/** 跑一条命令。永远 resolve；退出码非零是业务结果，由调用方写进文本。 */
function runCommand(command: string, cwd: string, timeout: number) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; bytes: number; timedOut: boolean; error?: string }>(
    (done) => {
      // detached：拿到自己的进程组。否则超时只杀得掉 bash，它 fork 出去的
      // （`npm run dev &`、管道里的子进程）会活下来，端口和 CPU 一起留着。
      const child = spawn('bash', ['-c', command], {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
      let out = ''
      let bytes = 0
      let timedOut = false
      const collect = (buf: Buffer) => {
        bytes += buf.length
        if (out.length < MAX_OUTPUT_CHARS) out += buf.toString('utf8')
      }
      child.stdout?.on('data', collect)
      child.stderr?.on('data', collect)
      const timer = setTimeout(() => {
        timedOut = true
        try {
          process.kill(-child.pid!, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }, timeout)
      child.on('error', (e) => {
        clearTimeout(timer)
        done({ code: null, signal: null, out, bytes, timedOut, error: e.message })
      })
      child.on('close', (code, signal) => {
        clearTimeout(timer)
        done({ code, signal, out, bytes, timedOut })
      })
    },
  )
}

export function apply(ctx: Context, config: Config = {}) {
  // 根目录和越界检查都在 workspace 服务上——上传和预览走的是同一份，
  // 各写一份 resolve 迟早会有一条写松。
  const root = ctx.workspace.root
  const resolveIn = (path?: string) => ctx.workspace.resolve(path)
  const show = (path: string) => ctx.workspace.show(path)
  const defaultTimeout = Math.min(config.timeout || DEFAULT_TIMEOUT, MAX_TIMEOUT)

  /** 统一把业务失败收成文本。管道故障（真异常）继续往上抛，由 ToolService 标 failed。 */
  const tool = (
    def: { name: string; description: string; parameters: Record<string, unknown> },
    execute: (args: any) => Promise<string | { text: string; files: WorkspaceFile[] }> | string,
  ) => {
    ctx.tools.register({
      ...def,
      async execute(args) {
        try {
          const out = await execute((args ?? {}) as any)
          return typeof out === 'string' ? { text: out } : out
        } catch (e) {
          // 越界是模型写错了路径，跟「文件不存在」同类——告诉它，让它改，
          // 不是管道故障。
          if (e instanceof WorkspaceError) return { text: e.message }
          if (e instanceof ToolFailure) return { text: e.message }
          const err = e as NodeJS.ErrnoException
          if (err?.code === 'ENOENT') return { text: `文件或目录不存在：${err.path ?? ''}` }
          if (err?.code === 'EACCES') return { text: `没有权限：${err.path ?? ''}` }
          if (err?.code === 'EISDIR') return { text: `这是一个目录，不是文件：${err.path ?? ''}` }
          throw e
        }
      },
    })
  }

  tool(
    {
      name: 'read',
      description:
        '读取工作区里的一个文件，按行返回并带行号。改文件之前必须先读——edit 要求 old_string 与文件里的内容逐字相同。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，相对工作区根目录，也可用绝对路径（须在工作区内）。' },
          offset: { type: 'number', description: '从第几行开始读（1 起）。默认 1。' },
          limit: { type: 'number', description: `最多读多少行。默认 ${MAX_READ_LINES}。` },
        },
        required: ['path'],
      },
    },
    async ({ path, offset, limit }: { path?: string; offset?: number; limit?: number }) => {
      if (!path) fail('缺少 path 参数')
      const target = resolveIn(path)
      const info = await stat(target)
      if (info.isDirectory()) fail(`${show(target)} 是目录，用 ls 列它的内容。`)
      const buf = await readFile(target)
      if (!buf.length) return `${show(target)} 是空文件。`
      if (looksBinary(buf)) return `${show(target)} 是二进制文件（${humanSize(info.size)}），不能按文本读。`

      const lines = buf.toString('utf8').split('\n')
      const start = Math.max(1, Math.floor(offset ?? 1))
      const count = Math.max(1, Math.min(Math.floor(limit ?? MAX_READ_LINES), MAX_READ_LINES))
      const picked = lines.slice(start - 1, start - 1 + count)
      if (!picked.length) fail(`offset ${start} 超出文件长度（共 ${lines.length} 行）`)

      const width = String(start + picked.length - 1).length
      const body = picked
        .map((line, i) => `${String(start + i).padStart(width, ' ')}\t${clip(line, MAX_LINE_CHARS)}`)
        .join('\n')
      const tail =
        start - 1 + picked.length < lines.length
          ? `\n…（还有 ${lines.length - (start - 1 + picked.length)} 行，用 offset 继续读）`
          : ''
      return clip(body, MAX_TEXT_CHARS) + tail
    },
  )

  tool(
    {
      name: 'write',
      description: '把内容整体写入一个文件，已存在就覆盖，父目录自动创建。只改一处时用 edit，别用它重写整个文件。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，相对工作区根目录。' },
          content: { type: 'string', description: '文件的完整内容。' },
        },
        required: ['path', 'content'],
      },
    },
    async ({ path, content }: { path?: string; content?: string }) => {
      if (!path) fail('缺少 path 参数')
      if (typeof content !== 'string') fail('缺少 content 参数')
      const target = resolveIn(path)
      const existed = await stat(target).then(
        (s) => (s.isDirectory() ? fail(`${show(target)} 是目录，不能当文件写。`) : true),
        () => false,
      )
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, 'utf8')
      const bytes = Buffer.byteLength(content)
      return {
        text: `${existed ? '已覆盖' : '已创建'} ${show(target)}（${content.split('\n').length} 行，${humanSize(bytes)}）`,
        files: [{ path: show(target), name: basename(target) }],
      }
    },
  )

  tool(
    {
      name: 'edit',
      description:
        '把文件里的一段文本原样替换成另一段。old_string 必须与文件内容逐字相同（含缩进），并且在文件里唯一——不唯一就多带几行上下文，或者置 replace_all。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径，相对工作区根目录。' },
          old_string: { type: 'string', description: '要被替换的原文。' },
          new_string: { type: 'string', description: '替换成的新文本。传空串表示删除。' },
          replace_all: { type: 'boolean', description: '替换全部出现处。默认 false，只允许唯一匹配。' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    async ({
      path,
      old_string: oldString,
      new_string: newString,
      replace_all: replaceAll,
    }: { path?: string; old_string?: string; new_string?: string; replace_all?: boolean }) => {
      if (!path) fail('缺少 path 参数')
      if (typeof oldString !== 'string' || !oldString) fail('缺少 old_string 参数')
      if (typeof newString !== 'string') fail('缺少 new_string 参数')
      if (oldString === newString) fail('old_string 与 new_string 相同，没有可改的东西。')

      const target = resolveIn(path)
      const buf = await readFile(target)
      if (looksBinary(buf)) fail(`${show(target)} 是二进制文件，不能编辑。`)
      const before = buf.toString('utf8')

      const hits = before.split(oldString).length - 1
      if (!hits) fail(`没找到那段文本。先用 read 确认 ${show(target)} 里的原文（缩进和空白要一致）。`)
      if (hits > 1 && !replaceAll) {
        fail(`那段文本出现了 ${hits} 次。多带几行上下文让它唯一，或者置 replace_all=true 全部替换。`)
      }

      const after = replaceAll ? before.split(oldString).join(newString) : before.replace(oldString, newString)
      await writeFile(target, after, 'utf8')
      return {
        text: `已修改 ${show(target)}（替换 ${replaceAll ? hits : 1} 处）`,
        files: [{ path: show(target), name: basename(target) }],
      }
    },
  )

  tool(
    {
      name: 'ls',
      description: '列出一个目录下的条目，目录带 / 后缀，文件带大小。不知道工作区里有什么时先用它。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径，相对工作区根目录。默认根目录。' },
          all: { type: 'boolean', description: '包含以 . 开头的隐藏条目。默认 false。' },
        },
      },
    },
    async ({ path, all }: { path?: string; all?: boolean }) => {
      const target = resolveIn(path)
      const info = await stat(target)
      if (!info.isDirectory()) fail(`${show(target)} 不是目录，用 read 读它。`)

      const entries = (await readdir(target, { withFileTypes: true })).filter(
        (e) => all || !e.name.startsWith('.'),
      )
      if (!entries.length) return `${show(target)} 是空目录。`

      entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
      const shown = entries.slice(0, MAX_LIST_ENTRIES)
      const lines = await Promise.all(
        shown.map(async (e) => {
          if (e.isDirectory()) return `${e.name}/`
          if (e.isSymbolicLink()) return `${e.name} -> (符号链接)`
          const s = await stat(join(target, e.name)).catch(() => undefined)
          return `${e.name}\t${s ? humanSize(s.size) : '?'}`
        }),
      )
      const more = entries.length > shown.length ? `\n…（还有 ${entries.length - shown.length} 条未列出）` : ''
      return `${show(target)}：\n${lines.join('\n')}${more}`
    },
  )

  tool(
    {
      name: 'find',
      description:
        '按文件名模式找文件，返回相对路径，按修改时间从新到旧。模式支持 * ? 与 **，例如 "*.ts"、"src/**/*.json"。node_modules、.git、dist 这类目录会跳过。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: '文件名或路径的 glob，如 "*.md" 或 "src/**/*.ts"。' },
          path: { type: 'string', description: '从哪个目录开始找，相对工作区根目录。默认根目录。' },
          limit: { type: 'number', description: `最多返回多少条。默认 ${MAX_FIND_RESULTS}。` },
        },
        required: ['pattern'],
      },
    },
    async ({ pattern, path, limit }: { pattern?: string; path?: string; limit?: number }) => {
      if (!pattern) fail('缺少 pattern 参数')
      const base = resolveIn(path)
      const info = await stat(base)
      if (!info.isDirectory()) fail(`${show(base)} 不是目录。`)

      const match = globMatcher(pattern)
      const cap = Math.max(1, Math.min(Math.floor(limit ?? MAX_FIND_RESULTS), MAX_FIND_RESULTS))
      const found: { rel: string; mtime: number }[] = []
      for await (const file of walkFiles(base, { left: MAX_WALK_FILES })) {
        // 模式按「相对搜索起点」匹配，展示按「相对工作区根」——前者是模型写模式时
        // 心里想的，后者才能直接喂回 read。
        const rel = relative(base, file).split(sep).join('/')
        if (!match(rel)) continue
        const s = await stat(file).catch(() => undefined)
        found.push({ rel: show(file).split(sep).join('/'), mtime: s?.mtimeMs ?? 0 })
      }
      if (!found.length) return `没有匹配 ${pattern} 的文件（起点 ${show(base)}）。`

      found.sort((a, b) => b.mtime - a.mtime)
      const shown = found.slice(0, cap)
      const more = found.length > shown.length ? `\n…（共 ${found.length} 个，只列出 ${shown.length} 个）` : ''
      return shown.map((f) => f.rel).join('\n') + more
    },
  )

  tool(
    {
      name: 'grep',
      description:
        '在文件内容里按正则搜索，返回 路径:行号: 内容。可用 glob 限定文件类型。二进制文件与 node_modules、.git、dist 这类目录会跳过。',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'JavaScript 正则，如 "function\\\\s+main" 或 "TODO"。' },
          path: { type: 'string', description: '搜索的文件或目录，相对工作区根目录。默认根目录。' },
          glob: { type: 'string', description: '只搜匹配这个 glob 的文件，如 "*.ts"。' },
          ignore_case: { type: 'boolean', description: '忽略大小写。默认 false。' },
          files_only: { type: 'boolean', description: '只返回命中的文件列表，不返回行。默认 false。' },
          limit: { type: 'number', description: `最多返回多少条匹配。默认 ${MAX_GREP_MATCHES}。` },
        },
        required: ['pattern'],
      },
    },
    async ({
      pattern,
      path,
      glob,
      ignore_case: ignoreCase,
      files_only: filesOnly,
      limit,
    }: {
      pattern?: string
      path?: string
      glob?: string
      ignore_case?: boolean
      files_only?: boolean
      limit?: number
    }) => {
      if (!pattern) fail('缺少 pattern 参数')
      let re: RegExp
      try {
        re = new RegExp(pattern, ignoreCase ? 'i' : '')
      } catch (e) {
        fail(`正则写错了：${(e as Error).message}`)
      }
      const base = resolveIn(path)
      const match = glob ? globMatcher(glob) : undefined
      const cap = Math.max(1, Math.min(Math.floor(limit ?? MAX_GREP_MATCHES), MAX_GREP_MATCHES))

      const lines: string[] = []
      const hitFiles: string[] = []
      let truncated = false

      outer: for await (const file of filesUnder(base)) {
        const rel = show(file).split(sep).join('/')
        if (match && !match(relative(base, file).split(sep).join('/'))) continue
        const s = await stat(file).catch(() => undefined)
        if (!s || s.size > MAX_GREP_FILE_BYTES) continue
        const buf = await readFile(file).catch(() => undefined)
        if (!buf || looksBinary(buf)) continue

        let hit = false
        const content = buf.toString('utf8').split('\n')
        for (let i = 0; i < content.length; i++) {
          if (!re.test(content[i])) continue
          hit = true
          if (filesOnly) break
          lines.push(`${rel}:${i + 1}: ${clip(content[i].trim(), MAX_LINE_CHARS)}`)
          if (lines.length >= cap) {
            truncated = true
            break outer
          }
        }
        if (hit) {
          hitFiles.push(rel)
          if (filesOnly && hitFiles.length >= cap) {
            truncated = true
            break
          }
        }
      }

      if (filesOnly) {
        if (!hitFiles.length) return `没有文件匹配 ${pattern}。`
        return hitFiles.join('\n') + (truncated ? `\n…（已达 ${cap} 条上限）` : '')
      }
      if (!lines.length) return `没有匹配 ${pattern} 的内容（范围 ${show(base)}）。`
      return (
        `${lines.length} 条匹配，来自 ${hitFiles.length} 个文件：\n${lines.join('\n')}` +
        (truncated ? `\n…（已达 ${cap} 条上限，缩小范围或加 glob）` : '')
      )
    },
  )

  tool(
    {
      name: 'bash',
      description:
        `在工作区里执行一条 bash 命令，返回标准输出与标准错误。默认工作目录是工作区根目录，超时 ${Math.round(defaultTimeout / 1000)} 秒。` +
        '查找文件用 find、搜内容用 grep、读文件用 read——它们的输出更适合阅读。命令是非交互执行的，不要跑需要输入或永不退出的程序。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令，如 "git status --short"。' },
          cwd: { type: 'string', description: '工作目录，相对工作区根目录。默认根目录。' },
          timeout: { type: 'number', description: `超时毫秒数，上限 ${MAX_TIMEOUT}。默认 ${defaultTimeout}。` },
        },
        required: ['command'],
      },
    },
    async ({ command, cwd, timeout }: { command?: string; cwd?: string; timeout?: number }) => {
      if (!command?.trim()) fail('缺少 command 参数')
      const dir = resolveIn(cwd)
      const info = await stat(dir).catch(() => fail(`工作目录不存在：${show(dir)}`))
      if (!info.isDirectory()) fail(`${show(dir)} 不是目录。`)
      const ms = Math.max(1000, Math.min(Math.floor(timeout || defaultTimeout), MAX_TIMEOUT))

      const { code, signal, out, bytes, timedOut, error } = await runCommand(command, dir, ms)
      if (error) fail(`无法执行：${error}`)

      const body = out.trim() || '（没有输出）'
      const cut = bytes > Buffer.byteLength(out) ? `\n…（输出已截断，共 ${humanSize(bytes)}）` : ''
      // 退出码非零是**业务**结果，不是管道故障：模型要看到它并自己决定下一步。
      if (timedOut) return `命令超时（${ms} 毫秒）已被终止。\n${body}${cut}`
      if (code === 0) return `${body}${cut}`
      const how = code === null ? `被信号 ${signal} 终止` : `退出码 ${code}`
      return `命令${how}。\n${body}${cut}`
    },
  )
}
