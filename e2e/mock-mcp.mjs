/**
 * e2e 用的假 MCP：HTTP JSON-RPC，一个 tool `secret_marker`，返回 MCP-OK-7F3A。
 * 绑 127.0.0.1:0，把端口打到 stdout。
 */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

export function startMockMcp() {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
        })
        res.end()
        return
      }
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        let body
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
          return
        }
        const id = body.id ?? null
        const method = body.method
        const json = (obj) => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(obj))
        }
        if (method === 'notifications/initialized' || (typeof method === 'string' && method.startsWith('notifications/'))) {
          res.writeHead(204)
          res.end()
          return
        }
        if (method === 'initialize') {
          json({
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'e2e-mock-mcp', version: '0.0.1' },
            },
          })
          return
        }
        if (method === 'tools/list') {
          json({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                {
                  name: 'secret_marker',
                  description: 'Returns a fixed marker string for e2e.',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          })
          return
        }
        if (method === 'tools/call') {
          const name = body.params?.name
          if (name === 'secret_marker') {
            json({
              jsonrpc: '2.0',
              id,
              result: { content: [{ type: 'text', text: 'MCP-OK-7F3A' }] },
            })
            return
          }
          json({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown tool ${name}` } })
          return
        }
        json({ jsonrpc: '2.0', id, error: { code: -32601, message: `unknown method ${method}` } })
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      console.log(`mock-mcp port ${port}`)
      resolve({
        server,
        port,
        close: () =>
          new Promise((r) => {
            server.close(() => r())
          }),
      })
    })
  })
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const m = await startMockMcp()
  console.log(String(m.port))
}
