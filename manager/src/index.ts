import { hostname } from 'node:os'
import { bootConfig, managerVersion, PROTOCOL, readState, type ManagerState } from './config.ts'
import { HttpError, json, listen, Router, type Req } from './http.ts'
import { attachUpgrade, proxyIntercept } from './proxy.ts'
import { bootChallenge, pairIfNeeded } from './pair.ts'
import { diagnose } from './diag.ts'
import { botUnit, clampLines, followLogs, MANAGER_UNIT, recentLogs } from './logs.ts'
import { checkLogs, defaultKeepMb, logUsage, setDesiredCapMb, startLogWatch, vacuum } from './logdisk.ts'
import { metrics, startMetrics } from './metrics.ts'
import { SeatBusy, deploySeat, removeSeat, seat, seatsWithLiveness, type SeatSpec } from './seats.ts'
import { confirmVersion, maybeUpgrade, refreshConfirmScript, upgradeDeferred, upgradeError } from './upgrade.ts'
import { currentTimezone, maybeSetTimezone, timezoneError } from './timezone.ts'
import { standDown } from './standdown.ts'

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
    // 人手工按的「重新部署」。只有它能跳过换版前的排空——自动跟版、模版下发都跳不过去。
    interrupt: b.interrupt === true,
    // 调用方给的排空预算（毫秒）。**不校验形状**，drainWindowMs 收到非数就回落到本机
    // 上限，而且两者取小——这个字段只能让排空更短，越不了机器自己的界。
    ...(b.drainMs == null ? {} : { drainMs: Number(b.drainMs) }),
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
    // 换版在等席位把会话跑完（见 upgrade.ts 的 seatsIdleEnough）。**和 upgradeError
    // 分开报**：等不是错，混进 lastError 会在界面上变成一行红字，而这台机器好好的。
    // 没在等就是 null——「界面上说 pending，机器上什么也没发生」得有个地方答得上。
    upgradeDeferred: upgradeDeferred(),
    // 时区分两件事报：机器现在是什么时区、上一次改时区为什么没改上。合成一个字段
    // 的话，「没指定过」和「指定了但改失败」在外面看着一样。
    timezone: currentTimezone() || null,
    timezoneError: timezoneError() || null,
    // 负载和日志占用都读**最近一次采样**，不现算：CPU 和出网速率是两次采样之差，
    // 现算给不出数；量一遍 /var/log 要走几千个文件，不该挂在一条探活路由上。
    metrics: metrics() ?? null,
    logs: logUsage() ?? null,
    seats: await seatsWithLiveness(),
  })
})

/**
 * 机器负载与日志占用。
 *
 * 心跳里已经带着同一份了——这条路给的是「我现在就想看」：心跳 30 秒一轮，而人盯着
 * 一台正在出事的机器时，等下一轮和等一分钟没区别。
 */
router.get('/metrics', async (req, res) => {
  requireMachine(req)
  json(res, 200, { metrics: metrics() ?? null, logs: logUsage() ?? null })
})

/**
 * 立刻清一次日志。平时不需要按——超过上限时看守自己会清（见 logdisk.ts）。
 *
 * 它存在是为了两种时候：盘已经快满了，等不了下一轮检查；以及刚把上限调小，想当场
 * 看到效果。`keepMb` 不给就用和自动清理同一个目标，免得两条路清出两种结果。
 */
