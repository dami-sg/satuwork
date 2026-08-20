import type { Context } from '@deepseek-ai/cordis'
import { timingSafeEqual } from 'node:crypto'

/**
 * 入站闸门。**这个进程认的唯一一把凭据是席位票（`sat_`）。**
 *
 * 这里以前是一整套账号体系：用户、角色、邀请、cookie 会话、口令重置、登录限流、
 * 设备列表。那是 Gateway 出现之前那一版的东西——那时候 Bot 自己发 SPA、自己管人。
 * 现在 Bot 无头（web/index.ts 里未知路径一律 JSON 404），身份和目录都在 Gateway，
 * 浏览器只打 Gateway，Gateway 再拿席位票反代过来（gateway/src/routes.ts 的 proxyJson /
 * proxySse——它们只发 `Authorization: Bearer sat_…`，**从不发 cookie**）。
 *
 * 于是那套账号体系一个调用方都没有，却仍然在监听：`/api/auth/setup` 在公开白名单里，
 * 一个用户都没有时谁都能建出第一个 admin。而席位上的员工在 noVNC 桌面里正好打得到
 * `127.0.0.1:<botPort>`——他建完账号就绕开了席位票。删掉它不是简化，是把这条路堵上。
 *
 * 剩下的就是这个文件：一把票、一条守卫。
 */
export const name = 'satu-guard'
export const inject = ['server']

/**
 * 席位票。按账号发，作用域到这个席位为止。
 *
 * 不认机器票（`smt_`）：那把票同时是管家 `PUT /seats/:id` 的凭据，等同于整台机器的
 * root；它会被写进 `$SEAT_DIR/bot.env`，而那个文件属于席位那个普通 Linux 用户，
 * 员工在桌面里 `cat` 一下就拿到了。
 */
function seatToken(): string {
  return (process.env.GATEWAY_TOKEN || '').trim()
}

/**
 * 守卫用的路径归一。
 *
 * 路由匹配是 path-to-regexp 生成的正则，**带 `i` 标志、且允许一个尾斜杠**
 * （`/api/sessions` 编译出来是 `/^(?:\/api\/sessions)(?:\/$)?$/i`）。守卫按原样
 * 字符串比就会和路由错位：`GET /API/sessions` 的 `startsWith('/api/')` 不成立 →
 * 守卫直接放行，而路由照样命中 → 整个 /api 面未鉴权。这里先按路由的口径归一，
 * 两边才是同一套判断。
 *
 * 只用于守卫的前缀判断，**不能拿去做路由**：sessionId / botId 在路径里是大小写
 * 敏感的。
 */
function guardPath(raw: string): string {
  const lower = raw.toLowerCase()
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower
}

/** 不要票也能打的。只有健康检查——它是管家判断「这个席位起来没有」的依据。 */
const PUBLIC = new Set(['/api/health'])

/** Gateway 用机器凭证按 sessionId 拉全文，令牌在路由里自己验。 */
const INTERNAL_SESSIONS = '/internal/sessions/'

function bearerMatches(header: string | null, expected: string): boolean {
  if (!expected || !header?.startsWith('Bearer ')) return false
  const token = header.slice(7).trim()
  if (!token) return false
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function apply(ctx: Context) {
  /**
   * `server.use` 是 **prepend** 的，所以它跑在所有路由之前——插件是并发挂载的，
   * 靠注册顺序排在最前面这件事本来不成立，这里不受影响。
   *
   * **默认拒绝。** 以前是「白名单里的 /api/* 才要票」，于是每加一条路由都要记得
   * 回来加一行，漏了就是裸奔。现在反过来：`/api/*` 一律要票，只有 PUBLIC 里那条例外。
   */
  ctx.server.use(async (req, res, next) => {
    const path = guardPath(req.path)
    if (path.startsWith(INTERNAL_SESSIONS)) return next()
    if (!path.startsWith('/api/') || PUBLIC.has(path)) return next()
    if (bearerMatches(req.headers.get('authorization'), seatToken())) return next()
    res.status = 401
    res.json({ error: '需要席位凭证', code: 'unauthenticated' })
  })
}
