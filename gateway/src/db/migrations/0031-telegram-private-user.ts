/**
 * 0031 · Telegram 渠道收紧为一个绑定只有一个私聊用户。
 *
 * 业务代码本来会加锁再配对，但 0029 的唯一索引是 (bindingId, userId)，
 * 数据库自己仍允许同一绑定出现多个用户。这里把最后一道约束也补上。
 */
export const SQL = `
  update channel_bindings
     set config = jsonb_set(coalesce(config, '{}'::jsonb), '{allowGroups}', 'false'::jsonb, true)
   where kind = 'telegram';

  delete from channel_identities older
   using channel_identities newer
   where older."bindingId" = newer."bindingId"
     and (older."pairedAt", older.id) < (newer."pairedAt", newer.id);

  create unique index if not exists channel_identity_one_per_binding
    on channel_identities ("bindingId");
`
