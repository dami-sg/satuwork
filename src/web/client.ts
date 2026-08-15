import { Service, type Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './static.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    client: ClientService
  }
}

/** 一个插件的浏览器半边。 */
export interface ClientEntry {
  /** 条目 id，同时是 URL 前缀。用插件名，别用路径。 */
  id: string
  /** 入口模块的文件路径。同目录的兄弟文件一并发出，模块之间可以相对 import。 */
  entry: string | URL
  /** 图上的依赖边。**只是信息**——真正的等待发生在浏览器那棵树的 `inject` 里。 */
  inject?: string[]
  /** 一阶段预取：boot 时就 import。不标的条目等到第一次用到才拉。 */
  immediately?: boolean
}

/** 注入给浏览器的那张图。它是宿主与浏览器之间**唯一**的接头。 */
export interface BootGraph {
  rev: string
  entries: { id: string; url: string; rev: string; inject?: string[]; immediately?: boolean }[]
}

/**
 * 浏览器运行时的单例。
 *
 * 插件的浏览器半边在运行时被 `import()`，那它们必须共享同一份框架实例——两份
 * Cordis 意味着 Service 与 Context 不是同一个类，跟启动器里守着的是同一条线，
 * 只是搬到了浏览器。这张表是唯一的来源：importmap 由它生成，插件写裸说明符。
 */
const VENDOR: Record<string, string> = {
  // 浏览器里跑的是同一个 Cordis：ctx.effect / inject / 卸载语义两边一致。
  '@deepseek-ai/cordis': 'cordis.js',
  '@deepseek-ai/cosmokit': 'cosmokit.js',
  preact: 'preact.js',
  'preact/hooks': 'preact-hooks.js',
  htm: 'htm.js',
}

const hash = (buf: Buffer) => createHash('sha256').update(buf).digest('hex').slice(0, 8)

/**
 * 客户端模块注册表——插件表的宿主半边。
 *
 * 一个功能插件不只注册路由，它还可以注册自己的浏览器半边；那半边随插件卸载而
 * 从图里消失，连带它在界面上贡献的一切。UI 的生命周期与插件的生命周期是同一条轴，
 * 前端不是这套架构里唯一的例外。
 */
export class ClientService extends Service {
  private entries = new Map<string, { file: string; dir: string; inject?: string[]; immediately?: boolean }>()
  private vendor = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'client')
    for (const [spec, name] of Object.entries(VENDOR)) {
      // 解析失败就在启动时炸掉：importmap 少一条，浏览器那边报的是「裸说明符
      // 解析不了」，指向的位置离病因很远。
      this.vendor.set(name, fileURLToPath(import.meta.resolve(spec)))
    }

    /** 各插件的浏览器半边。整个目录发出去，模块之间可以相对 import。 */
    ctx.server.get('/plugins/:id/{*file}', async (req, res) => {
      const entry = this.entries.get(req.params.id)
      const file = req.path.slice(`/plugins/${req.params.id}/`.length)
      // 未知 id 必须是响亮的 404，不能掉进 SPA 兜底——否则浏览器把一段 HTML
      // 当 JavaScript 执行，报错指向语法而不是「这个插件没挂上」。
      if (!entry || !file || !serve(res, entry.dir, file)) {
        res.status = 404
        return res.json({ error: 'unknown client module', id: req.params.id })
      }
    })

    /** 浏览器运行时单例。importmap 把裸说明符指到这里。 */
    ctx.server.get('/vendor/:name', async (req, res) => {
      const file = this.vendor.get(req.params.name)
      if (!file || !serve(res, dirname(file), file.slice(dirname(file).length + 1))) {
        res.status = 404
        return res.json({ error: 'unknown vendor module', name: req.params.name })
      }
    })
  }

  register(entry: ClientEntry) {
    const file = typeof entry.entry === 'string' ? entry.entry : fileURLToPath(entry.entry)
    if (this.entries.has(entry.id)) throw new Error(`client: ${entry.id} 已注册`)
    if (!existsSync(file)) throw new Error(`client: ${entry.id} 的入口不存在——${file}`)
    this.entries.set(entry.id, { file, dir: dirname(file), inject: entry.inject, immediately: entry.immediately })
    return this.ctx.effect(() => () => {
      this.entries.delete(entry.id)
    })
  }

  /**
   * 当前这张图。
   *
   * rev 是**每次现算**的内容哈希：开发时改完刷新即生效，不需要另一条监听链路。
   * 代价是每次渲染 index 都读一遍入口文件——条目是几十个的量级，不值得为它加缓存。
   */
  graph(): BootGraph {
    const entries = [...this.entries].map(([id, e]) => {
      const rev = hash(readFileSync(e.file))
      return {
        id,
        url: `/plugins/${id}/${e.file.slice(e.dir.length + 1)}?rev=${rev}`,
        rev,
        ...(e.inject?.length ? { inject: e.inject } : {}),
        ...(e.immediately ? { immediately: true } : {}),
      }
    })
    return { rev: hash(Buffer.from(JSON.stringify(entries))), entries }
  }

  /** importmap 的 imports 部分。shell 的地址由 web 插件补上。 */
  imports(): Record<string, string> {
    return Object.fromEntries(Object.entries(VENDOR).map(([spec, name]) => [spec, `/vendor/${name}`]))
  }

}

export const name = 'satu-client'
export const inject = ['server']

export function apply(ctx: Context) {
  ctx.plugin(ClientService)
}
