import { SQL as m0001 } from './0001-initial.ts'
import { SQL as m0002 } from './0002-bot-template.ts'
import { SQL as m0003 } from './0003-seed-bot-templates.ts'
import { SQL as m0004 } from './0004-connectors.ts'
import { SQL as m0005 } from './0005-connector-bonus-split.ts'
import { SQL as m0006 } from './0006-web-calls.ts'
import { SQL as m0007 } from './0007-usage-charges.ts'
import { SQL as m0008 } from './0008-llm-cache-write.ts'
import { SQL as m0009 } from './0009-multiplier-precision.ts'
import { SQL as m0010 } from './0010-machine-telemetry.ts'
import { SQL as m0011 } from './0011-routines.ts'

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
  { id: '0002-bot-template', name: 'Bot 模版层：bot-template 这一种、user 这一层、accountId', sql: m0002 },
  { id: '0003-seed-bot-templates', name: '每家公司种一份 Bot 模版，旧的公司 Bot 停用', sql: m0003 },
  { id: '0004-connectors', name: '连接器：catalog 的 connector 这一种、安装、连接、调用流水', sql: m0004 },
  { id: '0005-connector-bonus-split', name: '连接器流水按桶分账：这一笔吃了多少套餐赠送', sql: m0005 },
  // 分支上原本占的是 0002，和 main 撞了。**迁移的编号是身份**，撞号意味着两套库
  // 各自记着「0002 跑过了」却跑的是不同的东西，所以让路排到最后。
  { id: '0006-web-calls', name: '网页工具的按次计量表', sql: m0006 },
  { id: '0007-usage-charges', name: '计费账本：三条计费路唯一的钱', sql: m0007 },
  { id: '0008-llm-cache-write', name: 'llm_calls 记下缓存写的 token', sql: m0008 },
  { id: '0009-multiplier-precision', name: '账本的倍率换成 double precision', sql: m0009 },
  { id: '0010-machine-telemetry', name: '机器自报的负载与日志占用，以及日志上限', sql: m0010 },
  // 这条在分支上原本占的是 0010，和 main 上的机器遥测撞了（同 0006 那次）。**编号是
  // 身份**：撞号意味着两套库各自记着「0010 跑过了」，跑的却是不同的东西，所以让路排到
  // 最后。分支还没合进去，没有任何库应用过旧编号的这一条，改号是安全的。
  { id: '0011-routines', name: '日常任务：routine 定义与每次跑的流水', sql: m0011 },
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
