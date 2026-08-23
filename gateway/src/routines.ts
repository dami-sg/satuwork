/**
 * 日常任务的**跑**：到点了把那段指令发进席位的会话，然后等这一轮跑完，把结果记进流水。
 *
 * 定义、排期在 db 与 lib/schedule.ts；这里只回答两个问题——「现在该跑哪几条」和
 * 「刚才那一条跑成没跑成」。
 *
 * ## 为什么跑在 Gateway，而不是席位上
 *
 * 席位那边更「近」：它自己就知道一轮什么时候结束，机器关了就该不跑。但席位是**按需
 * 部署、随时会被重装**的一个进程，把日程放在它里面，等于把「每天九点」交给一个人人
 * 都有权重铺的目录。Gateway 这边有库、有事务、有唯一的一份时间，重启也不丢——代价是
 * 它得自己去问「跑完了没有」，也就是下面那条 SSE。
 *
 * ## 一次跑，四步
 *
 * 1. 找到席位（地址 + 两张票），拿到这颗 Bot 的会话 id
 * 2. 读一下当前最后一条事件的 seq，作为等待的游标
 * 3. **先挂上流，再发消息**——反过来的话，跑得快的那一轮会在流挂上之前就结束，
 *    然后这里等到超时，界面上是一条永远转着的圈，而事情其实早就做完了
 * 4. 等到**自己那一轮**的 `turn/end`，记 ok；超时或者出错，记 error 并把原因写进流水
 *    （「自己那一轮」这几个字是要紧的，见下面 readTurnEnd）
 */
import type { Db, Routine, RoutineRun, RoutineRunTrigger } from './db.ts'
import { nextRunAtOf } from './lib/schedule.ts'
import { machineTokenFor, seatBearer } from './lib/runtime.ts'
import { sweepHandoffs } from './handoff-sweep.ts'

/** 调度器多久看一眼。设成 0 就不起调度器（e2e 里有几条不需要它自己跑）。 */
const TICK_MS = Math.max(0, Math.trunc(Number(process.env.GATEWAY_ROUTINE_TICK_MS ?? 30_000)))
/**
 * 一次最多等多久。
 *
 * 这个数不是「一轮对话该有多长」，是「等到什么时候就认定它不会回来了」。定时任务里
 * 长的那种（翻一天的新闻、跑一份报表）十几分钟很正常，所以给得比人等得起的久得多；
 * 真超了也不是「失败」，而是**结果不明**，流水上会这么写。
 */
const RUN_TIMEOUT_MS = Math.max(60_000, Math.trunc(Number(process.env.GATEWAY_ROUTINE_TIMEOUT_MS ?? 20 * 60_000)))
/** 一轮扫最多处理几条。多了就下一轮再来，别让一次 tick 卡在网络上。 */
const BATCH = 20

/** 正在等结果的那几条。进程要停时全部掐掉，不然 fetch 吊着事件循环不退出。 */
const watching = new Set<AbortController>()

/**
 * 收掉没人再管的 `running`。
 *
 * 划线在「比最长等待还老一分钟」：那之前的每一条，**任何**进程里的 watcher 都已经
 * 放弃了（超时那一刻它自己会写结果），所以收它踩不到活人。多留的一分钟是给写结果
 * 那一跳的余量。
 */
function sweepStaleRuns(db: Db): Promise<number> {
  return db.failStaleRoutineRuns(Date.now() - RUN_TIMEOUT_MS - 60_000).catch((e: Error) => {
    console.error(`satuwork-gateway: 收尾日常任务流水失败：${e.message}`)
    return 0
  })
}

function headersFor(bearer: string, machineToken: string | undefined, accept: string): Record<string, string> {
  return {
    accept,
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    ...(machineToken ? { 'x-satuwork-machine': machineToken } : {}),
  }
}

interface SeatLink {
  host: string
  bearer: string
  machineToken: string | undefined
}

/**
 * 席位在哪、拿什么敲。**不复用路由层那几个 helper 的原因是它们要一个 `Account`**，
 * 而调度器手上只有一个 accountId——为此去查一遍账号再拼一个假的 Account，比直接
 * 查 instances 更绕。
 */
async function seatLinkOf(db: Db, accountId: string, botId: string): Promise<SeatLink> {
  const row = await db.instance(accountId, botId)
  const host = (row?.host || '').trim().replace(/\/$/, '')
  if (!host) throw new Error('实例还没上线')
  const account = await db.account(accountId)
  if (!account) throw new Error('账号不在了')
  return { host, bearer: await seatBearer(db, accountId), machineToken: await machineTokenFor(db, account, botId) }
}

