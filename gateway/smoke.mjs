import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'satuwork-gw-'))
const port = 3099
const base = `http://127.0.0.1:${port}`
const machineTok = 'test-machine'
const platformTok = 'test-platform'
const ownerEmail = 'owner@satuwork.test'
const ownerPassword = 'test-owner-smoke'

const child = spawn(
  process.execPath,
  ['--import', 'tsx', join(root, 'src/index.ts')],
  {
    cwd: root,
    env: {
      ...process.env,
      SATUWORK_GATEWAY_HOME: home,
      GATEWAY_DATABASE_URL: process.env.GATEWAY_DATABASE_URL || 'postgres://satuwork:satuwork@127.0.0.1:5434/satuwork',
      GATEWAY_PG_SCHEMA: 'smoke',
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      GATEWAY_MACHINE_TOKEN: machineTok,
      GATEWAY_PLATFORM_TOKEN: platformTok,
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      // 席位、供应商、机器地址都归 owner，冒烟得有这个人才走得通。
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: ownerEmail,
      GATEWAY_OWNER_PASSWORD: ownerPassword,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
)

let out = ''
child.stdout.on('data', (d) => {
  out += d.toString()
  process.stdout.write(d)
})
child.stderr.on('data', (d) => {
  out += d.toString()
  process.stderr.write(d)
})

function fail(msg) {
  console.error('SMOKE FAIL:', msg)
  child.kill('SIGTERM')
  setTimeout(() => child.kill('SIGKILL'), 500)
  setTimeout(() => process.exit(1), 800)
}

async function waitHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(base + '/health')
      if (r.ok) return
    } catch {}
    await new Promise((x) => setTimeout(x, 100))
  }
  throw new Error('gateway did not become healthy')
}

