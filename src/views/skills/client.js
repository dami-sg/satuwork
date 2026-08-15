import { html, icon, ICONS, NavItem, useHost, useState, t } from '@satu/shell'

/**
 * Skill 与 MCP。
 *
 * 三段：Skill 卡片（mock）、MCP 服务器表（mock）、**内置工具**（真）。第三段是这
 * 台机器上此刻真的能调的东西，单独列出来——不然「工具」这个词在这屏里会同时指
 * 三样东西，而其中两样还不存在。
 */

const ICON = [
  'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z',
]

function SkillsNav({ ctx, path }) {
  return html`<${NavItem} ctx=${ctx} path=${path} href="/skills" icon=${icon(ICON)} label=${t('Skill 与 MCP', 'Skills & MCP')} />`
}

function Notice({ text }) {
  return html`<div style="flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted-foreground);">${text}</div>`
}

function SkillCard({ skill, enabled, onToggle }) {
  return html`
    <div class="satu-card">
      <div style="display: flex; align-items: flex-start; gap: var(--space-3);">
        <span class="satu-providermark" style="background: var(--color-accent-100); color: var(--color-accent-800);">${icon(ICON, 16)}</span>
        <div style="flex: 1; min-width: 0;">
          <div class="satu-name">${skill.name}</div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px;">
            ${skill.tags.map((tag) => html`<span key=${tag} class="tag tag-neutral" style="font-size: 11px; padding: 2px 8px;">${tag}</span>`)}
          </div>
        </div>
        <button type="button" class="satu-switch" aria-pressed=${String(enabled)} aria-label=${t('启用', 'Enable')} onClick=${onToggle}><span></span></button>
      </div>
      <p class="satu-desc">${skill.desc}</p>
      <div style="height: 1px; background: var(--color-divider);"></div>
      <div class="satu-meta">
        <span>${t(`${skill.steps} 个步骤`, `${skill.steps} steps`)}</span>
        <span>${skill.source}</span>
        <span>${t(`本月调用 ${skill.usage}`, `${skill.usage} this month`)}</span>
      </div>
      <div style="display: flex; gap: var(--space-2); margin-top: auto;">
        <button type="button" class="btn btn-secondary" style="flex: 1; justify-content: center;" disabled title=${t('Skill 注册表还没做', 'The skill registry is not built yet')}>${t('编辑', 'Edit')}</button>
        <button type="button" class="btn btn-secondary" style="flex: none;" disabled title=${t('试运行需要 Skill 注册表', 'Dry runs need the skill registry')}>${t('试运行', 'Dry run')}</button>
      </div>
    </div>
  `
}

