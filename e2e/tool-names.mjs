/**
 * `bot/src/catalog/mcp.ts` 的 `mcpToolName` 单元测试。
 *
 * 这个函数把「服务器名 + 远端工具名」压成一个 ≤64 字的工具名，而**撞名的那个会被静默
 * 丢掉**——表现是「某个工具时有时无」，最难查的一类。所以这里只验一件事：**什么样的
 * 输入都不许撞**，以及没被截断的名字一个字节都不许变（那是绝大多数工具）。
 *
 * 撞名有三种来源，各有一条用例：
 *   1. 同一个连接器的两个账号     —— 区分它们的是名字**末尾**那一段，从头截会挤掉
 *   2. 两个连接器、同一个账号名   —— 保住尾巴也没用，头部一样
 *   3. 同一台服务器的两个长工具名 —— 尾巴在总长那一刀上被切掉
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

function names(root, pairs) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'bot/e2e-tool-names.mjs'), JSON.stringify(pairs)], {
      cwd: join(root, 'bot'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      const line = out.split('\n').find((l) => l.startsWith('__RESULT__'))
      if (code !== 0 || !line) return reject(new Error(`探针退出 ${code}\n${err || out}`))
      resolve(JSON.parse(line.slice('__RESULT__'.length)))
    })
  })
}

export async function runToolNames({ root, test, assert, log }) {
  log('\n# tool-names')

  await test('没被截断的名字一个字节都不变', async () => {
    // 现在上架的连接器名都短，绝大多数工具走的是这条路。它变了就是所有人的工具名都变了：
    // 提示缓存整个作废，会话历史里那些旧名字模型再调就是「没有这个工具」。
    const got = await names(root, [
      ['GitHub (default)', 'SW_SEARCH'],
      ['GitHub (default)', 'SW_DESCRIBE'],
      ['GitHub (default)', 'SW_RUN'],
      ['Gmail (default)', 'SEND_EMAIL'],
      ['Gmail (personal)', 'SEND_EMAIL'],
      ['Notion (company)', 'FETCH_MESSAGE_BY_THREAD_ID'],
    ])
    const want = [
      'mcp_github_default_sw_search',
      'mcp_github_default_sw_describe',
      'mcp_github_default_sw_run',
      'mcp_gmail_default_send_email',
      'mcp_gmail_personal_send_email',
      'mcp_notion_company_fetch_message_by_thread_id',
    ]
    assert(JSON.stringify(got) === JSON.stringify(want), `名字变了：\n实际 ${JSON.stringify(got, null, 1)}\n期望 ${JSON.stringify(want, null, 1)}`)
  })

  await test('三种撞名来源，一种都不许撞', async () => {
    const pairs = [
      // 1. 同一个连接器的两个账号：连接器名长到把账号名挤出预算
      ['Microsoft Teams (default)', 'SEND_MESSAGE'],
      ['Microsoft Teams (personal)', 'SEND_MESSAGE'],
      // 2. 两个连接器、同一个账号名：保住尾巴也没用，头部一模一样
      ['Microsoft Todo (default)', 'SEND_MESSAGE'],
      // 3. 同一台服务器的两个长工具名：尾巴在 64 那一刀上被切掉
      ['GitHub (default)', 'LIST_REPOSITORY_ISSUES_ASSIGNED_TO_AUTHENTICATED_USER'],
      ['GitHub (default)', 'LIST_REPOSITORY_ISSUES_ASSIGNED_TO_A_SPECIFIC_MILESTONE'],
      // 三个元工具在长名字下也不许互相撞
      ['Google Workspace (default)', 'SW_SEARCH'],
      ['Google Workspace (default)', 'SW_DESCRIBE'],
      ['Google Workspace (personal)', 'SW_SEARCH'],
    ]
    const got = await names(root, pairs)
    const seen = new Map()
    for (let i = 0; i < got.length; i++) {
      const dup = seen.get(got[i])
      assert(!dup, `${pairs[i].join(' / ')} 和 ${dup} 合成了同一个名字 ${got[i]}`)
      seen.set(got[i], pairs[i].join(' / '))
      assert(got[i].length <= 64, `超过 64 字：${got[i]}（${got[i].length}）`)
      assert(/^[a-z0-9_]+$/.test(got[i]), `名字里有怪字符：${got[i]}`)
    }
  })

  await test('长名字也要还看得出是哪个账号', async () => {
    // 撞名可以靠哈希堵死，但那样模型就分不清两把 Gmail 了——「工具名天然带账号」是
    // 连接器一把连接一条路径的全部理由（connectors.md §7）。账号名必须留在名字里。
    const [a, b] = await names(root, [
      ['Microsoft Teams (default)', 'SEND_MESSAGE'],
      ['Microsoft Teams (personal)', 'SEND_MESSAGE'],
    ])
    assert(a.includes('default'), `看不出是哪个账号：${a}`)
    assert(b.includes('personal'), `看不出是哪个账号：${b}`)
  })

  await test('确定性：同样的输入每次同样的名字', async () => {
    // 靠注册顺序去重（加个 -2 后缀）就会在这里失败：重启一次名字就换一个，工具表每轮
    // 都在变，提示缓存前缀跟着废，会话历史里的旧名字也调不动了。
    const pairs = [
      ['Microsoft Teams (personal)', 'SEND_MESSAGE'],
      ['GitHub (default)', 'LIST_REPOSITORY_ISSUES_ASSIGNED_TO_AUTHENTICATED_USER'],
    ]
    const once = await names(root, pairs)
    const twice = await names(root, pairs)
    assert(JSON.stringify(once) === JSON.stringify(twice), `两次跑出了不同的名字：${JSON.stringify(once)} / ${JSON.stringify(twice)}`)
  })
}
