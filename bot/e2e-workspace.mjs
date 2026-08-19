/**
 * 工作区的边界语义。探针要 tsx 才 import 得了 .ts。
 *
 * 这里钉的几乎全是**安全边界**：路径能不能逃出工作区、上传的文件名会不会变成路径、
 * 哪些类型允许浏览器内联。这类错不会在日常使用里露面——它要等到有人专门去试才发作，
 * 所以只能靠断言守着。
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceService, contentTypeOf, safeName } from './src/workspace/index.ts'

const root = mkdtempSync(join(tmpdir(), 'satu-ws-'))
const ctx = new Context()
ctx.plugin(WorkspaceService, { root, uploadMax: 1024 })
// plugin() 是异步生效的，等一拍再用。
await new Promise((r) => setTimeout(r, 50))
const ws = ctx.workspace

const out = {}
const throws = (fn) => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

// ── 1. 越界 ───────────────────────────────────────────────────────────
out.escape = {
  上跳: throws(() => ws.resolve('../../../etc/passwd')),
  绕一圈上跳: throws(() => ws.resolve('a/b/../../../../etc/passwd')),
  绝对路径: throws(() => ws.resolve('/etc/passwd')),
  根自己可以: !throws(() => ws.resolve('.')),
  正常路径可以: !throws(() => ws.resolve('a/b/c.txt')),
  // 前缀相同但不是子目录的兄弟目录：`/work` 与 `/workx`，只比字符串前缀会漏掉。
  同前缀兄弟目录: throws(() => ws.resolve('../' + root.split('/').pop() + 'x/evil')),
}

// ── 2. 文件名清洗 ─────────────────────────────────────────────────────
out.names = {
  上跳变普通名: safeName('../../evil.sh'),
  反斜杠也算分隔符: safeName('..\\..\\evil.sh'),
  纯点号不留: safeName('...'),
  空名有兜底: safeName(''),
  中文原样留着: safeName('二季度报表.xlsx'),
  控制字符剔掉: safeName('a\nb\tc.txt'),
  超长截断: safeName('x'.repeat(400)).length,
}

// ── 3. 内联白名单 ─────────────────────────────────────────────────────
out.inline = {
  png: contentTypeOf('a.png').inline,
  pdf: contentTypeOf('a.pdf').inline,
  // 这两个能带 <script>，内联等于在 Gateway 的源上执行上传者的代码。
  svg: contentTypeOf('a.svg').inline,
  html: contentTypeOf('a.html').inline,
  未知格式: contentTypeOf('a.wat').inline,
  未知格式的类型: contentTypeOf('a.wat').contentType,
  大写后缀也认: contentTypeOf('A.PNG').inline,
  markdown按纯文本发: contentTypeOf('a.md').contentType,
}

// ── 4. 上传落盘 ───────────────────────────────────────────────────────
const streamOf = (...chunks) =>
  new ReadableStream({
    start(c) {
      for (const x of chunks) c.enqueue(typeof x === 'string' ? new TextEncoder().encode(x) : x)
      c.close()
    },
  })

const saved = await ws.saveUpload('sess-1', 'hello.txt', streamOf('hello ', 'world'))
out.upload = {
  路径在uploads下: saved.path,
  大小: saved.size,
  内容: readFileSync(join(root, saved.path), 'utf8'),
}

// 同名再传一次：不能覆盖前一份
const again = await ws.saveUpload('sess-1', 'hello.txt', streamOf('second'))
out.collision = {
  换了名字: again.path !== saved.path,
  新路径: again.path,
  头一份还在: readFileSync(join(root, saved.path), 'utf8'),
}

// 文件名想逃出去：只能落在 uploads 里
const evil = await ws.saveUpload('sess-2', '../../../../etc/cron.d/pwn', streamOf('x'))
out.evilName = {
  落点: evil.path,
  没跑出uploads: evil.path.startsWith('uploads/'),
  外面没被写: !existsSync('/etc/cron.d/pwn'),
}

// sessionId 想逃出去：同样只能落在 uploads 里
const evilSession = await ws.saveUpload('../../..', 'a.txt', streamOf('x'))
out.evilSession = { 落点: evilSession.path, 没跑出uploads: evilSession.path.startsWith('uploads/') }

// ── 5. 超限：中断，且不留半个文件 ─────────────────────────────────────
let tooBig = ''
const before = await readdir(join(root, 'uploads', 'sess-3')).catch(() => [])
try {
  await ws.saveUpload('sess-3', 'big.bin', streamOf('x'.repeat(2000)))
} catch (e) {
  tooBig = e.message
}
const after = await readdir(join(root, 'uploads', 'sess-3')).catch(() => [])
out.tooBig = { 报错: Boolean(tooBig), 消息: tooBig, 没留残骸: after.length === before.length }

// ── 6. 读回来预览 ─────────────────────────────────────────────────────
mkdirSync(join(root, 'sub'), { recursive: true })
writeFileSync(join(root, 'sub/pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
const opened = await ws.open('sub/pic.png')
const chunks = []
for await (const c of opened.stream) chunks.push(Buffer.from(c))
out.open = {
  类型: opened.contentType,
  能内联: opened.inline,
  大小: opened.size,
  字节读得回来: Buffer.concat(chunks).toString('hex'),
}
out.openEscape = await ws
  .open('../../../etc/passwd')
  .then(() => false)
  .catch(() => true)

console.log('__RESULT__' + JSON.stringify(out))
