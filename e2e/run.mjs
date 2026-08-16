#!/usr/bin/env node
/**
 * Satuwork 端到端：真 HTTP，不 mock。
 *
 * Gateway 与 Bot 各自起子进程，隔离数据目录和端口，测完杀掉。
 * 不碰 ~/.satuwork-gateway / ~/.satuwork。
 *
 *   export PATH=/home/box/.local/node24/bin:$PATH
 *   node e2e/run.mjs
 */
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runRuntimePath } from './runtime-path.mjs'
import { runGatewayChat } from './gateway-chat.mjs'
import { runMachineDeploy } from './machine-deploy.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const gwRoot = join(root, 'gateway')
const botRoot = join(root, 'bot')

const GW_HOME = process.env.E2E_GW_HOME || '/tmp/satuwork-e2e-gw'
const BOT_HOME = process.env.E2E_BOT_HOME || '/tmp/satuwork-e2e-bot'
const GW_PORT = Number(process.env.E2E_GW_PORT || 18080)
const BOT_PORT = Number(process.env.E2E_BOT_PORT || 18082)
const MACHINE_TOK = 'e2e-machine-token'
const PLATFORM_TOK = 'e2e-platform-token'

const children = []
let failed = 0
let passed = 0
const skips = []

function log(line) {
  console.log(line)
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    log(`ok  ${name}`)
  } catch (e) {
    failed += 1
    log(`not ok  ${name}`)
    log(`  ${e.stack || e.message}`)
  }
}

function start(name, args, { cwd, env }) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child._name = name
  child._out = ''
  const eat = (d) => {
    const s = d.toString()
    child._out += s
    process.stderr.write(`[${name}] ${s}`)
  }
  child.stdout.on('data', eat)
  child.stderr.on('data', eat)
  child.on('exit', (code, sig) => {
    child._exited = { code, sig }
  })
  children.push(child)
  return child
}

function killAll() {
  for (const child of children) {
    if (child._exited) continue
    try {
      child.kill('SIGTERM')
    } catch {}
  }
  const t = Date.now()
  while (Date.now() - t < 800) {
    /* 等一下再强杀 */
  }
  for (const child of children) {
    if (child._exited) continue
    try {
      child.kill('SIGKILL')
    } catch {}
  }
  try {
    unlinkSync(join(botRoot, 'cordis.e2e.yml'))
  } catch {}
}

async function waitHttp(url, { timeout = 30000 } = {}) {
  const startAt = Date.now()
  let last
  while (Date.now() - startAt < timeout) {
    try {
      const r = await fetch(url)
      if (r.ok) return
      last = `HTTP ${r.status}`
    } catch (e) {
      last = e.message
    }
    await new Promise((x) => setTimeout(x, 150))
  }
  throw new Error(`等不到 ${url}：${last}`)
}

async function req(base, method, path, { token, cookie, body, headers: extra } = {}) {
  const headers = { ...(extra || {}) }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = 'Bearer ' + token
  if (cookie) headers.cookie = cookie
  const r = await fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await r.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = text
  }
  return { status: r.status, json, text, headers: r.headers, res: r }
}

function cookieOf(r) {
  const list = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
  const raw = list.find((c) => c.startsWith('satu_session=')) || r.headers.get('set-cookie') || ''
  const m = String(raw).match(/satu_session=([^;]+)/)
  if (!m) throw new Error('没有 satu_session cookie')
  return `satu_session=${m[1]}`
}

function dumpHas(obj, needle) {
  return JSON.stringify(obj).includes(needle)
}

function treeHas(dir, needle) {
  if (!existsSync(dir)) return false
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let names
    try {
      names = readdirSync(cur)
    } catch {
      continue
    }
    for (const name of names) {
      const f = join(cur, name)
      let st
      try {
        st = statSync(f)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        stack.push(f)
        continue
      }
      try {
        if (readFileSync(f).includes(needle)) return true
      } catch {}
    }
  }
  return false
}

function listenMock(handler) {
  const server = createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: addr.port, url: `http://127.0.0.1:${addr.port}` })
    })
  })
}

