/**
 * 和 Gateway 说话的那一层：api() 与所有 load*，外加 loadPage()——「这一页要哪几份数据」。
 *
 * 视图一律不自己 fetch：要什么数据在这里说清楚，画的时候只读 state。
 */
async function api(method, path, body) {
  const headers = { accept: 'application/json' }
  // 别叫 t——下面 401 那支要用上面那个文案函数。
  const tok = token()
  if (tok) headers.authorization = 'Bearer ' + tok
  if (body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  if (res.status === 401 && tok && path !== '/auth/login' && !path.startsWith('/invites/')) {
    clearToken()
    state.me = null
    state.loginError = t('登录已过期，请重新登录')
    render()
    throw new Error((json && json.error) || t('需要登录'))
  }
  // 服务端只发中文。在这里翻一次，调用方无论是丢给 flash 还是直接塞进 state
  // （state.planSkuError、state.inviteError 这些）拿到的都已经是当前语言。
  if (!res.ok) {
    const err = new Error(errText((json && json.error) || text || 'HTTP ' + res.status))
    // 状态码挂在错误上：调用方要判断 404 就看这个，别去猜文案——文案是会被翻译的。
    err.status = res.status
    throw err
  }
  return json
}

/**
 * 提示条。翻译在这里做一次，而不是散在上百个调用点上——
 * 消息既有界面自己的文案，也有服务端原样带回来的中文，两者查的是同一张表。
 */
function flash(kind, msg) {
  const text = errText(msg)
  state.error = kind === 'err' ? text : ''
  state.notice = kind === 'ok' ? text : ''
}

function groupCatalog(rows) {
  const map = new Map()
  for (const m of rows || []) {
    const provider = m.provider || m.owned_by || ''
    if (!provider) continue
    if (!map.has(provider)) map.set(provider, { provider, name: provider, models: [] })
    map.get(provider).models.push({
      id: m.model || (typeof m.id === 'string' && m.id.includes('/') ? m.id.slice(m.id.indexOf('/') + 1) : m.id),
      name: m.name || m.model || m.id,
      reasoning: !!m.reasoning,
      input: Array.isArray(m.input) ? m.input : ['text'],
      contextWindow: m.context_window,
      maxTokens: m.max_tokens,
      cost: m.cost,
    })
  }
  return [...map.values()]
}

function configuredSet() {
  return new Set((state.creds || []).filter((c) => c.configured).map((c) => c.provider))
}

function roleLabel(role) {
  const r = state.settings?.[role]
  if (!r?.provider || !r?.model) return t('未设置')
  return `${r.provider} / ${r.model}`
}

// 局部变量不能叫 t——那是上面那个文案函数，遮住它这里就成了「t is not a function」。
function testMark(kind, id) {
  const res = state.tests[`${kind}:${id}`]
  if (!res) return ''
  if (res.status === 'busy') return `<span style="font-size: 12px; color: var(--muted-foreground);">${t('测试中…')}</span>`
  if (res.status === 'ok') return `<span style="font-size: 12px; color: var(--color-accent-2-800);">${esc(res.text)}</span>`
  return `<span style="font-size: 12px; color: var(--color-accent-800);">${esc(res.text)}</span>`
}

function adoptAccountPrefs(account) {
  if (!account) return
  // 本机已有偏好就用本机的；空着才从账号接过来——换台机器第一次登录会跟过去。
  if (!localStorage.getItem(THEME_KEY) && account.theme) setTheme(account.theme)
  if (!localStorage.getItem(LOCALE_KEY) && account.locale) setLocale(account.locale)
}

async function loadMe() {
  state.me = await api('GET', '/me')
  if (state.me?.settings) state.settings = state.me.settings
  adoptAccountPrefs(state.me?.account)
}

async function loadCatalog() {
  const data = await api('GET', '/v1/models')
  state.catalog = groupCatalog(data.data || [])
}

/** 当前月份，YYYY-MM。月份选择器留空时用它。 */
function thisMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/**
 * 统计窗口 → [from, to]（unix 毫秒）。
 *
 * 在浏览器里算：「今日」「本月」是相对**用户所在时区**的，服务端不知道那是哪个
 * 时区，自己切会错一整天。服务端只按 from/to 过滤。
 */
function statsWindow() {
  const now = new Date()
  if (state.statsRange === 'month') {
    const [y, m] = (state.statsMonth || thisMonth()).split('-').map(Number)
    const from = new Date(y, m - 1, 1, 0, 0, 0, 0).getTime()
    // 下个月 1 号减 1 毫秒 = 本月最后一刻。别去数这个月有几天。
    const to = new Date(y, m, 1, 0, 0, 0, 0).getTime() - 1
    return { from, to }
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime()
  if (state.statsRange === '7d') {
    // 近 7 天含今天，所以往回退 6 天。
    return { from: startOfToday - 6 * 86400000, to: now.getTime() }
  }
  return { from: startOfToday, to: now.getTime() }
}

async function loadStats() {
  const { from, to } = statsWindow()
  const q = new URLSearchParams({ from: String(from), to: String(to) })
  if (state.statsCompany) q.set('companyId', state.statsCompany)
  state.statsLoading = true
  render()
  try {
    state.stats = await api('GET', `/platform/stats?${q}`)
  } catch (err) {
    state.stats = null
    flash('err', err.message)
  } finally {
    state.statsLoading = false
    render()
  }
}

/** 自定义供应商只有 owner 能看能改；别的角色这份留空，界面上就不出自定义那部分。 */
async function loadCustomProviders() {
  if (!isOwner()) {
    state.customProviders = []
    return
  }
  const data = await api('GET', '/platform/providers')
  state.customProviders = data.providers || []
  state.customApis = data.apis || []
}

function customProvider(id) {
  return (state.customProviders || []).find((p) => p.id === id)
}

async function loadCreds() {
  if (isOwner()) {
    const data = await api('GET', '/platform/credentials')
    state.creds = data.credentials || []
    return
  }
  const id = orgId()
  if (!id) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/credentials`)
  state.creds = data.credentials || []
}

/**
 * 连接器：供应商、上架清单、市场。
 *
 * 市场（`/connectors`）是公司里所有人都读得到的那一份；上架清单（`/platform/connectors`）
 * 只有 owner 读得到。两份分开，是因为员工那一份**不带 authConfigId**。
 */
async function loadConnectorVendors() {
  state.connectorVendors = (await api('GET', '/platform/connector-vendors')).vendors || []
}

async function loadConnectors() {
  state.connectors = (await api('GET', '/platform/connectors')).connectors || []
}

async function loadConnectorToolkits() {
  state.connectorToolkits = (await api('GET', '/platform/connector-toolkits')).toolkits || []
}

async function loadOrgConnectors() {
  const id = orgId()
  const [list, stats] = await Promise.all([
    api('GET', `/orgs/${encodeURIComponent(id)}/connectors`),
    api('GET', `/orgs/${encodeURIComponent(id)}/connector-stats`).catch(() => null),
  ])
  state.orgConnectors = list.connectors || []
  state.connectorStats = stats
}

async function loadMarket() {
  state.market = (await api('GET', '/me/connectors')).connectors || []
}

/**
 * 一个连接器的详情：我的安装、我的几把连接、可开的工具。
 *
 * 工具清单是现拉的（Gateway 那边去问供应商），所以这一条会慢一点；拉不到时后端给
 * `toolsError`，界面照样能装能连。
 */
async function loadConnectorDetail(id) {
  state.connectorDetail = await api('GET', `/me/connectors/${encodeURIComponent(id)}`)
}

async function loadSettings() {
  if (isOwner()) {
    state.settings = await api('GET', '/platform/settings')
    return
  }
  if (state.me?.settings) state.settings = state.me.settings
}

/** 平台工具配置。只有 owner 拿得到——里面有价目，也有「哪家配了密钥」。 */
async function loadWebTools() {
  if (!isOwner()) return
  state.webTools = await api('GET', '/platform/tools/web')
}

async function loadOrgs() {
  const data = await api('GET', '/platform/orgs')
  state.orgs = data.orgs || []
}

async function loadOrders() {
  const data = await api('GET', '/platform/orders')
  state.orders = data.orders || []
}

async function loadOrgTopups(id) {
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/topups`)
  state.orgTopups = data.topups || []
}

async function loadPlanSkus() {
  const data = await api('GET', '/platform/plans')
  state.planSkus = data.plans || []
}

async function loadUsers() {
  const data = await api('GET', '/platform/accounts')
  state.users = data.accounts || []
}

async function loadUserDetail(id) {
  if (!id) {
    flash('err', t('账号不存在'))
    state.path = '/users'
    history.replaceState({}, '', '/users')
    await loadUsers()
    return
  }
  try {
    state.userDetail = await api('GET', `/platform/accounts/${encodeURIComponent(id)}`)
    state.userReveal = { apiKey: false, accessToken: false }
  } catch (err) {
    flash('err', err.message)
    if (err.status === 404) {
      state.path = '/users'
      history.replaceState({}, '', '/users')
      await loadUsers()
    }
  }
}

async function loadOrg() {
  const id = orgId()
  if (!id) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}`)
  state.org = data.company
  state.plan = data.plan
}

async function loadAccounts() {
  const id = orgId()
  if (!id) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/accounts`)
  state.accounts = data.members || data.accounts || []
  state.groups = data.groups || []
  state.seats = data.seats || { total: 0, used: 0 }
  if (data.me) state.memberMe = data.me
}

