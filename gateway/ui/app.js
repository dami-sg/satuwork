const TOKEN_KEY = 'satuwork.gateway.token'
const THEME_KEY = 'satu.theme'
const LOCALE_KEY = 'satu.locale'

let themeMode = localStorage.getItem(THEME_KEY) || 'system'
let localeMode = localStorage.getItem(LOCALE_KEY) || 'zh'

const darkMq = matchMedia('(prefers-color-scheme: dark)')

/** system 在 CSS 里不存在：解析成 light/dark 再落到 <html data-theme>。 */
function paintTheme() {
  const resolved = themeMode === 'system' ? (darkMq.matches ? 'dark' : 'light') : themeMode
  document.documentElement.setAttribute('data-theme', resolved)
}

function setTheme(mode) {
  themeMode = mode
  localStorage.setItem(THEME_KEY, mode)
  paintTheme()
}

function setLocale(key) {
  localeMode = key
  localStorage.setItem(LOCALE_KEY, key)
  document.documentElement.lang = key === 'en' ? 'en' : 'zh-CN'
}

function t(zh, en) {
  return localeMode === 'en' ? (en ?? zh) : zh
}

function applyPrefs() {
  paintTheme()
  document.documentElement.lang = localeMode === 'en' ? 'en' : 'zh-CN'
}

darkMq.addEventListener('change', () => {
  if (themeMode === 'system') paintTheme()
})

applyPrefs()


const PATHS = {
  '/': { title: '概览' },
  '/models': { title: '模型配置' },
  '/providers': { title: '供应商' },
  '/company': { title: '公司/席位' },
  '/accounts': { title: '员工' },
  '/audit': { title: '审计' },
  '/companies': { title: '公司' },
  '/releases': { title: 'Bot 运行时' },
  '/users': { title: '用户' },
  '/plans': { title: '套餐' },
  '/stats': { title: '统计' },
  '/billing': { title: '账单' },
  '/usage': { title: '用量统计' },
  '/costs': { title: '账单' },
  '/catalog': { title: '公司目录' },
  '/profile': { title: '个人设置' },
  '/bots': { title: 'Bot 配置' },
  '/skills': { title: 'Skill 与 MCP' },
  '/chat': { title: '对话' },
}

const ICONS = {
  overview: ['M3 10.5 12 3l9 7.5', 'M5 10v10h5v-6h4v6h5V10'],
  models: [
    'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    'M9 9h6v6H9z',
    'M9 3v2',
    'M15 3v2',
    'M9 19v2',
    'M15 19v2',
  ],
  providers: ['M21 2l-2 2', 'M7 14a5 5 0 1 0 0 0.01', 'M12.5 8.5 21 2', 'M16 7l3 3'],
  company: ['M3 21h18', 'M5 21V7l7-4 7 4v14', 'M9 21v-6h6v6'],
  accounts: ['M2 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2', 'M8 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M19 8v6', 'M22 11h-6'],
  audit: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
  plans: ['M4 7h16', 'M4 12h16', 'M4 17h10'],
  stats: ['M4 19V5', 'M4 19h16', 'M8 15v4', 'M12 11v8', 'M16 8v11'],
  billing: ['M2 5h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M1 10h22'],
  usage: ['M3 12h4l3 8 4-16 3 8h4'],
  catalog: ['M4 6h7v7H4z', 'M13 6h7v7h-7z', 'M4 15h7v5H4z', 'M13 15h7v5h-7z'],
  bots: ['M3 8h18a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', 'M12 4v4', 'M8 14h.01', 'M16 14h.01'],
  skills: ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'],
  chat: ['M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-4l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'],
}

const AGENT_ICONS = {
  bot: ['M5 9h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M12 5v4', 'M12 3a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3z', 'M8.5 14h.01', 'M15.5 14h.01', 'M9.5 17.5h5'],
  chat: ['M4 8h16a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-3l-5 4v-4H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', 'M12 4v4', 'M8.5 12h.01', 'M15.5 12h.01'],
  chart: ['M5 9h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M12 4v5', 'M8 17v-3', 'M12 17v-5', 'M16 17v-2'],
  pen: ['M5 9h9a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M9.5 4v5', 'M7 14h.01', 'M11 14h.01', 'M22 3l-5.5 5.5', 'M19 3h3v3'],
  deal: ['M5 9h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M12 4v5', 'M8 16l2.5-2.5L13 16l3-3.5', 'M8.5 13h.01'],
  code: ['M5 9h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z', 'M12 4v5', 'm9.5 13-1.5 1.5 1.5 1.5', 'm14.5 13 1.5 1.5-1.5 1.5'],
}

const AGENT_ICON_KEYS = ['bot', 'chat', 'chart', 'pen', 'deal', 'code']
const MEMORY_SCOPES = ['仅本人', '所属分组', '全公司']
const MEMORY_KINDS = ['偏好', '事实', '流程', '联系人']
const MEMORY_TTLS = ['30 天', '90 天', '180 天', '永久保留']
const DEFAULT_BOT_GUARDS = [
  { id: 'high-risk', title: '高风险操作需确认', desc: '对外发送、改写数据或付款前先征求同意', on: true },
  { id: 'pii', title: '拦截个人敏感信息', desc: '手机号、证件号、银行卡等不写入记忆、不外发', on: true },
  { id: 'no-external', title: '禁止访问未授权的外部系统', desc: '只允许调用已勾选的 MCP 与连接器', on: true },
]


const GEAR = [
  'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
]

const OWNER_NAV = [
  { href: '/', label: '概览', icon: 'overview' },
  { href: '/companies', label: '公司', icon: 'company' },
  { href: '/releases', label: 'Bot 运行时', icon: 'bots' },
  { href: '/users', label: '用户', icon: 'accounts' },
  { href: '/providers', label: '供应商', icon: 'providers' },
  { href: '/models', label: '模型配置', icon: 'models' },
  { href: '/plans', label: '套餐', icon: 'plans' },
  { href: '/stats', label: '统计', icon: 'stats' },
]

const ADMIN_NAV = [
  { href: '/chat', label: '对话', icon: 'chat' },
  { href: '/', label: '概览', icon: 'overview' },
  { href: '/company', label: '公司/席位', icon: 'company' },
  { href: '/accounts', label: '员工', icon: 'accounts' },
  { href: '/audit', label: '审计', icon: 'audit' },
  { href: '/billing', label: '账单', icon: 'billing' },
  { href: '/usage', label: '用量统计', icon: 'usage' },
  { href: '/bots', label: 'Bot 配置', icon: 'bots' },
  { href: '/skills', label: 'Skill 与 MCP', icon: 'skills' },
]

const MEMBER_NAV = [{ href: '/', label: '对话', icon: 'chat' }]

const state = {
  me: null,
  path: '/',
  rail: false,
  busy: false,
  loginError: '',
  loginEmail: '',
  loginPassword: '',
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
  tests: {},
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
  botModels: [],
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
  deployHint: '',
  releases: [],
  latestRelease: null,
  updatingRuntime: false,
  updateVersion: '',
  chatBotId: '',
  chatSessionId: '',
  chatEvents: [],
  chatDraft: '',
  chatStatus: '',
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

function capTags(m) {
  const input = Array.isArray(m.input) ? m.input : []
  const vision = input.includes('image')
  const tags = []
  if (m.reasoning) tags.push('<span class="tag tag-neutral">推理</span>')
  if (vision) tags.push('<span class="tag tag-neutral">识图</span>')
  if (!tags.length) tags.push('<span class="tag tag-neutral">对话</span>')
  return tags.join('')
}

function tokens(n) {
  if (!n) return '—'
  return n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`
}

function orgId() {
  return state.me?.company?.id
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
  return new Set([...navForRole().map((n) => n.href), '/profile'])
}

function isChatPath(p) {
  return p === '/chat' || (typeof p === 'string' && p.startsWith('/a/'))
}

function chatBotIdOf(p) {
  if (!p || !p.startsWith('/a/')) return ''
  return decodeURIComponent(p.slice('/a/'.length).split('/')[0] || '')
}

function memberChatHome() {
  return !isOwner() && !isAdmin()
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

function agentIcon(key, size = 17) {
  return svg(AGENT_ICONS[key] || AGENT_ICONS.bot, size)
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

async function api(method, path, body) {
  const headers = { accept: 'application/json' }
  const t = token()
  if (t) headers.authorization = 'Bearer ' + t
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
  if (res.status === 401 && t && path !== '/auth/login' && !path.startsWith('/invites/')) {
    clearToken()
    state.me = null
    state.loginError = '登录已过期，请重新登录'
    render()
    throw new Error((json && json.error) || '需要登录')
  }
  if (!res.ok) throw new Error((json && json.error) || text || 'HTTP ' + res.status)
  return json
}

function flash(kind, msg) {
  state.error = kind === 'err' ? msg : ''
  state.notice = kind === 'ok' ? msg : ''
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
  if (!r?.provider || !r?.model) return '未设置'
  return `${r.provider} / ${r.model}`
}

function testMark(kind, id) {
  const t = state.tests[`${kind}:${id}`]
  if (!t) return ''
  if (t.status === 'busy') return '<span style="font-size: 12px; color: var(--muted-foreground);">测试中…</span>'
  if (t.status === 'ok') return `<span style="font-size: 12px; color: var(--color-accent-2-800);">${esc(t.text)}</span>`
  return `<span style="font-size: 12px; color: var(--color-accent-800);">${esc(t.text)}</span>`
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

async function loadSettings() {
  if (isOwner()) {
    state.settings = await api('GET', '/platform/settings')
    return
  }
  if (state.me?.settings) state.settings = state.me.settings
}

async function loadOrgs() {
  const data = await api('GET', '/platform/orgs')
  state.orgs = data.orgs || []
}

async function loadUsers() {
  const data = await api('GET', '/platform/accounts')
  state.users = data.accounts || []
}

async function loadUserDetail(id) {
  if (!id) {
    flash('err', '账号不存在')
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
    const msg = String(err.message || '')
    if (msg.includes('不存在') || /404/.test(msg)) {
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
  const data = await api('GET', '/platform/bot-releases')
  state.releases = data.releases || []
  state.latestRelease = data.latest || null
}

async function loadCompanyDetail(id) {
  if (!id) {
    flash('err', '公司不存在')
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
      api('GET', `/orgs/${encodeURIComponent(id)}/bots`).catch(() => ({ bots: [] })),
      loadReleases().catch(() => { state.releases = []; state.latestRelease = null }),
    ])
    state.org = org.company
    state.plan = org.plan
    state.accounts = accounts.members || accounts.accounts || []
    state.seats = accounts.seats || { total: 0, used: 0 }
    state.billing = billing
    state.machine = machineRes && machineRes.machine ? machineRes.machine : null
    if (botsRes && Array.isArray(botsRes.bots)) state.bots = botsRes.bots
  } catch (err) {
    flash('err', err.message)
    const msg = String(err.message || '')
    if (msg.includes('不存在') || /404/.test(msg)) {
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
  const id = orgId()
  if (!id) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/bots`)
  state.bots = data.bots || []
  state.bot = null
  state.botDraft = null
}

async function loadSkills() {
  const id = orgId()
  if (!id) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/skills`)
  state.skills = data.skills || []
  state.mcpServers = data.servers || []
  state.skillTags = data.tags || []
}

function draftFromBot(bot) {
  return {
    name: bot.name || '',
    description: bot.description || '',
    prompt: bot.prompt || '',
    icon: bot.icon || 'bot',
    provider: bot.provider || 'deepseek',
    model: bot.model || '',
    enabled: bot.enabled !== false,
    greeting: '',
    skills: Array.isArray(bot.skills) ? bot.skills.slice() : [],
    mcps: Array.isArray(bot.mcps) ? bot.mcps.slice() : [],
    groups: [],
    kbs: [],
    guards: DEFAULT_BOT_GUARDS.map((g) => ({ ...g })),
    escalate: '连续 2 次无法解决，或用户明确要求人工',
    memories: [],
    memoryOn: true,
    scope: '所属分组',
    kinds: ['偏好', '事实'],
    ttl: '90 天',
    cap: 20,
    confirmOn: true,
    piiOn: true,
  }
}

async function loadBotDetail(botId) {
  const id = orgId()
  if (!id || !botId) return
  const [one, opts, models] = await Promise.all([
    api('GET', `/orgs/${encodeURIComponent(id)}/bots/${encodeURIComponent(botId)}`),
    api('GET', `/orgs/${encodeURIComponent(id)}/bots/options`),
    api('GET', '/v1/models').catch(() => ({ data: [] })),
  ])
  state.bot = one.bot
  state.botDraft = draftFromBot(one.bot)
  state.botOptions = {
    skills: opts.skills || [],
    mcps: opts.mcps || [],
    groups: opts.groups || [],
    kbs: opts.kbs || [],
  }
  state.botModels = groupCatalog(models.data || [])
}

async function loadAudit() {
  const id = orgId()
  if (!id) return
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/audit`)
  state.events = data.events || []
}

async function loadSessions() {
  const id = orgId()
  if (!id) return
  const q = new URLSearchParams()
  if (state.sessionAccountId) q.set('accountId', state.sessionAccountId)
  const from = dayStart(state.sessionFrom)
  const to = dayEnd(state.sessionTo)
  if (from !== '') q.set('from', String(from))
  if (to !== '') q.set('to', String(to))
  const qs = q.toString()
  const data = await api('GET', `/orgs/${encodeURIComponent(id)}/sessions${qs ? '?' + qs : ''}`)
  state.sessions = data.sessions || []
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
      } else if (isAdmin()) {
        await Promise.all([loadMe(), loadOrg().catch(() => {}), loadSettings().catch(() => {})])
      } else {
        await loadMe()
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
    } else if (state.path === '/providers') {
      await Promise.all([loadCatalog(), loadCreds()])
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
    } else if (state.path === '/releases') {
      await loadReleases()
    } else if (state.path === '/companies' || state.path === '/plans') {
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
      await loadBots()
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

function mark(text, alt) {
  const style = alt
    ? 'background: var(--color-accent-2-100); color: var(--color-accent-2-800);'
    : 'background: var(--color-accent-100); color: var(--color-accent-800);'
  return `<span class="satu-providermark" style="${style}">${esc(String(text || '?').slice(0, 2).toUpperCase())}</span>`
}

function loginView() {
  return `
  <div class="gw-login">
    <div class="satu-authside">
      <div style="position: absolute; top: -60px; right: -60px; width: 220px; height: 220px; border-radius: 50%; background: var(--color-accent-2-200); opacity: 0.6;"></div>
      <div style="position: relative; display: flex; align-items: center; gap: var(--space-2);">
        <img src="/assets/satuwork-logo.png" alt="Satuwork" style="width: 34px; height: 34px; border-radius: 999px;">
        <span style="font-family: var(--font-heading); font-size: 20px;">Satuwork</span>
      </div>
      <div style="position: relative; display: flex; flex-direction: column; gap: var(--space-4); max-width: 440px;">
        <div style="width: 100%; aspect-ratio: 4/3; border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow-lg);">
          <img src="/assets/login-hero.png" alt="" style="width: 100%; height: 100%; object-fit: cover;">
        </div>
        <p style="font-family: var(--font-heading); font-size: 26px; line-height: 1.2; margin: 0;">Satuwork 控制面。按账号角色进入系统控制台或公司后台。</p>
        <p style="margin: 0; color: color-mix(in srgb, var(--color-text) 65%, transparent); font-size: 14px; line-height: 1.6;">日常任务模型和 utility 模型由系统管理员配置。供应商密钥保存后不会回显，也不会下发到 Bot。</p>
      </div>
      <div style="position: relative; display: flex; gap: var(--space-4); font-size: 12px; color: color-mix(in srgb, var(--color-text) 55%, transparent);">
        <span>© 2026 Satuwork</span>
      </div>
    </div>
    <div style="position: relative; display: flex; align-items: center; justify-content: center; padding: var(--space-8);">
      <div style="width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: var(--space-6);">
        <div>
          <h1 style="font-size: 30px; margin: 0 0 var(--space-2);">登录 Satuwork</h1>
          <p style="margin: 0; color: color-mix(in srgb, var(--color-text) 60%, transparent); font-size: 14px;">进入控制台，管理你的 AI 员工</p>
        </div>
        ${state.loginError ? `<div class="gw-flash gw-flash-err">${esc(state.loginError)}</div>` : ''}
        <form id="login-form" style="display: flex; flex-direction: column; gap: var(--space-4);">
          <div class="field">
            <label for="login-email">邮箱</label>
            <input class="input satu-input" id="login-email" name="email" type="email" autocomplete="username" placeholder="you@company.com" value="${esc(state.loginEmail)}" required>
          </div>
          <div class="field">
            <div style="display: flex; justify-content: space-between; align-items: baseline;">
              <label for="login-pw" style="margin: 0;">口令</label>
              <span style="font-size: 12px; color: var(--muted-foreground);">忘记口令？联系管理员</span>
            </div>
            <input class="input satu-input" id="login-pw" name="password" type="password" autocomplete="current-password" placeholder="输入口令" required>
          </div>
          <button type="submit" class="btn btn-primary btn-block" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? '登录中…' : '登录'}
            ${state.busy ? '' : svg(['M5 12h14', 'm12 5 7 7-7 7'], 14)}
          </button>
        </form>
        <p style="text-align: center; margin: 0; font-size: 14px; color: color-mix(in srgb, var(--color-text) 60%, transparent);">还没有账号？联系管理员开通。</p>
      </div>
    </div>
  </div>`
}

function navItem(item) {
  const current =
    state.path === item.href ||
    (item.href !== '/' && state.path.startsWith(item.href + '/')) ||
    (item.href === '/chat' && state.path.startsWith('/a/')) ||
    (item.href === '/' && memberChatHome() && state.path.startsWith('/a/'))
  return `<button type="button" class="satu-nav" data-act="go" data-href="${esc(item.href)}" aria-current="${current}">
    ${svg(ICONS[item.icon])}
    <span class="satu-label">${esc(item.label)}</span>
  </button>`
}

function flashes() {
  return `${state.error ? `<div class="gw-flash gw-flash-err">${esc(state.error)}</div>` : ''}
    ${state.notice ? `<div class="gw-flash gw-flash-ok">${esc(state.notice)}</div>` : ''}`
}

function placeholderPage(title, body) {
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${esc(title)}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(body)}</p>
        </div>
        ${flashes()}
      </div>
    </div>`
}

function overviewPage() {
  if (isOwner()) return ownerOverviewPage()
  if (isAdmin()) return adminOverviewPage()
  return chatPage()
}

function ownerOverviewPage() {
  const orgs = state.orgs || []
  const users = state.users || []
  const configured = [...configuredSet()]
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">概览</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">平台公司、用户、已配置供应商，以及日常 / utility 模型。</p>
        </div>
        ${flashes()}
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--space-3);">
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">公司</span>
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(orgs.length)}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">用户</span>
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(users.length)}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">日常任务模型</span>
            <span style="font-family: var(--font-heading); font-size: 18px; line-height: 1.2;">${esc(roleLabel('daily'))}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">Utility 模型</span>
            <span style="font-family: var(--font-heading); font-size: 18px; line-height: 1.2;">${esc(roleLabel('utility'))}</span>
          </div>
        </div>
        <div class="satu-panel">
          <span class="satu-panel-title">已配置供应商</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">只显示名称。密钥不会出现在这里。</p>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
            ${
              configured.length
                ? configured.map((p) => `<span class="tag tag-accent">${esc(p)}</span>`).join('')
                : '<span style="font-size: 13px; color: var(--muted-foreground);">还没有配置供应商。到「供应商」页添加密钥。</span>'
            }
          </div>
        </div>
      </div>
    </div>`
}

function adminOverviewPage() {
  const company = state.me?.company || state.org || {}
  const plan = state.me?.plan || state.plan || { seats: 0, used: 0 }
  const pct = plan.seats ? Math.min(100, Math.round((plan.used / plan.seats) * 100)) : 0
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">概览</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">公司、席位，以及平台日常 / utility 模型（只读）。</p>
        </div>
        ${flashes()}
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--space-3);">
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">公司</span>
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(company.name || '—')}</span>
            <span style="font-size: 11.5px; color: var(--muted-foreground);">${esc(company.slug || '')}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">席位</span>
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(plan.used)} / ${esc(plan.seats)}</span>
            <div class="satu-meter" style="margin-top: 4px;"><div class="satu-meterfill" style="width: ${pct}%;"></div></div>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">日常任务模型</span>
            <span style="font-family: var(--font-heading); font-size: 18px; line-height: 1.2;">${esc(roleLabel('daily'))}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">Utility 模型</span>
            <span style="font-family: var(--font-heading); font-size: 18px; line-height: 1.2;">${esc(roleLabel('utility'))}</span>
          </div>
        </div>
      </div>
    </div>`
}

function configuredProviders() {
  const configured = configuredSet()
  const list = state.catalog.filter((p) => configured.has(p.provider)).map((p) => ({
    provider: p.provider,
    name: p.name || p.provider,
    models: p.models || [],
  }))
  const seen = new Set(list.map((p) => p.provider))
  for (const provider of configured) {
    if (!seen.has(provider)) list.push({ provider, name: provider, models: [] })
  }
  return list
}

function providerOptions(selected) {
  const list = configuredProviders()
  if (selected && !list.some((p) => p.provider === selected)) list.unshift({ provider: selected, name: selected, models: [] })
  return list.map((p) => `<option value="${esc(p.provider)}" ${p.provider === selected ? 'selected' : ''}>${esc(p.name || p.provider)}</option>`).join('')
}

function modelOptions(provider, selected) {
  const shown = state.catalog.find((p) => p.provider === provider)
  const models = shown?.models?.length ? shown.models : selected ? [{ id: selected }] : []
  if (selected && !models.some((m) => m.id === selected)) models.unshift({ id: selected })
  return models.map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.id)}</option>`).join('')
}

function rolePanel(role, title, hint) {
  const cur = state.settings?.[role] || { provider: '', model: '' }
  return `
    <div class="satu-panel">
      <span class="satu-panel-title">${esc(title)}</span>
      <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(hint)}</p>
      <div class="satu-toggleRow">
        <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">供应商</div></div>
        <select class="input" style="width: 250px; flex: none;" data-act="role-provider" data-role="${esc(role)}">
          <option value="">选择供应商</option>
          ${providerOptions(cur.provider)}
        </select>
      </div>
      <div class="satu-toggleRow">
        <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">模型</div></div>
        <select class="input" style="width: 250px; flex: none;" data-act="role-model" data-role="${esc(role)}">
          <option value="">选择模型</option>
          ${modelOptions(cur.provider, cur.model)}
        </select>
      </div>
      <div class="satu-toggleRow">
        <div style="min-width: 0;">${testMark('role', role)}</div>
        <button type="button" class="btn btn-ghost" style="flex: none;" data-act="test-role" data-role="${esc(role)}" ${!cur.provider || !cur.model || state.tests['role:' + role]?.status === 'busy' ? 'disabled' : ''}>测试连通性</button>
      </div>
    </div>`
}

