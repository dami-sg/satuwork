import { spawn, type ChildProcess } from 'node:child_process'
import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { StringDecoder } from 'node:string_decoder'
import { humanSize, safeName } from '../workspace/index.ts'
import { satuworkHome } from '../home.ts'
import { fail, registerTool } from './common.ts'
import type { ToolCall } from './index.ts'

/**
 * terminal 工具集：`terminal` 跑命令，`process` 管它起在后台的那些。
 *
 * 看文件、改文件、找文件那四把在 tools/file.ts（file 工具集）。
 *
 * **根目录**：`$SATUWORK_WORK_DIR`——部署时注入的 `/home/{linuxUser}/work`。没有这个
 * 变量（本地跑）时回落 `$SATUWORK_HOME/work`。**不用 `$SATUWORK_HOME`**：那底下是会话
 * 日志和 SQLite，让模型的手伸进自己的记忆里，一条 `rm -rf` 就能把历史抹了。
 *
 * 但要把话说清楚：**这不是沙箱**。`terminal` 拿到的是一个真 shell，它 `cd /` 就出去了，
 * 符号链接也能指到外面。路径检查挡的是「模型手滑写错路径」，不是「模型想跑出去」。
 * 真正的边界在操作系统那层——专用系统用户、systemd 的 ProtectSystem/ReadWritePaths、
 * 或者容器；策略性的拦截（审批、白名单）挂 `tools/pre-execute` 的 waterfall，那里
 * 短路才是强制执行。别指望这里的 resolve() 顶那两层的用。
 */
export const name = 'satu-tools-terminal'
export const inject = ['tools', 'workspace']

export interface Config {
  /** 默认超时（**秒**）。 */
  timeout?: number
}

/** 喂回模型的输出上限。超出的部分落盘（见 OUT_DIR），不是丢掉。 */
const MAX_OUTPUT_CHARS = 30_000
const DEFAULT_TIMEOUT = 120
const MAX_TIMEOUT = 600

/**
 * 前台命令输出超限时，全文落在哪儿。
 *
 * **必须落在工作区里**，模型才读得到（`$SATUWORK_HOME` 底下它够不着）。放在一个点开头
 * 的目录里，`search_files` 默认跳过它——那是过程痕迹，不是员工的文件，不该混进列目录
 * 的那一屏，也不进 `files` / `refs`（界面上那一排药丸是「Bot 产出了什么」）。
 */
const OUT_DIR = '.satuwork/out'
/** 落盘的输出留几天。不清的话，一年之后工作区里躺着几千个没人看的 .log。 */
const OUT_TTL_MS = 3 * 24 * 3600_000

// ── 后台进程 ────────────────────────────────────────────────────────────

/**
 * 一条会话同时最多几个后台进程。
 *
 * 满了就拒，并且**把当前这份清单摆出来**——让模型看见是自己起了八个服务器，而不是
 * 收到一句没有出路的失败。
 */
const MAX_PROCS = 8
/** 单个后台进程最长活多久。忘掉的 `pnpm dev` 不能占着端口过周末。 */
const MAX_LIFETIME_MS = 24 * 3600_000
/**
 * 退出之后记录还留多久。
 *
 * `poll` 得到「已退出，退出码 N」要有一段窗口期——进程一没就查无此事的话，模型只能
 * 从「没有这个进程」里去猜它是跑完了还是从来没起来。
 */
const KEEP_AFTER_EXIT_MS = 30 * 60_000
/**
 * 盘上的后台进程日志留几天。
 *
 * 上面那个 30 分钟只管**干净退出**的那条路。进程被换版杀掉时定时器跟着内存一起没，
 * 日志就成了没主人的文件——这一条是它们唯一的出口（见 apply 里那段开机清扫）。
 */
const PROC_LOG_TTL_MS = 3 * 24 * 3600_000
/** 内存里留多少尾巴给 `poll`。全文在磁盘上，`log` 从那儿翻。 */
const MAX_TAIL_CHARS = 256 * 1024
/** `log` 不给 offset 时给最后多少行。 */
const LOG_TAIL_LINES = 200
/** 通知里带最后几行。不带的话模型的下一步一定是 `process(action='log')`，白花一步。 */
const NOTIFY_TAIL_LINES = 20

