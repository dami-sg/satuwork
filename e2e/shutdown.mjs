/**
 * 收工。**这条比看起来重要。**
 *
 * `server.close()` 只停止接受新连接，然后等已有的连接自己结束——而这台服务上挂着的
 * 恰恰都是不会自己结束的东西：对话的 SSE、桌面的 WebSocket、浏览器的 keep-alive。
 * 少了「主动掐连接」那一步，进程会停在一个最坏的状态：**端口已经不听了（谁来都是
 * connection refused），进程却还活着不退出**。线上遇到过一次，界面全挂，而 ps 里
 * 一切正常，最后只能 kill -9。
 *
 * 所以这里验的不是「能不能关」，是「**手上还挂着一条连接时**能不能关」。
 */
import { freePort } from './ports.mjs'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { rmSync } from 'node:fs'
import net from 'node:net'

/** 进程还在不在。kill(pid, 0) 不发信号，只做存在性检查。 */
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitGone(pid, ms) {
  const at = Date.now()
  while (Date.now() - at < ms) {
    if (!alive(pid)) return Date.now() - at
    await new Promise((r) => setTimeout(r, 50))
  }
  return -1
}

export async function runShutdown({ gwRoot, test, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-shutdown')
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# shutdown')

  const gw = start('shutdown-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_shutdown'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(port),
      GATEWAY_SEED_OWNER: '0',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'shutdown gateway' })

  await test('手上还挂着一条没走完的连接时，SIGTERM 也要真的退出', async () => {
    /**
     * 要的是一条**还没走完**的连接，不是空闲的 keep-alive——Node 19 起 `close()` 已经
     * 会顺手关掉空闲的那些。真正卡住它的是「正在进行中」的那种：对话的 SSE、桌面的
     * WebSocket。这里用一条**只发了一半的请求**来演：不发那个收尾的空行，服务端就
     * 一直等着它，和 SSE 在服务端看来是同一类连接，而且不需要任何登录态。
     */
    const sock = net.connect(port, '127.0.0.1')
    await new Promise((res, rej) => {
      sock.on('connect', res)
      sock.on('error', rej)
    })
    sock.write('GET /health HTTP/1.1\r\nhost: 127.0.0.1\r\n')

    gw.kill('SIGTERM')
    const ms = await waitGone(gw.pid, 8000)
    sock.destroy()
    assert(
      ms >= 0,
      '端口关了、进程不退——这时候界面全挂而 ps 里一切正常，只能 kill -9。' +
        '八成是 shutdown 少了 closeAllConnections（见 gateway/src/index.ts）',
    )
    // 三秒是兜底那道超时；正常路径（掐连接）应该是几十毫秒的事。
    assert(ms < 3000, `退得太慢（${ms}ms），走的是兜底超时那条路，不是主动掐连接`)
  })
}