function modelsPage() {
  const shown = state.catalog.find((p) => p.provider === state.selectedProvider)
  const selected = shown?.provider || state.selectedProvider || ''
  const daily = state.settings?.daily || {}
  const utility = state.settings?.utility || {}

  const modelRows = (shown?.models || [])
    .map((m) => {
      const isDaily = daily.provider === shown.provider && daily.model === m.id
      const isUtil = utility.provider === shown.provider && utility.model === m.id
      const cost = m.cost && typeof m.cost === 'object' ? m.cost : {}
      const actions = `
        <div class="satu-rowactions">
          ${isDaily ? '<span class="tag tag-accent">日常</span>' : `<button type="button" class="satu-linkbtn" data-act="set-role" data-role="daily" data-provider="${esc(shown.provider)}" data-model="${esc(m.id)}">设为日常</button>`}
          ${isUtil ? '<span class="tag tag-accent-2">utility</span>' : `<button type="button" class="satu-linkbtn" data-act="set-role" data-role="utility" data-provider="${esc(shown.provider)}" data-model="${esc(m.id)}">设为 utility</button>`}
        </div>`
      return `<div class="satu-modelrow">
        <div class="satu-tasklink" style="cursor: default;">
          <span style="font-weight: 600; font-size: 14px;">${esc(m.name)}</span>
          <span style="font-size: 12px; color: var(--muted-foreground);">${esc(m.id)}</span>
        </div>
        <span style="font-size: 13px;">${esc(shown.name || shown.provider)}</span>
        <div class="gw-caps">${capTags(m)}</div>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(tokens(m.contextWindow))}${m.maxTokens ? ` · 出 ${esc(tokens(m.maxTokens))}` : ''}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(money(cost.input))} / ${esc(money(cost.output))}</span>
        ${actions}
      </div>`
    })
    .join('')

  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">模型配置</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">目录来自 pi-ai；密钥在供应商页配置。密钥留在 Gateway，不会出现在本机磁盘或环境。</p>
        </div>
        ${flashes()}
        <div class="gw-roles">
          ${rolePanel('daily', '日常任务模型', '用于日常工作。')}
          ${rolePanel('utility', 'Utility 模型', '用于轻量、快速的任务。')}
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
            <div style="display: flex; align-items: baseline; gap: var(--space-3);">
              <h2 style="font-size: 18px; margin: 0;">${esc(shown?.name || shown?.provider || '模型')} 的模型</h2>
              <span style="font-size: 12px; color: var(--muted-foreground);">共 ${shown?.models.length ?? 0} 个</span>
            </div>
            <select class="input" style="width: 220px; flex: none;" data-act="select-provider">
              <option value="">选择供应商</option>
              ${providerOptions(selected)}
            </select>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-modelhead">
              <span>模型</span><span>供应商</span><span>能力</span><span>上下文 / 输出</span><span>单价 / 1M tok</span><span></span>
            </div>
            ${modelRows || '<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">选择已配置的供应商查看模型。</div>'}
          </div>
        </div>
      </div>
    </div>`
}

function addProviderModal() {
  if (!state.addOpen) return ''
  const configured = configuredSet()
  const available = state.catalog.filter((p) => !configured.has(p.provider))
  const options = available.length
    ? available.map((p) => `<option value="${esc(p.provider)}">${esc(p.name || p.provider)}</option>`).join('')
    : '<option value="">没有可添加的供应商</option>'
  return `
    <div class="gw-modal-backdrop" data-act="add-close">
      <div class="gw-modal" data-act="add-dialog" role="dialog" aria-modal="true" aria-labelledby="add-prov-title">
        <div>
          <h2 id="add-prov-title" style="font-size: 20px; margin: 0 0 4px;">添加供应商</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">从目录选择尚未配置的供应商，粘贴 API 密钥。密钥只存在 Gateway，保存后不会回显。</p>
        </div>
        <form data-form="add-cred" style="display: flex; flex-direction: column; gap: var(--space-4);">
          <div class="field">
            <label for="add-provider">供应商</label>
            <select class="input" id="add-provider" name="provider" required ${available.length ? '' : 'disabled'}>
              ${options}
            </select>
          </div>
          <div class="field">
            <label for="add-secret">API 密钥</label>
            <input class="input" id="add-secret" name="secret" type="password" autocomplete="off" placeholder="API 密钥" required>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
            <button type="button" class="btn btn-ghost" data-act="add-close">取消</button>
            <button type="submit" class="btn btn-primary" ${state.busy || !available.length ? 'disabled' : ''}>保存</button>
          </div>
        </form>
      </div>
    </div>`
}

function providersPage() {
  const credBy = new Map((state.creds || []).map((c) => [c.provider, c]))
  const list = configuredProviders()
    .slice()
    .sort((a, b) => String(a.name || a.provider).localeCompare(String(b.name || b.provider), 'zh'))
    .map((p) => ({ ...p, cred: credBy.get(p.provider) }))

  const rows = list
    .map((p, i) => {
      return `<div class="satu-provrow">
        <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
          ${mark(p.name || p.provider, i % 2 === 1)}
          <div style="min-width: 0;">
            <div style="font-size: 14px; font-weight: 600;">${esc(p.name || p.provider)}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${esc(p.provider)}</div>
          </div>
        </div>
        <span style="font-size: 13px; color: var(--muted-foreground);">${p.models.length} 个</span>
        <span class="tag tag-accent">已配置</span>
        <form class="gw-secret" data-form="cred" data-provider="${esc(p.provider)}" data-id="${esc(p.cred?.id || '')}">
          <input class="input" name="secret" type="password" autocomplete="off" placeholder="输入新密钥以更新" required>
        </form>
        <div class="gw-provactions">
          ${testMark('provider', p.provider)}
          <button type="button" class="btn btn-ghost" data-act="test-provider" data-provider="${esc(p.provider)}" ${state.tests['provider:' + p.provider]?.status === 'busy' ? 'disabled' : ''}>测试</button>
          <button type="button" class="btn btn-primary" data-act="save-cred" data-provider="${esc(p.provider)}" data-id="${esc(p.cred?.id || '')}">更新</button>
        </div>
      </div>`
    })
    .join('')

  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">供应商</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">只列出已经配置的供应商。密钥只存在 Gateway，保存后不会回显。</p>
          </div>
          <button type="button" class="btn btn-primary" data-act="add-open" style="flex: none;">添加供应商</button>
        </div>
        ${flashes()}
        <div class="gw-credlist" style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-provhead">
            <span>供应商</span><span>模型</span><span>状态</span><span>密钥</span><span></span>
          </div>
          ${rows || '<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">还没有配置供应商。点击「添加供应商」从目录里选一家并粘贴密钥。</div>'}
        </div>
      </div>
      ${addProviderModal()}
    </div>`
}

function companyPage() {
  const c = state.org || state.me?.company || {}
  const plan = state.plan || state.me?.plan || { seats: 1, used: 0 }
  return `
    <div class="gw-page">
      <div class="gw-page-inner narrow">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">公司</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">名称、slug 和访问地址。席位由系统管理员分配。</p>
        </div>
        ${flashes()}
        <form id="company-form" class="satu-panel" style="gap: var(--space-4);">
          <span class="satu-panel-title">资料</span>
          <div class="field">
            <label for="co-name">名称</label>
            <input class="input" id="co-name" name="name" value="${esc(c.name || '')}" required>
          </div>
          <div class="field">
            <label for="co-slug">slug</label>
            <input class="input" id="co-slug" name="slug" value="${esc(c.slug || '')}" required>
          </div>
          <div class="field">
            <label for="co-url">访问地址</label>
            <input class="input" id="co-url" name="accessUrl" value="${esc(c.accessUrl || '')}" placeholder="https://acme.satuwork.com">
          </div>
          <div class="field">
            <label>席位</label>
            <p style="margin: 0; font-size: 14px;">已用 ${esc(plan.used || 0)} / ${esc(plan.seats || 0)}</p>
            <span style="font-size: 12px; color: var(--muted-foreground);">席位由系统管理员分配</span>
          </div>
          <div style="display: flex; justify-content: flex-end;">
            <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>保存</button>
          </div>
        </form>
      </div>
    </div>`
}

function memberMeId() {
  return state.memberMe?.id || state.me?.account?.id || ''
}

function roleLabelOf(role) {
  if (role === 'admin') return '管理员'
  if (role === 'owner') return '系统管理员'
  return '成员'
}

const GROUP_ICONS = [
  { key: 'chat', name: '对话', paths: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'] },
  { key: 'chart', name: '数据', paths: ['M3 3v16a2 2 0 0 0 2 2h16', 'M8 17v-4', 'M13 17v-9', 'M18 17v-6'] },
  {
    key: 'users',
    name: '团队',
    paths: [
      'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
      'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
      'M22 21v-2a4 4 0 0 0-3-3.87',
      'M16 3.13a4 4 0 0 1 0 7.75',
    ],
  },
  { key: 'guest', name: '外部', paths: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3a13 13 0 0 1 0 18 13 13 0 0 1 0-18z'] },
  { key: 'code', name: '研发', paths: ['m8 8-4 4 4 4', 'm16 8 4 4-4 4', 'm13 6-2 12'] },
  { key: 'deal', name: '销售', paths: ['M3 3h8l10 10-8 8L3 11z', 'M7 7h.01'] },
  { key: 'shield', name: '权限', paths: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'] },
  { key: 'star', name: '重点', paths: ['m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z'] },
]

function groupIcon(key, size = 16) {
  const g = GROUP_ICONS.find((x) => x.key === key) || GROUP_ICONS[0]
  return svg(g.paths, size)
}

function emptyGroupForm() {
  return { name: '', desc: '', icon: 'chat', role: 'member', members: [] }
}

function syncGroupForm() {
  const name = document.getElementById('gp-name')
  const desc = document.getElementById('gp-desc')
  if (name instanceof HTMLInputElement) state.groupForm.name = name.value
  if (desc instanceof HTMLInputElement) state.groupForm.desc = desc.value
}

function groupById(id) {
  return (state.groups || []).find((g) => g.id === id)
}

const MEMBER_STATUS = {
  active: { label: '已激活', tag: 'tag-accent-2', hint: '可正常登录并使用已授权的 AI 员工。' },
  invited: { label: '待接受', tag: 'tag-accent', hint: '等 TA 用邀请链接设完口令，会自动转为已激活。' },
  disabled: { label: '已停用', tag: 'tag-neutral', hint: '立即断开其全部登录，且无法再登录。历史记录保留。' },
}

function ago(ts) {
  if (!ts) return '从未登录'
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  if (m < 60 * 24) return `${Math.floor(m / 60)} 小时前`
  return `${Math.floor(m / 1440)} 天前`
}

function canBeStatus(member, key) {
  return key === 'invited' ? member.status === 'invited' : member.status !== 'invited' || key === 'disabled'
}

function whyNotStatus(key) {
  return key === 'invited'
    ? '已激活的账号退不回待接受。要让 TA 重设口令，用下面的重置链接。'
    : '等 TA 用邀请链接设完口令，会自动转为已激活。'
}

function iconCopy() {
  return svg(
    [
      'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z',
      'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
    ],
    15,
  )
}

function statCard(label, value) {
  return `<div class="satu-stat">
    <span style="font-size: 12px; color: var(--muted-foreground);">${esc(label)}</span>
    <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(value)}</span>
  </div>`
}

function confirmModal() {
  const c = state.confirm
  if (!c) return ''
  return `<div class="gw-modal-backdrop" data-act="confirm-cancel">
    <div class="gw-modal" data-stop>
      <div>
        <h2 style="font-size: 20px; margin: 0 0 4px;">${esc(c.title)}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(c.body)}</p>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="confirm-cancel">取消</button>
        <button type="button" class="btn btn-primary" data-act="confirm-ok">${esc(c.label)}</button>
      </div>
    </div>
  </div>`
}

function secretModal() {
  const s = state.secret
  if (!s) return ''
  const days = Math.max(0, Math.round((s.expiresAt - Date.now()) / 86400000))
  const hours = Math.max(0, Math.round((s.expiresAt - Date.now()) / 3600000))
  const ttl = days >= 1 ? `${days} 天后过期` : `${hours || 1} 小时内有效`
  return `<div class="gw-modal-backdrop" data-act="secret-close">
    <div class="gw-modal" data-stop>
      <div>
        <h2 style="font-size: 20px; margin: 0 0 4px;">${esc(s.title)}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
          把这条链接发给 <b>${esc(s.email)}</b>，他打开后自行设置口令。链接只显示这一次，${esc(ttl)}，用过即失效。
        </p>
      </div>
      <div style="display: flex; align-items: center; gap: var(--space-2);">
        <code class="satu-code" style="flex: 1; min-width: 0; padding: 10px var(--space-3); font-size: 12.5px; overflow-x: auto; white-space: nowrap;">${esc(s.url)}</code>
        <button type="button" class="btn btn-secondary" style="flex: none;" data-act="secret-copy">${iconCopy()} ${state.inviteCopied && state.secret ? '已复制' : '复制'}</button>
      </div>
      <div style="display: flex; justify-content: flex-end;">
        <button type="button" class="btn btn-primary" data-act="secret-close">我记下了</button>
      </div>
    </div>
  </div>`
}

function inviteModal() {
  if (!state.inviteOpen) return ''
  const f = state.inviteForm
  const link = state.inviteLink
  const btn = state.busy
    ? '生成中…'
    : link
      ? state.inviteCopied
        ? '已复制'
        : '再复制一次'
      : '生成并复制链接'
  return `<div class="gw-modal-backdrop" data-act="invite-close">
    <form id="invite-form" class="gw-modal" style="max-width: 500px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">邀请成员</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">生成一条一次性邀请链接，发给要加入的同事。</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="关闭" data-act="invite-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
        <div class="field">
          <label for="iv-name">姓名</label>
          <input class="input" id="iv-name" name="name" type="text" value="${esc(f.name)}" placeholder="受邀人姓名" ${link ? 'disabled' : ''}>
        </div>
        <div class="field">
          <label for="iv-email">邮箱</label>
          <input class="input" id="iv-email" name="email" type="email" required value="${esc(f.email)}" placeholder="name@acme.com" ${link ? 'disabled' : ''}>
        </div>
      </div>
      <span style="font-size: 12px; color: var(--muted-foreground); margin-top: calc(var(--space-3) * -1);">链接只对该邮箱有效，对方打开后仅需设置口令即可加入。</span>
      <div class="field">
        <label for="iv-link">一次性邀请链接</label>
        <input class="input" id="iv-link" type="text" readonly value="${esc(link)}" placeholder="点下方按钮生成" style="min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;">
        <span style="font-size: 12px; color: var(--muted-foreground);">仅可使用 1 次，生成后按下方有效期失效。链接只显示这一次。</span>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
        <div class="field">
          <label for="iv-role">角色</label>
          <select class="input" id="iv-role" name="role" ${link ? 'disabled' : ''}>
            <option value="member" ${f.role === 'member' ? 'selected' : ''}>成员</option>
            <option value="admin" ${f.role === 'admin' ? 'selected' : ''}>管理员</option>
          </select>
        </div>
        <div class="field">
          <label for="iv-ttl">链接有效期</label>
          <select class="input" id="iv-ttl" name="ttlDays" ${link ? 'disabled' : ''}>
            <option value="1" ${String(f.ttlDays) === '1' ? 'selected' : ''}>1 天</option>
            <option value="7" ${String(f.ttlDays) === '7' ? 'selected' : ''}>7 天</option>
            <option value="30" ${String(f.ttlDays) === '30' ? 'selected' : ''}>30 天</option>
          </select>
        </div>
      </div>
      ${state.inviteError ? `<div class="gw-flash gw-flash-err">${esc(state.inviteError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="invite-close">${link ? '完成' : '取消'}</button>
        <button type="submit" class="btn btn-primary" style="min-width: 104px;" ${state.busy ? 'disabled' : ''}>${btn}</button>
      </div>
    </form>
  </div>`
}

function groupModal() {
  if (!state.groupDialog) return ''
  const f = state.groupForm
  const editing = !!(state.groupDialog && state.groupDialog.id)
  const icons = GROUP_ICONS.map((g) => {
    const on = f.icon === g.key
    return `<button type="button" class="satu-iconpick" aria-pressed="${String(on)}" aria-label="${esc(g.name)}" title="${esc(g.name)}" data-act="group-icon" data-icon="${esc(g.key)}">${svg(g.paths)}</button>`
  }).join('')
  const roles = ['admin', 'member']
    .map(
      (key) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(f.role === key)}" data-act="group-role" data-role="${key}">${roleLabelOf(key)}</button>`,
    )
    .join('')
  const picked = new Set(f.members || [])
  const people = (state.accounts || [])
    .map((m) => {
      const on = picked.has(m.id)
      const label = m.name ? `${m.name} · ${m.email}` : m.email
      return `<button type="button" class="satu-fileitem" aria-current="${String(on)}" data-act="group-toggle-member" data-id="${esc(m.id)}">
        <span class="satu-avatar" style="width: 24px; height: 24px; font-size: 11px; background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc((m.name || m.email).slice(0, 1).toUpperCase())}</span>
        <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(label)}</span>
        ${on ? `<span style="margin-left: auto; display: flex;">${svg(['m5 13 4 4L19 7'], 14)}</span>` : ''}
      </button>`
    })
    .join('')
  return `<div class="gw-modal-backdrop" data-act="group-close">
    <form id="group-form" class="gw-modal" style="max-width: 460px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${editing ? '管理分组' : '新建分组'}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">分组用于批量授权与统计，成员可同时属于多个分组。</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="关闭" data-act="group-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div class="field">
        <label for="gp-name">分组名称</label>
        <input class="input" id="gp-name" name="name" type="text" required value="${esc(f.name)}" placeholder="例如：客服组">
      </div>
      <div class="field">
        <label for="gp-desc">说明（可选）</label>
        <input class="input" id="gp-desc" name="desc" type="text" value="${esc(f.desc)}" placeholder="这个分组负责什么">
      </div>
      <div class="field">
        <label>分组图标</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${icons}</div>
      </div>
      <div class="field">
        <label>默认角色</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${roles}</div>
        <span style="font-size: 12px; color: var(--muted-foreground);">只影响之后被加进这个组的人，不改动已有成员的角色。</span>
      </div>
      <div class="field">
        <label>成员</label>
        <div style="display: flex; flex-direction: column; gap: 1px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-2); max-height: 220px; overflow-y: auto;">
          ${people || '<span style="font-size: 12px; color: var(--muted-foreground); padding: 6px var(--space-2);">还没有成员</span>'}
        </div>
        <span style="font-size: 12px; color: var(--muted-foreground);">已选 ${picked.size} 人</span>
      </div>
      ${state.groupError ? `<div class="gw-flash gw-flash-err">${esc(state.groupError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="group-close">取消</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? '保存中…' : editing ? '保存' : '创建分组'}</button>
      </div>
    </form>
  </div>`
}

function editModal() {
  const member = state.editing
  if (!member) return ''
  const isSelf = member.id === memberMeId()
  const f = state.editForm
  const statusBtns = ['active', 'disabled', 'invited']
    .map((key) => {
      const ok = canBeStatus(member, key)
      const disabled = isSelf || !ok
      return `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(f.status === key)}" ${disabled ? 'disabled' : ''} title="${ok ? '' : esc(whyNotStatus(key))}" data-act="edit-status" data-status="${key}">${MEMBER_STATUS[key].label}</button>`
    })
    .join('')
  const roleBtns = ['admin', 'member']
    .map(
      (key) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(f.role === key)}" ${isSelf ? 'disabled' : ''} data-act="edit-role" data-role="${key}">${roleLabelOf(key)}</button>`,
    )
    .join('')
  const hint = MEMBER_STATUS[f.status]?.hint || ''
  return `<div class="gw-modal-backdrop" data-act="edit-close">
    <form id="edit-member-form" class="gw-modal" style="max-width: 460px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">编辑成员</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">修改角色与状态，或给 TA 发一条口令重置链接。</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="关闭" data-act="edit-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div style="display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
        <span class="satu-avatar" style="background: var(--color-accent-2-200); color: var(--color-accent-2-800);">${esc((member.name || member.email).slice(0, 1).toUpperCase())}</span>
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(member.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(member.email)}</div>
        </div>
      </div>
      <div class="field">
        <label for="em-name">姓名</label>
        <input class="input" id="em-name" name="name" type="text" required value="${esc(f.name)}">
      </div>
      <div class="field">
        <label>角色</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${roleBtns}</div>
      </div>
      <div class="field">
        <label>状态</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${statusBtns}</div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint)}</span>
      </div>
      ${isSelf ? '<span style="font-size: 12px; color: var(--muted-foreground);">不能改自己的角色与状态——手滑一次就把自己关在门外。</span>' : ''}
      <div style="display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3);">
          <div style="min-width: 0;">
            <div style="font-size: 13.5px; font-weight: 600;">口令重置链接</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">生成后自行发给成员，1 小时内有效且仅能使用一次</div>
          </div>
          <button type="button" class="btn btn-secondary" style="flex: none;" data-act="edit-reset">${state.editLink ? '重新生成' : '生成链接'}</button>
        </div>
        ${
          state.editLink
            ? `<div style="display: flex; align-items: center; gap: var(--space-2);">
            <code class="satu-code" style="flex: 1; min-width: 0; padding: 8px var(--space-3); font-size: 12px; overflow-x: auto; white-space: nowrap;">${esc(state.editLink)}</code>
            <button type="button" class="btn btn-secondary" style="flex: none;" data-act="edit-copy">${iconCopy()} ${state.editCopied ? '已复制' : '复制'}</button>
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">生成的同时，TA 当前的登录已全部失效。链接只显示这一次。Gateway 没有会话表，签发早于作废时间的 JWT 会被拒，未过期的票在此之前仍可能可用。</span>`
            : ''
        }
      </div>
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="edit-close">取消</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? '保存中…' : '保存'}</button>
      </div>
    </form>
  </div>`
}

function memberRow(m) {
  const meId = memberMeId()
  const isSelf = m.id === meId
  const st = MEMBER_STATUS[m.status] || MEMBER_STATUS.active
  const last =
    isSelf ? '正在使用' : m.status === 'invited' ? `邀请于 ${new Date(m.createdAt).toLocaleDateString('zh-CN')}` : ago(m.lastSeenAt)
  const canManage = isAdmin() || isOwner()
  const menu = state.menu === m.id
    ? `<div class="satu-menu" data-flip="${String(!!state.menuFlip)}">
        <button type="button" class="satu-menuitem" data-act="edit-open" data-id="${esc(m.id)}">编辑成员</button>
        <button type="button" class="satu-menuitem" data-act="member-reset" data-id="${esc(m.id)}">${m.status === 'invited' ? '重发邀请' : '重置口令'}</button>
        ${
          m.status !== 'active'
            ? `<button type="button" class="satu-menuitem" ${m.status === 'invited' ? 'disabled' : ''} title="${m.status === 'invited' ? '等 TA 用邀请链接设完口令，会自动转为已激活。' : ''}" data-act="member-enable" data-id="${esc(m.id)}">${MEMBER_STATUS.active.label}</button>`
            : ''
        }
        ${
          m.status !== 'disabled'
            ? `<button type="button" class="satu-menuitem" data-act="member-disable" data-id="${esc(m.id)}">${MEMBER_STATUS.disabled.label}</button>`
            : ''
        }
        <div style="height: 1px; background: var(--border); margin: 4px 0;"></div>
        <button type="button" class="satu-menuitem" data-danger="true" data-act="member-delete" data-id="${esc(m.id)}">删除</button>
      </div>`
    : ''
  return `<div class="satu-memberrow">
    <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
      <span class="satu-avatar" style="background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc((m.name || m.email).slice(0, 1).toUpperCase())}</span>
      <div style="min-width: 0;">
        <div style="font-size: 13.5px; font-weight: 600;">${esc(m.name || m.email)}${isSelf ? ' · 你' : ''}</div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.email)}</div>
      </div>
    </div>
    <span style="font-size: 13px;">${esc(roleLabelOf(m.role))}</span>
    <span class="tag ${st.tag}">${st.label}</span>
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(last)}</span>
    <div class="satu-rowactions" style="display: flex; justify-content: flex-end; position: relative;">
      ${isSelf ? '<span style="font-size: 12px; color: var(--muted-foreground);">你</span>' : ''}
      ${
        canManage
          ? `<button type="button" class="btn btn-ghost btn-icon" aria-label="编辑成员" data-act="edit-open" data-id="${esc(m.id)}">${svg(['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'], 15)}</button>`
          : ''
      }
      ${
        canManage && !isSelf
          ? `<button type="button" class="btn btn-ghost btn-icon" aria-label="更多操作" data-menu-toggle data-act="menu-toggle" data-id="${esc(m.id)}">${svg(['M12 6h.01', 'M12 12h.01', 'M12 18h.01'], 16)}</button>`
          : ''
      }
      ${menu}
    </div>
  </div>`
}

function groupRow(g) {
  const canManage = isAdmin() || isOwner()
  const markStyle = g.builtin
    ? 'background: var(--color-accent-100); color: var(--color-accent-800);'
    : 'background: var(--color-accent-2-100); color: var(--color-accent-2-800);'
  const actions = g.builtin
    ? '<span style="font-size: 12px; color: var(--muted-foreground);">自动包含全部成员</span>'
    : `<button type="button" class="satu-linkbtn" ${canManage ? '' : 'disabled'} data-act="group-edit" data-id="${esc(g.id)}">管理成员</button>
       <button type="button" class="btn btn-ghost btn-icon" aria-label="删除分组" ${canManage ? '' : 'disabled'} data-act="group-delete" data-id="${esc(g.id)}">${svg(['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14'], 15)}</button>`
  const role = g.builtin ? '按成员设置' : roleLabelOf(g.role)
  const created = g.createdAt ? new Date(g.createdAt).toISOString().slice(0, 10) : '—'
  const n = Array.isArray(g.members) ? g.members.length : 0
  return `<div class="satu-grouprow">
    <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
      <span class="satu-providermark" style="${markStyle}">${groupIcon(g.icon, 16)}</span>
      <div style="min-width: 0;">
        <div style="display: flex; align-items: center; gap: var(--space-2);">
          <span style="font-size: 14px; font-weight: 600;">${esc(g.name)}</span>
          ${g.builtin ? '<span class="tag tag-accent-2">固定分组</span>' : ''}
        </div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${esc(g.desc || '')}</div>
      </div>
    </div>
    <span style="font-size: 13px;">${n} 人</span>
    <span style="font-size: 13px;">${esc(role)}</span>
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(created)}</span>
    <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-3); justify-content: flex-end;">${actions}</div>
  </div>`
}

function accountsPage() {
  const members = state.accounts || []
  const groups = state.groups || []
  const seats = state.seats || { total: 0, used: 0 }
  const admins = members.filter((m) => m.role === 'admin').length
  const pending = members.filter((m) => m.status === 'invited').length
  const left = (seats.total || 0) - (seats.used || 0)
  const canManage = isAdmin() || isOwner()
  const tab = state.accountsTab === 'groups' ? 'groups' : 'members'
  const headerAct = tab === 'members' ? 'invite-open' : 'group-open'
  const headerLabel = tab === 'members' ? '邀请成员' : '新建分组'
  const tabs = [
    { key: 'members', label: '成员' },
    { key: 'groups', label: '分组' },
  ]
    .map(
      (item) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === item.key)}" data-act="accounts-tab" data-tab="${item.key}">${item.label}</button>`,
    )
    .join('')
  const membersBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-6);">
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-3);">
            ${statCard('成员', members.length)}
            ${statCard('管理员', admins)}
            ${statCard('待接受邀请', pending)}
            ${statCard('席位余量', left)}
          </div>
          <div style="display: flex; flex-direction: column; gap: var(--space-3);">
            <div style="display: flex; align-items: baseline; justify-content: space-between;">
              <h2 style="font-size: 18px; margin: 0;">成员</h2>
              <span style="font-size: 12px; color: var(--muted-foreground);">共 ${members.length} 人</span>
            </div>
            <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
              <div class="satu-memberhead">
                <span>成员</span><span>角色</span><span>状态</span><span>最近活跃</span><span></span>
              </div>
              ${members.map(memberRow).join('') || '<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">还没有成员</div>'}
            </div>
          </div>
        </div>`
  const groupsBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-grouphead">
              <span>分组</span><span>成员</span><span>默认角色</span><span>创建时间</span><span></span>
            </div>
            ${groups.map(groupRow).join('') || '<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">还没有分组</div>'}
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">「全体成员」为系统固定分组，新成员加入后自动进入，不可删除或移除成员。</span>
        </div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">账号管理</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">邀请同事加入，并管理成员角色与权限。</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" ${canManage ? '' : 'disabled'} title="${canManage ? '' : '需要管理员权限'}" data-act="${headerAct}">
            ${svg(['M12 5v14', 'M5 12h14'], 15)} ${headerLabel}
          </button>
        </div>
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">${tabs}</div>
        ${flashes()}
        ${tab === 'members' ? membersBody : groupsBody}
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">成员这一半是真的：停用会当场作废对方已签发的 JWT（签发早于作废时间的票会被拒），重置口令同样作废旧登录。角色与权限的判断在服务端，界面上的禁用只是提前告诉你结果。Gateway 没有会话表，未过期且签发于作废之后的 JWT 仍可用，直到过期；停用账号登录会被拒绝。</p>
      </div>
    </div>
    ${inviteModal()}
    ${editModal()}
    ${groupModal()}
    ${secretModal()}
    ${confirmModal()}`
}

