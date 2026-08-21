/**
 * 连接器目录项的定义、校验与对外序列化。
 *
 * 见 docs/connectors.md §4。三样东西分得很清：**上架**（这里）、**安装**、**连接**。
 */
import { HttpError } from '../http.ts'
import { DEFAULT_VENDOR, isVendor, providerFor, type ToolDef } from '../connectors/index.ts'
import type { Db } from '../db.ts'
import { MCP_PERMS, asDef, trimStr } from './catalog.ts'
import { COMPANY_CONNECTION_LABEL as COMPANY_LABEL, type CatalogItem, type ConnectorBlockDef, type ConnectorConnection, type ConnectorDef, type ConnectorInstall } from '../db.ts'

/**
 * 一把连接最多下发几个工具。
 *
 * 连接器绑账号不绑 Bot，工具数是随**安装数**涨的：光 Gmail 一家就有 29 个，装八个
 * 连接器就是两百多个工具挤进每一颗 Bot 的每一轮请求，上下文先塌，模型选工具的准确率
 * 也跟着垮。首选出路是员工自己在详情页把用不上的关掉；这个数是关不掉时的硬闸。
 *
 * **截断不许静默**：结果里带 `truncated`，日志里写一行，详情页给一条红字。
 * 静默截断的表现是「某个工具时有时无」，是最难查的一类。
 */
export const MAX_TOOLS = Math.max(1, Math.trunc(Number(process.env.CONNECTOR_MAX_TOOLS) || 64))

/** 工具清单的缓存。列表是给模型看的目录，不是实时数据，五分钟足够新。 */
const TOOL_TTL_MS = 5 * 60_000
const toolCache = new Map<string, { at: number; tools: ToolDef[] }>()

export async function toolsOf(db: Db, vendor: string, toolkit: string): Promise<ToolDef[]> {
  const key = `${vendor}/${toolkit}`
  const hit = toolCache.get(key)
  if (hit && Date.now() - hit.at < TOOL_TTL_MS) return hit.tools
  const provider = await providerFor(db, vendor)
  const tools = await provider.listTools(toolkit)
  toolCache.set(key, { at: Date.now(), tools })
  return tools
}


/** toolkit slug 会进工具名和流水表，不收怪字符。 */
export const TOOLKIT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export function connectorDefOf(item: CatalogItem): ConnectorDef {
  const def = asDef(item.definition)
  const perm = (MCP_PERMS as readonly string[]).includes(trimStr(def.perm)) ? trimStr(def.perm) : '只读'
  return {
    vendor: trimStr(def.vendor) || DEFAULT_VENDOR,
    toolkit: trimStr(def.toolkit),
    authConfigId: trimStr(def.authConfigId),
    name: trimStr(def.name) || item.name,
    description: trimStr(def.description),
    logo: trimStr(def.logo),
    category: trimStr(def.category),
    multiAccount: def.multiAccount !== false,
    perm,
    enabled: def.enabled !== false,
  }
}

/** 建一条上架记录。`toolkit` 和 `vendor` 建完就不给改了（见 patch）。 */
export function newConnectorDefinition(body: Record<string, unknown>): ConnectorDef {
  const vendor = trimStr(body.vendor) || DEFAULT_VENDOR
  if (!isVendor(vendor)) throw new HttpError(400, `没有这家供应商：${vendor}`)
  const toolkit = trimStr(body.toolkit).toLowerCase()
  if (!TOOLKIT_RE.test(toolkit)) throw new HttpError(400, 'toolkit 只能是小写字母数字和 _ -')
  return {
    vendor,
    toolkit,
    authConfigId: trimStr(body.authConfigId),
    name: trimStr(body.name) || toolkit,
    description: trimStr(body.description),
    logo: trimStr(body.logo),
    category: trimStr(body.category),
    multiAccount: body.multiAccount !== false,
    perm: (MCP_PERMS as readonly string[]).includes(trimStr(body.perm)) ? trimStr(body.perm) : '只读',
    enabled: body.enabled !== false,
  }
}

/**
 * 改一条上架记录。
 *
 * **`vendor` 和 `toolkit` 不给改。** 它们已经写进了流水表的字面量列和员工已有的连接；
 * 改掉之后「上个月 gmail 花了多少」会指向一个不同的东西，而已经授权的连接会静静地
 * 连到另一家服务上。要换就下架再上架一条新的。
 */