async function runGateway() {
  log('\n# gateway')
  rmSync(GW_HOME, { recursive: true, force: true })
  const base = `http://127.0.0.1:${GW_PORT}`
  const child = start('gateway', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_MACHINE_TOKEN: MACHINE_TOK,
      GATEWAY_PLATFORM_TOKEN: PLATFORM_TOK,
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@satuwork.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-3080',
    },
  })
  await waitHttp(base + '/health')

  let token
  let orgId
  let memberTok
  let ownerTok
  let botId
  let skillId
  let orgMachineTok
  const secret = 'sk-e2e-never-leak'

  await test('POST /auth/register → company + admin + plan', async () => {
    const r = await req(base, 'POST', '/auth/register', {
      body: {
        email: 'admin@acme.test',
        password: 'correct-horse',
        companyName: 'Acme',
        slug: 'acme',
        seats: 2,
      },
    })
    assert(r.status === 201, `register ${r.status} ${r.text}`)
    assert(typeof r.json.token === 'string' && r.json.token.split('.').length === 3, 'jwt')
    assert(r.json.account.role === 'admin', 'admin')
    assert(r.json.company.slug === 'acme', 'company')
    assert(r.json.account.email === 'admin@acme.test', 'email')
    assert(!dumpHas(r.json, 'passwordHash'), '口令哈希不得出现')
    token = r.json.token
    orgId = r.json.company.id
  })

  await test('POST /auth/login → JWT', async () => {
    const r = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@acme.test', password: 'correct-horse' },
    })
    assert(r.status === 200, `login ${r.status} ${r.text}`)
    assert(typeof r.json.token === 'string' && r.json.token.split('.').length === 3, 'jwt')
    token = r.json.token
  })

  await test('GET /me → account, company, accessUrl（派机器之后）', async () => {
    const before = await req(base, 'GET', '/me', { token })
    assert(before.status === 200, `me ${before.status}`)
    assert(before.json.account.role === 'admin', 'account')
    assert(before.json.company.id === orgId, 'company')
    assert(before.json.plan.seats === 2, 'plan')
    assert(before.json.company.accessUrl == null, '派机器前不该有 accessUrl')

    const mach = await req(base, 'POST', `/orgs/${orgId}/machine`, {
      token,
      body: { host: '10.0.0.1' },
    })
    assert(mach.status === 201, `machine ${mach.status} ${mach.text}`)
    assert(mach.json.company.accessUrl === 'https://acme.satuwork.com', 'accessUrl')
    assert(!mach.json.machine.token, 'admin assign 带了 token')
    assert(!JSON.stringify(mach.json).includes('smt_'), 'admin assign 泄漏 smt_')

    const me = await req(base, 'GET', '/me', { token })
    assert(me.status === 200, `me2 ${me.status}`)
    assert(me.json.account.id, 'account')
    assert(me.json.company.id === orgId, 'company')
    assert(me.json.company.accessUrl === 'https://acme.satuwork.com', 'me.accessUrl')
  })

  await test('GET /jwks', async () => {
    const r = await req(base, 'GET', '/jwks')
    assert(r.status === 200, `jwks ${r.status}`)
    assert(Array.isArray(r.json.keys) && r.json.keys[0]?.kty === 'RSA', 'RSA jwk')
  })

  await test('席位用满后再加账号 → 409', async () => {
    const a = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
      token,
      body: { email: 'member@acme.test', password: 'correct-horse', role: 'member' },
    })
    assert(a.status === 201, `member ${a.status} ${a.text}`)
    const full = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
      token,
      body: { email: 'third@acme.test', password: 'correct-horse' },
    })
    assert(full.status === 409, `seat ${full.status} ${full.text}`)
    assert(full.json.error === '席位已满', '席位已满')
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'member@acme.test', password: 'correct-horse' },
    })
    assert(login.status === 200, 'member login')
    memberTok = login.json.token
  })

  await test('管理员 CRUD 公司 bot/skill；目录可见；成员不能写', async () => {
    const created = await req(base, 'POST', `/orgs/${orgId}/bots`, {
      token,
      body: { name: '公司助手' },
    })
    assert(created.status === 201, `bot ${created.status} ${created.text}`)
    assert(created.json.bot.origin === 'company', 'company bot')
    botId = created.json.bot.id

    const patched = await req(base, 'PATCH', `/orgs/${orgId}/bots/${botId}`, {
      token,
      body: { name: '公司助手改' },
    })
    assert(patched.status === 200, `patch bot ${patched.status}`)
    assert(patched.json.bot.name === '公司助手改', 'renamed')

    const got = await req(base, 'GET', `/orgs/${orgId}/bots/${botId}`, { token })
    assert(got.status === 200 && got.json.bot.name === '公司助手改', 'get bot')

    const cat = await req(base, 'GET', '/catalog/bots', { token })
    assert(cat.status === 200, `catalog ${cat.status}`)
    assert(cat.json.items.some((i) => i.id === botId && i.name === '公司助手改'), 'catalog 看见公司 bot')

    const skill = await req(base, 'POST', `/orgs/${orgId}/skills`, {
      token,
      body: { name: '内部技能', body: '步骤' },
    })
    assert(skill.status === 201, `skill ${skill.status} ${skill.text}`)
    assert(skill.json.skill && skill.json.skill.name === '内部技能', 'skill shape')
    skillId = skill.json.skill.id
    const skillPatch = await req(base, 'PATCH', `/orgs/${orgId}/skills/${skillId}`, {
      token,
      body: { name: '内部技能改' },
    })
    assert(skillPatch.status === 200, 'patch skill')
    assert(skillPatch.json.skill && skillPatch.json.skill.name === '内部技能改', 'patched skill')
    const skills = await req(base, 'GET', '/catalog/skills', { token })
    assert(skills.json.items.some((i) => i.id === skillId), 'catalog 看见 skill')

    const denyBot = await req(base, 'POST', `/orgs/${orgId}/bots`, {
      token: memberTok,
      body: { name: '不该成功' },
    })
    assert(denyBot.status === 403, `member bot ${denyBot.status}`)
    const denySkill = await req(base, 'POST', `/orgs/${orgId}/skills`, {
      token: memberTok,
      body: { name: '不该成功' },
    })
    assert(denySkill.status === 403, `member skill ${denySkill.status}`)
    const denyPatch = await req(base, 'PATCH', `/orgs/${orgId}/bots/${botId}`, {
      token: memberTok,
      body: { name: '不该成功' },
    })
    assert(denyPatch.status === 403, `member patch ${denyPatch.status}`)

    const del = await req(base, 'DELETE', `/orgs/${orgId}/bots/${botId}`, { token })
    assert(del.status === 200 && del.json.deleted === true, 'delete bot')
    const delS = await req(base, 'DELETE', `/orgs/${orgId}/skills/${skillId}`, { token })
    assert(delS.status === 200 && delS.json.deleted === true, 'delete skill')
  })

  await test('owner platform credentials；公司管理员不能写供应商', async () => {
    const ownerLogin = await req(base, 'POST', '/auth/login', {
      body: { email: 'owner@satuwork.test', password: 'test-owner-3080' },
    })
    assert(ownerLogin.status === 200, `owner login ${ownerLogin.status} ${ownerLogin.text}`)
    ownerTok = ownerLogin.json.token
    const platMach = await req(base, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
    assert(platMach.status === 200, `plat machine ${platMach.status} ${platMach.text}`)
    assert(typeof platMach.json.machine.token === 'string' && platMach.json.machine.token.startsWith('smt_'), 'owner 应看见 smt_')
    orgMachineTok = platMach.json.machine.token
    const orgMach = await req(base, 'GET', `/orgs/${orgId}/machine`, { token })
    assert(orgMach.status === 200, `org machine ${orgMach.status}`)
    assert(!orgMach.json.machine.token, '公司 machine JSON 带了 token')
    assert(!JSON.stringify(orgMach.json).includes(orgMachineTok), '公司 JSON 泄漏 smt_')

    const created = await req(base, 'POST', '/platform/credentials', {
      token: ownerTok,
      body: { provider: 'deepseek', secret },
    })
    assert(created.status === 201, `cred ${created.status} ${created.text}`)
    assert(created.json.credential.configured === true, 'create configured')
    assert(created.json.credential.provider === 'deepseek', 'provider')
    assert(!dumpHas(created.json, secret), 'create 泄漏 secret')
    assert(!Object.prototype.hasOwnProperty.call(created.json.credential, 'secret'), 'create 带 secret 字段')

    const put = await req(base, 'PUT', '/platform/credentials/deepseek', {
      token: ownerTok,
      body: { secret: 'sk-e2e-rotated-never-leak' },
    })
    assert(put.status === 200, `put ${put.status} ${put.text}`)
    assert(put.json.credential.configured === true, 'put configured')
    assert(!dumpHas(put.json, secret), 'put 泄漏旧 secret')
    assert(!dumpHas(put.json, 'sk-e2e-rotated-never-leak'), 'put 泄漏新 secret')

    const plat = await req(base, 'GET', '/platform/credentials', { token: ownerTok })
    assert(plat.status === 200, `plat list ${plat.status}`)
    assert(plat.json.credentials.some((c) => c.provider === 'deepseek' && c.configured === true), 'plat list deepseek')
    assert(!dumpHas(plat.json, secret), 'plat list 泄漏')
    assert(!dumpHas(plat.json, 'sk-e2e-rotated-never-leak'), 'plat list 泄漏新 secret')

    const list = await req(base, 'GET', `/orgs/${orgId}/credentials`, { token })
    assert(list.status === 200, `list ${list.status}`)
    assert(list.json.credentials.some((c) => c.provider === 'deepseek' && c.configured === true), 'list configured')
    assert(!dumpHas(list.json, secret), 'list 泄漏')
    assert(!dumpHas(list.json, 'sk-e2e-rotated-never-leak'), 'list 泄漏新 secret')

    const deny = await req(base, 'POST', `/orgs/${orgId}/credentials`, {
      token,
      body: { provider: 'openai', secret },
    })
    assert(deny.status === 403, `admin cred ${deny.status} ${deny.text}`)
    assert(String(deny.json.error).includes('供应商由系统管理员配置'), '403 文案')
  })

  await test('缺 GATEWAY_MACHINE_TOKEN 的 /internal/* → 401', async () => {
    const a = await req(base, 'POST', '/internal/machines', { body: { host: '10.0.0.2' } })
    assert(a.status === 401, `machines ${a.status}`)
    const b = await req(base, 'POST', '/internal/machines/x/heartbeat')
    assert(b.status === 401, `heartbeat ${b.status}`)
    const c = await req(base, 'POST', '/internal/sessions/index', { body: {} })
    assert(c.status === 401, `sessions ${c.status}`)
    const d = await req(base, 'POST', '/internal/usage', { body: {} })
    assert(d.status === 401, `usage ${d.status}`)
  })

  await test('引导票只能登记机器；心跳/索引/ready/用量要 smt_', async () => {
    const reg = await req(base, 'POST', '/internal/machines', { token: MACHINE_TOK, body: {} })
    assert(reg.status === 201, `register ${reg.status} ${reg.text}`)
    assert(typeof reg.json.machine.token === 'string' && reg.json.machine.token.startsWith('smt_'), '登记应返回 smt_')
    const smt = reg.json.machine.token
    const mid = reg.json.machine.id
    const publicReg = { ...reg.json.machine }
    delete publicReg.token
    assert(!JSON.stringify(publicReg).includes('smt_'), '登记公开字段含 smt_')

    const hbBoot = await req(base, 'POST', `/internal/machines/${mid}/heartbeat`, { token: MACHINE_TOK })
    assert(hbBoot.status === 401, `bootstrap heartbeat ${hbBoot.status}`)
    const idxBoot = await req(base, 'POST', '/internal/sessions/index', {
      token: MACHINE_TOK,
      body: { sessionId: 's-boot', companyId: orgId, accountId: 'x' },
    })
    assert(idxBoot.status === 401, `bootstrap index ${idxBoot.status}`)
    const readyBoot = await req(base, 'POST', '/internal/instances/no-such/ready', {
      token: MACHINE_TOK,
      body: { host: 'http://127.0.0.1:9', botId: 'b' },
    })
    assert(readyBoot.status === 401, `bootstrap ready ${readyBoot.status}`)
    const useBoot = await req(base, 'POST', '/internal/usage', {
      token: MACHINE_TOK,
      body: { accountId: 'x', provider: 'deepseek', model: 'm', promptTokens: 1, completionTokens: 1 },
    })
    assert(useBoot.status === 401, `bootstrap usage ${useBoot.status}`)

    const bind = await req(base, 'POST', `/orgs/${orgId}/machine`, { token, body: { id: mid } })
    assert(bind.status === 201, `bind ${bind.status} ${bind.text}`)
    assert(!bind.json.machine.token, 'bind 响应带 token')
    orgMachineTok = smt

    const hb = await req(base, 'POST', `/internal/machines/${mid}/heartbeat`, { token: smt })
    assert(hb.status === 200, `smt heartbeat ${hb.status} ${hb.text}`)
    const hbWrong = await req(base, 'POST', '/internal/machines/no-such/heartbeat', { token: smt })
    assert(hbWrong.status === 403, `heartbeat id mismatch ${hbWrong.status}`)
  })

  await test('GET /orgs/:id/audit 管理员能看操作记录；成员 403', async () => {
    const deny = await req(base, 'GET', `/orgs/${orgId}/audit`, { token: memberTok })
    assert(deny.status === 403, `member audit ${deny.status} ${deny.text}`)
    const r = await req(base, 'GET', `/orgs/${orgId}/audit`, { token })
    assert(r.status === 200, `audit ${r.status} ${r.text}`)
    assert(Array.isArray(r.json.events) && r.json.events.length > 0, '空操作记录')
    assert(r.json.events.some((e) => e.action === 'auth.register' || e.action === 'auth.login' || e.action === 'machine.assign'), '缺已知事件')
  })

  await test('对话审计：索引上报、筛选、成员 403、离线拉全文、不落正文', async () => {
    const UNIQUE = 'UNIQUE-BODY-MUST-NOT-LAND-ON-GATEWAY'
    const adminMe = await req(base, 'GET', '/me', { token })
    assert(adminMe.status === 200, `admin me ${adminMe.status}`)
    const memberMe = await req(base, 'GET', '/me', { token: memberTok })
    assert(memberMe.status === 200, `member me ${memberMe.status}`)
    const adminId = adminMe.json.account.id
    const memberId = memberMe.json.account.id
    const t1 = 1_700_000_000_000
    const t2 = 1_700_000_100_000

    assert(orgMachineTok && orgMachineTok.startsWith('smt_'), 'need bound machine token')
    const plat = await req(base, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
    const deadId = plat.json.machine.id
    assert(plat.json.machine.token === orgMachineTok, 'owner token 应对上')

    const a = await req(base, 'POST', '/internal/sessions/index', {
      token: orgMachineTok,
      body: {
        sessionId: 's-audit-early',
        companyId: orgId,
        accountId: adminId,
        botId: 'bot-audit',
        machineId: deadId,
        title: '早会话',
        origin: 'company',
        remoteId: 'bot-audit',
        messageCount: 3,
        createdAt: t1,
        updatedAt: t1,
        events: [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: UNIQUE }] } } }],
      },
    })
    assert(a.status === 200, `index a ${a.status} ${a.text}`)
    assert(a.json.session.sessionId === 's-audit-early', 'sessionId a')
    assert(a.json.session.updatedAt === t1, 'updatedAt a')
    assert(!dumpHas(a.json, UNIQUE), 'index 响应带正文')

    const b = await req(base, 'POST', '/internal/sessions/index', {
      token: orgMachineTok,
      body: {
        sessionId: 's-audit-late',
        companyId: orgId,
        accountId: memberId,
        title: '晚会话',
        createdAt: t2,
        updatedAt: t2,
        machineId: deadId,
      },
    })
    assert(b.status === 200, `index b ${b.status} ${b.text}`)

    const listed = await req(base, 'GET', `/orgs/${orgId}/sessions`, { token })
    assert(listed.status === 200, `list ${listed.status} ${listed.text}`)
    assert(Array.isArray(listed.json.sessions) && listed.json.sessions.length >= 2, '应有两条')
    const ids = listed.json.sessions.map((x) => x.sessionId)
    assert(ids.includes('s-audit-early') && ids.includes('s-audit-late'), '缺会话')
    const early = listed.json.sessions.find((x) => x.sessionId === 's-audit-early')
    assert(early.accountId === adminId, 'early account')
    assert(early.accountName, 'accountName')
    assert(early.title === '早会话', 'title')
    assert(early.origin === 'company', 'origin')
    assert(early.remoteId === 'bot-audit', 'remoteId')
    assert(early.messageCount === 3, 'messageCount')
    assert(!dumpHas(listed.json, UNIQUE), 'list 带正文')
    assert(!Object.prototype.hasOwnProperty.call(early, 'events'), 'list 带 events')

    const one = await req(base, 'GET', `/orgs/${orgId}/sessions?accountId=${encodeURIComponent(adminId)}`, { token })
    assert(one.status === 200, `filter account ${one.status}`)
    assert(one.json.sessions.length === 1, `account filter ${one.json.sessions.length}`)
    assert(one.json.sessions[0].sessionId === 's-audit-early', 'account filter id')

    const byBot = await req(base, 'GET', `/orgs/${orgId}/sessions?botId=${encodeURIComponent('bot-audit')}`, { token })
    assert(byBot.status === 200, `filter bot ${byBot.status}`)
    assert(byBot.json.sessions.length === 1 && byBot.json.sessions[0].sessionId === 's-audit-early', 'bot filter')

    const ranged = await req(base, 'GET', `/orgs/${orgId}/sessions?from=${t1 + 1}&to=${t2}`, { token })
    assert(ranged.status === 200, `range ${ranged.status}`)
    assert(ranged.json.sessions.length === 1, `range len ${ranged.json.sessions.length}`)
    assert(ranged.json.sessions[0].sessionId === 's-audit-late', 'range id')

    const denyList = await req(base, 'GET', `/orgs/${orgId}/sessions`, { token: memberTok })
    assert(denyList.status === 403, `member list ${denyList.status} ${denyList.text}`)
    const denyOne = await req(base, 'GET', `/orgs/${orgId}/sessions/s-audit-early`, { token: memberTok })
    assert(denyOne.status === 403, `member get ${denyOne.status}`)

    const missing = await req(base, 'GET', `/orgs/${orgId}/sessions/s-not-here`, { token })
    assert(missing.status === 404, `missing ${missing.status} ${missing.text}`)

    const pulled = await req(base, 'GET', `/orgs/${orgId}/sessions/s-audit-early`, { token })
    assert(pulled.status === 200, `pull offline ${pulled.status} ${pulled.text}`)
    assert(pulled.json.session && pulled.json.session.sessionId === 's-audit-early', 'pull session')
    assert(pulled.json.events === null, 'events should be null')
    assert(pulled.json.pullError === '机器不在线，全文拉不下来', `pullError ${pulled.json.pullError}`)
    assert(!dumpHas(pulled.json, UNIQUE), 'pull 响应编造正文')
    assert(!treeHas(GW_HOME, UNIQUE), 'Gateway home 含正文')

    const audit = await req(base, 'GET', `/orgs/${orgId}/audit`, { token })
    assert(audit.status === 200, `audit after pull ${audit.status}`)
    const pullEv = audit.json.events.find((e) => e.action === 'session.pull')
    assert(pullEv, '缺 session.pull')
    assert(pullEv.detail && pullEv.detail.sessionId === 's-audit-early', 'pull detail sessionId')
    assert(!dumpHas(pullEv, UNIQUE), '审计里有正文')
  })

  await test('对话审计：mock 机器在线时按需拉全文，Gateway 不落盘', async () => {
    const HELLO = 'AUDIT-OK-HELLO'
    let liveTok = ''
    const mock = await listenMock((req, res) => {
      if (req.url && req.url.startsWith('/internal/sessions/') && req.headers.authorization === 'Bearer ' + liveTok) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            events: [{ type: 'user/message', data: { message: { content: [{ type: 'text', text: HELLO }] } } }],
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })
    try {
      const adminMe = await req(base, 'GET', '/me', { token })
      const mach = await req(base, 'POST', '/internal/machines', {
        token: MACHINE_TOK,
        body: { host: mock.url },
      })
      assert(mach.status === 201, `mock machine ${mach.status} ${mach.text}`)
      liveTok = mach.json.machine.token
      assert(typeof liveTok === 'string' && liveTok.startsWith('smt_'), 'live smt_')
      const bind = await req(base, 'POST', `/orgs/${orgId}/machine`, { token, body: { id: mach.json.machine.id } })
      assert(bind.status === 201, `bind live ${bind.status} ${bind.text}`)
      orgMachineTok = liveTok
      const idx = await req(base, 'POST', '/internal/sessions/index', {
        token: liveTok,
        body: {
          sessionId: 's-audit-live',
          companyId: orgId,
          accountId: adminMe.json.account.id,
          machineId: mach.json.machine.id,
          title: '在线会话',
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      })
      assert(idx.status === 200, `live index ${idx.status} ${idx.text}`)
      const pulled = await req(base, 'GET', `/orgs/${orgId}/sessions/s-audit-live`, { token })
      assert(pulled.status === 200, `live pull ${pulled.status} ${pulled.text}`)
      assert(Array.isArray(pulled.json.events) && pulled.json.events[0]?.type === 'user/message', 'events')
      assert(dumpHas(pulled.json, HELLO), '缺 AUDIT-OK-HELLO')
      assert(!pulled.json.pullError, '不应有 pullError')
      assert(!treeHas(GW_HOME, HELLO), 'Gateway home 含拉下来的正文')
    } finally {
      await new Promise((r) => mock.server.close(r))
    }
  })

  await test('SPA GET /audit 与 /audit/:id 返回 html', async () => {
    const a = await req(base, 'GET', '/audit')
    assert(a.status === 200, `spa /audit ${a.status}`)
    assert(String(a.text).includes('<!doctype html>') || String(a.text).includes('Satuwork'), 'spa html')
    const b = await req(base, 'GET', '/audit/s-audit-early')
    assert(b.status === 200, `spa /audit/:id ${b.status}`)
    assert(String(b.text).includes('<!doctype html>') || String(b.text).includes('Satuwork'), 'spa detail html')
  })

  await test('SPA GET /chat 与 /a/default 返回 html', async () => {
    const a = await req(base, 'GET', '/chat')
    assert(a.status === 200, `spa /chat ${a.status}`)
    assert(String(a.text).includes('<!doctype html>') || String(a.text).includes('Satuwork'), 'spa /chat html')
    const b = await req(base, 'GET', '/a/default')
    assert(b.status === 200, `spa /a ${b.status}`)
    assert(String(b.text).includes('<!doctype html>') || String(b.text).includes('Satuwork'), 'spa /a html')
  })

  await test('owner GET /runtime/bots → 403；成员无实例 → 200 名册', async () => {
    const owner = await req(base, 'GET', '/runtime/bots', { token: ownerTok })
    assert(owner.status === 403, `owner ${owner.status} ${owner.text}`)
    const member = await req(base, 'GET', '/runtime/bots', { token: memberTok })
    assert(member.status === 200, `member ${member.status} ${member.text}`)
    assert(Array.isArray(member.json.bots), 'bots array')
  })

  await test('GET /v1/models 要登录票或 API Key；目录无 secret', async () => {
    const unauth = await req(base, 'GET', '/v1/models')
    assert(unauth.status === 401, `unauth models ${unauth.status}`)
    const r = await req(base, 'GET', '/v1/models', { token })
    assert(r.status === 200, `models ${r.status} ${r.text}`)
    assert(r.json.object === 'list', 'object list')
    assert(Array.isArray(r.json.data) && r.json.data.length > 0, '空目录')
    assert(r.json.data.some((m) => m.owned_by === 'deepseek' || m.provider === 'deepseek'), '缺 deepseek')
    assert(!dumpHas(r.json, secret), 'models 泄漏 secret')
    assert(!dumpHas(r.json, 'sk-e2e-rotated-never-leak'), 'models 泄漏 rotated')
  })

  await test('建管理员/员工默认有 API Key 和 access token；列表不泄漏；详情 owner 可见', async () => {
    const adminMe = await req(base, 'GET', '/me', { token })
    assert(adminMe.status === 200, `admin me ${adminMe.status}`)
    const adminId = adminMe.json.account.id
    const memberMe = await req(base, 'GET', '/me', { token: memberTok })
    assert(memberMe.status === 200, `member me ${memberMe.status}`)
    const memberId = memberMe.json.account.id

    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'admin@acme.test', password: 'correct-horse' },
    })
    assert(login.status === 200, `relogin ${login.status}`)

    const list = await req(base, 'GET', '/platform/accounts', { token: ownerTok })
    assert(list.status === 200, `list ${list.status} ${list.text}`)
    for (const a of list.json.accounts || []) {
      assert(!Object.prototype.hasOwnProperty.call(a, 'apiKey'), '列表带 apiKey 字段')
      assert(!Object.prototype.hasOwnProperty.call(a, 'accessToken'), '列表带 accessToken 字段')
    }
    const ownerRow = list.json.accounts.find((a) => a.role === 'owner')
    assert(ownerRow && ownerRow.id, '缺 owner')

    const missing = await req(base, 'GET', '/platform/accounts/no-such-account', { token: ownerTok })
    assert(missing.status === 404, `missing ${missing.status}`)

    const adminDetail = await req(base, 'GET', `/platform/accounts/${adminId}`, { token: ownerTok })
    assert(adminDetail.status === 200, `admin detail ${adminDetail.status} ${adminDetail.text}`)
    assert(typeof adminDetail.json.apiKey === 'string' && adminDetail.json.apiKey.startsWith('sk_sw_'), 'admin apiKey')
    assert(typeof adminDetail.json.accessToken === 'string' && adminDetail.json.accessToken.startsWith('sat_'), 'admin accessToken')
    assert(adminDetail.json.account && adminDetail.json.account.id === adminId, 'admin account')
    assert(adminDetail.json.company && adminDetail.json.company.id === orgId, 'admin company')

    const memberDetail = await req(base, 'GET', `/platform/accounts/${memberId}`, { token: ownerTok })
    assert(memberDetail.status === 200, `member detail ${memberDetail.status} ${memberDetail.text}`)
    assert(typeof memberDetail.json.apiKey === 'string' && memberDetail.json.apiKey.startsWith('sk_sw_'), 'member apiKey')
    assert(typeof memberDetail.json.accessToken === 'string' && memberDetail.json.accessToken.startsWith('sat_'), 'member accessToken')

    const ownerDetail = await req(base, 'GET', `/platform/accounts/${ownerRow.id}`, { token: ownerTok })
    assert(ownerDetail.status === 200, `owner detail ${ownerDetail.status} ${ownerDetail.text}`)
    assert(ownerDetail.json.apiKey === null, 'owner apiKey')
    assert(ownerDetail.json.accessToken === null, 'owner accessToken')

    const apiKey = adminDetail.json.apiKey
    const accessToken = adminDetail.json.accessToken
    assert(!dumpHas(list.json, apiKey), '列表泄漏 apiKey')
    assert(!dumpHas(list.json, accessToken), '列表泄漏 accessToken')
    assert(!dumpHas(login.json, apiKey), 'login 泄漏 apiKey')
    assert(!dumpHas(login.json, accessToken), 'login 泄漏 accessToken')
    assert(!dumpHas(adminMe.json, apiKey), '/me 泄漏 apiKey')
    assert(!dumpHas(adminMe.json, accessToken), '/me 泄漏 accessToken')

    const spaUsers = await req(base, 'GET', '/users')
    assert(spaUsers.status === 200, `spa /users ${spaUsers.status}`)
    assert(String(spaUsers.text).includes('<!doctype html>') || String(spaUsers.text).includes('Satuwork'), 'spa /users html')
    const spaDetail = await req(base, 'GET', `/users/${adminId}`)
    assert(spaDetail.status === 200, `spa /users/:id ${spaDetail.status}`)
    assert(String(spaDetail.text).includes('<!doctype html>') || String(spaDetail.text).includes('Satuwork'), 'spa detail html')
    const appJs = readFileSync(join(gwRoot, 'ui/app.js'), 'utf8')
    assert(appJs.includes('function userDetailPage'), '缺 userDetailPage')
  })

  await test('API Key 调 /v1/models；access token 调 /me；交叉 401', async () => {
    const adminMe = await req(base, 'GET', '/me', { token })
    const adminId = adminMe.json.account.id
    const detail = await req(base, 'GET', `/platform/accounts/${adminId}`, { token: ownerTok })
    assert(detail.status === 200, `detail ${detail.status} ${detail.text}`)
    const apiKey = detail.json.apiKey
    const accessToken = detail.json.accessToken
    assert(typeof apiKey === 'string' && apiKey.startsWith('sk_sw_'), 'apiKey')
    assert(typeof accessToken === 'string' && accessToken.startsWith('sat_'), 'accessToken')

    const byBearer = await req(base, 'GET', '/v1/models', { token: apiKey })
    assert(byBearer.status === 200, `apiKey bearer ${byBearer.status} ${byBearer.text}`)
    assert(byBearer.json.object === 'list', 'apiKey list')

    const byHeader = await req(base, 'GET', '/v1/models', { headers: { 'x-api-key': apiKey } })
    assert(byHeader.status === 200, `x-api-key ${byHeader.status} ${byHeader.text}`)
    assert(byHeader.json.object === 'list', 'x-api-key list')

    const satOnV1 = await req(base, 'GET', '/v1/models', { token: accessToken })
    assert(satOnV1.status === 401, `sat /v1 ${satOnV1.status} ${satOnV1.text}`)

    const meSat = await req(base, 'GET', '/me', { token: accessToken })
    assert(meSat.status === 200, `sat /me ${meSat.status} ${meSat.text}`)
    assert(meSat.json.account && meSat.json.account.id === adminId, 'sat /me id')

    const meKey = await req(base, 'GET', '/me', { token: apiKey })
    assert(meKey.status === 401, `apiKey /me ${meKey.status} ${meKey.text}`)

    const jwtModels = await req(base, 'GET', '/v1/models', { token })
    assert(jwtModels.status === 200, `jwt /v1 ${jwtModels.status}`)
    const jwtMe = await req(base, 'GET', '/me', { token })
    assert(jwtMe.status === 200 && jwtMe.json.account.id === adminId, 'jwt /me')

    const catSat = await req(base, 'GET', '/runtime/catalog', { token: accessToken })
    assert(catSat.status === 200, `sat catalog ${catSat.status} ${catSat.text}`)
    const patchSat = await req(base, 'PATCH', '/me', { token: accessToken, body: { name: '不该成功' } })
    assert(patchSat.status === 401, `sat PATCH /me ${patchSat.status}`)
    const depSat = await req(base, 'POST', '/runtime/deploy', { token: accessToken, body: { botId: 'x' } })
    assert(depSat.status === 401, `sat deploy ${depSat.status}`)
    const accSat = await req(base, 'GET', `/orgs/${orgId}/accounts`, { token: accessToken })
    assert(accSat.status === 401, `sat accounts ${accSat.status}`)
    const useSat = await req(base, 'GET', `/orgs/${orgId}/usage`, { token: accessToken })
    assert(useSat.status === 401, `sat usage ${useSat.status}`)
    const dashKey = await req(base, 'GET', `/orgs/${orgId}/accounts`, { token: apiKey })
    assert(dashKey.status === 401, `sk_sw_ dashboard ${dashKey.status}`)
  })

  await test('per-machine ready：未部署 404；跨公司 403；用量上报', async () => {
    const adminMe = await req(base, 'GET', '/me', { token })
    const adminId = adminMe.json.account.id
    const missBot = await req(base, 'POST', `/internal/instances/${adminId}/ready`, {
      token: orgMachineTok,
      body: { host: 'http://127.0.0.1:9' },
    })
    assert(missBot.status === 400, `missing botId ${missBot.status} ${missBot.text}`)
    const never = await req(base, 'POST', `/internal/instances/${adminId}/ready`, {
      token: orgMachineTok,
      body: { host: 'http://127.0.0.1:9', botId: 'never-deployed-bot' },
    })
    assert(never.status === 404, `never deployed ${never.status} ${never.text}`)
    assert(String(never.json.error || never.text).includes('还没有部署'), '404 文案')

    const other = await req(base, 'POST', '/auth/register', {
      body: {
        email: 'admin@other.test',
        password: 'correct-horse',
        companyName: 'OtherCo',
        slug: 'otherco',
        seats: 1,
      },
    })
    assert(other.status === 201, `other org ${other.status} ${other.text}`)
    const otherOrg = other.json.company.id
    const otherAdminTok = other.json.token
    const otherMach = await req(base, 'POST', '/internal/machines', { token: MACHINE_TOK, body: {} })
    assert(otherMach.status === 201, `other machine ${otherMach.status}`)
    const otherSmt = otherMach.json.machine.token
    const bindOther = await req(base, 'POST', `/orgs/${otherOrg}/machine`, {
      token: otherAdminTok,
      body: { id: otherMach.json.machine.id },
    })
    assert(bindOther.status === 201, `bind other ${bindOther.status} ${bindOther.text}`)

    const crossReady = await req(base, 'POST', `/internal/instances/${adminId}/ready`, {
      token: otherSmt,
      body: { host: 'http://127.0.0.1:9', botId: 'x' },
    })
    assert(crossReady.status === 403, `cross ready ${crossReady.status} ${crossReady.text}`)

    const crossIdx = await req(base, 'POST', '/internal/sessions/index', {
      token: otherSmt,
      body: { sessionId: 's-cross', companyId: orgId, accountId: adminId },
    })
    assert(crossIdx.status === 403, `cross index ${crossIdx.status} ${crossIdx.text}`)

    const crossUse = await req(base, 'POST', '/internal/usage', {
      token: otherSmt,
      body: { accountId: adminId, provider: 'deepseek', model: 'm', promptTokens: 1, completionTokens: 1 },
    })
    assert(crossUse.status === 403, `cross usage ${crossUse.status} ${crossUse.text}`)

    const usage = await req(base, 'POST', '/internal/usage', {
      token: orgMachineTok,
      body: { accountId: adminId, provider: 'deepseek', model: 'deepseek-v4-flash', promptTokens: 11, completionTokens: 7 },
    })
    assert(usage.status === 200 && usage.json.ok === true, `usage ingest ${usage.status} ${usage.text}`)
    const stats = await req(base, 'GET', `/orgs/${orgId}/usage`, { token })
    assert(stats.status === 200, `org usage after ingest ${stats.status}`)
    const tasks = (stats.json.stats || []).find((x) => x.label === '任务执行')
    assert(tasks && Number(tasks.value) >= 1, `calls ${tasks && tasks.value}`)
    const inp = (stats.json.stats || []).find((x) => x.label === '输入 Tokens')
    assert(inp && Number(inp.value) >= 11, `prompt ${inp && inp.value}`)
  })

  await test('POST /v1/chat/completions|/v1/responses|/v1/messages 无票 → 401', async () => {
    const a = await req(base, 'POST', '/v1/chat/completions', { body: { model: 'deepseek/deepseek-v4-flash', messages: [] } })
    assert(a.status === 401, `chat ${a.status}`)
    const b = await req(base, 'POST', '/v1/responses', { body: { model: 'openai/gpt-4o', input: 'hi' } })
    assert(b.status === 401, `responses ${b.status}`)
    const c = await req(base, 'POST', '/v1/messages', { body: { model: 'claude-3-5-sonnet-latest', max_tokens: 16, messages: [] } })
    assert(c.status === 401, `messages ${c.status}`)
  })

  await test('POST /v1/* 未知模型 → 404；无密钥 provider → 402（不打上游）', async () => {
    const miss = await req(base, 'POST', '/v1/chat/completions', {
      token,
      body: { model: 'no-such-provider/no-such-model', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert(miss.status === 404, `unknown ${miss.status} ${miss.text}`)
    const fake = await req(base, 'POST', '/catalog/models', {
      token: PLATFORM_TOK,
      body: { name: 'e2e-missing', definition: { provider: 'e2e-fake', id: 'missing-key' } },
    })
    assert(fake.status === 201, `catalog model ${fake.status} ${fake.text}`)
    const chat = await req(base, 'POST', '/v1/chat/completions', {
      token,
      body: { model: 'e2e-fake/missing-key', messages: [{ role: 'user', content: 'hi' }] },
    })
    assert(chat.status === 402, `chat 402 ${chat.status} ${chat.text}`)
    assert(!String(chat.json.error || '').includes('stack'), 'chat stack')
    const resp = await req(base, 'POST', '/v1/responses', {
      token,
      body: { model: 'e2e-fake/missing-key', input: 'hi' },
    })
    assert(resp.status === 402, `responses 402 ${resp.status} ${resp.text}`)
    const msg = await req(base, 'POST', '/v1/messages', {
      token,
      body: { model: 'e2e-fake/missing-key', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    })
    assert(msg.status === 402, `messages 402 ${msg.status} ${msg.text}`)
  })

  await test('POST /orgs/:id/llm/test：无票 401；成员 403；未设角色 400；无密钥 402；不泄漏 secret', async () => {
    const unauth = await req(base, 'POST', `/orgs/${orgId}/llm/test`, { body: { role: 'daily' } })
    assert(unauth.status === 401, `unauth ${unauth.status}`)
    const deny = await req(base, 'POST', `/orgs/${orgId}/llm/test`, { token: memberTok, body: { role: 'daily' } })
    assert(deny.status === 403, `member ${deny.status}`)
    const unset = await req(base, 'POST', `/orgs/${orgId}/llm/test`, { token, body: { role: 'daily' } })
    assert(unset.status === 400, `unset ${unset.status} ${unset.text}`)
    const fake = await req(base, 'POST', `/orgs/${orgId}/llm/test`, { token, body: { provider: 'e2e-fake' } })
    assert(fake.status === 402, `fake ${fake.status} ${fake.text}`)
    assert(!dumpHas(fake.json, secret), 'test 泄漏 secret')
    assert(!dumpHas(fake.json, 'sk-e2e-rotated-never-leak'), 'test 泄漏 rotated')
  })

  await test('seeded owner GET /me：role owner、company null、settings 对象', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'owner@satuwork.test', password: 'test-owner-3080' },
    })
    assert(login.status === 200, `owner login ${login.status} ${login.text}`)
    assert(login.json.account.role === 'owner', 'login role')
    assert(login.json.company === null, 'login company')
    ownerTok = login.json.token
    const me = await req(base, 'GET', '/me', { token: ownerTok })
    assert(me.status === 200, `me ${me.status} ${me.text}`)
    assert(me.json.account.role === 'owner', 'me role')
    assert(me.json.company === null, 'me company')
    assert(me.json.settings && typeof me.json.settings === 'object', 'me settings')
    assert(me.json.settings.daily && me.json.settings.utility, 'me daily/utility')
  })

  await test('owner GET /platform/orgs 看见已注册公司', async () => {
    const r = await req(base, 'GET', '/platform/orgs', { token: ownerTok })
    assert(r.status === 200, `orgs ${r.status} ${r.text}`)
    assert(r.json.orgs.some((c) => c.id === orgId && c.slug === 'acme'), 'missing acme')
  })

  await test('owner 公司列表弹窗 + 详情 SPA；成员/订阅 API 按 path id', async () => {
    const appJs = readFileSync(join(gwRoot, 'ui/app.js'), 'utf8')
    assert(appJs.includes('data-act="org-create-open"'), '缺 新建公司 按钮')
    assert(appJs.includes('orgCreateOpen'), '缺 orgCreateOpen')
    assert(appJs.includes('function companyDetailPage'), '缺 companyDetailPage')
    assert(appJs.includes('function companyIdOfPath'), '缺 companyIdOfPath')
    assert(appJs.includes('function orgCreateModal'), '缺 orgCreateModal')
    assert(!/function companiesPage\(\)[\s\S]*?<form id="create-org-form" class="satu-panel"/.test(appJs), '列表页仍有内联新建表单')

    const spa = await req(base, 'GET', '/companies')
    assert(spa.status === 200, `spa /companies ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa /companies html')
    assert(!String(spa.text).includes('<form id="create-org-form"'), 'shell 含静态新建表单')

    const detail = await req(base, 'GET', `/companies/${orgId}`)
    assert(detail.status === 200, `spa /companies/:id ${detail.status}`)
    assert(String(detail.text).includes('<!doctype html>') || String(detail.text).includes('Satuwork'), 'spa detail html')

    const org = await req(base, 'GET', `/orgs/${orgId}`, { token: ownerTok })
    assert(org.status === 200, `owner org ${org.status} ${org.text}`)
    assert(org.json.company && org.json.company.id === orgId, 'company')
    assert(org.json.plan && typeof org.json.plan.seats === 'number', 'plan.seats')

    const acc = await req(base, 'GET', `/orgs/${orgId}/accounts`, { token: ownerTok })
    assert(acc.status === 200, `owner accounts ${acc.status} ${acc.text}`)
    assert(Array.isArray(acc.json.members) && acc.json.members.some((m) => m.email === 'admin@acme.test' && m.role === 'admin'), '缺管理员')

    const bill = await req(base, 'GET', `/orgs/${orgId}/billing`, { token: ownerTok })
    assert(bill.status === 200, `owner billing ${bill.status} ${bill.text}`)
    assert(bill.json.plan && bill.json.plan.seats === `${org.json.plan.seats} 个席位`, `seats ${bill.json.plan && bill.json.plan.seats}`)
    assert(bill.json.plan.used === org.json.plan.used, `used ${bill.json.plan && bill.json.plan.used}`)

    const memberSpa = await req(base, 'GET', '/companies')
    assert(memberSpa.status === 200, `member spa /companies ${memberSpa.status}`)
    assert(String(memberSpa.text).includes('<!doctype html>') || String(memberSpa.text).includes('Satuwork'), 'member spa html')
  })

  await test('公司管理员 PUT /platform/settings → 403', async () => {
    const r = await req(base, 'PUT', '/platform/settings', {
      token,
      body: { daily: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
    })
    assert(r.status === 403, `admin settings ${r.status} ${r.text}`)
  })

  await test('成员 GET /platform/orgs → 403', async () => {
    const r = await req(base, 'GET', '/platform/orgs', { token: memberTok })
    assert(r.status === 403, `member orgs ${r.status} ${r.text}`)
  })

  await test('GET /me 给管理员的 settings 是平台设置', async () => {
    const put = await req(base, 'PUT', '/platform/settings', {
      token: ownerTok,
      body: {
        daily: { provider: 'deepseek', model: 'deepseek-chat' },
        utility: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      },
    })
    assert(put.status === 200, `owner put ${put.status} ${put.text}`)
    const me = await req(base, 'GET', '/me', { token })
    assert(me.status === 200, `admin me ${me.status}`)
    assert(me.json.settings.daily.provider === 'deepseek', 'daily provider')
    assert(me.json.settings.daily.model === 'deepseek-chat', 'daily model')
    assert(me.json.settings.utility.model === 'deepseek-v4-flash', 'utility model')
  })

  let inviteOrg
  let inviteAdminTok
  let inviteAdminId
  let invitedEmail
  let inviteToken
  let invitedId
  let invitedTok

  await test('邀请成员：建号为 invited，返回一次性链接', async () => {
    const reg = await req(base, 'POST', '/auth/register', {
      body: {
        email: 'boss@invite.test',
        password: 'correct-horse',
        companyName: 'InviteCo',
        slug: 'inviteco',
        seats: 5,
      },
    })
    assert(reg.status === 201, `register ${reg.status} ${reg.text}`)
    inviteOrg = reg.json.company.id
    inviteAdminTok = reg.json.token
    inviteAdminId = reg.json.account.id

    const list = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(list.status === 200, `list ${list.status} ${list.text}`)
    assert(Array.isArray(list.json.members), 'members')
    assert(list.json.seats && list.json.seats.total === 5, 'seats.total')
    assert(list.json.seats.used === 1, 'seats.used')
    assert(list.json.me && list.json.me.id === inviteAdminId, 'me')
    assert(!dumpHas(list.json, 'passwordHash'), 'list 泄漏哈希')

    invitedEmail = 'joiner@invite.test'
    const inv = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/members`, {
      token: inviteAdminTok,
      body: { email: invitedEmail, name: '加入者', role: 'member', ttlDays: 7 },
    })
    assert(inv.status === 201, `invite ${inv.status} ${inv.text}`)
    assert(inv.json.user.status === 'invited', 'status invited')
    assert(inv.json.user.email === invitedEmail, 'email')
    assert(inv.json.user.name === '加入者', 'name')
    assert(typeof inv.json.invite.url === 'string' && inv.json.invite.url.includes('/join/'), 'invite url')
    assert(typeof inv.json.invite.expiresAt === 'number', 'expiresAt')
    assert(!dumpHas(inv.json, 'passwordHash'), 'invite 泄漏哈希')
    invitedId = inv.json.user.id
    inviteToken = inv.json.invite.url.split('/join/')[1]
    assert(inviteToken, 'token from url')

    const listed = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(listed.json.members.some((m) => m.id === invitedId && m.status === 'invited'), 'list shows invited')
    assert(listed.json.seats.used === 2, 'invited occupies a seat')
  })

  await test('GET 邀请有效 → 接受 → 成员可登录；待接受不能登录', async () => {
    const blocked = await req(base, 'POST', '/auth/login', {
      body: { email: invitedEmail, password: 'correct-horse' },
    })
    assert(blocked.status === 401 || blocked.status === 403, `invited login ${blocked.status}`)
    assert(String(blocked.json.error).includes('邀请') || String(blocked.json.error).includes('口令'), 'invited 文案')

    const peek = await req(base, 'GET', `/invites/${inviteToken}`)
    assert(peek.status === 200, `peek ${peek.status} ${peek.text}`)
    assert(peek.json.valid === true, 'valid')
    assert(peek.json.email === invitedEmail, 'peek email')
    assert(peek.json.name === '加入者', 'peek name')

    const spa = await req(base, 'GET', `/join/${inviteToken}`)
    assert(spa.status === 200, `spa ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa html')

    const miss = await req(base, 'GET', '/invites/not-a-real-token')
    assert(miss.status === 200 && miss.json.valid === false, 'invalid invite')

    const acc = await req(base, 'POST', `/invites/${inviteToken}/accept`, {
      body: { name: '加入者', password: 'joiner-pass-10' },
    })
    assert(acc.status === 200, `accept ${acc.status} ${acc.text}`)
    assert(typeof acc.json.token === 'string', 'accept jwt')
    assert(acc.json.account.status === 'active', 'active')
    assert(!dumpHas(acc.json, 'passwordHash'), 'accept 泄漏哈希')

    const reuse = await req(base, 'GET', `/invites/${inviteToken}`)
    assert(reuse.status === 200 && reuse.json.valid === false, 'used invite invalid')

    const login = await req(base, 'POST', '/auth/login', {
      body: { email: invitedEmail, password: 'joiner-pass-10' },
    })
    assert(login.status === 200, `member login ${login.status} ${login.text}`)
    invitedTok = login.json.token
  })

  await test('公司账单：SPA + 真席位 + 空发票/充值，不编假钱', async () => {
    const spa = await req(base, 'GET', '/billing')
    assert(spa.status === 200, `spa /billing ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa /billing html')
    const alias = await req(base, 'GET', '/costs')
    assert(alias.status === 200, `spa /costs ${alias.status}`)
    assert(String(alias.text).includes('<!doctype html>') || String(alias.text).includes('Satuwork'), 'spa /costs html')

    const plan = await req(base, 'GET', `/orgs/${inviteOrg}/plan`, { token: inviteAdminTok })
    assert(plan.status === 200, `plan ${plan.status} ${plan.text}`)
    const r = await req(base, 'GET', `/orgs/${inviteOrg}/billing`, { token: inviteAdminTok })
    assert(r.status === 200, `billing ${r.status} ${r.text}`)
    assert(r.json.plan && r.json.plan.name === '席位套餐', 'plan.name')
    assert(r.json.plan.status === '生效中', 'plan.status')
    assert(r.json.plan.seats === `${plan.json.seats} 个席位`, `seats ${r.json.plan.seats}`)
    assert(r.json.plan.used === plan.json.used, `used ${r.json.plan.used}`)
    assert(r.json.plan.cycle === '—' && r.json.plan.period === '—' && r.json.plan.renew === '—' && r.json.plan.amount === '—', 'unwired plan fields')
    assert(r.json.plan.autoRenew === false, 'autoRenew')
    assert(Array.isArray(r.json.invoices) && r.json.invoices.length === 0, 'invoices empty')
    assert(Array.isArray(r.json.topups) && r.json.topups.length === 0, 'topups empty')
    assert(r.json.balance && r.json.balance.amount === '—' && r.json.balance.spentThisMonth === '—' && r.json.balance.alertAt === '—', 'balance empty')
    assert(r.json.mock !== true, 'mock:true')
    assert(!dumpHas(r.json, '$286'), '$286')
    assert(!dumpHas(r.json, '$1,150'), '$1,150')
    assert(!dumpHas(r.json, 'mock'), 'mock 字样')

    const member = await req(base, 'GET', `/orgs/${inviteOrg}/billing`, { token: invitedTok })
    assert(member.status === 403, `member billing ${member.status} ${member.text}`)

    const unauth = await req(base, 'GET', `/orgs/${inviteOrg}/billing`)
    assert(unauth.status === 401, `unauth billing ${unauth.status}`)
    const miss = await req(base, 'GET', '/orgs/no-such-org/billing', { token: ownerTok })
    assert(miss.status === 404, `missing org ${miss.status} ${miss.text}`)
  })

  await test('公司用量：SPA + 真成员名/席位 + 次数费用为 0/—，不编假数', async () => {
    const spa = await req(base, 'GET', '/usage')
    assert(spa.status === 200, `spa /usage ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa /usage html')

    const r = await req(base, 'GET', `/orgs/${inviteOrg}/usage`, { token: inviteAdminTok })
    assert(r.status === 200, `usage ${r.status} ${r.text}`)
    assert(r.json.mock !== true, 'mock:true')
    assert(!dumpHas(r.json, 'mock'), 'mock 字样')
    const numbers = { stats: r.json.stats, daily: r.json.daily, byAgent: r.json.byAgent, byModel: r.json.byModel, quota: r.json.quota }
    assert(!dumpHas(numbers, '$286'), '$286')
    assert(!dumpHas(numbers, '895'), '895')
    assert(!dumpHas(numbers, '48.2M'), '48.2M')
    assert(Array.isArray(r.json.stats) && r.json.stats.length === 4, 'stats')
    for (const s of r.json.stats) {
      assert(s.value === '0' || s.value === '—', `stat ${s.label}=${s.value}`)
      assert(s.delta === '—' || s.delta == null, `delta ${s.label}=${s.delta}`)
    }
    assert(Array.isArray(r.json.daily) && r.json.daily.length === 0, 'daily empty')
    assert(Array.isArray(r.json.byModel) && r.json.byModel.length === 0, 'byModel empty')
    assert(Array.isArray(r.json.quota) && r.json.quota.length === 0, 'quota empty')
    assert(Array.isArray(r.json.byAgent), 'byAgent array')
    assert(r.json.byAgent.length === 0, 'byAgent 应空，不编 0 次')
    assert(r.json.seats === 5, `seats ${r.json.seats}`)
    assert(Array.isArray(r.json.byMember) && r.json.byMember.length >= 1, 'byMember')
    const joiner = r.json.byMember.find((m) => m.id === invitedId || m.name === '加入者')
    assert(joiner, 'missing employee 加入者')
    assert(joiner.tasks === '0', `tasks ${joiner.tasks}`)
    assert(joiner.tokens === '0', `tokens ${joiner.tokens}`)
    assert(joiner.fail === '—', `fail ${joiner.fail}`)
    assert(joiner.last === '—', `last ${joiner.last}`)
    assert(joiner.initial === '加', `initial ${joiner.initial}`)

    const member = await req(base, 'GET', `/orgs/${inviteOrg}/usage`, { token: invitedTok })
    assert(member.status === 403, `member usage ${member.status} ${member.text}`)
    const meStats = await req(base, 'GET', '/me/stats', { token: invitedTok })
    assert(meStats.status === 200, `me/stats ${meStats.status} ${meStats.text}`)
    assert(Array.isArray(meStats.json.stats) && meStats.json.stats.length === 4, 'me stats')
    assert(!meStats.json.byMember, 'me/stats 不应带全员 byMember')
    const meTasks = (meStats.json.stats || []).find((x) => x.label === '任务执行')
    assert(meTasks && meTasks.value === '0', `self tasks ${meTasks && meTasks.value}`)
    const adminStats = await req(base, 'GET', '/me/stats', { token: inviteAdminTok })
    assert(adminStats.status === 200, `admin me/stats ${adminStats.status}`)

    const unauth = await req(base, 'GET', `/orgs/${inviteOrg}/usage`)
    assert(unauth.status === 401, `unauth usage ${unauth.status}`)
    const miss = await req(base, 'GET', '/orgs/no-such-org/usage', { token: ownerTok })
    assert(miss.status === 404, `missing org ${miss.status} ${miss.text}`)
  })

  await test('停用成员不能登录；成员不能邀请', async () => {
    const dis = await req(base, 'PATCH', `/orgs/${inviteOrg}/accounts/${invitedId}`, {
      token: inviteAdminTok,
      body: { status: 'disabled' },
    })
    assert(dis.status === 200, `disable ${dis.status} ${dis.text}`)
    assert(dis.json.account.status === 'disabled', 'disabled')

    const login = await req(base, 'POST', '/auth/login', {
      body: { email: invitedEmail, password: 'joiner-pass-10' },
    })
    assert(login.status === 403, `disabled login ${login.status} ${login.text}`)
    assert(String(login.json.error).includes('停用'), '停用文案')

    const still = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: invitedTok })
    assert(still.status === 401, `revoked jwt ${still.status} ${still.text}`)

    const en = await req(base, 'PATCH', `/orgs/${inviteOrg}/accounts/${invitedId}`, {
      token: inviteAdminTok,
      body: { status: 'active' },
    })
    assert(en.status === 200 && en.json.account.status === 'active', 're-enable')
    const relogin = await req(base, 'POST', '/auth/login', {
      body: { email: invitedEmail, password: 'joiner-pass-10' },
    })
    assert(relogin.status === 200, `relogin ${relogin.status}`)
    invitedTok = relogin.json.token

    const deny = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/members`, {
      token: invitedTok,
      body: { email: 'nope@invite.test', name: 'Nope', role: 'member', ttlDays: 1 },
    })
    assert(deny.status === 403, `member invite ${deny.status} ${deny.text}`)
  })

  await test('不能删除自己', async () => {
    const r = await req(base, 'DELETE', `/orgs/${inviteOrg}/accounts/${inviteAdminId}`, { token: inviteAdminTok })
    assert(r.status === 400 || r.status === 403, `delete self ${r.status} ${r.text}`)
    assert(String(r.json.error).includes('自己'), '自己 文案')
  })

  let groupId

  await test('GET accounts 含 builtin 全体成员（含管理员）', async () => {
    const list = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(list.status === 200, `list ${list.status} ${list.text}`)
    assert(Array.isArray(list.json.groups), 'groups')
    const all = list.json.groups.find((g) => g.id === 'all')
    assert(all && all.builtin === true, 'builtin all')
    assert(all.name === '全体成员', 'name')
    assert(all.icon === 'users', 'icon')
    assert(all.role === null, 'all role')
    assert(Array.isArray(all.members) && all.members.includes(inviteAdminId), 'admin in all')
    assert(all.members.includes(invitedId), 'invited in all')
    assert(Array.isArray(all.agents), 'agents')
  })

  await test('POST group → 201，出现在列表', async () => {
    const r = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/groups`, {
      token: inviteAdminTok,
      body: { name: '客服组', desc: '一线', icon: 'chat', role: 'member', members: [inviteAdminId, invitedId] },
    })
    assert(r.status === 201, `create ${r.status} ${r.text}`)
    assert(r.json.group && r.json.group.builtin === false, 'group')
    assert(r.json.group.name === '客服组', 'name')
    assert(r.json.group.icon === 'chat', 'icon')
    assert(r.json.group.role === 'member', 'role')
    assert(r.json.group.members.includes(inviteAdminId), 'members')
    assert(r.json.group.members.includes(invitedId), 'members invited')
    assert(Array.isArray(r.json.group.agents), 'agents')
    assert(!Object.prototype.hasOwnProperty.call(r.json.group, 'companyId'), 'omit companyId')
    groupId = r.json.group.id
    assert(groupId && groupId !== 'all', 'id')
    const list = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(
      list.json.groups.some((g) => g.id === groupId && g.name === '客服组' && g.builtin === false),
      'list',
    )
  })

  await test('PATCH group 改名和成员', async () => {
    const r = await req(base, 'PATCH', `/orgs/${inviteOrg}/accounts/groups/${groupId}`, {
      token: inviteAdminTok,
      body: { name: '客服组改', members: [invitedId] },
    })
    assert(r.status === 200, `patch ${r.status} ${r.text}`)
    assert(r.json.group.name === '客服组改', 'name')
    assert(r.json.group.members.length === 1 && r.json.group.members[0] === invitedId, 'members')
  })

  await test('不能 PATCH/DELETE all；成员不能 POST；空名 400', async () => {
    const patchAll = await req(base, 'PATCH', `/orgs/${inviteOrg}/accounts/groups/all`, {
      token: inviteAdminTok,
      body: { name: 'x' },
    })
    assert(patchAll.status === 400, `patch all ${patchAll.status} ${patchAll.text}`)
    const delAll = await req(base, 'DELETE', `/orgs/${inviteOrg}/accounts/groups/all`, { token: inviteAdminTok })
    assert(delAll.status === 400, `delete all ${delAll.status} ${delAll.text}`)
    const deny = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/groups`, {
      token: invitedTok,
      body: { name: '不该成功' },
    })
    assert(deny.status === 403, `member post ${deny.status} ${deny.text}`)
    const empty = await req(base, 'POST', `/orgs/${inviteOrg}/accounts/groups`, {
      token: inviteAdminTok,
      body: { name: '   ' },
    })
    assert(empty.status === 400, `empty ${empty.status} ${empty.text}`)
  })

  await test('DELETE group', async () => {
    const r = await req(base, 'DELETE', `/orgs/${inviteOrg}/accounts/groups/${groupId}`, { token: inviteAdminTok })
    assert(r.status === 200 && r.json.ok === true, `delete ${r.status} ${r.text}`)
    const list = await req(base, 'GET', `/orgs/${inviteOrg}/accounts`, { token: inviteAdminTok })
    assert(!list.json.groups.some((g) => g.id === groupId), 'gone')
    assert(list.json.groups.some((g) => g.id === 'all' && g.builtin === true), 'all remains')
  })

  await test('GET /me 含 title/phone/theme/locale', async () => {
    const r = await req(base, 'GET', '/me', { token: inviteAdminTok })
    assert(r.status === 200, `me ${r.status} ${r.text}`)
    const a = r.json.account
    assert(typeof a.title === 'string', 'title')
    assert(typeof a.phone === 'string', 'phone')
    assert(a.theme === 'light' || a.theme === 'dark' || a.theme === 'system', `theme ${a.theme}`)
    assert(a.locale === 'zh' || a.locale === 'en', `locale ${a.locale}`)
  })

  await test('PATCH /me 姓名/职位/手机/外观/语言会落库', async () => {
    const r = await req(base, 'PATCH', '/me', {
      token: inviteAdminTok,
      body: { name: '老板改', title: '运营负责人', phone: '13800000000', theme: 'dark', locale: 'en' },
    })
    assert(r.status === 200, `patch ${r.status} ${r.text}`)
    assert(r.json.account.name === '老板改', 'name')
    assert(r.json.account.title === '运营负责人', 'title')
    assert(r.json.account.phone === '13800000000', 'phone')
    assert(r.json.account.theme === 'dark', 'theme')
    assert(r.json.account.locale === 'en', 'locale')
    assert(!dumpHas(r.json, 'passwordHash'), 'patch 泄漏哈希')
    const me = await req(base, 'GET', '/me', { token: inviteAdminTok })
    assert(me.json.account.name === '老板改', 'persisted name')
    assert(me.json.account.title === '运营负责人', 'persisted title')
    assert(me.json.account.phone === '13800000000', 'persisted phone')
    assert(me.json.account.theme === 'dark', 'persisted theme')
    assert(me.json.account.locale === 'en', 'persisted locale')
  })

  await test('成员也能 PATCH /me（个人设置，不是管理员接口）', async () => {
    const r = await req(base, 'PATCH', '/me', {
      token: invitedTok,
      body: { name: '加入者改', title: '一线客服', phone: '', theme: 'light', locale: 'zh' },
    })
    assert(r.status === 200, `member patch ${r.status} ${r.text}`)
    assert(r.json.account.name === '加入者改', 'member name')
    assert(r.json.account.title === '一线客服', 'member title')
    assert(r.json.account.theme === 'light', 'member theme')
    const me = await req(base, 'GET', '/me', { token: invitedTok })
    assert(me.json.account.title === '一线客服', 'member persisted')
  })

  await test('SPA GET /profile 返回 html', async () => {
    const r = await req(base, 'GET', '/profile')
    assert(r.status === 200, `spa ${r.status}`)
    assert(String(r.text).includes('<!doctype html>') || String(r.text).includes('Satuwork'), 'spa html')
  })

  await test('POST /me/password 当前口令不对 → 400', async () => {
    const r = await req(base, 'POST', '/me/password', {
      token: inviteAdminTok,
      body: { current: 'wrong-horse', next: 'new-password-10' },
    })
    assert(r.status === 400, `wrong ${r.status} ${r.text}`)
    assert(String(r.json.error).includes('当前口令不对'), '文案')
  })

  await test('POST /me/password 新口令与当前相同 → 400', async () => {
    const r = await req(base, 'POST', '/me/password', {
      token: inviteAdminTok,
      body: { current: 'correct-horse', next: 'correct-horse' },
    })
    assert(r.status === 400, `same ${r.status} ${r.text}`)
    assert(String(r.json.error).includes('相同'), '文案')
  })

  await test('POST /me/password 成功 → 新票可用、旧票 401', async () => {
    // iat 只有秒精度：同一秒内签发的旧票不会被 tokenRevokedAt 杀掉（新票也要活）。
    await new Promise((x) => setTimeout(x, 1100))
    const r = await req(base, 'POST', '/me/password', {
      token: inviteAdminTok,
      body: { current: 'correct-horse', next: 'new-horse-10' },
    })
    assert(r.status === 200, `ok ${r.status} ${r.text}`)
    assert(r.json.ok === true, 'ok')
    assert(typeof r.json.token === 'string' && r.json.token.split('.').length === 3, 'new jwt')
    const old = await req(base, 'GET', '/me', { token: inviteAdminTok })
    assert(old.status === 401, `old token ${old.status} ${old.text}`)
    const neu = await req(base, 'GET', '/me', { token: r.json.token })
    assert(neu.status === 200, `new token ${neu.status} ${neu.text}`)
    assert(neu.json.account.id === inviteAdminId, 'same account')
  })

  await test('公司 Bot：空列表、创建、改、选项、权限、删除、SPA', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'boss@invite.test', password: 'new-horse-10' },
    })
    assert(login.status === 200, `relogin ${login.status} ${login.text}`)
    const adminTok = login.json.token

    const empty = await req(base, 'GET', `/orgs/${inviteOrg}/bots`, { token: adminTok })
    assert(empty.status === 200, `list ${empty.status} ${empty.text}`)
    assert(Array.isArray(empty.json.bots) && empty.json.bots.length === 0, 'starts empty')

    const created = await req(base, 'POST', `/orgs/${inviteOrg}/bots`, {
      token: adminTok,
      body: { name: '客服助手', description: '客服' },
    })
    assert(created.status === 201, `create ${created.status} ${created.text}`)
    assert(created.json.bot.origin === 'company', 'origin')
    assert(created.json.bot.enabled === true, 'enabled')
    assert(created.json.bot.name === '客服助手', 'name')
    assert(created.json.bot.description === '客服', 'description')
    assert(typeof created.json.bot.provider === 'string' && created.json.bot.provider, 'provider')
    assert(typeof created.json.bot.model === 'string' && created.json.bot.model, 'model')
    const id = created.json.bot.id

    const list = await req(base, 'GET', `/orgs/${inviteOrg}/bots`, { token: adminTok })
    assert(list.json.bots.some((b) => b.id === id && b.name === '客服助手'), 'list contains')

    const patched = await req(base, 'PATCH', `/orgs/${inviteOrg}/bots/${id}`, {
      token: adminTok,
      body: { prompt: '你是客服。', enabled: false, icon: 'chat' },
    })
    assert(patched.status === 200, `patch ${patched.status} ${patched.text}`)
    assert(patched.json.bot.prompt === '你是客服。', 'prompt')
    assert(patched.json.bot.enabled === false, 'enabled false')
    assert(patched.json.bot.icon === 'chat', 'icon')

    const opts = await req(base, 'GET', `/orgs/${inviteOrg}/bots/options`, { token: adminTok })
    assert(opts.status === 200, `options ${opts.status} ${opts.text}`)
    assert(Array.isArray(opts.json.groups), 'groups array')
    assert(Array.isArray(opts.json.skills), 'skills')
    assert(Array.isArray(opts.json.mcps), 'mcps')
    assert(Array.isArray(opts.json.kbs) && opts.json.kbs.length === 0, 'kbs empty')

    const deny = await req(base, 'POST', `/orgs/${inviteOrg}/bots`, {
      token: invitedTok,
      body: { name: '不该成功' },
    })
    assert(deny.status === 403, `member post ${deny.status}`)

    const emptyName = await req(base, 'POST', `/orgs/${inviteOrg}/bots`, {
      token: adminTok,
      body: { name: '   ' },
    })
    assert(emptyName.status === 400, `empty ${emptyName.status} ${emptyName.text}`)
    assert(String(emptyName.json.error).includes('助理要有名字'), 'empty name 文案')

    const spaList = await req(base, 'GET', '/bots')
    assert(spaList.status === 200, `spa list ${spaList.status}`)
    assert(String(spaList.text).includes('<!doctype html>') || String(spaList.text).includes('Satuwork'), 'spa html')
    const spaOne = await req(base, 'GET', `/bots/${id}`)
    assert(spaOne.status === 200, `spa one ${spaOne.status}`)
    assert(String(spaOne.text).includes('<!doctype html>') || String(spaOne.text).includes('Satuwork'), 'spa detail html')

    const del = await req(base, 'DELETE', `/orgs/${inviteOrg}/bots/${id}`, { token: adminTok })
    assert(del.status === 200 && del.json.deleted === true && del.json.id === id, 'delete')
    const gone = await req(base, 'GET', `/orgs/${inviteOrg}/bots/${id}`, { token: adminTok })
    assert(gone.status === 404, `gone ${gone.status}`)
    assert(String(gone.json.error).includes('没有这个助理'), '404 文案')
    const after = await req(base, 'GET', `/orgs/${inviteOrg}/bots`, { token: adminTok })
    assert(!after.json.bots.some((b) => b.id === id), 'list gone')
  })

  await test('公司 Skill / MCP：列表、步骤摘要、token 不回传、权限、SPA', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'boss@invite.test', password: 'new-horse-10' },
    })
    assert(login.status === 200, `relogin ${login.status} ${login.text}`)
    const adminTok = login.json.token

    const empty = await req(base, 'GET', `/orgs/${inviteOrg}/skills`, { token: adminTok })
    assert(empty.status === 200, `list ${empty.status} ${empty.text}`)
    assert(Array.isArray(empty.json.skills) && empty.json.skills.length === 0, 'skills empty')
    assert(Array.isArray(empty.json.servers) && empty.json.servers.length === 0, 'servers empty')
    assert(Array.isArray(empty.json.tags) && empty.json.tags.includes('客服'), 'default tags')

    const created = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: adminTok,
      body: { name: '工单归类', body: '处理工单。\n\n- 读取来信\n- 归类\n- 回复', tags: ['客服'] },
    })
    assert(created.status === 201, `create ${created.status} ${created.text}`)
    assert(created.json.skill.name === '工单归类', 'name')
    assert(created.json.skill.steps === 3, `steps ${created.json.skill.steps}`)
    assert(created.json.skill.summary === '处理工单。', `summary ${created.json.skill.summary}`)
    assert(created.json.skill.enabled === true, 'enabled')
    assert(created.json.skill.source === '手动编写', 'source')
    const skillId = created.json.skill.id

    const patched = await req(base, 'PATCH', `/orgs/${inviteOrg}/skills/${skillId}`, {
      token: adminTok,
      body: { tags: ['客服', '自动化'], enabled: false },
    })
    assert(patched.status === 200, `patch ${patched.status} ${patched.text}`)
    assert(patched.json.skill.enabled === false, 'enabled false')
    assert(patched.json.skill.tags.includes('自动化'), 'tags')

    const one = await req(base, 'GET', `/orgs/${inviteOrg}/skills/${skillId}`, { token: adminTok })
    assert(one.status === 200 && one.json.skill.id === skillId, 'get skill')
    assert(one.json.skill.steps === 3, 'get steps')

    const zip = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: adminTok,
      body: {
        name: 'zip-skill',
        source: 'ZIP 包',
        files: [
          { path: 'SKILL.md', text: '从包来。\n\n- 一步\n- 两步' },
          { path: 'bin.dat', base64: 'aaaa' },
        ],
      },
    })
    assert(zip.status === 201, `zip ${zip.status} ${zip.text}`)
    assert(zip.json.skill.body.includes('从包来'), 'zip body from SKILL.md')
    assert(zip.json.skill.steps === 2, 'zip steps')
    assert(zip.json.skill.fileCount === 1, `fileCount ${zip.json.skill.fileCount}`)
    const zipId = zip.json.skill.id

    const mcp = await req(base, 'POST', `/orgs/${inviteOrg}/mcp-servers`, {
      token: adminTok,
      body: {
        name: 'zendesk-mcp',
        kind: 'SSE',
        endpoint: 'https://mcp.example.com/sse',
        perm: '只读',
        token: 'secret-mcp-token',
        env: { API_KEY: 'mcp-env-secret-value' },
      },
    })
    assert(mcp.status === 201, `mcp ${mcp.status} ${mcp.text}`)
    assert(mcp.json.server.name === 'zendesk-mcp', 'mcp name')
    assert(mcp.json.server.hasToken === true, 'hasToken')
    assert(mcp.json.server.hasEnv === true, 'hasEnv')
    assert(!Object.prototype.hasOwnProperty.call(mcp.json.server, 'token'), 'no token field on create')
    assert(!dumpHas(mcp.json, 'secret-mcp-token'), 'create 泄漏 token')
    assert(!dumpHas(mcp.json, 'mcp-env-secret-value'), 'create 泄漏 env')
    if (mcp.json.server.env) {
      for (const v of Object.values(mcp.json.server.env)) assert(v === '', `env value ${v}`)
    }
    const serverId = mcp.json.server.id

    const mcpList = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers`, { token: adminTok })
    assert(mcpList.status === 200, `mcp list ${mcpList.status}`)
    assert(!dumpHas(mcpList.json, 'mcp-env-secret-value'), 'list 泄漏 env')
    assert(!dumpHas(mcpList.json, 'secret-mcp-token'), 'list 泄漏 token')

    const mcpGet = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, { token: adminTok })
    assert(mcpGet.status === 200, `mcp get ${mcpGet.status}`)
    assert(mcpGet.json.server.hasToken === true, 'get hasToken')
    assert(!Object.prototype.hasOwnProperty.call(mcpGet.json.server, 'token'), 'no token field on get')
    assert(!dumpHas(mcpGet.json, 'secret-mcp-token'), 'get 泄漏 token')
    assert(!dumpHas(mcpGet.json, 'mcp-env-secret-value'), 'get 泄漏 env')

    const mcpPatch = await req(base, 'PATCH', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, {
      token: adminTok,
      body: { token: 'rotated-mcp-token' },
    })
    assert(mcpPatch.status === 200, `mcp patch ${mcpPatch.status} ${mcpPatch.text}`)
    assert(mcpPatch.json.server.hasToken === true, 'patch hasToken')
    assert(!Object.prototype.hasOwnProperty.call(mcpPatch.json.server, 'token'), 'no token field on patch')
    assert(!dumpHas(mcpPatch.json, 'rotated-mcp-token'), 'patch 泄漏 token')

    const afterTok = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, { token: adminTok })
    assert(afterTok.json.server.hasToken === true, 'still hasToken')
    assert(!dumpHas(afterTok.json, 'rotated-mcp-token'), 'later get 泄漏 token')

    const denySkill = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: invitedTok,
      body: { name: '不该成功' },
    })
    assert(denySkill.status === 403, `member skill ${denySkill.status}`)
    const denyMcp = await req(base, 'POST', `/orgs/${inviteOrg}/mcp-servers`, {
      token: invitedTok,
      body: { name: '不该成功', endpoint: 'https://x' },
    })
    assert(denyMcp.status === 403, `member mcp ${denyMcp.status}`)

    const emptyName = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: adminTok,
      body: { name: '   ' },
    })
    assert(emptyName.status === 400, `empty ${emptyName.status} ${emptyName.text}`)
    assert(String(emptyName.json.error).includes('要有名字'), 'empty name 文案')

    const noEndpoint = await req(base, 'POST', `/orgs/${inviteOrg}/mcp-servers`, {
      token: adminTok,
      body: { name: 'no-url', kind: 'HTTP' },
    })
    assert(noEndpoint.status === 400, `endpoint ${noEndpoint.status}`)
    assert(String(noEndpoint.json.error).includes('要有服务器地址'), 'endpoint 文案')

    const spa = await req(base, 'GET', '/skills')
    assert(spa.status === 200, `spa ${spa.status}`)
    assert(String(spa.text).includes('<!doctype html>') || String(spa.text).includes('Satuwork'), 'spa html')

    const delS = await req(base, 'DELETE', `/orgs/${inviteOrg}/skills/${skillId}`, { token: adminTok })
    assert(delS.status === 200 && delS.json.deleted === true && delS.json.id === skillId, 'delete skill')
    const goneS = await req(base, 'GET', `/orgs/${inviteOrg}/skills/${skillId}`, { token: adminTok })
    assert(goneS.status === 404, `gone skill ${goneS.status}`)
    assert(String(goneS.json.error).includes('没有这个 Skill'), '404 skill 文案')

    const delZ = await req(base, 'DELETE', `/orgs/${inviteOrg}/skills/${zipId}`, { token: adminTok })
    assert(delZ.status === 200 && delZ.json.deleted === true, 'delete zip skill')

    const delM = await req(base, 'DELETE', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, { token: adminTok })
    assert(delM.status === 200 && delM.json.deleted === true && delM.json.id === serverId, 'delete mcp')
    const goneM = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers/${serverId}`, { token: adminTok })
    assert(goneM.status === 404, `gone mcp ${goneM.status}`)
    assert(String(goneM.json.error).includes('没有这个 MCP 服务器'), '404 mcp 文案')
  })

  await test('公司 Bot 持久化 skills/mcps ids；未知 id 忽略；成员 PATCH 403', async () => {
    const login = await req(base, 'POST', '/auth/login', {
      body: { email: 'boss@invite.test', password: 'new-horse-10' },
    })
    assert(login.status === 200, `relogin ${login.status} ${login.text}`)
    const adminTok = login.json.token

    const skill = await req(base, 'POST', `/orgs/${inviteOrg}/skills`, {
      token: adminTok,
      body: { name: '挂载技能', body: '一步' },
    })
    assert(skill.status === 201, `skill ${skill.status} ${skill.text}`)
    const skillId = skill.json.skill.id
    const mcp = await req(base, 'POST', `/orgs/${inviteOrg}/mcp-servers`, {
      token: adminTok,
      body: {
        name: '挂载mcp',
        kind: 'HTTP',
        endpoint: 'http://127.0.0.1:9',
        token: 'bind-secret-token',
        env: { API_KEY: 'mcp-env-runtime-secret' },
      },
    })
    assert(mcp.status === 201, `mcp ${mcp.status} ${mcp.text}`)
    const mcpId = mcp.json.server.id
    assert(!dumpHas(mcp.json, 'bind-secret-token'), 'create 泄漏 token')
    assert(!dumpHas(mcp.json, 'mcp-env-runtime-secret'), 'create 泄漏 env')

    const cat = await req(base, 'GET', '/catalog/mcp', { token: adminTok })
    assert(cat.status === 200, `catalog mcp ${cat.status}`)
    assert(!dumpHas(cat.json, 'bind-secret-token'), 'catalog/mcp 泄漏 token')
    for (const item of cat.json.items || []) {
      assert(!item.definition || item.definition.token == null, 'definition.token')
    }

    const created = await req(base, 'POST', `/orgs/${inviteOrg}/bots`, {
      token: adminTok,
      body: { name: '带挂载', skills: [skillId, 'no-such'], mcps: [mcpId, 'nope'] },
    })
    assert(created.status === 201, `create ${created.status} ${created.text}`)
    assert(JSON.stringify(created.json.bot.skills) === JSON.stringify([skillId]), `skills ${JSON.stringify(created.json.bot.skills)}`)
    assert(JSON.stringify(created.json.bot.mcps) === JSON.stringify([mcpId]), `mcps ${JSON.stringify(created.json.bot.mcps)}`)
    assert(created.json.bot.skillCount === 1, 'skillCount')
    assert(created.json.bot.mcpCount === 1, 'mcpCount')
    const id = created.json.bot.id

    const got = await req(base, 'GET', `/orgs/${inviteOrg}/bots/${id}`, { token: adminTok })
    assert(got.status === 200, `get ${got.status}`)
    assert(got.json.bot.skills[0] === skillId && got.json.bot.mcps[0] === mcpId, 'get ids')

    const rt = await req(base, 'GET', '/runtime/catalog', { token: adminTok })
    assert(rt.status === 200, `runtime ${rt.status} ${rt.text}`)
    const srv = (rt.json.servers || []).find((s) => s.id === mcpId)
    assert(srv && srv.token === 'bind-secret-token', 'runtime 应带 token')
    assert(srv.env && srv.env.API_KEY === 'mcp-env-runtime-secret', 'runtime 应带 env')
    const orgMcp = await req(base, 'GET', `/orgs/${inviteOrg}/mcp-servers/${mcpId}`, { token: adminTok })
    assert(!dumpHas(orgMcp.json, 'bind-secret-token'), 'org get 泄漏 token')
    assert(!dumpHas(orgMcp.json, 'mcp-env-runtime-secret'), 'org get 泄漏 env')
    const meAdmin = await req(base, 'GET', '/me', { token: adminTok })
    const platAcc = await req(base, 'GET', `/platform/accounts/${meAdmin.json.account.id}`, { token: ownerTok })
    const satRt = await req(base, 'GET', '/runtime/catalog', { token: platAcc.json.accessToken })
    assert(satRt.status === 200, `sat runtime ${satRt.status}`)
    const satSrv = (satRt.json.servers || []).find((x) => x.id === mcpId)
    assert(satSrv && satSrv.token === 'bind-secret-token' && satSrv.env && satSrv.env.API_KEY === 'mcp-env-runtime-secret', 'sat runtime env')

    const patched = await req(base, 'PATCH', `/orgs/${inviteOrg}/bots/${id}`, {
      token: adminTok,
      body: { skills: [], mcps: [mcpId] },
    })
    assert(patched.status === 200, `patch ${patched.status} ${patched.text}`)
    assert(Array.isArray(patched.json.bot.skills) && patched.json.bot.skills.length === 0, 'cleared skills')
    assert(patched.json.bot.skillCount === 0, 'skillCount 0')
    assert(patched.json.bot.mcpCount === 1, 'mcpCount stays')

    const deny = await req(base, 'PATCH', `/orgs/${inviteOrg}/bots/${id}`, {
      token: invitedTok,
      body: { skills: [skillId] },
    })
    assert(deny.status === 403, `member patch ${deny.status}`)

    const opts = await req(base, 'GET', `/orgs/${inviteOrg}/bots/options`, { token: adminTok })
    assert(opts.status === 200, `options ${opts.status}`)
    assert(opts.json.skills.some((s) => s.id === skillId && s.name === '挂载技能'), 'options skills')
    assert(opts.json.mcps.some((s) => s.id === mcpId && s.name === '挂载mcp'), 'options mcps')
  })

  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 400))
  try {
    child.kill('SIGKILL')
  } catch {}
}

