/**
 * 0012 · 机器负载按分钟归档。
 *
 * `machines.telemetry` 只有「现在怎么样」，答不了「今天忙不忙、下午那阵卡是几点」。
 *
 * 粒度是**一分钟一格**：心跳 30 秒一轮，所以一格通常并两笔。一台机器一天 1440 行、
 * 三十天四万多行——这是**为了看得见尖峰**付的代价。按小时归档的话，CPU 冲顶五分钟
 * 在均值里只剩 8%，而人来看这一页找的恰恰是那五分钟；分钟格里它是实打实的一根柱子。
 *
 * 只留 30 天（见 METRIC_RETENTION_MS）。再往前的回溯该去监控系统，不该指望这张顺带
 * 记的表——留得越久，这张表越像一个没人维护的时序库。
 *
 * ## 为什么存 sum 而不是 avg
 *
 * 每一轮心跳都要往当前那一格里累一笔。存平均值的话，累加就得「读出来、算新平均、
 * 写回去」——两轮心跳撞在一起（机器重连、或者两个 Gateway 进程）就会丢掉一笔。存
 * sum + samples，累加是纯 `+`，一条 `on conflict do update` 搞定，谁也不用读。
 *
 * ## 峰值单独存
 *
 * 一分钟里也可能一笔 5%、一笔 95%。`cpuMax` 不是从均值推出来的。
 *
 * ## 出网存的是「这一格走了多少字节」
 *
 * 不是计数器快照。机器自报的是开机以来的累计值，重启就归零；Gateway 拿相邻两轮心跳
 * 的差值往格子里加（倒退就当重启，那一笔不计），存进来的因此是**增量**，可以直接相
 * 加成一小时、一天的量。
 *
 * ## 时间是 UTC 整分
 *
 * 格子按 UTC 切，「今天」的边界由界面按浏览器时区去圈范围——同一份数据，谁在哪个
 * 时区看都对得上自己那本日历。存的时候就折成某个时区的话，换个时区看就全错位。
 */
export const SQL = `
  create table if not exists machine_metric_minutes (
    "machineId"   text   not null,
    "minuteStart" bigint not null,
    samples       int    not null default 0,
    "cpuSum"      double precision not null default 0,
    "cpuMax"      double precision not null default 0,
    "memSum"      double precision not null default 0,
    "memMax"      double precision not null default 0,
    "diskSum"     double precision not null default 0,
    "diskMax"     double precision not null default 0,
    "txBytes"     bigint not null default 0,
    "rxBytes"     bigint not null default 0,
    primary key ("machineId", "minuteStart")
  );
  create index if not exists machine_metric_minutes_time on machine_metric_minutes ("minuteStart");
`
