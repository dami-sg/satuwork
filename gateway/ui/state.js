/**
 * 全局 state，外加围着它转的那些小工具：转义、金额与时间、角色判断、路径解析。
 *
 * 都是纯函数，不发请求、不碰 DOM——发请求的在 data.js，画东西的在 pages-*.js。
 */
const state = {
  me: null,
  path: '/',
  rail: false,
  busy: false,
  loginError: '',
  loginEmail: '',
  loginPassword: '',
  needsSetup: false,
  setupError: '',
  setupEmail: '',
  setupName: '',
  error: '',
  notice: '',
  catalog: [],
  creds: [],
  settings: { daily: { provider: '', model: '' }, utility: { provider: '', model: '' } },
  selectedProvider: '',
  accounts: [],
  seats: { total: 0, used: 0 },
  events: [],
  sessions: [],
  sessionDetail: null,
  sessionEvents: null,
  sessionPullError: '',
  auditTab: 'chats',
  sessionAccountId: '',
  sessionFrom: '',
  sessionTo: '',
  org: null,
  plan: null,
  orgs: [],
  users: [],
  addOpen: false,
  orgCreateOpen: false,
  // 建公司的报错留在弹窗里。弹窗盖着列表，flash 画在列表上等于没画。
  orgCreateError: '',
  planSkus: [],
  orders: [],
  /** null = 不开；{ id: '' } = 新建；{ id: '<id>' } = 改这条。 */
  orderEdit: null,
  orderError: '',
  /** 某家公司的充值记录（公司详情用）。充值单付款后才会有。 */
  orgTopups: [],
  /** 公司详情的两笔余额：套餐赠送（跟套餐到期）与单独充值（不过期）。 */
  balance: null,
  /**
   * null = 不开；{ id: '' } = 新增；{ id: '<id>' } = 改这条。
   * `draft` 只在保存失败后才有：重名被打回来时得把人刚填的留在框里，
   * 不然 render 会拿库里的旧值把它盖掉，报着「已存在」却显示旧名字。
   */
  planSkuEdit: null,
  planSkuError: '',
  tests: {},
  savingMultiplier: false,
  /** 统计页：窗口口径、选中的公司、选中的月份，以及接口回来的那份数据。 */
  statsRange: 'today',
  statsMonth: '',
  statsCompany: '',
  stats: null,
  statsLoading: false,
  /** 自定义供应商（pi-ai createProvider 的形状），来自 /platform/providers。 */
  customProviders: [],
  customApis: [],
  /** 「添加自定义供应商」弹窗里那份草稿；null 表示没开。 */
  providerDraft: null,
  providerError: '',
  /** 正在编模型清单的那个自定义供应商 id。 */
  modelsFor: '',
  modelDraft: null,
  inviteOpen: false,
  inviteLink: '',
  inviteEmail: '',
  inviteExpiresAt: 0,
  inviteCopied: false,
  inviteError: '',
  inviteForm: { name: '', email: '', role: 'member', ttlDays: 7 },
  editing: null,
  editForm: { name: '', role: 'member', status: 'active' },
  editLink: '',
  editCopied: false,
  menu: null,
  menuFlip: false,
  confirm: null,
  secret: null,
  joinInvite: { loading: true, valid: false, email: '', name: '', expiresAt: 0, error: '' },
  joinForm: { name: '', password: '', confirm: '' },
  joinError: '',
  groups: [],
  accountsTab: 'members',
  groupDialog: null,
  groupForm: { name: '', desc: '', icon: 'chat', role: 'member', members: [] },
  groupError: '',
  profileDraft: null,
  profileSaved: false,
  profileError: '',
  pwOpen: false,
  pwForm: { current: '', next: '', confirm: '' },
  pwError: '',
  notifyOff: [],
  bots: [],
  bot: null,
  botDraft: null,
  botOptions: { skills: [], mcps: [], groups: [], kbs: [] },
  skills: [],
  mcpServers: [],
  skillTags: [],
  skillsTab: 'Skill',
  skillDialog: null,
  skillForm: null,
  skillError: '',
  skillFile: null,
  skillEntries: null,
  skillTagManage: false,
  skillTagAdding: false,
  skillFailure: '',
  billing: null,
  billingTab: 'sub',
  billingAutoRenew: null,
  usage: null,
  usageRange: null,
  runtimeBots: [],
  runtimeError: '',
  machine: null,
  /** 这台机器上现在跑着什么：管家版本、各 bot 版本的席位数、有没有更新的版本。 */
  /** 这家公司的机器列表（每台带负载和版本）。 */
  machines: [],
  machineCapacity: null,
  botLatest: null,
  managerLatest: null,
  managerReleases: null,
  /** 机器配置页当前 tab：manager | bot。 */
  machineTab: 'manager',
  /** 哪个 kind 的「新增版本」是展开的。提交失败时保持展开，不然填的东西白填了。 */
  addRelease: '',
  /** 刚生成的配对码。只在内存里——刷新就没了，界面上也是这么说的。 */
  pairingCode: null,
  seatMember: null,
  seatRuntime: null,
  seatRuntimes: [],
  seatReveal: false,
  seatError: '',
  userDetail: null,
  userReveal: { apiKey: false, accessToken: false },
  runtimeMachine: null,
  desktopRuntime: null,
  deploying: false,
  /**
   * 运行日志面板。null 表示没开着；开着时是
   * `{ title, active, sources: [{ key, label, url }] }`——见 chat.js 的 openLogs。
   */
  logsOpen: null,
  logLines: [],
  logError: '',
  deployHint: '',
  releases: [],
  latestRelease: null,
  updatingRuntime: false,
  sessionsHasMore: false,
  sessionsLimit: 0,
  sessionsCursor: '',
  sessionsLoadingMore: false,
  chatBotId: '',
  chatSessionId: '',
  chatEvents: [],
  chatDraft: '',
  chatStatus: '',
  chatFiles: [],
  /** botId → 没发出去的草稿。切走再切回来，打了一半的话还在。 */
  chatDrafts: {},
  /** 正在重放历史。期间只收不画，见 startChatStream。 */
  chatReplaying: false,
  /** 输入框那条「上下文占了多少」的浮层开着没有。 */
  chatCtxOpen: false,
}


