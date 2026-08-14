// 把 src/client/theme.css 内联进 dist/client.js。
// 只用 Node 内置模块，没有构建依赖——主题目前是一张纯 CSS 表，不值得为它引一套工具链。
// 等客户端插件长出真正的 TS 逻辑（新增视图、改造对话节点）再换成 tsdown 或 esbuild。
//
// 产物格式是 dsh 客户端模块表要求的 **lazy-CJS**，不是 ESM：
//   window.__ModuleLoader__.load({ id, factory })
// 脚本执行时只做「注册工厂」这一件事；模块体的副作用（包括注入 CSS）写在 factory
// 闭包里，在首次 materialize 时才跑。发普通 ESM 会被判为
// "loaded without registering ... via __ModuleLoader__.load" 并让整页启动失败。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const css = readFileSync(join(root, 'src/client/theme.css'), 'utf8')

// 反斜杠要先转义，否则后面两条替换插入的转义会被二次解释。
const escaped = css
  .replace(/\\/g, '\\\\')
  .replace(/`/g, '\\`')
  .replace(/\$\{/g, '\\${')

const out = `// GENERATED from src/client/theme.css by build.mjs — do not edit.
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    var CSS = \`${escaped}\`;
    var STYLE_ID = 'satuwork-theme';

    /**
     * 把 Satuwork 的 --dsw-alias-* 覆盖表挂到 document 上。
     * 幂等：重复调用只更新同一个 <style> 节点的内容。
     */
    function applyTheme() {
      if (typeof document === 'undefined') return;
      var el = document.getElementById(STYLE_ID);
      if (!el) {
        el = document.createElement('style');
        el.id = STYLE_ID;
        document.head.appendChild(el);
      }
      if (el.textContent !== CSS) el.textContent = CSS;
    }

    // dsh 的令牌表在 <head> 里，这张追加在其后；同选择器同特异性，后者胜出。
    applyTheme();

    exports.name = 'satuwork-theme';
    exports.apply = function apply(ctx) {
      applyTheme();
      // 注册项都要能卸载：插件卸载时把 <style> 摘掉。
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            var el = document.getElementById(STYLE_ID);
            if (el) el.remove();
          };
        });
      }
    };
    exports.default = { name: exports.name, apply: exports.apply };

    return module.exports;
  }
});
`

mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist/client.js'), out)
console.log(`dist/client.js  ${out.length} bytes  (css ${css.length})`)
