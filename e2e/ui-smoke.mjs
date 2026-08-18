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
import { PG_URL } from './pg.mjs'
import { el, fakeSse } from './ui-dom.mjs'

const APP = 'gateway/ui/app.js'

export async function runUiSmoke({ root, gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = '/tmp/satuwork-e2e-ui-gw'
  const GW_PORT = 18680
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
      assert(html.includes('成本价') && html.includes('报价'), '两个金额列没都画出来')
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

    await test('全局项在公司侧标出来且只读；owner 自己那份不算只读', async () => {
      const ui = await boot(ownerToken)
      ui.state.path = '/bots'
      ui.state.bots = [
        { id: 'g1', name: '全局助理', origin: 'global', enabled: true },
        { id: 'c1', name: '本公司助理', origin: 'company', enabled: true },
      ]
      // owner 管的就是全局那份，不该被标成只读。
      assert(ui.readOnlyItem(ui.state.bots[0]) === false, 'owner 被当成只读了')
      ui.render()
      assert(ui.html().includes('全局 Bot'), 'owner 侧标题不对')

      ui.state.me = { account: { role: 'admin', email: 'a@x' }, company: { id: 'org-1' }, settings: ui.state.settings }
      assert(ui.readOnlyItem(ui.state.bots[0]) === true, '公司侧没把全局项当只读')
      assert(ui.readOnlyItem(ui.state.bots[1]) === false, '把公司自己的项也当只读了')
      ui.render()
      const html = ui.html()
      assert(html.includes('全局'), '没标出「全局」')
      assert(html.includes('查看'), '全局行没换成「查看」')
      assert(html.includes('配置'), '公司自己的行不该变成只读')
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
        balance: { amount: '$350.00', planBonus: '$200.00', planBonusExpires: '2026-09-01', topup: '$150.00', spentThisMonth: '—', alertAt: '—' },
      }
      ui.render()
      const html = ui.html()
      const bonus = html.indexOf('套餐赠送余额')
      const account = html.indexOf('账户余额')
      assert(bonus > -1 && account > -1, '两张卡没都画出来')
      assert(bonus < account, '赠送那张跑到账户余额后面去了')
      assert(html.includes('$200.00') && html.includes('$350.00') && html.includes('$150.00'), '三个数没都画出来')
      assert(html.includes('2026-09-01 到期'), '到期日没画出来')
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
        balance: { amount: '$0.00', planBonus: '$0.00', planBonusExpires: '—', topup: '$0.00', spentThisMonth: '—', alertAt: '—' },
      }
      ui.render()
      const html = ui.html()
      assert(html.includes('没有生效中的套餐'), '空态没写清楚')
      assert(!html.includes('— 到期'), '把「—」当成到期日画出来了')
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
      const reg = await req(gwBase, 'POST', '/auth/register', {
        body: { email: 'admin@ui.test', password: 'correct-horse-2', companyName: 'UI', slug: 'ui-co', seats: 2 },
      })
      assert(reg.status === 201, `register ${reg.status} ${reg.text}`)
      adminToken = reg.json.token

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
      const before = thread.writes
      const run = ui.startChatStream('s-paint')
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