async function seatJson(link: SeatLink, path: string, init?: { method?: string; body?: unknown }): Promise<unknown> {
  const r = await fetch(`${link.host}${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      ...headersFor(link.bearer, link.machineToken, 'application/json'),
      ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })
  const text = await r.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = null
  }
  if (!r.ok) {
    const err = (parsed as { error?: string } | null)?.error || text.slice(0, 200) || `HTTP ${r.status}`
    throw new Error(err)
  }
  return parsed
}

/** 这颗 Bot 当前的会话。席位那边没有就现建一个，和界面走的是同一条路。 */
async function sessionIdOf(link: SeatLink, botId: string): Promise<string> {
  const got = (await seatJson(link, `/api/bots/${encodeURIComponent(botId)}/session`)) as { sessionId?: string } | null
  const id = got?.sessionId
  if (!id) throw new Error('席位没给出会话 id')
  return id
}

/** 会话里最后一条事件的 seq。等待游标从它起算，早于它的旧事件就不会被当成本次的结果。 */
async function lastSeqOf(link: SeatLink, sessionId: string): Promise<number> {
  const got = (await seatJson(link, `/api/sessions/${encodeURIComponent(sessionId)}/history?turns=1`)) as
    | { events?: { seq?: number }[] }
    | null
  let max = 0
  for (const ev of got?.events ?? []) max = Math.max(max, Number(ev?.seq) || 0)
  return max
}

/**
 * 挂上事件流。**返回的是一个已经拿到响应头的读取器**——也就是说这条流在席位那边
 * 已经建立、事件监听已经挂上了。发消息必须在这之后，否则跑得快的那一轮会在流建立
 * 之前就结束。
 *
 * 游标 `after` 还兜着第二层：即便流慢了半拍，席位也会把 seq 之后的事件从日志里补发
 * 一遍，`turn/end` 丢不了。
 */
async function openEvents(link: SeatLink, sessionId: string, afterSeq: number, ac: AbortController) {
  const url = `${link.host}/api/sessions/${encodeURIComponent(sessionId)}/events?after=${afterSeq}`
  const r = await fetch(url, { headers: headersFor(link.bearer, link.machineToken, 'text/event-stream'), signal: ac.signal })
  if (!r.ok || !r.body) throw new Error(`事件流打不开：HTTP ${r.status}`)
  return r.body.getReader()
}

/**
 * 读到**自己那一轮**结束为止，返回结束的原因。
 *
 * 只认 `turn/end`。`completed` 以外的原因照样算「结束了」，但要把原因带出去——
 * 「跑完了」「人按了停止」「模型那一跳失败了」在界面上必须分得开，全记成成功的话，
 * 一条每天都在失败的任务在清单上是一整列绿勾。
 *
 * **不能见到第一条 `turn/end` 就认。** 游标是发消息之前取的，中间隔着两跳 HTTP；
 * 人正好在这时候和这个 Bot 说着话的话，他那一轮的收口会先到，于是这一次运行按**别人
 * 那一轮**的结局记了下来，而任务自己那条消息才刚开始跑，结果再也不会反映到流水里。
 *
 * 所以分两种走法，按发消息那一跳的回话决定（见 bot 的 POST /messages 三岔）：
 *
 * - `steered`：我们的话被插进了**正在跑的那一轮**，那么下一条 `turn/end` 就是我们的
 * - 其余（`accepted` / 排队）：我们的话会**另起一轮**，所以先等一条 `turn/start`，
 *   记下它的轮号，只认这个轮号的收口；在那之前出现的 `turn/end` 都是别人的
 *
 * **`reason` 有两种形状。** 席位现在写的是一个字符串（见 bot 的 agent/index.ts 那句
 * `append('turn/end', { turn, reason })`），而 docs/session-event-field-map.md 里
 * 记的 dsh 原始日志写的是 `{ kind }`。两种都认——只认后者的话，失败的那一轮会
 * 静静地记成成功，这个 bug 真出现过一次。
 */
async function readTurnEnd(reader: ReadableStreamDefaultReader<Uint8Array>, ownTurn: boolean): Promise<string> {
  const decoder = new TextDecoder()
  let buf = ''
  // 我们那一轮的轮号。null = 还没开始（`steered` 的时候当场就算「已经在跑了」）。
  let turn: number | null = ownTurn ? null : -1
  while (true) {
    const { done, value } = await reader.read()
    if (done) throw new Error('事件流断了')
    buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data: ')) continue
        let ev: { type?: string; data?: { turn?: number; reason?: string | { kind?: string } } }
        try {
          ev = JSON.parse(line.slice(6))
        } catch {
          continue
        }
        if (ev.type === 'turn/start') {
          // 席位一条会话同时只跑一轮，所以发完消息之后开的第一轮就是我们这一轮。
          if (turn === null) turn = Number(ev.data?.turn ?? -1)
          continue
        }
        if (ev.type !== 'turn/end') continue
        if (turn === null) continue
        // 轮号对不上就不是我们那一条（-1 = 插进别人正在跑的那一轮，不比轮号）。
        if (turn !== -1 && Number(ev.data?.turn ?? -1) !== turn) continue
        const reason = ev.data?.reason
        return String((typeof reason === 'string' ? reason : reason?.kind) || 'completed')
      }
    }
  }
}

/** 一轮没跑成，那句给人看的话。正文在对话里，这里只说是哪一类。 */
function turnFailure(kind: string): string {
  if (kind === 'aborted') return '这一轮被中止了'
  if (kind === 'error') return '这一轮没跑完，出错的经过在对话里'
  return `这一轮以 ${kind} 结束`
}

/**
 * 真正跑一次。**先把流水记成 `running` 再发消息**：发出去之后进程被杀，库里留着一条
 * 「不知道结果」也比什么都没有强——后者会让人以为那天晚上根本没触发。
 *
 * 返回刚记下的那条流水；等结果是后台的事，调用方不必等（「试跑」那颗按钮要立刻有反应）。
 */
export async function runRoutine(db: Db, routine: Routine, trigger: RoutineRunTrigger): Promise<RoutineRun> {
  const run = await db.insertRoutineRun({
    routineId: routine.id,
    botId: routine.botId,
    accountId: routine.accountId,
    companyId: routine.companyId,
    trigger,
  })
  void (async () => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), RUN_TIMEOUT_MS)
    watching.add(ac)
    try {
      const link = await seatLinkOf(db, routine.accountId, routine.botId)
      const sessionId = await sessionIdOf(link, routine.botId)
      /**
       * 这条会话上有一张**挡着路**的交接单还没闭合：这一次不跑。
       *
       * 不拦的话，一件卡住的事会每小时重跑一遍、每小时开一张新单、每小时推一次通知
       * ——而人还没来得及处理第一张（见 docs/handoff.md §8）。流水上要如实写明是为什么
       * 跳过的：静静地不跑，和「跑了但什么都没做」在界面上长得一模一样。
       *
       * **判据取自 Gateway 这张表，不去问席位**：这一跳发生在 tick 里，机器可能正关着，
       * 而"关着"本身就是没人接手的一半原因。
       */
      const blocking = (await db.handoffsOfSession(sessionId)).find(
        (h) => h.blocking && (h.state === 'open' || h.state === 'claimed'),
      )
      if (blocking) {
        await db.finishRoutineRun(run.id, {
          status: 'error',
          error: `这一次没跑：还有一件转人工的事等着人处理（${blocking.ask.slice(0, 60) || '没写要做什么'}）`,
          sessionId,
        })
        return
      }
      await db.finishRoutineRun(run.id, { status: 'running', sessionId })
      const afterSeq = await lastSeqOf(link, sessionId)
      // 流先挂上，消息后发。顺序反了就会漏掉跑得快的那一轮，见文件头。
      const reader = await openEvents(link, sessionId, afterSeq, ac)
      const posted = (await seatJson(link, `/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: 'POST',
        body: { text: routine.instruction },
      })) as { steered?: boolean } | null
      // `steered` = 插进了正在跑的那一轮，等的就是那一轮的收口；否则我们会另起一轮。
      const kind = await readTurnEnd(reader, !posted?.steered)
      await db.finishRoutineRun(run.id, {
        status: kind === 'completed' ? 'ok' : 'error',
        error: kind === 'completed' ? null : turnFailure(kind),
        sessionId,
      })
    } catch (e) {
      const aborted = ac.signal.aborted
      await db
        .finishRoutineRun(run.id, {
          status: 'error',
          error: aborted ? '等结果超时，这一次的结果不明' : (e as Error).message.slice(0, 300),
        })
        .catch(() => {})
    } finally {
      clearTimeout(timer)
      // **等到了也要掐。** 那条 SSE 是席位主动保活的，读到 turn/end 之后它不会自己
      // 结束——不掐的话，每跑一次就在两边各留一条永不关闭的连接。
      ac.abort()
      watching.delete(ac)
    }
  })()
  return run
}

