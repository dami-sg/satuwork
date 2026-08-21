/**
 * SSRF 闸。探针要 tsx 才 import 得了 .ts。
 *
 * 这一关是**安全边界**：模型给一个地址、我们照着打，这本身就是 SSRF 的定义。
 * Gateway 手里有库和平台凭证，席位机器上还跑着管家（:8443）和别人的席位——
 * 漏一个网段，内网里任何一个没鉴权的服务都在射程内。
 *
 * 逐跳重查那一条单独钉：只查第一跳等于没查，攻击者给一个公网地址、让它 302 到
 * 127.0.0.1 就绕过去了。
 */
import { createServer } from 'node:http'
import { guardUrl, isPrivateIp, readCapped, reserveDdgSlot, safeFetch, stripCredentials } from './src/web-tools.ts'

const out = {}

const rejects = async (url) => {
  try {
    await guardUrl(url)
    return false
  } catch {
    return true
  }
}

// ── 1. 协议 ───────────────────────────────────────────────────────────
out.scheme = {
  file: await rejects('file:///etc/passwd'),
  gopher: await rejects('gopher://x.test/1'),
  不是地址: await rejects('随便一句话'),
  https可以: !(await rejects('https://example.com/')),
}

// ── 2. 网段 ───────────────────────────────────────────────────────────
out.private = {
  回环: await rejects('http://127.0.0.1:8443/'),
  回环别名: await rejects('http://127.127.127.127/'),
  十网段: await rejects('http://10.0.0.9/'),
  '172.16': await rejects('http://172.20.1.1/'),
  '192.168': await rejects('http://192.168.1.1/'),
  链路本地: await rejects('http://169.254.169.254/latest/meta-data/'),
  零地址: await rejects('http://0.0.0.0/'),
  ipv6回环: await rejects('http://[::1]/'),
  ipv6唯一本地: await rejects('http://[fd00::1]/'),
  // ::ffff:10.0.0.1 是 IPv4 映射地址，按它映射的那个 v4 判，不然是条现成的绕道。
  ipv4映射: isPrivateIp('::ffff:10.0.0.1'),
  管家端口: await rejects('http://localhost:8443/'),
}

out.publicOk = {
  一号公网: !isPrivateIp('1.1.1.1'),
  普通公网: !isPrivateIp('93.184.216.34'),
  判不了的当私网: isPrivateIp('不是 IP'),
}

// ── 3. 跳转要逐跳重查 ─────────────────────────────────────────────────
const server = createServer((req, res) => {
  if (req.url === '/to-loopback') {
    // 公网地址（这里用本机模拟）302 到内网。只查第一跳的实现会放行。
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' })
    return res.end()
  }
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('ok')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const host = `127.0.0.1:${port}`

// 这台测试服务器自己就在回环上，所以拿 allowHost 放行它——这正是自托管 SearXNG
// 那条「管理员明示的例外」走的同一条路。跳转的下一跳不在例外里，必须被拦。
out.redirect = {
  例外地址放行: (await safeFetch(`http://${host}/ok`, { allowHost: host, timeoutMs: 3000 }).then((r) => r.status)) === 200,
  跳内网被拦: await safeFetch(`http://${host}/to-loopback`, { allowHost: host, timeoutMs: 3000 })
    .then(() => false)
    .catch(() => true),
}

// ── 4. 跨主机跳转要摘掉凭据 ───────────────────────────────────────────
//
// 自己实现的跳转不摘凭据 = 上游哪天 302 到别的域名，我们就带着平台的密钥把同一个
// POST 重发过去。浏览器和 undici 的自动跳转都会摘，这里也必须摘。
//
// 跨主机那一跳没法在这里走完整条网络：两台测试服务器都在回环上，第二跳会先被
// SSRF 闸拦下（这本身是对的）。所以拆成两半——**同源那一跳**走真实网络，证明该带的
// 时候确实带着；**摘除本身**直接对函数断言。
const seen = []
const hopper = createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization || '', method: req.method })
  if (req.url === '/same-host') {
    // 同一个 origin 的跳转不该摘——那是同一家上游自己的路由。
    res.writeHead(302, { location: '/landing' })
    return res.end()
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{}')
})
await new Promise((r) => hopper.listen(0, '127.0.0.1', r))
const hopHost = `127.0.0.1:${hopper.address().port}`

await safeFetch(`http://${hopHost}/same-host`, {
  allowHost: hopHost,
  method: 'POST',
  headers: { authorization: 'Bearer SECRET-KEY', 'content-type': 'application/json' },
  body: '{}',
  timeoutMs: 3000,
})
const landed = seen.find((x) => x.url === '/landing')

const stripped = stripCredentials({
  authorization: 'Bearer SECRET-KEY',
  'x-api-key': 'SECRET-KEY',
  cookie: 'sid=1',
  'proxy-authorization': 'Basic x',
  'content-type': 'application/json',
  'user-agent': 'satuwork',
})

out.redirectCreds = {
  同源跳转真的跟了: !!landed,
  同源跳转带着凭据: landed?.auth === 'Bearer SECRET-KEY',
  摘掉authorization: !('authorization' in stripped),
  摘掉xapikey: !('x-api-key' in stripped),
  摘掉cookie: !('cookie' in stripped),
  摘掉代理凭据: !('proxy-authorization' in stripped),
  别的头留着: stripped['content-type'] === 'application/json' && stripped['user-agent'] === 'satuwork',
}

