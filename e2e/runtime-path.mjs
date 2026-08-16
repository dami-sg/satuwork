/**
 * Gateway 配置的 Skill / MCP / Bot 被实例加载并进入对话。
 * 自己的 home / 端口，不碰 live 3080，不碰 run.mjs 那套 /tmp/satuwork-e2e-gw。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { startMockMcp } from './mock-mcp.mjs'

const LIVE_GW_DB = '/workspace/satuwork/.data/gateway/gateway.db'

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function readLiveCreds() {
  if (!existsSync(LIVE_GW_DB)) return []
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(LIVE_GW_DB, { readOnly: true })
    try {
      return db.prepare('select provider, secret from platform_credentials').all().map((r) => ({
        provider: String(r.provider),
        secret: String(r.secret),
      }))
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

export async function runRuntimePath({ root, gwRoot, botRoot, test, req, start, waitHttp, cookieOf, assert, log }) {
  const GW_HOME = '/tmp/satuwork-e2e-runtime-gw'
  const BOT_HOME = '/tmp/satuwork-e2e-runtime-bot'
  const GW_PORT = 18180
  const BOT_PORT = 18182
  const MACHINE_TOK = 'e2e-runtime-machine'
  const PLATFORM_TOK = 'e2e-runtime-platform'
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  const botBase = `http://127.0.0.1:${BOT_PORT}`

  log('\n# runtime-path')
  rmSync(GW_HOME, { recursive: true, force: true })
  rmSync(BOT_HOME, { recursive: true, force: true })

  const gw = start('runtime-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_MACHINE_TOKEN: MACHINE_TOK,
      GATEWAY_PLATFORM_TOKEN: PLATFORM_TOK,
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@runtime.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-runtime',
      SATUWORK_DEPLOY_STUB: '1',
      SATUWORK_BOT_SRC: '/tmp/satuwork-e2e-missing-bot-src',
    },
  })
  await waitHttp(gwBase + '/health')

  let mock
  let botChild
  try {
    await test('Gateway 配置的 Skill/MCP/Bot 被实例加载并进入对话', async () => {
      const reg = await req(gwBase, 'POST', '/auth/register', {
        body: {
          email: 'admin@runtime.test',
          password: 'correct-horse',
          companyName: 'RuntimeCo',
          slug: 'runtimeco',
          seats: 2,
        },
      })
      assert(reg.status === 201, `register ${reg.status} ${reg.text}`)
      const adminTok = reg.json.token
      const orgId = reg.json.company.id

      const ownerLogin = await req(gwBase, 'POST', '/auth/login', {
        body: { email: 'owner@runtime.test', password: 'test-owner-runtime' },
      })
      assert(ownerLogin.status === 200, `owner ${ownerLogin.status} ${ownerLogin.text}`)
      const ownerTok = ownerLogin.json.token
      const adminId = reg.json.account.id
      const seat = await req(gwBase, 'GET', `/platform/accounts/${adminId}`, { token: ownerTok })
      assert(seat.status === 200, `seat secrets ${seat.status} ${seat.text}`)
      const seatAccess = seat.json.accessToken
      const seatApiKey = seat.json.apiKey
      assert(typeof seatAccess === 'string' && seatAccess.startsWith('sat_'), 'access token')
      assert(typeof seatApiKey === 'string' && seatApiKey.startsWith('sk_sw_'), 'api key')
      const putMach = await req(gwBase, 'PUT', `/platform/orgs/${orgId}/machine`, {
        token: ownerTok,
        body: { sshHost: '127.0.0.1', sshPort: 22, sshUser: 'debian', sshAuth: 'password', sshSecret: 'e2e-ssh' },
      })
      assert(putMach.status === 200, `put machine ${putMach.status} ${putMach.text}`)
      const platMach = await req(gwBase, 'GET', `/platform/orgs/${orgId}/machine`, { token: ownerTok })
      const machineTok = platMach.json.machine.token
      assert(typeof machineTok === 'string' && machineTok.startsWith('smt_'), 'smt_')
      const creds = await readLiveCreds()
      for (const c of creds) {
        const put = await req(gwBase, 'POST', '/platform/credentials', {
          token: ownerTok,
          body: { provider: c.provider, secret: c.secret },
        })
        assert(put.status === 201 || put.status === 200, `copy cred ${c.provider} ${put.status}`)
        assert(!JSON.stringify(put.json).includes(c.secret), 'copy 泄漏 secret')
      }
      const stubLlm = creds.length === 0

      const skill = await req(gwBase, 'POST', `/orgs/${orgId}/skills`, {
        token: adminTok,
        body: {
          name: 'e2e-skill-marker',
          body: 'SKILL-OK-9C2E\n\n- 第一步确认标记\n- 第二步按步骤执行',
          tags: ['自动化'],
        },
      })
      assert(skill.status === 201, `skill ${skill.status} ${skill.text}`)
      const skillId = skill.json.skill.id
      assert(skill.json.skill.body.includes('SKILL-OK-9C2E'), 'skill body')

      mock = await startMockMcp()
      const mcp = await req(gwBase, 'POST', `/orgs/${orgId}/mcp-servers`, {
        token: adminTok,
        body: {
          name: 'e2e-mcp',
          kind: 'HTTP',
          endpoint: `http://127.0.0.1:${mock.port}`,
          perm: '只读',
        },
      })
      assert(mcp.status === 201, `mcp ${mcp.status} ${mcp.text}`)
      const mcpId = mcp.json.server.id
      assert(!Object.prototype.hasOwnProperty.call(mcp.json.server, 'token'), 'admin 回了 token')

      const catMcp = await req(gwBase, 'GET', '/catalog/mcp', { token: adminTok })
      assert(catMcp.status === 200, `catalog mcp ${catMcp.status}`)
      for (const item of catMcp.json.items || []) {
        assert(!item.definition || item.definition.token == null, 'catalog/mcp 泄漏 token 字段')
      }

      const prompt = '你是 Runtime 探针助理。只回答 ping。PROMPT-OK-RUNTIME'
      const created = await req(gwBase, 'POST', `/orgs/${orgId}/bots`, {
        token: adminTok,
        body: {
          name: 'Runtime 探针',
          description: 'e2e runtime path',
          prompt,
          enabled: true,
          skills: [skillId, 'no-such-skill'],
          mcps: [mcpId, 'no-such-mcp'],
        },
      })
      assert(created.status === 201, `bot ${created.status} ${created.text}`)
      assert(created.json.bot.skills.length === 1 && created.json.bot.skills[0] === skillId, 'skills ids')
      assert(created.json.bot.mcps.length === 1 && created.json.bot.mcps[0] === mcpId, 'mcps ids')
      assert(created.json.bot.skillCount === 1 && created.json.bot.mcpCount === 1, 'counts')
      const remoteBotId = created.json.bot.id

      const rt = await req(gwBase, 'GET', '/runtime/catalog', { token: adminTok })
      assert(rt.status === 200, `runtime catalog ${rt.status} ${rt.text}`)
      assert(rt.json.bots.some((b) => b.id === remoteBotId), 'runtime bots')
      assert(rt.json.skills.some((s) => s.id === skillId && String(s.body).includes('SKILL-OK-9C2E')), 'runtime skills')
      const srv = rt.json.servers.find((s) => s.id === mcpId)
      assert(srv, 'runtime server')
      assert(typeof srv.token === 'string', 'runtime token field')

      const unauth = await req(gwBase, 'GET', '/runtime/catalog')
      assert(unauth.status === 401, `runtime unauth ${unauth.status}`)

      const pub = await req(gwBase, 'POST', '/platform/bot-releases', {
        token: ownerTok,
        body: { version: '0.1.0', note: 'e2e-runtime' },
      })
      assert(pub.status === 200, `publish ${pub.status} ${pub.text}`)
      const dep = await req(gwBase, 'POST', '/runtime/deploy', {
        token: adminTok,
        body: { botId: remoteBotId },
      })
      assert(dep.status === 200, `stub deploy ${dep.status} ${dep.text}`)

      botChild = start('runtime-bot', ['--import', 'tsx', join(botRoot, 'e2e-boot.mjs')], {
        cwd: botRoot,
        env: {
          SATUWORK_HOME: BOT_HOME,
          SATUWORK_PORT: String(BOT_PORT),
          SATUWORK_BOT_ID: remoteBotId,
          GATEWAY_URL: gwBase,
          GATEWAY_TOKEN: seatAccess,
          GATEWAY_API_KEY: seatApiKey,
          GATEWAY_MACHINE_TOKEN: machineTok,
          ...(stubLlm ? { E2E_STUB_LLM: '1' } : {}),
        },
      })
      await waitHttp(botBase + '/api/health', { timeout: 45000 })
      assert(!botChild._exited, 'bot 启动后就退出了')

      const unauthStatus = await req(botBase, 'GET', '/api/runtime/status')
      assert(unauthStatus.status === 401, `unauth status ${unauthStatus.status} ${unauthStatus.text}`)

      const deadline = Date.now() + 20000
      let status
      let last
      while (Date.now() < deadline) {
        const r = await req(botBase, 'GET', '/api/runtime/status', { token: machineTok })
        last = r
        if (r.status === 200) {
          status = r.json
          const hasBot = (status.bots || []).some((b) => b.remoteId === remoteBotId || b.id === remoteBotId)
          const hasSkill = (status.skills || []).some((s) => s.id === skillId)
          const mcpOk = (status.servers || []).some(
            (s) => s.id === mcpId && s.connected && (s.tools || []).some((t) => String(t).includes('secret_marker')),
          )
          if (hasBot && hasSkill && mcpOk) break
        }
        status = null
        await sleep(200)
      }
      assert(status, `runtime/status 未就绪 ${JSON.stringify(last?.json || last?.text)}`)
      assert(
        (status.bots || []).some((b) => b.origin === 'company' && (b.remoteId === remoteBotId || b.id === remoteBotId)),
        `bots ${JSON.stringify(status.bots)}`,
      )
      assert(
        (status.servers || []).some((s) => s.connected && (s.tools || []).some((t) => String(t).includes('secret_marker'))),
        `servers ${JSON.stringify(status.servers)}`,
      )

      const setup = await req(botBase, 'POST', '/api/auth/setup', {
        body: { email: 'admin@bot.test', name: '管理员', password: 'correct-horse' },
      })
      assert(setup.status === 200, `setup ${setup.status} ${setup.text}`)
      const cookie = cookieOf(setup)

      const list = await req(botBase, 'GET', '/api/bots', { cookie })
      assert(list.status === 200, `bots ${list.status} ${list.text}`)
      const bots = list.json.bots || []
      assert(bots.length === 1, `Gateway 钉住的名册应只有 1 颗，实际 ${bots.length} ${JSON.stringify(bots)}`)
      assert(!bots.some((b) => b.id === 'default'), 'Gateway 钉住的实例不该有 default')
      const pinned = bots.find((b) => b.id === remoteBotId || b.remoteId === remoteBotId)
      assert(pinned, `名册未见公司 bot ${JSON.stringify(bots)}`)
      assert(pinned.id === remoteBotId, `id ${pinned.id} != SATUWORK_BOT_ID ${remoteBotId}`)
      assert(pinned.origin === 'company', `origin ${pinned.origin}`)
      assert(pinned.remoteId === remoteBotId, `remoteId ${pinned.remoteId}`)
      assert(pinned.prompt === prompt, 'prompt mismatch')

      const sess = await req(botBase, 'GET', `/api/bots/${pinned.id}/session`, { cookie })
      assert(sess.status === 200, `session ${sess.status} ${sess.text}`)
      const sessionId = sess.json.sessionId
      assert(sessionId, 'sessionId')

      const msg = await req(botBase, 'POST', `/api/sessions/${sessionId}/messages`, {
        cookie,
        body: { text: 'ping' },
      })
      assert(msg.status === 200, `message ${msg.status} ${msg.text}`)
      assert(msg.json.accepted === true || msg.json.steered === true, 'accepted')

      const file = join(BOT_HOME, 'sessions', `${sessionId}.jsonl`)
      const jsonlDeadline = Date.now() + 20000
      let header
      let lines = []
      while (Date.now() < jsonlDeadline) {
        if (existsSync(file)) {
          lines = readFileSync(file, 'utf8')
            .split('\n')
            .filter((l) => l.trim())
            .map((l) => {
              try {
                return JSON.parse(l)
              } catch {
                return null
              }
            })
            .filter(Boolean)
          header = lines.find((e) => e.type === 'request/header')
          if (header) break
        }
        await sleep(150)
      }
      assert(header, `没有 request/header：${lines.map((e) => e.type).join(',')}`)
      const system = String(header.data?.system || '')
      assert(system.includes('SKILL-OK-9C2E'), `system 无技能标记：${system.slice(0, 400)}`)
      assert(system.includes('e2e-skill-marker'), `system 无技能名：${system.slice(0, 400)}`)
      const toolNames = (header.data?.tools || []).map((t) => t.name).join(',')
      assert(
        toolNames.includes('secret_marker'),
        `tools 无 MCP 工具：${toolNames}`,
      )
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
    if (mock) {
      try {
        await mock.close()
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