/**
 * 错过多久就不补了。
 *
 * 迟几分钟照跑：那多半是一次部署重启，21:00 的日报 21:03 发出来没有任何问题。迟到
 * **半小时以上**就不是「晚了」而是「错过了」——停机一整天之后，把昨天那份日报在今天
 * 上午十点发出来，既不是人要的东西，还会在重启那一刻一次涌出来一大批。
 */
const LATE_MS = Math.max(60_000, Math.trunc(Number(process.env.GATEWAY_ROUTINE_LATE_MS ?? 30 * 60_000)))

/** 错过的那一次也要留痕：流水上记一条，否则界面上「昨晚没跑」和「跑了没事」长得一样。 */
async function noteMissed(db: Db, routine: Routine, dueAt: number): Promise<void> {
  const run = await db.insertRoutineRun({
    routineId: routine.id,
    botId: routine.botId,
    accountId: routine.accountId,
    companyId: routine.companyId,
    trigger: 'schedule',
  })
  const late = Math.round((Date.now() - dueAt) / 60_000)
  await db.finishRoutineRun(run.id, { status: 'error', error: `错过了这一次（该跑的时候 Gateway 没在跑，已经迟了 ${late} 分钟）` })
}

/**
 * 扫一轮：到点的抢过来，抢到的就跑。
 *
 * **抢是一条带旧值的 update**（见 db.claimRoutine）：两个 Gateway 进程同时扫到同一条
 * 时，只有一个人的 rowCount 是 1。升级换版那几十秒里新旧两代会同时在跑，没有这一句，
 * 那一刻到点的任务会发两遍。
 *
 * 补跑不做，而且**错过太久的连这一次都不跑**（见 LATE_MS）——但会在流水上留一条，
 * 静静地跳过等于让人以为它跑过了。下一次的时间一律从**现在**往后算。
 */
