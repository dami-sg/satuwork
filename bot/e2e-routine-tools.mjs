/**
 * Agent 操作日常任务的内置工具探针（docs/routines.md §9）。
 *
 * 这里盯四件不会靠类型检查暴露的问题：工具是否真的注册；席位票与 botId 是否每一跳都带；
 * create / update 有没有把字段改名改对；run 是否走现有手动试跑端点而不是另造执行路径。
 */
import { createServer } from 'node:http'

process.env.SATUWORK_BOT_ID = 'bot-routine'
process.env.GATEWAY_TOKEN = 'sat_routine_probe'

const now = Date.now()
const baseRoutine = {
  id: 'rt-daily',
  botId: 'bot-routine',
  name: '每日简报',
  instruction: '整理昨日进展并发给我',
  active: true,
  triggers: [{ kind: 'schedule', every: 'day', at: '09:00', weekday: 1, day: 1, tz: 'Asia/Shanghai' }],
  modelRole: 'utility',
  nextRunAt: now + 60_000,
  retryAt: null,
  retryCount: 0,
  retryMax: 3,
  lastRun: null,
  createdAt: now,
  updatedAt: now,
}

const seen = []
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', () => {
    const url = new URL(req.url, 'http://probe')
    const body = raw ? JSON.parse(raw) : undefined
    seen.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body })
    const send = (code, value) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }
    if (req.method === 'GET' && url.pathname === '/runtime/bots/bot-routine/routines') {
      return send(200, { routines: [baseRoutine] })
    }
    if (req.method === 'GET' && url.pathname === '/runtime/routines/rt-daily') {
      return send(200, {
        routine: baseRoutine,
        runs: [{ id: 'run-old', trigger: 'schedule', status: 'ok', sessionId: 's1', error: null, startedAt: now - 1000, endedAt: now }],
      })
    }
    if (req.method === 'POST' && url.pathname === '/runtime/bots/bot-routine/routines') {
      return send(201, { routine: { ...baseRoutine, id: 'rt-new', name: body.name, instruction: body.instruction, triggers: body.triggers, modelRole: body.modelRole || 'utility' } })
    }
    if (req.method === 'PATCH' && url.pathname === '/runtime/routines/rt-daily') {
      return send(200, { routine: { ...baseRoutine, ...body, modelRole: body.modelRole || baseRoutine.modelRole } })
    }
    if (req.method === 'POST' && url.pathname === '/runtime/routines/rt-daily/run') {
      return send(200, { run: { id: 'run-now', trigger: 'manual', status: 'running', sessionId: 's1', error: null, startedAt: now, endedAt: null } })
    }
    send(404, { error: 'no route' })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.GATEWAY_URL = `http://127.0.0.1:${server.address().port}`

const { Context } = await import('@deepseek-ai/cordis')
const { ToolService } = await import('./src/tools/index.ts')
const ctx = new Context()
await ctx.plugin(ToolService)
await ctx.plugin(await import('./src/tools/routine.ts'))
for (let i = 0; i < 100 && !ctx.tools.has('routine_manage'); i++) await new Promise((r) => setTimeout(r, 10))

const call = (name, args) => ctx.tools.execute({ callId: `c-${seen.length}`, name, arguments: JSON.stringify(args), sessionId: 's-main' })
const out = {}
out.registered = ctx.tools.schemas().map((t) => t.name).filter((n) => n.startsWith('routine_'))
out.risk = { list: ctx.tools.riskOf('routine_list'), manage: ctx.tools.riskOf('routine_manage') }
out.delegation = { list: ctx.tools.delegationOf('routine_list'), manage: ctx.tools.delegationOf('routine_manage') }
out.list = (await call('routine_list', {})).text
out.detail = (await call('routine_list', { routine: '每日简报' })).text
out.createMissing = (await call('routine_manage', { action: 'create', name: '缺时间', instruction: '做事' })).text
out.create = (
  await call('routine_manage', {
    action: 'create',
    name: '周报',
    instruction: '整理本周进展',
    triggers: [{ kind: 'schedule', every: 'week', at: '18:00', weekday: 5, day: 1, tz: 'Asia/Shanghai' }],
    model_role: 'daily',
  })
).text
out.update = (await call('routine_manage', { action: 'update', routine: '每日简报', instruction: '整理昨日重点', active: false })).text
out.run = (await call('routine_manage', { action: 'run', routine: 'rt-daily' })).text
out.seen = seen

server.close()
console.log('__RESULT__' + JSON.stringify(out))
process.exit(0)
