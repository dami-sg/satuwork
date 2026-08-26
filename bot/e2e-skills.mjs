/**
 * Skill 工具集的探针（docs/skills.md）。e2e/skills-bot.mjs 用。要 tsx 才 import 得了 .ts。
 *
 * 盯的是两件在线上都**不会报错**的事：
 *
 * 1. **分档**。索引装不下时没退到 `skills_list`，模型就只剩一行摘要、什么都找不到；
 *    而它不会报错，只会说「没有这方面的方法」。
 * 2. **话术**。找不到、搜不到、改不动公司目录——这三种回答只要写成一句干巴巴的失败，
 *    模型就会转头告诉用户做不到。空结果在它眼里等于「这件事不存在」。
 */
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'satu-skills-'))
process.env.SATUWORK_HOME = home
process.env.SATUWORK_BOT_ID = 'bot-1'
process.on('exit', () => {
  try {
    rmSync(home, { recursive: true, force: true })
  } catch {}
})

const { Context } = await import('@deepseek-ai/cordis')
const { skillSplit } = await import('./src/agent/index.ts')
const { StorageService } = await import('./src/storage/index.ts')
const { ToolService } = await import('./src/tools/index.ts')

const out = {}

// ── 1. 分档：纯函数，同一份输入必然同一份输出 ─────────────────────────

const skill = (name, over = {}) => ({
  id: `id-${name}`,
  name,
  displayName: name,
  body: `${name} 的正文`,
  tags: [],
  source: '手动编写',
  enabled: true,
  mode: '按需',
  description: `${name} 用在什么时候`,
  hasFiles: false,
  origin: 'company',
  createdAt: 1,
  updatedAt: 1,
  ...over,
})

{
  const split = skillSplit([
    skill('回复口径', { mode: '常驻', body: '一律用中文。' }),
    skill('退款审核'),
    skill('周报模版'),
  ])
  out.tier0 = {
    resident: split.resident.map((s) => s.displayName),
    onDemand: split.onDemand.map((s) => s.displayName),
    listTool: split.listTool,
    index: split.index,
  }
}

{
  /**
   * 中文索引撑到装不下。**每条的名字和说明都是中文**——这正是 `chars / 3` 那个估法
   * 会低估三倍的地方：照它算，这一百条还「装得下」，于是分档线形同虚设。
   */
  const many = Array.from({ length: 120 }, (_, i) =>
    skill(`第${i}号流程`, { id: `id-${i}`, description: `这条讲的是第${i}号流程在什么情况下走，以及每一步交给谁` }),
  )
  const split = skillSplit(many)
  out.tier1 = { listTool: split.listTool, index: split.index, onDemand: split.onDemand.length }
}

// 一条按需的都没有 → 不需要索引，也不需要那把工具
out.allResident = (() => {
  const split = skillSplit([skill('口径', { mode: '常驻' })])
  return { index: split.index, listTool: split.listTool }
})()

// ── 2. 三把工具：话术、越权、包文件 ───────────────────────────────────

/** Gateway 的替身：私有档的写，加包文件那两条。 */
const seen = { created: [], deleted: [], fileHits: 0 }
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x')
  const send = (code, body) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const readBody = () =>
    new Promise((resolve) => {
      let raw = ''
      req.on('data', (d) => (raw += d))
      req.on('end', () => resolve(raw ? JSON.parse(raw) : {}))
    })

  if (url.pathname === '/runtime/skills' && req.method === 'POST') {
    return readBody().then((body) => {
      seen.created.push(body)
      if (body.name === '退款审核') return send(409, { error: '已经有一条「退款审核」了。要改它就用 update，确实是另一件事就换个名字。' })
      send(201, {
        skill: {
          id: 'id-new',
          name: body.name,
          displayName: body.name,
          body: body.body,
          tags: body.tags || [],
          source: '手动编写',
          enabled: true,
          mode: '按需',
          description: body.body.split('\n')[0],
          hasFiles: false,
          origin: 'seat',
        },
        used: 1,
        max: 30,
      })
    })
  }
  if (url.pathname.startsWith('/runtime/skills/') && url.pathname.endsWith('/files')) {
    return send(200, { files: [{ path: 'references/口径.md', bytes: 42 }] })
  }
  if (url.pathname.startsWith('/runtime/skills/') && url.pathname.endsWith('/file')) {
    seen.fileHits += 1
    return send(200, { path: url.searchParams.get('path'), text: '差额在 1 元以内不追。' })
  }
  if (req.method === 'DELETE') {
    seen.deleted.push(url.pathname)
    return send(200, { deleted: true, used: 0, max: 30 })
  }
  send(404, { error: 'no' })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
