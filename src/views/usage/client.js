import { html, icon, NavItem, useHost, useState, t } from '@satu/shell'

/** 用量统计。 */

const ICON = ['M3 12h4l3 8 4-16 3 8h4']
const RANGES = () => [t('近 7 天', 'Last 7 days'), t('近 30 天', 'Last 30 days'), t('本月', 'This month')]

function UsageNav({ ctx, path }) {
  return html`<${NavItem} ctx=${ctx} path=${path} href="/usage" icon=${icon(ICON)} label=${t('用量统计', 'Usage')} />`
}

function Notice({ text }) {
  return html`<div style="flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted-foreground);">${text}</div>`
}

/** 一行「名字 — 数值 — 进度条」。按 Agent、按模型、配额三处同一个形状。 */
function Meter({ name, value, pct, alt, mono }) {
  return html`
    <div style="display: flex; flex-direction: column; gap: 5px;">
      <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3);">
        <span style=${`min-width: 0; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;${mono ? ' font-family: ui-monospace, SFMono-Regular, Menlo, monospace;' : ''}`}>${name}</span>
        <span style="flex: none; font-size: 12.5px; color: var(--muted-foreground);">${value}</span>
      </div>
      <div class="satu-meter"><div class="satu-meterfill" data-alt=${alt ? 'true' : 'false'} style=${`width: ${pct}%;`}></div></div>
    </div>
  `
}

function UsagePage({ ctx }) {
  const { data, error, loading } = useHost(ctx, '/api/usage')
  const [range, setRange] = useState(null)

  if (loading) return html`<${Notice} text=${t('载入中…', 'Loading…')} />`
  if (error) return html`<${Notice} text=${error.message} />`

  const peak = Math.max(...data.daily.map((d) => d.value))

  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6);">
      <div style="max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-6);">

        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('用量统计', 'Usage')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${range ?? RANGES()[1]} · ${t('数据每小时更新一次', 'refreshed hourly')}</p>
          </div>
          <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
            ${RANGES().map(
              (r) => html`
                <button key=${r} type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed=${String((range ?? RANGES()[1]) === r)} onClick=${() => setRange(r)}>${r}</button>
              `,
            )}
            <button type="button" class="btn btn-secondary" disabled title=${t('导出需要统计投影', 'Export needs the usage projection')}>${t('导出 CSV', 'Export CSV')}</button>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--space-3);">
          ${data.stats.map(
            (s) => html`
              <div class="satu-stat" key=${s.label}>
                <span style="font-size: 12px; color: var(--muted-foreground);">${s.label}</span>
                <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${s.value}</span>
                <span style="font-size: 11.5px; color: var(--color-accent-2-800);">${s.delta}</span>
              </div>
            `,
          )}
        </div>

        <div class="satu-panel">
          <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
            <span class="satu-panel-title">${t('每日任务执行量', 'Runs per day')}</span>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t(`峰值 ${peak} 次`, `peak ${peak}`)}</span>
          </div>
          <div class="satu-bars">
            ${data.daily.map(
              (d) => html`
                <div class="satu-barcol" key=${d.label} title=${t(`${d.label} · ${d.value} 次`, `${d.label} · ${d.value} runs`)}>
                  <div class="satu-barstack">
                    <div class="satu-barfill" style=${`height: ${Math.round((d.value / peak) * 100)}%;`}></div>
                  </div>
                  <span class="satu-barlabel">${d.label}</span>
                </div>
              `,
            )}
          </div>
        </div>

        <div class="satu-agentpair">
          <div class="satu-panel">
            <span class="satu-panel-title">${t('按 Agent', 'By agent')}</span>
            ${data.byAgent.map((a) => html`<${Meter} key=${a.name} name=${a.name} value=${a.value} pct=${a.pct} />`)}
          </div>
          <div class="satu-panel">
            <span class="satu-panel-title">${t('按模型', 'By model')}</span>
            ${data.byModel.map((m) => html`<${Meter} key=${m.name} name=${m.name} value=${m.value} pct=${m.pct} alt mono />`)}
          </div>
        </div>

        <div class="satu-panel">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
            <div>
              <span class="satu-panel-title">${t('套餐额度', 'Plan quota')}</span>
              <p style="margin: 6px 0 0; font-size: 13px; color: var(--muted-foreground);">${t('团队版 · 每月 10,000 次任务、8,000 万 tokens', 'Team plan · 10,000 runs and 80M tokens per month')}</p>
            </div>
            <span class="tag tag-accent" style="flex: none;">${t('本月剩余 32%', '32% left this month')}</span>
          </div>
          <div style="display: flex; flex-direction: column; gap: var(--space-3);">
            ${data.quota.map((q) => html`<${Meter} key=${q.label} name=${q.label} value=${q.value} pct=${q.pct} />`)}
          </div>
        </div>

        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <h2 style="font-size: 18px; margin: 0;">${t('成员用量', 'By member')}</h2>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-usagehead">
              <span>${t('成员', 'Member')}</span><span>${t('任务', 'Runs')}</span><span>Tokens</span><span>${t('失败率', 'Failure rate')}</span><span>${t('最近使用', 'Last used')}</span>
            </div>
            ${data.byMember.map(
              (m) => html`
                <div class="satu-usagerow" key=${m.id}>
                  <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
                    <span class="satu-avatar" style="width: 26px; height: 26px; font-size: 11px; background: var(--color-neutral-300); color: var(--color-neutral-800);">${m.initial}</span>
                    <span style="min-width: 0; font-size: 13.5px;">${m.name}</span>
                  </div>
                  <span style="font-size: 13px;">${m.tasks}</span>
                  <span style="font-size: 13px; color: var(--muted-foreground);">${m.tokens}</span>
                  <span style="font-size: 13px; color: var(--muted-foreground);">${m.fail}</span>
                  <span style="font-size: 13px; color: var(--muted-foreground);">${m.last}</span>
                </div>
              `,
            )}
          </div>
        </div>

        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">
          ${t('这些数字现在是假的，但来源是现成的：每条 assistant 消息都带 token 与费用，按会话日志聚合就是真数——差的是那层投影。', 'These numbers are fake, but the source is not: every assistant message carries tokens and cost. Aggregating the session log would make them real — the projection layer is what is missing.')}
        </p>
      </div>
    </div>
  `
}

export default {
  name: 'satu-view-usage',
  inject: ['slots', 'host', 'router'],
  apply(ctx) {
    ctx.slots.inject(['sidebar.nav.admin', 'main'], function* () {
      yield ctx.slots.register({ name: 'sidebar.nav.admin', id: 'usage.nav', priority: 50 }, UsageNav)
      yield ctx.slots.register(
        { name: 'main', id: 'usage', select: (path) => (path === '/usage' ? { title: t('用量统计', 'Usage') } : null) },
        UsagePage,
      )
    })
  },
}