async function loadReleases() {
  const [data, mgr] = await Promise.all([
    api('GET', '/platform/bot-releases'),
    api('GET', '/platform/manager-releases').catch(() => null),
  ])
  state.releases = data.releases || []
  state.latestRelease = data.latest || null
  state.managerReleases = mgr
}

/**
 * 平台机器管理页的列表。
 *
 * 和公司详情里那份（`/platform/orgs/:id/machine`）不是一回事：这一份是**全平台**的，
 * 包括没派给任何公司的机器——按公司去列永远列不到它们，而落单的机器最需要被看见。
 */
async function loadAllMachines() {
  const data = await api('GET', '/platform/machines')
  state.allMachines = data.machines || []
  state.machineTotals = data.totals || null
  state.botLatest = data.botLatest || null
  state.managerLatest = data.managerLatest || null
}

async function loadMachineDetail(id) {
  if (!id) {
    flash('err', t('机器不存在'))
    state.path = '/machines'
    history.replaceState({}, '', '/machines')
    await loadAllMachines()
    return
  }
  try {
    const data = await api('GET', `/platform/machines/${encodeURIComponent(id)}`)
    state.machineDetail = data
    state.botLatest = data.botLatest || null
    state.managerLatest = data.managerLatest || null
  } catch (err) {
    flash('err', err.message)
    if (err.status === 404) {
      state.machineDetail = null
      state.path = '/machines'
      history.replaceState({}, '', '/machines')
      await loadAllMachines().catch(() => {})
    }
  }
}

