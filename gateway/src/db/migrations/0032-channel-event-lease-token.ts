/**
 * 0032 · 渠道消息处理租约增加 fencing token。
 *
 * 只有当前持有 token 的 Gateway 才能续租或提交结果。配合业务层的短租约心跳，进程
 * 崩溃/热重启后几十秒即可接管；旧进程即使晚回来，也不能覆盖接管者已经写下的状态。
 */
export const SQL = `
  alter table channel_events
    add column if not exists "leaseToken" text not null default '';

  create index if not exists channel_event_lease_token
    on channel_events (id, "leaseToken")
    where status = 'processing';
`
