/**
 * 偏好与常量：主题、语言、图标、路径表、侧栏定义。
 *
 * **必须第一个加载**：这里有唯一一段「加载即执行」的代码（applyPrefs），后面几个文件
 * 都从它铺好的全局量上接着写。它自己不依赖任何后面的东西——别往这里加会调用别处函数
 * 的顶层语句，那在拼成一个文件的年代能跑，拆开之后就是 ReferenceError。
 */
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
  '/machines': { title: '机器管理' },
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
  '/bots': { title: 'Bot 模版', ownerTitle: '全局 Bot' },
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
  // 机架：两层横条 + 各自一盏指示灯。跟 bots 那个「有触角的盒子」在 17px 下也分得开。
  machines: [
    'M4 4h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
    'M4 14h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1z',
    'M7 7.5h.01',
    'M7 17.5h.01',
  ],
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

/** 收起右栏。展开状态下开关画的是它——那时要说的是「点了会怎样」。 */
const CHEVRON_RIGHT = ['M9 18l6-6-6-6']

/**
 * 右栏那颗开关的图标。**收起的时候画一台显示器。**
 *
 * 栏收着的时候，人需要知道的是「这里面是什么」——箭头答不了，一块屏能。展开之后
 * 问题变了：屏就在眼前，不用再介绍，这时候要说的是「点了会怎样」，那就是收回去的
 * 箭头。所以两态两个图标，而不是一个图标翻方向。
 */
const MONITOR = [
  'M4 5h16a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z',
  'M12 16v3',
  'M8.5 19h7',
]

const GEAR = [
  'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
]

const OWNER_NAV = [
  { href: '/', label: '概览', icon: 'overview' },
  { href: '/companies', label: '公司', icon: 'company' },
  // 机器管理在机器配置**上面**：先是「平台上有哪些机器、哪台出事了」，然后才是
  // 「给它们发什么版本的包」。发布包那一页是给这一页服务的，不是反过来。
  { href: '/machines', label: '机器管理', icon: 'machines' },
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
  { href: '/connectors', label: '连接器', icon: 'providers' },
]

const ADMIN_NAV = [
  { href: '/company', label: '公司/席位', icon: 'company' },
  { href: '/accounts', label: '员工', icon: 'accounts' },
  { href: '/audit', label: '审计', icon: 'audit' },
  { href: '/billing', label: '账单', icon: 'billing' },
  { href: '/usage', label: '用量统计', icon: 'usage' },
  { href: '/bots', label: 'Bot 模版', icon: 'bots' },
  { href: '/skills', label: 'Skill 与 MCP', icon: 'skills' },
  { href: '/connectors', label: '连接器', icon: 'providers' },
]

/**
 * 员工侧栏原来是空的（只有 Bot 名单，由 chatRosterNav 单独画）。连接器是第一个
 * 进来的东西——它是「我这个人有哪些账号」，不属于任何一颗 Bot。
 */
const MEMBER_NAV = [{ href: '/connectors', label: '连接器', icon: 'providers' }]
