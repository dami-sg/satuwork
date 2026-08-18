const TOKEN_KEY = 'satuwork.gateway.token'
const THEME_KEY = 'satu.theme'
const LOCALE_KEY = 'satu.locale'

const ASIDE_KEY = 'satu.aside'
/**
 * 右侧运行环境栏的宽度与折叠状态。
 *
 * 落 localStorage：它是「工作台的形状」，不是页面状态——换个 Bot、切一次页面就恢复
 * 默认宽度会很烦人。
 */
const asidePref = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(ASIDE_KEY) || '{}')
    return { open: raw.open !== false, width: Math.min(520, Math.max(200, Number(raw.width) || 280)) }
  } catch {
    return { open: true, width: 280 }
  }
})()

function saveAside() {
  try {
    localStorage.setItem(ASIDE_KEY, JSON.stringify(asidePref))
  } catch {}
}

let themeMode = localStorage.getItem(THEME_KEY) || 'system'
let localeMode = localStorage.getItem(LOCALE_KEY) || 'zh'

const darkMq = matchMedia('(prefers-color-scheme: dark)')

/** system 在 CSS 里不存在：解析成 light/dark 再落到 <html data-theme>。 */
function paintTheme() {
  const resolved = themeMode === 'system' ? (darkMq.matches ? 'dark' : 'light') : themeMode
  document.documentElement.setAttribute('data-theme', resolved)
  // mermaid 的配色是渲染那一刻烧进 SVG 的，不跟 CSS 变量走——主题换了要重画。
  if (window.satuMd) satuMd.retheme()
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

/**
 * 界面文案。两种用法：
 *   t('保存')              查 i18n.js 的译表
 *   t('保存', 'Save')      就地给译文，优先于译表
 * 查不到就原样返回中文——露出一句没翻的，好过显示空白。
 */
function t(zh, en) {
  if (localeMode !== 'en') return zh
  if (en != null) return en
  const dict = window.SATU_I18N || {}
  if (dict[zh] != null) return dict[zh]
  // 文案两边的空格是排版用的，不该进译表的键——剥掉再查，查到了再贴回去。
  const trimmed = String(zh).trim()
  const hit = dict[trimmed]
  if (hit == null) return zh
  const lead = zh.slice(0, zh.indexOf(trimmed[0]))
  const tail = zh.slice(zh.indexOf(trimmed[0]) + trimmed.length)
  return `${lead}${hit}${tail}`
}

/**
 * 服务端错误。它只发中文，英文界面下按整句查表。
 * 带变量的（「口令至少 10 位」里的位数）先按模板归一化再查。
 */
function errText(msg) {
  if (localeMode !== 'en' || !msg) return msg
  const dict = window.SATU_I18N || {}
  if (dict[msg]) return dict[msg]
  const pw = msg.match(/^口令至少 (\d+) 位$/)
  if (pw) return `Password must be at least ${pw[1]} characters`
  return msg
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
  '/releases': { title: '机器配置' },
  '/users': { title: '用户' },
  '/plans': { title: '套餐' },
  '/orders': { title: '购买与充值' },
  '/stats': { title: '统计' },
  '/billing': { title: '账单' },
  '/usage': { title: '用量统计' },
  '/costs': { title: '账单' },
  '/catalog': { title: '公司目录' },
  '/profile': { title: '个人设置' },
  '/bots': { title: 'Bot 配置', ownerTitle: '全局 Bot' },
  '/skills': { title: 'Skill 与 MCP', ownerTitle: '全局 Skill 与 MCP' },
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

/**
 * Bot 头像。两个层级各八个，两套不重合。
 *
 * 底板形状就是层级：公司是圆角方牌，全局是六边牌 + 一圈内环。混在同一张列表里
 * （公司的 Bot 页会同时列出两种）扫一眼就能分开，不用去看那个「全局」小标。
 * 颜色只是帮衬——深浅主题下色相会变，形状不会。
 *
 * 每个头像是一整张图（底板填色 + 上面的线条），不是一枚线框图标；所以外面不用再
 * 套一层带背景的 .satu-providermark。
 */
const BOT_AVATAR_TILE = {
  // 圆角方牌。
  company: '<rect x="2" y="2" width="36" height="36" rx="11"/>',
  // 六边牌：顶点朝上下，和方牌在任何尺寸下都不会看混。
  global: '<path d="M20 1.8 35.8 10.9v18.2L20 38.2 4.2 29.1V10.9z"/>',
}

/** 全局那套多一圈内环，进一步跟公司那套拉开。 */
const BOT_AVATAR_RING = '<path d="M20 6.6 31.1 13v12.8L20 32.2 8.9 25.8V13z" fill="none" stroke-width="1.4" opacity="0.45"/>'

const BOT_AVATARS = {
  // ── 公司：日常岗位。─────────────────────────────────────────────
  'c-bot': { family: 'company', label: '助理', glyph: ['M13 16h14v10a2 2 0 0 1-2 2H15a2 2 0 0 1-2-2z', 'M20 11v5', 'M20 9.2a1.8 1.8 0 1 0 0 3.6 1.8 1.8 0 0 0 0-3.6z', 'M17 21h.02', 'M23 21h.02'] },
  'c-chat': { family: 'company', label: '客服', glyph: ['M11 14h18v10h-4l-5 4v-4h-9z', 'M16 19h.02', 'M20 19h.02', 'M24 19h.02'] },
  'c-chart': { family: 'company', label: '分析', glyph: ['M12 27h16', 'M16 27v-7', 'M20 27V13', 'M24 27v-10'] },
  'c-pen': { family: 'company', label: '文案', glyph: ['M12 28h16', 'M25.5 11.5a2.1 2.1 0 0 1 3 3L18 25l-4 1 1-4z'] },
  'c-deal': { family: 'company', label: '销售', glyph: ['M12 24l5-5 4 4 7-8', 'M23 15h5v5'] },
  'c-code': { family: 'company', label: '研发', glyph: ['M16 15l-5 5 5 5', 'M24 15l5 5-5 5', 'M22 13l-4 14'] },
  'c-flow': { family: 'company', label: '调度', glyph: ['M13 13h6v6h-6z', 'M21 21h6v6h-6z', 'M16 19v5h5'] },
  'c-book': { family: 'company', label: '知识', glyph: ['M12 13h7a3 3 0 0 1 3 3v12a3 3 0 0 0-3-3h-7z', 'M28 13h-6a3 3 0 0 0-3 3v12a3 3 0 0 1 3-3h6z'] },

  // ── 全局：平台级能力。──────────────────────────────────────────
  'g-core': { family: 'global', label: '核心', glyph: ['M20 15.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z', 'M20 11v3', 'M20 26v3', 'M14.3 14.3l2.1 2.1', 'M23.6 23.6l2.1 2.1', 'M25.7 14.3l-2.1 2.1', 'M16.4 23.6l-2.1 2.1'] },
  'g-relay': { family: 'global', label: '中转', glyph: ['M13 17.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z', 'M27 17.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z', 'M20 10.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z', 'M20 24.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z', 'M15.4 20h9.2', 'M20 15.4v9.2'] },
  'g-shield': { family: 'global', label: '守卫', glyph: ['M20 11l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9v-6z', 'M17 20l2.2 2.2L23.5 18'] },
  'g-globe': { family: 'global', label: '通用', glyph: ['M20 11.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M11.5 20h17', 'M20 11.5c2.4 2.6 3.6 5.4 3.6 8.5s-1.2 5.9-3.6 8.5c-2.4-2.6-3.6-5.4-3.6-8.5s1.2-5.9 3.6-8.5z'] },
  'g-spark': { family: 'global', label: '加速', glyph: ['M21.5 10.5 13.5 21h6l-1 8.5 8-10.5h-6z'] },
  'g-grid': { family: 'global', label: '编排', glyph: ['M13 13h5.5v5.5H13z', 'M21.5 13H27v5.5h-5.5z', 'M13 21.5h5.5V27H13z', 'M21.5 21.5H27V27h-5.5z'] },
  'g-beacon': { family: 'global', label: '广播', glyph: ['M20 17.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z', 'M15.4 15.4a6.5 6.5 0 0 0 0 9.2', 'M24.6 15.4a6.5 6.5 0 0 1 0 9.2', 'M12.6 12.6a10.5 10.5 0 0 0 0 14.8', 'M27.4 12.6a10.5 10.5 0 0 1 0 14.8'] },
  'g-vault': { family: 'global', label: '归档', glyph: ['M12.5 13h15v14h-15z', 'M12.5 18.5h15', 'M18 15.7h4', 'M18 23h4'] },
}

const COMPANY_AVATAR_KEYS = ['c-bot', 'c-chat', 'c-chart', 'c-pen', 'c-deal', 'c-code', 'c-flow', 'c-book']
const GLOBAL_AVATAR_KEYS = ['g-core', 'g-relay', 'g-shield', 'g-globe', 'g-spark', 'g-beacon', 'g-grid', 'g-vault']

/** 改版前存的那六个键，画之前先落到新的一套上。 */
const LEGACY_AVATARS = { bot: 'c-bot', chat: 'c-chat', chart: 'c-chart', pen: 'c-pen', deal: 'c-deal', code: 'c-code' }

function avatarKeysFor(origin) {
  return origin === 'global' ? GLOBAL_AVATAR_KEYS : COMPANY_AVATAR_KEYS
}

/**
 * 画一个头像。origin 决定层级（拿不准就按 key 前缀猜），key 决定画哪一个。
 * 颜色走主题变量，深浅色都成立。
 */
function botAvatar(key, size = 34, origin) {
  const k = LEGACY_AVATARS[key] || key
  const a = BOT_AVATARS[k]
  const fam = a ? a.family : origin === 'global' || String(k).startsWith('g-') ? 'global' : 'company'
  const def = a || BOT_AVATARS[fam === 'global' ? 'g-core' : 'c-bot']
  const bg = fam === 'global' ? 'var(--color-accent-2-200)' : 'var(--color-accent-200)'
  const fg = fam === 'global' ? 'var(--color-accent-2-800)' : 'var(--color-accent-800)'
  const tile = BOT_AVATAR_TILE[fam].replace('/>', ` fill="${bg}"/>`)
  const ring = fam === 'global' ? BOT_AVATAR_RING.replace('stroke-width', `stroke="${fg}" stroke-width`) : ''
  const glyph = def.glyph.map((d) => `<path d="${esc(d)}"/>`).join('')
  return `<svg width="${size}" height="${size}" viewBox="0 0 40 40" role="img" aria-label="${esc(t(def.label))}" style="flex: none; display: block;">
    ${tile}${ring}
    <g fill="none" stroke="${fg}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${glyph}</g>
  </svg>`
}

const MEMORY_SCOPES = ['仅本人', '所属分组', '全公司']
const MEMORY_KINDS = ['偏好', '事实', '流程', '联系人']
const MEMORY_TTLS = ['30 天', '90 天', '180 天', '永久保留']
const DEFAULT_BOT_GUARDS = [
  { id: 'high-risk', title: '高风险操作需确认', desc: '对外发送、改写数据或付款前先征求同意', on: true },
  { id: 'pii', title: '拦截个人敏感信息', desc: '手机号、证件号、银行卡等不写入记忆、不外发', on: true },
  { id: 'no-external', title: '禁止访问未授权的外部系统', desc: '只允许调用已勾选的 MCP 与连接器', on: true },
]


/** 二级页面头上那个返回。 */
const BACK_ARROW = ['M19 12H5', 'M12 19l-7-7 7-7']
const CHEVRON_LEFT = ['M15 18l-6-6 6-6']
const CHEVRON_RIGHT = ['M9 18l6-6-6-6']

const GEAR = [
  'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
]

const OWNER_NAV = [
  { href: '/', label: '概览', icon: 'overview' },
  { href: '/companies', label: '公司', icon: 'company' },
  { href: '/releases', label: '机器配置', icon: 'bots' },
  { href: '/users', label: '用户', icon: 'accounts' },
  { href: '/providers', label: '供应商', icon: 'providers' },
  { href: '/models', label: '模型配置', icon: 'models' },
  { href: '/plans', label: '套餐', icon: 'plans' },
  { href: '/orders', label: '购买与充值', icon: 'billing' },
  { href: '/stats', label: '统计', icon: 'stats' },
  // 全局 Skill / MCP：所有公司都看得见。跟公司侧共用同一套页面，差别只在
  // catalogBase() 给出的接口前缀。
  //
  // **「全局 Bot」不在这份菜单里。** 平台这一侧管的是公司、机器、模型和钱，Bot 名录
  // 是公司侧的东西；把它摆在平台菜单里，每次进来都要先分辨「这是全局的还是某家公司
  // 的」。页面本身没有撤——全局 Bot 目录还得有人维护，而 owner 是唯一改得动它的人，
  // 所以 allowedHrefs 里单独补了 /bots，直接输地址仍然进得去。
  { href: '/skills', label: '全局 Skill 与 MCP', icon: 'skills' },
]

const ADMIN_NAV = [
  { href: '/company', label: '公司/席位', icon: 'company' },
  { href: '/accounts', label: '员工', icon: 'accounts' },
  { href: '/audit', label: '审计', icon: 'audit' },
  { href: '/billing', label: '账单', icon: 'billing' },
  { href: '/usage', label: '用量统计', icon: 'usage' },
  { href: '/bots', label: 'Bot 配置', icon: 'bots' },
  { href: '/skills', label: 'Skill 与 MCP', icon: 'skills' },
]

/** 员工侧栏只有 Bot 名单（它由 chatRosterNav 单独画），所以这里是空的。 */
const MEMBER_NAV = []

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
    state.machine = machineRes && machineRes.machine ? machineRes.machine : null
    state.machines = (machineRes && machineRes.machines) || []
    state.machineCapacity = (machineRes && machineRes.capacity) || null
    state.botLatest = (machineRes && machineRes.botLatest) || null
    state.managerLatest = (machineRes && machineRes.managerLatest) || null
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
  const base = catalogBase()
  if (!base || !botId) return
  // 不再拉 /v1/models：模型由平台指定，这一页没有可挑的下拉了。
  const [one, opts] = await Promise.all([
    api('GET', `${base}/bots/${encodeURIComponent(botId)}`),
    api('GET', `${base}/bots/options`),
  ])
  state.bot = one.bot
  state.botDraft = draftFromBot(one.bot)
  state.botOptions = {
    skills: opts.skills || [],
    mcps: opts.mcps || [],
    groups: opts.groups || [],
    kbs: opts.kbs || [],
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

/** 登录页和创建页共用左半边，只有右半边那张卡不一样。 */
function authAside() {
  return `
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
        <p style="font-family: var(--font-heading); font-size: 26px; line-height: 1.2; margin: 0;">${t('Satuwork 控制面。按账号角色进入系统控制台或公司后台。')}</p>
        <p style="margin: 0; color: color-mix(in srgb, var(--color-text) 65%, transparent); font-size: 14px; line-height: 1.6;">${t('日常任务模型和 utility 模型由系统管理员配置。供应商密钥保存后不会回显，也不会下发到 Bot。')}</p>
      </div>
      <div style="position: relative; display: flex; gap: var(--space-4); font-size: 12px; color: color-mix(in srgb, var(--color-text) 55%, transparent);">
        <span>© 2026 Satuwork</span>
      </div>
    </div>`
}

/**
 * 系统里一个 owner 都没有时的第一屏。
 *
 * 不是登录页上的一个链接——没有管理员时登录页没有任何可用的入口，让人对着一个
 * 永远填不对的表单猜，不如直接把该做的事摆出来。建完当场就是登录态。
 */
function setupView() {
  return `
  <div class="gw-login">
    ${authAside()}
    <div style="position: relative; display: flex; align-items: center; justify-content: center; padding: var(--space-8);">
      <div style="width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: var(--space-6);">
        <div>
          <h1 style="font-size: 30px; margin: 0 0 var(--space-2);">${t('创建系统管理员')}</h1>
          <p style="margin: 0; color: color-mix(in srgb, var(--color-text) 60%, transparent); font-size: 14px;">${t('这台 Gateway 还没有系统管理员。第一个账号由你在这里创建，之后这一屏不会再出现。')}</p>
        </div>
        ${state.setupError ? `<div class="gw-flash gw-flash-err">${esc(state.setupError)}</div>` : ''}
        <form id="setup-form" style="display: flex; flex-direction: column; gap: var(--space-4);">
          <div class="field">
            <label for="setup-email">${t('邮箱')}</label>
            <input class="input satu-input" id="setup-email" name="email" type="email" autocomplete="username" placeholder="you@company.com" value="${esc(state.setupEmail)}" required>
          </div>
          <div class="field">
            <label for="setup-name">${t('姓名')}<span style="color: var(--muted-foreground); font-weight: 400;">${t('（可留空）')}</span></label>
            <input class="input satu-input" id="setup-name" name="name" type="text" autocomplete="name" placeholder="${esc(t('张三'))}" value="${esc(state.setupName)}">
          </div>
          <div class="field">
            <label for="setup-pw">${t('口令')}</label>
            <input class="input satu-input" id="setup-pw" name="password" type="password" autocomplete="new-password" placeholder="${esc(t('至少 10 位'))}" required minlength="10">
          </div>
          <div class="field">
            <label for="setup-pw2">${t('再输一遍')}</label>
            <input class="input satu-input" id="setup-pw2" name="confirm" type="password" autocomplete="new-password" placeholder="${esc(t('再输一遍口令'))}" required minlength="10">
          </div>
          <button type="submit" class="btn btn-primary btn-block" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? t('创建中…') : t('创建并进入')}
            ${state.busy ? '' : svg(['M5 12h14', 'm12 5 7 7-7 7'], 14)}
          </button>
        </form>
        <p style="text-align: center; margin: 0; font-size: 14px; color: color-mix(in srgb, var(--color-text) 60%, transparent);">${t('系统管理员不属于任何公司，负责分配席位、配置模型和供应商密钥。')}</p>
      </div>
    </div>
  </div>`
}

function loginView() {
  return `
  <div class="gw-login">
    ${authAside()}
    <div style="position: relative; display: flex; align-items: center; justify-content: center; padding: var(--space-8);">
      <div style="width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: var(--space-6);">
        <div>
          <h1 style="font-size: 30px; margin: 0 0 var(--space-2);">${t('登录 Satuwork')}</h1>
          <p style="margin: 0; color: color-mix(in srgb, var(--color-text) 60%, transparent); font-size: 14px;">${t('进入控制台，管理你的 AI 员工')}</p>
        </div>
        ${state.loginError ? `<div class="gw-flash gw-flash-err">${esc(state.loginError)}</div>` : ''}
        <form id="login-form" style="display: flex; flex-direction: column; gap: var(--space-4);">
          <div class="field">
            <label for="login-email">${t('邮箱')}</label>
            <input class="input satu-input" id="login-email" name="email" type="email" autocomplete="username" placeholder="you@company.com" value="${esc(state.loginEmail)}" required>
          </div>
          <div class="field">
            <div style="display: flex; justify-content: space-between; align-items: baseline;">
              <label for="login-pw" style="margin: 0;">${t('口令')}</label>
              <span style="font-size: 12px; color: var(--muted-foreground);">${t('忘记口令？联系管理员')}</span>
            </div>
            <input class="input satu-input" id="login-pw" name="password" type="password" autocomplete="current-password" placeholder="${esc(t('输入口令'))}" required>
          </div>
          <button type="submit" class="btn btn-primary btn-block" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? t('登录中…') : t('登录')}
            ${state.busy ? '' : svg(['M5 12h14', 'm12 5 7 7-7 7'], 14)}
          </button>
        </form>
        <p style="text-align: center; margin: 0; font-size: 14px; color: color-mix(in srgb, var(--color-text) 60%, transparent);">${t('还没有账号？联系管理员开通。')}</p>
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
    <span class="satu-label">${esc(t(item.label))}</span>
  </button>`
}

/**
 * 「对话」下面挂着的 Bot 名册。
 *
 * 挪到主导航里，是因为它本来就是**在一群人之间切换**——和左边那些页面入口是同一种
 * 动作，没理由在内容区里再占一栏。名册进来之后对话页只剩两栏：正文和运行环境。
 *
 * 只在对话相关的页面上展开：别的页面挂一串 Bot 是噪音。
 */
/**
 * 侧栏顶层的 Bot 名单。
 *
 * **不再挂在「对话」下面。** 这些 Bot 就是这个产品的主体——一个人管着几个 AI 员工，
 * 天天要看的是「谁在干活、谁刚回了话」。把它们藏在一个还要先点开的导航项里，等于
 * 把主角放进抽屉。所以提到顶层，做成聊天列表的样子：头像、名字、最近回复的时间、
 * 一行摘要，正在跑的转圈。
 *
 * 时间和摘要留空位不留内容：它们来自各自的事件流，每帧都在变（见 paintRoster），
 * 靠重绘整页去更新的话，一边打字一边就把侧栏刷没了。
 */
function chatRosterNav() {
  const bots = state.runtimeBots || []
  if (!bots.length) return ''
  const selected = chatBotIdOf(state.path) || state.chatBotId
  return bots
    .map((b) => {
      const sum = (botStreams.get(b.id) || {}).sum || { state: 'idle', lastAt: 0, lastText: '' }
      return `<button type="button" class="satu-botrow" data-act="chat-open" data-id="${esc(b.id)}" data-bot-row="${esc(b.id)}" aria-current="${b.id === selected}">
        ${/* 头像占满两行：名字和摘要并排在它右边，整行才像一条会话，而不是一个
             带小图标的菜单项。34 是 botAvatar 的默认尺寸，也正好等于两行的高度。 */ ''}
        <span class="satu-botavatar">${botAvatar(b.icon, 34, b.origin)}</span>
        <span class="satu-botmain">
          <span class="satu-botline">
            ${/* 状态点在名字**前面**：一列对齐的点，扫一眼就知道哪几个在动，
                 不用把视线甩到行尾去找。 */ ''}
            <span class="satu-botdot" data-state="${sum.state}" title="${esc(botStateLabel(sum.state))}" aria-label="${esc(botStateLabel(sum.state))}"></span>
            <span class="satu-botname">${esc(b.name || b.id)}</span>
            <time class="satu-bottime">${esc(sum.lastAt ? chatClock(sum.lastAt) : '')}</time>
          </span>
          ${/* 没有消息就不留这一行——空着一道灰边比少一行更碍眼。 */ ''}
          <span class="satu-botsnip"${sum.lastText ? '' : ' hidden'}>${esc(sum.lastText)}</span>
        </span>
      </button>`
    })
    .join('')
}

let rosterPaintQueued = false

/** 名单每帧都可能变（时间、摘要、转圈），跟正文一样合并到一帧里画。 */
function scheduleRosterPaint() {
  if (rosterPaintQueued) return
  rosterPaintQueued = true
  const run = () => {
    rosterPaintQueued = false
    paintRoster()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 16)
}

function botStateLabel(state) {
  if (state === 'busy') return t('正在执行')
  if (state === 'review') return t('待人工处理')
  return t('空闲')
}

/** 就地更新名单的状态点/时间/摘要。不重绘整页——那会把正在打字的输入框一起换掉。 */
function paintRoster() {
  for (const row of document.querySelectorAll('[data-bot-row]')) {
    const id = row.getAttribute('data-bot-row')
    const sum = (botStreams.get(id) || {}).sum
    if (!sum) continue
    const dot = row.querySelector('.satu-botdot')
    if (dot && dot.getAttribute('data-state') !== sum.state) {
      dot.setAttribute('data-state', sum.state)
      dot.title = botStateLabel(sum.state)
      dot.setAttribute('aria-label', botStateLabel(sum.state))
    }
    const time = row.querySelector('.satu-bottime')
    if (time) time.textContent = sum.lastAt ? chatClock(sum.lastAt) : ''
    const snip = row.querySelector('.satu-botsnip')
    if (snip) {
      snip.textContent = sum.lastText
      snip.hidden = !sum.lastText
    }
  }
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
  // 公司侧（管理员和员工）的 / 就是对话页；概览那一屏已经去掉了。
  if (isOwner()) return ownerOverviewPage()
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
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('概览')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('平台公司、用户、已配置供应商，以及日常 / utility 模型。')}</p>
        </div>
        ${flashes()}
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--space-3);">
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('公司')}</span>
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(orgs.length)}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('用户')}</span>
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(users.length)}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('日常任务模型')}</span>
            <span style="font-family: var(--font-heading); font-size: 18px; line-height: 1.2;">${esc(roleLabel('daily'))}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('Utility 模型')}</span>
            <span style="font-family: var(--font-heading); font-size: 18px; line-height: 1.2;">${esc(roleLabel('utility'))}</span>
          </div>
        </div>
        <div class="satu-panel">
          <span class="satu-panel-title">${t('已配置供应商')}</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('只显示名称。密钥不会出现在这里。')}</p>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
            ${
              configured.length
                ? configured.map((p) => `<span class="tag tag-accent">${esc(p)}</span>`).join('')
                : `<span style="font-size: 13px; color: var(--muted-foreground);">${t('还没有配置供应商。到「供应商」页添加密钥。')}</span>`
            }
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

