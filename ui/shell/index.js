/**
 * 插件的浏览器半边只 import 这一个说明符（`@satu/shell`）。
 *
 * 它同时是**运行时单例的入口**：preact 与 hooks 从这里透出去，插件不各自去
 * import 一遍，避免出现两份实例——那会让 hook 在「不同的 preact」里跑，症状是
 * 一段莫名其妙的 "Invalid hook call"，离病因很远。
 */
import { h } from 'preact'
import htm from 'htm'

export const html = htm.bind(h)

export { h, Fragment } from 'preact'
export * from 'preact/hooks'
export { renderSlot, renderSlotChain, useSlots } from './render.js'
export { useRoute } from './router.js'
export { useHost } from './host.js'
export { Confirm, NavItem, Page, Placeholder } from './primitives.js'
export { AGENT_ICONS, EXEC_MODES, GROUP_ICONS, ICONS, agentIcon, groupIcon, icon } from './icons.js'
export { locale, onPrefsChange, setLocale, setTheme, t, theme } from './prefs.js'
