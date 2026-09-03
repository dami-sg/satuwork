import { Service, type Context } from '@deepseek-ai/cordis'
import { appendFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { satuworkHome } from '../home.ts'
import {
  SESSION_FORMAT_VERSION,
  type EventEnvelope,
  type ChannelSessionMeta,
  type SessionEvent,
  type SessionEventMap,
  type SessionOrigin,
} from './types.ts'

export * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: SessionService
  }
  interface Events {
    /** 每追加一条事件后广播。UI、投影、遥测都从这里派生，而不是各自埋点。 */
    'session/event'(sessionId: string, event: SessionEvent): void
  }
}

export interface Config {
  /** JSONL 落盘目录。默认 `$SATUWORK_HOME/sessions`（见 src/home.ts）。 */
  root?: string
}

export interface CreateSession {
  botId: string
  origin?: SessionOrigin
  remoteId?: string
  title?: string
  channel?: ChannelSessionMeta
  /**
   * `task` = 一次委派开出来的子会话（docs/delegation.md）。默认 `main`。
   *
   * **除了 `main` 之外的都不是「这个人的对话」**：不进 list()、不上报会话索引、
   * 不会被 ensureSession 认领成长会话。判据一律写成「是不是 main」，不是「是不是
   * task」——老日志里还有已经下线的 `card` 卡片会话，
   * 照后者写的每一处都会静默地把它当成主会话。
   */
  kind?: 'main' | 'task'
  /**
   * 谁开的。**非 `main` 的都必须给。**
   *
   * 卡片会话没有开它的那次工具调用（是 Gateway 派过来的），所以 `sessionId` / `callId`
   * 留空，`taskId` 写卡号。
   */
  parent?: { sessionId: string; callId: string; taskId: string }
}

interface SessionState {
  id: string
  events: SessionEvent[]
  seq: number
  file: string
}

/**
 * 追加式会话日志。
 *
 * 唯一的写入口是 `append`：内存态、落盘、广播三件事在这里成为一件事，
 * 不可能出现「发了事件但没落盘」或「落了盘但 UI 不知道」。
 *
 * 读取一律走事件列表的派生——不维护第二份可变状态，因为那必然会跟日志漂移。
 */
