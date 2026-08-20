/**
 * 两个进程同时起来的时候，迁移会不会各跑一遍。
 *
 * 探针要 tsx 才 import 得了 `src/db/migrate.ts`，所以单独一个文件，由
 * `e2e/migrate.mjs` spawn 起来跑，结果打在 `__RESULT__` 那一行上。
 *
 * 这个场景在部署脚本里太容易出现了（滚动重启、compose up 两个副本、有人手滑跑了
 * 两次 start），而两个连接同时 `create table` 的报错很难看懂——所以要有一把
 * advisory lock，也要有这一条来钉住它。
 */
import { createRequire } from 'node:module'
import { migrate } from './src/db/migrate.ts'
import { MIGRATIONS } from './src/db/migrations/index.ts'

const require = createRequire(import.meta.url)
const pg = require('pg')

const url = process.env.E2E_DATABASE_URL || 'postgres://satuwork:satuwork@127.0.0.1:5434/satuwork'
const schema = process.env.E2E_MIGRATE_SCHEMA || 'e2e_migrate_race'

const out = {}

async function connect() {
  const c = new pg.Client({ connectionString: url })
  await c.connect()
  await c.query(`set search_path to ${schema}`)
  return c
}

const setup = new pg.Client({ connectionString: url })
await setup.connect()
await setup.query(`drop schema if exists ${schema} cascade`)
await setup.query(`create schema ${schema}`)

const a = await connect()
const b = await connect()
try {
  // 同时开跑。锁没生效的话，两条都会去建表——先到的建成功，后到的撞
  // "relation already exists"，或者两条都往 schema_migrations 里插同一个 id。
  const [ra, rb] = await Promise.all([migrate(a, schema), migrate(b, schema)])
  out.applied = [ra.applied, rb.applied]
  // 恰好一边跑了、另一边看到已经跑过了。谁先谁后不重要。
  // 两个进程同时起：该跑的那几条只能由**一边**跑完，另一边一条都不跑。
  // 写死「加起来等于 1」是把「只有一条迁移」当成了前提，加一条迁移就会假红。
  out.exactlyOneApplied =
    (ra.applied.length === 0) !== (rb.applied.length === 0) &&
    ra.applied.length + rb.applied.length === MIGRATIONS.length
  out.current = ra.current

  const rows = await setup.query(`select id from ${schema}.schema_migrations`)
  out.ledgerRows = rows.rows.length
  out.noDuplicate = rows.rows.length === MIGRATIONS.length

  const tables = await setup.query(
    'select count(*)::int as n from information_schema.tables where table_schema = $1',
    [schema],
  )
  out.tables = tables.rows[0].n

  // 锁真的放开了：第三个连接还能拿到它。拿不到就说明 finally 里那句没跑成，
  // 下一个起来的进程会永远卡在 pg_advisory_lock 上——那是最难查的一种「起不来」。
  const c = await connect()
  const got = await c.query('select pg_try_advisory_lock(hashtext($1)) as ok', ['probe'])
  out.lockReleased = Boolean(got.rows[0].ok)
  const third = await migrate(c, schema)
  out.thirdApplied = third.applied.length
  await c.end()
} finally {
  await a.end().catch(() => {})
  await b.end().catch(() => {})
  await setup.query(`drop schema if exists ${schema} cascade`).catch(() => {})
  await setup.end().catch(() => {})
}

console.log('__RESULT__' + JSON.stringify(out))