async function runBot() {
  log('\n# bot')
  rmSync(BOT_HOME, { recursive: true, force: true })
  const base = `http://127.0.0.1:${BOT_PORT}`
  const child = start('bot', ['--import', 'tsx', join(botRoot, 'e2e-boot.mjs')], {
    cwd: botRoot,
    env: {
      SATUWORK_HOME: BOT_HOME,
      SATUWORK_PORT: String(BOT_PORT),
      GATEWAY_MACHINE_TOKEN: MACHINE_TOK,
      // 本机套件：显式关掉 Gateway，避免继承环境里的 GATEWAY_URL 而不种 default。
      GATEWAY_URL: '',
      GATEWAY_TOKEN: '',
      GATEWAY_API_KEY: '',
      SATUWORK_BOT_ID: '',
      // 空 key 不删：套件不能因为没配模型就整组失败，但进程环境保持原样。
    },
  })
  await waitHttp(base + '/api/health', { timeout: 45000 })
  assert(!child._exited, 'bot 启动后就退出了')

  let cookie
  let botId
  let sessionId

  await test('未登录 /api/bots → 401（不跳过鉴权）', async () => {
    const r = await req(base, 'GET', '/api/bots')
    assert(r.status === 401, `unauth ${r.status} ${r.text}`)
  })

  await test('GET / → JSON 404，不是 HTML SPA', async () => {
    const r = await req(base, 'GET', '/')
    assert(r.status === 404, `root ${r.status} ${r.text}`)
    assert(r.json && r.json.error, `not json ${String(r.text).slice(0, 120)}`)
    assert(!String(r.text).toLowerCase().includes('<html'), '仍发 html')
  })

  await test('机器凭证 GET /api/bots 不走 cookie', async () => {
    const r = await req(base, 'GET', '/api/bots', { token: MACHINE_TOK })
    assert(r.status === 200, `machine ${r.status} ${r.text}`)
    assert(Array.isArray(r.json.bots) && r.json.bots.length >= 1, 'empty')
  })

  await test('POST /api/auth/setup 拿会话 cookie', async () => {
    const state = await req(base, 'GET', '/api/auth/state')
    assert(state.status === 200 && state.json.needsSetup === true, 'needsSetup')
    const r = await req(base, 'POST', '/api/auth/setup', {
      body: { email: 'admin@bot.test', name: '管理员', password: 'correct-horse' },
    })
    assert(r.status === 200, `setup ${r.status} ${r.text}`)
    assert(r.json.user.role === 'admin', 'admin')
    cookie = cookieOf(r)
  })

  await test('GET /api/bots 无 mock:true，默认 bot 带 provider+model', async () => {
    const r = await req(base, 'GET', '/api/bots', { cookie })
    assert(r.status === 200, `bots ${r.status} ${r.text}`)
    assert(r.json.mock !== true, '顶层 mock:true')
    assert(Array.isArray(r.json.bots) && r.json.bots.length >= 1, '空名册')
    assert(
      r.json.bots.every((a) => a.mock !== true),
      '条目带 mock:true',
    )
    const def = r.json.bots.find((a) => a.id === 'default') || r.json.bots[0]
    assert(def && def.id, '没有默认 bot')
    assert(def.provider === 'deepseek', `provider ${def.provider}`)
    assert(typeof def.model === 'string' && def.model, '缺 model')
    botId = def.id
  })

  await test('POST /api/bots → 410（Bot 配置在 Gateway）', async () => {
    const r = await req(base, 'POST', '/api/bots', {
      cookie,
      body: { name: '测试助理', description: 'e2e', prompt: '只说好' },
    })
    assert(r.status === 410 || r.status === 404, `create ${r.status} ${r.text}`)
    if (r.status === 410) assert(String(r.json.error || r.text).includes('Gateway'), '410 文案')
  })

  await test('GET /api/bots/:id/session 二次调用同一 sessionId', async () => {
    const a = await req(base, 'GET', `/api/bots/${botId}/session`, { cookie })
    assert(a.status === 200, `session1 ${a.status} ${a.text}`)
    assert(typeof a.json.sessionId === 'string' && a.json.sessionId, 'sessionId')
    const b = await req(base, 'GET', `/api/bots/${botId}/session`, { cookie })
    assert(b.status === 200, `session2 ${b.status}`)
    assert(b.json.sessionId === a.json.sessionId, 'sessionId 变了')
    sessionId = a.json.sessionId
  })

  await test('POST /api/sessions 缺 botId → 400', async () => {
    const r = await req(base, 'POST', '/api/sessions', { cookie, body: { title: '无主' } })
    assert(r.status === 400, `sessions ${r.status} ${r.text}`)
  })

  await test('发消息：无 Gateway 密钥也不准把进程打挂；JSONL 根有 botId+origin', async () => {
    const r = await req(base, 'POST', `/api/sessions/${sessionId}/messages`, {
      cookie,
      body: { text: 'ping' },
    })
    assert(r.status >= 200 && r.status < 500, `message ${r.status} ${r.text}`)
    assert(r.status === 200 || (r.status >= 400 && r.status < 500), `意外状态 ${r.status}`)
    if (r.status === 200) {
      assert(r.json.accepted === true || r.json.steered === true, '既没 accepted 也没 steered')
    }
    await new Promise((x) => setTimeout(x, 800))
    assert(!child._exited, `发消息后进程退出 code=${child._exited?.code} sig=${child._exited?.sig}`)
    const health = await req(base, 'GET', '/api/health')
    assert(health.status === 200 && health.json.ok === true, 'health 挂了')

    const file = join(BOT_HOME, 'sessions', `${sessionId}.jsonl`)
    assert(existsSync(file), `没有 JSONL ${file}`)
    const first = readFileSync(file, 'utf8').split('\n').find((l) => l.trim())
    const ev = JSON.parse(first)
    assert(ev.type === 'session', `首条是 ${ev.type}`)
    assert(ev.data.botId === botId, `botId ${ev.data.botId}`)
    assert(ev.data.origin, '缺 origin')
    skips.push('模型回复：bot 不持有上游 key，只断言接口收了、进程还在、JSONL 根字段在')
  })

  await test('GET /api/billing → 404（账单已挪到 Gateway）', async () => {
    const r = await req(base, 'GET', '/api/billing', { cookie })
    assert(r.status === 404 || r.status === 410, `billing ${r.status} ${r.text}`)
  })

  await test('GET /api/usage → 404（用量统计已挪到 Gateway）', async () => {
    const r = await req(base, 'GET', '/api/usage', { cookie })
    assert(r.status === 404 || r.status === 410, `usage ${r.status} ${r.text}`)
  })

  await test('GET /api/skills → 404（Skill 配置在 Gateway）', async () => {
    const r = await req(base, 'GET', '/api/skills', { cookie })
    assert(r.status === 404 || r.status === 410, `skills ${r.status} ${r.text}`)
  })

  await test('GET /api/accounts → 404（账号管理在 Gateway）', async () => {
    const r = await req(base, 'GET', '/api/accounts', { cookie })
    assert(r.status === 404 || r.status === 410, `accounts ${r.status} ${r.text}`)
  })

  await test('create+session 后 JSONL 首条是 version 3 且带 botId', async () => {
    const file = join(BOT_HOME, 'sessions', `${sessionId}.jsonl`)
    const first = readFileSync(file, 'utf8').split('\n').find((l) => l.trim())
    const ev = JSON.parse(first)
    assert(ev.type === 'session', '首条不是 session')
    assert(ev.data.version === 3, `version=${ev.data.version}`)
    assert(ev.data.botId === botId, 'botId')
  })

  await test('GET /internal/sessions/:id 机器凭证；错票 404 不暴露', async () => {
    const none = await req(base, 'GET', `/internal/sessions/${sessionId}`)
    assert(none.status === 404, `no token ${none.status} ${none.text}`)
    const bad = await req(base, 'GET', `/internal/sessions/${sessionId}`, { token: 'wrong-token' })
    assert(bad.status === 404, `bad token ${bad.status}`)
    const ok = await req(base, 'GET', `/internal/sessions/${sessionId}`, { token: MACHINE_TOK })
    assert(ok.status === 200, `ok ${ok.status} ${ok.text}`)
    assert(Array.isArray(ok.json.events) && ok.json.events[0]?.type === 'session', 'events')
    const miss = await req(base, 'GET', '/internal/sessions/s-no-such', { token: MACHINE_TOK })
    assert(miss.status === 404, `missing ${miss.status}`)
  })

  await test('未登录 GET /api/runtime/status → 401', async () => {
    const r = await req(base, 'GET', '/api/runtime/status')
    assert(r.status === 401, `unauth status ${r.status} ${r.text}`)
  })

  await test('本机无 GATEWAY_URL 仍有 default bot', async () => {
    const r = await req(base, 'GET', '/api/bots', { cookie })
    assert(r.status === 200, `bots ${r.status} ${r.text}`)
    assert((r.json.bots || []).some((b) => b.id === 'default'), '缺 default')
  })

  child.kill('SIGTERM')
  await new Promise((r) => setTimeout(r, 400))
  try {
    child.kill('SIGKILL')
  } catch {}
}

async function main() {
  process.on('SIGINT', () => {
    killAll()
    process.exit(130)
  })
  process.on('SIGTERM', () => {
    killAll()
    process.exit(143)
  })
  try {
    await runGateway()
    await runBot()
    await runRuntimePath({
      root,
      gwRoot,
      botRoot,
      test,
      req,
      start,
      waitHttp,
      cookieOf,
      assert,
      log,
    })
    await runGatewayChat({
      gwRoot,
      botRoot,
      test,
      req,
      start,
      waitHttp,
      assert,
      log,
      treeHas,
    })
    await runMachineDeploy({
      gwRoot,
      test,
      req,
      start,
      waitHttp,
      assert,
      log,
    })
  } finally {
    killAll()
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
    try {
      rmSync(BOT_HOME, { recursive: true, force: true })
    } catch {}
  }

  log('')
  log(`# ${passed} passed, ${failed} failed`)
  if (skips.length) {
    for (const s of skips) log(`# skip  ${s}`)
  }
  if (failed) process.exit(1)
  log('E2E OK')
}

main().catch((e) => {
  console.error(e.stack || e.message)
  killAll()
  process.exit(1)
})