router.post('/logs/vacuum', async (req, res) => {
  requireMachine(req)
  const raw = (req.body as { keepMb?: unknown })?.keepMb
  const keep = raw == null ? defaultKeepMb() : Number(raw)
  if (!Number.isFinite(keep) || keep < 0) throw new HttpError(400, 'keepMb is invalid')
  json(res, 200, { vacuum: await vacuum(keep), logs: logUsage() ?? null })
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

/**
 * 席位 bot 的运行日志。`?follow=1` 跟着滚（SSE），否则给最近 N 行。
 *
 * diag 那条能回答「它活着吗」，回答不了「它卡在哪一步」——而这一层最贵的故障恰恰
 * 都不报错：单元 active、端口有人听，只是那一轮永远不结束。没有这条路，每查一次都
 * 得请人登机器。
 *
 * seatId 先在名册里查，查不到就 404：unit 名是拿它拼的，只让已知席位过去，就不存在
 * 「拼出别的单元」这件事（spawn 本来也走参数数组，不过 shell）。
 */
router.get('/seats/:seatId/logs', async (req, res) => {
  requireMachine(req)
  const seatId = req.params.seatId
  if (!seat(seatId)) throw new HttpError(404, '没有这个席位')
  const lines = clampLines(req.query.get('lines'))
  if (req.query.get('follow') === '1') return followLogs(botUnit(seatId), lines, res)
  json(res, 200, { seatId, lines: await recentLogs(botUnit(seatId), lines) })
})

/**
 * 管家自己的日志。平台端排查「这台机器怎么了」看的是它——部署失败、升级卡住、
 * 配对回拨不通，这些都写在管家的 journal 里，席位的日志里一个字都没有。
 */
router.get('/logs', async (req, res) => {
  requireMachine(req)
  const lines = clampLines(req.query.get('lines'))
  if (req.query.get('follow') === '1') return followLogs(MANAGER_UNIT, lines, res)
  json(res, 200, { unit: MANAGER_UNIT, lines: await recentLogs(MANAGER_UNIT, lines) })
})

router.put('/seats/:seatId', async (req, res) => {
  requireMachine(req)
  try {
    const row = await deploySeat(specOf(req.params.seatId, req.body), token())
    json(res, row.status === 'ready' ? 200 : 502, { seat: row })
  } catch (e) {
    /**
     * 席位上还有会话在跑，等过了也没等到它结束。**这不是失败**：机器上一个字节都没
     * 动，席位还是原来那个版本、还在好好地跑。所以回 409（不是 502），并且带一个
     * `busy: true` 让 Gateway 认得出来——它据此保留原来的状态，而不是把这一行标红。
     */
    if (e instanceof SeatBusy) {
      json(res, 409, { error: e.message, busy: true, seat: seat(req.params.seatId) ?? null })
      return
    }
    throw e
  }
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

// 兜底脚本跟着包走，每次启动刷一遍——它装在 /usr/local/bin，不刷的话机器装好那天是
// 什么样就一直是什么样，改了也只有重装才拿得到。dryRun 下不碰宿主机的 /usr/local/bin。
if (!boot.dryRun) refreshConfirmScript()

// 负载采样和日志看守**在配对之前就起**：这两件事只关乎这台机器本身，不需要 Gateway
// 同意。一台还没配上（或者被移除之后还没人来收拾）的机器，日志照样在涨。
startMetrics()
startLogWatch()

const HEARTBEAT_MS = 30_000

/**
 * 连续多少次 401 之后认定「Gateway 不认这台机器了」。10 轮 = 5 分钟。
 *
 * **401 只降频加报警，不自毁**：它是否定式信号，分不出「我被移除了」和「Gateway
 * 那边出了状况」。真正的移除走的是心跳回包里的 `removed: true`（见 standDown）。
 * 这一路是兜底——Gateway 要是老版本、或者那行记录被人直接从库里删了，管家至少不会
 * 每 30 秒空敲到天荒地老，而且 journal 里有一句说得清的话。
 */
const AUTH_FAIL_LIMIT = 10
/** 认定失联之后的心跳间隔。不彻底停：Gateway 恢复了还能自己接回来。 */
const IDLE_HEARTBEAT_MS = 5 * 60_000
let authFails = 0
let idled = false

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
        // 负载和日志占用**搭心跳上报**，不另开一条上行：机器本来就每 30 秒敲一次门，
        // 再加一条定时 POST 只是多一个会失败、会重试、会被防火墙拦住的东西。
        metrics: metrics() ?? null,
        logs: logUsage() ?? null,
        seats: await seatsWithLiveness(),
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      // 401/403 = Gateway 不认这把票了。别的状态码（5xx、502）是它自己的毛病，
      // 不该算在这个账上，否则一次 Gateway 重启就会把整队机器推进「失联」。
      if (res.status === 401 || res.status === 403) onAuthFail()
      return
    }
    authFails = 0
    if (idled) {
      idled = false
      retime(HEARTBEAT_MS)
      console.log('satuwork-manager: Gateway 又认得这台机器了，心跳恢复正常间隔')
    }
    // 心跳通了才算「这个版本活过来了」。confirm timer 看的就是这个标记。
    confirmVersion()
    const reply = (await res.json()) as { timezone?: string | null; removed?: boolean; logCapMb?: number | null }
    // 被移除了：停席位、清配对、停自己。这一支之后不再做别的活儿。
    if (reply.removed) {
      clearInterval(timer)
      await standDown(state, boot.dryRun)
      return
    }
    // 日志上限改了就当场量一遍：把上限从 4G 调到 500M 的人，等的就是那一下，
    // 而定时检查半小时才轮一次。没改就不动——每轮心跳都走一遍 /var/log 太贵。
    if (setDesiredCapMb(reply as Record<string, unknown>)) await checkLogs()
    // 时区在前：它便宜、不重启进程，而 maybeUpgrade 成功那一支会把自己重启掉，
    // 排在它后面的活儿这一轮就不一定跑得到了。
    await maybeSetTimezone(reply.timezone)
    await maybeUpgrade(reply as Record<string, never>, state.token)
  } catch {
    /* 网络抖动不值得刷屏；下一轮再试。 */
  }
}

void heartbeat()
let timer = setInterval(() => void heartbeat(), HEARTBEAT_MS)

/** 换心跳间隔。`timer` 是 let，shutdown 那边照旧 clearInterval 得到当前这一个。 */
function retime(ms: number): void {
  clearInterval(timer)
  timer = setInterval(() => void heartbeat(), ms)
}

/**
 * 连着被拒了几次。到阈值就说一句话、把心跳降到低频。
 *
 * 只说一次：每 5 分钟往 journal 刷同一行，等于没说。
 */
function onAuthFail(): void {
  authFails += 1
  if (authFails !== AUTH_FAIL_LIMIT) return
  idled = true
  retime(IDLE_HEARTBEAT_MS)
  console.error(
    'satuwork-manager: Gateway 连续拒收心跳（401）。多半是这台机器已经在平台上被移除，' +
      '或者这把机器票被吊销了。席位还在跑，不会自动停——要下线这台机器，' +
      '在上面跑 `systemctl disable --now satuwork-manager` 并拆掉席位；要重新接回去，重跑一次配对。' +
      `心跳已降到 ${IDLE_HEARTBEAT_MS / 60_000} 分钟一次。`,
  )
}

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
