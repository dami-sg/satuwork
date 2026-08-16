import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isUniqueViolation, type Account, type Db, type Machine, type SeatRuntime } from './db.ts'
import type { JwtKeys } from './crypto.ts'
import { botReleaseFile } from './releases.ts'

export interface SeatPorts {
  display: number
  vncPort: number
  novncPort: number
  botPort: number
  cdpPort: number
}

/** `bot-` + first 12 hex of sha256(`${accountId}\n${botId}`). Unique per (account, bot) pair. */
export function linuxUserOf(accountId: string, botId: string): string {
  const hex = createHash('sha256').update(`${accountId}\n${botId}`).digest('hex')
  return 'bot-' + hex.slice(0, 12)
}

/** Slot N=0,1,2… DISPLAY=10+N RFB=5910+N HTTP=6081+N CDP=9222+N Bot=3200+N */
export function portsOf(slot: number): SeatPorts {
  const n = Math.max(0, Math.trunc(slot))
  return {
    display: 10 + n,
    vncPort: 5910 + n,
    novncPort: 6081 + n,
    botPort: 3200 + n,
    cdpPort: 9222 + n,
  }
}

export function novncUrlOf(sshHost: string, novncPort: number): string {
  const host = sshHost.trim()
  if (!host) return ''
  return `http://${host}:${novncPort}/vnc.html`
}

export function randomVncPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  const buf = randomBytes(16)
  let out = ''
  for (let i = 0; i < 16; i++) out += alphabet[buf[i]! % alphabet.length]
  return out
}

export function publicMachine(m: Machine) {
  return {
    id: m.id,
    host: m.host,
    sshHost: m.sshHost,
    sshPort: m.sshPort,
    sshUser: m.sshUser,
    sshAuth: m.sshAuth,
    hasSshAuth: Boolean(m.sshSecret),
    lastHeartbeatAt: m.lastHeartbeatAt,
  }
}

/** owner 机器详情：像账号密钥一样带一次 token。公司 admin 的 publicMachine 永不带。 */
export function ownerMachine(m: Machine) {
  return { ...publicMachine(m), token: m.token || null }
}

export function publicSeatRuntime(row: SeatRuntime, sshHost: string, opts: { includePassword: boolean }) {
  const ports = portsOf(row.slot)
  return {
    accountId: row.accountId,
    botId: row.botId,
    companyId: row.companyId,
    linuxUser: row.linuxUser,
    display: row.display,
    vncPort: row.vncPort,
    novncPort: row.novncPort,
    novncUrl: novncUrlOf(sshHost, row.novncPort),
    status: row.status,
    lastError: row.lastError,
    deployedAt: row.deployedAt,
    updatedAt: row.updatedAt,
    botVersion: row.botVersion ?? null,
    ...(opts.includePassword ? { vncPassword: row.vncPassword } : {}),
    ports: {
      display: ports.display,
      vncPort: ports.vncPort,
      novncPort: ports.novncPort,
    },
  }
}

export function listSeatRuntime(row: SeatRuntime, sshHost: string) {
  return {
    botId: row.botId,
    status: row.status,
    linuxUser: row.linuxUser,
    novncUrl: novncUrlOf(sshHost, row.novncPort) || null,
    botVersion: row.botVersion ?? null,
  }
}

