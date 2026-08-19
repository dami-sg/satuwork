import { randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { managerVersion, PROTOCOL, readState, writeState, type BootConfig, type ManagerState } from './config.ts'

/**
 * 配对：拿一次性配对码换这台机器的长期 `smt_`。
 *
 * 为什么不是 IP 绑定：IP 会变、会撞，也证明不了「这台机器是这家公司的」。码是
 * 一次性、30 分钟过期、可吊销的。机器的地址由 Gateway 从 socket 源地址取，
 * owner 之后可以在界面上改。
 */

/**
 * 配对回调的挑战串。
 *
 * Gateway 收到配对请求后要**立刻回拨一次**，确认自己真能打到这台机器——不然
 * 「配对成功但 Gateway 打不到」会拖到第一次部署才暴露，那时人已经离开机器了。
 *
 * 回拨不能用 `smt_` 鉴权：那一刻票还在 Gateway 手里，管家还没收到响应。所以管家
 * 在配对请求里带一个随机串，回拨带着它来，对得上才算数。进程活着期间不变。
 */
export const bootChallenge = randomBytes(18).toString('base64url')

export interface PairResult {
  state: ManagerState
  reachable: boolean
  message: string
}

export async function pairIfNeeded(boot: BootConfig): Promise<PairResult | undefined> {
  const existing = readState()
  if (existing) return { state: existing, reachable: true, message: 'already paired' }
  if (!boot.gatewayUrl) throw new Error('GATEWAY_URL is unset; cannot pair')
  if (!boot.pairingCode) throw new Error('SATUWORK_PAIRING_CODE is unset; cannot pair')

  const res = await fetch(`${boot.gatewayUrl}/machines/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: boot.pairingCode,
      managerPort: boot.port,
      hostname: hostname(),
      managerVersion: managerVersion(),
      protocol: PROTOCOL,
      challenge: bootChallenge,
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {}
  if (!res.ok) throw new Error(`pairing failed ${res.status}: ${String(body.error || text).slice(0, 300)}`)
  if (!body.machineId || !body.token) throw new Error('pairing response is missing machineId or token')

  const state: ManagerState = {
    machineId: String(body.machineId),
    token: String(body.token),
    gatewayUrl: boot.gatewayUrl,
    pairedAt: Date.now(),
    jwks: null,
    confirmedVersion: managerVersion(),
    lastUpgradeTo: '',
    lastUpgradeAt: 0,
  }
  // 桌面 ticket 要用它验签。现在抓一次，省得第一个员工点开桌面时才发现拿不到。
  try {
    const jr = await fetch(`${boot.gatewayUrl}/.well-known/jwks.json`, { signal: AbortSignal.timeout(8000) })
    if (jr.ok) state.jwks = (await jr.json()) as { keys: Record<string, unknown>[] }
  } catch {}
  writeState(state)

  const reachable = body.reachable === true
  return {
    state,
    reachable,
    message: reachable
      ? 'paired; the Gateway can reach this machine'
      : `paired, but the Gateway cannot reach port ${boot.port} on this machine - open it, then restart satuwork-manager`,
  }
}