/** 当前生效的报价倍率。没设过就是 1（按原价）。 */
function priceMultiplier() {
  const n = Number(state.settings?.priceMultiplier)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * 目录里「没有价」和「免费」长得一样：pi-ai 对没收录价格的模型（zai 这些）
 * 一律填 0。两个方向都是 0 时按「不知道」画成 —— 写成 $0.000 会被读成免费。
 */
function hasRates(cost) {
  return Number(cost?.input) > 0 || Number(cost?.output) > 0
}

function ratePair(cost, factor) {
  if (!hasRates(cost)) return `<span title="${esc(t('目录里没有这个模型的价格', 'The catalog has no price for this model'))}">—</span>`
  return `${esc(money(Number(cost.input || 0) * factor))} / ${esc(money(Number(cost.output || 0) * factor))}`
}

/** 倍率输入。改完即存，和上面两个角色面板一样不设「保存」按钮。 */
function pricePanel() {
  const mult = priceMultiplier()
  return `
    <div class="satu-panel">
      <span class="satu-panel-title">${t('单价倍率')}</span>
      <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('对外报价 = 模型原价 × 倍率。填 1 就是按原价。', 'Quoted price = list price × multiplier. 1 means list price.')}</p>
      <div class="satu-toggleRow">
        <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('倍率')}</div></div>
        <input class="input" style="width: 250px; flex: none;" type="number" inputmode="decimal"
          min="0.01" max="100" step="0.05" value="${esc(String(mult))}"
          data-act="price-multiplier" ${state.savingMultiplier ? 'disabled' : ''}>
      </div>
      <div class="satu-toggleRow">
        <div style="min-width: 0; font-size: 12px; color: var(--muted-foreground);">${t(`当前 ${mult} 倍，表里「倍率单价」按它算。`, `Currently ${mult}×; the "marked-up" column uses it.`)}</div>
      </div>
    </div>`
}

function rolePanel(role, title, hint) {
  const cur = state.settings?.[role] || { provider: '', model: '' }
  return `
    <div class="satu-panel">
      <span class="satu-panel-title">${esc(title)}</span>
      <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(hint)}</p>
      <div class="satu-toggleRow">
        <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('供应商')}</div></div>
        <select class="input" style="width: 250px; flex: none;" data-act="role-provider" data-role="${esc(role)}">
          <option value="">${t('选择供应商')}</option>
          ${providerOptions(cur.provider)}
        </select>
      </div>
      <div class="satu-toggleRow">
        <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('模型')}</div></div>
        <select class="input" style="width: 250px; flex: none;" data-act="role-model" data-role="${esc(role)}">
          <option value="">${t('选择模型')}</option>
          ${modelOptions(cur.provider, cur.model)}
        </select>
      </div>
      <div class="satu-toggleRow">
        <div style="min-width: 0;">${testMark('role', role)}</div>
        <button type="button" class="btn btn-ghost" style="flex: none;" data-act="test-role" data-role="${esc(role)}" ${!cur.provider || !cur.model || state.tests['role:' + role]?.status === 'busy' ? 'disabled' : ''}>${t('测试连通性')}</button>
      </div>
    </div>`
}

function modelsPage() {
  const shown = state.catalog.find((p) => p.provider === state.selectedProvider)
  const selected = shown?.provider || state.selectedProvider || ''
  const daily = state.settings?.daily || {}
  const utility = state.settings?.utility || {}
  const mult = priceMultiplier()

  const modelRows = (shown?.models || [])
    .map((m) => {
      const isDaily = daily.provider === shown.provider && daily.model === m.id
      const isUtil = utility.provider === shown.provider && utility.model === m.id
      const cost = m.cost && typeof m.cost === 'object' ? m.cost : {}
      const actions = `
        <div class="satu-rowactions">
          ${isDaily ? `<span class="tag tag-accent">${t('日常')}</span>` : `<button type="button" class="satu-linkbtn" data-act="set-role" data-role="daily" data-provider="${esc(shown.provider)}" data-model="${esc(m.id)}">${t('设为日常')}</button>`}
          ${isUtil ? '<span class="tag tag-accent-2">utility</span>' : `<button type="button" class="satu-linkbtn" data-act="set-role" data-role="utility" data-provider="${esc(shown.provider)}" data-model="${esc(m.id)}">${t('设为 utility')}</button>`}
        </div>`
      return `<div class="satu-modelrow">
        <div class="satu-tasklink" style="cursor: default;">
          <span style="font-weight: 600; font-size: 14px;">${esc(m.name)}</span>
          <span style="font-size: 12px; color: var(--muted-foreground);">${esc(m.id)}</span>
        </div>
        <span style="font-size: 13px;">${esc(shown.name || shown.provider)}</span>
        <div class="gw-caps">${capTags(m)}</div>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(tokens(m.contextWindow))}${m.maxTokens ? t(` · 出 ${esc(tokens(m.maxTokens))}`, ` · out ${esc(tokens(m.maxTokens))}`) : ''}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${ratePair(cost, 1)}</span>
        <span style="font-size: 13px; color: var(--foreground);">${ratePair(cost, mult)}</span>
        ${actions}
      </div>`
    })
    .join('')

  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('模型配置')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('目录来自 pi-ai；密钥在供应商页配置。密钥留在 Gateway，不会出现在本机磁盘或环境。')}</p>
        </div>
        ${flashes()}
        <div class="gw-roles">
          ${rolePanel('daily', t('日常任务模型'), t('用于日常工作。'))}
          ${rolePanel('utility', t('Utility 模型'), t('用于轻量、快速的任务。'))}
        </div>
        ${isOwner() ? pricePanel() : ''}
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
            <div style="display: flex; align-items: baseline; gap: var(--space-3);">
              <h2 style="font-size: 18px; margin: 0;">${t(`${esc(shown?.name || shown?.provider || '模型')} 的模型`, `${esc(shown?.name || shown?.provider || 'Provider')} models`)}</h2>
              <span style="font-size: 12px; color: var(--muted-foreground);">${t(`共 ${shown?.models.length ?? 0} 个`, `${shown?.models.length ?? 0} total`)}</span>
            </div>
            <select class="input" style="width: 220px; flex: none;" data-act="select-provider">
              <option value="">${t('选择供应商')}</option>
              ${providerOptions(selected)}
            </select>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-modelhead">
              <span>${t('模型')}</span><span>${t('供应商')}</span><span>${t('能力')}</span><span>${t('上下文 / 输出')}</span><span>${t('单价 / 1M tok')}</span><span>${t(`倍率单价 ×${mult}`, `Marked-up ×${mult}`)}</span><span></span>
            </div>
            ${modelRows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('选择已配置的供应商查看模型。')}</div>`}
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
    : `<option value="">${t('没有可添加的供应商')}</option>`
  return `
    <div class="gw-modal-backdrop" data-act="add-close">
      <div class="gw-modal" data-act="add-dialog" role="dialog" aria-modal="true" aria-labelledby="add-prov-title">
        <div>
          <h2 id="add-prov-title" style="font-size: 20px; margin: 0 0 4px;">${t('添加供应商')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('从目录选择尚未配置的供应商，粘贴 API 密钥。密钥只存在 Gateway，保存后不会回显。')}</p>
        </div>
        <form data-form="add-cred" style="display: flex; flex-direction: column; gap: var(--space-4);">
          <div class="field">
            <label for="add-provider">${t('供应商')}</label>
            <select class="input" id="add-provider" name="provider" required ${available.length ? '' : 'disabled'}>
              ${options}
            </select>
          </div>
          <div class="field">
            <label for="add-secret">${t('API 密钥')}</label>
            <input class="input" id="add-secret" name="secret" type="password" autocomplete="off" placeholder="${esc(t('API 密钥'))}" required>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
            <button type="button" class="btn btn-ghost" data-act="add-close">${t('取消')}</button>
            <button type="submit" class="btn btn-primary" ${state.busy || !available.length ? 'disabled' : ''}>${t('保存')}</button>
          </div>
        </form>
      </div>
    </div>`
}

/**
 * 列表 = 已配好密钥的内置供应商 ∪ 全部自定义供应商。
 *
 * 自定义的即使还没配密钥也要列出来——它是刚建出来的，不列的话没有地方能给它贴密钥。
 */
function providerRows() {
  const credBy = new Map((state.creds || []).map((c) => [c.provider, c]))
  const rows = configuredProviders().map((p) => ({
    provider: p.provider,
    name: p.name || p.provider,
    models: p.models || [],
    custom: null,
    cred: credBy.get(p.provider),
  }))
  const seen = new Set(rows.map((r) => r.provider))
  for (const c of state.customProviders || []) {
    const models = state.catalog.find((x) => x.provider === c.id)?.models || []
    const existing = rows.find((r) => r.provider === c.id)
    if (existing) {
      existing.custom = c
      existing.name = c.name || c.id
      continue
    }
    seen.add(c.id)
    rows.push({ provider: c.id, name: c.name || c.id, models, custom: c, cred: credBy.get(c.id) })
  }
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))
}

/** 用量金额。可能很小（$0.0004），也可能很大；小额要多给两位，否则全是 $0.00。 */
function usage$(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return '—'
  if (x === 0) return '$0'
  if (x < 0.01) return `$${x.toFixed(4)}`
  if (x < 1) return `$${x.toFixed(3)}`
  return `$${x.toFixed(2)}`
}

/** 精确的 token 数。tokens() 是给目录里的窗口用的，会四舍五入成 128K，统计不能那样。 */
function exactTokens(n) {
  return Number(n || 0).toLocaleString('en-US')
}

function statsPage() {
  const d = state.stats
  const month = state.statsMonth || thisMonth()
  const pill = (key, label) =>
    `<button type="button" class="btn ${state.statsRange === key ? 'btn-primary' : 'btn-ghost'}" data-act="stats-range" data-range="${key}">${label}</button>`

  const totals = d?.totals || { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, quotedUsd: 0, unpricedCalls: 0 }
  const cards = [
    [t('调用次数'), exactTokens(totals.calls)],
    [t('输入 Tokens'), exactTokens(totals.promptTokens)],
    [t('输出 Tokens'), exactTokens(totals.completionTokens)],
    [t('总 Tokens'), exactTokens(totals.promptTokens + totals.completionTokens)],
    [t('成本价'), usage$(totals.costUsd)],
    [t(`报价 ×${d?.multiplier ?? 1}`, `Quoted ×${d?.multiplier ?? 1}`), usage$(totals.quotedUsd)],
  ]
    .map(
      ([label, value]) => `<div class="satu-panel" style="gap: 4px;">
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(label)}</span>
        <span style="font-size: 22px; font-weight: 600;">${esc(value)}</span>
      </div>`,
    )
    .join('')

  const rows = (d?.byCompany || [])
    .map(
      (c) => `<div class="satu-statrow">
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(c.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${c.lastAt ? esc(fmtTime(c.lastAt)) : t('无调用')}</div>
        </div>
        <span style="font-size: 13px;">${esc(exactTokens(c.calls))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(exactTokens(c.promptTokens))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(exactTokens(c.completionTokens))}</span>
        <span style="font-size: 13px; font-weight: 600;">${esc(exactTokens(c.promptTokens + c.completionTokens))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(usage$(c.costUsd))}</span>
        <span style="font-size: 13px;">${esc(usage$(c.quotedUsd))}${c.unpricedCalls ? ` <span class="tag" title="${esc(t('这家公司有调用用的是没有单价的模型，金额没算进去'))}">${t('不全')}</span>` : ''}</span>
      </div>`,
    )
    .join('')

  const modelRows = (d?.byModel || [])
    .map(
      (m) => `<div class="satu-statrow" style="grid-template-columns: 2fr 1fr 1fr 1fr 1fr 1fr 1fr;">
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600;">${esc(m.model)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.provider)}</div>
        </div>
        <span style="font-size: 13px;">${esc(exactTokens(m.calls))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(exactTokens(m.promptTokens))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(exactTokens(m.completionTokens))}</span>
        <span style="font-size: 13px; font-weight: 600;">${esc(exactTokens(m.promptTokens + m.completionTokens))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${m.priced ? esc(usage$(m.costUsd)) : `<span title="${esc(t('目录里没有这个模型的单价'))}">—</span>`}</span>
        <span style="font-size: 13px;">${m.priced ? esc(usage$(m.quotedUsd)) : '—'}</span>
      </div>`,
    )
    .join('')

  const unpriced = d?.unpricedModels || []

  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('统计')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('各公司的 token 消耗。金额按模型单价折算，报价一列再乘单价倍率。', 'Token consumption per company. Amounts use model list prices; the quoted column also applies the price multiplier.')}</p>
        </div>
        ${flashes()}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          ${pill('today', t('今日'))}
          ${pill('7d', t('近 7 天'))}
          ${pill('month', t('月'))}
          ${state.statsRange === 'month' ? `<input class="input" type="month" style="width: 170px; flex: none;" value="${esc(month)}" data-act="stats-month">` : ''}
          <select class="input" style="width: 200px; flex: none;" data-act="stats-company">
            <option value="">${t('全部公司')}</option>
            ${(d?.companies || []).map((c) => `<option value="${esc(c.id)}" ${c.id === state.statsCompany ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
          <span style="font-size: 12px; color: var(--muted-foreground);">${state.statsLoading ? t('统计中…') : d ? `${esc(fmtTime(d.from))} — ${esc(fmtTime(d.to))}` : ''}</span>
        </div>
        ${
          unpriced.length
            ? `<div class="gw-flash gw-flash-err">${esc(t(`${unpriced.length} 个模型在目录里没有单价（${unpriced.slice(0, 3).join('、')}${unpriced.length > 3 ? ' …' : ''}），它们的调用没有计入金额。`, `${unpriced.length} model(s) have no price in the catalog (${unpriced.slice(0, 3).join(', ')}${unpriced.length > 3 ? ' …' : ''}); their calls are excluded from the amounts.`))}</div>`
            : ''
        }
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-3);">
          ${cards}
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <h2 style="font-size: 18px; margin: 0;">${t('按公司')}</h2>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-stathead">
              <span>${t('公司')}</span><span>${t('调用')}</span><span>${t('输入')}</span><span>${t('输出')}</span><span>${t('总计')}</span><span>${t('成本价')}</span><span>${t('报价')}</span>
            </div>
            ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${state.statsLoading ? t('统计中…') : t('这个时间段里没有调用。')}</div>`}
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <h2 style="font-size: 18px; margin: 0;">${t('按模型')}</h2>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-stathead" style="grid-template-columns: 2fr 1fr 1fr 1fr 1fr 1fr 1fr;">
              <span>${t('模型')}</span><span>${t('调用')}</span><span>${t('输入')}</span><span>${t('输出')}</span><span>${t('总计')}</span><span>${t('成本价')}</span><span>${t('报价')}</span>
            </div>
            ${modelRows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${state.statsLoading ? t('统计中…') : t('这个时间段里没有调用。')}</div>`}
          </div>
        </div>
      </div>
    </div>`
}

function providersPage() {
  const list = providerRows()

  const rows = list
    .map((p, i) => {
      const busy = state.tests['provider:' + p.provider]?.status === 'busy'
      const status = p.custom?.broken
        ? `<span class="tag tag-accent">${t('定义有误')}</span>`
        : p.cred
          ? `<span class="tag tag-accent">${t('已配置')}</span>`
          : `<span class="tag">${t('缺密钥')}</span>`
      return `<div class="satu-provrow">
        <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
          ${mark(p.name, i % 2 === 1)}
          <div style="min-width: 0;">
            <div style="font-size: 14px; font-weight: 600;">${esc(p.name)}${p.custom ? ` <span class="tag tag-accent-2">${t('自定义')}</span>` : ''}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${esc(p.provider)}${p.custom && !p.custom.broken ? ` · ${esc(p.custom.api)}` : ''}</div>
          </div>
        </div>
        <span style="font-size: 13px; color: var(--muted-foreground);">${t(`${p.models.length} 个`, `${p.models.length} models`)}</span>
        ${status}
        <form class="gw-secret" data-form="cred" data-provider="${esc(p.provider)}" data-id="${esc(p.cred?.id || '')}">
          <input class="input" name="secret" type="password" autocomplete="off" placeholder="${esc(p.cred ? t('输入新密钥以更新') : t('粘贴 API 密钥'))}" required>
        </form>
        <div class="gw-provactions">
          ${testMark('provider', p.provider) ? `<div class="gw-testline">${testMark('provider', p.provider)}</div>` : ''}
          ${p.custom ? `<button type="button" class="btn btn-ghost" data-act="prov-edit" data-provider="${esc(p.provider)}">${t('编辑')}</button>` : ''}
          ${p.custom ? `<button type="button" class="btn btn-ghost" data-act="prov-models" data-provider="${esc(p.provider)}">${t(`模型 ${p.custom.models?.length ?? 0}`, `Models ${p.custom.models?.length ?? 0}`)}</button>` : ''}
          <button type="button" class="btn btn-ghost" data-act="test-provider" data-provider="${esc(p.provider)}" ${busy ? 'disabled' : ''}>${t('测试')}</button>
          <button type="button" class="btn btn-primary" data-act="save-cred" data-provider="${esc(p.provider)}" data-id="${esc(p.cred?.id || '')}">${t('更新')}</button>
          <button type="button" class="satu-linkbtn" data-act="prov-delete" data-provider="${esc(p.provider)}" data-custom="${p.custom ? '1' : ''}">${t('删除')}</button>
        </div>
      </div>`
    })
    .join('')

  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('供应商')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('内置供应商配好密钥才列在这里；自定义供应商建出来就一直在。密钥只存在 Gateway，保存后不会回显。')}</p>
          </div>
          <div style="display: flex; gap: var(--space-2); flex: none;">
            ${isOwner() ? `<button type="button" class="btn btn-secondary" data-act="prov-new">${t('添加自定义供应商')}</button>` : ''}
            <button type="button" class="btn btn-primary" data-act="add-open">${t('添加供应商')}</button>
          </div>
        </div>
        ${flashes()}
        <div class="gw-credlist" style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-provhead">
            <span>${t('供应商')}</span><span>${t('模型')}</span><span>${t('状态')}</span><span>${t('密钥')}</span><span></span>
          </div>
          ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有配置供应商。点击「添加供应商」从目录里选一家并粘贴密钥，或者「添加自定义供应商」接一个自建端点。')}</div>`}
        </div>
      </div>
      ${addProviderModal()}
      ${customProviderModal()}
      ${providerModelsModal()}
    </div>`
}

/** 建 / 改自定义供应商。字段就是 pi-ai createProvider 的入参。 */
function customProviderModal() {
  const d = state.providerDraft
  if (!d) return ''
  const apis = state.customApis?.length ? state.customApis : ['openai-completions']
  return `
    <div class="gw-modal-backdrop" data-act="prov-close">
      <div class="gw-modal" data-stop role="dialog" aria-modal="true">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${d.editing ? t('编辑自定义供应商') : t('添加自定义供应商')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('字段与 pi-ai 的 createProvider 一致。建好之后在这一行贴密钥、加模型。', 'Fields match pi-ai createProvider. Add the key and models on the row afterwards.')}</p>
        </div>
        ${d.error ? `<div class="gw-flash gw-flash-err">${esc(d.error)}</div>` : ''}
        <div class="field">
          <label>${t('id')}</label>
          <input class="input" data-act="prov-field" data-field="id" value="${esc(d.id)}" ${d.editing ? 'disabled' : ''}
            placeholder="my-llm" autocomplete="off">
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('小写字母开头，字母数字和连字符。建好之后不能改——角色、密钥、用量都按它存。', 'Lowercase start, alphanumerics and hyphens. Immutable once created.')}</span>
        </div>
        <div class="field">
          <label>${t('名称')}</label>
          <input class="input" data-act="prov-field" data-field="name" value="${esc(d.name)}" placeholder="My LLM" autocomplete="off">
        </div>
        <div class="field">
          <label>baseUrl</label>
          <input class="input" data-act="prov-field" data-field="baseUrl" value="${esc(d.baseUrl)}" placeholder="https://api.example.com/v1" autocomplete="off">
        </div>
        <div class="field">
          <label>api</label>
          <select class="input" data-act="prov-field" data-field="api">
            ${apis.map((a) => `<option value="${esc(a)}" ${a === d.api ? 'selected' : ''}>${esc(a)}</option>`).join('')}
          </select>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('自建端点大多是 openai-completions。', 'Self-hosted endpoints are usually openai-completions.')}</span>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
          <button type="button" class="btn btn-ghost" data-act="prov-close">${t('取消')}</button>
          <button type="button" class="btn btn-primary" data-act="prov-save" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
        </div>
      </div>
    </div>`
}

/** 某个自定义供应商的模型清单。改完一次性提交整个 models 数组。 */
function providerModelsModal() {
  if (!state.modelsFor) return ''
  const p = customProvider(state.modelsFor)
  if (!p) return ''
  const d = state.modelDraft
  const rows = (p.models || [])
    .map(
      (m) => `<div class="satu-provrow" style="grid-template-columns: 2fr 1fr 1fr 88px;">
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600;">${esc(m.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.id)}</div>
        </div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(tokens(m.contextWindow))} / ${esc(tokens(m.maxTokens))}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(money(m.cost?.input))} / ${esc(money(m.cost?.output))}</span>
        <button type="button" class="satu-linkbtn" data-act="prov-model-del" data-model="${esc(m.id)}">${t('删除')}</button>
      </div>`,
    )
    .join('')
  return `
    <div class="gw-modal-backdrop" data-act="prov-models-close">
      <div class="gw-modal" data-stop role="dialog" aria-modal="true" style="max-width: 720px;">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t(`${esc(p.name)} 的模型`, `${esc(p.name)} models`)}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('单价按每 100 万 token 的美元填，和内置目录同一个单位。', 'Prices are USD per 1M tokens, same unit as the built-in catalog.')}</p>
        </div>
        ${state.providerError ? `<div class="gw-flash gw-flash-err">${esc(state.providerError)}</div>` : ''}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg);">
          ${rows || `<div style="padding: var(--space-5); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有模型。')}</div>`}
        </div>
        ${
          d
            ? `<div class="satu-panel">
          <span class="satu-panel-title">${t('新模型')}</span>
          <div class="field"><label>${t('模型 id')}</label><input class="input" data-act="model-field" data-field="id" value="${esc(d.id)}" placeholder="my-model" autocomplete="off"></div>
          <div class="field"><label>${t('名称')}</label><input class="input" data-act="model-field" data-field="name" value="${esc(d.name)}" placeholder="My Model" autocomplete="off"></div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="field"><label>${t('上下文窗口')}</label><input class="input" type="number" min="1" data-act="model-field" data-field="contextWindow" value="${esc(d.contextWindow)}"></div>
            <div class="field"><label>${t('最大输出')}</label><input class="input" type="number" min="1" data-act="model-field" data-field="maxTokens" value="${esc(d.maxTokens)}"></div>
            <div class="field"><label>${t('输入单价 / 1M')}</label><input class="input" type="number" min="0" step="0.01" data-act="model-field" data-field="costInput" value="${esc(d.costInput)}"></div>
            <div class="field"><label>${t('输出单价 / 1M')}</label><input class="input" type="number" min="0" step="0.01" data-act="model-field" data-field="costOutput" value="${esc(d.costOutput)}"></div>
          </div>
          <div class="satu-toggleRow">
            <div style="font-size: 13.5px; font-weight: 600;">${t('推理模型')}</div>
            <input type="checkbox" data-act="model-field" data-field="reasoning" ${d.reasoning ? 'checked' : ''}>
          </div>
          <div class="satu-toggleRow">
            <div style="font-size: 13.5px; font-weight: 600;">${t('支持图片输入')}</div>
            <input type="checkbox" data-act="model-field" data-field="image" ${d.image ? 'checked' : ''}>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
            <button type="button" class="btn btn-ghost" data-act="prov-model-cancel">${t('取消')}</button>
            <button type="button" class="btn btn-primary" data-act="prov-model-save" ${state.busy ? 'disabled' : ''}>${t('添加')}</button>
          </div>
        </div>`
            : `<button type="button" class="btn btn-secondary" data-act="prov-model-new">${t('添加模型')}</button>`
        }
        <div style="display: flex; justify-content: flex-end;">
          <button type="button" class="btn btn-ghost" data-act="prov-models-close">${t('完成')}</button>
        </div>
      </div>
    </div>`
}

function companyPage() {
  const c = state.org || state.me?.company || {}
  const plan = state.plan || state.me?.plan || { seats: 1, used: 0 }
  return `
    <div class="gw-page">
      <div class="gw-page-inner narrow">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('公司')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('名称、slug、联系人和访问地址。席位由系统管理员分配。')}</p>
        </div>
        ${flashes()}
        <form id="company-form" class="satu-panel" style="gap: var(--space-4);">
          <span class="satu-panel-title">${t('资料')}</span>
          <div class="field">
            <label for="co-name">${t('名称')}</label>
            <input class="input" id="co-name" name="name" value="${esc(c.name || '')}" required>
          </div>
          <div class="field">
            <label for="co-slug">slug</label>
            <input class="input" id="co-slug" name="slug" value="${esc(c.slug || '')}" required>
          </div>
          <div class="field">
            <label for="co-url">${t('访问地址')}</label>
            <input class="input" id="co-url" name="accessUrl" value="${esc(c.accessUrl || '')}" placeholder="https://acme.satuwork.com">
          </div>
          <div class="field">
            <label for="co-contact-name">${t('联系人')}</label>
            <input class="input" id="co-contact-name" name="contactName" value="${esc(c.contactName || '')}" required>
          </div>
          <div class="field">
            <label for="co-contact-phone">${t('电话')}</label>
            ${phoneField('co-contact-phone', c.contactPhone)}
          </div>
          <div class="field">
            <label for="co-contact-email">${t('联系邮箱')}</label>
            <input class="input" id="co-contact-email" name="contactEmail" type="email" value="${esc(c.contactEmail || '')}" required>
          </div>
          <div class="field">
            <label for="co-address">${t('公司地址')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
            <input class="input" id="co-address" name="address" value="${esc(c.address || '')}">
          </div>
          <div class="field">
            <label for="co-website">${t('网站')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
            <input class="input" id="co-website" name="website" value="${esc(c.website || '')}" placeholder="https://acme.com">
          </div>
          <div class="field">
            <label>${t('席位')}</label>
            <p style="margin: 0; font-size: 14px;">${t(`已用 ${esc(plan.used || 0)} / ${esc(plan.seats || 0)}`, `${esc(plan.used || 0)} / ${esc(plan.seats || 0)} used`)}</p>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('席位由系统管理员分配')}</span>
          </div>
          <div class="field">
            <label>${t('订阅套餐')}</label>
            <p style="margin: 0; font-size: 14px;">${esc(planLabel(plan) || t('无套餐'))}</p>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('到期时间')} ${esc(plan.expiresAt ? dayISO(plan.expiresAt) : t('不限期'))}</span>
          </div>
          <div style="display: flex; justify-content: flex-end;">
            <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
          </div>
        </form>
      </div>
    </div>`
}

function memberMeId() {
  return state.memberMe?.id || state.me?.account?.id || ''
}

function roleLabelOf(role) {
  if (role === 'admin') return t('管理员')
  if (role === 'owner') return t('系统管理员')
  return t('成员')
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
  if (!ts) return t('从未登录')
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return t('刚刚')
  if (m < 60) return t(`${m} 分钟前`, `${m} min ago`)
  if (m < 60 * 24) return t(`${Math.floor(m / 60)} 小时前`, `${Math.floor(m / 60)} h ago`)
  return t(`${Math.floor(m / 1440)} 天前`, `${Math.floor(m / 1440)} d ago`)
}

function canBeStatus(member, key) {
  return key === 'invited' ? member.status === 'invited' : member.status !== 'invited' || key === 'disabled'
}

function whyNotStatus(key) {
  return key === 'invited'
    ? t('已激活的账号退不回待接受。要让 TA 重设口令，用下面的重置链接。')
    : t('等 TA 用邀请链接设完口令，会自动转为已激活。')
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
        <button type="button" class="btn btn-secondary" data-act="confirm-cancel">${t('取消')}</button>
        <button type="button" class="btn btn-primary" data-act="confirm-ok">${esc(t(c.label))}</button>
      </div>
    </div>
  </div>`
}

function secretModal() {
  const s = state.secret
  if (!s) return ''
  const days = Math.max(0, Math.round((s.expiresAt - Date.now()) / 86400000))
  const hours = Math.max(0, Math.round((s.expiresAt - Date.now()) / 3600000))
  const ttl = days >= 1 ? t(`${days} 天后过期`, `expires in ${days} d`) : t(`${hours || 1} 小时内有效`, `valid for ${hours || 1} h`)
  return `<div class="gw-modal-backdrop" data-act="secret-close">
    <div class="gw-modal" data-stop>
      <div>
        <h2 style="font-size: 20px; margin: 0 0 4px;">${esc(s.title)}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
          ${t(`把这条链接发给 <b>${esc(s.email)}</b>，他打开后自行设置口令。链接只显示这一次，${esc(ttl)}，用过即失效。`, `Send this link to <b>${esc(s.email)}</b>; they set their own password. Shown once, ${esc(ttl)}, single use.`)}
        </p>
      </div>
      <div style="display: flex; align-items: center; gap: var(--space-2);">
        <code class="satu-code" style="flex: 1; min-width: 0; padding: 10px var(--space-3); font-size: 12.5px; overflow-x: auto; white-space: nowrap;">${esc(s.url)}</code>
        <button type="button" class="btn btn-secondary" style="flex: none;" data-act="secret-copy">${iconCopy()} ${state.inviteCopied && state.secret ? t('已复制') : t('复制')}</button>
      </div>
      <div style="display: flex; justify-content: flex-end;">
        <button type="button" class="btn btn-primary" data-act="secret-close">${t('我记下了')}</button>
      </div>
    </div>
  </div>`
}

function inviteModal() {
  if (!state.inviteOpen) return ''
  const f = state.inviteForm
  const link = state.inviteLink
  const btn = state.busy
    ? t('生成中…')
    : link
      ? state.inviteCopied
        ? t('已复制')
        : t('再复制一次')
      : t('生成并复制链接')
  return `<div class="gw-modal-backdrop" data-act="invite-close">
    <form id="invite-form" class="gw-modal" style="max-width: 500px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('邀请成员')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('生成一条一次性邀请链接，发给要加入的同事。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="invite-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
        <div class="field">
          <label for="iv-name">${t('姓名')}</label>
          <input class="input" id="iv-name" name="name" type="text" value="${esc(f.name)}" placeholder="${esc(t('受邀人姓名'))}" ${link ? 'disabled' : ''}>
        </div>
        <div class="field">
          <label for="iv-email">${t('邮箱')}</label>
          <input class="input" id="iv-email" name="email" type="email" required value="${esc(f.email)}" placeholder="name@acme.com" ${link ? 'disabled' : ''}>
        </div>
      </div>
      <span style="font-size: 12px; color: var(--muted-foreground); margin-top: calc(var(--space-3) * -1);">${t('链接只对该邮箱有效，对方打开后仅需设置口令即可加入。')}</span>
      <div class="field">
        <label for="iv-link">${t('一次性邀请链接')}</label>
        <input class="input" id="iv-link" type="text" readonly value="${esc(link)}" placeholder="${esc(t('点下方按钮生成'))}" style="min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;">
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('仅可使用 1 次，生成后按下方有效期失效。链接只显示这一次。')}</span>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
        <div class="field">
          <label for="iv-role">${t('角色')}</label>
          <select class="input" id="iv-role" name="role" ${link ? 'disabled' : ''}>
            <option value="member" ${f.role === 'member' ? 'selected' : ''}>${t('成员')}</option>
            <option value="admin" ${f.role === 'admin' ? 'selected' : ''}>${t('管理员')}</option>
          </select>
        </div>
        <div class="field">
          <label for="iv-ttl">${t('链接有效期')}</label>
          <select class="input" id="iv-ttl" name="ttlDays" ${link ? 'disabled' : ''}>
            <option value="1" ${String(f.ttlDays) === '1' ? 'selected' : ''}>${t('1 天')}</option>
            <option value="7" ${String(f.ttlDays) === '7' ? 'selected' : ''}>${t('7 天')}</option>
            <option value="30" ${String(f.ttlDays) === '30' ? 'selected' : ''}>${t('30 天')}</option>
          </select>
        </div>
      </div>
      ${state.inviteError ? `<div class="gw-flash gw-flash-err">${esc(state.inviteError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="invite-close">${link ? t('完成') : t('取消')}</button>
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
          <h2 style="font-size: 20px; margin: 0 0 4px;">${editing ? t('管理分组') : t('新建分组')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('分组用于批量授权与统计，成员可同时属于多个分组。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="group-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div class="field">
        <label for="gp-name">${t('分组名称')}</label>
        <input class="input" id="gp-name" name="name" type="text" required value="${esc(f.name)}" placeholder="${esc(t('例如：客服组'))}">
      </div>
      <div class="field">
        <label for="gp-desc">${t('说明（可选）')}</label>
        <input class="input" id="gp-desc" name="desc" type="text" value="${esc(f.desc)}" placeholder="${esc(t('这个分组负责什么'))}">
      </div>
      <div class="field">
        <label>${t('分组图标')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${icons}</div>
      </div>
      <div class="field">
        <label>${t('默认角色')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${roles}</div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('只影响之后被加进这个组的人，不改动已有成员的角色。')}</span>
      </div>
      <div class="field">
        <label>${t('成员')}</label>
        <div style="display: flex; flex-direction: column; gap: 1px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-2); max-height: 220px; overflow-y: auto;">
          ${people || `<span style="font-size: 12px; color: var(--muted-foreground); padding: 6px var(--space-2);">${t('还没有成员')}</span>`}
        </div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${t(`已选 ${picked.size} 人`, `${picked.size} selected`)}</span>
      </div>
      ${state.groupError ? `<div class="gw-flash gw-flash-err">${esc(state.groupError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="group-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : editing ? t('保存') : t('创建分组')}</button>
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
      return `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(f.status === key)}" ${disabled ? 'disabled' : ''} title="${ok ? '' : esc(whyNotStatus(key))}" data-act="edit-status" data-status="${key}">${t(MEMBER_STATUS[key].label)}</button>`
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
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('编辑成员')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('修改角色与状态，或给 TA 发一条口令重置链接。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="edit-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div style="display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
        <span class="satu-avatar" style="background: var(--color-accent-2-200); color: var(--color-accent-2-800);">${esc((member.name || member.email).slice(0, 1).toUpperCase())}</span>
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(member.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(member.email)}</div>
        </div>
      </div>
      <div class="field">
        <label for="em-name">${t('姓名')}</label>
        <input class="input" id="em-name" name="name" type="text" required value="${esc(f.name)}">
      </div>
      <div class="field">
        <label>${t('角色')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${roleBtns}</div>
      </div>
      <div class="field">
        <label>${t('状态')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${statusBtns}</div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint)}</span>
      </div>
      ${isSelf ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('不能改自己的角色与状态——手滑一次就把自己关在门外。')}</span>` : ''}
      <div style="display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3);">
          <div style="min-width: 0;">
            <div style="font-size: 13.5px; font-weight: 600;">${t('口令重置链接')}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${t('生成后自行发给成员，1 小时内有效且仅能使用一次')}</div>
          </div>
          <button type="button" class="btn btn-secondary" style="flex: none;" data-act="edit-reset">${state.editLink ? t('重新生成') : t('生成链接')}</button>
        </div>
        ${
          state.editLink
            ? `<div style="display: flex; align-items: center; gap: var(--space-2);">
            <code class="satu-code" style="flex: 1; min-width: 0; padding: 8px var(--space-3); font-size: 12px; overflow-x: auto; white-space: nowrap;">${esc(state.editLink)}</code>
            <button type="button" class="btn btn-secondary" style="flex: none;" data-act="edit-copy">${iconCopy()} ${state.editCopied ? t('已复制') : t('复制')}</button>
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('生成的同时，TA 当前的登录已全部失效。链接只显示这一次。Gateway 没有会话表，签发早于作废时间的 JWT 会被拒，未过期的票在此之前仍可能可用。')}</span>`
            : ''
        }
      </div>
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="edit-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('保存')}</button>
      </div>
    </form>
  </div>`
}

function memberRow(m) {
  const meId = memberMeId()
  const isSelf = m.id === meId
  const st = MEMBER_STATUS[m.status] || MEMBER_STATUS.active
  const last =
    isSelf ? t('正在使用') : m.status === 'invited' ? t(`邀请于 ${new Date(m.createdAt).toLocaleDateString('zh-CN')}`, `Invited ${new Date(m.createdAt).toLocaleDateString('en-US')}`) : ago(m.lastSeenAt)
  const canManage = isAdmin() || isOwner()
  const menu = state.menu === m.id
    ? `<div class="satu-menu" data-flip="${String(!!state.menuFlip)}">
        <button type="button" class="satu-menuitem" data-act="edit-open" data-id="${esc(m.id)}">${t('编辑成员')}</button>
        <button type="button" class="satu-menuitem" data-act="member-reset" data-id="${esc(m.id)}">${m.status === 'invited' ? t('重发邀请') : t('重置口令')}</button>
        ${
          m.status !== 'active'
            ? `<button type="button" class="satu-menuitem" ${m.status === 'invited' ? 'disabled' : ''} title="${m.status === 'invited' ? t('等 TA 用邀请链接设完口令，会自动转为已激活。') : ''}" data-act="member-enable" data-id="${esc(m.id)}">${t(MEMBER_STATUS.active.label)}</button>`
            : ''
        }
        ${
          m.status !== 'disabled'
            ? `<button type="button" class="satu-menuitem" data-act="member-disable" data-id="${esc(m.id)}">${t(MEMBER_STATUS.disabled.label)}</button>`
            : ''
        }
        <div style="height: 1px; background: var(--border); margin: 4px 0;"></div>
        <button type="button" class="satu-menuitem" data-danger="true" data-act="member-delete" data-id="${esc(m.id)}">${t('删除')}</button>
      </div>`
    : ''
  return `<div class="satu-memberrow">
    <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
      <span class="satu-avatar" style="background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc((m.name || m.email).slice(0, 1).toUpperCase())}</span>
      <div style="min-width: 0;">
        <div style="font-size: 13.5px; font-weight: 600;">${esc(m.name || m.email)}${isSelf ? t(' · 你') : ''}</div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.email)}</div>
      </div>
    </div>
    <span style="font-size: 13px;">${esc(roleLabelOf(m.role))}</span>
    <span class="tag ${st.tag}">${t(st.label)}</span>
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(last)}</span>
    <div class="satu-rowactions" style="display: flex; justify-content: flex-end; position: relative;">
      ${isSelf ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('你')}</span>` : ''}
      ${
        canManage
          ? `<button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('编辑成员'))}" data-act="edit-open" data-id="${esc(m.id)}">${svg(['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'], 15)}</button>`
          : ''
      }
      ${
        canManage && !isSelf
          ? `<button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('更多操作'))}" data-menu-toggle data-act="menu-toggle" data-id="${esc(m.id)}">${svg(['M12 6h.01', 'M12 12h.01', 'M12 18h.01'], 16)}</button>`
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
    ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('自动包含全部成员')}</span>`
    : `<button type="button" class="satu-linkbtn" ${canManage ? '' : 'disabled'} data-act="group-edit" data-id="${esc(g.id)}">${t('管理成员')}</button>
       <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('删除分组'))}" ${canManage ? '' : 'disabled'} data-act="group-delete" data-id="${esc(g.id)}">${svg(['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14'], 15)}</button>`
  const role = g.builtin ? t('按成员设置') : roleLabelOf(g.role)
  const created = g.createdAt ? new Date(g.createdAt).toISOString().slice(0, 10) : '—'
  const n = Array.isArray(g.members) ? g.members.length : 0
  return `<div class="satu-grouprow">
    <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
      <span class="satu-providermark" style="${markStyle}">${groupIcon(g.icon, 16)}</span>
      <div style="min-width: 0;">
        <div style="display: flex; align-items: center; gap: var(--space-2);">
          <span style="font-size: 14px; font-weight: 600;">${esc(g.name)}</span>
          ${g.builtin ? `<span class="tag tag-accent-2">${t('固定分组')}</span>` : ''}
        </div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${esc(g.desc || '')}</div>
      </div>
    </div>
    <span style="font-size: 13px;">${t(`${n} 人`, `${n} people`)}</span>
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
  const headerLabel = tab === 'members' ? t('邀请成员') : t('新建分组')
  const tabs = [
    { key: 'members', label: '成员' },
    { key: 'groups', label: '分组' },
  ]
    .map(
      (item) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === item.key)}" data-act="accounts-tab" data-tab="${item.key}">${t(item.label)}</button>`,
    )
    .join('')
  const membersBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-6);">
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-3);">
            ${statCard(t('成员'), members.length)}
            ${statCard(t('管理员'), admins)}
            ${statCard(t('待接受邀请'), pending)}
            ${statCard(t('席位余量'), left)}
          </div>
          <div style="display: flex; flex-direction: column; gap: var(--space-3);">
            <div style="display: flex; align-items: baseline; justify-content: space-between;">
              <h2 style="font-size: 18px; margin: 0;">${t('成员')}</h2>
              <span style="font-size: 12px; color: var(--muted-foreground);">${t(`共 ${members.length} 人`, `${members.length} people`)}</span>
            </div>
            <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
              <div class="satu-memberhead">
                <span>${t('成员')}</span><span>${t('角色')}</span><span>${t('状态')}</span><span>${t('最近活跃')}</span><span></span>
              </div>
              ${members.map(memberRow).join('') || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有成员')}</div>`}
            </div>
          </div>
        </div>`
  const groupsBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-grouphead">
              <span>${t('分组')}</span><span>${t('成员')}</span><span>${t('默认角色')}</span><span>${t('创建时间')}</span><span></span>
            </div>
            ${groups.map(groupRow).join('') || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有分组')}</div>`}
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('「全体成员」为系统固定分组，新成员加入后自动进入，不可删除或移除成员。')}</span>
        </div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('账号管理')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('邀请同事加入，并管理成员角色与权限。')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" ${canManage ? '' : 'disabled'} title="${canManage ? '' : t('需要管理员权限')}" data-act="${headerAct}">
            ${svg(['M12 5v14', 'M5 12h14'], 15)} ${headerLabel}
          </button>
        </div>
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">${tabs}</div>
        ${flashes()}
        ${tab === 'members' ? membersBody : groupsBody}
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('成员这一半是真的：停用会当场作废对方已签发的 JWT（签发早于作废时间的票会被拒），重置口令同样作废旧登录。角色与权限的判断在服务端，界面上的禁用只是提前告诉你结果。Gateway 没有会话表，未过期且签发于作废之后的 JWT 仍可用，直到过期；停用账号登录会被拒绝。')}</p>
      </div>
    </div>
    ${inviteModal()}
    ${editModal()}
    ${groupModal()}
    ${secretModal()}`
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
        <p style="font-family: var(--font-heading); font-size: 26px; line-height: 1.2; margin: 0;">${t('加入同事的工作区，设置你自己的口令。')}</p>
        <p style="margin: 0; color: color-mix(in srgb, var(--color-text) 65%, transparent); font-size: 14px; line-height: 1.6;">${t('管理员从头到尾看不到你的口令。链接只用一次。')}</p>
      </div>
      <div style="position: relative; display: flex; gap: var(--space-4); font-size: 12px; color: color-mix(in srgb, var(--color-text) 55%, transparent);">
        <span>© 2026 Satuwork</span>
      </div>
    </div>`
  let inner
  if (inv.loading) {
    inner = `<p style="margin: 0; color: var(--muted-foreground);">${t('载入邀请…')}</p>`
  } else if (!inv.valid) {
    inner = `
      <div style="display: flex; flex-direction: column; gap: var(--space-4); align-items: flex-start;">
        <span class="tag tag-accent">${t('邀请已失效')}</span>
        <h1 style="font-size: 28px; margin: 0;">${t('这条邀请链接不可用')}</h1>
        <p style="margin: 0; color: var(--muted-foreground); font-size: 14px; line-height: 1.6;">${t('链接可能已过期、已被使用，或管理员重新生成了新的邀请。请联系邀请你的人重新发一条。')}</p>
        ${inv.error ? `<div class="gw-flash gw-flash-err">${esc(inv.error)}</div>` : ''}
        <button type="button" class="btn btn-secondary" data-act="join-login">${t('返回登录')}</button>
      </div>`
  } else {
    const f = state.joinForm
    inner = `
      <div style="display: flex; flex-direction: column; gap: var(--space-6);">
        <div>
          <span class="tag tag-accent-2">${t('邀请有效')}</span>
          <h1 style="font-size: 28px; margin: var(--space-3) 0 var(--space-2);">${t('设置登录口令')}</h1>
          <p style="margin: 0; color: var(--muted-foreground); font-size: 14px;">${t('你的账号信息已由管理员填好，设置口令即可加入。')}</p>
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
            <label for="jn-name">${t('姓名')}</label>
            <input class="input satu-input" id="jn-name" name="name" type="text" value="${esc(f.name)}" placeholder="${esc(t('你的姓名'))}" autocomplete="name">
          </div>
          <div class="field">
            <label for="jn-pw">${t('设置口令')}</label>
            <input class="input satu-input" id="jn-pw" name="password" type="password" required minlength="10" placeholder="${esc(t('至少 10 位'))}" autocomplete="new-password">
          </div>
          <div class="field">
            <label for="jn-pw2">${t('确认口令')}</label>
            <input class="input satu-input" id="jn-pw2" name="confirm" type="password" required minlength="10" placeholder="${esc(t('再输一次'))}" autocomplete="new-password">
          </div>
          ${state.joinError ? `<div class="gw-flash gw-flash-err">${esc(state.joinError)}</div>` : ''}
          <button type="submit" class="btn btn-primary btn-block" ${state.busy ? 'disabled' : ''}>
            ${state.busy ? t('加入中…') : t('加入 Satuwork')}
            ${state.busy ? '' : svg(['M5 12h14', 'm12 5 7 7-7 7'], 14)}
          </button>
        </form>
        <p style="text-align: center; margin: 0; font-size: 14px; color: color-mix(in srgb, var(--color-text) 60%, transparent);">
          ${t('已经有账号？')}
          <button type="button" class="satu-linkbtn" data-act="join-login">${t('直接登录')}</button>
        </p>
      </div>`
  }
  return `<div class="gw-login">${side}<div style="position: relative; display: flex; align-items: center; justify-content: center; padding: var(--space-8);"><div style="width: 100%; max-width: 400px;">${inner}</div></div></div>`
}


