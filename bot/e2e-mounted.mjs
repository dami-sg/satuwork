/**
 * **照真实组合起一遍，看该在的服务和工具在不在。**
 *
 * 这个套件是补一次事故补出来的：`BrowserService` 上写了 `static inject = ['logger']`，
 * 而 `logger` 根本不是服务（`satu-logger` 只给 cordis 自带的 logger 挂 exporter，从没
 * provide 过）。那条 inject 永远满足不了，于是服务不启动、`ctx.browser` 不存在、
 * `browser/tools.ts` 的 `inject: ['browser']` 跟着一直挂着——**十二把工具一把都没注册，
 * 而且一声不响**：进程正常起来、健康检查通过、类型检查干净、日志一个字都没有。
 *
 * 另外两个套件都测不到它：它们各自 `ctx.plugin(服务)` 手动挂，**绕过了 inject**。
 * 真正的组合只发生在 Loader 读 cordis.yml 那一刻，所以这里就照那条路起。
 *
 * 断言是「名单」而不是「数量」：加一把工具要顺手把名字写进来，那是一秒钟的事；
 * 而少一把工具的代价是模型说「我没有这个功能」，而所有别的信号都是绿的。
 */
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as vendored from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const { Context } = vendored
const botRoot = dirname(fileURLToPath(import.meta.url))
const ymlPath = join(botRoot, 'cordis.mounted.yml')

/**
 * **没给 `SATUWORK_HOME` 就自己造一个。**
 *
 * 这个探针起的是完整组合——storage 的 SQLite、sessions 的 JSONL、名册全都会落盘。
 * 不兜住的话，任何人按仓库里别的探针的习惯直接 `node --import tsx bot/e2e-mounted.mjs`
 * 跑一下（排查时最自然的动作），就会在他真实的 `~/.satuwork` 里建库写会话。
 * e2e-guards 没这个问题只是因为它不起 storage。
 */
const ownHome = process.env.SATUWORK_HOME ? '' : mkdtempSync(join(tmpdir(), 'satu-mounted-'))
if (ownHome) process.env.SATUWORK_HOME = ownHome

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
  if (ownHome) {
    try { rmSync(ownHome, { recursive: true, force: true }) } catch {}
  }
}
process.on('exit', cleanup)
// SIGKILL 接不到，所以那个 yml 还额外进了 .gitignore——两道都要有：
// 这一道管「正常被叫停」，那一道管「被硬杀」。
process.on('SIGINT', () => process.exit(130))
process.on('SIGTERM', () => process.exit(143))

// 端口挪开，别跟正式入口和别的套件抢。
writeFileSync(ymlPath, readFileSync(join(botRoot, 'cordis.yml'), 'utf8').replace(/port:\s*\d+/, `port: ${process.env.SATUWORK_PORT || '18124'}`))

const ctx = new Context()
ctx.baseUrl = pathToFileURL(botRoot).href + '/'
await ctx.plugin(Loader)
await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-include', config: { path: ymlPath } })

const has = (name) => {
  try {
    return ctx.reflect?.get?.(name) !== undefined
  } catch {
    return false
  }
}
const toolNames = () => ctx.tools?.schemas().map((t) => t.name) ?? []
const stateNow = () => {
  const names = toolNames()
  return {
    down: SERVICES.filter((n) => !has(n)),
    missing: TOOLS.filter((t) => !names.includes(t)),
  }
}

/**
 * **轮询到齐，不是睡一觉。**
 *
 * 这里等的是「都挂上了」，而挂载是并发的、由 `inject` 决定先后。原先写的是固定睡 5 秒
 * ——本机热缓存下十个服务全就绪只要 300 毫秒上下，看着绰绰有余，但那是 tsx 已经编译过
 * 整棵源码树之后的数字；CI 上这个进程是冷启动，二十几个 TS 模块现编，超 5 秒完全可能。
 *
 * 超了之后**不是超时，是把没起完的当成没起来**：报「browser 没起来」，和真 bug 的报错
 * 一字不差。而这套断言存在的全部意义就是让「挂没挂上」这个信号可信，一次假红就毁了它。
 *
 * 上限比套件那边的硬杀（40 秒）短：宁可自己报出「等到 25 秒还差这几个」，也不要被
 * SIGKILL 掉——那样连诊断信息都没有，还会把临时 yml 留在工作区里。
 */
const DEADLINE_MS = 25_000
const started = Date.now()
for (;;) {
  const { down, missing } = stateNow()
  if (!down.length && !missing.length) break
  if (Date.now() - started > DEADLINE_MS) break
  await new Promise((r) => setTimeout(r, 100))
}
const waited = Date.now() - started

const names = toolNames()
const provided = Object.fromEntries(SERVICES.map((n) => [n, has(n)]))
const missing = TOOLS.filter((t) => !names.includes(t))
const extra = names.filter((n) => !TOOLS.includes(n) && !n.startsWith('mcp_'))

console.log('__RESULT__' + JSON.stringify({ provided, missing, extra, count: names.length, waited }))
cleanup()
process.exit(0)
