import { Context } from '@deepseek-ai/cordis'
import { h, render } from 'preact'
import { Host } from './host.js'
import { applyPrefs, onPrefsChange } from './prefs.js'
import { Root } from './render.js'
import { Router } from './router.js'
import { Slots } from './slots.js'

// 主题在**第一帧之前**贴上，否则深色用户会先看到一闪的白。
applyPrefs()

/**
 * shell 的启动。
 *
 * 浏览器里跑的是**同一个 Cordis**：一个插件的浏览器半边就是一个普通 cordis
 * 插件，`inject` 声明依赖、挂载顺序由依赖决定而不是由加载顺序决定、卸载时它
 * 注册的一切（服务、slot 贡献、事件监听）自动撤销。前端不是这套架构的例外。
 *
 * 插件表由宿主注入成 `window.__SATU_BOOT__`。没有这张图就没法启动，这里**大声
 * 失败**：静默的空白页会让人从前端一路查到后端才发现是没注进来。
 */
const graph = window.__SATU_BOOT__
if (!graph?.entries) throw new Error('shell: 缺少 __SATU_BOOT__——宿主没有把插件表注进来')

const ctx = new Context()
ctx.plugin(Slots)
ctx.plugin(Router)
ctx.plugin(Host)

/**
 * 先挂 `immediately` 的，再挂其余的。
 *
 * 顺序不决定生效顺序（那是 `inject` 的事），它只决定**先看到什么**：布局与侧栏
 * 标了 immediately，所以框架先出现，各屏随后填进去。
 *
 * 惰性加载（真正等到第一次进那一屏才拉那个模块）还没做——现在的量级下全量加载
 * 就是几十 KB，先把它记在这里而不是假装已经有了。
 */
const load = async (entry) => {
  try {
    const module = await import(entry.url)
    ctx.plugin(module.default ?? module)
  } catch (e) {
    // 一个插件挂不上不该让整个界面消失：其余的照常，这条大声记下来。
    console.error(`shell: 插件 ${entry.id} 挂载失败`, e)
  }
}

await Promise.all(graph.entries.filter((e) => e.immediately).map(load))
await Promise.all(graph.entries.filter((e) => !e.immediately).map(load))

// 换主题或语言之后整棵树重画。偏好不是某一屏的状态，是整个界面的状态。
ctx.effect(() => onPrefsChange(() => ctx.slots.bump()))

// 排障入口：控制台里 `__SATU__.slots.entries('main')` 能直接看到当前的组合。
// 界面出不来的时候，第一个问题永远是「插件挂上了吗」，这条能当场回答。
window.__SATU__ = ctx

render(h(Root, { ctx }), document.body)