interface Proc {
  id: string
  sessionId: string
  command: string
  workdir: string
  startedAt: number
  endedAt?: number
  code: number | null
  signal: NodeJS.Signals | null
  child: ChildProcess
  log: WriteStream
  logPath: string
  /** 内存里的尾巴，以及它在整条输出流里的起点——`poll` 靠这两个算「上次之后的新输出」。 */
  tail: string
  tailFrom: number
  bytes: number
  /** `poll` 上次看到哪儿（整条流的绝对偏移）。 */
  cursor: number
  notify: boolean
  /** 被谁杀的。`undefined` = 自己跑完的。 */
  killedBy?: 'model' | 'ttl' | 'shutdown'
  waiters: (() => void)[]
  timers: NodeJS.Timeout[]
}

/** 杀整个进程组。只杀 shell 的话，它 fork 出去的会留下来，端口和 CPU 一起占着。 */
function killTree(child: ChildProcess) {
  try {
    process.kill(-child.pid!, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
}

function lastLines(text: string, n: number): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  return lines.slice(-n).join('\n')
}

function since(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${s % 60} 秒`
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

/**
 * detached：拿到自己的进程组。否则超时只杀得掉 bash，它 fork 出去的
 * （`npm run dev &`、管道里的子进程）会活下来。
 */
function spawnShell(command: string, cwd: string): ChildProcess {
  return spawn('bash', ['-c', command], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
}

/**
 * 把子进程的两条输出流接到一个回调上，**每条流各自一个 UTF-8 解码器**。
 *
 * 不能对每个 chunk 单独 `buf.toString('utf8')`：一个汉字三个字节，而 chunk 的边界落在
 * 哪儿只看内核什么时候把数据递上来。切在字符中间时两半各自解码，出来的是两个 `�`——
 * 前台那次调用最多是屏幕上花一下，后台那份还会**落进 proc/<id>.log**，原字节再也捞不
 * 回来。这个产品的命令输出以中文为主，这不是边角情况。
 *
 * 回调拿到解码后的文本和这一块的**字节数**（截断判据看的是字节，不是字符）。
 */
function pipeInto(child: ChildProcess, onText: (text: string, bytes: number) => void) {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue
    const decoder = new StringDecoder('utf8')
    stream.on('data', (buf: Buffer) => onText(decoder.write(buf), buf.length))
    // 流结束时把解码器里剩的半个字符吐出来，否则末尾那个字会凭空消失。
    stream.on('end', () => {
      const rest = decoder.end()
      if (rest) onText(rest, 0)
    })
  }
}

/**
 * 跑一条前台命令。永远 resolve；退出码非零是业务结果，由调用方写进文本。
 *
 * `abort` 是这一轮的中止信号（界面上那颗停止按钮）。**必须在这里响应**：不接的话，
 * 一条跑十分钟的命令按了停止也停不下来，而那正是人最想停它的时候。
 */
function runForeground(command: string, cwd: string, timeoutMs: number, abort?: AbortSignal) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; out: string; full: string; bytes: number; timedOut: boolean; aborted: boolean; error?: string }>(
    (done) => {
      const child = spawnShell(command, cwd)
      let out = ''
      let full = ''
      let bytes = 0
      let timedOut = false
      let aborted = false
      const collect = (text: string) => {
        if (out.length < MAX_OUTPUT_CHARS) out += text
        // 全文另收一份，超限时落盘给模型自己翻。**不无限收**：一条疯掉的命令能吐几个
        // GB，而那时该做的是让它撞上限，不是把席位的内存吃光。
        if (full.length < MAX_OUTPUT_CHARS * 100) full += text
      }
      // 每条流一个解码器（见 pipeInto）。
      pipeInto(child, (text, n) => {
        bytes += n
        collect(text)
      })
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, timeoutMs)
      const onAbort = () => {
        aborted = true
        killTree(child)
      }
      // 已经是 aborted 的信号不会再发事件——那种情况要当场杀，否则这条命令会在一个
      // 早就被喊停的轮次里安安静静跑满十分钟。
      if (abort) {
        if (abort.aborted) onAbort()
        else abort.addEventListener('abort', onAbort, { once: true })
      }
      const settle = (r: { code: number | null; signal: NodeJS.Signals | null; error?: string }) => {
        clearTimeout(timer)
        abort?.removeEventListener('abort', onAbort)
        done({ ...r, out, full, bytes, timedOut, aborted })
      }
      child.on('error', (e) => settle({ code: null, signal: null, error: e.message }))
      child.on('close', (code, signal) => settle({ code, signal }))
    },
  )
}

export function apply(ctx: Context, config: Config = {}) {
  const resolveIn = (path?: string) => ctx.workspace.resolve(path)
  const show = (path: string) => ctx.workspace.show(path)
  const defaultTimeout = Math.min(Math.max(1, Math.trunc(config.timeout || DEFAULT_TIMEOUT)), MAX_TIMEOUT)

  /** 后台进程注册表。只在内存里——进程被换掉时它们本来也要一起没（见下面的 killAll）。 */
  const procs = new Map<string, Proc>()

  /**
   * 后台进程的日志落在 `$SATUWORK_HOME/proc/`，**不在工作区**。
   *
   * 和前台那份截断全文（OUT_DIR）正相反：那一份是模型要自己 `read_file` 的，这一份
   * 由 `process(action='log')` 替它读。会话侧的运行数据不该出现在员工的共享 `~/work` 里。
   */
  const procDir = satuworkHome('proc')

  /**
   * 起来时先扫一遍 `proc/`，把过期的日志删掉。
   *
   * 不扫的话它们**只增不减**：删日志靠的是进程退出后那个三十分钟的定时器，而定时器活在
   * 内存里——席位换一次版、崩一次，正跑着的那些后台进程连同定时器一起没，日志留在盘上
   * 再也没有主人。工作区那份落盘输出（OUT_DIR）有 TTL 扫，这一份当初漏了。
   *
   * 只在启动时扫一次：这一刻注册表是空的，盘上每一个都是上一条命的遗物。
   */
  void (async () => {
    try {
      await mkdir(procDir, { recursive: true })
      const now = Date.now()
      for (const entry of await readdir(procDir).catch(() => [] as string[])) {
        const at = join(procDir, entry)
        const s = await stat(at).catch(() => undefined)
        if (s?.isFile() && now - s.mtimeMs > PROC_LOG_TTL_MS) await unlink(at).catch(() => {})
      }
    } catch (e) {
      ctx.logger?.warn?.(`terminal: 清理旧的后台进程日志失败：${(e as Error).message}`)
    }
  })()

  /**
   * 把超限的全文落进工作区，返回相对路径；写不成就返回空（那只是少一条线索，不该让
   * 整次调用失败）。顺手扫掉过期的。
   */
  const spill = async (callId: string, text: string): Promise<string> => {
    try {
      const dir = resolveIn(OUT_DIR)
      await mkdir(dir, { recursive: true })
      const now = Date.now()
      for (const entry of await readdir(dir).catch(() => [] as string[])) {
        const at = join(dir, entry)
        const s = await stat(at).catch(() => undefined)
        if (s && now - s.mtimeMs > OUT_TTL_MS) await unlink(at).catch(() => {})
      }
      /**
       * **callId 要洗过再拼路径。** 它是 provider 在响应里给的，一路透传到这儿，没有
       * 任何一层校验过它长什么样；带一个 `/` 就写不进去（只建了 OUT_DIR），带 `..` 就
       * 写出工作区。上传文件名和 sessionId 早就走 `safeName` / `safeSegment` 了，这条
       * 新路不该是例外。`resolveIn` 再兜一道越界检查。
       */
      const target = resolveIn(`${OUT_DIR}/${safeName(callId || String(now))}.log`)
      await writeFile(target, text, 'utf8')
      return show(target)
    } catch {
      return ''
    }
  }

  /**
   * 进程结束了要不要说一声。
   *
   * 走 `reflect.get` 而不是 inject：`agents` 那边 inject 了 `tools`，静态依赖绕回来
   * 两边都起不来（policy 够 agents 是同一条理由）。取不到就只留一行日志——通知没送到
   * 比整个进程崩掉好，模型还可以自己 `process(action='poll')`。
   *
   * **两条路**：那一轮还在跑就插话（steering 在工具跑到一半时也插得进），已经结束就
   * 开新的一轮。两种都落成一条 `user/message`——不变量 7，进入模型的那句话必须在
   * JSONL 里，重放才对得上。
   */
  const notifyExit = async (p: Proc) => {
    const text = exitNotice(p)
    try {
      const agents = (ctx as unknown as { reflect?: { get?: (n: string) => unknown } }).reflect?.get?.('agents') as
        | {
            isRunning?: (id: string) => boolean
            steer?: (id: string, text: string, images: never[], source: unknown) => Promise<boolean>
            send?: (id: string, text: string, images: never[], mentions: never[], source: unknown) => Promise<void>
          }
        | undefined
      if (!agents) throw new Error('agents 服务没起来')
      const source = { kind: 'plugin', plugin: 'process' }
      if (agents.isRunning?.(p.sessionId) && (await agents.steer?.(p.sessionId, text, [], source))) return
      await agents.send?.(p.sessionId, text, [], [], source)
    } catch (e) {
      ctx.logger?.warn?.(`terminal: ${p.id} 的结束通知没能进会话：${(e as Error).message}`)
    }
  }

  const exitNotice = (p: Proc): string => {
    const how =
      p.killedBy === 'model'
        ? '已被终止'
        : p.killedBy === 'ttl'
          ? `活过了 ${Math.round(MAX_LIFETIME_MS / 3600_000)} 小时上限，已被终止`
          : p.code === null
            ? `被信号 ${p.signal} 终止`
            : `退出码 ${p.code}`
    const head = `[后台进程 ${p.id} 已结束] ${p.command} · ${how} · 用时 ${since((p.endedAt ?? Date.now()) - p.startedAt)}`
    const body = lastLines(p.tail, NOTIFY_TAIL_LINES)
    return body ? `${head}\n最后 ${NOTIFY_TAIL_LINES} 行输出：\n${body}` : `${head}\n（没有输出）`
  }

  const finish = (p: Proc, code: number | null, signal: NodeJS.Signals | null) => {
    if (p.endedAt) return
    p.endedAt = Date.now()
    p.code = code
    p.signal = signal
    p.log.end()
    for (const t of p.timers) clearTimeout(t)
    p.timers = []
    for (const w of p.waiters.splice(0)) w()
    // 退出之后再留一会儿：poll 得到「已退出」要有窗口期。
    const gone = setTimeout(() => {
      procs.delete(p.id)
      void unlink(p.logPath).catch(() => {})
    }, KEEP_AFTER_EXIT_MS)
    gone.unref?.()
    p.timers.push(gone)
    /**
     * **自己动手杀的不通知。**
     *
     * `kill` 是模型刚发起的那次调用，它已经从返回值里知道结果了。照样通知的话，那一轮
     * 要是已经收口，`agents.send` 会为此**单独开一轮**——用户看到一条没来由的「已被终止」
     * 冒出来，账上还多一次模型调用。关机同理：进程马上就没了，没有人在等这句话。
     */
    if (p.notify && p.killedBy !== 'shutdown' && p.killedBy !== 'model') void notifyExit(p)
  }

  const start = async (sessionId: string, command: string, cwd: string, notify: boolean): Promise<Proc> => {
    await mkdir(procDir, { recursive: true })
    const id = `proc_${randomBytes(4).toString('hex')}`
    const logPath = join(procDir, `${id}.log`)
    const child = spawnShell(command, cwd)
    const p: Proc = {
      id,
      sessionId,
      command,
      workdir: show(cwd),
      startedAt: Date.now(),
      code: null,
      signal: null,
      child,
      log: createWriteStream(logPath),
      logPath,
      tail: '',
      tailFrom: 0,
      bytes: 0,
      cursor: 0,
      notify,
      waiters: [],
      timers: [],
    }
    // 写日志失败（盘满）不该把进程带走：少一份全文，poll 那条尾巴还在。
    p.log.on('error', (e) => ctx.logger?.warn?.(`terminal: ${id} 的日志写不下去：${e.message}`))
    pipeInto(child, (text, n) => {
      p.bytes += n
      p.log.write(text)
      p.tail += text
      if (p.tail.length > MAX_TAIL_CHARS) {
        const drop = p.tail.length - MAX_TAIL_CHARS
        p.tail = p.tail.slice(drop)
        p.tailFrom += drop
      }
    })
    child.on('error', (e) => {
      p.tail += `\n（启动失败：${e.message}）`
      finish(p, null, null)
    })
    child.on('close', (code, signal) => finish(p, code, signal))
    const ttl = setTimeout(() => {
      p.killedBy = 'ttl'
      killTree(child)
    }, MAX_LIFETIME_MS)
    ttl.unref?.()
    p.timers.push(ttl)
    procs.set(id, p)
    return p
  }

  /**
   * 换版和关机时把它们全杀掉。
   *
   * 管家重启这个进程之前会先让它静默、排空，但**排空只等模型那一轮跑完，管不到后台
   * 进程**。不在这里杀，换一次版就在席位上漏一批孤儿：端口占着、内存占着，而下一个
   * 版本起来时那个端口已经被占了。
   */
  const killAll = () => {
    for (const p of procs.values()) {
      if (p.endedAt) continue
      p.killedBy = 'shutdown'
      killTree(p.child)
      p.log.end()
    }
  }
  /**
   * 两道都要有：`ctx.effect` 管插件卸载，信号处理管 systemd 重启——后者走的是 SIGTERM，
   * 根本不会触发卸载。而席位换版恰恰是后者。
   *
   * **杀完必须把信号重新发给自己。** Node 的规矩是：一旦给 SIGTERM / SIGINT 装了监听器，
   * 它的默认行为（结束进程）就被摘掉了。这个进程在这之前一个信号监听器都没有，靠的正是
   * 那个默认行为退出；只在这儿挂一个不退出的监听器，`systemctl restart` 之后进程会一直
   * 活着，直到 systemd 等满 `DefaultTimeoutStopSec`（90 秒，单元里没另设）再 SIGKILL
   * ——每次换版白等一分半，排空那条路还可能直接超时。
   *
   * 摘掉自己再重发：别的监听器（探针里那些）照跑，一个都没有时就落回默认行为。
   */
  const onSignal = (sig: NodeJS.Signals) => {
    killAll()
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    process.kill(process.pid, sig || 'SIGTERM')
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)
  ctx.effect(() => () => {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
    killAll()
  })

  /** 按 id 或**唯一前缀**找。模型抄长 id 会抄错，而「没有这个进程」它排查不出来。 */
  const find = (sessionId: string, raw: string): Proc => {
    const key = String(raw || '').trim()
    if (!key) fail('缺少 session_id 参数。用 process(action="list") 看有哪些。')
    const mine = [...procs.values()].filter((p) => p.sessionId === sessionId)
    const exact = mine.find((p) => p.id === key)
    if (exact) return exact
    const bare = key.replace(/^proc_/, '')
    const hit = mine.filter((p) => p.id.slice('proc_'.length).startsWith(bare))
    if (hit.length === 1) return hit[0]
    if (hit.length > 1) fail(`${key} 对应 ${hit.length} 个进程（${hit.map((p) => p.id).join('、')}），写全一点。`)
    fail(`没有 ${key} 这个后台进程。用 process(action="list") 看有哪些——退出超过 ${Math.round(KEEP_AFTER_EXIT_MS / 60_000)} 分钟的会被清掉。`)
  }

  const stateOf = (p: Proc): string =>
    p.endedAt
      ? p.killedBy === 'model'
        ? '已被终止'
        : p.killedBy === 'ttl'
          ? '超过存活上限被终止'
          : p.code === null
            ? `被信号 ${p.signal} 终止`
            : `已退出（退出码 ${p.code}）`
      : `运行中（已 ${since(Date.now() - p.startedAt)}）`

  // ── terminal ─────────────────────────────────────────────────────────

  registerTool(
    ctx,
    {
      name: 'terminal',
      /**
       * **三样都占。** 一条命令能写文件、能 rm -rf、也能 curl 出去——它是这台席位上
       * 唯一一把「什么都做得到」的工具，标成只写就等于给所有边界开了条暗路。
       *
       * `background=true` 没有在这上面开口子：它仍然是 `terminal` 的一次调用，
       * `tools/pre-execute` 上那条命令扫描照常跑。
       */
      risk: ['write', 'destructive', 'external'],
      description:
        `在工作区里执行一条 shell 命令，返回标准输出与标准错误。默认工作目录是工作区根目录，默认超时 ${defaultTimeout} 秒（前台上限 ${MAX_TIMEOUT}）。` +
        '命令一跑完就立刻返回，超时设大一点不会让你多等。\n' +
        '读文件用 read_file、搜内容与找文件用 search_files、改文件用 patch 或 write_file——' +
        '不要用 cat / head / tail / grep / rg / find / ls / sed / awk / echo 重复它们，那几把工具的输出更适合阅读。' +
        'terminal 留给构建、安装、git、进程、脚本、包管理器这些真的需要 shell 的事。\n' +
        '**不要把构建或测试命令管道给 tail / head**（`pnpm build | tail -20`）：输出本来就会自动截断、超出的部分会落盘，' +
        '而管道会让退出码变成管道里最后一条命令的（tail 的 0），真失败被盖掉。`cmd || echo failed` 同理。\n' +
        '跑得久的（服务器、长构建）设 background=true，它会立刻返回一个 session_id，之后用 process 查看和终止；' +
        '有明确终点的（构建、测试、部署）再加 notify_on_complete=true，跑完会自动告诉你，不用轮询。' +
        '**不要用 nohup / setsid / 结尾 &** 自己甩到后台——那样起的进程 process 管不到。\n' +
        '后台进程**不随这一轮结束**，用户点停止也不会停掉它们，要停就调 process(action="kill")。\n' +
        '命令是非交互执行的，不要跑需要输入的程序。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令，如 "git status --short"。' },
          workdir: { type: 'string', description: '这条命令的工作目录，相对工作区根目录。默认工作区根目录。' },
          timeout: { type: 'number', description: `前台最多等多少**秒**，上限 ${MAX_TIMEOUT}。默认 ${defaultTimeout}。background=true 时无效。` },
          background: { type: 'boolean', description: '放到后台跑，立刻返回 session_id。默认 false。' },
          notify_on_complete: {
            type: 'boolean',
            description: '配合 background=true：进程结束时自动通知你，不用轮询。有明确终点的任务都该设它；永不退出的服务器不用。默认 false。',
          },
        },
        required: ['command'],
      },
    },
    async (
      {
        command,
        workdir,
        timeout,
        background,
        notify_on_complete: notifyOnComplete,
      }: {
        command?: string
        workdir?: string
        timeout?: number
        background?: boolean
        notify_on_complete?: boolean
      },
      call: ToolCall,
    ) => {
      if (!command?.trim()) fail('缺少 command 参数')
      const dir = resolveIn(workdir)
      const info = await stat(dir).catch(() => fail(`工作目录不存在：${show(dir)}`))
      if (!info.isDirectory()) fail(`${show(dir)} 不是目录。`)

      if (background) {
        const mine = [...procs.values()].filter((p) => p.sessionId === call.sessionId && !p.endedAt)
        if (mine.length >= MAX_PROCS) {
          // 拒绝要带着清单：让模型看见是自己起了八个，而不是收到一句没有出路的失败。
          const list = mine.map((p) => `  ${p.id}  ${p.command}`).join('\n')
          fail(`后台进程已经有 ${mine.length} 个（上限 ${MAX_PROCS}），先用 process(action="kill") 停掉不用的：\n${list}`)
        }
        const p = await start(call.sessionId, command, dir, notifyOnComplete === true)
        const hint = p.notify
          ? '跑完会自动告诉你。'
          : '用 process(action="poll", session_id="…") 看进展。'
        return (
          `已在后台启动：${p.id}\n命令：${command}\n工作目录：${p.workdir}\n${hint}\n` +
          '它不随这一轮结束，要停就 process(action="kill")。'
        )
      }

      const seconds = Math.max(1, Math.min(Math.floor(timeout || defaultTimeout), MAX_TIMEOUT))
      const r = await runForeground(command, dir, seconds * 1000, call?.signal)
      if (r.error) fail(`无法执行：${r.error}`)

      const body = r.out.trim() || '（没有输出）'
      let cut = ''
      if (r.bytes > Buffer.byteLength(r.out)) {
        /**
         * 截断的同时把全文落盘。
         *
         * 上面那句「不要 `| tail`」只有配上这一条才站得住：既然禁止模型自己截短输出，
         * 就得给它一条把全文捞回来的路，否则它下一步一定是再跑一遍加管道。
         */
        const at = await spill(call?.callId, r.full)
        cut = at
          ? `\n…（输出已截断，共 ${humanSize(r.bytes)}。完整输出在 ${at}，用 read_file 翻）`
          : `\n…（输出已截断，共 ${humanSize(r.bytes)}）`
      }
      // 退出码非零是**业务**结果，不是管道故障：模型要看到它并自己决定下一步。
      // 被中止要单独说：让模型知道这条命令没跑完，别拿半截输出当结论。
      if (r.aborted) return `命令已被中止（用户点了停止）。已经产生的输出：\n${body}${cut}`
      if (r.timedOut) {
        return `命令超时（${seconds} 秒）已被终止。跑得久的用 background=true。\n${body}${cut}`
      }
      if (r.code === 0) return `${body}${cut}`
      const how = r.code === null ? `被信号 ${r.signal} 终止` : `退出码 ${r.code}`
      return `命令${how}。\n${body}${cut}`
    },
  )

  // ── process ──────────────────────────────────────────────────────────

  registerTool(
    ctx,
    {
      name: 'process',
      /**
       * **不要审批。** 后台进程会不会干坏事，在 `terminal` 起它的那一刻就已经按同一条
       * 命令扫过一遍了；`process` 只是在管自己起的那几个。再判一次的结果是每一次 poll
       * 都弹一张卡片——那不是收紧边界，是让人学会闭眼点批准。
       */
      risk: ['write'],
      description:
        '管理 terminal(background=true) 起的后台进程。\n' +
        "list：列出这条会话的全部后台进程。poll：看状态和**上次之后的新输出**（轮询用这个）。" +
        'log：完整输出，带分页。wait：阻塞到结束或超时。kill：终止（连它 fork 出去的一起）。\n' +
        'session_id 写唯一前缀就行（`4dae` 能指到 `proc_4dae56ca`）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['list', 'poll', 'log', 'wait', 'kill'], description: '要做什么。' },
          session_id: { type: 'string', description: 'terminal 返回的那个进程 id，唯一前缀也认。除 list 外必填。' },
          timeout: { type: 'number', description: 'wait 最多阻塞多少秒。超时返回已有的输出。' },
          offset: { type: 'number', description: `log 从第几行开始（1 起）。不给就给最后 ${LOG_TAIL_LINES} 行。` },
          limit: { type: 'number', description: 'log 最多返回多少行。' },
        },
        required: ['action'],
      },
    },
    async (
      {
        action,
        session_id: sessionId,
        timeout,
        offset,
        limit,
      }: { action?: string; session_id?: string; timeout?: number; offset?: number; limit?: number },
      call: ToolCall,
    ) => {
      const mine = () => [...procs.values()].filter((p) => p.sessionId === call.sessionId)

      if (action === 'list') {
        const all = mine()
        if (!all.length) return '这条会话没有后台进程。'
        return all
          .map((p) => `${p.id}  ${stateOf(p)}\n  命令：${p.command}\n  目录：${p.workdir}`)
          .join('\n')
      }

      if (action === 'poll') {
        const p = find(call.sessionId, sessionId ?? '')
        const end = p.tailFrom + p.tail.length
        // 缓冲滚过去的那一段说清楚。悄悄跳过会让模型以为它看到了全部输出。
        const dropped = p.cursor < p.tailFrom ? p.tailFrom - p.cursor : 0
        const from = Math.max(p.cursor, p.tailFrom)
        const fresh = p.tail.slice(from - p.tailFrom)
        p.cursor = end
        const head = `${p.id}  ${stateOf(p)}`
        const skipped = dropped ? `\n（中间有 ${humanSize(dropped)} 输出滚出了缓冲，完整的用 action="log" 看）` : ''
        if (!fresh.trim()) return `${head}${skipped}\n（上次之后没有新输出）`
        return `${head}${skipped}\n新输出：\n${fresh.replace(/\s+$/, '')}`
      }

      if (action === 'log') {
        const p = find(call.sessionId, sessionId ?? '')
        const text = await readFile(p.logPath, 'utf8').catch(() => p.tail)
        const lines = text.replace(/\s+$/, '').split('\n')
        const cap = Math.max(1, Math.min(Math.floor(limit || LOG_TAIL_LINES), 2000))
        const startAt = offset ? Math.max(1, Math.floor(offset)) : Math.max(1, lines.length - cap + 1)
        const picked = lines.slice(startAt - 1, startAt - 1 + cap)
        if (!picked.length) return `${p.id} 一共 ${lines.length} 行，offset ${startAt} 超出了。`
        const left = lines.length - (startAt - 1 + picked.length)
        const width = String(startAt + picked.length - 1).length
        const body = picked.map((l, i) => `${String(startAt + i).padStart(width, ' ')}|${l}`).join('\n')
        return (
          `${p.id}  ${stateOf(p)}  共 ${lines.length} 行\n${body}` +
          (left > 0 ? `\n…（还有 ${left} 行，用 offset=${startAt + picked.length} 接着看）` : '')
        )
      }

      if (action === 'wait') {
        const p = find(call.sessionId, sessionId ?? '')
        if (!p.endedAt) {
          const seconds = Math.max(1, Math.min(Math.floor(timeout || 60), MAX_TIMEOUT))
          await new Promise<void>((resolve) => {
            let done = false
            const settle = () => {
              if (done) return
              done = true
              clearTimeout(timer)
              call?.signal?.removeEventListener('abort', settle)
              // 从等待队列里摘掉自己。超时和中止这两条路 finish() 永远走不到，不摘的话
              // 一个长命进程上反复 wait 会让这个数组一直涨（连着闭包一起留着）。
              const at = p.waiters.indexOf(settle)
              if (at >= 0) p.waiters.splice(at, 1)
              resolve()
            }
            const timer = setTimeout(settle, seconds * 1000)
            timer.unref?.()
            p.waiters.push(settle)
            // 停止按钮要停得掉这次等待——进程照旧在跑，那是它该有的样子。
            call?.signal?.addEventListener('abort', settle, { once: true })
          })
        }
        const tail = lastLines(p.tail, NOTIFY_TAIL_LINES)
        const head = `${p.id}  ${stateOf(p)}`
        if (!p.endedAt) return `${head}\n还没结束，等待已到时间。最后 ${NOTIFY_TAIL_LINES} 行：\n${tail}`
        return `${head}  用时 ${since(p.endedAt - p.startedAt)}\n最后 ${NOTIFY_TAIL_LINES} 行：\n${tail || '（没有输出）'}`
      }

      if (action === 'kill') {
        const p = find(call.sessionId, sessionId ?? '')
        if (p.endedAt) return `${p.id} 已经结束了（${stateOf(p)}），没有可终止的。`
        p.killedBy = 'model'
        killTree(p.child)
        return `已终止 ${p.id}（连同它 fork 出去的进程）。命令：${p.command}`
      }

      fail(`action 只能是 list / poll / log / wait / kill，收到的是 ${JSON.stringify(action)}。`)
    },
  )
}
