import { Service, type Context } from '@deepseek-ai/cordis'
import { createReadStream, createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, relative, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { satuworkHome } from '../home.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workspace: WorkspaceService
  }
}

export interface Config {
  /** 工作区根目录。默认 `$SATUWORK_WORK_DIR`，回落 `$SATUWORK_HOME/work`。 */
  root?: string
  /** 单个上传文件的上限（字节）。默认 100 MB，`SATUWORK_UPLOAD_MAX` 可覆盖。 */
  uploadMax?: number
}

/** 越界、参数不对、文件不存在这类**业务**失败。不是管道故障。 */
export class WorkspaceError extends Error {}

const DEFAULT_UPLOAD_MAX = 100 * 1024 * 1024

/**
 * 工作区：Bot 干活的那个目录，以及所有进出它的字节。
 *
 * 单独成服务而不是散在各处，是因为**根目录和越界检查必须只有一份**。碰这个目录的
 * 有三条路——模型的工具（tools/workspace.ts）、浏览器传进来的附件、浏览器要看的
 * 预览（都在 web/index.ts）——三条路各写一份 resolve，迟早会有一条写松。
 *
 * **根目录**：`$SATUWORK_WORK_DIR`，部署时注入的 `/home/{linuxUser}/work`，同一个员工
 * 的所有席位共用。没有这个变量（本地跑）时回落 `$SATUWORK_HOME/work`。
 * **不用 `$SATUWORK_HOME`**：那底下是会话日志和 SQLite，让模型的手伸进自己的记忆里，
 * 一条 `bash rm -rf` 就能把历史抹了。
 *
 * 但要把话说清楚：**这不是沙箱**。工具里的 `bash` 拿到的是真 shell，`cd /` 就出去了。
 * 这里的 resolve 挡的是「路径写错」和「浏览器传了 `../`」，不是「模型想跑出去」。
 * 真正的边界在操作系统那层——专用系统用户、systemd 的 ProtectSystem/ReadWritePaths。
 */
export class WorkspaceService extends Service {
  /** 绝对路径，末尾不带分隔符。 */
  readonly root: string
  readonly uploadMax: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'workspace')
    const raw = config.root?.trim() || process.env.SATUWORK_WORK_DIR?.trim()
    this.root = raw ? resolve(raw) : satuworkHome('work')
    const fromEnv = Number(process.env.SATUWORK_UPLOAD_MAX)
    this.uploadMax = config.uploadMax ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_UPLOAD_MAX)
    // 工作区不存在时先建出来。缺了它，第一次 ls 会以「路径不存在」收场，
    // 而那其实不是模型的错。
    void mkdir(this.root, { recursive: true }).catch(() => {})
  }

  /**
   * 参数路径 → 绝对路径。越界即拒。
   *
   * 这里不 realpath：解析一条还不存在的写入路径会失败，而 write 要能创建新文件。
   * 也就是说符号链接绕得过去——见类注释，这层挡的是手滑，不是恶意。
   */
  resolve(path?: string): string {
    const target = resolve(this.root, path?.trim() || '.')
    if (target !== this.root && !target.startsWith(this.root + sep)) {
      throw new WorkspaceError(`路径越界：${path}。只能访问工作区 ${this.root} 以内的文件。`)
    }
    return target
  }

  /** 展示用相对路径。根目录本身显示成 `.`。 */
  show(path: string): string {
    return relative(this.root, path) || '.'
  }

  /**
   * 把上传的字节流写进 `uploads/<sessionId>/`，返回工作区相对路径。
   *
   * **边写边数**：先收完再看大小，等于让任何人都能拿磁盘换一次拒绝。超限就地
   * 中断、把半个文件删掉，不留残骸。
   */
  async saveUpload(sessionId: string, filename: string, body: ReadableStream<Uint8Array> | null) {
    if (!body) throw new WorkspaceError('请求体是空的')
    const dir = this.resolve(`uploads/${safeSegment(sessionId)}`)
    await mkdir(dir, { recursive: true })
    const target = await freshPath(dir, safeName(filename))
    const out = createWriteStream(target)
    /**
     * 写失败（盘满、目录被人删掉）之后 `drain` 永远不会来，只等它这条上传就挂在一个
     * 不会再有任何事件的流上，请求永远不返回。所以把第一个错记下来，背压那一等也认它。
     */
    let failed: Error | undefined
    out.on('error', (e: Error) => {
      failed ??= e
    })
    let size = 0
    try {
      for await (const chunk of Readable.fromWeb(body as any)) {
        if (failed) throw failed
        size += (chunk as Buffer).length
        if (size > this.uploadMax) throw new WorkspaceError(`文件超过上限 ${humanSize(this.uploadMax)}`)
        if (!out.write(chunk)) await drained(out)
      }
      if (failed) throw failed
      await new Promise<void>((ok, no) => out.end((e?: Error) => (e ? no(e) : ok())))
    } catch (e) {
      out.destroy()
      await rm(target, { force: true }).catch(() => {})
      throw e
    }
    return { path: this.show(target), name: basename(target), size, ...contentTypeOf(target) }
  }

  /**
   * 把一段**已经在手上的**字节落进 `<dir>/<filename>`。目录不存在就建，重名不覆盖。
   *
   * 和 saveUpload 分开而不是合并：那条收的是外面一条不受信的请求体，所以边写边数、
   * 超限就地中断；这条收的是我们自己生成的东西（浏览器截图），大小早就定了，再套一层
   * 流只是绕路。共用的是路径这一头——`resolve` 的越界检查和 `freshPath` 的不覆盖，
   * 那两样按这个文件开头的说法只能有一份。
   */
  async saveBytes(dir: string, filename: string, bytes: Uint8Array) {
    // dir 是我们自己拼的（`browser/<sessionId>`），但 sessionId 一路来自外面，
    // 所以每一段照样过一遍清洗；resolve 那道是最后的兜底，不是唯一一道。
    const cleaned = dir.split('/').map(safeSegment).filter(Boolean).join('/') || 'misc'
    const target = this.resolve(cleaned)
    await mkdir(target, { recursive: true })
    const file = await freshPath(target, safeName(filename))
    await writeFile(file, bytes)
    return { path: this.show(file), name: basename(file), size: bytes.byteLength }
  }

  /** 读一个文件用来预览。返回 Web 流，不进内存。 */
  async open(path: string) {
    const target = this.resolve(path)
    const info = await stat(target)
    if (info.isDirectory()) throw new WorkspaceError(`${this.show(target)} 是目录，不能预览。`)
    return {
      name: basename(target),
      size: info.size,
      ...contentTypeOf(target),
      stream: Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>,
    }
  }
}

