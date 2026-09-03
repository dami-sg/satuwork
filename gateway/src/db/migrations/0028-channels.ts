/**
 * 0028 · 外部消息渠道。
 *
 * Gateway 只留渠道凭据的密文、远端会话标识和可靠投递状态；对话正文仍然落在席位的
 * session JSONL。channel_events 只保留完成投递所需的那一句，成功后由清理器删除。
 */
export const SQL = `
  create table if not exists channel_bindings (
    id                    text primary key,
    "companyId"           text not null,
    "accountId"           text not null,
    "botId"               text not null,
    kind                  text not null check (kind in ('telegram','wechat_official','wecom')),
    status                text not null check (status in ('binding','active','paused','error')),
    "externalBotId"       text not null,
    "externalUsername"    text not null default '',
    "credentialCiphertext" text not null,
    "webhookSecretHash"   text not null,
    "publicId"            text not null,
    config                jsonb not null default '{}'::jsonb,
    "lastReceivedAt"      bigint,
    "lastError"           text,
    "createdAt"           bigint not null,
    "updatedAt"           bigint not null
  );
  create unique index if not exists channel_binding_account_kind
    on channel_bindings ("accountId", kind);
  create unique index if not exists channel_binding_external
    on channel_bindings (kind, "externalBotId");
  create unique index if not exists channel_binding_public
    on channel_bindings ("publicId");
  create index if not exists channel_binding_company
    on channel_bindings ("companyId", "updatedAt" desc);

  create table if not exists channel_events (
    id                       text primary key,
    "bindingId"              text not null references channel_bindings(id) on delete cascade,
    "externalEventId"        text not null,
    "externalConversationId" text not null,
    "remoteUserId"           text not null default '',
    "remoteDisplayName"      text not null default '',
    title                    text not null default '',
    text                     text not null,
    status                   text not null check (status in ('pending','processing','ready','retry','delivered','dead')),
    attempts                 integer not null default 0,
    "nextTryAt"              bigint,
    "leaseUntil"             bigint,
    "sessionId"              text,
    reply                    text not null default '',
    "lastError"              text,
    "createdAt"              bigint not null,
    "updatedAt"              bigint not null,
    "deliveredAt"            bigint
  );
  create unique index if not exists channel_event_external
    on channel_events ("bindingId", "externalEventId");
  create index if not exists channel_event_due
    on channel_events (status, "nextTryAt", "leaseUntil", "createdAt");
  create index if not exists channel_event_conversation
    on channel_events ("bindingId", "externalConversationId", "createdAt");
`
