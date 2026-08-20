/**
 * Gateway 配置的 Skill / MCP / Bot 被实例加载并进入对话。
 * 自己的 home / 端口，不碰 live 3080，不碰 run.mjs 那套 /tmp/satuwork-e2e-gw。
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createCompany } from './org.mjs'
import { startMockMcp } from './mock-mcp.mjs'
import { PG_URL } from './pg.mjs'
import { publishRelease } from './release.mjs'
import { pairMachine } from './pair.mjs'
import { freePorts } from './ports.mjs'

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

export async function runRuntimePath({ root, gwRoot, botRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = '/tmp/satuwork-e2e-runtime-gw'
  const BOT_HOME = '/tmp/satuwork-e2e-runtime-bot'
  const [GW_PORT, BOT_PORT] = await freePorts(2)
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
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: 'e2e_runtime',
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_MACHINE_TOKEN: MACHINE_TOK,
      GATEWAY_PLATFORM_TOKEN: PLATFORM_TOK,
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@runtime.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-runtime',
      SATUWORK_DEPLOY_STUB: '1',
    },
  })
  await waitHttp(gwBase + '/health')

  let mock
  let botChild
  try {
    await test('Gateway 配置的 Skill/MCP/Bot 被实例加载并进入对话', async () => {
      const reg = await createCompany(req, gwBase, {
        ownerEmail: 'owner@runtime.test',
        ownerPassword: 'test-owner-runtime',
        email: 'admin@runtime.test',
        password: 'correct-horse',
        companyName: 'RuntimeCo',
        slug: 'runtimeco',
        seats: 2,
      })
      const adminTok = reg.token
      const orgId = reg.company.id
      const ownerTok = reg.ownerToken
      const adminId = reg.account.id
      const seat = await req(gwBase, 'GET', `/platform/accounts/${adminId}`, { token: ownerTok })
      assert(seat.status === 200, `seat secrets ${seat.status} ${seat.text}`)
      const seatAccess = seat.json.accessToken
      const seatApiKey = seat.json.apiKey
      assert(typeof seatAccess === 'string' && seatAccess.startsWith('sat_'), 'access token')
      assert(typeof seatApiKey === 'string' && seatApiKey.startsWith('sk_sw_'), 'api key')
      const machineTok = (await pairMachine({ req, gwBase, ownerTok, orgId })).token
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

      // 席位 sat_ 才拿得到这份目录——它带 MCP 明文 token。
      const rt = await req(gwBase, 'GET', '/runtime/catalog', { token: seatAccess })
      assert(rt.status === 200, `runtime catalog ${rt.status} ${rt.text}`)
      assert(rt.json.bots.some((b) => b.id === remoteBotId), 'runtime bots')
      assert(rt.json.skills.some((s) => s.id === skillId && String(s.body).includes('SKILL-OK-9C2E')), 'runtime skills')
      const srv = rt.json.servers.find((s) => s.id === mcpId)
      assert(srv, 'runtime server')
      assert(typeof srv.token === 'string', 'runtime token field')

      const rtJwt = await req(gwBase, 'GET', '/runtime/catalog', { token: adminTok })
      assert(rtJwt.status === 401, `runtime 不该收 JWT ${rtJwt.status}`)

      const unauth = await req(gwBase, 'GET', '/runtime/catalog')
      assert(unauth.status === 401, `runtime unauth ${unauth.status}`)

await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0', note: 'e2e-runtime' })
      const dep = await req(gwBase, 'POST', '/runtime/deploy', {
        token: adminTok,
        body: { botId: remoteBotId },
      })
      assert(dep.status === 200, `stub deploy ${dep.status} ${dep.text}`)

      await test('席位票上报会话索引：不带 botId 也要落到席位所在的机器上', async () => {
        // 回归防护。machineId 一度只在 body 带 botId 时才推导，不带就落 null——而会话
        // 根事件的 botId 本来就可能缺（bot 那边是 `data.botId || null`）。落 null 之后
        // 拉全文会回落到「公司默认机器」，多机公司必然拿错票，管家 401；现象只是
        // 「拉不到全文」，从这里一点也看不出来。账号粘住机器，所以按账号查一定查得到。
        const now = Date.now()
        const r = await req(gwBase, 'POST', '/internal/sessions/index', {
          token: seatAccess,
          body: {
            sessionId: 's-seat-no-botid',
            // 故意不带 botId；也不带 accountId——席位票只能报自己，body 里给了也不算
            title: '无 botId 的会话',
            createdAt: now,
            updatedAt: now,
            messageCount: 1,
          },
        })
        assert(r.status === 200, `席位票上报 ${r.status} ${r.text}`)
        assert(
          typeof r.json.session.machineId === 'string' && r.json.session.machineId,
          `machineId 该由服务端按席位算出来，实际 ${JSON.stringify(r.json.session.machineId)}`,
        )
        assert(r.json.session.accountId === adminId, `席位票只能报自己，实际 ${r.json.session.accountId}`)
      })

      await test('席位票替别人上报会被拒', async () => {
        const now = Date.now()
        const r = await req(gwBase, 'POST', '/internal/sessions/index', {
          token: seatAccess,
          body: {
            sessionId: 's-seat-impersonate',
            accountId: 'some-other-account',
            createdAt: now,
            updatedAt: now,
            messageCount: 1,
          },
        })
        // body 里的 accountId 对席位票不作数：要么被忽略（记成自己），要么直接拒。
        assert(r.status !== 200 || r.json.session.accountId === adminId, `冒名上报 ${r.status} ${r.text}`)
      })

      botChild = start('runtime-bot', ['--import', 'tsx', join(botRoot, 'e2e-boot.mjs')], {
        cwd: botRoot,
        env: {
          SATUWORK_HOME: BOT_HOME,
          SATUWORK_PORT: String(BOT_PORT),
          SATUWORK_BOT_ID: remoteBotId,
          GATEWAY_URL: gwBase,
          GATEWAY_TOKEN: seatAccess,
          GATEWAY_API_KEY: seatApiKey,
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
        const r = await req(botBase, 'GET', '/api/runtime/status', { token: seatAccess })
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

      // bot 认的唯一一把入站凭据就是席位票（GATEWAY_TOKEN），和 Gateway 反代时发的
      // 是同一把。以前这里先 POST /api/auth/setup 建个本地管理员再拿 cookie，
      // 那套账号体系已经删了。
      const list = await req(botBase, 'GET', '/api/bots', { token: seatAccess })
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

      const sess = await req(botBase, 'GET', `/api/bots/${pinned.id}/session`, { token: seatAccess })
      assert(sess.status === 200, `session ${sess.status} ${sess.text}`)
      const sessionId = sess.json.sessionId
      assert(sessionId, 'sessionId')

      const msg = await req(botBase, 'POST', `/api/sessions/${sessionId}/messages`, {
        token: seatAccess,
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
