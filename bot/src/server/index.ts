import type { Context } from '@deepseek-ai/cordis'
import Server from '@cordisjs/plugin-server'

export const name = 'satu-server'

export interface Config {
  host?: string
  port?: number
}

/** Desktop 为每颗本地 Bot 分一个 loopback 端口；远程席位仍保持 3082。 */
export function apply(ctx: Context, config: Config = {}) {
  const raw = Number(process.env.SATUWORK_BOT_PORT)
  const port = Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : (config.port || 3082)
  return ctx.plugin(Server, { host: config.host || '127.0.0.1', port })
}
