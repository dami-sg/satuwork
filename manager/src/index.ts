import { hostname } from 'node:os'
import { bootConfig, managerVersion, PROTOCOL, readState, type ManagerState } from './config.ts'
import { HttpError, json, listen, Router, type Req } from './http.ts'
import { attachUpgrade, proxyIntercept } from './proxy.ts'
import { bootChallenge, pairIfNeeded } from './pair.ts'
import { diagnose } from './diag.ts'
import { deploySeat, removeSeat, seat, seatsWithLiveness, type SeatSpec } from './seats.ts'
import { confirmVersion, maybeUpgrade, upgradeError } from './upgrade.ts'
import { currentTimezone, maybeSetTimezone, timezoneError } from './timezone.ts'

/**
 * 机器管家。一台席位机器一个，root systemd 服务。
 *
 * 它取代了 Gateway 的 SSH 部署路径：Gateway 不再持有任何能登录这台机器的凭据，
 * 只有一把可吊销的 `smt_`；席位的 bot 口和 noVNC 口全部收回 127.0.0.1，对外只剩
 * 管家这一个端口。
 *
 * 启动顺序是**先起 HTTP 再配对**——配对时 Gateway 会立刻回拨一次确认可达，
 * 服务没起来那次回拨必然失败。
 */

let state: ManagerState | undefined
const boot = bootConfig()

const token = () => state?.token ?? ''
const gatewayUrl = () => state?.gatewayUrl ?? boot.gatewayUrl

/**
 * 控制类接口的鉴权。
 *
 * **两个头都收**：Gateway 下发部署时用 `x-satuwork-machine`（反代那条路径上要和
 * 转给 bot 的 `authorization` 区分开），而 `/health` 和手工 curl 习惯用
 * `authorization`。只认一个的后果是「/health 通、部署 401」这种极难对上的现象。
 */
function requireMachine(req: Req): void {
  const given =
    String(req.headers['x-satuwork-machine'] || '') ||
    String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
  const want = token()
  if (!want || given.length !== want.length) throw new HttpError(401, 'invalid machine credential')
  let diff = 0
  for (let i = 0; i < want.length; i++) diff |= given.charCodeAt(i) ^ want.charCodeAt(i)
  if (diff !== 0) throw new HttpError(401, 'invalid machine credential')
}

function strField(body: unknown, key: string): string {
  const v = (body as Record<string, unknown>)?.[key]
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, `${key} is required`)
  return v.trim()
}

/**
 * 标识符的形状。**不是**照抄 Gateway 的 sha256 命名（那样两边就得锁版本升级），
 * 只保证它能安全地当目录名和 systemd 单元实例名用：没有 `/`、没有 `.`（也就没有
 * `..`）、没有空白和 shell 元字符、长度有上限。
 */
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** botId 是 Gateway 的 catalog id（randomUUID 或 `default`），允许点但不许 `..`。 */
const BOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
/** 和 releases.ts 的 safeVersion 同一套口径。 */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

/**
 * 单行字符串。这些值最后会被 heredoc 原样写进 `bot.env`，**一个换行就能在里面多插
 * 一行环境变量**（比如再塞一个 GATEWAY_URL 把上报引到别处），所以控制字符一律不收。
 */
