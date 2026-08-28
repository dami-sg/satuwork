/**
 * 日常任务跑砸了之后**自己再来三次**（见 docs/routines.md §8）。
 *
 * 为什么值得单开一套：这一层坏了**一声不响**。界面上看到的还是一条红的运行记录，
 * 和「试过了、没成、就这样了」长得一模一样——补跑没排上、排上了没跑、或者反过来永远
 * 停不下来（每五分钟往那条会话里灌一条），都要等到有人翻运行记录才看得出来。而这三种
 * 塌法都不会让任何一条断言以外的东西变红。
 *
 * 席位这一头是个**总是 500 的假席位**：这一套要验的不是那一轮跑得怎么样，是「够不着
 * 席位」——真实世界里定时任务失败最常见的那一类（机器没开、正在换版、网断了一分钟），
 * 也正是重试最该管的那一类。
 *
 * 时间全压到秒级：`GATEWAY_ROUTINE_RETRY_MS` 把 5/15/30 分钟换成几百毫秒，调度器
 * 一秒扫一次。压的是间隔，不是逻辑——排第几次、什么时候停、谁把它清掉，走的都是
 * 线上那一份代码。
 */
import { createServer } from 'node:http'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { createCompany } from './org.mjs'
import { publishRelease } from './release.mjs'
import { pairMachine } from './pair.mjs'
import { freePort } from './ports.mjs'
import { closeServer } from './probe.mjs'

/** 这一套自己的 schema。写死名字会被别的 worktree 的 e2e 清掉（见 pg.mjs 的 schemaOf）。 */
const SCHEMA = schemaOf('e2e_routine_retry')

/** 补跑那三档压到这个量级。调度器一秒扫一次，所以每一档都得比一次 tick 短。 */
const RETRY_MS = [400, 500, 600]
/** 一共补几次。就是上面那个表的长度——界面上「共 N 次」里的 N。 */
const RETRY_MAX = RETRY_MS.length

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
  })
}

/**
 * 假席位：**每一下都 500**，并且把敲门次数记下来。
 *
 * 记次数是要紧的：补跑「排上了」和补跑「真的去跑了」是两件事，只看库里那两格的话，
 * 一个排上了却永远起不来的实现照样能把断言蒙过去。
 */
function deadSeat() {
  const hits = []
  const server = createServer((req, res) => {
    hits.push(req.url.split('?')[0])
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: '席位挂了' }))
  })
  return { server, hits }
}

