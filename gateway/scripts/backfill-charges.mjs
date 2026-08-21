/**
 * 把 `connector_calls` 和 `web_calls` 的历史金额翻成账本行（`usage_charges`）。
 *
 * **升级完立刻跑一次。** 从这个版本起，余额判定只看账本；不回填的话，一家公司此前
 * 在连接器和网页工具上花掉的钱会凭空消失，余额看着比实际多——直到有人发现为止。
 *
 * 为什么不写进迁移：这是一次性的数据订正，不是结构变更。
 * `db/migrations/index.ts` 里那条规矩说得很清楚——一次性的活儿走脚本，不该每个新库
 * 都跟着跑一遍。
 *
 * **可以重复跑。** 已经有账本行的流水会被跳过（按 refId 认），所以中途断了直接再来。
 *
 *   GATEWAY_DATABASE_URL=postgres://… node gateway/scripts/backfill-charges.mjs
 *   …… --dry-run 只报数，不写库
 */
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const pg = require('pg')

const url = (process.env.GATEWAY_DATABASE_URL || '').trim()
if (!url) {
  console.error('未配置 GATEWAY_DATABASE_URL')
  process.exit(1)
}
const schema = (process.env.GATEWAY_PG_SCHEMA || 'public').trim()
if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
  console.error(`不合法的 schema 名：${schema}`)
  process.exit(1)
}
const dry = process.argv.includes('--dry-run')

/** 一句人话就够。**不要让 pg 的原始堆栈成为这个脚本的错误界面**——那是给写它的人看的。 */
function die(msg) {
  console.error(msg)
  process.exit(1)
}

const client = new pg.Client({ connectionString: url })
try {
  await client.connect()
} catch (e) {
  die(`连不上数据库（${url.replace(/\/\/[^@]*@/, '//')}）：${e.message}\n先起库：docker compose up -d postgres`)
}
await client.query(`set search_path to "${schema}"`)

/**
 * 预检：库升到位了没有。
 *
 * **这一步不能省。** 顺序是「升级、起一次进程把迁移跑掉，然后才回填」，而顺序搞反
 * 是最容易发生的事——那时脚本会撞上一个不存在的表，把 pg 的堆栈甩出来，而那堆栈里
 * 一个字都没说该干什么。
 */
const has = async (table) =>
  (await client.query('select to_regclass($1) as t', [`"${schema}".${table}`])).rows[0].t != null

// schema 压根不存在和「表还没建」是两回事，说反了会让人去起进程等一个永远不会好的东西。
const schemaExists = (await client.query('select 1 from information_schema.schemata where schema_name = $1', [schema])).rowCount
if (!schemaExists) {
  await client.end()
  die(`这个库里没有名叫 ${schema} 的 schema。用 GATEWAY_PG_SCHEMA 指对地方，或者确认 GATEWAY_DATABASE_URL 连的是哪个库。`)
}

if (!(await has('usage_charges'))) {
  await client.end()
  die(
    [
      `${schema} 这个 schema 里还没有 usage_charges 这张表——库没升到位。`,
      '',
      '顺序是：先起一次 Gateway（迁移在进程启动时自己跑掉），再回填。',
      '  cd gateway && pnpm dev        # 或者你平时怎么起就怎么起',
      '起完看日志里那句「已应用 N 条迁移」，认得出 0007-usage-charges 就可以回来跑这个脚本了。',
      '',
      `如果你要回填的不是 ${schema}，用 GATEWAY_PG_SCHEMA 指过去。`,
    ].join('\n'),
  )
}
// 这两张是老表，正常一定在。不在说明 schema 指错了，早说比查出一半再说好。
for (const t of ['connector_calls', 'web_calls', 'llm_calls']) {
  if (!(await has(t))) {
    await client.end()
    die(`${schema} 里没有 ${t}——schema 多半指错了（当前 GATEWAY_PG_SCHEMA=${schema}）。`)
  }
}

/** 一次插一批，别一行一个往返。 */
const BATCH = 500

