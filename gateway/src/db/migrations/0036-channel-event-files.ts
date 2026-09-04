/**
 * 渠道回复要把这一轮产出的文件一起可靠投递。
 *
 * 只放 reply 不够：模型跑完到 Telegram 发完之间 Gateway 可能重启，接管者不能再跑一轮
 * 模型，也不能靠正文猜文件名。把体积很小的路径清单和 reply 放在同一行，重试时两样都在。
 */
export const SQL = `
  alter table channel_events
    add column if not exists files jsonb not null default '[]'::jsonb;
`
