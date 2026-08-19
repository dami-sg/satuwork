/**
 * 机器管家：配对、鉴权、部署下发、反代、桌面票。
 *
 * 这里起的是**真的管家进程**，只是带 `SATUWORK_MANAGER_DRYRUN=1`——跳过
 * `deploy-seat.sh` 和 systemd（那些要 root，也要一台 Debian），但 HTTP、配对、
 * 鉴权、反代、WebSocket 升级全都走真的。整条新接缝就是靠这一套盯住的。
 *
 * 上游 bot 用一个 mock HTTP 顶替：反代要验的是「转过去了、头对不对、流不断」，
 * 不是 bot 本身。
 */
import { createHash, sign } from 'node:crypto'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'

/** 起一个假 bot。记下每次请求的头和路径，供断言。 */
function fakeBot() {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ path: req.url, headers: { ...req.headers } })
    if (req.url.startsWith('/api/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"seq":1}\n\n')
      setTimeout(() => {
        res.write('data: {"seq":2}\n\n')
        res.end()
      }, 60)
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, path: req.url }))
  })
  // 顺带兼作 noVNC：WebSocket 升级要有人接。
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n')
    socket.write('HELLO-WS')
  })
  return { server, seen }
}

function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
}

/** 手搓一次 WebSocket 升级握手，只看服务端有没有把它接通。 */
function wsHandshake(port, path, cookie) {
  return new Promise((resolve) => {
    const sock = connect(port, '127.0.0.1', () => {
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
          (cookie ? `Cookie: ${cookie}\r\n` : '') +
          '\r\n',
      )
    })
    let buf = ''
    const done = (v) => {
      try {
        sock.destroy()
      } catch {}
      resolve(v)
    }
    sock.on('data', (d) => {
      buf += String(d)
      if (buf.includes('HELLO-WS') || buf.length > 2000) done(buf)
    })
    sock.on('error', (e) => done('ERR ' + e.message))
    setTimeout(() => done(buf || 'TIMEOUT'), 4000)
  })
}

