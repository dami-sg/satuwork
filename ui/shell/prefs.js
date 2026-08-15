/**
 * 界面偏好：主题与语言。
 *
 * 两样都**先落在本机**（localStorage），再由个人设置那屏顺手同步到账号上。理由是
 * 顺序：主题必须在第一帧之前生效，而那时候还没登录、也还没有任何请求回来——等
 * 服务端回话再切，就是一次白闪。
 *
 * 不做成 cordis 服务，是因为它们在 boot 里就要用（那时 Context 还没建起来），
 * 而且全局只有一份：一个页面一套外观、一种语言。
 */

const THEME_KEY = 'satu.theme'
const LOCALE_KEY = 'satu.locale'

const listeners = new Set()
const notify = () => {
  for (const listener of listeners) listener()
}

/** 界面变了要重画。boot 把它接到 slots 的 bump 上。 */
export function onPrefsChange(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ── 主题 ───────────────────────────────────────────────────────────────────
const dark = matchMedia('(prefers-color-scheme: dark)')
let themeMode = localStorage.getItem(THEME_KEY) ?? 'system'

/**
 * `system` 在 CSS 那边**不存在**：这里把它解析成 light/dark 再落到
 * `<html data-theme>` 上。这样 theme.css 里只有一套暗色令牌，不用为
 * `prefers-color-scheme` 再抄一份——那份抄件迟早会跟本体对不上。
 */
function paint() {
  const resolved = themeMode === 'system' ? (dark.matches ? 'dark' : 'light') : themeMode
  document.documentElement.setAttribute('data-theme', resolved)
}

dark.addEventListener('change', () => {
  if (themeMode === 'system') {
    paint()
    notify()
  }
})

export const theme = () => themeMode

export function setTheme(mode) {
  themeMode = mode
  localStorage.setItem(THEME_KEY, mode)
  paint()
  notify()
}

// ── 语言 ───────────────────────────────────────────────────────────────────
let current = localStorage.getItem(LOCALE_KEY) ?? 'zh'

export const locale = () => current

export function setLocale(next) {
  current = next
  localStorage.setItem(LOCALE_KEY, next)
  document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN'
  notify()
}

/**
 * 取词。
 *
 * 两种语言就地成对写，而不是抽一份 key 字典：`t('新建对话', 'New chat')`。
 * 字典那套在十几种语言时才划算，两种语言下它只带来一个新问题——改了文案忘了改
 * 字典，界面上出现一个 key。就地成对写，漏译当场就能看见。
 */
export function t(zh, en) {
  return current === 'en' ? (en ?? zh) : zh
}

/** 启动时立刻贴上，别等第一帧之后。 */
export function applyPrefs() {
  paint()
  document.documentElement.lang = current === 'en' ? 'en' : 'zh-CN'
}
