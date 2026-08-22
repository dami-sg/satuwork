import { spawn } from 'node:child_process'

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * 跑一个外部命令，把两股输出都收齐。
 *
 * 输出**截断在 64 KiB**：`apt-get install` 一次能刷出几兆，全留着只会把内存和上报给
 * Gateway 的错误信息一起撑爆。出错时有用的永远是最后几行，所以留尾不留头。
 */
export function run(
  file: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv; timeout?: number; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const cap = (s: string, chunk: string) => (s + chunk).slice(-65536)
    child.stdout.on('data', (d) => {
      stdout = cap(stdout, String(d))
    })
    child.stderr.on('data', (d) => {
      stderr = cap(stderr, String(d))
    })
    const timer = setTimeout(
      () => {
        try {
          child.kill('SIGKILL')
        } catch {}
        stderr = cap(stderr, `\n[manager] ${file} timed out`)
      },
      opts.timeout ?? 600_000,
    )
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: cap(stderr, String(e instanceof Error ? e.message : e)) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr })
    })
  })
}

/**
 * 出错信息压成一行，给 Gateway 看。保留尾部——报错都在最后。
 *
 * 两处是踩过坑之后改的：
 *
 * **退出码永远带上。** 原先它藏在 `fallback` 里，而 `fallback` 只在两个流都空的时候
 * 才用得上。可失败的那条命令**很可能什么都不打印**（mkdir、chown、systemctl 都是这
 * 样），偏偏前面又有一堆正常的进度输出——于是消息里全是无关的话，唯一有用的「exited
 * 几」被挤掉了。
 *
 * **stdout 也留一段。** stderr 优先没错，但这个脚本的进度打在 stdout 上；出错那一步
 * 静默时，stdout 的末尾就是「走到哪儿了」，那是唯一的线索。
 */
export function tailError(r: RunResult, fallback: string): string {
  const one = (s: string) => (s || '').replace(/\s+/g, ' ').trim()
  const err = one(r.stderr)
  const out = one(r.stdout)
  const head = typeof r.code === 'number' && r.code !== 0 ? `exited ${r.code}` : fallback
  const body = [err && `stderr: ${err.slice(-400)}`, out && `stdout: ${out.slice(-400)}`].filter(Boolean).join(' | ')
  return body ? `${head} — ${body}` : head || fallback
}

/**
 * 跑一遍，只要 stdout；非零和抛异常都当「什么都没看到」。
 *
 * 「看一眼现场」这类活儿（诊断、回收端口）不该因为少一个工具就整件挂掉——老镜像
 * 上没有 ss、没有 journalctl 是常事，而那正是最需要看现场的时候。
 */
export async function tryRun(file: string, args: string[], timeout = 8000): Promise<string> {
  try {
    const r = await run(file, args, { timeout })
    return r.code === 0 ? r.stdout : ''
  } catch {
    return ''
  }
}
