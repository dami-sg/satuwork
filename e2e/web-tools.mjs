/**
 * 平台工具配置 + 席位网页工具 + 按次计价。
 *
 * 后端用 E2E_STUB_WEB=1 顶掉（见 gateway/src/web-tools.ts）：要验的是路由、鉴权、
 * 计量和计价这条链路，真打 Tavily 只会让这套测试随别人的限流一起随机失败。
 *
 * 盯死三件事：
 * 1. **业务失败必须是 200 + ok:false**，不是 4xx——席位那头要把它原样说给模型听。
 * 2. **金额是写行那一刻的快照**，改价不能追溯改动旧行。
 * 3. **密钥不回显**，配置接口只报「配没配」。
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { freePort } from './ports.mjs'

/** SSRF 闸跑在 gateway/e2e-web-guard.mjs 里——那几个函数是纯的，起一整套服务没必要。 */
function runGuardProbe(gwRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(gwRoot, 'e2e-web-guard.mjs')], {
      cwd: gwRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('__RESULT__'))
      if (code !== 0 || !line) return reject(new Error(`SSRF 探针退出 ${code}\n${err || out}`))
      resolve(JSON.parse(line.slice('__RESULT__'.length)))
    })
  })
}

const SCHEMA = 'e2e_webtools'