function auditTranscript(events) {
  const blocks = []
  for (const ev of events || []) {
    if (ev.type === 'user/message' || ev.type === 'assistant/message') {
      // messageText 收的是整条 message，不是它的 content 数组。
      const text = messageText(ev.data && ev.data.message)
      const role = ev.type === 'user/message' ? 'user' : 'ai'
      const label = role === 'user' ? t('员工') : t('助理')
      blocks.push(`<div class="satu-dbmsg" data-role="${role}" style="white-space: pre-wrap; overflow: visible;">
        <div style="font-size: 11.5px; font-weight: 600; margin-bottom: 4px; opacity: 0.7;">${label}</div>
        ${esc(text || t('（空）'))}
      </div>`)
      continue
    }
    if (ev.type === 'tool/call') {
      const name = (ev.data && ev.data.name) || t('工具')
      blocks.push(`<div style="font-size: 12px; color: var(--muted-foreground);">${esc(t('工具 ') + name)}</div>`)
      continue
    }
    if (ev.type === 'tool/result') {
      const text = (ev.data && ev.data.text) || ''
      blocks.push(`<div style="font-size: 12px; color: var(--muted-foreground);">${esc(t('结果 ') + String(text).slice(0, 240))}</div>`)
    }
  }
  if (!blocks.length) {
    return `<div style="padding: var(--space-4); font-size: 13px; color: var(--muted-foreground);">${t('没有消息')}</div>`
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
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === item.key)}" data-act="audit-tab" data-tab="${item.key}">${t(item.label)}</button>`,
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
            <span>${t('事件')}</span><span>${t('时间')}</span><span>${t('账号')}</span><span>${t('详情')}</span><span></span>
          </div>
          ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有审计事件')}</div>`}
        </div>`
}

function auditChatsTable() {
  const members = state.accounts || []
  const opts = [`<option value="">${t('全部')}</option>`]
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
        <span style="font-size: 13.5px; font-weight: 600;">${esc(row.title || t('未命名'))}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(row.accountName || row.accountId || '—')}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(row.botName || row.botId || '—')}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(fmtTime(row.updatedAt))}</span>
        <button type="button" class="satu-linkbtn" data-act="go" data-href="/audit/${esc(row.sessionId)}">${t('打开')}</button>
      </div>`
    })
    .join('')
  return `
        <form id="audit-filter-form" style="display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: flex-end;">
          <div class="field" style="margin: 0;">
            <label for="audit-account">${t('员工')}</label>
            <select class="input" id="audit-account" name="accountId" style="width: 200px;">${opts}</select>
          </div>
          <div class="field" style="margin: 0;">
            <label for="audit-from">${t('开始日期')}</label>
            <input class="input" id="audit-from" name="from" type="date" value="${esc(state.sessionFrom || '')}">
          </div>
          <div class="field" style="margin: 0;">
            <label for="audit-to">${t('结束日期')}</label>
            <input class="input" id="audit-to" name="to" type="date" value="${esc(state.sessionTo || '')}">
          </div>
          <button type="submit" class="btn btn-secondary" style="flex: none;">${t('筛选')}</button>
        </form>
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-usagehead" style="${grid}">
            <span>${t('标题')}</span><span>${t('员工')}</span><span>Bot</span><span>${t('更新时间')}</span><span>${t('打开')}</span>
          </div>
          ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有对话索引。实例上报之后会列在这里。')}</div>`}
        </div>
        ${
          state.sessionsHasMore
            ? `<div style="display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;">
                 <button type="button" class="btn btn-secondary" style="flex: none;" data-act="sessions-more"${
                   state.sessionsLoadingMore ? ' disabled' : ''
                 }>${state.sessionsLoadingMore ? t('加载中…') : t('加载更多')}</button>
                 <span style="font-size: 13px; color: var(--muted-foreground);">${esc(
                   t(
                     `已列出 ${(state.sessions || []).length} 条，还有更早的。`,
                     `${(state.sessions || []).length} listed so far; there are older ones.`,
                   ),
                 )}</span>
               </div>`
            : ''
        }`
}

function auditPage() {
  const tab = state.auditTab === 'events' ? 'events' : 'chats'
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('审计')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('查看公司成员的对话。全文在执行机器上，这里只存索引。')}</p>
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
        ${flashes()}
        <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('找不到这条对话。')}</p>
      </div>
    </div>`
  }
  const err = state.sessionPullError
  const events = state.sessionEvents
  let body
  if (err) {
    body = `<div class="gw-flash gw-flash-err">${esc(err)}</div>`
  } else if (events == null) {
    body = `<div class="gw-flash gw-flash-err">${t('机器不在线，全文拉不下来')}</div>`
  } else {
    body = auditTranscript(events)
  }
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          ${/* 返回在内容区头上的面包屑里，这儿不再重复一个。 */ ''}
          <h1 style="font-size: 24px; margin: 0 0 4px;">${esc(row.title || t('未命名'))}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(row.accountName || row.accountId || '—')} · ${esc(fmtTime(row.updatedAt || row.createdAt))}</p>
        </div>
        ${flashes()}
        ${body}
      </div>
    </div>`
}

function roleTag(role) {
  if (role === 'owner') return `<span class="tag tag-accent">${t('系统管理员')}</span>`
  if (role === 'admin') return `<span class="tag tag-accent">${t('管理员')}</span>`
  return `<span class="tag tag-neutral">${t('成员')}</span>`
}

function companyStatusTag(status) {
  return status === 'disabled'
    ? `<span class="tag tag-neutral">${t('已停用')}</span>`
    : `<span class="tag tag-accent-2">${t('生效中')}</span>`
}

/** 套餐名：界面语言是英文且这条套餐存了英文名就用英文名——套餐名是数据，译表翻不了。 */
function planLabel(plan) {
  if (!plan) return ''
  return (localeMode === 'en' && plan.skuNameEn ? plan.skuNameEn : plan.skuName) || ''
}

/**
 * 常用国家区号。国家名是**数据**不是文案，中英各写一份，别丢进译表。
 * 不求全：列里没有的号码照样存得下（见 phoneParts），只是要手填。
 */
const PHONE_CODES = [
  { code: '+86', zh: '中国', en: 'China' },
  { code: '+852', zh: '香港', en: 'Hong Kong' },
  { code: '+853', zh: '澳门', en: 'Macau' },
  { code: '+886', zh: '台湾', en: 'Taiwan' },
  { code: '+65', zh: '新加坡', en: 'Singapore' },
  { code: '+60', zh: '马来西亚', en: 'Malaysia' },
  { code: '+62', zh: '印尼', en: 'Indonesia' },
  { code: '+66', zh: '泰国', en: 'Thailand' },
  { code: '+84', zh: '越南', en: 'Vietnam' },
  { code: '+63', zh: '菲律宾', en: 'Philippines' },
  { code: '+81', zh: '日本', en: 'Japan' },
  { code: '+82', zh: '韩国', en: 'South Korea' },
  { code: '+91', zh: '印度', en: 'India' },
  { code: '+61', zh: '澳大利亚', en: 'Australia' },
  { code: '+1', zh: '美国 / 加拿大', en: 'US / Canada' },
  { code: '+44', zh: '英国', en: 'United Kingdom' },
  { code: '+49', zh: '德国', en: 'Germany' },
  { code: '+33', zh: '法国', en: 'France' },
  { code: '+971', zh: '阿联酋', en: 'UAE' },
]
const PHONE_CODE_DEFAULT = '+86'

/** 库里存的是一整串 `+86 13800000000`，编辑时拆成区号和号码两格。 */
function phoneParts(raw) {
  const s = String(raw || '').trim()
  const m = s.match(/^(\+\d{1,4})[\s-]*(.*)$/)
  if (!m) return { code: PHONE_CODE_DEFAULT, number: s }
  return { code: m[1], number: m[2].trim() }
}

/**
 * 区号 + 号码两格。区号是下拉，但库里那条不在列表里时把它补进去——
 * 否则一打开表单就被默默改成了别的国家。
 */
function phoneField(idPrefix, value, required = true) {
  const { code, number } = phoneParts(value)
  const codes = PHONE_CODES.some((c) => c.code === code) ? PHONE_CODES : [{ code, zh: code, en: code }, ...PHONE_CODES]
  return `<div style="display: flex; gap: var(--space-2);">
    <select class="input" id="${idPrefix}-code" name="contactPhoneCode" style="width: 132px; flex: none;" aria-label="${esc(t('国家区号'))}">
      ${codes
        .map((c) => `<option value="${esc(c.code)}" ${c.code === code ? 'selected' : ''}>${esc(c.code)} ${esc(localeMode === 'en' ? c.en : c.zh)}</option>`)
        .join('')}
    </select>
    <input class="input" id="${idPrefix}" name="contactPhone" type="tel" value="${esc(number)}" ${required ? 'required' : ''} placeholder="13800000000">
  </div>`
}

/** 提交时再拼回一整串。号码里的空格保留，人怎么填就怎么存。 */
function phoneValue(fd) {
  const code = String(fd.get('contactPhoneCode') || PHONE_CODE_DEFAULT).trim()
  const number = String(fd.get('contactPhone') || '').trim()
  if (!number) return ''
  return number.startsWith('+') ? number : `${code} ${number}`
}

function orgCreateModal() {
  if (!state.orgCreateOpen) return ''
  return `<div class="gw-modal-backdrop" data-act="org-create-close">
    <form id="create-org-form" class="gw-modal" style="max-width: 500px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('新建公司')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('创建公司并指定一名管理员。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="org-create-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      ${state.orgCreateError ? `<div class="gw-flash gw-flash-err">${esc(state.orgCreateError)}</div>` : ''}
      <div class="field">
        <label for="org-name">${t('名称')}</label>
        <input class="input" id="org-name" name="name" required>
      </div>
      <div class="field">
        <label for="org-slug">slug</label>
        <input class="input" id="org-slug" name="slug" required>
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('访问地址里的短名，小写字母开头，只能用字母数字和连字符')}</span>
      </div>
      <div class="field">
        <label for="org-contact-name">${t('联系人')}</label>
        <input class="input" id="org-contact-name" name="contactName" required>
      </div>
      <div class="field">
        <label for="org-contact-phone">${t('电话')}</label>
        ${phoneField('org-contact-phone', '')}
      </div>
      <div class="field">
        <label for="org-contact-email">${t('联系邮箱')}</label>
        <input class="input" id="org-contact-email" name="contactEmail" type="email" required>
      </div>
      <div class="field">
        <label for="org-address">${t('公司地址')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
        <input class="input" id="org-address" name="address">
      </div>
      <div class="field">
        <label for="org-website">${t('网站')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
        <input class="input" id="org-website" name="website" placeholder="https://acme.com">
      </div>
      <div class="field">
        <label for="org-admin-email">${t('管理员邮箱')}</label>
        <input class="input" id="org-admin-email" name="adminEmail" type="email" required>
      </div>
      <div class="field">
        <label for="org-admin-password">${t('管理员口令')}</label>
        <input class="input" id="org-admin-password" name="adminPassword" type="password" minlength="10" required>
      </div>
      <div class="field">
        <label for="org-admin-password2">${t('确认管理员口令')}</label>
        <input class="input" id="org-admin-password2" name="adminPassword2" type="password" minlength="10" required>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="org-create-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('创建中…') : t('创建')}</button>
      </div>
    </form>
  </div>`
}

function companiesPage() {
  // 席位那一列拿掉了：席位在公司详情的订阅里管，列表看的是「这家是谁、订了什么、什么时候到期」。
  const cols = 'minmax(160px, 1.8fr) 84px minmax(90px, 1fr) minmax(120px, 1fr) minmax(150px, 1.4fr) minmax(110px, 1fr) 104px'
  const cell = (text) =>
    `<span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(text || '—')}</span>`
  const rows = (state.orgs || [])
    .map((c) => {
      const plan = c.plan || {}
      return `<div class="satu-memberrow" style="cursor: pointer; grid-template-columns: ${cols};" data-act="go" data-href="/companies/${esc(c.id)}">
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(c.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(c.slug)}</div>
        </div>
        ${companyStatusTag(c.status)}
        ${cell(c.contactName)}
        ${cell(c.contactPhone)}
        ${cell(c.contactEmail)}
        ${cell(planLabel(plan))}
        ${cell(plan.expiresAt ? dayISO(plan.expiresAt) : t('不限期'))}
      </div>`
    })
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('公司')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('所有注册公司。点进去改资料、定套餐、分席位。')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" data-act="org-create-open">${t('新建公司')}</button>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-memberhead" style="grid-template-columns: ${cols};">
            <span>${t('公司')}</span><span>${t('状态')}</span><span>${t('联系人')}</span><span>${t('电话')}</span><span>${t('联系邮箱')}</span><span>${t('订阅套餐')}</span><span>${t('到期时间')}</span>
          </div>
          ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有公司')}</div>`}
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

/**
 * 上传示例。**先在 Linux 上打包**那一步不能省：包里带 esbuild 的原生二进制，在
 * Mac 上打的解到席位机器上 tsx 加载不了它，bot 起不来。pack.mjs 会拦，但示例里
 * 直接给对的做法，比让人先撞一次再看报错强。
 */
const UPLOAD_SNIPPET = `# 打包（Linux，架构要和席位机器一致）
node bot/pack.mjs --upload "$GATEWAY_URL"
# 或者手动传已有的包
curl -sf -X PUT "$GATEWAY_URL/platform/bot-releases/$VERSION" \\
  -H "Authorization: Bearer $GATEWAY_PLATFORM_TOKEN" \\
  -H "X-Bot-Sha256: $(shasum -a 256 bot.tgz | cut -d' ' -f1)" \\
  --data-binary @bot.tgz`

/**
 * 机器配置。两个 tab：机器管家、Bot 运行时。
 *
 * 两边是同一套东西——按版本发布的包、一张列表、一个新增表单——只是 kind 不同，
 * 所以渲染共用 `releaseSection`，避免两份会各自漂移的相似代码。
 */
function releasesPage() {
  const tab = state.machineTab === 'bot' ? 'bot' : 'manager'
  const tabBtn = (id, label) =>
    `<button type="button" class="btn ${tab === id ? 'btn-primary' : ''}" data-act="machine-tab" data-tab="${id}">${label}</button>`
  const body =
    tab === 'manager'
      ? releaseSection({
          kind: 'manager',
          title: t('机器管家'),
          hint: t('机器心跳时拿到期望版本，自己换版并在失败时回滚。留空表示跟最新发布走。'),
          data: state.managerReleases,
          desired: true,
        })
      : releaseSection({
          kind: 'bot',
          title: t('Bot 运行时'),
          hint: t('部署席位时用最新版本；也可以在部署时指定某一版。'),
          data: { releases: state.releases || [], latest: state.latestRelease, desired: '' },
          desired: false,
        })
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('机器配置')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('Gateway 只登记和分发发布包，自己不构建。包必须在 Linux 上打，架构要和席位机器一致。')}</p>
          <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted-foreground);">${t('下载地址就是那台 Debian 拉包用的 URL，凭机器令牌访问（curl -H "Authorization: Bearer smt_…"）。管家自己会带上，这里给出来是为了能人工核对。')}</p>
        </div>
        ${flashes()}
        <div style="display: flex; gap: var(--space-2);">
          ${tabBtn('manager', t('机器管家'))}${tabBtn('bot', t('Bot 运行时'))}
        </div>
        ${body}
      </div>
    </div>`
}

function releaseRow(r, latest) {
  // 下载地址永远给出来，**包括字节就在 Gateway 磁盘上的时候**：那台 Debian 上没有
  // 别的地方能看到它，这一栏写「本机存储」等于没给。字节在哪儿降级成一行小字。
  const dl = r.downloadUrl || r.url || ''
  const from = r.url ? `${t('外部来源')} ${esc(r.url)}` : t('本机存储')
  const where = `<span style="display: flex; flex-direction: column; gap: 2px; min-width: 0;">
      <span style="font-family: var(--font-mono, ui-monospace, monospace); word-break: break-all;">${esc(dl)}</span>
      <span style="color: var(--muted-foreground); word-break: break-all;">${from}${dl ? ` · <button type="button" class="satu-linkbtn" data-act="copy-release-url" data-url="${esc(dl)}">${t('复制')}</button>` : ''}</span>
    </span>`
  return `<div class="satu-memberrow" style="grid-template-columns: 200px 90px 120px 1fr 150px;">
    <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; word-break: break-all;">${esc(r.version)}${r.version === latest ? ` <span class="tag tag-accent">${t('最新')}</span>` : ''}</span>
    <span style="font-size: 13px;">${esc(fmtSize(r.size))}</span>
    <span style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--muted-foreground);">${esc(shaShort(r.sha256))}</span>
    <span style="font-size: 12px;">${where}</span>
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(fmtTime(r.createdAt))}</span>
  </div>`
}

function releaseSection({ kind, title, hint, data, desired }) {
  const d = data || { releases: [], latest: null, desired: '' }
  const rows = d.releases || []
  const table = rows.length
    ? `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); overflow: hidden;">
        <div class="satu-memberhead" style="grid-template-columns: 200px 90px 120px 1fr 150px;">
          <span>${t('版本')}</span><span>${t('大小')}</span><span>sha256</span><span>${t('下载地址')}</span><span>${t('时间')}</span>
        </div>
        ${rows.map((r) => releaseRow(r, d.latest)).join('')}
      </div>`
    : `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground); border: 1px solid var(--border); border-radius: var(--radius-lg);">${t('还没有发布版本')}</div>`
  // 期望版本只有管家有：bot 是部署时挑版本，管家是机器自己去追一个目标版本。
  const desiredForm = desired
    ? `<form data-form="manager-version" style="display: flex; gap: var(--space-2); align-items: flex-end;">
        <div class="field" style="margin: 0; flex: 1;">
          <label for="mgr-ver">${t('期望版本')}</label>
          <input class="input" id="mgr-ver" name="managerVersion" value="${esc(d.desired || '')}" placeholder="${esc(t('留空 = 跟最新'))}" autocomplete="off">
        </div>
        <button type="submit" class="btn" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
      </form>`
    : ''
  return `<div class="satu-panel" style="display: flex; flex-direction: column; gap: var(--space-3);">
    <span class="satu-panel-title">${esc(title)}</span>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(hint)}</p>
    ${desiredForm}
    ${table}
    ${addReleaseForm(kind)}
  </div>`
}

/**
 * 新增版本。
 *
 * 四个字段都必填：**大小和 sha256 是拿来核对的，不是拿来记录的**。保存时 Gateway
 * 会把包整个拉一遍,比对这两项、确认入口文件在,对不上就不入库——一条指向坏包的
 * 记录会一路传染到席位机器上,而那时已经没人能上去看了。
 */
function addReleaseForm(kind) {
  const busy = state.busy
  return `<details ${state.addRelease === kind ? 'open' : ''}>
    <summary style="cursor: pointer; font-size: 13px; color: var(--muted-foreground);">${t('新增版本')}</summary>
    <form data-form="add-release" data-kind="${kind}" style="display: flex; flex-direction: column; gap: var(--space-3); margin-top: var(--space-3);">
      <div style="display: flex; gap: var(--space-3); flex-wrap: wrap;">
        <div class="field" style="margin: 0; flex: 1; min-width: 200px;">
          <label for="ar-ver-${kind}">${t('版本号')}</label>
          <input class="input" id="ar-ver-${kind}" name="version" required placeholder="0.1.0+abc1234-arm64" autocomplete="off">
        </div>
        <div class="field" style="margin: 0; width: 160px;">
          <label for="ar-size-${kind}">${t('大小')}（${t('字节')}）</label>
          <input class="input" id="ar-size-${kind}" name="size" required inputmode="numeric" placeholder="9376749" autocomplete="off">
        </div>
      </div>
      <div class="field" style="margin: 0;">
        <label for="ar-sha-${kind}">sha256</label>
        <input class="input" id="ar-sha-${kind}" name="sha256" required placeholder="${esc(t('64 位十六进制'))}" autocomplete="off">
      </div>
      <div class="field" style="margin: 0;">
        <label for="ar-url-${kind}">${t('下载地址')}</label>
        <input class="input" id="ar-url-${kind}" name="url" required placeholder="https://…/${kind}-0.1.0.tgz" autocomplete="off">
      </div>
      <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('保存前会把包整个拉一遍，核对大小与 sha256、确认入口文件在。验不过不入库。')}</p>
      <div><button type="submit" class="btn btn-primary" ${busy ? 'disabled' : ''}>${busy ? t('验证中…') : t('验证并保存')}</button></div>
    </form>
  </details>`
}

