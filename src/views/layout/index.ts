import type { Context } from '@deepseek-ai/cordis'

/**
 * 根布局。宿主这边没有业务——它只有浏览器半边。
 *
 * 一个插件可以只贡献界面，就像一个插件可以只贡献工具：`cordis.yml` 里是同一种
 * 条目，加载与卸载走同一条路径。
 */
export const name = 'satu-view-layout'
export const inject = ['client']

export function apply(ctx: Context) {
  ctx.client.register({
    id: 'layout',
    entry: new URL('./client.js', import.meta.url),
    // 框架先出现，各屏随后填进去。
    immediately: true,
  })
}
