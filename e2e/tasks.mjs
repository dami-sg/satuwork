/**
 * 任务看板的 Gateway 一侧（docs/task-board.md）。
 *
 * 验的是这一侧的口径：**抽取器写不过人**、**`dropped` 只有人能推**、状态没变就不动
 * `stateAt`（界面上那行「停滞 N 天」全靠它）、别人的一律 404、两道闸（一次 5 条、一条
 * 会话 60 条）真的拦得住。席位那一侧（判据、预过滤、增量窗口）在 bot/e2e-task-extract.mjs。
 *
 * **还验一件「没有」的事**：这一版没有任何一条能让任务跑起来的路由。那不是注释，是
 * 不变量 1 的实现——所以这里对着几条最像的路径各打一枪，全都得是 404。
 *
 * **用线上的默认参数**，不靠调小上限把测试凑出来。
 */
import { rmSync } from 'node:fs'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'

export async function runTasks({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-tasks')
  const GW_PORT = 18993
  const base = `http://127.0.0.1:${GW_PORT}`

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# tasks')

  const gw = start('tasks-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_tasks'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      GATEWAY_PLATFORM_TOKEN: 'e2e-platform-tasks',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'tasks gateway' })

  let owner = ''
  let adminTok = ''
  let meTok = ''
  let meId = ''
  let seatTok = ''
  let otherTok = ''
  let otherSeatTok = ''
  let orgId = ''
  let botId = ''
  const SESSION = 'session-e2e-tasks'
  const OTHER_SESSION = 'session-e2e-tasks-other'

  /** 席位报一批抽取结果。**归属全由服务端从票上算**，这里只给内容。 */
  const extract = (tasks, opts = {}) =>
    req(base, 'POST', '/internal/tasks/extract', {
      token: opts.token ?? seatTok,
      body: {
        sessionId: opts.sessionId ?? SESSION,
        upto: opts.upto ?? 100,
        model: 'p-util/m-util',
        version: 1,
        tasks,
      },
    })

  const list = async (token = meTok, q = '') => {
    const r = await req(base, 'GET', `/tasks${q}`, { token })
    assert(r.status === 200, `list ${r.status} ${r.text}`)
    return r.json
  }
  const one = (key, rows) => rows.find((x) => x.title.includes(key))

  try {
    await test('建公司、员工、一颗 Bot，报一条会话索引', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@task.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201 || setup.status === 200, `setup ${setup.status} ${setup.text}`)
      owner = setup.json.token

      const org = await req(base, 'POST', '/platform/orgs', {
        token: owner,
        body: {
          name: 'Acme', slug: 'acme-task',
          contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: 'z@acme.test',
          adminEmail: 'a@task.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      orgId = org.json.company.id
      adminTok = (await req(base, 'POST', '/auth/login', { body: { email: 'a@task.test', password: 'correct-horse-1' } })).json.token
      await req(base, 'PUT', `/platform/orgs/${orgId}/plan`, { token: owner, body: { seats: 3 } })

      const mine = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
        token: adminTok,
        body: { email: 'm@task.test', name: '小王', password: 'correct-horse-1', role: 'member' },
      })
      assert(mine.status === 201, `member ${mine.status} ${mine.text}`)
      meId = mine.json.account.id
      meTok = (await req(base, 'POST', '/auth/login', { body: { email: 'm@task.test', password: 'correct-horse-1' } })).json.token
      seatTok = (await req(base, 'GET', `/platform/accounts/${meId}`, { token: owner })).json.accessToken

      const other = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
        token: adminTok,
        body: { email: 'x@task.test', name: '小李', password: 'correct-horse-1', role: 'member' },
      })
      assert(other.status === 201, `other ${other.status} ${other.text}`)
      otherTok = (await req(base, 'POST', '/auth/login', { body: { email: 'x@task.test', password: 'correct-horse-1' } })).json.token
      otherSeatTok = (await req(base, 'GET', `/platform/accounts/${other.json.account.id}`, { token: owner })).json.accessToken

      const bot = await req(base, 'POST', '/runtime/bots', { token: meTok, body: { name: '邮件助理' } })
      assert(bot.status === 201, `bot ${bot.status} ${bot.text}`)
      botId = bot.json.bot.id

      for (const [sid, tok] of [[SESSION, seatTok], [OTHER_SESSION, otherSeatTok]]) {
        const idx = await req(base, 'POST', '/internal/sessions/index', {
          token: tok,
          body: { sessionId: sid, botId: sid === SESSION ? botId : '', messageCount: 4, title: '聊天', createdAt: Date.now(), updatedAt: Date.now() },
        })
        assert(idx.status === 200 || idx.status === 201, `index ${idx.status} ${idx.text}`)
      }
    })

    await test('抽取器认出两件事，板上就有两条', async () => {
      const r = await extract([
        { key: 'reply-supplier-quote', title: '回复供应商的报价邮件', state: 'doing', summary: '报价高了 12%', evidence: '#12 用户让回', firstSeq: 10, lastSeq: 20 },
        { key: 'book-meeting-room', title: '订周四的会议室', state: 'proposed', summary: '', evidence: '#13 助理问要不要订', firstSeq: 21, lastSeq: 22 },
      ])
      assert(r.status === 200, `extract ${r.status} ${r.text}`)
      const data = await list()
      assert(data.tasks.length === 2, `该有两条：${JSON.stringify(data.tasks).slice(0, 300)}`)
      assert(data.counts.doing === 1 && data.counts.proposed === 1, `列头数不对：${JSON.stringify(data.counts)}`)
      // 响应里回的是**这条会话现在挂着的全部**，席位下一次要拿它回喂给模型（§4.3）。
      assert(r.json.open.length === 2, `open 该有两条：${JSON.stringify(r.json.open)}`)
    })

    await test('同一个 key 再报一次：并进去，不新开一条', async () => {
      await extract([{ key: 'reply-supplier-quote', title: '回复供应商的报价邮件', state: 'doing', summary: '改了措辞', evidence: 'x', firstSeq: 10, lastSeq: 40 }])
      const data = await list()
      assert(data.tasks.length === 2, `还是两条：${data.tasks.length}`)
    })

    await test('状态没变就不动 stateAt，变了才动，而且时间线上留一行', async () => {
      const before = one('报价', (await list()).tasks)
      await extract([{ key: 'reply-supplier-quote', title: '回复供应商的报价邮件', state: 'doing', summary: '又改了一版措辞', evidence: 'y', firstSeq: 10, lastSeq: 60 }])
      const same = one('报价', (await list()).tasks)
      /**
       * **这一条是那行「停滞 N 天」成不成立的全部依据。** 抽取器每一轮都会把 lastSeq
       * 往后推，跟着动 stateAt 的话，界面上没有一条任务会显得停滞过。
       */
      assert(same.stateAt === before.stateAt, `状态没变，stateAt 不该动：${before.stateAt} → ${same.stateAt}`)

      await extract([{ key: 'reply-supplier-quote', title: '回复供应商的报价邮件', state: 'done', summary: '已回信', evidence: '#13 gmail_send 成功返回', firstSeq: 10, lastSeq: 70 }])
      const moved = one('报价', (await list()).tasks)
      assert(moved.state === 'done', `该是 done：${moved.state}`)
      assert(moved.stateAt > before.stateAt, '状态变了，stateAt 该往前走')
      assert(moved.doneAt, 'done 了要记下完成时刻')
      const detail = await req(base, 'GET', `/tasks/${moved.id}`, { token: meTok })
      assert(detail.status === 200, `detail ${detail.status} ${detail.text}`)
      const moves = detail.json.events.filter((e) => e.toState === 'done')
      assert(moves.length === 1 && moves[0].kind === 'extract', `时间线上该有一行「抽取器把它推到 done」：${JSON.stringify(detail.json.events)}`)
    })

    await test('抽取器推不到 dropped——那一档只有人能推', async () => {
      const r = await extract([{ key: 'book-meeting-room', title: '订周四的会议室', state: 'dropped', summary: '', evidence: '后来没再提', firstSeq: 21, lastSeq: 80 }])
      assert(r.status === 200, `extract ${r.status} ${r.text}`)
      const still = one('会议室', (await list()).tasks)
      /**
       * 一件真被放弃的事和一件被忘掉的事，在会话里长得一模一样，而后者恰恰是这块板存在
       * 的理由。所以模型报 `dropped` 的那一条**整条丢掉**，不是照写。
       */
      assert(still.state === 'proposed', `该还在提案里：${still.state}`)
    })

    await test('人改过的字段，抽取器不再覆盖', async () => {
      const row = one('会议室', (await list()).tasks)
      const patched = await req(base, 'PATCH', `/tasks/${row.id}`, { token: meTok, body: { title: '订周四下午的大会议室' } })
      assert(patched.status === 200, `patch ${patched.status} ${patched.text}`)
      assert(patched.json.task.humanFields.includes('title'), `该记下人碰过 title：${JSON.stringify(patched.json.task.humanFields)}`)

      await extract([{ key: 'book-meeting-room', title: '订会议室', state: 'doing', summary: '人让订了', evidence: 'z', firstSeq: 21, lastSeq: 90 }])
      const after = (await list()).tasks.find((x) => x.id === row.id)
      assert(after.title === '订周四下午的大会议室', `标题该保持人改的那份：${after.title}`)
      // 人只碰了标题，状态这一格照旧归抽取器管——冻住整条的话，人改个错别字就等于接管了
      // 这条任务的全部判断。
      assert(after.state === 'doing', `状态该跟着抽取器走：${after.state}`)
    })

    await test('人能把一条推到 dropped', async () => {
      const row = one('会议室', (await list()).tasks)
      const r = await req(base, 'PATCH', `/tasks/${row.id}`, { token: meTok, body: { state: 'dropped' } })
      assert(r.status === 200, `patch ${r.status} ${r.text}`)
      assert(r.json.task.state === 'dropped', `该是 dropped：${r.json.task.state}`)
      const detail = await req(base, 'GET', `/tasks/${row.id}`, { token: meTok })
      assert(detail.json.events.some((e) => e.kind === 'human' && e.toState === 'dropped'), '时间线上该留一行「人把它放弃了」')
    })

    await test('别人的任务一律 404，不是 403', async () => {
      const row = (await list()).tasks[0]
      const got = await req(base, 'GET', `/tasks/${row.id}`, { token: otherTok })
      assert(got.status === 404, `别人读该 404：${got.status}`)
      const patched = await req(base, 'PATCH', `/tasks/${row.id}`, { token: otherTok, body: { state: 'done' } })
      assert(patched.status === 404, `别人改该 404：${patched.status}`)
      const gone = await req(base, 'DELETE', `/tasks/${row.id}`, { token: otherTok })
      assert(gone.status === 404, `别人删该 404：${gone.status}`)
      // 别人的席位也报不进我的会话：判据是 session_index 上那一行的归属。
      const posted = await extract([{ key: 'x', title: '插一条', state: 'doing', firstSeq: 1, lastSeq: 2 }], { token: otherSeatTok })
      assert(posted.status === 404, `别人的席位该 404：${posted.status} ${posted.text}`)
    })

    await test('一次最多认 5 件事，多的截掉', async () => {
      const many = Array.from({ length: 8 }, (_, i) => ({
        key: `bulk-${i}`, title: `批量 ${i}`, state: 'doing', summary: '', evidence: '', firstSeq: 100 + i, lastSeq: 101 + i,
      }))
      const r = await extract(many)
      assert(r.status === 200, `extract ${r.status} ${r.text}`)
      const bulk = (await list()).tasks.filter((x) => x.title.startsWith('批量'))
      assert(bulk.length === 5, `该只进 5 条：${bulk.length}`)
    })

    await test('一条会话的任务数到上限就整批拒收', async () => {
      // 已经有 2 + 5 条，再灌到 60。**拒收整批，不是截断**：到这儿要看的是抽取器为什么
      // 在把每一轮都认成新任务，而截断会在板上留下一半失控的结果，没有任何东西会响。
      for (let round = 0; round < 11; round++) {
        const batch = Array.from({ length: 5 }, (_, i) => ({
          key: `fill-${round}-${i}`, title: `填 ${round}-${i}`, state: 'doing', summary: '', evidence: '', firstSeq: 200, lastSeq: 201,
        }))
        const r = await extract(batch)
        if (r.status === 409) break
        assert(r.status === 200, `fill ${r.status} ${r.text}`)
      }
      const capped = await extract([{ key: 'one-more', title: '再来一条', state: 'doing', firstSeq: 300, lastSeq: 301 }])
      assert(capped.status === 409, `到上限该 409：${capped.status} ${capped.text}`)
    })

    await test('删掉一条就真没了', async () => {
      const row = (await list()).tasks[0]
      const r = await req(base, 'DELETE', `/tasks/${row.id}`, { token: meTok })
      assert(r.status === 200, `delete ${r.status} ${r.text}`)
      const after = await req(base, 'GET', `/tasks/${row.id}`, { token: meTok })
      assert(after.status === 404, `删完该 404：${after.status}`)
    })

    await test('没有任何一条路能让一条任务跑起来', async () => {
      /**
       * **不变量 1。** 这几条不是「以前有、现在关了」，是压根不存在——所以断言的是
       * 404（路由表里没有），不是 403。哪天有人为了「顺手」加回其中一条，这一条会红。
       */
      const row = (await list()).tasks[0]
      for (const path of [`/tasks/${row.id}/run`, `/tasks/${row.id}/retry`, `/tasks/${row.id}/assign`, '/kanban/boards']) {
        const r = await req(base, 'POST', path, { token: meTok, body: {} })
        assert(r.status === 404, `${path} 该不存在：${r.status}`)
      }
    })
  } finally {
    gw.kill()
    rmSync(GW_HOME, { recursive: true, force: true })
  }
}