function companyDetailPage() {
  const c = state.org
  if (!c) {
    return `<div class="gw-page"><div class="gw-page-inner">${flashes()}<p style="color: var(--muted-foreground);">${t('载入中…')}</p></div></div>`
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
        : t('未部署')
      return `<div class="satu-memberrow" style="grid-template-columns: ${envCols};">
      <button type="button" class="satu-linkbtn" data-act="seat-open" data-id="${esc(m.id)}" style="min-width: 0; display: flex; align-items: center; gap: var(--space-3); text-align: left; padding: 0; border: 0; background: transparent;">
        <span class="satu-avatar" style="background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc((m.name || m.email || '·').slice(0, 1).toUpperCase())}</span>
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600;">${esc(m.name || m.email)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.email)}</div>
        </div>
      </button>
      ${roleTag(m.role)}
      <span class="tag ${st.tag}">${t(st.label)}</span>
      <span style="font-size: 13px; color: var(--muted-foreground);">${esc(ago(m.lastSeenAt))}</span>
      <span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${env}</span>
      <button type="button" class="satu-linkbtn" data-act="seat-open" data-id="${esc(m.id)}">${t('查看')}</button>
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
          <h1 style="font-size: 24px; margin: 0 0 4px;">${esc(c.name || t('公司详情'))}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(c.slug || '')}</p>
        </div>
        ${flashes()}
        <form class="satu-panel" data-form="org-profile" data-id="${esc(c.id)}" style="gap: var(--space-4);">
          <span class="satu-panel-title">${t('公司信息')}</span>
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: var(--space-3);">
            <div class="field" style="margin: 0;">
              <label for="cd-name">${t('名称')}</label>
              <input class="input" id="cd-name" name="name" value="${esc(c.name || '')}" required>
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-slug">slug</label>
              <input class="input" id="cd-slug" name="slug" value="${esc(c.slug || '')}" required>
            </div>
            <div class="field" style="margin: 0;">
              <label>${t('状态')}</label>
              <div style="display: flex; align-items: center; gap: var(--space-3);">
                ${companyStatusTag(c.status)}
                <button type="button" class="btn btn-secondary" data-act="org-status" data-id="${esc(c.id)}" data-next="${c.status === 'disabled' ? 'active' : 'disabled'}">
                  ${c.status === 'disabled' ? t('启用') : t('停用')}
                </button>
              </div>
              <span style="font-size: 12px; color: var(--muted-foreground);">${t('状态单独生效，不用保存这张表单。停用后这家公司的人一律登不进来')}</span>
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-contact-name">${t('联系人')}</label>
              <input class="input" id="cd-contact-name" name="contactName" value="${esc(c.contactName || '')}" required>
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-contact-phone">${t('电话')}</label>
              ${phoneField('cd-contact-phone', c.contactPhone)}
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-contact-email">${t('联系邮箱')}</label>
              <input class="input" id="cd-contact-email" name="contactEmail" type="email" value="${esc(c.contactEmail || '')}" required>
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-address">${t('公司地址')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
              <input class="input" id="cd-address" name="address" value="${esc(c.address || '')}">
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-website">${t('网站')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
              <input class="input" id="cd-website" name="website" value="${esc(c.website || '')}" placeholder="https://acme.com">
            </div>
            <div class="field" style="margin: 0;">
              <label for="cd-url">${t('访问地址')}</label>
              <input class="input" id="cd-url" name="accessUrl" value="${esc(c.accessUrl || '')}" placeholder="https://acme.satuwork.com">
            </div>
          </div>
          <div class="satu-kv"><span>id</span><span>${esc(c.id || '—')}</span></div>
          <div class="satu-kv"><span>${t('创建时间')}</span><span>${esc(fmtTime(c.createdAt))}</span></div>
          <div class="satu-kv"><span>machineId</span><span>${esc(c.machineId || '—')}</span></div>
          <div style="display: flex; justify-content: flex-end;">
            <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
          </div>
        </form>
        ${machinePanel(c.id)}
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
            <h2 style="font-size: 18px; margin: 0;">${t('成员')}</h2>
            <div style="display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;">
              <span style="font-size: 12px; color: var(--muted-foreground);">${t(`平台最新 ${esc(state.latestRelease || t('还没有发布版本'))}`, `Latest ${esc(state.latestRelease || t('还没有发布版本'))}`)} · ${t(`${members.length} 人`, `${members.length} people`)} · ${t('已用')} ${t(`${esc(used)} / ${esc(total)} 席位`, `${esc(used)} / ${esc(total)} seats`)}</span>
            </div>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-memberhead" style="grid-template-columns: ${envCols};">
              <span>${t('成员')}</span><span>${t('角色')}</span><span>${t('状态')}</span><span>${t('最近活跃')}</span><span>${t('环境')}</span><span></span>
            </div>
            ${memberRows || empty(t('还没有成员'))}
          </div>
        </div>
        <div class="satu-panel">
          <span class="satu-panel-title">${t('订阅')}</span>
          <div style="display: flex; align-items: baseline; gap: var(--space-2);">
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(planLabel(plan) || t('无套餐'))}</span>
            ${plan.expiresAt && plan.expiresAt < Date.now() ? `<span class="tag tag-neutral">${t('已到期')}</span>` : ''}
          </div>
          <div class="satu-kv"><span>${t('席位')}</span><span>${esc(used)} / ${esc(total)}</span></div>
          <div class="satu-kv"><span>${t('账期')}</span><span>${esc(bplan.period || '—')}</span></div>
          <div class="satu-kv"><span>${t('到期时间')}</span><span>${esc(plan.expiresAt ? dayISO(plan.expiresAt) : t('不限期'))}</span></div>
          <div class="satu-kv"><span>${t('周期费用')}</span><span>${esc(bplan.amount || '—')}</span></div>
          <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('订阅按订单走：套餐、席位、到期时间都跟着订单，改这些请到订单页下单。')}</p>
        </div>
        ${balancePanel()}
        ${topupRecordsPanel()}
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <h2 style="font-size: 18px; margin: 0;">${t('订阅账单')}</h2>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-billhead">
              <span>${t('账期')}</span><span>${t('金额')}</span><span>${t('状态')}</span><span>${t('付款时间')}</span><span></span>
            </div>
            ${invoiceRows || empty(t('还没有订阅账单。支付接上之后，账期会列在这里。'))}
          </div>
        </div>
        ${seatEnvModal()}
      </div>
    </div>`
}

function machinePanel(orgId) {
  const list = state.machines || []
  const cap = state.machineCapacity || { accounts: 0, max: 0 }
  const code = state.pairingCode
  // 配对码只在生成的那一刻拿得到，刷新页面就没了——所以要显眼，还要能一键复制。
  const codeBox = code
    ? `<div class="satu-panel" style="margin: 0; background: var(--muted);">
        <div class="satu-kv"><span>${t('配对码')}</span><span style="font-family: var(--font-mono); font-size: 16px; letter-spacing: 1px;">${esc(code.code)}</span></div>
        <div class="satu-kv"><span>${t('有效期至')}</span><span>${esc(new Date(code.expiresAt).toLocaleString())}</span></div>
        <p style="margin: var(--space-2) 0 6px; font-size: 12px; color: var(--muted-foreground);">${t('在那台 Debian 上用 root 跑这一条，装完即配对：')}</p>
        <pre style="margin: 0; padding: 10px; overflow-x: auto; background: var(--background); border-radius: var(--radius); font-size: 12px;"><code>${esc(code.installCommand)}</code></pre>
        <p style="margin: var(--space-2) 0 0; font-size: 12px; color: var(--muted-foreground);">${t('同一个地址重跑 = 重新配对那一台；换一台机器跑 = 新增一台。')}</p>
        <div style="margin-top: var(--space-2);"><button type="button" class="satu-linkbtn" data-act="copy-install">${t('复制命令')}</button></div>
      </div>`
    : ''
  const cards = list.length
    ? list.map((m) => machineCard(orgId, m)).join('')
    : `<p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('还没有配对任何机器')}</p>`
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('运行机器')}</span>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('装上机器管家并配对之后，建账号、装包、起桌面全归它——Gateway 不保存任何登录这台机器的凭据。')}</p>
    <div class="satu-kv"><span>${t('账号位')}</span><span>${cap.accounts} / ${cap.max}${cap.max && cap.accounts >= cap.max ? ' · ' + t('已满，新员工无法部署') : ''}</span></div>
    ${cards}
    ${list.length ? timezoneOptions() : ''}
    ${codeBox}
    <div><button type="button" class="btn btn-primary" data-act="pairing-code" data-id="${esc(orgId)}" ${state.busy ? 'disabled' : ''}>${list.length ? t('新增 / 重配机器') : t('生成配对码')}</button></div>
  </div>`
}

/**
 * 通联状态 → 一盏灯 + 一句话。
 *
 * **判据是心跳的新旧，不是 `lastError`。** 能报错说明线是通的；把两件事塞进同一盏灯，
 * 「机器失联」和「机器在线但升级失败」就长成一个样子，而这两种的处置完全不同。错误
 * 另有一行 lastError 管。
 *
 * 中间那档 `stale` 不是凑数：换版重启本身就会断几十秒，一超时就报红会让每次自升级都
 * 闪一次红灯，几次之后没人再信这盏灯。
 */
const LINK_TEXT = {
  online: () => t('在线'),
  stale: () => t('心跳迟了'),
  offline: () => t('失联'),
  unpaired: () => t('还没有配对'),
  unknown: () => t('状态未知'),
}

/** 「多久之前」。秒级起步——心跳 30 秒一轮，只报到分钟就看不出刚刚断没断。 */
function sinceMs(ms) {
  if (ms == null) return ''
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return t(`${sec} 秒前`, `${sec}s ago`)
  const min = Math.floor(sec / 60)
  if (min < 60) return t(`${min} 分钟前`, `${min} min ago`)
  const hr = Math.floor(min / 60)
  if (hr < 24) return t(`${hr} 小时前`, `${hr} h ago`)
  return t(`${Math.floor(hr / 24)} 天前`, `${Math.floor(hr / 24)} d ago`)
}

/**
 * 卡片的头一行：灯、编号、短码、状态。
 *
 * **编号和短码是两样东西。** 「1 号机」是给人照着念的，中间删掉一台后面就会往前挪；
 * 要唯一地指一台得用 id，所以短码那颗按钮复制的是**完整 id**，显示的只是前 8 位——
 * 完整 UUID 摆在卡片头上，占一行，还没人读得下来。
 */
function machineHead(card, m) {
  // **「后端没给这个字段」不等于「机器没配对」。** 这两件事差得最远，而合成一个兜底
  // 值的代价是：一台心跳正常、版本刚升完的机器，界面上写着「还没有配对」。开发时
  // 前端比后端新一步就会撞上（浏览器读的是磁盘上的 app.js，Gateway 要重启才换代码）。
  //
  // `paired` 是老响应里就有的，可信；`link` 缺了就老实说不知道，不替它猜一个。
  const link = m.link || (m.paired === false ? 'unpaired' : 'unknown')
  const label = (LINK_TEXT[link] || LINK_TEXT.unknown)()
  // 「还没有配对」本身就说完了，再缀一个「从未」是废话；配对过却没心跳过才要点出来。
  // 状态未知时也不缀——那个数字同样来自缺席的那批字段。
  const when =
    link === 'unpaired' || link === 'unknown'
      ? ''
      : m.heartbeatAge == null
        ? ' · ' + t('从未心跳')
        : ' · ' + sinceMs(m.heartbeatAge)
  const short = String(m.id || '').slice(0, 8)
  return `<div class="satu-machinehead">
    <span class="satu-linkdot" data-link="${esc(link)}" title="${esc(label)}"></span>
    ${/* 编号缺席时整个略过，不画「机器 ?」——一个问号既指代不了机器，也说不清是哪儿出了问题。 */ ''}
    ${card.no ? `<span class="satu-machineno">${t('机器')} ${esc(card.no)}</span>` : ''}
    ${short ? `<button type="button" class="satu-linkbtn satu-machineid" data-act="copy-machine-id" data-machine="${esc(m.id)}" title="${t('复制完整编号')}">${esc(short)}</button>` : ''}
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(label)}${esc(when)}</span>
  </div>`
}

/**
 * 一台机器一张卡：地址、容量、两行版本、各自的升级按钮。
 *
 * 「已用」是**激活账号数**，不是席位数——一个员工的多个 bot 落在同一台机器上，只占
 * 一个账号位。席位数另外标出来，运维时想知道机器上到底有多少个进程。
 */
function machineCard(orgId, card) {
  const m = card.machine || {}
  const full = card.full
  return `<div class="satu-panel" style="margin: 0; background: var(--muted);">
    ${machineHead(card, m)}
    <div class="satu-kv"><span>${t('地址')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; word-break: break-all;">
      ${esc(m.host || '—')}
      ${card.seats ? '' : `<button type="button" class="satu-linkbtn" data-act="machine-remove" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" ${state.busy ? 'disabled' : ''}>${t('移除')}</button>`}
    </span></div>
    <div class="satu-kv"><span>${t('账号位')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
      ${m.paired ? `${card.accounts} / ${card.maxAccounts}` : `<span style="color: var(--muted-foreground);">${t('未配对，不提供账号位')}</span>`}${full ? ` <span class="tag">${t('已满')}</span>` : ''} · ${t('席位')} ${card.seats}
      <form data-form="machine-capacity" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" style="display: inline-flex; gap: 6px; align-items: center;">
        <input class="input" name="maxAccounts" type="number" min="1" max="1000" value="${esc(card.maxAccounts)}" style="width: 84px;">
        <button type="submit" class="satu-linkbtn" ${state.busy ? 'disabled' : ''}>${t('改容量')}</button>
      </form>
    </span></div>
    <div class="satu-kv"><span>${t('最近心跳')}</span><span>${m.lastHeartbeatAt ? esc(new Date(m.lastHeartbeatAt).toLocaleString()) : t('还没有')}</span></div>
    ${timezoneRow(orgId, m, card)}
    ${managerVersionRow(orgId, m, card)}
    ${botVersionRow(orgId, card)}
    ${m.lastError ? `<div class="satu-kv"><span>lastError</span><span>${esc(m.lastError)}</span></div>` : ''}
    <form data-form="machine" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" style="display: flex; gap: var(--space-2); align-items: flex-end;">
      <div class="field" style="margin: 0; flex: 1;">
        <label>${t('管家地址')}</label>
        <input class="input" name="host" value="${esc(m.host || '')}" placeholder="http://10.0.0.12:8443" autocomplete="off">
      </div>
      <button type="submit" class="btn" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
    </form>
  </div>`
}

/**
 * 机器时区行。
 *
 * 和「升级」是同一条路：Gateway 没有登录这台机器的凭据，填进去只是**把期望时区钉在
 * 这台机器上**，真正 `timedatectl set-timezone` 的是机器上的管家，下一轮心跳才知道
 * 成没成。所以这里显示的是**机器自报的实际时区**，指令还没落地时另标一句，不写成
 * 「已生效」。
 *
 * 留空 = 不再管这台机器的时区（不会把机器改回去）。
 */
function timezoneRow(orgId, m, card) {
  const cur = m.currentTimezone || (m.paired ? t('机器没报') : '—')
  const note = card.timezonePending
    ? ` · ${t('已下指令，等机器改')} → ${esc(m.timezone || '')}`
    : m.timezone
      ? ` · ${t('已生效')}`
      : ` · ${t('没有指定，跟机器现状')}`
  return `<div class="satu-kv"><span>${t('时区')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
    ${esc(cur)}${note}
    <form data-form="machine-timezone" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" style="display: inline-flex; gap: 6px; align-items: center;">
      <input class="input" name="timezone" list="satu-timezones" value="${esc(m.timezone || '')}" placeholder="Asia/Shanghai" autocomplete="off" spellcheck="false" style="width: 200px;">
      <button type="submit" class="satu-linkbtn" ${state.busy ? 'disabled' : ''}>${t('改时区')}</button>
    </form>
  </span></div>`
}

/**
 * 时区候选。浏览器自己就有全套 IANA 表（`Intl.supportedValuesOf`），不必在前端塞一份
 * 会过期的清单。取不到就退回几个常用的——datalist 只是补全，手打任何合法名字都收，
 * 真正认不认由 Gateway 判。
 *
 * **整个面板只出一份**（不是每台机器一份）：id 要唯一，而且这张表有四百多项，
 * 多机公司逐台复制一遍纯属白搭 DOM。
 */
let timezoneList = null
function timezoneOptions() {
  if (!timezoneList) {
    try {
      timezoneList = Intl.supportedValuesOf('timeZone')
    } catch {
      timezoneList = ['Asia/Shanghai', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Kolkata', 'Europe/London', 'UTC']
    }
  }
  return `<datalist id="satu-timezones">${timezoneList.map((z) => `<option value="${esc(z)}"></option>`).join('')}</datalist>`
}

/**
 * 管家版本行。
 *
 * 「升级」只是**把期望版本钉到这台机器上**——真正换版由机器在下一轮心跳里自己做：
 * 它要挑不忙的时候、要跑自检、失败要回滚，这些只有机器上做得了。所以按下之后显示
 * 的是「等机器换版」，不是「已升级」。
 */
function managerVersionRow(orgId, m, card) {
  const cur = m.managerVersion || '—'
  const latest = state.managerLatest
  const canUp = card.managerOutdated
  const note = card.managerPending
    ? ` · ${t('已下指令，等机器换版')} → ${esc(card.managerDesired || '')}`
    : m.protocolTooOld
      ? ' · ' + t('版本过旧，等它自升级')
      : canUp
        ? ` · ${t('最新')} ${esc(latest)}`
        : ''
  const btn = canUp
    ? `<button type="button" class="btn" data-act="upgrade-manager" data-id="${esc(orgId)}" data-machine="${esc(m.id)}" ${state.busy ? 'disabled' : ''}>${t('升级')}</button>`
    : ''
  return `<div class="satu-kv"><span>${t('管家版本')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">${esc(cur)}${note}${btn}</span></div>`
}

/**
 * Bot 运行时版本行。
 *
 * 一台机器上可以同时躺着几个版本——有的席位部署得早、有的重新部署过。混版本本身
 * 不是错误，但得看得见，不然「升级完了吗」永远说不清。所以列的是清单加席位数。
 */
function botVersionRow(orgId, card) {
  const list = card.botVersions || []
  const text = list.length
    ? list.map((v) => `${esc(v.version || t('未部署'))} × ${v.seats}`).join('、')
    : t('还没有部署席位')
  const canUp = card.botOutdated
  const note = canUp ? ` · ${t('最新')} ${esc(state.botLatest || '')}` : ''
  const btn = canUp
    ? `<button type="button" class="btn" data-act="upgrade-bot" data-id="${esc(orgId)}" ${state.updatingRuntime ? 'disabled' : ''}>${state.updatingRuntime ? t('更新中…') : t('全部升级')}</button>`
    : ''
  return `<div class="satu-kv"><span>${t('Bot 运行时')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">${text}${note}${btn}</span></div>`
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
        <div class="satu-kv"><span>seatId</span><span style="word-break: break-all;">${esc(rt.seatId || '—')}</span></div>
        <div class="satu-kv"><span>${t('共享目录')}</span><span style="word-break: break-all;">${esc(rt.sharedDir || '—')}</span></div>
        <div class="satu-kv"><span>DISPLAY</span><span>${esc(rt.display != null ? ':' + rt.display : '—')}</span></div>
        <div class="satu-kv"><span>noVNC</span><span style="word-break: break-all;">${esc(rt.novncUrl || '—')}</span></div>
        <div class="satu-kv"><span>${t('VNC 密码')}</span><span>${esc(pw)} <button type="button" class="satu-linkbtn" data-act="seat-reveal">${state.seatReveal ? t('隐藏') : t('显示')}</button></span></div>
        <div class="satu-kv"><span>${t('状态')}</span><span>${esc(rt.status || '—')}</span></div>
        <div class="satu-kv"><span>${t('Bot 版本')}</span><span>${esc(rt.botVersion || t('未部署'))}</span></div>
        ${rt.lastError ? `<div class="satu-kv"><span>lastError</span><span>${esc(rt.lastError)}</span></div>` : ''}
      </div>`
        })
        .join('') +
      `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('x11vnc 只听 localhost；noVNC 走内网 HTTP。不要当成公网安全。')}</p>`
    : `<p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${state.seatError || t('还没有部署。员工打开某个 Bot 后可以点「部署这个 Bot」。')}</p>`
  return `<div class="gw-modal-backdrop" data-act="seat-close">
    <div class="gw-modal" style="max-width: 520px;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('员工环境')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(m.name || m.email)} · ${esc(m.email)}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="seat-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      ${body}
    </div>
  </div>`
}

function usersPage() {
  const rows = (state.users || [])
    .map((a) => {
      const company = a.company ? `${a.company.name} (${a.company.slug})` : t('平台')
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
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('用户')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('平台账号与各公司管理员、员工。')}</p>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-memberhead">
            <span>${t('账号')}</span><span>${t('角色')}</span><span>${t('加入时间')}</span><span></span><span></span>
          </div>
          ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有用户')}</div>`}
        </div>
      </div>
    </div>`
}

function userSecretRow(label, kind, value) {
  const revealed = Boolean(state.userReveal && state.userReveal[kind])
  const shown = value ? (revealed ? value : '••••••••') : '—'
  const actions = value
    ? ` <button type="button" class="satu-linkbtn" data-act="user-secret-reveal" data-kind="${esc(kind)}">${revealed ? t('隐藏') : t('显示')}</button> <button type="button" class="satu-linkbtn" data-act="user-secret-copy" data-kind="${esc(kind)}">${t('复制')}</button>`
    : ''
  return `<div class="satu-kv"><span>${esc(label)}</span><span style="word-break: break-all;">${esc(shown)}${actions}</span></div>`
}

function userDetailPage() {
  const d = state.userDetail
  if (!d || !d.account) {
    return `<div class="gw-page"><div class="gw-page-inner">${flashes()}<p style="color: var(--muted-foreground);">${t('载入中…')}</p></div></div>`
  }
  const a = d.account
  const company = d.company
  const st = MEMBER_STATUS[a.status] || MEMBER_STATUS.active
  const ownerSeat = a.role === 'owner'
  const secrets = ownerSeat
    ? `<p style="margin: var(--space-3) 0 0; font-size: 13px; color: var(--muted-foreground);">${t('平台账号不占席位，没有 API Key 和 access token。')}</p>`
    : `${userSecretRow('API Key', 'apiKey', d.apiKey)}${userSecretRow('access token', 'accessToken', d.accessToken)}`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('账号详情')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(a.email || '')}</p>
        </div>
        ${flashes()}
        <div class="satu-panel">
          <span class="satu-panel-title">${t('账号信息')}</span>
          <div class="satu-kv"><span>${t('邮箱')}</span><span>${esc(a.email || '—')}</span></div>
          <div class="satu-kv"><span>${t('名称')}</span><span>${esc(a.name || '—')}</span></div>
          <div class="satu-kv"><span>${t('角色')}</span><span>${roleTag(a.role)}</span></div>
          <div class="satu-kv"><span>${t('公司')}</span><span>${esc(company ? `${company.name} (${company.slug})` : t('平台'))}</span></div>
          <div class="satu-kv"><span>${t('状态')}</span><span class="tag ${st.tag}">${t(st.label)}</span></div>
          <div class="satu-kv"><span>${t('加入时间')}</span><span>${esc(fmtTime(a.createdAt))}</span></div>
        </div>
        <div class="satu-panel">
          <span class="satu-panel-title">${t('席位密钥')}</span>
          ${secrets}
        </div>
      </div>
    </div>`
}

function planSkuModal() {
  const edit = state.planSkuEdit
  if (!edit) return ''
  const cur = edit.id ? (state.planSkus || []).find((p) => p.id === edit.id) : null
  // 开着改的那条被别人删了/列表没刷上，宁可什么都不显示，也别拿空表单假装是它。
  if (edit.id && !cur) return ''
  const title = cur ? t('修改套餐') : t('新建套餐')
  // 金额和额度都走 milsOf：服务端比前端旧时字段名不一样，直接读会得到 undefined，
  // 让必填框变空——那时候连保存都点不动。
  const v = edit.draft || {
    name: cur?.name || '',
    nameEn: cur?.nameEn || '',
    amount: cur ? milsOf(cur, 'amount') / 1000 : '',
    seats: cur ? cur.seats : 1,
    period: cur ? cur.period : 'month',
    bonus: cur ? milsOf(cur, 'bonus') / 1000 : 0,
  }
  return `<div class="gw-modal-backdrop" data-act="plan-sku-close">
    <form id="plan-sku-form" class="gw-modal" style="max-width: 460px;" data-id="${esc(cur?.id || '')}" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${esc(title)}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('改价目表不会动已经开出去的公司席位。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="plan-sku-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div class="field">
        <label for="plan-sku-name">${t('名称（中文）')}</label>
        <input class="input" id="plan-sku-name" name="name" value="${esc(v.name)}" required>
      </div>
      <div class="field">
        <label for="plan-sku-name-en">${t('名称（English）')}</label>
        <input class="input" id="plan-sku-name-en" name="nameEn" value="${esc(v.nameEn)}" placeholder="${esc(t('选填，留空则英文界面显示中文名'))}">
      </div>
      <div class="field">
        <label for="plan-sku-amount">${t('金额（美元）')}</label>
        ${/* $ 贴在输入框里而不是标签上：填的时候就看得见单位，不用回头看标签。 */ ''}
        <div class="satu-money">
          <span aria-hidden="true">$</span>
          <input class="input" id="plan-sku-amount" name="amount" type="number" min="0" step="0.001" value="${esc(v.amount)}" required>
        </div>
        <p style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);">${t('最小到厘（小数点后 3 位）。')}</p>
      </div>
      <div class="field">
        <label for="plan-sku-period">${t('类型')}</label>
        <select class="input" id="plan-sku-period" name="period">
          ${PLAN_PERIODS.map((k) => `<option value="${esc(k)}" ${k === (v.period || 'month') ? 'selected' : ''}>${esc(periodLabel(k))}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <label for="plan-sku-seats">${t('席位')}</label>
        <input class="input" id="plan-sku-seats" name="seats" type="number" min="1" step="1" value="${esc(v.seats)}" required>
      </div>
      <div class="field">
        <label for="plan-sku-bonus">${t('赠送 Token 额度（美元）')}</label>
        <div class="satu-money">
          <span aria-hidden="true">$</span>
          <input class="input" id="plan-sku-bonus" name="bonusTokens" type="number" min="0" step="0.001" value="${esc(v.bonus)}" required>
        </div>
        <p style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);">${t('随套餐赠送的额度，可用于消费 token。0 表示不送。')}</p>
      </div>
      ${state.planSkuError ? `<div class="gw-flash gw-flash-err">${esc(state.planSkuError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="plan-sku-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('保存')}</button>
      </div>
    </form>
  </div>`
}

/**
 * 套餐名按当前语言取。名字是数据不是文案，译表管不了它——英文名留空就回落到中文名，
 * 宁可显示中文，也不要空白。
 */
function planName(p) {
  return (localeMode === 'en' ? p.nameEn || p.name : p.name) || ''
}

/**
 * 取金额的「厘」值。服务端进程比前端旧时（改了代码没重启），返回的还是老字段，
 * 这时用 amount 折算回厘——版本错开时宁可显示价格，也别显示一个「—」。
 */
function milsOf(row, key) {
  const mils = row[`${key}Mils`]
  if (mils != null) return Number(mils)
  // 依次回落：新接口的美元字段 → 迁移前的老字段。
  // 老字段的数值当美元看，跟迁移里 ×1000 的算法一致，错开期间读数不会跳。
  const legacy = key === 'amount' ? row.amountCents / 100 : row.bonusTokens
  const dollars = row[key] ?? legacy
  return dollars == null || Number.isNaN(Number(dollars)) ? NaN : Math.round(Number(dollars) * 1000)
}

/** 副标题给另一种语言的名字；没填就退回 id（调试时还认得出是哪条）。 */
function planSubName(p) {
  const other = localeMode === 'en' ? p.name : p.nameEn
  return other && other !== planName(p) ? other : p.id
}

/** 周期存英文枚举，显示时才翻——中文名进了库就换不了语言。 */
const PLAN_PERIODS = ['month', 'quarter', 'year']
function periodLabel(p) {
  return { month: t('月包'), quarter: t('季包'), year: t('年包') }[p] || t('月包')
}

/** 多一列赠送额度，5 列的 satu-memberrow 不够用，这里单独排。 */
const PLAN_COLS = 'minmax(140px, 2fr) 92px 68px 72px 104px minmax(88px, 1fr) 84px'

/** 订单状态是算出来的，不存库——存了就得有人定时去改它。 */
function orderStatus(o) {
  const now = Date.now()
  // 没付款就不是订阅，只是一张待收的账单，日期到了也不生效。
  if (o.payStatus !== 'paid') return { label: t('待付款'), tag: 'tag-neutral' }
  // 充值没有账期：付了就是到账，谈不上「生效中」或「已过期」。
  if (o.kind === 'topup') return { label: t('已到账'), tag: 'tag-accent-2' }
  if (now < o.startAt) return { label: t('未开始'), tag: 'tag-neutral' }
  if (now > o.endAt) return { label: t('已过期'), tag: 'tag-neutral' }
  return { label: t('生效中'), tag: 'tag-accent-2' }
}

function orderPlanName(o) {
  return (localeMode === 'en' ? o.planNameEn || o.planName : o.planName) || '—'
}

function payStatusTag(status) {
  return status === 'paid'
    ? `<span class="tag tag-accent-2">${t('已付款')}</span>`
    : `<span class="tag tag-neutral">${t('未付款')}</span>`
}

// 最后一列要同时放状态标签和「修改」按钮，给够宽度，否则按钮会被切掉。
const ORDER_COLS = 'minmax(110px, 1.3fr) 64px minmax(96px, 1.1fr) 84px 84px 56px 108px 80px 148px'

function orderModal() {
  const edit = state.orderEdit
  if (!edit) return ''
  const cur = edit.id ? (state.orders || []).find((o) => o.id === edit.id) : null
  if (edit.id && !cur) return ''
  const skus = state.planSkus || []
  const orgs = state.orgs || []
  const v = edit.draft || {
    kind: cur?.kind || edit.kind || 'plan',
    companyId: cur?.companyId || edit.companyId || orgs[0]?.id || '',
    planId: cur?.planId || skus[0]?.id || '',
    period: cur?.period || 'month',
    seats: cur ? cur.seats : skus[0]?.seats ?? 1,
    amount: cur ? cur.amount : skus[0]?.amount ?? 0,
    bonus: cur ? cur.bonus : skus[0]?.bonus ?? 0,
    startAt: dayISO(cur ? cur.startAt : Date.now()),
    payStatus: cur?.payStatus || 'unpaid',
    note: cur?.note || '',
  }
  // 一张表单两种单子：套餐单要选套餐、席位、账期，充值单只有金额和备注。
  const topup = v.kind === 'topup'
  return `<div class="gw-modal-backdrop" data-act="order-close">
    <form id="order-form" class="gw-modal" style="max-width: 480px; max-height: 88vh; overflow-y: auto;" data-id="${esc(cur?.id || '')}" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${cur ? t('修改订单') : topup ? t('新建充值单') : t('新建套餐单')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${topup ? t('充值单付款后才开充值记录，余额也是那时候才涨。') : t('下单时套餐内容会抄进订单，之后改价目表不影响它。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="order-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div class="field">
        <label for="order-kind">${t('单据类型')}</label>
        <select class="input" id="order-kind" name="kind" data-act="order-kind-pick" ${cur ? 'disabled' : ''}>
          <option value="plan" ${!topup ? 'selected' : ''}>${t('套餐')}</option>
          <option value="topup" ${topup ? 'selected' : ''}>${t('充值')}</option>
        </select>
        ${cur ? `<p style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);">${t('类型不能改，要换请另开一单。')}</p>` : ''}
      </div>
      <div class="field">
        <label for="order-company">${t('公司')}</label>
        <select class="input" id="order-company" name="companyId" required>
          ${orgs.map((c) => `<option value="${esc(c.id)}" ${c.id === v.companyId ? 'selected' : ''}>${esc(c.name)}</option>`).join('') || `<option value="">${t('还没有公司')}</option>`}
        </select>
      </div>
      ${topup ? '' : `
      <div class="field">
        <label for="order-plan">${t('套餐')}</label>
        <select class="input" id="order-plan" name="planId" data-act="order-plan-pick" required>
          ${skus.map((p) => `<option value="${esc(p.id)}" ${p.id === v.planId ? 'selected' : ''}>${esc(planName(p))}</option>`).join('') || `<option value="">${t('还没有套餐')}</option>`}
        </select>
        <p style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);">${t('选套餐会带出下面几项，可以再改。')}</p>
      </div>
      <div class="field">
        <label for="order-period">${t('类型')}</label>
        <select class="input" id="order-period" name="period">
          ${PLAN_PERIODS.map((k) => `<option value="${esc(k)}" ${k === v.period ? 'selected' : ''}>${esc(periodLabel(k))}</option>`).join('')}
        </select>
      </div>
      `}
      <div class="field">
        <label for="order-amount">${topup ? t('充值金额（美元）') : t('金额（美元）')}</label>
        <div class="satu-money">
          <span aria-hidden="true">$</span>
          <input class="input" id="order-amount" name="amount" type="number" min="0" step="0.001" value="${esc(v.amount)}" required>
        </div>
      </div>
      ${topup ? `
      <div class="field">
        <label for="order-note">${t('备注')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
        <input class="input" id="order-note" name="note" value="${esc(v.note)}" placeholder="${esc(t('例如：线下转账补充'))}">
      </div>
      <div class="field">
        <label for="order-start">${t('日期')}</label>
        <input class="input" id="order-start" name="startAt" type="date" value="${esc(v.startAt)}" required>
      </div>
      ` : `
      <div class="field">
        <label for="order-seats">${t('席位')}</label>
        <input class="input" id="order-seats" name="seats" type="number" min="1" step="1" value="${esc(v.seats)}" required>
      </div>
      <div class="field">
        <label for="order-bonus">${t('赠送 Token 额度（美元）')}</label>
        <div class="satu-money">
          <span aria-hidden="true">$</span>
          <input class="input" id="order-bonus" name="bonusTokens" type="number" min="0" step="0.001" value="${esc(v.bonus)}" required>
        </div>
      </div>
      <div class="field">
        <label for="order-start">${t('开始日期')}</label>
        <input class="input" id="order-start" name="startAt" type="date" value="${esc(v.startAt)}" required>
        <p style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);">${t('结束日期按类型自动算。')}</p>
      </div>
      `}
      <div class="field">
        <label for="order-pay">${t('付款状态')}</label>
        <select class="input" id="order-pay" name="payStatus">
          <option value="unpaid" ${v.payStatus !== 'paid' ? 'selected' : ''}>${t('未付款')}</option>
          <option value="paid" ${v.payStatus === 'paid' ? 'selected' : ''}>${t('已付款')}</option>
        </select>
        <p style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);">${topup ? t('未付款不记账，改成已付款才开充值记录、余额才涨。') : t('未付款只开账单；改成已付款才写这家公司的订阅。')}</p>
      </div>
      ${state.orderError ? `<div class="gw-flash gw-flash-err">${esc(state.orderError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="order-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('保存')}</button>
      </div>
    </form>
  </div>`
}

function ordersPage() {
  const rows = (state.orders || [])
    .map((o) => {
      const st = orderStatus(o)
      const topup = o.kind === 'topup'
      return `<div class="satu-memberrow" style="grid-template-columns: ${ORDER_COLS};">
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(o.company?.name || '—')}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(o.company?.slug || o.companyId)}</div>
        </div>
        <span class="tag ${topup ? 'tag-neutral' : 'tag-accent'}">${topup ? t('充值') : t('套餐')}</span>
        <div style="min-width: 0;">
          <div style="font-size: 13px;">${esc(topup ? o.note || t('充值') : orderPlanName(o))}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(topup ? '—' : periodLabel(o.period))}</div>
        </div>
        <span style="font-size: 13px; font-weight: 600;">${esc(usd(milsOf(o, 'amount')))}</span>
        <span style="font-size: 13px;">${topup ? '—' : esc(usd(milsOf(o, 'bonus')))}</span>
        <span style="font-size: 13px;">${topup ? '—' : t(`${esc(o.seats)} 席`, `${esc(o.seats)} seat${o.seats === 1 ? '' : 's'}`)}</span>
        <!-- 起止两行：挤一行会被省略号切掉，日期切一半等于没显示。 -->
        <div style="font-size: 12px; color: var(--muted-foreground); line-height: 1.5;">
          ${topup ? esc(dayISO(o.startAt)) : `<div>${esc(dayISO(o.startAt))} →</div><div>${esc(dayISO(o.endAt))}</div>`}
        </div>
        ${payStatusTag(o.payStatus)}
        <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-2);">
          <span class="tag ${st.tag}">${esc(st.label)}</span>
          <button type="button" class="btn btn-secondary" data-act="order-edit" data-id="${esc(o.id)}">${t('修改')}</button>
        </div>
      </div>`
    })
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('购买与充值')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('买套餐和充值走同一张单：付了款，套餐才生效、充值余额才到账。')}</p>
          </div>
          <div style="display: flex; gap: var(--space-2); flex: none;">
            <button type="button" class="btn btn-secondary" data-act="order-new" data-kind="topup">${t('新建充值单')}</button>
            <button type="button" class="btn btn-primary" data-act="order-new" data-kind="plan">${t('新建套餐单')}</button>
          </div>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-memberhead" style="grid-template-columns: ${ORDER_COLS};">
            <span>${t('公司')}</span><span>${t('类型')}</span><span>${t('内容')}</span><span>${t('金额')}</span><span>${t('赠送 Token')}</span><span>${t('席位')}</span><span>${t('账期')}</span><span>${t('付款状态')}</span><span></span>
          </div>
          ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有订单')}</div>`}
        </div>
      </div>
      ${orderModal()}
    </div>`
}

/**
 * 两笔额度分开画，别加在一起：
 * 套餐赠送的跟着套餐到期清零，单独充的不过期——合成一个数就分不出哪部分会没。
 */
function balancePanel() {
  const b = state.balance || { planBonusMils: 0, planBonusExpiresAt: null, topupMils: 0 }
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('额度')}</span>
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--space-4);">
      <div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${t('套餐赠送余额')}</div>
        <div style="font-family: var(--font-heading); font-size: 24px; line-height: 1.3;">${esc(usd(b.planBonusMils || 0))}</div>
        <div style="font-size: 12px; color: var(--muted-foreground);">
          ${b.planBonusExpiresAt ? t(`${esc(dayISO(b.planBonusExpiresAt))} 到期，没用完清零`, `Expires ${esc(dayISO(b.planBonusExpiresAt))}, unused amount is cleared`) : t('没有生效中的套餐')}
        </div>
      </div>
      <div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${t('充值余额')}</div>
        <div style="font-family: var(--font-heading); font-size: 24px; line-height: 1.3;">${esc(usd(b.topupMils || 0))}</div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${t('不过期，用完为止')}</div>
      </div>
    </div>
    <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('充值在「充值」页里做，跟套餐赠送分开记。')}</p>
  </div>`
}

/** 公司详情里的充值记录：只有付了款的充值单才会有记录，所以这张表天然只列已到账的。 */
const TOPUP_COLS = 'minmax(120px, 1fr) 104px minmax(160px, 2fr) minmax(120px, 1fr)'

