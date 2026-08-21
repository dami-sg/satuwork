/**
 * 0010 · 机器自报的负载与日志占用。
 *
 * 心跳每 30 秒带一份上来（CPU、内存、各块盘、出网流量、journal 有多大），存**最近
 * 一份**，不建流水表：这一格要答的是「这台机器现在怎么样」，而按 30 秒一行存，一台
 * 机器一个月就是 8 万多行，换来的是一条谁也不会去查的曲线。真要看趋势，那是监控系统
 * 的活儿，不该顺手在这张表上长出来。
 *
 * `telemetryAt` 记的是 **Gateway 收到的时刻**，不是机器自报的采样时刻——机器的钟可能
 * 是歪的，而界面上那句「3 分钟前」必须准（同一个理由见 publicMachine 的 heartbeatAge）。
 *
 * `logCapMb` 是**期望值**，和 timezone、desiredManagerVersion 一样：写在这里只是下
 * 指令，真正清 journal 的是机器上的管家。空 = 没人指定过，跟管家的默认走；0 = 明确
 * 不要它动 journal。这两者不能合并——空当成 0 会把清理静默关掉。
 */
export const SQL = `
  alter table machines add column if not exists telemetry jsonb;
  alter table machines add column if not exists "telemetryAt" bigint;
  alter table machines add column if not exists "logCapMb" int;
`
