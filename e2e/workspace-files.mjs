/**
 * 工作区的边界语义。探针在 bot/e2e-workspace.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 这一层钉的几乎全是**安全边界**。它们和别的回归不一样：写松了不会有人报 bug，
 * 功能照跑，要等到有人专门去试才发作。所以每一条都单独钉死，包括那些看起来
 * 「显然不会错」的。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

function runProbe(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'bot/e2e-workspace.mjs')], {
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
      try {
        resolve(JSON.parse(line.slice('__RESULT__'.length)))
      } catch (e) {
        reject(new Error(`探针输出解析失败：${e.message}\n${line}`))
      }
    })
  })
}

export async function runWorkspaceFiles({ root, test, assert, log }) {
  log('\n# workspace-files')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.escape && r.upload, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('路径逃不出工作区', () => {
    assert(r.escape.上跳, '`../../../etc/passwd` 没被拦住')
    assert(r.escape.绕一圈上跳, '先下去再上来能绕过检查')
    assert(r.escape.绝对路径, '绝对路径没被拦住')
    // `/work` 与 `/workx`：只比字符串前缀会把兄弟目录当成子目录放行。
    assert(r.escape.同前缀兄弟目录, '同前缀的兄弟目录被当成了工作区内部')
    assert(r.escape.根自己可以 && r.escape.正常路径可以, '正常路径被误伤')
  })

  await test('上传的文件名变不成路径', () => {
    assert(r.names.上跳变普通名 === 'evil.sh', `../../evil.sh → ${r.names.上跳变普通名}`)
    // Windows 的分隔符也算分隔符——浏览器传上来的名字是外部输入，不挑平台。
    assert(r.names.反斜杠也算分隔符 === 'evil.sh', `..\\..\\evil.sh → ${r.names.反斜杠也算分隔符}`)
    assert(r.names.纯点号不留 === 'file', `... → ${r.names.纯点号不留}`)
    assert(r.names.空名有兜底 === 'file', '空文件名没有兜底')
    // 换行能把 Content-Disposition 那一行撑破。
    assert(r.names.控制字符剔掉 === 'abc.txt', `控制字符没剔干净：${r.names.控制字符剔掉}`)
    assert(r.names.中文原样留着 === '二季度报表.xlsx', '中文名被洗坏了')
    assert(r.names.超长截断 === 200, `超长名没截断：${r.names.超长截断}`)
  })

  await test('只有白名单里的类型允许内联', () => {
    assert(r.inline.png && r.inline.pdf, '图片和 PDF 应该能直接看')
    assert(r.inline.大写后缀也认, '大写后缀没认出来，会被当成未知格式')
    // 这两个能带 <script>。内联它们，等于让上传者在 Gateway 的源上执行代码。
    assert(!r.inline.svg, 'SVG 被允许内联了——这是 XSS')
    assert(!r.inline.html, 'HTML 被允许内联了——这是 XSS')
    assert(!r.inline.未知格式, '未知格式默认应该是下载')
    assert(r.inline.未知格式的类型 === 'application/octet-stream', '未知格式的 MIME 不对')
    assert(r.inline.markdown按纯文本发.startsWith('text/plain'), 'markdown 该按纯文本发，浏览器才不会去下载它')
  })

  await test('上传落进 uploads，字节一个不差', () => {
    assert(r.upload.路径在uploads下 === 'uploads/sess-1/hello.txt', `落点不对：${r.upload.路径在uploads下}`)
    assert(r.upload.内容 === 'hello world', `内容对不上：${r.upload.内容}`)
    assert(r.upload.大小 === 11, `大小对不上：${r.upload.大小}`)
  })

  await test('同名不覆盖', () => {
    // 传两次同名文件是常事，覆盖掉就是数据丢失，而且是静悄悄的那种。
    assert(r.collision.换了名字, '第二份把第一份盖掉了')
    assert(r.collision.头一份还在 === 'hello world', `头一份被改了：${r.collision.头一份还在}`)
    assert(r.collision.新路径 === 'uploads/sess-1/hello-1.txt', `换的名字不对：${r.collision.新路径}`)
  })

  await test('恶意文件名和恶意 sessionId 都出不去', () => {
    assert(r.evilName.没跑出uploads, `文件名把落点带出去了：${r.evilName.落点}`)
    assert(r.evilName.外面没被写, '真的写到 /etc/cron.d 去了')
    assert(r.evilSession.没跑出uploads, `sessionId 把落点带出去了：${r.evilSession.落点}`)
    // 清洗完不该在磁盘上留下一串点当目录名——跑不出去，但会让人以为出了别的事。
    assert(!/\/\.+\//.test('/' + r.evilSession.落点), `落点里留下了点目录：${r.evilSession.落点}`)
  })

  await test('超过上限就地中断，不留半个文件', () => {
    // 先收完再看大小，等于让任何人都能拿磁盘换一次拒绝。
    assert(r.tooBig.报错, '超限没报错')
    assert(r.tooBig.没留残骸, '超限之后留下了半个文件')
  })

  await test('预览读得回原始字节，且一样逃不出去', () => {
    assert(r.open.类型 === 'image/png', `类型不对：${r.open.类型}`)
    assert(r.open.字节读得回来 === '89504e47', `字节对不上：${r.open.字节读得回来}`)
    assert(r.openEscape, '预览能读工作区外面的文件')
  })
}
