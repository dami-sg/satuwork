#!/usr/bin/env node
/**
 * 验一件事：**这条反代会不会把 SSE 攒住。**
 *
 * 为什么值得单独有个工具：攒住这件事**不报错**。反代照常 200，连接照常开着，浏览器
 * 那头只是「有几条事件一直没来」——而其中一条恰好是 `replay/done`（席位用它说「历史
 * 放完了、这条会话此刻在不在跑」）。少了它，界面缺一截历史、还永远挂着「正在处理」，
 * 而且哪条会话中招取决于字节数落在缓冲边界的哪一侧，所以刷一次换一个，看着像见了鬼。
 * 上线之后再撞见，从症状是查不回反代配置的。
 *
 * 复现的形状就是真实的那个：**先灌一批帧，然后彻底安静下来**。攒住的反代会把最后那
 * 几条连同结尾标记一起扣在缓冲里，而一条安静下来的会话再也不会有新字节把它顶出去。
 * （席位每 15 秒发的 `: ping` 是兜底，不是解法——所以这个工具故意不发心跳。）
 *
 * 用法：两个终端。
 *
 *   1) 起一个假席位（只发 SSE，不需要 Gateway、数据库、席位机器）：
 *        node gateway/deploy/check-sse.mjs origin
 *
 *   2) 让反代把某个路径转到 http://127.0.0.1:9099，然后从反代那一头验：
 *        node gateway/deploy/check-sse.mjs check http://127.0.0.1:8080/sse
 *
 *   直连自己先跑一遍当对照（必过）：
 *        node gateway/deploy/check-sse.mjs check http://127.0.0.1:9099/sse
 *
 * 加 --idle 再多验一条：长连接会不会被反代的空闲超时掐掉（nginx 默认 60 秒，
 * 而 SSE 安静几分钟是常态）。这一项要等 65 秒。
 *
 * **本地不用有证书。** 攒不攒和 TLS 无关，纯 HTTP 就验得出来；h2 那一半（连接数上限）
 * 才需要证书，上线时自然就有了。
 */
import { createServer } from 'node:http'
import http from 'node:http'
import https from 'node:https'

const ORIGIN_PORT = 9099
/** 灌多少帧。**故意不大**：小于反代一组缓冲的量才是最坏情况——攒住之后再也没有东西把它顶出去。 */
const BURST = 50
/** 结尾标记要在这么久之内到，否则就是被攒住了。直连是毫秒级的。 */
const TAIL_BUDGET_MS = 2000
/** 等到这个点还没来就判死。 */
const GIVE_UP_MS = 8000

function runOrigin(port) {
  createServer((req, res) => {
    if (!req.url.startsWith('/sse')) {
      res.writeHead(404).end('用 /sse')
      return
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    })
    // 一批帧，最后一条是结尾标记——它就是真实链路里的 `replay/done`。
    for (let i = 1; i <= BURST; i++) {
      res.write(`data: ${JSON.stringify({ type: 'filler', seq: i, pad: 'x'.repeat(120) })}\n\n`)
    }
    res.write(`data: ${JSON.stringify({ type: 'tail', seq: BURST + 1 })}\n\n`)
    // **然后彻底闭嘴。** 不发心跳、不断开——这正是一条安静下来的会话的样子。
    console.log(`[origin] 灌了 ${BURST} 帧 + 结尾标记，之后保持安静`)
  }).listen(port, '127.0.0.1', () => {
    console.log(`[origin] 听在 http://127.0.0.1:${port}/sse`)
    console.log('[origin] 把反代的某个路径转到这里，然后在另一个终端跑 check')
  })
}

