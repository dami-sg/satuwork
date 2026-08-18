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

/** 出错信息压成一行，给 Gateway 看。保留尾部——报错都在最后。 */
export function tailError(r: RunResult, fallback: string): string {
  const raw = (r.stderr || r.stdout || fallback).replace(/\s+/g, ' ').trim()
  return raw.slice(-500) || fallback
}
