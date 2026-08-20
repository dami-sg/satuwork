/**
 * 平台设置、上游密钥、用量统计、自定义供应商、连通性探测。owner-only。
 */
import type { RouteCtx } from './ctx.ts'
import { CUSTOM_APIS, type CustomProviderDef, DefError, parseProviderDef } from '../providers.ts'
import { HttpError, json, type Router } from '../http.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { enabledModelsOf, modelRoleOf, priceMultiplierOf, publicPlatformCred, publicSettings } from '../lib/org.ts'
import { rangeQuery, requireOwner, requireUser } from '../lib/guards.ts'
import { WEB_BACKENDS, type PlatformSettings, emptyWebTools, parsePriceMultiplier, parseWebTools } from '../db.ts'
import { WebToolError, canExtract, canSearch, needsSecret } from '../web-tools.ts'
import { testBackend } from '../web-service.ts'

export function attachPlatform(router: Router, ctx: RouteCtx) {
  const { db, keys, llm } = ctx

  // ── 平台（owner）───────────────────────────────────────────────────

  router.get('/platform/settings', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    json(res, 200, publicSettings(await db.platformSettings()))
  })

  router.put('/platform/settings', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    const cur = await db.platformSettings()
    const next: PlatformSettings = {
      daily: 'daily' in body ? modelRoleOf(body.daily, 'daily') : cur.daily,
      utility: 'utility' in body ? modelRoleOf(body.utility, 'utility') : cur.utility,
      enabledModels: 'enabledModels' in body ? enabledModelsOf(body.enabledModels) : cur.enabledModels ?? [],
      priceMultiplier: priceMultiplierOf(body.priceMultiplier, parsePriceMultiplier(cur.priceMultiplier)),
      managerVersion:
        'managerVersion' in body ? String(body.managerVersion ?? '').trim() : (cur.managerVersion ?? ''),
      // 这一屏不管网页工具，但 next 是整份覆盖上去的——不带着它，去模型配置页存一次
      // 就把工具配置抹了。
      webTools: cur.webTools ?? emptyWebTools(),
    }
    const saved = await db.putPlatformSettings(next)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.settings.update', detail: publicSettings(saved) })
    json(res, 200, publicSettings(saved))
  })

  router.get('/platform/credentials', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    json(res, 200, { credentials: (await db.platformCredentials()).map(publicPlatformCred) })
  })

  router.post('/platform/credentials', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    const provider = strField(body, 'provider')
    const secret = strField(body, 'secret')
    const existed = !!await db.platformCredential(provider)
    const row = await db.upsertPlatformCredential(provider, secret)
    await db.audit({
      companyId: 'platform',
      accountId: account.id,
      action: existed ? 'platform.credential.update' : 'platform.credential.create',
      detail: { provider },
    })
    json(res, existed ? 200 : 201, { credential: publicPlatformCred(row) })
  })

  router.put('/platform/credentials/:provider', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const provider = req.params.provider
    if (!await db.platformCredential(provider)) throw new HttpError(404, '密钥不存在')
    const secret = strField(bodyOf(req), 'secret')
    const row = await db.upsertPlatformCredential(provider, secret)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.credential.update', detail: { provider } })
    json(res, 200, { credential: publicPlatformCred(row) })
  })

  router.delete('/platform/credentials/:provider', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const provider = req.params.provider
    if (!await db.platformCredential(provider)) throw new HttpError(404, '密钥不存在')
    await db.deletePlatformCredential(provider)
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.credential.delete', detail: { provider } })
    json(res, 200, { deleted: true, provider })
  })

  // ── 工具配置 → 网页与搜索 ─────────────────────────────────────────────
  //
  // 只在平台层配一次，公司不配、也看不见：搜索后端是平台采购、平台计价、转售给各家
  // 的能力。公司那层留一个开关，「这家用的是哪个后端、按哪个价结算」当场变糊涂账。

  /** 密钥永不回显，只报「配没配 + 什么时候改的」，和模型供应商那屏同一条规矩。 */
  async function webToolsView() {
    const s = await db.platformSettings()
    const web = s.webTools ?? emptyWebTools()
    const creds = new Map((await db.platformCredentials()).map((c) => [c.provider, c]))
    return {
      web,
      priceMultiplier: parsePriceMultiplier(s.priceMultiplier),
      backends: WEB_BACKENDS.map((id) => ({
        id,
        search: canSearch(id),
        extract: canExtract(id),
        needsSecret: needsSecret(id),
        // firecrawl 在名单里但没实现：界面上要能看见它「未接入」，而不是凭空少一项。
        implemented: canSearch(id) || canExtract(id),
        configured: needsSecret(id) ? creds.has(id) : true,
        updatedAt: creds.get(id)?.updatedAt ?? null,
      })),
    }
  }

  router.get('/platform/tools/web', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    json(res, 200, await webToolsView())
  })

  router.put('/platform/tools/web', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    const cur = await db.platformSettings()
    const web = parseWebTools({ ...(cur.webTools ?? emptyWebTools()), ...body })
    // 配得出来的组合必须是能跑的：把只会搜索的后端设成提取后端，等于让人配出一个
    // 必然报错的组合，然后到席位那边才发现。
    if (web.searchBackend && !canSearch(web.searchBackend)) {
      throw new HttpError(400, `${web.searchBackend} 不支持搜索`)
    }
    if (web.extractBackend && !canExtract(web.extractBackend)) {
      throw new HttpError(400, `${web.extractBackend} 不支持提取`)
    }
    if (web.searxngUrl) {
      let u: URL | undefined
      try {
        u = new URL(web.searxngUrl)
      } catch {
        throw new HttpError(400, 'SearXNG 地址必须是完整的 http/https 地址')
      }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'SearXNG 地址必须是 http/https')
    }
    await db.putPlatformSettings({ ...cur, webTools: web })
    await db.audit({
      companyId: 'platform',
      accountId: account.id,
      action: 'platform.tools.web.update',
      // **不带密钥**：审计里躺一份密钥，等于把它复制到了第二个地方。
      detail: { searchBackend: web.searchBackend, extractBackend: web.extractBackend, searxngUrl: web.searxngUrl, pricing: web.pricing },
    })
    json(res, 200, await webToolsView())
  })

  /** 自检：拿固定查询词打一次选中的后端。不记 web_calls——这是验配置，不是用。 */
  router.post('/platform/tools/web/test', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const kind = strField(bodyOf(req), 'kind') === 'extract' ? 'extract' : 'search'
    try {
      const out = await testBackend(db, kind)
      json(res, 200, { ok: true, kind, ...out })
    } catch (e) {
      // 自检失败是这一屏的正常结果，不是接口故障：要让管理员看见原因，而不是一个红叉。
      json(res, 200, { ok: false, kind, error: e instanceof WebToolError ? e.hint : (e as Error).message })
    }
  })

  /** 网页调用的汇总：按公司一行、按后端一行，外加一个合计。 */
  function webStats(
    rows: { companyId: string | null; backend: string; kind: string; calls: number; units: number; mils: number; lastAt: number | null }[],
    companies: Map<string, { id: string; name: string }>,
  ) {
    const byCompany = new Map<string, { companyId: string | null; name: string; calls: number; units: number; mils: number; lastAt: number | null }>()
    const byBackend = new Map<string, { backend: string; search: number; extract: number; units: number; mils: number }>()
    for (const row of rows) {
      const key = row.companyId ?? ''
      let c = byCompany.get(key)
      if (!c) {
        c = {
          companyId: row.companyId,
          name: row.companyId ? companies.get(row.companyId)?.name ?? row.companyId : '平台（系统管理员）',
          calls: 0, units: 0, mils: 0, lastAt: null,
        }
        byCompany.set(key, c)
      }
      c.calls += row.calls
      c.units += row.units
      c.mils += row.mils
      if (row.lastAt != null && (c.lastAt == null || row.lastAt > c.lastAt)) c.lastAt = row.lastAt

      let b = byBackend.get(row.backend)
      if (!b) {
        b = { backend: row.backend, search: 0, extract: 0, units: 0, mils: 0 }
        byBackend.set(row.backend, b)
      }
      if (row.kind === 'search') b.search += row.calls
      else b.extract += row.calls
      b.units += row.units
      b.mils += row.mils
    }
    const list = [...byCompany.values()].sort((a, b) => b.mils - a.mils)
    return {
      byCompany: list,
      byBackend: [...byBackend.values()].sort((a, b) => b.mils - a.mils),
      totals: list.reduce(
        (acc, x) => ({ calls: acc.calls + x.calls, units: acc.units + x.units, mils: acc.mils + x.mils }),
        { calls: 0, units: 0, mils: 0 },
      ),
    }
  }

  /**
   * 平台用量统计：按公司汇总 token，并按模型单价折成金额。
   *
   * 时间窗由前端算好用 from/to（unix 毫秒）传进来——「今日」「本月」是相对
   * **用户所在时区**的，服务端不知道那是哪个时区，自己切会错一整天。
   *
   * 金额用浮点数算：它是从 token 数折出来的展示值，不是账本条目（账本那边
   * 是 amountMils 整数厘）。token 数和单价的量级下，双精度的误差落不到显示位上。
   */
  router.get('/platform/stats', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const range = rangeQuery(req)
    const companyId = (req.query.get('companyId') || '').trim()
    if (companyId && !(await db.company(companyId))) throw new HttpError(404, '公司不存在')

    const rows = await db.llmUsageByCompanyModel(range, companyId || undefined)
    const webRows = await db.webUsageByCompanyBackend(range, companyId || undefined)
    const multiplier = parsePriceMultiplier((await db.platformSettings()).priceMultiplier)
    const rates = new Map<string, { input: number; output: number; cacheRead: number }>()
    for (const m of await llm.catalog(null)) {
      const c = (m.cost ?? {}) as { input?: unknown; output?: unknown; cacheRead?: unknown }
      const input = Number(c.input) || 0
      rates.set(`${m.provider}/${m.id}`, {
        input,
        output: Number(c.output) || 0,
        // 目录里没写缓存读单价就按输入价算——宁可高估，也不要因为缺一列就把这部分白送。
        // 自定义供应商的 cost.cacheRead 允许留 0（providers.ts 的 nonNegative），
        // 那种情况下 `|| input` 正好接住。
        cacheRead: Number(c.cacheRead) || input,
      })
    }

    const companies = new Map((await db.companies()).map((c) => [c.id, c]))
    type Bucket = {
      companyId: string | null
      name: string
      calls: number
      promptTokens: number
      completionTokens: number
      /** promptTokens 里命中缓存的那一截。是子集，界面上用来解释金额为什么比 token 数低。 */
      cachedTokens: number
      costUsd: number
      quotedUsd: number
      unpricedCalls: number
      lastAt: number | null
    }
    const byCompany = new Map<string, Bucket>()
    const byModel = new Map<string, {
      provider: string
      model: string
      calls: number
      promptTokens: number
      completionTokens: number
      cachedTokens: number
      costUsd: number
      quotedUsd: number
      priced: boolean
    }>()
    /** 目录里没价的模型（pi-ai 没收录，或自定义时留了 0）。金额算不出来，得说清楚。 */
    const unpricedModels = new Set<string>()

    for (const row of rows) {
      const key = `${row.provider}/${row.model}`
      const rate = rates.get(key)
      const priced = !!rate && (rate.input > 0 || rate.output > 0)
      if (!priced) unpricedModels.add(key)
      /**
       * 单价的单位是「每 100 万 token 多少美元」，和内置目录一致。
       *
       * **命中缓存的那一截要单算。** `promptTokens` 含缓存（见 v1.ts 的
       * openaiUsage：pi 的 `input` 是未命中的部分，缓存那截另算，两者相加才是这次
       * 真发出去的提示词），而缓存读的单价低得多——Anthropic 的 claude-haiku-4-5 是
       * 输入 1、缓存读 0.1，差十倍。全部按输入价算，等于把最省钱的那部分按最贵的收。
       *
       * `min` 是防线：cachedTokens 理论上是 promptTokens 的子集，真出现脏数据
       * （上游改了口径、旧行没有这一列）也不能算出负的未命中量。
       */
      const cached = Math.min(Math.max(0, row.cachedTokens), row.promptTokens)
      const fresh = row.promptTokens - cached
      const cost = priced
        ? (fresh * rate.input + cached * rate.cacheRead + row.completionTokens * rate.output) / 1_000_000
        : 0

      const cid = row.companyId
      const bk = cid ?? ''
      let bucket = byCompany.get(bk)
      if (!bucket) {
        bucket = {
          companyId: cid,
          name: cid ? companies.get(cid)?.name ?? cid : '平台（系统管理员）',
          calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, quotedUsd: 0, unpricedCalls: 0, lastAt: null,
        }
        byCompany.set(bk, bucket)
      }
      bucket.calls += row.calls
      bucket.promptTokens += row.promptTokens
      bucket.completionTokens += row.completionTokens
      bucket.cachedTokens += cached
      bucket.costUsd += cost
      bucket.quotedUsd += cost * multiplier
      if (!priced) bucket.unpricedCalls += row.calls
      if (row.lastAt != null && (bucket.lastAt == null || row.lastAt > bucket.lastAt)) bucket.lastAt = row.lastAt

      let mb = byModel.get(key)
      if (!mb) {
        mb = { provider: row.provider, model: row.model, calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, quotedUsd: 0, priced }
        byModel.set(key, mb)
      }
      mb.calls += row.calls
      mb.promptTokens += row.promptTokens
      mb.completionTokens += row.completionTokens
      mb.cachedTokens += cached
      mb.costUsd += cost
      mb.quotedUsd += cost * multiplier
    }

    const list = [...byCompany.values()].sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens))
    const totals = list.reduce(
      (acc, x) => ({
        calls: acc.calls + x.calls,
        promptTokens: acc.promptTokens + x.promptTokens,
        completionTokens: acc.completionTokens + x.completionTokens,
        cachedTokens: acc.cachedTokens + x.cachedTokens,
        costUsd: acc.costUsd + x.costUsd,
        quotedUsd: acc.quotedUsd + x.quotedUsd,
        unpricedCalls: acc.unpricedCalls + x.unpricedCalls,
      }),
      { calls: 0, promptTokens: 0, completionTokens: 0, cachedTokens: 0, costUsd: 0, quotedUsd: 0, unpricedCalls: 0 },
    )

    json(res, 200, {
      from: range.from ?? null,
      to: range.to ?? null,
      multiplier,
      companies: [...companies.values()].map((c) => ({ id: c.id, name: c.name })),
      byCompany: list,
      byModel: [...byModel.values()].sort((a, b) => b.promptTokens + b.completionTokens - (a.promptTokens + a.completionTokens)),
      totals,
      // 前端要据此提示「有模型没单价，金额不完整」，不能让 $0.00 被读成免费。
      unpricedModels: [...unpricedModels],
      // 网页工具按次算钱，跟 token 不是一个量纲，所以单开一块，不混进上面的合计。
      // 金额直接求和：那已经是**写行那一刻的报价**，不重算（重算会让改价追溯改账）。
      web: webStats(webRows, companies),
    })
  })

  // ── 自定义供应商（pi-ai 的 createProvider 形状）──────────────────────

  /** 删掉这个供应商就没模型可用了的角色。删之前先问清楚，别让日常模型悄悄哑掉。 */
  async function rolesUsing(provider: string): Promise<string[]> {
    const s = await db.platformSettings()
    const hit: string[] = []
    if (s.daily.provider === provider) hit.push('日常')
    if (s.utility.provider === provider) hit.push('utility')
    return hit
  }

  async function customProviderItem(id: string) {
    for (const item of await db.visibleCatalog('provider', null)) {
      const def = (item.definition ?? {}) as { id?: unknown }
      if (String(def.id ?? item.name) === id) return item
    }
    return undefined
  }

  function defOf(item: { definition: unknown }): CustomProviderDef {
    return parseProviderDef(item.definition)
  }

  /** parseProviderDef 抛的是 DefError，对外要变成 400，不能漏成 500。 */
  function parseOr400<T>(fn: () => T): T {
    try {
      return fn()
    } catch (e) {
      if (e instanceof DefError) throw new HttpError(400, e.message)
      throw e
    }
  }

  router.get('/platform/providers', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const items = await db.visibleCatalog('provider', null)
    const out: Record<string, unknown>[] = []
    for (const item of items) {
      try {
        out.push({ itemId: item.id, ...defOf(item) })
      } catch (e) {
        // 坏定义也要露出来，否则界面上它就是一条看不见删不掉的记录。
        out.push({ itemId: item.id, id: item.name, name: item.name, broken: (e as Error).message })
      }
    }
    json(res, 200, { providers: out, apis: CUSTOM_APIS, builtin: [...llm.builtinProviderIds()] })
  })

  router.post('/platform/providers', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const def = parseOr400(() => parseProviderDef(bodyOf(req)))
    if (llm.isBuiltinProvider(def.id)) throw new HttpError(409, `${def.id} 是内置供应商，换个 id`)
    if (await customProviderItem(def.id)) throw new HttpError(409, '这个供应商 id 已经有了')
    const item = await db.insertCatalog({ kind: 'provider', scope: 'global', companyId: null, name: def.id, definition: def })
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.provider.create', detail: { provider: def.id } })
    json(res, 201, { provider: { itemId: item.id, ...def } })
  })

  router.put('/platform/providers/:provider', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const item = await customProviderItem(req.params.provider)
    if (!item) throw new HttpError(404, '自定义供应商不存在')
    // id 不给改：模型角色、密钥、用量记录都是按它存的，改了会成孤儿。
    const def = parseOr400(() => parseProviderDef({ ...(bodyOf(req) as object), id: req.params.provider }))
    const next = await db.updateCatalog(item.id, { name: def.id, definition: def })
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.provider.update', detail: { provider: def.id } })
    json(res, 200, { provider: { itemId: next.id, ...def } })
  })

  router.delete('/platform/providers/:provider', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const provider = req.params.provider
    const item = await customProviderItem(provider)
    if (!item) throw new HttpError(404, '自定义供应商不存在')
    const used = await rolesUsing(provider)
    if (used.length && req.query.get('force') !== '1') {
      throw new HttpError(409, `${used.join(' 和 ')}模型正在用它，确认要删就带 force=1`, { roles: used })
    }
    await db.deleteCatalog(item.id)
    // 密钥跟着走，别在库里留一把指向不存在的供应商的密钥。
    if (await db.platformCredential(provider)) await db.deletePlatformCredential(provider)
    for (const role of used) {
      await db.putPlatformSettings({
        ...(await db.platformSettings()),
        [role === '日常' ? 'daily' : 'utility']: { provider: '', model: '' },
      })
    }
    await db.audit({ companyId: 'platform', accountId: account.id, action: 'platform.provider.delete', detail: { provider, clearedRoles: used } })
    json(res, 200, { deleted: true, provider, clearedRoles: used })
  })

  router.post('/platform/llm/test', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireOwner(account)
    const body = bodyOf(req)
    let provider = ''
    let model = ''
    const role = body.role
    const cur = await db.platformSettings()
    if (role === 'daily' || role === 'utility') {
      const slot = cur[role]
      if (!slot.provider || !slot.model) throw new HttpError(400, `${role === 'daily' ? '日常' : 'utility'} 模型还没设置`)
      provider = slot.provider
      model = slot.model
    } else {
      provider = strField(body, 'provider')
      model = strField(body, 'model', false)
      if (!model) {
        if (cur.daily.provider === provider && cur.daily.model) model = cur.daily.model
        else if (cur.utility.provider === provider && cur.utility.model) model = cur.utility.model
        else model = await llm.firstModel(null, provider)
      }
      if (!model) throw new HttpError(400, '这个供应商没有可测的模型')
    }
    const result = await llm.probe(null, provider, model)
    if (!result.ok && result.error === '模型不在可见目录里') {
      throw new HttpError(404, result.error, { model: `${result.provider}/${result.model}` })
    }
    if (!result.ok && result.error?.startsWith('没有 ') && result.error.endsWith(' 的密钥')) {
      throw new HttpError(402, result.error, { provider: result.provider })
    }
    json(res, 200, result)
  })
}