export class SessionService extends Service {
  private cache = new Map<string, SessionState>()
  /**
   * 正在读盘的会话。两个请求同时碰一条还没缓存的会话时，必须共用同一次 load——
   * 否则两份 SessionState 各自记 seq，各自往同一个文件写，事件会互相盖掉。
   */
  private loading = new Map<string, Promise<SessionState>>()
  private root: string
  /**
   * 旧会话没有 botId 时挂到这个 Bot。
   *
   * 选「挂到默认 Bot」而不是标只读：这是单机单席位，旧对话仍是这个人的工作，
   * 挂上去就能接着聊。只改根事件，不删 JSONL。
   */
  fallbackBotId = 'default'

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'sessions')
    this.root = config.root ?? satuworkHome('sessions')
  }

  async create(opts: CreateSession): Promise<string> {
    if (!opts.botId) throw new Error('sessions: 创建会话必须带 botId')
    if (opts.kind && opts.kind !== 'main' && !opts.parent) throw new Error('sessions: 非主会话必须带 parent')
    await mkdir(this.root, { recursive: true })
    /**
     * 主会话 `s-`、委派子会话 `t-`（老日志里还有看板卡那批 `c-`）。
     *
     * **只为运维时 `ls` 一眼分得开**，代码里不许拿它做判断——事实源是根事件的 `kind`
     * （见 session/types.ts）。两个判据并存的话，它们迟早会分叉。
     */
    const id = `${opts.kind === 'task' ? 't' : 's'}-${randomUUID()}`
    const state: SessionState = { id, events: [], seq: 0, file: join(this.root, `${id}.jsonl`) }
    this.cache.set(id, state)
    await this.append(id, 'session', {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: Date.now(),
      title: opts.title,
      botId: opts.botId,
      origin: opts.origin ?? 'local',
      ...(opts.remoteId ? { remoteId: opts.remoteId } : {}),
      ...(opts.channel ? { channel: opts.channel } : {}),
      ...(opts.kind && opts.kind !== 'main' ? { kind: opts.kind, parent: opts.parent } : {}),
    })
    return id
  }

  /**
   * 追加一条事件。返回落定的信封，调用方拿得到 seq——同一个 turn 内的关联
   * （比如 tool/result 指回 tool/call）靠业务 id，不靠 seq，但诊断时 seq 有用。
   */
  async append<T extends keyof SessionEventMap>(
    sessionId: string,
    type: T,
    data: SessionEventMap[T],
  ): Promise<EventEnvelope<T>> {
    const state = await this.load(sessionId)
    const event = { seq: ++state.seq, time: Date.now(), type, data } as EventEnvelope<T>
    state.events.push(event as SessionEvent)
    // 先落盘再广播：监听者看到事件时，它已经是持久的。
    await appendFile(state.file, JSON.stringify(event) + '\n', 'utf8')
    this.ctx.emit('session/event', sessionId, event as SessionEvent)
    return event
  }

  /** 会话的全部事件，按 seq 升序。`after` 用于增量拉取（SSE 断线重连）。 */
  async events(sessionId: string, after = 0): Promise<SessionEvent[]> {
    const state = await this.load(sessionId)
    return after ? state.events.filter((e) => e.seq > after) : state.events.slice()
  }

  /**
   * 会话列表，按创建时间倒序。标题取 session/title，没有就回落到根记录。
   *
   * **默认只有主会话。** 委派开出来的（`task`）和看板卡（`card`）都不是「这个人的
   * 对话」，而这个列表的每一个调用方都是在问那个问题：侧栏画什么、认领哪条长会话
   * （registry 的 ensureSession）、往控制面报哪些索引。混进去的后果最狠的一条是认领
   * ——列表按创建时间**倒序**，它们永远比主会话新，于是席位重装、名册行上的
   * sessionId 丢了的那一刻，`mine[0]` 认回来的是某次委派、或者昨天某张卡的现场。
   *
   * **判据是「是不是 main」，不是「是不是 task」。** 照后者写的话，第三个取值出现的
   * 那天它会被静默地当成主会话——而卡是天天在跑的。
   *
   * 要连它们一起看（调试、清理）传 `{ tasks: true }`。
   */
  async list(opts: { tasks?: boolean } = {}): Promise<
    { id: string; title: string; createdAt: number; botId?: string; kind?: 'main' | 'task' | 'card'; channel?: ChannelSessionMeta }[]
  > {
    if (!existsSync(this.root)) return []
    const files = (await readdir(this.root)).filter((f) => f.endsWith('.jsonl'))
    const rows = await Promise.all(
      files.map(async (f) => {
        const id = f.replace(/\.jsonl$/, '')
        const events = await this.events(id)
        const root = events.find((e) => e.type === 'session')
        if (!root) return null
        const titled = [...events].reverse().find((e) => e.type === 'session/title')
        const data = root.data as {
          title?: string
          createdAt: number
          botId?: string
          agentId?: string
          kind?: 'main' | 'task' | 'card'
          channel?: ChannelSessionMeta
        }
        if (data.kind && data.kind !== 'main' && !opts.tasks) return null
        return {
          id,
          title:
            (titled?.data as { title: string } | undefined)?.title ??
            data.title ??
            '新会话',
          createdAt: data.createdAt,
          botId: data.botId ?? data.agentId,
          ...(data.kind ? { kind: data.kind } : {}),
          ...(data.channel ? { channel: data.channel } : {}),
        }
      }),
    )
    return rows.filter((r): r is NonNullable<typeof r> => Boolean(r)).sort((a, b) => b.createdAt - a.createdAt)
  }

  /**
   * 扫一遍目录，把旧格式根事件改成 v2。
   *
   * 走 load()：迁移和日常读取是同一条路，不会出现「启动迁过了、读的时候又判版本失败」。
   * 坏文件只记一笔，不删。
   */
  async migrateAll(fallbackBotId: string): Promise<void> {
    this.fallbackBotId = fallbackBotId
    if (!existsSync(this.root)) return
    const files = (await readdir(this.root)).filter((f) => f.endsWith('.jsonl'))
    for (const f of files) {
      const id = f.replace(/\.jsonl$/, '')
      try {
        await this.load(id)
      } catch (e) {
        this.ctx.logger?.warn?.(`sessions: 迁移 ${id} 失败：${(e as Error).message}`)
      }
    }
  }

  /** 惰性从磁盘恢复。进程重启后第一次访问某会话会走这里。并发进来的共用同一次。 */
  private async load(sessionId: string): Promise<SessionState> {
    const cached = this.cache.get(sessionId)
    if (cached) return cached
    const inflight = this.loading.get(sessionId)
    if (inflight) return inflight
    const run = this.read(sessionId).finally(() => this.loading.delete(sessionId))
    this.loading.set(sessionId, run)
    return run
  }

  private async read(sessionId: string): Promise<SessionState> {
    const file = join(this.root, `${sessionId}.jsonl`)
    if (!existsSync(file)) throw new Error(`sessions: 未知会话 ${sessionId}`)

    const events: SessionEvent[] = []
    let rewritten = false
    for (const line of (await readFile(file, 'utf8')).split('\n')) {
      if (!line.trim()) continue
      const event = JSON.parse(line) as SessionEvent
      // 更新的版本拒绝，不要猜。旧版本就地迁到当前：补 botId / origin，不丢文件。
      if (event.type === 'session') {
        const data = event.data as SessionEventMap['session'] & { agentId?: string }
        if (data.version > SESSION_FORMAT_VERSION) {
          throw new Error(
            `sessions: ${sessionId} 是格式 v${data.version}，当前是 v${SESSION_FORMAT_VERSION}，需要迁移`,
          )
        }
        if (data.version < SESSION_FORMAT_VERSION || !data.botId) {
          const { agentId: legacyId, ...rest } = data as SessionEventMap['session'] & { agentId?: string }
          event.data = {
            ...rest,
            version: SESSION_FORMAT_VERSION,
            botId: data.botId ?? legacyId ?? this.fallbackBotId,
            origin: data.origin ?? 'local',
          }
          rewritten = true
        }
      }
      events.push(event)
    }

    // 迁移要改的只有根事件，但 JSONL 只能整份重写。**先写临时文件再 rename**：
    // rename 在同一个目录里是原子的，写到一半断电也只会留下一个 .tmp，原文件仍然完整。
    if (rewritten) {
      const tmp = `${file}.${randomUUID()}.tmp`
      await writeFile(tmp, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
      await rename(tmp, file)
    }

    const state: SessionState = {
      id: sessionId,
      events,
      // 取**最大**的 seq，不是最后一行的。并发追加会让物理行序和 seq 序不一致（两个
      // writer 各自拿号、写入顺序由文件锁决定），迁移重写也可能改变行序。按最后一行
      // 恢复会把游标退回到一个已经用过的号上，下一条事件的 seq 就和历史撞号——SSE 的
      // ?after=N 游标从此认不出新事件。
      seq: events.reduce((max, e) => {
        const n = Number((e as { seq?: unknown }).seq)
        return Number.isFinite(n) && n > max ? n : max
      }, 0),
      file,
    }
    this.cache.set(sessionId, state)
    await this.healDanglingTurn(state)
    return state
  }

  /**
   * 把上一个进程没写完的 turn 收口。
   *
   * `turn/end` 是在 `finally` 里写的，所以正常路径（成功、模型报错、用户中止）都收得
   * 住。收不住的只有一种：进程本身没了——崩溃、机器重启，以及**每一次「重新部署」**。
   * 那条 `turn/start` 于是永远悬在日志末尾，谁也不会再去关它。
   *
   * 后果不只是难看：界面拿「最后一条 turn/start 之后有没有 turn/end」判断这轮还在不在
   * 跑，一条悬着的记录会让会话永远显示「正在处理」——而那边其实什么都没在跑，等多久
   * 都不会变。用量归集也按 turn/end 触发，同样会漏掉这一轮。
   *
   * 从磁盘恢复的这一刻正是唯一能确定「那个进程已经死了」的时机：它写的东西我们读到
   * 了，而它自己不在了。所以在这里补一条 reason: 'error' 的 turn/end。
   */
  private async healDanglingTurn(state: SessionState): Promise<void> {
    let lastStart = -1
    let lastEnd = -1
    for (let i = state.events.length - 1; i >= 0; i--) {
      const type = state.events[i].type
      if (lastStart < 0 && type === 'turn/start') lastStart = i
      if (lastEnd < 0 && type === 'turn/end') lastEnd = i
      if (lastStart >= 0 && lastEnd >= 0) break
    }
    if (lastStart < 0 || lastStart < lastEnd) return
    const turn = Number((state.events[lastStart].data as { turn?: unknown }).turn) || 0
    this.ctx.logger?.warn?.(`sessions: ${state.id} 第 ${turn} 轮没有收口（上个进程没能写完），补一条 turn/end`)
    await this.append(state.id, 'turn/end', { turn, reason: 'error' })
  }
}

export const name = 'satu-sessions'

export function apply(ctx: Context, config: Config = {}) {
  ctx.plugin(SessionService, config)
}