export async function runManager({ root, gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = '/tmp/satuwork-e2e-manager-gw'
  const MGR_HOME = '/tmp/satuwork-e2e-manager-etc'
  const GW_PORT = 19080
  const MGR_PORT = 19081
  const BOT_PORT = 19082
  const NOVNC_PORT = 19083
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  const mgrBase = `http://127.0.0.1:${MGR_PORT}`
  const managerRoot = join(root, 'manager')

  rmSync(GW_HOME, { recursive: true, force: true })
  rmSync(MGR_HOME, { recursive: true, force: true })
  log('\n# manager')

  const bot = fakeBot()
  const novnc = fakeBot()
  await listenOn(bot.server, BOT_PORT)
  await listenOn(novnc.server, NOVNC_PORT)

  start('manager-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: 'e2e_manager',
      GATEWAY_PG_RESET: '1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_PUBLIC_URL: gwBase,
      GATEWAY_OWNER_EMAIL: 'owner@manager.test',
      GATEWAY_OWNER_PASSWORD: 'manager-owner-1234',
      SATUWORK_DEPLOY_STUB: '',
    },
  })
  await waitHttp(`${gwBase}/health`, { timeout: 40000 })

  try {
    const login = await req(gwBase, 'POST', '/auth/login', {
      body: { email: 'owner@manager.test', password: 'manager-owner-1234' },
    })
    assert(login.status === 200, `owner login ${login.status} ${login.text}`)
    const ownerTok = login.json.token

    const org = await req(gwBase, 'POST', '/platform/orgs', {
      token: ownerTok,
      body: {
        name: '管家验证公司',
        slug: 'mgrtest',
        contactName: '联系人',
        contactPhone: '+86 13800000000',
        contactEmail: 'admin@mgrtest.local',
        adminEmail: 'admin@mgrtest.local',
        adminPassword: 'manager-admin-1234',
      },
    })
    assert(org.status === 201, `org ${org.status} ${org.text}`)
    const orgId = org.json.company.id

    let code = ''
    let machineTok = ''

    await test('生成配对码：格式、有效期、安装命令', async () => {
      const r = await req(gwBase, 'POST', `/platform/orgs/${orgId}/pairing-code`, { token: ownerTok })
      assert(r.status === 201, `code ${r.status} ${r.text}`)
      assert(/^SW-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(r.json.code), `格式 ${r.json.code}`)
      assert(r.json.expiresAt > Date.now(), '已过期')
      assert(r.json.installCommand.includes(`${gwBase}/install-manager.sh`), '安装命令要带 Gateway 地址')
      code = r.json.code
    })

    await test('安装脚本公开可取，内容像个装机脚本', async () => {
      const r = await req(gwBase, 'GET', '/install-manager.sh')
      assert(r.status === 200, `install ${r.status}`)
      assert(r.text.startsWith('#!/bin/bash'), 'shebang')
      assert(r.text.includes(gwBase), '脚本里要写死 Gateway 地址')
      assert(r.text.includes('satuwork-manager.service'), '要装 systemd 单元')
      assert(r.text.includes('satuwork-manager-confirm'), '要装回滚定时器')
      assert(!r.text.includes('smt_'), '安装脚本不该含任何机器票')
    })

    // 管家先起来再配对：Gateway 收到配对请求会立刻回拨一次 /health。
    start('manager', ['--import', 'tsx', join(managerRoot, 'bin/satuwork-manager.mjs')], {
      cwd: managerRoot,
      env: {
        SATUWORK_MANAGER_HOME: MGR_HOME,
        SATUWORK_MANAGER_HOST: '127.0.0.1',
        SATUWORK_MANAGER_PORT: String(MGR_PORT),
        SATUWORK_MANAGER_DRYRUN: '1',
        GATEWAY_URL: gwBase,
        SATUWORK_PAIRING_CODE: code,
      },
    })

    await test('管家自己配上了，而且 Gateway 回拨得通', async () => {
      for (let i = 0; i < 100; i++) {
        if (existsSync(join(MGR_HOME, 'manager.json'))) break
        await new Promise((r) => setTimeout(r, 200))
      }
      assert(existsSync(join(MGR_HOME, 'manager.json')), '管家没有写出配对结果')
      const m = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(m.status === 200, `machine ${m.status} ${m.text}`)
      assert(m.json.machine.paired === true, 'paired')
      assert(m.json.machine.host === mgrBase, `host ${m.json.machine.host}`)
      // 回拨走 challenge 而不是 smt_：那一刻票还在 Gateway 手里。通了才说明真可达。
      assert(!m.json.machine.lastError, `回拨失败: ${m.json.machine.lastError}`)
      machineTok = m.json.machine.token
      assert(String(machineTok).startsWith('smt_'), 'smt_')
    })

    await test('管家的 /health 认票：无票 401，有票 200', async () => {
      const anon = await req(mgrBase, 'GET', '/health')
      assert(anon.status === 401, `无票 ${anon.status}`)
      const ok = await req(mgrBase, 'GET', '/health', { token: machineTok })
      assert(ok.status === 200, `有票 ${ok.status} ${ok.text}`)
      assert(ok.json.protocol >= 1, 'protocol')
      assert(ok.json.dryRun === true, 'dryRun')
    })

    await test('部署下发：无票 401，有票落进名册', async () => {
      const spec = {
        linuxUser: 'sw-test',
        homeDir: '/home/sw-test',
        workDir: '/home/sw-test/work',
        seatDir: '/home/sw-test/.satuwork/seat-1',
        botId: 'bot-1',
        botVersion: '0.0.0-e2e',
        vncPassword: 'x'.repeat(16),
        gatewayUrl: gwBase,
        gatewayToken: 'sat_e2e',
        gatewayApiKey: 'sk_sw_e2e',
        ports: { display: 10, vncPort: 5910, novncPort: NOVNC_PORT, botPort: BOT_PORT, cdpPort: 9222 },
      }
      const anon = await req(mgrBase, 'PUT', '/seats/seat-1', { body: spec })
      assert(anon.status === 401, `无票部署 ${anon.status}`)

      // **用 Gateway 真正发的那个头。** 之前这里只测了 authorization——和管家的实现
      // 一致，却和调用方不一致，于是「/health 通、部署 401」漏了过去。
      const viaHeader = await fetch(`${mgrBase}/seats/seat-1`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-satuwork-machine': machineTok },
        body: JSON.stringify(spec),
      })
      assert(viaHeader.status === 200, `x-satuwork-machine 部署 ${viaHeader.status} ${await viaHeader.text()}`)

      const ok = await req(mgrBase, 'PUT', '/seats/seat-1', { token: machineTok, body: spec })
      assert(ok.status === 200, `部署 ${ok.status} ${ok.text}`)
      assert(ok.json.seat.status === 'ready', `status ${ok.json.seat.status}`)
      const list = await req(mgrBase, 'GET', '/seats', { token: machineTok })
      assert(list.json.seats.length === 1, `名册 ${list.json.seats.length}`)
    })

    await test('席位规格按形状校验：路径和标识符不收外部值', async () => {
      // 管家以 root 跑 deploy-seat.sh，这些值会变成 mkdir/chown 的目标和 systemd 单元里
      // 的字段。以前只校验「是非空字符串」，于是 homeDir=/etc 就能让 root 去 chown /etc，
      // 而 homeDir 里塞个换行就能往 [Service] 里注入 ExecStartPre。
      const good = {
        linuxUser: 'sw-test',
        homeDir: '/home/sw-test',
        workDir: '/home/sw-test/work',
        seatDir: '/home/sw-test/.satuwork/seat-2',
        botId: 'bot-1',
        botVersion: '0.0.0-e2e',
        vncPassword: 'x'.repeat(16),
        gatewayUrl: gwBase,
        gatewayToken: 'sat_e2e',
        gatewayApiKey: 'sk_sw_e2e',
        ports: { display: 11, vncPort: 5911, novncPort: NOVNC_PORT, botPort: BOT_PORT, cdpPort: 9223 },
      }
      const bad = [
        ['homeDir 指到 /etc', { ...good, homeDir: '/etc', workDir: '/etc/satuwork' }],
        ['linuxUser 带换行', { ...good, linuxUser: 'sw-test\nUser=root' }],
        ['linuxUser 带斜杠', { ...good, linuxUser: '../root' }],
        ['botVersion 想跳出目录', { ...good, botVersion: '../../etc/passwd' }],
        ['botId 带换行', { ...good, botId: 'bot-1\nGATEWAY_URL=http://evil' }],
        ['端口越界', { ...good, ports: { ...good.ports, botPort: 99999 } }],
      ]
      for (const [why, body] of bad) {
        const r = await req(mgrBase, 'PUT', '/seats/seat-2', { token: machineTok, body })
        assert(r.status === 400, `${why}：应 400，得到 ${r.status} ${r.text}`)
      }
      // seatId 走 URL，同样要按形状拒
      const badId = await req(mgrBase, 'PUT', '/seats/' + encodeURIComponent('../../etc'), {
        token: machineTok,
        body: good,
      })
      assert(badId.status === 400 || badId.status === 404, `坏 seatId 应被拒，得到 ${badId.status}`)
      // 名册不该因为这些被拒的请求多出东西来
      const list = await req(mgrBase, 'GET', '/seats', { token: machineTok })
      assert(list.json.seats.length === 1, `被拒的部署不该进名册：${list.json.seats.length}`)
    })

    await test('bot 反代：转发到本机端口，authorization 原样到达', async () => {
      const anon = await fetch(`${mgrBase}/seats/seat-1/bot/api/hello`)
      assert(anon.status === 401, `无机器票 ${anon.status}`)
      const r = await fetch(`${mgrBase}/seats/seat-1/bot/api/hello?x=1`, {
        headers: { 'x-satuwork-machine': machineTok, authorization: 'Bearer sat_seat_token' },
      })
      assert(r.status === 200, `反代 ${r.status}`)
      const body = await r.json()
      assert(body.path === '/api/hello?x=1', `路径重写 ${body.path}`)
      const last = bot.seen[bot.seen.length - 1]
      // 席位票原样透传给 bot；机器票是给管家的，不该继续往下走。
      assert(last.headers.authorization === 'Bearer sat_seat_token', 'authorization 没透传')
      assert(!last.headers['x-satuwork-machine'], '机器票漏给了 bot')
    })

    await test('SSE 经过反代不被缓冲，一帧一帧出来', async () => {
      const r = await fetch(`${mgrBase}/seats/seat-1/bot/api/sse`, {
        headers: { 'x-satuwork-machine': machineTok },
      })
      assert(r.status === 200, `sse ${r.status}`)
      assert(String(r.headers.get('content-type')).includes('text/event-stream'), 'content-type')
      const text = await r.text()
      assert(text.includes('"seq":1') && text.includes('"seq":2'), `帧不全: ${text}`)
    })

    await test('未知席位 404，不暴露端口', async () => {
      const r = await fetch(`${mgrBase}/seats/no-such/bot/api/x`, {
        headers: { 'x-satuwork-machine': machineTok },
      })
      assert(r.status === 404, `未知席位 ${r.status}`)
    })

    let deskCookie = ''
    /** 落地页地址。下一条要从它的 query 里取 path——那正是 noVNC 建连的唯一依据。 */
    let deskLanding = ''

    await test('桌面票：无票 401，有效票换 cookie 并跳转', async () => {
      const anon = await fetch(`${mgrBase}/seats/seat-1/vnc/`, { redirect: 'manual' })
      assert(anon.status === 401, `无票 ${anon.status}`)
      const bad = await fetch(`${mgrBase}/seats/seat-1/vnc/?ticket=not-a-jwt`, { redirect: 'manual' })
      assert(bad.status === 401, `坏票 ${bad.status}`)

      const ticket = await mintTicket(gwBase, ownerTok)
      const r = await fetch(`${mgrBase}/seats/seat-1/vnc/?ticket=${encodeURIComponent(ticket)}`, {
        redirect: 'manual',
      })
      assert(r.status === 302, `换 cookie ${r.status}`)
      deskLanding = String(r.headers.get('location'))
      assert(deskLanding.startsWith('/seats/seat-1/vnc/vnc.html'), `location=${deskLanding}`)
      // 票里没带口令时不许凭空造一个 password 参数出来——那会让 noVNC 拿空口令去认证，
      // 直接失败，而不是老老实实弹输入框。
      assert(!deskLanding.includes('password='), `票里没口令却带了 password：${deskLanding}`)
      const setCookie = String(r.headers.get('set-cookie') || '')
      assert(setCookie.includes('HttpOnly'), 'cookie 要 HttpOnly')
      assert(setCookie.includes('Path=/seats/seat-1/vnc'), 'cookie 要限定到这个席位')
      deskCookie = setCookie.split(';')[0]
    })

    await test('拿着 cookie 能取 noVNC 静态资源，也能建 WebSocket', async () => {
      const page = await fetch(`${mgrBase}/seats/seat-1/vnc/vnc.html`, { headers: { cookie: deskCookie } })
      assert(page.status === 200, `静态 ${page.status}`)
      // **按 noVNC 自己的拼法去连**，不要照着「应该是什么路径」手写——它拼的是
      // `'/' + path`（从根开始），path 只能从落地页的 query 里来。原先这条断言直接
      // 写死了正确路径，于是「跳转没把 path 告诉 noVNC」这个 bug 一路测过去了：
      // 反代是好的，可 noVNC 压根不会往这儿连，它去连了 /websockify。
      const novncPath = new URLSearchParams(deskLanding.split('?')[1] || '').get('path')
      assert(novncPath, `落地页没带 path，noVNC 会去连 /websockify：${deskLanding}`)
      const ws = await wsHandshake(MGR_PORT, '/' + novncPath, deskCookie)
      assert(ws.includes('101'), `升级失败: ${ws.slice(0, 120)}`)
      assert(ws.includes('HELLO-WS'), '升级后字节没通')
      const noAuth = await wsHandshake(MGR_PORT, '/' + novncPath, '')
      assert(noAuth.includes('401'), `无 cookie 的升级应 401: ${noAuth.slice(0, 80)}`)
    })

    await test('口令随票带过来时，落地页直接免密进桌面', async () => {
      // 「打开桌面」的意图是看桌面，不是打开一个还要人回去抄一遍口令的登录框。
      // Gateway 把席位口令签在票里，管家验完签转成 noVNC 认的 password 参数。
      const ticket = mintTicketWithPassword(GW_HOME, 'seat-1', 'PW-secret-9')
      const r = await fetch(`${mgrBase}/seats/seat-1/vnc/?ticket=${encodeURIComponent(ticket)}`, {
        redirect: 'manual',
      })
      assert(r.status === 302, `换 cookie ${r.status}`)
      const loc = String(r.headers.get('location'))
      const q = new URLSearchParams(loc.split('?')[1] || '')
      assert(q.get('password') === 'PW-secret-9', `口令没转过去：${loc}`)
      assert(q.get('autoconnect') === '1', `没自动连：${loc}`)
      assert(q.get('path'), `path 丢了：${loc}`)
    })

    await test('显示参数按白名单透传，path 与 password 不许被外面覆盖', async () => {
      // 右栏那块内嵌预览只有两百来像素宽，没有 resize=scale 就只看得见桌面左上角。
      // 但同一个入口不能让调用方顺手改掉连接地址和口令——那两个只能由票说了算。
      const ticket = mintTicketWithPassword(GW_HOME, 'seat-1', 'PW-secret-9')
      const q0 = new URLSearchParams({
        ticket,
        resize: 'scale',
        bell: 'false',
        path: 'evil/websockify',
        password: 'stolen',
        onload: '<script>',
      })
      const r = await fetch(`${mgrBase}/seats/seat-1/vnc/?${q0}`, { redirect: 'manual' })
      assert(r.status === 302, `换 cookie ${r.status}`)
      const q = new URLSearchParams(String(r.headers.get('location')).split('?')[1] || '')
      assert(q.get('resize') === 'scale', `resize 没透传：${q}`)
      assert(q.get('bell') === 'false', `bell 没透传：${q}`)
      assert(q.get('path') === 'seats/seat-1/vnc/websockify', `path 被覆盖了：${q.get('path')}`)
      assert(q.get('password') === 'PW-secret-9', `password 被覆盖了：${q.get('password')}`)
      assert(q.get('onload') === null, `白名单外的参数漏过去了：${q}`)
    })

    await test('席位诊断：给得出现场，而且不漏凭据', async () => {
      // 这个接口是为「没有 SSH 就看不见机器」补的洞。它最该答上的几个问题，正是今天
      // 排查里逐个靠人肉 ps/ss/journalctl 才问出来的：端口归谁、服务什么时候起的、
      // dock 项在不在、浏览器装没装。
      const anon = await fetch(`${mgrBase}/seats/seat-1/diag`)
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)

      const r = await req(mgrBase, 'GET', '/seats/seat-1/diag', { token: machineTok })
      assert(r.status === 200, `diag ${r.status} ${r.text}`)
      const d = r.json.diag
      assert(d.seatId === 'seat-1', `seatId=${d.seatId}`)
      assert(d.seat && d.seat.linuxUser, '该带上名册里那条记录')
      // 三个端口都要有一行——「没人在听」也是结论，不能因为查不到就整条不给。
      assert(Array.isArray(d.ports) && d.ports.length === 3, `ports 应有 3 条，实际 ${JSON.stringify(d.ports)}`)
      assert(d.units.length === 2, `units 应有桌面和 bot 两条，实际 ${d.units.length}`)
      assert(Array.isArray(d.files) && d.files.some((f) => f.path.endsWith('vnc-passwd')), 'files 里该有 vnc-passwd')
      assert(Array.isArray(d.notes), 'notes 要在——「哪里不对」得写成人话，不能让人自己比对字段')
      assert('found' in d.browser, 'browser 探测结果要在')

      // **口令一个字都不能出去。** vnc-passwd 只报存在与时间；报告会经 Gateway 到浏览器。
      const blob = JSON.stringify(d)
      assert(!blob.includes('vncPassword'), '报告里不该出现 vncPassword 字段')
      const pw = d.files.find((f) => f.path.endsWith('vnc-passwd'))
      assert(pw && !('content' in pw), 'vnc-passwd 只能报存在与时间，不能报内容')
    })

    await test('运行日志：无票 401，未知席位 404，有票给得出结构', async () => {
      // diag 回答「它活着吗」，这条回答「它卡在哪一步」——这一层最贵的故障都不报错：
      // 单元 active、端口有人听，只是那一轮永远不结束。
      const anon = await fetch(`${mgrBase}/seats/seat-1/logs`)
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)

      // unit 名是拿 seatId 拼的，所以只让名册里有的席位过去。
      const nope = await req(mgrBase, 'GET', '/seats/seat-nope/logs', { token: machineTok })
      assert(nope.status === 404, `未知席位该 404，实际 ${nope.status} ${nope.text}`)

      const r = await req(mgrBase, 'GET', '/seats/seat-1/logs?lines=5', { token: machineTok })
      assert(r.status === 200, `logs ${r.status} ${r.text}`)
      // 开发机上没有 journalctl，取不到就是空数组——但字段必须在，不能整条塌掉。
      assert(Array.isArray(r.json.lines), `lines 该是数组：${r.text.slice(0, 200)}`)
      assert(r.json.seatId === 'seat-1', `seatId=${r.json.seatId}`)
    })

    await test('席位诊断：不认识的席位给结论，不是 500', async () => {
      const r = await req(mgrBase, 'GET', '/seats/seat-nope/diag', { token: machineTok })
      assert(r.status === 200, `未知席位也该正常回，实际 ${r.status} ${r.text}`)
      assert(r.json.diag.seat === null, 'seat 该是 null')
      assert(r.json.diag.notes.length > 0, '该说清楚「名册里没有这个席位」')
    })

    await test('拆席位：名册里没了，反代跟着 404', async () => {
      const r = await req(mgrBase, 'DELETE', '/seats/seat-1', { token: machineTok })
      assert(r.status === 200, `拆 ${r.status} ${r.text}`)
      const list = await req(mgrBase, 'GET', '/seats', { token: machineTok })
      assert(list.json.seats.length === 0, '名册没清干净')
      const gone = await fetch(`${mgrBase}/seats/seat-1/bot/api/x`, {
        headers: { 'x-satuwork-machine': machineTok },
      })
      assert(gone.status === 404, `拆完还转 ${gone.status}`)
    })

    await test('心跳带回期望版本；没发过管家包时为 null', async () => {
      const r = await req(gwBase, 'POST', `/internal/machines/${(await machineIdOf(req, gwBase, ownerTok, orgId))}/heartbeat`, {
        token: machineTok,
        body: { managerVersion: 'e2e-1', protocol: 1, node: process.versions.node, seats: [] },
      })
      assert(r.status === 200, `heartbeat ${r.status} ${r.text}`)
      assert(r.json.desiredManagerVersion === null, `期望版本 ${r.json.desiredManagerVersion}`)
      assert(r.json.minNode >= 24, 'minNode')
      assert(r.json.minProtocol >= 1, 'minProtocol')
      const m = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(m.json.machine.managerVersion === 'e2e-1', '心跳应更新管家版本')
    })

    await test('机器时区：坏名字挡在 Gateway，好名字下发给机器，实际值由心跳自报', async () => {
      // 时区和管家版本走同一条路——Gateway 没有登录这台机器的凭据，只能在心跳响应里
      // 把期望值带下去。所以这条要盯的是三件事：认不认识的名字有没有就地回绝、期望值
      // 有没有真的进心跳、以及**期望和实际是不是两格**。合成一格的话，「指令下了但机器
      // 没改上」在界面上和「改好了」长得一模一样，那正是这个功能最需要看出来的状态。
      const id = await machineIdOf(req, gwBase, ownerTok, orgId)
      const tzUrl = `/platform/orgs/${orgId}/machines/${id}/timezone`

      for (const bad of ['Asia/Shanghi', '../../etc/passwd', 'Asia/Shanghai; reboot']) {
        const r = await req(gwBase, 'PUT', tzUrl, { token: ownerTok, body: { timezone: bad } })
        assert(r.status === 400, `${bad} 应 400，得到 ${r.status} ${r.text}`)
      }

      // 大小写不规范的名字要归一，否则库里同一个时区会存出好几种拼法，
      // 而「实际 == 期望」这个判断是按字符串比的。
      const set = await req(gwBase, 'PUT', tzUrl, { token: ownerTok, body: { timezone: 'asia/shanghai' } })
      assert(set.status === 200, `设时区 ${set.status} ${set.text}`)
      assert(set.json.machine.timezone === 'Asia/Shanghai', `没归一：${set.json.machine.timezone}`)
      assert(set.json.pending === true, '机器还没报回来，这一刻只能是 pending')

      const body = { managerVersion: 'e2e-1', protocol: 1, node: process.versions.node, seats: [] }
      const hb = await req(gwBase, 'POST', `/internal/machines/${id}/heartbeat`, { token: machineTok, body })
      assert(hb.json.timezone === 'Asia/Shanghai', `心跳没下发时区：${JSON.stringify(hb.json.timezone)}`)

      // 机器自报实际时区之后，pending 才落下去。
      await req(gwBase, 'POST', `/internal/machines/${id}/heartbeat`, {
        token: machineTok,
        body: { ...body, timezone: 'Asia/Shanghai' },
      })
      const card = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machines[0]
      assert(card.machine.currentTimezone === 'Asia/Shanghai', `实际时区 ${card.machine.currentTimezone}`)
      assert(card.timezonePending === false, '实际和期望对上了就不该再 pending')

      // 机器报一个不认识的名字：宁可当成「没报」，也不能存进去——存了的话
      // 「改上了没有」这个判断从此就是错的。
      await req(gwBase, 'POST', `/internal/machines/${id}/heartbeat`, {
        token: machineTok,
        body: { ...body, timezone: 'Mars/Olympus' },
      })
      const after = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machines[0]
      assert(after.machine.currentTimezone === 'Asia/Shanghai', `坏值被当真了：${after.machine.currentTimezone}`)

      // 清空 = 不再管这台机器的时区。**不是**改成 UTC——心跳里必须是 null，
      // 否则没人指定过时区的机器会被凭空改掉。
      const clear = await req(gwBase, 'PUT', tzUrl, { token: ownerTok, body: { timezone: '' } })
      assert(clear.status === 200, `清空 ${clear.status} ${clear.text}`)
      assert(clear.json.machine.timezone === null, `没清掉：${clear.json.machine.timezone}`)
      const idle = await req(gwBase, 'POST', `/internal/machines/${id}/heartbeat`, { token: machineTok, body })
      assert(idle.json.timezone === null, `清空后仍在下发：${JSON.stringify(idle.json.timezone)}`)
    })

    await test('通联指示灯：四态按心跳新旧分，编号按登记先后给', async () => {
      // 这盏灯要答的是「哪台不对」，而它唯一的判据是心跳有多久没来了。四档的边界不能
      // 只靠读代码确认——`stale` 那一档存在的理由（换版重启会断几十秒，不该闪红灯）
      // 恰恰是最容易在后来的重构里被合并掉的。
      //
      // 造一台**假机器**来测，不动真管家那台：真管家每 30 秒心跳一次，改它的
      // lastHeartbeatAt 会被下一轮覆盖，断言就成了掷骰子。
      const { createRequire } = await import('node:module')
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      const fake = '00000000-0000-4000-8000-0000000000ff'
      const linkOf = async () => {
        const r = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
        return r.json.machines.find((c) => c.machine.id === fake)
      }
      try {
        await client.query('set search_path to e2e_manager')
        await client.query(
          `insert into machines (id, host, "companyId", "lastHeartbeatAt", "createdAt", "pairedAt", protocol, "maxAccounts", token)
           values ($1, 'http://10.0.0.99:8443', $2, $3, $3, $3, 1, 10, 'smt_e2e-link-probe')`,
          [fake, orgId, Date.now()],
        )

        const online = await linkOf()
        assert(online, '假机器没出现在列表里')
        assert(online.machine.link === 'online', `刚心跳过该是 online，得到 ${online.machine.link}`)
        assert(online.machine.heartbeatAge != null && online.machine.heartbeatAge < 5000, `heartbeatAge=${online.machine.heartbeatAge}`)

        // 3 轮心跳（90 秒）之内还算在线——换版重启就落在这个区间里，报红等于狼来了。
        const at = async (agoMs) => {
          await client.query('update machines set "lastHeartbeatAt" = $1 where id = $2', [Date.now() - agoMs, fake])
          return (await linkOf()).machine.link
        }
        assert((await at(80_000)) === 'online', '80 秒（不到 3 轮）还该是 online')
        assert((await at(5 * 60_000)) === 'stale', '5 分钟该是 stale')
        assert((await at(2 * 3600_000)) === 'offline', '2 小时该是 offline')

        // 没配对是**单独一档**，不能并进 offline：前者是还没装，后者是装了但出事了，
        // 处置完全不同（一个去跑安装脚本，一个去看机器还在不在）。
        await client.query('update machines set "pairedAt" = null where id = $1', [fake])
        assert((await linkOf()).machine.link === 'unpaired', '没配对该是 unpaired')

        // 编号按登记先后：真管家那台先配对，是 1 号；假机器后插，是 2 号。
        const all = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machines
        assert(all.length === 2, `该有两台，实际 ${all.length}`)
        assert(all[0].no === 1 && all[1].no === 2, `编号不对：${all.map((c) => c.no).join(',')}`)
        assert(all[1].machine.id === fake, '2 号该是后插的那台')
      } finally {
        await client.query('delete from machines where id = $1', [fake]).catch(() => {})
        await client.end().catch(() => {})
      }
    })

    await test('管家自己的日志：无票 401，有票给得出结构', async () => {
      // 部署失败、升级卡住、配对回拨不通，全写在管家的 journal 里——席位的日志里
      // 一个字都没有。平台端排查「这台机器怎么了」看的是这条。
      const anon = await fetch(`${mgrBase}/logs`)
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)
      const r = await req(mgrBase, 'GET', '/logs?lines=5', { token: machineTok })
      assert(r.status === 200, `logs ${r.status} ${r.text}`)
      assert(Array.isArray(r.json.lines), `lines 该是数组：${r.text.slice(0, 200)}`)
      assert(/satuwork-manager/.test(r.json.unit || ''), `unit 不对：${r.json.unit}`)
    })

    await test('平台端看机器日志：只有 owner，席位必须是这台机器上的，且留审计', async () => {
      const machineId = await machineIdOf(req, gwBase, ownerTok, orgId)
      const base = `/platform/orgs/${orgId}/machines/${machineId}/logs`

      const anon = await req(gwBase, 'GET', base)
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)

      const ok = await req(gwBase, 'GET', `${base}?lines=5`, { token: ownerTok })
      assert(ok.status === 200, `管家日志 ${ok.status} ${ok.text}`)
      assert(Array.isArray(ok.json.lines), `lines 该是数组：${ok.text.slice(0, 200)}`)

      // seatId 会进 systemd 单元名，只认这台机器上的——别处的值一律挡掉。
      const bad = await req(gwBase, 'GET', `${base}?seatId=seat-not-here`, { token: ownerTok })
      assert(bad.status === 404, `外来 seatId 该 404，实际 ${bad.status} ${bad.text}`)

      // 席位日志里有员工的对话正文和执行过的命令。这和「看别人的屏幕」是同一类
      // 动作，必须留痕。
      const audit = await req(gwBase, 'GET', `/orgs/${orgId}/audit`, { token: ownerTok })
      assert(audit.status === 200, `audit ${audit.status} ${audit.text}`)
      const rows = audit.json.events || audit.json.rows || []
      assert(
        rows.some((e) => e.action === 'machine.logs'),
        `审计里没有 machine.logs：${JSON.stringify(rows.map((e) => e.action)).slice(0, 300)}`,
      )
    })

    await test('管家自报机器时区，答得上「现在是什么时区」', async () => {
      const r = await req(mgrBase, 'GET', '/health', { token: machineTok })
      assert(r.status === 200, `health ${r.status}`)
      assert('timezone' in r.json, '/health 要报机器时区')
      assert('timezoneError' in r.json, '改时区失败要报得出来，不能只写日志')
    })


    await test('平台钉住的管家版本要存得住，并且真的下发给机器', async () => {
      // 这一条曾经是**假通过**的：路由层收下 managerVersion、拼进 next、返回 200，
      // 而 db.putPlatformSettings 拼 payload 时根本没写这个字段，读端也没解析它。
      // 于是「全机队钉版本」这一级完全是死的——传个包上去，所有没有逐台钉过的机器
      // 都会自己升，唯一能拦住的开关看着能设、其实存不进去。
      // 钉住的版本必须真有对应的包：desiredManagerRelease 查不到就会静悄悄回落到
      // 「最新」，那样这条用例即使在坏代码下也可能碰巧过。先传一个真包上去。
      const { tarGz, sha256Of } = await import('./release.mjs')
      const pinnedPkg = tarGz([
        { name: './bin/satuwork-manager.mjs', data: '#!/usr/bin/env node\n' },
        { name: './VERSION', data: 'pinned-9.9.9\n' },
      ])
      const up = await req(gwBase, 'PUT', '/platform/manager-releases/pinned-9.9.9', {
        token: ownerTok,
        raw: pinnedPkg,
        headers: { 'content-type': 'application/gzip', 'x-bot-sha256': sha256Of(pinnedPkg) },
      })
      assert(up.status === 200, `传包 ${up.status} ${up.text}`)

      const before = (await req(gwBase, 'GET', '/platform/settings', { token: ownerTok })).json
      try {
        const put = await req(gwBase, 'PUT', '/platform/settings', {
          token: ownerTok,
          body: { managerVersion: 'pinned-9.9.9' },
        })
        assert(put.status === 200, `PUT ${put.status} ${put.text}`)
        assert(put.json.managerVersion === 'pinned-9.9.9', `回显 ${JSON.stringify(put.json.managerVersion)}`)

        // 关键：**重新读一次**。回显对不代表落库了——原来的 bug 里回显走的是
        // 重新读库的结果，所以连回显都是空的；但换个实现回显很容易假对。
        const back = await req(gwBase, 'GET', '/platform/settings', { token: ownerTok })
        assert(back.json.managerVersion === 'pinned-9.9.9', `重读 ${JSON.stringify(back.json.managerVersion)}`)

        // 存住还不够，得真的下发到心跳里去——那才是机器唯一的依据。
        const id = await machineIdOf(req, gwBase, ownerTok, orgId)
        const hb = await req(gwBase, 'POST', `/internal/machines/${id}/heartbeat`, {
          token: machineTok,
          body: { managerVersion: 'e2e-1', protocol: 1, node: process.versions.node, seats: [] },
        })
        assert(hb.json.desiredManagerVersion === 'pinned-9.9.9', `心跳下发的是 ${JSON.stringify(hb.json.desiredManagerVersion)}`)

        // 清掉 = 回到「跟最新发布走」。
        await req(gwBase, 'PUT', '/platform/settings', { token: ownerTok, body: { managerVersion: '' } })
        const cleared = await req(gwBase, 'GET', '/platform/settings', { token: ownerTok })
        assert(!cleared.json.managerVersion, `清不掉：${JSON.stringify(cleared.json.managerVersion)}`)
      } finally {
        await req(gwBase, 'PUT', '/platform/settings', { token: ownerTok, body: before })
      }
    })

    await test('登记远端包：验证过才入库，size/sha256 对不上就拒', async () => {
      // 拿一个真的 tar.gz 挂在 mock HTTP 上，走完整的「拉下来核对」流程。
      const { tarGz, sha256Of } = await import('./release.mjs')
      const pkg = tarGz([
        { name: './bin/satuwork-manager.mjs', data: '#!/usr/bin/env node\n' },
        { name: './VERSION', data: 'remote-1\n' },
      ])
      const host = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/gzip' })
        res.end(pkg)
      })
      const port = await listenOn(host, 0)
      const url = `http://127.0.0.1:${port}/manager.tgz`
      try {
        const bad = await req(gwBase, 'POST', '/platform/manager-releases', {
          token: ownerTok,
          body: { version: 'remote-1', url, size: pkg.length + 1, sha256: sha256Of(pkg) },
        })
        assert(bad.status === 400 && String(bad.json.error).includes('大小'), `size 不符应 400：${bad.status} ${bad.text}`)

        const badSha = await req(gwBase, 'POST', '/platform/manager-releases', {
          token: ownerTok,
          body: { version: 'remote-1', url, size: pkg.length, sha256: 'f'.repeat(64) },
        })
        assert(badSha.status === 400 && String(badSha.json.error).includes('sha256'), `sha 不符应 400：${badSha.status}`)

        const noHost = await req(gwBase, 'POST', '/platform/manager-releases', {
          token: ownerTok,
          body: { version: 'remote-2', url: 'http://127.0.0.1:1/x.tgz', size: 10, sha256: '0'.repeat(64) },
        })
        assert(noHost.status === 502, `取不到应 502：${noHost.status}`)

        const ok = await req(gwBase, 'POST', '/platform/manager-releases', {
          token: ownerTok,
          body: { version: 'remote-1', url, size: pkg.length, sha256: sha256Of(pkg) },
        })
        assert(ok.status === 201, `登记 ${ok.status} ${ok.text}`)
        assert(ok.json.release.url === url, 'url 要存下来')
        assert(ok.json.release.storage === 'remote', 'storage')

        // 下发时从远端现取，并且校验头还在——这条决定了管家能不能验完整性。
        const dl = await fetch(`${gwBase}/internal/manager-releases/remote-1`, {
          headers: { authorization: 'Bearer ' + machineTok },
        })
        assert(dl.status === 200, `下发 ${dl.status}`)
        assert(dl.headers.get('x-bot-sha256') === sha256Of(pkg), '校验头丢了')
        assert(Buffer.from(await dl.arrayBuffer()).equals(pkg), '字节对不上')
      } finally {
        host.close()
      }
    })

    await test('平台机器管理：列得出所有机器，改得动配置，归属改得回来', async () => {
      // 这一组和 /platform/orgs/:id/machine 是**两个口径**，两个都要有：那条答的是
      // 「这家公司有几台」，这条答的是「这台 Gateway 上挂着哪些机器」。差别不只是
      // 入口——没派给任何公司的机器在按公司列的那条路上永远列不出来。
      const machineId = await machineIdOf(req, gwBase, ownerTok, orgId)

      const anon = await req(gwBase, 'GET', '/platform/machines')
      assert(anon.status === 401, `无票该 401，实际 ${anon.status}`)

      // 公司管理员看不到别家的机器，这一整组都是 owner 的。
      const adminLogin = await req(gwBase, 'POST', '/auth/login', {
        body: { email: 'admin@mgrtest.local', password: 'manager-admin-1234' },
      })
      assert(adminLogin.status === 200, `admin login ${adminLogin.status} ${adminLogin.text}`)
      const asAdmin = await req(gwBase, 'GET', '/platform/machines', { token: adminLogin.json.token })
      assert(asAdmin.status === 403, `公司管理员该 403，实际 ${asAdmin.status} ${asAdmin.text}`)

      const list = await req(gwBase, 'GET', '/platform/machines', { token: ownerTok })
      assert(list.status === 200, `list ${list.status} ${list.text}`)
      const row = (list.json.machines || []).find((c) => c.machine.id === machineId)
      assert(row, `列表里没有这台机器：${list.text.slice(0, 300)}`)
      assert(row.company && row.company.id === orgId, `归属公司没带出来：${JSON.stringify(row.company)}`)
      // 编号在平台这一侧必须是 null：「1 号机」是一家公司内部数出来的短号，两家公司
      // 的机器摆在同一张表里，两个「1 号机」并排会指代不清。
      assert(row.no === null, `平台侧不该有编号：${row.no}`)
      assert(list.json.totals.machines >= 1 && list.json.totals.paired >= 1, `totals 不对：${JSON.stringify(list.json.totals)}`)

      const one = await req(gwBase, 'GET', `/platform/machines/${machineId}`, { token: ownerTok })
      assert(one.status === 200, `detail ${one.status} ${one.text}`)
      assert(one.json.machine.id === machineId, 'detail 的机器不对')
      // 席位清单和「席位数」不能撞在同一个键上：撞了的话详情页上那个数字会变成
      // 一串 [object Object]，而 `有没有席位` 这类判断会因为「空数组是真值」整个翻过来。
      assert(Array.isArray(one.json.seatList), 'seatList 该是数组')
      assert(typeof one.json.seats === 'number', `seats 该是个数：${JSON.stringify(one.json.seats)}`)
      // 席位行要自带人名和 Bot 名。少了它们，界面上那一列只能显示 uuid——前端手上
      // 那份 Bot 名录是别的页面顺带装进去的，这一页从不加载。
      for (const seat of one.json.seatList) {
        assert('who' in seat && 'botName' in seat, `席位行少了名字：${JSON.stringify(seat)}`)
      }
      // 列表页只画汇总，不该为每台机器白跑一轮按席位的账号查询。
      const listRow = (await req(gwBase, 'GET', '/platform/machines', { token: ownerTok })).json.machines.find(
        (c) => c.machine.id === machineId,
      )
      assert(!('seatList' in listRow), '列表页不用席位清单，就别带上它')
      // 反过来，公司详情那条**必须**还带着它：那一页的日志选择器要靠它列出席位。
      const orgCard = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machines.find(
        (c) => c.machine.id === machineId,
      )
      assert(Array.isArray(orgCard.seatList), '公司侧的机器卡片把席位清单弄丢了')
      assert((one.json.companies || []).some((c) => c.id === orgId), '改归属要用的公司清单没给')
      const miss = await req(gwBase, 'GET', '/platform/machines/00000000-0000-4000-8000-00000000dead', { token: ownerTok })
      assert(miss.status === 404, `不存在的机器该 404，实际 ${miss.status}`)

      // 容量与时区：和公司侧那条改的是同一行，两边看到的必须是同一个值。
      const cap = await req(gwBase, 'PUT', `/platform/machines/${machineId}/capacity`, {
        token: ownerTok,
        body: { maxAccounts: 33 },
      })
      assert(cap.status === 200, `capacity ${cap.status} ${cap.text}`)
      const viaOrg = (await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })).json.machines.find(
        (c) => c.machine.id === machineId,
      )
      assert(viaOrg.maxAccounts === 33, `公司侧看到的容量是 ${viaOrg.maxAccounts}`)
      assert(
        (await req(gwBase, 'PUT', `/platform/machines/${machineId}/capacity`, { token: ownerTok, body: { maxAccounts: 0 } }))
          .status === 400,
        '容量 0 该 400',
      )
      await req(gwBase, 'PUT', `/platform/machines/${machineId}/capacity`, { token: ownerTok, body: { maxAccounts: 10 } })

      const badTz = await req(gwBase, 'PUT', `/platform/machines/${machineId}/timezone`, {
        token: ownerTok,
        body: { timezone: 'Asia/Shanghi' },
      })
      assert(badTz.status === 400, `坏时区该 400，实际 ${badTz.status}`)
      const tz = await req(gwBase, 'PUT', `/platform/machines/${machineId}/timezone`, {
        token: ownerTok,
        body: { timezone: 'asia/singapore' },
      })
      assert(tz.status === 200 && tz.json.machine.timezone === 'Asia/Singapore', `时区 ${tz.status} ${tz.text}`)
      await req(gwBase, 'PUT', `/platform/machines/${machineId}/timezone`, { token: ownerTok, body: { timezone: '' } })

      // 地址：改完当场探活。这台真管家在，所以 reachable 必须为真——不然「保存成功」
      // 就成了一句没人验过的话。
      const host = await req(gwBase, 'PUT', `/platform/machines/${machineId}/host`, {
        token: ownerTok,
        body: { host: mgrBase },
      })
      assert(host.status === 200, `host ${host.status} ${host.text}`)
      assert(host.json.reachable === true, `探活没通：${host.json.error}`)
      assert((await req(gwBase, 'PUT', `/platform/machines/${machineId}/host`, { token: ownerTok, body: { host: '' } })).status === 400, '空地址该 400')

      // 日志跟公司侧那条一样要留审计，也一样只认这台机器上的席位。
      const logs = await req(gwBase, 'GET', `/platform/machines/${machineId}/logs?lines=5`, { token: ownerTok })
      assert(logs.status === 200, `logs ${logs.status} ${logs.text}`)
      assert(Array.isArray(logs.json.lines), `lines 该是数组：${logs.text.slice(0, 200)}`)
      const badSeat = await req(gwBase, 'GET', `/platform/machines/${machineId}/logs?seatId=seat-not-here`, { token: ownerTok })
      assert(badSeat.status === 404, `外来 seatId 该 404，实际 ${badSeat.status}`)

      // 归属：收回来再派回去。收回之后它仍然列得出来——这正是这一页存在的理由。
      const off = await req(gwBase, 'PUT', `/platform/machines/${machineId}/company`, { token: ownerTok, body: { companyId: '' } })
      assert(off.status === 200, `收回 ${off.status} ${off.text}`)
      const orphan = (await req(gwBase, 'GET', '/platform/machines', { token: ownerTok })).json.machines.find(
        (c) => c.machine.id === machineId,
      )
      assert(orphan && orphan.company === null, `收回后该是无归属，实际 ${JSON.stringify(orphan && orphan.company)}`)
      const gone = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(!gone.json.machines.some((c) => c.machine.id === machineId), '收回后不该还挂在公司名下')

      const badOrg = await req(gwBase, 'PUT', `/platform/machines/${machineId}/company`, {
        token: ownerTok,
        body: { companyId: '00000000-0000-4000-8000-00000000dead' },
      })
      assert(badOrg.status === 404, `不存在的公司该 404，实际 ${badOrg.status}`)

      const back = await req(gwBase, 'PUT', `/platform/machines/${machineId}/company`, { token: ownerTok, body: { companyId: orgId } })
      assert(back.status === 200, `派回 ${back.status} ${back.text}`)
      const again = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      assert(again.json.machine && again.json.machine.id === machineId, '派回之后该重新成为这家公司的默认机器')
    })

    await test('配对码一次性：同一个码换不了第二把票', async () => {
      const r = await req(gwBase, 'POST', '/machines/pair', {
        body: { code, managerPort: MGR_PORT, protocol: 1 },
      })
      assert(r.status === 401, `重放 ${r.status}`)
    })
  } finally {
    bot.server.close()
    novnc.server.close()
    rmSync(GW_HOME, { recursive: true, force: true })
    rmSync(MGR_HOME, { recursive: true, force: true })
  }
}

