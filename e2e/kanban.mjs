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
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'

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
  }
}