// ── 5. 文档大小闸：边读边数，不能先收完再量 ─────────────────────────
//
// content-length 可以撒谎，也可以根本不给（chunked）。先整份读进内存再判超限，
// 等于让任何一个地址拿 Gateway 的内存换一次拒绝——而 Gateway 是所有公司共用的
// 那一个进程。这里直接对 readCapped 下断言：要验的是读取本身，不是那道闸
//（闸会先把回环地址拒掉，测试服务器正好在回环上）。
// 服务器准备吐的量要**远大于**上限：这样「在哪一刻掐断」才有区分度。
const BIG = 30 * 1024 * 1024
const CHUNK = 1024 * 1024
const CAP = 10 * 1024 * 1024
const docs = createServer((req, res) => {
  if (req.url === '/small') {
    res.writeHead(200, { 'content-type': 'application/pdf' })
    return res.end(Buffer.from('%PDF-1.4 tiny'))
  }
  // 不给 content-length：chunked 流式吐 30 MB。声明那道闸对它无效。
  res.writeHead(200, { 'content-type': 'application/pdf' })
  const chunk = Buffer.alloc(CHUNK, 0x41)
  let sent = 0
  const pump = () => {
    while (sent < BIG) {
      sent += chunk.length
      if (!res.write(chunk)) return res.once('drain', pump)
    }
    res.end()
  }
  pump()
})
await new Promise((r) => docs.listen(0, '127.0.0.1', r))
const docBase = `http://127.0.0.1:${docs.address().port}`

/**
 * 报错里带着**掐断时已经读了多少字节**。钉它，而不是钉进程的 RSS——
 * RSS 受 GC 时机影响，同一份代码时红时绿，那种断言守不住任何东西。
 */
const trippedAt = await fetch(`${docBase}/huge`)
  .then((r) => readCapped(r, CAP))
  .then(() => -1)
  .catch((e) => Number(/doc too large (\d+)/.exec(e.message)?.[1] ?? -1))

out.docLimit = {
  超限当场掐断: trippedAt > CAP,
  // 停在越过上限的**那一块**，不是收完 30 MB 再回头量：容差给一块的大小。
  没把整份读进来: trippedAt > 0 && trippedAt <= CAP + CHUNK,
  小文档照读: await fetch(`${docBase}/small`)
    .then((r) => readCapped(r, CAP))
    .then((b) => b.length > 0)
    .catch(() => false),
}
docs.close()

// ── 6. DuckDuckGo 的节流要真的排队 ────────────────────────────────────
//
// 记「上一次发车时刻」是挡不住并发的：同时进来的请求读到同一个旧时间戳，算出同样的
// 等待，睡完在同一刻一起打出去。要记的是「下一次允许发车的时刻」。
const t = 1_000_000
out.ddgThrottle = {
  第一个不等: reserveDdgSlot(t) === 0,
  第二个等一秒: reserveDdgSlot(t) === 1000,
  第三个等两秒: reserveDdgSlot(t) === 2000,
  // 闲了很久之后不该还欠着队
  闲下来立刻放行: reserveDdgSlot(t + 60_000) === 0,
}

// ── 7. Firecrawl：自托管地址要过得去，200 里的 success:false 要认出来 ─
//
// 这两条在假后端下走不到，必须用真实现打一台本地服务器。自托管的官方示例就是
// localhost:3002——不给闸留例外的话，这个后端配了也用不了。
const fcSeen = []
const fc = createServer(async (req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  await new Promise((r) => req.on('end', r))
  fcSeen.push({ url: req.url, auth: req.headers.authorization || '' })
  res.writeHead(200, { 'content-type': 'application/json' })
  if (req.url === '/v2/search' && raw.includes('额度用尽')) {
    // Firecrawl 用 200 + success:false 报这类错。当成「没结果」的话，模型会一遍遍
    // 换搜索词重试，而换到天亮也没用。
    return res.end(JSON.stringify({ success: false, error: 'Insufficient credits' }))
  }
  if (req.url === '/v2/search') {
    return res.end(JSON.stringify({ success: true, data: { web: [{ title: '自托管命中', url: 'https://ok.test/1', description: '来自本地实例' }] } }))
  }
  return res.end(JSON.stringify({ success: true, data: { markdown: '# 自托管正文', metadata: { title: '自托管页' } } }))
})
await new Promise((r) => fc.listen(0, '127.0.0.1', r))
process.env.FIRECRAWL_API_URL = `http://127.0.0.1:${fc.address().port}`

// backendOf 要在 env 设好之后再取——firecrawlBase() 是每次调用现读的，所以这样就行。
const { backendOf: liveBackendOf } = await import('./src/web-tools.ts')
const fcBackend = liveBackendOf('firecrawl')
const q = { query: '自托管', count: 3, domains: [], exclude: [], freshness: '' }
const cfg = { secret: 'fc-test' }

const hits = await fcBackend.search(q, cfg).catch((e) => ({ err: e.hint || e.message }))
const page = await fcBackend.extract('https://ok.test/1', cfg).catch((e) => ({ err: e.hint || e.message }))
const denied = await fcBackend
  .search({ ...q, query: '额度用尽' }, cfg)
  .then(() => '')
  .catch((e) => e.hint || e.message)

out.firecrawl = {
  自托管搜索通了: Array.isArray(hits) && hits[0]?.url === 'https://ok.test/1',
  自托管提取通了: page?.markdown === '# 自托管正文',
  带上了密钥: fcSeen.every((x) => x.auth === 'Bearer fc-test'),
  // success:false 必须变成一句「它拒绝了」，不能落成空结果。
  拒绝被认出来: /拒绝了这次请求/.test(denied),
  错误原文带上了: /Insufficient credits/.test(denied),
}
fc.close()
delete process.env.FIRECRAWL_API_URL

hopper.close()
server.close()
console.log('__RESULT__' + JSON.stringify(out))
