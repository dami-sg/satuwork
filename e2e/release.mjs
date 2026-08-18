/**
 * e2e 里造发布包。
 *
 * 源码打包那条路（`POST /platform/bot-releases`）已经拆掉了——它只有本地开发的
 * Gateway 能走，而且打出来的包带的是**本机**的 esbuild 原生二进制，传到席位机器上
 * 起不来。现在只剩一条上传路径，测试也走同一条。
 *
 * 这里手搓 tar.gz 而不是调 `tar`：测的是 Gateway 的解析，不是本机 tar 的方言。
 */
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'

/** 最小 ustar tar.gz。`files` 是 `{ name, data }`。 */
export function tarGz(files) {
  const blocks = []
  for (const f of files) {
    const data = Buffer.from(f.data, 'utf8')
    const h = Buffer.alloc(512)
    h.write(f.name, 0, 100, 'utf8')
    h.write('000644 \0', 100, 8)
    h.write('000000 \0', 108, 8)
    h.write('000000 \0', 116, 8)
    h.write(data.length.toString(8).padStart(11, '0') + ' ', 124, 12)
    h.write('00000000000 ', 136, 12)
    h.write('        ', 148, 8) // 先按空格算校验和
    h.write('0', 156, 1)
    h.write('ustar\0', 257, 6)
    h.write('00', 263, 2)
    let sum = 0
    for (const b of h) sum += b
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024)) // 结束块
  return gzipSync(Buffer.concat(blocks))
}

export function sha256Of(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

/**
 * 传一个能过校验的最小发布包。Gateway 只检查入口文件在不在，不解包，所以两个文件
 * 就够——测试要的是「有一个可部署的版本」，不是一份能跑的 bot。
 */
export async function publishRelease({ req, gwBase, token, version, note = '', kind = 'bot' }) {
  const entry = kind === 'manager' ? 'bin/satuwork-manager.mjs' : 'bin/satuwork.mjs'
  const tgz = tarGz([
    { name: `./${entry}`, data: `#!/usr/bin/env node\n// e2e ${kind} ${version}\n` },
    { name: './VERSION', data: version + '\n' },
  ])
  const path = kind === 'manager' ? 'manager-releases' : 'bot-releases'
  const r = await req(gwBase, 'PUT', `/platform/${path}/${encodeURIComponent(version)}${note ? '?note=' + encodeURIComponent(note) : ''}`, {
    token,
    raw: tgz,
    headers: { 'x-bot-sha256': sha256Of(tgz) },
  })
  if (r.status !== 200) throw new Error(`publish ${kind} ${version} → ${r.status} ${r.text}`)
  return { release: r.json.release, tgz, sha256: sha256Of(tgz) }
}
