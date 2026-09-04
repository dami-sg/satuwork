/**
 * 渠道回复里的转人工卡必须和正文一样可靠投递。
 *
 * 席位跑完到 Telegram 发按钮之间 Gateway 可能重启；只存在内存里会留下已开单、却没有
 * 任何处理入口的对话。保存本轮新开的卡，接管者就能原样补发。
 */
export const SQL = `
  alter table channel_events
    add column if not exists handoffs jsonb not null default '[]'::jsonb;
`
