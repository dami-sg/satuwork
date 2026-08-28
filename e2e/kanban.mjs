/**
 * 多 Bot 看板的 Gateway 一侧（docs/kanban.md）。
 *
 * 验的是这一侧的口径：**板只有它的主人看得见**（口径〇，管理员和 owner 也不例外，
 * 而且回 404 不是 403）、成员只能是自己名下的 Bot、派活派不出成员名单、依赖不跨板也
 * 不成圈。调度、席位、卡真的跑起来那一段在后面几个阶段。
 *
 * **用线上的默认参数**，不靠调小上限把测试凑出来。
 */
import { rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { pairMachine } from './pair.mjs'
import { publishRelease } from './release.mjs'

export async function runKanban({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-kanban')
  const GW_PORT = 18993
  const base = `http://127.0.0.1:${GW_PORT}`

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# kanban')

  const gw = start('kanban-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schemaOf('e2e_kanban'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      GATEWAY_PLATFORM_TOKEN: 'e2e-platform-kanban',
      // 调度器要真的转：派卡那条链子（收依赖 → 抢 → 派 → 回报）只有跑起来才验得到。
      // 300ms 是为了让用例不用等半分钟；退避那两个数也一起调小，理由同上——但**判据
      // 本身一个字没改**，验的仍然是「真失败等得比 busy 久」。
      GATEWAY_ROUTINE_TICK_MS: '300',
      GATEWAY_KANBAN_RETRY_DELAY_MS: '2000',
      GATEWAY_KANBAN_REQUEUE_DELAY_MS: '200',
      GATEWAY_KANBAN_STALE_MS: '60000',
      // 不联系管家的部署（同 handoff / gateway-chat 那几套）：这一套验的是调度，
      // 不是「机器上怎么把席位装起来」。
      SATUWORK_DEPLOY_STUB: '1',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'kanban gateway' })

  let owner = ''
  let adminTok = ''
  let meTok = ''
  let otherTok = ''
  let orgId = ''
  let designBot = ''
  let writeBot = ''
  let otherBot = ''
  let boardId = ''
  let seatTok = ''
  let meId = ''
  let machineTok = ''
  let seatPort = 0
  let seatSrv = null
  let seatGot = []
  let seatSays = () => {}
  let seatBrowserBusy = () => {}
  let doneCardId = ''

  /**
   * 替席位报一次收口。
   *
   * 假席位只收不报（它不是一个真的 Bot），所以每条用例都得自己把开出去的那张收回来
   * ——**并发闸是「一颗 Bot 同时一张」**，漏收一张，后面每一条用例都会等在门外，
   * 而报出来的错是「该被派出去」，指不到真正的原因。
   */
  const settleQuiet = (id, body = { status: 'ok', summary: 'e2e 收口' }) =>
    req(base, 'POST', `/internal/kanban/cards/${id}/result`, { token: machineTok, body })

  const settle = async (id, body) => {
    const r = await settleQuiet(id, body)
    // **收不下就当场红**：漏掉一张没收口的卡，它会一直占着那一格闸，而报错的会是后面
    // 某条完全不相干的用例（「该被派出去」），指不到这里。
    //
    // **但清场那条路不能用它**（用 settleQuiet）：那个循环是「读一眼板 → 逐张处理」，
    // 中间调度器会把卡从 running 退回 ready，于是 409 是**合法的**，靠下一圈再来。
    // 拿这条硬断言去卡它，等于把一次预期之内的竞态变成致命错。
    assert(r.status === 200, `收口 ${id} 失败：${r.status} ${r.text}`)
    return r
  }

  /**
   * 等某张卡被派出去。
   *
   * **等不到就把整块板的状态 dump 出来**：并发闸是「一颗 Bot 同时一张」，等不到多半是
   * 那一格被别的卡占着——只报一句「没被派出去」，查不到是被谁占的。
   */
  const untilRunning = async (id, what) => {
    const got = await until(async () => {
      const r = await req(base, 'GET', `/kanban/cards/${id}`, { token: meTok })
      return r.json.card.state === 'running' ? r.json.card : null
    })
    if (!got) {
      const dump = await req(base, 'GET', `/kanban/boards/${boardId}`, { token: meTok })
      assert(false, `${what}：板上现在是 ${JSON.stringify(dump.json.cards.map((c) => [c.title, c.state, c.assigneeBotId === designBot ? 'design' : 'write']))}`)
    }
    return got
  }

  /**
   * 把一张卡收干净（撤掉），**盯到它真的走到终态为止**。
   *
   * 「先 GET 看状态、再决定 cancel 还是 abort」这两跳中间隔着 120ms 的轮询间隔，而调度器
   * 每 300ms 转一圈——卡完全可能在这个缝里被抢走，于是 `cancel` 撞上 409「正在跑」。
   * **这个形状在这一套里出现过三次**（清场循环、要浏览器那张、撤销那张），每次都表现成
   * 后面某条不相干的用例「该被派出去」不成立，因为那张漏网的卡一直占着并发闸。
   *
   * 所以只留这一个入口：循环、不断言中间那几跳、只断言最后真的到了终态。
   */
  const dropCard = async (id) => {
    const done = await until(async () => {
      const r = await req(base, 'GET', `/kanban/cards/${id}`, { token: meTok })
      const st = r.json.card.state
      if (st === 'cancelled' || st === 'done' || st === 'archived') return true
      if (st === 'running') await req(base, 'POST', `/kanban/cards/${id}/abort`, { token: meTok })
      else if (st === 'blocked') await req(base, 'POST', `/kanban/cards/${id}/cancel`, { token: meTok })
      else await req(base, 'POST', `/kanban/cards/${id}/cancel`, { token: meTok })
      return null
    })
    assert(done, `这张卡没收干净（${id}），它会一直占着那一格闸`)
  }

  /**
   * 等这张卡的执行包**真的落到席位上**。
   *
   * **不能等「状态变 running」再去翻 `seatGot`。** 调度器是先 CAS 抢成 `running`、再发
   * 那一跳 HTTP 的，中间那个窗口机器一忙就张开——状态早就是 running 了，而包还在路上，
   * 于是断言看到一个空数组，报出来的是「执行包该送到席位」，指不到「你等错了东西」。
   */
  const untilPack = async (cardId, what) => {
    const got = await until(async () => seatGot.filter((g) => g.pack.cardId === cardId).pop() ?? null)
    if (!got) {
      const dump = await req(base, 'GET', `/kanban/cards/${cardId}`, { token: meTok })
      assert(false, `${what}：这张卡现在是 ${dump.json.card.state}，而席位一个包都没收到`)
    }
    return got
  }

  /** 等一件事发生。调度器每 300ms 转一圈，所以这里的轮询要比它密。 */
  const until = async (probe, timeout = 15000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeout) {
      const got = await probe()
      if (got) return got
      await new Promise((x) => setTimeout(x, 120))
    }
    return null
  }

  /** 席位视角的那一份目录。板、指纹都从这里读。 */
  const catalog = async (bot) => {
    const r = await req(base, 'GET', `/runtime/catalog?botId=${encodeURIComponent(bot)}`, { token: seatTok })
    assert(r.status === 200, `catalog ${r.status} ${r.text}`)
    return r.json
  }
  const stamp = async (bot) => {
    const r = await req(base, 'GET', `/runtime/catalog/version?botId=${encodeURIComponent(bot)}`, { token: seatTok })
    assert(r.status === 200, `probe ${r.status} ${r.text}`)
    return r.json.stamp
  }

  try {
    await test('建公司、两个员工、各自的 Bot', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'o@kan.test', name: 'o', password: 'correct-horse-1' },
      })
      assert(setup.status === 201 || setup.status === 200, `setup ${setup.status} ${setup.text}`)
      owner = setup.json.token

      const org = await req(base, 'POST', '/platform/orgs', {
        token: owner,
        body: {
          name: 'Acme', slug: 'acme-kan',
          contactName: '张三', contactPhone: '+86 138 0000 0000', contactEmail: 'z@acme.test',
          adminEmail: 'a@kan.test', adminPassword: 'correct-horse-1',
        },
      })
      assert(org.status === 201, `org ${org.status} ${org.text}`)
      orgId = org.json.company.id
      adminTok = (await req(base, 'POST', '/auth/login', { body: { email: 'a@kan.test', password: 'correct-horse-1' } })).json.token
      await req(base, 'PUT', `/platform/orgs/${orgId}/plan`, { token: owner, body: { seats: 4 } })

      for (const [email, name] of [['me@kan.test', '小李'], ['other@kan.test', '小周']]) {
        const made = await req(base, 'POST', `/orgs/${orgId}/accounts`, {
          token: adminTok,
          body: { email, name, password: 'correct-horse-1', role: 'member' },
        })
        assert(made.status === 201, `member ${made.status} ${made.text}`)
      }
      meTok = (await req(base, 'POST', '/auth/login', { body: { email: 'me@kan.test', password: 'correct-horse-1' } })).json.token
      meId = (await req(base, 'GET', '/me', { token: meTok })).json.account.id
      seatTok = (await req(base, 'GET', `/platform/accounts/${meId}`, { token: owner })).json.accessToken
      otherTok = (await req(base, 'POST', '/auth/login', { body: { email: 'other@kan.test', password: 'correct-horse-1' } })).json.token

      const mk = async (token, name) => {
        const r = await req(base, 'POST', '/runtime/bots', { token, body: { name } })
        assert(r.status === 201, `bot ${r.status} ${r.text}`)
        return r.json.bot.id
      }
      designBot = await mk(meTok, '出图的')
      writeBot = await mk(meTok, '写字的')
      otherBot = await mk(otherTok, '别人的')
    })

    await test('建板、加自己的两颗 Bot', async () => {
      const made = await req(base, 'POST', '/kanban/boards', {
        token: meTok,
        body: { name: '新品上线', brief: '这块板上跑的是新品的物料' },
      })
      assert(made.status === 201, `board ${made.status} ${made.text}`)
      boardId = made.json.board.id

      for (const [botId, role] of [[designBot, '出图'], [writeBot, '审校']]) {
        const r = await req(base, 'POST', `/kanban/boards/${boardId}/members`, { token: meTok, body: { botId, role } })
        assert(r.status === 201, `member ${r.status} ${r.text}`)
      }
      const board = await req(base, 'GET', `/kanban/boards/${boardId}`, { token: meTok })
      assert(board.status === 200, `board ${board.status} ${board.text}`)
      assert(board.json.members.length === 2, `该有两个成员：${board.text}`)
      // role 那一列要出得去：派活的那颗 Bot 靠它挑人，不然只能按名字猜。
      assert(board.json.members.some((m) => m.role === '出图'), `成员该带 role：${board.text}`)
    })

    await test('板下发到席位，而且指纹跟着动——不然工具永远不出现', async () => {
      /**
       * **这个洞的第四次**（前三次是连接器、模型角色、记忆）。板不在 catalog_items 里，
       * 把一颗 Bot 加进板时那张表一个字节都不会变；不算进指纹的话，每分钟那次探针一直
       * 判「没变」，席位永远不重拉，`kanban_*` 那几把工具**整组不出现**——而界面上那次
       * 「加进板」明明回了成功。
       */
      const seen = await catalog(designBot)
      assert(Array.isArray(seen.boards) && seen.boards.length === 1, `目录里该带板：${JSON.stringify(seen.boards)}`)
      assert(seen.boards[0].role === '出图', `role 要跟着下来：${JSON.stringify(seen.boards)}`)
      assert(seen.boards[0].brief.includes('新品'), `brief 要跟着下来：${JSON.stringify(seen.boards)}`)
      assert((await catalog(writeBot)).boards.length === 1, '写字的那颗也在这块板上')
      // 不在任何板上的那颗看不见板——不然它会注册一组它根本用不上的工具。
      const loner = (await req(base, 'POST', '/runtime/bots', { token: meTok, body: { name: '闲着的' } })).json.bot.id
      assert((await catalog(loner)).boards.length === 0, '不在板上的那颗不该看见任何板')

      const before = await stamp(designBot)
      const fresh = (await req(base, 'POST', '/kanban/boards', { token: meTok, body: { name: '临时板' } })).json.board
      await req(base, 'POST', `/kanban/boards/${fresh.id}/members`, { token: meTok, body: { botId: designBot, role: '打杂' } })
      // 加成员不动 boards.updatedAt，所以指纹里那半个「条数」是必须的。
      assert((await stamp(designBot)) !== before, '加进一块新板之后指纹该变')

      const after = await stamp(designBot)
      await req(base, 'DELETE', `/kanban/boards/${fresh.id}/members/${designBot}`, { token: meTok })
      assert((await stamp(designBot)) !== after, '退出一块板之后指纹也该变')
      await req(base, 'DELETE', `/kanban/boards/${fresh.id}`, { token: meTok })
    })

    await test('别人一个字都看不见——admin 和 owner 也不例外，而且是 404', async () => {
      /**
       * 口径〇。403 等于告诉他这块板存在、只是他进不去——而板名本身就是内容
       * （「面试候选人筛选」「离职交接」）。
       */
      for (const [who, token] of [['同事', otherTok], ['管理员', adminTok], ['平台 owner', owner]]) {
        const one = await req(base, 'GET', `/kanban/boards/${boardId}`, { token })
        assert(one.status === 404, `${who}读我的板该 404，实际 ${one.status} ${one.text}`)
        const patched = await req(base, 'PATCH', `/kanban/boards/${boardId}`, { token, body: { name: '改了' } })
        assert(patched.status === 404, `${who}改我的板该 404，实际 ${patched.status}`)
        const carded = await req(base, 'POST', `/kanban/boards/${boardId}/cards`, { token, body: { title: '塞一张' } })
        assert(carded.status === 404, `${who}往我的板建卡该 404，实际 ${carded.status}`)
      }
      // 列表里也不能冒出来——「看不见」不是「点进去才 404」。
      const list = await req(base, 'GET', '/kanban/boards', { token: adminTok })
      assert(list.status === 200 && list.json.boards.length === 0, `管理员的板列表该是空的：${list.text}`)
    })

    await test('加别人名下的 Bot 进板：404，板上不留痕', async () => {
      const r = await req(base, 'POST', `/kanban/boards/${boardId}/members`, { token: meTok, body: { botId: otherBot } })
      assert(r.status === 404, `该 404，实际 ${r.status} ${r.text}`)
      const board = await req(base, 'GET', `/kanban/boards/${boardId}`, { token: meTok })
      assert(board.json.members.length === 2, `成员数不该变：${board.text}`)
    })

    await test('派给不在板上的 Bot：拒绝，并把能派的那几个原样列出来', async () => {
      const r = await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok,
        body: { title: '画三张主图', assigneeBotId: otherBot },
      })
      assert(r.status === 400, `该 400，实际 ${r.status} ${r.text}`)
      // 「告诉它有哪些选项」比「告诉它你错了」有用——它下一步就能改对。
      assert(r.text.includes(designBot) && r.text.includes('出图'), `拒绝里该带名单：${r.text}`)
    })

    await test('没有父卡的卡直接 ready，不经过 todo', async () => {
      const r = await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok,
        body: { title: '画三张主图', assigneeBotId: designBot, body: '尺寸见 brief' },
      })
      assert(r.status === 201, `card ${r.status} ${r.text}`)
      assert(r.json.card.state === 'ready', `该直接 ready：${r.text}`)
    })

    await test('没写理由的 utility 降成 daily，而且留痕', async () => {
      /**
       * 抄 delegation §8.3：先蹦出档位再补理由，写出来的是事后合理化。降级要看得出来，
       * 否则人在板上看到 daily 会以为那是模型选的。
       */
      const bare = await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok,
        body: { title: '抄一份报价表', modelRole: 'utility' },
      })
      assert(bare.status === 201, `card ${bare.status} ${bare.text}`)
      assert(bare.json.card.modelRole === 'daily', `没理由该降级：${bare.text}`)
      assert(bare.json.card.modelDowngraded === true, `降级要留痕：${bare.text}`)

      const withReason = await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok,
        body: { title: '再抄一份', modelRole: 'utility', modelReason: '格式定死了，漏一行一眼能看见' },
      })
      assert(withReason.json.card.modelRole === 'utility', `给了理由就该是 utility：${withReason.text}`)
      assert(withReason.json.card.modelDowngraded === false, `这次不该标降级：${withReason.text}`)
    })

    await test('加了依赖：子卡从 ready 退回 todo；拆了又回来', async () => {
      const mk = async (title) =>
        (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, { token: meTok, body: { title, assigneeBotId: designBot } })).json.card
      const parent = await mk('先写文案')
      const child = await mk('再排版')

      const linked = await req(base, 'POST', '/kanban/links', { token: meTok, body: { parentId: parent.id, childId: child.id } })
      assert(linked.status === 201, `link ${linked.status} ${linked.text}`)
      let after = await req(base, 'GET', `/kanban/cards/${child.id}`, { token: meTok })
      assert(after.json.card.state === 'todo', `有父卡就该等着：${after.text}`)
      assert(after.json.parents.length === 1, `父卡该查得到：${after.text}`)
      // 时间线上要留下这一笔，否则「这张卡怎么不动了」事后查不出来。
      assert(after.json.timeline.some((t) => t.kind === 'system' && t.body.includes('先写文案')), `时间线该留一行：${after.text}`)

      const unlinked = await req(base, 'DELETE', `/kanban/links/${parent.id}/${child.id}`, { token: meTok })
      assert(unlinked.status === 200, `unlink ${unlinked.status} ${unlinked.text}`)
      after = await req(base, 'GET', `/kanban/cards/${child.id}`, { token: meTok })
      assert(after.json.card.state === 'ready', `没父卡了就该回待派：${after.text}`)
    })

    await test('依赖不成圈，也不跨板', async () => {
      const mk = async (board, title) =>
        (await req(base, 'POST', `/kanban/boards/${board}/cards`, { token: meTok, body: { title } })).json.card
      const a = await mk(boardId, 'A')
      const b = await mk(boardId, 'B')
      await req(base, 'POST', '/kanban/links', { token: meTok, body: { parentId: a.id, childId: b.id } })

      /**
       * A→B 已经在了，再建 B→A 的话两张卡会永远互相等着，而板上看起来只是「还有父卡
       * 没做完」——一个查不出原因的僵局。
       */
      const cycle = await req(base, 'POST', '/kanban/links', { token: meTok, body: { parentId: b.id, childId: a.id } })
      assert(cycle.status === 400 && cycle.text.includes('圈'), `成圈该被拒：${cycle.status} ${cycle.text}`)

      const self = await req(base, 'POST', '/kanban/links', { token: meTok, body: { parentId: a.id, childId: a.id } })
      assert(self.status === 400, `自己依赖自己该被拒：${self.status}`)

      const other = (await req(base, 'POST', '/kanban/boards', { token: meTok, body: { name: '另一块' } })).json.board
      const c = await mk(other.id, 'C')
      const cross = await req(base, 'POST', '/kanban/links', { token: meTok, body: { parentId: a.id, childId: c.id } })
      assert(cross.status === 400 && cross.text.includes('跨板'), `跨板该被拒：${cross.status} ${cross.text}`)
    })

    await test('没做完的卡谈不上打回和归档；没卡住的卡谈不上解锁', async () => {
      const card = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, { token: meTok, body: { title: '随便一张' } })).json.card
      for (const [path, what] of [['reopen', '打回'], ['archive', '归档']]) {
        const r = await req(base, 'POST', `/kanban/cards/${card.id}/${path}`, { token: meTok, body: { reason: '不行' } })
        assert(r.status === 409, `${what}没做完的卡该 409，实际 ${r.status} ${r.text}`)
      }
      const un = await req(base, 'POST', `/kanban/cards/${card.id}/unblock`, { token: meTok })
      assert(un.status === 409, `解锁没卡住的卡该 409，实际 ${un.status} ${un.text}`)
    })

    await test('撤销之后就不在板上了，再撤一次 409', async () => {
      const card = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, { token: meTok, body: { title: '算了不做了' } })).json.card
      const r = await req(base, 'POST', `/kanban/cards/${card.id}/cancel`, { token: meTok })
      assert(r.status === 200 && r.json.card.state === 'cancelled', `cancel ${r.status} ${r.text}`)
      const again = await req(base, 'POST', `/kanban/cards/${card.id}/cancel`, { token: meTok })
      assert(again.status === 409, `再撤一次该 409，实际 ${again.status}`)
    })

    await test('模型那一组：走 /runtime + 席位票，botId 验归属', async () => {
      const seat = (method, path, body) => req(base, method, `/runtime/kanban${path}`, { token: seatTok, body })
      const q = `?botId=${encodeURIComponent(designBot)}`

      const list = await seat('GET', `/boards${q}`)
      assert(list.status === 200, `list ${list.status} ${list.text}`)
      const board = list.json.boards.find((b) => b.id === boardId)
      assert(board, `该看得见这块板：${list.text}`)
      // 一把工具答完三个问题：有哪些板、板上有谁、板上有什么卡。模型只有这一条路问路。
      assert(board.members.length === 2 && board.members.some((m) => m.role === '出图'), `成员要带出去：${list.text}`)
      assert(Array.isArray(board.cards), `卡要带出去：${list.text}`)
      // 收口的不列：模型要的是「现在还有什么活」，一屏历史只会挤掉那几条。
      assert(!board.cards.some((c) => c.state === 'cancelled'), `撤销的不该列出来：${list.text}`)

      // **请求体是模型拼的**：一个编出来的 botId 不该换来别人的板。
      const stolen = await req(base, 'GET', `/runtime/kanban/boards?botId=${encodeURIComponent(otherBot)}`, { token: seatTok })
      assert(stolen.status === 404, `拿别人的 botId 该 404，实际 ${stolen.status} ${stolen.text}`)
    })

    await test('模型建卡：一次一块板，assignee 只能从名单里挑', async () => {
      const seat = (path, body) => req(base, 'POST', `/runtime/kanban${path}?botId=${encodeURIComponent(designBot)}`, { token: seatTok, body })

      const made = await seat('/cards', {
        board: boardId,
        cards: [
          { title: '出三张主图', assignee: designBot, body: '尺寸见 brief', model_reason: '格式定死了', model_role: 'utility' },
          { title: '审一遍文案', assignee: writeBot, body: '看有没有夸大', model_reason: '要判断算不算夸大', model_role: 'daily' },
        ],
      })
      assert(made.status === 201, `create ${made.status} ${made.text}`)
      assert(made.json.cards.length === 2, `该建出两张：${made.text}`)
      assert(made.json.cards[0].createdByBotId === designBot, `要记下是谁建的：${made.text}`)

      const outsider = await seat('/cards', {
        board: boardId,
        cards: [{ title: '给别人', assignee: otherBot, model_reason: 'x', model_role: 'daily' }],
      })
      assert(outsider.status === 400 && outsider.text.includes(writeBot), `派到名单外该被拒并列出名单：${outsider.text}`)
    })

    await test('在好几块板上就必须点名往哪块建', async () => {
      const second = (await req(base, 'POST', '/kanban/boards', { token: meTok, body: { name: '另一摊事' } })).json.board
      await req(base, 'POST', `/kanban/boards/${second.id}/members`, { token: meTok, body: { botId: designBot } })
      const r = await req(base, 'POST', `/runtime/kanban/cards?botId=${encodeURIComponent(designBot)}`, {
        token: seatTok,
        body: { cards: [{ title: '不知道往哪建', assignee: designBot, model_reason: 'x', model_role: 'daily' }] },
      })
      // 主会话里没有「当前这块板」这个东西：人上一句在聊别的，下一句说「派给设计 Bot」。
      assert(r.status === 400 && r.text.includes(second.id), `该逼它点名并列出板：${r.status} ${r.text}`)
      await req(base, 'DELETE', `/kanban/boards/${second.id}`, { token: meTok })
    })

    await test('同一次调用里两张一样的：合并成一张，把卡号回给它', async () => {
      /**
       * 模型换个措辞又撞一次是常态，而板上出现三张一模一样的卡，人会把三张都派出去。
       * 唯一索引是唯一原子的那个：一次调用里的五张同一毫秒落库，先查后插拦不住自己。
       */
      const r = await req(base, 'POST', `/runtime/kanban/cards?botId=${encodeURIComponent(designBot)}`, {
        token: seatTok,
        body: {
          board: boardId,
          cards: [
            { title: '把报价页抓一份', assignee: designBot, model_reason: '抓取', model_role: 'utility' },
            { title: '把报价页抓一份 ', assignee: designBot, model_reason: '抓取', model_role: 'utility' },
          ],
        },
      })
      assert(r.status === 201, `create ${r.status} ${r.text}`)
      assert(r.json.cards[0].id === r.json.cards[1].id, `该是同一张：${r.text}`)
      assert(r.json.merged.length === 1, `合并的要报出来，不然模型以为自己建了两张：${r.text}`)
    })

    await test('模型建依赖和留言：不跨板、不成圈，时间线上留得下', async () => {
      const q = `?botId=${encodeURIComponent(designBot)}`
      const mk = async (title) =>
        (await req(base, 'POST', `/runtime/kanban/cards${q}`, {
          token: seatTok,
          body: { board: boardId, cards: [{ title, assignee: designBot, model_reason: 'x', model_role: 'daily' }] },
        })).json.cards[0]
      const first = await mk('先做的')
      const then = await mk('后做的')

      const linked = await req(base, 'POST', `/runtime/kanban/cards/${then.id}/links${q}`, { token: seatTok, body: { parentId: first.id } })
      assert(linked.status === 201, `link ${linked.status} ${linked.text}`)
      const cycle = await req(base, 'POST', `/runtime/kanban/cards/${first.id}/links${q}`, { token: seatTok, body: { parentId: then.id } })
      assert(cycle.status === 400, `成圈该被拒，实际 ${cycle.status} ${cycle.text}`)

      const said = await req(base, 'POST', `/runtime/kanban/cards/${then.id}/comments${q}`, {
        token: seatTok,
        body: { body: '第三家要登录，跳过' },
      })
      assert(said.status === 201, `comment ${said.status} ${said.text}`)
      const seen = await req(base, 'GET', `/kanban/cards/${then.id}`, { token: meTok })
      assert(seen.json.timeline.some((t) => t.authorBotId === designBot && t.body.includes('登录')), `人也该看得见：${seen.text}`)
    })

    await test('派卡：调度器抢到、送到席位、席位回报，卡走完一整条', async () => {
      /**
       * 假席位：只回答「收下了没有」。跑完由它自己打 /internal/kanban/cards/:id/result
       * ——**不挂事件流、不等 turn/end**，这正是和 routines 那条路最大的区别。
       */
      const got = []
      let reply = 200
      /**
       * 「那块屏被占着」单独一个开关。
       *
       * `reply` 是**整台席位**的回话，做不出「只有这一张派不出去」——而队头阻塞那条
       * 用例要的正是这个形状：一张要浏览器的卡一直 409，别的卡照收。生产里 409 的判据
       * 本来就是 `needsBrowser` + 那块屏被占着，这里照抄。
       */
      let browserBusy = false
      const seat = createServer((rq, rs) => {
        let raw = ''
        rq.on('data', (d) => (raw += d))
        rq.on('end', () => {
          // `notify: report` 那条路要先问「这颗 Bot 的长会话是哪条」，再往里发消息。
          // **按 /api/bots/ 认，不按 '/session' 认**：`/api/sessions/x/messages` 里也有
          // 那个词，一起吃掉的话发消息那一跳会被当成问会话，而断言只会说「没发出去」。
          if (rq.url.startsWith('/api/bots/')) {
            rs.writeHead(200, { 'content-type': 'application/json' })
            rs.end(JSON.stringify({ sessionId: 's-main' }))
            return
          }
          got.push({ url: rq.url, pack: JSON.parse(raw || '{}') })
          if (rq.url.includes('/messages')) {
            rs.writeHead(200, { 'content-type': 'application/json' })
            rs.end('{}')
            return
          }
          if (browserBusy && JSON.parse(raw || '{}').needsBrowser === true) {
            rs.writeHead(409, { 'content-type': 'application/json' })
            rs.end(JSON.stringify({ error: '浏览器被占着' }))
            return
          }
          rs.writeHead(reply, { 'content-type': 'application/json' })
          rs.end(JSON.stringify(reply === 200 ? { ok: true } : { error: reply === 409 ? '浏览器被占着' : '正在排空' }))
        })
      })
      await new Promise((ok) => seat.listen(0, '127.0.0.1', ok))
      seatPort = seat.address().port
      seatSrv = seat
      seatSays = (code) => (reply = code)
      seatBrowserBusy = (on) => (browserBusy = on)
      seatGot = got

      const paired = await pairMachine({ req, gwBase: base, ownerTok: owner, orgId, managerPort: 18992 })
      await publishRelease({ req, gwBase: base, token: owner, version: '0.1.0', note: 'e2e-kanban' })
      machineTok = paired.token

      /**
       * 先清场，**而且要循环到干净为止**。
       *
       * 前面那几条用例在板上留了一批 `ready` 的卡，而并发闸是「一颗 Bot 同时一张」——
       * 席位一上线，调度器会先派它们，而假席位只收不报，那一格就被永久占住了。这不是
       * bug，正是闸该有的样子（下面单独有一条用例验它）。
       *
       * 一遍不够：撤的时候调度器正好抢走一张（`ready` → `running`），而撤销对 running
       * 是 409——那一张就会漏网，然后在后面每一条用例里表现成「调度器该把它派出去」。
       */
      const cleared = await until(async () => {
        const board = await req(base, 'GET', `/kanban/boards/${boardId}`, { token: meTok })
        const live = board.json.cards.filter((c) => c.state === 'todo' || c.state === 'ready' || c.state === 'running')
        if (!live.length) return true
        for (const c of live) {
          // 这两跳都可能撞上调度器刚把它挪走（409），下一圈再来就是——所以都不断言。
          if (c.state === 'running') await settleQuiet(c.id)
          else await req(base, 'POST', `/kanban/cards/${c.id}/cancel`, { token: meTok })
        }
        return null
      })
      assert(cleared, '清不干净就别往下走：后面每一条用例都会被那一格闸挡在门外')

      const dep = await req(base, 'POST', '/runtime/deploy', { token: meTok, body: { botId: designBot } })
      assert(dep.status === 200, `deploy ${dep.status} ${dep.text}`)
      const ready = await req(base, 'POST', `/internal/instances/${meId}/ready`, {
        token: seatTok,
        body: { host: `http://127.0.0.1:${seatPort}`, botId: designBot },
      })
      assert(ready.status === 200, `ready ${ready.status} ${ready.text}`)

      const card = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok,
        body: { title: '真的派一次', assigneeBotId: designBot, body: '交底书' },
      })).json.card
      const pack = await untilPack(card.id, '调度器该把它派出去')
      // 板级交底书要跟着走：不然人得在每张卡的 body 里把同一段背景抄一遍。
      assert(pack.pack.brief.includes('新品'), `执行包该带板的 brief：${JSON.stringify(pack.pack)}`)
      assert(pack.pack.maxSteps === 60 && pack.pack.attempt === 0, `执行包字段不对：${JSON.stringify(pack.pack)}`)

      const done = await req(base, 'POST', `/internal/kanban/cards/${card.id}/result`, {
        token: machineTok,
        body: { status: 'ok', summary: '抓了三家，表在 work/quote.md', metadata: { changed_files: ['work/quote.md'] }, steps: 12 },
      })
      assert(done.status === 200 && done.json.card.state === 'done', `result ${done.status} ${done.text}`)
      // **收口只收一次**：两段不一样的结论，后写的那段未必是对的那段。
      const again = await req(base, 'POST', `/internal/kanban/cards/${card.id}/result`, { token: machineTok, body: { status: 'ok' } })
      assert(again.status === 409, `重复收口该 409，实际 ${again.status} ${again.text}`)
      doneCardId = card.id
    })

    await test('父卡做完，子卡下一轮自己出发', async () => {
      const mk = async (title) =>
        (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, { token: meTok, body: { title, assigneeBotId: designBot } })).json.card
      const child = await mk('等着的那张')
      await req(base, 'POST', '/kanban/links', { token: meTok, body: { parentId: doneCardId, childId: child.id } })
      // 父卡已经 done 了，所以这一条依赖不该把它按住——收依赖那一步下一轮就把它放出来。
      const out = await until(async () => {
        const r = await req(base, 'GET', `/kanban/cards/${child.id}`, { token: meTok })
        return r.json.card.state === 'running' || r.json.card.state === 'done' ? r.json.card : null
      })
      assert(out, '父卡做完之后子卡该被放出来')
      // 收掉它，否则那一格并发闸被永久占着，后面每一条用例都会等在门外。
      await settle(child.id)
    })

    await test('席位说忙：退回 ready，不算失败', async () => {
      /**
       * 席位整夜关着是常态。把 409 / 503 记成失败的话，第二天早上是一板子的红，而没有
       * 任何一件事真的出过错。
       */
      seatSays(409)
      const card = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok,
        body: { title: '撞上忙的那张', assigneeBotId: designBot, needsBrowser: true },
      })).json.card
      const back = await until(async () => {
        const r = await req(base, 'GET', `/kanban/cards/${card.id}`, { token: meTok })
        const t = r.json.timeline || []
        return t.some((x) => x.body.includes('没派出去')) ? r.json : null
      })
      assert(back, '该在时间线上写明这一轮没派出去')
      assert(back.card.state === 'ready', `该退回 ready，实际 ${back.card.state}`)
      assert(back.card.attempt === 0, `busy 不该占 attempt，实际 ${back.card.attempt}`)
      // **要分得清是哪一种没派出去**：席位说忙和席位压根没上线，处理一样但原因不一样，
      // 时间线上混成一句话的话，人查「为什么这张卡一直不动」时看不出该去看哪儿。
      const why = back.timeline.filter((t) => t.body.includes('没派出去')).pop()
      assert(why.body.includes('浏览器'), `原因要是席位说的那句：${why.body}`)
      /**
       * **趁席位还在说忙的时候撤掉它**：先放开的话，下一轮它就被派出去了，而假席位不会
       * 回报，那一格并发闸就被永久占住。
       *
       * 撤销可能正好撞上调度器把它抢走（那时回 409「正在跑」）——所以要**盯到它真的
       * 收干净为止**。漏掉这一张，后面每一条用例都会红在「该被派出去」上，而那句话
       * 指不到这里。
       */
      await dropCard(card.id)
      seatSays(200)
    })

    await test('席位报错两次：第一次退避重试，第二次转人处理', async () => {
      const card = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok,
        body: { title: '注定失败的那张', assigneeBotId: designBot },
      })).json.card
      const failOnce = async () => {
        const run = await until(async () => {
          const r = await req(base, 'GET', `/kanban/cards/${card.id}`, { token: meTok })
          return r.json.card.state === 'running' ? r.json.card : null
        })
        assert(run, '该被派出去')
        const r = await req(base, 'POST', `/internal/kanban/cards/${card.id}/result`, {
          token: machineTok,
          body: { status: 'error', error: '第三家的页面 500' },
        })
        assert(r.status === 200, `result ${r.status} ${r.text}`)
        return r.json.card
      }
      const first = await failOnce()
      assert(first.state === 'ready' && first.attempt === 1, `第一次该重试：${JSON.stringify(first)}`)
      const second = await failOnce()
      assert(second.state === 'blocked' && second.blockedKind === 'failed', `第二次该转人处理：${JSON.stringify(second)}`)
      assert(second.blockedReason.includes('500'), `原因要留下来：${JSON.stringify(second)}`)

      // 重试那一次的执行包里**必须带上一次的报错**，不然第二次会一字不差地重演第一次。
      const retry = await until(async () => {
        const all = seatGot.filter((g) => g.pack.cardId === card.id)
        return all.length === 2 ? all : null
      })
      assert(retry, '重试那一次的包也该送到席位')
      assert(retry[1].pack.lastFailure.includes('500'), `重试的包该带上次的错：${JSON.stringify(retry.map((x) => x.pack.lastFailure))}`)

      // 转人处理的进待办计数；人自己按停止的那些不进（blockedKind 分档的全部理由）。
      const boards = await req(base, 'GET', '/kanban/boards', { token: meTok })
      assert(boards.json.blocked >= 1, `blocked 该被数进去：${boards.text}`)
    })

    await test('模型说卡住了：不算失败、不占 attempt', async () => {
      const card = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok,
        body: { title: '要人拍板的那张', assigneeBotId: designBot },
      })).json.card
      await until(async () => {
        const r = await req(base, 'GET', `/kanban/cards/${card.id}`, { token: meTok })
        return r.json.card.state === 'running' ? r.json.card : null
      })
      const r = await req(base, 'POST', `/internal/kanban/cards/${card.id}/result`, {
        token: machineTok,
        body: { status: 'blocked', error: '要用哪家的报价得你定' },
      })
      assert(r.status === 200, `result ${r.status} ${r.text}`)
      // 重试它只会让同一句「我需要人」再说一遍，每次都花钱。
      assert(r.json.card.state === 'blocked' && r.json.card.blockedKind === 'by-model', `该是 by-model：${r.text}`)
      assert(r.json.card.attempt === 0, `不该占 attempt：${r.text}`)

      // 人处理完解锁：attempt 清零，这是新的一次机会。
      const un = await req(base, 'POST', `/kanban/cards/${card.id}/unblock`, { token: meTok })
      assert(un.status === 200 && un.json.card.state === 'ready', `unblock ${un.status} ${un.text}`)
      assert(un.json.card.attempt === 0, `解锁要把 attempt 清零：${un.text}`)
      // 解锁之后它就又能被派了——撤掉，别让它占住下一条用例要用的那格闸。
      await req(base, 'POST', `/kanban/cards/${card.id}/cancel`, { token: meTok })
    })

    await test('一颗 Bot 同时只跑一张：第二张老实排队', async () => {
      /**
       * 闸是 1，理由是 `~/work`：委派那边不给工作区加锁，靠的是「一批并发委派的 goal
       * 里各自划清文件范围」——那句话的前提是同一个主代理一次写出这一批，而板上的卡
       * 来自不同的时候、可能不同的 Bot，没有任何一个环节会去划这个范围。
       */
      const mk = async (title) =>
        (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, { token: meTok, body: { title, assigneeBotId: designBot } })).json.card
      const a = await mk('排队的第一张')
      const b = await mk('排队的第二张')
      const first = await until(async () => {
        const r = await req(base, 'GET', `/kanban/cards/${a.id}`, { token: meTok })
        return r.json.card.state === 'running' ? r.json.card : null
      })
      assert(first, '第一张该被派出去')
      // 等几轮 tick，确认第二张**没有**跟着出去。
      await new Promise((x) => setTimeout(x, 1500))
      const second = await req(base, 'GET', `/kanban/cards/${b.id}`, { token: meTok })
      assert(second.json.card.state === 'ready', `第二张该还在排队，实际 ${second.json.card.state}`)

      await req(base, 'POST', `/internal/kanban/cards/${a.id}/result`, { token: machineTok, body: { status: 'ok', summary: '好了' } })
      const out = await until(async () => {
        const r = await req(base, 'GET', `/kanban/cards/${b.id}`, { token: meTok })
        return r.json.card.state === 'running' ? r.json.card : null
      })
      assert(out, '第一张腾出位置之后，第二张该自己出发')
      await req(base, 'POST', `/internal/kanban/cards/${b.id}/result`, { token: machineTok, body: { status: 'ok', summary: '也好了' } })
    })

    await test('队头那张派不出去，不许把后面的一起饿死', async () => {
      /**
       * 候选集**只能按账号截，不能再按 (账号, Bot) 截成一张**。
       *
       * 截成一张的话，排在最前面那张要是这一轮派不出去（`needsBrowser` 而那块屏被占着），
       * 调度器连看一眼下一张的机会都没有——后面那些本来跑得起来的卡会一直等着，而板上
       * 显示的是「待派」，看不出被谁挡着。这一条就是那个形状：队头那张一直 409，别的
       * 卡照收。
       */
      seatBrowserBusy(true)
      const head = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok, body: { title: '排在最前面又派不出去的', assigneeBotId: designBot, needsBrowser: true },
      })).json.card
      const tried = await until(async () => {
        const r = await req(base, 'GET', `/kanban/cards/${head.id}`, { token: meTok })
        return (r.json.timeline || []).some((t) => t.body.includes('没派出去')) ? r.json.card : null
      })
      assert(tried, '队头那张该被试过一次并退回 ready')

      const behind = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok, body: { title: '排在它后面的', assigneeBotId: designBot },
      })).json.card
      await untilRunning(behind.id, '排在后面那张该越过队头被派出去')
      await settle(behind.id)
      const still = await req(base, 'GET', `/kanban/cards/${head.id}`, { token: meTok })
      assert(still.json.card.state === 'ready', `队头那张该还在排队：${still.json.card.state}`)
      await dropCard(head.id)
      seatBrowserBusy(false)
    })

    await test('心跳停了就当席位死了：不用等墙钟', async () => {
      /**
       * **主要的回收路径是心跳那条**，不是墙钟：席位被 kill 之后心跳当场停，而墙钟还有
       * 五十多分钟才到——那段时间里界面上是一张正在跑的卡，跑它的进程早没了。
       */
      const card = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok,
        body: { title: '跑着跑着席位没了', assigneeBotId: designBot },
      })).json.card
      const run = await until(async () => {
        const r = await req(base, 'GET', `/kanban/cards/${card.id}`, { token: meTok })
        return r.json.card.state === 'running' ? r.json.card : null
      })
      assert(run, '该被派出去')
      // 心跳这条路本身要通：席位每 60 秒替它报一次，模型不管这件事。
      const beat = await req(base, 'POST', `/internal/kanban/cards/${card.id}/heartbeat`, { token: machineTok })
      assert(beat.status === 200, `heartbeat ${beat.status} ${beat.text}`)
      // 收口之后再报心跳要被顶回来，席位据此掐掉那一轮，而不是继续跑一个没人认领的活。
      await req(base, 'POST', `/internal/kanban/cards/${card.id}/result`, { token: machineTok, body: { status: 'ok', summary: 'x' } })
      const late = await req(base, 'POST', `/internal/kanban/cards/${card.id}/heartbeat`, { token: machineTok })
      assert(late.status === 409, `收口之后的心跳该 409，实际 ${late.status} ${late.text}`)
    })

    await test('哪一档算「要人管」：模型说卡住了算，人自己按停止的不算', async () => {
      /**
       * 这条 webhook 是**公司级**的，而板只有主人看得见（口径〇）：带上标题就是把一块
       * 私人板的内容一天几条地倒进公司群，而板名和卡名恰恰是最能说明问题的两样东西。
       *
       * 看着没用，其实正好够——**这一层的作用是把人叫回来，不是让他在群里把事读完。**
       */
      /**
       * **这条用例验的是分档，不是 webhook 的正文。**
       *
       * `notifyBlocked` 只收 https（那条 URL 是一把凭据，走明文等于交给路上的每一跳），
       * 而这一套里没有证书，架不起一个真的 TLS 服务端。所以「推出去那条消息不带标题」
       * 这一句**在这一层验不了**——写一个收 http 的假地址、再让断言看起来通过，是拿一条
       * 骗人的用例换一个绿点。
       *
       * 这里验得到的是判据本身：哪一档该算「要人管」、哪一档不该。webhook 那一跳发不
       * 发得出去，和它是同一个 `blockedNeedsAttention`。
       */
      const saved = await req(base, 'PATCH', `/orgs/${orgId}`, {
        token: adminTok,
        body: { handoffWebhook: 'https://example.invalid/hook' },
      })
      assert(saved.status === 200, `设 webhook ${saved.status} ${saved.text}`)

      const stuck = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok, body: { title: '会卡住的那张', assigneeBotId: designBot },
      })).json.card
      await until(async () => {
        const r = await req(base, 'GET', `/kanban/cards/${stuck.id}`, { token: meTok })
        return r.json.card.state === 'running' ? r.json.card : null
      })
      const blocked = await req(base, 'POST', `/internal/kanban/cards/${stuck.id}/result`, {
        token: machineTok, body: { status: 'blocked', error: '要你定用哪家' },
      })
      assert(blocked.json.card.blockedKind === 'by-model', `该是 by-model：${blocked.text}`)

      // 人自己按停止那一档**不推**：他刚按的那一下就是原因。
      const mine = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok, body: { title: '我自己停的那张', assigneeBotId: designBot },
      })).json.card
      await until(async () => {
        const r = await req(base, 'GET', `/kanban/cards/${mine.id}`, { token: meTok })
        return r.json.card.state === 'running' ? r.json.card : null
      })
      const stopped = await req(base, 'POST', `/kanban/cards/${mine.id}/abort`, { token: meTok })
      assert(stopped.status === 200, `abort ${stopped.status} ${stopped.text}`)

      // 顶栏那个计数：by-model 的算进去，stopped 的不算。
      const boards = await req(base, 'GET', '/kanban/boards', { token: meTok })
      assert(boards.json.blocked >= 1, `blocked 计数该有：${boards.text}`)
      await dropCard(stuck.id)
    })

    await test('notify=report：做完了往做完它的那颗 Bot 的主会话里说一声', async () => {
      /**
       * **发给 assignee 那颗，不是建卡的人常用的那颗。** 人看到汇报之后第一句多半是
       * 追问（「那第三家呢」），而唯一还能接住的是刚做完那件事的那颗。
       */
      const card = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok, body: { title: '做完了喊我一声', assigneeBotId: designBot, notify: 'report' },
      })).json.card
      assert(card.notify === 'report', `notify 要存下来：${JSON.stringify(card)}`)
      await until(async () => {
        const r = await req(base, 'GET', `/kanban/cards/${card.id}`, { token: meTok })
        return r.json.card.state === 'running' ? r.json.card : null
      })
      await settle(card.id, { status: 'ok', summary: '三家都比完了，第二家最便宜' })
      const said = await until(async () => seatGot.find((g) => g.url.includes('/messages')) ?? null, 8000)
      assert(said, `该往主会话发一条：${JSON.stringify(seatGot.map((g) => g.url))}`)
      assert(said.pack.text.includes('第二家最便宜'), `结论要带上：${JSON.stringify(said.pack)}`)
      // source 说清这条不是人打的字——界面画成卡片，审计和重放里也认得出出处。
      assert(said.pack.source && said.pack.source.plugin === 'kanban', `要标明出处：${JSON.stringify(said.pack)}`)
    })

    await test('回报要认是哪一次执行：迟到的旧回报盖不掉新那一轮', async () => {
      /**
       * 席位断网被判失联 → 卡重派 → 旧那一轮恢复过来报上去。没有 runId 的话，它看到的
       * 正是一张 running 的卡，一报就把全新的一次盖掉，而新那一轮成了没人认领的孤儿。
       */
      const card = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok, body: { title: '认一认是哪一次', assigneeBotId: designBot },
      })).json.card
      const pack = await untilPack(card.id, '认一认是哪一次：该被派出去')
      assert(pack.pack.runId, `执行包该带 runId：${JSON.stringify(pack.pack)}`)

      const stale = await req(base, 'POST', `/internal/kanban/cards/${card.id}/result`, {
        token: machineTok, body: { runId: 'run-of-a-previous-life', status: 'ok', summary: '旧那一轮的结论' },
      })
      assert(stale.status === 409, `旧那一轮的回报该被顶回去，实际 ${stale.status} ${stale.text}`)
      const beat = await req(base, 'POST', `/internal/kanban/cards/${card.id}/heartbeat`, {
        token: machineTok, body: { runId: 'run-of-a-previous-life' },
      })
      assert(beat.status === 409, `旧那一轮的心跳也该被顶回去，实际 ${beat.status}`)

      // 带对 runId 的照常收口。
      const good = await req(base, 'POST', `/internal/kanban/cards/${card.id}/result`, {
        token: machineTok, body: { runId: pack.pack.runId, status: 'ok', summary: '这一轮的结论' },
      })
      assert(good.status === 200 && good.json.card.summary === '这一轮的结论', `对的那次该收得下：${good.text}`)
    })

    await test('人按停止：不占 attempt，也不会被席位的收尾报成失败', async () => {
      /**
       * 席位被掐掉之后，runCard 的收尾会自己报一次 error（模型一句收口的话都没说）。
       * 那条回报抢在状态落库前到达的话，走的是 failCard——人按一下停止就占掉一次
       * attempt，而这张卡此前失败过一次的话会直接转 blocked/failed 并推一条 webhook。
       */
      const card = (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
        token: meTok, body: { title: '按下去就停', assigneeBotId: designBot },
      })).json.card
      await untilRunning(card.id, '按下去就停：该被派出去')
      const stopped = await req(base, 'POST', `/kanban/cards/${card.id}/abort`, { token: meTok })
      assert(stopped.status === 200, `abort ${stopped.status} ${stopped.text}`)
      assert(stopped.json.card.blockedKind === 'stopped', `该是 stopped：${stopped.text}`)
      assert(stopped.json.card.attempt === 0, `不该占 attempt：${stopped.text}`)

      // 席位随后那条迟到的收尾回报：拿 409 收场，什么都改不动。
      const late = await req(base, 'POST', `/internal/kanban/cards/${card.id}/result`, {
        token: machineTok, body: { status: 'error', error: '被掐掉了' },
      })
      assert(late.status === 409, `迟到的回报该 409，实际 ${late.status} ${late.text}`)
      const after = await req(base, 'GET', `/kanban/cards/${card.id}`, { token: meTok })
      assert(after.json.card.blockedKind === 'stopped' && after.json.card.attempt === 0, `状态不该被改：${after.text}`)
    })

    await test('撤销一张卡：下游还没开跑的一起收掉，不留一张永远等着的', async () => {
      /**
       * 原来的判据是「有任何一张父卡不是 done 就不放行」，于是父卡被撤销之后子卡永远停在
       * todo——界面上收在「等依赖」折叠区里写着「还在等」，而它等的东西已经不存在了，
       * 卡页上连拆依赖的按钮都没有。
       */
      const mk = async (title) =>
        (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, { token: meTok, body: { title, assigneeBotId: designBot } })).json.card
      const a = await mk('上游那张')
      const b = await mk('等它的那张')
      await req(base, 'POST', '/kanban/links', { token: meTok, body: { parentId: a.id, childId: b.id } })
      // a 一建出来就可能被派走，而撤销要求它不在跑——盯到它真的收干净为止。
      await dropCard(a.id)
      const child = await req(base, 'GET', `/kanban/cards/${b.id}`, { token: meTok })
      assert(child.json.card.state === 'cancelled', `下游该跟着收掉，实际 ${child.json.card.state}`)
      assert(child.json.timeline.some((t) => t.body.includes('上游那张被撤销')), `要写明为什么：${child.text}`)
    })

    await test('打回一张卡：下游做完的要打回去等，不然没人复核重做的结果', async () => {
      /**
       * 文档推荐的评审流水线就是「干活卡 A → 评审卡 B」，而 B 说不行时打回的正是 A。
       * 不动 B 的话，A 重做、再次 done，而 B 早就是 done 了、永远不会再跑——板上四列
       * 全绿，而重做之后根本没人复核。
       */
      const mk = async (title) =>
        (await req(base, 'POST', `/kanban/boards/${boardId}/cards`, { token: meTok, body: { title, assigneeBotId: designBot } })).json.card
      const work = await mk('干活的')
      const review = await mk('评审的')
      await req(base, 'POST', '/kanban/links', { token: meTok, body: { parentId: work.id, childId: review.id } })
      for (const id of [work.id, review.id]) {
        await untilRunning(id, `评审流水线：${id} 该被派出去`)
        await settle(id)
      }
      const back = await req(base, 'POST', `/kanban/cards/${work.id}/reopen`, { token: meTok, body: { reason: '第三家抄错了' } })
      assert(back.status === 200, `reopen ${back.status} ${back.text}`)
      assert((back.json.rerun || []).includes(review.id), `评审卡要跟着打回：${back.text}`)
      const rv = await req(base, 'GET', `/kanban/cards/${review.id}`, { token: meTok })
      assert(rv.json.card.state === 'todo', `评审卡该回去等，实际 ${rv.json.card.state}`)
      // 干活卡重新做完之后，评审卡自己会被放出来再跑一次。
      await untilRunning(work.id, '评审流水线：干活卡重做时该被派出去')
      await settle(work.id)
      const again = await until(async () => {
        const r = await req(base, 'GET', `/kanban/cards/${review.id}`, { token: meTok })
        return r.json.card.state === 'running' || r.json.card.state === 'ready' ? r.json.card : null
      })
      assert(again, '干活卡重新做完之后，评审卡该再跑一次')
      if (again.state === 'running') await settle(review.id)
    })

    await test('打回一张卡：下游那张**还排在队里等着被派**的（ready）也要退回去等', async () => {
      /**
       * 上面那条验的是 `done` 的下游。**`ready` 的那些同样要退**，而且这一档更险：
       * 只推 done 的话，那张 ready 的卡会在下一个 tick 带着刚被人否掉的上游结论跑出去
       * （执行包里 `parents[].summary` 取的就是它），跑完就是 done——等上游真的重做完，
       * 它已经不在打回名单里了，再也不会跑第二次。板上四列全绿，而复核的是废掉的那份。
       */
      const mk = async (title, assignee) =>
        (
          await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
            token: meTok,
            body: assignee ? { title, assigneeBotId: assignee } : { title },
          })
        ).json.card
      const work = await mk('要被打回的那张', designBot)
      /**
       * 评审那张**故意不派人**：`dueCards` 只挑有 assignee 的，所以它会稳稳停在 ready 上。
       * 线上让它停在那儿的是「一颗 Bot 同时一张」那道闸（等上几轮是常态），而那个窗口在
       * 用例里拿不稳——这里换一个同样落在 ready 的、可复现的理由。
       */
      const review = await mk('等着被派的那张')
      await req(base, 'POST', '/kanban/links', { token: meTok, body: { parentId: work.id, childId: review.id } })
      await untilRunning(work.id, '打回-ready：干活卡该被派出去')
      await settle(work.id)
      const ready = await until(async () => {
        const r = await req(base, 'GET', `/kanban/cards/${review.id}`, { token: meTok })
        return r.json.card.state === 'ready' ? r.json.card : null
      })
      assert(ready, '干活卡做完之后，评审卡该被推成 ready')
      const back = await req(base, 'POST', `/kanban/cards/${work.id}/reopen`, { token: meTok, body: { reason: '第三家抄错了' } })
      assert(back.status === 200, `reopen ${back.status} ${back.text}`)
      assert((back.json.rerun || []).includes(review.id), `ready 的下游也要跟着打回：${back.text}`)
      const rv = await req(base, 'GET', `/kanban/cards/${review.id}`, { token: meTok })
      assert(rv.json.card.state === 'todo', `它该回去等上游重做，实际 ${rv.json.card.state}`)
      await dropCard(work.id)
      await dropCard(review.id)
    })

    await test('解锁：上游还没做完的话回去等，不是直接待派', async () => {
      /**
       * `blocked` 的这段时间里上游完全可能被打回重做（或者像这里，人顺手补了一条依赖）。
       * 解锁写死 `ready` 就是让它插到自己的依赖前面去跑，拿的还是那份作废的输入——而
       * `promoteReadyCards` 只推 todo → ready，推不回来。
       */
      const mk = async (title, assignee) =>
        (
          await req(base, 'POST', `/kanban/boards/${boardId}/cards`, {
            token: meTok,
            body: assignee ? { title, assigneeBotId: assignee } : { title },
          })
        ).json.card
      const child = await mk('卡住的那张', designBot)
      await untilRunning(child.id, '解锁-依赖：该被派出去')
      await settle(child.id, { status: 'blocked', error: '要人给个账号' })
      // 不派人，所以它会一直停在 ready——「上游还没做完」这件事因此是稳的。
      const parent = await mk('后来才补上的上游')
      const link = await req(base, 'POST', '/kanban/links', { token: meTok, body: { parentId: parent.id, childId: child.id } })
      assert(link.status === 201, `加依赖失败：${link.status} ${link.text}`)
      const un = await req(base, 'POST', `/kanban/cards/${child.id}/unblock`, { token: meTok })
      assert(un.status === 200, `unblock ${un.status} ${un.text}`)
      assert(un.json.card.state === 'todo', `上游没做完，解锁后该回去等，实际 ${un.json.card.state}`)
      await dropCard(parent.id)
      await dropCard(child.id)
    })

    await test('删板：卡跟着走，别人删不掉', async () => {
      const board = (await req(base, 'POST', '/kanban/boards', { token: meTok, body: { name: '待删' } })).json.board
      const card = (await req(base, 'POST', `/kanban/boards/${board.id}/cards`, { token: meTok, body: { title: '一张' } })).json.card
      const notMine = await req(base, 'DELETE', `/kanban/boards/${board.id}`, { token: adminTok })
      assert(notMine.status === 404, `管理员删我的板该 404，实际 ${notMine.status}`)
      const gone = await req(base, 'DELETE', `/kanban/boards/${board.id}`, { token: meTok })
      assert(gone.status === 200, `delete ${gone.status} ${gone.text}`)
      const card404 = await req(base, 'GET', `/kanban/cards/${card.id}`, { token: meTok })
      assert(card404.status === 404, `板删了卡该跟着走，实际 ${card404.status}`)
    })
  } finally {
    gw.kill('SIGTERM')
    seatSrv?.close()
  }
}
