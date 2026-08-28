/**
 * 日常任务跑砸了之后，自己再试三次：5 分钟、15 分钟、30 分钟，然后停。
 *
 * 定时任务失败最常见的原因是**那一刻够不着席位**——机器还没开、正在换版、网断了一
 * 分钟。这类事十有八九几分钟后自己就好了，而现在的行为是：这一天的日报没有了，等到
 * 明天九点再说。退避重试要的就是这一段。
 *
 * 两列，都挂在 `routines` 上而不是流水上：
 *
 * - `retryAt` —— 下一次重试的时刻。null = 没有欠着的重试（这是绝大多数时候的样子）。
 * - `retryCount` —— 这一串已经补跑过几次。到 3 就不再排。
 *
 * **为什么不放在 `routine_runs` 上**：那张表只留最近 50 条（`ROUTINE_RUNS_KEEP`），
 * 一条会被删掉的行不能拿来当调度状态；而且调度器每一轮要问的是「这条任务有没有欠着
 * 的重试」，问 `routines` 是一条带索引的等值查询，问流水得先按 routineId 找最后一条
 * 再看它的状态。
 *
 * 存量那几条落在 `retryAt = null, retryCount = 0` 上，也就是「没欠着重试」——它们过去
 * 的失败已经过去了，这次升级不该在启动那一刻给全网补跑一批。
 *
 * 流水那张表还要**放开 `trigger` 那道 check**：补跑的那几次记的是 `retry`，和到点、
 * 试跑并列（不并进 `schedule` 的理由见 `RoutineRunTrigger`）。少了这一句，代码这边
 * 一切正常，只有插流水那一下被库顶回来——而那条路上没人接得住，表现是「补跑一次都
 * 没发生过」。
 */
export const SQL = `
  alter table routines add column if not exists "retryAt" bigint;
  alter table routines add column if not exists "retryCount" integer not null default 0;
  create index if not exists routines_retry_at on routines ("retryAt") where "retryAt" is not null;
  alter table routine_runs drop constraint if exists routine_runs_trigger_check;
  alter table routine_runs add constraint routine_runs_trigger_check check (trigger in ('schedule', 'manual', 'retry'));
`
