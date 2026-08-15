import type { Context } from '@deepseek-ai/cordis'

/**
 * 个人设置屏。
 *
 * 它只有浏览器半边：资料、口令、登录设备都归 satu-auth 的 `/api/me*`。这一屏
 * 自己没有后端——**「当前登录的是谁」只该有一个来源**。
 */
export const name = 'satu-view-profile'
export const inject = ['client']

export function apply(ctx: Context) {
  ctx.client.register({ id: 'profile', entry: new URL('./client.js', import.meta.url), immediately: true })
}