export async function runWebTools({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = '/tmp/satuwork-e2e-webtools'
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# web-tools')

  const gw = start('webtools-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
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
      E2E_STUB_WEB: '1',
    },
  })
  await waitHttp(`${base}/health`, gw, 'web-tools gateway')

  const require = createRequire(`${gwRoot}/package.json`)
  const pg = require('pg')
  const client = new pg.Client({ connectionString: PG_URL })
  await client.connect()
  await client.query(`set search_path to ${SCHEMA}`)

  const webCalls = async () =>
    (await client.query('select kind, backend, units, mils, "createdAt" from web_calls order by "createdAt"')).rows

  try {
    let token = ''
    let adminToken = ''
    let seatToken = ''

    await test('种数据：一家公司、一个员工席位', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@web.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201, `setup ${setup.status} ${setup.text}`)
      token = setup.json.token

      const org = await req(base, 'POST', '/platform/orgs', {
        token,
        body: {
          name: 'Acme', slug: 'acme-web',
          contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: 'z@web.test',
          adminEmail: 'a@web.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)

      const login = await req(base, 'POST', '/auth/login', {
        body: { email: 'a@web.test', password: 'correct-horse-1' },
      })
      assert(login.status === 200, `login ${login.status} ${login.text}`)
      adminToken = login.json.token

      const secrets = await client.query(
        `select s."accessToken" from account_secrets s join accounts a on a.id = s."accountId" where a.email = 'a@web.test'`,
      )
      seatToken = secrets.rows[0].accessToken
      assert(seatToken.startsWith('sat_'), `席位票不对：${seatToken}`)
    })

    await test('工具配置只有系统管理员看得见', async () => {
      const mine = await req(base, 'GET', '/platform/tools/web', { token })
      assert(mine.status === 200, `owner ${mine.status} ${mine.text}`)
      const theirs = await req(base, 'GET', '/platform/tools/web', { token: adminToken })
      assert(theirs.status === 403, `公司管理员拿到了 ${theirs.status}`)
      const put = await req(base, 'PUT', '/platform/tools/web', { token: adminToken, body: { searchBackend: 'tavily' } })
      assert(put.status === 403, `公司管理员改得动：${put.status}`)
    })

    await test('后端能力不匹配的组合存不进去', async () => {
      // duckduckgo 只会搜索。把它设成提取后端，等于让人配出一个必然报错的组合，
      // 然后到席位那边才发现。
      const bad = await req(base, 'PUT', '/platform/tools/web', { token, body: { extractBackend: 'duckduckgo' } })
      assert(bad.status === 400, `不支持提取的后端被接受了：${bad.status} ${bad.text}`)
      const badUrl = await req(base, 'PUT', '/platform/tools/web', { token, body: { searxngUrl: 'not-a-url' } })
      assert(badUrl.status === 400, `坏地址被接受了：${badUrl.status}`)
    })

    await test('还没配后端时，席位调用是 200 + ok:false，不是 4xx', async () => {
      const r = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: 'hello' } })
      assert(r.status === 200, `状态 ${r.status}，业务失败不该是 4xx`)
      assert(r.json.ok === false, `ok=${r.json.ok}`)
      assert(r.json.error.includes('工具配置'), `没指路该谁去哪配：${r.json.error}`)
      assert((await webCalls()).length === 0, '没配后端也记了一笔账')
    })

    await test('配后端与单价：密钥不回显，只报配没配', async () => {
      const cred = await req(base, 'POST', '/platform/credentials', {
        token,
        body: { provider: 'tavily', secret: 'tvly-e2e-never-leak' },
      })
      assert(cred.status === 201, `密钥 ${cred.status} ${cred.text}`)
      const saved = await req(base, 'PUT', '/platform/tools/web', {
        token,
        body: {
          searchBackend: 'tavily',
          extractBackend: 'tavily',
          pricing: { tavily: { search: 8, extract: 8 } },
        },
      })
      assert(saved.status === 200, `保存 ${saved.status} ${saved.text}`)
      assert(saved.json.web.searchBackend === 'tavily', `没存住：${JSON.stringify(saved.json.web)}`)
      assert(saved.json.web.pricing.tavily.search === 8, `单价没存住：${JSON.stringify(saved.json.web.pricing)}`)
      const tav = saved.json.backends.find((b) => b.id === 'tavily')
      assert(tav.configured === true, 'tavily 应当显示已配置')
      assert(!JSON.stringify(saved.json).includes('tvly-e2e-never-leak'), '配置接口把密钥回显了')
      // firecrawl 在名单里但没实现：界面上要能看见它「未接入」，而不是凭空少一项。
      const fire = saved.json.backends.find((b) => b.id === 'firecrawl')
      assert(fire && fire.implemented === false, 'firecrawl 应当列出来并标未接入')
    })

    await test('存模型配置不会把工具配置抹掉', async () => {
      // PUT /platform/settings 是整份覆盖上去的，不带着 webTools 就会顺手清空它。
      const s = await req(base, 'PUT', '/platform/settings', { token, body: { priceMultiplier: 1.2 } })
      assert(s.status === 200, `settings ${s.status} ${s.text}`)
      const after = await req(base, 'GET', '/platform/tools/web', { token })
      assert(after.json.web.searchBackend === 'tavily', '去模型配置存了一次，工具配置被抹了')
      assert(after.json.priceMultiplier === 1.2, `倍率 ${after.json.priceMultiplier}`)
    })

    await test('搜索：计价 = 单价 × 倍率，四舍五入到厘', async () => {
      const r = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: 'node 24' } })
      assert(r.json.ok === true, `搜索失败：${r.text}`)
      assert(r.json.hits.length === 2, `条数 ${r.json.hits.length}`)
      const rows = await webCalls()
      assert(rows.length === 1, `账目 ${rows.length} 条`)
      // 8 厘 × 1 次 × 1.2 = 9.6 → 10
      assert(rows[0].mils === 10, `金额 ${rows[0].mils}，应当是 10`)
      assert(rows[0].units === 1 && rows[0].kind === 'search', JSON.stringify(rows[0]))
    })

    await test('零结果也是正常返回，照样记一次调用', async () => {
      const r = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: 'empty thing' } })
      assert(r.json.ok === true && r.json.hits.length === 0, `不该是失败：${r.text}`)
      // 后端已经被调用过了，钱花了就得记——空结果不是「没调用」。
      assert((await webCalls()).length === 2, '零结果没记账')
    })

    await test('提取：部分失败不影响其余，units 只数抓成功的', async () => {
      const r = await req(base, 'POST', '/runtime/web/extract', {
        token: seatToken,
        body: { urls: ['https://a.test/1', 'https://a.test/2', 'https://a.test/fail', 'https://a.test/4', 'https://a.test/5'] },
      })
      assert(r.json.ok === true, `提取失败：${r.text}`)
      assert(r.json.pages.length === 5, `页数 ${r.json.pages.length}`)
      assert(r.json.pages.filter((p) => p.ok).length === 4, '成功页数不对')
      assert(r.json.pages[2].ok === false && r.json.pages[2].error.includes('404'), `失败页没写清楚：${JSON.stringify(r.json.pages[2])}`)
      const rows = await webCalls()
      const last = rows[rows.length - 1]
      assert(last.kind === 'extract' && last.units === 4, `units ${last.units}，失败那条不该算钱`)
      // 8 × 4 × 1.2 = 38.4 → 38
      assert(last.mils === 38, `金额 ${last.mils}，应当是 38`)
    })

    await test('后缀骗人的地址只收一次钱，也不把缓存那几条一起收了', async () => {
      // `.pdf` 结尾其实返回 HTML：先走文档探测（落空），再落回提取后端。
      // 旧实现用一个计数器倒推「命中缓存几条」，这一路会把它加两次，于是缓存命中
      // 被算成负数——一条 URL 收两份钱，同一次调用里真命中的那几条也跟着被收。
      await req(base, 'POST', '/runtime/web/extract', { token: seatToken, body: { urls: ['https://a.test/warm'] } })
      const before = (await webCalls()).length
      const r = await req(base, 'POST', '/runtime/web/extract', {
        token: seatToken,
        // 一条假 PDF（真打后端一次）+ 一条上面刚抓过的（命中缓存，免费）。
        body: { urls: ['https://a.test/fake-doc.pdf', 'https://a.test/warm'] },
      })
      assert(r.json.ok === true, r.text)
      const rows = await webCalls()
      assert(rows.length === before + 1, `记了 ${rows.length - before} 笔`)
      assert(rows[rows.length - 1].units === 1, `计费条数 ${rows[rows.length - 1].units}，应当只算那条真抓的`)
    })

    await test('文档记在 document 名下，按它自己那档价算', async () => {
      // PDF 是 Gateway 自己下的，提取后端一次都没被调用。记在 tavily 头上的话，
      // 统计里「按后端」那张表就在撒谎——而那张表正是用来看钱花在哪家的。
      const put = await req(base, 'PUT', '/platform/tools/web', {
        token,
        body: { pricing: { tavily: { search: 8, extract: 8 }, document: { search: 0, extract: 5 } } },
      })
      assert(put.status === 200, `定价 ${put.status} ${put.text}`)
      const doc = put.json.backends.find((b) => b.id === 'document')
      assert(doc && doc.selectable === false, 'document 不该是可选后端')

      const r = await req(base, 'POST', '/runtime/web/extract', { token: seatToken, body: { urls: ['https://a.test/real.pdf'] } })
      assert(r.json.ok === true, r.text)
      assert(r.json.pages[0].document?.base64, `没走文档那条路：${JSON.stringify(r.json.pages[0]).slice(0, 200)}`)
      const rows = await webCalls()
      const last = rows[rows.length - 1]
      assert(last.backend === 'document', `记在了 ${last.backend} 头上`)
      // 5 厘 × 1 条 × 1.2 = 6
      assert(last.units === 1 && last.mils === 6, `文档那笔：${JSON.stringify(last)}`)
    })

    await test('一次调用里网页和文档各按各的价，分开落账', async () => {
      const before = (await webCalls()).length
      const r = await req(base, 'POST', '/runtime/web/extract', {
        token: seatToken,
        body: { urls: ['https://a.test/mixed-page', 'https://a.test/mixed.pdf'] },
      })
      assert(r.json.ok === true, r.text)
      const rows = (await webCalls()).slice(before)
      assert(rows.length === 2, `该落两笔（网页一笔、文档一笔），实际 ${rows.length}`)
      const byBackend = Object.fromEntries(rows.map((x) => [x.backend, x]))
      assert(byBackend.tavily?.units === 1, `网页那笔：${JSON.stringify(byBackend.tavily)}`)
      assert(byBackend.document?.units === 1, `文档那笔：${JSON.stringify(byBackend.document)}`)
      // 8 × 1.2 = 9.6 → 10；5 × 1.2 = 6
      assert(byBackend.tavily.mils === 10 && byBackend.document.mils === 6, `金额：${JSON.stringify(rows)}`)
    })

    await test('参数越界当场说清楚，不发给后端', async () => {
      // 越界的两次一笔都不该有：调用前后账目条数必须一样。
      const before = (await webCalls()).length
      const many = await req(base, 'POST', '/runtime/web/extract', {
        token: seatToken,
        body: { urls: ['1', '2', '3', '4', '5', '6'].map((n) => `https://a.test/${n}`) },
      })
      assert(many.json.ok === false && many.json.error.includes('最多 5'), `没挡住 6 个地址：${many.text}`)
      const count = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: 'x', count: 50 } })
      assert(count.json.ok === false && count.json.error.includes('count'), `没挡住 count=50：${count.text}`)
      const after = (await webCalls()).length
      assert(after === before, `越界的调用记了账：多了 ${after - before} 条`)
    })

    await test('改单价不动旧账', async () => {
      const rowsBefore = await webCalls()
      const put = await req(base, 'PUT', '/platform/tools/web', {
        token,
        body: { pricing: { tavily: { search: 100, extract: 100 }, document: { search: 0, extract: 5 } } },
      })
      assert(put.status === 200, `改价 ${put.status}`)
      const rowsAfter = await webCalls()
      assert(
        rowsBefore.every((r, i) => r.mils === rowsAfter[i].mils),
        `改价把历史账改了：${JSON.stringify(rowsAfter.map((r) => r.mils))}`,
      )
      // 新的一笔按新价：100 × 1.2 = 120
      await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: 'after' } })
      const rows = await webCalls()
      assert(rows[rows.length - 1].mils === 120, `新价没生效：${rows[rows.length - 1].mils}`)
    })

    await test('自检不记账——那是管理员在验配置，不是公司在用', async () => {
      const before = (await webCalls()).length
      const r = await req(base, 'POST', '/platform/tools/web/test', { token, body: { kind: 'search' } })
      assert(r.status === 200 && r.json.ok === true, `自检 ${r.status} ${r.text}`)
      assert(r.json.count === 2, `自检结果条数 ${r.json.count}`)
      assert((await webCalls()).length === before, '自检记了账')
    })

    await test('缓存：同一次搜索 15 分钟内不再打后端，也不再记账', async () => {
      const before = (await webCalls()).length
      const first = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: '缓存这一条' } })
      assert(first.json.ok === true && first.json.cached !== true, '第一次就说是缓存')
      const second = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: '缓存这一条' } })
      assert(second.json.cached === true, '第二次没命中缓存')
      assert(second.json.mils === 0, `命中缓存还报了价：${second.json.mils}`)
      // 没打后端就没有这笔成本，记上去是虚报。
      assert((await webCalls()).length === before + 1, '命中缓存也记了账')
    })

    await test('缓存：提取命中的那几条不计费，没命中的照算', async () => {
      const urls = ['https://cache.test/1', 'https://cache.test/2']
      await req(base, 'POST', '/runtime/web/extract', { token: seatToken, body: { urls } })
      const before = await webCalls()
      // 一条命中缓存、一条是新的 → 只该按 1 条计费。
      const r = await req(base, 'POST', '/runtime/web/extract', {
        token: seatToken,
        body: { urls: ['https://cache.test/1', 'https://cache.test/3'] },
      })
      assert(r.json.ok === true, r.text)
      const rows = await webCalls()
      assert(rows.length === before.length + 1, `多记了账：${rows.length - before.length} 条`)
      assert(rows[rows.length - 1].units === 1, `计费条数 ${rows[rows.length - 1].units}，应当只算没命中的那一条`)
    })

    await test('公司配额：用满就拦住，且拦住的那次不记账', async () => {
      const used = (await webCalls()).filter((r) => r.companyId !== null).length || (await webCalls()).length
      // 把上限设成「已经用掉的次数」，下一次必然撞线。
      const put = await req(base, 'PUT', '/platform/tools/web', { token, body: { dailyLimit: used } })
      assert(put.status === 200 && put.json.web.dailyLimit === used, `配额没存住：${put.text}`)
      const r = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: '撞线' } })
      assert(r.status === 200 && r.json.ok === false, `没拦住：${r.text}`)
      assert(r.json.error.includes('用满'), `话没说清楚：${r.json.error}`)
      assert((await webCalls()).length === used, '被拦住的调用记了账')
      // 调高就该放行。
      await req(base, 'PUT', '/platform/tools/web', { token, body: { dailyLimit: 0 } })
      const ok = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: '放行' } })
      assert(ok.json.ok === true, `调高上限后仍然被拦：${ok.text}`)
    })

    await test('SearXNG：能选成搜索后端，实例不通时说的是「不通」不是「没结果」', async () => {
      const put = await req(base, 'PUT', '/platform/tools/web', {
        token,
        body: { searchBackend: 'searxng', searxngUrl: 'http://127.0.0.1:19999' },
      })
      assert(put.status === 200, `选不上 SearXNG：${put.text}`)
      const r = await req(base, 'POST', '/runtime/web/search', { token: seatToken, body: { query: '打不通的实例' } })
      assert(r.json.ok === false, '实例不通却报成功')
      assert(!r.json.error.includes('没有结果'), `把「不通」说成了「没结果」：${r.json.error}`)
      // 内网地址是管理员明示的例外，闸不能把它一并拒了——那样自托管就没法用了。
      assert(!r.json.error.includes('内网'), `管理员填的自托管地址被 SSRF 闸拒了：${r.json.error}`)
      await req(base, 'PUT', '/platform/tools/web', { token, body: { searchBackend: 'tavily' } })
    })

    await test('统计里有网页那一块，金额直接求和不重算', async () => {
      const rows = await webCalls()
      const sum = rows.reduce((a, r) => a + r.mils, 0)
      const r = await req(base, 'GET', `/platform/stats?from=0&to=${Date.now() + 1000}`, { token })
      assert(r.status === 200, `stats ${r.status} ${r.text}`)
      assert(r.json.web, '统计里没有网页那一块')
      assert(r.json.web.totals.mils === sum, `金额 ${r.json.web.totals.mils}，账目求和是 ${sum}`)
      assert(r.json.web.byBackend.some((b) => b.backend === 'tavily'), '按后端那张表里没有 tavily')
      // token 那边的合计不能把网页的钱混进去——两者不是一个量纲。
      assert(r.json.totals.quotedUsd === 0 || !Number.isNaN(r.json.totals.quotedUsd), '模型合计被污染了')
    })

    await test('闸与限流：SSRF、跳转不带凭据、文档边读边数、DDG 排队', async () => {
      const g = await runGuardProbe(gwRoot)
      for (const group of ['scheme', 'private', 'publicOk', 'redirect', 'redirectCreds', 'docLimit', 'ddgThrottle']) {
        for (const [k, v] of Object.entries(g[group])) assert(v === true, `${group}.${k} 不成立`)
      }
    })

    await test('登录 JWT 打不了席位那两个口', async () => {
      const r = await req(base, 'POST', '/runtime/web/search', { token: adminToken, body: { query: 'x' } })
      assert(r.status === 401, `席位口收了登录票：${r.status}`)
    })
  } finally {
    await client.end().catch(() => {})
  }
}