async function req(method, path, { token, body, expect } = {}) {
  const headers = { 'content-type': 'application/json' }
  if (token) headers.authorization = 'Bearer ' + token
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
  if (expect != null && r.status !== expect) {
    throw new Error(`${method} ${path} expected ${expect} got ${r.status} ${text}`)
  }
  return { status: r.status, json }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function run() {
  await waitHealth()

  const health = await req('GET', '/health', { expect: 200 })
  assert(health.json.ok === true, 'health')

  const jwks = await req('GET', '/jwks', { expect: 200 })
  assert(Array.isArray(jwks.json.keys) && jwks.json.keys[0].kty === 'RSA', 'jwks')
  await req('GET', '/.well-known/jwks.json', { expect: 200 })

  await req('POST', '/auth/register', {
    body: { email: 'a@x.com', password: 'short', companyName: 'Acme', slug: 'acme' },
    expect: 400,
  })

  const reg = await req('POST', '/auth/register', {
    body: {
      email: 'admin@acme.test',
      password: 'correct-horse',
      companyName: 'Acme',
      slug: 'acme',
      seats: 2,
    },
    expect: 201,
  })
  const token = reg.json.token
  const orgId = reg.json.company.id
  const adminId = reg.json.account.id
  assert(typeof token === 'string' && token.split('.').length === 3, 'jwt')
  assert(reg.json.account.role === 'admin', 'register admin')
  assert(!JSON.stringify(reg.json).includes('passwordHash'), 'no hash in register')
  assert(!JSON.stringify(reg.json).includes('scrypt$'), 'no scrypt in register')

  await req('POST', '/auth/register', {
    body: {
      email: 'other@acme.test',
      password: 'correct-horse',
      companyName: 'Acme2',
      slug: 'acme',
      seats: 1,
    },
    expect: 409,
  })

  const login = await req('POST', '/auth/login', {
    body: { email: 'admin@acme.test', password: 'correct-horse' },
    expect: 200,
  })
  assert(typeof login.json.token === 'string', 'login token')

  await req('POST', '/auth/login', {
    body: { email: 'admin@acme.test', password: 'wrong-password-x' },
    expect: 401,
  })

  const me = await req('GET', '/me', { token, expect: 200 })
  assert(me.json.company.id === orgId, 'me company')
  assert(me.json.plan.seats === 2 && me.json.plan.used === 1, 'me plan')
  assert(me.json.company.accessUrl == null, 'no url before machine')

  const acc2 = await req('POST', `/orgs/${orgId}/accounts`, {
    token,
    body: { email: 'member@acme.test', password: 'correct-horse', role: 'member' },
    expect: 201,
  })
  const memberId = acc2.json.account.id
  assert(acc2.json.account.role === 'member', 'member role')

  const full = await req('POST', `/orgs/${orgId}/accounts`, {
    token,
    body: { email: 'third@acme.test', password: 'correct-horse' },
    expect: 409,
  })
  assert(full.json.error === '席位已满', 'seat full')
  assert(full.json.seats === 2 && full.json.used === 2, 'seat numbers')

  // 席位由 owner 分配：公司管理员那条路是明着 403 的。
  await req('PUT', `/orgs/${orgId}/plan`, { token, body: { seats: 3 }, expect: 403 })

  const ownerLogin = await req('POST', '/auth/login', {
    body: { email: ownerEmail, password: ownerPassword },
    expect: 200,
  })
  const ownerTok = ownerLogin.json.token
  assert(ownerLogin.json.account.role === 'owner', 'owner role')
  assert(ownerLogin.json.company === null, 'owner 不属于公司')

  const planUp = await req('PUT', `/platform/orgs/${orgId}/plan`, {
    token: ownerTok,
    body: { seats: 3 },
    expect: 200,
  })
  assert(planUp.json.seats === 3, 'plan 3')
  await req('PUT', `/platform/orgs/${orgId}/plan`, { token, body: { seats: 4 }, expect: 403 })

  const acc3 = await req('POST', `/orgs/${orgId}/accounts`, {
    token,
    body: { email: 'third@acme.test', password: 'correct-horse' },
    expect: 201,
  })

  const memberLogin = await req('POST', '/auth/login', {
    body: { email: 'member@acme.test', password: 'correct-horse' },
    expect: 200,
  })
  const memberTok = memberLogin.json.token

  await req('POST', `/orgs/${orgId}/accounts`, {
    token: memberTok,
    body: { email: 'nope@acme.test', password: 'correct-horse' },
    expect: 403,
  })

  // host 是平台的事，管理员写不了——写了要被 403 挡下。
  await req('POST', `/orgs/${orgId}/machine`, {
    token,
    body: { host: '10.0.0.1' },
    expect: 403,
  })
  // 带路径的地址谁都不收：这个值 Gateway 会带着 smt_ 去 fetch。
  await req('POST', '/internal/machines', {
    token: machineTok,
    body: { host: 'http://10.0.0.1/internal/sessions/x' },
    expect: 400,
  })

  // 机器自己用引导票登记，拿到只属于它的 smt_；管理员只负责认领。
  const machReg = await req('POST', '/internal/machines', {
    token: machineTok,
    body: { host: '10.0.0.1:3200' },
    expect: 201,
  })
  const machineId = machReg.json.machine.id
  const smt = machReg.json.machine.token
  assert(typeof smt === 'string' && smt.startsWith('smt_'), 'smt_')
  assert(machReg.json.machine.host === '10.0.0.1:3200', `host 原样保留 ${machReg.json.machine.host}`)

  const mach = await req('POST', `/orgs/${orgId}/machine`, {
    token,
    body: { id: machineId },
    expect: 201,
  })
  assert(mach.json.company.accessUrl === 'https://acme.satuwork.com', 'access url')
  // publicMachine 不带 companyId，绑定关系从公司这边看。
  assert(mach.json.company.machineId === machineId, 'machine assigned')
  assert(!JSON.stringify(mach.json).includes('smt_'), '认领响应泄漏 smt_')

  const me2 = await req('GET', '/me', { token, expect: 200 })
  assert(me2.json.company.accessUrl === 'https://acme.satuwork.com', 'me access url')

  const bot = await req('POST', `/orgs/${orgId}/bots`, {
    token,
    body: { name: '公司助手' },
    expect: 201,
  })
  assert(bot.json.bot.origin === 'company', 'company bot')
  await req('POST', `/orgs/${orgId}/bots`, {
    token: memberTok,
    body: { name: 'nope' },
    expect: 403,
  })

  const catBots = await req('GET', '/catalog/bots', { token, expect: 200 })
  assert(catBots.json.items.length === 1, 'visible company bot')

  const gModel = await req('POST', '/catalog/models', {
    token: platformTok,
    body: { name: 'demo-model', definition: { provider: 'demo' } },
    expect: 201,
  })
  assert(gModel.json.item.scope === 'global', 'global model')
  await req('POST', '/catalog/models', {
    token,
    body: { name: 'should-fail' },
    expect: 401,
  })

  const catModels = await req('GET', '/catalog/models', { token: memberTok, expect: 200 })
  assert(catModels.json.items.some((i) => i.scope === 'global'), 'member sees global')

  // 供应商密钥归 owner：公司那条路只读，写一律 403。
  await req('POST', `/orgs/${orgId}/credentials`, {
    token,
    body: { provider: 'deepseek', secret: 'sk-should-never-leak' },
    expect: 403,
  })

  const cred = await req('POST', '/platform/credentials', {
    token: ownerTok,
    body: { provider: 'deepseek', secret: 'sk-should-never-leak' },
    expect: 201,
  })
  const credDump = JSON.stringify(cred.json)
  assert(cred.json.credential.configured === true, 'configured true')
  assert(!credDump.includes('sk-should-never-leak'), 'no secret in create')
  assert(!credDump.includes('"secret"'), 'no secret field')

  const creds = await req('GET', `/orgs/${orgId}/credentials`, { token, expect: 200 })
  const credsDump = JSON.stringify(creds.json)
  assert(!credsDump.includes('sk-should-never-leak'), 'no secret in list')
  assert(creds.json.credentials[0].configured === true, 'list configured')

  const platCreds = await req('GET', '/platform/credentials', { token: ownerTok, expect: 200 })
  assert(!JSON.stringify(platCreds.json).includes('sk-should-never-leak'), 'no secret in platform list')

  const jwtPayload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
  assert(jwtPayload.accountId === adminId && jwtPayload.companyId === orgId, 'jwt claims')
  assert(jwtPayload.role === 'admin', 'jwt role')
  assert(!JSON.stringify(jwtPayload).toLowerCase().includes('secret'), 'jwt no secret')
  assert(!JSON.stringify(jwtPayload).includes('sk-'), 'jwt no key')

  const sess = await req('GET', `/orgs/${orgId}/sessions`, { token, expect: 200 })
  assert(Array.isArray(sess.json.sessions) && sess.json.sessions.length === 0, 'empty sessions')
  const pull = await req('GET', `/orgs/${orgId}/sessions/abc`, { token, expect: 404 })
  assert(String(pull.json.error) === '会话不存在', `pull 404 文案 ${pull.json.error}`)

  const audit = await req('GET', `/orgs/${orgId}/audit`, { token, expect: 200 })
  assert(audit.json.events.some((e) => e.action === 'auth.register'), 'audit register')
  assert(audit.json.events.some((e) => e.action === 'auth.login'), 'audit login')
  assert(audit.json.events.some((e) => e.action === 'machine.assign'), 'audit machine')

  await req('POST', `/internal/machines/${machineId}/heartbeat`, { expect: 401 })
  const hb = await req('POST', `/internal/machines/${machineId}/heartbeat`, { token: smt, expect: 200 })
  assert(hb.json.machine.lastHeartbeatAt > 0, 'heartbeat')

  // 引导票只够登记机器；心跳、索引、用量、ready 都要每台机器自己的 smt_。
  await req('POST', `/internal/machines/${machineId}/heartbeat`, { token: machineTok, expect: 401 })
  await req('POST', `/internal/instances/${adminId}/ready`, {
    token: machineTok,
    body: { host: 'http://127.0.0.1:9', botId: 'b' },
    expect: 401,
  })
  await req('POST', '/internal/sessions/index', { token: machineTok, body: {}, expect: 401 })
  await req('POST', '/internal/usage', { token: machineTok, body: {}, expect: 401 })

  const idx = await req('POST', '/internal/sessions/index', {
    token: smt,
    body: {
      sessionId: 's-smoke',
      companyId: orgId,
      accountId: adminId,
      title: '冒烟会话',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    expect: 200,
  })
  assert(idx.json.session.sessionId === 's-smoke', 'session index')

  await req('POST', '/internal/usage', {
    token: smt,
    body: { accountId: adminId, provider: 'deepseek', model: 'demo', promptTokens: 3, completionTokens: 4 },
    expect: 200,
  })
  const usage = await req('GET', `/orgs/${orgId}/usage`, { token, expect: 200 })
  const tokenStat = (label) => Number(usage.json.stats.find((s) => s.label === label).value)
  assert(tokenStat('输入 Tokens') === 3, `输入 tokens ${tokenStat('输入 Tokens')}`)
  assert(tokenStat('输出 Tokens') === 4, `输出 tokens ${tokenStat('输出 Tokens')}`)

  // 没部署过的席位报 ready 是 404，不是默默收下。
  await req('POST', `/internal/instances/${adminId}/ready`, {
    token: smt,
    body: { host: 'http://127.0.0.1:9', botId: 'b' },
    expect: 404,
  })

  await req('GET', `/orgs/${orgId}/accounts`, { token, expect: 200 })
  await req('DELETE', `/orgs/${orgId}/accounts/${acc3.json.account.id}`, { token, expect: 200 })

  console.log('SMOKE OK')
}

async function main() {
  try {
    await run()
    child.kill("SIGTERM")
    await new Promise((r) => setTimeout(r, 400))
    try { child.kill("SIGKILL") } catch {}
    try { rmSync(home, { recursive: true, force: true }) } catch {}
    process.exit(0)
  } catch (e) {
    fail(e.stack || e.message)
  }
}
main()
  .catch((e) => fail(e.stack || e.message))
  .finally(() => {
    child.kill('SIGTERM')
    setTimeout(() => {
      child.kill('SIGKILL')
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {}
    }, 300)
  })