/** GET /platform/orgs/:id/machine 那一份响应 → state。整页加载和单独刷新走的是同一条。 */
function applyMachineRes(res) {
  state.machine = res && res.machine ? res.machine : null
  state.machines = (res && res.machines) || []
  state.machineCapacity = (res && res.capacity) || null
  state.botLatest = (res && res.botLatest) || null
  state.managerLatest = (res && res.managerLatest) || null
}

/**
 * 只重新拉机器那一块，不动这一页的其它数据。
 *
 * 卡片上的心跳、管家版本、bot 版本都是**机器自报**的，Gateway 这边只是存着——下指令
 * 之后要等下一轮心跳（≤30 秒）才变。所以要有一条比整页重载轻的路给人手动催一下。
 *
 * 失败时**不动 state**：把机器列表清空会让一次网络抖动看起来像「机器全没了」。
 */
async function loadMachines(id) {
  if (!id) return
  applyMachineRes(await api('GET', `/platform/orgs/${encodeURIComponent(id)}/machine`))
}

async function loadCompanyDetail(id) {
  if (!id) {
    flash('err', t('公司不存在'))
    state.path = '/companies'
    history.replaceState({}, '', '/companies')
    await loadOrgs()
    return
  }
  try {
    const [org, accounts, billing, machineRes, botsRes] = await Promise.all([
      api('GET', `/orgs/${encodeURIComponent(id)}`),
      api('GET', `/orgs/${encodeURIComponent(id)}/accounts`),
      api('GET', `/orgs/${encodeURIComponent(id)}/billing`),
      api('GET', `/platform/orgs/${encodeURIComponent(id)}/machine`).catch(() => ({ machine: null })),
      // 这里是 owner 在看**某一家公司**的 Bot，不是全局那份。
      api('GET', `/orgs/${encodeURIComponent(id)}/bots`).catch(() => ({ bots: [] })),
      loadReleases().catch(() => { state.releases = []; state.latestRelease = null }),
      // 订阅那一栏要按价目表画下拉；拉不到就只剩「未设置」，不挡住整页。
      loadPlanSkus().catch(() => { state.planSkus = [] }),
      // 充值记录：只有已付款的充值单才有，拉不到就当空的，不挡整页。
      loadOrgTopups(id).catch(() => { state.orgTopups = [] }),
    ])
    state.org = org.company
    state.plan = org.plan
    state.balance = org.balance || null
    state.accounts = accounts.members || accounts.accounts || []
    state.seats = accounts.seats || { total: 0, used: 0 }
    state.billing = billing
    applyMachineRes(machineRes)
    if (botsRes && Array.isArray(botsRes.bots)) state.bots = botsRes.bots
  } catch (err) {
    flash('err', err.message)
    if (err.status === 404) {
      state.path = '/companies'
      history.replaceState({}, '', '/companies')
      await loadOrgs()
    }
  }
}