async function machineIdOf(req, gwBase, ownerTok, orgId) {
  const m = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
  return m.json.machine.id
}

/** 弄一张桌面票。走 owner 的支持入口——它就是为「替员工打开桌面」存在的。 */
async function mintTicket(gwBase, ownerTok) {
  const r = await fetch(`${gwBase}/platform/desktop-ticket?seatId=seat-1`, {
    headers: { authorization: 'Bearer ' + ownerTok },
  })
  if (!r.ok) throw new Error(`签票失败 ${r.status} ${await r.text()}`)
  return (await r.json()).ticket
}

/**
 * 自己签一张**带 VNC 口令**的桌面票。
 *
 * 为什么不走 /platform/desktop-ticket：那个接口只按 seatId 签，拿不到口令——真正带口令
 * 的是「打开桌面」那条路（desktopTicketFor），而它要求 Gateway 库里有这个席位的
 * seat_runtimes 行。本套件的 seat-1 是管家侧登记的假席位，Gateway 那边没有。
 *
 * 所以直接用 Gateway 落盘的私钥签一张，形状和 signDesktopTicket 完全一致。验的是管家
 * 那半边：**票里带了口令，落地页就该把它交给 noVNC**。
 */
function mintTicketWithPassword(gwHome, seatId, vnc) {
  const priv = readFileSync(join(gwHome, 'keys', 'jwt-private.pem'), 'utf8')
  const pub = readFileSync(join(gwHome, 'keys', 'jwt-public.pem'), 'utf8')
  const kid = createHash('sha256').update(pub).digest('hex').slice(0, 16)
  const now = Math.floor(Date.now() / 1000)
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const h = b64({ alg: 'RS256', typ: 'JWT', kid })
  const p = b64({ typ: 'satu-desktop', seatId, iat: now, exp: now + 300, vnc })
  return `${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), priv).toString('base64url')}`
}
