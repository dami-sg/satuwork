/**
 * 编号迁移。
 *
 * 这一套要答的是升级线上库时唯一要问的那几个问题：存量库能不能自动接上、
 * 跑过的会不会再跑一遍、有人回头改了已发布的迁移会怎样。
 *
 * **最要紧的是「存量库自动基线」那条**：生产库早就有全套表、但没有
 * `schema_migrations`。如果那种库上来就被当成空库、或者干脆报错停机，这套机制
 * 就是负收益——它要解决的正是这个场景。
 */
import { spawn } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { freePort } from './ports.mjs'

const SCHEMA = 'e2e_migrate'
const GW_HOME = '/tmp/satuwork-e2e-migrate'

/**
 * 0001 那段 SQL，直接从源码里读。
 *
 * 拿它来造一个「迁移机制之前的库」——那正是生产库现在的样子。写死一份副本的话，
 * 这条用例过几个月就会在测一个和线上无关的形状。
 */
function initialSql(gwRoot) {
  const src = readFileSync(join(gwRoot, 'src/db/migrations/0001-initial.ts'), 'utf8')
  // 从 `export const SQL = ` 之后那个反引号开始数——文件抬头的注释里也有反引号。
  const mark = 'export const SQL = `'
  const a = src.indexOf(mark)
  const b = src.lastIndexOf('`')
  if (a < 0 || b <= a) throw new Error('0001-initial.ts 里找不到那段模板字符串')
  return src.slice(a + mark.length, b)
}

/** 跑一个要 tsx 的探针，把它 `__RESULT__` 那一行解出来。 */
function runProbe(gwRoot, file) {
  return new Promise((ok, bad) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(gwRoot, file)], {
      cwd: gwRoot,
      env: { ...process.env, E2E_DATABASE_URL: PG_URL },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', bad)
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('__RESULT__'))
      if (code !== 0 || !line) return bad(new Error(`探针退出 ${code}\n${err || out}`))
      try {
        ok(JSON.parse(line.slice('__RESULT__'.length)))
      } catch (e) {
        bad(new Error(`探针输出解析失败：${e.message}\n${line}`))
      }
    })
  })
}

function waitExit(child, ms = 20000) {
  return new Promise((ok, bad) => {
    if (child._exited) return ok(child._exited)
    const t = setTimeout(() => bad(new Error(`进程 ${ms}ms 内没退出，输出：\n${child._out}`)), ms)
    child.on('exit', (code, sig) => {
      clearTimeout(t)
      ok({ code, sig })
    })
  })
}

async function stop(child) {
  if (!child || child._exited) return
  try {
    child.kill('SIGTERM')
  } catch {}
  await waitExit(child, 5000).catch(() => {})
}

