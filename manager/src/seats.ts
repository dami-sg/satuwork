import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { bootConfig, seatAssets, seatsPath } from './config.ts'
import { reclaimSeatPorts } from './reclaim.ts'
import { ensureRelease, releaseDir } from './releases.ts'
import { run, tailError } from './run.ts'

/** Gateway 下发的席位规格。字段名和 gateway/src/deploy.ts 那边一一对应。 */
export interface SeatSpec {
  seatId: string
  linuxUser: string
  homeDir: string
  workDir: string
  seatDir: string
  botId: string
  botVersion: string
  vncPassword: string
  gatewayUrl: string
  gatewayToken: string
  gatewayApiKey: string
  ports: { display: number; vncPort: number; novncPort: number; botPort: number; cdpPort: number }
}

export interface SeatRecord {
  seatId: string
  linuxUser: string
  seatDir: string
  botId: string
  botVersion: string
  botPort: number
  novncPort: number
  deployedAt: number
  status: 'ready' | 'error'
  lastError: string | null
}

type Registry = Record<string, SeatRecord>

function load(): Registry {
  try {
    const raw = JSON.parse(readFileSync(seatsPath(), 'utf8')) as Registry
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function save(reg: Registry): void {
  const path = seatsPath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, path)
}

export function seats(): SeatRecord[] {
  return Object.values(load()).sort((a, b) => a.seatId.localeCompare(b.seatId))
}

export function seat(seatId: string): SeatRecord | undefined {
  return load()[seatId]
}

/**
 * 部署期间不许自升级换版：换版会重启进程，把跑到一半的 `deploy-seat.sh` 连同它建了
 * 一半的席位一起打断。计数而不是布尔，因为可以有并发的多个部署。
 */
let inFlight = 0
export const busy = () => inFlight > 0

export async function deploySeat(spec: SeatSpec, token: string): Promise<SeatRecord> {
  inFlight += 1
  try {
    return await doDeploy(spec, token)
  } finally {
    inFlight -= 1
  }
}

/**
 * 把回收时停掉的席位从名册里销号。改动过返回 true，调用方据此决定要不要落盘。
 *
 * **留着它们是会骗人的。** 下一次部署撞上同一个口时，classifyHolder 拿名册判「占口
 * 的那个席位还活着吗」——名册里还挂着一个已经被自己停掉的席位，判断依据就成了一份
 * 自己造出来的假象，处置会从「孤儿，清掉」滑到「名册里活着的席位」那一格。
 *
 * 逐个判在不在，不是照着 retired 数一数就落盘：回收清掉的**多半是名册里本来就没有
 * 的孤儿**（那正是这条路最常见的入口），那种情况一个字都没改，不该白写一次盘。
 */
export function pruneRetired(reg: Record<string, SeatRecord>, retired: string[]): boolean {
  let changed = false
  for (const id of retired) {
    if (!(id in reg)) continue
    delete reg[id]
    changed = true
  }
  return changed
}

async function doDeploy(spec: SeatSpec, token: string): Promise<SeatRecord> {
  const reg = load()
  const base: SeatRecord = {
    seatId: spec.seatId,
    linuxUser: spec.linuxUser,
    seatDir: spec.seatDir,
    botId: spec.botId,
    botVersion: spec.botVersion,
    botPort: spec.ports.botPort,
    novncPort: spec.ports.novncPort,
    deployedAt: Date.now(),
    status: 'ready',
    lastError: null,
  }

  if (bootConfig().dryRun) {
    reg[spec.seatId] = base
    save(reg)
    return base
  }

  const fail = (message: string): SeatRecord => {
    const row: SeatRecord = { ...base, status: 'error', lastError: message.slice(0, 500) }
    reg[spec.seatId] = row
    save(reg)
    return row
  }

  try {
    await ensureRelease(spec.botVersion, { gatewayUrl: spec.gatewayUrl, token })
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }

  // ── 先把这三个口要回来 ──────────────────────────────────────────────
  // 单元停了、进程没死是这一层的常态（logind session scope + KillUserProcesses=no，
  // 见 reclaim.ts）。上一个席位拆掉之后留下的 x11vnc 会一直蹲在 5910 上，而 Gateway
  // 那边行一删槽位就分给了下一个人——不先清，这次部署必然撞在同一个口上。
  //
  // 该不该清只有管家判得了：脚本手里没有名册。清不动的当场失败，理由说清楚——比
  // 让 deploy-seat.sh 干等 30 秒再报一句「被别人占着」有用得多。
  const reclaimed = await reclaimSeatPorts(
    {
      seatId: spec.seatId,
      display: spec.ports.display,
      vncPort: spec.ports.vncPort,
      novncPort: spec.ports.novncPort,
      botPort: spec.ports.botPort,
    },
    Object.values(reg),
  )
  for (const line of reclaimed.freed) console.log(`satuwork-manager: 席位 ${spec.seatId} 部署前回收端口：${line}`)
  if (pruneRetired(reg, reclaimed.retired)) save(reg)
  if (reclaimed.blocked.length) return fail(reclaimed.blocked.join('；'))

  const r = await run('bash', [join(seatAssets(), 'deploy-seat.sh')], {
    timeout: 900_000,
    env: {
      LINUX_USER: spec.linuxUser,
      SEAT_ID: spec.seatId,
      HOME_DIR: spec.homeDir,
      WORK_DIR: spec.workDir,
      SEAT_DIR: spec.seatDir,
      DISPLAY_NUM: String(spec.ports.display),
      RFB: String(spec.ports.vncPort),
      HTTP: String(spec.ports.novncPort),
      BOT_PORT: String(spec.ports.botPort),
      CDP: String(spec.ports.cdpPort),
      BOT_VERSION: spec.botVersion,
      BOT_EXTRACT: releaseDir(spec.botVersion),
      SEAT_ASSETS: seatAssets(),
      VNC_PASSWORD: spec.vncPassword,
      GATEWAY_URL: spec.gatewayUrl,
      GATEWAY_TOKEN: spec.gatewayToken,
      GATEWAY_API_KEY: spec.gatewayApiKey,
      // **机器票不进席位环境。** 它是管家自己的控制面凭据（PUT /seats/:id 认的就是
      // 它），而 bot.env 属于席位那个普通 Linux 用户。bot 上报 /internal/* 用席位票
      // （GATEWAY_TOKEN）就够了。`token` 在这个函数里只用于向 Gateway 拉发布包。
      SATUWORK_BOT_ID: spec.botId,
    },
  })
  if (r.code !== 0) return fail(tailError(r, `deploy script exited ${r.code}`))

  reg[spec.seatId] = base
  save(reg)
  return base
}

/**
 * 拆一个席位。**非零退出只有一个含义：单元还活着**（见 remove-seat.sh 的结尾）。
 *
 * 分得这么细，是因为 Gateway 那边拿这个结果决定「这颗 Bot 能不能删」。删目录、删
 * drop-in 失败只是留了点垃圾，据此报错的代价是那颗 Bot 既聊不了也删不掉；而单元
 * 没停，端口就还占着，槽位让出去下一个人的席位就起不来——只有后者值得拦。
 *
 * 脚本的警告（跳过的目录、没删掉的 drop-in）走 stderr，成功时也写进 journal：
 * 机器上留了什么垃圾，事后只有这里答得上。
 */
export async function removeSeat(seatId: string): Promise<void> {
  const reg = load()
  const row = reg[seatId]
  if (!row) return
  if (!bootConfig().dryRun) {
    const r = await run('bash', [join(seatAssets(), 'remove-seat.sh')], {
      timeout: 120_000,
      env: { LINUX_USER: row.linuxUser, SEAT_ID: seatId, SEAT_DIR: row.seatDir },
    })
    if (r.code !== 0) throw new Error(tailError(r, `remove script exited ${r.code}`))
    const warnings = r.stderr.trim()
    if (warnings) console.warn(`satuwork-manager: 席位 ${seatId} 拆掉了，但有告警：${warnings.slice(-400)}`)
  }
  delete reg[seatId]
  save(reg)
}

/** systemd 眼里这个席位活着吗。心跳带上它，Gateway 才知道「部署过」之外还「在跑」。 */
export async function unitActive(seatId: string): Promise<boolean> {
  if (bootConfig().dryRun) return true
  const r = await run('systemctl', ['is-active', '--quiet', `satuwork-bot@${seatId}.service`], { timeout: 10_000 })
  return r.code === 0
}

export async function seatsWithLiveness(): Promise<(SeatRecord & { active: boolean })[]> {
  const rows = seats()
  return Promise.all(rows.map(async (r) => ({ ...r, active: await unitActive(r.seatId) })))
}

export function assetsReady(): boolean {
  return existsSync(join(seatAssets(), 'deploy-seat.sh'))
}
