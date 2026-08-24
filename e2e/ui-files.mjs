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
import { loadApp } from './ui-dom.mjs'

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
}