function shQuote(s: string): string {
  return `'` + String(s).replace(/'/g, `'\\''`) + `'`
}

function gatewayPublicUrl(): string {
  const explicit = (process.env.GATEWAY_PUBLIC_URL || '').trim().replace(/\/$/, '')
  if (explicit) return explicit
  const host = process.env.GATEWAY_HOST || '127.0.0.1'
  const port = process.env.GATEWAY_PORT || '3080'
  return `http://${host}:${port}`
}

function allocateSlot(db: Db, companyId: string, keep?: number): number {
  if (keep != null && keep >= 0) return keep
  const used = new Set(db.seatRuntimesOf(companyId).map((r) => r.slot))
  let i = 0
  while (used.has(i)) i += 1
  return i
}

export function companyMachineOf(db: Db, companyId: string): Machine | undefined {
  const company = db.company(companyId)
  if (!company) return
  if (company.machineId) {
    const m = db.machine(company.machineId)
    if (m) return m
  }
  return db.machineOfCompany(companyId)
}

export function machineBound(m: Machine | undefined): m is Machine {
  return Boolean(m && (m.sshHost || '').trim())
}

export function machineHasSshAuth(m: Machine | undefined): m is Machine {
  return Boolean(machineBound(m) && m.sshSecret)
}

export interface DeployResult {
  runtime: SeatRuntime
  machine: Machine
}

/**
 * Allocate (or reuse) a slot and deploy this seat.
 * Stub: SATUWORK_DEPLOY_STUB=1 writes ready + instances.host, no SSH.
 * Live: SSH as debian (sudo) and start slim-desktop@ + satuwork-bot@.
 */
export async function deploySeat(
  db: Db,
  keys: JwtKeys,
  account: Account,
  opts: { botId: string; version?: string; update?: boolean },
): Promise<
  | { ok: true; result: DeployResult }
  | { ok: false; status: number; error: string; runtime: SeatRuntime | undefined }
> {
  const companyId = account.companyId
  if (!companyId) return { ok: false, status: 403, error: '没有公司席位', runtime: undefined }
  const botId = (opts.botId || '').trim()
  if (!botId) return { ok: false, status: 400, error: 'botId 不能为空', runtime: undefined }
  const visible = db.visibleCatalog('bot', companyId)
  if (!visible.some((b) => b.id === botId)) {
    return { ok: false, status: 404, error: '没有这个 Bot', runtime: undefined }
  }
  const machine = companyMachineOf(db, companyId)
  if (!machineBound(machine)) {
    return { ok: false, status: 409, error: '公司还没有绑定运行机器', runtime: undefined }
  }
  if (!machineHasSshAuth(machine)) {
    return { ok: false, status: 409, error: '运行机器还没有配置 SSH 登录', runtime: undefined }
  }

  const requested = (opts.version || '').trim()
  let version: string
  if (requested) {
    const rel = db.botRelease(requested)
    if (!rel) return { ok: false, status: 404, error: '没有这个 Bot 版本', runtime: db.seatRuntime(account.id, botId) }
    version = rel.version
  } else {
    const latest = db.latestBotRelease()
    if (!latest) return { ok: false, status: 409, error: '还没有发布 Bot 版本', runtime: db.seatRuntime(account.id, botId) }
    version = latest.version
  }

  const linuxUser = linuxUserOf(account.id, botId)
  const existing = db.seatRuntime(account.id, botId)
  if (existing?.status === 'ready' && existing.botVersion === version && !opts.update) {
    return { ok: true, result: { runtime: existing, machine } }
  }

  const vncPassword = existing?.vncPassword || randomVncPassword()
  let row: SeatRuntime | undefined
  for (let i = 0; i < 8; i++) {
    try {
      row = db.tx(() => {
        const slot = allocateSlot(db, companyId, i === 0 ? existing?.slot : undefined)
        const ports = portsOf(slot)
        const now = Date.now()
        return db.upsertSeatRuntime({
          accountId: account.id,
          botId,
          companyId,
          linuxUser,
          slot,
          display: ports.display,
          vncPort: ports.vncPort,
          novncPort: ports.novncPort,
          botPort: ports.botPort,
          vncPassword,
          status: 'deploying',
          lastError: null,
          deployedAt: existing?.deployedAt ?? null,
          updatedAt: now,
          botVersion: existing?.botVersion ?? null,
        })
      })
      break
    } catch (e) {
      if (i === 7 || !isUniqueViolation(e)) throw e
    }
  }
  if (!row) return { ok: false, status: 500, error: '无法分配席位槽', runtime: existing }

  if (process.env.SATUWORK_DEPLOY_STUB === '1') {
    const ready = db.upsertSeatRuntime({
      ...row,
      status: 'ready',
      lastError: null,
      deployedAt: Date.now(),
      updatedAt: Date.now(),
      botVersion: version,
    })
    db.upsertInstance({
      accountId: account.id,
      botId,
      companyId,
      host: `http://127.0.0.1:${row.botPort}`,
    })
    return { ok: true, result: { runtime: ready, machine } }
  }

  const tgz = botReleaseFile(version)
  if (!existsSync(tgz)) {
    const failed = db.upsertSeatRuntime({
      ...row,
      status: 'error',
      lastError: '发布包文件不存在',
      updatedAt: Date.now(),
    })
    return { ok: false, status: 502, error: '发布包文件不存在', runtime: failed }
  }

  const secrets = db.ensureAccountSecrets(account.id)
  if (!secrets) {
    const failed = db.upsertSeatRuntime({
      ...row,
      status: 'error',
      lastError: '没有席位密钥',
      updatedAt: Date.now(),
    })
    return { ok: false, status: 500, error: '没有席位密钥', runtime: failed }
  }
  const deployTarget: SshTarget = {
    linuxUser,
    ports: portsOf(row.slot),
    vncPassword,
    gatewayUrl: gatewayPublicUrl(),
    gatewayToken: secrets.accessToken,
    gatewayApiKey: secrets.apiKey,
    machineToken: machine.token || '',
    botId,
    botVersion: version,
    botTgz: tgz,
  }
  try {
    await sshDeploy(machine, deployTarget)
  } catch (e) {
    const message = sanitizeError(e, deploySecrets(machine, deployTarget))
    const failed = db.upsertSeatRuntime({
      ...row,
      status: 'error',
      lastError: message,
      updatedAt: Date.now(),
    })
    return { ok: false, status: 502, error: message, runtime: failed }
  }

  const ready = db.upsertSeatRuntime({
    ...row,
    status: 'ready',
    lastError: null,
    deployedAt: Date.now(),
    updatedAt: Date.now(),
    botVersion: version,
  })
  db.upsertInstance({
    accountId: account.id,
    botId,
    companyId,
    host: `http://${machine.sshHost!.trim()}:${row.botPort}`,
  })
  return { ok: true, result: { runtime: ready, machine } }
}

function sanitizeError(e: unknown, secrets: string[] = []): string {
  const raw = e instanceof Error ? e.message : String(e)
  return stripSecrets(raw.replace(/\s+/g, ' ').trim(), secrets).slice(0, 500) || '部署失败'
}
const seatDir = join(dirname(fileURLToPath(import.meta.url)), 'seat')

interface SshTarget {
  linuxUser: string
  ports: SeatPorts
  vncPassword: string
  gatewayUrl: string
  gatewayToken: string
  gatewayApiKey: string
  machineToken: string
  botId: string
  botVersion: string
  botTgz: string
}

function b64File(name: string): string {
  return readFileSync(join(seatDir, name)).toString('base64')
}

async function sshDeploy(machine: Machine, target: SshTarget): Promise<void> {
  const host = machine.sshHost!.trim()
  const port = machine.sshPort || 22
  const user = (machine.sshUser || 'debian').trim() || 'debian'
  const secret = machine.sshSecret || ''
  const script = remoteScript(target)
  const tmp = mkdtempSync(join(tmpdir(), 'satuwork-deploy-'))
  const remoteTgz = `/tmp/satuwork-bot-${target.botVersion}.tgz`
  try {
    const common = ['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=20']
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env.SSHPASS
    if (machine.sshAuth === 'key') {
      const keyPath = join(tmp, 'id_deploy')
      writeFileSync(keyPath, secret.endsWith('\n') ? secret : secret + '\n', { mode: 0o600 })
      common.push('-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-i', keyPath)
    } else {
      env.SSHPASS = secret
      common.push(
        '-o',
        'PreferredAuthentications=password',
        '-o',
        'PubkeyAuthentication=no',
        '-o',
        'NumberOfPasswordPrompts=1',
      )
    }
    const dest = `${user}@${host}`
    const scpBin = machine.sshAuth === 'key' ? 'scp' : 'sshpass'
    const scpArgs =
      machine.sshAuth === 'key'
        ? [...common, '-P', String(port), target.botTgz, `${dest}:${remoteTgz}`]
        : ['-e', 'scp', ...common, '-P', String(port), target.botTgz, `${dest}:${remoteTgz}`]
    try {
      await run(scpBin, scpArgs, { env, timeout: 300_000, input: '', cwd: tmp, secrets: deploySecrets(machine, target) })
    } catch (e) {
      const msg = sanitizeError(e, deploySecrets(machine, target))
      throw new Error(msg.startsWith('scp') ? msg : 'scp 失败: ' + msg)
    }
    const sshArgs = [...common, '-p', String(port), dest, 'bash -s']
    const file = machine.sshAuth === 'key' ? 'ssh' : 'sshpass'
    const args = machine.sshAuth === 'key' ? sshArgs : ['-e', 'ssh', ...sshArgs]
    await run(file, args, { env, timeout: 180_000, input: script, cwd: tmp, secrets: deploySecrets(machine, target) })
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {}
  }
}

function run(
  file: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeout: number; input: string; cwd: string; secrets: string[] },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: opts.env, cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      reject(new Error(file === 'scp' || args.includes('scp') ? 'scp 超时' : 'ssh 超时'))
    }, opts.timeout)
    let stderr = ''
    let stdout = ''
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      const msg = e instanceof Error ? e.message : String(e)
      if (file === 'sshpass' && /ENOENT/.test(msg)) reject(new Error('本机没有 sshpass，无法用密码登录'))
      else reject(new Error(stripSecrets(msg, opts.secrets)))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        resolve()
        return
      }
      if (code === 42) {
        reject(new Error(stripSecrets((stderr || stdout || '机器上还没有 Bot 运行时').trim(), opts.secrets)))
        return
      }
      reject(new Error(stripSecrets((stderr || stdout || 'ssh 退出 ' + code).trim(), opts.secrets)))
    })
    try {
      if (opts.input) child.stdin.write(opts.input)
      child.stdin.end()
    } catch {}
  })
}

