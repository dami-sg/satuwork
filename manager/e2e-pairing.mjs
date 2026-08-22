/**
 * 带配对码重跑装机脚本时，管家该拿哪个身份。
 *
 * 由 e2e/pairing.mjs 用 `node --import tsx` 拉起，结果以 __RESULT__ 一行 JSON 回去。
 * 起一个假 Gateway 顶着 /machines/pair，不碰真库——要钉的是「码和本地身份谁说了算」。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 假 Gateway：verdict 决定这次配对认不认。 */
function fakeGateway(verdict) {
  return new Promise((resolve) => {
    let hits = 0
    const srv = createServer((req, res) => {
      if (req.url === '/machines/pair') {
        hits += 1
        if (verdict === 'ok') {
          res.writeHead(201, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ machineId: 'new-machine-id', token: 'smt_new', reachable: true }))
        } else {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: '配对码无效或已过期' }))
        }
        return
      }
      res.writeHead(404).end('{}')
    })
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, hits: () => hits }))
  })
}

async function scenario({ existingState, code, verdict }) {
  const home = mkdtempSync(join(tmpdir(), 'satu-pair-'))
  const gw = await fakeGateway(verdict)
  try {
    if (existingState) {
      writeFileSync(join(home, 'manager.json'), JSON.stringify({ machineId: 'old-machine-id', token: 'smt_old', gatewayUrl: `http://127.0.0.1:${gw.port}`, pairedAt: 1, jwks: null, confirmedVersion: '0', lastUpgradeTo: '', lastUpgradeAt: 0 }))
    }
    process.env.SATUWORK_MANAGER_HOME = home
    process.env.GATEWAY_URL = `http://127.0.0.1:${gw.port}`
    process.env.SATUWORK_PAIRING_CODE = code
    // 每一轮都重新导入：bootConfig / readState 都是按进程环境算的。
    const { pairIfNeeded } = await import(`./src/pair.ts?v=${home}`)
    const { bootConfig } = await import(`./src/config.ts?v=${home}`)
    let error = null
    let out = null
    try {
      out = await pairIfNeeded(bootConfig())
    } catch (e) {
      error = String(e && e.message ? e.message : e)
    }
    const onDisk = existsSync(join(home, 'manager.json')) ? JSON.parse(readFileSync(join(home, 'manager.json'), 'utf8')) : null
    return { pairCalls: gw.hits(), machineId: out ? out.state.machineId : null, onDisk: onDisk ? onDisk.machineId : null, token: onDisk ? onDisk.token : null, error }
  } finally {
    gw.srv.close()
    rmSync(home, { recursive: true, force: true })
  }
}

const out = {
  // 本地已有身份、又给了码 → 必须真的去配一次，并换成新身份。这就是这次的坑。
  staleThenCode: await scenario({ existingState: true, code: 'SW-AAAA-BBBB', verdict: 'ok' }),
  // 码用过了/过期了 → 退回旧身份，不能把机器丢掉，也不能炸。
  staleThenBadCode: await scenario({ existingState: true, code: 'SW-AAAA-BBBB', verdict: 'bad' }),
  // 没给码 → 一次请求都不该发，身份不动。「重跑不会把机器搞乱」那条路。
  staleNoCode: await scenario({ existingState: true, code: '', verdict: 'ok' }),
  // 全新机器 → 照旧。
  freshWithCode: await scenario({ existingState: false, code: 'SW-AAAA-BBBB', verdict: 'ok' }),
  // 全新机器、码不认 → 没有可退回的身份，该抛。
  freshBadCode: await scenario({ existingState: false, code: 'SW-AAAA-BBBB', verdict: 'bad' }),
}
console.log('__RESULT__' + JSON.stringify(out))
