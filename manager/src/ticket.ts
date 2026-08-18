import { createPublicKey, verify } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { readState, writeState } from './config.ts'

/**
 * 桌面 ticket。
 *
 * 浏览器要直连管家看 noVNC，而它手里没有 `smt_`（那是 Gateway 的机器票，绝不能进
 * 浏览器）。所以 Gateway 用自己的 JWT 私钥签一张只活几分钟、只对一个席位有效的票，
 * 管家用 Gateway 的公钥验。
 *
 * 验签自己写，不引依赖——照 gateway/src/crypto.ts:113 那份的写法，RS256 就是
 * `verify('sha256', h.p, pubkey, sig)`。
 */

export interface Ticket {
  typ: string
  seatId: string
  exp: number
  /** 席位的 VNC 口令。Gateway 签在票里，管家原样转给 noVNC 自动填。 */
  vnc?: string
}

function b64urlJson(part: string): unknown {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

async function jwksOf(gatewayUrl: string, kid: string): Promise<Record<string, unknown> | undefined> {
  const state = readState()
  const find = (set: { keys: Record<string, unknown>[] } | null) =>
    set?.keys?.find((k) => k.kid === kid) ?? undefined
  const cached = find(state?.jwks ?? null)
  if (cached) return cached
  // kid 对不上就再抓一次：Gateway 轮换密钥之后不该要求管家重装。
  try {
    const res = await fetch(`${gatewayUrl}/.well-known/jwks.json`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return
    const fresh = (await res.json()) as { keys: Record<string, unknown>[] }
    if (state) writeState({ ...state, jwks: fresh })
    return find(fresh)
  } catch {
    return
  }
}

/** 验不过一律返回 undefined，不区分原因——区分了就是在告诉攻击者哪一步错了。 */
export async function verifyTicket(token: string, gatewayUrl: string): Promise<Ticket | undefined> {
  const parts = (token || '').split('.')
  if (parts.length !== 3) return
  const [h, p, s] = parts
  let kid: string
  try {
    kid = String((b64urlJson(h) as { kid?: string }).kid || '')
  } catch {
    return
  }
  if (!kid) return
  const jwk = await jwksOf(gatewayUrl, kid)
  if (!jwk) return
  let ok = false
  try {
    const key = createPublicKey({ key: jwk as never, format: 'jwk' })
    ok = verify('sha256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))
  } catch {
    return
  }
  if (!ok) return
  let payload: Ticket
  try {
    payload = b64urlJson(p) as Ticket
  } catch {
    return
  }
  if (payload.typ !== 'satu-desktop') return
  if (!payload.seatId) return
  if (!(typeof payload.exp === 'number') || payload.exp < Math.floor(Date.now() / 1000)) return
  return payload
}

export const cookieName = (seatId: string) => `satu_desk_${seatId.replace(/[^A-Za-z0-9_-]/g, '')}`

export function cookieOf(req: IncomingMessage, name: string): string {
  const raw = req.headers.cookie
  if (!raw) return ''
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim())
  }
  return ''
}
