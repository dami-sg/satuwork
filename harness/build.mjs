// 把 src/client/theme.css 内联进 dist/client.js。
// 只用 Node 内置模块，没有构建依赖——主题目前是一张纯 CSS 表，不值得为它引一套工具链。
// 等客户端插件长出真正的 TS 逻辑（新增视图、改造对话节点）再换成 tsdown 或 esbuild。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(root, 'src/client/theme.css'), 'utf8')

// 反引号和 ${ 会破坏模板字符串；反斜杠要先转义，否则后面的转义会被二次解释。
const escaped = css
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')

const out = `// GENERATED from src/client/theme.css by build.mjs — do not edit.
const CSS = \`${escaped}\`
const STYLE_ID = 'satuwork-theme'

/**
 * 把 Satuwork 的 --dsw-alias-* 覆盖表挂到 document 上。
 * 幂等：重复调用只更新同一个 <style> 节点的内容。
 */
function applyTheme() {
  if (typeof document === 'undefined') return
  let el = document.getElementById(STYLE_ID)
  if (!el) {
    el = document.createElement('style')
    el.id = STYLE_ID
    document.head.appendChild(el)
  }
  if (el.textContent !== CSS) el.textContent = CSS
}

// dsh 的样式表在 <head> 里，这里追加在其后，同选择器同特异性时后者胜出。
applyTheme()

export const name = 'satuwork-theme'

export function apply(ctx) {
  applyTheme()
  // 注册项都要能卸载：插件卸载时把 <style> 摘掉。
  if (ctx && typeof ctx.effect === 'function') {
    ctx.effect(() => () => document.getElementById(STYLE_ID)?.remove())
  }
}

export default { name, apply }
`

mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist/client.js'), out)
console.log(`dist/client.js  ${out.length} bytes  (css ${css.length})`)
