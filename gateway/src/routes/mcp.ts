/**
 * 连接器的 MCP 端点：席位实例连到这里，Gateway 再去打供应商。
 *
 * **一把连接一条路径**（`/mcp/connectors/:connectionId`）。这样席位那边合成出来的
 * 工具名天然带账号（`mcp_gmail_person_send_email` / `mcp_gmail_defaul_send_email`），
 * 模型不用靠参数说明去猜该用哪个邮箱，流水也直接落到具体哪一把连接上。
 *
 * 见 docs/connectors.md §7、§8。
 */
import type { ServerResponse } from 'node:http'
import { HttpError, json, type Req, type Router } from '../http.ts'
import type { RouteCtx } from './ctx.ts'
import { ProviderError, providerFor, type ToolDef } from '../connectors/index.ts'
import { MAX_TOOLS, blockMapOf, connectorDefOf, toolsOf } from '../lib/connectors.ts'
import { requireSeatOnly } from '../lib/guards.ts'
import type { Account, ConnectorCallStatus, ConnectorConnection, Db } from '../db.ts'

/**
 * 上游调用的时限。
 *
 * **必须比席位那边的客户端先超时**（那边给连接器留的是 60 秒）。反过来的话，Bot 已经
 * 断了我们还在等，这次调用记不到结果，钱也说不清收没收。
 *
 * 可以调小，只为一件事：e2e 要在几秒内验到超时那一档，而不是真等 45 秒。
 */
const UPSTREAM_TIMEOUT_MS = Math.max(1000, Math.trunc(Number(process.env.CONNECTOR_UPSTREAM_TIMEOUT_MS) || 45_000))

/**
 * 工具名去掉 toolkit 前缀：`GMAIL_SEND_EMAIL` → `SEND_EMAIL`。
 *
 * 席位那边的 `mcpToolName()` 会把服务器名当前缀再拼一次，不去掉的话就成了
 * `mcp_gmail_person_gmail_send_email`——名字有长度上限，重复的那一截会把真正区分
 * 工具的尾巴挤掉，两个不同的工具截成同一个名字，后注册的那个被静默丢弃。
 */
export function shortToolName(toolkit: string, slug: string): string {
  const prefix = `${toolkit.toUpperCase().replace(/-/g, '_')}_`
  return slug.toUpperCase().startsWith(prefix) ? slug.slice(prefix.length) : slug
}

/**
 * 席位传回来的名字 → 真实 slug。
 *
 * **先拿真清单对，对不上再按前缀猜。** 只靠前缀猜是错的：`shortToolName` 只在 slug
 * 带 toolkit 前缀时才去前缀，而这里无条件补前缀，两者对「不带前缀的 slug」不互逆。
 * Composio 的自定义工具就是这种（`LOCAL_GMAIL_GET_IMPORTANT_EMAILS`），猜出来会变成
 * `GMAIL_LOCAL_GMAIL_…`——工具表里有、点了永远失败，还查不出为什么。
 *
 * 拿不到清单（供应商暂时不可达）时才退回猜，那时宁可猜错一个也好过把所有调用堵死。
 * 两条路都保住同一个边界：结果要么来自这个 toolkit 的清单，要么带着它的前缀，
 * 跨 toolkit 是够不着的。
 */
export function resolveToolSlug(toolkit: string, name: string, known: ToolDef[] = []): string {
  const raw = String(name || '').trim()
  if (!raw) return ''
  const upper = raw.toUpperCase()
  const hit = known.find((t) => t.slug.toUpperCase() === upper || shortToolName(toolkit, t.slug).toUpperCase() === upper)
  if (hit) return hit.slug
  const prefix = `${toolkit.toUpperCase().replace(/-/g, '_')}_`
  return upper.startsWith(prefix) ? upper : prefix + upper
}

interface RpcReq {
  jsonrpc?: string
  id?: unknown
  method?: string
  params?: unknown
}

function rpcOk(res: ServerResponse, id: unknown, result: unknown) {
  json(res, 200, { jsonrpc: '2.0', id: id ?? null, result })
}

function rpcErr(res: ServerResponse, id: unknown, code: number, message: string) {
  json(res, 200, { jsonrpc: '2.0', id: id ?? null, error: { code, message } })
}

/** 工具的返回值一律走 MCP 的 content 形状；`isError` 让席位那边知道这次没成。 */
function toolResult(text: string, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) }
}