function topupRecordsPanel() {
  const rows = (state.orgTopups || [])
    .map(
      (r) => `<div class="satu-memberrow" style="grid-template-columns: ${TOPUP_COLS};">
        <span style="font-size: 13px;">${esc(fmtTime(r.createdAt))}</span>
        <span style="font-size: 13px; font-weight: 600;">${esc(usd(milsOf(r, 'amount')))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(r.note || '—')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(r.createdByName || '—')}</span>
      </div>`,
    )
    .join('')
  return `<div style="display: flex; flex-direction: column; gap: var(--space-3);">
    <h2 style="font-size: 18px; margin: 0;">${t('充值记录')}</h2>
    <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
      <div class="satu-memberhead" style="grid-template-columns: ${TOPUP_COLS};">
        <span>${t('时间')}</span><span>${t('金额')}</span><span>${t('备注')}</span><span>${t('操作人')}</span>
      </div>
      ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有充值记录。已付款的充值单才会记在这里。')}</div>`}
    </div>
  </div>`
}

function plansPage() {
  const skuRows = (state.planSkus || [])
    .map((p) => {
      return `<div class="satu-memberrow" style="grid-template-columns: ${PLAN_COLS};">
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(planName(p))}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(planSubName(p))}</div>
        </div>
        <span style="font-size: 13px; font-weight: 600;">${esc(usd(milsOf(p, 'amount')))}</span>
        <span style="font-size: 13px;">${esc(periodLabel(p.period))}</span>
        <span style="font-size: 13px;">${t(`${esc(p.seats)} 席`, `${esc(p.seats)} seat${p.seats === 1 ? '' : 's'}`)}</span>
        <span style="font-size: 13px;">${esc(usd(milsOf(p, 'bonus')))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(fmtTime(p.updatedAt))}</span>
        <div class="satu-rowactions">
          <button type="button" class="btn btn-secondary" data-act="plan-sku-edit" data-id="${esc(p.id)}">${t('修改')}</button>
        </div>
      </div>`
    })
    .join('')
  // 改某家公司的席位不在这页——那是公司详情页「订阅」面板的事。这页只管价目表。
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('套餐')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('价目表：一条套餐 = 一个金额 + 一个席位数。')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" data-act="plan-sku-new">${t('新建套餐')}</button>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-memberhead" style="grid-template-columns: ${PLAN_COLS};">
            <span>${t('套餐')}</span><span>${t('金额')}</span><span>${t('类型')}</span><span>${t('席位')}</span><span>${t('赠送 Token')}</span><span>${t('更新时间')}</span><span></span>
          </div>
          ${skuRows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有套餐')}</div>`}
        </div>
      </div>
      ${planSkuModal()}
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
                    <span style="font-size: 13px; font-weight: 600;">${esc(t(item.label))}</span>
                    <span style="font-size: 11.5px; color: var(--muted-foreground); text-align: center;">${esc(t(item.hint))}</span>
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
                  <div style="font-size: 13.5px; font-weight: 600;">${esc(t(n.title))}</div>
                  <div style="font-size: 12px; color: var(--muted-foreground);">${esc(t(n.desc))}</div>
                </div>
                <button type="button" class="satu-switch" aria-pressed="${String(!state.notifyOff.includes(n.key))}" aria-label="${esc(t(n.title))}" data-act="profile-notify" data-notify="${n.key}"><span></span></button>
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
  const empty = options && options.length ? '' : `<span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint || t('没有可选项'))}</span>`
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
      const ro = readOnlyItem(a)
      return `<div class="satu-agentrow">
        <button type="button" class="satu-tasklink" data-act="go" data-href="/bots/${esc(a.id)}">
          <span style="display: flex; align-items: center; gap: var(--space-3); min-width: 0;">
            ${botAvatar(a.icon, 34, a.origin)}
            <span style="min-width: 0; display: flex; flex-direction: column; gap: 1px; text-align: left;">
              <span style="font-size: 14px; font-weight: 600;">${esc(a.name)}${ro ? ` <span class="tag tag-accent-2" style="font-size: 11px;">${t('全局')}</span>` : ''}</span>
              <span style="font-size: 12px; color: var(--muted-foreground);">${esc(a.description || '')}</span>
            </span>
          </span>
        </button>
        <span class="tag ${on ? 'tag-accent-2' : 'tag-neutral'}">${on ? t('已上线') : t('未上线')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(a.skillCount ?? '—')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(a.mcpCount ?? '—')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(a.usage ?? '—')}</span>
        <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-2); justify-content: flex-end;">
          <button type="button" class="satu-switch" aria-pressed="${String(on)}" aria-label="${esc(t('上线'))}" data-act="bot-list-enabled" data-id="${esc(a.id)}" ${ro ? 'disabled title="' + esc(t('全局 Bot 由系统管理员维护')) + '"' : ''}><span></span></button>
          <button type="button" class="satu-linkbtn" data-act="go" data-href="/bots/${esc(a.id)}">${ro ? t('查看') : t('配置')}</button>
        </div>
      </div>`
    })
    .join('')
  const body = rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有 Bot')}</div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${isOwner() ? t('全局 Bot') : t('Bot 配置')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${isOwner() ? t('这里建的 Bot 所有公司都能用。公司自己建的只在自己公司里可见。', 'Bots created here are available to every company. Company-created bots stay inside that company.') : t('管理 AI 员工的人设、能力与可访问范围。带「全局」标的由系统管理员维护，只能查看。', 'Manage personas, capabilities and access. Items tagged 全局 are maintained by the system owner and are read-only.')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" data-act="bot-create">
            ${svg(['M12 5v14', 'M5 12h14'], 15)} ${t('新建 Bot', 'New bot')}
          </button>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-agenthead">
            <span>Bot</span><span>${t('状态')}</span><span>Skill</span><span>MCP</span><span>${t('本月执行')}</span><span></span>
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
    return `<div class="gw-page"><div class="gw-page-inner" style="max-width: 820px;">${flashes()}<p style="color: var(--muted-foreground);">${t('载入中…')}</p></div></div>`
  }
  // 公司管理员打开的是全局 Bot：能看，不能存也不能删。
  const ro = readOnlyItem(bot)
  const opts = state.botOptions || { skills: [], mcps: [], groups: [], kbs: [] }
  const iconPick = avatarKeysFor(bot.origin).map((key) => {
    const on = a.icon === key
    const label = t(BOT_AVATARS[key]?.label || key)
    return `<button type="button" class="satu-iconpick" aria-pressed="${String(on)}" aria-label="${esc(label)}" title="${esc(label)}" data-act="bot-icon" data-icon="${esc(key)}" ${ro ? 'disabled' : ''}>${botAvatar(key, 30, bot.origin)}</button>`
  }).join('')
  const guards = (a.guards || [])
    .map((g) => botToggle(g.title, g.desc, g.on, 'bot-guard', `data-id="${esc(g.id)}"`))
    .join('')
  const scopePills = MEMORY_SCOPES.map(
    (sc) =>
      `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(a.scope === sc)}" data-act="bot-scope" data-value="${esc(sc)}">${esc(t(sc))}</button>`,
  ).join('')
  // value 用中文原串当键（存的就是它），只翻显示的那一份。
  const ttlOpts = MEMORY_TTLS.map((ttl) => `<option value="${esc(ttl)}" ${ttl === a.ttl ? 'selected' : ''}>${esc(t(ttl))}</option>`).join('')
  const memoryBody = a.memoryOn
    ? `<div style="display: flex; flex-direction: column; gap: var(--space-4);">
        <div class="field">
          <label>${t('记忆范围')}</label>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${scopePills}</div>
        </div>
        <div class="field">
          <label>${t('记录哪些内容')}</label>
          ${/* id 保持中文原串（存的是它），只翻显示的 label；botPicks 也喂用户数据，不能整体翻。 */ ''}
          ${botPicks('kinds', MEMORY_KINDS.map((k) => ({ id: k, name: t(k) })), a.kinds)}
        </div>
        <div class="satu-agentpair">
          <div class="field">
            <label for="bot-ttl">${t('保留时长')}</label>
            <select class="input" id="bot-ttl" data-act="bot-ttl">${ttlOpts}</select>
          </div>
          <div class="field">
            <label for="bot-cap" data-bot-cap-label>${t(`注入上限 · ${esc(a.cap)} 条`, `Injection cap · ${esc(a.cap)}`)}</label>
            <input class="input" id="bot-cap" type="range" min="5" max="50" step="5" value="${esc(a.cap)}" data-bot="cap" style="padding: 0; border: 0; background: transparent; accent-color: var(--color-accent);">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('每次对话最多注入的记忆条数')}</span>
          </div>
        </div>
        ${botToggle(t('写入前需用户确认'), t('Agent 提议记住某条信息时先征求同意'), a.confirmOn, 'bot-confirm')}
        ${botToggle(t('不记录敏感信息'), t('手机号、证件号、银行卡等自动跳过'), a.piiOn, 'bot-pii')}
        <div style="display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
            <span style="font-size: 13.5px; font-weight: 600;">${t('已存记忆')}</span>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t(`${(a.memories || []).length} 条`, `${(a.memories || []).length} items`)}</span>
          </div>
          <div style="padding: 6px 0; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted-foreground);">${t('没有已存记忆')}</div>
        </div>
      </div>`
    : ''
  return `
    <div class="gw-page">
      <div class="gw-page-inner" style="max-width: 820px; gap: var(--space-4);">
        ${/* 「已保存」画在最下面那排按钮旁边——保存键在页尾，结论也该在那儿。 */ ''}
        <div class="satu-panel">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
            <div style="display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; flex: 1;">
              ${botAvatar(a.icon, 42, bot.origin)}
              <div style="min-width: 0; flex: 1; display: flex; flex-direction: column; gap: var(--space-2);">
                <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
                  <input class="input" style="max-width: 280px; font-family: var(--font-heading); font-size: 16px; font-weight: 600;" data-bot="name" value="${esc(a.name)}" placeholder="${esc(t('助理名字'))}">
                  <span class="tag ${a.enabled ? 'tag-accent-2' : 'tag-neutral'}">${a.enabled ? t('已上线') : t('未上线')}</span>
                </div>
                <input class="input" data-bot="description" value="${esc(a.description)}" placeholder="${esc(t('简介'))}">
                ${/* 模型不给挑：平台在「模型配置」里定的那一个，所有 Bot 都用它。 */ ''}
                <div style="font-size: 12.5px; color: var(--muted-foreground);">${t(`本月执行 ${esc(bot.usage || '—')}`, `${esc(bot.usage || '—')} this month`)} · ${t(`模型 ${esc(a.model || '—')}（平台指定）`, `model ${esc(a.model || '—')} (set by the platform)`)}</div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px;">${iconPick}</div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
              <button type="button" class="satu-switch" aria-pressed="${String(!!a.enabled)}" aria-label="${esc(t('上线'))}" data-act="bot-enabled"><span></span></button>
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
            <span class="satu-panel-title" style="text-transform: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; letter-spacing: 0;">soul.md</span>
            <span style="font-size: 12px; color: var(--muted-foreground);" data-bot-prompt-len>${t(`${esc(String(a.prompt.length))} 字 · 每轮随上下文注入`, `${esc(String(a.prompt.length))} chars · injected each turn`)}</span>
          </div>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('这份文件定义 Agent 的身份、语气与工作原则，每次对话都会随上下文一起注入。')}</p>
          <textarea class="input satu-code" rows="12" data-bot="prompt">${esc(a.prompt)}</textarea>
          <div class="field">
            <label for="bot-greeting">${t('开场问候')}</label>
            <input class="input" id="bot-greeting" type="text" data-bot="greeting" value="${esc(a.greeting)}">
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('行为边界')}</span>
          ${guards}
          <div class="field">
            <label for="bot-escalate">${t('升级人工的条件')}</label>
            <input class="input" id="bot-escalate" type="text" data-bot="escalate" value="${esc(a.escalate)}">
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('这几条最终落在工具执行前的拦截上（tools/pre-execute），不是提示词里的一句话——现在还没接。')}</span>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('可用 Skill')}</span>
          ${botPicks('skills', opts.skills, a.skills, t('没有可选项'))}
          <span class="satu-panel-title" style="margin-top: var(--space-2);">${t('可用 MCP 服务器')}</span>
          ${botPicks('mcps', opts.mcps, a.mcps, t('没有可选项'))}
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('未勾选的能力，Agent 在任务中不可调用。')}</span>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('记忆')}</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('决定这个 Agent 能记住什么、记多久，以及记忆如何参与后续对话。')}</p>
          ${botToggle(t('启用长期记忆'), t('关闭后每次对话都从空白上下文开始'), a.memoryOn, 'bot-memory')}
          ${memoryBody}
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('可访问范围')}</span>
          <div class="field">
            <label>${t('可使用该 Agent 的分组')}</label>
            ${botPicks('groups', opts.groups, a.groups, t('没有可选项'))}
          </div>
          <div class="field">
            <label>${t('知识库')}</label>
            ${botPicks('kbs', opts.kbs, a.kbs, t('没有可选项'))}
          </div>
        </div>

        ${flashes()}
        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);">
          ${ro ? '' : `<button type="button" class="satu-linkbtn" style="text-align: left;" data-act="bot-delete">${t('删除这个 Bot')}</button>`}
          <div style="display: flex; gap: var(--space-2);">
            <button type="button" class="btn btn-primary" data-act="bot-save" ${state.busy || ro ? 'disabled' : ''} ${ro ? 'title="' + esc(t('全局 Bot 由系统管理员维护')) + '"' : ''}>${state.busy ? t('保存中…') : ro ? t('只读') : t('保存配置')}</button>
          </div>
        </div>
        <p style="margin: 0 0 var(--space-4); font-size: 12px; color: var(--muted-foreground);">${t('这一页的设置都会写回目录。行为边界与记忆现在只是存下来：拦截和注入还没接到 Bot 上。分组与知识库也还没有落点。', 'Everything here is persisted to the catalog. Guardrails and memory are stored only — enforcement and injection are not wired into the bot yet. Groups and knowledge bases have no home yet either.')}</p>
      </div>
    </div>`
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
      <div style="font-size: 13.5px; font-weight: 600;">${t('保存后立即启用')}</div>
      <div style="font-size: 12px; color: var(--muted-foreground);">${t('关闭则仅保存，不对 Agent 开放')}</div>
    </div>
    <button type="button" class="satu-switch" aria-pressed="${String(!!enabled)}" aria-label="${esc(t('立即启用'))}" data-act="skill-enabled"><span></span></button>
  </div>`
}

function skillTagPicker(known, picked) {
  const manage = state.skillTagManage
  const chips = (known || [])
    .map((tag) =>
      manage
        ? `<button type="button" class="satu-assignee" style="padding: 5px 10px 5px 12px; gap: 6px; color: var(--color-accent-800);" aria-label="${t(`删除标签 ${esc(tag)}`, `Delete tag ${esc(tag)}`)}" data-act="skill-tag-delete" data-tag="${esc(tag)}">${esc(tag)} ${svg(CLOSE_ICON, 12)}</button>`
        : `<button type="button" class="satu-assignee" style="padding: 5px 12px;" aria-pressed="${String(picked.includes(tag))}" data-act="skill-tag-pick" data-tag="${esc(tag)}">${esc(tag)}</button>`,
    )
    .join('')
  const add = manage
    ? ''
    : state.skillTagAdding
      ? `<input class="input" id="sk-tag-draft" style="width: 120px; padding: 4px 10px; font-size: 13px;" autofocus data-skill-tag-draft placeholder="${esc(t('新标签'))}">`
      : `<button type="button" class="satu-assignee" style="padding: 5px 12px;" data-act="skill-tag-add">${svg(PLUS_ICON, 12)} ${t('新建标签', 'New tag')}</button>`
  const hint = manage
    ? t('点一个标签把它删掉——用到它的 Skill 上那一个也会一起去掉。')
    : t('可多选，用于筛选与归类')
  return `<div class="field">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
      <label style="margin: 0;">${t('标签')}</label>
      <button type="button" class="satu-linkbtn" style="font-size: 12px;" data-act="skill-tag-manage">${manage ? t('完成') : t('管理')}</button>
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
  // 全局项在公司侧只能看。owner 自己那份页面里不算只读。
  const ro = readOnlyItem(skill)
  const tags = (skill.tags || []).map((tag) => `<span class="tag tag-neutral" style="font-size: 11px; padding: 2px 8px;">${esc(tag)}</span>`).join('')
  const steps = skill.steps ? `<span>${t(`${esc(String(skill.steps))} 个步骤`, `${esc(String(skill.steps))} steps`)}</span>` : ''
  return `<div class="satu-card">
    <div style="display: flex; align-items: flex-start; gap: var(--space-3);">
      <span class="satu-providermark" style="background: var(--color-accent-100); color: var(--color-accent-800);">${svg(SKILL_ICON, 16)}</span>
      <div style="flex: 1; min-width: 0;">
        <div class="satu-name">${esc(skill.name)}${ro ? ` <span class="tag tag-accent-2" style="font-size: 11px;">${t('全局')}</span>` : ''}</div>
        <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px;">${tags}</div>
      </div>
      <button type="button" class="satu-switch" aria-pressed="${String(skill.enabled !== false)}" aria-label="${esc(t('启用'))}" data-act="skill-toggle" data-id="${esc(skill.id)}" ${ro ? 'disabled title="' + esc(t('全局 Skill 由系统管理员维护')) + '"' : ''}><span></span></button>
    </div>
    <p class="satu-desc">${esc(skill.summary || t('（还没写正文）'))}</p>
    <div style="height: 1px; background: var(--color-divider);"></div>
    <div class="satu-meta">
      ${steps}
      <span>${esc(skill.source || t('手动编写'))}</span>
      <span>${t(`更新于 ${esc(dayISO(skill.updatedAt))}`, `Updated ${esc(dayISO(skill.updatedAt))}`)}</span>
    </div>
    <div style="display: flex; gap: var(--space-2); margin-top: auto;">
      <button type="button" class="btn btn-secondary" style="flex: 1; justify-content: center;" data-act="skill-edit" data-id="${esc(skill.id)}" ${ro ? 'disabled title="' + esc(t('全局 Skill 由系统管理员维护')) + '"' : ''}>${ro ? t('查看') : t('编辑')}</button>
      <button type="button" class="btn btn-secondary" style="flex: none;" disabled title="${esc(t('试运行要等 Skill 接进 Agent 循环'))}">${t('试运行')}</button>
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
    const title = zip ? t('选择 .zip 技能包') : t('选择 SKILL.md / .yaml / .json')
    const hint = zip
      ? t('就在这台浏览器里解开，看清楚了再保存。')
      : t('文件内容就是这个 Skill 的定义，导入后可以直接在下面改。')
    const reqs = zip
      ? `<div style="display: flex; flex-direction: column; gap: 6px; padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
          <span class="satu-panel-title">${t('ZIP 包结构要求')}</span>
          ${[t('根目录含 SKILL.md（名称、说明、步骤）'), t('可选 scripts/、templates/、assets/ 子目录'), t('单包不超过 5 MB、200 个文件')]
            .map((line) => `<div class="satu-step" style="color: var(--muted-foreground);">${svg(CHECK_ICON, 13)} ${esc(line)}</div>`)
            .join('')}
        </div>`
      : ''
    const fileRow = file
      ? `<div class="satu-uploadrow">
          <span class="satu-dropicon" style="width: 32px; height: 32px;">${svg(FILE_ICON, 16)}</span>
          <div style="min-width: 0; flex: 1;">
            <div style="font-size: 13.5px; font-weight: 600;">${esc(file.name)}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${esc(kbOf(file.size))}${entries ? t(` · 解出 ${entries.length} 个文件`, ` · ${entries.length} files extracted`) : ''} · 读到 ${steps} 个步骤</div>
          </div>
          <span class="tag tag-accent-2">${zip ? t('已解开') : t('已读取')}</span>
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
        <label for="sk-body">${esc(skill?.fileName || t('Skill 说明'))}</label>
        <textarea class="input${skill || file ? ' satu-code' : ''}" id="sk-body" rows="${skill || file ? 14 : 6}" style="border-radius: var(--radius-md); resize: vertical;" placeholder="${esc(t('描述这个 Skill 解决什么问题、按什么步骤执行'))}">${esc(f.body)}</textarea>
        <span style="font-size: 12px; color: var(--muted-foreground);">${t(`按步骤写：每一条列表项算一个步骤，现在是 ${steps} 个。`, `Write it as steps: each list item counts as one. Currently ${steps}.`)}</span>
      </div>`
    : ''
  const sourceRow = skill ? '' : pickRow(t('创建方式'), SKILL_SOURCES, f.source, 'skill-source')
  const err = state.skillError
    ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${esc(state.skillError)}</div>`
    : ''
  const del = skill
    ? `<button type="button" class="satu-linkbtn" style="margin-right: auto; color: var(--color-accent-800);" data-act="skill-delete">${t('删除这个 Skill')}</button>`
    : ''
  return `<div class="gw-modal-backdrop" data-act="skill-close">
    <form id="skill-form" class="gw-modal" style="max-width: 560px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${skill ? t('编辑 Skill') : t('新建 Skill')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('Skill 把一组步骤和 MCP 工具打包成可复用的工作方法。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="skill-close">${svg(CLOSE_ICON, 16)}</button>
      </div>
      <div class="field">
        <label for="sk-name">${t('名称')}</label>
        <input class="input" id="sk-name" type="text" required value="${esc(f.name)}" placeholder="${esc(t('例如：工单归类与摘要'))}">
      </div>
      ${sourceRow}
      ${uploadBlock}
      ${bodyField}
      ${skillTagPicker(known, f.tags || [])}
      ${skillEnableRow(f.enabled)}
      ${err}
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2);">
        ${del}
        <button type="button" class="btn btn-secondary" data-act="skill-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : skill ? t('保存修改') : t('保存')}</button>
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
    ? `<button type="button" class="satu-linkbtn" style="margin-right: auto; color: var(--color-accent-800);" data-act="mcp-delete">${t('移除这台服务器')}</button>`
    : ''
  const tokenHint = f.hasToken
    ? t('已存了一把。留空表示不动它，填了就换成新的。')
    : t('存在本机库里，不会再从服务端发回浏览器。')
  return `<div class="gw-modal-backdrop" data-act="skill-close">
    <form id="server-form" class="gw-modal" style="max-width: 520px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${server ? t('编辑 MCP 服务器') : t('接入 MCP 服务器')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('接入之后，它提供的工具即可被 Agent 调用。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="skill-close">${svg(CLOSE_ICON, 16)}</button>
      </div>
      <div class="field">
        <label for="tl-name">${t('名称')}</label>
        <input class="input" id="tl-name" name="name" type="text" required value="${esc(f.name)}" placeholder="${esc(t('例如：zendesk-mcp'))}">
      </div>
      ${pickRow(t('传输方式'), MCP_KINDS.map((k) => ({ key: k, label: k })), f.kind, 'mcp-kind')}
      <div class="field">
        <label for="tl-endpoint">${stdio ? t('启动命令') : t('服务器地址')}</label>
        <input class="input" id="tl-endpoint" type="text" required value="${esc(f.endpoint)}" placeholder="${stdio ? 'npx -y @acme/mcp-server' : 'https://mcp.example.com/sse'}" ${stdio ? 'style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;"' : ''}>
        ${stdio ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('本机启动的进程，按 stdio 通信')}</span>` : ''}
      </div>
      <div class="field">
        <label for="tl-token">${t('鉴权 Token（可选）')}</label>
        <input class="input" id="tl-token" type="password" value="${esc(f.token)}" placeholder="${f.hasToken ? '••••••••' : 'Bearer …'}">
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(tokenHint)}</span>
      </div>
      <div class="field">
        <label for="tl-env">${t('环境变量（JSON，可选）')}</label>
        <textarea class="input" id="tl-env" rows="3" style="border-radius: var(--radius-md); resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;" placeholder='{"WORKSPACE_ID":"acme"}'>${esc(f.env)}</textarea>
      </div>
      ${pickRow(t('权限'), MCP_PERMS, f.perm, 'mcp-perm', t('这一档现在只是登记，真正的拦截要等工具管线接上 MCP。'))}
      ${skillEnableRow(f.enabled)}
      ${err}
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2);">
        ${del}
        <button type="button" class="btn btn-secondary" data-act="skill-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : server ? t('保存修改') : t('保存')}</button>
      </div>
    </form>
  </div>`
}

