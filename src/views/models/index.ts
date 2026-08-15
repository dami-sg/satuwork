import type { Context } from '@deepseek-ai/cordis'

/**
 * 模型配置屏。
 *
 * **这一屏没有 mock**：供应商目录、模型元数据（上下文、单价、是否推理）都来自
 * pi-ai 的目录，凭据读写走 `/api/credentials/:provider`，默认模型走 `/api/settings`。
 * 加一家 provider 是配置不是代码，所以这屏也不需要为谁写特例。
 */
export const name = 'satu-view-models'
export const inject = ['client']

export function apply(ctx: Context) {
  ctx.client.register({ id: 'models', entry: new URL('./client.js', import.meta.url) })
}
