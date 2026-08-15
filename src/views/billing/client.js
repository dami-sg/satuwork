import { html, icon, NavItem, useHost, useState, t } from '@satu/shell'

/** 账单：订阅与充值两个页签。 */

const ICON = ['M2 5h20a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M1 10h22']

function BillingNav({ ctx, path }) {
  return html`<${NavItem} ctx=${ctx} path=${path} href="/billing" icon=${icon(ICON)} label=${t('账单', 'Billing')} />`
}

function Notice({ text }) {
  return html`<div style="flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted-foreground);">${text}</div>`
}

function BillingPage({ ctx }) {
  const { data, error, loading } = useHost(ctx, '/api/billing')
  const [tab, setTab] = useState('sub')
  const [autoRenew, setAutoRenew] = useState(null)

  if (loading) return html`<${Notice} text=${t('载入中…', 'Loading…')} />`
  if (error) return html`<${Notice} text=${error.message} />`

  const plan = data.plan
  const renewing = autoRenew ?? plan.autoRenew

  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6);">
      <div style="max-width: 900px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-6);">

        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('账单', 'Billing')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('查看订阅状态、充值余额与历史账单。', 'Subscription status, credit balance, and past invoices.')}</p>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          ${[{ key: 'sub', label: t('订阅', 'Subscription') }, { key: 'topup', label: t('充值', 'Credits') }].map(
            (item) => html`
              <button key=${item.key} type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed=${String(tab === item.key)} onClick=${() => setTab(item.key)}>${item.label}</button>
            `,
          )}
        </div>

        ${tab === 'sub'
          ? html`
              <div style="display: flex; flex-direction: column; gap: var(--space-6);">
                <div class="satu-panel">
                  <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
                    <div>
                      <span class="satu-panel-title">${t('当前订阅', 'Current plan')}</span>
                      <div style="display: flex; align-items: baseline; gap: var(--space-2); margin-top: 6px;">
                        <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${plan.name}</span>
                        <span class="tag tag-accent-2">${plan.status}</span>
                      </div>
                      <p style="margin: 6px 0 0; font-size: 13px; color: var(--muted-foreground);">${plan.cycle} · ${plan.seats}</p>
                    </div>
                    <button type="button" class="btn btn-secondary" style="flex: none;" disabled title=${t('订阅体系还没做', 'Subscriptions are not built yet')}>${t('管理订阅', 'Manage plan')}</button>
                  </div>
                  <div class="satu-kv"><span>${t('当前周期', 'Current period')}</span><span>${plan.period}</span></div>
                  <div class="satu-kv"><span>${t('下次续订', 'Renews')}</span><span>${plan.renew}</span></div>
                  <div class="satu-kv"><span>${t('周期费用', 'Amount')}</span><span>${plan.amount}</span></div>
                  <div class="satu-toggleRow">
                    <div>
                      <div style="font-size: 13.5px; font-weight: 600;">${t('自动续订', 'Auto-renew')}</div>
                      <div style="font-size: 12px; color: var(--muted-foreground);">${t('到期日自动扣款并续期', 'Charge and renew on the due date')}</div>
                    </div>
                    <button type="button" class="satu-switch" aria-pressed=${String(renewing)} aria-label=${t('自动续订', 'Auto-renew')} onClick=${() => setAutoRenew(!renewing)}><span></span></button>
                  </div>
                </div>

                <div style="display: flex; flex-direction: column; gap: var(--space-3);">
                  <h2 style="font-size: 18px; margin: 0;">${t('订阅账单', 'Invoices')}</h2>
                  <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
                    <div class="satu-billhead">
                      <span>${t('账期', 'Period')}</span><span>${t('金额', 'Amount')}</span><span>${t('状态', 'Status')}</span><span>${t('付款时间', 'Paid')}</span><span></span>
                    </div>
                    ${data.invoices.map(
                      (b) => html`
                        <div class="satu-billrow" key=${b.id}>
                          <span style="font-size: 13.5px;">${b.period}</span>
                          <span style="font-size: 13.5px;">${b.amount}</span>
                          <span class="tag tag-accent-2">${b.status}</span>
                          <span style="font-size: 13px; color: var(--muted-foreground);">${b.paid}</span>
                          <div style="display: flex; align-items: center; gap: var(--space-3); justify-content: flex-end;">
                            <button type="button" class="satu-linkbtn" disabled title=${t('发票开具还没做', 'Invoicing is not built yet')}>${t('发票', 'Invoice')}</button>
                          </div>
                        </div>
                      `,
                    )}
                  </div>
                </div>
              </div>
            `
          : html`
              <div style="display: flex; flex-direction: column; gap: var(--space-6);">
                <div class="satu-panel">
                  <span class="satu-panel-title">${t('账户余额', 'Balance')}</span>
                  <div style="display: flex; align-items: baseline; gap: var(--space-3); margin-top: 6px;">
                    <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${data.balance.amount}</span>
                    <span style="font-size: 13px; color: var(--muted-foreground);">${t(`本月已用 ${data.balance.spentThisMonth}`, `${data.balance.spentThisMonth} used this month`)}</span>
                  </div>
                  <div class="satu-kv"><span>${t('余额预警线', 'Low-balance alert')}</span><span>${data.balance.alertAt}</span></div>
                  <div style="display: flex; gap: var(--space-2);">
                    <button type="button" class="btn btn-primary" disabled title=${t('支付还没接', 'Payments are not wired up')}>${t('充值', 'Add credits')}</button>
                    <button type="button" class="btn btn-secondary" disabled title=${t('支付还没接', 'Payments are not wired up')}>${t('设置预警', 'Set alert')}</button>
                  </div>
                </div>

                <div style="display: flex; flex-direction: column; gap: var(--space-3);">
                  <h2 style="font-size: 18px; margin: 0;">${t('充值记录', 'Credit history')}</h2>
                  <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
                    <div class="satu-billhead">
                      <span>${t('时间', 'Date')}</span><span>${t('金额', 'Amount')}</span><span>${t('状态', 'Status')}</span><span>${t('方式', 'Method')}</span><span></span>
                    </div>
                    ${data.topups.map(
                      (row) => html`
                        <div class="satu-billrow" key=${row.id}>
                          <span style="font-size: 13.5px;">${row.time}</span>
                          <span style="font-size: 13.5px;">${row.amount}</span>
                          <span class="tag tag-accent-2">${row.status}</span>
                          <span style="font-size: 13px; color: var(--muted-foreground);">${row.method}</span>
                          <span></span>
                        </div>
                      `,
                    )}
                  </div>
                </div>
              </div>
            `}

        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">
          ${t('账单与引擎无关，全是产品层的事——这一屏永远不会往 agent 那边挂后端。', 'Billing has nothing to do with the engine — this screen will never hang a backend off the agent side.')}
        </p>
      </div>
    </div>
  `
}

export default {
  name: 'satu-view-billing',
  inject: ['slots', 'host', 'router'],
  apply(ctx) {
    ctx.slots.inject(['sidebar.nav.admin', 'main'], function* () {
      yield ctx.slots.register({ name: 'sidebar.nav.admin', id: 'billing.nav', priority: 60 }, BillingNav)
      yield ctx.slots.register(
        { name: 'main', id: 'billing', select: (path) => (path === '/billing' ? { title: t('账单', 'Billing') } : null) },
        BillingPage,
      )
    })
  },
}
