/**
 * 0034 · 移除任务看板及对话任务抽取留下的三张表。
 *
 * 旧迁移不能回头改：已经部署的数据库会校验它们的 checksum。新装环境也按相同顺序先建、
 * 再删，保证新旧数据库最后落在同一个 schema 上。
 */
export const SQL = `
  drop table if exists task_extract_logs;
  drop table if exists task_events;
  drop table if exists tasks;
`