function token() {
  return sessionStorage.getItem(TOKEN_KEY)
}
function setToken(t) {
  sessionStorage.setItem(TOKEN_KEY, t)
}
function clearToken() {
  sessionStorage.removeItem(TOKEN_KEY)
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function fmtTime(ms) {
  if (!ms) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Kuching',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

function money(n) {
  if (n === undefined || n === null || n === '') return '—'
  const x = Number(n)
  if (!Number.isFinite(x)) return '—'
  return x >= 1 ? `$${x.toFixed(2)}` : `$${x.toFixed(3)}`
}

/** 套餐金额，美元。跟上面的 money() 分开：那个是 token 成本，不足 $1 要看到第三位小数。 */
/**
 * 套餐金额。入参是**厘**（整数，千分之一美元），不是元——从整数格式化，
 * 免得 amount/1000 的浮点误差跑到界面上。
 * 常规价显示两位小数；带厘位的价（$0.005 这种）才显示第三位，不然满屏都是多余的 0。
 */
function usd(mils) {
  const m = Number(mils)
  if (!Number.isFinite(m)) return '—'
  if (m === 0) return '$0.00'
  const neg = m < 0
  const a = Math.round(Math.abs(m))
  const whole = Math.floor(a / 1000)
  const frac = a % 1000
  const dec = frac % 10 === 0 ? String(frac / 10).padStart(2, '0') : String(frac).padStart(3, '0')
  const loc = localeMode === 'en' ? 'en-US' : 'zh-CN'
  return `${neg ? '-' : ''}$${whole.toLocaleString(loc)}.${dec}`
}

function capTags(m) {
  const input = Array.isArray(m.input) ? m.input : []
  const vision = input.includes('image')
  const tags = []
  if (m.reasoning) tags.push(`<span class="tag tag-neutral">${t('推理')}</span>`)
  if (vision) tags.push(`<span class="tag tag-neutral">${t('识图')}</span>`)
  if (!tags.length) tags.push(`<span class="tag tag-neutral">${t('对话')}</span>`)
  return tags.join('')
}

function tokens(n) {
  if (!n) return '—'
  return n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`
}

function orgId() {
  return state.me?.company?.id
}

/**
 * Bot / Skill / MCP 的接口前缀。
 *
 * owner 管的是全局那份（所有公司可见），公司管理员管自己公司那份。两边的页面是
 * 同一套，只有这个前缀不同——所以别在页面里到处判角色，判这一处就够了。
 * 拿不到前缀（成员账号）就返回空串，调用方据此直接不发请求。
 */
function catalogBase() {
  if (isOwner()) return '/platform'
  const id = orgId()
  return id ? `/orgs/${encodeURIComponent(id)}` : ''
}

/** 全局项在公司侧只能看不能改。owner 自己在平台页面里管的就是全局项，不受这条限制。 */
function readOnlyItem(item) {
  return !isOwner() && item?.origin === 'global'
}

function currentRole() {
  return state.me?.account?.role || ''
}

function isOwner() {
  return currentRole() === 'owner'
}

function isAdmin() {
  return currentRole() === 'admin'
}

function navForRole() {
  const role = currentRole()
  if (role === 'owner') return OWNER_NAV
  if (role === 'admin') return ADMIN_NAV
  return MEMBER_NAV
}

function allowedHrefs() {
  // '/' 不在导航里也必须可达：公司侧它就是对话页，是这些人的落点。
  const set = new Set([...navForRole().map((n) => n.href), '/profile', '/'])
  // 全局 Bot 从 owner 的菜单里撤了（见 OWNER_NAV），但**页面没撤**：撤的是入口，
  // 不是功能。少了这一行，owner 直接输 /bots 会被 pathAllowed 踢回首页，全局 Bot
  // 目录就此没人改得动了——而他是唯一改得动的人。
  if (isOwner()) set.add('/bots')
  return set
}

function isChatPath(p) {
  return p === '/chat' || (typeof p === 'string' && p.startsWith('/a/'))
}

function chatBotIdOf(p) {
  if (!p || !p.startsWith('/a/')) return ''
  return decodeURIComponent(p.slice('/a/'.length).split('/')[0] || '')
}

/**
 * 「/ 就是对话页」的角色。
 *
 * 公司侧不再有概览页——那一屏说的都是别处已经说过的话，而人进来是为了看 Bot。
 * 去掉它之后，管理员和员工的落点是一样的：首页直接是对话。只有 owner 例外，
 * 他管的是平台，没有席位也进不了对话。
 */
function memberChatHome() {
  return !isOwner()
}

function pathAllowed(p) {
  if (p === '/costs') p = '/billing'
  if (allowedHrefs().has(p)) return true
  // /bots/:id 跟 /profile 一样不在侧栏，但管理员能进。
  if (p.startsWith('/bots/') && allowedHrefs().has('/bots')) return true
  if (p.startsWith('/companies/') && allowedHrefs().has('/companies')) return true
  if (p.startsWith('/users/') && allowedHrefs().has('/users')) return true
  if (p.startsWith('/audit/') && allowedHrefs().has('/audit')) return true
  if (isChatPath(p)) return !isOwner()
  return false
}

function botIdOfPath(p) {
  if (!p.startsWith('/bots/')) return ''
  return decodeURIComponent(p.slice('/bots/'.length).split('/')[0] || '')
}

function companyIdOfPath(p) {
  if (!p.startsWith('/companies/')) return ''
  return decodeURIComponent(p.slice('/companies/'.length).split('/')[0] || '')
}

function userIdOfPath(p) {
  if (!p.startsWith('/users/')) return ''
  return decodeURIComponent(p.slice('/users/'.length).split('/')[0] || '')
}

function sessionIdOfPath(p) {
  if (!p.startsWith('/audit/')) return ''
  return decodeURIComponent(p.slice('/audit/'.length).split('/')[0] || '')
}

/** 一级页面头上那个标题。二级页面走 crumbsOf()，不经过这里。 */
function pageTitle(path) {
  if (isChatPath(path) || (memberChatHome() && path === '/')) return t('对话')
  // owner 在这两个页面上管的是全局那份，标题得说清楚，别跟公司页混起来。
  if (isOwner() && PATHS[path]?.ownerTitle) return t(PATHS[path].ownerTitle)
  return t(PATHS[path]?.title || 'Satuwork')
}

/**
 * 二级页面的面包屑：`{ href, parent, current }`；一级页面返回 null，头上照旧只有一个标题。
 *
 * 上一级只看路径，不看是从哪儿点进来的——同一个地址不管怎么进来，面包屑和那个返回
 * 都指向同一处，不会把人送回一个不相干的页面。
 *
 * 当前这一级用的是**已经载到的那条数据**的名字，且要求 id 跟地址里的对得上：
 * 页面之间 state.bot / state.org 这些是留在内存里的，不比对就会在新的一条还没到时
 * 顶着上一条的名字。对不上就退回一个泛称，宁可少说一句，不能说错。
 */
function crumbsOf(path) {
  if (path.startsWith('/bots/')) {
    const bot = state.bot && state.bot.id === botIdOfPath(path) ? state.bot : null
    return { href: '/bots', parent: isOwner() ? t('全局 Bot') : t('Bot 配置'), current: bot?.name || t('Bot 详情') }
  }
  if (path.startsWith('/companies/') && path !== '/companies') {
    const org = state.org && state.org.id === companyIdOfPath(path) ? state.org : null
    return { href: '/companies', parent: t('公司'), current: org?.name || t('公司详情') }
  }
  if (path.startsWith('/users/') && path !== '/users') {
    const acc = state.userDetail?.account
    const one = acc && acc.id === userIdOfPath(path) ? acc : null
    return { href: '/users', parent: t('用户'), current: one?.name || one?.email || t('账号详情') }
  }
  if (path.startsWith('/audit/') && path !== '/audit') {
    const row = state.sessionDetail
    const id = sessionIdOfPath(path)
    const one = row && (row.sessionId || row.id) === id ? row : null
    return { href: '/audit', parent: t('审计'), current: one?.title || t('对话') }
  }
  return null
}

function dayStart(dateStr) {
  if (!dateStr) return ''
  const t = new Date(dateStr + 'T00:00:00').getTime()
  return Number.isFinite(t) ? t : ''
}

function dayEnd(dateStr) {
  if (!dateStr) return ''
  const t = new Date(dateStr + 'T23:59:59.999').getTime()
  return Number.isFinite(t) ? t : ''
}

/** Bot 详情页的图标格里那份草稿还没落库，层级要从当前页面的角色推。 */
function draftOrigin() {
  return state.bot?.origin || (isOwner() ? 'global' : 'company')
}

function svg(paths, size = 17) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round">${paths
    .map((d) => `<path d="${esc(d)}"/>`)
    .join('')}</svg>`
}

function pathOf() {
  const p = location.pathname
  if (p === '/ui' || p === '/ui/' || p === '/index.html') return '/'
  if (p.startsWith('/join/')) return p
  if (p === '/bots' || p.startsWith('/bots/')) return p
  if (p === '/companies' || p.startsWith('/companies/')) return p
  if (p === '/users' || p.startsWith('/users/')) return p
  if (p === '/audit' || p.startsWith('/audit/')) return p
  if (p === '/chat' || p.startsWith('/a/')) return p
  if (p === '/costs') return '/billing'
  return PATHS[p] ? p : '/'
}

function joinToken() {
  if (!state.path.startsWith('/join/')) return ''
  return decodeURIComponent(state.path.slice('/join/'.length).split('/')[0] || '')
}

function go(href) {
  if (location.pathname !== href) history.pushState({}, '', href)
  state.path = href
  state.error = ''
  state.notice = ''
  state.addOpen = false
  if (typeof closeMemberUi === 'function') closeMemberUi()
  if (typeof closeSkillDialog === 'function') closeSkillDialog()
  state.seatMember = null
  state.seatRuntime = null
  state.seatRuntimes = []
  state.userReveal = { apiKey: false, accessToken: false }
  state.seatReveal = false
  state.seatError = ''
  loadPage().then(render)
}
