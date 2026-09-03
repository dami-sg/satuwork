/**
 * 0033 · 记住渠道事件最近发出的审批提示。
 *
 * Gateway 热重启后会重新接管 processing 事件。把短审批键和 Telegram message id 留在
 * 事件行上，接管者就不会为同一张仍在等待的审批重复发按钮。
 */
export const SQL = `
  alter table channel_events
    add column if not exists "approvalKey" text not null default '',
    add column if not exists "approvalMessageId" bigint;
`
