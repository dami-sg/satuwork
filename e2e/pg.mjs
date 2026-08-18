/**
 * e2e 连的 PostgreSQL。
 *
 * 每个 Gateway 实例一个 schema（GATEWAY_PG_SCHEMA），起来时带 GATEWAY_PG_RESET=1
 * 把自己那份 drop 掉重建——各套用例互不干扰，也不用各自准备一个库。
 *
 *   docker compose up -d postgres
 */
export const PG_URL =
  process.env.E2E_DATABASE_URL || 'postgres://satuwork:satuwork@127.0.0.1:5434/satuwork'

/** 起 Gateway 前先探一下，省得每个子用例各报一次「连不上」。 */
export async function requirePg() {
  // pg 装在 gateway 包里，仓库根目录解析不到，从那边的 package.json 起解。
  const { createRequire } = await import('node:module')
  const require = createRequire(new URL('../gateway/package.json', import.meta.url))
  const pg = require('pg')
  const client = new pg.Client({ connectionString: PG_URL, connectionTimeoutMillis: 4000 })
  try {
    await client.connect()
    await client.query('select 1')
    await client.end()
  } catch (e) {
    throw new Error(
      `连不上 PostgreSQL（${PG_URL.replace(/\/\/[^@]*@/, '//')}）：${e.message}\n` +
        '先起库：docker compose up -d postgres\n' +
        '或用 E2E_DATABASE_URL 指到别处。',
    )
  }
}
