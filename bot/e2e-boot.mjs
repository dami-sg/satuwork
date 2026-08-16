/**
 * e2e 专用启动器。
 *
 * 正式入口写死读 ./cordis.yml，端口 3082。测试要换端口、换 $SATUWORK_HOME，
 * 又不改仓库里那份组合，所以把 yml 抄一份、只改 port，再按同一套 Loader 挂上去。
 * 抄出来的文件必须仍在 bot/ 目录——include 会把 baseUrl 指到 yml 所在目录，
 * 相对说明符 './src/…' 才能解析。
 */
import { pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import * as vendored from '@deepseek-ai/cordis'
import * as aliased from 'cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'

const { Context } = vendored
if (aliased.Context !== vendored.Context) {
  throw new Error(
    'satuwork: `cordis` 与 `@deepseek-ai/cordis` 解析到了两份不同的框架。',
  )
}

const botRoot = dirname(fileURLToPath(import.meta.url))
const port = process.env.SATUWORK_PORT || '18082'
const ymlPath = join(botRoot, 'cordis.e2e.yml')
const yml = readFileSync(join(botRoot, 'cordis.yml'), 'utf8').replace(/port:\s*\d+/, `port: ${port}`)
writeFileSync(ymlPath, yml)

const cleanup = () => {
  try {
    unlinkSync(ymlPath)
  } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})
process.on('SIGTERM', () => {
  cleanup()
  process.exit(143)
})

const ctx = new Context()
ctx.baseUrl = pathToFileURL(botRoot).href + '/'

const { satuworkHome } = await import(pathToFileURL(join(botRoot, 'src/home.ts')).href)
console.log(`satuwork: 数据目录 ${satuworkHome()}${process.env.SATUWORK_HOME ? '（来自 $SATUWORK_HOME）' : ''}`)

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@deepseek-ai/cordis-plugin-include',
  config: { path: ymlPath },
})