function line(body: unknown, key: string, max = 512): string {
  const v = strField(body, key)
  if (v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw new HttpError(400, `${key} is invalid`)
  return v
}

function shaped(value: string, re: RegExp, key: string): string {
  if (!re.test(value) || value.includes('..')) throw new HttpError(400, `${key} is invalid`)
  return value
}

/**
 * 请求体 → 席位规格。
 *
 * 这是**网络边界**，不是 Gateway 的内部函数调用：管家以 root 跑 `deploy-seat.sh`，
 * 下面每个值都会变成 root 的 mkdir/chown 目标、systemd 单元里的字段、或者 bot.env
 * 里的一行。所以：标识符按形状校验，**路径一律不收外部值**、由已校验的标识符重新
 * 推出来（和 gateway/src/deploy.ts 的 homeDirOf/workDirOf/seatDirOf 同一套规则）。
 *
 * 以前这里只有「是非空字符串」，`homeDir: "/etc"` 就能让 root 去 chown /etc。
 */
function specOf(rawSeatId: string, body: unknown): SeatSpec {
  const b = (body ?? {}) as Record<string, unknown>
  const ports = (b.ports ?? {}) as Record<string, unknown>
  const port = (k: string) => {
    const n = Number(ports[k])
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new HttpError(400, `ports.${k} is invalid`)
    return n
  }
  const seatId = shaped(rawSeatId.trim(), IDENT_RE, 'seatId')
  const linuxUser = shaped(line(b, 'linuxUser', 64), IDENT_RE, 'linuxUser')
  const homeDir = `/home/${linuxUser}`
  const workDir = `${homeDir}/work`
  const seatDir = `${homeDir}/.satuwork/${seatId}`
  // 路径由上面推出来，body 里那三个字段只用来**对账**：对得上就往下走，对不上就 400。
  // 不采信是安全底线；但也不能默默忽略——Gateway 哪天改了目录布局，静默忽略会把席位
  // 建到一个双方都以为不是那儿的地方，报错才看得见。deploy-seat.sh 里那三条 [ ] 判断
  // 是同一套规则的第二层，给手工调用兜底。
  const expect: Record<string, string> = { homeDir, workDir, seatDir }
  for (const [key, want] of Object.entries(expect)) {
    const got = line(b, key)
    if (got !== want) throw new HttpError(400, `${key} must be ${want}`)
  }
  return {
    seatId,
    linuxUser,
    homeDir,
    workDir,
    seatDir,
    botId: shaped(line(b, 'botId', 64), BOT_ID_RE, 'botId'),
    botVersion: shaped(line(b, 'botVersion', 64), VERSION_RE, 'botVersion'),
    vncPassword: line(b, 'vncPassword', 256),
    gatewayUrl: line(b, 'gatewayUrl'),
    gatewayToken: line(b, 'gatewayToken'),
    gatewayApiKey: line(b, 'gatewayApiKey'),
    ports: {
      display: port('display'),
      vncPort: port('vncPort'),
      novncPort: port('novncPort'),
      botPort: port('botPort'),
      cdpPort: port('cdpPort'),
    },
  }
}

const router = new Router()
router.intercept(proxyIntercept({ machineToken: token, gatewayUrl }))

router.get('/health', async (req, res) => {
  // 配对回拨走 challenge，不走 smt_：那一刻票还在 Gateway 手里，管家还没收到响应。
  const challenge = req.query.get('challenge')
  if (!challenge || challenge !== bootChallenge) requireMachine(req)
  json(res, 200, {
    ok: true,
    managerVersion: managerVersion(),
    protocol: PROTOCOL,
    node: process.versions.node,
    hostname: hostname(),
    paired: Boolean(state),
    dryRun: boot.dryRun,
    upgradeError: upgradeError() || null,
    // 时区分两件事报：机器现在是什么时区、上一次改时区为什么没改上。合成一个字段
    // 的话，「没指定过」和「指定了但改失败」在外面看着一样。
    timezone: currentTimezone() || null,
    timezoneError: timezoneError() || null,
    seats: await seatsWithLiveness(),
  })
})

router.get('/seats', async (req, res) => {
  requireMachine(req)
  json(res, 200, { seats: await seatsWithLiveness() })
})

/**
 * 一个席位的现场快照。**只读**，见 diag.ts 开头。
 *
 * 没有 SSH 的代价就是「机器上到底怎么了」谁也看不见，而这一层最贵的故障恰恰都不报错
 * （端口被别人占、服务没真重启、dock 少一格）。这条路让那些只能靠 ps/ss/journal 看出
 * 来的东西，隔着 Gateway 也能拿到。
 */
router.get('/seats/:seatId/diag', async (req, res) => {
  requireMachine(req)
  const lines = Number(req.query.get('lines') || 40)
  json(res, 200, { diag: await diagnose(req.params.seatId, Number.isFinite(lines) ? lines : 40) })
})

router.put('/seats/:seatId', async (req, res) => {
  requireMachine(req)
  const row = await deploySeat(specOf(req.params.seatId, req.body), token())
  json(res, row.status === 'ready' ? 200 : 502, { seat: row })
})

router.delete('/seats/:seatId', async (req, res) => {
  requireMachine(req)
  if (!seat(req.params.seatId)) throw new HttpError(404, 'no such seat')
  await removeSeat(req.params.seatId)
  json(res, 200, { ok: true })
})

/**
 * 自检模式：起一次、答一次、退出。自升级换版之前由**旧**管家跑新版本的这一条，
 * 用来挡住「包坏了 / 语法错 / 依赖缺失」。它不连 Gateway，也不碰任何持久状态。
 */
if (process.argv.includes('--selftest')) {
  const server = listen(router, '127.0.0.1', 0)
  await new Promise((r) => server.once('listening', r))
  const port = (server.address() as { port: number }).port
  const res = await fetch(`http://127.0.0.1:${port}/health?challenge=${encodeURIComponent(bootChallenge)}`)
  server.close()
  if (!res.ok) {
    console.error(`satuwork-manager: selftest failed ${res.status}`)
    process.exit(1)
  }
  console.log(`satuwork-manager: selftest ok ${managerVersion()}`)
  process.exit(0)
}

const server = listen(router, boot.host, boot.port)
attachUpgrade(server, { machineToken: token, gatewayUrl })

state = readState()
if (!state) {
  try {
    const out = await pairIfNeeded(boot)
    state = out?.state
    console.log('satuwork-manager: ' + (out?.message ?? 'not paired'))
  } catch (e) {
    console.error('satuwork-manager: ' + (e instanceof Error ? e.message : String(e)))
  }
} else {
  console.log(`satuwork-manager: paired machineId=${state.machineId} -> ${state.gatewayUrl}`)
}

const HEARTBEAT_MS = 30_000

async function heartbeat(): Promise<void> {
  if (!state) return
  try {
    const res = await fetch(`${state.gatewayUrl}/internal/machines/${encodeURIComponent(state.machineId)}/heartbeat`, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + state.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        managerVersion: managerVersion(),
        protocol: PROTOCOL,
        node: process.versions.node,
        // Gateway 按它挑发布包。包里带 esbuild 的原生二进制，架构不对就起不来。
        arch: process.arch,
        // 自报**实际**时区。Gateway 拿它和期望时区比，界面上才分得出「已经改上了」
        // 和「指令下了、还没改上」。
        timezone: currentTimezone() || null,
        // 升级和改时区都可能失败，而 Gateway 只有一格 lastError。升级失败更要命
        // （机器版本会卡住），所以它优先；两者都好的时候这里是 null。
        upgradeError: upgradeError() || timezoneError() || null,
        seats: await seatsWithLiveness(),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return
    // 心跳通了才算「这个版本活过来了」。confirm timer 看的就是这个标记。
    confirmVersion()
    const reply = (await res.json()) as { timezone?: string | null }
    // 时区在前：它便宜、不重启进程，而 maybeUpgrade 成功那一支会把自己重启掉，
    // 排在它后面的活儿这一轮就不一定跑得到了。
    await maybeSetTimezone(reply.timezone)
    await maybeUpgrade(reply as Record<string, never>, state.token)
  } catch {
    /* 网络抖动不值得刷屏；下一轮再试。 */
  }
}

void heartbeat()
const timer = setInterval(() => void heartbeat(), HEARTBEAT_MS)

let closing = false
function shutdown() {
  if (closing) return
  closing = true
  clearInterval(timer)
  // 短暂 drain：停止接受新连接，给在途请求几秒。换版重启时聊天 SSE 会断，UI 侧靠
  // ?after=N 游标自己接回来。
  server.close()
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
