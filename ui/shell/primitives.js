import { html } from './index.js'

/**
 * 各屏共用的控件。
 *
 * 放这里的标准只有一条：**同一个东西在两屏里必须长得一样**。导航项、页头、
 * 空态——这些一旦让每屏各写一遍，稿子上统一的那点分寸半个月就散了。只在一屏
 * 出现的东西不属于这里，留在那一屏自己的模块里。
 */

/** 侧栏导航项。当前项由地址决定，不由调用方传状态——两处判断迟早会不一致。 */
export function NavItem({ ctx, path, href, icon, label, exact = false }) {
  const current = exact ? path === href : path === href || path.startsWith(href + '/')
  return html`
    <button
      type="button"
      class="satu-nav"
      aria-current=${String(current)}
      onClick=${() => ctx.router.go(href)}
    >
      ${icon}
      <span class="satu-label">${label}</span>
    </button>
  `
}

/** 一屏的常规骨架：可滚动的正文加一个最大宽度。 */
export function Page({ children, wide = false }) {
  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6);">
      <div style=${`max-width: ${wide ? '1180px' : '860px'}; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-5);`}>
        ${children}
      </div>
    </div>
  `
}

/**
 * 破坏性操作的确认框。
 *
 * 稿子里这种框有好几个（删除任务、撤销授权、断开渠道…），措辞结构是同一套：
 * **标题问一句、正文说清楚失去什么、右下角两个按钮**。共用一个件，是因为「删了
 * 会怎样」这句话每屏各写各的，迟早有一屏写得比实际后果轻。
 */
export function Confirm({ title, body, confirmLabel = '删除', onCancel, onConfirm }) {
  return html`
    <div
      style="position: fixed; inset: 0; z-index: 25; display: flex; align-items: center; justify-content: center; padding: var(--space-6); background: color-mix(in srgb, var(--color-neutral-900) 42%, transparent);"
      onClick=${(e) => e.target === e.currentTarget && onCancel()}
    >
      <div style="width: 100%; max-width: 380px; box-sizing: border-box; background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-3);">
        <h2 style="font-size: 18px; margin: 0;">${title}</h2>
        <p style="margin: 0; font-size: 14px; line-height: 1.6; color: var(--muted-foreground);">${body}</p>
        <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
          <button type="button" class="btn btn-secondary" onClick=${onCancel}>取消</button>
          <button type="button" class="btn btn-primary" onClick=${onConfirm}>${confirmLabel}</button>
        </div>
      </div>
    </div>
  `
}

/** 还没接后端的那些屏用它占位——空白页说不清是没做完还是坏了。 */
export function Placeholder({ title, note }) {
  return html`
    <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-2); color: var(--muted-foreground);">
      <div style="font-family: var(--font-heading); font-size: 20px; color: var(--color-text);">${title}</div>
      <div style="font-size: 13px;">${note ?? '这一屏还没移植'}</div>
    </div>
  `
}