export function applyConnectorPatch(cur: ConnectorDef, body: Record<string, unknown>): ConnectorDef {
  const next = { ...cur }
  if ('authConfigId' in body) next.authConfigId = trimStr(body.authConfigId)
  if ('name' in body) next.name = trimStr(body.name) || cur.name
  if ('description' in body) next.description = trimStr(body.description)
  if ('logo' in body) next.logo = trimStr(body.logo)
  if ('category' in body) next.category = trimStr(body.category)
  if ('multiAccount' in body) next.multiAccount = body.multiAccount !== false
  if ('perm' in body && (MCP_PERMS as readonly string[]).includes(trimStr(body.perm))) next.perm = trimStr(body.perm)
  if ('enabled' in body) next.enabled = body.enabled !== false
  return next
}

export function blockDefOf(item: CatalogItem | undefined): ConnectorBlockDef {
  const def = asDef(item?.definition)
  return { connectorId: trimStr(def.connectorId), blocked: def.blocked === true, reason: trimStr(def.reason) }
}

/** 公司层的禁令表：连接器 id → 禁令。没有记录 = 放行。 */
export function blockMapOf(items: CatalogItem[]): Map<string, ConnectorBlockDef> {
  const map = new Map<string, ConnectorBlockDef>()
  for (const item of items) {
    if (item.scope !== 'company') continue
    const block = blockDefOf(item)
    if (block.connectorId) map.set(block.connectorId, block)
  }
  return map
}

/**
 * 上架记录的对外形状。**`authConfigId` 永远不出现**——它是平台在供应商侧的配置 id，
 * 公司和员工都不该看见，和密钥同一档。
 */
export function publicConnector(item: CatalogItem) {
  const def = connectorDefOf(item)
  return {
    id: item.id,
    vendor: def.vendor,
    toolkit: def.toolkit,
    name: def.name,
    description: def.description,
    logo: def.logo,
    category: def.category,
    multiAccount: def.multiAccount,
    perm: def.perm,
    enabled: def.enabled,
    /** 配了 auth config 才连得上。只说配没配，不带出值。 */
    authReady: Boolean(def.authConfigId),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }
}

export function publicInstall(v: ConnectorInstall) {
  return {
    id: v.id,
    connectorId: v.connectorId,
    accountId: v.accountId,
    enabledTools: v.enabledTools,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  }
}

/** 连接的对外形状。`externalId` 和 `externalUserId` 是供应商侧的引用，不带出去。 */
export function publicConnection(v: ConnectorConnection) {
  return {
    id: v.id,
    connectorId: v.connectorId,
    scope: v.scope,
    label: v.label,
    accountId: v.accountId,
    status: v.status,
    mentionOnly: v.mentionOnly,
    error: v.lastError,
    connectedAt: v.connectedAt,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
  }
}

/**
 * 一把已连接的账号 → 席位那边看到的一条 MCP 服务器记录。
 *
 * **一把连接一条**，不是一个连接器一条：这样席位那边合成的工具名天然带账号
 * （`mcp_gmail_person_send_email`），模型选得动，流水也落得到具体哪一把。
 *
 * `timeoutMs` 必须下发：`bot/src/catalog/mcp.ts` 默认只等 8 秒，对本地 MCP 够用，
 * 对「发一封邮件」「查一遍 CRM」不够——这类调用十几秒是常态。
 */
export function runtimeConnectorServer(
  conn: ConnectorConnection,
  item: CatalogItem,
  opts: { origin: string; token: string; botId: string; timeoutMs: number },
) {
  const def = connectorDefOf(item)
  const query = opts.botId ? `?botId=${encodeURIComponent(opts.botId)}` : ''
  return {
    id: conn.id,
    // 名字进工具名前缀，所以带上 label——两把 Gmail 才分得开。
    name: conn.scope === 'company' ? `${def.name} (${COMPANY_LABEL})` : `${def.name} (${conn.label})`,
    kind: 'HTTP' as const,
    endpoint: `${opts.origin}/mcp/connectors/${encodeURIComponent(conn.id)}${query}`,
    env: {} as Record<string, string>,
    hasEnv: false,
    perm: def.perm,
    enabled: true,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
    hasToken: true,
    token: opts.token,
    timeoutMs: opts.timeoutMs,
    /** 「仅 @ 时可用」：席位照样连上、照样注册工具，但不进默认工具表。 */
    mentionOnly: conn.mentionOnly,
    /** 席位不需要它，但界面和排错要：这条是连接器合成出来的，不是公司配的 MCP。 */
    connector: def.toolkit,
  }
}