async function loadInvite() {
  const token = joinToken()
  state.joinInvite = { loading: true, valid: false, email: '', name: '', expiresAt: 0, error: '' }
  state.joinError = ''
  if (!token) {
    state.joinInvite = { loading: false, valid: false, email: '', name: '', expiresAt: 0, error: '' }
    return
  }
  try {
    const data = await api('GET', `/invites/${encodeURIComponent(token)}`)
    state.joinInvite = {
      loading: false,
      valid: !!data.valid,
      email: data.email || '',
      name: data.name || '',
      expiresAt: data.expiresAt || 0,
      error: '',
    }
    state.joinForm = { name: data.name || '', password: '', confirm: '' }
  } catch (err) {
    state.joinInvite = { loading: false, valid: false, email: '', name: '', expiresAt: 0, error: err.message }
  }
}


async function loadBots() {
  const base = catalogBase()
  if (!base) return
  const data = await api('GET', `${base}/bots`)
  state.bots = data.bots || []
  state.bot = null
  state.botDraft = null
}

/**
 * 公司的 Bot 模版。管理员那一页编辑的就是它，员工那边只读着看「我的 Bot 继承了什么」。
 *
 * 草稿和 state.template 分开放：改了一半还没保存的时候，版本号那一栏要显示的是**已经
 * 生效**的那一版，不是手上这份。
 */
async function loadBotTemplate() {
  const base = catalogBase()
  if (!base) return
  const data = await api('GET', `${base}/bot-template`)
  state.template = data.template || null
  state.templateOptions = { skills: data.options?.skills || [], mcps: data.options?.mcps || [] }
  state.templateDraft = draftFromTemplate(state.template)
}