process.env.GATEWAY_URL = `http://127.0.0.1:${server.address().port}`
process.env.GATEWAY_TOKEN = 'sat_probe'

const ctx = new Context()
await ctx.plugin(StorageService, { path: join(home, 'probe.db') })
await ctx.plugin(ToolService)

/** 目录服务的替身：三把工具只用到 noteSkill / dropSkill / pull。 */
const noted = []
ctx.provide('catalog', {
  noteSkill: (item) => noted.push(item),
  dropSkill: (id) => noted.push({ dropped: id }),
  pull: async () => true,
})
/** 会话日志的替身：那张卡落在这里。 */
const cards = []
ctx.provide('sessions', { append: async (sessionId, type, data) => cards.push({ sessionId, type, data }) })

const col = ctx.storage.collection('skills')
col.put('id-refund', skill('退款审核', { id: 'id-refund', body: '按金额分档：\n- 500 以内直接退', origin: 'company' }))
col.put('id-zip', skill('对账流程', { id: 'id-zip', hasFiles: true, origin: 'company' }))
col.put('id-mine', skill('周报工单导出', { id: 'id-mine', origin: 'seat', body: '我自己记的做法' }))
col.put('id-dup', skill('周报模版（2）', { id: 'id-dup', name: '周报模版', displayName: '周报模版（2）' }))

await ctx.plugin(await import('./src/tools/skill.ts'))
// 插件是并发挂载的，等三把工具都注册上。
for (let i = 0; i < 100 && !ctx.tools.has('skill_manage'); i++) await new Promise((r) => setTimeout(r, 20))

const call = async (name, args) =>
  await ctx.tools.execute({
    callId: 'c1',
    name,
    arguments: JSON.stringify(args),
    sessionId: 's1',
  })

out.registered = ctx.tools.schemas().map((t) => t.name).filter((n) => n.startsWith('skill'))
out.risk = {
  view: ctx.tools.riskOf('skill_view'),
  list: ctx.tools.riskOf('skills_list'),
  manage: ctx.tools.riskOf('skill_manage'),
}
out.delegation = {
  view: ctx.tools.delegationOf('skill_view'),
  manage: ctx.tools.delegationOf('skill_manage'),
}

out.view = (await call('skill_view', { skill: '退款审核' })).text
// 重名的那条按带序号的名字取；缩写成原名也认（模型很爱这么干）
out.viewDup = (await call('skill_view', { skill: '周报模版（2）' })).text
out.viewMissing = (await call('skill_view', { skill: '退款审' })).text
out.viewFiles = (await call('skill_view', { skill: '对账流程' })).text
out.viewOneFile = (await call('skill_view', { skill: '对账流程', file: 'references/口径.md' })).text
// 第二次读同一个文件应当走缓存，不再打 Gateway
await call('skill_view', { skill: '对账流程', file: 'references/口径.md' })
out.fileHits = seen.fileHits
out.viewNoSuchFile = (await call('skill_view', { skill: '对账流程', file: 'nope.md' })).text

out.list = (await call('skills_list', { query: '退款' })).text
out.listEmpty = (await call('skills_list', { query: '发工资' })).text

out.create = (await call('skill_manage', { action: 'create', name: '对账小抄', body: '每月对账怎么做\n- 拉流水' })).text
out.createSent = seen.created[seen.created.length - 1]
out.card = cards.map((c) => ({ type: c.type, action: c.data.action, name: c.data.name }))
out.clash = (await call('skill_manage', { action: 'create', name: '退款审核', body: '我自己的一套' })).text
out.updateCompany = (await call('skill_manage', { action: 'update', skill: '退款审核', body: '改一下' })).text
out.removeCompany = (await call('skill_manage', { action: 'remove', skill: '退款审核' })).text
out.removeMine = (await call('skill_manage', { action: 'remove', skill: '周报工单导出' })).text
out.deleted = seen.deleted

server.close()
console.log(`__RESULT__${JSON.stringify(out)}`)
process.exit(0)
