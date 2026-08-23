/**
 * 公司的转人工通知地址（见 docs/handoff.md §6 第 3 层）。
 *
 * **为什么是 webhook 而不是邮件**：那一层要解决的是「浏览器关着」——半夜的日常任务
 * 卡住了，站内的红点没有任何人会看见。而 Gateway 现在没有 SMTP，为一条通知再养一套
 * 投递重试和退信处理不划算；员工自己装的 Gmail 连接器也不行，那把票只能以他本人的
 * 身份发，而收件人恰恰常常不是他。一条 URL 加一个 POST，够到的正是那个场景。
 *
 * 落在 companies 上而不是 settings 的 payload 里：那份 payload 是「日常/utility 模型」
 * 两个角色，`putSettings` 整份覆盖写——把一个不相干的字段塞进去，下次谁改模型就会把
 * 它清掉。
 */
export const SQL = `
  alter table companies add column if not exists "handoffWebhook" text;
`