function draftFromTemplate(tpl) {
  if (!tpl) return null
  const saved = tpl.guards && typeof tpl.guards === 'object' ? tpl.guards : {}
  const mem = tpl.memory && typeof tpl.memory === 'object' ? tpl.memory : {}
  return {
    prompt: tpl.prompt || '',
    escalate: tpl.escalate || '',
    skills: Array.isArray(tpl.skills) ? tpl.skills.slice() : [],
    mcps: Array.isArray(tpl.mcps) ? tpl.mcps.slice() : [],
    guards: DEFAULT_BOT_GUARDS.map((g) => ({ ...g, on: typeof saved[g.id] === 'boolean' ? saved[g.id] : g.on })),
    memoryOn: mem.on !== false,
    scope: MEMORY_SCOPES.includes(mem.scope) ? mem.scope : '所属分组',
    kinds: Array.isArray(mem.kinds) ? mem.kinds.filter((k) => MEMORY_KINDS.includes(k)) : ['偏好', '事实'],
    ttl: MEMORY_TTLS.includes(mem.ttl) ? mem.ttl : '90 天',
    cap: Number.isFinite(Number(mem.cap)) && mem.cap ? Number(mem.cap) : 20,
    confirmOn: mem.confirm !== false,
    piiOn: mem.pii !== false,
  }
}

async function loadSkills() {
  const base = catalogBase()
  if (!base) return
  const data = await api('GET', `${base}/skills`)
  state.skills = data.skills || []
  state.mcpServers = data.servers || []
  state.skillTags = data.tags || []
}

function draftFromBot(bot) {
  // 行为边界：文案在这边（要跟着界面语言走），开关从服务端来，按 id 贴回去。
  const saved = bot.guards && typeof bot.guards === 'object' ? bot.guards : {}
  const mem = bot.memory && typeof bot.memory === 'object' ? bot.memory : {}
  return {
    name: bot.name || '',
    description: bot.description || '',
    prompt: bot.prompt || '',
    icon: bot.icon || 'bot',
    provider: bot.provider || 'deepseek',
    model: bot.model || '',
    enabled: bot.enabled !== false,
    greeting: bot.greeting || '',
    skills: Array.isArray(bot.skills) ? bot.skills.slice() : [],
    mcps: Array.isArray(bot.mcps) ? bot.mcps.slice() : [],
    groups: [],
    kbs: [],
    guards: DEFAULT_BOT_GUARDS.map((g) => ({ ...g, on: typeof saved[g.id] === 'boolean' ? saved[g.id] : g.on })),
    escalate: bot.escalate || '',
    memories: [],
    memoryOn: mem.on !== false,
    scope: MEMORY_SCOPES.includes(mem.scope) ? mem.scope : '所属分组',
    kinds: Array.isArray(mem.kinds) ? mem.kinds.filter((k) => MEMORY_KINDS.includes(k)) : ['偏好', '事实'],
    ttl: MEMORY_TTLS.includes(mem.ttl) ? mem.ttl : '90 天',
    cap: Number.isFinite(Number(mem.cap)) && mem.cap ? Number(mem.cap) : 20,
    confirmOn: mem.confirm !== false,
    piiOn: mem.pii !== false,
  }
}

async function loadBotDetail(botId) {
  if (!botId) return
  // 不再拉 /v1/models：模型由平台指定，这一页没有可挑的下拉了。
  if (isOwner()) {
    const [one, opts] = await Promise.all([
      api('GET', `/platform/bots/${encodeURIComponent(botId)}`),
      api('GET', '/platform/bots/options'),
    ])
    state.bot = one.bot
    state.botDraft = draftFromBot(one.bot)
    state.botOptions = { skills: opts.skills || [], mcps: opts.mcps || [], groups: opts.groups || [], kbs: opts.kbs || [] }
    return
  }
  /**
   * 公司侧一律走 /runtime/bots/:id——**员工也进得来这一页**，而 /orgs/:id/bots/:id 是
   * 管理员接口。那条给出的也是合成之后的样子（提示词已经拼上模版那一段），正是这一页
   * 要显示的东西。
   */
  const [one, tpl] = await Promise.all([
    api('GET', `/runtime/bots/${encodeURIComponent(botId)}`),
    api('GET', `${catalogBase()}/bot-template`).catch(() => null),
  ])
  state.bot = one.bot
  state.botDraft = { ...draftFromBot(one.bot), extraPrompt: one.bot.extraPrompt || '' }
  state.template = tpl?.template || state.template
  state.botOptions = {
    skills: tpl?.options?.skills || [],
    mcps: tpl?.options?.mcps || [],
    groups: [],
    kbs: [],
  }
}