function runCheck(url, idle) {
  const u = new URL(url)
  const lib = u.protocol === 'https:' ? https : http
  const t0 = Date.now()
  let tail = 0
  let frames = 0
  let firstByte = 0
  let buf = ''

  const req = lib.get(
    url,
    {
      headers: {
        accept: 'text/event-stream',
        // 故意允许压缩：反代要是对 text/event-stream 也开了 gzip，压缩缓冲一样会攒住帧。
        'accept-encoding': 'gzip, deflate',
      },
    },
    (res) => {
      console.log(`\n连上了：HTTP ${res.statusCode}`)
      const enc = res.headers['content-encoding']
      const type = res.headers['content-type'] || ''
      if (!type.includes('text/event-stream')) {
        console.log(`  content-type 是 ${JSON.stringify(type)}——这不是一条 SSE，路径转错了？`)
      }
      if (enc) {
        fail(`反代在压缩 SSE（content-encoding: ${enc}）`, [
          'nginx：在这个 location 里加 `gzip off;`',
          'Caddy：把 `encode` 这一段对 text/event-stream 关掉',
          '压缩缓冲和代理缓冲一样会把帧攒住，而且更难看出来。',
        ])
        req.destroy()
        return
      }

      res.on('data', (chunk) => {
        if (!firstByte) {
          firstByte = Date.now() - t0
          console.log(`  第一个字节：+${firstByte}ms`)
        }
        buf += chunk.toString()
        let idx
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 2)
          if (!line.startsWith('data: ')) continue
          frames++
          let ev
          try {
            ev = JSON.parse(line.slice(6))
          } catch {
            continue
          }
          if (ev.type === 'tail') {
            tail = Date.now() - t0
            done(res, req, { tail, frames, idle })
          }
        }
      })
      res.on('end', () => {
        if (!tail) fail('流被对面结束了，结尾标记始终没到', ['上游连接被反代提前关掉了？'])
      })
    },
  )

  req.on('error', (e) => fail(`连不上：${e.message}`, ['origin 起了吗？反代的路径转对了吗？']))

  setTimeout(() => {
    if (tail) return
    fail(`${GIVE_UP_MS}ms 过去了，结尾标记还没到（已收到 ${frames}/${BURST + 1} 帧）`, [
      'nginx：这个 location 里要有 `proxy_buffering off;` 和 `gzip off;`',
      'Caddy：reverse_proxy 里要有 `flush_interval -1`',
      '现在这个样子上线，症状是「历史缺一截 + 永远挂着正在处理」，而且刷一次换一个。',
      '完整配置见同目录的 nginx.conf.example / Caddyfile.example。',
    ])
    req.destroy()
  }, GIVE_UP_MS).unref?.()
}

function done(res, req, { tail, frames, idle }) {
  console.log(`  收齐 ${frames} 帧，结尾标记：+${tail}ms`)
  if (tail > TAIL_BUDGET_MS) {
    return fail(`结尾标记晚了 ${tail}ms（预算 ${TAIL_BUDGET_MS}ms）`, [
      '不是完全攒死，但中间有一层在攒。按 nginx.conf.example 逐条对一遍。',
    ])
  }
  console.log(`\n✅ 不攒：结尾标记 +${tail}ms 就到了。`)
  if (!idle) {
    console.log('   （想连空闲超时一起验，加 --idle，要多等 65 秒）')
    req.destroy()
    return process.exit(0)
  }
  console.log('\n再验空闲超时：安静地挂 65 秒，看这条连接会不会被掐（nginx 默认 60 秒就掐）。')
  let killed = false
  res.on('end', () => (killed = true))
  res.on('close', () => (killed = true))
  setTimeout(() => {
    if (killed) {
      return fail('安静 65 秒之后连接被掐了', [
        'nginx：`proxy_read_timeout 1h;` 和 `proxy_send_timeout 1h;`',
        'Caddy：transport http 里 `read_timeout 0` / `write_timeout 0`',
        'SSE 安静几分钟是常态（没人说话的时候就该没有字节）。被掐的表现是每分钟重连一次。',
      ])
    }
    console.log('✅ 空闲 65 秒没被掐。')
    req.destroy()
    process.exit(0)
  }, 65_000)
}

function fail(why, hints) {
  console.log(`\n❌ ${why}`)
  for (const h of hints) console.log(`   · ${h}`)
  process.exit(1)
}

const [mode, arg] = process.argv.slice(2)
if (mode === 'origin') runOrigin(Number(arg) || ORIGIN_PORT)
else if (mode === 'check' && arg) runCheck(arg, process.argv.includes('--idle'))
else {
  console.log('用法：')
  console.log('  node gateway/deploy/check-sse.mjs origin [port]')
  console.log('  node gateway/deploy/check-sse.mjs check <url> [--idle]')
  process.exit(2)
}
