/**
 * 正文里的文件名怎么接回工作区里的文件（chat.js 的 knownFiles / fileCands / fileHits），
 * 外加右栏那棵文件树画出来的 HTML。
 *
 * 不起服务、不连数据库：这几个是纯函数，装进 ui-dom.mjs 那层垫片就能跑。
 *
 * 为什么值得单独钉一条：这条规则是**在散文里认名字**，而它唯一的护栏就是那几条边界
 * 判断——认宽了，一句「更新了报表」会把不相干的字点亮，点开是另一个文件；认窄了，
 * 目录树那一屏又一个都点不动。两头都不会有人报 bug，只会觉得「这功能怪怪的」。
 */
import { join } from 'node:path'
import { loadApp, el } from './ui-dom.mjs'

/** 一份现成的名册：两个目录下各一个文件，外加一个重名的。 */
function knownOf(ui, paths) {
  return ui.knownFiles([
    { tools: [{ name: 'ls', refs: paths.map((p) => ({ path: p, name: p.split('/').pop() })) }] },
  ])
}

export async function runUiFiles({ root, test, assert, log }) {
  log('\n# ui-files')
  const ui = loadApp({ appPath: join(root, 'gateway/ui/app.js'), base: 'http://127.0.0.1:1' })

  /** text 里认出来的那些文件名，按出现顺序。 */
  const hits = (text, paths) => ui.fileHits(text, ui.fileCands(knownOf(ui, paths))).map((h) => h.file.path)

  await test('整条会话攒一份名册：产出、附件、看到的都算', async () => {
    const known = ui.knownFiles([
      { files: [{ path: 'uploads/s-1/单据.pdf', name: '单据.pdf' }] },
      {
        tools: [
          { name: 'write', files: [{ path: '报告.md', name: '报告.md' }] },
          { name: 'ls', refs: [{ path: 'uploads/s-1/图.png', name: '图.png' }] },
        ],
      },
    ])
    assert(known.size === 3, `名册里有 ${known.size} 个`)
    assert(known.get('报告.md').name === '报告.md', '产出没进名册')
    assert(known.get('uploads/s-1/图.png'), 'refs 没进名册')
  })

  await test('完整路径认得出来', async () => {
    const got = hits('详见 uploads/s-1/单据.pdf 里的第二页', ['uploads/s-1/单据.pdf'])
    assert(got.length === 1 && got[0] === 'uploads/s-1/单据.pdf', JSON.stringify(got))
  })

  await test('句子里裸着的文件名也认得出来（中文两边不算词边界）', async () => {
    const got = hits('已生成印尼山火报告2026-08.html，请查收', ['印尼山火报告2026-08.html'])
    assert(got.length === 1, `认了 ${got.length} 个：${JSON.stringify(got)}`)
  })

  await test('目录树里那一行（前面是树线、后面是大小）照样认', async () => {
    const tree = '├── Airchina_A359.pdf   (708 KB)\n└── page-1.png   (961 KB)'
    const got = hits(tree, ['uploads/s-1/Airchina_A359.pdf', 'uploads/s-1/page-1.png'])
    assert(got.length === 2, `认了 ${got.length} 个：${JSON.stringify(got)}`)
  })

  await test('完整路径赢过它自己的文件名，不重复认两次', async () => {
    const got = hits('看 uploads/s-1/单据.pdf', ['uploads/s-1/单据.pdf'])
    assert(got.length === 1, `同一段认了 ${got.length} 次`)
  })

  await test('截一半的不认：a.md 不是 ba.md，报表.xlsx 不是 报表.xlsx.bak', async () => {
    assert(hits('打开 ba.md 看看', ['a.md']).length === 0, 'ba.md 被当成了 a.md')
    assert(hits('备份在 报表.xlsx.bak', ['报表.xlsx']).length === 0, '报表.xlsx.bak 被当成了 报表.xlsx')
    assert(hits('src/lib/a.md 里', ['a.md']).length === 0, '更长路径里的一段被单独认了')
  })

  await test('重名的一律不认——猜中一次不值得赔上指错的那两次', async () => {
    const got = hits('改一下 index.ts', ['src/index.ts', 'lib/index.ts'])
    assert(got.length === 0, `重名还认了：${JSON.stringify(got)}`)
    // 但写全了就还是认得出来。
    const full = hits('改一下 src/index.ts', ['src/index.ts', 'lib/index.ts'])
    assert(full.length === 1 && full[0] === 'src/index.ts', JSON.stringify(full))
  })

  await test('没有扩展名的名字不认：一个叫「报告」的文件不该把每个「报告」都点亮', async () => {
    assert(hits('这份报告写完了', ['报告']).length === 0, '无扩展名的名字被认了')
  })

  await test('读过的文件只认 read 报的那些', async () => {
    const tools = [
      { name: 'read', refs: [{ path: '报告.html', name: '报告.html' }] },
      { name: 'ls', refs: [{ path: '别的.txt', name: '别的.txt' }] },
      { name: 'read', refs: [{ path: '报告.html', name: '报告.html' }] },
    ]
    const reads = ui.readFiles(tools)
    assert(reads.length === 1 && reads[0].path === '报告.html', JSON.stringify(reads))
  })

  await test('文件树把目录和文件画成两种行，文件点开走预览', async () => {
    ui.state.wsDirs = {
      '': {
        entries: [
          { name: 'uploads', path: 'uploads', dir: true, size: 0 },
          { name: '报告.md', path: '报告.md', dir: false, size: 2048 },
        ],
        more: 0,
      },
      uploads: { entries: [{ name: '单据.pdf', path: 'uploads/单据.pdf', dir: false, size: 100 }], more: 0 },
    }
    ui.state.wsOpen = { uploads: true }
    const html = ui.workspacePanel()
    assert(html.includes('data-act="ws-dir" data-path="uploads"'), '目录不是可展开的行')
    assert(html.includes('data-path="uploads/单据.pdf"'), '展开的那一层没画出来')
    assert(html.includes('data-act="chat-preview"'), '文件点开的不是预览')
    assert(html.includes('2.0 KB'), '没标大小')
  })

  await test('列不出来时说出来，不画成一棵空树', async () => {
    ui.state.wsDirs = { '': { entries: null, error: '实例还没接上' } }
    ui.state.wsOpen = {}
    assert(ui.workspacePanel().includes('实例还没接上'), '错误被吞掉了')
  })

  await test('截断说出来', async () => {
    ui.state.wsDirs = { '': { entries: [{ name: 'a.md', path: 'a.md', dir: false, size: 1 }], more: 7 } }
    ui.state.wsOpen = {}
    assert(/还有 7 条/.test(ui.workspacePanel()), '少列了几条却没说')
  })

  /**
   * 头一回点开那个文件夹，看到的必须是这台席位里真有的东西。
   *
   * 这两条钉的是同一件事的两头：**「没取到」不能长得像「里面没东西」**，而「这一趟没
   * 取成」也不能就此定格。原先两头都破：进页面那会儿席位还没接上，那一屏当场拿到一句
   * 「实例还没接上」并且**把它当成取过了**——十几秒后席位接上、对话都能发了，那一屏
   * 还停在原地，只有人自己去按那颗刷新才会出来。
   */
  const seatUi = ({ workspace, fail }) => {
    const calls = []
    const fetchImpl = async (path) => {
      calls.push(path)
      // fail：这台席位头 N 趟先摆一个状态码出来（热身中的 503、旧版本的 404）；
      // status 给 0 就是**根本没出门**——Gateway 在重启、网断了一秒，fetch 自己 reject。
      if (fail && path.includes('/workspace') && calls.length <= fail.times) {
        if (!fail.status) throw new TypeError('Failed to fetch')
        return new Response(JSON.stringify({ error: fail.error || '实例还没上线' }), {
          status: fail.status,
          headers: { 'content-type': 'application/json' },
        })
      }
      const body = path.includes('/workspace') ? workspace : {}
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    const app = loadApp({
      appPath: join(root, 'gateway/ui/app.js'),
      base: 'http://127.0.0.1:1',
      fetchImpl,
      stubIds: ['chat-thread'],
    })
    app.state.me = { account: { id: 'a1', role: 'member', email: 'a@b.c' } }
    app.state.path = '/chat'
    app.state.chatBotId = 'b1'
    app.state.chatEvents = []
    app.state.chatSessionId = ''
    return { app, calls }
  }

  /** 点开右栏那一屏（走真的点击分发），再让排在后面那一拍跑完。 */
  const openFiles = async (app) => {
    await app.fire('click', el('button', { 'data-act': 'aside-tab', 'data-tab': 'files' }))
    await new Promise((r) => setTimeout(r, 5))
  }

  await test('席位接上之后那一屏自己重取一遍，不用人去按刷新', async () => {
    const { app, calls } = seatUi({ workspace: { entries: [{ name: '报表', path: '报表', dir: true, size: 0 }], more: 0 } })
    app.render()
    await openFiles(app)
    assert(/实例还没接上/.test(app.workspacePanel()), '席位没接上却没说出来')
    assert(calls.length === 0, `会话都没有还发了请求：${JSON.stringify(calls)}`)
    // 席位接上了：走的是 hydrateChat / 流那条路，只 paintChat，不整页重绘。
    app.state.chatSessionId = 's1'
    app.paintChat()
    await new Promise((r) => setTimeout(r, 5))
    assert(calls.some((p) => p.includes('/workspace')), '接上之后没有自己去取')
    assert(/报表/.test(app.workspacePanel()), `那一屏还停在旧状态：${app.workspacePanel()}`)
  })

  await test('席位还在热身（5xx）：过一会儿自己再来一趟', async () => {
    const { app, calls } = seatUi({
      workspace: { entries: [{ name: '报表', path: '报表', dir: true, size: 0 }], more: 0 },
      fail: { status: 503, times: 1 },
    })
    app.state.chatSessionId = 's1'
    app.render()
    await openFiles(app)
    assert(/实例还没上线/.test(app.workspacePanel()), `没把席位那句话说出来：${app.workspacePanel()}`)
    // 到点了（十秒在测里等不起，直接把闹钟拨到现在）。
    app.state.wsDirs[''].retryAt = 1
    app.paintChat()
    await new Promise((r) => setTimeout(r, 5))
    assert(calls.filter((p) => p.includes('/workspace')).length === 2, `没有自己再来一趟：${JSON.stringify(calls)}`)
    assert(/报表/.test(app.workspacePanel()), `重来那一趟没画出来：${app.workspacePanel()}`)
  })

  await test('席位版本旧（404）：说清楚要更新，而且不再自己重试', async () => {
    const { app, calls } = seatUi({
      workspace: {},
      fail: { status: 404, times: 99, error: 'unknown endpoint' },
    })
    app.state.chatSessionId = 's1'
    app.render()
    await openFiles(app)
    assert(/更新 Bot 版本/.test(app.workspacePanel()), `没说清楚是版本旧了：${app.workspacePanel()}`)
    assert(!app.state.wsDirs[''].retryAt, '答案不会变的那种也排了重试')
    app.paintChat()
    await new Promise((r) => setTimeout(r, 5))
    assert(calls.filter((p) => p.includes('/workspace')).length === 1, `打了一台已经把话说清楚的席位：${JSON.stringify(calls)}`)
  })

  await test('压根没走到 Gateway（网断了）：说人话，而且照样排下一趟', async () => {
    const { app, calls } = seatUi({
      workspace: { entries: [{ name: '报表', path: '报表', dir: true, size: 0 }], more: 0 },
      fail: { status: 0, times: 1 },
    })
    app.state.chatSessionId = 's1'
    app.render()
    await openFiles(app)
    const html = app.workspacePanel()
    assert(!/Failed to fetch/.test(html), `把浏览器那句原话摆给人看了：${html}`)
    assert(/连不上服务器/.test(html), `没说清楚是连不上：${html}`)
    assert(app.state.wsDirs[''].retryAt, '最该重来的一种反而没排重试')
    app.state.wsDirs[''].retryAt = 1
    app.paintChat()
    await new Promise((r) => setTimeout(r, 5))
    assert(/报表/.test(app.workspacePanel()), `网回来了却没自己再取一遍：${app.workspacePanel()}`)
    assert(calls.filter((p) => p.includes('/workspace')).length === 2, JSON.stringify(calls))
  })

  await test('换人登录：上一个账号的文件名一个都不许留在树上', async () => {
    const { app } = seatUi({ workspace: { entries: [{ name: '裁员名单.xlsx', path: '裁员名单.xlsx', dir: false, size: 9 }], more: 0 } })
    app.state.chatSessionId = 's1'
    app.render()
    await openFiles(app)
    assert(/裁员名单/.test(app.workspacePanel()), '前置条件没成立：树没取到')
    await app.fire('click', el('button', { 'data-act': 'logout' }))
    assert(!/裁员名单/.test(app.workspacePanel()), `登出之后上一个人的文件名还在：${app.workspacePanel()}`)
    assert(!app.state.wsSession, 'wsSession 没跟着归零')
  })

  await test('席位回的不是一份目录：说列不出来，不能画成「工作区还是空的」', async () => {
    const { app } = seatUi({ workspace: {} })
    app.state.chatSessionId = 's1'
    app.render()
    await openFiles(app)
    const html = app.workspacePanel()
    assert(!/还是空的/.test(html), `没取到却说成了空工作区：${html}`)
    assert(/列不出来/.test(html), `没说出「没取到」：${html}`)
  })
}
