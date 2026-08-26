/**
 * terminal / process：前台、后台、以及**关机之后机器上还剩什么**。
 * 探针在 bot/e2e-process.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 这一组和别的不一样：它钉的东西在这台机器上留得下痕迹。一个没杀干净的后台进程会占着
 * 端口和内存活到下次重启，而所有别的信号都是绿的——所以每一条「杀掉了」都是拿
 * `kill(pid, 0)` 问操作系统问出来的，不是读我们自己那本账。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

function runProbe(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'bot/e2e-process.mjs')], {
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

const all = (obj) => Object.entries(obj).filter(([, v]) => v !== true).map(([k, v]) => `${k}=${JSON.stringify(v)}`)

export async function runProcess({ root, test, assert, log }) {
  log('\n# process')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.foreground && r.shutdown, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('前台：退出码是业务结果，超时按秒算', () => {
    assert(r.foreground.跑得通 === 'hi', `没跑通：${r.foreground.跑得通}`)
    // 退出码非零是模型要看到并自己决定下一步的东西，不是管道故障。
    assert(r.foreground.退出码非零不是管道故障, '非零退出码被当成了管道故障')
    // 单位从毫秒换成了秒。理解错一边，`timeout: 1` 要么是一毫秒要么是十六分钟。
    assert(r.foreground.超时按秒算, 'timeout 不是按秒算的')
    assert(r.foreground.workdir生效, 'workdir 没生效')
  })

  await test('输出超限：截断，但全文捞得回来', () => {
    // 工具描述里禁止模型自己 `| tail`（管道会把退出码盖掉），那句话只有配上这一条
    // 才站得住：得给它一条把全文捞回来的路。
    const bad = all(r.spill)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('后台：立刻返回，poll 只给新输出', () => {
    assert(!all(r.background).length, `起后台不对：${all(r.background).join('、')}`)
    // poll 再给一遍旧输出的话，模型会以为那一步又跑了一次。
    assert(!all(r.poll).length, `poll 不对：${all(r.poll).join('、')}`)
    assert(r.list, 'list 里没有刚起的那个')
    assert(r.prefix, '唯一前缀指不到进程——模型抄长 id 会抄错')
    // 别的会话看不见，也管不着。
    assert(/没有 proc_/.test(r.otherSession), `跨会话够得着别人的进程：${r.otherSession}`)
  })

  await test('wait 停得下来，而进程照旧在跑', () => {
    assert(!all(r.waitTimeout).length, `wait 超时不对：${all(r.waitTimeout).join('、')}`)
    // 停止按钮掐的是这一轮。后台进程存在的意义就是活过这次调用——要停得调 kill。
    assert(!all(r.abortStopsWaitNotProcess).length, `中止语义不对：${all(r.abortStopsWaitNotProcess).join('、')}`)
  })

  await test('kill 杀的是整族，不只是那个 shell', () => {
    assert(r.killTree.杀之前fork出去的活着, '探针没能确认子进程起来了，后面那条断言不作数')
    // 只杀 bash 的话，`sleep 60 &` 这类 fork 出去的会留下来，端口和 CPU 一起占着。
    assert(r.killTree.杀之后整族都没了, 'fork 出去的进程活下来了')
    assert(r.killTree.状态变了, 'kill 之后状态没更新')
    assert(r.killed, 'kill 没报成功')
  })

  await test('并发上限按会话算，拒绝时把清单摆出来', () => {
    const bad = all(r.cap)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('notify_on_complete：进程结束自己来一条，落成 user/message', () => {
    // 不变量 7：进入模型的那句话必须在 JSONL 里，重放才对得上。source 写 process，
    // 否则日志里那句话看起来像用户自己说的。
    // 「自己杀的不通知」也在这一组：kill 是模型刚发起的调用，结果它已经拿到了；照样
    // 通知的话，那一轮要是收了口，send 会为此单独开一轮——用户看到一条没来由的消息，
    // 账上还多一次模型调用。
    const bad = all(r.notify)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('中文输出不出现替换字符', () => {
    // 一个汉字三个字节，chunk 边界切在字符中间时两半各自解码就是两个 �。前台那次最多
    // 是屏幕上花一下，后台那份还会落进 proc/<id>.log，原字节再也捞不回来。
    const bad = all(r.utf8)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('callId 洗过再拼路径', () => {
    // callId 是 provider 给的，一路透传到落盘那一步。上传文件名和 sessionId 早就走
    // safeName / safeSegment 了，这条新路不该是例外。
    const bad = all(r.callId)
    assert(!bad.length, `这几条不对：${bad.join('、')}`)
  })

  await test('开机扫掉没主人的后台日志', () => {
    // 删日志靠的是退出后那个三十分钟的定时器，而定时器活在内存里——换一次版、崩一次，
    // 日志就留在盘上再也没有主人。
    assert(r.sweep.过期的删了, '过期的日志没被扫掉，proc/ 会只增不减')
    assert(r.sweep.新的留着, '把还有用的日志一起删了')
  })

  await test('SIGTERM：进程自己退出，而且一个孤儿都不剩', () => {
    // 两件事都要成立。**给 SIGTERM 装监听器就摘掉了 Node 的默认退出**——只杀后台进程
    // 不重发信号的话，进程会一直活到 systemd 那九十秒的硬杀，每次换版白等一分半。
    // 这一条只有拿真信号打一个真进程才测得出来，`process.emit` 是测不出来的。
    assert(r.shutdown.信号之前活着, '探针没能确认子进程起来了，后面两条断言不作数')
    assert(r.shutdown.进程自己退出了, '收到 SIGTERM 之后进程没退出——换一次版要白等 systemd 的停机超时')
    assert(r.shutdown.孤儿也没了, 'SIGTERM 之后后台进程还活着——换一次版就漏一批孤儿')
  })
}
