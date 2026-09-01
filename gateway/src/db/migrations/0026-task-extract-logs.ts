/**
 * 0026 · 任务抽取判定日志。
 *
 * `task_events` 只能解释一条已经存在的任务怎么变；它回答不了「这一轮为什么没有建任务」。
 * 判定日志因此独立成表，但仍只存结果、计数和 seq 范围，不存对话正文。
 */
export const SQL = `
  create table if not exists task_extract_logs (
    id             text primary key,
    "accountId"    text not null references accounts(id) on delete cascade,
    "companyId"    text not null references companies(id) on delete cascade,
    "botId"        text not null,
    "sessionId"    text not null,
    outcome         text not null check (outcome in ('created','updated','unchanged','no_task','skipped','failed')),
    reason           text not null,
    detail           text not null default '',
    "createdCount" integer not null default 0,
    "updatedCount" integer not null default 0,
    "taskCount"    integer not null default 0,
    "fromSeq"      bigint not null default 0,
    "toSeq"        bigint not null default 0,
    model            text not null default '',
    version          integer not null default 0,
    "createdAt"     bigint not null
  );
  create index if not exists task_extract_log_board
    on task_extract_logs ("accountId", "createdAt" desc, id desc);
  create index if not exists task_extract_log_bot
    on task_extract_logs ("accountId", "botId", "createdAt" desc, id desc);
`