function skillsPage() {
  const tab = state.skillsTab === 'MCP 与工具' ? t('MCP 与工具') : 'Skill'
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
        <button type="button" class="satu-linkbtn" data-act="skill-dismiss">${t('知道了')}</button>
      </div>`
    : ''
  let body
  if (isSkill) {
    body = skills.length
      ? `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-4);">${skills.map(skillCard).join('')}</div>`
      : skillEmpty(t('还没有 Skill'), t('点右上角新建一个：手动写，或导入一份 SKILL.md。'))
  } else {
    const rows = servers
      .map(
        (s) => `<div class="satu-toolrow">
          <div style="min-width: 0; display: flex; flex-direction: column; gap: 2px;">
            <span style="font-weight: 600; font-size: 14px;">${esc(s.name)}${readOnlyItem(s) ? ` <span class="tag tag-accent-2" style="font-size: 11px;">${t('全局')}</span>` : ''}</span>
            <span style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(s.endpoint)}</span>
          </div>
          <span style="font-size: 13px;">${esc(s.kind)}</span>
          <span style="font-size: 13px; color: var(--muted-foreground);" title="${esc(t('接上之后才知道'))}">—</span>
          <span class="tag ${permTag(s.perm)}">${esc(s.perm)}</span>
          <span style="font-size: 13px; color: var(--muted-foreground);">${esc(dayISO(s.updatedAt))}</span>
          <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-1); justify-content: flex-end;">
            <button type="button" class="satu-switch" aria-pressed="${String(s.enabled !== false)}" aria-label="${esc(t('启用'))}" data-act="mcp-toggle" data-id="${esc(s.id)}" ${readOnlyItem(s) ? 'disabled title="' + esc(t('全局 MCP 由系统管理员维护')) + '"' : ''}><span></span></button>
            <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('编辑 MCP 服务器'))}" data-act="mcp-edit" data-id="${esc(s.id)}" ${readOnlyItem(s) ? 'disabled title="' + esc(t('全局 MCP 由系统管理员维护')) + '"' : ''}>${svg(EDIT_ICON, 15)}</button>
          </div>
        </div>`,
      )
      .join('')
    const table = servers.length
      ? `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-toolhead">
            <span>${t('MCP 服务器')}</span><span>${t('传输')}</span><span>${t('工具数')}</span><span>${t('权限')}</span><span>${t('更新时间')}</span><span></span>
          </div>
          ${rows}
        </div>`
      : skillEmpty(t('还没接入 MCP 服务器'), t('点右上角接入一台：填地址与权限，先把配置登记下来。'))
    body = `<div style="display: flex; flex-direction: column; gap: var(--space-6);">
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <div style="display: flex; align-items: baseline; justify-content: space-between;">
          <h2 style="font-size: 18px; margin: 0;">${t('内置工具')}</h2>
        </div>
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('内置工具在 Bot 运行时上，Gateway 这一屏不列。')}</div>
      </div>
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <div style="display: flex; align-items: baseline; justify-content: space-between;">
          <h2 style="font-size: 18px; margin: 0;">${t('已接入 MCP 服务器')}</h2>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t(`共 ${servers.length} 个`, `${servers.length} total`)}</span>
        </div>
        ${table}
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('这里存的是连接配置。MCP 客户端还没接上，所以「工具数」要等真握上手才知道，先空着。')}</span>
      </div>
    </div>`
  }
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('Skill 与 MCP')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('Skill 是可复用的工作方法，MCP 服务器提供 AI 员工实际可调用的工具。')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" data-act="${isSkill ? 'skill-create' : 'mcp-create'}">
            ${svg(PLUS_ICON, 15)} ${isSkill ? t('新建 Skill') : t('接入 MCP')}
          </button>
        </div>
        ${flashes()}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('分类')}</span>
          ${tabs}
        </div>
        ${failure}
        ${body}
      </div>
    </div>
    ${skillDialogView()}
    ${serverDialogView()}`
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
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === item.key)}" data-act="billing-tab" data-tab="${item.key}">${t(item.label)}</button>`,
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
          <button type="button" class="satu-linkbtn" disabled title="${esc(t('发票开具还没做'))}">${t('发票')}</button>
        </div>
      </div>`,
    )
    .join('')
  const topupRows = topups
    .map(
      (row) => `<div class="satu-billrow">
        <span style="font-size: 13.5px;">${esc(row.time)}</span>
        <span style="font-size: 13.5px;">${esc(row.amount)}</span>
        <span class="tag tag-accent-2">${t('已到账')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(row.note || '—')}</span>
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
                <span class="satu-panel-title">${t('当前订阅')}</span>
                <div style="display: flex; align-items: baseline; gap: var(--space-2); margin-top: 6px;">
                  <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(plan.name || t('席位套餐'))}</span>
                  <span class="tag tag-accent-2">${esc(plan.status || t('生效中'))}</span>
                </div>
                <p style="margin: 6px 0 0; font-size: 13px; color: var(--muted-foreground);">${esc(plan.cycle || '—')} · ${esc(plan.seats || '—')}</p>
              </div>
              <button type="button" class="btn btn-secondary" style="flex: none;" disabled title="${esc(t('订阅体系还没做'))}">${t('管理订阅')}</button>
            </div>
            <div class="satu-kv"><span>${t('当前周期')}</span><span>${esc(plan.period || '—')}</span></div>
            <div class="satu-kv"><span>${t('下次续订')}</span><span>${esc(plan.renew || '—')}</span></div>
            <div class="satu-kv"><span>${t('周期费用')}</span><span>${esc(plan.amount || '—')}</span></div>
            <div class="satu-toggleRow">
              <div>
                <div style="font-size: 13.5px; font-weight: 600;">${t('自动续订')}</div>
                <div style="font-size: 12px; color: var(--muted-foreground);">${t('续订还没接，这个开关现在只是界面。')}</div>
              </div>
              <button type="button" class="satu-switch" aria-pressed="${String(renewing)}" aria-label="${esc(t('自动续订'))}" data-act="billing-autorenew"><span></span></button>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; gap: var(--space-3);">
            <h2 style="font-size: 18px; margin: 0;">${t('订阅账单')}</h2>
            <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
              <div class="satu-billhead">
                <span>${t('账期')}</span><span>${t('金额')}</span><span>${t('状态')}</span><span>${t('付款时间')}</span><span></span>
              </div>
              ${invoiceRows || empty(t('还没有订阅账单。支付接上之后，账期会列在这里。'))}
            </div>
          </div>
        </div>`
  // 余额跟两个 tab 都有关（订阅送的 + 自己充的），所以提到 tab 上面，切 tab 也不换走。
  //
  // 两张卡并排：左边是会过期的那一笔，右边是账户合计。分开摆是因为这两笔的规矩不一样
  // ——赠送的跟着套餐到期清零，充的不过期。混在一张卡里只剩一个合计数，看不出该先花哪笔。
  const bonusExpiry = balance.planBonusExpires && balance.planBonusExpires !== '—'
    ? t(`${esc(balance.planBonusExpires)} 到期，没用完清零`, `expires ${esc(balance.planBonusExpires)}, unused amount is cleared`)
    : t('没有生效中的套餐')
  const balanceCard = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-4);">
          <div class="satu-panel">
            <span class="satu-panel-title">${t('套餐赠送余额')}</span>
            <div style="display: flex; align-items: baseline; gap: var(--space-3); margin-top: 6px;">
              <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(balance.planBonus || '—')}</span>
              <span style="font-size: 13px; color: var(--muted-foreground);">${bonusExpiry}</span>
            </div>
            <div class="satu-kv"><span>${t('来源')}</span><span>${esc(plan.name || t('席位套餐'))}</span></div>
            <div class="satu-kv"><span>${t('当前周期')}</span><span>${esc(plan.period || '—')}</span></div>
            <p style="margin: auto 0 0; font-size: 12px; color: var(--muted-foreground);">${t('跟着套餐走：续订会重新发一笔，到期不结转。')}</p>
          </div>
          <div class="satu-panel">
            <span class="satu-panel-title">${t('账户余额')}</span>
            <div style="display: flex; align-items: baseline; gap: var(--space-3); margin-top: 6px;">
              <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(balance.amount || '—')}</span>
              <span style="font-size: 13px; color: var(--muted-foreground);">${t(`本月已用 ${esc(balance.spentThisMonth || '—')}`, `${esc(balance.spentThisMonth || '—')} used this month`)}</span>
            </div>
            ${/* 合计里含左边那一笔，所以这儿把两笔各自摊开，省得看着像两个不相干的数。 */ ''}
            <div class="satu-kv">
              <span>${t('充值余额')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('不过期')}</span></span>
              <span>${esc(balance.topup || '—')}</span>
            </div>
            <div class="satu-kv">
              <span>${t('套餐赠送余额')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('会过期')}</span></span>
              <span>${esc(balance.planBonus || '—')}</span>
            </div>
            <div class="satu-kv"><span>${t('余额预警线')}</span><span>${esc(balance.alertAt || '—')}</span></div>
            <p style="margin: auto 0 0; font-size: 12px; color: var(--muted-foreground);">${t('充值由平台代充：需要加额度请联系平台管理员。')}</p>
          </div>
        </div>`
  const topupBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-6);">
          <div style="display: flex; flex-direction: column; gap: var(--space-3);">
            <h2 style="font-size: 18px; margin: 0;">${t('充值记录')}</h2>
            <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
              <div class="satu-billhead">
                <span>${t('时间')}</span><span>${t('金额')}</span><span>${t('状态')}</span><span>${t('备注')}</span><span></span>
              </div>
              ${topupRows || empty(t('还没有充值记录。'))}
            </div>
          </div>
        </div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('账单')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('查看订阅状态、充值余额与历史账单。')}</p>
        </div>
        ${balanceCard}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">${tabs}</div>
        ${flashes()}
        ${tab === 'sub' ? subBody : topupBody}
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('账单是公司产品层的事，不走 Bot 运行时。发票、扣款、充值都还没接，数字空着，不编。')}</p>
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
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(t(s.label))}</span>
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
            return `<div class="satu-barcol" title="${esc(t(`${d.label} · ${v} 次`, `${d.label} · ${v} calls`))}">
                <div class="satu-barstack">
                  <div class="satu-barfill" style="height: ${h}%;"></div>
                </div>
                <span class="satu-barlabel">${esc(d.label)}</span>
              </div>`
          })
          .join('')
        return `<div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
            <span class="satu-panel-title">${t('每日任务执行量')}</span>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t(`峰值 ${peak} 次`, `peak ${peak} calls`)}</span>
          </div>
          <div class="satu-bars">${cols}</div>`
      })()
    : `<span class="satu-panel-title">${t('每日任务执行量')}</span>
          ${empty(t('还没有每日用量。实例上报之后会画在这里。'))}`
  const agentBody = byAgent.length
    ? byAgent.map((a) => usageMeter(a.name, a.value, a.pct, false, false)).join('')
    : empty('还没有按 Bot 的用量。')
  const modelBody = byModel.length
    ? byModel.map((m) => usageMeter(m.name, m.value, m.pct, true, true)).join('')
    : empty('还没有按模型的用量。')
  const memberRows = byMember
    .map((m) => {
      // 「已离职员工」是服务端兜出来的合计行，不是某个人——它的名字要翻译，真人的
      // 名字不能进译表。所以按标记分流，不是把所有 name 都塞进 t()。
      const label = m.departed
        ? `${t('已离职员工')}${m.count > 0 ? `（${m.count}）` : ''}`
        : m.name
      return `<div class="satu-usagerow"${m.departed ? ' style="opacity: 0.75;"' : ''}>
        <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
          <span class="satu-avatar" style="width: 26px; height: 26px; font-size: 11px; background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc(m.initial || initialOf(m))}</span>
          <span style="min-width: 0; font-size: 13.5px;">${esc(label)}</span>
        </div>
        <span style="font-size: 13px;">${esc(m.tasks)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(m.tokens)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(m.fail)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(m.last)}</span>
      </div>`
    })
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('用量统计')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(range)} · ${esc((Number((stats.find((x) => x.label === t('任务执行')) || {}).value) || 0) > 0 ? t('已记录调用') : t('还没有调用'))}</p>
          </div>
          <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
            ${pills}
            <button type="button" class="btn btn-secondary" disabled title="${esc(t('导出需要统计投影'))}">${t('导出 CSV')}</button>
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
            <span class="satu-panel-title">${t('按 Bot')}</span>
            ${agentBody}
          </div>
          <div class="satu-panel">
            <span class="satu-panel-title">${t('按模型')}</span>
            ${modelBody}
          </div>
        </div>
        <div class="satu-panel">
          <div>
            <span class="satu-panel-title">${t('套餐额度')}</span>
            <p style="margin: 6px 0 0; font-size: 13px; color: var(--muted-foreground);">${t(`当前套餐只约束席位（${seats} 个），还没有任务次数和 token 额度。`, `The current plan only caps seats (${seats}); there is no task or token quota yet.`)}</p>
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <h2 style="font-size: 18px; margin: 0;">${t('成员用量')}</h2>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-usagehead">
              <span>${t('成员')}</span><span>${t('任务')}</span><span>Tokens</span><span>${t('失败率')}</span><span>${t('最近使用')}</span>
            </div>
            ${memberRows || empty(t('还没有成员。'))}
          </div>
        </div>
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('费用还没有账单，显示 —。调用次数和 token 来自 Gateway 记下的 llm_calls，没有就 0。')}</p>
      </div>
    </div>`
}


let chatAbort = null
let chatStreamId = ''

/**
 * 每个 Bot 一条事件流。
 *
 * 侧栏那份名单要显示「最近一条回复的时间 + 摘要 + 在不在跑」，这三样只能从会话事件里
 * 拿。**只盯当前这条会话是不够的**：人在 A 上派了活、切到 B 去看别的，最想知道的恰恰
 * 是 A 什么时候干完——而以前一切走就把 A 的流掐了，从此两眼一抹黑。
 *
 * 摘要为什么不让 Gateway 给：db.ts 那边写着「会话索引只存指针，不存 user/message 或
 * assistant/message 正文」——正文留在席位机器上，Gateway 只有 sessionId 和计数。为了
 * 名单上一行灰字去破这条边界不划算，而流里本来就有全文。
 *
 * botId -> { sessionId, ac, events, sum }
 * sum = { busy, lastAt, lastText }，**增量维护**：每次渲染名单都去 fold 一遍全部事件，
 * 几个 Bot 各七百多条，光滚个侧栏就能把 CPU 吃满。
 */
const botStreams = new Map()

/** 同时开着的流的上限。名单通常只有两三个 Bot，这道闸是防意外，不是常态。 */
const BOT_STREAM_MAX = 8

function botStreamOf(botId) {
  let row = botStreams.get(botId)
  if (!row) {
    row = { sessionId: '', ac: null, events: [], sum: { state: 'idle', lastAt: 0, lastText: '' } }
    botStreams.set(botId, row)
  }
  return row
}

/** 事件到了就地更新摘要。O(1)，不 fold。 */
function noteBotEvent(botId, ev) {
  const row = botStreams.get(botId)
  if (!row) return
  const sum = row.sum
  const before = sum.state + '|' + sum.lastAt + '|' + sum.lastText
  if (ev.type === 'turn/start') sum.state = 'busy'
  else if (ev.type === 'turn/end') sum.state = 'idle'
  // **「待人工处理」还没有数据源。** 系统里的「需审批」目前只是 MCP 的配置项
  // （routes.ts 的 MCP_PERMS），运行时并没有「停下来等人点头」这件事——bot 要么在跑，
  // 要么跑完了。等哪天 bot 会为此发一条事件（比如 turn 挂起等审批），在这里加一行
  // `sum.state = 'review'` 就接上了，点的样式和三态判断都已经在位。
  else if (ev.type === 'user/message' || ev.type === 'assistant/message') {
    const text = messageText((ev.data || {}).message) || (ev.data || {}).text || ''
    if (text) {
      sum.lastText = text.replace(/\s+/g, ' ').trim().slice(0, 120)
      sum.lastAt = Number(ev.time) || sum.lastAt
    }
  } else if (ev.type === 'assistant/chunk') {
    // 流式期间也把时间往前推，否则「最近回复」会停在上一轮，看着像卡住了。
    sum.lastAt = Number(ev.time) || sum.lastAt
  }
  if (before !== sum.state + '|' + sum.lastAt + '|' + sum.lastText) scheduleRosterPaint()
}

/** 关掉一个 Bot 的流。事件留着——切回去时就不用再重放一遍历史。 */
function closeBotStream(botId) {
  const row = botStreams.get(botId)
  if (!row) return
  if (row.ac) {
    try {
      row.ac.abort()
    } catch {}
  }
  row.ac = null
}

function closeAllBotStreams() {
  for (const id of botStreams.keys()) closeBotStream(id)
  botStreams.clear()
}

/** 超出上限就先关最久没动静的那条，事件也一并丢掉。 */
function trimBotStreams(keepId) {
  if (botStreams.size <= BOT_STREAM_MAX) return
  const rows = [...botStreams.entries()].filter(([id, r]) => id !== keepId && r.sum.state === 'idle')
  rows.sort((a, b) => a[1].sum.lastAt - b[1].sum.lastAt)
  while (botStreams.size > BOT_STREAM_MAX && rows.length) {
    const [id] = rows.shift()
    closeBotStream(id)
    botStreams.delete(id)
  }
}

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
    // 事件自带 time（bot 那边 append 时打的）。界面上要按天分隔、每条标时刻，
    // 所以 fold 得把它带出来——只有块的**第一条**事件的时间算数，流式续写的那些
    // chunk 不该让一条消息的时间一直往后跳。
    const at = Number(ev.time) || 0
    if (type === 'user/message') {
      if (data.source && data.source.kind && data.source.kind !== 'user') continue
      assistant = null
      tools = []
      blocks.push({ kind: 'user', text: messageText(data.message) || data.text || '', time: at })
    } else if (type === 'assistant/message') {
      const text = messageText(data.message)
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, time: at }
        blocks.push(assistant)
      }
      if (text) assistant.text = text
    } else if (type === 'assistant/chunk') {
      const chunk = data.chunk || {}
      if (chunk.type === 'text-delta' && chunk.text) {
        if (!assistant) {
          assistant = { kind: 'assistant', text: '', tools, time: at }
          blocks.push(assistant)
        }
        assistant.text += chunk.text
      }
    } else if (type === 'tool/call') {
      // 工具常常在助手吐出第一个字**之前**就开始跑（先查订单再回话）。以前只在已经有
      // 助手块时才把工具挂上去，于是这一段时间里工具痕迹无处可去，等回答开始才突然
      // 冒出来——正好是最想知道「它在干什么」的那几秒什么都看不到。这里补一条：工具
      // 一开跑就把助手块建出来，正文留空，界面上就是一个带工具痕迹的「正在想」气泡。
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, time: at }
        blocks.push(assistant)
      }
      tools.push({ callId: data.callId, name: data.name || 'tool', result: null, failed: false })
      assistant.tools = tools
    } else if (type === 'tool/result') {
      const hit =
        tools.find((x) => x.callId && x.callId === data.callId && x.result == null) ||
        tools.find((x) => x.result == null) ||
        tools[tools.length - 1]
      if (hit) {
        hit.result = data.text || ''
        hit.failed = Boolean(data.failed)
      }
    } else if (type === 'turn/start') {
      status = 'running'
    } else if (type === 'turn/end') {
      status = ''
    }
  }
  return { blocks, status }
}

/**
 * 放掉「当前流」这把闩，但不 abort。
 *
 * 建连失败的几条路径（fetch 抛、503、非 2xx）以前直接 return，把 chatAbort /
 * chatStreamId 留在「已占用」状态。ensureChatSession 和 startChatStream 都靠这两个值
 * 判断「已经有流在跑」，于是一次实例还没起来的 503 之后，聊天再也不会重连——要刷新
 * 整页才回得来。
 */
function releaseChatStream(ac) {
  if (chatAbort !== ac) return
  chatAbort = null
  chatStreamId = ''
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

/**
 * 把当前会话换成这个 Bot 的。
 *
 * **换 Bot 的第一件事是清场，不是去拿新会话。** 原先是等新会话拿回来、比对出
 * sessionId 变了才清 state.chatEvents——于是只要那一步没走到，屏幕上就还挂着上一个
 * Bot 的对话。而它非常容易走不到：新 Bot 的席位没起来时，`/runtime/bots/:id/session`
 * 直接 503「实例还没上线」，catch 里记一笔就返回了。结果是切过去之后，你看着的是**另
 * 一个 Bot 的聊天记录**，旧的那条流还连着，还在往里追新消息。
 *
 * 所以顺序反过来：Bot 一变，立刻停掉旧流、把正文和状态清空。拿不到新会话就是一片空
 * 白加一句「实例还没上线」——空白是诚实的，别人的对话不是。
 */
async function ensureChatSession(botId) {
  if (!botId) return
  if (state.chatBotId === botId && state.chatSessionId && chatStreamId === state.chatSessionId) return
  // 这个 Bot 的流一直开着（切走时没掐）——把正文接回去就行，不用重新拉一遍会话。
  const warm = botStreams.get(botId)
  if (warm && warm.ac && warm.sessionId && state.chatBotId !== botId) {
    if (state.chatBotId) state.chatDrafts[state.chatBotId] = { text: state.chatDraft, files: state.chatFiles }
    const kept = state.chatDrafts[botId] || { text: '', files: [] }
    state.chatBotId = botId
    state.chatSessionId = warm.sessionId
    state.chatEvents = warm.events
    state.chatReplaying = false
    state.chatDraft = kept.text
    state.chatFiles = kept.files
    chatAbort = warm.ac
    chatStreamId = warm.sessionId
    paintChat()
    return
  }
  if (state.chatBotId !== botId) {
    // **不掐上一个 Bot 的流。** 它可能正在干活，而名单上的转圈和「最近回复」就靠它。
    // 只把「当前会话」这把闩放开——正文渲染换到新 Bot 那边去。
    chatAbort = null
    chatStreamId = ''
    // 没发出去的草稿和附件是写给上一个 Bot 的，跟着它一起收起来；切回去还在。
    if (state.chatBotId) state.chatDrafts[state.chatBotId] = { text: state.chatDraft, files: state.chatFiles }
    const kept = state.chatDrafts[botId] || { text: '', files: [] }
    state.chatBotId = botId
    state.chatSessionId = ''
    // 正文直接指向这个 Bot 自己的事件桶：切回去时历史还在，不用再重放一遍。
    state.chatEvents = botStreamOf(botId).events
    state.chatStatus = ''
    state.chatReplaying = false
    state.chatDraft = kept.text
    state.chatFiles = kept.files
  }
  try {
    const data = await api('GET', '/runtime/bots/' + encodeURIComponent(botId) + '/session')
    const sessionId = data.sessionId
    if (!sessionId) throw new Error('没有会话')
    // 期间人又切走了：这次的结果已经不作数，认领了就会把新会话顶掉。
    if (state.chatBotId !== botId) return
    const row = botStreamOf(botId)
    if (row.sessionId && row.sessionId !== sessionId) {
      // 换了一条会话（席位重建过）——旧事件作废。
      row.events.length = 0
      row.sum = { state: 'idle', lastAt: 0, lastText: '' }
    }
    state.chatEvents = row.events
    state.chatSessionId = sessionId
    state.chatStatus = ''
    void startChatStream(sessionId, 0, botId)
  } catch (err) {
    const msg = String(err.message || '')
    if (msg.includes('实例还没上线')) state.runtimeError = '实例还没上线'
    else throw err
  }
}

async function loadChatPage() {
  // loadRuntimeBots 由 loadPage 统一拉（名单是全局侧栏，不只这一页要）。
  await loadRuntimeMachine()
  const botId = chatBotIdOf(state.path)
  await loadDesktopRuntime(botId)
  if (botId) await ensureChatSession(botId)
  // 名单上每个 Bot 都挂一条流。刷新页面之后也能立刻看出谁在干活、谁最近说了什么——
  // 只连当前这一个的话，那两列信息要等人挨个点进去才出得来。
  void warmBotStreams()
}

/**
 * 给名单上的每个 Bot 都开一条流（当前这个除外，它自己会开）。
 *
 * 串着来、不并发：每条流一上来都要重放整段历史，几个 Bot 同时灌会把主线程压住，
 * 而这些数据只是侧栏上的一行字，不该跟正文抢。
 */
async function warmBotStreams() {
  for (const b of state.runtimeBots || []) {
    if (!b || !b.id) continue
    // 当前这个由 ensureChatSession 开（它还要接正文），这里只管别的。
    if (b.id === state.chatBotId && botStreams.get(b.id)?.ac) continue
    const row = botStreams.get(b.id)
    if (row && row.ac) continue
    try {
      const data = await api('GET', '/runtime/bots/' + encodeURIComponent(b.id) + '/session')
      if (!data.sessionId) continue
      const r = botStreamOf(b.id)
      if (r.sessionId && r.sessionId !== data.sessionId) {
        r.events.length = 0
        r.sum = { state: 'idle', lastAt: 0, lastText: '' }
      }
      void startChatStream(data.sessionId, 0, b.id)
    } catch {
      // 席位没上线之类——名单上这一行就没有时间和摘要，不该让整页跟着出错。
    }
  }
}

/**
 * 事件流游标。断线重连时带上它，服务端从这一条之后继续发。
 *
 * 事件里的 `seq` 是会话日志的行号，天然单调，所以「续传」就是把最后见到的那个数
 * 回传过去——不需要去重，也不会重放已经画出来的内容。
 */
function chatCursor(botId) {
  const list = botId ? botStreamOf(botId).events : state.chatEvents
  for (let i = list.length - 1; i >= 0; i--) {
    const n = Number(list[i] && list[i].seq)
    if (Number.isFinite(n)) return n
  }
  return null
}

/** 这条会话归哪个 Bot。事件回来时要知道记到谁头上。 */
function botIdOfSession(sessionId) {
  for (const [id, row] of botStreams) if (row.sessionId === sessionId) return id
  return ''
}

/**
 * 断了自己接回来。
 *
 * 以前是「流断了就停，下次打开会话才重连」——网络抖一下、或者机器管家换版重启一
 * 次，正在看的对话就无声地卡住了，人还以为 bot 在想。退避重试到第 6 次为止，
 * 之后才把「连接断开」摆到界面上。
 */
const CHAT_RETRY_MAX = 6
/** 连接活够这么久，就算「真的连上过」，退避档位归零。 */
const CHAT_ALIVE_MS = 10_000

async function startChatStream(sessionId, attempt = 0, botId = '') {
  const owner = botId || botIdOfSession(sessionId)
  const isActive = () => state.chatSessionId === sessionId
  if (attempt === 0) {
    const row = owner ? botStreamOf(owner) : null
    // 这条流已经在跑就别再开一条。**换 Bot 不再掐流**：名单要靠它继续报「跑完没有」。
    if (row && row.sessionId === sessionId && row.ac) return
    if (isActive()) stopChatStream()
  }
  const ac = new AbortController()
  if (owner) {
    const row = botStreamOf(owner)
    row.sessionId = sessionId
    row.ac = ac
    trimBotStreams(owner)
  }
  // `|| !owner`：没归到哪个 Bot 名下的流（低层直接调用、测试）按老规矩走单流那一套，
  // 否则它既不在 botStreams 里、又不是当前会话，就成了没人认领的孤儿——断了不重连，
  // 也没人把「连接断开」摆到界面上。
  if (isActive() || !owner) {
    chatAbort = ac
    chatStreamId = sessionId
    // 断线重连（带 after）也可能补一大段，同样先拉闸。
    beginReplay()
  }
  const t = token()
  const after = chatCursor(owner)
  const q = after != null ? '?after=' + encodeURIComponent(after) : ''
  let res
  try {
    res = await fetch('/runtime/sessions/' + encodeURIComponent(sessionId) + '/events' + q, {
      headers: {
        accept: 'text/event-stream',
        ...(t ? { authorization: 'Bearer ' + t } : {}),
      },
      signal: ac.signal,
    })
  } catch (err) {
    releaseChatStream(ac)
    endReplay()
    if (ac.signal.aborted) return
    state.runtimeError = '实例还没上线'
    paintChat()
    return
  }
  if (res.status === 503) {
    releaseChatStream(ac)
    endReplay()
    state.runtimeError = '实例还没上线'
    paintChat()
    return
  }
  if (!res.ok || !res.body) {
    releaseChatStream(ac)
    endReplay()
    state.runtimeError = (await res.text().catch(() => '')) || '实例还没上线'
    paintChat()
    return
  }
  const reader = res.body.getReader()
  const openedAt = Date.now()
  const decoder = new TextDecoder()
  let buf = ''
  /**
   * 下一次重连用哪个退避档位。
   *
   * 判据是**这次连接活了多久**，不是「有没有连上」。两头都要照顾：
   *
   * - 只看「连上了没有」：bot 在崩溃重启循环里（接受连接后立刻断），每次都拿到 200，
   *   档位每次归零，于是每 500ms 重连一次、永远停不下来，也永远走不到「连接断开」。
   * - 只看「一共重连过几次」：一个开着一整天的标签页，被中间那一跳定期掐断 6 次之后
   *   就再也接不回来了——可每一次它都是连上的。
   *
   * 活够 CHAT_ALIVE_MS 才算一次真连接，归零；没活够就沿用当前档位继续退避。
   */
  const nextAttempt = () => (Date.now() - openedAt >= CHAT_ALIVE_MS ? 0 : attempt)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // 这条流已经不是「当前那条」了就收摊。切 Bot 的一瞬间，旧流手上可能还攥着一段
      // 已经收到、还没解析的数据；不在这里拦住，它会落进新会话的事件数组里，画出来
      // 就是两个 Bot 的消息串在一起。
      //
      // 判据以 chatStreamId 为准（换 Bot 必经 stopChatStream，它就是那把闩）。
      // chatSessionId 只在**已经认定了某条会话**时才参与——低层直接调 startChatStream
      // 的路径（重连、测试）还没来得及认领，不该被当成「串台」拦掉。
      if (ac.signal.aborted) break
      // **不再因为「不是当前会话」就收摊**：后台那几条流正是名单上时间、摘要和转圈的
      // 唯一来源。只有当前这条要盯 chatStreamId（重连时它会被换掉）。
      if (isActive() && chatStreamId !== sessionId) break
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
          if (ev.type === 'replay/done') {
            // bot 明说历史放完了。它不是会话事件，不进事件桶。
            if (isActive()) endReplay()
            continue
          }
          if (owner) {
            botStreamOf(owner).events.push(ev)
            noteBotEvent(owner, ev)
          } else if (isActive()) {
            // 没有归属又不是当前会话的流，事件无处可放——**绝不能倒进 chatEvents**，
            // 那正是「切走了，旧流剩下的半截落进新会话」的老毛病。
            state.chatEvents.push(ev)
          }
          if (!isActive()) continue
          if (state.chatReplaying) bumpReplayQuiet()
          else schedulePaintChat()
        }
      }
    }
  } catch (err) {
    endReplay()
    if (!ac.signal.aborted) return retryChatStream(sessionId, ac, nextAttempt())
    return
  }
  endReplay()
  // 正常读到 done 也要重连：SSE 被中间那一跳掐掉时看起来就是干净的流结束。
  if (!ac.signal.aborted) return retryChatStream(sessionId, ac, nextAttempt())
}

function retryChatStream(sessionId, ac, attempt) {
  const owner = botIdOfSession(sessionId)
  const row = owner ? botStreams.get(owner) : null
  // 后台流也要重连——名单上的「跑完没有」全指望它。
  if (row ? row.ac !== ac : chatAbort !== ac || chatStreamId !== sessionId) return
  if (attempt >= CHAT_RETRY_MAX) {
    state.runtimeError = '连接断开，刷新页面重试'
    paintChat()
    return
  }
  const delay = Math.min(500 * 2 ** attempt, 8000)
  setTimeout(() => {
    if (chatAbort !== ac || chatStreamId !== sessionId) return
    void startChatStream(sessionId, attempt + 1)
  }, delay)
}

/**
 * 重放闸。
 *
 * 打开一条会话时，SSE 会把**全部历史**从头推一遍，和后续的实时事件走同一个通道。
 * 一条 8 轮的对话就是 789 条事件（其中 706 条是流式 chunk）。以前每收到一条就重绘一
 * 次：每次都要 fold 全量事件、比对整棵 DOM、把最后那段 Markdown 重渲染一遍——O(n²)，
 * 而且屏幕上能看见消息一条条往外冒。
 *
 * 更糟的是**状态是错的**：重放到某轮的 `turn/start` 就显示「正在处理」，要等重放出
 * 配对的 `turn/end` 才消失。实测 789 帧里有 772 帧（98%）挂着「正在处理」，而那期间
 * 什么都没在跑——它说的是几小时前那一轮。
 *
 * 所以重放期间只收不画，历史放完再画一次。两个判据：
 *   1. bot 发的 `replay/done`（准确，但要 bot 也升级）
 *   2. 静默 120ms（兜底：重放是连续灌的，一停就是灌完了）
 * 外加 4 秒硬上限，免得某条流一直断续把闸卡死。
 */
const REPLAY_QUIET_MS = 120
const REPLAY_MAX_MS = 4000
let replayQuietTimer = null
let replayCapTimer = null

function beginReplay() {
  state.chatReplaying = true
  clearTimeout(replayCapTimer)
  replayCapTimer = setTimeout(() => endReplay(), REPLAY_MAX_MS)
  bumpReplayQuiet()
}

/** 又来一条：重放还在继续，把「静默」判定往后推。 */
function bumpReplayQuiet() {
  if (!state.chatReplaying) return
  clearTimeout(replayQuietTimer)
  replayQuietTimer = setTimeout(() => endReplay(), REPLAY_QUIET_MS)
}

function endReplay() {
  clearTimeout(replayQuietTimer)
  clearTimeout(replayCapTimer)
  if (!state.chatReplaying) return
  state.chatReplaying = false
  paintChat()
}

let chatPaintQueued = false

/**
 * 流式渲染期间合并重绘。
 *
 * 每个 token 都整块 innerHTML 重建一次会话，是 O(n²)：第 n 个 token 要连带重画前面
 * n-1 条消息。一帧一次就够，人眼分辨不出差别，长会话下差别很大。
 */
function schedulePaintChat() {
  if (chatPaintQueued) return
  chatPaintQueued = true
  const run = () => {
    chatPaintQueued = false
    paintChat()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 16)
}

/* ══ 对话渲染 ════════════════════════════════════════════════════════
   一轮回答期间 paintChat 每帧跑一次，所以这里只有一条规矩：**只动变了的那一块**。
   两层各管一段：

     消息层  syncThread —— 按 data-key 比对，新消息插进来，旧的连节点都不换
     正文层  syncMd     —— 把正文切成 Markdown 顶层块，只重画正在长的那一块

   两层都要。只做消息层的话，一条越写越长的回答每帧都要重排整段正文，连带把里面
   已经画好的 mermaid 图和公式重画一遍；只做正文层的话，每帧还是在重建整条消息流。
   分开之后稳定的部分节点身份不变，markdown.js 打在上面的 data-done 才作数。
   ══════════════════════════════════════════════════════════════════ */

/* 时间戳统一按这个时区读。跟 fmtTime 保持一致——同一屏上两套时区最难查。 */
const CHAT_TZ = 'Asia/Kuching'

function chatClock(ms) {
  if (!ms) return ''
  return new Intl.DateTimeFormat('en-GB', { timeZone: CHAT_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
}

/** YYYY-MM-DD，只用来比「是不是同一天」。 */
function chatDayKey(ms) {
  if (!ms) return ''
  return new Intl.DateTimeFormat('en-CA', { timeZone: CHAT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

function chatDayLabel(ms) {
  const key = chatDayKey(ms)
  if (!key) return ''
  const now = Date.now()
  if (key === chatDayKey(now)) return t('今天')
  if (key === chatDayKey(now - 86400000)) return t('昨天')
  return key
}

const ICON_CLIP =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>'
const ICON_X =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'

/* 发送 / 停止。同一个按钮的两副面孔，所以放在一起。 */
const ICON_SEND =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>'
const ICON_STOP =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'

const ICON_BOT =
  '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>'
const ICON_TOOL =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>'
const ICON_DOWN =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>'

/** 当前这条对话属于哪个 Bot。抬头和导出都要用。 */
function chatBotOf() {
  const id = chatBotIdOf(state.path) || state.chatBotId
  return (state.runtimeBots || []).find((b) => b.id === id) || null
}

/**
 * 一条工具痕迹。
 *
 * 只露名字和状态，**不展开结果**：工具结果动辄几千字（一次文件读、一次搜索），摊在
 * 对话里会把真正的回答挤到屏幕外。要看细节去右栏的运行环境。
 */
function chipHtml(x) {
  const state_ = x.result == null ? 'running' : x.failed ? 'error' : 'done'
  const label = x.result == null ? t('调用中') : x.failed ? t('失败') : t('完成')
  return `<span class="sw-chip" data-state="${state_}" title="${esc(x.name + ' · ' + label)}">${ICON_TOOL}<span>${esc(x.name)} · ${esc(label)}</span></span>`
}

/** 一条消息的外壳。正文和工具条留空，交给 updateRow 填——它俩每帧都可能变。 */
function rowShell(b, key) {
  const account = (state.me && state.me.account) || {}
  const avatar = b.kind === 'user' ? esc(initialOf(account)) : ICON_BOT
  // 时间戳两侧一致，都挂在气泡外面（见 chat.css 里 .sw-time 的说明）。
  const time = b.time ? `<time class="sw-time" datetime="${new Date(b.time).toISOString()}">${esc(chatClock(b.time))}</time>` : ''
  return (
    `<div class="sw-msg" data-role="${b.kind}" data-key="${key}">` +
    `<div class="sw-msg-avatar" aria-hidden="true">${avatar}</div>` +
    `<div class="sw-msg-col">` +
    `<div class="sw-bubble" data-role="${b.kind}"><div class="sw-md"></div><div class="sw-chips" hidden></div></div>` +
    `${time}</div></div>`
  )
}

/**
 * 把 host 的子节点对齐到 text 渲染出的 Markdown 块。
 *
 * 每个子节点记着自己那一块的**源文本**（data-sig）。源文本没变就整块跳过——节点原地
 * 保留，里面已经渲染好的 KaTeX、高亮、mermaid 图跟着一起留下。流式输出下只有最后一块
 * 在变，所以每帧真正重画的就那一块。
 */
function syncMd(host, text, streaming) {
  const md = window.satuMd
  if (!md) {
    host.textContent = String(text || '')
    return
  }
  // healStream 看的是整段正文的末尾，所以要先补齐再切块，不能切完逐块补。
  const src = streaming ? md.healStream(text) : String(text == null ? '' : text)
  const parts = src.trim() ? md.splitBlocks(src) : []
  const kids = host.children
  for (let i = 0; i < parts.length; i++) {
    const cur = kids[i]
    if (cur && cur.getAttribute('data-sig') === parts[i]) continue
    const box = document.createElement('div')
    box.className = 'sw-mdblock'
    box.setAttribute('data-sig', parts[i])
    box.innerHTML = md.render(parts[i])
    if (cur) host.replaceChild(box, cur)
    else host.appendChild(box)
  }
  while (kids.length > parts.length) host.removeChild(kids[kids.length - 1])
}

/** 正文 + 工具条就地更新。streaming 指「这条还在写」，只有最后一条会是 true。 */
function updateRow(el, b, streaming) {
  const bubble = el.querySelector('.sw-bubble')
  const md = bubble.querySelector('.sw-md')
  const chips = bubble.querySelector('.sw-chips')

  if (!String(b.text || '').trim() && streaming) {
    // 还没吐字。给一个空气泡里的三点——它就地长成正文，位置不跳。
    if (!md.querySelector('.sw-typing')) md.innerHTML = '<span class="sw-typing"><i></i><i></i><i></i></span>'
  } else {
    if (md.querySelector('.sw-typing')) md.innerHTML = ''
    syncMd(md, b.text, streaming)
  }

  const tools = b.tools || []
  const sig = tools.map((x) => x.name + (x.result == null ? '·' : x.failed ? '!' : '=')).join('|')
  if (chips.getAttribute('data-sig') !== sig) {
    chips.setAttribute('data-sig', sig)
    chips.innerHTML = tools.map(chipHtml).join('')
    chips.hidden = !tools.length
  }
}

/**
 * 要画哪些行。日期分隔是**算出来的**，不是数据里的——相邻两条不在同一天就插一条。
 */
function threadRows(folded) {
  const blocks = folded.blocks || []
  const rows = []
  let lastDay = ''
  blocks.forEach((b, i) => {
    const day = chatDayKey(b.time)
    if (day && day !== lastDay) {
      lastDay = day
      rows.push({ kind: 'day', key: 'd' + day, html: `<div class="sw-daydiv"><span>${esc(chatDayLabel(b.time) + ' ' + chatClock(b.time))}</span></div>` })
    }
    rows.push({ kind: 'msg', key: 'm' + i, block: b })
  })
  // 轮次开着但助手那条还没建出来（工具先跑、或者刚发出去）——补一条空的，
  // 让「正在想」有地方待着，而不是让输入框上面挂一行状态文字。
  const last = blocks[blocks.length - 1]
  if (folded.status && (!last || last.kind === 'user')) {
    rows.push({ kind: 'msg', key: 'm' + blocks.length, block: { kind: 'assistant', text: '', tools: [], time: 0 } })
  }
  return rows
}

function syncThread(thread, folded) {
  const rows = threadRows(folded)
  // 空会话就留空。以前这里摆一句「继续这段对话…」——它只在**刚开一条新对话**时出现
  // 一瞬间，而输入框的 placeholder 已经说了该干什么。多一句灰字只是让空屏更吵。
  if (!rows.length) {
    if (thread.getAttribute('data-empty') !== '1') {
      thread.setAttribute('data-empty', '1')
      thread.innerHTML = ''
    }
    return
  }
  if (thread.getAttribute('data-empty') === '1') {
    thread.removeAttribute('data-empty')
    thread.innerHTML = ''
  }
  const kids = thread.children
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    let cur = kids[i]
    if (!cur || cur.getAttribute('data-key') !== row.key) {
      const box = document.createElement('div')
      box.innerHTML = row.kind === 'day' ? row.html : rowShell(row.block, row.key)
      const node = box.firstElementChild
      if (row.kind === 'day') node.setAttribute('data-key', row.key)
      if (cur) thread.replaceChild(node, cur)
      else thread.appendChild(node)
      cur = node
    }
    if (row.kind === 'msg') updateRow(cur, row.block, folded.status ? i === rows.length - 1 : false)
  }
  while (kids.length > rows.length) thread.removeChild(kids[kids.length - 1])
}

/**
 * 贴底。
 *
 * 以前是每帧无条件 `scrollTop = scrollHeight`：往上翻历史时，回答每吐一个字就把人拽
 * 回底部，根本读不了前面。改成「本来就在底部附近才跟着走」，翻上去了就停住，另外给一
 * 个「回到底部」的按钮把路留回来。
 */
const STICK_SLACK = 80

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK
}

function paintChat() {
  const thread = document.getElementById('chat-thread')
  const folded = fold(state.chatEvents)
  state.chatStatus = folded.status
  if (!thread) return

  const stick = thread.getAttribute('data-touched') !== '1' || nearBottom(thread)
  syncThread(thread, folded)
  if (window.satuMd) satuMd.enhance(thread)
  if (stick) thread.scrollTop = thread.scrollHeight
  paintChatChrome(folded)
}

/** 抬头的在线灯、输入区的提示和中止按钮——都不重绘整页，就地改。 */
function paintChatChrome(folded) {
  const busy = Boolean(folded.status)
  const live = document.getElementById('chat-live')
  if (live) {
    const ready = state.desktopRuntime && state.desktopRuntime.status === 'ready'
    live.setAttribute('data-live', busy ? 'busy' : ready ? '1' : '0')
    live.lastElementChild.textContent = busy ? t('正在处理') : ready ? t('在线') : t('离线')
  }
  const meta = document.getElementById('chat-meta')
  if (meta) meta.textContent = chatMetaText(folded)
  const tip = document.getElementById('chat-tip')
  if (tip) tip.textContent = busy ? t('正在思考…（可以继续输入来打断）') : t('Enter 发送，Shift + Enter 换行')
  const send = document.getElementById('chat-send')
  if (send && send.getAttribute('data-state') !== (busy ? 'stop' : 'send')) {
    // 停止态改成 type=button 并挂上 chat-abort：留着 submit 的话，点它会走发送。
    // 回车不受影响——那条路径仍是提交表单，也就是「边跑边补一句」，本来就该照发。
    send.setAttribute('data-state', busy ? 'stop' : 'send')
    send.type = busy ? 'button' : 'submit'
    send.innerHTML = busy ? ICON_STOP : ICON_SEND
    const label = busy ? t('停止') : t('发送')
    send.setAttribute('aria-label', label)
    send.title = label
    if (busy) send.setAttribute('data-act', 'chat-abort')
    else send.removeAttribute('data-act')
  }
  // 名单上的时间/摘要/转圈由 paintRoster 管——它认每个 Bot 自己那条流，
  // 不再只看当前这一条。
  paintRoster()
  const jump = document.getElementById('chat-jump')
  const thread = document.getElementById('chat-thread')
  if (jump && thread) jump.hidden = nearBottom(thread)
}

function chatMetaText(folded) {
  const blocks = (folded && folded.blocks) || []
  const account = (state.me && state.me.account) || {}
  const who = account.name || account.email || ''
  const first = blocks.find((b) => b.time)
  const parts = []
  if (who) parts.push(t('发起人') + ' ' + who)
  parts.push(blocks.length + ' ' + t('条消息'))
  if (first) parts.push(t('开始于') + ' ' + chatDayLabel(first.time) + ' ' + chatClock(first.time))
  return parts.join(' · ')
}

/** 导出成 Markdown。工具痕迹一起带上——只留回答的话，出问题时对不上做过什么。 */
function chatExportText() {
  const folded = fold(state.chatEvents)
  const bot = chatBotOf()
  const account = (state.me && state.me.account) || {}
  const me = account.name || account.email || t('我')
  const title = (bot && bot.name) || t('对话')
  const out = ['# ' + title, '', '> ' + chatMetaText(folded), '']
  for (const b of folded.blocks || []) {
    out.push('## ' + (b.kind === 'user' ? me : title) + (b.time ? ' · ' + fmtTime(b.time) : ''), '')
    for (const x of b.tools || []) {
      out.push('- ' + t('工具') + ' `' + x.name + '` · ' + (x.result == null ? t('调用中') : x.failed ? t('失败') : t('完成')))
    }
    if ((b.tools || []).length) out.push('')
    out.push(String(b.text || '').trim(), '')
  }
  return out.join('\n')
}

function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function deployBotButton(botId, label) {
  if (!botId) return ''
  const cls = label ? 'btn' : 'btn btn-primary'
  return `<button type="button" class="${cls}" data-act="runtime-deploy" data-bot="${esc(botId)}" ${state.deploying ? 'disabled' : ''}>${state.deploying ? t('部署中…') : label || t('部署这个 Bot')}</button>`
}

/**
 * 对话页右侧的「这个 Bot 的机器」栏。
 *
 * 部署按钮和环境信息原来挤在左边名册的上方，两者都不好用。挪到右栏之后：名册只管
 * 选人，中间只管对话，机器的事集中在一处。
 *
 * **桌面地址做成按钮,不打印 URL。** 那条 URL 里带着一整段 JWT 票（五分钟有效），
 * 渲染成文本会占掉半屏，而且没人会去手抄它——它唯一的用法就是点开。
 */
function chatMachinePanel() {
  const selected = chatBotIdOf(state.path) || state.chatBotId
  if (!selected) return ''
  const mine = state.desktopRuntime
  const bound = !!(state.runtimeMachine && state.runtimeMachine.paired)
  const rows = []

  if (!bound) {
    rows.push(
      `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground); line-height: 1.6;">${t('公司的运行机器还没有配对机器管家，请系统管理员在公司详情里生成配对码。')}</p>`,
    )
  } else if (!mine || mine.status === 'none') {
    rows.push(`<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('实例还没上线')}</p>`)
    rows.push(deployBotButton(selected))
    if (state.deployHint) {
      rows.push(`<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${esc(state.deployHint)}</p>`)
    }
  } else if (mine.status === 'error') {
    rows.push(`<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(mine.lastError || t('部署失败'))}</div>`)
    rows.push(deployBotButton(selected))
  } else if (mine.status === 'deploying') {
    rows.push(`<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('部署中…')}</p>`)
  }

  if (mine && mine.status === 'ready') {
    if (mine.novncUrl) {
      rows.push(
        `<a class="btn btn-primary" href="${esc(mine.novncUrl)}" target="_blank" rel="noopener noreferrer" style="text-align: center;">${t('打开桌面')}</a>`,
      )
    }
    rows.push(
      `<div class="satu-kv"><span>${t('VNC 密码')}</span><span>${esc(state.seatReveal ? mine.vncPassword || '—' : '••••••••')} <button type="button" class="satu-linkbtn" data-act="seat-reveal">${state.seatReveal ? t('隐藏') : t('显示')}</button></span></div>`,
    )
    rows.push(`<div class="satu-kv"><span>${t('共享目录')}</span><span>${esc(mine.sharedDir || '—')}</span></div>`)
    rows.push(`<div class="satu-kv"><span>linuxUser</span><span>${esc(mine.linuxUser || '—')}</span></div>`)
    if (mine.botVersion) {
      rows.push(`<div class="satu-kv"><span>${t('Bot 版本')}</span><span>${esc(mine.botVersion)}</span></div>`)
    }
    // 重新部署留在这儿：换了 Bot 版本、或者席位坏了，这是唯一的自助入口。
    // **要确认**：它会重启席位，正在跑的对话和开着的桌面会断。
    rows.push(
      `<div><button type="button" class="btn btn-secondary" data-act="runtime-redeploy" data-bot="${esc(selected)}" ${state.deploying ? 'disabled' : ''}>${state.deploying ? t('部署中…') : t('重新部署')}</button></div>`,
    )
  }

  return rows.join('')
}

