#!/usr/bin/env node
/**
 * 给已安装的 Desktop 打一份可热替换的本地 Bot 运行时。
 *
 * 包不带 Node：Node 随 Desktop 安装器分发；这里只放 bot + 已实体化依赖。tsx/esbuild
 * 含原生模块，所以平台和架构必须进入版本号，Gateway 才能给每台机器选对包。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = dirname(dirname(fileURLToPath(import.meta.url)))
const root = dirname(desktop)

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

function die(message) {
  console.error(`local-runtime-pack: ${message}`)
  process.exit(1)
}

const platform = { darwin: 'darwin', win32: 'windows', linux: 'linux' }[process.platform]
const arch = { x64: 'x64', arm64: 'arm64' }[process.arch]
if (!platform || !arch) die(`暂不支持 ${process.platform}-${process.arch}`)

const pkg = JSON.parse(readFileSync(join(root, 'bot/package.json'), 'utf8'))
const base = String(arg('version') || pkg.version || '').trim()
const version = `${base}-${platform}-${arch}`
if (!/^[A-Za-z0-9._+-]{1,64}$/.test(version)) {
  die(`版本号 ${version} 不合法或超过 64 位`)
}

const out = resolve(arg('out') || join(root, 'dist', `local-bot-${version}.tgz`))
const packed = spawnSync(
  process.execPath,
  [
    join(root, 'bot/pack.mjs'),
    '--allow-foreign-platform',
    '--version',
    version,
    '--out',
    out,
  ],
  { cwd: root, stdio: 'inherit' },
)
if (packed.status !== 0) process.exit(packed.status || 1)
console.log(`local-runtime-pack: ${out}`)
