/**
 * 私有档 Skill：Bot 自己在会话里记下来的方法。
 *
 * **不新增 scope。** `scope = 'user'` 和 `accountId` 这一维早就在了（0002 加的，员工
 * 自建的 Bot 就长在上面），私有 Skill 用的是同一套，缺的只是「哪颗 Bot」——所以这里
 * 只加一列 `botId`，不动 scope 的取值范围。
 *
 * 列上**不加外键**：`botId` 指的是 `catalog_items` 里 kind='bot' 的那条，而目录项之间
 * 已经有一堆这种软引用（模版的 skills / mcps 列表存的也是 id 数组）。加了外键，删一颗
 * Bot 就会被它自己攒下的 Skill 挡住，而那时该做的是把 Skill 一起删掉，不是拒绝删 Bot。
 *
 * 索引按「这颗 Bot 的私有档」建，那正是 skillsFor 每分钟要查的那一条路。
 */
export const SQL = `
  alter table catalog_items add column if not exists "botId" text;
  create index if not exists catalog_seat_skills on catalog_items (kind, scope, "accountId", "botId");
`
