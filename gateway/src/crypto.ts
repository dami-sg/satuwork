import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scrypt as scryptCb,
  sign,
  timingSafeEqual,
  verify,
} from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 口令下限。和 Bot 框架同一条，不多写一条服务端不检查的。 */
export const MIN_PASSWORD = 10

/** 邀请新成员默认 7 天；重置已激活账号口令 1 小时。 */
export const INVITE_TTL = 7 * 24 * 3600 * 1000
export const RESET_LINK_TTL = 3600 * 1000

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex')
}

export function randomInviteToken(): string {
  return randomBytes(24).toString('base64url')
}

/** scrypt 参数。N 越大越慢越安全；16384 在本机登录约 50–80ms，够用且不刺痛。 */
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 }

function scrypt(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (err, derived) => {
      if (err) reject(err)
      else resolve(derived as Buffer)
    })
  })
}

/** `scrypt$N$r$p$salt$hash`，全部十六进制。**永远不出现在任何响应里。** */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const key = await scrypt(password, salt)
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, , , , salt, hash] = stored.split('$')
  if (scheme !== 'scrypt' || !salt || !hash) return false
  const key = await scrypt(password, Buffer.from(salt, 'hex'))
  const expected = Buffer.from(hash, 'hex')
  return key.length === expected.length && timingSafeEqual(key, expected)
}

export interface JwtKeys {
  kid: string
  privatePem: string
  publicPem: string
}

/**
 * 第一次启动生成 RSA 2048 并落盘。之后每次读同一对——kid 跟着公钥走，
 * 重启不会让已发出的票全部失效。
 */
export function loadKeys(home: string): JwtKeys {
  const dir = join(home, 'keys')
  const privPath = join(dir, 'jwt-private.pem')
  const pubPath = join(dir, 'jwt-public.pem')
  mkdirSync(dir, { recursive: true })
  if (!existsSync(privPath) || !existsSync(pubPath)) {
    const pair = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    })
    writeFileSync(privPath, pair.privateKey, { mode: 0o600 })
    writeFileSync(pubPath, pair.publicKey, { mode: 0o644 })
  }
  const privatePem = readFileSync(privPath, 'utf8')
  const publicPem = readFileSync(pubPath, 'utf8')
  const kid = createHash('sha256').update(publicPem).digest('hex').slice(0, 16)
  return { kid, privatePem, publicPem }
}

export interface JwtPayload {
  iss: string
  sub: string
  accountId: string
  companyId: string
  role: 'owner' | 'admin' | 'member'
  iat: number
  exp: number
}

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url')

export function signJwt(keys: JwtKeys, claims: Omit<JwtPayload, 'iss' | 'iat' | 'exp'>, ttlSec: number): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: JwtPayload = {
    iss: process.env.GATEWAY_ISS ?? 'satuwork-gateway',
    iat: now,
    exp: now + ttlSec,
    ...claims,
  }
  const header = { alg: 'RS256', typ: 'JWT', kid: keys.kid }
  const h = b64url(JSON.stringify(header))
  const p = b64url(JSON.stringify(payload))
  const sig = sign('sha256', Buffer.from(`${h}.${p}`), keys.privatePem)
  return `${h}.${p}.${sig.toString('base64url')}`
}

export function verifyJwt(keys: JwtKeys, token: string): JwtPayload {
  const parts = token.split('.')
  if (parts.length !== 3) throw new Error('票格式不对')
  const [h, p, s] = parts
  const ok = verify('sha256', Buffer.from(`${h}.${p}`), keys.publicPem, Buffer.from(s, 'base64url'))
  if (!ok) throw new Error('票签验失败')
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as JwtPayload
  if (!payload.accountId || !payload.role) throw new Error('票缺字段')
  if (payload.role !== 'owner' && !payload.companyId) throw new Error('票缺字段')
  if (payload.role !== 'owner' && payload.role !== 'admin' && payload.role !== 'member') throw new Error('票缺字段')
  const iss = process.env.GATEWAY_ISS ?? 'satuwork-gateway'
  if (payload.iss !== iss) throw new Error('票签发方不对')
  if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('票已过期')
  return payload
}

export interface DesktopTicket {
  typ: 'satu-desktop'
  seatId: string
  iat: number
  exp: number
}

/**
 * 桌面票。浏览器拿它直连机器管家看 noVNC。
 *
 * 为什么不复用登录 JWT：那张票带着 accountId 和 role，能调 Gateway 的写接口，而这
 * 一张要交给一个**不在我们控制下的进程**（管家）去验，还会以 cookie 的形式在机器
 * 上落一会儿。所以另起一种，只说明「谁可以看哪一块屏、看到什么时候」，别的什么
 * 都不说。`typ` 是显式的，管家验签之后还要再对一次——同一把密钥签出来的两种票不
 * 能互相冒充。
 *
 * 五分钟：够点开桌面，不够被人捡去慢慢用。管家会把它换成一张 path 限定的 cookie，
 * 所以票短不影响会话长度。
 */
export function signDesktopTicket(keys: JwtKeys, seatId: string, ttlSec = 300): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: DesktopTicket = { typ: 'satu-desktop', seatId, iat: now, exp: now + ttlSec }
  const h = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: keys.kid }))
  const p = b64url(JSON.stringify(payload))
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), keys.privatePem).toString('base64url')}`
}

/** JWKS。实例拿它验 Gateway 签的票。 */
export function jwks(keys: JwtKeys): { keys: Record<string, unknown>[] } {
  const jwk = createPublicKey(keys.publicPem).export({ format: 'jwk' }) as Record<string, unknown>
  return { keys: [{ ...jwk, kid: keys.kid, alg: 'RS256', use: 'sig' }] }
}

export function timingSafeToken(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given ?? '').digest()
  const b = createHash('sha256').update(expected ?? '').digest()
  return timingSafeEqual(a, b)
}

/** 席位 API Key。调 Gateway /v1 模型，标明是哪个用户发起的调用。明文落库，详情页要给 owner 看。 */
export function randomApiKey(): string {
  return 'sk_sw_' + randomBytes(32).toString('base64url')
}

/** 席位 access token。Gateway ↔ Bot 双向鉴权。明文落库。 */
export function randomAccessToken(): string {
  return 'sat_' + randomBytes(32).toString('base64url')
}

/**
 * 每台机器一把，**只给管家**。
 *
 * 它是管家控制面（`PUT /seats/:id` 等）的凭据，等同于那台机器的 root。所以它只活在
 * `/etc/satuwork/manager.json`（0600），不再注入 bot.env——那个文件属于席位那个普通
 * Linux 用户，员工在 noVNC 桌面里 cat 一下就拿到了。bot 上报用的是席位票（sat_）。
 */
export function randomMachineToken(): string {
  return 'smt_' + randomBytes(32).toString('base64url')
}
