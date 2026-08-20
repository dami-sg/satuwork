/**
 * 平台统计：窗口过滤、按公司/模型聚合、按单价折金额。
 *
 * 时间窗是前端按用户时区算好传进来的（from/to 毫秒），所以这里直接构造窗口，
 * 不去猜服务端会怎么切天。
 *
 * 金额这块要盯死两件事：倍率只影响报价不影响成本价；目录里没单价的模型不能
 * 悄悄按 $0 计入——那会让报表少算钱还看不出来。
 */
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { PG_URL } from './pg.mjs'

const SCHEMA = 'e2e_stats'

export async function runStats({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = '/tmp/satuwork-e2e-stats'
  const GW_PORT = 18880
  const base = `http://127.0.0.1:${GW_PORT}`

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# stats')

  const gw = start('stats-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: SCHEMA,
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
    },
  })
  await waitHttp(`${base}/health`, gw, 'stats gateway')

  const require = createRequire(`${gwRoot}/package.json`)
  const pg = require('pg')
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()
  await client.query(`set search_path to ${SCHEMA}`)

  const now = Date.now()
  const d = new Date()
  const startOfToday = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const DAY = 86400000
  const q = (from, to, companyId) =>
    `/platform/stats?from=${from}&to=${to}${companyId ? `&companyId=${encodeURIComponent(companyId)}` : ''}`

  try {
    let token = ''
    let orgId = ''
    let accountId = ''
    await test('种数据：一家公司、有价模型和无价模型各若干条调用', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@stats.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201, `setup ${setup.status} ${setup.text}`)
      token = setup.json.token

      const org = await req(base, 'POST', '/platform/orgs', {
        token,
        body: {
          name: 'Acme', slug: 'acme-stats',
          contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: 'z@stats.test',
          adminEmail: 'a@stats.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      orgId = org.json.company.id

      // 一个单价全 0 的自定义供应商：模拟 pi-ai 没收录价格的那类模型。
      const prov = await req(base, 'POST', '/platform/providers', {
        token,
        body: {
          id: 'noprice', name: 'NoPrice', baseUrl: 'https://noprice.test/v1', api: 'openai-completions',
          models: [{ id: 'free-model', name: 'Free', contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0 } }],
        },
      })
      assert(prov.status === 201, `provider ${prov.status} ${prov.text}`)

      const acc = await client.query(`select id from accounts where email = 'a@stats.test'`)
      accountId = acc.rows[0].id
      const insert = (id, provider, model, pt, ct, at) =>
        client.query(
          'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "createdAt") values ($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, accountId, orgId, provider, model, pt, ct, at],
        )
      // 「今天」的两条要落在 [startOfToday, now] 里。**不能写死 startOfToday + N 小时**：
      // 凌晨跑的时候那个时刻还没到，查询窗口是 [今天零点, 此刻]，行会被排除在外，
      // 于是这一套断言在 00:00–02:00 之间必然失败。往回退、并且不早于今天零点。
      const todayA = Math.max(startOfToday, now - 3600_000)
      const todayB = Math.max(startOfToday, now - 7200_000)
      // gpt-4.1 是 $2/1M 入、$8/1M 出。今天：1M 入 + 0.5M 出 = $2 + $4 = $6。
      await insert('s1', 'openai', 'gpt-4.1', 1_000_000, 500_000, todayA)
      // 10 天前：9M 入 + 9M 出 = $18 + $72 = $90。
      await insert('s2', 'openai', 'gpt-4.1', 9_000_000, 9_000_000, now - 10 * DAY)
      // 今天，没单价的模型。
      await insert('s3', 'noprice', 'free-model', 2_000_000, 1_000_000, todayB)
    })

    await test('今日：只数今天的，金额按单价折算', async () => {
      const r = await req(base, 'GET', q(startOfToday, now), { token })
      assert(r.status === 200, `${r.status} ${r.text}`)
      assert(r.json.totals.calls === 2, `调用数 ${r.json.totals.calls}`)
      assert(r.json.totals.promptTokens === 3_000_000, `输入 ${r.json.totals.promptTokens}`)
      assert(r.json.totals.completionTokens === 1_500_000, `输出 ${r.json.totals.completionTokens}`)
      assert(Math.abs(r.json.totals.costUsd - 6) < 1e-9, `成本价 ${r.json.totals.costUsd}，应当是 6`)
    })

    await test('近 7 天不含 10 天前那条；30 天窗口才含', async () => {
      const seven = await req(base, 'GET', q(startOfToday - 6 * DAY, now), { token })
      assert(seven.json.totals.calls === 2, `近 7 天 ${seven.json.totals.calls}`)
      const wide = await req(base, 'GET', q(now - 30 * DAY, now), { token })
      assert(wide.json.totals.calls === 3, `30 天 ${wide.json.totals.calls}`)
      assert(Math.abs(wide.json.totals.costUsd - 96) < 1e-9, `30 天成本价 ${wide.json.totals.costUsd}，应当是 96`)
    })

    await test('没单价的模型不按 $0 混进金额，要单独标出来', async () => {
      const r = await req(base, 'GET', q(startOfToday, now), { token })
      assert(r.json.unpricedModels.includes('noprice/free-model'), `没标出来：${JSON.stringify(r.json.unpricedModels)}`)
      assert(r.json.byCompany[0].unpricedCalls === 1, `未计价调用数 ${r.json.byCompany[0].unpricedCalls}`)
      const m = r.json.byModel.find((x) => x.model === 'free-model')
      assert(m && m.priced === false, '按模型那行没标 priced=false')
      // 它有 3M token，但一分钱都不该加进去。
      assert(Math.abs(r.json.totals.costUsd - 6) < 1e-9, '没单价的模型把金额算进去了')
    })

    await test('命中缓存的 token 按缓存读单价算，不按输入价', async () => {
      // 这条以前是错的：聚合 SQL 只 sum(promptTokens)/sum(completionTokens)，
      // llm_calls 里明明存着 cachedTokens 却没人汇总，于是整个提示词按输入价计。
      // 一个 Bot 一条长会话、系统提示词稳定，正是缓存命中率最高的形态——命中率越高
      // 账面越虚，而 quotedUsd 是报给公司的价。
      //
      // claude-haiku-4-5：输入 $1/1M、输出 $5/1M、缓存读 $0.1/1M（差十倍）。
      // 1M 提示词里 900k 命中缓存：
      //   对的：100k × $1 + 900k × $0.1 = $0.10 + $0.09 = $0.19
      //   错的：1M × $1                  = $1.00
      const at = now - 45 * DAY
      await client.query(
        'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "cachedTokens", "createdAt")' +
          ' values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        ['s-cache', accountId, orgId, 'anthropic', 'claude-haiku-4-5', 1_000_000, 0, 900_000, at],
      )
      // 自己的窗口，和上面几条互不打扰。
      const r = await req(base, 'GET', q(now - 50 * DAY, now - 40 * DAY), { token })
      assert(r.status === 200, `${r.status} ${r.text}`)
      assert(r.json.totals.calls === 1, `这个窗口应只有 1 条，实际 ${r.json.totals.calls}`)
      assert(r.json.totals.cachedTokens === 900_000, `缓存 token 没汇总：${r.json.totals.cachedTokens}`)
      assert(
        Math.abs(r.json.totals.costUsd - 0.19) < 1e-9,
        `成本价 ${r.json.totals.costUsd}，应当是 0.19（按输入价算会得到 1）`,
      )
      const m = r.json.byModel.find((x) => x.model === 'claude-haiku-4-5')
      assert(m && m.cachedTokens === 900_000, `按模型那行缺缓存 token：${JSON.stringify(m)}`)
    })

    await test('缓存 token 比提示词还多时按提示词封顶，不算出负的未命中量', async () => {
      // 脏数据防线：上游改口径、或者旧行没这一列的时候，不能算出负数把账拉低。
      const at = now - 46 * DAY
      await client.query(
        'insert into llm_calls (id, "accountId", "companyId", provider, model, "promptTokens", "completionTokens", "cachedTokens", "createdAt")' +
          ' values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        ['s-cache-bad', accountId, orgId, 'anthropic', 'claude-haiku-4-5', 100_000, 0, 999_000_000, at],
      )
      const r = await req(base, 'GET', q(now - 47 * DAY, now - 45.5 * DAY), { token })
      assert(r.json.totals.calls === 1, `窗口里应只有那条脏数据，实际 ${r.json.totals.calls}`)
      // 100k 全按缓存读价：100_000 × 0.1 / 1e6 = 0.01
      assert(Math.abs(r.json.totals.costUsd - 0.01) < 1e-9, `封顶后应是 0.01，实际 ${r.json.totals.costUsd}`)
      assert(r.json.totals.costUsd >= 0, '算出了负成本')
    })

    await test('倍率只影响报价，不动成本价', async () => {
      const put = await req(base, 'PUT', '/platform/settings', { token, body: { priceMultiplier: 1.5 } })
      assert(put.status === 200, `settings ${put.status} ${put.text}`)
      const r = await req(base, 'GET', q(startOfToday, now), { token })
      assert(r.json.multiplier === 1.5, `倍率 ${r.json.multiplier}`)
      assert(Math.abs(r.json.totals.costUsd - 6) < 1e-9, `成本价被倍率改了：${r.json.totals.costUsd}`)
      assert(Math.abs(r.json.totals.quotedUsd - 9) < 1e-9, `报价 ${r.json.totals.quotedUsd}，应当是 9`)
      await req(base, 'PUT', '/platform/settings', { token, body: { priceMultiplier: 1 } })
    })

    await test('按公司过滤；公司不存在是 404', async () => {
      const one = await req(base, 'GET', q(now - 30 * DAY, now, orgId), { token })
      assert(one.json.byCompany.length === 1, `过滤后 ${one.json.byCompany.length} 行`)
      assert(one.json.byCompany[0].companyId === orgId, '过滤到了别家')
      const bad = await req(base, 'GET', q(now - 30 * DAY, now, 'no-such-company'), { token })
      assert(bad.status === 404, `不存在的公司 ${bad.status}`)
    })

    await test('空窗口给 0，不报错', async () => {
      const r = await req(base, 'GET', q(now - 90 * DAY, now - 60 * DAY), { token })
      assert(r.status === 200, `${r.status} ${r.text}`)
      assert(r.json.totals.calls === 0 && r.json.byCompany.length === 0, `空窗口 ${JSON.stringify(r.json.totals)}`)
    })

    await test('只有 owner 能看；无票 401，公司管理员 403', async () => {
      const unauth = await req(base, 'GET', q(startOfToday, now))
      assert(unauth.status === 401, `无票 ${unauth.status}`)
      const login = await req(base, 'POST', '/auth/login', { body: { email: 'a@stats.test', password: 'correct-horse-1' } })
      const denied = await req(base, 'GET', q(startOfToday, now), { token: login.json.token })
      assert(denied.status === 403, `公司管理员 ${denied.status}`)
    })

    await test('from 不是数字要 400', async () => {
      const bad = await req(base, 'GET', '/platform/stats?from=昨天', { token })
      assert(bad.status === 400, `坏 from ${bad.status} ${bad.text}`)
    })
  } finally {
    try {
      await client.end()
    } catch {}
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
