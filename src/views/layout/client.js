import { html, renderSlot, renderSlotChain, useRoute, useState, t } from '@satu/shell'

/**
 * 根布局：侧栏 + 主区。
 *
 * 它**不知道有哪些屏**。侧栏的三组位置和主区的链式位置由它声明，谁往里贡献是
 * 别人的事；主区那一位是链式的——视图自荐路径，第一个认领的出场。加一屏因此不
 * 需要动这个文件，这正是「加一屏 = 加一个插件」成立的地方。
 *
 * 二级页的返回按钮也在这里：视图在自荐时声明 `back: { to, label }`，**画在哪儿、
 * 长什么样由布局说了算**。每屏各放一个的话，位置和措辞迟早各走各的。
 *
 * 那颗按钮上要盖掉 `.satu-back` 自带的 `align-self: flex-start`——那条是给正文里
 * 竖排用的，放进顶栏这一行会把它顶到上边，跟旁边的开关和标题错开。
 *
 * 带标题的每一组都裹在 `.satu-navgroup` 里：布局声明位置，但里面有没有东西是别人
 * 的事，**空的那一组不该在侧栏留下一条分隔线加一个标题**。所以判空交给 CSS
 * （`:has(.satu-nav)`，见 ui/shell/shell.css），布局这边不必知道谁贡献了什么——
 * 也就不用为「Plugin 现在还没人来」在这里写一句迟早忘了删的临时判断。
 */

const SLOTS = [
  'sidebar.nav.main',
  'sidebar.nav.plugin',
  'sidebar.nav.admin',
  'sidebar.footer',
  'main',
  // 顶栏右侧。哪一屏需要放东西，哪一屏自己往这里贡献——布局不认识它们。
  'header.actions',
]

function Layout({ ctx, renderSlot, renderSlotChain }) {
  const path = useRoute(ctx)
  const [rail, setRail] = useState(false)
  // 标题跟着出场的那一屏走：谁认领了这个地址，谁说自己叫什么。
  const [, matched] = ctx.slots.elect('main', path)
  /**
   * Admin 那一组整段只给管理员看——标题、分隔线、里面的每一项。
   *
   * 判断放在**这里**而不是各屏自己那儿：`sidebar.nav.admin` 这个位置的名字本身
   * 就是规矩，往里贡献等于声明「我是管理员的屏」。摊到六个插件里各写一遍，只是
   * 六份迟早会走散的同一句话。这**不是**权限措施——真正的拦截在服务端，这里只是
   * 别把点进去会碰壁的入口摆在人家眼前。
   *
   * 角色到前端时只剩 admin / member 两档（老数据里的 owner 在服务端就归了 admin）。
   */
  const admin = ctx.auth.state.user?.role === 'admin'

  return html`
    <div style=${`height: 100vh; overflow: hidden; display: grid; grid-template-columns: ${rail ? '62px' : '248px'} 1fr; gap: var(--space-4); padding: var(--space-4); background: var(--color-bg); font-family: var(--font-body); color: var(--color-text); box-sizing: border-box;`}>

      <aside class=${rail ? 'satu-rail' : ''} style="height: 100%; min-height: 0; overflow: hidden; box-sizing: border-box; display: flex; flex-direction: column; background: var(--color-surface); border-radius: var(--radius-md); padding: var(--space-4) var(--space-2) var(--space-2);">
        <button
          type="button"
          class="satu-brand"
          onClick=${() => ctx.router.go('/')}
          style="display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3) var(--space-4); border: 0; background: transparent; cursor: pointer; color: inherit;"
        >
          <img src="/assets/satuwork-logo.png" alt="Satuwork" style="width: 32px; height: 32px; min-width: 32px; flex: none; object-fit: contain; border-radius: var(--radius-sm);" />
          <span class="satu-brandtext" style="font-family: var(--font-heading); font-size: 19px;">Satuwork</span>
        </button>

        <div style="flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;">
          ${renderSlot('sidebar.nav.main', { path })}
          <div class="satu-navgroup">
            <div class="satu-sep"></div>
            <p class="satu-group">Plugin</p>
            ${renderSlot('sidebar.nav.plugin', { path })}
          </div>
          ${admin &&
          html`
            <div class="satu-navgroup">
              <div class="satu-sep"></div>
              <p class="satu-group">Admin</p>
              ${renderSlot('sidebar.nav.admin', { path })}
            </div>
          `}
        </div>

        <div class="satu-userrow" style="display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3); margin-top: var(--space-2); border-top: 1px solid var(--color-divider);">
          ${renderSlot('sidebar.footer', { path })}
        </div>
      </aside>

      <main style="min-width: 0; height: 100%; min-height: 0; box-sizing: border-box; overflow: hidden; background: var(--color-neutral-100); border: 1px solid var(--color-divider); border-radius: var(--radius-md); display: flex; flex-direction: column;">
        <div style="flex: none; display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-6); border-bottom: 1px solid var(--color-divider);">
          <button type="button" class="btn btn-ghost btn-icon" aria-label=${rail ? t('展开侧栏', 'Expand sidebar') : t('收起侧栏', 'Collapse sidebar')} onClick=${() => setRail(!rail)}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
          </button>
          <div style="width: 1px; height: 18px; background: var(--color-divider);"></div>
          ${matched?.back &&
          html`
            <button
              type="button"
              class="satu-back"
              style="margin: 0; align-self: center;"
              aria-label=${matched.back.label}
              title=${matched.back.label}
              onClick=${() => ctx.router.go(matched.back.to)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
              ${matched.back.label}
            </button>
            <div style="width: 1px; height: 18px; background: var(--color-divider);"></div>
          `}
          <span style="font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${matched?.title ?? 'Satuwork'}</span>
          <div style="margin-left: auto; display: flex; align-items: center; gap: var(--space-2); flex: none;">
            ${renderSlot('header.actions', { path })}
          </div>
        </div>

        ${renderSlotChain(
          'main',
          path,
          html`<${Missing} path=${path} />`,
        )}
      </main>
    </div>
  `
}

/** 没人认领这个地址。说清楚是「没有这一屏」，别画成一屏空数据。 */
function Missing({ path }) {
  return html`
    <div style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; color: var(--muted-foreground);">
      <div style="font-family: var(--font-heading); font-size: 20px; color: var(--color-text);">${t('没有这一屏', 'No such screen')}</div>
      <div style="font-size: 13px;">${t(`${path} 没有插件认领`, `No plugin claims ${path}`)}</div>
    </div>
  `
}

export default {
  name: 'satu-layout',
  // 服务是异步就绪的：声明依赖，cordis 会把插件挂在 PENDING 上等它，`apply` 里
  // 因此不需要任何「服务还在吗」的防御判断——和宿主那边是同一条规则。
  inject: ['slots', 'router', 'auth'],
  apply(ctx) {
    ctx.slots.register(
      {
        name: 'root',
        id: 'layout',
        children: SLOTS,
        // root 是链式的：登录页优先级更高，没登录时它先认领整块屏幕。这里的
        // priority 大，意思是「别人都不要的时候才轮到我」。
        priority: 100,
        select: () => ({}),
      },
      Layout,
    )
  },
}