/** 非「未上线」的错误仍然贴在名册上方——那是整页级别的问题，不属于某一个 Bot。 */
function runtimeDownBanner() {
  const err = state.runtimeError
  if (!err || String(err).includes('实例还没上线')) return ''
  return `<div class="gw-flash gw-flash-err">${esc(err)}</div>`
}

/**
 * 会话身份行，**直接长在页面顶栏里**。
 *
 * 它原本是消息流上面单独一条 header，于是顶栏写着「对话」、下面一行写着这条对话是
 * 谁——两条横杠叠在一起，上面那条还是一句永远不变的废话。合成一条之后，顶栏在对话页
 * 上说的就是「你正在跟谁说话、它现在什么状态」，这才是这一页需要一直挂在眼前的东西。
 *
 * 返回的是 .gw-head 的内容片段（身份 + 操作），外壳和内边距由 .gw-head 给。
 */
function chatHeadInline() {
  const bot = chatBotOf()
  const name = (bot && bot.name) || t('未选择')
  const menu =
    state.menu === 'chat'
      ? `<div class="satu-menu" data-flip="${String(Boolean(state.menuFlip))}">
          <button type="button" class="satu-menuitem" data-act="chat-copy-all">${t('复制全文')}</button>
          <button type="button" class="satu-menuitem" data-act="chat-export">${t('导出 Markdown')}</button>
        </div>`
      : ''
  return `<div class="sw-convo-avatar" aria-hidden="true">${ICON_BOT}</div>
    <div class="sw-convo-id">
      <div class="sw-convo-title">
        <span class="sw-convo-name">${esc(name)}</span>
        <span class="sw-convo-live" id="chat-live" data-live="0"><i aria-hidden="true"></i><span>${t('离线')}</span></span>
      </div>
      <p class="sw-convo-meta" id="chat-meta"></p>
    </div>
    <div class="sw-convo-actions">
      <button type="button" class="btn btn-secondary" data-act="chat-export">${t('导出记录')}</button>
      <button type="button" class="btn btn-ghost btn-icon" data-menu-toggle data-act="chat-menu"
        aria-label="${esc(t('更多操作'))}">${svg(['M12 6h.01', 'M12 12h.01', 'M12 18h.01'], 16)}</button>
      ${menu}
    </div>`
}

function chatPage() {
  const bots = state.runtimeBots || []
  const selected = chatBotIdOf(state.path) || state.chatBotId
  const banner = runtimeDownBanner()
  if (!selected) {
    return `<div class="gw-chat"><section class="gw-chat-main">${banner}
      <div class="gw-chat-empty-main"><p>${bots.length ? t('从左边选一个 Bot 开始对话。') : t('还没有 Bot。公司后台配置并上线后会出现在这里。')}</p></div>
    </section></div>`
  }
  /* 正文一律留空：消息、在线灯、提示行全部由 paintChat 增量填。在这里先渲染一遍
     再让 paintChat 覆盖，等于每次换页把同一份内容画两遍，还会把已经渲染好的图冲掉。 */
  return `
    <div class="gw-chat">
      <section class="gw-chat-main">
        ${banner}
        <div class="sw-threadwrap">
          <div class="sw-thread" id="chat-thread"></div>
          <button type="button" class="sw-jump" id="chat-jump" data-act="chat-jump" hidden>${ICON_DOWN}${t('回到底部')}</button>
        </div>
        <div class="sw-composer">
          <form id="chat-form" class="sw-composer-box">
            <div class="sw-files" id="chat-files" hidden></div>
            <textarea id="chat-input" class="satu-prompt satu-grow" rows="1"
              placeholder="${esc(t('输入消息'))}">${esc(state.chatDraft || '')}</textarea>
            <div class="sw-composer-row">
              ${/* 席位的消息接口目前只收 text，没有二进制通道。所以附件走「随消息一起
                    贴成正文」这条路：选中的文本文件在发送时以围栏代码块拼进去，模型看到
                    的就是文件内容本身。二进制在选择那一刻当场挡掉并说明白，不做成一个
                    看起来能传、传完没反应的按钮。 */ ''}
              <button type="button" class="sw-iconbtn" data-act="chat-attach"
                aria-label="${esc(t('添加附件'))}" title="${esc(t('添加附件'))}">${ICON_CLIP}</button>
              <input type="file" id="chat-file" multiple hidden>
              <span class="sw-spacer"></span>
              ${/* 发送和停止是同一个按钮的两副面孔——它们指的是同一件事（这一轮对话的
                    开与关），而且永远只有一个有意义。摆两个按钮的话，其中一个总是灰的，
                    还得让人先分辨哪个能点。切换由 paintChatChrome 就地改，不重绘整页。 */ ''}
              <button type="submit" class="sw-send" id="chat-send" data-state="send"
                aria-label="${esc(t('发送'))}" title="${esc(t('发送'))}">${ICON_SEND}</button>
            </div>
          </form>
          <div class="sw-composer-tip">
            <span id="chat-tip"></span>
          </div>
        </div>
      </section>
    </div>`
}

/** 单个附件的上限。贴进正文的东西要跟消息一起进模型上下文，不能没有边。 */
const CHAT_FILE_MAX = 256 * 1024

function paintChatFiles() {
  const box = document.getElementById('chat-files')
  if (!box) return
  const files = state.chatFiles || []
  box.hidden = !files.length
  box.innerHTML = files
    .map(
      (f, i) =>
        `<span class="sw-file"><span>${esc(f.name)}</span>` +
        `<button type="button" class="sw-file-x" data-act="chat-file-drop" data-i="${i}" ` +
        `aria-label="${esc(t('移除'))} ${esc(f.name)}">${ICON_X}</button></span>`,
    )
    .join('')
}

/**
 * 读入选中的附件。
 *
 * 二进制在这里就挡掉：接口只能带文本，一个 PNG 贴成乱码进上下文，对谁都没有用。
 * 判据是内容里有没有 NUL——比看后缀名准，也不用维护一张白名单。
 */
async function takeChatFiles(input) {
  const picked = Array.from(input.files || [])
  input.value = ''
  const bad = []
  for (const file of picked) {
    if (file.size > CHAT_FILE_MAX) {
      bad.push(file.name + t('（超过 256 KB）'))
      continue
    }
    let text
    try {
      text = await file.text()
    } catch {
      bad.push(file.name)
      continue
    }
    if (text.includes('\u0000')) {
      bad.push(file.name + t('（不是文本文件）'))
      continue
    }
    state.chatFiles = [...(state.chatFiles || []), { name: file.name, text }]
  }
  if (bad.length) flash('err', t('这些文件没能附上：') + bad.join('、') + t('。附件会随消息贴成正文，所以只能是 256 KB 以内的文本。'))
  paintChatFiles()
  if (bad.length) render()
}

