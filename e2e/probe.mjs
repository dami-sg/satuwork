/**
 * 探针跑法与「别永远等下去」这两件事，统一放在这儿。
 *
 * 二十多个套件各抄了一份一模一样的 runProbe，其中十八份**没有超时**：探针一挂，
 * `child.on('close')` 就永远不来，整套 e2e 停在那一行，屏幕上最后一句是上一条 `ok`——
 * 既不知道卡在哪个套件，也不知道卡了多久。这正是「跑一晚上还没完」的样子。
 *
 * 超时不是保险丝，是**诊断**：探针挂住本身就是一次失败，它必须带着名字报出来。
 */
import { spawn } from 'node:child_process'
import { basename, dirname, join } from 'node:path'

/** 探针默认额度。真起 Chrome / 真等心跳那几个自己传大一点的数。 */
export const PROBE_TIMEOUT_MS = Number(process.env.E2E_PROBE_TIMEOUT_MS) || 60_000

/**
 * 跑一个要 tsx 的探针，把它 `__RESULT__` 那一行解出来。
 *
 * `script` 是相对仓库根的路径（如 `bot/e2e-compact.mjs`）；cwd 取它所在的包目录——
 * `--import tsx` 是按 cwd 解析的，从别处跑会以 ERR_MODULE_NOT_FOUND 当场死掉。
 *
 * `skippable`：探针可以打印 `__SKIP__<理由>` 表示这台机器上跑不了（如没装 Chrome），
 * 这时返回 `{ skip }` 而不是抛错。
 */
export function runProbe(root, script, { env, args = [], timeout = PROBE_TIMEOUT_MS, skippable = false } = {}) {
  const file = join(root, script)
  const name = basename(script)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', file, ...args], {
      cwd: dirname(file),
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    // 挂住的探针必须自己变成一条失败，而不是把整套 e2e 一起拖死。
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`探针 ${name} ${Math.round(timeout / 1000)} 秒没跑完\n${err || out}`))
    }, timeout)
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const lines = out.split('\n')
      if (skippable) {
        const skip = lines.find((l) => l.startsWith('__SKIP__'))
        if (skip) return resolve({ skip: skip.slice('__SKIP__'.length) })
      }
      const line = lines.find((l) => l.startsWith('__RESULT__'))
      if (code !== 0 || !line) return reject(new Error(`探针 ${name} 退出 ${code}\n${err || out}`))
      try {
        resolve(JSON.parse(line.slice('__RESULT__'.length)))
      } catch (e) {
        reject(new Error(`探针 ${name} 输出解析失败：${e.message}\n${line}`))
      }
    })
  })
}

/**
 * 关掉一个 http.Server，**先掐连接再关**。
 *
 * `server.close()` 只是不再收新连接，已经建起来的它会一直等着对方自己断开。而对面
 * 是 Gateway 的反代（keep-alive）或者一条还开着的 SSE——那个「自己断开」永远不会来，
 * 套件就停在 finally 里，看起来跟测试卡死一模一样。
 */
export function closeServer(server, what = 'server', ms = 5_000) {
  if (!server) return Promise.resolve()
  // 已经不 listening 了也要掐一遍连接：留下来的那些 socket 正是让进程到最后空不掉
  // 事件循环的东西。
  server.closeAllConnections?.()
  if (!server.listening) return Promise.resolve()
  return withDeadline(new Promise((r) => server.close(() => r())), `关掉 ${what}`, ms).catch(() => {})
}

/**
 * 给一个 promise 加一道墙钟闸；超了就带着名字抛出来，而不是继续等。
 *
 * 抛出来的错带 `deadline: true`——调用方要分得清「卡住了」和「跑出错了」，这两种
 * 的处理不一样，而按错误文案去猜迟早会猜错。
 *
 * **这个 timer 不 unref。** unref 的意思是「别为我留着事件循环」，而被等的那件事挂住时
 * 手上恰恰可能一个句柄都没有——那时候 Node 会以退出码 0 悄悄结束，一行结论都不打，CI
 * 看到的是绿加半截日志，比原来那个明摆着的挂起还难认。多留一个 timer 不花什么：成功
 * 路径上面那句 `.finally` 已经把它清掉了。
 */
export function withDeadline(p, what, ms) {
  let timer
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    new Promise((_, bad) => {
      timer = setTimeout(() => {
        const e = new Error(`卡在「${what}」超过 ${Math.round(ms / 1000)} 秒`)
        e.deadline = true
        bad(e)
      }, ms)
    }),
  ])
}