export async function runRoutineRetry({ gwRoot, test, req, start, waitHttp, assert, log }) {
  log('\n# routine-retry')

  const GW_HOME = tmpOf('satuwork-e2e-routine-retry')
  const GW_PORT = await freePort()
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  rmSync(GW_HOME, { recursive: true, force: true })

  const seat = deadSeat()
  const seatUrl = await listen(seat.server)

  const gw = start('routine-retry-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: SCHEMA,
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '1',
      GATEWAY_OWNER_EMAIL: 'owner@retry.test',
      GATEWAY_OWNER_PASSWORD: 'test-owner-retry',
      SATUWORK_DEPLOY_STUB: '1',
      GATEWAY_ROUTINE_TICK_MS: '1000',
      GATEWAY_ROUTINE_RETRY_MS: RETRY_MS.join(','),
    },
  })

  /** 直接改库：把这条任务的「下一次」拨到刚刚过去，好让下一个 tick 当场抢到它。 */
  const withPg = async (fn) => {
    const { createRequire } = await import('node:module')
    const require = createRequire(new URL('../gateway/package.json', import.meta.url))
    const pg = require('pg')
    const client = new pg.Client({ connectionString: PG_URL })
    await client.connect()
    try {
      await client.query(`set search_path to ${SCHEMA}`)
      return await fn(client)
    } finally {
      await client.end().catch(() => {})
    }
  }

  try {
    await waitHttp(gwBase + '/health', { child: gw, what: 'routine-retry gateway' })

    const reg = await createCompany(req, gwBase, {
      ownerEmail: 'owner@retry.test',
      ownerPassword: 'test-owner-retry',
      email: 'admin@retry.test',
      password: 'correct-horse',
      companyName: 'RetryCo',
      slug: 'retryco',
      seats: 2,
    })
    const adminTok = reg.token
    const ownerTok = reg.ownerToken
    const orgId = reg.company.id

    const me = await req(gwBase, 'GET', '/me', { token: adminTok })
    const accountId = me.json.account.id
    const secrets = await req(gwBase, 'GET', `/platform/accounts/${accountId}`, { token: ownerTok })
    assert(secrets.status === 200, `席位凭证 ${secrets.status} ${secrets.text}`)
    const seatAccess = secrets.json.accessToken

    const madeBot = await req(gwBase, 'POST', '/runtime/bots', { token: adminTok, body: { name: '每日简报' } })
    assert(madeBot.status === 201, `建 Bot ${madeBot.status} ${madeBot.text}`)
    const botId = madeBot.json.bot.id

    await pairMachine({ req, gwBase, ownerTok, orgId })
    await publishRelease({ req, gwBase, token: ownerTok, version: '0.1.0', note: 'e2e-routine-retry' })
    const dep = await req(gwBase, 'POST', '/runtime/deploy', { token: adminTok, body: { botId } })
    assert(dep.status === 200, `deploy ${dep.status} ${dep.text}`)
    const ready = await req(gwBase, 'POST', `/internal/instances/${accountId}/ready`, {
      token: seatAccess,
      body: { host: seatUrl, botId },
    })
    assert(ready.status === 200, `ready ${ready.status} ${ready.text}`)

    const made = await req(gwBase, 'POST', `/runtime/bots/${botId}/routines`, {
      token: adminTok,
      body: {
        name: '每日简报',
        instruction: '把今天的事说一遍',
        tz: 'UTC',
        triggers: [{ kind: 'schedule', every: 'day', at: '09:00', weekday: 1, day: 1 }],
      },
    })
    assert(made.status === 201, `建任务 ${made.status} ${made.text}`)
    const routineId = made.json.routine.id
    assert(made.json.routine.retryAt === null, `新建的就欠着补跑：${made.json.routine.retryAt}`)
    assert(made.json.routine.retryMax === RETRY_MAX, `retryMax ${made.json.routine.retryMax} != ${RETRY_MAX}`)

    const detail = async () => {
      const r = await req(gwBase, 'GET', `/runtime/routines/${routineId}`, { token: adminTok })
      assert(r.status === 200, `详情 ${r.status} ${r.text}`)
      return r.json
    }
    /** 等到这一条不再有正在跑的运行为止。跑一次就是敲一下假席位，几十毫秒的事。 */
    const settled = async (what) => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const d = await detail()
        if (!(d.runs || []).some((x) => x.status === 'running')) return d
        await sleep(100)
      }
      assert(false, `${what}：一直有一轮在跑`)
    }
    /** 把「下一次」拨到刚刚过去，等下一个 tick 把它抢走。 */
    const makeDue = async () => {
      await withPg((c) => c.query('update routines set "nextRunAt" = $1 where id = $2', [Date.now() - 1000, routineId]))
    }
    const runsOf = (d, trigger) => (d.runs || []).filter((x) => x.trigger === trigger)

    await test('试跑砸了不排补跑：人就坐在屏幕前，他要的是这一下的结果', async () => {
      const r = await req(gwBase, 'POST', `/runtime/routines/${routineId}/run`, { token: adminTok, body: {} })
      assert(r.status === 200, `试跑 ${r.status} ${r.text}`)
      const d = await settled('试跑')
      const last = (d.runs || [])[0]
      assert(last && last.status === 'error', `试跑该记成 error：${JSON.stringify(last)}`)
      assert(String(last.error || '').includes('席位挂了'), `失败原因没照实记：${last.error}`)
      assert(d.routine.retryAt === null, `手点的一下排上了补跑：${d.routine.retryAt}`)
      // 多等两个 tick：排没排上看的是库里那一格，而"排上了但没人跑"看的是这里。
      await sleep(2500)
      const after = await detail()
      assert(runsOf(after, 'retry').length === 0, '试跑之后冒出了补跑')
    })

    await test('到点砸了：排下第一次补跑，时刻在未来、次数是 1', async () => {
      const before = seat.hits.length
      await makeDue()
      const deadline = Date.now() + 15000
      let d
      while (Date.now() < deadline) {
        d = await detail()
        if (runsOf(d, 'schedule').length) break
        await sleep(100)
      }
      assert(runsOf(d, 'schedule').length === 1, `到点那一次没跑起来：${JSON.stringify(d && d.runs)}`)
      d = await settled('到点那一次')
      assert(seat.hits.length > before, '压根没去敲席位')
      /**
       * **补跑排在 `retryAt` 上，`nextRunAt` 一动不动。**
       *
       * 写回 `nextRunAt` 的话，一次失败会把人设的「每天 09:00」挪成「09:05」，界面上
       * 那行「下一次」跟着变——他看到的是自己设的时间被系统改掉了。
       */
      assert(d.routine.retryAt > Date.now() - 1000, `补跑没排上：${d.routine.retryAt}`)
      assert(d.routine.retryCount === 1, `第几次不对：${d.routine.retryCount}`)
      const nextDay = new Date(d.routine.nextRunAt)
      assert(
        nextDay.getUTCHours() === 9 && nextDay.getUTCMinutes() === 0,
        `下一次被补跑挪走了：${nextDay.toISOString()}`,
      )
    })

    await test('三次补完就停：不是两次，也不是没完没了', async () => {
      /**
       * 等的是**补跑的条数**，不是「retryAt 空了而且没有在跑的」。
       *
       * 后者在调度器内部也短暂成立一次：`claimRoutineRetry` 把 `retryAt` 抹掉之后、
       * `insertRoutineRun` 把那条 running 插进去之前，中间隔着一次 db 往返。轮询正好
       * 落进那一两毫秒，循环就在第 1 次补跑之后退出，而随后 `armRetry` 已经排上了第 2
       * 次——下面那句 `retryAt === null` 于是在实现完全正确的情况下报「补跑停不下来」。
       */
      const deadline = Date.now() + 20000
      let d
      while (Date.now() < deadline) {
        d = await detail()
        if (runsOf(d, 'retry').length >= RETRY_MAX) break
        await sleep(200)
      }
      d = await settled('补跑')
      assert(d.routine.retryAt === null, `补跑停不下来：${d.routine.retryAt}`)
      assert(runsOf(d, 'retry').length === RETRY_MAX, `补了 ${runsOf(d, 'retry').length} 次，该是 ${RETRY_MAX} 次`)
      // 三次之后再等几个 tick：停不下来的实现要在这儿露头，不然它会每 5 分钟往那条
      // 会话里灌一条，直到有人删了这条任务。
      await sleep(3000)
      const after = await detail()
      assert(runsOf(after, 'retry').length === RETRY_MAX, `停了之后又补了：${runsOf(after, 'retry').length} 次`)
      assert(after.routine.retryAt === null, `又排上了：${after.routine.retryAt}`)
      // 每一次补跑都真的去敲了席位（不是只在库里记了一笔）。
      assert(seat.hits.length >= RETRY_MAX + 2, `席位只被敲了 ${seat.hits.length} 下`)
    })

    await test('拨开关把欠着的补跑收掉：关掉的意思就是别自己动', async () => {
      await makeDue()
      const deadline = Date.now() + 15000
      let d
      while (Date.now() < deadline) {
        d = await detail()
        if (d.routine.retryAt) break
        await sleep(100)
      }
      assert(d.routine.retryAt, '没等到新的一次补跑排上')
      // 到点跑的那一次把上一串一笔勾销：从第 1 次重新数，不是接着第 3 次往下。
      assert(d.routine.retryCount === 1, `到点那一次没把上一串清掉：retryCount=${d.routine.retryCount}`)
      const off = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, { token: adminTok, body: { active: false } })
      assert(off.status === 200, `停用 ${off.status} ${off.text}`)
      assert(off.json.routine.retryAt === null, `停用了还欠着补跑：${off.json.routine.retryAt}`)
      const runsBefore = ((await detail()).runs || []).length
      await sleep(2500)
      const after = await detail()
      assert((after.runs || []).length === runsBefore, '停用之后还自己跑了一次')
      assert(after.routine.retryAt === null, `停用之后又排上了：${after.routine.retryAt}`)
    })

    await test('把时间删光也收掉补跑：界面上写着「还没有设定时间」，它就不能再自己动', async () => {
      /**
       * 判据是「重算出来的下一次是不是 null」，不是「有没有拨开关」——这两条路在人那边
       * 是同一句话。少了这一条的表现最难看：21:00 那次失败排下 21:05 的补跑，人 21:02
       * 把唯一那个时间删掉，21:05 这个 Bot 照样自己把指令发了出去，而那一刻这条任务在
       * 列表上写的是「还没有设定时间」。
       */
      const on = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, { token: adminTok, body: { active: true } })
      assert(on.status === 200 && on.json.routine.nextRunAt, `重新启用 ${on.status} ${on.text}`)
      await makeDue()
      const deadline = Date.now() + 15000
      let d
      while (Date.now() < deadline) {
        d = await detail()
        if (d.routine.retryAt) break
        await sleep(100)
      }
      assert(d.routine.retryAt, '没等到补跑排上')
      const bare = await req(gwBase, 'PATCH', `/runtime/routines/${routineId}`, { token: adminTok, body: { triggers: [] } })
      assert(bare.status === 200, `删光时间 ${bare.status} ${bare.text}`)
      assert(bare.json.routine.nextRunAt === null, `下一次没跟着清掉：${bare.json.routine.nextRunAt}`)
      assert(bare.json.routine.retryAt === null, `时间删光了还欠着补跑：${bare.json.routine.retryAt}`)
      // 这条任务还是「启用」的，所以只有那一格真的清干净了才不会再跑。
      const runsBefore = ((await detail()).runs || []).length
      await sleep(2500)
      const after = await detail()
      assert((after.runs || []).length === runsBefore, '时间删光之后它还是自己跑了一次')
    })
  } finally {
    /**
     * **先杀进程，再删它的数据目录。**
     *
     * 不杀的话它活到整场 e2e 的最后一刻（run.mjs 收尾那次 killAll 才轮得到它）：每秒
     * tick 一次、占着 PG 连接、日志混进后面每一个套件的输出里——而它的数据目录已经在
     * 下面这一行里被删掉了。
     */
    gw.kill()
    await closeServer(seat.server, '席位替身')
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
