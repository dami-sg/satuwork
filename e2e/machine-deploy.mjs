/**
 * 公司机器绑定 + 席位 stub 部署。独立 home / 端口，不碰 live 3080。
 */
import { createHash } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { publishRelease, sha256Of, tarGz } from './release.mjs'

/** 一个员工一个 Linux 账号——名下所有 bot 共用它。和 gateway/src/deploy.ts 保持一致。 */
function linuxUserOf(accountId) {
  return 'sw-' + createHash('sha256').update(accountId).digest('hex').slice(0, 12)
}

/** 席位标识：systemd 实例名与席位私有目录名。一个 bot 一个。 */
function seatIdOf(accountId, botId) {
  return linuxUserOf(accountId) + '-' + createHash('sha256').update(botId).digest('hex').slice(0, 12)
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
  let machineTok = ''

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# machine-deploy')

  const gw = start('machine-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: 'e2e_machine',
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_MACHINE_TOKEN: MACHINE_TOK,
      GATEWAY_PLATFORM_TOKEN: PLATFORM_TOK,
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@machine.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-machine',
      SATUWORK_DEPLOY_STUB: '1',
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

    await test('配对：owner 出码，机器换 smt_，一次性', async () => {
      // 还没配对时不给改地址——地址是配对的产物，不是配对的前提。
      const early = await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machine`, {
        token: ownerTok,
        body: { host: 'http://10.8.0.21:8443' },
      })
      assert(early.status === 409, `edit before pair ${early.status} ${early.text}`)

      const code = await req(gwBase, 'POST', `/platform/orgs/${orgId}/pairing-code`, { token: ownerTok })
      assert(code.status === 201, `code ${code.status} ${code.text}`)
      assert(/^SW-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code.json.code), `码格式 ${code.json.code}`)
      assert(code.json.expiresAt > Date.now(), '码已过期')
      assert(String(code.json.installCommand).includes('/install-manager.sh'), '安装命令')
      assert(String(code.json.installCommand).includes(code.json.code), '安装命令要带码')

      const bad = await req(gwBase, 'POST', '/machines/pair', {
        body: { code: 'SW-0000-0000', managerPort: 8443, protocol: 1 },
      })
      assert(bad.status === 401, `坏码 ${bad.status}`)

      // 码是照着屏幕手抄到另一台机器上的，所以生成端不产 S/Z/B/O/I/L，收端把它们
      // 纠回对应数字。**前缀 SW- 里就有一个 S**，纠错只能作用在随机那一段。
      assert(!/[SZBOIL]/.test(code.json.code.slice(3)), `码里有易混字符 ${code.json.code}`)
      const typo = code.json.code.slice(3).replace(/5/g, 'S').replace(/2/g, 'Z').replace(/8/g, 'B')
      const fuzzy = await req(gwBase, 'POST', '/machines/pair', {
        body: { code: 'sw-' + typo.toLowerCase(), managerPort: 8443, hostname: 'e2e', managerVersion: '9.9.9', protocol: 1 },
      })
      assert(fuzzy.status === 201, `抄错字符也该认出来：${fuzzy.status} ${fuzzy.text}`)
      machineTok = fuzzy.json.token

      // 上面那次已经把码用掉了，后面的重放断言仍然成立；这里补配一次拿到干净状态。
      const code1b = await req(gwBase, 'POST', `/platform/orgs/${orgId}/pairing-code`, { token: ownerTok })
      assert(code1b.status === 201, 'code1b')

      const paired = await req(gwBase, 'POST', '/machines/pair', {
        body: { code: code1b.json.code, managerPort: 8443, hostname: 'e2e', managerVersion: '9.9.9', protocol: 1 },
      })
      assert(paired.status === 201, `pair ${paired.status} ${paired.text}`)
      assert(String(paired.json.token).startsWith('smt_'), 'smt_')
      // 地址取的是请求来源 IP，不是 body 里说的——body 说了不算。
      assert(paired.json.host === 'http://127.0.0.1:8443', `host ${paired.json.host}`)
      // e2e 里没有管家在听，回拨必然失败；配对本身照样成立。
      assert(paired.json.reachable === false, 'reachable 应为 false')
      machineTok = paired.json.token

      const replay = await req(gwBase, 'POST', '/machines/pair', {
        body: { code: code1b.json.code, managerPort: 8443, protocol: 1 },
      })
      assert(replay.status === 401, `重放 ${replay.status}`)

      const get = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(get.status === 200, `get ${get.status} ${get.text}`)
      assert(get.json.machine.paired === true, 'paired')
      assert(get.json.machine.managerVersion === '9.9.9', 'managerVersion')
      assert(get.json.machine.protocolTooOld === false, 'protocolTooOld')
      assert(String(get.json.machine.token).startsWith('smt_'), 'owner GET 应带 smt_')
      const dumped = JSON.stringify(get.json)
      for (const k of ['sshSecret', 'sshHost', 'sshUser', 'sshAuth']) {
        assert(!dumped.includes(k), `机器 JSON 仍含 ${k}`)
      }
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

    await test('上传 0.1.0；GET 列表最新', async () => {
      const { release: rel } = await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0', note: 'e2e' })
      assert(rel.version === '0.1.0', 'version')
      assert(typeof rel.sha256 === 'string' && rel.sha256.length === 64, 'sha256')
      assert(typeof rel.size === 'number' && rel.size > 0, 'size')
      const list = await req(gwBase, 'GET', '/platform/bot-releases', { token: ownerTok })
      assert(list.status === 200, `list ${list.status} ${list.text}`)
      assert(list.json.latest === '0.1.0', `latest ${list.json.latest}`)
      assert(list.json.releases[0]?.version === '0.1.0', 'releases newest')
      assert(list.text.length < 100_000, 'list 太大，可能含文件字节')
    })

    await test('stub 部署 botA：linuxUser/seatId/slot 0 端口公式，无 CDP', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botA } })
      assert(r.status === 200, `deploy ${r.status} ${r.text}`)
      const expectedUser = linuxUserOf(memberId)
      assert(r.json.botId === botA, `botId ${r.json.botId}`)
      assert(r.json.linuxUser === expectedUser, `linuxUser ${r.json.linuxUser} != ${expectedUser}`)
      assert(r.json.seatId === seatIdOf(memberId, botA), `seatId ${r.json.seatId}`)
      assert(r.json.sharedDir === `/home/${expectedUser}/work`, `sharedDir ${r.json.sharedDir}`)
      assert(r.json.status === 'ready', `status ${r.json.status}`)
      assert(r.json.botVersion === '0.1.0', `botVersion ${r.json.botVersion}`)
      assert(typeof r.json.vncPassword === 'string' && r.json.vncPassword.length === 16, 'vncPassword 16')
      assert(
        String(r.json.novncUrl).startsWith(`http://127.0.0.1:8443/seats/${r.json.seatId}/vnc/?ticket=`),
        `novncUrl ${r.json.novncUrl}`,
      )
      assert(r.json.display === 10, `display ${r.json.display}`)
      assert(r.json.vncPort === 5910, `vncPort ${r.json.vncPort}`)
      assert(r.json.novncPort === 6081, `novncPort ${r.json.novncPort}`)
      assert(!Object.prototype.hasOwnProperty.call(r.json, 'botPort'), '员工 JSON 不应含 botPort')
      assert(!Object.prototype.hasOwnProperty.call(r.json, 'slot'), '员工 JSON 不应含 slot')
      assert(!r.json.ports || r.json.ports.botPort == null, 'ports.botPort')
      assert(r.json.cdpPort == null, '员工 JSON 不应含 CDP 端口')
      assert(!r.json.ports || r.json.ports.cdpPort == null, 'ports 含 CDP')
      assert(!JSON.stringify(r.json).includes('smt_'), 'deploy 响应泄漏机器票')
      assert(!JSON.stringify(r.json).includes('sshSecret'), 'deploy 含 sshSecret')
    })

    // 同一员工的第二个 bot：**账号相同**（共享文件靠这个），席位不同（屏、目录、单元靠这个）。
    await test('同一成员部署 botB → 同一 linuxUser、不同 seatId、下一槽', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botB } })
      assert(r.status === 200, `deploy B ${r.status} ${r.text}`)
      const expectedUser = linuxUserOf(memberId)
      assert(r.json.botId === botB, 'botId B')
      assert(r.json.linuxUser === expectedUser, `linuxUser ${r.json.linuxUser} != ${expectedUser}`)
      assert(r.json.seatId === seatIdOf(memberId, botB), `seatId ${r.json.seatId}`)
      assert(r.json.seatId !== seatIdOf(memberId, botA), 'botB 撞了 botA seatId')
      assert(r.json.sharedDir === `/home/${expectedUser}/work`, 'botB 应与 botA 共享同一个工作区')
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
      const expectedUser = linuxUserOf(member2Id)
      assert(r.json.linuxUser === expectedUser, `linuxUser ${r.json.linuxUser}`)
      assert(r.json.linuxUser !== linuxUserOf(memberId), '撞 member1 的账号')
      assert(r.json.seatId === seatIdOf(member2Id, botA), `seatId ${r.json.seatId}`)
      assert(r.json.seatId !== seatIdOf(memberId, botA), '撞 member1 botA 席位')
      assert(r.json.sharedDir !== `/home/${linuxUserOf(memberId)}/work`, '两名员工共享了同一个工作区')
      assert(r.json.display === 12, `display ${r.json.display}`)
      assert(r.json.vncPort === 5912, `vncPort ${r.json.vncPort}`)
      assert(r.json.novncPort === 6083, `novncPort ${r.json.novncPort}`)
      assert(!Object.prototype.hasOwnProperty.call(r.json, 'botPort'), 'member2 botPort')
    })

    await test('GET /runtime/desktop?botId= 本人能看到同一份密码', async () => {
      const r = await req(gwBase, 'GET', '/runtime/desktop?botId=' + encodeURIComponent(botA), { token: memberTok })
      assert(r.status === 200, `desktop ${r.status} ${r.text}`)
      assert(r.json.linuxUser === linuxUserOf(memberId), 'linuxUser')
      assert(r.json.seatId === seatIdOf(memberId, botA), 'seatId')
      assert(r.json.botId === botA, 'botId')
      assert(r.json.vncPassword && r.json.vncPassword.length === 16, 'vncPassword')
      assert(String(r.json.novncUrl).includes(`/seats/${r.json.seatId}/vnc/?ticket=`), 'novncUrl 要带票')
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
      assert(a.linuxUser === r.json.linuxUser, 'linuxUser 绑定该账号')
      assert(a.seatId === r.json.seatId, 'seatId 绑定该 pair')
      assert(a.botVersion === '0.1.0', `owner botVersion ${a.botVersion}`)
      assert(a.cdpPort == null, 'owner JSON CDP')
      assert(!JSON.stringify(ownerRt.json).includes('smt_'), 'owner runtime 泄漏机器票')
    })

    await test('另一名成员不能读这份 runtime', async () => {
      const plat = await req(gwBase, 'GET', `/platform/orgs/${orgId}/accounts/${memberId}/runtime`, { token: otherTok })
      assert(plat.status === 403 || plat.status === 404, `other platform ${plat.status} ${plat.text}`)
      const desk = await req(gwBase, 'GET', '/runtime/desktop?botId=' + encodeURIComponent(botA), { token: otherTok })
      if (desk.status === 200) {
        assert(desk.json.seatId !== seatIdOf(memberId, botA), 'other desktop 串了席位')
      } else {
        assert(desk.status === 404, `other desktop ${desk.status} ${desk.text}`)
      }
      assert(!JSON.stringify(desk.json).includes('smt_'), 'other desktop 泄漏机器票')
    })

    await test('owner GET /orgs/:id/accounts 列表含 runtimes 不含密码', async () => {
      const r = await req(gwBase, 'GET', `/orgs/${orgId}/accounts`, { token: ownerTok })
      assert(r.status === 200, `accounts ${r.status} ${r.text}`)
      const row = (r.json.members || []).find((m) => m.id === memberId)
      assert(row, '找不到成员')
      assert(Array.isArray(row.runtimes) && row.runtimes.length === 2, 'list runtimes')
      const a = row.runtimes.find((x) => x.botId === botA)
      assert(a && a.status === 'ready', 'list runtime A')
      assert(a.linuxUser === linuxUserOf(memberId), 'list linuxUser')
      assert(a.seatId === seatIdOf(memberId, botA), 'list seatId')
      assert(a.botVersion === '0.1.0', `list botVersion ${a.botVersion}`)
      // 列表里不签票：那是给管理员看的引用，点进去要走 /runtime/desktop 现签一张。
      assert(a.novncUrl === `http://127.0.0.1:8443/seats/${a.seatId}/vnc/`, `list novncUrl ${a.novncUrl}`)
      assert(!JSON.stringify(row).includes('vncPassword'), '列表含 vncPassword')
      const dumped = JSON.stringify(r.json)
      assert(!dumped.includes('smt_'), 'accounts 泄漏机器票')
    })

    await test('再次 deploy 同一 pair 已 ready 返回当前 runtime', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botA } })
      assert(r.status === 200, `again ${r.status} ${r.text}`)
      assert(r.json.status === 'ready', 'still ready')
      assert(r.json.linuxUser === linuxUserOf(memberId), 'same user')
      assert(r.json.seatId === seatIdOf(memberId, botA), 'same seat')
      assert(r.json.display === 10, 'same slot')
    })

    await test('GET 机器 JSON 不含 sshSecret 标记串', async () => {
      const r = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(machineTok && JSON.stringify(r.json).includes(machineTok), 'owner 应看得到机器票')
      const orgMach = await req(gwBase, 'GET', `/orgs/${orgId}/machine`, { token: memberTok })
      assert(orgMach.status === 200, `org machine ${orgMach.status}`)
      assert(!JSON.stringify(orgMach.json).includes(machineTok), '公司管理员不该看到机器票')
      
      assert(!Object.prototype.hasOwnProperty.call(orgMach.json.machine || {}, 'token'), 'org machine 带 token')
      assert(!JSON.stringify(orgMach.json).includes('smt_'), 'org machine 泄漏 smt_')
    })

    await test('多机调度：填满一台再用下一台，同一账号粘住同一台', async () => {
      // 到这儿 m1 上已经有 member1 和 member2 两个账号了。容量压到 1 → 立刻算满。
      // 不驱逐已经在上面的账号：把人从机器上赶走会丢掉他的 ~/work。
      const first = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      const m1 = first.json.machines[0].machine.id
      const cap = await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machines/${m1}/capacity`, {
        token: ownerTok,
        body: { maxAccounts: 1 },
      })
      assert(cap.status === 200, `capacity ${cap.status} ${cap.text}`)
      assert(cap.json.machine.id === m1, 'capacity 返回的是同一台')

      // 订阅席位和机器容量是两回事：这里要加的是前者，否则建不出新员工。
      const plan = await req(gwBase, 'PUT', `/platform/orgs/${orgId}/plan`, { token: ownerTok, body: { seats: 8 } })
      assert(plan.status === 200, `plan ${plan.status} ${plan.text}`)

      // 换个地址配对 = 新增一台，不是替换。
      const code2 = await req(gwBase, 'POST', `/platform/orgs/${orgId}/pairing-code`, { token: ownerTok })
      const pair2 = await req(gwBase, 'POST', '/machines/pair', {
        body: { code: code2.json.code, managerPort: 9443, managerVersion: '9.9.9', protocol: 1 },
      })
      assert(pair2.status === 201, `pair2 ${pair2.status} ${pair2.text}`)
      const listed = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(listed.json.machines.length === 2, `应有两台：${listed.json.machines.length}`)
      const m2 = listed.json.machines.find((x) => x.machine.id !== m1).machine.id

      // 粘住：member1 已经在 m1 上，m1 满了也还得落在 m1——他的 bot 要共享同一份 ~/work。
      const again = await req(gwBase, 'POST', '/runtime/deploy', { token: memberTok, body: { botId: botB, update: true } })
      assert(again.status === 200, `member1 再部署 ${again.status} ${again.text}`)
      // 两台机器的端口不同，novncUrl 里就能看出席位落在哪台——顺带验了「每个席位
      // 用自己那台机器的地址」，多机之后用错地址会把桌面开到别人的机器上。
      assert(again.json.novncUrl.includes(':8443/'), `member1 应还在 m1：${again.json.novncUrl}`)

      // 新账号：m1 满了，只能落到 m2。
      const m3 = await req(gwBase, 'POST', `/orgs/${orgId}/accounts`, {
        token: adminTok,
        body: { email: 'member3@machine.test', password: 'correct-horse', role: 'member' },
      })
      assert(m3.status === 201, `member3 ${m3.status} ${m3.text}`)
      const tok3 = (
        await req(gwBase, 'POST', '/auth/login', { body: { email: 'member3@machine.test', password: 'correct-horse' } })
      ).json.token
      const on2 = await req(gwBase, 'POST', '/runtime/deploy', { token: tok3, body: { botId: botA } })
      assert(on2.status === 200, `member3 部署 ${on2.status} ${on2.text}`)
      assert(on2.json.novncUrl.includes(':9443/'), `member3 应落到 m2：${on2.json.novncUrl}`)

      const after = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      const c1 = after.json.machines.find((x) => x.machine.id === m1)
      const c2 = after.json.machines.find((x) => x.machine.id === m2)
      assert(c1.full, `m1 应算满：${c1.accounts}/${c1.maxAccounts}`)
      assert(c2.accounts === 1, `member3 应落到 m2：${c2.accounts}`)
      assert(after.json.capacity.max === c1.maxAccounts + c2.maxAccounts, '总容量是各台之和')

      // 两台都满 → 第四个账号无处可去，要给能看懂的 409。
      await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machines/${m2}/capacity`, { token: ownerTok, body: { maxAccounts: 1 } })
      const m4 = await req(gwBase, 'POST', `/orgs/${orgId}/accounts`, {
        token: adminTok,
        body: { email: 'member4@machine.test', password: 'correct-horse', role: 'member' },
      })
      assert(m4.status === 201, `member4 ${m4.status} ${m4.text}`)
      const tok4 = (
        await req(gwBase, 'POST', '/auth/login', { body: { email: 'member4@machine.test', password: 'correct-horse' } })
      ).json.token
      const nope = await req(gwBase, 'POST', '/runtime/deploy', { token: tok4, body: { botId: botA } })
      assert(nope.status === 409, `都满了应 409：${nope.status} ${nope.text}`)
      assert(String(nope.json.error).includes('都满了'), `文案 ${nope.json.error}`)

      // 放开 m1 的容量，第四个人就落回 m1（已用最多、且没满的那台）。
      await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machines/${m1}/capacity`, { token: ownerTok, body: { maxAccounts: 5 } })
      const ok4 = await req(gwBase, 'POST', '/runtime/deploy', { token: tok4, body: { botId: botA } })
      assert(ok4.status === 200, `放开后 ${ok4.status} ${ok4.text}`)
      assert(ok4.json.novncUrl.includes(':8443/'), `member4 应落回 m1：${ok4.json.novncUrl}`)
      const final = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(final.json.machines.find((x) => x.machine.id === m1).accounts === 3, 'member4 应落在 m1')
    })

    await test('未配对的机器：不算容量，能移除；有席位的不给删', async () => {
      const before = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      const busy = before.json.machines.find((x) => x.seats > 0)
      assert(busy, '这时候该有一台带席位的机器')
      const refused = await req(gwBase, 'DELETE', `/platform/orgs/${orgId}/machines/${busy.machine.id}`, { token: ownerTok })
      assert(refused.status === 409, `有席位应拒删：${refused.status} ${refused.text}`)

      // 造一台「登记了但没配对」的：容量不该把它算进去。
      const ghost = await req(gwBase, 'POST', '/internal/machines', {
        token: MACHINE_TOK,
        body: { host: '10.9.9.9:3200' },
      })
      assert(ghost.status === 201, `ghost ${ghost.status} ${ghost.text}`)
      const claimed = await req(gwBase, 'POST', `/orgs/${orgId}/machine`, {
        token: adminTok,
        body: { id: ghost.json.machine.id },
      })
      assert(claimed.status === 201, `claim ${claimed.status} ${claimed.text}`)

      const withGhost = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      const g = withGhost.json.machines.find((x) => x.machine.id === ghost.json.machine.id)
      assert(g && !g.machine.paired, '这台不该算已配对')
      assert(
        withGhost.json.capacity.max === before.json.capacity.max,
        `未配对的机器不该贡献容量：${before.json.capacity.max} → ${withGhost.json.capacity.max}`,
      )

      const gone = await req(gwBase, 'DELETE', `/platform/orgs/${orgId}/machines/${ghost.json.machine.id}`, {
        token: ownerTok,
      })
      assert(gone.status === 200, `移除 ${gone.status} ${gone.text}`)
      const after = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(!after.json.machines.some((x) => x.machine.id === ghost.json.machine.id), '没删干净')
    })

    await test('改管家地址：存得下，并且当场报可达性', async () => {
      const r = await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machine`, {
        token: ownerTok,
        body: { host: '10.8.0.21:8443' },
      })
      assert(r.status === 200, `edit ${r.status} ${r.text}`)
      // 裸 host 要补上 scheme：这个值会被直接拼成 fetch 的 URL。
      assert(r.json.machine.host === 'http://10.8.0.21:8443', `host ${r.json.machine.host}`)
      assert(r.json.reachable === false, '那儿没有管家，应报不可达')
      // 改回去，后面的用例还要用。
      await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machine`, {
        token: ownerTok,
        body: { host: 'http://127.0.0.1:8443' },
      })
    })

    await test('同一版本传第二次 → 409', async () => {
      let err = ''
      try {
        await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0' })
      } catch (e) {
        err = String(e.message)
      }
      assert(err.includes('409'), `dup ${err}`)
    })

    await test('发布 0.2.0 后成员 update deploy → botVersion 0.2.0', async () => {
      await publishRelease({ req, gwBase, token: ownerTok, version: '0.2.0' })
      const r = await req(gwBase, 'POST', '/runtime/deploy', {
        token: memberTok,
        body: { botId: botA, version: '0.2.0', update: true },
      })
      assert(r.status === 200, `update deploy ${r.status} ${r.text}`)
      assert(r.json.botVersion === '0.2.0', `botVersion ${r.json.botVersion}`)
    })

    await test('按架构选包：x64 更新，arm64 机器仍拿到 arm64 的包', async () => {
      // 发布包里带 esbuild 的原生二进制，装错架构起不来。CI 一次出两份，x64 后传所以
      // 更「新」——只按 createdAt 取的话，arm 机器每次都会拿到 x64 那份。
      await publishRelease({ req, gwBase, token: ownerTok, version: '0.3.0-arm64' })
      await publishRelease({ req, gwBase, token: ownerTok, version: '0.3.0-x64' }) // 更新

      // 机器还没报过架构：退回老行为，谁新要谁。
      const blind = await req(gwBase, 'POST', '/runtime/deploy', {
        token: memberTok,
        body: { botId: botA, update: true },
      })
      assert(blind.status === 200, `未报架构时部署 ${blind.status} ${blind.text}`)
      assert(blind.json.botVersion === '0.3.0-x64', `未报架构应取最新，实际 ${blind.json.botVersion}`)

      // 心跳报 arm64 之后，同样不指定版本，必须挑到 arm64 那份。
      const mach = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(mach.status === 200, `取机器 ${mach.status} ${mach.text}`)
      const machineId = mach.json.machine.id
      const hb = await req(gwBase, `POST`, `/internal/machines/${machineId}/heartbeat`, {
        token: machineTok,
        body: { managerVersion: 'e2e', protocol: 1, arch: 'arm64', seats: [] },
      })
      assert(hb.status === 200, `heartbeat ${hb.status} ${hb.text}`)

      const aware = await req(gwBase, 'POST', '/runtime/deploy', {
        token: memberTok,
        body: { botId: botA, update: true },
      })
      assert(aware.status === 200, `按架构部署 ${aware.status} ${aware.text}`)
      assert(
        aware.json.botVersion === '0.3.0-arm64',
        `arm64 机器该拿 arm64 的包，实际 ${aware.json.botVersion}`,
      )
    })

    await test('按架构选包：显式指定错架构的版本 → 409', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', {
        token: memberTok,
        body: { botId: botA, version: '0.3.0-x64', update: true },
      })
      assert(r.status === 409, `错架构该被挡下，实际 ${r.status} ${r.text}`)
      assert(String(r.text).includes('arm64'), `报错该点明机器架构：${r.text}`)
      // 认不出架构的老版本号照旧放行。
      const legacy = await req(gwBase, 'POST', '/runtime/deploy', {
        token: memberTok,
        body: { botId: botA, version: '0.2.0', update: true },
      })
      assert(legacy.status === 200, `无后缀的老版本不该被拦，实际 ${legacy.status} ${legacy.text}`)
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

    // ── 上传发布包（生产路径：CI 传包，Gateway 不构建）──────────────────
    const goodPack = tarGz([
      { name: './bin/satuwork.mjs', data: '#!/usr/bin/env node\nconsole.log("uploaded")\n' },
      { name: './package.json', data: '{"name":"satuwork","version":"1.0.0"}\n' },
    ])
    const relFile = (v) => join(GW_HOME, 'releases', `bot-${v}.tgz`)

    await test('CI 用平台令牌 PUT 上传发布包 → 200，sha256/size 对得上', async () => {
      const sha = sha256Of(goodPack)
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/1.0.0+ci?note=uploaded', {
        token: PLATFORM_TOK,
        raw: goodPack,
        headers: { 'x-bot-sha256': sha },
      })
      assert(r.status === 200, `upload ${r.status} ${r.text}`)
      assert(r.json.release.version === '1.0.0+ci', `version ${r.json.release.version}`)
      assert(r.json.release.sha256 === sha, 'sha256 回显')
      assert(r.json.release.size === goodPack.length, `size ${r.json.release.size}`)
      assert(r.json.release.note === 'uploaded', `note ${r.json.release.note}`)
      assert(existsSync(relFile('1.0.0+ci')), '发布包没落盘')
      const one = await req(gwBase, 'GET', '/platform/bot-releases/1.0.0%2Bci', { token: ownerTok })
      assert(one.status === 200, `one ${one.status} ${one.text}`)
      assert(one.json.release.sha256 === sha, 'one sha256')
    })

    // 字节在 Gateway 磁盘上的包也必须报出一个下载地址：那台 Debian 只有这一处能看到
    // 该拉哪儿，界面上写「本机存储」等于没给。
    await test('本机存储的发布包也给下载地址，且那个地址真能拉到包', async () => {
      const one = await req(gwBase, 'GET', '/platform/bot-releases/1.0.0%2Bci', { token: ownerTok })
      const url = one.json.release.downloadUrl
      assert(one.json.release.storage === 'local', `storage ${one.json.release.storage}`)
      assert(url && url.endsWith('/internal/bot-releases/1.0.0%2Bci'), `downloadUrl ${url}`)
      assert(url.startsWith('http://'), `downloadUrl 要是绝对地址：${url}`)
      const dl = await fetch(url, { headers: { authorization: 'Bearer ' + machineTok } })
      assert(dl.status === 200, `按下载地址拉包 ${dl.status}`)
      assert(dl.headers.get('x-bot-sha256') === sha256Of(goodPack), '校验头丢了')
    })

    await test('上传的版本能部署：botVersion 跟上', async () => {
      const r = await req(gwBase, 'POST', '/runtime/deploy', {
        token: memberTok,
        body: { botId: botA, version: '1.0.0+ci', update: true },
      })
      assert(r.status === 200, `deploy uploaded ${r.status} ${r.text}`)
      assert(r.json.botVersion === '1.0.0+ci', `botVersion ${r.json.botVersion}`)
    })

    await test('没有令牌上传 → 401，不落盘', async () => {
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/9.9.9', { raw: goodPack })
      assert(r.status === 401, `anon upload ${r.status} ${r.text}`)
      assert(!existsSync(relFile('9.9.9')), '匿名上传落了盘')
    })

    await test('sha256 对不上 → 400，文件和库都不留', async () => {
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/1.0.1', {
        token: PLATFORM_TOK,
        raw: goodPack,
        headers: { 'x-bot-sha256': 'f'.repeat(64) },
      })
      assert(r.status === 400, `bad sha ${r.status} ${r.text}`)
      assert(String(r.json.error || '').includes('sha256'), 'sha256 文案')
      assert(!existsSync(relFile('1.0.1')), '坏包留在盘上')
      const one = await req(gwBase, 'GET', '/platform/bot-releases/1.0.1', { token: ownerTok })
      assert(one.status === 404, `bad sha 入库了 ${one.status}`)
    })

    await test('包里没有 bin/satuwork.mjs → 400', async () => {
      const bad = tarGz([{ name: './README.md', data: 'nope\n' }])
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/1.0.2', { token: PLATFORM_TOK, raw: bad })
      assert(r.status === 400, `no entry ${r.status} ${r.text}`)
      assert(String(r.json.error || '').includes('bin/satuwork.mjs'), '缺入口文案')
      assert(!existsSync(relFile('1.0.2')), '坏包留在盘上')
    })

    await test('不是 gzip → 400', async () => {
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/1.0.3', {
        token: PLATFORM_TOK,
        raw: Buffer.from('这不是 tar.gz'),
      })
      assert(r.status === 400, `not gz ${r.status} ${r.text}`)
      assert(!existsSync(relFile('1.0.3')), '坏包留在盘上')
    })

    await test('重复上传同一版本 → 409，原包不动', async () => {
      const before = sha256Of(goodPack)
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/1.0.0+ci', { token: PLATFORM_TOK, raw: goodPack })
      assert(r.status === 409, `dup upload ${r.status} ${r.text}`)
      const one = await req(gwBase, 'GET', '/platform/bot-releases/1.0.0%2Bci', { token: ownerTok })
      assert(one.json.release.sha256 === before, '原包被改了')
    })

    await test('非法版本号 → 400', async () => {
      const r = await req(gwBase, 'PUT', '/platform/bot-releases/..%2Fetc', { token: PLATFORM_TOK, raw: goodPack })
      assert(r.status === 400, `bad version ${r.status} ${r.text}`)
    })

    await test('平台令牌也能回查发布列表（CI 传完要能确认）', async () => {
      const list = await req(gwBase, 'GET', '/platform/bot-releases', { token: PLATFORM_TOK })
      assert(list.status === 200, `list by platform token ${list.status} ${list.text}`)
      assert(list.json.releases.some((r) => r.version === '1.0.0+ci'), '列表里没有上传的版本')
      const bad = await req(gwBase, 'GET', '/platform/bot-releases', { token: 'not-a-token' })
      assert(bad.status === 401, `bogus token ${bad.status}`)
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
