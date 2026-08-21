/**
 * 0009 · 账本上那一列倍率换成 double precision。
 *
 * 0007 建表时用的是 `real`（float4）。float4 存不下 `1.2`：写进去再读出来是
 * `1.2000000476837158`，而这个值会原样经 `publicCharge` 出去，在计费明细里画成
 * 「倍率 ×1.2000000476837158」。`chargeUsageBy` 里那个「原价 = 成交额 ÷ 倍率」的
 * 除法也跟着带上这个误差。
 *
 * 倍率是**人手填出来的十进制**（配置屏上按 0.05 一档），不是测量值——存得下它才对。
 * e2e 里当时只用了倍率 2，float4 里恰好精确，所以一路绿灯。
 *
 * **为什么不回去改 0007。** `db/migrations/index.ts` 那条规矩：已经跑过的迁移不能改，
 * 改了下次起进程会被校验和拦下来（migrate.ts 会报「在应用之后被改过」）。这条分支上
 * 已经有开发库跑过 0007 了。
 *
 * 老行里那个 1.2000000476837158 转成 double 之后还是它——**存进去的时候精度就没了，
 * 转类型补不回来**。所以界面上那一步仍然要收一下小数位（pages-admin.js 的 trimNum）。
 */
export const SQL = `
  alter table usage_charges alter column multiplier type double precision;
`
