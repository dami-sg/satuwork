import type { Context } from '@deepseek-ai/cordis'

/**
 * 登录 / 初始化屏。
 *
 * 只有浏览器半边——账号与会话本身归 `src/auth`，那是一个能力，不是一屏。
 * 标 `immediately`：它决定整块屏幕归谁，必须在第一帧之前就位。
 */
export const name = 'satu-view-auth'
export const inject = ['client']

export function apply(ctx: Context) {
  ctx.client.register({ id: 'auth', entry: new URL('./client.js', import.meta.url), immediately: true })
}