function joinView() {
  const inv = state.joinInvite || { loading: true }
  const side = `
    <div class="satu-authside">
      <div style="position: absolute; top: -60px; right: -60px; width: 220px; height: 220px; border-radius: 50%; background: var(--color-accent-2-200); opacity: 0.6;"></div>
      <div style="position: relative; display: flex; align-items: center; gap: var(--space-2);">
        <img src="/assets/satuwork-logo.png" alt="Satuwork" style="width: 34px; height: 34px; border-radius: 999px;">
        <span style="font-family: var(--font-heading); font-size: 20px;">Satuwork</span>
      </div>
      <div style="position: relative; display: flex; flex-direction: column; gap: var(--space-4); max-width: 440px;">
        <div style="width: 100%; aspect-ratio: 4/3; border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow-lg);">
          <img src="/assets/login-hero.png" alt="" style="width: 100%; height: 100%; object-fit: cover;">
        </div>
        <p style="font-family: var(--font-heading); font-size: 26px; line-height: 1.2; margin: 0;">加入同事的工作区，设置你自己的口令。</p>
        <p style="margin: 0; color: color-mix(in srgb, var(--color-text) 65%, transparent); font-size: 14px; line-height: 1.6;">管理员从头到尾看不到你的口令。链接只用一次。</p>
      </div>
      <div style="position: relative; display: flex; gap: var(--space-4); font-size: 12px; color: color-mix(in srgb, var(--color-text) 55%, transparent);">
        <span>© 2026 Satuwork</span>
      </div>
    </div>`
  let inner
  if (inv.loading) {
    inner = `<p style="margin: 0; color: var(--muted-foreground);">载入邀请…</p>`
  } else if (!inv.valid) {
    inner = `
      <div style="display: flex; flex-direction: column; gap: var(--space-4); align-items: flex-start;">
        <span class="tag tag-accent">邀请已失效</span>
        <h1 style="font-size: 28px; margin: 0;">这条邀请链接不可用</h1>
        <p style="margin: 0; color: var(--muted-foreground); font-size: 14px; line-height: 1.6;">链接可能已过期、已被使用，或管理员重新生成了新的邀请。请联系邀请你的人重新发一条。</p>
        ${inv.error ? `<div class="gw-flash gw-flash-err">${esc(inv.error)}</div>` : ''}
        <button type="button" class="btn btn-secondary" data-act="join-login">返回登录</button>
      </div>`
  } else {
    const f = state.joinForm
    inner = `
      <div style="display: flex; flex-direction: column; gap: var(--space-6);">
        <div>
          <span class="tag tag-accent-2">邀请有效</span>
          <h1 style="font-size: 28px; margin: var(--space-3) 0 var(--space-2);">设置登录口令</h1>
          <p style="margin: 0; color: var(--muted-foreground); font-size: 14px;">你的账号信息已由管理员填好，设置口令即可加入。</p>
        </div>
        <form id="join-form" style="display: flex; flex-direction: column; gap: var(--space-4);">
          <div style="display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
            <span class="satu-avatar" style="background: var(--color-accent-200); color: var(--color-accent-800);">${esc((inv.name || inv.email).slice(0, 1).toUpperCase())}</span>
            <div style="min-width: 0;">
              <div style="font-size: 14px; font-weight: 600;">${esc(inv.name || '')}</div>
              <div style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(inv.email)}</div>
            </div>
          </div>
          <div class="field">
            <label for="jn-name">姓名</label>
            <input class="input satu-input" id="jn-name" name="name" type="text" value="${esc(f.name)}" placeholder="你的姓名" autocomplete="name">
          </div>
          <div class="field">
            <label for="jn-pw">设置口令</label>
            <input class="input satu-input" id="jn-pw" name="password" type="password" required minlength="10" placeholder="至少 10 位" autocomplete="new-password">
          </div>
          <div class="field">
            <label for="jn-pw2">确认口令</label>
            <input class="input satu-input" id="jn-pw2" name="confirm" type="password" required minlength="10" placeholder="再输一次" autocomplete="new-password">
          </div>
          ${state.joinError ? `<div class="gw-flash gw-flash-err">${esc(state.joinError)}</div>` : ''}
          <button type="submit" class="btn btn-primary btn-block" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? '加入中…' : '加入 Satuwork'}
            ${state.busy ? '' : svg(['M5 12h14', 'm12 5 7 7-7 7'], 14)}
          </button>
        </form>
        <p style="text-align: center; margin: 0; font-size: 14px; color: color-mix(in srgb, var(--color-text) 60%, transparent);">
          已经有账号？
          <button type="button" class="satu-linkbtn" data-act="join-login">直接登录</button>
        </p>
      </div>`
  }
  return `<div class="gw-login">${side}<div style="position: relative; display: flex; align-items: center; justify-content: center; padding: var(--space-8);"><div style="width: 100%; max-width: 400px;">${inner}</div></div></div>`
}


function messageText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
}

function auditTranscript(events) {
  const blocks = []
  for (const ev of events || []) {
    if (ev.type === 'user/message' || ev.type === 'assistant/message') {
      const text = messageText(ev.data && ev.data.message && ev.data.message.content)
      const role = ev.type === 'user/message' ? 'user' : 'ai'
      const label = role === 'user' ? '员工' : '助理'
      blocks.push(`<div class="satu-dbmsg" data-role="${role}" style="white-space: pre-wrap; overflow: visible;">
        <div style="font-size: 11.5px; font-weight: 600; margin-bottom: 4px; opacity: 0.7;">${label}</div>
        ${esc(text || '（空）')}
      </div>`)
      continue
    }
    if (ev.type === 'tool/call') {
      const name = (ev.data && ev.data.name) || '工具'
      blocks.push(`<div style="font-size: 12px; color: var(--muted-foreground);">${esc('工具 ' + name)}</div>`)
      continue
    }
    if (ev.type === 'tool/result') {
      const text = (ev.data && ev.data.text) || ''
      blocks.push(`<div style="font-size: 12px; color: var(--muted-foreground);">${esc('结果 ' + String(text).slice(0, 240))}</div>`)
    }
  }
  if (!blocks.length) {
    return '<div style="padding: var(--space-4); font-size: 13px; color: var(--muted-foreground);">没有消息</div>'
  }
  return `<div style="display: flex; flex-direction: column; gap: var(--space-3);">${blocks.join('')}</div>`
}

function auditTabs(tab) {
  const items = [
    { key: 'chats', label: '对话' },
    { key: 'events', label: '操作记录' },
  ]
  return items
    .map(
      (item) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === item.key)}" data-act="audit-tab" data-tab="${item.key}">${item.label}</button>`,
    )
    .join('')
}

function auditEventsTable() {
  const rows = (state.events || [])
    .map((e) => {
      const detail = e.detail && typeof e.detail === 'object' ? JSON.stringify(e.detail) : String(e.detail ?? '')
      return `<div class="satu-usagerow">
        <span style="font-size: 13.5px; font-weight: 600;">${esc(e.action)}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(fmtTime(e.createdAt))}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(e.accountId || '—')}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(detail)}</span>
        <div></div>
      </div>`
    })
    .join('')
  return `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-usagehead">
            <span>事件</span><span>时间</span><span>账号</span><span>详情</span><span></span>
          </div>
          ${rows || '<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">还没有审计事件</div>'}
        </div>`
}

function auditChatsTable() {
  const members = state.accounts || []
  const opts = ['<option value="">全部</option>']
    .concat(
      members.map(
        (m) =>
          `<option value="${esc(m.id)}" ${state.sessionAccountId === m.id ? 'selected' : ''}>${esc(m.name || m.email || m.id)}</option>`,
      ),
    )
    .join('')
  const grid = 'grid-template-columns: minmax(140px, 2fr) minmax(100px, 1.2fr) minmax(80px, 1fr) minmax(130px, 1.2fr) 64px;'
  const rows = (state.sessions || [])
    .map((row) => {
      return `<div class="satu-usagerow" style="${grid}">
        <span style="font-size: 13.5px; font-weight: 600;">${esc(row.title || '未命名')}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(row.accountName || row.accountId || '—')}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(row.botName || row.botId || '—')}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(fmtTime(row.updatedAt))}</span>
        <button type="button" class="satu-linkbtn" data-act="go" data-href="/audit/${esc(row.sessionId)}">打开</button>
      </div>`
    })
    .join('')
  return `
        <form id="audit-filter-form" style="display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: flex-end;">
          <div class="field" style="margin: 0;">
            <label for="audit-account">员工</label>
            <select class="input" id="audit-account" name="accountId" style="width: 200px;">${opts}</select>
          </div>
          <div class="field" style="margin: 0;">
            <label for="audit-from">开始日期</label>
            <input class="input" id="audit-from" name="from" type="date" value="${esc(state.sessionFrom || '')}">
          </div>
          <div class="field" style="margin: 0;">
            <label for="audit-to">结束日期</label>
            <input class="input" id="audit-to" name="to" type="date" value="${esc(state.sessionTo || '')}">
          </div>
          <button type="submit" class="btn btn-secondary" style="flex: none;">筛选</button>
        </form>
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-usagehead" style="${grid}">
            <span>标题</span><span>员工</span><span>Bot</span><span>更新时间</span><span>打开</span>
          </div>
          ${rows || '<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">还没有对话索引。实例上报之后会列在这里。</div>'}
        </div>`
}

function auditPage() {
  const tab = state.auditTab === 'events' ? 'events' : 'chats'
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">审计</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">查看公司成员的对话。全文在执行机器上，这里只存索引。</p>
        </div>
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">${auditTabs(tab)}</div>
        ${flashes()}
        ${tab === 'events' ? auditEventsTable() : auditChatsTable()}
      </div>
    </div>`
}

function auditDetailPage() {
  const row = state.sessionDetail
  if (!row) {
    return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <button type="button" class="satu-linkbtn" data-act="go" data-href="/audit">返回审计</button>
        ${flashes()}
        <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">找不到这条对话。</p>
      </div>
    </div>`
  }
  const err = state.sessionPullError
  const events = state.sessionEvents
  let body
  if (err) {
    body = `<div class="gw-flash gw-flash-err">${esc(err)}</div>`
  } else if (events == null) {
    body = `<div class="gw-flash gw-flash-err">机器不在线，全文拉不下来</div>`
  } else {
    body = auditTranscript(events)
  }
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <button type="button" class="satu-linkbtn" data-act="go" data-href="/audit">返回审计</button>
          <h1 style="font-size: 24px; margin: 12px 0 4px;">${esc(row.title || '未命名')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(row.accountName || row.accountId || '—')} · ${esc(fmtTime(row.updatedAt || row.createdAt))}</p>
        </div>
        ${flashes()}
        ${body}
      </div>
    </div>`
}

function roleTag(role) {
  if (role === 'owner') return '<span class="tag tag-accent">系统管理员</span>'
  if (role === 'admin') return '<span class="tag tag-accent">管理员</span>'
  return '<span class="tag tag-neutral">成员</span>'
}

function orgCreateModal() {
  if (!state.orgCreateOpen) return ''
  return `<div class="gw-modal-backdrop" data-act="org-create-close">
    <form id="create-org-form" class="gw-modal" style="max-width: 500px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">新建公司</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">创建公司并指定一名管理员。</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="关闭" data-act="org-create-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div class="field">
        <label for="org-name">名称</label>
        <input class="input" id="org-name" name="name" required>
      </div>
      <div class="field">
        <label for="org-slug">slug</label>
        <input class="input" id="org-slug" name="slug" required>
      </div>
      <div class="field">
        <label for="org-seats">席位</label>
        <input class="input" id="org-seats" name="seats" type="number" min="1" value="1" required>
      </div>
      <div class="field">
        <label for="org-admin-email">管理员邮箱</label>
        <input class="input" id="org-admin-email" name="adminEmail" type="email" required>
      </div>
      <div class="field">
        <label for="org-admin-password">管理员口令</label>
        <input class="input" id="org-admin-password" name="adminPassword" type="password" minlength="10" required>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="org-create-close">取消</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? '创建中…' : '创建'}</button>
      </div>
    </form>
  </div>`
}

function companiesPage() {
  const rows = (state.orgs || [])
    .map((c) => {
      return `<div class="satu-memberrow" style="cursor: pointer;" data-act="go" data-href="/companies/${esc(c.id)}">
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(c.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(c.slug)} · ${esc(c.id)}</div>
        </div>
        <span style="font-size: 13px;">${esc(c.used)} / ${esc(c.seats)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(fmtTime(c.createdAt))}</span>
        <div></div>
        <div></div>
      </div>`
    })
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">公司</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">所有注册公司。席位由这里的套餐决定。</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" data-act="org-create-open">新建公司</button>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-memberhead">
            <span>公司</span><span>席位</span><span>创建时间</span><span></span><span></span>
          </div>
          ${rows || '<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">还没有公司</div>'}
        </div>
      </div>
      ${orgCreateModal()}
    </div>`
}

function fmtSize(n) {
  const x = Number(n)
  if (!Number.isFinite(x) || x < 0) return '—'
  if (x < 1024) return x + ' B'
  if (x < 1024 * 1024) return (x / 1024).toFixed(1) + ' KB'
  return (x / (1024 * 1024)).toFixed(1) + ' MB'
}

function shaShort(h) {
  const s = String(h || '')
  return s ? s.slice(0, 12) : '—'
}

function releasesPage() {
  const rows = state.releases || []
  const latest = state.latestRelease
  const table = rows.length
    ? `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); overflow: hidden;">
        <div class="satu-memberhead" style="grid-template-columns: 140px 100px 1fr 160px;">
          <span>版本</span><span>大小</span><span>sha256</span><span>时间</span>
        </div>
        ${rows
          .map(
            (r) => `<div class="satu-memberrow" style="grid-template-columns: 140px 100px 1fr 160px;">
          <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;">${esc(r.version)}${r.version === latest ? ' <span class="tag tag-accent">最新</span>' : ''}</span>
          <span style="font-size: 13px;">${esc(fmtSize(r.size))}</span>
          <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted-foreground);">${esc(shaShort(r.sha256))}</span>
          <span style="font-size: 13px; color: var(--muted-foreground);">${esc(fmtTime(r.createdAt))}</span>
        </div>`,
          )
          .join('')}
      </div>`
    : `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-lg);">还没有发布版本</div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${esc(latest ? '最新 ' + latest : '还没有发布版本')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">从 Gateway 上的 Bot 源码打包。不会从浏览器上传。</p>
        </div>
        ${flashes()}
        <form id="release-form" class="satu-panel" style="display: flex; flex-direction: column; gap: var(--space-3);">
          <span class="satu-panel-title">发布新版本</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">从 Gateway 上的 Bot 源码打包。</p>
          <div style="display: flex; gap: var(--space-3); flex-wrap: wrap; align-items: flex-end;">
            <div class="field" style="margin: 0;">
              <label for="rel-ver">version</label>
              <input class="input" id="rel-ver" name="version" required placeholder="0.1.0" autocomplete="off" style="width: 160px;">
            </div>
            <div class="field" style="margin: 0; flex: 1; min-width: 180px;">
              <label for="rel-note">说明（可选）</label>
              <input class="input" id="rel-note" name="note" placeholder="这次改了什么" autocomplete="off">
            </div>
            <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? '打包中…' : '发布'}</button>
          </div>
        </form>
        ${table}
      </div>
    </div>`
}

function companyDetailPage() {
  const c = state.org
  if (!c) {
    return `<div class="gw-page"><div class="gw-page-inner">${flashes()}<p style="color: var(--muted-foreground);">载入中…</p></div></div>`
  }
  const plan = state.plan || { seats: 0, used: 0 }
  const seats = state.seats || { total: plan.seats || 0, used: plan.used || 0 }
  const members = state.accounts || []
  const billing = state.billing || { plan: {}, invoices: [] }
  const bplan = billing.plan || {}
  const invoices = Array.isArray(billing.invoices) ? billing.invoices : []
  const used = plan.used ?? seats.used ?? 0
  const total = plan.seats ?? seats.total ?? 0
  const envCols = 'minmax(170px, 2fr) 88px 72px minmax(90px, 1fr) minmax(120px, 1.3fr) 72px'
  const memberRows = members
    .map((m) => {
      const st = MEMBER_STATUS[m.status] || MEMBER_STATUS.active
      const runtimes = Array.isArray(m.runtimes) ? m.runtimes : []
      const env = runtimes.length
        ? runtimes.map((rt) => esc(rt.botVersion || rt.botId || rt.status || '—')).join(' · ')
        : '未部署'
      return `<div class="satu-memberrow" style="grid-template-columns: ${envCols};">
      <button type="button" class="satu-linkbtn" data-act="seat-open" data-id="${esc(m.id)}" style="min-width: 0; display: flex; align-items: center; gap: var(--space-3); text-align: left; padding: 0; border: 0; background: transparent;">
        <span class="satu-avatar" style="background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc((m.name || m.email || '·').slice(0, 1).toUpperCase())}</span>
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600;">${esc(m.name || m.email)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.email)}</div>
        </div>
      </button>
      ${roleTag(m.role)}
      <span class="tag ${st.tag}">${st.label}</span>
      <span style="font-size: 13px; color: var(--muted-foreground);">${esc(ago(m.lastSeenAt))}</span>
      <span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${env}</span>
      <button type="button" class="satu-linkbtn" data-act="seat-open" data-id="${esc(m.id)}">查看</button>
    </div>`
    })
    .join('')
  const invoiceRows = invoices
    .map(
      (b) => `<div class="satu-billrow">
        <span style="font-size: 13.5px;">${esc(b.period)}</span>
        <span style="font-size: 13.5px;">${esc(b.amount)}</span>
        <span class="tag tag-accent-2">${esc(b.status)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(b.paid)}</span>
        <span></span>
      </div>`,
    )
    .join('')
  const empty = (msg) =>
    `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${esc(msg)}</div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${esc(c.name || '公司详情')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(c.slug || '')}</p>
        </div>
        ${flashes()}
        <div class="satu-panel">
          <span class="satu-panel-title">公司信息</span>
          <div class="satu-kv"><span>名称</span><span>${esc(c.name || '—')}</span></div>
          <div class="satu-kv"><span>slug</span><span>${esc(c.slug || '—')}</span></div>
          <div class="satu-kv"><span>id</span><span>${esc(c.id || '—')}</span></div>
          <div class="satu-kv"><span>创建时间</span><span>${esc(fmtTime(c.createdAt))}</span></div>
          <div class="satu-kv"><span>访问地址</span><span>${esc(c.accessUrl || '—')}</span></div>
          <div class="satu-kv"><span>machineId</span><span>${esc(c.machineId || '—')}</span></div>
        </div>
        ${machinePanel(c.id)}
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
            <h2 style="font-size: 18px; margin: 0;">成员</h2>
            <div style="display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;">
              <span style="font-size: 12px; color: var(--muted-foreground);">平台最新 ${esc(state.latestRelease || '还没有发布版本')} · ${members.length} 人 · 已用 ${esc(used)} / ${esc(total)} 席位</span>
              ${
                state.releases && state.releases.length
                  ? `<select class="input" style="width: 140px; flex: none;" data-act="update-version">${state.releases
                      .map((r) => `<option value="${esc(r.version)}" ${r.version === (state.updateVersion || state.latestRelease) ? 'selected' : ''}>${esc(r.version)}</option>`)
                      .join('')}</select>`
                  : ''
              }
              <button type="button" class="btn btn-primary" data-act="runtime-update" ${state.updatingRuntime || !state.latestRelease ? 'disabled' : ''}>${state.updatingRuntime ? '更新中…' : '更新 Bot'}</button>
            </div>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-memberhead" style="grid-template-columns: ${envCols};">
              <span>成员</span><span>角色</span><span>状态</span><span>最近活跃</span><span>环境</span><span></span>
            </div>
            ${memberRows || empty('还没有成员')}
          </div>
        </div>
        <div class="satu-panel">
          <span class="satu-panel-title">订阅</span>
          <div style="display: flex; align-items: baseline; gap: var(--space-2);">
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(bplan.name || '席位套餐')}</span>
          </div>
          <div class="satu-kv"><span>已用</span><span>${esc(used)} / ${esc(total)}</span></div>
          <form data-form="plan" data-id="${esc(c.id)}" style="display: flex; align-items: flex-end; gap: var(--space-3); flex-wrap: wrap;">
            <div class="field" style="margin: 0;">
              <label for="co-seats">席位</label>
              <input class="input" id="co-seats" name="seats" type="number" min="${esc(used || 1)}" value="${esc(total || 1)}" required style="width: 120px;">
            </div>
            <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>保存</button>
          </form>
          <div class="satu-kv"><span>账期</span><span>${esc(bplan.period || '—')}</span></div>
          <div class="satu-kv"><span>下次续订</span><span>${esc(bplan.renew || '—')}</span></div>
          <div class="satu-kv"><span>周期费用</span><span>${esc(bplan.amount || '—')}</span></div>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <h2 style="font-size: 18px; margin: 0;">订阅账单</h2>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-billhead">
              <span>账期</span><span>金额</span><span>状态</span><span>付款时间</span><span></span>
            </div>
            ${invoiceRows || empty('还没有订阅账单。支付接上之后，账期会列在这里。')}
          </div>
        </div>
        ${seatEnvModal()}
      </div>
    </div>`
}

function machinePanel(orgId) {
  const m = state.machine
  const has = !!(m && m.hasSshAuth)
  const bound = !!(m && (m.sshHost || m.id))
  const auth = (m && m.sshAuth) || 'password'
  return `<div class="satu-panel">
    <span class="satu-panel-title">运行机器</span>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${bound ? '一家公司一台 Debian 机器。SSH 登录给系统管理员用，席位用户没有 sudo。' : '还没有绑定。填 SSH 主机后保存。'}</p>
    <div class="satu-kv"><span>SSH 凭据</span><span>${has ? '已保存' : '未配置'}</span></div>
    <form data-form="machine" data-id="${esc(orgId)}" style="display: flex; flex-direction: column; gap: var(--space-3);">
      <div class="field" style="margin: 0;">
        <label for="mc-host">sshHost</label>
        <input class="input" id="mc-host" name="sshHost" value="${esc(m && m.sshHost || '')}" placeholder="例如 10.0.0.12" autocomplete="off">
      </div>
      <div style="display: flex; gap: var(--space-3); flex-wrap: wrap;">
        <div class="field" style="margin: 0;">
          <label for="mc-port">sshPort</label>
          <input class="input" id="mc-port" name="sshPort" type="number" min="1" value="${esc((m && m.sshPort) || 22)}" style="width: 96px;">
        </div>
        <div class="field" style="margin: 0; flex: 1;">
          <label for="mc-user">sshUser</label>
          <input class="input" id="mc-user" name="sshUser" value="${esc((m && m.sshUser) || 'debian')}" placeholder="debian">
        </div>
        <div class="field" style="margin: 0;">
          <label for="mc-auth">sshAuth</label>
          <select class="input" id="mc-auth" name="sshAuth" style="width: 140px;">
            <option value="password" ${auth === 'password' ? 'selected' : ''}>password</option>
            <option value="key" ${auth === 'key' ? 'selected' : ''}>key</option>
          </select>
        </div>
      </div>
      <div class="field" style="margin: 0;">
        <label for="mc-secret">sshSecret</label>
        <input class="input" id="mc-secret" name="sshSecret" type="password" value="" placeholder="${has ? '已保存' : '密码或私钥'}" autocomplete="new-password">
        <p style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);">留空则保留已保存的凭据。响应里不会回显。</p>
      </div>
      <div><button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>保存</button></div>
    </form>
  </div>`
}

