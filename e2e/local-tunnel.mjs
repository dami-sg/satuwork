#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import wsPackage from '../gateway/node_modules/ws/index.js'

const { WebSocketServer } = wsPackage

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const botRoot = join(root, 'bot')
const http = createServer((_req, res) => {
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end('{"error":"test"}')
})
const wss = new WebSocketServer({ noServer: true })
http.on('upgrade', (req, socket, head) => {
  if (req.url !== '/runtime/local-tunnel') return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})
await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve))
const port = http.address().port
const home = `/tmp/satuwork-local-tunnel-${process.pid}`
const work = join(home, 'work')
const approved = join(home, 'approved')
const denied = join(home, 'denied')
const approvals = join(home, 'approved-dirs.json')
await mkdir(join(work, 'External'), { recursive: true })
await mkdir(approved, { recursive: true })
await mkdir(denied, { recursive: true })
await writeFile(join(approved, 'ok.txt'), 'approved')
await writeFile(join(denied, 'no.txt'), 'denied')
await symlink(approved, join(work, 'External', 'Approved'))
await symlink(denied, join(work, 'External', 'Denied'))
await writeFile(approvals, JSON.stringify([approved]))
const child = spawn(process.execPath, ['--import', 'tsx', 'bin/satuwork.mjs'], {
  cwd: botRoot,
  env: {
    ...process.env,
    SATUWORK_RUNTIME_KIND: 'local',
    SATUWORK_BOT_ID: 'bot-local-test',
    SATUWORK_BOT_PORT: String(port + 1),
    SATUWORK_HOME: join(home, 'data'),
    SATUWORK_WORK_DIR: work,
    SATUWORK_APPROVED_DIRS: approvals,
    GATEWAY_URL: `http://127.0.0.1:${port}`,
    GATEWAY_TOKEN: 'sat_local_test',
    GATEWAY_API_KEY: 'sk_sw_local_test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

try {
  const ws = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('本地通道没有连接')), 10_000)
    wss.once('connection', (socket) => {
      clearTimeout(timer)
      resolve(socket)
    })
  })
  const hello = await new Promise((resolve) => ws.once('message', (raw) => resolve(JSON.parse(raw.toString()))))
  assert.deepEqual(hello, { type: 'auth', token: 'sat_local_test', botId: 'bot-local-test' })
  ws.send(JSON.stringify({ type: 'ready' }))
  const request = async (id, path, headers = {}) => {
    const parts = []
    let status = 0
    const done = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`本地通道没有返回 ${path}`)), 10_000)
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString())
        if (message.id !== id) return
        if (message.type === 'response') status = message.status
        if (message.type === 'response/chunk') parts.push(Buffer.from(message.data, 'base64'))
        if (message.type === 'response/error') reject(new Error(message.error))
        if (message.type === 'response/end') {
          clearTimeout(timer)
          ws.off('message', onMessage)
          resolve()
        }
      }
      ws.on('message', onMessage)
    })
    ws.send(JSON.stringify({ type: 'request', id, method: 'GET', path, headers }))
    ws.send(JSON.stringify({ type: 'request/end', id }))
    await done
    return { status, body: Buffer.concat(parts).toString() }
  }
  const health = await request('health', '/api/health')
  assert.equal(health.status, 200)
  assert.equal(JSON.parse(health.body).ok, true)
  const headers = { authorization: 'Bearer sat_local_test' }
  const list = await request('list', '/api/workspace/list?path=External', headers)
  assert.equal(list.status, 200)
  assert.deepEqual(JSON.parse(list.body).entries.map((item) => item.name), ['Approved'])
  const read = await request('read', '/api/workspace/file?path=External%2FApproved%2Fok.txt', headers)
  assert.equal(read.status, 200)
  assert.match(read.body, /approved/)
  const blocked = await request('blocked', '/api/workspace/file?path=External%2FDenied%2Fno.txt', headers)
  assert.equal(blocked.status, 400)
  console.log('local-tunnel: ok')
} finally {
  child.kill('SIGTERM')
  wss.close()
  await new Promise((resolve) => http.close(resolve))
  await rm(home, { recursive: true, force: true })
}
