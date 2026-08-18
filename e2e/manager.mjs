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
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { existsSync, rmSync } from 'node:fs'
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
      assert(String(r.headers.get('location')).endsWith('/vnc.html'), 'location')
      const setCookie = String(r.headers.get('set-cookie') || '')
      assert(setCookie.includes('HttpOnly'), 'cookie 要 HttpOnly')
      assert(setCookie.includes('Path=/seats/seat-1/vnc'), 'cookie 要限定到这个席位')
      deskCookie = setCookie.split(';')[0]
    })

    await test('拿着 cookie 能取 noVNC 静态资源，也能建 WebSocket', async () => {
      const page = await fetch(`${mgrBase}/seats/seat-1/vnc/vnc.html`, { headers: { cookie: deskCookie } })
      assert(page.status === 200, `静态 ${page.status}`)
      const ws = await wsHandshake(MGR_PORT, '/seats/seat-1/vnc/websockify', deskCookie)
      assert(ws.includes('101'), `升级失败: ${ws.slice(0, 120)}`)
      assert(ws.includes('HELLO-WS'), '升级后字节没通')
      const noAuth = await wsHandshake(MGR_PORT, '/seats/seat-1/vnc/websockify', '')
      assert(noAuth.includes('401'), `无 cookie 的升级应 401: ${noAuth.slice(0, 80)}`)
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
