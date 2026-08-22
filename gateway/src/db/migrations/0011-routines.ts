/**
 * 日常任务（routine）：一个 Bot 定时替人跑的一段指令，外加它每次跑的流水。
 *
 * 两张表一起建：只有 routine 没有流水的话，界面上「上一次跑成没跑成」就没有出处，
 * 而定时跑起来的东西**看不见结果等于没跑**——人不会为了确认它昨晚干了什么去翻聊天。
 *
 * 归属是 (accountId, botId) 这一对，和席位同一个粒度：日常任务要发消息进那个席位的
 * 会话，落在别人名下的 Bot 上就没有会话可发。所以它跟着人走，不是跟着公司走。
 */
export const SQL = `
  create table if not exists routines (
    id            text primary key,
    "botId"       text not null references catalog_items(id) on delete cascade,
    "accountId"   text not null references accounts(id) on delete cascade,
    "companyId"   text not null references companies(id) on delete cascade,
    name          text not null default '',
    instruction   text not null default '',
    -- 停用不是删除：人写好的指令和触发时间还在，只是不排下一次了。
    active        boolean not null default true,
    -- 触发器数组。现在只有 schedule 一种，形状见 lib/schedule.ts。
    triggers      jsonb not null default '[]',
    -- 下一次什么时候跑。**null = 不排**（停用、没有触发器、或者算不出来）。
    -- 调度器靠它一条 SQL 就能选出「到点的」，不用把所有 routine 拉出来逐个算。
    "nextRunAt"   bigint,
    "createdAt"   bigint not null,
    "updatedAt"   bigint not null
  );
  create index if not exists routine_pair on routines ("accountId", "botId");
  -- 调度器每半分钟扫一次，扫的就是这个条件。
  create index if not exists routine_due on routines ("nextRunAt") where active;

  create table if not exists routine_runs (
    id           text primary key,
    "routineId"  text not null references routines(id) on delete cascade,
    "botId"      text not null,
    "accountId"  text not null,
    "companyId"  text not null,
    -- 这一次是定时到点跑的，还是人点「试跑」跑的。
    trigger      text not null check (trigger in ('schedule', 'manual')),
    status       text not null check (status in ('running', 'ok', 'error')),
    -- 发进了哪个会话。有了它，界面上那一行才点得回聊天里去。
    "sessionId"  text,
    error        text,
    "startedAt"  bigint not null,
    "endedAt"    bigint
  );
  create index if not exists routine_run_of on routine_runs ("routineId", "startedAt" desc);
`
