/**
 * UI 冒烟：真 Gateway + 真 app.js + DOM 垫片。
 *
 * **不是真浏览器**（见 ui-dom.mjs 开头）。验的是「拿到真响应之后渲染出什么」，
 * 这一层专抓两类以前漏网的错：
 *
 * 1. boot 走错分支——手上有张上一套数据留下的废票时，画的是登录页而不是初始化页，
 *    而系统里一个账号都没有，那个登录页永远登不进去。
 * 2. 视图把正文渲染丢了——审计里每条消息都显示「（空）」，接口其实是好的。
 *
 * 两个都不是接口错，e2e 的状态码断言一个也拦不住。
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { createCompany } from './org.mjs'
import { PG_URL } from './pg.mjs'
import { el, fakeSse } from './ui-dom.mjs'
import { readFileSync } from 'node:fs'
import { freePort } from './ports.mjs'

const APP = 'gateway/ui/app.js'

export async function runUiSmoke({ root, gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = '/tmp/satuwork-e2e-ui-gw'
  const GW_PORT = await freePort()
  const gwBase = `http://127.0.0.1:${GW_PORT}`
  const appPath = join(root, APP)

  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# ui-smoke')

  const gw = start('ui-gw', ['--import', 'tsx', join(gwRoot, 'src/index.ts')], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: 'e2e_ui',
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
    },
  })
  await waitHttp(`${gwBase}/health`, gw, 'ui gateway')

  const { loadApp } = await import('./ui-dom.mjs')
  const boot = async (token) => {
    const ui = loadApp({ appPath, base: gwBase, token })
    await ui.boot()
    return ui
  }

  try {
    await test('index.html 列出的每个前端分片都真的取得到', async () => {
      // 前端拆成了一串普通脚本，多一个分片就要在 http.ts 的 ROOT_FILES 里也加一行。
      // 漏了的表现很坏：本地开 index.html 一切正常，线上那一个 404，整个界面白屏。
      const html = readFileSync(join(root, 'gateway/ui/index.html'), 'utf8')
      const parts = [...html.matchAll(/<script src="\/([^"]+)"[^>]*\bdata-app-part\b/g)].map((m) => m[1])
      assert(parts.length > 1, `index.html 里没找到 data-app-part 脚本`)
      for (const f of parts) {
        const r = await req(gwBase, 'GET', '/' + f)
        assert(r.status === 200, `GET /${f} → ${r.status}，八成是 ROOT_FILES 白名单漏了它`)
      }
      // 最后一个分片必须是带 boot() 的那个，否则整串脚本加载完谁也不启动。
      const last = readFileSync(join(root, 'gateway/ui', parts[parts.length - 1]), 'utf8')
      assert(/\nboot\(\)\s*$/.test(last), `最后一个分片 ${parts[parts.length - 1]} 末尾没有 boot()`)
    })

    await test('空壳工具调用不画成药丸，它的结果也不许赖到别人头上', async () => {
      // bot 那边的下标错位已经修了（见 e2e/toolcalls.mjs），但**已经写下的日志里还留着**：
      // 翻上去看昨天那轮，每轮开头挂一颗红色的「tool · 失败」，点开里面什么都没有。
      const ui = await boot()
      const ev = (seq, type, data) => ({ seq, time: 1, type, data })
      const folded = ui.fold([
        ev(1, 'user/message', { message: { content: [{ type: 'text', text: '查一下' }] }, source: { kind: 'user' } }),
        ev(2, 'turn/start', { turn: 1 }),
        ev(3, 'tool/call', { turn: 1, step: 1, callId: '', name: '', arguments: '{}' }),
        ev(4, 'tool/call', { turn: 1, step: 1, callId: 'call_a', name: 'web_search', arguments: '{"q":"x"}' }),
        ev(5, 'tool/result', { turn: 1, step: 1, callId: '', text: 'Tool  not found', failed: true }),
        ev(6, 'tool/result', { turn: 1, step: 1, callId: 'call_a', text: '搜到了', failed: false }),
        ev(7, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: '好了' }] } }),
        ev(8, 'turn/end', { turn: 1, reason: 'completed' }),
      ])
      const tools = folded.blocks.find((b) => b.kind === 'assistant')?.tools || []
      assert(tools.length === 1, `该只剩真的那一把：${JSON.stringify(tools.map((t) => t.name))}`)
      assert(tools[0].name === 'web_search', `留错了：${tools[0].name}`)
      // 空壳的结果要一起跳过。不跳的话它会按「第一条还没有结果的」认过去，
      // 把一次成功的调用标成失败——比多一颗药丸更坏，因为它是错的。
      assert(tools[0].failed === false, '成功的调用被空壳的失败结果盖成了失败')
      assert(tools[0].result === '搜到了', `结果配错了：${tools[0].result}`)
    })

    await test('确认卡：还等着的摊开，有结论的收成药丸', async () => {
      /**
       * 摊开是给「你要批的到底是什么」用的——参数看不见就只能凭信任点。可人点完之后
       * 它就只是一条痕迹了，还占着半屏参数的话，往上翻这一轮会被几张已经作废的卡片挡住。
       */
      const ui = await boot()
      const ev = (seq, type, data) => ({ seq, time: 1, type, data })
      const approval = (seq, callId, state) =>
        ev(seq, 'tool/approval', {
          callId,
          name: 'mcp_github_default_sw_run',
          arguments: '{"tool":"GITHUB_FIND_REPOSITORIES","args":{"per_page":50}}',
          reason: 'mcp_github_default_sw_run 会往外部系统写入或发送内容',
          state,
          ...(state === 'pending' ? { expiresAt: 2 } : {}),
        })
      const folded = ui.fold([
        ev(1, 'turn/start', { turn: 1 }),
        ev(2, 'tool/call', { turn: 1, step: 1, callId: 'call_a', name: 'mcp_github_default_sw_run', arguments: '{}' }),
        approval(3, 'call_a', 'pending'),
        approval(4, 'call_a', 'approved'),
        approval(5, 'call_b', 'pending'),
      ])
      const apps = folded.blocks.find((b) => b.kind === 'assistant')?.approvals || []
      assert(apps.length === 2, `两条确认该各留一条：${JSON.stringify(apps.map((a) => a.state))}`)
      // 同一个 callId 来两条（pending 之后是终态），取最后一条。
      assert(apps[0].state === 'approved' && apps[1].state === 'pending', JSON.stringify(apps.map((a) => a.state)))

      const chip = ui.approvalChipHtml(apps[0], 1)
      assert(chip.includes('sw-approvalchip'), '收起来的那条没画成药丸')
      assert(chip.includes('已批准'), `药丸上没写结论：${chip}`)
      // 药丸上**不许**带参数：整段 JSON 摊在气泡里，正是这次要收掉的东西。
      assert(!chip.includes('GITHUB_FIND_REPOSITORIES'), '药丸把参数也带出来了')
      assert(chip.includes('data-i="1"'), `下标要接在工具药丸后面数：${chip}`)

      // 参数没丢，只是挪进了悬浮窗——和工具痕迹同一个交互。
      const pop = ui.toolPopBody(ui.approvalPop(apps[0]))
      assert(pop.includes('GITHUB_FIND_REPOSITORIES'), '悬浮窗里看不到当时批的参数')
      assert(pop.includes('会往外部系统写入'), '悬浮窗里没说为什么要确认')

      // 还等着的那条照旧摊开，按钮都在。
      const card = ui.approvalHtml(apps[1])
      assert(card.includes('data-act="chat-approve"') && card.includes('data-act="chat-deny"'), '等着的那张卡没有按钮')
      assert(card.includes('GITHUB_FIND_REPOSITORIES'), '等着的那张卡没把参数摆出来')
      assert(ui.approvalState(apps[0]) === 'approved', '状态认错了')
    })

    await test('发信的确认走定制卡：能读、能改，别的参数也露着', async () => {
      /**
       * 通用卡把整份 JSON 摊出来，而人在批一封信时要看的是「发给谁、写了什么」。更要紧
       * 的是**得能改**：模型起草的正文十有八九要动一两句，只能批准/拒绝的话，人就得
       * 拒掉再去跟它解释，而它下一稿仍然是它写的。
       */
      const ui = await boot()
      const form = {
        kind: 'email',
        tool: 'GMAIL_SEND_EMAIL',
        fields: [
          { key: 'args.recipient_email', label: '收件人', value: 'a@b.c' },
          { key: 'args.subject', label: '主题', value: '二季度报表', editable: true },
          { key: 'args.body', label: '正文', value: '你好，附件是报表。', editable: true, multiline: true },
          { key: 'args.is_html', label: 'is_html', value: 'false' },
        ],
      }
      const card = ui.approvalHtml({
        callId: 'call_mail',
        name: 'mcp_gmail_default_sw_run',
        args: '{}',
        reason: 'GMAIL_SEND_EMAIL 会往外部系统写入或发送内容',
        state: 'pending',
        form,
      })
      assert(card.includes('sw-approval-mail'), '发信没走定制卡')
      assert(card.includes('收件人') && card.includes('a@b.c'), '收件人没摆出来')
      // 只读的那几格照样露着：藏起来的话，人以为自己看到了这封信的全部。
      assert(card.includes('is_html'), '别的参数被藏起来了')
      // 收件人不能改：那是「在这儿写封信」，不是「审一眼要发出去的东西」。
      assert(!card.includes('data-edit="args.recipient_email"'), '收件人被做成可改的了')
      assert(card.includes('data-edit="args.subject"'), '主题不让改')
      assert(card.includes('<textarea') && card.includes('data-edit="args.body"'), '正文没做成可编辑的多行框')
      assert(card.includes('你好，附件是报表。'), '正文没填进去')
      assert(card.includes('批准并发送'), `发信那张卡的按钮该说清楚它要干什么：${card.slice(-400)}`)
      /**
       * 第二颗按钮的范围是**一轮**，不是一条会话。
       *
       * 一个 Bot 一辈子只有一条会话，按会话放行等于永久通行证；按钮上的话必须跟真实
       * 范围对得上，否则它就是在替人做一个他没同意的决定。
       */
      assert(card.includes('data-scope="turn"'), '「都批准」那颗按钮的范围不是一轮')
      assert(card.includes('这一轮都批准') && !card.includes('这次对话都批准'), '按钮上的话还在说「这次对话」')
      // 拒绝那一侧也有一颗带范围的，和批准那一对对称。
      assert(card.includes('data-act="chat-deny" data-call="call_mail" data-scope="turn"'), '没有「这一轮别再试」那颗按钮')
      assert(card.includes('这一轮别再试'), '拒绝那一侧缺了带范围的那颗')
      // 剥壳之后的工具名才认得出来，sw_run 谁也看不出是什么。
      assert(card.includes('GMAIL_SEND_EMAIL'), '卡片上没写真正要跑的那把工具')

      // 认不出的 kind 一律退回通用卡——新增一种表单不该让老版本白屏。
      const generic = ui.approvalHtml({
        callId: 'c2', name: 'mcp_x_y', args: '{"a":1}', reason: 'x', state: 'pending',
        form: { kind: '将来才有的一种', tool: 'X', fields: [] },
      })
      assert(!generic.includes('sw-approval-mail') && generic.includes('sw-approval-args'), '认不出的 kind 没退回通用卡')

      // 收起来那颗药丸上写真工具名，改过还要标一笔。
      const chip = ui.approvalChipHtml({ callId: 'call_mail', name: 'mcp_gmail_default_sw_run', state: 'approved', form, edited: ['正文'] }, 0)
      assert(chip.includes('GMAIL_SEND_EMAIL'), `药丸上还是壳的名字：${chip}`)
      assert(chip.includes('已改'), '改过的没在药丸上标出来')
      const pop = ui.toolPopBody(ui.approvalPop({ callId: 'call_mail', name: 'x', args: '{}', state: 'approved', form, edited: ['正文'] }))
      assert(pop.includes('批准时改过') && pop.includes('正文'), '悬浮窗没说这次改过哪几格')
      assert(pop.includes('你好，附件是报表。'), '悬浮窗里看不到最终发出去的内容')
    })

    await test('消息里的 @ 点名要留在气泡上，别发完就没', async () => {
      // 点名是消息的一部分（它决定了这一轮的工具表），不是输入框上一个发完就没的装饰。
      // 丢掉的话翻上去看昨天那条，「@ 了谁」就消失了——而那正是「它为什么去读了我的
      // 邮箱」的唯一答案。落盘的是结构块，正文里一个字都没有，所以只能从块里取。
      const ui = await boot()
      const folded = ui.fold([
        {
          seq: 1,
          time: 1,
          type: 'user/message',
          data: {
            source: { kind: 'user' },
            message: {
              content: [
                { type: 'mention', kind: 'connector', id: 'conn-1', label: 'Gmail (default)' },
                { type: 'text', text: '查看邮件' },
              ],
            },
          },
        },
      ])
      const b = folded.blocks[0]
      assert(b && b.kind === 'user', '用户那条没折出来')
      assert(b.text === '查看邮件', `正文被点名块弄脏了：${b.text}`)
      assert((b.mentions || []).length === 1, `点名没跟着消息留下来：${JSON.stringify(b.mentions)}`)
      assert(b.mentions[0].label === 'Gmail (default)', `药丸上的名字不对：${b.mentions[0].label}`)
      // 气泡那一层是真 DOM（垫片里画不出来），这里只钉住它确实画了这排药丸。
      const src = readFileSync(join(root, 'gateway/ui/chat.js'), 'utf8')
      assert(src.includes('sw-mentions-in'), '气泡里没有画点名药丸的那一排')
    })

    await test('工具浮层：在它自己身上滚不算「页面滚了」，不许收掉', async () => {
      // 这一条只验源码。滚动收浮层挂在 window 的**捕获阶段**，垫片里 window 是个空壳，
      // 事件根本发不出去——但错法就藏在那一行里：不看事件源头，滚浮层自己的结果区
      // （`.sw-toolpop pre`，最高 220px）也照收，手一动窗口就没了，长输出永远看不完。
      const src = readFileSync(join(root, 'gateway/ui/chat.js'), 'utf8')
      // chat.js 里不止一个捕获阶段的 scroll 监听，认收浮层的那一个。
      const handler = [...src.matchAll(/addEventListener\(\s*'scroll',([\s\S]*?),\s*true,?\s*\)/g)]
        .map((m) => m[1])
        .find((h) => h.includes('hideToolPop'))
      assert(handler !== undefined, '找不到收浮层的那个 scroll 监听')
      assert(handler.includes('sw-toolpop'), '滚动收浮层时没有区分事件源头，滚浮层自己也会把它收掉')
    })

    await test('空库 + 没有票 → 画「创建系统管理员」，不是登录页', async () => {
      const ui = await boot()
      const html = ui.html()
      assert(html.includes('创建系统管理员'), '没画初始化页')
      assert(!html.includes('登录 Satuwork'), '画成登录页了')
      assert(html.includes('id="setup-form"'), '缺创建表单')
    })

    await test('空库 + 手上有张废票 → 仍然画初始化页，且不显示「登录已过期」', async () => {
      // 这一条正是修之前的错法：有票就直奔 /me，失败后落回登录页——死胡同。
      const ui = await boot('eyJhbGciOiJSUzI1NiJ9.stale.token')
      const html = ui.html()
      assert(html.includes('创建系统管理员'), '废票把初始化页挡住了')
      assert(!html.includes('登录已过期'), '不该给出一条误导的过期提示')
      assert(ui.token() === undefined || !ui.token(), '废票应被清掉')
    })

    let ownerToken = ''
    await test('建完管理员后，同一份 app.js 画的是控制台不是登录页', async () => {
      const created = await req(gwBase, 'POST', '/auth/setup', {
        body: { email: 'owner@ui.test', name: '老板', password: 'correct-horse-1' },
      })
      assert(created.status === 201, `setup ${created.status} ${created.text}`)
      ownerToken = created.json.token

      const ui = await boot(ownerToken)
      const html = ui.html()
      assert(!html.includes('创建系统管理员'), '已经有管理员了还画初始化页')
      assert(!html.includes('id="login-form"'), '画成登录页了')
      assert(html.includes('owner@ui.test'), '侧栏没有当前账号')
    })

    await test('有管理员 + 没有票 → 画登录页', async () => {
      const ui = await boot()
      const html = ui.html()
      assert(html.includes('登录 Satuwork'), '没画登录页')
      assert(!html.includes('创建系统管理员'), '不该再出初始化页')
    })

    await test('审计正文渲染：消息要出来，不能是「（空）」', async () => {
      const ui = await boot(ownerToken)
      const html = ui.auditTranscript([
        { type: 'user/message', data: { message: { content: [{ type: 'text', text: 'UI-SMOKE-员工说的' }] } } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'UI-SMOKE-助理答的' }] } } },
        { type: 'tool/call', data: { name: 'clock' } },
      ])
      assert(html.includes('UI-SMOKE-员工说的'), '员工消息没渲染出来')
      assert(html.includes('UI-SMOKE-助理答的'), '助理消息没渲染出来')
      assert(!html.includes('（空）'), '渲染成了「（空）」')
      assert(html.includes('工具 clock'), '工具调用没渲染')
    })

    await test('模型页「测试连通性」：跑完一轮，busy 和结果都画得出来', async () => {
      // 修之前 testMark 里的局部变量把文案函数 t 遮住了，一进 busy 这一帧就抛
      // 「t is not a function」，按钮点下去什么都不会发生——接口是好的，e2e 拦不住。
      const ui = await boot(ownerToken)
      ui.state.path = '/models'
      await ui.saveSettings({ daily: { provider: 'e2e-fake', model: 'probe-me' } })

      ui.state.tests['role:daily'] = { status: 'busy' }
      ui.render()
      assert(ui.html().includes('测试中…'), 'busy 这一帧没画出来')

      delete ui.state.tests['role:daily']
      await ui.testLlm('role', { role: 'daily' })
      const res = ui.state.tests['role:daily']
      assert(res, '测完没留下结论')
      assert(res.status !== 'busy', `还停在 busy：${JSON.stringify(res)}`)
      // 上游是假的，只可能是 err；要的是「有结论且画得出来」，不是「通了」。
      assert(res.status === 'err', `预期 err，拿到 ${res.status}`)
      assert(ui.html().includes(res.text.slice(0, 8)), '结论没画到页面上')
    })

    await test('供应商页「测试」：没配密钥时给出结论，不是静默', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/providers'
      await ui.testLlm('provider', { provider: 'e2e-fake' })
      const res = ui.state.tests['provider:e2e-fake']
      assert(res && res.status === 'err', `预期 err，拿到 ${JSON.stringify(res)}`)
      assert(res.text && res.text.length > 0, '错误文案是空的')
    })

    await test('换了模型就丢掉上一次的连通性结论', async () => {
      const ui = await boot(ownerToken)
      ui.state.tests['role:daily'] = { status: 'ok', text: '通了 12ms · a/b' }
      await ui.saveSettings({ daily: { provider: 'e2e-fake', model: 'another-model' } })
      assert(!ui.state.tests['role:daily'], '换了模型还留着上一次的绿字')
    })

    await test('单价倍率：存得下、画得出、倍率单价按倍数算', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/models'
      ui.state.selectedProvider = 'e2e-prov'
      ui.state.catalog = [
        {
          provider: 'e2e-prov',
          name: 'E2E',
          models: [
            { id: 'priced', name: 'Priced', cost: { input: 2, output: 8 } },
            { id: 'unpriced', name: 'Unpriced', cost: { input: 0, output: 0 } },
          ],
        },
      ]

      // 走真的 change 派发，不是直接调函数——这个分支最早就接错了位置：
      // 挂在「只收 select」那道关卡后面，函数本身是好的，改了框子什么也不会发生。
      await ui.fire('change', el('input', { 'data-act': 'price-multiplier' }, '1.5'))
      assert(ui.state.settings.priceMultiplier === 1.5, `没存下：${ui.state.settings.priceMultiplier}`)

      // 存完要真的回到库里，不是只留在内存。
      const back = await ui.api('GET', '/platform/settings')
      assert(back.priceMultiplier === 1.5, `库里是 ${back.priceMultiplier}`)

      ui.render()
      const html = ui.html()
      assert(html.includes('倍率单价 ×1.5'), '表头没有倍率列')
      assert(html.includes('$2.00 / $8.00'), `原价没画出来：${html.includes('$2.00')}`)
      assert(html.includes('$3.00 / $12.00'), '倍率单价算错或没画出来')
      // 目录里没有价的模型不能显示成 $0.000——那会被读成免费。
      assert(!html.includes('$0.000'), '没有价的模型画成了 $0.000')
    })

    await test('工具配置页：后端、密钥框、单价都画得出来，改动走真的派发', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/tools'
      await ui.loadWebTools()
      ui.render()
      let html = ui.html()
      assert(html.includes('网页与搜索'), '没画那个 tab')
      assert(html.includes('搜索后端') && html.includes('提取后端'), '两个下拉缺一个')
      // 只会搜索的后端不能出现在提取那个下拉里——配得出来的组合必须是能跑的。
      // 只截那个 select，不能截「提取后端」往后的整段：单价表里每个后端都要有一行。
      const at = html.indexOf('data-cap="extract"')
      assert(at > 0, '没找到提取后端的下拉')
      const extractSelect = html.slice(at, html.indexOf('</select>', at))
      assert(!extractSelect.includes('>DuckDuckGo<'), `提取下拉里列了只会搜索的后端：${extractSelect}`)
      assert(extractSelect.includes('>Tavily<'), '提取下拉里没有能提取的后端')

      // 走真的 change 派发，不是直接调函数：这个分支要排在「只收 select」那道关卡
      // 前面，接错了位置的话函数是好的、点了没反应（倍率输入框就栽过这一次）。
      await ui.fire('change', el('select', { 'data-act': 'web-backend', 'data-cap': 'search' }, 'duckduckgo'))
      assert(ui.state.webTools.web.searchBackend === 'duckduckgo', `没存下：${JSON.stringify(ui.state.webTools.web)}`)
      const back = await ui.api('GET', '/platform/tools/web')
      assert(back.web.searchBackend === 'duckduckgo', `库里是 ${back.web.searchBackend}`)
      ui.render()
      html = ui.html()
      assert(html.includes('封 IP'), 'DuckDuckGo 那句「无保障」的提醒没画出来')

      // 单价：界面按美元填，库里按整数「厘」存。
      await ui.fire('change', el('input', { 'data-act': 'web-price', 'data-backend': 'tavily', 'data-kind': 'search' }, '0.008'))
      assert(ui.state.webTools.web.pricing.tavily.search === 8, `单价没按厘存：${JSON.stringify(ui.state.webTools.web.pricing)}`)
      const back2 = await ui.api('GET', '/platform/tools/web')
      assert(back2.web.pricing.tavily.search === 8, `库里单价是 ${JSON.stringify(back2.web.pricing)}`)
    })

    await test('工具配置页：非 owner 进不去这条路径', async () => {
      const ui = await boot(ownerToken)
      // pathAllowed 是侧栏和路由共用的那道门。公司管理员不该有工具配置。
      ui.state.me = { account: { role: 'admin' }, company: { id: 'c1' } }
      assert(ui.pathAllowed('/tools') === false, '公司管理员被放进了工具配置')
      ui.state.me = { account: { role: 'owner' } }
      assert(ui.pathAllowed('/tools') === true, 'owner 反倒进不去')
    })

    await test('角色面板选了供应商，下面那张表跟着换', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/models'
      ui.state.catalog = [
        { provider: 'aa', name: 'AA', models: [{ id: 'aa-1', name: 'AA One' }] },
        { provider: 'bb', name: 'BB', models: [{ id: 'bb-1', name: 'BB One' }] },
      ]
      ui.state.selectedProvider = 'aa'
      await ui.fire('change', el('select', { 'data-act': 'role-provider', 'data-role': 'daily' }, 'bb'))
      assert(ui.state.selectedProvider === 'bb', `selectedProvider 还是 ${ui.state.selectedProvider}`)
      assert(ui.html().includes('BB One'), '表还停在上一个供应商')
    })

    await test('倍率越界：不落库，输入退回上一个有效值', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/models'
      const set = (v) => ui.fire('change', el('input', { 'data-act': 'price-multiplier' }, v))
      await set('2')
      await set('0')
      assert(ui.state.settings.priceMultiplier === 2, `0 倍被存下了：${ui.state.settings.priceMultiplier}`)
      await set('abc')
      assert(ui.state.settings.priceMultiplier === 2, '非数字被存下了')
      const back = await ui.api('GET', '/platform/settings')
      assert(back.priceMultiplier === 2, `库里被写坏了：${back.priceMultiplier}`)
    })

    await test('服务端也挡越界倍率，不只靠前端', async () => {
      const bad = await req(gwBase, 'PUT', '/platform/settings', {
        token: ownerToken,
        body: { priceMultiplier: 0 },
      })
      assert(bad.status === 400, `0 倍拿到 ${bad.status}`)
      const huge = await req(gwBase, 'PUT', '/platform/settings', {
        token: ownerToken,
        body: { priceMultiplier: 1e9 },
      })
      assert(huge.status === 400, `1e9 拿到 ${huge.status}`)
    })

    await test('自定义供应商：建出来就在列表里，缺密钥也在', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/providers'
      ui.state.providerDraft = { editing: false, id: 'my-llm', name: 'My LLM', baseUrl: 'http://127.0.0.1:9/v1', api: 'openai-completions', error: '' }
      await ui.saveCustomProvider()
      assert(!ui.state.providerDraft, `没保存成功：${JSON.stringify(ui.state.providerDraft)}`)
      const html = ui.html()
      assert(html.includes('My LLM'), '列表里没有这个自定义供应商')
      assert(html.includes('自定义'), '没标出「自定义」')
      // 还没配密钥也得列出来——不然没有地方能给它贴密钥。
      assert(html.includes('缺密钥'), '缺密钥的状态没画出来')
    })

    await test('给自定义供应商加模型，行上的计数跟着走', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/providers'
      await ui.loadCustomProviders()
      ui.state.modelsFor = 'my-llm'
      ui.state.modelDraft = { id: 'm1', name: 'M One', contextWindow: 65536, maxTokens: 4096, costInput: 1.5, costOutput: 3, reasoning: true, image: false }
      await ui.saveCustomModel()
      assert(!ui.state.providerError, `加模型报错：${ui.state.providerError}`)
      const p = (ui.state.customProviders || []).find((x) => x.id === 'my-llm')
      assert(p && p.models.length === 1, `模型没加上：${JSON.stringify(p && p.models)}`)
      assert(p.models[0].cost.input === 1.5, '单价没存下')
      assert(p.models[0].reasoning === true, '推理标记没存下')
      assert(ui.html().includes('模型 1'), '行上的模型计数没更新')
    })

    await test('删自定义供应商：确认框画得出来，确认后真的删掉', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/providers'
      await ui.loadCustomProviders()
      // 确认框以前只在三个页面各画一份，供应商页没有——点了删除什么都不会弹。
      await ui.fire('click', el('button', { 'data-act': 'prov-delete', 'data-provider': 'my-llm', 'data-custom': '1' }))
      assert(ui.state.confirm?.kind === 'delete-custom-provider', `没进确认：${JSON.stringify(ui.state.confirm)}`)
      assert(ui.html().includes('删除自定义供应商'), '确认框没画出来')
      await ui.runConfirm()
      assert(!(ui.state.customProviders || []).some((x) => x.id === 'my-llm'), '没删掉')
    })

    await test('内置供应商的删除走的是「移除密钥」，不是删供应商', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/providers'
      await ui.fire('click', el('button', { 'data-act': 'prov-delete', 'data-provider': 'openai', 'data-custom': '' }))
      assert(ui.state.confirm?.kind === 'delete-credential', `走错分支：${JSON.stringify(ui.state.confirm)}`)
    })

    await test('统计窗口按本地时区算：今日 / 近 7 天 / 指定月', async () => {
      const ui = await boot(ownerToken)
      const dayStart = (ms) => {
        const d = new Date(ms)
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
      }

      ui.state.statsRange = 'today'
      const today = ui.statsWindow()
      assert(today.from === dayStart(Date.now()), '今日没有从本地零点开始')
      assert(today.to >= today.from, '今日窗口反了')

      ui.state.statsRange = '7d'
      const seven = ui.statsWindow()
      // 含今天，所以往回退 6 天，不是 7 天。
      assert(seven.from === dayStart(Date.now()) - 6 * 86400000, `近 7 天起点错了：${new Date(seven.from).toISOString()}`)

      ui.state.statsRange = 'month'
      ui.state.statsMonth = '2026-02'
      const feb = ui.statsWindow()
      assert(feb.from === new Date(2026, 1, 1).getTime(), '月起点错了')
      // 2026 年不是闰年，2 月 28 天——月末是算出来的，不是写死 30/31。
      assert(feb.to === new Date(2026, 2, 1).getTime() - 1, `月末错了：${new Date(feb.to).toString()}`)

      ui.state.statsMonth = '2024-02'
      const leap = ui.statsWindow()
      assert(new Date(leap.to).getDate() === 29, `闰年 2 月没算到 29 号：${new Date(leap.to).toString()}`)
    })

    await test('统计页：拉得到数、画得出表、没单价的模型有提示', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/stats'
      ui.state.statsRange = 'month'
      ui.state.statsMonth = new Date().toISOString().slice(0, 7)
      await ui.loadStats()
      assert(ui.state.stats, '没拉到统计数据')
      const html = ui.html()
      assert(html.includes('按公司'), '没画「按公司」')
      assert(html.includes('按模型'), '没画「按模型」')
      assert(html.includes('原价') && html.includes('已扣'), '两个金额列没都画出来')
      // 计费明细跟统计画在同一屏：汇总回答「多少」，明细回答「为什么是这个数」。
      assert(html.includes('计费明细'), '没画计费明细')
    })

    await test('明细和汇总永远问同一个时间窗', async () => {
      /**
       * 统计屏上那三颗胶囊只刷过汇总，底下的计费明细还留着上一个窗口的行——同一屏
       * 两张表各说各的时间段，人只会以为数字算错了。这条钉的是「窗口只有一个来源」。
       *
       * 只比到「几乎同时」，不比毫秒：`7d`/今天/用量那几档的边界是**此刻**，每次调用
       * 现取，前后两次天然差几毫秒。拿 === 比的话这条会随机红，红的还是时钟不是窗口
       * 来源。真走岔了算法差的是小时和天，这个容差照样拦得住。
       */
      const NEAR_MS = 2000
      const sameWindow = (a, b, what) => {
        assert(a && b, `${what}：窗口是空的`)
        assert(Math.abs(a.from - b.from) < NEAR_MS, `${what}：起点差了 ${a.from - b.from}ms`)
        assert(Math.abs(a.to - b.to) < NEAR_MS, `${what}：终点差了 ${a.to - b.to}ms`)
      }

      const ui = await boot(ownerToken)
      ui.state.path = '/stats'
      ui.state.statsRange = '7d'
      sameWindow(ui.chargesWindow('platform'), ui.statsWindow(), '统计屏的明细没跟着统计窗口')
      ui.state.statsRange = 'month'
      ui.state.statsMonth = '2026-02'
      const feb = ui.chargesWindow('platform')
      assert(feb.from === new Date(2026, 1, 1).getTime(), `换月之后明细没跟上：${new Date(feb.from).toString()}`)

      // 用量屏跟的是它自己那排胶囊，不是统计的。
      ui.state.path = '/usage'
      ui.state.usageRange = '近 7 天'
      sameWindow(ui.chargesWindow('org'), ui.usageRangeMs('近 7 天'), '用量屏的明细没跟着范围胶囊')

      // 账单页和平台的公司详情没有范围控件，那里就是全时段。
      ui.state.path = '/billing'
      assert(ui.chargesWindow('org') === null, '账单页凭空造了一个时间窗')
    })

    await test('计费明细：倍率对所有种类都画出来，不只是模型', async () => {
      // 这一列的全部意义是让人自己乘一遍对得上金额。倍率只加在模型那一支的时候，
      // 网页那行写着「4 条 × $0.0080」而金额是 $0.0384，对账的人会先怀疑金额错了。
      const ui = await boot(ownerToken)
      ui.state.path = '/billing'
      ui.state.billingTab = 'usage'
      ui.state.charges = {
        charges: [
          {
            id: 'c1', createdAt: Date.now(), companyId: 'o1', companyName: 'Acme', accountId: 'a1', accountName: '张三',
            kind: 'web', subject: 'tavily:extract', status: 'ok',
            quantity: { units: 4 }, unitPrice: { unit: 8000 }, multiplier: 1.2,
            amountMicros: 38400, amount: 0.0384, bonusMicros: 0, topupMicros: 38400, unpriced: false,
          },
        ],
        limit: 20, hasMore: false, nextCursor: null,
      }
      ui.render()
      const html = ui.html()
      assert(html.includes('4 条 × $0.0080'), `计量那格没画出来：${html.slice(0, 200)}`)
      assert(html.includes('倍率 ×1.2'), '网页那一行漏了倍率')
      assert(!html.includes('1.2000000476837158'), '倍率的小数位没收干净')

      /**
       * 同一张表，公司那边只画消耗。单价和倍率是平台怎么定价的，摊在客户面前
       * 等于把成本价一起交出去了；「扣了多少」照画——那是真花掉的钱。
       */
      ui.state.me = { account: { role: 'admin', email: 'a@x' }, company: { id: 'o1' }, settings: ui.state.settings }
      ui.render()
      const orgHtml = ui.html()
      assert(orgHtml.includes('4 条'), '公司侧连消耗都没画')
      assert(!orgHtml.includes('× $0.0080'), '公司侧把单价画出来了')
      assert(!orgHtml.includes('倍率'), '公司侧把倍率画出来了')
      assert(orgHtml.includes('$0.038'), '公司侧不该连金额一起藏掉')
    })

    await test('catalogBase：owner 走 /platform，公司管理员走 /orgs/:id', async () => {
      const ui = await boot(ownerToken)
      assert(ui.catalogBase() === '/platform', `owner 拿到 ${ui.catalogBase()}`)
      // 装成公司管理员：同一套页面，只有前缀不同。
      ui.state.me = { account: { role: 'admin', email: 'a@x' }, company: { id: 'org-1' }, settings: ui.state.settings }
      assert(ui.catalogBase() === '/orgs/org-1', `admin 拿到 ${ui.catalogBase()}`)
      // 成员没有公司目录可管，返回空串，调用方据此不发请求。
      ui.state.me = { account: { role: 'member', email: 'm@x' }, company: null }
      assert(ui.catalogBase() === '', `member 拿到 ${ui.catalogBase()}`)
    })

    await test('/bots 两副面孔：owner 是全局名录，公司管理员是那份模版', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/bots'
      ui.state.bots = [
        { id: 'g1', name: '全局助理', origin: 'global', scope: 'global', enabled: true },
        { id: 'c1', name: '老公司助理', origin: 'company', scope: 'company', enabled: false, legacy: true },
      ]
      // owner 管的就是全局那份，不该被标成只读。
      assert(ui.readOnlyItem(ui.state.bots[0]) === false, 'owner 被当成只读了')
      ui.render()
      assert(ui.html().includes('全局 Bot'), 'owner 侧标题不对')
      assert(ui.html().includes('配置'), 'owner 侧的行不该是只读')

      // 公司侧：这一页现在是模版。全局项和停用掉的老公司 Bot 列在底下，都只能看。
      ui.state.me = { account: { role: 'admin', email: 'a@x' }, company: { id: 'org-1' }, settings: ui.state.settings }
      assert(ui.readOnlyItem(ui.state.bots[0]) === true, '公司侧没把全局项当只读')
      assert(ui.readOnlyItem(ui.state.bots[1]) === true, '停用掉的老公司 Bot 该是只读')
      assert(ui.readOnlyItem({ id: 'u1', scope: 'user', origin: 'company' }) === false, '自己建的 Bot 被当成只读了')
      ui.state.template = { version: 3, prompt: '公司口径', escalate: '', guards: {}, memory: {}, skills: [], mcps: [] }
      ui.state.templateDraft = {
        prompt: '公司口径', escalate: '', skills: [], mcps: [], guards: [],
        memoryOn: true, scope: '所属分组', kinds: [], ttl: '90 天', cap: 20, confirmOn: true, piiOn: true,
      }
      ui.render()
      const html = ui.html()
      assert(html.includes('Bot 模版'), '公司侧没画出模版页')
      assert(html.includes('v3'), '没显示模版版本号')
      assert(html.includes('公司口径'), '模版正文没画出来')
      assert(html.includes('立即下发到全部席位'), '没有下发入口')
      assert(html.includes('全局'), '底下那张表没标出「全局」')
      assert(html.includes('已停用'), '没标出停用掉的老公司 Bot')
      // 公司管理员这一页不该再有「新建 Bot」——Bot 由员工自己建。
      assert(!html.includes('data-act="bot-create"'), '公司侧还留着建公司 Bot 的入口')

      /**
       * 席位同步那一格。**落后的那台必须点名**：只报一个「1/2」的比分，管理员知道有事
       * 却不知道是谁，下一步只能去按「立即下发」，而那会掐掉全公司正在进行的对话。
       */
      ui.state.templateSync = {
        version: 3,
        total: 2,
        synced: 1,
        seats: [
          { seatId: 's-2', botId: 'b2', accountId: 'a2', name: '李四', version: null, syncedAt: null },
          { seatId: 's-1', botId: 'b1', accountId: 'a1', name: '张三', version: 3, syncedAt: Date.now() - 60000 },
        ],
      }
      ui.render()
      const synced = ui.html()
      assert(synced.includes('席位同步'), '没画出同步那一格')
      assert(synced.includes('1/2 在 v3'), `比分没画对：${synced.includes('1/2') ? 'v?' : '没有比分'}`)
      assert(synced.includes('李四') && synced.includes('还没报到过'), '落后的那台没点名')
      assert(!synced.includes('张三'), '跟上的那台不该占地方')

      // 员工那边接口不给这一格（state.templateSync 是 null），这时候整块都不该出现——
      // 空着一个「0/0」比没有更难懂。
      ui.state.templateSync = null
      ui.render()
      assert(!ui.html().includes('席位同步'), '没有同步数据时还画了那一格')
    })

    await test('只读地看别人维护的 Bot：页面上不留任何按了没反应的控件', async () => {
      // 「看着能按、按了不生效」比少一个控件更糟：人以为改上了，刷新一下又回去了。
      const ui = await boot(ownerToken)
      ui.state.me = { account: { role: 'admin', email: 'a@x' }, company: { id: 'org-1' }, settings: ui.state.settings }
      ui.state.path = '/bots/g1'
      ui.state.bot = { id: 'g1', name: '全局助理', origin: 'global', scope: 'global', enabled: true }
      ui.state.botDraft = {
        name: '全局助理', description: '', prompt: '平台口径', greeting: '', escalate: '', icon: 'g-core',
        model: 'm', enabled: true, skills: [], mcps: [], groups: [], kbs: [],
        guards: [{ id: 'pii', title: '拦截个人敏感信息', desc: '', on: true }],
        memoryOn: true, scope: '所属分组', kinds: ['偏好'], ttl: '90 天', cap: 20, confirmOn: true, piiOn: true,
      }
      ui.render()
      const html = ui.html()
      assert(html.includes('只读'), '保存键没标成只读')
      // 记忆那块的「记录哪些内容」曾经漏了这一条：药丸照常带着 bot-pick，点了会改草稿。
      assert(!html.includes('data-act="bot-pick"'), '只读页面上还留着可点的勾选药丸')
      assert(!html.includes('data-act="bot-guard"'), '只读页面上还留着可点的行为边界开关')
      assert(!html.includes('data-act="bot-scope"'), '只读页面上还留着可点的记忆范围')
    })

    await test('员工自己的 Bot：详情页只给身份和补充说明，底座只读', async () => {
      const ui = await boot(ownerToken)
      ui.state.me = { account: { role: 'member', email: 'm@x' }, company: { id: 'org-1' }, settings: ui.state.settings }
      ui.state.path = '/bots/u1'
      ui.state.bot = { id: 'u1', name: '回访助手', origin: 'company', scope: 'user', enabled: true, templateVersion: 3, extraPrompt: '带上客户名' }
      ui.state.botDraft = {
        name: '回访助手', description: '', prompt: '公司口径\n\n带上客户名', extraPrompt: '带上客户名',
        greeting: '', icon: 'c-bot', model: 'm', enabled: true, skills: [], mcps: [], guards: [],
        memoryOn: true, scope: '所属分组', kinds: [], ttl: '90 天', cap: 20, confirmOn: true, piiOn: true,
      }
      ui.state.template = { version: 3, prompt: '公司口径', escalate: '', guards: {}, memory: {}, skills: [], mcps: [] }
      assert(ui.pathAllowed('/bots/u1'), '员工进不了自己 Bot 的详情页')
      assert(!ui.pathAllowed('/bots'), '员工进得了管理员的模版页')
      ui.render()
      const html = ui.html()
      assert(html.includes('这个 Bot 的补充说明'), '没有补充说明那一栏')
      assert(html.includes('继承自公司模版'), '没说清楚底座从哪来')
      assert(html.includes('v3'), '没显示继承的是哪一版')
      // 底座那份提示词摆出来了，但不能是可编辑的。
      const soul = html.indexOf('公司口径')
      assert(soul > -1, '没把模版的人设摆出来')
      assert(html.slice(0, soul).lastIndexOf('disabled') > html.slice(0, soul).lastIndexOf('<textarea'), '模版正文是可编辑的')
    })

    await test('二级页面的头是「上一级 / 这一条」，返回在最前面', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/bots/b1'
      ui.state.bot = { id: 'b1', name: '测试 Bot', origin: 'global', enabled: true }
      ui.state.botDraft = { name: '测试 Bot', description: '', prompt: '', provider: 'p', model: 'm', enabled: true, icon: 'g-core', skills: [], mcps: [] }
      ui.render()
      const html = ui.html()
      assert(html.includes('satu-crumbs'), '没画面包屑')
      assert(html.includes('>全局 Bot</button>'), '上一级不是「全局 Bot」')
      assert(html.includes('>测试 Bot</span>'), '当前这一级不是 Bot 的名字')
      // 返回要在面包屑前面：DOM 顺序就是视觉顺序，这一条能拦住「又挪回右边」。
      const back = html.indexOf('aria-label="返回"')
      assert(back > -1, '头上没有返回按钮')
      assert(back < html.indexOf('satu-crumbs'), '返回跑到面包屑后面去了')
      assert(!html.includes('返回 Bot 列表'), '右边那条旧的返回还在')

      // 名字对不上就不能顶着上一条的名字——列表页留在内存里的那份最容易漏。
      ui.state.path = '/bots/b2'
      ui.render()
      assert(!ui.html().includes('>测试 Bot</span>'), '换了一条还画着上一条的名字')
      assert(ui.html().includes('Bot 详情'), '没退回泛称')
    })

    await test('账单页两张余额卡并排：赠送的在前，账户合计在后', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/billing'
      ui.state.billing = {
        plan: { name: '标准版', period: '2026-08-01 → 2026-09-01' },
        invoices: [],
        topups: [],
        // 发放 $200 + $150，已扣 $40，还剩 $310。**大字画的是剩的，不是发的**。
        balance: {
          amount: '$350.00', planBonus: '$200.00', planBonusExpires: '2026-09-01', topup: '$150.00',
          planBonusLeft: '$160.00', topupLeft: '$150.00', left: '$310.00', leftMicros: 310_000_000,
          grantedMicros: 350_000_000, spentThisPeriod: '$40.00', alertAt: '—', enforce: true,
        },
      }
      ui.render()
      const html = ui.html()
      const bonus = html.indexOf('套餐赠送余额')
      const account = html.indexOf('账户余额')
      assert(bonus > -1 && account > -1, '两张卡没都画出来')
      assert(bonus < account, '赠送那张跑到账户余额后面去了')
      assert(html.includes('$310.00') && html.includes('$160.00') && html.includes('$150.00'), '剩余额没都画出来')
      assert(html.includes('本期已扣 $40.00'), '已扣没画出来')
      // 发放额也要在，但只能是小字——只报发放额的话那个数永远不动。
      assert(html.includes('$200.00'), '本期发放没画出来')
      assert(html.includes('2026-09-01 到期'), '到期日没画出来')
      assert(!html.includes('额度已用完'), '还有钱却报了熔断')
      // 并排靠 auto-fit 网格，窄了自己叠成一列；写死两列会在窄屏上挤成一团。
      assert(html.includes('repeat(auto-fit, minmax(280px, 1fr))'), '不是自适应两列')
    })

    await test('没有生效中的套餐：赠送那张写清楚，不显示一个空的到期日', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/billing'
      ui.state.billing = {
        plan: {},
        invoices: [],
        topups: [],
        balance: {
          amount: '$0.00', planBonus: '$0.00', planBonusExpires: '—', topup: '$0.00',
          planBonusLeft: '$0.00', topupLeft: '$0.00', left: '$0.00', leftMicros: 0,
          grantedMicros: 0, spentThisPeriod: '$0.00', alertAt: '—', enforce: true,
        },
      }
      ui.render()
      const html = ui.html()
      assert(html.includes('没有生效中的套餐'), '空态没写清楚')
      assert(!html.includes('— 到期'), '把「—」当成到期日画出来了')
      // 余额 0 且熔断开着：这一屏必须说出「调用已经停下来了」，不能只画一个 $0.00。
      assert(html.includes('额度已用完'), '余额见底没给告警')
    })

    await test('余额告警的措辞跟着 enforce 变：真停了和只记账不拦是两件事', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/billing'
      const base = {
        amount: '$0.00', planBonus: '$0.00', planBonusExpires: '—', topup: '$0.00',
        planBonusLeft: '$0.00', topupLeft: '$0.00', left: '$0.00', leftMicros: 0,
        grantedMicros: 100_000_000, spentThisPeriod: '$100.00', alertAt: '—',
      }
      ui.state.billing = { plan: {}, invoices: [], topups: [], balance: { ...base, enforce: false } }
      ui.render()
      assert(ui.html().includes('调用还在继续'), 'enforce 关着却说停了')

      // 还剩不到一成：提醒，但别说已经停了——那时人还来得及去充。
      ui.state.billing = {
        plan: {}, invoices: [], topups: [],
        balance: { ...base, enforce: true, left: '$5.00', leftMicros: 5_000_000 },
      }
      ui.render()
      const low = ui.html()
      assert(low.includes('还剩不到一成'), '低余额没提醒')
      assert(!low.includes('额度已用完'), '还有钱却说用完了')
    })

    await test('原地重绘不丢滚动位置；换了页面才回到顶部', async () => {
      // Bot 详情上按一个开关（记忆范围、勾选项、上线…）走的都是整页重绘。
      // 不把位置贴回去，人就被扔回页首——页面越长越难受。
      const ui = await boot(ownerToken)
      ui.state.path = '/bots/b1'
      ui.state.bot = { id: 'b1', name: '测试 Bot', origin: 'global', enabled: true }
      ui.state.botDraft = { name: '测试 Bot', description: '', prompt: '', provider: 'p', model: 'm', enabled: true, icon: 'g-core', skills: [], mcps: [], memoryOn: true, scope: '仅本人', kinds: [], ttl: '90 天', cap: 20, guards: [] }
      ui.render()

      ui.page.scrollTop = 640
      ui.state.botDraft = { ...ui.state.botDraft, scope: '全公司' }
      ui.render()
      assert(ui.page.scrollTop === 640, `原地重绘把人扔回了 ${ui.page.scrollTop}`)

      ui.state.path = '/bots'
      ui.render()
      assert(ui.page.scrollTop === 0, `换页没回到顶部：${ui.page.scrollTop}`)
    })

    await test('一级页面的头照旧是单标题，不出面包屑', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/bots'
      ui.render()
      assert(!ui.html().includes('satu-crumbs'), '一级页面画出了面包屑')
      assert(!ui.html().includes('aria-label="返回"'), '一级页面出现了返回按钮')
    })

    let adminToken = ''
    await test('登出清空聊天状态：同一标签页换人登录，看不到上一个人的对话', async () => {
      // 登出以前只清了账号相关的字段，聊天正文、草稿、助理名册都原样留在内存里。
      // 同一台电脑换个人登录，上一个人的对话会直接画在他面前——SSE 要是还连着，
      // 新的事件也照样往里落。
      const reg = await createCompany(req, gwBase, {
        ownerToken,
        email: 'admin@ui.test',
        password: 'correct-horse-2',
        companyName: 'UI',
        slug: 'ui-co',
        seats: 2,
      })
      adminToken = reg.token

      const ui = await boot(adminToken)
      ui.state.chatBotId = 'bot-x'
      ui.state.chatSessionId = 's-previous-user'
      ui.state.chatEvents = [
        { type: 'user/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'UI-SMOKE-上一个人说的' }] } } },
      ]
      ui.state.chatDraft = 'UI-SMOKE-没发出去的草稿'
      ui.state.runtimeBots = [{ id: 'bot-x', name: 'UI-SMOKE-上一个人的助理' }]

      await ui.fire('click', el('button', { 'data-act': 'logout' }))

      assert(ui.state.chatEvents.length === 0, `聊天正文没清：${JSON.stringify(ui.state.chatEvents)}`)
      assert(ui.state.chatDraft === '', `草稿没清：${ui.state.chatDraft}`)
      assert(ui.state.chatSessionId === '', `会话 id 没清：${ui.state.chatSessionId}`)
      assert(ui.state.chatBotId === '', `botId 没清：${ui.state.chatBotId}`)
      assert((ui.state.runtimeBots || []).length === 0, '助理名册没清')
      const html = ui.html()
      assert(!html.includes('UI-SMOKE-上一个人说的'), '登出后页面上还留着上一个人的对话')
      assert(!html.includes('UI-SMOKE-没发出去的草稿'), '登出后页面上还留着上一个人的草稿')
    })

    await test('Bot 名单在非对话页也要在——它是顶层导航，不是对话页的附属', async () => {
      // 名单从「对话」子项提到侧栏顶层之后，取数的路径没跟着搬：loadRuntimeBots 一直
      // 只在 loadChatPage 里跑。于是管理员一进概览页（首页就是概览，根本不走那条路），
      // 侧栏上的 Bot 就整片消失了——而它现在是这个产品的主导航。
      const ui = loadApp({ appPath, base: gwBase, token: adminToken })
      await ui.boot()
      assert(ui.state.path === '/', `管理员首页应是概览，实际 ${ui.state.path}`)
      assert(Array.isArray(ui.state.runtimeBots), '非对话页也该把名单取回来')
      // 有没有 Bot 取决于这套数据，但「取过了」这件事必须成立——空数组和没取过是两回事。
      const html = ui.html()
      if (ui.state.runtimeBots.length) {
        assert(html.includes('satu-botrow'), '名单取回来了却没画进侧栏')
        assert(html.includes('satu-botdot'), '状态点没画')
      }
    })

    await test('平台菜单里没有「全局 Bot」，但那一页 owner 仍然进得去', async () => {
      // 撤的是**入口**，不是功能。这两条断言必须一起看：只删菜单项的话，
      // allowedHrefs 跟着少一项，pathAllowed('/bots') 变 false，owner 直接输地址会被
      // 踢回首页——全局 Bot 目录从此没人改得动，而他是唯一改得动的人。
      const ui = await boot(ownerToken)
      assert(!ui.html().includes('全局 Bot'), '平台菜单里还挂着「全局 Bot」')
      assert(ui.pathAllowed('/bots'), '把页面一起封掉了：owner 进不去全局 Bot')
      assert(ui.pathAllowed('/bots/some-id'), '详情页也被封了')
      // 公司侧不受影响：那边的 Bot 名录本来就该在菜单里。
      const admin = await boot(adminToken)
      assert(admin.pathAllowed('/bots'), '公司管理员的 Bot 页被误伤')
    })

    await test('平台侧栏没有 Bot 名单时，菜单贴着顶，不被占位压到底部', async () => {
      // 「导航沉底」的理由是给 Bot 名单让位。owner 永远没有名单（没席位，/runtime/bots
      // 对他 403），占位却照撑满，结果是菜单被压到屏幕最下面、上面空一大片。
      const ui = await boot(ownerToken)
      const html = ui.html()
      assert(!html.includes('satu-botlist'), 'owner 侧栏不该有 Bot 名单')
      // navfoot 前面不许再有别的兄弟——有就是占位又回来了。
      assert(
        /<div style="flex: 1; min-height: 0;[^"]*">\s*<div class="satu-navfoot">/.test(html),
        '菜单前面还夹着一个撑满高度的占位',
      )
    })

    await test('员工侧栏没有 Bot 时，「新建 Bot」不许顶到品牌标底下', async () => {
      // 占位是按「这一侧有没有名单」留的，不是按「此刻有没有 Bot」。跟着 Bot 一起收掉
      // 的话，删完最后一颗的那一瞬间「新建 Bot」和「插件」会从名单下沿弹到最上面，
      // 整个侧栏跳一下——而对话区那句空态写的正是「点左下角「新建 Bot」」。
      const ui = await boot(adminToken)
      ui.state.runtimeBots = []
      ui.render()
      const html = ui.html()
      assert(html.includes('satu-botlist'), '名单空了，占位跟着没了')
      assert(!html.includes('satu-botrow'), '没有 Bot 却画出了名单行')
      assert(
        html.indexOf('satu-botlist') < html.indexOf('satu-newbot'),
        '「新建 Bot」跑到名单占位前面去了',
      )
    })

    await test('长列表分页：一页 20 条，越界夹回，筛选之后回到第一页', async () => {
      // 这几张表是一次拉齐、前端切页的。切页最容易出的两种错都在这里钉住：
      // **越界**（数据变少了还停在第 7 页，人看到一片空白）和**筛选之后不回第一页**
      // （点了「只看在线」，结果因为停在第 3 页而一台都没有）。
      const ui = await boot(ownerToken)
      const rowsIn = (html) => (html.match(/class="satu-memberrow"/g) || []).length
      ui.state.orgs = Array.from({ length: 47 }, (_, i) => ({ id: 'org-' + i, name: '公司' + i, slug: 'c' + i, plan: {} }))
      ui.state.path = '/companies'
      ui.render()
      let html = ui.html()
      assert(rowsIn(html) === 20, `第一页画了 ${rowsIn(html)} 行，不是一页 20 条`)
      assert(html.includes('共 47 家'), `总数没说清：${html.slice(html.indexOf('satu-pager'), html.indexOf('satu-pager') + 200)}`)
      assert(html.includes('第 1 / 3 页'), '页码没画出来')

      ui.state.listPage.companies = 3
      ui.render()
      html = ui.html()
      assert(rowsIn(html) === 7, `最后一页该是 7 行，实际 ${rowsIn(html)}`)

      // 越界：数据缩水（删了一批、或者上一次看的是别的筛选）之后不能留在空页上。
      ui.state.listPage.companies = 99
      ui.render()
      html = ui.html()
      assert(html.includes('第 3 / 3 页'), '越界的页码没被夹回最后一页')
      assert(rowsIn(html) > 0, '夹回之后还是一页空白')

      // 一页装得下时只报总数，不画两颗永远点不动的翻页按钮。
      ui.state.orgs = ui.state.orgs.slice(0, 5)
      ui.render()
      html = ui.html()
      assert(html.includes('共 5 家'), '总数一直要在')
      assert(!html.includes('data-act="list-page"'), '只有一页却画了翻页按钮')

      // 机器：先筛后分页，而顶上那排计数仍然按全量算——它答的是「这一档有几台」，
      // 跟着当前页变的话「失联 3 台」会在翻页时变成 1 台，那是句假话。
      ui.state.allMachines = Array.from({ length: 47 }, (_, i) => ({
        machine: { id: 'm' + i, host: '10.0.0.' + i, paired: true, link: i % 3 === 0 ? 'online' : 'offline' },
        accounts: 1, maxAccounts: 4, seats: 1, company: null,
      }))
      ui.state.machineTotals = { machines: 47, paired: 47, online: 16, accounts: 47, max: 188, seats: 47 }
      ui.state.path = '/machines'
      ui.state.listPage.machines = 3
      ui.render()
      assert(ui.html().includes('第 3 / 3 页'), '机器表没停在第 3 页，后面那条断言就没意义了')
      await ui.fire('click', el('button', { 'data-act': 'machine-filter', 'data-filter': 'online' }))
      html = ui.html()
      assert(html.includes('共 16 台'), `筛完的总数不对：${html.slice(html.indexOf('satu-pager'), html.indexOf('satu-pager') + 120)}`)
      assert(rowsIn(html) === 16, `筛完该看到 16 行，实际 ${rowsIn(html)}——多半是还停在第 3 页`)
      assert(/data-filter="online"[^>]*>[^<]*16/.test(html), '顶上那排计数被分页带歪了')
    })

    await test('平台菜单是分组的，且分组没有吃掉任何一条入口', async () => {
      // 十几条平铺是找不到落点的。分组之后要盯住两件事：**组还在**（有人把标题删了，
      // 菜单就退回一根柱子），以及**条目一条不少**——漏一条的表现是那一页从此没有入口，
      // 而页面还在、地址还通，翻遍界面也找不到它。
      const ui = await boot(ownerToken)
      const html = ui.html()
      const groups = [...html.matchAll(/<div class="satu-navgroup">([\s\S]*?)<\/div>/g)].map((m) => m[1])
      assert(groups.length >= 4, `平台菜单只剩 ${groups.length} 组，分组没生效`)
      const titled = groups.filter((g) => g.includes('satu-group'))
      assert(titled.length === groups.length - 1, '除了「概览」那一组，每组都该有标题')
      const inGroups = groups.reduce((n, g) => n + (g.match(/class="satu-nav"/g) || []).length, 0)
      const all = (html.match(/class="satu-nav"/g) || []).length
      assert(inGroups === all, `有 ${all - inGroups} 条入口掉在了所有分组外面`)
      // 「先看哪台机器出事，再谈给它发什么包」——这两条是一组里的一对，不能被拆散。
      const machines = groups.find((g) => g.includes('机器管理'))
      assert(machines && machines.includes('机器配置'), '机器管理和机器配置被分到了两组')
    })

    await test('通联灯：后端没给 link 时说「状态未知」，不谎称「还没有配对」', async () => {
      // 前端比后端新一步时（浏览器读磁盘上的 app.js，Gateway 要重启才换代码）响应里
      // 没有 link 这个字段。原来的兜底是 `m.link || 'unpaired'`，于是一台心跳正常、
      // 版本刚升完的机器，头一行写着「还没有配对」——把「字段缺席」和「机器没配对」
      // 混成同一个结论，而这两件事差得最远。
      const ui = await boot(ownerToken)
      const stale = ui.machineHead('org-1', { no: 1 }, { id: 'abcdef0123', paired: true })
      assert(stale.includes('状态未知'), `缺 link 时该说不知道，实际：${stale}`)
      assert(!stale.includes('还没有配对'), '对一台已配对的机器谎称没配对')
      // paired 是老响应里就有的，可信：它说没配对，那就是真没配对。
      const virgin = ui.machineHead('org-1', { no: 2 }, { id: 'abcdef0123', paired: false })
      assert(virgin.includes('还没有配对'), '真没配对时反而不说了')
      // 编号缺席就整个略过——「机器 ?」既指代不了机器，也说不清哪儿出了问题。
      const noNo = ui.machineHead('org-1', {}, { id: 'abcdef0123', paired: true, link: 'online' })
      assert(!noNo.includes('?'), `编号缺席时画出了问号：${noNo}`)
      assert(noNo.includes('abcdef01'), '短码也一起没了')
      // 刷新那颗要挂着公司 id：机器那个接口是按公司回整张列表的，没有 id 就无处可拉。
      assert(
        /data-act="machine-refresh"[^>]*data-id="org-1"/.test(stale),
        `刷新按钮没带上公司 id：${stale}`,
      )
    })

    await test('用户列表：状态那一格有东西，能按着停用；自己和待接受的不给按钮', async () => {
      /**
       * 这一页原来最后两列是**空的**（表头两个 `<span></span>`，行里两个 `<div></div>`），
       * 于是「这个人还能不能登录」在全平台唯一列全部账号的这一页上看不见，也改不了。
       *
       * 按钮该不该出现是这条用例的重点：
       *  - 自己那一行不能有——把自己停掉之后下一次请求就 401，谁也开不回来（服务端也挡）
       *  - 待接受那一行不能有「启用」——口令得由本人用邀请链接设
       */
      const ui = await boot(ownerToken)
      ui.state.path = '/users'
      const meId = ui.state.me?.account?.id || 'me-1'
      ui.state.users = [
        { id: meId, email: 'owner@x.com', name: '我自己', role: 'owner', status: 'active', createdAt: Date.now() - 86400000, company: null },
        { id: 'u-active', email: 'a@acme.test', name: '在职的', role: 'admin', status: 'active', createdAt: Date.now() - 86400000, company: { id: 'c1', name: 'Acme', slug: 'acme' } },
        { id: 'u-off', email: 'b@acme.test', name: '停用的', role: 'member', status: 'disabled', createdAt: Date.now() - 86400000, company: { id: 'c1', name: 'Acme', slug: 'acme' } },
        { id: 'u-inv', email: 'c@acme.test', name: '待接受的', role: 'member', status: 'invited', createdAt: Date.now() - 3600000, company: { id: 'c1', name: 'Acme', slug: 'acme' } },
      ]
      ui.render()
      const html = ui.html()
      assert(html.includes('已激活') && html.includes('已停用') && html.includes('待接受'), '状态那一格还是空的')
      assert(html.includes('data-act="user-status" data-id="u-active" data-next="disabled"'), '在职的那行没有「停用」')
      assert(html.includes('data-act="user-status" data-id="u-off" data-next="active"'), '停用的那行没有「启用」')
      assert(!html.includes('data-id="u-inv"'), '待接受的那行不该给状态按钮')
      assert(!html.includes(`data-act="user-status" data-id="${meId}"`), '自己那行不该给状态按钮')
    })

    await test('公司详情页：机器报了负载也画得出来，不是整页白屏', async () => {
      /**
       * 这一页曾经整页画不出来：机器卡片里那格负载的渲染函数（machineLoadCell）在
       * 「机器列表砍掉负载那一列」时被一并删掉，而它**还有第二个调用方**——就是这里。
       * 于是只要那台机器报过负载，整页抛 ReferenceError，屏幕上停在上一屏，控制台之外
       * 一个字都没有。
       *
       * 所以这条断言的不是某一行长什么样，而是**这一页画得出来**：owner 侧最常点开的
       * 一页，此前在 ui-smoke 里一条覆盖都没有。
       */
      const ui = await boot(ownerToken)
      ui.state.path = '/companies/org-1'
      ui.state.org = {
        id: 'org-1', name: 'UI-SMOKE-公司', slug: 'smoke', status: 'active',
        contactName: '张三', contactPhone: '+65 68886888', contactEmail: 'a@x.com',
        address: '', website: '', accessUrl: '', createdAt: Date.now() - 86400000, machineId: null,
      }
      ui.state.plan = { seats: 3, used: 2, expiresAt: Date.now() + 86400000 }
      ui.state.seats = { total: 3, used: 2 }
      ui.state.accounts = [{ id: 'a1', name: '李四', email: 'l@x.com', role: 'member', status: 'active', lastSeenAt: Date.now() - 60000, runtimes: [] }]
      ui.state.billing = { plan: { period: '月付', amount: '$200.00' }, invoices: [] }
      // 拉不到的那几份在真实加载里也是这些默认值（各自带 .catch），照抄过来。
      ui.state.charges = null
      ui.state.orgTopups = []
      ui.state.planSkus = []
      ui.state.releases = []
      ui.state.latestRelease = null
      ui.state.machines = [{
        no: 1,
        machine: {
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', host: 'http://10.0.0.12:8443', paired: true,
          pairedAt: Date.now(), managerVersion: '0.3.1+abc-arm64', protocol: 1, lastError: null,
          lastHeartbeatAt: Date.now() - 12000, link: 'online', heartbeatAge: 12000,
          timezone: null, currentTimezone: 'Asia/Singapore', arch: 'arm64',
          // 报过负载的机器**才**触发那一格。盘 92%：和列表页那个 fixture 同一个数。
          telemetry: {
            metrics: {
              uptime: 3600,
              cpu: { cores: 8, usage: 0.23, load1: 1.8 },
              memory: { total: 16 * 1024 ** 3, used: 9 * 1024 ** 3, usage: 0.56, swapTotal: 0, swapUsed: 0 },
              disks: [{ mount: '/', total: 100 * 1024 ** 3, used: 92 * 1024 ** 3, free: 8 * 1024 ** 3, usage: 0.92 }],
              net: { txBytes: 0, rxBytes: 0, txRate: 0, rxRate: 0, interfaces: ['eth0'] },
            },
            logs: { journalBytes: 3.4 * 1024 ** 3, varLogBytes: 0, capMb: 1024, capSource: 'default', top: [], lastVacuum: null },
          },
          telemetryAt: Date.now() - 12000, telemetryAge: 12000, logCapMb: null,
        },
        accounts: 2, maxAccounts: 10, seats: 1, full: false,
        botVersions: [{ version: '0.9.0+aaa-arm64', seats: 1 }], botOutdated: false,
        managerDesired: null, managerOutdated: false, managerPending: false, timezonePending: false,
        company: { id: 'org-1', name: 'UI-SMOKE-公司', slug: 'smoke', status: 'active' },
      }]
      ui.render()
      const page = ui.html()
      assert(page.includes('公司信息'), '公司详情页没画出来')
      assert(page.includes('UI-SMOKE-公司'), '标题没画出公司名')
      // 那一格：最吃紧的是盘 92%，写出来的是它，不是三项并排。
      assert(page.includes('盘 / 92%'), `机器负载那一格没画出来：${page.includes('负载') ? '有「负载」但没有数值' : '连「负载」都没有'}`)
      assert(page.includes('成员') && page.includes('订阅'), '成员或订阅那两块没画出来')
    })

    await test('机器管理：菜单在「机器配置」上面，列表和详情画得出，公司侧进不去', async () => {
      // 这一页答的是「平台上挂着哪些机器」，公司详情里那块「运行机器」答的是「这家
      // 有几台」。断言分三层：入口在不在、两张页面画不画得出、以及**没派给公司的机器
      // 有没有列出来**——最后这条正是这一页存在的理由，按公司列永远列不到它们。
      const ui = await boot(ownerToken)
      const nav = ui.html()
      assert(nav.includes('机器管理'), '平台菜单里没有「机器管理」')
      assert(
        nav.indexOf('机器管理') < nav.indexOf('机器配置'),
        '「机器管理」该排在「机器配置」上面：先看哪台机器出事，再谈给它发什么包',
      )
      assert(ui.pathAllowed('/machines') && ui.pathAllowed('/machines/some-id'), '列表或详情被挡在门外')

      const machine = (over) => ({
        no: null,
        machine: {
          id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          host: 'http://10.0.0.12:8443',
          paired: true,
          pairedAt: Date.now(),
          managerVersion: '0.3.1+abc-arm64',
          protocol: 1,
          lastError: null,
          lastHeartbeatAt: Date.now() - 12000,
          link: 'online',
          heartbeatAge: 12000,
          timezone: null,
          currentTimezone: null,
          arch: 'arm64',
          // 机器自报的负载与日志占用。**盘故意画到 92%**：这一页最该一眼看见的就是
          // 一台快写满的机器，而颜色分档（75/90）只有真有个超线的值才验得到。
          telemetry: {
            metrics: {
              uptime: 3 * 86400 + 3600,
              cpu: { cores: 8, usage: 0.23, load1: 1.8 },
              memory: { total: 16 * 1024 ** 3, used: 9 * 1024 ** 3, usage: 0.56, swapTotal: 0, swapUsed: 0 },
              disks: [{ mount: '/', total: 100 * 1024 ** 3, used: 92 * 1024 ** 3, free: 8 * 1024 ** 3, usage: 0.92 }],
              net: { txBytes: 42 * 1024 ** 3, rxBytes: 10 * 1024 ** 3, txRate: 1.2 * 1024 ** 2, rxRate: 2048, interfaces: ['eth0'] },
            },
            logs: {
              journalBytes: 3.4 * 1024 ** 3,
              varLogBytes: 3.6 * 1024 ** 3,
              capMb: 1024,
              capSource: 'default',
              top: [{ path: '/var/log/syslog', size: 120 * 1024 ** 2 }],
              lastVacuum: { at: Date.now() - 3600_000, before: 4 * 1024 ** 3, after: 600 * 1024 ** 2, freed: 3.4 * 1024 ** 3, keepMb: 614, error: '' },
            },
          },
          telemetryAt: Date.now() - 12000,
          telemetryAge: 12000,
          logCapMb: null,
          ...(over || {}),
        },
        accounts: 3,
        maxAccounts: 10,
        seats: 2,
        full: false,
        botVersions: [{ version: '0.9.0+aaa-arm64', seats: 2 }],
        botOutdated: false,
        managerDesired: null,
        managerOutdated: false,
        managerPending: false,
        timezonePending: false,
        company: { id: 'c1', name: 'UI-SMOKE-公司', slug: 'smoke', status: 'active' },
      })
      const orphan = {
        ...machine({
          id: 'ffffffff-0000-4000-8000-000000000000',
          host: null,
          paired: false,
          link: 'unpaired',
          lastHeartbeatAt: null,
          heartbeatAge: null,
          managerVersion: null,
          // 没配对的机器什么都不报。这一台在下面用来验「没报」和「报了 0」画得不一样。
          telemetry: null,
          telemetryAt: null,
          telemetryAge: null,
        }),
        company: null,
      }

      ui.state.path = '/machines'
      ui.state.allMachines = [machine(), orphan]
      ui.state.machineTotals = { machines: 2, paired: 1, online: 1, accounts: 3, max: 10, seats: 2 }
      ui.render()
      const list = ui.html()
      assert(list.includes('UI-SMOKE-公司'), '列表没画出归属公司')
      assert(list.includes('未分配'), '没派给公司的机器没标出来——它恰恰是这一页要看见的那种')
      assert(list.includes('data-href="/machines/ffffffff-0000-4000-8000-000000000000"'), '行点不进详情')
      // 负载那一格画的是**最吃紧的那一项**（这台是盘 92%），并且要进最响的那一档
      // 颜色——这张表存在的意义就是在机器写满之前看见它。
      assert(/satu-gauge" data-level="hot"/.test(list), '92% 的盘没进最响那一档，红线就白划了')
      assert(list.includes('盘 / 92%'), `列表里没写出最吃紧的那一项：${list.slice(list.indexOf('satu-gauge') - 200, list.indexOf('satu-gauge') + 200)}`)
      // 没报过的那台给「—」，不给 0%：失联机器的 0% 和空闲机器的 0% 看着一样、
      // 结论正相反。
      assert(!/satu-gauge[^>]*><span style="width: 0\.0%/.test(list), '没报过的机器被画成了 0%')

      ui.state.path = '/machines/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
      ui.state.machineDetail = {
        ...machine(),
        seatList: [
          {
            accountId: 'a1',
            who: 'zhang@smoke.test',
            whoName: '张三',
            botId: 'b1',
            botName: 'UI-SMOKE-助理',
            seatId: 'smoke-zhang-b1',
            linuxUser: 'sw_a1',
            slot: 3,
            status: 'ready',
            botVersion: '0.9.0+aaa-arm64',
            lastError: null,
            deployedAt: Date.now(),
          },
        ],
        companies: [{ id: 'c1', name: 'UI-SMOKE-公司', slug: 'smoke' }],
      }
      ui.render()
      const detail = ui.html()
      assert(detail.includes('smoke-zhang-b1'), '详情页没列出席位')
      // 「席位数」和「席位清单」共用一个键的话，这里会画出一串 [object Object]，
      // 而「这台机器上还有没有席位」也会跟着判错（空数组是真值）。
      assert(!detail.includes('[object Object]'), '有字段被当成对象直接拼进 HTML 了')
      // Bot 名要用接口给的那个。回落到 state.bots 的话，直接打开这个地址时整列是 uuid
      // ——而 state.bots 只有逛过别的页面才会有内容。
      assert(detail.includes('UI-SMOKE-助理'), '列表没用接口给的 Bot 名')
      // 出错的那个要比正常的显眼：这一页就是用来找坏掉那个的。
      assert(/tag-accent">运行中/.test(detail) === false, '正常的不该占着最扎眼的那档标签')
      assert(detail.includes('tag-accent-2">运行中'), 'ready 该是安静的那一档')
      // ── 负载与日志：这一页新加的两块 ────────────────────────────────
      assert(detail.includes('机器负载'), '详情页没有负载那块')
      assert(detail.includes('8 核') && detail.includes('23%'), `CPU 那行不对：${detail.slice(detail.indexOf('机器负载'), detail.indexOf('机器负载') + 600)}`)
      assert(detail.includes('92%'), '磁盘占用没画出来')
      assert(detail.includes('MB/s'), '出网速率没画出来')
      // 数是机器自报的、隔一轮心跳才来一次，所以必须先说清楚它有多新——不然一台失联
      // 机器上的「CPU 5%」看着和好机器一模一样。
      assert(/采样于/.test(detail), '没说这份数是什么时候采的')
      assert(detail.includes('日志占用'), '详情页没有日志那块')
      assert(detail.includes('data-form="machine-log-cap"'), '改日志上限的表单没接上')
      assert(detail.includes('data-act="machine-logs-vacuum"'), '手动清理的按钮没接上')
      // 超过上限要写出来：这一格是「管家会自己清」还是「它不清」，处置完全不同。
      assert(detail.includes('超过上限'), '3.4 GB 的 journal 压着 1024 MB 的上限，没说它超了')
      // 算不出百分比时**只说一遍**。原先条子和数值格各写一句「取样中」，同一行里
      // 出现两遍；空心虚线的槽负责占位，话由数值格去说。
      // 每次都从 machine() 现造一份并深拷一层：下面几段各改各的那一格，共用同一个
      // 对象的话，前一段的改动会跟着漏进后一段，断言就成了看运气。
      const variant = (tweak) => {
        const card = { ...machine(), seatList: [], companies: [] }
        card.machine = JSON.parse(JSON.stringify(card.machine))
        tweak(card.machine)
        return card
      }
      const asIs = ui.state.machineDetail

      ui.state.machineDetail = variant((m) => {
        m.telemetry.metrics.cpu.usage = null
      })
      ui.render()
      const half = ui.html()
      assert((half.match(/取样中/g) || []).length === 1, `「取样中」出现了 ${(half.match(/取样中/g) || []).length} 次，该只有一次`)
      assert(half.includes('data-level="none"'), '算不出来的那一格该画空心虚线槽，不能画成实心的 0%')

      // 上限为 0（这台机器不自动清）同样没有百分比可算，但机器一直在正常上报——
      // 写成「取样中」会让人跑去查一件根本没坏的事。
      ui.state.machineDetail = variant((m) => {
        m.telemetry.logs.capMb = 0
        m.logCapMb = 0
      })
      ui.render()
      const uncapped = ui.html()
      assert(uncapped.includes('不限'), 'journal 那行没写「不限」')
      assert(!uncapped.includes('取样中'), '上限为 0 被说成了「取样中」')

      // 机器上用 SATUWORK_LOG_CAP_MB 钉死时，期望值永远追不上实际值、pending 恒为真
      // ——那句「这里改不动它」必须排在前面，否则它恰好在唯一需要它的场景下画不出来。
      ui.state.machineDetail = variant((m) => {
        m.telemetry.logs.capSource = 'env'
        m.telemetry.logs.capMb = 2048
        m.logCapMb = 900
      })
      ui.render()
      const env = ui.html()
      assert(env.includes('SATUWORK_LOG_CAP_MB'), '本机钉死那句话没画出来')
      assert(!env.includes('已下指令，机器现在用的是'), '本机钉死时不该一直说「等机器认」')

      // ── 负载那块的两档：实时 / 日 ──────────────────────────────────
      ui.state.machineDetail = asIs
      ui.render()
      const live = ui.html()
      assert(live.includes('data-act="machine-load-tab"'), '负载那块没有档位切换')
      assert(!/data-tab="month"/.test(live), '月那一档已经取消了，不该还画着')

      // 「日」这一档吃的是另一条接口（按分钟归的档），所以要连数据一起摆进去。
      // key 对不上时界面只会写「载入中」——那条比对本身也顺带验到了。
      const today = new Date()
      const p2 = (n) => String(n).padStart(2, '0')
      const dayKey = `${today.getFullYear()}-${p2(today.getMonth() + 1)}-${p2(today.getDate())}`
      const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 30).getTime()
      ui.state.machineLoadTab = 'day'
      ui.state.machineLoadDate = dayKey
      ui.state.machineLoadMinutes = {
        key: `${asIs.machine.id}|day|${dayKey}`,
        retentionMs: 30 * 24 * 3600_000,
        minutes: [
          { minuteStart: at, samples: 2, cpuAvg: 0.2, cpuMax: 0.85, memAvg: 0.5, memMax: 0.6, diskAvg: 0.9, diskMax: 0.92, txBytes: 1024 * 1024, rxBytes: 2048 },
          { minuteStart: at + 60_000, samples: 2, cpuAvg: 0.1, cpuMax: 0.2, memAvg: 0.5, memMax: 0.5, diskAvg: 0.9, diskMax: 0.9, txBytes: 2048, rxBytes: 1024 },
        ],
      }
      ui.render()
      const day = ui.html()
      assert(day.includes('satu-bars'), '日视图没画出柱图')
      assert(day.includes('data-act="machine-load-date"'), '日视图没有日期选择器')
      // 峰值必须单独说出来：均值 20%，而那一分钟真冲到过 85%——人要找的就是它。
      assert(day.includes('85%'), `峰值没画出来：${day.slice(day.indexOf('satu-bars') - 400, day.indexOf('satu-bars'))}`)
      // 有数据的格子远少于总格数，这句话要如实说，不能把空档说成 0。
      // 09:30 和 09:31 落在**同一个 10 分钟格**里，所以是 1 格不是 2——这正是「库里按
      // 分钟存、画的时候并成 10 分钟」那句话的意思。
      assert(/1 \/ 144 格有数据/.test(day), `没说清多少格有数据：${day.slice(day.indexOf('出网合计') - 100, day.indexOf('出网合计') + 200)}`)

      // 超出保留期的那一天：要说「已经清掉了」，不是含混地空一片让人以为机器没开。
      const old2 = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 60)
      const oldKey = `${old2.getFullYear()}-${p2(old2.getMonth() + 1)}-${p2(old2.getDate())}`
      ui.state.machineLoadDate = oldKey
      ui.state.machineLoadMinutes = { key: `${asIs.machine.id}|day|${oldKey}`, retentionMs: 30 * 24 * 3600_000, minutes: [] }
      ui.render()
      assert(ui.html().includes('保留期'), '超出保留期的那天没说清是被清掉了')

      ui.state.machineLoadTab = 'live'
      ui.state.machineLoadDate = ''
      ui.state.machineLoadMinutes = null
      ui.render()
      assert(detail.includes('data-form="machine-capacity"'), '改容量的表单没接上')
      assert(detail.includes('data-form="machine-company"'), '改归属的表单没接上')
      // 上面有 Bot 也删得掉（登记跟着一起没），所以按钮**不该**是禁的——以前禁掉的
      // 结果是人对着一颗灰按钮猜为什么。代价改由确认框来说。
      assert(!/data-act="machine-remove"[^>]*disabled/.test(detail), '上面有 Bot 不该把移除按钮禁掉')
      assert(detail.includes('Bot 登记会一起抹掉'), '没告诉人这些 Bot 的登记会跟着一起没')
      // scope 决定接口前缀。漏了它，平台页上的每个动作都会打到公司那条路上去，
      // 而那条路要 orgId——没归属的机器上一个动作都做不了。
      assert(detail.includes('data-scope="platform"'), '动作没标 scope，会打到公司那条接口上')

      // 公司管理员没有这一页：机器是平台的事。
      const admin = await boot(adminToken)
      assert(!admin.pathAllowed('/machines'), '公司管理员不该进得去机器管理')
    })

    await test('会话列表截断时画出「加载更多」，没截断就不画', async () => {
      // 这条防的是「接口分页了、界面没接上」：后端只回最近一页，界面照样画成一份
      // 完整列表，管理员据此以为更早的会话不存在。按钮的 data-act 也要在，否则点了
      // 没反应——和当初供应商页漏掉确认框是同一类错。
      const ui = await boot(adminToken)
      ui.state.path = '/audit'
      ui.state.auditTab = 'chats'
      ui.state.sessions = [
        { sessionId: 's1', title: 'UI-SMOKE-会话一', accountName: '甲', botName: 'B', updatedAt: Date.now() },
      ]
      ui.state.sessionsHasMore = false
      ui.state.sessionsCursor = ''
      ui.render()
      assert(ui.html().includes('UI-SMOKE-会话一'), '列表没画出来')
      assert(!ui.html().includes('加载更多'), '没截断却画了「加载更多」')

      ui.state.sessionsHasMore = true
      ui.state.sessionsCursor = '123:s1'
      ui.render()
      const html = ui.html()
      assert(html.includes('加载更多'), '截断了却不说，用户会以为就这些')
      assert(html.includes('data-act="sessions-more"'), '按钮没接 data-act，点了不会有任何反应')
    })

    await test('建连失败（503）之后闩要放开，聊天还能重连', async () => {
      // chatAbort / chatStreamId 这对「当前流」的闩，建连失败时一度不放。
      // ensureChatSession 和 startChatStream 都拿它判断「已经有流在跑」，于是实例
      // 还没起来那一次 503 之后，聊天再也不会重连，要刷新整页才回得来。
      let hits = 0
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) {
            hits += 1
            return { ok: false, status: 503, text: async () => '实例还没上线' }
          }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      await ui.startChatStream('s-latch')
      assert(hits === 1, `第一次该打一次，实际 ${hits}`)
      await ui.startChatStream('s-latch')
      assert(hits === 2, `503 之后闩没放开，聊天不会再重连——只打了 ${hits} 次`)
      ui.stopChatStream()
    })

    await test('短命连接不清退避档位，否则会无限重连', async () => {
      // 判据是「这次连接活了多久」，不是「有没有连上」。bot 在崩溃重启循环里每次都
      // 给 200 然后立刻断；按「连上就清零」算的话，退避永远回到 500ms，重连停不下来。
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) {
            const sse = fakeSse()
            sse.close() // 接受连接，立刻收流
            return sse.response
          }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      try {
        // 从最后一档进去：连接活得太短就不该清零，所以这一次就该判定「断开」。
        await ui.startChatStream('s-backoff', ui.CHAT_RETRY_MAX)
        assert(
          ui.state.runtimeError === '连接断开，刷新页面重试',
          `短命连接把退避档位清零了，会一直 500ms 重连一次；runtimeError=${JSON.stringify(ui.state.runtimeError)}`,
        )
      } finally {
        // 清零的那个版本会留下一串 setTimeout 自我续命，套件就不退出了。
        ui.stopChatStream()
      }
    })

    await test('流式渲染合并重绘：一帧一次，不是一个 token 一次', async () => {
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        stubIds: ['chat-thread', 'chat-status'],
        fetchImpl: async (path) => (path.includes('/events') ? sse.response : fetch(gwBase + path)),
      })
      await ui.boot()
      const thread = ui.stubs.get('chat-thread')
      ui.state.chatSessionId = 's-paint'
      const run = ui.startChatStream('s-paint')
      // **先把历史放完。** 开流后的第一批事件属于重放，那一段是故意不画的（见上面
      // 「重放历史时不画中间态」）。这里要测的是历史之后**真正的流式输出**——用户发完
      // 消息、模型一个 token 一个 token 吐出来的那一段，它必须逐帧画。
      sse.push({ type: 'replay/done' })
      for (let i = 0; i < 100 && ui.state.chatReplaying; i++) await new Promise((r) => setTimeout(r, 5))
      const before = thread.writes
      const N = 20
      for (let i = 0; i < N; i++) sse.push({ type: 'assistant/chunk', seq: i + 1, data: { text: 'x' } })
      for (let i = 0; i < 200 && ui.state.chatEvents.length < N; i++) {
        await new Promise((r) => setTimeout(r, 5))
      }
      assert(ui.state.chatEvents.length === N, `事件没收全：${ui.state.chatEvents.length}/${N}`)
      // 合并重绘是**延后**的（一帧一次），事件到齐不等于已经画完——这里要多等一拍，
      // 否则测的是「还没来得及画」，不是「合并了」。
      await new Promise((r) => setTimeout(r, 60))
      const writes = thread.writes - before
      assert(writes > 0, '一次都没重绘，说明根本没画')
      assert(writes <= 3, `${N} 个 token 重绘了 ${writes} 次——没有合并，长会话下是 O(n²)`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('重放历史时不画中间态：不闪「正在处理」，消息也不逐条冒', async () => {
      // 打开一条会话时，SSE 把**全部历史**从头推一遍，和实时事件走同一个通道。一条
      // 8 轮的真实对话是 789 条事件。以前每收到一条就重绘一次：
      //   · O(n²)——每次都 fold 全量、比对整棵 DOM、重渲染最后那段 Markdown
      //   · 状态还是错的——重放到某轮的 turn/start 就显示「正在处理」，要等重放出配对
      //     的 turn/end 才消失。拿真实数据量过，789 帧里有 772 帧（98%）挂着「正在
      //     处理」，而那期间什么都没在跑。
      // 用户看到的就是「卡在正在处理，消息一条条往外冒」。
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => (path.includes('/events') ? sse.response : fetch(gwBase + path)),
      })
      await ui.boot()
      ui.state.chatSessionId = 's-replay'
      const run = ui.startChatStream('s-replay')
      assert(ui.state.chatReplaying, '开流就该拉闸')

      // 三轮都已收口的历史。中间那些 turn/start 正是以前让界面「忙」起来的东西。
      let seq = 0
      const push = (type, data) => sse.push({ seq: ++seq, time: 1, type, data: data || {} })
      for (let turn = 1; turn <= 3; turn++) {
        push('user/message', { message: { content: [{ type: 'text', text: '问题' + turn }] }, source: { kind: 'user' } })
        push('turn/start', { turn })
        for (let i = 0; i < 5; i++) push('assistant/chunk', { chunk: { type: 'text-delta', text: 'x' } })
        push('assistant/message', { turn, message: { content: [{ type: 'text', text: '回答' + turn }] } })
        push('turn/end', { turn, reason: 'completed' })
      }
      for (let i = 0; i < 200 && ui.state.chatEvents.length < seq; i++) await new Promise((r) => setTimeout(r, 5))
      assert(ui.state.chatEvents.length === seq, `事件没收全：${ui.state.chatEvents.length}/${seq}`)

      // 关键断言：灌的过程中一次都没画过，所以中间那些 turn/start 没能把界面点亮。
      assert(ui.state.chatReplaying, '历史还在灌，闸不该开')
      assert(ui.state.chatStatus === '', `重放期间画了中间态：chatStatus=${JSON.stringify(ui.state.chatStatus)}`)

      // 静默兜底：连着灌完一停，就认为历史放完了（老 bot 不发 replay/done 也能收敛）。
      await new Promise((r) => setTimeout(r, 350))
      assert(!ui.state.chatReplaying, '静默之后闸该开')
      const folded = ui.fold(ui.state.chatEvents)
      assert(folded.status === '', `重放完不该是忙态：${JSON.stringify(folded.status)}`)
      assert(folded.blocks.length === 6, `应有 6 条消息，实际 ${folded.blocks.length}`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    /* ── 历史和实时拆成两条路 ──────────────────────────────────────
       历史走 HTTP（hydrateChat），实时走 SSE，而流上还垫一轮兜底：名单要那行灰字，
       点进去的第一帧也要有东西可看。那一轮和 HTTP 拉回来的最后一轮**必然重叠**，
       所以两头都要挡：进桶时「比尾巴大才收」，补历史时「比头小才收」。
       两种到达顺序各测一遍——谁先到取决于网络，不该由它决定画出来对不对。
       ────────────────────────────────────────────────────────── */

    /** 一轮完整对话，seq 连号。 */
    const chatTurn = (base, n) => [
      { seq: base, time: base * 1000, type: 'user/message', data: { message: { content: [{ type: 'text', text: '问题' + n }] }, source: { kind: 'user' } } },
      { seq: base + 1, time: base * 1000, type: 'turn/start', data: { turn: n } },
      { seq: base + 2, time: base * 1000, type: 'assistant/message', data: { turn: n, message: { content: [{ type: 'text', text: '回答' + n }] } } },
      { seq: base + 3, time: base * 1000, type: 'turn/end', data: { turn: n, reason: 'completed' } },
    ]
    const THREE_TURNS = [...chatTurn(1, 1), ...chatTurn(5, 2), ...chatTurn(9, 3)]

    /** 接管 /history 和 /events 的 app 实例。history 回的是三轮全量。 */
    const twoPathUi = async (sse, onHistory) => {
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/history')) {
            if (onHistory) onHistory(path)
            return new Response(JSON.stringify({ events: THREE_TURNS, firstSeq: 1, hasMore: false }), {
              headers: { 'content-type': 'application/json' },
            })
          }
          if (path.includes('/events')) return sse.response
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      return ui
    }

    await test('流先到、历史后到：重叠的那一轮不画两遍', async () => {
      const sse = fakeSse()
      const seen = []
      const ui = await twoPathUi(sse, (path) => seen.push(path))
      const row = ui.botStreamOf('bot-two-path')
      row.sessionId = 's-two-a'
      ui.state.chatBotId = 'bot-two-path'
      ui.state.chatSessionId = 's-two-a'
      ui.state.chatEvents = row.events

      const run = ui.startChatStream('s-two-a', 0, 'bot-two-path')
      // 流垫的那一轮 = 最后一轮，和 history 的尾巴完全重叠。
      for (const ev of chatTurn(9, 3)) sse.push(ev)
      sse.push({ type: 'replay/done', live: false, firstSeq: 9, hasMore: true })
      for (let i = 0; i < 200 && row.events.length < 4; i++) await new Promise((r) => setTimeout(r, 5))
      assert(row.events.length === 4, `流垫的一轮没收全：${row.events.length}`)

      await ui.hydrateChat('bot-two-path', 's-two-a')
      const seqs = row.events.map((e) => e.seq)
      assert(
        JSON.stringify(seqs) === JSON.stringify(THREE_TURNS.map((e) => e.seq)),
        `归并结果不对（该是 1..12 无重复）：${JSON.stringify(seqs)}`,
      )
      const folded = ui.fold(row.events)
      assert(folded.blocks.length === 6, `该是 3 问 3 答共 6 条，实际 ${folded.blocks.length}`)
      // 游标只许往前推：replay/done 说的是 9，HTTP 说的是 1，最后要留 1。
      assert(ui.chatPages.get('s-two-a').firstSeq === 1, `翻页游标被缩回去了：${JSON.stringify(ui.chatPages.get('s-two-a'))}`)
      assert(seen.length === 1 && seen[0].includes('turns=' + ui.CHAT_TAIL_TURNS), `历史那一跳不对：${JSON.stringify(seen)}`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('历史先到、流后到：重放段整段被认成重复', async () => {
      const sse = fakeSse()
      const ui = await twoPathUi(sse)
      const row = ui.botStreamOf('bot-two-path')
      row.sessionId = 's-two-b'
      ui.state.chatBotId = 'bot-two-path'
      ui.state.chatSessionId = 's-two-b'
      ui.state.chatEvents = row.events

      await ui.hydrateChat('bot-two-path', 's-two-b')
      assert(row.events.length === 12, `历史没进桶：${row.events.length}`)
      assert(row.hydrated === true, 'hydrated 没置位')

      const run = ui.startChatStream('s-two-b', 0, 'bot-two-path')
      for (const ev of chatTurn(9, 3)) sse.push(ev)
      sse.push({ type: 'replay/done', live: false })
      await new Promise((r) => setTimeout(r, 120))
      assert(row.events.length === 12, `重放段被重复收下了：${row.events.length}`)

      // 真正的新事件照收。
      for (const ev of chatTurn(13, 4)) sse.push(ev)
      for (let i = 0; i < 200 && row.events.length < 16; i++) await new Promise((r) => setTimeout(r, 5))
      assert(row.events.length === 16, `新一轮没收进来：${row.events.length}`)
      assert(row.sum.lastText === '回答4', `名单摘要不对：${JSON.stringify(row.sum.lastText)}`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('流上只垫一轮，二十轮那份改走 HTTP', async () => {
      // 名单上每个 Bot 都挂一条流。以前每条一上来都推二十轮历史，几个 Bot 乘二十轮
      // 全在主线程上 parse，换来的只是侧栏一行字。
      const sse = fakeSse()
      let streamUrl = ''
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) {
            streamUrl = path
            return sse.response
          }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      ui.state.chatSessionId = 's-tail'
      const run = ui.startChatStream('s-tail')
      for (let i = 0; i < 100 && !streamUrl; i++) await new Promise((r) => setTimeout(r, 5))
      assert(streamUrl.includes('tail=' + ui.STREAM_TAIL_TURNS), `流上的 tail 不对：${streamUrl}`)
      assert(ui.STREAM_TAIL_TURNS === 1, `流上该只垫一轮，实际 ${ui.STREAM_TAIL_TURNS}`)
      assert(ui.CHAT_TAIL_TURNS === 20, `历史一页该是二十轮，实际 ${ui.CHAT_TAIL_TURNS}`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('拉历史途中会话被重建：这一份作废，不串台', async () => {
      const sse = fakeSse()
      const ui = await twoPathUi(sse)
      const row = ui.botStreamOf('bot-two-path')
      row.sessionId = 's-old'
      ui.state.chatBotId = 'bot-two-path'
      ui.state.chatSessionId = 's-old'
      ui.state.chatEvents = row.events
      const job = ui.hydrateChat('bot-two-path', 's-old')
      // 席位重建了会话——这份历史属于另一条对话。
      ui.resetBotStream(row)
      row.sessionId = 's-new'
      await job
      assert(row.events.length === 0, `串台的历史进桶了：${row.events.length}`)
      assert(row.hydrated === false, '作废的那次不该置 hydrated')
      sse.close()
    })

    await test('席位重建了会话：旧流被掐掉，新会话真的连得上', async () => {
      // resetBotStream 一度只清数据（事件、摘要、hydrated），把 row.ac 留着。而调用方
      // 紧接着就把 row.sessionId 改成新的，于是 startChatStream 的「已经在跑」闸
      // （row.sessionId === sessionId && row.ac）误触发、直接 return——新会话一条流都
      // 开不出来。更糟的是旧流还活着，继续往这只刚清空的桶里灌旧会话的事件。
      const first = fakeSse()
      const second = fakeSse()
      const opened = []
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/history')) {
            return new Response(JSON.stringify({ events: [], firstSeq: null, hasMore: false }), {
              headers: { 'content-type': 'application/json' },
            })
          }
          if (path.includes('/events')) {
            opened.push(path)
            return opened.length === 1 ? first.response : second.response
          }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      const row = ui.botStreamOf('bot-rebuilt')
      ui.state.chatBotId = 'bot-rebuilt'
      ui.state.chatSessionId = 's-old'
      ui.state.chatEvents = row.events
      void ui.startChatStream('s-old', 0, 'bot-rebuilt')
      for (let i = 0; i < 200 && !opened.length; i++) await new Promise((r) => setTimeout(r, 5))
      assert(row.ac, '第一条流没记到行上')

      // 席位重建 —— 走 ensureChatSession 冷路径的那两步。
      ui.resetBotStream(row)
      assert(!row.ac, '旧流的 ac 没清掉，「已经在跑」闸会拿它误认新会话')
      row.sessionId = 's-new'
      ui.state.chatSessionId = 's-new'
      void ui.startChatStream('s-new', 0, 'bot-rebuilt')
      for (let i = 0; i < 200 && opened.length < 2; i++) await new Promise((r) => setTimeout(r, 5))
      assert(opened.length === 2, `新会话的流没开出来：${JSON.stringify(opened)}`)

      // 掐掉的那条就算还有半截数据在手，也不该落进新会话的桶里。
      first.push({ seq: 99, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '旧会话的话' }] }, source: { kind: 'user' } } })
      await new Promise((r) => setTimeout(r, 60))
      assert(
        !JSON.stringify(row.events).includes('旧会话的话'),
        `旧会话的事件串进新会话了：${JSON.stringify(row.events)}`,
      )
      first.close()
      second.close()
      ui.stopChatStream()
    })

    await test('席位重建时正在拉历史：新会话不会被那把闸挡在门外', async () => {
      // 「别拉两遍」的闸认的是 row.hydrating。它拉的是**旧**会话的历史，重建之后不清
      // 掉的话，新会话这次 hydrate 会拿到旧会话那只 promise 就直接返回；旧的一醒来
      // 发现串台自己走了，于是新会话的历史从此没人去拉。
      const sse = fakeSse()
      const asked = []
      let release
      const gate = new Promise((r) => (release = r))
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/history')) {
            asked.push(path)
            // 第一次（旧会话那次）挂住，制造「正在飞」的窗口。
            if (asked.length === 1) await gate
            return new Response(JSON.stringify({ events: THREE_TURNS, firstSeq: 1, hasMore: false }), {
              headers: { 'content-type': 'application/json' },
            })
          }
          if (path.includes('/events')) return sse.response
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      const row = ui.botStreamOf('bot-hydrating')
      row.sessionId = 's-old'
      ui.state.chatBotId = 'bot-hydrating'
      ui.state.chatSessionId = 's-old'
      ui.state.chatEvents = row.events
      const stale = ui.hydrateChat('bot-hydrating', 's-old')
      for (let i = 0; i < 200 && !asked.length; i++) await new Promise((r) => setTimeout(r, 5))
      assert(row.hydrating, '在飞的 hydrate 没记到行上')

      ui.resetBotStream(row)
      assert(!row.hydrating, '在飞的 hydrate 没清掉，新会话会被它挡住')
      row.sessionId = 's-new'
      ui.state.chatSessionId = 's-new'
      await ui.hydrateChat('bot-hydrating', 's-new')
      assert(asked.length === 2, `新会话没去拉历史：${JSON.stringify(asked)}`)
      assert(row.events.length === 12, `新会话的历史没进桶：${row.events.length}`)
      assert(row.hydrated === true, '新会话的 hydrated 没置位')

      release()
      await stale
      // 旧那次醒来发现串台，不该把自己那份塞进来，也不该改动结论。
      assert(row.events.length === 12, `串台的历史挤进来了：${row.events.length}`)
      sse.close()
    })

    await test('历史接口回了个空 body：不炸，也不把这个 Bot 永久钉死', async () => {
      // api() 在 body 为空时返回 null（Gateway 的 proxyJson 同样把席位的空 body 转成
      // 200 + null）。裸取 data.firstSeq 会当场抛，而那时 hydrated 已经置位——于是这个
      // Bot 从此不再重拉，永远停在流垫的那一轮。
      const sse = fakeSse()
      let calls = 0
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/history')) {
            calls++
            if (calls === 1) return new Response('', { headers: { 'content-type': 'application/json' } })
            return new Response(JSON.stringify({ events: THREE_TURNS, firstSeq: 1, hasMore: false }), {
              headers: { 'content-type': 'application/json' },
            })
          }
          if (path.includes('/events')) return sse.response
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      const row = ui.botStreamOf('bot-empty-body')
      row.sessionId = 's-empty'
      ui.state.chatBotId = 'bot-empty-body'
      ui.state.chatSessionId = 's-empty'
      ui.state.chatEvents = row.events

      await ui.hydrateChat('bot-empty-body', 's-empty')
      assert(row.hydrated === false, '空 body 当成拉到了，这个 Bot 就再也不会重拉')
      // 第二次要真的重来一遍，并且能拿到东西。
      await ui.hydrateChat('bot-empty-body', 's-empty')
      assert(calls === 2, `没有重试：calls=${calls}`)
      assert(row.events.length === 12, `重试之后历史还是没进桶：${row.events.length}`)
      sse.close()
    })

    await test('翻页游标只许往前推——loadOlderChat 也不例外', async () => {
      // chatPages.firstSeq 有三个写入方（replay/done、hydrateChat、loadOlderChat），
      // 而它们看到的窗口不一样大。窄的那份晚到时如果照写，游标就退回去了：下一次
      // 「加载更早」取的是一页手上全有的事件，归并那两道闸把它们全滤掉，按钮点了
      // 没反应。
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/history')) {
            // 这一页比手上知道的**窄**：从 seq 5 开始，而 hydrate 已经知道 1 了。
            return new Response(JSON.stringify({ events: chatTurn(5, 2), firstSeq: 5, hasMore: true }), {
              headers: { 'content-type': 'application/json' },
            })
          }
          if (path.includes('/events')) return sse.response
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      const row = ui.botStreamOf('bot-cursor')
      row.sessionId = 's-cursor'
      ui.state.chatBotId = 'bot-cursor'
      ui.state.chatSessionId = 's-cursor'
      ui.state.chatEvents = row.events
      row.events.push(...THREE_TURNS)
      // 先记下宽的那份（hydrateChat 拉回二十轮时的样子）。
      ui.chatPages.set('s-cursor', { firstSeq: 1, hasMore: true, loading: false })

      await ui.loadOlderChat('s-cursor')
      const page = ui.chatPages.get('s-cursor')
      assert(page.firstSeq === 1, `游标被窄的那一页推回去了：${JSON.stringify(page)}`)
      assert(page.loading === false, `翻完了没解灰：${JSON.stringify(page)}`)
      sse.close()
    })

    await test('bot 说了 replay/done 就立刻开闸，不用等静默', async () => {
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => (path.includes('/events') ? sse.response : fetch(gwBase + path)),
      })
      await ui.boot()
      ui.state.chatSessionId = 's-mark'
      const run = ui.startChatStream('s-mark')
      sse.push({ seq: 1, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '嗨' }] }, source: { kind: 'user' } } })
      sse.push({ type: 'replay/done' })
      for (let i = 0; i < 100 && ui.state.chatReplaying; i++) await new Promise((r) => setTimeout(r, 5))
      assert(!ui.state.chatReplaying, 'replay/done 之后闸该立刻开')
      // 标记本身不是会话事件，不该混进正文里
      assert(ui.state.chatEvents.length === 1, `标记被当成消息收下了：${JSON.stringify(ui.state.chatEvents)}`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('bot 说了没在跑，就别再挂着「正在处理」', async () => {
      // 历史被截断在 turn/start 上时，扫事件扫出来的结论一定是「在跑」——而它可能几
      // 小时前就结束了。两条路都会走到这儿，而且都很常见：流断在重放中途（尾巴那条
      // turn/end 没到），或者进程半路没了、日志里那条 turn/end 根本没写成。
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => (path.includes('/events') ? sse.response : fetch(gwBase + path)),
      })
      await ui.boot()
      ui.state.chatSessionId = 's-live'
      const run = ui.startChatStream('s-live')
      sse.push({ seq: 1, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '嗨' }] }, source: { kind: 'user' } } })
      sse.push({ seq: 2, time: 1, type: 'turn/start', data: { turn: 1 } })
      sse.push({ type: 'replay/done', live: false })
      for (let i = 0; i < 100 && ui.state.chatReplaying; i++) await new Promise((r) => setTimeout(r, 5))
      assert(
        ui.state.chatStatus === '',
        `bot 说了没在跑，界面还挂着「正在处理」：${JSON.stringify(ui.state.chatStatus)}`,
      )

      // 之后由实时的 turn 事件接着维护：真开跑了就得点亮。
      sse.push({ seq: 3, time: 1, type: 'turn/start', data: { turn: 2 } })
      for (let i = 0; i < 100 && ui.state.chatStatus === ''; i++) await new Promise((r) => setTimeout(r, 5))
      assert(ui.state.chatStatus === 'running', '真开跑了却没点亮')
      sse.push({ seq: 4, time: 1, type: 'turn/end', data: { turn: 2, reason: 'completed' } })
      for (let i = 0; i < 100 && ui.state.chatStatus !== ''; i++) await new Promise((r) => setTimeout(r, 5))
      assert(ui.state.chatStatus === '', '跑完了没灭')
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('闸已经自己开过了，replay/done 的结论照样要画出来', async () => {
      // 这条抓的是线上那个真实故障：一段 988 条的历史，重放必然撞上 4 秒硬上限（或
      // 120ms 静默兜底），闸提前开了。等 replay/done 带着 live=false 到达时，endReplay
      // 第一行就是「闸开过了就 return」——结论存进了 chatLive，一帧都没画。而这之后
      // 不会再有任何事件来触发重绘（它说的就是「没在跑」），界面于是永远停在开闸那
      // 一刻：一个悬着的 turn/start，一句「正在处理」。
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => (path.includes('/events') ? sse.response : fetch(gwBase + path)),
      })
      await ui.boot()
      ui.state.chatSessionId = 's-late'
      const run = ui.startChatStream('s-late')
      sse.push({ seq: 1, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '嗨' }] }, source: { kind: 'user' } } })
      sse.push({ seq: 2, time: 1, type: 'turn/start', data: { turn: 1 } })

      // **先让闸自己开**——这正是长历史下必然发生的事，也是这条用例的前提。
      for (let i = 0; i < 200 && ui.state.chatReplaying; i++) await new Promise((r) => setTimeout(r, 5))
      assert(!ui.state.chatReplaying, '前置没成立：闸还没自己开')
      assert(ui.state.chatStatus === 'running', `前置没成立：此刻按扫描该是忙的，实际 ${JSON.stringify(ui.state.chatStatus)}`)

      // 现在 bot 才说「没在跑」。晚到不等于不算数。
      sse.push({ type: 'replay/done', live: false })
      for (let i = 0; i < 200 && ui.state.chatStatus !== ''; i++) await new Promise((r) => setTimeout(r, 5))
      assert(
        ui.state.chatStatus === '',
        `bot 说了没在跑，界面却还挂着——结论没被画出来：${JSON.stringify(ui.state.chatStatus)}`,
      )
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('重放停在半路：带着游标自己重连，把缺的那截补回来', async () => {
      // 线上实测：bot 报「重放 1078 条」，客户端只收到 1054 条，replay/done 从没到达，
      // 连接还开着也不会重连。原因是 bot 那边 enqueue 不阻塞，尾巴压在下游的缓冲里，
      // 而一条安静的会话再也不会有新字节把它顶出去。表现是历史缺一截 + 永远「正在处理」。
      const first = fakeSse()
      const second = fakeSse()
      const urls = []
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (!path.includes('/events')) return fetch(gwBase + path)
          urls.push(path)
          return urls.length === 1 ? first.response : second.response
        },
      })
      await ui.boot()
      ui.state.chatSessionId = 's-stall'
      void ui.startChatStream('s-stall', 0, 'bot-stall')

      // 收了两条就断供，且**不发** replay/done——正是卡住的样子。
      first.push({ seq: 1, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '嗨' }] }, source: { kind: 'user' } } })
      first.push({ seq: 2, time: 1, type: 'turn/start', data: { turn: 1 } })
      for (let i = 0; i < 200 && urls.length < 1; i++) await new Promise((r) => setTimeout(r, 5))

      // 看门狗到点应该带着游标重连，而不是干等下去。
      for (let i = 0; i < 300 && urls.length < 2; i++) await new Promise((r) => setTimeout(r, 50))
      assert(urls.length === 2, `没有重连——重放卡住就一直卡着了：${JSON.stringify(urls)}`)
      assert(
        /after=2(&|$)/.test(urls[1]),
        `重连没带游标，会从 0 再放一遍（缓冲边界照样卡同一处）：${urls[1]}`,
      )

      // 补上剩下的一截 + replay/done，界面该收敛。
      second.push({ seq: 3, time: 1, type: 'turn/end', data: { turn: 1, reason: 'completed' } })
      second.push({ type: 'replay/done', live: false })
      for (let i = 0; i < 300 && ui.state.chatStatus !== ''; i++) await new Promise((r) => setTimeout(r, 20))
      assert(ui.state.chatStatus === '', `补齐之后还挂着：${JSON.stringify(ui.state.chatStatus)}`)
      first.close()
      second.close()
      ui.stopChatStream()
    })

    await test('打开对话只要最近几轮，往前翻再一页页取', async () => {
      // 以前是整段推：实测 1078 条，每次刷新都从头灌一遍。慢，而且尾巴容易压在下游
      // 缓冲里出不来——「历史缺一截 + 永远正在处理」就是这么来的。
      const sse = fakeSse()
      const urls = []
      const older = [
        { seq: 5, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '很早以前' }] }, source: { kind: 'user' } } },
        { seq: 6, time: 1, type: 'assistant/message', data: { turn: 1, step: 0, message: { content: [{ type: 'text', text: '很早的回答' }] } } },
      ]
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          urls.push(path)
          if (path.includes('/history')) {
            return { ok: true, status: 200, text: async () => JSON.stringify({ events: older, firstSeq: 5, hasMore: false }) }
          }
          if (path.includes('/events')) return sse.response
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      ui.state.chatSessionId = 's-page'
      void ui.startChatStream('s-page')
      for (let i = 0; i < 200 && !urls.some((u) => u.includes('/events')); i++) await new Promise((r) => setTimeout(r, 5))
      const open = urls.find((u) => u.includes('/events'))
      assert(/[?&]tail=\d+/.test(open), `头一次连没带 tail，还是会把整段历史推一遍：${open}`)

      sse.push({ seq: 10, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: '最近的' }] }, source: { kind: 'user' } } })
      sse.push({ seq: 11, time: 1, type: 'assistant/message', data: { turn: 2, step: 0, message: { content: [{ type: 'text', text: '最近的回答' }] } } })
      sse.push({ type: 'replay/done', live: false, firstSeq: 10, hasMore: true })
      for (let i = 0; i < 200 && ui.state.chatEvents.length < 2; i++) await new Promise((r) => setTimeout(r, 5))

      // 前面还有，顶上就该有一行入口。
      const rows = ui.threadRows(ui.fold(ui.state.chatEvents), 's-page')
      assert(rows[0] && rows[0].kind === 'more', `顶上没有「加载更早」：${JSON.stringify(rows.map((r) => r.kind))}`)

      await ui.loadOlderChat('s-page')
      const page = urls.find((u) => u.includes('/history'))
      assert(page && /before=10/.test(page), `翻页没带游标，会把同一段再取一遍：${page}`)
      // 旧的要插在**开头**，顺序不能乱。
      assert(ui.state.chatEvents[0].seq === 5, `旧消息没插到开头：${ui.state.chatEvents.map((e) => e.seq).join(',')}`)
      const after = ui.threadRows(ui.fold(ui.state.chatEvents), 's-page')
      assert(!after.some((r) => r.kind === 'more'), '翻到头了还挂着「加载更早」')
      assert(after.filter((r) => r.kind === 'msg').length === 4, `四条消息该都在：${after.filter((r) => r.kind === 'msg').length}`)
      sse.close()
      ui.stopChatStream()
    })

    await test('老 bot 不带 live 字段：照旧按事件扫，不改行为', async () => {
      // 席位上的 bot 比 Gateway 旧一步是常态（要重新部署才换版本）。它发的 replay/done
      // 上没有 live，这时候只能回落到扫描——可以不如新版准，但不能比以前更差。
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => (path.includes('/events') ? sse.response : fetch(gwBase + path)),
      })
      await ui.boot()
      ui.state.chatSessionId = 's-old'
      const run = ui.startChatStream('s-old')
      sse.push({ seq: 1, time: 1, type: 'turn/start', data: { turn: 1 } })
      sse.push({ type: 'replay/done' })
      for (let i = 0; i < 100 && ui.state.chatReplaying; i++) await new Promise((r) => setTimeout(r, 5))
      assert(ui.state.chatStatus === 'running', `老 bot 那条路被改坏了：${JSON.stringify(ui.state.chatStatus)}`)
      sse.close()
      await run
      ui.stopChatStream()
    })

    await test('换 Bot：席位没起来时也不能留着上一个 Bot 的对话', async () => {
      // 原来是等新会话拿回来、比对出 sessionId 变了才清正文。新 Bot 的席位没上线时那步
      // 走不到（503 就地 return），于是切过去之后屏幕上还挂着**上一个 Bot 的聊天记录**，
      // 旧的那条流还连着，还在往里追消息。
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) return sse.response
          // bot-b 的席位没起来
          if (path.includes('/bots/bot-b/session')) return { ok: false, status: 503, text: async () => '实例还没上线' }
          if (path.includes('/bots/bot-a/session')) return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 's-a' }) }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()

      await ui.ensureChatSession('bot-a')
      ui.state.chatEvents.push({ seq: 1, time: 1, type: 'user/message', data: { message: { content: [{ type: 'text', text: 'A 的悄悄话' }] }, source: { kind: 'user' } } })
      assert(ui.state.chatEvents.length === 1, '前置没成立')

      await ui.ensureChatSession('bot-b')
      assert(ui.state.chatEvents.length === 0, `切到没上线的 Bot 之后还留着 ${ui.state.chatEvents.length} 条上一个 Bot 的消息`)
      assert(ui.state.chatSessionId === '', `会话 id 还指着上一条：${ui.state.chatSessionId}`)
      assert(ui.state.chatBotId === 'bot-b', `chatBotId 应为 bot-b，实际 ${ui.state.chatBotId}`)
      ui.stopChatStream()
      sse.close()
    })

    await test('换 Bot：旧流还在跑，但它的事件绝不落进新会话', async () => {
      const sseA = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) return sseA.response
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      ui.state.chatSessionId = 's-a'
      const run = ui.startChatStream('s-a')
      sseA.push({ type: 'assistant/chunk', seq: 1, data: { chunk: { type: 'text-delta', text: 'A' } } })
      for (let i = 0; i < 100 && ui.state.chatEvents.length < 1; i++) await new Promise((r) => setTimeout(r, 5))
      assert(ui.state.chatEvents.length === 1, '前置没成立')

      // 人切走了：当前会话已经换成 s-b，但 s-a 那条流**照旧在跑**——侧栏名单上那个
      // Bot 的转圈和「最近回复」就指望它。要守的是「它的事件不许串到新会话的正文里」，
      // 不是「把它掐掉」。
      ui.state.chatSessionId = 's-b'
      ui.state.chatEvents = []
      sseA.push({ type: 'assistant/chunk', seq: 2, data: { chunk: { type: 'text-delta', text: '迟到的 A' } } })
      await new Promise((r) => setTimeout(r, 40))
      assert(
        ui.state.chatEvents.length === 0,
        `旧流的事件落进了新会话：${JSON.stringify(ui.state.chatEvents)}`,
      )
      sseA.close()
      await run
      ui.stopChatStream()
    })

    await test('侧栏预热流先到：认领它，别让正文空着', async () => {
      const sse = fakeSse()
      let release = null
      const held = new Promise((r) => {
        release = r
      })
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) return sse.response
          if (path.includes('/session')) {
            await held
            return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 's-a' }) }
          }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()

      // loadPage 里那句 `void warmBotStreams()` 跑在 loadChatPage 前面，正在打开的这个
      // Bot 也在名单里。于是同一条会话有两个人去开流：预热那边先建上（那会儿它还只是
      // 后台流，chatStreamId 没设），ensureChatSession 随后才把这条会话认成当前的。
      const pending = ui.ensureChatSession('bot-a')
      await new Promise((r) => setTimeout(r, 10))
      void ui.startChatStream('s-a', 0, 'bot-a')
      await new Promise((r) => setTimeout(r, 10))
      release()
      await pending

      // 认领没做的话，这条流在读循环里会同时满足「是当前会话」和「chatStreamId 对不上」
      // ——那正是「人已经切走了」的判据，它自己收摊，重放到一半的历史再也回不来：正文
      // 空白，切走再切回来还是空白，只能刷新整页。
      sse.push({
        type: 'assistant/message',
        seq: 1,
        time: Date.now(),
        data: { message: { content: [{ type: 'text', text: '历史第一条' }] } },
      })
      for (let i = 0; i < 100 && ui.state.chatEvents.length < 1; i++) await new Promise((r) => setTimeout(r, 5))
      assert(ui.state.chatEvents.length === 1, `预热流把自己判成「已经切走」收摊了，正文空白`)
      ui.stopChatStream()
      sse.close()
    })

    await test('换 Bot：没发出去的草稿跟着各自的 Bot 走', async () => {
      const sse = fakeSse()
      const ui = loadApp({
        appPath,
        base: gwBase,
        token: adminToken,
        fetchImpl: async (path) => {
          if (path.includes('/events')) return sse.response
          if (path.includes('/session')) return { ok: true, status: 200, text: async () => JSON.stringify({ sessionId: 's-' + path.split('/bots/')[1].split('/')[0] }) }
          return fetch(gwBase + path)
        },
      })
      await ui.boot()
      await ui.ensureChatSession('bot-a')
      ui.state.chatDraft = '写给 A 的半句话'
      await ui.ensureChatSession('bot-b')
      // 带着 A 的草稿跳到 B，一按回车就发错人了。
      assert(ui.state.chatDraft === '', `切到 B 之后草稿还在：${JSON.stringify(ui.state.chatDraft)}`)
      await ui.ensureChatSession('bot-a')
      assert(ui.state.chatDraft === '写给 A 的半句话', `切回 A 草稿没了：${JSON.stringify(ui.state.chatDraft)}`)
      ui.stopChatStream()
      sse.close()
    })

    await test('正文里的 HTML 被转义，不当标签渲染', async () => {
      const ui = await boot(ownerToken)
      const html = ui.auditTranscript([
        { type: 'user/message', data: { message: { content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }] } } },
      ])
      assert(!html.includes('<img src=x'), '正文里的标签没转义')
      assert(html.includes('&lt;img'), '没走转义')
    })
  } finally {
    try {
      rmSync(GW_HOME, { recursive: true, force: true })
    } catch {}
  }
}
