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

const child = spawn(
  process.execPath,
  ['--import', 'tsx', join(root, 'src/index.ts')],
  {
    cwd: root,
    env: {
      ...process.env,
      SATUWORK_GATEWAY_HOME: home,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      GATEWAY_MACHINE_TOKEN: machineTok,
      GATEWAY_PLATFORM_TOKEN: platformTok,
      GATEWAY_ACCESS_HOST: 'satuwork.com',
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

  const planUp = await req('PUT', `/orgs/${orgId}/plan`, { token, body: { seats: 3 }, expect: 200 })
  assert(planUp.json.seats === 3, 'plan 3')

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

  const mach = await req('POST', `/orgs/${orgId}/machine`, {
    token,
    body: { host: '10.0.0.1' },
    expect: 201,
  })
  assert(mach.json.company.accessUrl === 'https://acme.satuwork.com', 'access url')
  assert(mach.json.machine.companyId === orgId, 'machine assigned')
  const machineId = mach.json.machine.id

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

  const cred = await req('POST', `/orgs/${orgId}/credentials`, {
    token,
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

  const jwtPayload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
  assert(jwtPayload.accountId === adminId && jwtPayload.companyId === orgId, 'jwt claims')
  assert(jwtPayload.role === 'admin', 'jwt role')
  assert(!JSON.stringify(jwtPayload).toLowerCase().includes('secret'), 'jwt no secret')
  assert(!JSON.stringify(jwtPayload).includes('sk-'), 'jwt no key')

  const sess = await req('GET', `/orgs/${orgId}/sessions`, { token, expect: 200 })
  assert(Array.isArray(sess.json.sessions) && sess.json.sessions.length === 0, 'empty sessions')
  const pull = await req('GET', `/orgs/${orgId}/sessions/abc`, { token, expect: 501 })
  assert(String(pull.json.error).includes('machine pull not implemented'), '501 pull')

  const audit = await req('GET', `/orgs/${orgId}/audit`, { token, expect: 200 })
  assert(audit.json.events.some((e) => e.action === 'auth.register'), 'audit register')
  assert(audit.json.events.some((e) => e.action === 'auth.login'), 'audit login')
  assert(audit.json.events.some((e) => e.action === 'machine.assign'), 'audit machine')

  await req('POST', `/internal/machines/${machineId}/heartbeat`, { expect: 401 })
  const hb = await req('POST', `/internal/machines/${machineId}/heartbeat`, {
    token: machineTok,
    expect: 200,
  })
  assert(hb.json.machine.lastHeartbeatAt > 0, 'heartbeat')

  await req('POST', `/internal/instances/${adminId}/ready`, { token: machineTok, expect: 501 })
  await req('POST', '/internal/sessions/index', { token: machineTok, expect: 501 })
  await req('POST', '/internal/usage', { token: machineTok, expect: 501 })

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