async function sendChat() {
  const text = (state.chatDraft || '').trim()
  const files = state.chatFiles || []
  if ((!text && !files.length) || !state.chatSessionId) return
  // 附件排在正文**前面**：先给材料再给指令，模型读到「照这个文件改」时文件已经在眼前。
  const body = files.map((f) => '`' + f.name + '`：\n\n```\n' + f.text + '\n```').concat(text ? [text] : []).join('\n\n')
  state.chatDraft = ''
  state.chatFiles = []
  paintChatFiles()
  const input = document.getElementById('chat-input')
  if (input) {
    input.value = ''
    input.style.height = ''
  }
  try {
    await api('POST', '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/messages', { text: body })
  } catch (err) {
    // 发失败要把草稿和附件都还回去，不然人得重新选一遍文件。
    state.chatDraft = text
    state.chatFiles = files
    paintChatFiles()
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

async function updateOrgRuntime() {
  const org = state.org && state.org.id
  if (!org || state.updatingRuntime) return
  const version = state.latestRelease
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
    if (!results.length) flash('ok', t('没有需要更新的席位', 'No seats needed updating'))
    else flash(bad && !ok ? 'err' : 'ok', t(`更新 ${data.version}：成功 ${ok}，失败 ${bad}`, `Updated ${data.version}: ${ok} ok, ${bad} failed`))
    await loadCompanyDetail(org)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.updatingRuntime = false
    render()
  }
}

async function deployMyRuntime(botId, opts = {}) {
  const id = botId || chatBotIdOf(state.path) || state.chatBotId
  if (state.deploying || isOwner() || !id) return
  state.deploying = true
  state.deployHint = opts.update ? '正在重新部署…' : '正在部署…'
  render()
  try {
    // `update` 不能省：席位已经是 ready 且版本没变时，服务端会直接把现状还回来，
    // 什么都不做——那样「重新部署」这个按钮就成了摆设。
    // force：见 gateway/src/deploy.ts 里那道「已经 ready 就跳过」的门。不带它的话，
    // 「重新部署」在最需要它的时候（版本对、状态 ready、但机器上不对）什么都不会做。
    const body = { botId: id }
    if (opts.update) body.update = true
    if (opts.force) body.force = true
    await api('POST', '/runtime/deploy', body)
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
    case '/orders':
      return ordersPage()
    case '/plans':
      return plansPage()
    case '/stats':
      return statsPage()
    case '/billing':
    case '/costs':
      return billingPage()
    case '/usage':
      return usagePage()
    case '/catalog':
      return placeholderPage(t('公司目录'), t('公司 Bot / Skill / MCP'))
    case '/profile':
      return profilePage()
    default:
      return overviewPage()
  }
}

/**
 * 当前页面的右侧栏。目前只有对话页有。
 *
 * 折叠时不是 `display:none`，而是留一条 34px 的竖条 —— 收起来之后还得有地方点回去，
 * 而且列宽从 280 变 34 有过渡，不会突然跳一下。
 */
function pageAside() {
  if (!hasAside()) return ''
  // 折叠 = 整个不渲染。开关挪到了对话 header 上，这里不用再留一条竖条给人点回去。
  if (!asidePref.open) return ''
  return `<aside class="gw-aside">
    <div class="gw-aside-grip" data-act="aside-grip" title="${esc(t('拖动调整宽度'))}"></div>
    <div class="gw-aside-body">
      <h3>${t('运行环境')}</h3>
      ${chatMachinePanel()}
    </div>
  </aside>`
}

/** 右栏开关。放在对话 header 上，所以折叠之后仍然点得到——右栏本身是整个不渲染的。 */
function asideToggle() {
  if (!hasAside()) return ''
  const open = asidePref.open
  return `<button type="button" class="btn btn-ghost btn-icon" style="margin-left: auto; flex: none;"
    data-act="aside-toggle" aria-pressed="${open}"
    aria-label="${esc(open ? t('收起运行环境') : t('展开运行环境'))}"
    title="${esc(t('运行环境'))}">${svg(open ? CHEVRON_RIGHT : CHEVRON_LEFT, 16)}</button>`
}

/** 在不在对话页。顶栏换不换成会话身份行、右栏开不开，都看它，免得两处判断漂移。 */
function onChatPage() {
  if (!state.me) return false
  const onChat = state.path === '/chat' || state.path.startsWith('/a/') || (memberChatHome() && state.path === '/')
  return onChat && Boolean(chatBotIdOf(state.path) || state.chatBotId)
}

/** 这一页有没有右栏可开。 */
function hasAside() {
  return onChatPage()
}

function appView() {
  const rail = state.rail
  const crumbs = crumbsOf(state.path)
  // 对话页不要面包屑也不要「对话」两个字——顶栏整条让给会话身份行。
  const head = onChatPage()
    ? chatHeadInline()
    : crumbs
    ? `<button type="button" class="btn btn-ghost btn-icon" style="flex: none;" data-act="go" data-href="${esc(crumbs.href)}" aria-label="${esc(t('返回'))}" title="${esc(crumbs.parent)}">${svg(BACK_ARROW, 17)}</button>
        <nav class="satu-crumbs" aria-label="${esc(t('面包屑', 'Breadcrumb'))}">
          <button type="button" class="satu-crumblink" data-act="go" data-href="${esc(crumbs.href)}">${esc(crumbs.parent)}</button>
          <span class="satu-crumbsep" aria-hidden="true">/</span>
          <span class="satu-crumbcur" aria-current="page">${esc(crumbs.current)}</span>
        </nav>`
    : `<span style="font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(pageTitle(state.path))}</span>`
  const account = state.me?.account || {}
  const email = account.email || ''
  const displayName = account.name || email || '…'
  const initial = initialOf(account)
  const nav = navForRole()
  const home = nav[0]
  const rest = nav.slice(1)
  const roster = chatRosterNav()
  const groupLabel = isOwner() ? t('平台') : isAdmin() ? t('公司') : ''
  const mainNav = home ? navItem(home) : ''
  const restNav = rest.map(navItem).join('')
  // 右栏和 header 同高：把 main 做成两行两列的 grid，侧栏跨两行占右列。做成 header
  // 下面的兄弟节点就顶不上去了。
  const aside = pageAside()
  const asideCols = aside
    ? `grid-template-columns: minmax(0, 1fr) ${asidePref.width}px;`
    : 'grid-template-columns: minmax(0, 1fr);'
  return `
  <div style="height: 100vh; overflow: hidden; display: grid; grid-template-columns: ${rail ? '62px' : '248px'} 1fr; gap: var(--space-4); padding: var(--space-4); background: var(--color-bg); font-family: var(--font-body); color: var(--color-text); box-sizing: border-box;">
    <aside class="${rail ? 'satu-rail' : ''}" style="height: 100%; min-height: 0; overflow: hidden; box-sizing: border-box; display: flex; flex-direction: column; background: var(--color-surface); border-radius: var(--radius-md); padding: var(--space-4) var(--space-2) var(--space-2);">
      <button type="button" class="satu-brand" data-act="go" data-href="/" style="display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3) var(--space-4); border: 0; background: transparent; cursor: pointer; color: inherit;">
        <img src="/assets/satuwork-logo.png" alt="Satuwork" style="width: 32px; height: 32px; min-width: 32px; flex: none; object-fit: contain; border-radius: var(--radius-sm);">
        <span class="satu-brandtext" style="font-family: var(--font-heading); font-size: 19px;">Satuwork</span>
      </button>
      ${/* 名单吃掉剩下的全部高度并自己滚；下面那组导航沉到底，不跟着一起滚走。
            Bot 是这一屏的主体，页面入口是配角，位置上就该这么分。

            **但没有名单时不能留那个占位。** 平台管理员这一侧永远没有 Bot（他没有席位，
            /runtime/bots 对他 403），于是占位每次都撑满，把整组菜单压到屏幕底部，上面
            空一大片——沉底的理由是「给名单让位」，名单不在，理由也就不在了。 */ ''}
      <div style="flex: 1; min-height: 0; display: flex; flex-direction: column;">
        ${roster ? `<div class="satu-botlist">${roster}</div>` : ''}
        ${
          mainNav || restNav
            ? `<div class="satu-navfoot">
          <div class="satu-sep"></div>
          ${groupLabel ? `<p class="satu-group">${esc(groupLabel)}</p>` : ''}
          ${mainNav}${restNav}
        </div>`
            : ''
        }
      </div>
      ${/* box-sizing 必须写死：侧栏是 border-box，这一行不写就按 content-box 算，
            宽度比容器多出左右内边距，齿轮会顶出侧栏外沿。 */ ''}
      <div class="satu-userrow" style="display: flex; align-items: center; gap: var(--space-2); box-sizing: border-box; width: 100%; padding: var(--space-3); margin-top: var(--space-2); border-top: 1px solid var(--color-divider);">
        <div style="width: 30px; height: 30px; flex: none; border-radius: 999px; background: var(--color-accent-200); display: flex; align-items: center; justify-content: center; font-family: var(--font-heading); font-size: 13px; color: var(--color-accent-800);">${esc(initial)}</div>
        <div class="satu-userinfo" style="line-height: 1.25; min-width: 0; flex: 1;">
          <div style="font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(displayName)}</div>
          <div style="font-size: 11px; color: color-mix(in srgb, var(--color-text) 50%, transparent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(email)}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-icon satu-usercog" style="flex: none;" data-act="go" data-href="/profile" aria-label="${esc(t('个人设置'))}" aria-pressed="${String(state.path === '/profile')}">${svg(GEAR, 16)}</button>
      </div>
    </aside>
    <main id="gw-main" class="gw-main${aside ? ' gw-main-aside' : ''}" style="${asideCols}">
      <div class="gw-head">
        <button type="button" class="btn btn-ghost btn-icon" data-act="rail" aria-label="${rail ? t('展开侧栏') : t('收起侧栏')}">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
        </button>
        <div style="width: 1px; height: 18px; background: var(--color-divider);"></div>
        ${head}
        ${asideToggle()}
      </div>
      <div class="gw-body">${pageView()}</div>
      ${aside}
    </main>
    ${confirmModal()}
  </div>`
}

/** 上一帧画的是哪个页面。换页要回到顶部，原地重绘不能动——见 render()。 */
let paintedPath = null

/**
 * 重绘。整页是 innerHTML 整块换掉的，滚动位置跟着一起没——在同一个页面上按一个
 * 开关（记忆范围、勾选项这些都会重绘一次）视线就被扔回页首，页面越长越难受。
 * 所以换之前记下内容区滚到哪儿，换完贴回去；只有真的换了页面才落回顶部。
 */
function render() {
  const root = document.getElementById('app')
  // 对话页没有 .gw-page（自己那套滚动容器由 paintChat 管），这里就是 null，跳过。
  const before = document.querySelector('.gw-page')
  const keep = before && paintedPath === state.path ? before.scrollTop : 0
  paintedPath = state.path
  if (state.path.startsWith('/join/')) {
    root.innerHTML = joinView()
    return
  }
  if (!state.me && state.needsSetup) {
    root.innerHTML = setupView()
    return
  }
  root.innerHTML = state.me ? appView() : loginView()
  // 对话页的正文不在 appView 里——chatPage 只搭空壳，消息由 paintChat 增量填。
  // 整页重绘会把那个壳换掉，所以每次 render 之后要补一次。
  if (document.getElementById('chat-thread')) paintChat()
  if (!keep) return
  const after = document.querySelector('.gw-page')
  if (after) after.scrollTop = keep
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

async function onSetup(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const email = String(fd.get('email') || '').trim()
  const name = String(fd.get('name') || '').trim()
  const password = String(fd.get('password') || '')
  const confirm = String(fd.get('confirm') || '')
  state.setupEmail = email
  state.setupName = name
  if (password !== confirm) {
    state.setupError = '两次输入的口令不一致'
    render()
    return
  }
  state.busy = true
  state.setupError = ''
  render()
  try {
    const data = await api('POST', '/auth/setup', { email, name, password })
    if (!data.token) throw new Error('创建响应没有 token')
    setToken(data.token)
    state.needsSetup = false
    await loadMe()
    state.path = '/'
    history.replaceState({}, '', '/')
    await loadPage()
  } catch (err) {
    // 别人抢先建好了就退回登录页，而不是让人对着一个永远失败的表单再点一次。
    if (String(err.message).includes('已经有系统管理员')) {
      state.needsSetup = false
      state.loginError = '系统管理员已创建，请登录'
    } else {
      state.setupError = err.message || '创建失败'
    }
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
    priceMultiplier: priceMultiplier(),
    ...patch,
  }
  if (patch.daily) next.daily = patch.daily
  if (patch.utility) next.utility = patch.utility
  // 换了模型，上一次的连通性结论就不作数了——留着那个绿字比没有还糟。
  for (const role of ['daily', 'utility']) {
    if (!patch[role]) continue
    const cur = state.settings?.[role] || {}
    if (cur.provider !== next[role].provider || cur.model !== next[role].model) delete state.tests[`role:${role}`]
  }
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

/**
 * 存倍率。服务端也校验区间——这里先挡一道，是为了让输入框里那个手滑的值
 * 当场退回上一个有效值，而不是先画出来再被一条错误提示纠正。
 */
async function savePriceMultiplier(raw) {
  const prev = priceMultiplier()
  const n = Number(String(raw).trim())
  if (!Number.isFinite(n) || n < 0.01 || n > 100) {
    flash('err', '倍率只能是 0.01 到 100 之间的数字')
    render()
    return
  }
  if (n === prev) return
  state.savingMultiplier = true
  state.settings = { ...state.settings, priceMultiplier: n }
  render()
  try {
    const saved = await api('PUT', '/platform/settings', { ...state.settings, priceMultiplier: n })
    state.settings = saved
    if (state.me) state.me.settings = saved
    flash('ok', '已保存单价倍率')
  } catch (err) {
    state.settings = { ...state.settings, priceMultiplier: prev }
    flash('err', err.message)
  } finally {
    state.savingMultiplier = false
    render()
  }
}

async function testLlm(kind, payload) {
  const key = kind === 'role' ? `role:${payload.role}` : `provider:${payload.provider}`
  state.tests[key] = { status: 'busy', text: '测试中…' }
  render()
  try {
    const path = isOwner() ? '/platform/llm/test' : `/orgs/${encodeURIComponent(orgId())}/llm/test`
    const data = await api('POST', path, payload)
    if (data.ok) {
      const text = t(`通了 ${data.latencyMs}ms · ${data.provider}/${data.model}`, `OK ${data.latencyMs}ms · ${data.provider}/${data.model}`)
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

/** 建或改自定义供应商。改的时候要把已有的 models 原样带上，否则一保存模型就没了。 */
async function saveCustomProvider() {
  const d = state.providerDraft
  if (!d) return
  state.busy = true
  d.error = ''
  render()
  try {
    const body = { name: d.name.trim() || d.id.trim(), baseUrl: d.baseUrl.trim(), api: d.api }
    if (d.editing) {
      body.models = customProvider(d.id)?.models || []
      await api('PUT', `/platform/providers/${encodeURIComponent(d.id)}`, body)
    } else {
      await api('POST', '/platform/providers', { ...body, id: d.id.trim(), models: [] })
    }
    await Promise.all([loadCustomProviders(), loadCatalog()])
    state.providerDraft = null
    flash('ok', d.editing ? '已保存' : '已添加自定义供应商')
  } catch (err) {
    d.error = err.message
  } finally {
    state.busy = false
    render()
  }
}

/** 模型清单是整份提交的：读出当前那份，改完再整份写回去。 */
async function putModels(providerId, models) {
  const p = customProvider(providerId)
  if (!p) throw new Error('自定义供应商不存在')
  await api('PUT', `/platform/providers/${encodeURIComponent(providerId)}`, {
    name: p.name,
    baseUrl: p.baseUrl,
    api: p.api,
    ...(p.headers ? { headers: p.headers } : {}),
    models,
  })
  await Promise.all([loadCustomProviders(), loadCatalog()])
}

async function saveCustomModel() {
  const d = state.modelDraft
  const p = customProvider(state.modelsFor)
  if (!d || !p) return
  state.busy = true
  state.providerError = ''
  render()
  try {
    const next = [...(p.models || []), {
      id: String(d.id).trim(),
      name: String(d.name).trim() || String(d.id).trim(),
      contextWindow: Number(d.contextWindow),
      maxTokens: Number(d.maxTokens),
      reasoning: !!d.reasoning,
      input: d.image ? ['text', 'image'] : ['text'],
      cost: { input: Number(d.costInput) || 0, output: Number(d.costOutput) || 0, cacheRead: 0, cacheWrite: 0 },
    }]
    await putModels(state.modelsFor, next)
    state.modelDraft = null
    flash('ok', '已添加模型')
  } catch (err) {
    state.providerError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function deleteCustomModel(modelId) {
  const p = customProvider(state.modelsFor)
  if (!p) return
  state.busy = true
  state.providerError = ''
  render()
  try {
    await putModels(state.modelsFor, (p.models || []).filter((m) => m.id !== modelId))
    flash('ok', '已删除模型')
  } catch (err) {
    state.providerError = err.message
  } finally {
    state.busy = false
    render()
  }
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
    // 换了密钥，之前那次测试测的是旧密钥。
    delete state.tests[`provider:${provider}`]
    for (const role of ['daily', 'utility']) {
      if (state.settings?.[role]?.provider === provider) delete state.tests[`role:${role}`]
    }
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
    await api('PATCH', `/orgs/${encodeURIComponent(id)}`, {
      name,
      slug,
      accessUrl: accessUrl || null,
      contactName: String(fd.get('contactName') || '').trim(),
      contactPhone: phoneValue(fd),
      contactEmail: String(fd.get('contactEmail') || '').trim(),
      address: String(fd.get('address') || '').trim(),
      website: String(fd.get('website') || '').trim(),
    })
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
  const adminPassword = String(fd.get('adminPassword') || '')
  if (adminPassword !== String(fd.get('adminPassword2') || '')) {
    state.orgCreateError = t('两次输入的口令不一致')
    render()
    return
  }
  state.orgCreateError = ''
  const body = {
    name: String(fd.get('name') || '').trim(),
    slug: String(fd.get('slug') || '').trim(),
    contactName: String(fd.get('contactName') || '').trim(),
    contactPhone: phoneValue(fd),
    contactEmail: String(fd.get('contactEmail') || '').trim(),
    address: String(fd.get('address') || '').trim(),
    website: String(fd.get('website') || '').trim(),
    adminEmail: String(fd.get('adminEmail') || '').trim(),
    adminPassword,
  }
  state.busy = true
  render()
  try {
    await api('POST', '/platform/orgs', body)
    state.orgCreateOpen = false
    await loadOrgs()
    flash('ok', '已创建公司')
  } catch (err) {
    // 弹窗不关，报错留在填错的那张表单上。
    state.orgCreateError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function saveMachine(e) {
  e.preventDefault()
  const form = e.target
  const id = form.getAttribute('data-id')
  const host = String(new FormData(form).get('host') || '').trim()
  const machineId = form.getAttribute('data-machine') || ''
  state.busy = true
  render()
  try {
    const data = await api('PUT', `/platform/orgs/${encodeURIComponent(id)}/machine`, { host, machineId })
    await loadCompanyDetail(id)
    // 存下来还不够——地址写错了要当场知道，不能等到第一次部署。
    flash(data.reachable ? 'ok' : 'err', data.reachable ? '已保存，管家可达' : `已保存，但打不到管家：${data.error || '无响应'}`)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

/**
 * 提交「新增版本」。慢是正常的——Gateway 要把包整个拉下来核对，26 MiB 的包在内网
 * 也要几秒，所以按钮上写「验证中…」而不是「保存中…」。
 */
async function addRelease(e) {
  e.preventDefault()
  const form = e.target
  const kind = form.getAttribute('data-kind') === 'manager' ? 'manager' : 'bot'
  const fd = new FormData(form)
  const body = {
    version: String(fd.get('version') || '').trim(),
    size: String(fd.get('size') || '').trim(),
    sha256: String(fd.get('sha256') || '').trim().toLowerCase(),
    url: String(fd.get('url') || '').trim(),
  }
  state.busy = true
  state.addRelease = kind
  render()
  try {
    const path = kind === 'manager' ? '/platform/manager-releases' : '/platform/bot-releases'
    const data = await api('POST', path, body)
    await loadReleases()
    state.addRelease = ''
    flash('ok', `已登记 ${data.release.version}`)
    form.reset()
  } catch (err) {
    // 验证失败时表单保持展开：填错的往往只有一项，重填比重来强。
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function saveManagerVersion(e) {
  e.preventDefault()
  const managerVersion = String(new FormData(e.target).get('managerVersion') || '').trim()
  state.busy = true
  render()
  try {
    await api('PUT', '/platform/settings', { managerVersion })
    await loadReleases()
    flash('ok', managerVersion ? `期望版本已设为 ${managerVersion}` : '期望版本已清空，跟最新发布走')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

/**
 * 给这台机器钉一个新的管家版本。
 *
 * 只是下指令——换版、自检、失败回滚都在机器上做，所以提示语说的是「等机器换版」。
 */
async function removeMachine(id, machineId) {
  if (!id || !machineId) return
  state.busy = true
  render()
  try {
    await api('DELETE', `/platform/orgs/${encodeURIComponent(id)}/machines/${encodeURIComponent(machineId)}`)
    await loadCompanyDetail(id)
    flash('ok', '已移除这台机器的登记（机器本身没动）')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function saveCapacity(e) {
  e.preventDefault()
  const form = e.target
  const id = form.getAttribute('data-id')
  const machineId = form.getAttribute('data-machine')
  const maxAccounts = Number(new FormData(form).get('maxAccounts'))
  state.busy = true
  render()
  try {
    await api('PUT', `/platform/orgs/${encodeURIComponent(id)}/machines/${encodeURIComponent(machineId)}/capacity`, {
      maxAccounts,
    })
    await loadCompanyDetail(id)
    flash('ok', `容量改为 ${maxAccounts} 个账号`)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function saveTimezone(e) {
  e.preventDefault()
  const form = e.target
  const id = form.getAttribute('data-id')
  const machineId = form.getAttribute('data-machine')
  const timezone = String(new FormData(form).get('timezone') || '').trim()
  state.busy = true
  render()
  try {
    const data = await api(
      'PUT',
      `/platform/orgs/${encodeURIComponent(id)}/machines/${encodeURIComponent(machineId)}/timezone`,
      { timezone },
    )
    await loadCompanyDetail(id)
    // 「已下指令」而不是「已改好」：真正改的是机器，下一轮心跳才知道成没成。
    flash('ok', !timezone ? '不再管这台机器的时区' : data.pending ? `已下指令：${timezone}，等机器改` : `时区改为 ${timezone}`)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function upgradeManager(id, machineId) {
  if (!id || !machineId) return
  state.busy = true
  render()
  try {
    const data = await api('POST', `/platform/orgs/${encodeURIComponent(id)}/machines/${encodeURIComponent(machineId)}/upgrade`, {})
    await loadCompanyDetail(id)
    flash('ok', data.pending ? `已下指令升到 ${data.version}，等机器下一轮心跳换版` : `已经是 ${data.version}`)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function makePairingCode(id) {
  state.busy = true
  render()
  try {
    state.pairingCode = await api('POST', `/platform/orgs/${encodeURIComponent(id)}/pairing-code`)
    flash('ok', '配对码已生成，30 分钟内有效')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}


async function saveOrder(e) {
  e.preventDefault()
  const form = e.target
  const id = form.getAttribute('data-id')
  const fd = new FormData(form)
  // 改单时类型下拉是 disabled，表单里没有它——以这张单子自己的类型为准，
  // 别回落到 'plan'，否则改一张充值单会当成套餐单发出去。
  const cur = id ? (state.orders || []).find((o) => o.id === id) : null
  const kind = (cur?.kind || String(fd.get('kind') || state.orderEdit?.kind || 'plan')) === 'topup' ? 'topup' : 'plan'
  const body = kind === 'topup'
    ? {
        // 改单不带 kind：类型本来就不让改，服务端按原单子的类型处理。
        ...(id ? {} : { kind }),
        companyId: String(fd.get('companyId') || ''),
        amount: Number(fd.get('amount')),
        note: String(fd.get('note') || '').trim(),
        startAt: String(fd.get('startAt') || ''),
        payStatus: String(fd.get('payStatus') || 'unpaid'),
      }
    : {
        ...(id ? {} : { kind }),
        companyId: String(fd.get('companyId') || ''),
        planId: String(fd.get('planId') || ''),
        period: String(fd.get('period') || 'month'),
        seats: Number(fd.get('seats')),
        amount: Number(fd.get('amount')),
        bonusTokens: Number(fd.get('bonusTokens') || 0),
        startAt: String(fd.get('startAt') || ''),
        payStatus: String(fd.get('payStatus') || 'unpaid'),
      }
  state.busy = true
  state.orderError = ''
  render()
  try {
    if (id) await api('PUT', `/platform/orders/${encodeURIComponent(id)}`, body)
    else await api('POST', '/platform/orders', body)
    state.orderEdit = null
    // 下单会改公司的订阅，公司列表跟着刷一遍，省得回去看到的还是旧套餐。
    await Promise.all([loadOrders(), loadOrgs().catch(() => {})])
    flash('ok', id ? t('已保存订单') : t('已创建订单'))
  } catch (err) {
    // 报错留在弹窗里，连同刚填的值——draft 的字段名要跟弹窗读的对上。
    state.orderError = err.message
    state.orderEdit = {
      id,
      kind,
      draft: {
        kind, companyId: body.companyId, planId: body.planId, period: body.period,
        seats: body.seats, amount: body.amount, bonus: body.bonusTokens, startAt: body.startAt,
        payStatus: body.payStatus, note: body.note || '',
      },
    }
  } finally {
    state.busy = false
    render()
  }
}

/** 公司详情页那张资料表单。跟公司自己那张（saveCompany）走同一条 PATCH，多一个状态。 */
async function saveOrgProfile(e) {
  e.preventDefault()
  const form = e.target
  const id = form.getAttribute('data-id')
  const fd = new FormData(form)
  const accessUrl = String(fd.get('accessUrl') || '').trim()
  state.busy = true
  render()
  try {
    // 状态不在这张表单里：它单独一条 PATCH，改完立刻生效。
    await api('PATCH', `/orgs/${encodeURIComponent(id)}`, {
      name: String(fd.get('name') || '').trim(),
      slug: String(fd.get('slug') || '').trim(),
      contactName: String(fd.get('contactName') || '').trim(),
      contactPhone: phoneValue(fd),
      contactEmail: String(fd.get('contactEmail') || '').trim(),
      address: String(fd.get('address') || '').trim(),
      website: String(fd.get('website') || '').trim(),
      accessUrl: accessUrl || null,
    })
    await loadOrgs()
    await loadCompanyDetail(id)
    flash('ok', '已保存')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function savePlanSku(e) {
  e.preventDefault()
  const form = e.target
  const id = form.getAttribute('data-id')
  const fd = new FormData(form)
  const body = {
    name: String(fd.get('name') || '').trim(),
    nameEn: String(fd.get('nameEn') || '').trim(),
    amount: Number(fd.get('amount')),
    seats: Number(fd.get('seats')),
    period: String(fd.get('period') || 'month'),
    bonusTokens: Number(fd.get('bonusTokens') || 0),
  }
  state.busy = true
  state.planSkuError = ''
  render()
  try {
    if (id) await api('PUT', `/platform/plans/${encodeURIComponent(id)}`, body)
    else await api('POST', '/platform/plans', body)
    state.planSkuEdit = null
    await loadPlanSkus()
    flash('ok', id ? t('已保存套餐') : t('已创建套餐'))
  } catch (err) {
    // 报错留在弹窗里，连同刚填的值——关掉弹窗再去页面顶上找提示是白丢一次输入。
    state.planSkuError = err.message
    // draft 要按弹窗读的字段名存：body 里叫 bonusTokens（接口的名字），
    // 弹窗读的是 bonus——直接塞 body 会让赠送额度那一栏在报错后变空。
    state.planSkuEdit = {
      id,
      draft: { name: body.name, nameEn: body.nameEn, amount: body.amount, seats: body.seats, period: body.period, bonus: body.bonusTokens },
    }
  } finally {
    state.busy = false
    render()
  }
}

// 席位不在界面上改：它跟套餐、到期时间一样由订单决定，下单时一起写进去。

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
  state.orgCreateError = ''
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
        title: m.status === 'invited' ? t('新的邀请链接') : t('口令重设链接'),
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
  const base = catalogBase()
  if (!base || !f) return
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
    if (item) await api('PATCH', `${base}/skills/${encodeURIComponent(item.id)}`, payload)
    else await api('POST', `${base}/skills`, payload)
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
  const base = catalogBase()
  if (!base || !f) return
  const nameEl = document.getElementById('tl-name')
  if (nameEl) f.name = nameEl.value
  const payload = { name: f.name, kind: f.kind, endpoint: f.endpoint, env: f.env, perm: f.perm, enabled: f.enabled }
  if (f.token) payload.token = f.token
  state.busy = true
  state.skillError = ''
  render()
  try {
    const item = state.skillDialog && state.skillDialog.item
    if (item) await api('PATCH', `${base}/mcp-servers/${encodeURIComponent(item.id)}`, payload)
    else await api('POST', `${base}/mcp-servers`, payload)
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
  const base = catalogBase()
  try {
    const data = await api('POST', `${base}/skills/tags`, { name: tag })
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
    if (c.kind === 'org-status') {
      await api('PATCH', `/orgs/${encodeURIComponent(c.id)}`, { status: c.next })
      await Promise.all([loadOrgs().catch(() => {}), loadCompanyDetail(c.id)])
      flash('ok', c.next === 'disabled' ? '已停用公司' : '已启用公司')
      render()
      return
    } else if (c.kind === 'redeploy-bot') {
      render()
      // force 而不是 update：这个按钮的意思是「把席位重铺一遍」，不是「升到新版本」。
      // 两者眼下都能穿过 deploy.ts 里那道「已经 ready 就跳过」的门，但借 update 的名义
      // 是在赌它将来不会变成「只在有新版本时才做」——真那样，重新部署会静悄悄失效，
      // 而它恰恰是机器上出了问题时唯一的自助手段。
      await deployMyRuntime(c.id, { force: true })
      return
    } else if (c.kind === 'delete-bot') {
      const base = catalogBase()
      await api('DELETE', `${base}/bots/${encodeURIComponent(c.id)}`)
      flash('ok', '已删除')
      go('/bots')
      return
    } else if (c.kind === 'delete-skill') {
      const base = catalogBase()
      await api('DELETE', `${base}/skills/${encodeURIComponent(c.id)}`)
      closeSkillDialog()
      await loadSkills()
      render()
      return
    } else if (c.kind === 'delete-mcp') {
      const base = catalogBase()
      await api('DELETE', `${base}/mcp-servers/${encodeURIComponent(c.id)}`)
      closeSkillDialog()
      await loadSkills()
      render()
      return
    } else if (c.kind === 'delete-skill-tag') {
      const base = catalogBase()
      const data = await api('DELETE', `${base}/skills/tags/${encodeURIComponent(c.tag)}`)
      state.skillTags = data.tags || []
      if (state.skillForm) state.skillForm.tags = (state.skillForm.tags || []).filter((x) => x !== c.tag)
      render()
      return
    } else if (c.kind === 'delete-credential') {
      await api('DELETE', `/platform/credentials/${encodeURIComponent(c.id)}`)
      delete state.tests[`provider:${c.id}`]
      await Promise.all([loadCreds(), loadCatalog()])
      flash('ok', '已移除密钥')
      render()
      return
    } else if (c.kind === 'delete-custom-provider') {
      try {
        await api('DELETE', `/platform/providers/${encodeURIComponent(c.id)}`)
      } catch (err) {
        // 409 = 有模型角色正在用它。上面那句确认已经把后果说清楚了，直接带 force 再来一次。
        if (err.status !== 409) throw err
        await api('DELETE', `/platform/providers/${encodeURIComponent(c.id)}?force=1`)
      }
      delete state.tests[`provider:${c.id}`]
      state.modelsFor = ''
      await Promise.all([loadCustomProviders(), loadCreds(), loadCatalog(), loadSettings()])
      flash('ok', '已删除自定义供应商')
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
  if (form.id === 'setup-form') return onSetup(e)
  if (form.id === 'pw-form') return submitPassword(e)
  if (form.id === 'invite-form') return submitInvite(e)
  if (form.id === 'group-form') return submitGroup(e)
  if (form.id === 'edit-member-form') return submitEdit(e)
  if (form.id === 'join-form') return submitJoin(e)
  if (form.id === 'skill-form') return submitSkill(e)
  if (form.id === 'server-form') return submitServer(e)
  if (form.id === 'company-form') return saveCompany(e)
  if (form.id === 'create-org-form') return createOrg(e)
  if (form.id === 'plan-sku-form') return savePlanSku(e)
  if (form.id === 'order-form') return saveOrder(e)
  if (form.id === 'audit-filter-form') return submitAuditFilter(e)
  if (form.id === 'chat-form') {
    e.preventDefault()
    return sendChat()
  }
  if (form.getAttribute('data-form') === 'org-profile') return saveOrgProfile(e)
  if (form.getAttribute('data-form') === 'machine') return saveMachine(e)
  if (form.getAttribute('data-form') === 'manager-version') return saveManagerVersion(e)
  if (form.getAttribute('data-form') === 'add-release') return addRelease(e)
  if (form.getAttribute('data-form') === 'machine-capacity') return saveCapacity(e)
  if (form.getAttribute('data-form') === 'machine-timezone') return saveTimezone(e)
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
  // 别叫 t——这个处理器里好几处确认文案要用上面那个文案函数。
  const el = e.target instanceof Element ? e.target : e.target.parentElement
  if (state.menu && el && !el.closest('.satu-menu, [data-menu-toggle]')) {
    state.menu = null
    render()
  }
  const btn = el && el.closest('[data-act]')
  if (!btn) return
  if (btn.classList.contains('gw-modal-backdrop') && e.target !== btn) return
  const act = btn.getAttribute('data-act')
  if (act === 'go') {
    go(btn.getAttribute('data-href'))
    return
  }
  if (act === 'sessions-more') {
    if (state.sessionsLoadingMore || !state.sessionsHasMore) return
    state.sessionsLoadingMore = true
    render()
    loadSessions(true)
      .catch((err) => flash('err', err.message))
      .finally(() => {
        state.sessionsLoadingMore = false
        render()
      })
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
  if (act === 'chat-attach') {
    const picker = document.getElementById('chat-file')
    if (picker) picker.click()
    return
  }
  if (act === 'chat-file-drop') {
    const i = Number(btn.getAttribute('data-i'))
    state.chatFiles = (state.chatFiles || []).filter((_, n) => n !== i)
    paintChatFiles()
    return
  }
  if (act === 'chat-menu') {
    const rect = btn.getBoundingClientRect()
    state.menuFlip = rect.bottom > innerHeight - 260
    state.menu = state.menu === 'chat' ? null : 'chat'
    render()
    return
  }
  if (act === 'chat-export') {
    const bot = chatBotOf()
    const stamp = new Date().toISOString().slice(0, 10)
    downloadFile(((bot && bot.name) || 'chat') + '-' + stamp + '.md', chatExportText(), 'text/markdown;charset=utf-8')
    state.menu = null
    render()
    return
  }
  if (act === 'chat-copy-all') {
    try {
      await navigator.clipboard.writeText(chatExportText())
      flash('ok', '已复制全文')
    } catch {
      flash('err', '复制失败，浏览器不允许')
    }
    state.menu = null
    render()
    return
  }
  if (act === 'chat-jump') {
    const thread = document.getElementById('chat-thread')
    // 这一下是人主动点的，滑过去更容易跟上；流式跟随那一路是瞬时的（见 paintChat），
    // 平滑动画会让 nearBottom 在动画途中判成 false，跟随就断了。
    if (thread) thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' })
    return
  }
  if (act === 'aside-toggle') {
    asidePref.open = !asidePref.open
    saveAside()
    render()
    return
  }
  if (act === 'runtime-redeploy') {
    const id = btn.getAttribute('data-bot') || ''
    const bot = (state.runtimeBots || []).find((b) => b.id === id)
    state.confirm = {
      title: '重新部署这个 Bot？',
      body: t(
        `会把「${(bot && bot.name) || id}」的席位重装一遍并重启。正在进行的对话会断，开着的桌面会掉线；${'\u007e'}/work 里的文件和会话记录不受影响。`,
        `The seat for "${(bot && bot.name) || id}" is reinstalled and restarted. Ongoing conversations drop and any open desktop disconnects; files in ~/work and session history are unaffected.`,
      ),
      label: '重新部署',
      kind: 'redeploy-bot',
      id,
    }
    render()
    return
  }
  if (act === 'runtime-deploy') {
    await deployMyRuntime(btn.getAttribute('data-bot') || '')
    return
  }
  if (act === 'upgrade-bot') {
    await updateOrgRuntime()
    return
  }
  if (act === 'machine-remove') {
    await removeMachine(btn.getAttribute('data-id'), btn.getAttribute('data-machine'))
    return
  }
  if (act === 'upgrade-manager') {
    await upgradeManager(btn.getAttribute('data-id'), btn.getAttribute('data-machine'))
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
  if (act === 'machine-tab') {
    state.machineTab = btn.getAttribute('data-tab') === 'bot' ? 'bot' : 'manager'
    render()
    return
  }
  if (act === 'pairing-code') return makePairingCode(btn.getAttribute('data-id'))
  if (act === 'copy-machine-id') {
    const id = btn.getAttribute('data-machine')
    if (id) {
      // 和 copy-install 同一个理由：剪贴板 API 在非 https 的内网页面上会被拒，
      // 失败必须说话——静默复制失败之后人会照着屏幕上那 8 位去用，那不是完整 id。
      navigator.clipboard?.writeText(id).then(
        () => flash('ok', '已复制机器编号'),
        () => flash('err', '复制失败，请手动选中'),
      )
    }
    return
  }
  if (act === 'copy-install') {
    const cmd = state.pairingCode && state.pairingCode.installCommand
    if (cmd) {
      // 剪贴板 API 在非 https 的内网页面上会被拒，所以失败要说话，不能静默。
      navigator.clipboard?.writeText(cmd).then(
        () => flash('ok', '已复制安装命令'),
        () => flash('err', '复制失败，请手动选中命令'),
      )
    }
    return
  }
  if (act === 'copy-release-url') {
    const url = btn.getAttribute('data-url') || ''
    if (!url) return
    const ok = await copyText(url)
    flash(ok ? 'ok' : 'err', ok ? t('已复制') : t('复制失败，请手动选中复制。'))
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
    const base = catalogBase()
    if (!base) return
    state.busy = true
    render()
    try {
      const data = await api('POST', `${base}/bots`, { name: '新助理' })
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
    const base = catalogBase()
    const botId = btn.getAttribute('data-id')
    const cur = (state.bots || []).find((b) => b.id === botId)
    if (!base || !cur) return
    const enabled = !(cur.enabled !== false)
    try {
      const data = await api('PATCH', `${base}/bots/${encodeURIComponent(botId)}`, { enabled })
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
    if (!avatarKeysFor(draftOrigin()).includes(icon)) return
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
    const base = catalogBase()
    const bot = state.bot
    const a = state.botDraft
    if (!base || !bot || !a) return
    state.busy = true
    render()
    try {
      // model / provider 不发：模型由平台指定，这里没得挑。
      const data = await api('PATCH', `${base}/bots/${encodeURIComponent(bot.id)}`, {
        name: a.name,
        description: a.description,
        prompt: a.prompt,
        greeting: a.greeting,
        escalate: a.escalate,
        enabled: a.enabled,
        icon: a.icon,
        skills: a.skills,
        mcps: a.mcps,
        guards: Object.fromEntries((a.guards || []).map((g) => [g.id, !!g.on])),
        memory: { on: a.memoryOn, scope: a.scope, kinds: a.kinds, ttl: a.ttl, cap: a.cap, confirm: a.confirmOn, pii: a.piiOn },
      })
      state.bot = data.bot
      // 存完整份按服务端的回执重建：谁被归一化过（越界的注入上限、认不出的选项）当场就看得见。
      // groups / kbs 还没有落点，先留住手上这份，别一保存就空掉。
      state.botDraft = { ...draftFromBot(data.bot), groups: a.groups, kbs: a.kbs, memories: a.memories }
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
      body: t(`「${(a && a.name) || bot.name}」的人设、能力配置与已存记忆会一并删除，正在用它的定时任务与渠道会失效。`, `The persona, capability config and stored memories of "${(a && a.name) || bot.name}" are deleted; scheduled tasks and channels using it stop working.`),
      label: '删除',
      kind: 'delete-bot',
      id: bot.id,
    }
    render()
    return
  }
  if (act === 'logout') {
    clearToken()
    // 先掐流再清数据：SSE 还连着的话，下一个人登进来之前就会有上一个人的事件继续往
    // state.chatEvents 里落，然后被画出来。聊天正文、草稿、名册都是上一个账号的东西，
    // 同一个标签页换人登录时一条都不能留。
    stopChatStream()
    state.chatBotId = ''
    state.chatSessionId = ''
    state.chatEvents = []
    state.chatDraft = ''
    state.chatStatus = ''
    state.runtimeBots = []
    state.runtimeError = ''
    state.runtimeMachine = null
    state.desktopRuntime = null
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
  if (act === 'stats-range') {
    state.statsRange = btn.getAttribute('data-range')
    if (state.statsRange === 'month' && !state.statsMonth) state.statsMonth = thisMonth()
    await loadStats()
    return
  }
  if (act === 'prov-new') {
    state.providerDraft = { editing: false, id: '', name: '', baseUrl: '', api: state.customApis?.[0] || 'openai-completions', error: '' }
    render()
    return
  }
  if (act === 'prov-edit') {
    const p = customProvider(btn.getAttribute('data-provider'))
    if (!p) return
    state.providerDraft = { editing: true, id: p.id, name: p.name || '', baseUrl: p.baseUrl || '', api: p.api || 'openai-completions', error: '' }
    render()
    return
  }
  if (act === 'prov-close') {
    state.providerDraft = null
    render()
    return
  }
  if (act === 'prov-save') {
    await saveCustomProvider()
    return
  }
  if (act === 'prov-models') {
    state.modelsFor = btn.getAttribute('data-provider')
    state.modelDraft = null
    state.providerError = ''
    render()
    return
  }
  if (act === 'prov-models-close') {
    state.modelsFor = ''
    state.modelDraft = null
    render()
    return
  }
  if (act === 'prov-model-new') {
    state.modelDraft = { id: '', name: '', contextWindow: 128000, maxTokens: 8192, costInput: 0, costOutput: 0, reasoning: false, image: false }
    render()
    return
  }
  if (act === 'prov-model-cancel') {
    state.modelDraft = null
    render()
    return
  }
  if (act === 'prov-model-save') {
    await saveCustomModel()
    return
  }
  if (act === 'prov-model-del') {
    await deleteCustomModel(btn.getAttribute('data-model'))
    return
  }
  if (act === 'prov-delete') {
    const provider = btn.getAttribute('data-provider')
    const isCustom = btn.getAttribute('data-custom') === '1'
    state.confirm = isCustom
      ? {
          title: t(`删除自定义供应商「${provider}」？`, `Delete custom provider "${provider}"?`),
          body: t(
            `它的模型定义和密钥会一并删除，正在用它的模型角色会被清空。`,
            `Its model definitions and key are deleted; model roles using it are cleared.`,
          ),
          label: '删除',
          kind: 'delete-custom-provider',
          id: provider,
        }
      : {
          title: t(`移除「${provider}」的密钥？`, `Remove the key for "${provider}"?`),
          body: t(
            `密钥删掉之后这家供应商不再出现在列表里，它的模型也调不通了。重新贴一把密钥就能恢复。`,
            `Without a key this provider leaves the list and its models stop working. Paste a key again to restore it.`,
          ),
          label: '移除密钥',
          kind: 'delete-credential',
          id: provider,
        }
    render()
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
    state.orgCreateError = ''
    render()
    return
  }
  if (act === 'org-create-close') {
    state.orgCreateOpen = false
    state.orgCreateError = ''
    render()
    return
  }
  if (act === 'order-new') {
    state.orderEdit = { id: '', kind: btn.getAttribute('data-kind') === 'topup' ? 'topup' : 'plan' }
    state.orderError = ''
    render()
    return
  }
  if (act === 'order-edit') {
    const id = btn.getAttribute('data-id') || ''
    // 类型跟着这张单子走：弹窗里的类型下拉是 disabled，提交时表单不会带它。
    const row = (state.orders || []).find((o) => o.id === id)
    state.orderEdit = { id, kind: row?.kind || 'plan' }
    state.orderError = ''
    render()
    return
  }
  if (act === 'order-close') {
    state.orderEdit = null
    state.orderError = ''
    render()
    return
  }
  if (act === 'plan-sku-new') {
    state.planSkuEdit = { id: '' }
    state.planSkuError = ''
    render()
    return
  }
  if (act === 'plan-sku-edit') {
    state.planSkuEdit = { id: btn.getAttribute('data-id') || '' }
    state.planSkuError = ''
    render()
    return
  }
  if (act === 'plan-sku-close') {
    state.planSkuEdit = null
    state.planSkuError = ''
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
      body: t(`「${g.name}」删除后，它授权的 Agent 访问范围随之失效。成员账号不受影响。`, `Deleting "${g.name}" revokes the agent access it granted. Member accounts are unaffected.`),
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
      body: t(`「${m.name}」当前的登录会立即失效，之后也无法再登录。历史记录保留。`, `"${m.name}" is signed out immediately and cannot sign in again. History is kept.`),
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
      body: t(`「${m.name}」将可以重新登录。`, `"${m.name}" will be able to sign in again.`),
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
      body: t(`「${m.name}」的账号将被删除，登录立即失效。他创建的会话与定时任务保留但不再执行。`, `The account "${m.name}" is deleted and signed out at once. Sessions and scheduled tasks they created remain but stop running.`),
      label: '删除',
      kind: 'delete',
      id: m.id,
    }
    state.menu = null
    render()
    return
  }
  if (act === 'org-status') {
    const id = btn.getAttribute('data-id')
    const next = btn.getAttribute('data-next') === 'disabled' ? 'disabled' : 'active'
    const name = (state.org && state.org.name) || ''
    state.confirm = next === 'disabled'
      ? {
          title: '停用这家公司？',
          body: t(`「${name}」的所有人当场登不进来，手上的票也立刻失效。资料和数据都保留。`, `Everyone at "${name}" is signed out at once and cannot sign in. Data is kept.`),
          label: '停用',
          kind: 'org-status',
          id,
          next,
        }
      : {
          title: '启用这家公司？',
          body: t(`「${name}」的人可以重新登录。`, `People at "${name}" can sign in again.`),
          label: '启用',
          kind: 'org-status',
          id,
          next,
        }
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
    const base = catalogBase()
    const skillId = btn.getAttribute('data-id')
    const cur = (state.skills || []).find((x) => x.id === skillId)
    if (!base || !cur) return
    const enabled = !(cur.enabled !== false)
    api('PATCH', `${base}/skills/${encodeURIComponent(skillId)}`, { enabled })
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
    const base = catalogBase()
    const serverId = btn.getAttribute('data-id')
    const cur = (state.mcpServers || []).find((x) => x.id === serverId)
    if (!base || !cur) return
    const enabled = !(cur.enabled !== false)
    api('PATCH', `${base}/mcp-servers/${encodeURIComponent(serverId)}`, { enabled })
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
      title: t(`删除标签「${tag}」？`, `Delete tag "${tag}"?`),
      body: used > 0 ? t(`${used} 个 Skill 正在用它，它们身上这个标签会一起去掉。`, `${used} skills use it; the tag is removed from them too.`) : t('这个标签会从表里删掉。'),
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
      body: t(`「${item.name}」的定义会被删除，用到它的 Agent 将不再有这项方法。`, `The definition of "${item.name}" is deleted; agents using it lose this method.`),
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
      body: t(`「${item.name}」的连接配置与鉴权 token 一并删除。`, `The connection config and auth token for "${item.name}" are deleted.`),
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
  // 两份草稿只存在 state 里，边打边收；不 render，否则每敲一个字都会丢焦点。
  if (el.getAttribute('data-act') === 'prov-field' && state.providerDraft) {
    state.providerDraft[el.getAttribute('data-field')] = el.value
    return
  }
  if (el.getAttribute('data-act') === 'model-field' && state.modelDraft) {
    const f = el.getAttribute('data-field')
    state.modelDraft[f] = el.type === 'checkbox' ? el.checked : el.value
    return
  }
  const botField = el.getAttribute('data-bot')
  if (botField && state.botDraft) {
    if (botField === 'cap') {
      state.botDraft = { ...state.botDraft, cap: Number(el.value) }
      const label = document.querySelector('[data-bot-cap-label]')
      if (label) label.textContent = t(`注入上限 · ${state.botDraft.cap} 条`, `Injection cap · ${state.botDraft.cap}`)
      return
    }
    state.botDraft = { ...state.botDraft, [botField]: el.value }
    if (botField === 'prompt') {
      const len = document.querySelector('[data-bot-prompt-len]')
      if (len) len.textContent = t(`${el.value.length} 字 · 每轮随上下文注入`, `${el.value.length} chars · injected each turn`)
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
  if (el instanceof HTMLInputElement && el.id === 'chat-file') {
    await takeChatFiles(el)
    return
  }
  // 换单据类型要整张表单重画（两种单子字段不一样），所以这里走 render()。
  if (el instanceof HTMLSelectElement && el.getAttribute('data-act') === 'order-kind-pick') {
    const form = el.closest('form')
    const fd = form ? new FormData(form) : null
    state.orderEdit = {
      id: '',
      kind: el.value === 'topup' ? 'topup' : 'plan',
      // 两种单子都有的几项留住，其余按新类型的默认值来。
      draft: null,
      companyId: fd ? String(fd.get('companyId') || '') : '',
    }
    render()
    return
  }
  // 换套餐时把金额/席位/赠送/类型带出来。直接写 DOM 而不是 render()——
  // render 会重建表单，把用户已经填好的其他项冲掉。
  if (el instanceof HTMLSelectElement && el.getAttribute('data-act') === 'order-plan-pick') {
    const sku = (state.planSkus || []).find((p) => p.id === el.value)
    const form = el.closest('form')
    if (sku && form) {
      const set = (name, value) => {
        const f = form.querySelector(`[name="${name}"]`)
        if (f) f.value = value
      }
      set('amount', milsOf(sku, 'amount') / 1000)
      set('bonusTokens', milsOf(sku, 'bonus') / 1000)
      set('seats', sku.seats)
      set('period', sku.period || 'month')
    }
    return
  }
  // 倍率是 input，得在下面那道「只收 select」的关卡之前处理。
  if (el instanceof HTMLInputElement && el.getAttribute('data-act') === 'price-multiplier') {
    await savePriceMultiplier(el.value)
    return
  }
  // 月份选择器和公司下拉都在「只收 select」那道关卡的两边，各自处理。
  if (el.getAttribute?.('data-act') === 'stats-month') {
    state.statsMonth = el.value || thisMonth()
    state.statsRange = 'month'
    await loadStats()
    return
  }
  if (el.getAttribute?.('data-act') === 'stats-company') {
    state.statsCompany = el.value
    await loadStats()
    return
  }
  // select 和 checkbox 只发 change，草稿字段在这里也收一次。
  if (el.getAttribute?.('data-act') === 'prov-field' && state.providerDraft) {
    state.providerDraft[el.getAttribute('data-field')] = el.value
    return
  }
  if (el.getAttribute?.('data-act') === 'model-field' && state.modelDraft) {
    const f = el.getAttribute('data-field')
    state.modelDraft[f] = el instanceof HTMLInputElement && el.type === 'checkbox' ? el.checked : el.value
    return
  }
  if (!(el instanceof HTMLSelectElement)) return
  const act = el.getAttribute('data-act')
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
    state.selectedProvider = provider
    await saveSettings({ [role]: { provider, model } })
    // saveSettings 里那次 render 在前面，改完 selectedProvider 得自己再画一次，
    // 否则下面那张表还停在上一个供应商。
    render()
    return
  }
  if (act === 'role-model') {
    const role = el.getAttribute('data-role')
    const cur = state.settings[role] || {}
    await saveSettings({ [role]: { provider: cur.provider, model: el.value } })
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

/**
 * Enter 发送，Shift + Enter 换行。
 *
 * **isComposing 必须挡住。** 中文输入法里回车是「选中候选词」，不挡的话打「你好」按回
 * 车，选词的同时把半截话发出去了。keyCode 229 是同一件事的老写法，有的浏览器只给这个。
 */
document.getElementById('app').addEventListener('keydown', (e) => {
  const el = e.target
  if (!(el instanceof HTMLTextAreaElement) || el.id !== 'chat-input') return
  if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
  if (e.isComposing || e.keyCode === 229) return
  e.preventDefault()
  void sendChat()
})

/**
 * 消息流的滚动。scroll 不冒泡，但捕获阶段到得了 document，所以一个监听器就够——
 * 对话页每次重绘都会换掉那个滚动容器，挂在元素上的话得跟着重挂。
 */
document.addEventListener(
  'scroll',
  (e) => {
    const el = e.target
    if (!(el instanceof Element) || el.id !== 'chat-thread') return
    // 人动过滚动条之后，贴底才开始看「是不是本来就在底部」。在这之前一律贴底，
    // 否则刚进页面、内容还没铺满时会停在顶上。
    el.setAttribute('data-touched', '1')
    const jump = document.getElementById('chat-jump')
    if (jump) jump.hidden = nearBottom(el)
  },
  true,
)

/**
 * 拖右栏改宽度。
 *
 * **拖动期间不重绘**：整页是 innerHTML 整块换掉的，重绘一次就把正在拖的那个元素连同
 * 鼠标捕获一起换掉了，手感会碎成一段一段。所以直接改 main 上的 grid 列宽，松手才落盘。
 */
document.getElementById('app').addEventListener('mousedown', (e) => {
  const grip = e.target instanceof Element ? e.target.closest('[data-act="aside-grip"]') : null
  if (!grip) return
  e.preventDefault()
  const main = document.getElementById('gw-main')
  if (!main) return
  const startX = e.clientX
  const startW = asidePref.width
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  const onMove = (ev) => {
    // 往左拖变宽：栏在右边，所以是起点减当前。
    const next = Math.min(520, Math.max(200, startW + (startX - ev.clientX)))
    asidePref.width = next
    main.style.gridTemplateColumns = `minmax(0, 1fr) ${next}px`
  }
  const onUp = () => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    saveAside()
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
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
  // **不管手上有没有票都先问一次**。票可能是上一套数据留下的（库换了、账号删了），
  // 那时候拿着废票去 /me 只会掉进登录页——而系统里一个账号都没有，那是个死胡同。
  try {
    const st = await api('GET', '/auth/state')
    state.needsSetup = Boolean(st && st.needsSetup)
  } catch {
    // 问不到就按常规走，别把人挡在门外。
  }
  if (state.needsSetup) {
    clearToken()
    state.me = null
    state.loginError = ''
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
