/**
 * Gateway 对话反代：Bot 无头运行时登记 host，Gateway 反代 SSE / 发消息。
 * 独立 home / 端口，不碰 live 3080，不碰 run.mjs 那套 /tmp/satuwork-e2e-gw。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { createCompany } from './org.mjs'
import { publishRelease } from './release.mjs'
import { pairMachine } from './pair.mjs'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function readSse(url, { token, timeout = 8000, until } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeout)
  const r = await fetch(url, {
    headers: {
      accept: 'text/event-stream',
      ...(token ? { authorization: 'Bearer ' + token } : {}),
    },
    signal: ac.signal,
  })
  const events = []
  let text = ''
  if (!r.ok || !r.body) {
    text = await r.text().catch(() => '')
    clearTimeout(timer)
    return { status: r.status, events, text }
  }
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            events.push(JSON.parse(line.slice(6)))
          } catch {}
        }
        if (until && until(events)) {
          clearTimeout(timer)
          ac.abort()
          return { status: r.status, events, text }
        }
      }
    }
  } catch {
    /* abort / timeout */
  } finally {
    clearTimeout(timer)
    try {
      ac.abort()
    } catch {}
  }
  return { status: r.status, events, text }
}

export async function runGatewayChat({ gwRoot, botRoot, test, req, start, waitHttp, assert, log, treeHas }) {
  const GW_HOME = '/tmp/satuwork-e2e-chat-gw'
  const BOT_HOME = '/tmp/satuwork-e2e-chat-bot'
  const GW_PORT = 18280
  const BOT_PORT = 18282
  const MACHINE_TOK = 'e2e-chat-machine'
  const PLATFORM_TOK = 'e2e-chat-platform'
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  const botBase = `http://127.0.0.1:${BOT_PORT}`
  const MARKER = 'CHAT-BODY-MUST-NOT-LAND-ON-GATEWAY-7F3A'

  rmSync(GW_HOME, { recursive: true, force: true })
  rmSync(BOT_HOME, { recursive: true, force: true })

  let gw
  let botChild
  log('\n# gateway-chat')

  try {
    gw = start('chat-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
      cwd: gwRoot,
      env: {
        SATUWORK_GATEWAY_HOME: GW_HOME,
        GATEWAY_DATABASE_URL: PG_URL,
        GATEWAY_PG_SCHEMA: 'e2e_chat',
        GATEWAY_PG_RESET: '1',
        GATEWAY_HOST: '127.0.0.1',
        GATEWAY_PORT: String(GW_PORT),
        GATEWAY_MACHINE_TOKEN: MACHINE_TOK,
        GATEWAY_PLATFORM_TOKEN: PLATFORM_TOK,
        GATEWAY_ACCESS_HOST: 'satuwork.com',
        GATEWAY_SEED_OWNER: '1',
        GATEWAY_OWNER_EMAIL: 'owner@chat.test',
        GATEWAY_OWNER_PASSWORD: 'test-owner-chat',
        SATUWORK_DEPLOY_STUB: '1',
      },
    })
    await waitHttp(gwBase + '/health')

    const reg = await createCompany(req, gwBase, {
      ownerEmail: 'owner@chat.test',
      ownerPassword: 'test-owner-chat',
      email: 'admin@chat.test',
      password: 'correct-horse',
      companyName: 'ChatCo',
      slug: 'chatco',
      seats: 2,
    })
    const adminTok = reg.token
    const orgId = reg.company.id

    const memberCreate = await req(gwBase, 'POST', `/orgs/${orgId}/accounts`, {
      token: adminTok,
      body: { email: 'member@chat.test', password: 'correct-horse', role: 'member' },
    })
    assert(memberCreate.status === 201, `member ${memberCreate.status} ${memberCreate.text}`)
    const memberLogin = await req(gwBase, 'POST', '/auth/login', {
      body: { email: 'member@chat.test', password: 'correct-horse' },
    })
    assert(memberLogin.status === 200, `member login ${memberLogin.status}`)
    const memberTok = memberLogin.json.token

    const ownerTok = reg.ownerToken
    const adminId = reg.account.id
    const seat = await req(gwBase, 'GET', `/platform/accounts/${adminId}`, { token: ownerTok })
    assert(seat.status === 200, `seat secrets ${seat.status} ${seat.text}`)
    const seatAccess = seat.json.accessToken
    const seatApiKey = seat.json.apiKey

    /**
     * 用**全局 Bot**：下面几条要验的是「同一颗 Bot 在管理员和员工两边都在名册里」，
     * 而员工自己建的 Bot 只有本人看得见（公司这一层现在是一份模版，不再有共享 Bot）。
     */
    const createdBot = await req(gwBase, 'POST', '/platform/bots', {
      token: ownerTok,
      body: { name: '对话 Bot' },
    })
    assert(createdBot.status === 201, `global bot ${createdBot.status} ${createdBot.text}`)
    const catalogBotId = createdBot.json.bot.id
    let machineTok

    await test('owner GET /runtime/bots → 403', async () => {
      const r = await req(gwBase, 'GET', '/runtime/bots', { token: ownerTok })
      assert(r.status === 403, `owner ${r.status} ${r.text}`)
    })

    await test('成员无实例 GET /runtime/bots → 200 名册有 bot、runtime 空', async () => {
      const r = await req(gwBase, 'GET', '/runtime/bots', { token: memberTok })
      assert(r.status === 200, `member ${r.status} ${r.text}`)
      assert(Array.isArray(r.json.bots), 'bots array')
      const hit = (r.json.bots || []).find((b) => b.id === catalogBotId)
      assert(hit, '名册没有那颗全局 Bot')
      assert(hit.runtime == null, 'member runtime 应为空')
    })

    await test('管理员无实例 GET /runtime/bots → 200', async () => {
      const r = await req(gwBase, 'GET', '/runtime/bots', { token: adminTok })
      assert(r.status === 200, `admin ${r.status} ${r.text}`)
      const hit = (r.json.bots || []).find((b) => b.id === catalogBotId)
      assert(hit, 'admin 名册没有公司 Bot')
      assert(hit.runtime == null, 'admin runtime 应为空')
    })

    await test('无实例 GET /runtime/bots/:id/session → 503 实例还没上线', async () => {
      const r = await req(gwBase, 'GET', `/runtime/bots/${catalogBotId}/session`, { token: adminTok })
      assert(r.status === 503, `session ${r.status} ${r.text}`)
      assert(String(r.json.error || r.text).includes('实例还没上线'), '503 文案')
    })

    const paired = await pairMachine({ req, gwBase, ownerTok, orgId })
    machineTok = paired.token
    assert(typeof machineTok === 'string' && machineTok.startsWith('smt_'), 'smt_')

    await test('POST /internal/instances/:id/ready 校验 host / 账号 / botId', async () => {
      const orgMach = await req(gwBase, 'GET', `/orgs/${orgId}/machine`, { token: adminTok })
      assert(!Object.prototype.hasOwnProperty.call(orgMach.json.machine || {}, 'token'), 'admin machine 带 token')

      const me = await req(gwBase, 'GET', '/me', { token: adminTok })
      const accountId = me.json.account.id
      const boot = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
        token: MACHINE_TOK,
        body: { host: 'http://127.0.0.1:9', botId: catalogBotId },
      })
      assert(boot.status === 401, `bootstrap ready ${boot.status}`)
      const missBot = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
        token: machineTok,
        body: { host: 'http://127.0.0.1:9' },
      })
      assert(missBot.status === 400, `missing botId ${missBot.status}`)
      const miss = await req(gwBase, 'POST', '/internal/instances/no-such/ready', {
        token: machineTok,
        body: { host: 'http://127.0.0.1:9', botId: catalogBotId },
      })
      assert(miss.status === 404, `missing account ${miss.status}`)
      const bad = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
        token: machineTok,
        body: { host: 'ftp://127.0.0.1:9', botId: catalogBotId },
      })
      assert(bad.status === 400, `bad proto ${bad.status}`)
      const pathHost = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
        token: machineTok,
        body: { host: 'http://127.0.0.1:9/api', botId: catalogBotId },
      })
      assert(pathHost.status === 400, `path host ${pathHost.status}`)
      const never = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
        token: machineTok,
        body: { host: botBase, botId: catalogBotId },
      })
      assert(never.status === 404, `never deployed ${never.status} ${never.text}`)
      assert(String(never.json.error || never.text).includes('还没有部署'), '404 文案')
    })

    await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0', note: 'e2e-chat' })
    const dep = await req(gwBase, 'POST', '/runtime/deploy', {
      token: adminTok,
      body: { botId: catalogBotId },
    })
    assert(dep.status === 200, `stub deploy ${dep.status} ${dep.text}`)
    assert(!Object.prototype.hasOwnProperty.call(dep.json, 'botPort'), 'deploy 含 botPort')

    botChild = start('chat-bot', ['--import', 'tsx', join(botRoot, 'e2e-boot.mjs')], {
      cwd: botRoot,
      env: {
        SATUWORK_HOME: BOT_HOME,
        SATUWORK_PORT: String(BOT_PORT),
        SATUWORK_BOT_ID: catalogBotId,
        GATEWAY_URL: gwBase,
        GATEWAY_TOKEN: seatAccess,
        GATEWAY_API_KEY: seatApiKey,
        E2E_STUB_LLM: '1',
      },
    })
    await waitHttp(botBase + '/api/health', { timeout: 45000 })
    assert(!botChild._exited, 'bot 启动后就退出了')

    const botId = catalogBotId
    let sessionId

    await test('Bot 上报 ready 后 GET /runtime/bots/:id/session → sessionId', async () => {
      const deadline = Date.now() + 20000
      let last
      while (Date.now() < deadline) {
        const r = await req(gwBase, 'GET', `/runtime/bots/${botId}/session`, { token: adminTok })
        last = r
        if (r.status === 200 && typeof r.json.sessionId === 'string' && r.json.sessionId) {
          sessionId = r.json.sessionId
          return
        }
        await sleep(200)
      }
      assert(false, `ready 未到 ${last?.status} ${last?.text}`)
    })

    await test('POST /runtime/sessions/:id/messages ping → accepted/steered', async () => {
      const r = await req(gwBase, 'POST', `/runtime/sessions/${sessionId}/messages`, {
        token: adminTok,
        body: { text: `ping ${MARKER}` },
      })
      assert(r.status === 200, `message ${r.status} ${r.text}`)
      assert(r.json.accepted === true || r.json.steered === true, 'accepted/steered')
    })

    await test('@ 点名：Gateway 把失效的剔掉，不让它进席位', async () => {
      /**
       * 这一条守的是不变量：**席位收到什么就注入什么**——它信的是那张 `sat_` 票，
       * 票背后是谁由 Gateway 说了算。所以浏览器编一个连接 id 上来，必须在这一跳被
       * 挡掉，而不是让整条消息失败：用户那句话没有错，错的是一个已经失效的点名。
       */
      const r = await req(gwBase, 'POST', `/runtime/sessions/${sessionId}/messages`, {
        token: adminTok,
        body: {
          text: `mention ${MARKER}`,
          mentions: [{ kind: 'connector', id: 'conn-not-mine', label: '别人的 Gmail' }],
        },
      })
      assert(r.status === 200, `message ${r.status} ${r.text}`)
      assert(Array.isArray(r.json.droppedMentions), `该说明剔掉了什么：${r.text}`)
      assert(r.json.droppedMentions.includes('conn-not-mine'), `没剔掉伪造的点名：${r.text}`)
      assert(r.json.accepted === true || r.json.steered === true || r.json.queued === true, `这条消息本身该照发：${r.text}`)
      // 剔干净了就等于没点名，所以走的是 steering / 新一轮，不是排队。
      assert(r.json.queued !== true, '点名全被剔掉了还排队，那用户就白等一轮')
    })

    // ── 附件反代。这一跳是 proxyUpload / proxyDownload：字节从浏览器流到席位，
    //    再流回来。前面几组都是直连 bot，只有这里能验「Gateway 中间那段没把它弄坏」。
    let gwPath

    await test('经 Gateway 上传附件：落到席位的工作区', async () => {
      // 挑一段跨 chunk 边界也要拼对的内容，顺带把中文名一路带过去。
      const bytes = Buffer.from('报表内容\n第二行\n', 'utf8')
      const r = await req(gwBase, 'POST', `/runtime/sessions/${sessionId}/files`, {
        token: adminTok,
        raw: bytes,
        headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('季度报表.txt') },
      })
      assert(r.status === 200, `upload ${r.status} ${r.text}`)
      assert(typeof r.json.path === 'string' && r.json.path.startsWith('uploads/'), `落点不对：${r.text}`)
      assert(r.json.name === '季度报表.txt', `文件名在路上坏了：${r.json.name}`)
      assert(r.json.size === bytes.length, `大小对不上：${r.json.size} ≠ ${bytes.length}`)
      gwPath = r.json.path
      // 正文只在席位磁盘上——Gateway 不该留副本，这条和「Gateway home 不含对话正文」是同一条纪律。
      assert(existsSync(join(BOT_HOME, 'work', gwPath)), '席位磁盘上没有这个文件')
      assert(!treeHas(GW_HOME, '报表内容'), 'Gateway 落了一份附件正文')
    })

    await test('经 Gateway 预览：字节一个不差，安全头齐全', async () => {
      const r = await req(gwBase, 'GET', `/runtime/sessions/${sessionId}/files?path=${encodeURIComponent(gwPath)}`, {
        token: adminTok,
      })
      assert(r.status === 200, `preview ${r.status} ${r.text}`)
      assert(r.text === '报表内容\n第二行\n', `内容对不上：${JSON.stringify(r.text)}`)
      assert(r.headers.get('x-content-type-options') === 'nosniff', '少了 nosniff')
      // 这段字节是用户传的，却挂在 Gateway 的源上。没有 sandbox，一个带脚本的附件
      // 就能在登录态里跑起来。
      const csp = String(r.headers.get('content-security-policy') || '')
      assert(csp.includes('sandbox'), `少了 CSP sandbox：${csp}`)
    })

    await test('附件反代也认账号：别人的会话碰不到', async () => {
      const r = await req(gwBase, 'GET', `/runtime/sessions/${sessionId}/files?path=${encodeURIComponent(gwPath)}`, {
        token: memberTok,
      })
      assert(r.status >= 400, `成员读到了管理员的附件：${r.status} ${r.text}`)
      const up = await req(gwBase, 'POST', `/runtime/sessions/${sessionId}/files`, {
        token: memberTok,
        raw: Buffer.from('x'),
        headers: { 'content-type': 'application/octet-stream', 'x-filename': 'a.txt' },
      })
      assert(up.status >= 400, `成员往管理员的会话里传了文件：${up.status} ${up.text}`)
      const anon = await req(gwBase, 'GET', `/runtime/sessions/${sessionId}/files?path=${encodeURIComponent(gwPath)}`)
      assert(anon.status === 401, `未登录预览 ${anon.status}`)
    })

    await test('SSE 含 user/message ping（或 request/header）', async () => {
      const sse = await readSse(`${gwBase}/runtime/sessions/${encodeURIComponent(sessionId)}/events`, {
        token: adminTok,
        timeout: 8000,
        until: (events) =>
          events.some((e) => e.type === 'user/message' || e.type === 'request/header'),
      })
      assert(sse.status === 200, `sse ${sse.status} ${sse.text}`)
      const types = sse.events.map((e) => e.type)
      const user = sse.events.find((e) => e.type === 'user/message')
      const header = sse.events.find((e) => e.type === 'request/header')
      assert(user || header, `缺 user/message 与 request/header：${types.join(',')}`)
      if (user) {
        const blob = JSON.stringify(user)
        assert(blob.includes('ping') && blob.includes(MARKER), `user/message 无 ping：${blob.slice(0, 400)}`)
      }
    })

    await test('replay/done 带着「在不在跑」，而且是真 bot 给的', async () => {
      // 界面判断「正在处理」原来只能扫事件：从头扫，遇 turn/start 算在跑、遇 turn/end
      // 算跑完。这个猜法要求历史完整，而它经常不完整（流断在重放中途、或者进程半路
      // 没了、那条 turn/end 根本没写成），于是界面一直挂着「正在处理」。所以让知道的
      // 人说：bot 在 replay/done 上带 live。这里要验的是它真的一路走到了 Gateway 出口。
      const sse = await readSse(`${gwBase}/runtime/sessions/${encodeURIComponent(sessionId)}/events`, {
        token: adminTok,
        timeout: 8000,
        until: (events) => events.some((e) => e.type === 'replay/done'),
      })
      assert(sse.status === 200, `sse ${sse.status} ${sse.text}`)
      const done = sse.events.find((e) => e.type === 'replay/done')
      assert(done, `没有 replay/done：${sse.events.map((e) => e.type).join(',')}`)
      assert(typeof done.live === 'boolean', `replay/done 没带 live：${JSON.stringify(done)}`)
      // 标记必须排在历史**后面**——它的意思就是「前面那些都是历史」。
      const at = sse.events.indexOf(done)
      assert(
        sse.events.slice(0, at).some((e) => e.type === 'session'),
        'replay/done 跑到历史前面去了，那它就不再是「历史放完了」的意思',
      )
    })

    await test('bot 真的会写日志——那 16 处 ?.warn?.() 不能又是空转', async () => {
      // 挂上 logger 服务之前，cordis.yml 里没有任何 logger 插件，ctx.logger 是
      // undefined，代码里那 16 处可选链一条都没输出过。席位的 journal 里除了 systemd
      // 和启动那两行什么都没有，查问题只能靠猜。**这条测的就是「日志真的出来了」。**
      const sse = await readSse(`${gwBase}/runtime/sessions/${encodeURIComponent(sessionId)}/events`, {
        token: adminTok,
        timeout: 8000,
        until: (events) => events.some((e) => e.type === 'replay/done'),
      })
      assert(sse.status === 200, `sse ${sse.status}`)
      // 日志是异步刷出去的，给它一拍。
      await new Promise((r) => setTimeout(r, 300))
      const out = botChild._out || ''
      assert(/\[INFO\]/.test(out), `bot 一行日志都没有，logger 多半又没挂上：${out.slice(-400)}`)
      assert(
        /sse: 会话 .*live=(true|false)/.test(out),
        `没写出接流那行（live 是断案的关键）：${out.slice(-500)}`,
      )
    })

    await test('Bot GET / → JSON 404，不是 HTML SPA', async () => {
      const r = await req(botBase, 'GET', '/')
      assert(r.status === 404, `bot / ${r.status} ${r.text}`)
      assert(typeof r.json === 'object' && r.json && r.json.error, `not json ${r.text.slice(0, 120)}`)
      assert(!String(r.text).toLowerCase().includes('<!doctype html>'), 'bot 仍发 SPA')
      assert(!String(r.text).includes('<html'), 'bot 仍发 html')
    })

    await test('Gateway SPA GET /chat 与 /a/:id 返回 HTML', async () => {
      const a = await req(gwBase, 'GET', '/chat')
      assert(a.status === 200, `spa /chat ${a.status}`)
      assert(String(a.text).includes('<!doctype html>') || String(a.text).includes('Satuwork'), 'spa /chat html')
      const b = await req(gwBase, 'GET', `/a/${botId}`)
      assert(b.status === 200, `spa /a ${b.status}`)
      assert(String(b.text).includes('<!doctype html>') || String(b.text).includes('Satuwork'), 'spa /a html')
    })

    await test('成员在管理员实例上线后名册仍 200，session 503', async () => {
      const r = await req(gwBase, 'GET', '/runtime/bots', { token: memberTok })
      assert(r.status === 200, `member after ready ${r.status} ${r.text}`)
      const hit = (r.json.bots || []).find((b) => b.id === botId)
      assert(hit, '成员名册没有 bot')
      assert(hit.runtime == null, '成员不该看到管理员的 runtime')
      const sess = await req(gwBase, 'GET', `/runtime/bots/${botId}/session`, { token: memberTok })
      assert(sess.status === 503, `member session ${sess.status} ${sess.text}`)
    })

    await test('Gateway home 不含对话正文', async () => {
      assert(!treeHas(GW_HOME, MARKER), 'Gateway home 含聊天正文')
    })

    await test('席位凭证可直连 Bot JSON API', async () => {
      const r = await req(botBase, 'GET', '/api/bots', { token: seatAccess })
      assert(r.status === 200, `machine bots ${r.status} ${r.text}`)
      assert(Array.isArray(r.json.bots) && r.json.bots.length >= 1, 'empty')
    })

    await test('Gateway 钉住的实例名册只有 SATUWORK_BOT_ID，没有 default', async () => {
      const r = await req(botBase, 'GET', '/api/bots', { token: seatAccess })
      assert(r.status === 200, `machine bots ${r.status} ${r.text}`)
      const bots = r.json.bots || []
      assert(bots.length === 1, `bots.length ${bots.length} ${JSON.stringify(bots)}`)
      assert(bots[0].id === catalogBotId, `id ${bots[0] && bots[0].id} != ${catalogBotId}`)
      assert(!bots.some((b) => b.id === 'default'), '不该有 default')
    })

    await test('未登录 GET /api/runtime/status → 401', async () => {
      const r = await req(botBase, 'GET', '/api/runtime/status')
      assert(r.status === 401, `unauth status ${r.status} ${r.text}`)
    })

    await test('席位凭证 GET /api/runtime/status → 200 且只钉一颗', async () => {
      const r = await req(botBase, 'GET', '/api/runtime/status', { token: seatAccess })
      assert(r.status === 200, `status ${r.status} ${r.text}`)
      const bots = r.json.bots || []
      assert(bots.length === 1, `status bots ${bots.length}`)
      assert(bots[0].id === catalogBotId, `status id ${bots[0] && bots[0].id}`)
      assert(!bots.some((b) => b.id === 'default'), 'status 不该有 default')
    })
  } finally {
    if (botChild && !botChild._exited) {
      try {
        botChild.kill('SIGTERM')
      } catch {}
      await sleep(400)
      try {
        botChild.kill('SIGKILL')
      } catch {}
    }
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
    try {
      rmSync(BOT_HOME, { recursive: true, force: true })
    } catch {}
  }
}