function SkillsPage({ ctx }) {
  const data = useHost(ctx, '/api/skills')
  const builtin = useHost(ctx, '/api/tools')
  const [tab, setTab] = useState('Skill')
  const [off, setOff] = useState([])

  if (data.loading || builtin.loading) return html`<${Notice} text=${t('载入中…', 'Loading…')} />`
  if (data.error) return html`<${Notice} text=${data.error.message} />`

  const enabledOf = (x) => (off.includes(x.id) ? !x.enabled : x.enabled)
  const toggle = (id) => setOff((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]))
  const tools = builtin.data?.tools ?? []

  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6);">
      <div style="max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-6);">

        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('Skill 与 MCP', 'Skills & MCP')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('Skill 是可复用的工作方法，MCP 服务器提供 AI 员工实际可调用的工具。', 'Skills are reusable methods; MCP servers provide the tools an AI employee can actually call.')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" disabled title=${t('Skill 注册表还没做', 'The skill registry is not built yet')}>
            ${icon(ICONS.plus, 15)} ${tab === 'Skill' ? t('新建 Skill', 'New skill') : t('接入 MCP', 'Add MCP')}
          </button>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('分类', 'Section')}</span>
          ${['Skill', t('MCP 与工具', 'MCP & tools')].map(
            (name) => html`
              <button key=${name} type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed=${String(tab === name)} onClick=${() => setTab(name)}>${name}</button>
            `,
          )}
        </div>

        ${tab === 'Skill'
          ? html`
              <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-4);">
                ${data.data.skills.map(
                  (s) => html`<${SkillCard} key=${s.id} skill=${s} enabled=${enabledOf(s)} onToggle=${() => toggle(s.id)} />`,
                )}
              </div>
            `
          : html`
              <div style="display: flex; flex-direction: column; gap: var(--space-6);">
                <div style="display: flex; flex-direction: column; gap: var(--space-3);">
                  <div style="display: flex; align-items: baseline; justify-content: space-between;">
                    <h2 style="font-size: 18px; margin: 0;">${t('内置工具', 'Built-in tools')}</h2>
                    <span style="font-size: 12px; color: var(--muted-foreground);">${t(`真实注册表 · 共 ${tools.length} 个`, `Live registry · ${tools.length} tools`)}</span>
                  </div>
                  <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
                    ${tools.map(
                      (tool) => html`
                        <div key=${tool.name} style="display: flex; align-items: baseline; gap: var(--space-3); padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border);">
                          <span style="flex: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; font-weight: 600;">${tool.name}</span>
                          <span style="min-width: 0; font-size: 13px; color: var(--muted-foreground);">${tool.description}</span>
                        </div>
                      `,
                    )}
                    ${!tools.length && html`<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('没有注册任何工具', 'No tools registered')}</div>`}
                  </div>
                  <span style="font-size: 12px; color: var(--muted-foreground);">${t('这一段是真的：Agent 此刻能调的就是这些。下面的 MCP 服务器还没接。', 'This part is real — it is exactly what an agent can call right now. The MCP servers below are not connected.')}</span>
                </div>

                <div style="display: flex; flex-direction: column; gap: var(--space-3);">
                  <div style="display: flex; align-items: baseline; justify-content: space-between;">
                    <h2 style="font-size: 18px; margin: 0;">${t('已接入 MCP 服务器', 'Connected MCP servers')}</h2>
                    <span style="font-size: 12px; color: var(--muted-foreground);">
                      ${t(`共 ${data.data.servers.length} 个 · 提供 ${data.data.servers.reduce((n, s) => n + s.toolCount, 0)} 个工具`, `${data.data.servers.length} servers · ${data.data.servers.reduce((n, s) => n + s.toolCount, 0)} tools`)}
                    </span>
                  </div>
                  <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
                    <div class="satu-toolhead">
                      <span>${t('MCP 服务器', 'MCP server')}</span><span>${t('传输', 'Transport')}</span><span>${t('工具数', 'Tools')}</span><span>${t('权限', 'Access')}</span><span>${t('本月调用', 'Calls this month')}</span><span></span>
                    </div>
                    ${data.data.servers.map(
                      (s) => html`
                        <div class="satu-toolrow" key=${s.id}>
                          <div style="min-width: 0; display: flex; flex-direction: column; gap: 2px;">
                            <span style="font-weight: 600; font-size: 14px;">${s.name}</span>
                            <span style="font-size: 12px; color: var(--muted-foreground);">${s.desc}</span>
                          </div>
                          <span style="font-size: 13px;">${s.kind}</span>
                          <span style="font-size: 13px; color: var(--muted-foreground);">${s.toolCount}</span>
                          <span class=${`tag ${s.perm === '只读' ? 'tag-neutral' : 'tag-accent'}`}>${s.perm}</span>
                          <span style="font-size: 13px; color: var(--muted-foreground);">${s.usage}</span>
                          <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-1); justify-content: flex-end;">
                            <button type="button" class="satu-switch" aria-pressed=${String(enabledOf(s))} aria-label=${t('启用', 'Enable')} onClick=${() => toggle(s.id)}><span></span></button>
                          </div>
                        </div>
                      `,
                    )}
                  </div>
                </div>
              </div>
            `}
      </div>
    </div>
  `
}

export default {
  name: 'satu-view-skills',
  inject: ['slots', 'host', 'router'],
  apply(ctx) {
    ctx.slots.inject(['sidebar.nav.admin', 'main'], function* () {
      yield ctx.slots.register({ name: 'sidebar.nav.admin', id: 'skills.nav', priority: 30 }, SkillsNav)
      yield ctx.slots.register(
        { name: 'main', id: 'skills', select: (path) => (path === '/skills' ? { title: t('Skill 与 MCP', 'Skills & MCP') } : null) },
        SkillsPage,
      )
    })
  },
}
