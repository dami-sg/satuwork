/**
 * Bot 模版：公司这一层从「一批共享的 Bot」收成**一份底座**，Bot 由员工自己建。
 *
 * 这条用例盯的是四件事，缺一条产品承诺就不成立：
 *
 *   1. 员工建得了 Bot，建出来只有他自己看得见
 *   2. 建出来的东西长在模版上——提示词、Skill、行为边界都不是他自己存的一份副本
 *   3. 模版一改，**已经建好的** Bot 下一次读就跟着变，且版本号 +1
 *   4. 员工改不动模版
 */
import { rmSync } from 'node:fs'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'

export async function runBotTemplate({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-tpl')
  // 端口向内核要（见 ports.mjs）：写死的数迟早撞上别的套件或别的 worktree。
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# bot-template')

  const gw = start('tpl-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_tpl'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      // 配额的下限就是 1，用它验「第 N+1 个被挡住」不必真建十个。
      GATEWAY_MAX_USER_BOTS: '2',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'tpl gateway' })

  let owner = ''
  let orgId = ''
  let admin = ''
  let alice = ''
  let bob = ''
  let aliceBot = ''

  const login = async (email, password) => {
    const r = await req(base, 'POST', '/auth/login', { body: { email, password } })
    assert(r.status === 200, `login ${email} ${r.status} ${r.text}`)
    return r.json.token
  }

  try {
    await test('建公司和两个员工', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@tpl.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201, `setup ${setup.status} ${setup.text}`)
      owner = setup.json.token

      const org = await req(base, 'POST', '/platform/orgs', {
        token: owner,
        body: {
          name: 'Tpl', slug: 'tpl-co',
          contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: 'z@tpl.test',
          adminEmail: 'a@tpl.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      orgId = org.json.company.id
      admin = await login('a@tpl.test', 'correct-horse-1')
      // 默认只有一席，管理员自己就占满了；这条用例要两个员工。
      const plan = await req(base, 'PUT', `/platform/orgs/${orgId}/plan`, { token: owner, body: { seats: 3 } })
      assert(plan.status === 200, `plan ${plan.status} ${plan.text}`)

      for (const email of ['alice@tpl.test', 'bob@tpl.test']) {
        const r = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
          token: admin, body: { email, password: 'correct-horse-1', role: 'member' },
        })
        assert(r.status === 201, `account ${email} ${r.status} ${r.text}`)
      }
      alice = await login('alice@tpl.test', 'correct-horse-1')
      bob = await login('bob@tpl.test', 'correct-horse-1')
    })

    await test('新公司自带一份 v1 模版，员工也读得到', async () => {
      const a = await req(base, 'GET', `/orgs/${orgId}/bot-template`, { token: admin })
      assert(a.status === 200, `模版 ${a.status} ${a.text}`)
      assert(a.json.template.version === 1, `version ${a.json.template.version}`)
      assert(a.json.template.prompt.length > 0, '默认模版没有提示词')
      // 员工建 Bot 那一屏要显示「你的 Bot 会继承这些」，读不到就等于蒙着眼建。
      const m = await req(base, 'GET', `/orgs/${orgId}/bot-template`, { token: alice })
      assert(m.status === 200, `员工读模版 ${m.status} ${m.text}`)
    })

    await test('员工建 Bot：底座来自模版，自己只填身份', async () => {
      const r = await req(base, 'POST', '/runtime/bots', {
        token: alice,
        body: { name: '回访助手', description: '跟进客户回访', extraPrompt: '回复里带上客户名。' },
      })
      assert(r.status === 201, `建 ${r.status} ${r.text}`)
      aliceBot = r.json.bot.id
      const bot = r.json.bot
      assert(bot.scope === 'user', `scope ${bot.scope}`)
      assert(bot.templateVersion === 1, `templateVersion ${bot.templateVersion}`)
      // 追加，不是覆盖：模版那段还在，自己那段接在后面。
      const tpl = await req(base, 'GET', `/orgs/${orgId}/bot-template`, { token: alice })
      assert(bot.prompt.startsWith(tpl.json.template.prompt), '模版的人设没打头')
      assert(bot.prompt.endsWith('回复里带上客户名。'), '自己那段没接上')
    })

    await test('只有自己看得见：别人的名册里没有，也拉不到详情', async () => {
      const mine = await req(base, 'GET', '/runtime/bots', { token: alice })
      assert(mine.status === 200 && (mine.json.bots || []).some((b) => b.id === aliceBot), 'Alice 看不到自己的 Bot')
      const his = await req(base, 'GET', '/runtime/bots', { token: bob })
      assert(!(his.json.bots || []).some((b) => b.id === aliceBot), 'Bob 看到了 Alice 的 Bot')
      const peek = await req(base, 'GET', `/runtime/bots/${aliceBot}`, { token: bob })
      assert(peek.status === 404, `Bob 拉到了 Alice 的 Bot：${peek.status}`)
      const patch = await req(base, 'PATCH', `/runtime/bots/${aliceBot}`, { token: bob, body: { name: '偷改' } })
      assert(patch.status === 404, `Bob 改得动 Alice 的 Bot：${patch.status}`)
      const del = await req(base, 'DELETE', `/runtime/bots/${aliceBot}`, { token: bob })
      assert(del.status === 404, `Bob 删得掉 Alice 的 Bot：${del.status}`)
    })

    await test('员工改不动模版', async () => {
      const r = await req(base, 'PUT', `/orgs/${orgId}/bot-template`, { token: alice, body: { prompt: '我说了算' } })
      assert(r.status === 403, `员工存模版拿到 ${r.status}`)
    })

    await test('管理员改模版：版本号 +1，已经建好的 Bot 下一次读就跟着变', async () => {
      const put = await req(base, 'PUT', `/orgs/${orgId}/bot-template`, {
        token: admin, body: { prompt: '你是 Tpl 公司的 AI 员工，先问清楚再动手。' },
      })
      assert(put.status === 200, `存 ${put.status} ${put.text}`)
      assert(put.json.template.version === 2, `version ${put.json.template.version}`)

      // **不做任何同步动作**，直接读那个早就建好的 Bot。
      const bot = await req(base, 'GET', `/runtime/bots/${aliceBot}`, { token: alice })
      assert(bot.status === 200, `读 ${bot.status} ${bot.text}`)
      assert(bot.json.bot.prompt.startsWith('你是 Tpl 公司的 AI 员工'), '底座没跟着换')
      assert(bot.json.bot.prompt.endsWith('回复里带上客户名。'), '自己那段被模版冲掉了')
      assert(bot.json.bot.templateVersion === 2, `templateVersion ${bot.json.bot.templateVersion}`)
    })

    await test('并发保存：带旧版本号的那次被 409 挡下，不静悄悄覆盖', async () => {
      const cur = (await req(base, 'GET', `/orgs/${orgId}/bot-template`, { token: admin })).json.template
      // 另一个管理员先落地一版。
      const first = await req(base, 'PUT', `/orgs/${orgId}/bot-template`, {
        token: admin, body: { version: cur.version, escalate: '甲改的' },
      })
      assert(first.status === 200, `第一次 ${first.status} ${first.text}`)
      // 乙手上还是老版本号：他这一次必须被拦下，否则甲的改动会不声不响地没了。
      const stale = await req(base, 'PUT', `/orgs/${orgId}/bot-template`, {
        token: admin, body: { version: cur.version, escalate: '乙改的' },
      })
      assert(stale.status === 409, `旧版本号拿到 ${stale.status} ${stale.text}`)
      const kept = await req(base, 'GET', `/orgs/${orgId}/bot-template`, { token: admin })
      assert(kept.json.template.escalate === '甲改的', `被覆盖了：${kept.json.template.escalate}`)
      // 看到新版本号之后再来一次就是「确认覆盖」，得放行。
      const retry = await req(base, 'PUT', `/orgs/${orgId}/bot-template`, {
        token: admin, body: { version: kept.json.template.version, escalate: '乙改的' },
      })
      assert(retry.status === 200 && retry.json.template.escalate === '乙改的', `重试 ${retry.status} ${retry.text}`)
      // 不带版本号的调用方（脚本）照旧直接覆盖，不强制。
      const noMatch = await req(base, 'PUT', `/orgs/${orgId}/bot-template`, { token: admin, body: { escalate: '脚本改的' } })
      assert(noMatch.status === 200, `不带版本号 ${noMatch.status} ${noMatch.text}`)
    })

    await test('公司不存在：模版三条路由都是 404，不是 500', async () => {
      const missing = '00000000-0000-4000-8000-000000000000'
      for (const [method, path, body] of [
        ['GET', `/orgs/${missing}/bot-template`, undefined],
        ['PUT', `/orgs/${missing}/bot-template`, { prompt: 'x' }],
        ['POST', `/orgs/${missing}/bot-template/redeploy`, {}],
      ]) {
        // owner 不属于任何公司，requireOrg 对他直接放行——挡下来的必须是公司这道检查。
        const r = await req(base, method, path, { token: owner, body })
        assert(r.status === 404, `${method} ${path} 拿到 ${r.status} ${r.text}`)
      }
    })

    await test('改 Bot 只收身份字段：提示词、能力一概不收', async () => {
      const r = await req(base, 'PATCH', `/runtime/bots/${aliceBot}`, {
        token: alice,
        body: { name: '回访助手 2', prompt: '我自己写的人设', skills: ['凭空一个 id'], greeting: '你好' },
      })
      assert(r.status === 200, `改 ${r.status} ${r.text}`)
      assert(r.json.bot.name === '回访助手 2', '名字没改上')
      assert(r.json.bot.greeting === '你好', '开场白没改上')
      assert(!r.json.bot.prompt.includes('我自己写的人设'), '员工把模版的人设改掉了')
      assert(r.json.bot.skills.length === 0, '员工给自己挂上了模版没给的能力')
    })

    await test('配额挡住第三个', async () => {
      const two = await req(base, 'POST', '/runtime/bots', { token: alice, body: { name: '第二个' } })
      assert(two.status === 201, `第二个 ${two.status} ${two.text}`)
      const three = await req(base, 'POST', '/runtime/bots', { token: alice, body: { name: '第三个' } })
      assert(three.status === 409, `第三个拿到 ${three.status}`)
      // 别人的额度各算各的。
      const his = await req(base, 'POST', '/runtime/bots', { token: bob, body: { name: 'Bob 的' } })
      assert(his.status === 201, `Bob 建 ${his.status} ${his.text}`)
    })

    await test('删掉自己的 Bot（没席位的那种直接删干净）', async () => {
      const del = await req(base, 'DELETE', `/runtime/bots/${aliceBot}`, { token: alice })
      assert(del.status === 200, `删 ${del.status} ${del.text}`)
      const gone = await req(base, 'GET', `/runtime/bots/${aliceBot}`, { token: alice })
      assert(gone.status === 404, `删完还在：${gone.status}`)
    })

    await test('没有席位的公司，「立即下发」是个空操作而不是报错', async () => {
      const r = await req(base, 'POST', `/orgs/${orgId}/bot-template/redeploy`, { token: admin, body: {} })
      assert(r.status === 200, `下发 ${r.status} ${r.text}`)
      assert(r.json.total === 0 && r.json.ok === 0, `下发结果 ${r.text}`)
      // 预算用完时没轮到的席位报在这里，界面照着它说「它们会自己跟上」。
      assert(Array.isArray(r.json.skipped), `回执里没有 skipped：${r.text}`)
      const nope = await req(base, 'POST', `/orgs/${orgId}/bot-template/redeploy`, { token: alice, body: {} })
      assert(nope.status === 403, `员工下发拿到 ${nope.status}`)
    })

    await test('审计里留下了模版的改动', async () => {
      const r = await req(base, 'GET', `/orgs/${orgId}/audit`, { token: admin })
      assert(r.status === 200, `审计 ${r.status} ${r.text}`)
      const events = r.json.events || r.json.items || []
      assert(events.some((e) => e.action === 'bot-template.update'), '模版改动没进审计')
      assert(events.some((e) => e.action === 'bot.create'), '建 Bot 没进审计')
    })
  } finally {
    gw.kill()
    // 自己的数据目录自己收：留下的话 /tmp 里会越攒越多，下一轮还会带着旧状态起。
    rmSync(GW_HOME, { recursive: true, force: true })
  }
}
