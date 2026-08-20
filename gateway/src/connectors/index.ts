/**
 * 供应商注册表：按 vendor 名取一个实现。
 *
 * 密钥从 `platform_credentials` 取（和模型供应商同一张表、同一条规矩：平台一把、
 * 不回显、不下发），取不到再退到环境变量，方便本地跑。
 */
import type { Db } from '../db.ts'
import { ComposioProvider } from './composio.ts'
import { ProviderError, type ConnectorProvider } from './types.ts'

export * from './types.ts'
export { ComposioProvider } from './composio.ts'

/** 目前支持的供应商。加一家就加一行，别的地方不用改。 */
export const VENDORS = ['composio'] as const
export type Vendor = (typeof VENDORS)[number]
export const DEFAULT_VENDOR: Vendor = 'composio'

export function isVendor(v: unknown): v is Vendor {
  return typeof v === 'string' && (VENDORS as readonly string[]).includes(v)
}

/** 供应商密钥也走 SATUWORK_<VENDOR>_API_KEY 这条环境变量；平台表里的优先。 */
export function vendorEnvVar(vendor: string): string {
  return `SATUWORK_${vendor.toUpperCase().replace(/-/g, '_')}_API_KEY`
}

const FACTORY: Record<Vendor, (secret: string) => ConnectorProvider> = {
  composio: (secret) => new ComposioProvider(secret),
}

export async function secretFor(db: Db, vendor: string): Promise<string> {
  const cred = await db.platformCredential(vendor)
  if (cred?.secret) return cred.secret
  return (process.env[vendorEnvVar(vendor)] || '').trim()
}

/**
 * 取一个可用的实现。**没有密钥也返回**——`configured()` 为 false，由调用方决定是
 * 402 还是在界面上显示「未配置」。这里抛错的话，owner 那一屏连「还没配」都画不出来。
 */
export async function providerFor(db: Db, vendor: string): Promise<ConnectorProvider> {
  if (!isVendor(vendor)) throw new ProviderError(`没有这家供应商：${vendor}`, 400)
  return FACTORY[vendor](await secretFor(db, vendor))
}
