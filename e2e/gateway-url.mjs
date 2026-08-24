/**
 * 席位从入站请求上学「Gateway 现在在哪」。探针在 bot/e2e-gateway-url.mjs（纯函数，要 tsx）。
 *
 * 这条路要解的死结：席位的 GATEWAY_URL 是部署那一刻写死进 bot.env 的，Gateway 换了对外
 * 地址（家里 DHCP 换个租约就够）之后，这台席位彻底哑掉——模型调用、目录拉取、会话上报
 * 全是 fetch failed，而它自己无从知道新地址，因为唯一能告诉它的通道正是它打不出去的
 * 那一条。反过来走：Gateway 每次打进来时顺便报一下自己在哪。
 *
 * 错了都不当场报错，所以这里逐条钉住。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

function runProbe(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'bot/e2e-gateway-url.mjs')], {
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

export async function runGatewayUrl({ root, test, assert, log }) {
  log('\n# gateway-url')
  const r = await runProbe(root)

  await test('学到新地址：改写 bot.env，其余各行一个字不动', () => {
    assert(r.rewrite.lineChanged, 'GATEWAY_URL 那一行没换成新地址')
    assert(r.rewrite.oldGone, '旧地址还留在文件里')
    assert(r.rewrite.memory === 'http://192.168.5.40:3080', `内存里还是 ${r.rewrite.memory}`)
    // 这两条挂了 = 席位重启即变砖：没有票和 key，它连 Gateway 的门都进不去，
    // 而那比「地址过期」严重得多——地址过期至少还能靠重新部署救回来。
    assert(r.rewrite.keptToken, 'GATEWAY_TOKEN 被写没了')
    assert(r.rewrite.keptApiKey, 'GATEWAY_API_KEY 被写没了')
    assert(r.rewrite.keptRest, '别的环境变量被写没了')
    assert(r.rewrite.lines === 6, `行数变了：${r.rewrite.lines}，应该还是 6`)
    // 文件里有票和 key，而席位那个 Linux 用户在 noVNC 桌面里能开终端。
    assert(r.rewrite.mode === '600', `权限被放宽成了 ${r.rewrite.mode}`)
    assert(r.rewrite.noTmp, '临时文件留下了——它和 bot.env 同内容，权限却没人管')
  })

  await test('地址没变就不写盘', () => {
    assert(r.same.untouched, '地址一样却还是写了一次盘')
    assert(r.same.memory === 'http://192.168.5.59:3080', '把内存改坏了')
  })

  await test('写不进去时绝不改内存', () => {
    // 这条是整件事最容易做错的一处：先改内存再落盘的话，一次写失败会留下
    // 「这次好了、重启又回去」的间歇故障——而且**再也不会重试**，因为下一次调用
    // 会因为「和内存里的一样」提前返回。
    assert(r.unwritable.memory === 'http://192.168.5.59:3080', '盘没写成，内存却改了')
    assert(r.unwritable.said, '写失败了一声不吭')
  })

  await test('本地开发没有 bot.env：内存也不动', () => {
    assert(r.noFile.memory === 'http://192.168.5.59:3080', '没地方落盘却改了内存')
    assert(r.noFile.said, '没说为什么不改')
  })

  await test('形状不对的一律不认', () => {
    // 带路径、带查询、带用户名口令、非 http(s) —— 都不是一个裸 origin。
    assert(r.junk.allRejected, `${r.junk.n} 种垃圾输入里有被接受的`)
  })

  await test('bot.env 里没有那一行时补一行，不把文件改没', () => {
    assert(r.missingLine.added, '没补上 GATEWAY_URL')
    assert(r.missingLine.keptToken, '补的时候把原有内容冲掉了')
  })
}