export async function runMigrate({ gwRoot, test, start, waitHttp, assert, log }) {
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`
  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# migrate')

  const require = createRequire(`${gwRoot}/package.json`)
  const pg = require('pg')
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()

  const fresh = async () => {
    await client.query(`drop schema if exists ${SCHEMA} cascade`)
    await client.query(`create schema ${SCHEMA}`)
    await client.query(`set search_path to ${SCHEMA}`)
  }
  const ledger = async () => {
    const r = await client.query('select id, name, checksum from schema_migrations order by id')
    return r.rows
  }
  /**
   * 代码里现在有哪几条迁移。**不写死条数**：每加一条新迁移都要回来改一遍断言的话，
   * 这套用例就会变成「加迁移的人顺手改绿」的橡皮图章。
   */
  const migrationIds = () => {
    const src = readFileSync(join(gwRoot, 'src/db/migrations/index.ts'), 'utf8')
    const body = src.slice(src.indexOf('MIGRATIONS: Migration[] = ['))
    return [...body.matchAll(/\{\s*id:\s*'([^']+)'/g)].map((m) => m[1])
  }

  /** 0001 之后那些迁移会新建哪些表。存量库那条用它算「只该多出这几张」。 */
  const laterTables = () => {
    const out = []
    for (const id of migrationIds().slice(1)) {
      const src = readFileSync(join(gwRoot, `src/db/migrations/${id}.ts`), 'utf8')
      for (const m of src.matchAll(/create table if not exists (\w+)/g)) out.push(m[1])
    }
    return out
  }

  const boot = (name) =>
    start(name, ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
      cwd: gwRoot,
      env: {
        SATUWORK_GATEWAY_HOME: GW_HOME,
        GATEWAY_DATABASE_URL: PG_URL,
        GATEWAY_PG_SCHEMA: SCHEMA,
        // **不设 GATEWAY_PG_RESET**：这一套要的就是「库里原来有什么」。
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: String(GW_PORT),
        GATEWAY_ACCESS_HOST: 'satuwork.com',
        GATEWAY_SEED_OWNER: '0',
      },
    })

  let gw
  try {
    await test('空库：把代码里的迁移全跑一遍并记上账', async () => {
      await fresh()
      gw = boot('migrate-fresh')
      await waitHttp(`${base}/health`)
      const ids = migrationIds()
      const rows = await ledger()
      assert(
        rows.map((r) => r.id).join() === ids.join(),
        `账本和代码里的迁移对不上：${JSON.stringify(rows.map((r) => r.id))} vs ${JSON.stringify(ids)}`,
      )
      assert(rows[0].id === '0001-initial', `第一条该是基线，实际 ${rows[0].id}`)
      assert(rows.every((r) => r.checksum && r.checksum.length === 16), `校验和形状不对：${JSON.stringify(rows)}`)
      // 表真的建出来了，不是只记了一行账。
      const t = await client.query(
        `select count(*)::int as n from information_schema.tables where table_schema = '${SCHEMA}' and table_name = 'companies'`,
      )
      assert(t.rows[0].n === 1, 'companies 表没建出来')
      assert(gw._out.includes(`已应用 ${ids.length} 条迁移`), `启动日志没说跑了哪几条：\n${gw._out.slice(-400)}`)
      await stop(gw)
    })

    await test('再起一次：不重复应用，日志说「已是最新」', async () => {
      gw = boot('migrate-again')
      await waitHttp(`${base}/health`)
      const rows = await ledger()
      assert(rows.length === migrationIds().length, `迁移被重复应用了：${JSON.stringify(rows)}`)
      assert(gw._out.includes('已是最新'), `没说「已是最新」：\n${gw._out.slice(-400)}`)
      await stop(gw)
    })

    /**
     * 这条是这套机制存在的理由。
     *
     * 生产库现在的样子：全套表都在，但没有 schema_migrations——它是被那段幂等脚本
     * 一次次跑出来的。带着迁移机制的新版本起上去时，必须自己认出「这库已经是 0001
     * 的形状了」，记一行账就走，**不能重建、更不能报错停机**。
     *
     * 靠的是 0001 本身幂等：在一个已经建满表的库上跑它等于空转。
     */
    await test('存量库：自动接上基线，数据一行不动', async () => {
      await fresh()
      // 造一个「迁移机制之前」的库：直接跑 0001 的 SQL，不建 schema_migrations。
      await client.query(initialSql(gwRoot))
      const before = await client.query('select count(*)::int as n from information_schema.tables where table_schema = $1', [SCHEMA])
      assert(before.rows[0].n > 10, `存量库该有一堆表，实际 ${before.rows[0].n}`)
      const has = await client.query(
        `select count(*)::int as n from information_schema.tables where table_schema = '${SCHEMA}' and table_name = 'schema_migrations'`,
      )
      assert(has.rows[0].n === 0, '造出来的存量库不该已经有 schema_migrations')

      // 塞一行真数据。迁移绝不能把它弄丢。
      const now = Date.now()
      await client.query(
        'insert into companies (id, slug, name, "createdAt", "updatedAt") values ($1,$2,$3,$4,$5)',
        ['co-legacy', 'legacy', '存量公司', now, now],
      )

      gw = boot('migrate-legacy')
      await waitHttp(`${base}/health`)
      const rows = await ledger()
      // 存量库认出「已经是 0001 的形状」记一行账，然后把 0001 之后那几条正常跑掉。
      assert(rows.map((r) => r.id).join() === migrationIds().join(), `没接上基线：${JSON.stringify(rows)}`)
      const kept = await client.query('select name from companies where id = $1', ['co-legacy'])
      assert(kept.rows.length === 1 && kept.rows[0].name === '存量公司', '存量数据被弄丢了')
      const after = await client.query('select count(*)::int as n from information_schema.tables where table_schema = $1', [SCHEMA])
      // 只该多出 schema_migrations，以及 0001 之后那几条迁移自己建的表——
      // 0001 在存量库上必须是空转，一张都不许重建。
      const expected = before.rows[0].n + 1 + laterTables().length
      assert(
        after.rows[0].n === expected,
        `表数量对不上：${before.rows[0].n} → ${after.rows[0].n}，预期 ${expected}`,
      )
      await stop(gw)
    })

    await test('已发布的迁移被改过：当场停机，不往下跑', async () => {
      // 库里记的校验和和代码算出来的对不上 = 有人回头编辑了已经跑过的迁移。
      // 继续跑只会在几百行之后报一个和真正原因毫无关系的错。
      await client.query(`update schema_migrations set checksum = 'deadbeefdeadbeef' where id = '0001-initial'`)
      const bad = boot('migrate-tampered')
      const exit = await waitExit(bad)
      assert(exit.code !== 0, `应该起不来，实际退出码 ${exit.code}`)
      assert(bad._out.includes('在应用之后被改过'), `报错没说清楚原因：\n${bad._out.slice(-600)}`)
      assert(bad._out.includes('0001-initial'), '报错没说是哪一条')
      // 失败时还要说清楚库停在哪儿——那是运维当场最想知道的一件事：
      // 升级挂了，库是升过的还是没升过的？回滚代码安不安全？
      assert(bad._out.includes('库停在'), `没报出库当前停在哪一号：\n${bad._out.slice(-600)}`)
    })

    await test('库比代码新：当场停机，别拿旧代码配新库', async () => {
      // 上一条把校验和改坏了。清空账本、借一次成功启动把真值写回去，
      // 这一条才是在测「库里有代码没有的编号」，而不是继续测上一条。
      await client.query(`delete from schema_migrations`)
      const ok = boot('migrate-restore')
      await waitHttp(`${base}/health`)
      await stop(ok)

      await client.query(
        'insert into schema_migrations (id, name, checksum, "appliedAt") values ($1,$2,$3,$4)',
        ['9999-from-the-future', '未来的迁移', '0'.repeat(16), Date.now()],
      )
      const bad = boot('migrate-rollback')
      const exit = await waitExit(bad)
      assert(exit.code !== 0, `应该起不来，实际退出码 ${exit.code}`)
      assert(bad._out.includes('但这份代码里没有'), `报错没说清楚原因：\n${bad._out.slice(-600)}`)
      assert(bad._out.includes('9999-from-the-future'), '报错没说是哪一条')
    })

    await test('两个进程同时起：迁移只跑一遍，锁还得放开', async () => {
      // 滚动重启、compose 起两个副本、有人手滑跑了两次 start——这个场景在部署脚本里
      // 太容易出现，而两个连接同时 create table 的报错很难看懂。
      const r = await runProbe(gwRoot, 'e2e-migrate-race.mjs')
      assert(r.exactlyOneApplied, `应该恰好一边跑了：${JSON.stringify(r.applied)}`)
      assert(r.noDuplicate, `schema_migrations 有 ${r.ledgerRows} 行，应该和代码里的条数一样（${migrationIds().length}）`)
      assert(r.tables > 10, `表没建全，只有 ${r.tables} 张`)
      // 锁没放开的话，下一个起来的进程会永远卡在 pg_advisory_lock 上——
      // 那是最难查的一种「起不来」：没有报错，就是不动。
      assert(r.lockReleased, 'advisory lock 没放开')
      assert(r.thirdApplied === 0, `第三次不该再跑，实际跑了 ${r.thirdApplied} 条`)
    })
  } finally {
    await stop(gw)
    try {
      await client.query(`drop schema if exists ${SCHEMA} cascade`)
    } catch {}
    try {
      await client.end()
    } catch {}
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
