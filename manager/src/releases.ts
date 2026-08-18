import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { releaseRoot } from './config.ts'
import { run } from './run.ts'

/**
 * 发布包缓存。
 *
 * 取代了原来「每部署一个席位就 scp 一遍完整安装包」：管家在本机，同一个版本拉一次、
 * 解一次，之后所有席位从 `releases/<version>/` 拷。
 *
 * `VERSION` 文件是「解完整了」的标记，最后写。中途失败留下的半个目录下次会被整个
 * 删掉重来——只判断目录存在会把半个包当成好包用。
 */

export function releaseDir(version: string): string {
  return join(releaseRoot(), version)
}

export function haveRelease(version: string): boolean {
  try {
    return readFileSync(join(releaseDir(version), 'VERSION'), 'utf8').trim() === version
  } catch {
    return false
  }
}

/** 版本号进路径，得先确认它不能往上跳。Gateway 那边也校验，这里不依赖它。 */
function safeVersion(version: string): string {
  if (!/^[A-Za-z0-9._+-]{1,64}$/.test(version) || version.startsWith('.')) {
    throw new Error(`invalid version: ${version}`)
  }
  return version
}

export async function ensureRelease(
  version: string,
  opts: { gatewayUrl: string; token: string },
): Promise<string> {
  safeVersion(version)
  const dir = releaseDir(version)
  if (haveRelease(version)) return dir

  const url = `${opts.gatewayUrl}/internal/bot-releases/${encodeURIComponent(version)}`
  const res = await fetch(url, {
    headers: { authorization: 'Bearer ' + opts.token },
    signal: AbortSignal.timeout(300_000),
  })
  if (!res.ok) throw new Error(`downloading release ${version} failed: ${res.status} ${(await res.text()).slice(0, 200)}`)
  const bytes = Buffer.from(await res.arrayBuffer())

  // Gateway 在响应头里给 sha256。对不上就是传输坏了——解开只会得到更难查的症状。
  const want = String(res.headers.get('x-bot-sha256') || '').trim()
  if (want) {
    const got = createHash('sha256').update(bytes).digest('hex')
    if (got !== want) throw new Error(`release ${version} checksum mismatch: ${got.slice(0, 12)} != ${want.slice(0, 12)}`)
  }

  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const tgz = join(releaseRoot(), `.${version}.tgz`)
  writeFileSync(tgz, bytes)
  try {
    const r = await run('tar', ['-xzf', tgz, '-C', dir], { timeout: 300_000 })
    if (r.code !== 0) throw new Error(`untarring ${version} failed: ${(r.stderr || r.stdout).slice(-300)}`)
    if (!existsSync(join(dir, 'bin', 'satuwork.mjs'))) {
      throw new Error(`release ${version} has no bin/satuwork.mjs`)
    }
    writeFileSync(join(dir, 'VERSION'), version + '\n')
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  } finally {
    rmSync(tgz, { force: true })
  }
  return dir
}
