import type { Context } from '@deepseek-ai/cordis'

/**
 * 账单屏。
 *
 * 与引擎**完全无关**：订阅、席位、发票、充值都是产品层的事。做多租户时它整屏
 * 归 gateway。这里给出形状，不给出后端。
 */
export const name = 'satu-view-billing'
export const inject = ['client', 'server']

export function apply(ctx: Context) {
  ctx.client.register({ id: 'billing', entry: new URL('./client.js', import.meta.url) })

  ctx.server.get('/api/billing', async (req, res) =>
    res.json({
      mock: true,
      plan: { name: '团队版', status: '生效中', cycle: '按年', seats: '10 个席位', period: '2026-01-01 — 2026-12-31', renew: '2027-01-01', amount: '$1,150 / 年', autoRenew: true },
      invoices: [
        { id: 'in1', period: '2026 年度', amount: '$1,150.00', status: '已支付', paid: '2026-01-02' },
        { id: 'in2', period: '2025 年度', amount: '$980.00', status: '已支付', paid: '2025-01-03' },
        { id: 'in3', period: '2024 年度', amount: '$980.00', status: '已支付', paid: '2024-01-05' },
      ],
      balance: { amount: '$286.40', spentThisMonth: '$286.40', alertAt: '$50.00' },
      topups: [
        { id: 't1', time: '2026-08-01', amount: '$500.00', method: '对公转账', status: '已到账' },
        { id: 't2', time: '2026-06-14', amount: '$500.00', method: '信用卡', status: '已到账' },
      ],
    }),
  )
}
