import { SQL as m0001 } from './0001-initial.ts'

export interface Migration {
  /** 四位编号加短横线名字，例如 `0002-seat-labels`。排序就是执行顺序。 */
  id: string
  /** 给人看的一句话，写进 schema_migrations，出问题时日志里认得出是哪一条。 */
  name: string
  sql: string
}

/**
 * 全部迁移，**按编号升序**。
 *
 * ## 怎么加一条
 *
 * 1. 新建 `0002-<短名>.ts`，导出一个 `SQL`
 * 2. 在下面的数组末尾加一行
 * 3. 起一次进程，日志里会打出「已应用 0002-…」
 *
 * 不要改已经发出去的那些文件——校验和会在下次启动时把它拦下来（见 migrate.ts）。
 * 想撤销一条已发布的迁移，写新的一条把它改回去，不要回头编辑。
 *
 * ## 写迁移的两条规矩
 *
 * - **一条迁移一件事**，别把三张表的改动塞进一条。失败时只回滚这一条，粒度越细
 *   越好排查。
 * - **不要在迁移里写业务数据修补**，除非它和这次结构变更绑死（比如新加一列要有初值）。
 *   一次性的数据订正走脚本，那种活儿跑一次就完了，不该每个新库都跟着跑一遍。
 */
export const MIGRATIONS: Migration[] = [
  { id: '0001-initial', name: '初始 schema（编号迁移之前那段幂等脚本）', sql: m0001 },
]

/**
 * 编号必须唯一且升序。
 *
 * 两条分支各加一条迁移然后合并，很容易撞号或者插到中间——那样某些库会跳过一条，
 * 而且再也补不回来（`schema_migrations` 只按 id 查「跑过没有」）。这条检查在模块
 * 加载时跑，也就是进程起来的第一秒，而不是等到某个库上出事。
 */
for (let i = 1; i < MIGRATIONS.length; i++) {
  const prev = MIGRATIONS[i - 1].id
  const cur = MIGRATIONS[i].id
  if (cur <= prev) throw new Error(`迁移编号必须严格升序：${prev} 之后是 ${cur}`)
}