export async function tickRoutines(db: Db, now = Date.now()): Promise<number> {
  const due = await db.dueRoutines(now, BATCH)
  let fired = 0
  for (const routine of due) {
    if (routine.nextRunAt == null) continue
    const dueAt = routine.nextRunAt
    const next = nextRunAtOf(routine, now)
    if (!(await db.claimRoutine(routine.id, dueAt, next))) continue
    /**
     * 指令还空着就不跑，**而且什么都不记**。
     *
     * 手动那条路在接口上就回 400（见 routes/routines.ts），到点这条路不拦的话，
     * 界面上点一下「+」建出来、还没来得及写内容的那条任务，会**每天**发一次空消息、
     * 被席位以 400 顶回来、在运行记录里留一条红的——直到有人想起来删掉它。
     *
     * 这一条排在「错过了」前面：一条还没写完的任务，连「错过」都谈不上。
     */
    if (!routine.instruction.trim()) continue
    if (now - dueAt > LATE_MS) {
      await noteMissed(db, routine, dueAt).catch((e: Error) => {
        console.error(`satuwork-gateway: 日常任务 ${routine.id} 的错过记录写不下去：${e.message}`)
      })
      continue
    }
    // 上一次还没跑完就跳过这一次。定时任务撞车的默认答案是「别叠着跑」——同一个
    // 会话里两轮抢着说话，出来的东西谁也不认。
    if (await db.routineRunning(routine.id)) continue
    fired++
    await runRoutine(db, routine, 'schedule').catch((e: Error) => {
      console.error(`satuwork-gateway: 日常任务 ${routine.id} 起不来：${e.message}`)
    })
  }
  return fired
}

/**
 * 起调度器。返回停它的那个函数。
 *
 * 起来的第一件事是把上一代留下的「正在跑」收干净：等结果的 watcher 活在内存里，
 * 进程一停，库里那条 `running` 就再也没人来改了。
 */
export function startRoutineScheduler(db: Db): () => void {
  if (!TICK_MS) {
    console.log('satuwork-gateway: 日常任务调度器没起（GATEWAY_ROUTINE_TICK_MS=0）')
    return () => {}
  }
  void sweepStaleRuns(db).then((n) => {
    if (n) console.log(`satuwork-gateway: 收掉了 ${n} 条没等到结果的日常任务`)
  })
  let running = false
  const timer = setInterval(() => {
    // 上一轮还没扫完就跳过这一轮：扫的过程里有网络，慢起来会叠。
    if (running) return
    running = true
    void Promise.resolve()
      .then(() => tickRoutines(db))
      // 收尾跟着每一轮跑，不只在启动时跑一次：按年龄划线之后，启动那一次收不到
      // 「刚起来时还不够老、后来也没人管」的那些（比如另一个进程半路被 kill）。
      .then(() => sweepStaleRuns(db))
      /**
       * 转人工的催办跟着同一个节拍走（见 handoff-sweep.ts）。
       *
       * **不新起一个定时器**：两件事的周期一样（半分钟量级的粗节拍），而多一个
       * 定时器就多一处要在关停时记得清的东西——忘了清的表现是进程不退出。
       */
      .then(() => sweepHandoffs(db))
      .catch((e: Error) => console.error(`satuwork-gateway: 日常任务扫描失败：${e.message}`))
      .finally(() => {
        running = false
      })
  }, TICK_MS)
  // 只有它一个定时器的话，进程会因为它一直不退出。
  timer.unref?.()
  return () => {
    clearInterval(timer)
    for (const ac of watching) ac.abort()
    watching.clear()
  }
}
