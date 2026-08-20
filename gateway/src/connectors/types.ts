/**
 * 连接器供应商的抽象层。
 *
 * 接口窄到只剩「换供应商时真的会变的东西」：列有哪些连接器、列它有哪些工具、
 * 发起授权、查授权状态、断开、执行一次工具。别的一律不进来——上层需要什么就在
 * Gateway 里做，不要为了迁就某一家的 SDK 把它的概念漏到接口上。
 *
 * 见 docs/connectors.md §5。
 */

export interface Toolkit {
  /** 供应商侧的 slug，例如 `gmail`。上架之后它会进流水表，不能变。 */
  slug: string
  name: string
  description: string
  /** 图标地址。没有就空串，界面自己退化成首字母。 */
  logo: string
  /** 供应商给的分组，例如 `productivity`。市场里按它分组。 */
  categories: string[]
  /** 这家 toolkit 支持的鉴权方式（`OAUTH2` / `API_KEY` …），给上架那一屏看。 */
  authSchemes: string[]
}

export interface ToolDef {
  /** 工具 slug，例如 `GMAIL_SEND_EMAIL`。它会进工具名和流水表。 */
  slug: string
  name: string
  description: string
  /** JSON Schema。合成 MCP 工具表时原样交给模型。 */
  inputSchema: Record<string, unknown>
}

export interface InitiateInput {
  toolkit: string
  /** 供应商侧的 auth config id。owner 上架时填，公司和员工都看不见。 */
  authConfigId: string
  /** 我们这边的用户标识：`sw_{accountId}` 或 `swc_{companyId}`。不用邮箱。 */
  externalUserId: string
  callbackUrl: string
}

export interface InitiateResult {
  /** 供应商侧的连接 id。存进 connector_connections.externalId。 */
  externalId: string
  /** 让浏览器跳过去的地址。 */
  redirectUrl: string
}

export type ConnectionState = 'pending' | 'active' | 'failed'

export interface StatusResult {
  status: ConnectionState
  error?: string
}

export interface ExecuteInput {
  tool: string
  externalUserId: string
  /** 供应商侧的连接 id。多账号时它决定这次用哪一个。 */
  externalId: string
  args: unknown
  signal: AbortSignal
}

export interface ExecuteResult {
  /** 工具自己说成功了没有。 */
  ok: boolean
  /** 交给模型的正文。 */
  text: string
}

/** 这家供应商能干什么。调用方按位判断，不按 vendor 名字判断。 */
export interface ProviderCaps {
  /** 能直接给出一个 per-user 的 MCP 地址（将来可以少一跳）。 */
  mcpUrl: boolean
  /** 工具多到装不下时，有没有服务端搜索。 */
  search: boolean
  /** 同一个用户能不能连同一个 toolkit 的多个账号。 */
  multiAccount: boolean
}

export interface ConnectorProvider {
  readonly vendor: string
  readonly caps: ProviderCaps

  /** 供应商密钥配了没有。没配的话上层直接 402，不用等一次失败的网络往返。 */
  configured(): boolean
  /** 拨一下看看通不通。owner 那一屏的「测试连接」。 */
  ping(): Promise<{ ok: boolean; error?: string }>

  listToolkits(): Promise<Toolkit[]>
  listTools(toolkit: string): Promise<ToolDef[]>

  initiate(input: InitiateInput): Promise<InitiateResult>
  status(externalId: string): Promise<StatusResult>
  disconnect(externalId: string): Promise<void>

  execute(input: ExecuteInput): Promise<ExecuteResult>
}

/** 供应商侧的错误。上层据此决定回 402 / 502，而不是把栈丢给调用方。 */
export class ProviderError extends Error {
  constructor(
    message: string,
    /** 上游的 HTTP 状态。0 = 根本没连上。 */
    readonly status = 0,
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
