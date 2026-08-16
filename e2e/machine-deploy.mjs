/**
 * 公司机器绑定 + 席位 stub 部署。独立 home / 端口，不碰 live 3080。
 */
import { createHash } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

function linuxUserOf(accountId, botId) {
  return 'bot-' + createHash('sha256').update(`${accountId}\n${botId}`).digest('hex').slice(0, 12)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

export async function runMachineDeploy({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = '/tmp/satuwork-e2e-machine-gw'
  const GW_PORT = 18380
  const MACHINE_TOK = 'e2e-machine-deploy'
  const PLATFORM_TOK = 'e2e-platform-deploy'
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  const SSH_SECRET = 'SSH-SECRET-MUST-NOT-LEAK'
  const SSH_HOST = '10.8.0.21'

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# machine-deploy')

  const gw = start('machine-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_MACHINE_TOKEN: MACHINE_TOK,
      GATEWAY_PLATFORM_TOKEN: PLATFORM_TOK,
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@machine.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-machine',
      SATUWORK_DEPLOY_STUB: '1',
      SATUWORK_BOT_SRC: '/tmp/satuwork-e2e-missing-bot-src',
    },
  })
  await waitHttp(gwBase + '/health')

  try {
    const ownerLogin = await req(gwBase, 'POST', '/auth/login', {
      body: { email: 'owner@machine.test', password: 'test-owner-machine' },
    })
    assert(ownerLogin.status === 200, `owner ${ownerLogin.status} ${ownerLogin.text}`)
    const ownerTok = ownerLogin.json.token

    const reg = await req(gwBase, 'POST', '/auth/register', {
      body: {
        email: 'admin@machine.test',
        password: 'correct-horse',
        companyName: 'MachineCo',
        slug: 'machineco',
        seats: 3,
      },
    })
    assert(reg.status === 201, `register ${reg.status} ${reg.text}`)
    const adminTok = reg.json.token
    const orgId = reg.json.company.id

    const m1 = await req(gwBase, 'POST', `/orgs/${orgId}/accounts`, {
      token: adminTok,
      body: { email: 'member1@machine.test', password: 'correct-horse', role: 'member' },
    })
    assert(m1.status === 201, `member1 ${m1.status} ${m1.text}`)
    const memberId = m1.json.account.id
    const memberLogin = await req(gwBase, 'POST', '/auth/login', {
      body: { email: 'member1@machine.test', password: 'correct-horse' },
    })
    assert(memberLogin.status === 200, `member1 login ${memberLogin.status}`)
    const memberTok = memberLogin.json.token

    const m2 = await req(gwBase, 'POST', `/orgs/${orgId}/accounts`, {
      token: adminTok,
      body: { email: 'member2@machine.test', password: 'correct-horse', role: 'member' },
    })
    assert(m2.status === 201, `member2 ${m2.status} ${m2.text}`)
    const otherLogin = await req(gwBase, 'POST', '/auth/login', {
      body: { email: 'member2@machine.test', password: 'correct-horse' },
    })
    assert(otherLogin.status === 200, `member2 login ${otherLogin.status}`)
    const otherTok = otherLogin.json.token
    const member2Id = m2.json.account.id

    const botARes = await req(gwBase, 'POST', `/orgs/${orgId}/bots`, {
      token: adminTok,
      body: { name: '席位 Bot A' },
    })
    assert(botARes.status === 201, `botA ${botARes.status} ${botARes.text}`)
    const botA = botARes.json.bot.id
    const botBRes = await req(gwBase, 'POST', `/orgs/${orgId}/bots`, {
      token: adminTok,
      body: { name: '席位 Bot B' },
    })
    assert(botBRes.status === 201, `botB ${botBRes.status} ${botBRes.text}`)
    const botB = botBRes.json.bot.id

    await test('POST /runtime/deploy 没有 botId → 400', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: {} })
      assert(r.status === 400, `deploy ${r.status} ${r.text}`)
    })

    await test('成员未绑机器 POST /runtime/deploy → 409', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botA } })
      assert(r.status === 409, `deploy ${r.status} ${r.text}`)
      assert(String(r.json.error || r.text).includes('运行机器'), '409 文案')
    })

    await test('owner GET 成员 runtime 部署前 → 空数组', async () => {
      const r = await req(gwBase, 'GET', `/platform/orgs/${orgId}/accounts/${memberId}/runtime`, { token: ownerTok })
      assert(r.status === 200, `runtime ${r.status} ${r.text}`)
      assert(Array.isArray(r.json.runtimes) && r.json.runtimes.length === 0, 'empty runtimes')
    })

    await test('owner PUT 机器绑定；GET 有 hasSshAuth、无 sshSecret', async () => {
      const miss = await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machine`, {
        token: ownerTok,
        body: { sshUser: 'debian' },
      })
      assert(miss.status === 400, `create without host ${miss.status} ${miss.text}`)

      const put = await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machine`, {
        token: ownerTok,
        body: { sshHost: SSH_HOST, sshPort: 22, sshUser: 'debian', sshAuth: 'password', sshSecret: SSH_SECRET },
      })
      assert(put.status === 200, `put ${put.status} ${put.text}`)
      const dumped = JSON.stringify(put.json)
      assert(!dumped.includes('sshSecret'), 'PUT 响应含 sshSecret 键')
      assert(!dumped.includes(SSH_SECRET), 'PUT 响应含 SSH 秘密')
      assert(put.json.machine.hasSshAuth === true, 'hasSshAuth')
      assert(put.json.machine.sshHost === SSH_HOST, 'sshHost')
      assert(put.json.machine.sshUser === 'debian', 'sshUser')
      assert(typeof put.json.machine.token === 'string' && put.json.machine.token.startsWith('smt_'), 'owner PUT 应带 smt_')

      const get = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(get.status === 200, `get ${get.status} ${get.text}`)
      const body = JSON.stringify(get.json)
      assert(!body.includes('sshSecret'), 'GET 响应含 sshSecret 键')
      assert(!body.includes(SSH_SECRET), 'GET 响应含 SSH 秘密')
      assert(get.json.machine.hasSshAuth === true, 'GET hasSshAuth')
      assert(get.json.machine.sshHost === SSH_HOST, 'GET sshHost')
      assert(typeof get.json.machine.token === 'string' && get.json.machine.token.startsWith('smt_'), 'owner GET 应带 smt_')
    })

    await test('owner 不能 POST /runtime/deploy 也不能 GET /runtime/desktop', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: ownerTok, body: { botId: botA } })
      assert(r.status === 403, `owner deploy ${r.status} ${r.text}`)
      const d = await req(gwBase, 'GET', '/runtime/desktop?botId=' + encodeURIComponent(botA), { token: ownerTok })
      assert(d.status === 403, `owner desktop ${d.status} ${d.text}`)
    })

    await test('部署前没有发布版本 → 409 还没有发布 Bot 版本', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botA } })
      assert(r.status === 409, `deploy ${r.status} ${r.text}`)
      assert(String(r.json.error || r.text).includes('还没有发布 Bot 版本'), '409 文案')
    })

    await test('owner POST /platform/bot-releases 0.1.0；GET 列表最新', async () => {
      const post = await req(gwBase, 'POST', '/platform/bot-releases', {
        token: ownerTok,
        body: { version: '0.1.0', note: 'e2e' },
      })
      assert(post.status === 200, `publish ${post.status} ${post.text}`)
      const rel = post.json.release
      assert(rel && rel.version === '0.1.0', 'version')
      assert(typeof rel.sha256 === 'string' && rel.sha256.length === 64, 'sha256')
      assert(typeof rel.size === 'number' && rel.size > 0, 'size')
      assert(!JSON.stringify(post.json).includes('\x1f\x8b'), 'POST 含 gzip 字节')
      const list = await req(gwBase, 'GET', '/platform/bot-releases', { token: ownerTok })
      assert(list.status === 200, `list ${list.status} ${list.text}`)
      assert(list.json.latest === '0.1.0', `latest ${list.json.latest}`)
      assert(Array.isArray(list.json.releases) && list.json.releases[0]?.version === '0.1.0', 'releases newest')
      assert(typeof list.json.releases[0].sha256 === 'string', 'list sha256')
      assert(typeof list.json.releases[0].size === 'number', 'list size')
      assert(list.text.length < 100_000, 'list 太大，可能含文件字节')
      const one = await req(gwBase, 'GET', '/platform/bot-releases/0.1.0', { token: ownerTok })
      assert(one.status === 200, `one ${one.status} ${one.text}`)
      assert(one.json.release.version === '0.1.0', 'one version')
      assert(one.json.release.sha256 === rel.sha256, 'one sha256')
    })

    await test('stub 部署 botA：linuxUser/slot 0 端口公式，无 CDP', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botA } })
      assert(r.status === 200, `deploy ${r.status} ${r.text}`)
      const expectedUser = linuxUserOf(memberId, botA)
      assert(r.json.botId === botA, `botId ${r.json.botId}`)
      assert(r.json.linuxUser === expectedUser, `linuxUser ${r.json.linuxUser} != ${expectedUser}`)
      assert(r.json.status === 'ready', `status ${r.json.status}`)
      assert(r.json.botVersion === '0.1.0', `botVersion ${r.json.botVersion}`)
      assert(typeof r.json.vncPassword === 'string' && r.json.vncPassword.length === 16, 'vncPassword 16')
      assert(r.json.novncUrl === `http://${SSH_HOST}:6081/vnc.html`, `novncUrl ${r.json.novncUrl}`)
      assert(r.json.display === 10, `display ${r.json.display}`)
      assert(r.json.vncPort === 5910, `vncPort ${r.json.vncPort}`)
      assert(r.json.novncPort === 6081, `novncPort ${r.json.novncPort}`)
      assert(!Object.prototype.hasOwnProperty.call(r.json, 'botPort'), '员工 JSON 不应含 botPort')
      assert(!Object.prototype.hasOwnProperty.call(r.json, 'slot'), '员工 JSON 不应含 slot')
      assert(!r.json.ports || r.json.ports.botPort == null, 'ports.botPort')
      assert(r.json.cdpPort == null, '员工 JSON 不应含 CDP 端口')
      assert(!r.json.ports || r.json.ports.cdpPort == null, 'ports 含 CDP')
      assert(!JSON.stringify(r.json).includes(SSH_SECRET), 'deploy 响应含 SSH 秘密')
      assert(!JSON.stringify(r.json).includes('sshSecret'), 'deploy 含 sshSecret')
    })

    await test('同一成员部署 botB → 不同 linuxUser、下一槽', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botB } })
      assert(r.status === 200, `deploy B ${r.status} ${r.text}`)
      const expectedUser = linuxUserOf(memberId, botB)
      assert(r.json.botId === botB, 'botId B')
      assert(r.json.linuxUser === expectedUser, `linuxUser ${r.json.linuxUser} != ${expectedUser}`)
      assert(r.json.linuxUser !== linuxUserOf(memberId, botA), 'botB 撞了 botA linuxUser')
      assert(r.json.display === 11, `display ${r.json.display}`)
      assert(r.json.vncPort === 5911, `vncPort ${r.json.vncPort}`)
      assert(r.json.novncPort === 6082, `novncPort ${r.json.novncPort}`)
      assert(!Object.prototype.hasOwnProperty.call(r.json, 'botPort'), 'botB botPort')
      assert(typeof r.json.vncPassword === 'string' && r.json.vncPassword.length === 16, 'vncPassword 16')
      assert(r.json.cdpPort == null, 'botB CDP')
    })

    await test('member2 部署 botA → 不同 linuxUser/槽', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: otherTok, body: { botId: botA } })
      assert(r.status === 200, `member2 deploy ${r.status} ${r.text}`)
      const expectedUser = linuxUserOf(member2Id, botA)
      assert(r.json.linuxUser === expectedUser, `linuxUser ${r.json.linuxUser}`)
      assert(r.json.linuxUser !== linuxUserOf(memberId, botA), '撞 member1 botA')
      assert(r.json.linuxUser !== linuxUserOf(memberId, botB), '撞 member1 botB')
      assert(r.json.display === 12, `display ${r.json.display}`)
      assert(r.json.vncPort === 5912, `vncPort ${r.json.vncPort}`)
      assert(r.json.novncPort === 6083, `novncPort ${r.json.novncPort}`)
      assert(!Object.prototype.hasOwnProperty.call(r.json, 'botPort'), 'member2 botPort')
    })

    await test('GET /runtime/desktop?botId= 本人能看到同一份密码', async () => {
      const r = await req(gwBase, 'GET', '/runtime/desktop?botId=' + encodeURIComponent(botA), { token: memberTok })
      assert(r.status === 200, `desktop ${r.status} ${r.text}`)
      assert(r.json.linuxUser === linuxUserOf(memberId, botA), 'linuxUser')
      assert(r.json.botId === botA, 'botId')
      assert(r.json.vncPassword && r.json.vncPassword.length === 16, 'vncPassword')
      assert(r.json.novncUrl === `http://${SSH_HOST}:6081/vnc.html`, 'novncUrl')
      const miss = await req(gwBase, 'GET', '/runtime/desktop', { token: memberTok })
      assert(miss.status === 400, `desktop no botId ${miss.status}`)
      const ownerRt = await req(gwBase, 'GET', `/platform/orgs/${orgId}/accounts/${memberId}/runtime`, { token: ownerTok })
      assert(ownerRt.status === 200, `owner rt ${ownerRt.status} ${ownerRt.text}`)
      assert(Array.isArray(ownerRt.json.runtimes), 'runtimes array')
      assert(ownerRt.json.runtimes.length === 2, `runtimes ${ownerRt.json.runtimes.length}`)
      const ids = ownerRt.json.runtimes.map((x) => x.botId).sort()
      assert(ids[0] === botA && ids[1] === botB || ids[0] === botB && ids[1] === botA, `bot ids ${ids}`)
      const a = ownerRt.json.runtimes.find((x) => x.botId === botA)
      assert(a.vncPassword === r.json.vncPassword, 'owner 看到的密码应与员工同一份')
      assert(a.linuxUser === r.json.linuxUser, 'linuxUser 绑定该 pair')
      assert(a.botVersion === '0.1.0', `owner botVersion ${a.botVersion}`)
      assert(a.cdpPort == null, 'owner JSON CDP')
      assert(!JSON.stringify(ownerRt.json).includes(SSH_SECRET), 'owner runtime 含 SSH 秘密')
    })

    await test('另一名成员不能读这份 runtime', async () => {
      const plat = await req(gwBase, 'GET', `/platform/orgs/${orgId}/accounts/${memberId}/runtime`, { token: otherTok })
      assert(plat.status === 403 || plat.status === 404, `other platform ${plat.status} ${plat.text}`)
      const desk = await req(gwBase, 'GET', '/runtime/desktop?botId=' + encodeURIComponent(botA), { token: otherTok })
      if (desk.status === 200) {
        assert(desk.json.linuxUser !== linuxUserOf(memberId, botA), 'other desktop 串了席位')
      } else {
        assert(desk.status === 404, `other desktop ${desk.status} ${desk.text}`)
      }
      assert(!JSON.stringify(desk.json).includes(SSH_SECRET), 'other desktop 含 SSH 秘密')
    })

    await test('owner GET /orgs/:id/accounts 列表含 runtimes 不含密码', async () => {
      const r = await req(gwBase, 'GET', `/orgs/${orgId}/accounts`, { token: ownerTok })
      assert(r.status === 200, `accounts ${r.status} ${r.text}`)
      const row = (r.json.members || []).find((m) => m.id === memberId)
      assert(row, '找不到成员')
      assert(Array.isArray(row.runtimes) && row.runtimes.length === 2, 'list runtimes')
      const a = row.runtimes.find((x) => x.botId === botA)
      assert(a && a.status === 'ready', 'list runtime A')
      assert(a.linuxUser === linuxUserOf(memberId, botA), 'list linuxUser')
      assert(a.botVersion === '0.1.0', `list botVersion ${a.botVersion}`)
      assert(a.novncUrl === `http://${SSH_HOST}:6081/vnc.html`, 'list novncUrl')
      assert(!JSON.stringify(row).includes('vncPassword'), '列表含 vncPassword')
      const dumped = JSON.stringify(r.json)
      assert(!dumped.includes(SSH_SECRET), 'accounts 含 SSH 秘密')
    })

    await test('再次 deploy 同一 pair 已 ready 返回当前 runtime', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botA } })
      assert(r.status === 200, `again ${r.status} ${r.text}`)
      assert(r.json.status === 'ready', 'still ready')
      assert(r.json.linuxUser === linuxUserOf(memberId, botA), 'same user')
      assert(r.json.display === 10, 'same slot')
    })

    await test('GET 机器 JSON 不含 sshSecret 标记串', async () => {
      const r = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(!JSON.stringify(r.json).includes(SSH_SECRET), 'secret leaked in GET machine')
      const orgMach = await req(gwBase, 'GET', `/orgs/${orgId}/machine`, { token: memberTok })
      assert(orgMach.status === 200, `org machine ${orgMach.status}`)
      assert(!JSON.stringify(orgMach.json).includes(SSH_SECRET), 'secret leaked in org machine')
      assert(!JSON.stringify(orgMach.json).includes('sshSecret') || JSON.stringify(orgMach.json.machine || {}).indexOf('sshSecret') < 0, 'org machine 含 sshSecret 键')
      assert(!Object.prototype.hasOwnProperty.call(orgMach.json.machine || {}, 'token'), 'org machine 带 token')
      assert(!JSON.stringify(orgMach.json).includes('smt_'), 'org machine 泄漏 smt_')
    })

    await test('空 sshSecret 保留原凭据', async () => {
      const r = await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machine`, {
        token: ownerTok,
        body: { sshHost: SSH_HOST, sshSecret: '' },
      })
      assert(r.status === 200, `keep ${r.status} ${r.text}`)
      assert(r.json.machine.hasSshAuth === true, 'still hasSshAuth')
      assert(!JSON.stringify(r.json).includes(SSH_SECRET), 'keep 响应含秘密')
    })

    await test('第二次 POST 同一版本 → 409', async () => {
      const r = await req(gwBase, 'POST', '/platform/bot-releases', {
        token: ownerTok,
        body: { version: '0.1.0' },
      })
      assert(r.status === 409, `dup ${r.status} ${r.text}`)
    })

    await test('发布 0.2.0 后成员 update deploy → botVersion 0.2.0', async () => {
      const pub = await req(gwBase, 'POST', '/platform/bot-releases', {
        token: ownerTok,
        body: { version: '0.2.0' },
      })
      assert(pub.status === 200, `publish 0.2.0 ${pub.status} ${pub.text}`)
      const r = await req(gwBase, 'POST', '/runtime/deploy', {
        token: memberTok,
        body: { botId: botA, version: '0.2.0', update: true },
      })
      assert(r.status === 200, `update deploy ${r.status} ${r.text}`)
      assert(r.json.botVersion === '0.2.0', `botVersion ${r.json.botVersion}`)
    })

    await test('owner POST /platform/orgs/:id/runtime/update 返回结果', async () => {
      const r = await req(gwBase, 'POST', `/platform/orgs/${orgId}/runtime/update`, {
        token: ownerTok,
        body: { version: '0.2.0' },
      })
      assert(r.status === 200, `update ${r.status} ${r.text}`)
      assert(r.json.version === '0.2.0', `version ${r.json.version}`)
      assert(Array.isArray(r.json.results), 'results')
      assert(r.json.results.length >= 2, `results ${r.json.results.length}`)
      for (const row of r.json.results) {
        assert(row.accountId && row.botId, `row ids ${JSON.stringify(row)}`)
        assert(row.botVersion === '0.2.0' || row.error, `row ${JSON.stringify(row)}`)
      }
      const ready = r.json.results.filter((x) => x.status === 'ready' && !x.error)
      assert(ready.length >= 1, 'no ready seats')
      assert(ready.every((x) => x.botVersion === '0.2.0'), 'versions match')
    })

    await test('SPA GET /releases 返回 html', async () => {
      const r = await req(gwBase, 'GET', '/releases')
      assert(r.status === 200, `spa /releases ${r.status}`)
      assert(String(r.text).includes('<!doctype html>') || String(r.text).includes('Satuwork'), 'spa html')
    })
  } finally {
    if (gw && !gw._exited) {
      try {
        gw.kill('SIGTERM')
      } catch {}
      await sleep(400)
      try {
        gw.kill('SIGKILL')
      } catch {}
    }
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