async function insertAll(rows) {
  if (dry || !rows.length) return
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    const values = []
    const args = []
    for (const r of slice) {
      const base = args.length
      values.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14})`)
      args.push(
        randomUUID(), r.companyId, r.accountId, r.botId ?? null, r.kind, r.subject, r.status,
        JSON.stringify(r.quantity ?? {}), JSON.stringify(r.unitPrice ?? {}), r.multiplier ?? 1,
        r.amountMicros, r.bonusMicros, r.refId, r.createdAt,
      )
    }
    await client.query(
      `insert into usage_charges (id, "companyId", "accountId", "botId", kind, subject, status, quantity, "unitPrice", multiplier, "amountMicros", "bonusMicros", "refId", "createdAt") values ${values.join(',')}`,
      args,
    )
  }
}

// ── 连接器 ────────────────────────────────────────────────────────────
//
// 老行的金额和分桶都在 connector_calls 上，原样搬过去——**不重算**。重算要用今天的
// 单价，而这些调用是按当时的单价收过钱的（docs/billing.md §2）。
const conn = await client.query(`
  select c.* from connector_calls c
  left join usage_charges u on u."refId" = c.id
  where u.id is null
  order by c."createdAt"
`)
const connRows = conn.rows.map((r) => ({
  companyId: r.companyId,
  accountId: r.accountId,
  botId: r.botId,
  kind: 'connector',
  subject: `${r.connector}:${r.tool}`,
  status: r.status,
  quantity: {},
  // 老行没留单价快照，只留了总额。倒推一个 unit 出来比留空强：金额是按次收的，
  // 一次就是一个 unit。
  unitPrice: { unit: Number(r.amountMicros) || 0 },
  multiplier: 1,
  amountMicros: Number(r.amountMicros) || 0,
  bonusMicros: Number(r.bonusMicros) || 0,
  refId: r.id,
  createdAt: Number(r.createdAt),
}))
await insertAll(connRows)

// ── 网页工具 ──────────────────────────────────────────────────────────
//
// web_calls 记的是**厘**，账本是微元：×1000。这是两套单位并存唯一要换算的地方。
//
// 老行没有分桶（那时网页工具压根不扣余额），全部算充值承担——保守的那一侧：
// 把历史花费算成吃了充值，只会让余额偏小，不会让人白花钱（同迁移 0005 的取舍）。
const web = await client.query(`
  select w.* from web_calls w
  left join usage_charges u on u."refId" = w.id
  where u.id is null
  order by w."createdAt"
`)
const webRows = web.rows.map((r) => ({
  companyId: r.companyId,
  accountId: r.accountId,
  botId: null,
  kind: 'web',
  subject: `${r.backend}:${r.kind}`,
  status: 'ok',
  quantity: { units: Number(r.units) || 0 },
  unitPrice: { unit: Number(r.units) > 0 ? Math.round((Number(r.mils) * 1000) / Number(r.units)) : 0 },
  multiplier: 1,
  amountMicros: (Number(r.mils) || 0) * 1000,
  bonusMicros: 0,
  refId: r.id,
  createdAt: Number(r.createdAt),
}))
await insertAll(webRows)

// ── 模型 ──────────────────────────────────────────────────────────────
//
// **不回填金额。** 历史 llm_calls 上没有钱这个概念，按今天的单价折出来的数字不是
// 「当时收了多少」，而是「今天会收多少」——把它写进账本，等于凭空给每家公司记上一笔
// 从来没发生过的欠账。只报个数，让人知道有这么一段账本上是空的。
const llm = await client.query('select count(*)::int as n from llm_calls')

console.log(
  [
    dry ? '【dry-run，没有写库】' : '已写入：',
    `连接器 ${connRows.length} 行`,
    `网页工具 ${webRows.length} 行（厘 ×1000 换成微元）`,
    `模型 ${llm.rows[0].n} 次历史调用**不回填**（当时没有金额，折算出来的不是成交价）`,
  ].join('\n  '),
)

await client.end()
