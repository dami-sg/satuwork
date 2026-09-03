/** 0030 · 长轮询错误单独记录，避免一次成功轮询抹掉消息投递错误。 */
export const SQL = `
  alter table channel_bindings
    add column if not exists "pollLastError" text;
`