function botNameOfId(id) {
  const b = (state.bots || []).find((x) => x.id === id)
  return (b && b.name) || id || '—'
}

function seatEnvModal() {
  if (!state.seatMember) return ''
  const m = state.seatMember
  const runtimes = Array.isArray(state.seatRuntimes) ? state.seatRuntimes : []
  const body = runtimes.length
    ? runtimes
        .map((rt) => {
          const pw = rt && rt.vncPassword ? (state.seatReveal ? rt.vncPassword : '••••••••') : '—'
          return `<div class="satu-panel" style="margin: 0;">
        <span class="satu-panel-title">${esc(botNameOfId(rt.botId))}</span>
        <div class="satu-kv"><span>botId</span><span>${esc(rt.botId || '—')}</span></div>
        <div class="satu-kv"><span>linuxUser</span><span>${esc(rt.linuxUser || '—')}</span></div>
        <div class="satu-kv"><span>DISPLAY</span><span>${esc(rt.display != null ? ':' + rt.display : '—')}</span></div>
        <div class="satu-kv"><span>noVNC</span><span style="word-break: break-all;">${esc(rt.novncUrl || '—')}</span></div>
        <div class="satu-kv"><span>VNC 密码</span><span>${esc(pw)} <button type="button" class="satu-linkbtn" data-act="seat-reveal">${state.seatReveal ? '隐藏' : '显示'}</button></span></div>
        <div class="satu-kv"><span>状态</span><span>${esc(rt.status || '—')}</span></div>
        <div class="satu-kv"><span>Bot 版本</span><span>${esc(rt.botVersion || '未部署')}</span></div>
        ${rt.lastError ? `<div class="satu-kv"><span>lastError</span><span>${esc(rt.lastError)}</span></div>` : ''}
      </div>`
        })
        .join('') +
      `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">x11vnc 只听 localhost；noVNC 走内网 HTTP。不要当成公网安全。</p>`
    : `<p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${state.seatError || '还没有部署。员工打开某个 Bot 后可以点「部署这个 Bot」。'}</p>`
  return `<div class="gw-modal-backdrop" data-act="seat-close">
    <div class="gw-modal" style="max-width: 520px;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">员工环境</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(m.name || m.email)} · ${esc(m.email)}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="关闭" data-act="seat-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      ${body}
    </div>
  </div>`
}

function usersPage() {
  const rows = (state.users || [])
    .map((a) => {
      const company = a.company ? `${a.company.name} (${a.company.slug})` : '平台'
      const initial = (a.email || '·').slice(0, 1).toUpperCase()
      return `<div class="satu-memberrow" style="cursor: pointer;" data-act="go" data-href="/users/${esc(a.id)}">
        <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
          <span style="width: 34px; height: 34px; flex: none; border-radius: 999px; background: var(--color-accent-200); color: var(--color-accent-800); display: flex; align-items: center; justify-content: center; font-family: var(--font-heading);">${esc(initial)}</span>
          <div style="min-width: 0;">
            <div style="font-size: 14px; font-weight: 600;">${esc(a.email)}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${esc(company)}</div>
          </div>
        </div>
        ${roleTag(a.role)}
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(fmtTime(a.createdAt))}</span>
        <div></div>
        <div></div>
      </div>`
    })
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">用户</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">平台账号与各公司管理员、员工。</p>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-memberhead">
            <span>账号</span><span>角色</span><span>加入时间</span><span></span><span></span>
          </div>
          ${rows || '<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">还没有用户</div>'}
        </div>
      </div>
    </div>`
}

function userSecretRow(label, kind, value) {
  const revealed = Boolean(state.userReveal && state.userReveal[kind])
  const shown = value ? (revealed ? value : '••••••••') : '—'
  const actions = value
    ? ` <button type="button" class="satu-linkbtn" data-act="user-secret-reveal" data-kind="${esc(kind)}">${revealed ? '隐藏' : '显示'}</button> <button type="button" class="satu-linkbtn" data-act="user-secret-copy" data-kind="${esc(kind)}">复制</button>`
    : ''
  return `<div class="satu-kv"><span>${esc(label)}</span><span style="word-break: break-all;">${esc(shown)}${actions}</span></div>`
}

function userDetailPage() {
  const d = state.userDetail
  if (!d || !d.account) {
    return `<div class="gw-page"><div class="gw-page-inner">${flashes()}<p style="color: var(--muted-foreground);">载入中…</p></div></div>`
  }
  const a = d.account
  const company = d.company
  const st = MEMBER_STATUS[a.status] || MEMBER_STATUS.active
  const ownerSeat = a.role === 'owner'
  const secrets = ownerSeat
    ? `<p style="margin: var(--space-3) 0 0; font-size: 13px; color: var(--muted-foreground);">平台账号不占席位，没有 API Key 和 access token。</p>`
    : `${userSecretRow('API Key', 'apiKey', d.apiKey)}${userSecretRow('access token', 'accessToken', d.accessToken)}`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">账号详情</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(a.email || '')}</p>
        </div>
        ${flashes()}
        <div class="satu-panel">
          <span class="satu-panel-title">账号信息</span>
          <div class="satu-kv"><span>邮箱</span><span>${esc(a.email || '—')}</span></div>
          <div class="satu-kv"><span>名称</span><span>${esc(a.name || '—')}</span></div>
          <div class="satu-kv"><span>角色</span><span>${roleTag(a.role)}</span></div>
          <div class="satu-kv"><span>公司</span><span>${esc(company ? `${company.name} (${company.slug})` : '平台')}</span></div>
          <div class="satu-kv"><span>状态</span><span class="tag ${st.tag}">${st.label}</span></div>
          <div class="satu-kv"><span>加入时间</span><span>${esc(fmtTime(a.createdAt))}</span></div>
        </div>
        <div class="satu-panel">
          <span class="satu-panel-title">席位密钥</span>
          ${secrets}
        </div>
      </div>
    </div>`
}

function plansPage() {
  const rows = (state.orgs || [])
    .map((c) => {
      return `<div class="satu-memberrow">
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(c.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(c.slug)}</div>
        </div>
        <span style="font-size: 13px; color: var(--muted-foreground);">已用 ${esc(c.used)}</span>
        <form data-form="plan" data-id="${esc(c.id)}" style="display: flex; align-items: center; gap: var(--space-2);">
          <input class="input" name="seats" type="number" min="${esc(c.used || 1)}" value="${esc(c.seats || 1)}" style="width: 96px;" required>
          <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>保存</button>
        </form>
        <div></div>
        <div></div>
      </div>`
    })
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">套餐</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">为每家公司分配席位。</p>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-memberhead">
            <span>公司</span><span>已用</span><span>席位</span><span></span><span></span>
          </div>
          ${rows || '<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">还没有公司</div>'}
        </div>
      </div>
    </div>`
}

function initialOf(user) {
  return (user?.name || user?.email || '·').trim().slice(0, 1).toUpperCase()
}

function profileForm() {
  const u = state.me?.account || {}
  return state.profileDraft ?? { name: u.name || '', title: u.title || '', phone: u.phone || '' }
}

function profileDirty() {
  const u = state.me?.account || {}
  const d = state.profileDraft
  if (!d) return false
  return d.name !== (u.name || '') || d.title !== (u.title ?? '') || d.phone !== (u.phone ?? '')
}

function roleLabelOfAccount(role) {
  return ({ owner: t('所有者', 'Owner'), admin: t('管理员', 'Admin'), member: t('成员', 'Member') })[role] || role
}

function dayOf(ts) {
  if (!ts) return t('从未修改', 'never')
  return new Date(ts).toLocaleDateString(localeMode === 'en' ? 'en-US' : 'zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function whenOf(ts) {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return t('刚刚', 'just now')
  if (m < 60) return t(`${m} 分钟前`, `${m} min ago`)
  if (m < 60 * 24) return t(`${Math.floor(m / 60)} 小时前`, `${Math.floor(m / 60)} h ago`)
  return t(`${Math.floor(m / 1440)} 天前`, `${Math.floor(m / 1440)} d ago`)
}

/** User-Agent → 一句人话。认不出来就说认不出来，别猜。 */
function deviceName(agent) {
  if (!agent) return t('未知设备', 'Unknown device')
  const os = /Mac OS X/.test(agent)
    ? 'macOS'
    : /Windows/.test(agent)
      ? 'Windows'
      : /Android/.test(agent)
        ? 'Android'
        : /iPhone|iPad/.test(agent)
          ? 'iOS'
          : /Linux/.test(agent)
            ? 'Linux'
            : null
  const browser = /Edg\//.test(agent)
    ? 'Edge'
    : /Chrome\//.test(agent)
      ? 'Chrome'
      : /Safari\//.test(agent)
        ? 'Safari'
        : /Firefox\//.test(agent)
          ? 'Firefox'
          : null
  if (!os && !browser) return t('未知设备', 'Unknown device')
  return [browser, os].filter(Boolean).join(' · ')
}

function paintProfileActions() {
  const dirty = profileDirty()
  const cancel = document.querySelector('[data-act="profile-cancel"]')
  const save = document.querySelector('[data-act="profile-save"]')
  const saved = document.querySelector('[data-profile-saved]')
  if (cancel instanceof HTMLButtonElement) cancel.disabled = !dirty
  if (save instanceof HTMLButtonElement) save.disabled = !dirty || state.busy
  if (saved) saved.hidden = !state.profileSaved
}

function passwordModal() {
  if (!state.pwOpen) return ''
  const f = state.pwForm
  const check = svg(['m5 13 4 4L19 7'], 13)
  return `<div class="gw-modal-backdrop" data-act="pw-close">
    <form id="pw-form" class="gw-modal" style="max-width: 420px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('修改口令', 'Change password')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('改完之后，其他设备上的登录会立即失效。', 'Every other device is signed out immediately.')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${t('关闭', 'Close')}" data-act="pw-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div class="field">
        <label for="pw-old">${t('当前口令', 'Current password')}</label>
        <input class="input" id="pw-old" name="current" data-pw="current" type="password" autocomplete="current-password" required value="${esc(f.current)}">
      </div>
      <div class="field">
        <label for="pw-new">${t('新口令', 'New password')}</label>
        <input class="input" id="pw-new" name="next" data-pw="next" type="password" autocomplete="new-password" required value="${esc(f.next)}" placeholder="${t('至少 10 位', 'At least 10 characters')}">
      </div>
      <div class="field">
        <label for="pw-new2">${t('确认新口令', 'Confirm new password')}</label>
        <input class="input" id="pw-new2" name="confirm" data-pw="confirm" type="password" autocomplete="new-password" required value="${esc(f.confirm)}">
      </div>
      <div style="display: flex; flex-direction: column; gap: 5px; padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
        <span class="satu-panel-title">${t('要求', 'Requirements')}</span>
        <div class="satu-step" style="color: var(--muted-foreground);">${check} ${t('至少 10 个字符', 'At least 10 characters')}</div>
        <div class="satu-step" style="color: var(--muted-foreground);">${check} ${t('不能与当前口令相同', 'Different from the current one')}</div>
      </div>
      ${state.pwError ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${esc(state.pwError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="pw-close">${t('取消', 'Cancel')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…', 'Saving…') : t('保存新口令', 'Save new password')}</button>
      </div>
    </form>
  </div>`
}

/**
 * 个人设置。
 *
 * 真的那些：基本资料（写回 /me）、修改口令（验旧口令、改完其他 JWT 全部作废）、
 * 外观与语言（本机立刻生效，并同步到账号）。
 *
 * 不真的那些，都在旁边写了缺什么：通知三项没有投递渠道，渠道配对码没有渠道。
 * 登录设备只有当前这一次——Gateway 用 JWT，没有会话表。
 */
function profilePage() {
  const u = state.me?.account || {}
  const form = profileForm()
  const dirty = profileDirty()
  const themes = [
    { key: 'light', label: t('浅色', 'Light'), hint: t('始终使用浅色', 'Always light') },
    { key: 'dark', label: t('深色', 'Dark'), hint: t('始终使用深色', 'Always dark') },
    { key: 'system', label: t('跟随系统', 'System'), hint: t('跟随操作系统设置', 'Follow your OS setting') },
  ]
  const langs = [
    { key: 'zh', label: '中文' },
    { key: 'en', label: 'English' },
  ]
  const notices = [
    {
      key: 'digest',
      title: t('每日工作摘要', 'Daily digest'),
      desc: t('每天 09:00 汇总 AI 员工的执行结果发到邮箱', 'A 09:00 roundup of what your AI employees did, by email'),
    },
    {
      key: 'review',
      title: t('待复核提醒', 'Review requests'),
      desc: t('有任务需要人工确认时立即通知我', 'Notify me the moment a task needs human confirmation'),
    },
    {
      key: 'fail',
      title: t('任务失败提醒', 'Failure alerts'),
      desc: t('定时任务执行失败时发送站内通知', 'In-app notice when a scheduled task fails'),
    },
  ]
  const themeCards = themes
    .map(
      (item) => `<button type="button" class="satu-themecard" aria-pressed="${String(themeMode === item.key)}" data-act="profile-theme" data-mode="${item.key}">
                    <span class="satu-themeswatch" data-mode="${item.key}">
                      <span class="satu-themebar"></span>
                      <span class="satu-themebody"></span>
                    </span>
                    <span style="font-size: 13px; font-weight: 600;">${esc(item.label)}</span>
                    <span style="font-size: 11.5px; color: var(--muted-foreground); text-align: center;">${esc(item.hint)}</span>
                  </button>`,
    )
    .join('')
  const langPills = langs
    .map(
      (l) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(localeMode === l.key)}" data-act="profile-locale" data-locale="${l.key}">${esc(l.label)}</button>`,
    )
    .join('')
  const noticeRows = notices
    .map(
      (n) => `<div class="satu-toggleRow">
                <div style="min-width: 0;">
                  <div style="font-size: 13.5px; font-weight: 600;">${esc(n.title)}</div>
                  <div style="font-size: 12px; color: var(--muted-foreground);">${esc(n.desc)}</div>
                </div>
                <button type="button" class="satu-switch" aria-pressed="${String(!state.notifyOff.includes(n.key))}" aria-label="${esc(n.title)}" data-act="profile-notify" data-notify="${n.key}"><span></span></button>
              </div>`,
    )
    .join('')
  const sessionAt = u.lastSeenAt || Date.now()
  const agent = navigator.userAgent
  return `
    <div class="gw-page">
      <div class="gw-page-inner gw-profile">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('个人设置', 'Preferences')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('管理你的账号信息、偏好与安全设置。', 'Manage your account details, preferences, and security.')}</p>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-4); padding: var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg);">
          <div style="width: 56px; height: 56px; flex: none; border-radius: 999px; background: var(--color-accent-200); display: flex; align-items: center; justify-content: center; font-family: var(--font-heading); font-size: 22px; color: var(--color-accent-800);">${esc(initialOf(u))}</div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 16px; font-weight: 600;">${esc(u.name || u.email || '')}</div>
            <div style="font-size: 13px; color: var(--muted-foreground);">
              ${esc(u.email || '')} · ${esc(roleLabelOfAccount(u.role))} · ${t('加入于', 'Joined')} ${esc(dayOf(u.createdAt))}
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('基本资料', 'Profile')}</span>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="field">
              <label for="pf-name">${t('姓名', 'Name')}</label>
              <input class="input" id="pf-name" data-profile="name" type="text" value="${esc(form.name)}">
            </div>
            <div class="field">
              <label for="pf-title">${t('职位', 'Job title')}</label>
              <input class="input" id="pf-title" data-profile="title" type="text" value="${esc(form.title)}" placeholder="${t('例如：运营负责人', 'e.g. Head of Operations')}">
            </div>
            <div class="field">
              <label for="pf-email">${t('邮箱', 'Email')}</label>
              <input class="input" id="pf-email" type="email" value="${esc(u.email || '')}" readonly disabled>
              <span style="font-size: 12px; color: var(--muted-foreground);">${t('邮箱是登录身份，改它要另一套验证流程，暂时不开放。', 'Email is your sign-in identity; changing it needs a verification flow we do not have yet.')}</span>
            </div>
            <div class="field">
              <label for="pf-phone">${t('手机号', 'Phone')}</label>
              <input class="input" id="pf-phone" data-profile="phone" type="tel" value="${esc(form.phone)}" placeholder="${t('选填', 'Optional')}">
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('渠道配对码', 'Channel pairing code')}</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
            ${t('用来把微信、Telegram 这类渠道里的对话绑到你的账号上。渠道本身还没接入，所以现在没有可配对的东西。', 'Binds conversations from channels like WeChat or Telegram to your account. No channel is wired up yet, so there is nothing to pair with.')}
          </p>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('偏好', 'Preferences')}</span>
          <div class="field">
            <label>${t('界面外观', 'Appearance')}</label>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3);">
              ${themeCards}
            </div>
          </div>
          <div class="field">
            <label>${t('界面语言', 'Language')}</label>
            <div style="display: flex; gap: var(--space-2); flex-wrap: wrap;">
              ${langPills}
            </div>
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">
            ${t('两项都存在这台机器上，并同步到你的账号——换台机器登录会自动跟过去。', 'Both are stored on this machine and synced to your account, so they follow you to another machine.')}
          </span>
          ${noticeRows}
          <span style="font-size: 12px; color: var(--muted-foreground);">
            ${t('这三项还没有落点：发通知要先有定时任务与通知渠道，两者都还没做。开关是真的，记不住。', 'These three have nowhere to land yet — notifications need the scheduler and a delivery channel, and neither exists. The switches move, but nothing is stored.')}
          </span>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('安全', 'Security')}</span>
          <div class="satu-toggleRow">
            <div>
              <div style="font-size: 13.5px; font-weight: 600;">${t('登录口令', 'Password')}</div>
              <div style="font-size: 12px; color: var(--muted-foreground);">${t('上次修改于', 'Last changed')} ${esc(dayOf(u.passwordChangedAt || u.createdAt))}</div>
            </div>
            <button type="button" class="btn btn-secondary" style="flex: none;" data-act="pw-open">${t('修改口令', 'Change password')}</button>
          </div>
        </div>

        <div class="satu-panel">
          <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3);">
            <span class="satu-panel-title">${t('登录设备', 'Signed-in devices')}</span>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('共 1 个会话', '1 session(s)')}</span>
          </div>
          <div class="satu-toggleRow">
            <div style="min-width: 0;">
              <div style="font-size: 13.5px; font-weight: 600;">${esc(deviceName(agent))}${t(' · 当前设备', ' · this device')}</div>
              <div style="font-size: 12px; color: var(--muted-foreground);">${t('登录于', 'Signed in')} ${esc(whenOf(sessionAt))}</div>
            </div>
            <span class="tag tag-accent-2" style="flex: none;">${t('使用中', 'Active')}</span>
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">
            ${t('Gateway 用 JWT，没有会话表，列不出也注销不了其他设备。改口令会作废所有已签发的票；当前这次会发一张新票。', 'Gateway uses JWTs and has no session table, so other devices cannot be listed or revoked. Changing your password voids every issued ticket; this browser gets a new one.')}
          </span>
        </div>

        ${state.profileError ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-md); padding: 10px var(--space-4);">${esc(state.profileError)}</div>` : ''}

        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4);">
          <button type="button" class="satu-linkbtn" style="text-align: left;" data-act="logout">${t('退出登录', 'Sign out')}</button>
          <div style="display: flex; align-items: center; gap: var(--space-3);">
            <span data-profile-saved style="font-size: 12.5px; color: var(--muted-foreground);" ${state.profileSaved ? '' : 'hidden'}>${t('已保存', 'Saved')}</span>
            <button type="button" class="btn btn-secondary" data-act="profile-cancel" ${dirty ? '' : 'disabled'}>${t('取消', 'Cancel')}</button>
            <button type="button" class="btn btn-primary" data-act="profile-save" ${dirty && !state.busy ? '' : 'disabled'}>${state.busy ? t('保存中…', 'Saving…') : t('保存更改', 'Save changes')}</button>
          </div>
        </div>
      </div>
    </div>
    ${passwordModal()}`
}


function pickId(o) {
  return typeof o === 'string' ? o : o && typeof o === 'object' ? String(o.id ?? o.name ?? '') : String(o ?? '')
}
function pickLabel(o) {
  return typeof o === 'string' ? o : o && typeof o === 'object' ? String(o.name ?? o.id ?? '') : String(o ?? '')
}

function botPicks(key, options, selected, hint) {
  const sel = Array.isArray(selected) ? selected : []
  const buttons = (options || [])
    .map((o) => {
      const id = pickId(o)
      const on = sel.includes(id)
      return `<button type="button" class="satu-assignee" style="padding: 5px 12px;" aria-pressed="${String(on)}" data-act="bot-pick" data-key="${esc(key)}" data-value="${esc(id)}">${esc(pickLabel(o))}</button>`
    })
    .join('')
  const empty = options && options.length ? '' : `<span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint || '没有可选项')}</span>`
  return `<div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${buttons}${empty}</div>`
}

function botToggle(title, desc, on, act, extra = '') {
  return `<div class="satu-toggleRow">
    <div style="min-width: 0;">
      <div style="font-size: 13.5px; font-weight: 600;">${esc(title)}</div>
      <div style="font-size: 12px; color: var(--muted-foreground);">${esc(desc)}</div>
    </div>
    <button type="button" class="satu-switch" aria-pressed="${String(!!on)}" aria-label="${esc(title)}" data-act="${esc(act)}" ${extra}><span></span></button>
  </div>`
}

function botsPage() {
  const rows = (state.bots || [])
    .map((a) => {
      const on = a.enabled !== false
      return `<div class="satu-agentrow">
        <button type="button" class="satu-tasklink" data-act="go" data-href="/bots/${esc(a.id)}">
          <span style="display: flex; align-items: center; gap: var(--space-3); min-width: 0;">
            <span class="satu-providermark" style="width: 34px; height: 34px; background: var(--color-accent-200); color: var(--color-accent-800);">${agentIcon(a.icon)}</span>
            <span style="min-width: 0; display: flex; flex-direction: column; gap: 1px; text-align: left;">
              <span style="font-size: 14px; font-weight: 600;">${esc(a.name)}</span>
              <span style="font-size: 12px; color: var(--muted-foreground);">${esc(a.description || a.origin || '')}</span>
            </span>
          </span>
        </button>
        <span class="tag ${on ? 'tag-accent-2' : 'tag-neutral'}">${on ? '已上线' : '未上线'}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(a.skillCount ?? '—')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(a.mcpCount ?? '—')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(a.usage ?? '—')}</span>
        <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-2); justify-content: flex-end;">
          <button type="button" class="satu-switch" aria-pressed="${String(on)}" aria-label="上线" data-act="bot-list-enabled" data-id="${esc(a.id)}"><span></span></button>
          <button type="button" class="satu-linkbtn" data-act="go" data-href="/bots/${esc(a.id)}">配置</button>
        </div>
      </div>`
    })
    .join('')
  const body = rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">还没有 Bot</div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">Bot 配置</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">管理 AI 员工的人设、能力与可访问范围。</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" data-act="bot-create">
            ${svg(['M12 5v14', 'M5 12h14'], 15)} 新建 Bot
          </button>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-agenthead">
            <span>Bot</span><span>状态</span><span>Skill</span><span>MCP</span><span>本月执行</span><span></span>
          </div>
          ${body}
        </div>
      </div>
    </div>`
}

