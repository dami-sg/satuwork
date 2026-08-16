import { existsSync, readFileSync, statSync } from 'node:fs'
import { extname, join, normalize, resolve } from 'node:path'

/**
 * 静态文件发送。宿主这边有两处要发文件——shell 自己和各插件的浏览器半边——
 * 目录穿越的防线只写一次。
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

export function mimeOf(file: string) {
  return MIME[extname(file)] ?? 'application/octet-stream'
}

export interface ResponseLike {
  status: number
  headers: Headers
  text(body: string): unknown
  bytes(body: Uint8Array): unknown
}

/**
 * 把 `root` 下的 `rel` 发出去。
 *
 * `rel` 来自 URL，一律当作**不可信**：先归一化再确认落在 root 内，越界返回 403 而
 * 不是 404——两者的区别在排障时是有意义的。找不到返回 undefined 由调用方决定兜底，
 * 这个函数不替它选（SPA 要回 index.html，插件路由要回 404）。
 */
export function serve(res: ResponseLike, root: string, rel: string): boolean {
  const base = resolve(root)
  const file = join(base, normalize(decodeURIComponent(rel)).replace(/^(\.\.[/\\])+/, ''))
  if (file !== base && !file.startsWith(base + '/')) {
    res.status = 403
    res.text('forbidden')
    return true
  }
  if (!existsSync(file) || statSync(file).isDirectory()) return false
  res.headers.set('content-type', mimeOf(file))
  // 一致性锚点是插件 URL 上的 rev 查询参数，不是 HTTP 缓存。shell 自己的模块没有
  // rev，`no-cache`（可重验证）在没有 ETag 时又会被浏览器按内存缓存处理，改完刷新
  // 不生效——本地优先的产品不值得为此加一套验证器，直接不存。
  res.headers.set('cache-control', 'no-store')
  res.bytes(new Uint8Array(readFileSync(file)))
  return true
}
