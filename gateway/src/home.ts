import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Gateway 的数据目录。
 *
 * 默认 `~/.satuwork-gateway`，可用 `SATUWORK_GATEWAY_HOME` 覆盖。
 * 和 Bot 的 `$SATUWORK_HOME` 分开——控制面和运行面不共用一份库。
 */
export function gatewayHome(...segments: string[]): string {
  const root = process.env.SATUWORK_GATEWAY_HOME
    ? resolve(process.env.SATUWORK_GATEWAY_HOME)
    : join(homedir(), '.satuwork-gateway')
  return segments.length ? join(root, ...segments) : root
}