function botDetailPage() {
  const bot = state.bot
  const a = state.botDraft
  if (!bot || !a) {
    return `<div class="gw-page"><div class="gw-page-inner" style="max-width: 820px;">${flashes()}<p style="color: var(--muted-foreground);">载入中…</p></div></div>`
  }
  const opts = state.botOptions || { skills: [], mcps: [], groups: [], kbs: [] }
  const catalog = state.botModels || []
  const providers = catalog.length ? catalog : [{ provider: a.provider || 'deepseek', name: a.provider || 'deepseek', models: [{ id: a.model, name: a.model }] }]
  const providerOpts = providers
    .map((p) => `<option value="${esc(p.provider)}" ${p.provider === a.provider ? 'selected' : ''}>${esc(p.name || p.provider)}</option>`)
    .join('')
  const modelList = (providers.find((p) => p.provider === a.provider) || providers[0] || { models: [] }).models || []
  const models = modelList.length ? modelList : [{ id: a.model, name: a.model }]
  const modelOpts = models
    .map((m) => `<option value="${esc(m.id)}" ${m.id === a.model ? 'selected' : ''}>${esc(m.id)}</option>`)
    .join('')
  const iconPick = AGENT_ICON_KEYS.map((key) => {
    const on = a.icon === key
    return `<button type="button" class="satu-iconpick" aria-pressed="${String(on)}" aria-label="${esc(key)}" title="${esc(key)}" data-act="bot-icon" data-icon="${esc(key)}">${agentIcon(key)}</button>`
  }).join('')
  const guards = (a.guards || [])
    .map((g) => botToggle(g.title, g.desc, g.on, 'bot-guard', `data-id="${esc(g.id)}"`))
    .join('')
  const scopePills = MEMORY_SCOPES.map(
    (sc) =>
      `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(a.scope === sc)}" data-act="bot-scope" data-value="${esc(sc)}">${esc(sc)}</button>`,
  ).join('')
  const ttlOpts = MEMORY_TTLS.map((t) => `<option value="${esc(t)}" ${t === a.ttl ? 'selected' : ''}>${esc(t)}</option>`).join('')
  const memoryBody = a.memoryOn
    ? `<div style="display: flex; flex-direction: column; gap: var(--space-4);">
        <div class="field">
          <label>记忆范围</label>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${scopePills}</div>
        </div>
        <div class="field">
          <label>记录哪些内容</label>
          ${botPicks('kinds', MEMORY_KINDS, a.kinds)}
        </div>
        <div class="satu-agentpair">
          <div class="field">
            <label for="bot-ttl">保留时长</label>
            <select class="input" id="bot-ttl" data-act="bot-ttl">${ttlOpts}</select>
          </div>
          <div class="field">
            <label for="bot-cap" data-bot-cap-label>注入上限 · ${esc(a.cap)} 条</label>
            <input class="input" id="bot-cap" type="range" min="5" max="50" step="5" value="${esc(a.cap)}" data-bot="cap" style="padding: 0; border: 0; background: transparent; accent-color: var(--color-accent);">
            <span style="font-size: 12px; color: var(--muted-foreground);">每次对话最多注入的记忆条数</span>
          </div>
        </div>
        ${botToggle('写入前需用户确认', 'Agent 提议记住某条信息时先征求同意', a.confirmOn, 'bot-confirm')}
        ${botToggle('不记录敏感信息', '手机号、证件号、银行卡等自动跳过', a.piiOn, 'bot-pii')}
        <div style="display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
            <span style="font-size: 13.5px; font-weight: 600;">已存记忆</span>
            <span style="font-size: 12px; color: var(--muted-foreground);">${(a.memories || []).length} 条</span>
          </div>
          <div style="padding: 6px 0; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted-foreground);">没有已存记忆</div>
        </div>
      </div>`
    : ''
  return `
    <div class="gw-page">
      <div class="gw-page-inner" style="max-width: 820px; gap: var(--space-4);">
        ${flashes()}
        <div class="satu-panel">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
            <div style="display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; flex: 1;">
              <span class="satu-providermark" style="width: 42px; height: 42px; background: var(--color-accent-200); color: var(--color-accent-800);">${agentIcon(a.icon, 20)}</span>
              <div style="min-width: 0; flex: 1; display: flex; flex-direction: column; gap: var(--space-2);">
                <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
                  <input class="input" style="max-width: 280px; font-family: var(--font-heading); font-size: 16px; font-weight: 600;" data-bot="name" value="${esc(a.name)}" placeholder="助理名字">
                  <span class="tag ${a.enabled ? 'tag-accent-2' : 'tag-neutral'}">${a.enabled ? '已上线' : '未上线'}</span>
                </div>
                <input class="input" data-bot="description" value="${esc(a.description)}" placeholder="简介">
                <div style="font-size: 12.5px; color: var(--muted-foreground);">本月执行 ${esc(bot.usage || '—')} · ${esc(a.model || '')}</div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px;">${iconPick}</div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
              <button type="button" class="satu-switch" aria-pressed="${String(!!a.enabled)}" aria-label="上线" data-act="bot-enabled"><span></span></button>
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">模型</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">发消息用这一对。密钥在 Gateway，不在本机。</p>
          <div class="satu-toggleRow">
            <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">供应商</div></div>
            <select class="input" style="width: 250px; flex: none;" data-act="bot-provider">${providerOpts}</select>
          </div>
          <div class="satu-toggleRow">
            <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">模型</div></div>
            <select class="input" style="width: 250px; flex: none;" data-act="bot-model">${modelOpts}</select>
          </div>
        </div>

        <div class="satu-panel">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
            <span class="satu-panel-title" style="text-transform: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; letter-spacing: 0;">soul.md</span>
            <span style="font-size: 12px; color: var(--muted-foreground);" data-bot-prompt-len>${esc(String(a.prompt.length))} 字 · 每轮随上下文注入</span>
          </div>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">这份文件定义 Agent 的身份、语气与工作原则，每次对话都会随上下文一起注入。</p>
          <textarea class="input satu-code" rows="12" data-bot="prompt">${esc(a.prompt)}</textarea>
          <div class="field">
            <label for="bot-greeting">开场问候</label>
            <input class="input" id="bot-greeting" type="text" data-bot="greeting" value="${esc(a.greeting)}">
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">行为边界</span>
          ${guards}
          <div class="field">
            <label for="bot-escalate">升级人工的条件</label>
            <input class="input" id="bot-escalate" type="text" data-bot="escalate" value="${esc(a.escalate)}">
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">这几条最终落在工具执行前的拦截上（tools/pre-execute），不是提示词里的一句话——现在还没接。</span>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">可用 Skill</span>
          ${botPicks('skills', opts.skills, a.skills, '没有可选项')}
          <span class="satu-panel-title" style="margin-top: var(--space-2);">可用 MCP 服务器</span>
          ${botPicks('mcps', opts.mcps, a.mcps, '没有可选项')}
          <span style="font-size: 12px; color: var(--muted-foreground);">未勾选的能力，Agent 在任务中不可调用。</span>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">记忆</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">决定这个 Agent 能记住什么、记多久，以及记忆如何参与后续对话。</p>
          ${botToggle('启用长期记忆', '关闭后每次对话都从空白上下文开始', a.memoryOn, 'bot-memory')}
          ${memoryBody}
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">可访问范围</span>
          <div class="field">
            <label>可使用该 Agent 的分组</label>
            ${botPicks('groups', opts.groups, a.groups, '没有可选项')}
          </div>
          <div class="field">
            <label>知识库</label>
            ${botPicks('kbs', opts.kbs, a.kbs, '没有可选项')}
          </div>
        </div>

        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);">
          <button type="button" class="satu-linkbtn" style="text-align: left;" data-act="bot-delete">删除这个 Bot</button>
          <div style="display: flex; gap: var(--space-2);">
            <button type="button" class="btn btn-primary" data-act="bot-save" ${state.busy ? 'disabled' : ''}>${state.busy ? '保存中…' : '保存配置'}</button>
          </div>
        </div>
        <p style="margin: 0 0 var(--space-4); font-size: 12px; color: var(--muted-foreground);">名字、简介、提示词、模型、上线状态、Skill 与 MCP 会写回公司目录。开场问候、守卫、记忆、分组与知识库还没有落点。</p>
      </div>
    </div>
    ${confirmModal()}`
}

function dayISO(ts) {
  if (!ts) return '—'
  return new Date(ts).toISOString().slice(0, 10)
}

function kbOf(n) {
  const x = Number(n) || 0
  return x < 1024 ? `${x} B` : x < 1024 * 1024 ? `${(x / 1024).toFixed(1)} KB` : `${(x / 1024 / 1024).toFixed(1)} MB`
}

function stepsOfBody(body) {
  return String(body || '')
    .split('\n')
    .filter((l) => /^\s*(?:\d+[.)]|[-*+])\s+/.test(l)).length
}

const SKILL_ICON = ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z']
const EDIT_ICON = ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z']
const FILE_ICON = ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6']
const UPLOAD_ICON = ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 9 5-5 5 5', 'M12 4v12']
const CHECK_ICON = ['m5 13 4 4L19 7']
const PLUS_ICON = ['M12 5v14', 'M5 12h14']
const CLOSE_ICON = ['M18 6 6 18', 'M6 6l12 12']
const SKILL_SOURCES = [
  { key: '手动编写', label: '手动编写' },
  { key: '单文件 Skill', label: '单文件 Skill' },
  { key: 'ZIP 包', label: 'ZIP 包' },
]
const MCP_KINDS = ['stdio', 'SSE', 'HTTP']
const MCP_PERMS = [
  { key: '只读', label: '只读', tag: 'tag-neutral' },
  { key: '可写', label: '可写', tag: 'tag-accent' },
  { key: '需审批', label: '需审批', tag: 'tag-accent-2' },
]
function permTag(perm) {
  return MCP_PERMS.find((p) => p.key === perm)?.tag || 'tag-neutral'
}

function emptySkillForm(item) {
  return {
    name: item?.name || '',
    body: item?.body || '',
    tags: Array.isArray(item?.tags) ? [...item.tags] : [],
    source: item?.source || '手动编写',
    enabled: item ? item.enabled !== false : true,
    fileName: item?.fileName || '',
  }
}

function emptyServerForm(item) {
  const env = item?.env && typeof item.env === 'object' && Object.keys(item.env).length ? JSON.stringify(item.env, null, 2) : ''
  return {
    name: item?.name || '',
    kind: item?.kind || 'SSE',
    endpoint: item?.endpoint || '',
    token: '',
    env,
    perm: item?.perm || '只读',
    enabled: item ? item.enabled !== false : true,
    hasToken: !!item?.hasToken,
  }
}

function syncSkillForm() {
  const f = state.skillForm
  if (!f) return
  const name = document.getElementById('sk-name')
  const body = document.getElementById('sk-body')
  const endpoint = document.getElementById('tl-endpoint')
  const token = document.getElementById('tl-token')
  const env = document.getElementById('tl-env')
  if (name) f.name = name.value
  if (body) f.body = body.value
  if (endpoint) f.endpoint = endpoint.value
  if (token) f.token = token.value
  if (env) f.env = env.value
}

function closeSkillDialog() {
  state.skillDialog = null
  state.skillForm = null
  state.skillError = ''
  state.skillFile = null
  state.skillEntries = null
  state.skillTagManage = false
  state.skillTagAdding = false
}

function pickRow(label, options, value, act, hint) {
  const buttons = options
    .map((o) => {
      const key = o.key || o
      const lab = o.label || o
      return `<button type="button" class="satu-assignee" style="padding: 5px 12px;" aria-pressed="${String(value === key)}" data-act="${esc(act)}" data-value="${esc(key)}">${esc(lab)}</button>`
    })
    .join('')
  return `<div class="field">
    <label>${esc(label)}</label>
    <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${buttons}</div>
    ${hint ? `<span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint)}</span>` : ''}
  </div>`
}

function skillEnableRow(enabled) {
  return `<div class="satu-toggleRow" style="border-top: 0; padding: 0;">
    <div>
      <div style="font-size: 13.5px; font-weight: 600;">保存后立即启用</div>
      <div style="font-size: 12px; color: var(--muted-foreground);">关闭则仅保存，不对 Agent 开放</div>
    </div>
    <button type="button" class="satu-switch" aria-pressed="${String(!!enabled)}" aria-label="立即启用" data-act="skill-enabled"><span></span></button>
  </div>`
}

function skillTagPicker(known, picked) {
  const manage = state.skillTagManage
  const chips = (known || [])
    .map((tag) =>
      manage
        ? `<button type="button" class="satu-assignee" style="padding: 5px 10px 5px 12px; gap: 6px; color: var(--color-accent-800);" aria-label="删除标签 ${esc(tag)}" data-act="skill-tag-delete" data-tag="${esc(tag)}">${esc(tag)} ${svg(CLOSE_ICON, 12)}</button>`
        : `<button type="button" class="satu-assignee" style="padding: 5px 12px;" aria-pressed="${String(picked.includes(tag))}" data-act="skill-tag-pick" data-tag="${esc(tag)}">${esc(tag)}</button>`,
    )
    .join('')
  const add = manage
    ? ''
    : state.skillTagAdding
      ? `<input class="input" id="sk-tag-draft" style="width: 120px; padding: 4px 10px; font-size: 13px;" autofocus data-skill-tag-draft placeholder="新标签">`
      : `<button type="button" class="satu-assignee" style="padding: 5px 12px;" data-act="skill-tag-add">${svg(PLUS_ICON, 12)} 新建标签</button>`
  const hint = manage
    ? '点一个标签把它删掉——用到它的 Skill 上那一个也会一起去掉。'
    : '可多选，用于筛选与归类'
  return `<div class="field">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
      <label style="margin: 0;">标签</label>
      <button type="button" class="satu-linkbtn" style="font-size: 12px;" data-act="skill-tag-manage">${manage ? '完成' : '管理'}</button>
    </div>
    <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${chips}${add}</div>
    <span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint)}</span>
  </div>`
}

function skillEmpty(title, note) {
  return `<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: var(--space-8) var(--space-4); border: 1px dashed var(--input-border); border-radius: var(--radius-lg); background: var(--card);">
    <div style="font-size: 14px; font-weight: 600;">${esc(title)}</div>
    <div style="font-size: 12.5px; color: var(--muted-foreground);">${esc(note)}</div>
  </div>`
}

function skillCard(skill) {
  const tags = (skill.tags || []).map((tag) => `<span class="tag tag-neutral" style="font-size: 11px; padding: 2px 8px;">${esc(tag)}</span>`).join('')
  const steps = skill.steps ? `<span>${esc(String(skill.steps))} 个步骤</span>` : ''
  return `<div class="satu-card">
    <div style="display: flex; align-items: flex-start; gap: var(--space-3);">
      <span class="satu-providermark" style="background: var(--color-accent-100); color: var(--color-accent-800);">${svg(SKILL_ICON, 16)}</span>
      <div style="flex: 1; min-width: 0;">
        <div class="satu-name">${esc(skill.name)}</div>
        <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px;">${tags}</div>
      </div>
      <button type="button" class="satu-switch" aria-pressed="${String(skill.enabled !== false)}" aria-label="启用" data-act="skill-toggle" data-id="${esc(skill.id)}"><span></span></button>
    </div>
    <p class="satu-desc">${esc(skill.summary || '（还没写正文）')}</p>
    <div style="height: 1px; background: var(--color-divider);"></div>
    <div class="satu-meta">
      ${steps}
      <span>${esc(skill.source || '手动编写')}</span>
      <span>更新于 ${esc(dayISO(skill.updatedAt))}</span>
    </div>
    <div style="display: flex; gap: var(--space-2); margin-top: auto;">
      <button type="button" class="btn btn-secondary" style="flex: 1; justify-content: center;" data-act="skill-edit" data-id="${esc(skill.id)}">编辑</button>
      <button type="button" class="btn btn-secondary" style="flex: none;" disabled title="试运行要等 Skill 接进 Agent 循环">试运行</button>
    </div>
  </div>`
}

function skillDialogView() {
  const d = state.skillDialog
  if (!d || d.type !== 'skill') return ''
  const f = state.skillForm || emptySkillForm(d.item)
  const skill = d.item
  const zip = f.source === 'ZIP 包'
  const upload = f.source !== '手动编写' && !skill
  const steps = stepsOfBody(f.body)
  const known = state.skillTags || []
  const file = state.skillFile
  const entries = state.skillEntries
  let uploadBlock = ''
  if (upload) {
    const accept = zip ? '.zip' : '.md,.markdown,.yaml,.yml,.json,.txt'
    const title = zip ? '选择 .zip 技能包' : '选择 SKILL.md / .yaml / .json'
    const hint = zip
      ? '就在这台浏览器里解开，看清楚了再保存。'
      : '文件内容就是这个 Skill 的定义，导入后可以直接在下面改。'
    const reqs = zip
      ? `<div style="display: flex; flex-direction: column; gap: 6px; padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
          <span class="satu-panel-title">ZIP 包结构要求</span>
          ${['根目录含 SKILL.md（名称、说明、步骤）', '可选 scripts/、templates/、assets/ 子目录', '单包不超过 5 MB、200 个文件']
            .map((line) => `<div class="satu-step" style="color: var(--muted-foreground);">${svg(CHECK_ICON, 13)} ${esc(line)}</div>`)
            .join('')}
        </div>`
      : ''
    const fileRow = file
      ? `<div class="satu-uploadrow">
          <span class="satu-dropicon" style="width: 32px; height: 32px;">${svg(FILE_ICON, 16)}</span>
          <div style="min-width: 0; flex: 1;">
            <div style="font-size: 13.5px; font-weight: 600;">${esc(file.name)}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${esc(kbOf(file.size))}${entries ? ` · 解出 ${entries.length} 个文件` : ''} · 读到 ${steps} 个步骤</div>
          </div>
          <span class="tag tag-accent-2">${zip ? '已解开' : '已读取'}</span>
        </div>`
      : ''
    const tree = zip && entries
      ? `<div class="satu-filetree" style="max-height: 168px;">
          ${entries
            .map(
              (entry) => `<div class="satu-fileitem" style="cursor: default;">
                <span class="satu-fileicon">${svg(FILE_ICON, 13)}</span>
                <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(entry.path)}</span>
                <span style="margin-left: auto; font-size: 11.5px; color: var(--muted-foreground);">${esc(kbOf(entry.bytes ? entry.bytes.length : 0))}</span>
              </div>`,
            )
            .join('')}
        </div>`
      : ''
    uploadBlock = `<div style="display: flex; flex-direction: column; gap: var(--space-3);">
      <label class="satu-drop">
        <input type="file" accept="${esc(accept)}" style="position: absolute; inset: 0; opacity: 0; cursor: pointer;" data-skill-file="1">
        <span class="satu-dropicon">${svg(UPLOAD_ICON, 20)}</span>
        <span style="font-size: 14px; font-weight: 600;">${esc(title)}</span>
        <span style="font-size: 12px; color: var(--muted-foreground); text-align: center;">${esc(hint)}</span>
      </label>
      ${reqs}
      ${fileRow}
      ${tree}
    </div>`
  }
  const showBody = !upload || file
  const bodyField = showBody
    ? `<div class="field">
        <label for="sk-body">${esc(skill?.fileName || 'Skill 说明')}</label>
        <textarea class="input${skill || file ? ' satu-code' : ''}" id="sk-body" rows="${skill || file ? 14 : 6}" style="border-radius: var(--radius-md); resize: vertical;" placeholder="描述这个 Skill 解决什么问题、按什么步骤执行">${esc(f.body)}</textarea>
        <span style="font-size: 12px; color: var(--muted-foreground);">按步骤写：每一条列表项算一个步骤，现在是 ${steps} 个。</span>
      </div>`
    : ''
  const sourceRow = skill ? '' : pickRow('创建方式', SKILL_SOURCES, f.source, 'skill-source')
  const err = state.skillError
    ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${esc(state.skillError)}</div>`
    : ''
  const del = skill
    ? `<button type="button" class="satu-linkbtn" style="margin-right: auto; color: var(--color-accent-800);" data-act="skill-delete">删除这个 Skill</button>`
    : ''
  return `<div class="gw-modal-backdrop" data-act="skill-close">
    <form id="skill-form" class="gw-modal" style="max-width: 560px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${skill ? '编辑 Skill' : '新建 Skill'}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">Skill 把一组步骤和 MCP 工具打包成可复用的工作方法。</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="关闭" data-act="skill-close">${svg(CLOSE_ICON, 16)}</button>
      </div>
      <div class="field">
        <label for="sk-name">名称</label>
        <input class="input" id="sk-name" type="text" required value="${esc(f.name)}" placeholder="例如：工单归类与摘要">
      </div>
      ${sourceRow}
      ${uploadBlock}
      ${bodyField}
      ${skillTagPicker(known, f.tags || [])}
      ${skillEnableRow(f.enabled)}
      ${err}
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2);">
        ${del}
        <button type="button" class="btn btn-secondary" data-act="skill-close">取消</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? '保存中…' : skill ? '保存修改' : '保存'}</button>
      </div>
    </form>
  </div>`
}

function serverDialogView() {
  const d = state.skillDialog
  if (!d || d.type !== 'server') return ''
  const f = state.skillForm || emptyServerForm(d.item)
  const server = d.item
  const stdio = f.kind === 'stdio'
  const err = state.skillError
    ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${esc(state.skillError)}</div>`
    : ''
  const del = server
    ? `<button type="button" class="satu-linkbtn" style="margin-right: auto; color: var(--color-accent-800);" data-act="mcp-delete">移除这台服务器</button>`
    : ''
  const tokenHint = f.hasToken
    ? '已存了一把。留空表示不动它，填了就换成新的。'
    : '存在本机库里，不会再从服务端发回浏览器。'
  return `<div class="gw-modal-backdrop" data-act="skill-close">
    <form id="server-form" class="gw-modal" style="max-width: 520px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${server ? '编辑 MCP 服务器' : '接入 MCP 服务器'}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">接入之后，它提供的工具即可被 Agent 调用。</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="关闭" data-act="skill-close">${svg(CLOSE_ICON, 16)}</button>
      </div>
      <div class="field">
        <label for="tl-name">名称</label>
        <input class="input" id="tl-name" name="name" type="text" required value="${esc(f.name)}" placeholder="例如：zendesk-mcp">
      </div>
      ${pickRow('传输方式', MCP_KINDS.map((k) => ({ key: k, label: k })), f.kind, 'mcp-kind')}
      <div class="field">
        <label for="tl-endpoint">${stdio ? '启动命令' : '服务器地址'}</label>
        <input class="input" id="tl-endpoint" type="text" required value="${esc(f.endpoint)}" placeholder="${stdio ? 'npx -y @acme/mcp-server' : 'https://mcp.example.com/sse'}" ${stdio ? 'style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;"' : ''}>
        ${stdio ? '<span style="font-size: 12px; color: var(--muted-foreground);">本机启动的进程，按 stdio 通信</span>' : ''}
      </div>
      <div class="field">
        <label for="tl-token">鉴权 Token（可选）</label>
        <input class="input" id="tl-token" type="password" value="${esc(f.token)}" placeholder="${f.hasToken ? '••••••••' : 'Bearer …'}">
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(tokenHint)}</span>
      </div>
      <div class="field">
        <label for="tl-env">环境变量（JSON，可选）</label>
        <textarea class="input" id="tl-env" rows="3" style="border-radius: var(--radius-md); resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;" placeholder='{"WORKSPACE_ID":"acme"}'>${esc(f.env)}</textarea>
      </div>
      ${pickRow('权限', MCP_PERMS, f.perm, 'mcp-perm', '这一档现在只是登记，真正的拦截要等工具管线接上 MCP。')}
      ${skillEnableRow(f.enabled)}
      ${err}
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2);">
        ${del}
        <button type="button" class="btn btn-secondary" data-act="skill-close">取消</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? '保存中…' : server ? '保存修改' : '保存'}</button>
      </div>
    </form>
  </div>`
}