async function loadAudit() {
  const id = orgId()
  if (!id) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/audit`)
  state.events = data.events || []
}

async function loadSessions(append = false) {
  const id = orgId()
  if (!id) return
  const q = new URLSearchParams()
  if (state.sessionAccountId) q.set('accountId', state.sessionAccountId)
  const from = dayStart(state.sessionFrom)
  const to = dayEnd(state.sessionTo)
  if (from !== '') q.set('from', String(from))
  if (to !== '') q.set('to', String(to))
  // 追加下一页时带上游标；不带就是从头拉第一页（筛选条件变了要从头来）。
  if (append && state.sessionsCursor) q.set('cursor', state.sessionsCursor)
  const qs = q.toString()
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/sessions${qs ? '?' + qs : ''}`)
  const got = data.sessions || []
  state.sessions = append ? (state.sessions || []).concat(got) : got
  // 接口是分页的。不把这几个字段带出来，一份被截断的列表看起来和「就这么多」一模一样，
  // 管理员会据此以为更早的会话不存在。
  state.sessionsHasMore = Boolean(data.hasMore)
  state.sessionsLimit = Number(data.limit) || state.sessions.length
  state.sessionsCursor = data.nextCursor || ''
}

async function loadSessionDetail(sessionId) {
  const id = orgId()
  if (!id || !sessionId) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`)
  state.sessionDetail = data.session || null
  state.sessionEvents = data.events == null ? null : data.events
  state.sessionPullError = data.pullError || ''
}

async function loadBilling() {
  const id = orgId()
  if (!id) return
  state.billing = await api('GET', `/orgs/${encodeURIComponent(id)}/billing`)
}

function usageRangeMs(range) {
  const now = Date.now()
  if (range === '近 7 天') return { from: now - 7 * 24 * 3600 * 1000, to: now }
  if (range === '本月') {
    const d = new Date()
    return { from: Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1), to: now }
  }
  return { from: now - 30 * 24 * 3600 * 1000, to: now }
}

async function loadUsage() {
  const range = state.usageRange || '近 30 天'
  const { from, to } = usageRangeMs(range)
  const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  if (isAdmin() || isOwner()) {
    const id = orgId()
    if (!id) return
    state.usage = await api('GET', `/orgs/${encodeURIComponent(id)}/usage?${q}`)
    return
  }
  state.usage = await api('GET', `/me/stats?${q}`)
}

async function loadPage() {
  if (state.path.startsWith('/join/')) return
  if (!state.me) return
  if (!pathAllowed(state.path)) {
    state.path = '/'
    history.replaceState({}, '', '/')
  }
  // **Bot 名单在每一页都要有。** 它现在是侧栏的顶层，不再是「对话」页的附属——
  // 而 loadRuntimeBots 一直只在 loadChatPage 里跑，于是管理员一进概览页，名单就空了。
  // owner 没有席位，/runtime/bots 会 403，跳过它。
  if (!isOwner()) {
    await loadRuntimeBots().catch(() => {})
    // 状态点和摘要也不该只在对话页才有：人切到账单页等 Bot 干完活，正是要看着它。
    void warmBotStreams()
  }
  try {
    if (state.path === '/') {
      if (isOwner()) {
        await Promise.all([
          loadMe(),
          loadOrgs().catch(() => { state.orgs = [] }),
          loadUsers().catch(() => { state.users = [] }),
          loadCreds().catch(() => { state.creds = [] }),
          loadSettings().catch(() => {}),
        ])
      } else {
        // 管理员和员工的 / 都是对话页。管理员还要 loadOrg——右栏的运行环境要用。
        await loadMe()
        if (isAdmin()) await Promise.all([loadOrg().catch(() => {}), loadSettings().catch(() => {})])
        await loadChatPage()
      }
    } else if (state.path === '/models') {
      await Promise.all([loadCatalog(), loadCreds(), loadSettings()])
      const configured = configuredSet()
      if (!state.selectedProvider || !configured.has(state.selectedProvider)) {
        const dailyP = state.settings.daily?.provider
        const utilP = state.settings.utility?.provider
        state.selectedProvider =
          (dailyP && configured.has(dailyP) && dailyP) ||
          (utilP && configured.has(utilP) && utilP) ||
          [...configured][0] ||
          ''
      }
    } else if (state.path === '/stats') {
      await loadStats()
    } else if (state.path === '/tools') {
      await loadWebTools()
    } else if (state.path.startsWith('/connectors/')) {
      await loadConnectorDetail(connectorIdOfPath(state.path))
    } else if (state.path === '/connectors') {
      if (isOwner()) {
        // 上架清单、供应商状态、单价一起要：没有密钥时那颗「上架」按钮是灰的。
        await Promise.all([loadConnectorVendors(), loadConnectors(), loadSettings()])
      } else if (isAdmin()) {
        await loadOrgConnectors()
      } else {
        await loadMarket()
      }
    } else if (state.path === '/providers') {
      await Promise.all([loadCatalog(), loadCreds(), loadCustomProviders().catch(() => { state.customProviders = [] })])
    } else if (state.path === '/company') {
      await loadOrg()
    } else if (state.path === '/accounts') {
      await loadAccounts()
    } else if (state.path === '/audit') {
      await Promise.all([
        loadSessions(),
        loadAccounts().catch(() => { state.accounts = state.accounts || [] }),
        loadAudit().catch(() => { state.events = state.events || [] }),
      ])
    } else if (state.path.startsWith('/audit/')) {
      await loadSessionDetail(sessionIdOfPath(state.path))
    } else if (state.path === '/machines') {
      await loadAllMachines()
    } else if (state.path.startsWith('/machines/')) {
      await loadMachineDetail(machineIdOfPath(state.path))
    } else if (state.path === '/releases') {
      await loadReleases()
    } else if (state.path === '/orders') {
      // 订单表单要选公司和套餐，两份列表都得先有。
      await Promise.all([loadOrders(), loadPlanSkus(), loadOrgs()])
    } else if (state.path === '/plans') {
      await loadPlanSkus()
    } else if (state.path === '/companies') {
      await loadOrgs()
    } else if (state.path.startsWith('/companies/')) {
      await loadCompanyDetail(companyIdOfPath(state.path))
    } else if (state.path.startsWith('/users/') && state.path !== '/users') {
      await loadUserDetail(userIdOfPath(state.path))
    } else if (state.path === '/users') {
      await loadUsers()
    } else if (state.path === '/profile') {
      await loadMe()
    } else if (state.path === '/bots') {
      // owner 管的是全局 Bot 名录；公司管理员这一页是模版，底下还列着全局那几个和
      // 停用掉的老公司 Bot，所以两份都要。
      if (isOwner()) await loadBots()
      else await Promise.all([loadBotTemplate(), loadBots()])
    } else if (state.path.startsWith('/bots/')) {
      await loadBotDetail(botIdOfPath(state.path))
    } else if (state.path === '/skills') {
      await loadSkills()
    } else if (state.path === '/billing' || state.path === '/costs') {
      if (location.pathname === '/costs') history.replaceState({}, '', '/billing')
      state.path = '/billing'
      await loadBilling()
    } else if (state.path === '/usage') {
      await loadUsage()
    } else if (isChatPath(state.path) || (memberChatHome() && state.path === '/')) {
      await loadChatPage()
    }
  } catch (err) {
    flash('err', err.message)
  }
}