export function attachConnectorMcp(router: Router, ctx: RouteCtx) {
  const { db, meter } = ctx

  /**
   * 这一把连接现在能不能用，以及它属于谁。
   *
   * 判定顺序一步都不能省：票 → 归属 → active → 公司没禁 → 装了 → 工具在子集里。
   * URL 上的 `botId` **只做统计归因，不参与鉴权**——它是席位自己填的，可以是假的，
   * 但假也只能假成同一个账号名下的另一颗 Bot。账号才是边界。
   */
  async function gate(req: Req): Promise<{
    account: Account
    conn: ConnectorConnection
    toolkit: string
    vendor: string
    enabledTools: string[]
    botId: string
  }> {
    const account = await requireSeatOnly(req, db)
    const conn = await db.connectorConnection(req.params.connectionId)
    if (!conn) throw new HttpError(404, '没有这个连接')
    const mine = conn.scope === 'company' ? conn.companyId === account.companyId : conn.accountId === account.id
    if (!mine) throw new HttpError(404, '没有这个连接')
    if (conn.status !== 'active') throw new HttpError(409, '这个账号还没连上')

    const items = await db.visibleCatalog('connector', account.companyId)
    const item = items.find((i) => i.id === conn.connectorId && i.scope === 'global')
    if (!item) throw new HttpError(404, '没有这个连接器')
    const def = connectorDefOf(item)
    if (!def.enabled) throw new HttpError(404, '没有这个连接器')
    if (blockMapOf(items).get(item.id)?.blocked) throw new HttpError(403, '本公司已禁用这个连接器')

    // 公司共用那把不挂在某个人的安装上，所以只有个人连接要查安装。
    let enabledTools: string[] = []
    if (conn.scope === 'user') {
      const install = await db.connectorInstall(item.id, account.id)
      if (!install) throw new HttpError(409, '还没装这个连接器')
      enabledTools = install.enabledTools
    }
    return {
      account,
      conn,
      toolkit: def.toolkit,
      vendor: def.vendor,
      enabledTools,
      botId: (req.query.get('botId') || '').trim(),
    }
  }

  // 余额、单价、落账都在 lib/meter.ts 了。这里曾经有一份自己的 budgetOf 和
  // priceMicrosOf——那时连接器是唯一往下扣的东西，所以「余额」只看 connector_calls。
  // 模型和网页工具接上之后那个口径就错了：钱烧在别处，这里算出来的余额纹丝不动。

  router.post('/mcp/connectors/:connectionId', async (req, res) => {
    const body = (req.body ?? {}) as RpcReq
    const method = String(body.method || '')
    const id = body.id
    // 通知（没有 id）不用回结果。`notifications/initialized` 是握手的最后一步。
    const isNotification = id === undefined || id === null

    const g = await gate(req)

    if (method === 'initialize') {
      rpcOk(res, id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: `satuwork-connector-${g.toolkit}`, version: '1' },
      })
      return
    }
    if (method.startsWith('notifications/')) {
      if (isNotification) {
        json(res, 200, {})
        return
      }
      rpcOk(res, id, {})
      return
    }

    if (method === 'tools/list') {
      let all: ToolDef[]
      try {
        all = await toolsOf(db, g.vendor, g.toolkit)
      } catch {
        // 拉不到清单就回空表，不回错：席位那边收到错会把整台服务器标成连不上，
        // 而它其实只是这一次没拿到目录，下一轮探针还会再来。
        rpcOk(res, id, { tools: [] })
        return
      }
      const allow = new Set(g.enabledTools)
      const picked = allow.size ? all.filter((tl) => allow.has(tl.slug)) : all
      const kept = picked.slice(0, MAX_TOOLS)
      const dropped = picked.length - kept.length
      if (dropped > 0) {
        console.warn(
          `satuwork-gateway: 连接 ${g.conn.id}（${g.toolkit}）有 ${picked.length} 个工具，超过上限 ${MAX_TOOLS}，截掉 ${dropped} 个`,
        )
      }
      rpcOk(res, id, {
        tools: kept.map((tl) => ({
          name: shortToolName(g.toolkit, tl.slug),
          description: tl.description || tl.name,
          inputSchema:
            tl.inputSchema && Object.keys(tl.inputSchema).length ? tl.inputSchema : { type: 'object', properties: {} },
        })),
        // 席位不认这个字段，但它得出现在响应里：截断必须说出来。
        ...(dropped > 0 ? { truncated: dropped } : {}),
      })
      return
    }

    if (method !== 'tools/call') {
      rpcErr(res, id, -32601, `不支持的方法：${method}`)
      return
    }

    const params = (body.params ?? {}) as { name?: unknown; arguments?: unknown; _meta?: unknown }
    /**
     * 这一次是不是用户 `@` 点名的。
     *
     * 只有席位那一侧知道（点名决定的是那一轮的工具表），所以它经 MCP 的 `params._meta`
     * 带过来。出事时第一个要问的就是「人点的还是模型自己挑的」，事后从会话正文反推
     * 既慢又不一定对得上。**只做归因，不参与任何判定**——它是席位自报的。
     */
    const viaMention = (params._meta as { viaMention?: unknown } | undefined)?.viaMention === true
    // 清单是缓存的（五分钟），所以这一步不是每次调用都打一趟上游。
    const known = await toolsOf(db, g.vendor, g.toolkit).catch(() => [] as ToolDef[])
    const slug = resolveToolSlug(g.toolkit, String(params.name ?? ''), known)
    const startedAt = Date.now()

    /**
     * 落一行流水 + 一行账。**被拒的也落**——「谁想调、为什么没调成」和「谁调了」
     * 一样要留档。
     *
     * 流水记事实（耗时、是不是点名来的、哪一把连接），账本记钱，靠 `refId` 串起来。
     * `free` 是「这一次不收钱」：我们自己拒掉的、根本没跑成的，没有产生上游成本。
     */
    const record = async (status: ConnectorCallStatus, free = false) => {
      const call = await db.insertConnectorCall({
        companyId: g.account.companyId,
        accountId: g.account.id,
        connectionId: g.conn.id,
        botId: g.botId || null,
        vendor: g.vendor,
        connector: g.toolkit,
        label: g.conn.label,
        tool: slug,
        status,
        latencyMs: Date.now() - startedAt,
        viaMention,
      })
      await meter.charge({
        kind: 'connector',
        account: g.account,
        botId: g.botId || null,
        status,
        toolkit: g.toolkit,
        tool: slug,
        free,
        refId: call.id,
      })
    }

    if (!slug) {
      await record('denied', true)
      rpcOk(res, id, toolResult('没有指定工具名', true))
      return
    }
    if (g.enabledTools.length && !g.enabledTools.includes(slug)) {
      await record('denied', true)
      rpcOk(res, id, toolResult('这个工具没有开启，去连接器那一屏打开它', true))
      return
    }

    // 变量名不叫 gate：这个文件里 gate() 已经是「取连接、查权限」那个函数了。
    const credit = await meter.gate(g.account, { kind: 'connector', toolkit: g.toolkit })
    if (!credit.ok) {
      await record('denied', true)
      // **一句人话，不是 HTTP 错误。** 席位那边会把它当工具输出交给模型，模型照实
      // 告诉用户；回错误的话模型多半会重试三次再放弃。
      rpcOk(res, id, toolResult(credit.reason, true))
      return
    }

    if (!g.conn.externalId) {
      await record('error', true)
      rpcOk(res, id, toolResult('这个账号还没连上', true))
      return
    }

    const provider = await providerFor(db, g.vendor)
    const timer = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
    try {
      const out = await provider.execute({
        tool: slug,
        externalUserId: g.conn.externalUserId,
        externalId: g.conn.externalId,
        args: params.arguments ?? {},
        signal: timer,
      })
      /**
       * **execute 返回了，就说明上游 2xx——它真的跑了一遍，照收钱**，哪怕工具自己说
       * 失败（「邮箱不存在」是跑完才知道的，成本已经发生）。没跑成的一律走下面的
       * catch：provider 的契约是「抛出 = 没跑成」，不许把异常吞成一个返回值。
       */
      await record(out.ok ? 'ok' : 'failed')
      rpcOk(res, id, toolResult(out.text, !out.ok))
    } catch (e) {
      const timedOut = timer.aborted
      // 超时**照收钱**：发出去的邮件不会因为我们没等到响应就退回来。别的失败
      // （连不上、4xx、5xx）没产生上游成本，不收。
      await record(timedOut ? 'timeout' : 'error', !timedOut)
      const msg = e instanceof ProviderError ? e.message : (e as Error).message
      rpcOk(res, id, toolResult(timedOut ? `工具调用超时（${UPSTREAM_TIMEOUT_MS / 1000} 秒）` : `工具调用失败：${msg}`, true))
    }
  })
}