function skillsPage() {
  const tab = state.skillsTab === 'MCP 与工具' ? 'MCP 与工具' : 'Skill'
  const isSkill = tab === 'Skill'
  const skills = state.skills || []
  const servers = state.mcpServers || []
  const tabs = ['Skill', 'MCP 与工具']
    .map(
      (name) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === name)}" data-act="skills-tab" data-tab="${esc(name)}">${esc(name)}</button>`,
    )
    .join('')
  const failure = state.skillFailure
    ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-md); padding: 10px var(--space-4); display: flex; justify-content: space-between; gap: var(--space-3);">
        <span>${esc(state.skillFailure)}</span>
        <button type="button" class="satu-linkbtn" data-act="skill-dismiss">知道了</button>
      </div>`
    : ''
  let body
  if (isSkill) {
    body = skills.length
      ? `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-4);">${skills.map(skillCard).join('')}</div>`
      : skillEmpty('还没有 Skill', '点右上角新建一个：手动写，或导入一份 SKILL.md。')
  } else {
    const rows = servers
      .map(
        (s) => `<div class="satu-toolrow">
          <div style="min-width: 0; display: flex; flex-direction: column; gap: 2px;">
            <span style="font-weight: 600; font-size: 14px;">${esc(s.name)}</span>
            <span style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(s.endpoint)}</span>
          </div>
          <span style="font-size: 13px;">${esc(s.kind)}</span>
          <span style="font-size: 13px; color: var(--muted-foreground);" title="接上之后才知道">—</span>
          <span class="tag ${permTag(s.perm)}">${esc(s.perm)}</span>
          <span style="font-size: 13px; color: var(--muted-foreground);">${esc(dayISO(s.updatedAt))}</span>
          <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-1); justify-content: flex-end;">
            <button type="button" class="satu-switch" aria-pressed="${String(s.enabled !== false)}" aria-label="启用" data-act="mcp-toggle" data-id="${esc(s.id)}"><span></span></button>
            <button type="button" class="btn btn-ghost btn-icon" aria-label="编辑 MCP 服务器" data-act="mcp-edit" data-id="${esc(s.id)}">${svg(EDIT_ICON, 15)}</button>
          </div>
        </div>`,
      )
      .join('')
    const table = servers.length
      ? `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-toolhead">
            <span>MCP 服务器</span><span>传输</span><span>工具数</span><span>权限</span><span>更新时间</span><span></span>
          </div>
          ${rows}
        </div>`
      : skillEmpty('还没接入 MCP 服务器', '点右上角接入一台：填地址与权限，先把配置登记下来。')
    body = `<div style="display: flex; flex-direction: column; gap: var(--space-6);">
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <div style="display: flex; align-items: baseline; justify-content: space-between;">
          <h2 style="font-size: 18px; margin: 0;">内置工具</h2>
        </div>
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">内置工具在 Bot 运行时上，Gateway 这一屏不列。</div>
      </div>
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <div style="display: flex; align-items: baseline; justify-content: space-between;">
          <h2 style="font-size: 18px; margin: 0;">已接入 MCP 服务器</h2>
          <span style="font-size: 12px; color: var(--muted-foreground);">共 ${servers.length} 个</span>
        </div>
        ${table}
        <span style="font-size: 12px; color: var(--muted-foreground);">这里存的是连接配置。MCP 客户端还没接上，所以「工具数」要等真握上手才知道，先空着。</span>
      </div>
    </div>`
  }
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">Skill 与 MCP</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">Skill 是可复用的工作方法，MCP 服务器提供 AI 员工实际可调用的工具。</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" data-act="${isSkill ? 'skill-create' : 'mcp-create'}">
            ${svg(PLUS_ICON, 15)} ${isSkill ? '新建 Skill' : '接入 MCP'}
          </button>
        </div>
        ${flashes()}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          <span style="font-size: 12px; color: var(--muted-foreground);">分类</span>
          ${tabs}
        </div>
        ${failure}
        ${body}
      </div>
    </div>
    ${skillDialogView()}
    ${serverDialogView()}
    ${confirmModal()}`
}


function billingPage() {
  const data = state.billing || {
    plan: { name: '席位套餐', status: '生效中', cycle: '—', seats: '—', period: '—', renew: '—', amount: '—', autoRenew: false },
    invoices: [],
    balance: { amount: '—', spentThisMonth: '—', alertAt: '—' },
    topups: [],
  }
  const plan = data.plan || {}
  const tab = state.billingTab === 'topup' ? 'topup' : 'sub'
  const renewing = state.billingAutoRenew ?? !!plan.autoRenew
  const invoices = Array.isArray(data.invoices) ? data.invoices : []
  const topups = Array.isArray(data.topups) ? data.topups : []
  const balance = data.balance || { amount: '—', spentThisMonth: '—', alertAt: '—' }
  const tabs = [
    { key: 'sub', label: '订阅' },
    { key: 'topup', label: '充值' },
  ]
    .map(
      (item) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === item.key)}" data-act="billing-tab" data-tab="${item.key}">${item.label}</button>`,
    )
    .join('')
  const invoiceRows = invoices
    .map(
      (b) => `<div class="satu-billrow">
        <span style="font-size: 13.5px;">${esc(b.period)}</span>
        <span style="font-size: 13.5px;">${esc(b.amount)}</span>
        <span class="tag tag-accent-2">${esc(b.status)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(b.paid)}</span>
        <div style="display: flex; align-items: center; gap: var(--space-3); justify-content: flex-end;">
          <button type="button" class="satu-linkbtn" disabled title="发票开具还没做">发票</button>
        </div>
      </div>`,
    )
    .join('')
  const topupRows = topups
    .map(
      (row) => `<div class="satu-billrow">
        <span style="font-size: 13.5px;">${esc(row.time)}</span>
        <span style="font-size: 13.5px;">${esc(row.amount)}</span>
        <span class="tag tag-accent-2">${esc(row.status)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(row.method)}</span>
        <span></span>
      </div>`,
    )
    .join('')
  const empty = (msg) =>
    `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${esc(msg)}</div>`
  const subBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-6);">
          <div class="satu-panel">
            <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
              <div>
                <span class="satu-panel-title">当前订阅</span>
                <div style="display: flex; align-items: baseline; gap: var(--space-2); margin-top: 6px;">
                  <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(plan.name || '席位套餐')}</span>
                  <span class="tag tag-accent-2">${esc(plan.status || '生效中')}</span>
                </div>
                <p style="margin: 6px 0 0; font-size: 13px; color: var(--muted-foreground);">${esc(plan.cycle || '—')} · ${esc(plan.seats || '—')}</p>
              </div>
              <button type="button" class="btn btn-secondary" style="flex: none;" disabled title="订阅体系还没做">管理订阅</button>
            </div>
            <div class="satu-kv"><span>当前周期</span><span>${esc(plan.period || '—')}</span></div>
            <div class="satu-kv"><span>下次续订</span><span>${esc(plan.renew || '—')}</span></div>
            <div class="satu-kv"><span>周期费用</span><span>${esc(plan.amount || '—')}</span></div>
            <div class="satu-toggleRow">
              <div>
                <div style="font-size: 13.5px; font-weight: 600;">自动续订</div>
                <div style="font-size: 12px; color: var(--muted-foreground);">续订还没接，这个开关现在只是界面。</div>
              </div>
              <button type="button" class="satu-switch" aria-pressed="${String(renewing)}" aria-label="自动续订" data-act="billing-autorenew"><span></span></button>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; gap: var(--space-3);">
            <h2 style="font-size: 18px; margin: 0;">订阅账单</h2>
            <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
              <div class="satu-billhead">
                <span>账期</span><span>金额</span><span>状态</span><span>付款时间</span><span></span>
              </div>
              ${invoiceRows || empty('还没有订阅账单。支付接上之后，账期会列在这里。')}
            </div>
          </div>
        </div>`
  const topupBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-6);">
          <div class="satu-panel">
            <span class="satu-panel-title">账户余额</span>
            <div style="display: flex; align-items: baseline; gap: var(--space-3); margin-top: 6px;">
              <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(balance.amount || '—')}</span>
              <span style="font-size: 13px; color: var(--muted-foreground);">本月已用 ${esc(balance.spentThisMonth || '—')}</span>
            </div>
            <div class="satu-kv"><span>余额预警线</span><span>${esc(balance.alertAt || '—')}</span></div>
            <div style="display: flex; gap: var(--space-2);">
              <button type="button" class="btn btn-primary" disabled title="支付还没接">充值</button>
              <button type="button" class="btn btn-secondary" disabled title="支付还没接">设置预警</button>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; gap: var(--space-3);">
            <h2 style="font-size: 18px; margin: 0;">充值记录</h2>
            <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
              <div class="satu-billhead">
                <span>时间</span><span>金额</span><span>状态</span><span>方式</span><span></span>
              </div>
              ${topupRows || empty('还没有充值记录。')}
            </div>
          </div>
        </div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">账单</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">查看订阅状态、充值余额与历史账单。</p>
        </div>
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">${tabs}</div>
        ${flashes()}
        ${tab === 'sub' ? subBody : topupBody}
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">账单是公司产品层的事，不走 Bot 运行时。发票、扣款、充值都还没接，数字空着，不编。</p>
      </div>
    </div>`
}

function usageMeter(name, value, pct, alt, mono) {
  const font = mono ? ' font-family: ui-monospace, SFMono-Regular, Menlo, monospace;' : ''
  return `<div style="display: flex; flex-direction: column; gap: 5px;">
      <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3);">
        <span style="min-width: 0; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;${font}">${esc(name)}</span>
        <span style="flex: none; font-size: 12.5px; color: var(--muted-foreground);">${esc(value)}</span>
      </div>
      <div class="satu-meter"><div class="satu-meterfill" data-alt="${alt ? 'true' : 'false'}" style="width: ${Number(pct) || 0}%;"></div></div>
    </div>`
}

