/**
 * 0025 · 删掉旧看板那七张表（见 docs/task-board.md §8、§14）。
 *
 * **不做数据迁移。** 旧卡是「人派给 Bot 的一件活」，新任务是「对话里被认出来的一件事」，
 * 两者不是同一个对象：旧卡没有 `sessionId`，迁过去就是一批点不进任何对话的僵尸条目，
 * 而「点进去看原话」是这块板唯一的可信来源（§10）。
 *
 * **删表的顺序按外键反着来**，`cascade` 只用在最后那两张上：一次显式的顺序比一串
 * `cascade` 好读——谁指着谁，下一个人一眼看得见。
 *
 * 卡的附件字节落在 gateway home 的 `kanban/` 下，这条迁移**不碰磁盘**：库里删干净之后
 * 那个目录就是一堆没人指向的字节，运维可以随时删，而一条迁移去 rm 一棵目录树，回滚的
 * 时候什么都补不回来。
 */
export const SQL = `
  drop table if exists card_runs;
  drop table if exists card_links;
  drop table if exists card_comments;
  drop table if exists card_files;
  drop table if exists cards;
  drop table if exists board_members;
  drop table if exists boards;
`
