/**
 * 0035 · 同一条日常任务同一时刻最多一条 `running` 流水。
 *
 * 「试跑」按钮和调度器都是先查 `routineRunning` 再插流水，两步之间没有锁——并发点两下
 * 就会有两条 running 进同一个会话。把判据做进库里，插入撞上唯一索引就是「上一次还在跑」，
 * 路由和 tick 都不必再自己上锁。
 */
export const SQL = `
  create unique index if not exists routine_runs_one_running
    on routine_runs ("routineId") where status = 'running';
`