function usagePage() {
  const data = state.usage || {
    stats: [
      { label: '任务执行', value: '0', delta: '—' },
      { label: '输入 Tokens', value: '0', delta: '—' },
      { label: '输出 Tokens', value: '0', delta: '—' },
      { label: '费用', value: '—', delta: '—' },
    ],
    daily: [],
    byAgent: [],
    byModel: [],
    quota: [],
    seats: 0,
    byMember: [],
  }
  const ranges = ['近 7 天', '近 30 天', '本月']
  const range = state.usageRange || '近 30 天'
  const stats = Array.isArray(data.stats) ? data.stats : []
  const daily = Array.isArray(data.daily) ? data.daily : []
  const byAgent = Array.isArray(data.byAgent) ? data.byAgent : []
  const byModel = Array.isArray(data.byModel) ? data.byModel : []
  const byMember = Array.isArray(data.byMember) ? data.byMember : []
  const seats = Number(data.seats) || 0
  const empty = (msg) =>
    `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${esc(msg)}</div>`
  const pills = ranges
    .map(
      (r) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(range === r)}" data-act="usage-range" data-range="${esc(r)}">${esc(r)}</button>`,
    )
    .join('')
  const statCards = stats
    .map(
      (s) => `<div class="satu-stat">
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(s.label)}</span>
        <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(s.value)}</span>
        <span style="font-size: 11.5px; color: var(--color-accent-2-800);">${esc(s.delta || '—')}</span>
      </div>`,
    )
    .join('')
  const dailyBody = daily.length
    ? (() => {
        const peak = Math.max(...daily.map((d) => Number(d.value) || 0), 0)
        const cols = daily
          .map((d) => {
            const v = Number(d.value) || 0
            const h = peak ? Math.round((v / peak) * 100) : 0
            return `<div class="satu-barcol" title="${esc(`${d.label} · ${v} 次`)}">
                <div class="satu-barstack">
                  <div class="satu-barfill" style="height: ${h}%;"></div>
                </div>
                <span class="satu-barlabel">${esc(d.label)}</span>
              </div>`
          })
          .join('')
        return `<div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
            <span class="satu-panel-title">每日任务执行量</span>
            <span style="font-size: 12px; color: var(--muted-foreground);">峰值 ${peak} 次</span>
          </div>
          <div class="satu-bars">${cols}</div>`
      })()
    : `<span class="satu-panel-title">每日任务执行量</span>
          ${empty('还没有每日用量。实例上报之后会画在这里。')}`
  const agentBody = byAgent.length
    ? byAgent.map((a) => usageMeter(a.name, a.value, a.pct, false, false)).join('')
    : empty('还没有按 Bot 的用量。')
  const modelBody = byModel.length
    ? byModel.map((m) => usageMeter(m.name, m.value, m.pct, true, true)).join('')
    : empty('还没有按模型的用量。')
  const memberRows = byMember
    .map(
      (m) => `<div class="satu-usagerow">
        <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
          <span class="satu-avatar" style="width: 26px; height: 26px; font-size: 11px; background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc(m.initial || initialOf(m))}</span>
          <span style="min-width: 0; font-size: 13.5px;">${esc(m.name)}</span>
        </div>
        <span style="font-size: 13px;">${esc(m.tasks)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(m.tokens)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(m.fail)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(m.last)}</span>
      </div>`,
    )
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">用量统计</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(range)} · ${esc((Number((stats.find((x) => x.label === '任务执行') || {}).value) || 0) > 0 ? '已记录调用' : '还没有调用')}</p>
          </div>
          <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
            ${pills}
            <button type="button" class="btn btn-secondary" disabled title="导出需要统计投影">导出 CSV</button>
          </div>
        </div>
        ${flashes()}
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--space-3);">
          ${statCards}
        </div>
        <div class="satu-panel">
          ${dailyBody}
        </div>
        <div class="satu-agentpair">
          <div class="satu-panel">
            <span class="satu-panel-title">按 Bot</span>
            ${agentBody}
          </div>
          <div class="satu-panel">
            <span class="satu-panel-title">按模型</span>
            ${modelBody}
          </div>
        </div>
        <div class="satu-panel">
          <div>
            <span class="satu-panel-title">套餐额度</span>
            <p style="margin: 6px 0 0; font-size: 13px; color: var(--muted-foreground);">当前套餐只约束席位（${seats} 个），还没有任务次数和 token 额度。</p>
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <h2 style="font-size: 18px; margin: 0;">成员用量</h2>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-usagehead">
              <span>成员</span><span>任务</span><span>Tokens</span><span>失败率</span><span>最近使用</span>
            </div>
            ${memberRows || empty('还没有成员。')}
          </div>
        </div>
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">费用还没有账单，显示 —。调用次数和 token 来自 Gateway 记下的 llm_calls，没有就 0。</p>
      </div>
    </div>`
}


let chatAbort = null
let chatStreamId = ''

function messageText(msg) {
  if (!msg) return ''
  if (typeof msg === 'string') return msg
  const content = msg.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && (b.type === 'text' || b.type === 'reasoning') ? b.text || '' : ''))
    .join('')
}

function fold(events) {
  const blocks = []
  let assistant = null
  let tools = []
  let status = ''
  for (const ev of events || []) {
    const type = ev.type
    const data = ev.data || {}
    if (type === 'user/message') {
      if (data.source && data.source.kind && data.source.kind !== 'user') continue
      assistant = null
      tools = []
      blocks.push({ kind: 'user', text: messageText(data.message) || data.text || '' })
    } else if (type === 'assistant/message') {
      const text = messageText(data.message)
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools }
        blocks.push(assistant)
      }
      if (text) assistant.text = text
    } else if (type === 'assistant/chunk') {
      const chunk = data.chunk || {}
      if (chunk.type === 'text-delta' && chunk.text) {
        if (!assistant) {
          assistant = { kind: 'assistant', text: '', tools }
          blocks.push(assistant)
        }
        assistant.text += chunk.text
      }
    } else if (type === 'tool/call') {
      tools.push({ callId: data.callId, name: data.name || 'tool', result: null })
      if (assistant) assistant.tools = tools
    } else if (type === 'tool/result') {
      const hit =
        tools.find((x) => x.callId && x.callId === data.callId && x.result == null) ||
        tools.find((x) => x.result == null) ||
        tools[tools.length - 1]
      if (hit) hit.result = data.text || ''
    } else if (type === 'turn/start') {
      status = 'running'
    } else if (type === 'turn/end') {
      status = ''
    }
  }
  return { blocks, status }
}

function stopChatStream() {
  if (chatAbort) {
    try {
      chatAbort.abort()
    } catch {}
  }
  chatAbort = null
  chatStreamId = ''
}

async function loadRuntimeBots() {
  state.runtimeError = ''
  try {
    const data = await api('GET', '/runtime/bots')
    state.runtimeBots = data.bots || []
  } catch (err) {
    state.runtimeBots = []
    throw err
  }
}

async function loadRuntimeMachine() {
  const id = orgId()
  if (!id || isOwner()) {
    state.runtimeMachine = null
    return
  }
  try {
    const data = await api('GET', `/orgs/${encodeURIComponent(id)}/machine`)
    state.runtimeMachine = data.machine || null
  } catch {
    state.runtimeMachine = null
  }
}

async function loadDesktopRuntime(botId) {
  const id = botId || chatBotIdOf(state.path) || state.chatBotId
  if (isOwner() || !id) {
    state.desktopRuntime = null
    return
  }
  try {
    state.desktopRuntime = await api('GET', '/runtime/desktop?botId=' + encodeURIComponent(id))
  } catch {
    state.desktopRuntime = null
  }
}

async function ensureChatSession(botId) {
  if (!botId) return
  if (state.chatBotId === botId && state.chatSessionId && chatStreamId === state.chatSessionId) return
  state.chatBotId = botId
  try {
    const data = await api('GET', '/runtime/bots/' + encodeURIComponent(botId) + '/session')
    const sessionId = data.sessionId
    if (!sessionId) throw new Error('没有会话')
    if (state.chatSessionId !== sessionId) {
      state.chatEvents = []
      state.chatStatus = ''
    }
    state.chatSessionId = sessionId
    void startChatStream(sessionId)
  } catch (err) {
    const msg = String(err.message || '')
    if (msg.includes('实例还没上线')) state.runtimeError = '实例还没上线'
    else throw err
  }
}

async function loadChatPage() {
  await Promise.all([loadRuntimeBots(), loadRuntimeMachine()])
  const botId = chatBotIdOf(state.path)
  await loadDesktopRuntime(botId)
  if (botId) await ensureChatSession(botId)
  else if (!memberChatHome() || state.path === '/chat') {
    /* 名单页，不断流也可以，但换页时停掉以免后台烧连接 */
    if (!botId) stopChatStream()
  }
}

async function startChatStream(sessionId) {
  if (chatStreamId === sessionId && chatAbort) return
  stopChatStream()
  const ac = new AbortController()
  chatAbort = ac
  chatStreamId = sessionId
  const t = token()
  let res
  try {
    res = await fetch('/runtime/sessions/' + encodeURIComponent(sessionId) + '/events', {
      headers: {
        accept: 'text/event-stream',
        ...(t ? { authorization: 'Bearer ' + t } : {}),
      },
      signal: ac.signal,
    })
  } catch (err) {
    if (ac.signal.aborted) return
    state.runtimeError = '实例还没上线'
    paintChat()
    return
  }
  if (res.status === 503) {
    state.runtimeError = '实例还没上线'
    paintChat()
    return
  }
  if (!res.ok || !res.body) {
    state.runtimeError = (await res.text().catch(() => '')) || '实例还没上线'
    paintChat()
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      buf = buf.replace(/\r\n/g, '\n')
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue
          let ev
          try {
            ev = JSON.parse(line.slice(6))
          } catch {
            continue
          }
          if (!ev || typeof ev !== 'object') continue
          state.chatEvents = state.chatEvents.concat(ev)
          paintChat()
        }
      }
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      /* 流断了就停，下一次打开会话会重连 */
    }
  }
}

function paintChat() {
  const thread = document.getElementById('chat-thread')
  const status = document.getElementById('chat-status')
  const folded = fold(state.chatEvents)
  state.chatStatus = folded.status
  if (thread) thread.innerHTML = chatThreadHtml(folded)
  if (status) status.textContent = folded.status ? '正在思考…（可以继续输入来打断）' : ''
  if (thread) thread.scrollTop = thread.scrollHeight
}

function chatThreadHtml(folded) {
  const blocks = folded.blocks || []
  if (!blocks.length && !folded.status) {
    return `<p class="gw-chat-empty">继续这段对话…</p>`
  }
  return blocks
    .map((b) => {
      if (b.kind === 'user') {
        return `<div class="satu-msg" data-role="user"><div class="satu-bubble" data-role="user">${esc(b.text)}</div></div>`
      }
      const tools = (b.tools || [])
        .map((x) => {
          const label = x.result != null ? x.name + ' · 完成' : x.name + ' · 调用中'
          return `<div class="satu-step">${esc(label)}</div>`
        })
        .join('')
      const steps = tools ? `<div class="satu-steps">${tools}</div>` : ''
      return `<div class="satu-msg" data-role="assistant">${steps}<div class="satu-bubble" data-role="assistant">${esc(b.text)}</div></div>`
    })
    .join('')
}

function deployBotButton(botId) {
  if (!botId) return ''
  return `<button type="button" class="btn btn-primary" data-act="runtime-deploy" data-bot="${esc(botId)}" ${state.deploying ? 'disabled' : ''} style="margin-top: 8px;">${state.deploying ? '部署中…' : '部署这个 Bot'}</button>`
}

function runtimeDownBanner() {
  const selected = chatBotIdOf(state.path) || state.chatBotId
  const mine = state.desktopRuntime
  const mineBox = mine && mine.status === 'ready'
    ? `<div class="satu-panel" style="margin-bottom: var(--space-2);">
        <span class="satu-panel-title">我的环境</span>
        <div class="satu-kv"><span>linuxUser</span><span>${esc(mine.linuxUser || '—')}</span></div>
        ${mine.botVersion ? `<div class="satu-kv"><span>Bot 版本</span><span>${esc(mine.botVersion)}</span></div>` : ''}
        <div class="satu-kv"><span>noVNC</span><span style="word-break: break-all;">${esc(mine.novncUrl || '—')}</span></div>
        <div class="satu-kv"><span>VNC 密码</span><span>${esc(state.seatReveal ? (mine.vncPassword || '—') : '••••••••')} <button type="button" class="satu-linkbtn" data-act="seat-reveal">${state.seatReveal ? '隐藏' : '显示'}</button></span></div>
      </div>`
    : ''
  if (mine && mine.status === 'error') {
    return `${mineBox}<div class="gw-flash gw-flash-err">${esc(mine.lastError || '部署失败')}
      <div>${deployBotButton(selected)}</div></div>`
  }
  if (!state.runtimeError || !String(state.runtimeError).includes('实例还没上线')) {
    return (state.runtimeError ? `<div class="gw-flash gw-flash-err">${esc(state.runtimeError)}</div>` : '') + mineBox
  }
  const bound = !!(state.runtimeMachine && (state.runtimeMachine.sshHost || state.runtimeMachine.hasSshAuth))
  if (!bound) {
    return `<div class="gw-flash gw-flash-err">公司还没有绑定运行机器，请系统管理员在公司详情里配置。</div>`
  }
  const hint = state.deployHint ? `<p style="margin: 8px 0 0; font-size: 12px;">${esc(state.deployHint)}</p>` : ''
  return `<div class="gw-flash gw-flash-err">
    <div>实例还没上线</div>
    ${deployBotButton(selected)}
    ${hint}
  </div>${mineBox}`
}

function chatPage() {
  const bots = state.runtimeBots || []
  const selected = chatBotIdOf(state.path) || state.chatBotId
  const banner = runtimeDownBanner()
  const roster =
    bots.length === 0
      ? `<p class="gw-chat-empty">还没有 Bot。公司后台配置并上线后会出现在这里。</p>`
      : bots
          .map((b) => {
            const current = b.id === selected
            return `<button type="button" class="satu-nav" data-act="chat-open" data-id="${esc(b.id)}" aria-current="${current}">
              ${svg(AGENT_ICONS[b.icon] || AGENT_ICONS.bot)}
              <span class="satu-label">${esc(b.name || b.id)}</span>
            </button>`
          })
          .join('')
  const folded = fold(state.chatEvents)
  const main = !selected
    ? `<div class="gw-chat-empty-main"><p>选一个 Bot 开始对话。</p></div>`
    : `<div class="gw-chat-thread" id="chat-thread">${chatThreadHtml(folded)}</div>
        <div class="gw-chat-composer">
          <div id="chat-status" class="gw-chat-status">${folded.status ? '正在思考…（可以继续输入来打断）' : ''}</div>
          <form id="chat-form" class="gw-chat-form">
            <textarea id="chat-input" class="satu-prompt satu-grow" rows="1" placeholder="输入消息" >${esc(state.chatDraft || '')}</textarea>
            <div class="gw-chat-actions">
              <button type="button" class="btn btn-ghost" data-act="chat-abort">中止</button>
              <button type="submit" class="btn btn-primary">发送</button>
            </div>
          </form>
        </div>`
  return `
    <div class="gw-chat">
      <aside class="gw-chat-roster">
        ${banner}
        ${roster}
      </aside>
      <section class="gw-chat-main">${main}</section>
    </div>`
}

async function sendChat() {
  const text = (state.chatDraft || '').trim()
  if (!text || !state.chatSessionId) return
  state.chatDraft = ''
  const input = document.getElementById('chat-input')
  if (input) {
    input.value = ''
    input.style.height = ''
  }
  try {
    await api('POST', '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/messages', { text })
  } catch (err) {
    state.chatDraft = text
    if (String(err.message || '').includes('实例还没上线')) state.runtimeError = '实例还没上线'
    else flash('err', err.message)
    render()
  }
}

async function abortChat() {
  if (!state.chatSessionId) return
  try {
    await api('POST', '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/abort', {})
  } catch {}
}

async function publishRelease(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const version = String(fd.get('version') || '').trim()
  const note = String(fd.get('note') || '').trim()
  if (!version) return
  state.busy = true
  render()
  try {
    await api('POST', '/platform/bot-releases', note ? { version, note } : { version })
    await loadReleases()
    flash('ok', '已发布 ' + version)
    e.target.reset()
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function updateOrgRuntime() {
  const org = state.org && state.org.id
  if (!org || state.updatingRuntime) return
  const version = state.updateVersion || state.latestRelease
  if (!version) {
    flash('err', '还没有发布 Bot 版本')
    render()
    return
  }
  state.updatingRuntime = true
  render()
  try {
    const data = await api('POST', `/platform/orgs/${encodeURIComponent(org)}/runtime/update`, { version })
    const results = Array.isArray(data.results) ? data.results : []
    const ok = results.filter((r) => r.status === 'ready' && !r.error).length
    const bad = results.filter((r) => r.error || r.status === 'error').length
    if (!results.length) flash('ok', `没有需要更新的席位`)
    else flash(bad && !ok ? 'err' : 'ok', `更新 ${data.version}：成功 ${ok}，失败 ${bad}`)
    await loadCompanyDetail(org)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.updatingRuntime = false
    render()
  }
}

async function deployMyRuntime(botId) {
  const id = botId || chatBotIdOf(state.path) || state.chatBotId
  if (state.deploying || isOwner() || !id) return
  state.deploying = true
  state.deployHint = '正在部署…'
  render()
  try {
    await api('POST', '/runtime/deploy', { botId: id })
    const startAt = Date.now()
    while (Date.now() - startAt < 15000) {
      try {
        const rt = await api('GET', '/runtime/desktop?botId=' + encodeURIComponent(id))
        state.desktopRuntime = rt
        if (rt.status === 'ready' || rt.status === 'error') break
      } catch {}
      await new Promise((r) => setTimeout(r, 400))
    }
    await loadRuntimeBots()
    if (state.chatBotId === id || chatBotIdOf(state.path) === id) {
      state.runtimeError = ''
      await ensureChatSession(id)
    }
    if (state.desktopRuntime && state.desktopRuntime.status === 'error') {
      state.deployHint = state.desktopRuntime.lastError || '部署失败'
    } else if (!state.runtimeError) {
      state.deployHint = ''
      flash('ok', '已部署')
    } else {
      state.deployHint = '已登记，实例还在上线'
    }
  } catch (err) {
    state.deployHint = err.message
    flash('err', err.message)
  } finally {
    state.deploying = false
    render()
  }
}

function pageView() {
  if (state.path.startsWith('/bots/')) return botDetailPage()
  if (state.path.startsWith('/companies/') && state.path !== '/companies') return companyDetailPage()
  if (state.path.startsWith('/users/') && state.path !== '/users') return userDetailPage()
  if (state.path.startsWith('/audit/') && state.path !== '/audit') return auditDetailPage()
  if (isChatPath(state.path)) return chatPage()
  switch (state.path) {
    case '/bots':
      return botsPage()
    case '/skills':
      return skillsPage()
    case '/models':
      return modelsPage()
    case '/providers':
      return providersPage()
    case '/company':
      return companyPage()
    case '/accounts':
      return accountsPage()
    case '/audit':
      return auditPage()
    case '/releases':
      return releasesPage()
    case '/companies':
      return companiesPage()
    case '/users':
      return usersPage()
    case '/plans':
      return plansPage()
    case '/stats':
      return placeholderPage('统计', '用量统计稍后接实例上报')
    case '/billing':
    case '/costs':
      return billingPage()
    case '/usage':
      return usagePage()
    case '/catalog':
      return placeholderPage('公司目录', '公司 Bot / Skill / MCP')
    case '/profile':
      return profilePage()
    default:
      return overviewPage()
  }
}

function appView() {
  const rail = state.rail
  const title = state.path.startsWith('/bots/')
    ? 'Bot 详情'
    : state.path.startsWith('/companies/') && state.path !== '/companies'
      ? '公司详情'
      : state.path.startsWith('/users/') && state.path !== '/users'
        ? '账号详情'
        : state.path.startsWith('/audit/') && state.path !== '/audit'
          ? '对话'
          : isChatPath(state.path) || (memberChatHome() && state.path === '/')
            ? '对话'
            : PATHS[state.path]?.title || 'Satuwork'
  const back = state.path.startsWith('/bots/')
    ? `<button type="button" class="satu-linkbtn" style="flex: none; margin-left: auto;" data-act="go" data-href="/bots">返回 Bot 列表</button>`
    : state.path.startsWith('/companies/') && state.path !== '/companies'
      ? `<button type="button" class="satu-linkbtn" style="flex: none; margin-left: auto;" data-act="go" data-href="/companies">返回公司列表</button>`
      : state.path.startsWith('/users/') && state.path !== '/users'
        ? `<button type="button" class="satu-linkbtn" style="flex: none; margin-left: auto;" data-act="go" data-href="/users">返回用户列表</button>`
        : state.path.startsWith('/audit/') && state.path !== '/audit'
          ? `<button type="button" class="satu-linkbtn" style="flex: none; margin-left: auto;" data-act="go" data-href="/audit">返回审计</button>`
          : ''
  const account = state.me?.account || {}
  const email = account.email || ''
  const displayName = account.name || email || '…'
  const initial = initialOf(account)
  const nav = navForRole()
  const home = nav[0]
  const rest = nav.slice(1)
  const groupLabel = isOwner() ? '平台' : isAdmin() ? '公司' : ''
  const mainNav = navItem(home)
  const restNav = rest.map(navItem).join('')
  return `
  <div style="height: 100vh; overflow: hidden; display: grid; grid-template-columns: ${rail ? '62px' : '248px'} 1fr; gap: var(--space-4); padding: var(--space-4); background: var(--color-bg); font-family: var(--font-body); color: var(--color-text); box-sizing: border-box;">
    <aside class="${rail ? 'satu-rail' : ''}" style="height: 100%; min-height: 0; overflow: hidden; box-sizing: border-box; display: flex; flex-direction: column; background: var(--color-surface); border-radius: var(--radius-md); padding: var(--space-4) var(--space-2) var(--space-2);">
      <button type="button" class="satu-brand" data-act="go" data-href="/" style="display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3) var(--space-4); border: 0; background: transparent; cursor: pointer; color: inherit;">
        <img src="/assets/satuwork-logo.png" alt="Satuwork" style="width: 32px; height: 32px; min-width: 32px; flex: none; object-fit: contain; border-radius: var(--radius-sm);">
        <span class="satu-brandtext" style="font-family: var(--font-heading); font-size: 19px;">Satuwork</span>
      </button>
      <div style="flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;">
        ${mainNav}
        ${
          rest.length
            ? `<div class="satu-navgroup">
          <div class="satu-sep"></div>
          ${groupLabel ? `<p class="satu-group">${esc(groupLabel)}</p>` : ''}
          ${restNav}
        </div>`
            : ''
        }
      </div>
      <div class="satu-userrow" style="display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3); margin-top: var(--space-2); border-top: 1px solid var(--color-divider);">
        <div style="width: 30px; height: 30px; flex: none; border-radius: 999px; background: var(--color-accent-200); display: flex; align-items: center; justify-content: center; font-family: var(--font-heading); font-size: 13px; color: var(--color-accent-800);">${esc(initial)}</div>
        <div class="satu-userinfo" style="line-height: 1.25; min-width: 0; flex: 1;">
          <div style="font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(displayName)}</div>
          <div style="font-size: 11px; color: color-mix(in srgb, var(--color-text) 50%, transparent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(email)}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-icon satu-usercog" style="flex: none;" data-act="go" data-href="/profile" aria-label="个人设置" aria-pressed="${String(state.path === '/profile')}">${svg(GEAR, 16)}</button>
      </div>
    </aside>
    <main style="min-width: 0; height: 100%; min-height: 0; box-sizing: border-box; overflow: hidden; background: var(--color-neutral-100); border: 1px solid var(--color-divider); border-radius: var(--radius-md); display: flex; flex-direction: column;">
      <div style="flex: none; display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-6); border-bottom: 1px solid var(--color-divider);">
        <button type="button" class="btn btn-ghost btn-icon" data-act="rail" aria-label="${rail ? '展开侧栏' : '收起侧栏'}">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
        </button>
        <div style="width: 1px; height: 18px; background: var(--color-divider);"></div>
        <span style="font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(title)}</span>
        ${back}
      </div>
      ${pageView()}
    </main>
  </div>`
}

function render() {
  const root = document.getElementById('app')
  if (state.path.startsWith('/join/')) {
    root.innerHTML = joinView()
    return
  }
  root.innerHTML = state.me ? appView() : loginView()
}

async function saveProfile() {
  if (!profileDirty()) return
  const form = profileForm()
  state.busy = true
  state.profileError = ''
  render()
  try {
    await api('PATCH', '/me', { name: form.name, title: form.title, phone: form.phone })
    state.profileDraft = null
    state.profileSaved = true
    await loadMe()
  } catch (err) {
    state.profileError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function submitPassword(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const current = String(fd.get('current') || '')
  const next = String(fd.get('next') || '')
  const confirm = String(fd.get('confirm') || '')
  state.pwForm = { current, next, confirm }
  if (next !== confirm) {
    state.pwError = t('两次输入的新口令不一致', 'The two new passwords do not match')
    render()
    return
  }
  state.busy = true
  state.pwError = ''
  render()
  try {
    const data = await api('POST', '/me/password', { current, next })
    if (data.token) setToken(data.token)
    state.pwOpen = false
    state.pwForm = { current: '', next: '', confirm: '' }
    state.profileSaved = true
    await loadMe()
  } catch (err) {
    state.pwError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function onLogin(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const email = String(fd.get('email') || '').trim()
  const password = String(fd.get('password') || '')
  state.busy = true
  state.loginError = ''
  state.loginEmail = email
  render()
  try {
    const data = await api('POST', '/auth/login', { email, password })
    if (!data.token) throw new Error('登录响应没有 token')
    setToken(data.token)
    await loadMe()
    state.path = '/'
    history.replaceState({}, '', '/')
    flash('ok', '')
    await loadPage()
  } catch (err) {
    clearToken()
    state.me = null
    state.loginError = err.message || '登录失败'
  } finally {
    state.busy = false
    render()
  }
}

async function saveSettings(patch) {
  const next = {
    daily: { ...(state.settings.daily || { provider: '', model: '' }) },
    utility: { ...(state.settings.utility || { provider: '', model: '' }) },
    enabledModels: Array.isArray(state.settings.enabledModels) ? state.settings.enabledModels : [],
    ...patch,
  }
  if (patch.daily) next.daily = patch.daily
  if (patch.utility) next.utility = patch.utility
  state.settings = next
  render()
  try {
    const path = isOwner() ? '/platform/settings' : `/orgs/${encodeURIComponent(orgId())}/settings`
    state.settings = await api('PUT', path, next)
    if (state.me) state.me.settings = state.settings
    flash('ok', '已保存模型角色')
  } catch (err) {
    flash('err', err.message)
  }
  render()
}

async function testLlm(kind, payload) {
  const key = kind === 'role' ? `role:${payload.role}` : `provider:${payload.provider}`
  state.tests[key] = { status: 'busy', text: '测试中…' }
  render()
  try {
    const path = isOwner() ? '/platform/llm/test' : `/orgs/${encodeURIComponent(orgId())}/llm/test`
    const data = await api('POST', path, payload)
    if (data.ok) {
      const text = `通了 ${data.latencyMs}ms · ${data.provider}/${data.model}`
      state.tests[key] = { status: 'ok', text }
      flash('ok', text)
    } else {
      const text = data.error || '不通'
      state.tests[key] = { status: 'err', text }
      flash('err', text)
    }
  } catch (err) {
    state.tests[key] = { status: 'err', text: err.message }
    flash('err', err.message)
  }
  render()
}

async function saveCred(provider, secret, credId) {
  state.busy = true
  render()
  try {
    if (isOwner()) {
      const exists = (state.creds || []).some((c) => c.provider === provider) || !!credId
      if (exists) await api('PUT', `/platform/credentials/${encodeURIComponent(provider)}`, { secret })
      else await api('POST', '/platform/credentials', { provider, secret })
    } else {
      throw new Error('供应商由系统管理员配置')
    }
    await loadCreds()
    state.addOpen = false
    flash('ok', '已配置')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function saveCompany(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const id = orgId()
  const name = String(fd.get('name') || '').trim()
  const slug = String(fd.get('slug') || '').trim()
  const accessUrl = String(fd.get('accessUrl') || '').trim()
  state.busy = true
  render()
  try {
    await api('PATCH', `/orgs/${encodeURIComponent(id)}`, { name, slug, accessUrl: accessUrl || null })
    await loadOrg()
    await loadMe()
    flash('ok', '已保存')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function submitAuditFilter(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  state.sessionAccountId = String(fd.get('accountId') || '').trim()
  state.sessionFrom = String(fd.get('from') || '')
  state.sessionTo = String(fd.get('to') || '')
  try {
    await loadSessions()
  } catch (err) {
    flash('err', err.message)
  }
  render()
}

async function createOrg(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const body = {
    name: String(fd.get('name') || '').trim(),
    slug: String(fd.get('slug') || '').trim(),
    seats: Number(fd.get('seats')),
    adminEmail: String(fd.get('adminEmail') || '').trim(),
    adminPassword: String(fd.get('adminPassword') || ''),
  }
  state.busy = true
  render()
  try {
    await api('POST', '/platform/orgs', body)
    state.orgCreateOpen = false
    await loadOrgs()
    flash('ok', '已创建公司')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function saveMachine(e) {
  e.preventDefault()
  const form = e.target
  const id = form.getAttribute('data-id')
  const fd = new FormData(form)
  const body = {
    sshHost: String(fd.get('sshHost') || '').trim(),
    sshPort: Number(fd.get('sshPort') || 22),
    sshUser: String(fd.get('sshUser') || '').trim() || 'debian',
    sshAuth: String(fd.get('sshAuth') || 'password'),
  }
  const secret = String(fd.get('sshSecret') || '')
  if (secret) body.sshSecret = secret
  state.busy = true
  render()
  try {
    const data = await api('PUT', `/platform/orgs/${encodeURIComponent(id)}/machine`, body)
    state.machine = data.machine || null
    flash('ok', '已保存运行机器')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function savePlan(e) {
  e.preventDefault()
  const form = e.target
  const id = form.getAttribute('data-id')
  const seats = Number(new FormData(form).get('seats'))
  state.busy = true
  render()
  try {
    await api('PUT', `/platform/orgs/${encodeURIComponent(id)}/plan`, { seats })
    await loadOrgs()
    if (state.path.startsWith('/companies/') && companyIdOfPath(state.path) === id) {
      await loadCompanyDetail(id)
    }
    flash('ok', '已保存席位')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}


function orgAccountsPath(extra) {
  const id = orgId()
  return `/orgs/${encodeURIComponent(id)}/accounts${extra || ''}`
}

function memberById(id) {
  return (state.accounts || []).find((m) => m.id === id)
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function closeMemberUi() {
  state.orgCreateOpen = false
  state.inviteOpen = false
  state.inviteLink = ''
  state.inviteError = ''
  state.editing = null
  state.editLink = ''
  state.editCopied = false
  state.menu = null
  state.confirm = null
  state.secret = null
  state.groupDialog = null
  state.groupError = ''
}

async function submitInvite(e) {
  e.preventDefault()
  if (state.inviteLink) {
    const ok = await copyText(state.inviteLink)
    state.inviteCopied = ok
    state.inviteError = ok ? '' : '复制失败，请手动选中上面的链接复制。'
    render()
    return
  }
  const fd = new FormData(e.target)
  state.inviteForm = {
    name: String(fd.get('name') || '').trim(),
    email: String(fd.get('email') || '').trim(),
    role: String(fd.get('role') || 'member'),
    ttlDays: Number(fd.get('ttlDays') || 7),
  }
  state.busy = true
  state.inviteError = ''
  render()
  try {
    const data = await api('POST', orgAccountsPath('/members'), {
      name: state.inviteForm.name,
      email: state.inviteForm.email,
      role: state.inviteForm.role,
      ttlDays: state.inviteForm.ttlDays,
    })
    state.inviteLink = data.invite?.url || ''
    state.inviteEmail = data.user?.email || state.inviteForm.email
    state.inviteExpiresAt = data.invite?.expiresAt || 0
    const ok = state.inviteLink ? await copyText(state.inviteLink) : false
    state.inviteCopied = ok
    if (!ok && state.inviteLink) state.inviteError = '复制失败，请手动选中上面的链接复制。'
  } catch (err) {
    state.inviteError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function submitEdit(e) {
  e.preventDefault()
  const member = state.editing
  if (!member) return
  const fd = new FormData(e.target)
  const name = String(fd.get('name') || '').trim()
  const isSelf = member.id === memberMeId()
  const body = { name }
  if (!isSelf) {
    if (state.editForm.role !== member.role) body.role = state.editForm.role
    if (state.editForm.status !== member.status) body.status = state.editForm.status
  }
  state.busy = true
  render()
  try {
    await api('PATCH', orgAccountsPath('/' + encodeURIComponent(member.id)), body)
    state.editing = null
    state.editLink = ''
    await loadAccounts()
    flash('ok', '已保存')
  } catch (err) {
    flash('err', err.message)
    state.editing = null
  } finally {
    state.busy = false
    render()
  }
}

async function submitGroup(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const name = String(fd.get('name') || '').trim()
  const desc = String(fd.get('desc') || '').trim()
  state.groupForm = { ...state.groupForm, name, desc }
  state.groupError = ''
  if (!name) {
    state.groupError = '分组要有名字'
    render()
    return
  }
  const body = {
    name,
    desc,
    icon: state.groupForm.icon || 'chat',
    role: state.groupForm.role === 'admin' ? 'admin' : 'member',
    members: state.groupForm.members || [],
  }
  state.busy = true
  render()
  try {
    const id = state.groupDialog && state.groupDialog.id
    if (id) await api('PATCH', orgAccountsPath('/groups/' + encodeURIComponent(id)), body)
    else await api('POST', orgAccountsPath('/groups'), body)
    state.groupDialog = null
    state.groupError = ''
    await loadAccounts()
  } catch (err) {
    state.groupError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function submitJoin(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const name = String(fd.get('name') || '').trim()
  const password = String(fd.get('password') || '')
  const confirm = String(fd.get('confirm') || '')
  state.joinForm = { name, password: '', confirm: '' }
  state.joinError = ''
  if (password !== confirm) {
    state.joinError = '两次输入的口令不一致'
    render()
    return
  }
  if (password.length < 10) {
    state.joinError = '口令至少 10 位'
    render()
    return
  }
  state.busy = true
  render()
  try {
    const data = await api('POST', `/invites/${encodeURIComponent(joinToken())}/accept`, { name, password })
    if (!data.token) throw new Error('加入响应没有 token')
    setToken(data.token)
    await loadMe()
    state.path = '/'
    history.replaceState({}, '', '/')
    await loadPage()
  } catch (err) {
    state.joinError = err.message || '加入失败'
  } finally {
    state.busy = false
    render()
  }
}

async function resetMember(id, viaEdit) {
  const m = memberById(id) || state.editing
  if (!m) return
  try {
    const data = await api('POST', orgAccountsPath('/' + encodeURIComponent(m.id) + '/reset'))
    const invite = data.invite || {}
    if (viaEdit) {
      state.editLink = invite.url || ''
      state.editCopied = false
    } else {
      state.secret = {
        title: m.status === 'invited' ? '新的邀请链接' : '口令重设链接',
        email: m.email,
        url: invite.url,
        expiresAt: invite.expiresAt,
      }
      state.inviteCopied = false
      state.menu = null
    }
    render()
  } catch (err) {
    flash('err', err.message)
    state.menu = null
    render()
  }
}

async function submitSkill(e) {
  e.preventDefault()
  syncSkillForm()
  const f = state.skillForm
  const id = orgId()
  if (!id || !f) return
  const payload = {
    name: f.name,
    body: f.body,
    tags: f.tags,
    enabled: f.enabled,
    source: f.source,
    fileName: (state.skillFile && state.skillFile.name) || f.fileName,
  }
  if (f.source === 'ZIP 包' && state.skillEntries && window.satuUnzip) {
    payload.files = window.satuUnzip.toPayload(state.skillEntries).filter((x) => typeof x.text === 'string')
  }
  state.busy = true
  state.skillError = ''
  render()
  try {
    const item = state.skillDialog && state.skillDialog.item
    if (item) await api('PATCH', `/orgs/${encodeURIComponent(id)}/skills/${encodeURIComponent(item.id)}`, payload)
    else await api('POST', `/orgs/${encodeURIComponent(id)}/skills`, payload)
    closeSkillDialog()
    await loadSkills()
  } catch (err) {
    state.skillError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function submitServer(e) {
  e.preventDefault()
  syncSkillForm()
  const f = state.skillForm
  const id = orgId()
  if (!id || !f) return
  const nameEl = document.getElementById('tl-name')
  if (nameEl) f.name = nameEl.value
  const payload = { name: f.name, kind: f.kind, endpoint: f.endpoint, env: f.env, perm: f.perm, enabled: f.enabled }
  if (f.token) payload.token = f.token
  state.busy = true
  state.skillError = ''
  render()
  try {
    const item = state.skillDialog && state.skillDialog.item
    if (item) await api('PATCH', `/orgs/${encodeURIComponent(id)}/mcp-servers/${encodeURIComponent(item.id)}`, payload)
    else await api('POST', `/orgs/${encodeURIComponent(id)}/mcp-servers`, payload)
    closeSkillDialog()
    await loadSkills()
  } catch (err) {
    state.skillError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function createSkillTag(raw) {
  const tag = String(raw || '').trim()
  syncSkillForm()
  state.skillTagAdding = false
  if (!tag) {
    render()
    return
  }
  const id = orgId()
  try {
    const data = await api('POST', `/orgs/${encodeURIComponent(id)}/skills/tags`, { name: tag })
    state.skillTags = data.tags || []
    if (state.skillForm && !state.skillForm.tags.includes(tag)) state.skillForm.tags = state.skillForm.tags.concat(tag)
  } catch (err) {
    state.skillError = err.message
  }
  render()
}

async function takeSkillFile(input) {
  const picked = input.files && input.files[0]
  input.value = ''
  if (!picked) return
  syncSkillForm()
  const zip = state.skillForm && state.skillForm.source === 'ZIP 包'
  state.skillError = ''
  if (!zip) {
    const text = await picked.text()
    state.skillForm.body = text
    state.skillFile = { name: picked.name, size: picked.size }
    if (!state.skillForm.name) state.skillForm.name = picked.name.replace(/\.(md|markdown|ya?ml|json)$/i, '')
    state.skillEntries = null
    render()
    return
  }
  const unzip = window.satuUnzip
  if (!unzip) {
    state.skillError = '解压器还没载入，请稍后再试'
    render()
    return
  }
  try {
    const list = unzip.stripTopDir(await unzip.unzip(picked))
    const readme = list.find((f) => f.path.toLowerCase() === 'skill.md')
    if (!readme) throw new Error('包的根目录里没有 SKILL.md')
    state.skillEntries = list
    state.skillFile = { name: picked.name, size: picked.size }
    state.skillForm.body = new TextDecoder().decode(readme.bytes)
    if (!state.skillForm.name) state.skillForm.name = picked.name.replace(/[-_]?skill\.zip$|\.zip$/i, '')
  } catch (err) {
    state.skillEntries = null
    state.skillFile = null
    state.skillError = err.message
  }
  render()
}

async function runConfirm() {
  const c = state.confirm
  if (!c) return
  state.confirm = null
  state.menu = null
  try {
    if (c.kind === 'delete-bot') {
      const id = orgId()
      await api('DELETE', `/orgs/${encodeURIComponent(id)}/bots/${encodeURIComponent(c.id)}`)
      flash('ok', '已删除')
      go('/bots')
      return
    } else if (c.kind === 'delete-skill') {
      const id = orgId()
      await api('DELETE', `/orgs/${encodeURIComponent(id)}/skills/${encodeURIComponent(c.id)}`)
      closeSkillDialog()
      await loadSkills()
      render()
      return
    } else if (c.kind === 'delete-mcp') {
      const id = orgId()
      await api('DELETE', `/orgs/${encodeURIComponent(id)}/mcp-servers/${encodeURIComponent(c.id)}`)
      closeSkillDialog()
      await loadSkills()
      render()
      return
    } else if (c.kind === 'delete-skill-tag') {
      const id = orgId()
      const data = await api('DELETE', `/orgs/${encodeURIComponent(id)}/skills/tags/${encodeURIComponent(c.tag)}`)
      state.skillTags = data.tags || []
      if (state.skillForm) state.skillForm.tags = (state.skillForm.tags || []).filter((x) => x !== c.tag)
      render()
      return
    } else if (c.kind === 'delete') {
      await api('DELETE', orgAccountsPath('/' + encodeURIComponent(c.id)))
    } else if (c.kind === 'delete-group') {
      await api('DELETE', orgAccountsPath('/groups/' + encodeURIComponent(c.id)))
    } else if (c.kind === 'disable') {
      await api('PATCH', orgAccountsPath('/' + encodeURIComponent(c.id)), { status: 'disabled' })
    } else if (c.kind === 'enable') {
      await api('PATCH', orgAccountsPath('/' + encodeURIComponent(c.id)), { status: 'active' })
    }
    await loadAccounts()
  } catch (err) {
    flash('err', err.message)
  }
  render()
}

document.getElementById('app').addEventListener('submit', (e) => {
  const form = e.target
  if (!(form instanceof HTMLFormElement)) return
  if (form.id === 'login-form') return onLogin(e)
  if (form.id === 'pw-form') return submitPassword(e)
  if (form.id === 'invite-form') return submitInvite(e)
  if (form.id === 'group-form') return submitGroup(e)
  if (form.id === 'edit-member-form') return submitEdit(e)
  if (form.id === 'join-form') return submitJoin(e)
  if (form.id === 'skill-form') return submitSkill(e)
  if (form.id === 'server-form') return submitServer(e)
  if (form.id === 'company-form') return saveCompany(e)
  if (form.id === 'create-org-form') return createOrg(e)
  if (form.id === 'audit-filter-form') return submitAuditFilter(e)
  if (form.id === 'release-form') return publishRelease(e)
  if (form.id === 'chat-form') {
    e.preventDefault()
    return sendChat()
  }
  if (form.getAttribute('data-form') === 'plan') return savePlan(e)
  if (form.getAttribute('data-form') === 'machine') return saveMachine(e)
  if (form.getAttribute('data-form') === 'cred') {
    e.preventDefault()
    const provider = form.getAttribute('data-provider')
    const credId = form.getAttribute('data-id')
    const secret = String(new FormData(form).get('secret') || '')
    return saveCred(provider, secret, credId)
  }
  if (form.getAttribute('data-form') === 'add-cred') {
    e.preventDefault()
    const fd = new FormData(form)
    const provider = String(fd.get('provider') || '').trim()
    const secret = String(fd.get('secret') || '')
    if (!provider) {
      flash('err', '请选择供应商')
      render()
      return
    }
    if (!secret) {
      flash('err', '密钥不能为空')
      render()
      return
    }
    return saveCred(provider, secret)
  }
})

document.getElementById('app').addEventListener('click', async (e) => {
  const t = e.target instanceof Element ? e.target : e.target.parentElement
  if (state.menu && t && !t.closest('.satu-menu, [data-menu-toggle]')) {
    state.menu = null
    render()
  }
  const btn = t && t.closest('[data-act]')
  if (!btn) return
  if (btn.classList.contains('gw-modal-backdrop') && e.target !== btn) return
  const act = btn.getAttribute('data-act')
  if (act === 'go') {
    go(btn.getAttribute('data-href'))
    return
  }
  if (act === 'chat-open') {
    const id = btn.getAttribute('data-id')
    if (id) go('/a/' + id)
    return
  }
  if (act === 'chat-abort') {
    await abortChat()
    return
  }
  if (act === 'runtime-deploy') {
    await deployMyRuntime(btn.getAttribute('data-bot') || '')
    return
  }
  if (act === 'runtime-update') {
    await updateOrgRuntime()
    return
  }
  if (act === 'seat-open') {
    const id = btn.getAttribute('data-id')
    const member = (state.accounts || []).find((x) => x.id === id)
    if (!member) return
    state.seatMember = member
    state.seatRuntime = null
    state.seatRuntimes = []
    state.seatReveal = false
    state.seatError = ''
    render()
    const org = state.org && state.org.id
    if (!org) return
    try {
      const data = await api('GET', `/platform/orgs/${encodeURIComponent(org)}/accounts/${encodeURIComponent(id)}/runtime`)
      state.seatRuntimes = Array.isArray(data.runtimes) ? data.runtimes : []
      state.seatRuntime = state.seatRuntimes[0] || null
    } catch (err) {
      state.seatError = err.message || '还没有部署'
    }
    render()
    return
  }
  if (act === 'seat-close') {
    state.seatMember = null
    state.seatRuntime = null
    state.seatRuntimes = []
    state.seatReveal = false
    state.seatError = ''
    render()
    return
  }
  if (act === 'seat-reveal') {
    state.seatReveal = !state.seatReveal
    render()
    return
  }
  if (act === 'user-secret-reveal') {
    const kind = btn.getAttribute('data-kind')
    if (kind !== 'apiKey' && kind !== 'accessToken') return
    state.userReveal = { ...state.userReveal, [kind]: !state.userReveal[kind] }
    render()
    return
  }
  if (act === 'user-secret-copy') {
    const kind = btn.getAttribute('data-kind')
    const value = kind === 'apiKey' ? state.userDetail?.apiKey : kind === 'accessToken' ? state.userDetail?.accessToken : ''
    if (!value) return
    const ok = await copyText(value)
    if (!ok) flash('err', '复制失败，请手动选中复制。')
    else flash('ok', '已复制')
    render()
    return
  }
  if (act === 'bot-create') {
    const id = orgId()
    if (!id) return
    state.busy = true
    render()
    try {
      const data = await api('POST', `/orgs/${encodeURIComponent(id)}/bots`, { name: '新助理' })
      state.busy = false
      go('/bots/' + data.bot.id)
    } catch (err) {
      flash('err', err.message)
      state.busy = false
      render()
    }
    return
  }
  if (act === 'bot-list-enabled') {
    const id = orgId()
    const botId = btn.getAttribute('data-id')
    const cur = (state.bots || []).find((b) => b.id === botId)
    if (!id || !cur) return
    const enabled = !(cur.enabled !== false)
    try {
      const data = await api('PATCH', `/orgs/${encodeURIComponent(id)}/bots/${encodeURIComponent(botId)}`, { enabled })
      state.bots = (state.bots || []).map((b) => (b.id === botId ? data.bot : b))
    } catch (err) {
      flash('err', err.message)
    }
    render()
    return
  }
  if (act === 'bot-enabled') {
    if (!state.botDraft) return
    state.botDraft = { ...state.botDraft, enabled: !state.botDraft.enabled }
    render()
    return
  }
  if (act === 'bot-icon') {
    if (!state.botDraft) return
    const icon = btn.getAttribute('data-icon')
    if (!AGENT_ICONS[icon]) return
    state.botDraft = { ...state.botDraft, icon }
    render()
    return
  }
  if (act === 'bot-pick') {
    if (!state.botDraft) return
    const key = btn.getAttribute('data-key')
    const value = btn.getAttribute('data-value')
    const cur = Array.isArray(state.botDraft[key]) ? state.botDraft[key] : []
    state.botDraft = {
      ...state.botDraft,
      [key]: cur.includes(value) ? cur.filter((x) => x !== value) : cur.concat(value),
    }
    render()
    return
  }
  if (act === 'bot-scope') {
    if (!state.botDraft) return
    state.botDraft = { ...state.botDraft, scope: btn.getAttribute('data-value') }
    render()
    return
  }
  if (act === 'bot-guard') {
    if (!state.botDraft) return
    const gid = btn.getAttribute('data-id')
    state.botDraft = {
      ...state.botDraft,
      guards: (state.botDraft.guards || []).map((g) => (g.id === gid ? { ...g, on: !g.on } : g)),
    }
    render()
    return
  }
  if (act === 'bot-memory') {
    if (!state.botDraft) return
    state.botDraft = { ...state.botDraft, memoryOn: !state.botDraft.memoryOn }
    render()
    return
  }
  if (act === 'bot-confirm') {
    if (!state.botDraft) return
    state.botDraft = { ...state.botDraft, confirmOn: !state.botDraft.confirmOn }
    render()
    return
  }
  if (act === 'bot-pii') {
    if (!state.botDraft) return
    state.botDraft = { ...state.botDraft, piiOn: !state.botDraft.piiOn }
    render()
    return
  }
  if (act === 'bot-save') {
    const id = orgId()
    const bot = state.bot
    const a = state.botDraft
    if (!id || !bot || !a) return
    state.busy = true
    render()
    try {
      const data = await api('PATCH', `/orgs/${encodeURIComponent(id)}/bots/${encodeURIComponent(bot.id)}`, {
        name: a.name,
        description: a.description,
        prompt: a.prompt,
        model: a.model,
        provider: a.provider,
        enabled: a.enabled,
        icon: a.icon,
        skills: a.skills,
        mcps: a.mcps,
      })
      state.bot = data.bot
      state.botDraft = { ...a, ...draftFromBot(data.bot), greeting: a.greeting, groups: a.groups, kbs: a.kbs, guards: a.guards, escalate: a.escalate, memories: a.memories, memoryOn: a.memoryOn, scope: a.scope, kinds: a.kinds, ttl: a.ttl, cap: a.cap, confirmOn: a.confirmOn, piiOn: a.piiOn }
      flash('ok', '已保存')
    } catch (err) {
      flash('err', err.message)
    } finally {
      state.busy = false
      render()
    }
    return
  }
  if (act === 'bot-delete') {
    const bot = state.bot
    const a = state.botDraft
    if (!bot) return
    state.confirm = {
      title: '删除这个 Bot？',
      body: `「${(a && a.name) || bot.name}」的人设、能力配置与已存记忆会一并删除，正在用它的定时任务与渠道会失效。`,
      label: '删除',
      kind: 'delete-bot',
      id: bot.id,
    }
    render()
    return
  }
  if (act === 'logout') {
    clearToken()
    state.me = null
    state.loginError = ''
    state.profileDraft = null
    state.profileSaved = false
    state.profileError = ''
    state.pwOpen = false
    state.pwForm = { current: '', next: '', confirm: '' }
    state.pwError = ''
    state.notifyOff = []
    history.replaceState({}, '', '/')
    state.path = '/'
    render()
    return
  }
  if (act === 'pw-open') {
    state.pwOpen = true
    state.pwForm = { current: '', next: '', confirm: '' }
    state.pwError = ''
    render()
    return
  }
  if (act === 'pw-close') {
    state.pwOpen = false
    state.pwError = ''
    render()
    return
  }
  if (act === 'profile-cancel') {
    state.profileDraft = null
    state.profileSaved = false
    state.profileError = ''
    render()
    return
  }
  if (act === 'profile-save') {
    await saveProfile()
    return
  }
  if (act === 'profile-theme') {
    const mode = btn.getAttribute('data-mode')
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return
    setTheme(mode)
    render()
    api('PATCH', '/me', { theme: mode }).catch((err) => {
      state.profileError = err.message
      render()
    })
    return
  }
  if (act === 'profile-locale') {
    const key = btn.getAttribute('data-locale')
    if (key !== 'zh' && key !== 'en') return
    setLocale(key)
    render()
    api('PATCH', '/me', { locale: key }).catch((err) => {
      state.profileError = err.message
      render()
    })
    return
  }
  if (act === 'profile-notify') {
    const key = btn.getAttribute('data-notify')
    if (!key) return
    state.notifyOff = state.notifyOff.includes(key) ? state.notifyOff.filter((x) => x !== key) : state.notifyOff.concat(key)
    render()
    return
  }
  if (act === 'rail') {
    state.rail = !state.rail
    render()
    return
  }
  if (act === 'add-dialog') return
  if (act === 'add-open') {
    state.addOpen = true
    render()
    return
  }
  if (act === 'add-close') {
    state.addOpen = false
    render()
    return
  }
  if (act === 'set-role') {
    const role = btn.getAttribute('data-role')
    const provider = btn.getAttribute('data-provider')
    const model = btn.getAttribute('data-model')
    await saveSettings({ [role]: { provider, model } })
    return
  }
  if (act === 'save-cred') {
    const provider = btn.getAttribute('data-provider')
    const credId = btn.getAttribute('data-id')
    const form = document.querySelector(`form[data-form="cred"][data-provider="${CSS.escape(provider)}"]`)
    const secret = form ? String(new FormData(form).get('secret') || '') : ''
    if (!secret) {
      flash('err', '密钥不能为空')
      render()
      return
    }
    await saveCred(provider, secret, credId)
    return
  }
  if (act === 'test-role') {
    await testLlm('role', { role: btn.getAttribute('data-role') })
    return
  }
  if (act === 'test-provider') {
    await testLlm('provider', { provider: btn.getAttribute('data-provider') })
    return
  }
  if (act === 'invite-open') {
    state.inviteOpen = true
    state.inviteLink = ''
    state.inviteCopied = false
    state.inviteError = ''
    state.inviteForm = { name: '', email: '', role: 'member', ttlDays: 7 }
    state.menu = null
    render()
    return
  }
  if (act === 'invite-close') {
    state.inviteOpen = false
    state.inviteLink = ''
    state.inviteError = ''
    loadAccounts().then(render)
    return
  }
  if (act === 'org-create-open') {
    state.orgCreateOpen = true
    render()
    return
  }
  if (act === 'org-create-close') {
    state.orgCreateOpen = false
    render()
    return
  }
  if (act === 'org-open') {
    const id = btn.getAttribute('data-id')
    if (id) go('/companies/' + id)
    return
  }
  if (act === 'accounts-tab') {
    state.accountsTab = btn.getAttribute('data-tab') === 'groups' ? 'groups' : 'members'
    render()
    return
  }
  if (act === 'audit-tab') {
    state.auditTab = btn.getAttribute('data-tab') === 'events' ? 'events' : 'chats'
    render()
    return
  }
  if (act === 'billing-tab') {
    state.billingTab = btn.getAttribute('data-tab') === 'topup' ? 'topup' : 'sub'
    render()
    return
  }
  if (act === 'billing-autorenew') {
    const cur = state.billingAutoRenew ?? !!state.billing?.plan?.autoRenew
    state.billingAutoRenew = !cur
    render()
    return
  }
  if (act === 'usage-range') {
    state.usageRange = btn.getAttribute('data-range') || '近 30 天'
    loadUsage()
      .then(() => render())
      .catch((err) => {
        flash('err', err.message)
        render()
      })
    return
  }
  if (act === 'group-open') {
    state.groupDialog = {}
    state.groupForm = emptyGroupForm()
    state.groupError = ''
    state.menu = null
    render()
    return
  }
  if (act === 'group-edit') {
    const g = groupById(btn.getAttribute('data-id'))
    if (!g || g.builtin) return
    state.groupDialog = g
    state.groupForm = {
      name: g.name || '',
      desc: g.desc || '',
      icon: g.icon || 'chat',
      role: g.role === 'admin' ? 'admin' : 'member',
      members: Array.isArray(g.members) ? g.members.slice() : [],
    }
    state.groupError = ''
    state.menu = null
    render()
    return
  }
  if (act === 'group-delete') {
    const g = groupById(btn.getAttribute('data-id'))
    if (!g || g.builtin) return
    state.confirm = {
      title: '删除这个分组？',
      body: `「${g.name}」删除后，它授权的 Agent 访问范围随之失效。成员账号不受影响。`,
      label: '删除',
      kind: 'delete-group',
      id: g.id,
    }
    state.menu = null
    render()
    return
  }
  if (act === 'group-close') {
    state.groupDialog = null
    state.groupError = ''
    render()
    return
  }
  if (act === 'group-icon') {
    syncGroupForm()
    state.groupForm.icon = btn.getAttribute('data-icon') || 'chat'
    render()
    return
  }
  if (act === 'group-role') {
    syncGroupForm()
    state.groupForm.role = btn.getAttribute('data-role') === 'admin' ? 'admin' : 'member'
    render()
    return
  }
  if (act === 'group-toggle-member') {
    syncGroupForm()
    const id = btn.getAttribute('data-id')
    const cur = state.groupForm.members || []
    state.groupForm.members = cur.includes(id) ? cur.filter((x) => x !== id) : cur.concat(id)
    render()
    return
  }
  if (act === 'edit-open') {
    const m = memberById(btn.getAttribute('data-id'))
    if (!m) return
    state.editing = m
    state.editForm = { name: m.name || '', role: m.role === 'admin' ? 'admin' : 'member', status: m.status || 'active' }
    state.editLink = ''
    state.editCopied = false
    state.menu = null
    render()
    return
  }
  if (act === 'edit-close') {
    state.editing = null
    state.editLink = ''
    render()
    return
  }
  if (act === 'edit-role') {
    if (state.editing && state.editing.id !== memberMeId()) state.editForm.role = btn.getAttribute('data-role')
    render()
    return
  }
  if (act === 'edit-status') {
    if (state.editing && state.editing.id !== memberMeId()) state.editForm.status = btn.getAttribute('data-status')
    render()
    return
  }
  if (act === 'edit-reset') {
    if (state.editing) await resetMember(state.editing.id, true)
    return
  }
  if (act === 'edit-copy') {
    const ok = await copyText(state.editLink)
    state.editCopied = ok
    if (!ok) flash('err', '复制失败，请手动选中上面的链接复制。')
    render()
    return
  }
  if (act === 'menu-toggle') {
    const id = btn.getAttribute('data-id')
    const rect = btn.getBoundingClientRect()
    state.menuFlip = rect.bottom > innerHeight - 260
    state.menu = state.menu === id ? null : id
    render()
    return
  }
  if (act === 'member-reset') {
    await resetMember(btn.getAttribute('data-id'), false)
    return
  }
  if (act === 'member-disable') {
    const m = memberById(btn.getAttribute('data-id'))
    if (!m) return
    state.confirm = {
      title: '停用这名成员？',
      body: `「${m.name}」当前的登录会立即失效，之后也无法再登录。历史记录保留。`,
      label: '已停用',
      kind: 'disable',
      id: m.id,
    }
    state.menu = null
    render()
    return
  }
  if (act === 'member-enable') {
    const m = memberById(btn.getAttribute('data-id'))
    if (!m) return
    state.confirm = {
      title: '恢复这名成员？',
      body: `「${m.name}」将可以重新登录。`,
      label: '已激活',
      kind: 'enable',
      id: m.id,
    }
    state.menu = null
    render()
    return
  }
  if (act === 'member-delete') {
    const m = memberById(btn.getAttribute('data-id'))
    if (!m) return
    state.confirm = {
      title: '删除这名成员？',
      body: `「${m.name}」的账号将被删除，登录立即失效。他创建的会话与定时任务保留但不再执行。`,
      label: '删除',
      kind: 'delete',
      id: m.id,
    }
    state.menu = null
    render()
    return
  }
  if (act === 'confirm-cancel') {
    state.confirm = null
    render()
    return
  }
  if (act === 'confirm-ok') {
    await runConfirm()
    return
  }
  if (act === 'secret-close') {
    state.secret = null
    state.inviteCopied = false
    render()
    return
  }
  if (act === 'secret-copy') {
    const ok = await copyText(state.secret?.url || '')
    state.inviteCopied = ok
    if (!ok) flash('err', '复制失败，请手动选中上面的链接复制。')
    render()
    return
  }
  if (act === 'join-login') {
    history.replaceState({}, '', '/')
    state.path = '/'
    state.joinError = ''
    render()
    return
  }
  if (act === 'skills-tab') {
    state.skillsTab = btn.getAttribute('data-tab') || 'Skill'
    closeSkillDialog()
    render()
    return
  }
  if (act === 'skill-create') {
    closeSkillDialog()
    state.skillDialog = { type: 'skill', item: null }
    state.skillForm = emptySkillForm(null)
    render()
    return
  }
  if (act === 'mcp-create') {
    closeSkillDialog()
    state.skillDialog = { type: 'server', item: null }
    state.skillForm = emptyServerForm(null)
    render()
    return
  }
  if (act === 'skill-close') {
    closeSkillDialog()
    loadSkills().then(render)
    return
  }
  if (act === 'skill-dismiss') {
    state.skillFailure = ''
    render()
    return
  }
  if (act === 'skill-toggle') {
    const id = orgId()
    const skillId = btn.getAttribute('data-id')
    const cur = (state.skills || []).find((x) => x.id === skillId)
    if (!id || !cur) return
    const enabled = !(cur.enabled !== false)
    api('PATCH', `/orgs/${encodeURIComponent(id)}/skills/${encodeURIComponent(skillId)}`, { enabled })
      .then((data) => {
        state.skills = (state.skills || []).map((x) => (x.id === skillId ? data.skill : x))
        render()
      })
      .catch((err) => {
        state.skillFailure = err.message
        render()
      })
    return
  }
  if (act === 'mcp-toggle') {
    const id = orgId()
    const serverId = btn.getAttribute('data-id')
    const cur = (state.mcpServers || []).find((x) => x.id === serverId)
    if (!id || !cur) return
    const enabled = !(cur.enabled !== false)
    api('PATCH', `/orgs/${encodeURIComponent(id)}/mcp-servers/${encodeURIComponent(serverId)}`, { enabled })
      .then((data) => {
        state.mcpServers = (state.mcpServers || []).map((x) => (x.id === serverId ? data.server : x))
        render()
      })
      .catch((err) => {
        state.skillFailure = err.message
        render()
      })
    return
  }
  if (act === 'skill-edit') {
    const item = (state.skills || []).find((x) => x.id === btn.getAttribute('data-id'))
    if (!item) return
    closeSkillDialog()
    state.skillDialog = { type: 'skill', item }
    state.skillForm = emptySkillForm(item)
    render()
    return
  }
  if (act === 'mcp-edit') {
    const item = (state.mcpServers || []).find((x) => x.id === btn.getAttribute('data-id'))
    if (!item) return
    closeSkillDialog()
    state.skillDialog = { type: 'server', item }
    state.skillForm = emptyServerForm(item)
    render()
    return
  }
  if (act === 'skill-source') {
    syncSkillForm()
    state.skillForm.source = btn.getAttribute('data-value')
    state.skillFile = null
    state.skillEntries = null
    render()
    return
  }
  if (act === 'mcp-kind') {
    syncSkillForm()
    state.skillForm.kind = btn.getAttribute('data-value')
    render()
    return
  }
  if (act === 'mcp-perm') {
    syncSkillForm()
    state.skillForm.perm = btn.getAttribute('data-value')
    render()
    return
  }
  if (act === 'skill-enabled') {
    syncSkillForm()
    state.skillForm.enabled = !state.skillForm.enabled
    render()
    return
  }
  if (act === 'skill-tag-manage') {
    syncSkillForm()
    state.skillTagManage = !state.skillTagManage
    state.skillTagAdding = false
    render()
    return
  }
  if (act === 'skill-tag-pick') {
    syncSkillForm()
    const tag = btn.getAttribute('data-tag')
    const cur = state.skillForm.tags || []
    state.skillForm.tags = cur.includes(tag) ? cur.filter((x) => x !== tag) : cur.concat(tag)
    render()
    return
  }
  if (act === 'skill-tag-add') {
    syncSkillForm()
    state.skillTagAdding = true
    render()
    const el = document.getElementById('sk-tag-draft')
    if (el) el.focus()
    return
  }
  if (act === 'skill-tag-delete') {
    syncSkillForm()
    const tag = btn.getAttribute('data-tag')
    const used = (state.skills || []).filter((x) => (x.tags || []).includes(tag)).length
    state.confirm = {
      title: `删除标签「${tag}」？`,
      body: used > 0 ? `${used} 个 Skill 正在用它，它们身上这个标签会一起去掉。` : '这个标签会从表里删掉。',
      label: '删除标签',
      kind: 'delete-skill-tag',
      tag,
    }
    render()
    return
  }
  if (act === 'skill-delete') {
    const item = state.skillDialog && state.skillDialog.item
    if (!item) return
    state.confirm = {
      title: '删除这个 Skill？',
      body: `「${item.name}」的定义会被删除，用到它的 Agent 将不再有这项方法。`,
      label: '删除',
      kind: 'delete-skill',
      id: item.id,
    }
    render()
    return
  }
  if (act === 'mcp-delete') {
    const item = state.skillDialog && state.skillDialog.item
    if (!item) return
    state.confirm = {
      title: '移除这台 MCP 服务器？',
      body: `「${item.name}」的连接配置与鉴权 token 一并删除。`,
      label: '移除',
      kind: 'delete-mcp',
      id: item.id,
    }
    render()
    return
  }
})

document.getElementById('app').addEventListener('keydown', (e) => {
  const el = e.target
  if (!(el instanceof HTMLInputElement) || el.id !== 'sk-tag-draft') return
  if (e.key === 'Enter') {
    e.preventDefault()
    createSkillTag(el.value)
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    syncSkillForm()
    state.skillTagAdding = false
    render()
  }
})

document.getElementById('app').addEventListener('focusout', (e) => {
  const el = e.target
  if (!(el instanceof HTMLInputElement) || el.id !== 'sk-tag-draft') return
  createSkillTag(el.value)
})

document.getElementById('app').addEventListener('input', (e) => {
  const el = e.target
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return
  const botField = el.getAttribute('data-bot')
  if (botField && state.botDraft) {
    if (botField === 'cap') {
      state.botDraft = { ...state.botDraft, cap: Number(el.value) }
      const label = document.querySelector('[data-bot-cap-label]')
      if (label) label.textContent = `注入上限 · ${state.botDraft.cap} 条`
      return
    }
    state.botDraft = { ...state.botDraft, [botField]: el.value }
    if (botField === 'prompt') {
      const len = document.querySelector('[data-bot-prompt-len]')
      if (len) len.textContent = `${el.value.length} 字 · 每轮随上下文注入`
    }
    return
  }
  if (!(el instanceof HTMLInputElement)) return
  const field = el.getAttribute('data-profile')
  if (field === 'name' || field === 'title' || field === 'phone') {
    const u = state.me?.account || {}
    const cur = state.profileDraft ?? { name: u.name || '', title: u.title || '', phone: u.phone || '' }
    state.profileDraft = { ...cur, [field]: el.value }
    state.profileSaved = false
    paintProfileActions()
    return
  }
  const pw = el.getAttribute('data-pw')
  if (pw === 'current' || pw === 'next' || pw === 'confirm') {
    state.pwForm = { ...state.pwForm, [pw]: el.value }
  }
})

document.getElementById('app').addEventListener('change', async (e) => {
  const el = e.target
  if (el instanceof HTMLInputElement && el.type === 'file' && el.getAttribute('data-skill-file')) {
    await takeSkillFile(el)
    return
  }
  if (!(el instanceof HTMLSelectElement)) return
  const act = el.getAttribute('data-act')
  if (act === 'update-version') {
    state.updateVersion = el.value
    return
  }
  if (act === 'select-provider') {
    state.selectedProvider = el.value
    render()
    return
  }
  if (act === 'role-provider') {
    const role = el.getAttribute('data-role')
    const provider = el.value
    const p = state.catalog.find((x) => x.provider === provider)
    const model = p?.models[0]?.id || ''
    await saveSettings({ [role]: { provider, model } })
    state.selectedProvider = provider
    return
  }
  if (act === 'role-model') {
    const role = el.getAttribute('data-role')
    const cur = state.settings[role] || {}
    await saveSettings({ [role]: { provider: cur.provider, model: el.value } })
    return
  }
  if (act === 'bot-provider') {
    if (!state.botDraft) return
    const p = (state.botModels || []).find((x) => x.provider === el.value)
    state.botDraft = { ...state.botDraft, provider: el.value, model: p?.models?.[0]?.id || state.botDraft.model }
    render()
    return
  }
  if (act === 'bot-model') {
    if (!state.botDraft) return
    state.botDraft = { ...state.botDraft, model: el.value }
    return
  }
  if (act === 'bot-ttl') {
    if (!state.botDraft) return
    state.botDraft = { ...state.botDraft, ttl: el.value }
  }
})

document.getElementById('app').addEventListener('input', (e) => {
  const el = e.target
  if (!(el instanceof HTMLTextAreaElement) || el.id !== 'chat-input') return
  state.chatDraft = el.value
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 200) + 'px'
})

window.addEventListener('popstate', () => {
  if (location.pathname === '/costs') history.replaceState({}, '', '/billing')
  state.path = pathOf()
  state.addOpen = false
  closeMemberUi()
  if (state.path.startsWith('/join/')) {
    loadInvite().then(render)
    return
  }
  loadPage().then(render)
})

async function boot() {
  if (location.pathname === '/costs') history.replaceState({}, '', '/billing')
  state.path = pathOf()
  if (state.path.startsWith('/join/')) {
    await loadInvite()
    render()
    return
  }
  if (!token()) {
    render()
    return
  }
  try {
    await loadMe()
    await loadPage()
  } catch {
    clearToken()
    state.me = null
  }
  render()
}

boot()