/**
 * 背压：等这个可写流把缓冲吃掉。**close 和 error 也要收，不能只等 drain。**
 *
 * 毁掉或者出错的可写流只发 `close` / `error`，`drain` 一辈子不会再来——只等它的话，
 * 一次「盘满」就会让这条上传永远挂在那儿，请求不返回、临时文件也不删。三个事件哪个
 * 先到都算「不必再等了」，错由外面那个 `failed` 接着抛。
 */
function drained(out: WriteStream): Promise<void> {
  if (out.destroyed || out.writableEnded) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const done = () => {
      out.off('drain', done)
      out.off('close', done)
      out.off('error', done)
      resolve()
    }
    out.once('drain', done)
    out.once('close', done)
    out.once('error', done)
  })
}

/**
 * 文件名清洗。
 *
 * 浏览器传上来的名字是**外部输入**，可以是 `../../../.ssh/authorized_keys`，也可以带
 * 换行去污染 header。这里只取最后一段、剔掉分隔符和控制字符，剩下的交给 resolve()。
 */
export function safeName(raw: string): string {
  const base = basename((raw || '').replace(/\\/g, '/').trim())
  const cleaned = base
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 200)
    .trim()
  return cleaned || 'file'
}

/**
 * 路径里的一段（sessionId）。它进的是目录名，不能带分隔符。
 *
 * 前导点单独剔一次：`../../..` 只去分隔符会剩下 `......`——那确实不是 `..`、也确实
 * 跑不出去（resolve 还会再拦一道），但让一个可疑的 id 在磁盘上留下这么个目录名，
 * 下次有人看到只会以为出了别的事。
 */
function safeSegment(raw: string): string {
  const cleaned = (raw || '').replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 100)
  return cleaned || 'misc'
}

/** 重名不覆盖：`a.png` 撞了就 `a-1.png`。传两次同名文件是常事，覆盖掉是数据丢失。 */
async function freshPath(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length) || 'file'
  for (let i = 0; i < 1000; i++) {
    const candidate = resolve(dir, i ? `${stem}-${i}${ext}` : name)
    // 落在 dir 之外说明清洗漏了东西，宁可整个拒掉。
    if (candidate !== dir && !candidate.startsWith(dir + sep)) throw new WorkspaceError('文件名不合法')
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  throw new WorkspaceError('同名文件太多了')
}

/**
 * 能安全地让浏览器**内联渲染**的类型。
 *
 * 这张表是白名单，不是「我们认识的格式」表——它决定哪些字节能带着自己的 MIME 在
 * 浏览器里跑起来。SVG 和 HTML **故意不在**：它们能带 `<script>`，内联渲染等于让上传
 * 者在 Gateway 的源上执行代码，登录态就归他了。它们照样能传、能下载、能被工具读，
 * 只是不给内联。
 */
const INLINE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  // 文本一律 text/plain：浏览器不执行它，而按真实类型发 .md / .csv 只会触发下载。
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/plain; charset=utf-8',
  '.tsv': 'text/plain; charset=utf-8',
  '.json': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
}

/**
 * 扩展名 → MIME 与「能不能内联」。
 *
 * 不在白名单里的一律 `application/octet-stream` + 下载。**绝不按内容嗅探**：嗅探正是
 * 那类漏洞的来源，一个改名成 `.png` 的 HTML 文件能骗过任何嗅探器。
 */
export function contentTypeOf(name: string): { contentType: string; inline: boolean } {
  const hit = INLINE[extname(name).toLowerCase()]
  return hit ? { contentType: hit, inline: true } : { contentType: 'application/octet-stream', inline: false }
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** \0 出现在头部就当二进制。够用，且比嗅探 MIME 便宜。 */
export function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0)
}

export const name = 'satu-workspace'

export function apply(ctx: Context, config: Config = {}) {
  ctx.plugin(WorkspaceService, config)
}
