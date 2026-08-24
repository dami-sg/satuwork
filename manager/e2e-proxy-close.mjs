/**
 * 席位半路死掉时，反代要把下游一起拆掉——不许让浏览器拿着一条半死的 SSE 干等。
 *
 * 钉的是 proxy.ts 里 `up.pipe(res)` 那一处：pipe 只在**干净的 end** 上收尾 res，席位
 * 被 `systemctl restart` 掐掉（换版就是这个动作）走的是 aborted/error，pipe 对这两种
 * 只 unpipe——下游于是悬着不关，Gateway 和浏览器等的「断」永远传不下去，界面上就是
 * 那句永远的「正在思考」。
 *
 * 由 e2e/proxy-close.mjs 用 `node --import tsx` 拉起，结果以 __RESULT__ 一行 JSON 回去。
 * 放 manager/ 而不是 e2e/：和别的探针同一个理由，裸导入按文件所在目录往上找。
 */
import { createServer, get } from 'node:http'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 环境要在**导入之前**摆好：config.ts 里那几个路径是在调用时读 env 的，但早读一步
// 更保险，也让这份探针不碰宿主机的 /etc 和 /opt。
const HOME = mkdtempSync(join(tmpdir(), 'satuwork-proxyclose-home-'))
const ROOT = mkdtempSync(join(tmpdir(), 'satuwork-proxyclose-root-'))
process.env.SATUWORK_MANAGER_HOME = HOME
process.env.SATUWORK_MANAGER_ROOT = ROOT

const { proxyIntercept } = await import('./src/proxy.ts')

function listen(server) {
  return new Promise((ok, bad) => {
    server.once('error', bad)
    server.listen(0, '127.0.0.1', () => ok(server.address().port))
  })
}

/** 假席位：一条永远不主动收尾的 SSE，外加每 100ms 一个心跳字节。 */
const seat = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
  res.write('data: {"type":"runtime/hello"}\n\n')
  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {}
  }, 100)
  res.on('close', () => clearInterval(beat))
})
const seatPort = await listen(seat)

writeFileSync(
  join(HOME, 'seats.json'),
  JSON.stringify({
    'sw-probe-0001': {
      seatId: 'sw-probe-0001',
      linuxUser: 'sw-probe',
      seatDir: `/home/sw-probe/.satuwork/sw-probe-0001`,
      botId: 'bot-probe',
      botVersion: '0.0.0-probe',
      botPort: seatPort,
      novncPort: 6081,
      deployedAt: Date.now(),
      status: 'ready',
      lastError: null,
    },
  }),
)

const intercept = proxyIntercept({ machineToken: () => 'smt_probe', gatewayUrl: () => 'http://127.0.0.1:9' })
const proxy = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  void intercept(req, res, url).then((handled) => {
    if (!handled) {
      res.writeHead(404)
      res.end()
    }
  })
})
const proxyPort = await listen(proxy)

const out = {}

// 一、正常路：SSE 穿过反代，字节到得了客户端。
const bytes = []
const done = new Promise((resolve) => {
  const r = get(
    {
      host: '127.0.0.1',
      port: proxyPort,
      path: '/seats/sw-probe-0001/bot/api/sessions/s-1/events',
      headers: { 'x-satuwork-machine': 'smt_probe', accept: 'text/event-stream' },
    },
    (res) => {
      out.status = res.statusCode
      res.on('data', (c) => bytes.push(c))
      // 「断」不管以哪种脸色来（干净的 end 还是 error），到了就算传下来了。
      res.on('end', () => resolve('end'))
      res.on('error', () => resolve('error'))
      res.on('close', () => resolve('close'))
    },
  )
  r.on('error', () => resolve('request-error'))
})

await new Promise((r) => setTimeout(r, 400))
out.bytesBeforeKill = Buffer.concat(bytes).length

// 二、席位被换版杀掉：所有连接当场断。下游必须在几秒内看见「断」，而不是永远悬着。
const killedAt = Date.now()
seat.closeAllConnections()
seat.close()

const verdict = await Promise.race([done, new Promise((r) => setTimeout(() => r('HUNG'), 5000))])
out.ended = verdict !== 'HUNG'
out.endedBy = verdict
out.endedInMs = Date.now() - killedAt

proxy.closeAllConnections()
proxy.close()
console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
