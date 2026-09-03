/**
 * 0029 · Telegram 改成长轮询，并且先配对身份再放消息进模型。
 *
 * 0028 的 Webhook 字段暂时保留，避免改写已经应用过的迁移；新代码不再使用它们。
 */
export const SQL = `
  alter table channel_bindings
    add column if not exists "pairingCodeHash" text not null default '',
    add column if not exists "pollOffset" bigint not null default 0,
    add column if not exists "pollLeaseUntil" bigint,
    add column if not exists "lastPolledAt" bigint;

  create index if not exists channel_binding_poll_due
    on channel_bindings (kind, status, "pollLeaseUntil", "updatedAt");

  create table if not exists channel_identities (
    id                    text primary key,
    "bindingId"           text not null references channel_bindings(id) on delete cascade,
    "externalUserId"      text not null,
    "externalUsername"    text not null default '',
    "externalDisplayName" text not null default '',
    "pairedEventId"       text not null,
    "pairedAt"            bigint not null,
    "lastSeenAt"          bigint not null
  );
  create unique index if not exists channel_identity_binding_user
    on channel_identities ("bindingId", "externalUserId");
  create index if not exists channel_identity_binding
    on channel_identities ("bindingId", "pairedAt");
`
