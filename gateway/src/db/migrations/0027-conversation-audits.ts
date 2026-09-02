/**
 * 0027 · 自动对话审计与删除前终审。
 *
 * 原始会话仍在席位 JSONL；这里保存的是有长度上限的结构化派生物、覆盖水位和删除状态。
 * Bot 外键刻意不建：Bot 删除之后，这些记录正是还要留下来的那一份。
 */
export const SQL = `
  alter table catalog_items add column if not exists "deletingAt" bigint;

  create table if not exists conversation_audit_batches (
    id                  text primary key,
    "companyId"         text not null,
    "accountId"         text not null,
    "botId"             text not null,
    "sessionId"         text not null,
    "deletionRequestId" text,
    kind                text not null check (kind in ('scheduled','pre_delete')),
    "windowStart"       bigint not null,
    "windowEnd"         bigint not null,
    timezone            text not null,
    "fromSeq"           bigint not null default 0,
    "toSeq"             bigint not null default 0,
    "eventCount"        integer not null default 0,
    "turnCount"         integer not null default 0,
    status              text not null check (status in ('queued','leased','processing','succeeded','empty','retry','dead')),
    attempts            integer not null default 0,
    "leaseUntil"        bigint,
    "nextTryAt"         bigint,
    "lastError"         text,
    "modelRole"         text not null check ("modelRole" in ('daily','utility')),
    provider            text not null,
    model               text not null,
    "reasoningEffort"   text not null default 'off',
    "promptVersion"     integer not null default 1,
    "redactionVersion"  integer not null default 1,
    "sourceHash"        text not null default '',
    "resultHash"        text not null default '',
    "createdAt"         bigint not null,
    "startedAt"         bigint,
    "completedAt"       bigint
  );
  create unique index if not exists conversation_audit_window
    on conversation_audit_batches ("accountId", "botId", kind, "windowStart", "windowEnd");
  create index if not exists conversation_audit_due
    on conversation_audit_batches (status, "nextTryAt", "createdAt");
  create index if not exists conversation_audit_company
    on conversation_audit_batches ("companyId", "windowEnd" desc, id desc);
  create index if not exists conversation_audit_deletion
    on conversation_audit_batches ("deletionRequestId", status)
    where "deletionRequestId" is not null;

  create table if not exists conversation_audit_items (
    id                   text primary key,
    "batchId"            text not null references conversation_audit_batches(id) on delete cascade,
    "companyId"          text not null,
    "accountId"          text not null,
    "botId"              text not null,
    "sessionId"          text not null,
    "botNameSnapshot"    text not null default '',
    "accountNameSnapshot" text not null default '',
    "itemKey"            text not null,
    "firstSeq"           bigint not null,
    "lastSeq"            bigint not null,
    "startedAt"          bigint,
    "endedAt"            bigint,
    "taskSummary"        text not null default '',
    timeline             jsonb not null default '[]'::jsonb,
    "userQuestion"       text not null default '',
    "modelAnswer"        text not null default '',
    "finalResult"        text not null default '',
    outcome              text not null check (outcome in ('completed','partial','failed','blocked','answered','unknown')),
    "modelScore"         integer,
    "scoreBreakdown"     jsonb not null default '{}'::jsonb,
    "scoreConfidence"    double precision,
    evidence             jsonb not null default '[]'::jsonb,
    "riskFlags"          jsonb not null default '[]'::jsonb,
    "createdAt"          bigint not null,
    "expiresAt"          bigint not null
  );
  create unique index if not exists conversation_audit_item_key
    on conversation_audit_items ("batchId", "itemKey", "firstSeq", "lastSeq");
  create index if not exists conversation_audit_item_company
    on conversation_audit_items ("companyId", "endedAt" desc, id desc);
  create index if not exists conversation_audit_item_pair
    on conversation_audit_items ("companyId", "accountId", "botId", "endedAt" desc, id desc);
  create index if not exists conversation_audit_expiry
    on conversation_audit_items ("expiresAt");

  create table if not exists bot_deletion_requests (
    id                   text primary key,
    "companyId"          text not null,
    "accountId"          text,
    "botId"              text not null,
    "botNameSnapshot"    text not null default '',
    "requestedBy"        text not null,
    status               text not null check (status in ('freezing','auditing','ready_to_purge','purging','completed','failed')),
    "cutoffAt"           bigint not null,
    "targetCount"        integer not null default 0,
    "auditedCount"       integer not null default 0,
    attempts             integer not null default 0,
    "nextTryAt"          bigint,
    "lastError"          text,
    orphans              jsonb not null default '[]'::jsonb,
    "requestedAt"        bigint not null,
    "auditCompletedAt"   bigint,
    "deletedAt"          bigint
  );
  create unique index if not exists bot_deletion_one_live
    on bot_deletion_requests ("botId")
    where status in ('freezing','auditing','ready_to_purge','purging','failed');
  create index if not exists bot_deletion_due
    on bot_deletion_requests (status, "nextTryAt", "requestedAt");
`
