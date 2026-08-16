import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BotRelease, Db } from './db.ts'
import { gatewayHome } from './home.ts'
import { HttpError } from './http.ts'

const VERSION_RE = /^[A-Za-z0-9._+-]+$/
const gatewayRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

export function parseBotVersion(raw: string): string {
  const version = String(raw || '').trim()
  if (!version || version.length > 64 || !VERSION_RE.test(version)) {
    throw new HttpError(400, 'version 须为 1–64 位字母数字或 . _ + -')
  }
  return version
}

export function botSrcPath(): string {
  const env = (process.env.SATUWORK_BOT_SRC || '').trim()
  if (env) return resolve(env)
  return resolve(join(gatewayRoot, '..', 'bot'))
}

export function botReleaseDir(): string {
  return gatewayHome('releases')
}

export function botReleaseFile(version: string): string {
  return join(botReleaseDir(), `bot-${version}.tgz`)
}

export function publicBotRelease(row: BotRelease) {
  return {
    version: row.version,
    sha256: row.sha256,
    size: row.size,
    createdAt: row.createdAt,
    note: row.note,
  }
}

export function botSrcVersion(): { version?: string } {
  const src = botSrcPath()
  const pkg = join(src, 'package.json')
  if (!existsSync(pkg)) return {}
  try {
    const raw = JSON.parse(readFileSync(pkg, 'utf8')) as { version?: unknown }
    const version = typeof raw.version === 'string' ? raw.version.trim() : ''
    return version ? { version } : {}
  } catch {
    return {}
  }
}

function srcMissing(src: string): boolean {
  try {
    return !existsSync(src) || !statSync(src).isDirectory()
  } catch {
    return true
  }
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(path)
    s.on('data', (d) => h.update(d))
    s.on('error', reject)
    s.on('end', () => resolveHash(h.digest('hex')))
  })
}

function tarFail(r: ReturnType<typeof spawnSync>): never {
  const msg = String(r.stderr || r.stdout || '打包失败')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400)
  throw new HttpError(500, msg || '打包失败')
}

function packTree(src: string, dest: string, version: string) {
  if (!existsSync(join(src, 'bin', 'satuwork.mjs'))) {
    throw new HttpError(400, 'Bot 源码缺少 bin/satuwork.mjs')
  }
  const tmp = mkdtempSync(join(tmpdir(), 'satuwork-bot-ver-'))
  try {
    writeFileSync(join(tmp, 'VERSION'), version + '\n')
    const r = spawnSync(
      'tar',
      [
        '-czf',
        dest,
        '--exclude=node_modules/.cache',
        '--exclude=.data',
        '--exclude=*.log',
        '--exclude=cordis.e2e.yml',
        '--exclude=VERSION',
        '-C',
        src,
        '.',
        '-C',
        tmp,
        'VERSION',
      ],
      { encoding: 'utf8' },
    )
    if (r.status !== 0) tarFail(r)
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {}
  }
}

function packStub(dest: string, version: string) {
  const tmp = mkdtempSync(join(tmpdir(), 'satuwork-bot-stub-'))
  try {
    mkdirSync(join(tmp, 'bin'), { recursive: true })
    writeFileSync(
      join(tmp, 'package.json'),
      JSON.stringify({ name: 'satuwork', version, private: true, type: 'module' }) + '\n',
    )
    writeFileSync(join(tmp, 'bin', 'satuwork.mjs'), '#!/usr/bin/env node\nconsole.log("satuwork-bot stub")\n')
    writeFileSync(join(tmp, 'VERSION'), version + '\n')
    const r = spawnSync('tar', ['-czf', dest, '-C', tmp, '.'], { encoding: 'utf8' })
    if (r.status !== 0) tarFail(r)
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true })
    } catch {}
  }
}

export async function publishBotRelease(db: Db, input: { version: string; note?: string }): Promise<BotRelease> {
  const version = parseBotVersion(input.version)
  const note = String(input.note ?? '').trim()
  if (db.botRelease(version)) throw new HttpError(409, '这个版本已经发布过')
  mkdirSync(botReleaseDir(), { recursive: true })
  const dest = botReleaseFile(version)
  if (existsSync(dest)) {
    try {
      unlinkSync(dest)
    } catch {}
  }
  const src = botSrcPath()
  if (srcMissing(src)) {
    if (process.env.SATUWORK_DEPLOY_STUB === '1') packStub(dest, version)
    else throw new HttpError(400, 'Bot 源码不存在')
  } else {
    packTree(src, dest, version)
  }
  try {
    const st = statSync(dest)
    const sha256 = await sha256File(dest)
    const row: BotRelease = {
      version,
      sha256,
      size: st.size,
      createdAt: Date.now(),
      note,
    }
    try {
      db.insertBotRelease(row)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (/UNIQUE|constraint/i.test(msg)) throw new HttpError(409, '这个版本已经发布过')
      throw e
    }
    return row
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 409)) {
      try {
        unlinkSync(dest)
      } catch {}
    }
    throw e
  }
}
