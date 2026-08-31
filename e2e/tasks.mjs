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
 *
 * 端口向内核要（`freePort`），不写死。写死那一版是从删掉的 kanban.mjs 抄来的 18993，
 * 而 skills.mjs 也写着同一个数——两套一前一后跑，前一套的网关只要慢一拍还没死透，后一套
 * 的 `waitHttp` 探到的就是它：接着整套用例一起红，报的却是「已经有系统管理员了」。
 * 见 e2e/ports.mjs 开头那段。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'

export async function runTasks({ root, gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-tasks')
  const GW_PORT = await freePort()
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

    await test('提交一个没变的值不算「人碰过」', async () => {
      const row = one('报价', (await list()).tasks)
      assert(!row.humanFields.includes('state'), `前提：这条还没被人碰过 ${JSON.stringify(row.humanFields)}`)
      /**
       * 详情弹窗把当前那一档画成 primary，人点一下它是想确认——界面上什么都不会变。
       * 照「提交了就算」写的话，那一次毫无反馈的点击会永久关掉抽取器对这条任务的更新，
       * 而这件事后来真办完了，板上它还停在原地。
       */
      const same = await req(base, 'PATCH', `/tasks/${row.id}`, { token: meTok, body: { state: row.state, title: row.title } })
      assert(same.status === 200, `patch ${same.status} ${same.text}`)
      assert(same.json.task.humanFields.length === 0, `没改就不该记：${JSON.stringify(same.json.task.humanFields)}`)
      // 抽取器照样推得动它。
      await extract([{ key: 'reply-supplier-quote', title: '回复供应商的报价邮件', state: 'doing', summary: '又聊起来了', evidence: '#20 用户又提了一次', firstSeq: 10, lastSeq: 200 }])
      const moved = one('报价', (await list()).tasks)
      assert(moved.state === 'doing', `抽取器该还推得动：${moved.state}`)
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

    await test('界面：一屏四列，人只能改状态 / 改标题 / 删除 / 打开原对话', async () => {
      const { loadApp, el } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: meTok })
      await ui.boot()
      // 侧栏那颗入口进得去：`/tasks` 不在 MEMBER_NAV 里，靠 allowedHrefs 单独放行——
      // 漏了这一行的表现是点一下被踢回首页。
      assert(ui.pathAllowed('/tasks'), '/tasks 该放行')
      assert(ui.html().includes('data-href="/tasks"'), '侧栏没有「任务看板」入口')

      /**
       * **直接摆好 state 再 render**，不走 `go()`：`go` 是 `loadPage().then(render)`，
       * 那一拍之后才画得出来，在这儿等它等于给测试加一个时序赌注。这一条验的是
       * 「同样的数据画成什么」和「点下去干了什么」，路由那一半上面那句已经验过。
       */
      ui.state.path = '/tasks'
      ui.state.tasks = (await list()).tasks
      ui.state.taskCounts = (await list()).counts
      ui.render()
      const html = ui.html()
      assert(['提案', '进行中', '完成'].every((x) => html.includes(x)), `三列该都在：${html.slice(html.indexOf('gw-body'), html.indexOf('gw-body') + 400)}`)
      assert(html.includes('draggable="true"'), '每一条都该拿得起来——这一版的状态是判断，人有权纠正')
      /**
       * **执行面的按钮一个都不许有。** 这一条和下面那条「没有那种路由」是一对：路由没了
       * 而界面上还留着按钮，人点下去看到的是一次 404，比没有按钮更糟。
       */
      for (const gone of ['data-act="task-run"', 'data-act="task-assign"', '重跑', '派给']) {
        assert(!html.includes(gone), `界面上不该还有「${gone}」`)
      }

      /**
       * 点开一条、改一档状态都要先去一趟 Gateway，而那两个动作是 `void … .then(render)`
       * ——**不等就读，读到的是上一拍**。这里等条件成立，不是等一个拍脑袋的毫秒数。
       */
      const settle = async (what, ok) => {
        for (let i = 0; i < 40; i++) {
          if (await ok()) return
          await new Promise((r) => setTimeout(r, 50))
        }
        throw new Error(what)
      }

      /**
       * 列头那个数**只数画出来的**，另有一行「一共 N 条，还有 M 条没显示」跟着一颗
       * 「加载更多」。原来列头放的是服务端总数而卡片只有第一页——数对不上，而且多出来的
       * 那些既看不见也翻不到。
       */
      const shown = ui.state.tasks.filter((x) => x.state === 'doing').length
      assert(html.includes(`>进行中<span>${shown}</span>`) || html.includes(`进行中<span>${shown}</span>`), `列头该只数画出来的 ${shown} 张`)

      const row = ui.state.tasks.find((x) => x.state !== 'dropped' && x.state !== 'done')
      await ui.fire('click', el('button', { 'data-act': 'task-open', 'data-id': row.id }))
      await settle('点一条该开详情', async () => ui.html().includes('gw-modal'))
      assert(ui.html().includes('打开这段对话'), '详情里该有回到原对话那条路——摘要错了只有原文能纠')
      await ui.fire('click', el('button', { 'data-act': 'task-state', 'data-id': row.id, 'data-state': 'done' }))
      await settle('界面上改状态该落库', async () => (await req(base, 'GET', `/tasks/${row.id}`, { token: meTok })).json.task.state === 'done')
      const after = (await req(base, 'GET', `/tasks/${row.id}`, { token: meTok })).json.task
      assert(after.state === 'done', `界面上改状态该落库：${after.state}`)
      assert(after.humanFields.includes('state'), '人改过的那一格要记下来，抽取器之后绕开它')
      /**
       * **走之前把这一页的轮询停掉。**
       *
       * 那条 30 秒的定时器活在垫片里，套件结束它照样在排——响的时候已经是下一个套件，
       * 而它拿到的 DOM 是个查不了的壳。第一次跑完整 e2e 就是这么死的：整场停在 manager
       * 中间，后面十几个套件根本没跑，而屏幕上只有一句 querySelectorAll is not a function。
       * 页面那侧也修了（轮询在响的时候再判一次路径），这里再明说一遍。
       */
      ui.state.path = '/'
    })

    await test('界面：超过一页时给得出「加载更多」，而且真的接得上', async () => {
      const { loadApp, el } = await import('./ui-dom.mjs')
      const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base, token: meTok })
      await ui.boot()
      ui.state.path = '/tasks'
      // 这条会话上面已经灌了几十条，拿一页 5 条来逼出翻页。
      const first = await req(base, 'GET', '/tasks?limit=5', { token: meTok })
      assert(first.status === 200, `list ${first.status} ${first.text}`)
      assert(first.json.cursor, '这么多条了该给出游标')
      ui.state.tasks = first.json.tasks
      ui.state.taskCounts = first.json.counts
      ui.state.taskCursor = first.json.cursor
      ui.render()
      assert(ui.html().includes('data-act="task-more"'), '还有没显示的，就该有「加载更多」')

      const before = ui.state.tasks.length
      await ui.fire('click', el('button', { 'data-act': 'task-more' }))
      for (let i = 0; i < 40 && ui.state.tasks.length === before; i++) await new Promise((r) => setTimeout(r, 50))
      assert(ui.state.tasks.length > before, '点了加载更多，列表该变长')
      // **追加，不是覆盖**；而且不能把上一页重复追一遍。
      const ids = new Set(ui.state.tasks.map((x) => x.id))
      assert(ids.size === ui.state.tasks.length, '翻页翻出了重复的行')
      // 同上：别把一条还在排的轮询留给下一个套件。
      ui.state.path = '/'
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
