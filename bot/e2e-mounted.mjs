/**
 * **照真实组合起一遍，看该在的服务和工具在不在。**
 *
 * 这个套件是补一次事故补出来的：`BrowserService` 上写了 `static inject = ['logger']`，
 * 而 `logger` 根本不是服务（`satu-logger` 只给 cordis 自带的 logger 挂 exporter，从没
 * provide 过）。那条 inject 永远满足不了，于是服务不启动、`ctx.browser` 不存在、
 * `browser/tools.ts` 的 `inject: ['browser']` 跟着一直挂着——**十二把工具一把都没注册，
 * 而且一声不响**：进程正常起来、健康检查通过、类型检查干净、日志一个字都没有。
 *
 * 已有的两个套件都测不到它：它们各自 `ctx.plugin(服务)` 手动挂，**绕过了 inject**。
 * 真正的组合只发生在 Loader 读 cordis.yml 那一刻，所以这里就照那条路起。
 *
 * 断言是「名单」而不是「数量」：加一把工具要顺手把名字写进来，那是一秒钟的事；
 * 而少一把工具的代价是模型说「我没有这个功能」，而所有别的信号都是绿的。
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import * as vendored from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const { Context } = vendored
const botRoot = dirname(fileURLToPath(import.meta.url))
const ymlPath = join(botRoot, 'cordis.mounted.yml')

/** cordis.yml 里挂的每一个服务。少一个就说明它那条 inject 没满足。 */
const SERVICES = ['storage', 'sessions', 'roster', 'tools', 'llm', 'workspace', 'catalog', 'policy', 'browser', 'agents']

/**
 * 不接 Gateway 时应当注册的全部工具。
 *
 * `mcp_*` 不在里面——那些要连上目录才有，本机裸起时一个都不该有。
 */
const TOOLS = [
  'now',
  'read', 'write', 'edit', 'ls', 'find', 'grep', 'bash',
  'web_search', 'web_extract',
  'history_read', 'history_search',
  'escalate_to_human',
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_press',
  'browser_dialog', 'browser_back', 'browser_scroll', 'browser_read', 'browser_wait_for',
  'browser_select', 'browser_tabs',
]

const cleanup = () => {
  try { unlinkSync(ymlPath) } catch {}
}
process.on('exit', cleanup)

// 端口挪开，别跟正式入口和别的套件抢。
writeFileSync(ymlPath, readFileSync(join(botRoot, 'cordis.yml'), 'utf8').replace(/port:\s*\d+/, `port: ${process.env.SATUWORK_PORT || '18124'}`))

const ctx = new Context()
ctx.baseUrl = pathToFileURL(botRoot).href + '/'
await ctx.plugin(Loader)
await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-include', config: { path: ymlPath } })
// 挂载是并发的，`inject` 决定先后。给足时间——挂不上的那些**不会报错，只会一直挂着**，
// 所以这里等的是「都起来了」，不是「起完了」。
await new Promise((r) => setTimeout(r, 5000))

const provided = {}
for (const name of SERVICES) {
  let ok = false
  try {
    ok = ctx.reflect?.get?.(name) !== undefined
  } catch {
    ok = false
  }
  provided[name] = ok
}
const names = ctx.tools?.schemas().map((t) => t.name) ?? []
const missing = TOOLS.filter((t) => !names.includes(t))
const extra = names.filter((n) => !TOOLS.includes(n) && !n.startsWith('mcp_'))

console.log('__RESULT__' + JSON.stringify({ provided, missing, extra, count: names.length }))
cleanup()
process.exit(0)