function deploySecrets(machine: Machine, t: SshTarget): string[] {
  return [machine.sshSecret || '', t.gatewayToken, t.gatewayApiKey, t.machineToken, t.vncPassword].filter(Boolean)
}

function stripSecrets(text: string, secrets: string | string[] = []): string {
  let s = text
  const list = typeof secrets === 'string' ? (secrets ? [secrets] : []) : secrets
  for (const secret of list) {
    if (secret) s = s.split(secret).join('***')
  }
  s = s.replace(/SSHPASS=\S+/g, 'SSHPASS=***')
  s = s.replace(/gatewayToken[=:]\S+/gi, 'gatewayToken=***')
  s = s.replace(/gatewayApiKey[=:]\S+/gi, 'gatewayApiKey=***')
  s = s.replace(/machineToken[=:]\S+/gi, 'machineToken=***')
  s = s.replace(/vncPassword[=:]\S+/gi, 'vncPassword=***')
  s = s.replace(/\bsat_[A-Za-z0-9_-]+/g, 'sat_***')
  s = s.replace(/\bsk_sw_[A-Za-z0-9_-]+/g, 'sk_sw_***')
  s = s.replace(/\bsmt_[A-Za-z0-9_-]+/g, 'smt_***')
  return s
}

function remoteScript(t: SshTarget): string {
  let tpl = readFileSync(join(seatDir, 'remote-deploy.sh'), 'utf8')
  const picom = Buffer.from('backend = "xrender";\nvsync = false;\nuse-damage = false;\n', 'utf8').toString('base64')
  const vars: Record<string, string> = {
    __LINUX_USER__: t.linuxUser,
    __HOME_DIR__: '/home/' + t.linuxUser,
    __SW_HOME__: '/home/' + t.linuxUser + '/.satuwork',
    __DISPLAY_NUM__: String(t.ports.display),
    __RFB__: String(t.ports.vncPort),
    __HTTP__: String(t.ports.novncPort),
    __BOT_PORT__: String(t.ports.botPort),
    __CDP__: String(t.ports.cdpPort),
    __DISPLAY_VAR__: ':' + t.ports.display,
    __BOT_VERSION__: t.botVersion,
    __BOT_TGZ_Q__: shQuote(`/tmp/satuwork-bot-${t.botVersion}.tgz`),
    __BOT_EXTRACT_Q__: shQuote(`/opt/satuwork/releases/${t.botVersion}`),
    __VNC_PASSWORD_Q__: shQuote(t.vncPassword),
    __GATEWAY_URL_Q__: shQuote(t.gatewayUrl),
    __GATEWAY_TOKEN_Q__: shQuote(t.gatewayToken),
    __GATEWAY_API_KEY_Q__: shQuote(t.gatewayApiKey),
    __MACHINE_TOKEN_Q__: shQuote(t.machineToken),
    __BOT_ID_Q__: shQuote(t.botId),
    __DESK_B64_Q__: shQuote(b64File('slim-desktop.sh')),
    __DESK_UNIT_B64_Q__: shQuote(b64File('slim-desktop@.service')),
    __BOT_UNIT_B64_Q__: shQuote(b64File('satuwork-bot@.service')),
    __PICOM_B64_Q__: shQuote(picom),
  }
  for (const [k, v] of Object.entries(vars)) tpl = tpl.split(k).join(v)
  return tpl
}
