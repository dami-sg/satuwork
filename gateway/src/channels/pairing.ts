import { randomInt } from 'node:crypto'
import { sha256Hex } from '../crypto.ts'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** 去掉视觉分隔符并统一大写；聊天里输入 `ABCD EFGH`、`abcd-efgh` 都能配。 */
export function normalizePairingCode(raw: unknown): string {
  return String(raw ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function pairingCodeHash(raw: unknown): string {
  return sha256Hex(normalizePairingCode(raw))
}

export function newPairingCode(): string {
  let compact = ''
  for (let i = 0; i < 8; i++) compact += ALPHABET[randomInt(ALPHABET.length)]
  return `${compact.slice(0, 4)}-${compact.slice(4)}`
}
