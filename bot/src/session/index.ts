import { Service, type Context } from '@deepseek-ai/cordis'
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { satuworkHome } from '../home.ts'
import {
  SESSION_FORMAT_VERSION,
  type EventEnvelope,
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
    await mkdir(this.root, { recursive: true })
    const id = `s-${randomUUID()}`
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

  /** 会话列表，按创建时间倒序。标题取 session/title，没有就回落到根记录。 */
  async list(): Promise<{ id: string; title: string; createdAt: number; botId?: string }[]> {
    if (!existsSync(this.root)) return []
    const files = (await readdir(this.root)).filter((f) => f.endsWith('.jsonl'))
    const rows = await Promise.all(
      files.map(async (f) => {
        const id = f.replace(/\.jsonl$/, '')
        const events = await this.events(id)
        const root = events.find((e) => e.type === 'session')
        if (!root) return null
        const titled = [...events].reverse().find((e) => e.type === 'session/title')
        const data = root.data as { title?: string; createdAt: number; botId?: string; agentId?: string }
        return {
          id,
          title:
            (titled?.data as { title: string } | undefined)?.title ??
            data.title ??
            '新会话',
          createdAt: data.createdAt,
          botId: data.botId ?? data.agentId,
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

  /** 惰性从磁盘恢复。进程重启后第一次访问某会话会走这里。 */
  private async load(sessionId: string): Promise<SessionState> {
    const cached = this.cache.get(sessionId)
    if (cached) return cached

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

    if (rewritten) {
      await writeFile(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
    }

    const state: SessionState = {
      id: sessionId,
      events,
      seq: events.at(-1)?.seq ?? 0,
      file,
    }
    this.cache.set(sessionId, state)
    return state
  }
}

export const name = 'satu-sessions'

export function apply(ctx: Context, config: Config = {}) {
  ctx.plugin(SessionService, config)
}
