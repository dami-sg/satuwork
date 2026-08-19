/**
 * 部署失败时报回去的那句话。
 *
 * 这一组是补票：一次真实的部署失败在界面上只显示到「Adding new group (1003) .」就断了，
 * 而真正的原因——脚本在哪一步、退出码多少——一个字都没有。两处叠在一起造成的：管家把
 * 退出码藏在只在两流皆空时才用的兜底里，Gateway 又在 JSON.parse 之前把响应体砍到 400 字。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

function runProbe(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'manager/e2e-deploy-errors.mjs')], {
      cwd: join(root, 'manager'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('__RESULT__'))
      if (code !== 0 || !line) {
        reject(new Error(`探针退出 ${code}\n${err || out}`))
        return
      }
      resolve(JSON.parse(line.slice('__RESULT__'.length)))
    })
  })
}

export async function runDeployErrors({ root, test, assert, log }) {
  log('\n# deploy-errors')
  const r = await runProbe(root)

  await test('失败的命令一声不吭时，退出码必须还在', async () => {
    // 这就是那次真实故障：脚本非零退出，stderr 空，stdout 里全是无关的正常进度。
    // 原先的取法是 `stderr || stdout || fallback`——stdout 非空，于是兜底里那句
    // 「exited 3」永远轮不上，界面上只剩一堆进度。
    assert(r.silentFailure.includes('exited 3'), `没带退出码：${r.silentFailure}`)
    assert(r.silentFailure.includes('chrome: 已在位'), `没带上走到哪儿了：${r.silentFailure}`)
  })

  await test('两个流都空：至少说得出退出码', async () => {
    assert(r.bothEmpty.includes('exited 137'), `${r.bothEmpty}`)
  })

  await test('stderr 有内容也不丢 stdout——一个说为什么，一个说走到哪儿', async () => {
    assert(r.bothStreams.includes('第 42 行失败'), `丢了 stderr：${r.bothStreams}`)
    assert(r.bothStreams.includes('进度B'), `丢了 stdout：${r.bothStreams}`)
  })

  await test('超长输出留尾不留头', async () => {
    assert(r.longTail.includes('最后一句'), `把结尾截掉了：${r.longTail.slice(0, 80)}…`)
    assert(!r.longTail.includes('OUT-0 '), '把开头留下了，那儿没有原因')
  })

  await test('退出码为 0 时不硬说 exited 0，走兜底', async () => {
    assert(r.code0 === '兜底', `${r.code0}`)
  })
}
