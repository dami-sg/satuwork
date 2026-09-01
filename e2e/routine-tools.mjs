/** Agent 侧的日常任务内置工具。探针在 bot/e2e-routine-tools.mjs。 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-routine-tools.mjs')

export async function runRoutineTools({ root, test, assert, log }) {
  log('\n# routine-tools')
  let r
  await test('探针跑得起来，两把工具都注册', async () => {
    r = await runProbe(root)
    assert(JSON.stringify(r.registered.sort()) === JSON.stringify(['routine_list', 'routine_manage']), `工具名单 ${JSON.stringify(r.registered)}`)
  })
  if (!r) return

  await test('读取只读、修改只写，而且两把都只给主代理', () => {
    assert(JSON.stringify(r.risk.list) === JSON.stringify(['read']), `list risk ${JSON.stringify(r.risk.list)}`)
    assert(JSON.stringify(r.risk.manage) === JSON.stringify(['write']), `manage risk ${JSON.stringify(r.risk.manage)}`)
    assert(r.delegation.list.mode === 'root-only' && r.delegation.manage.mode === 'root-only', `delegation ${JSON.stringify(r.delegation)}`)
  })

  await test('能列全部、按名字看详情和最近流水', () => {
    assert(r.list.includes('每日简报') && r.list.includes('每天 09:00'), `列表 ${r.list}`)
    assert(r.detail.includes('最近运行'), `详情 ${r.detail}`)
    assert(r.detail.includes('schedule'), `详情没有运行触发来源 ${r.detail}`)
  })

  await test('新增缺时间时先问，不替用户猜', () => {
    assert(r.createMissing.includes('缺少 triggers') && r.createMissing.includes('先问用户'), `缺时间 ${r.createMissing}`)
  })

  await test('新增、修改和立即触发都走既有 Gateway 端点', () => {
    assert(r.create.includes('周报') && r.create.includes('每周五 18:00'), `create ${r.create}`)
    assert(r.update.includes('整理昨日重点') && r.update.includes('停用'), `update ${r.update}`)
    assert(r.run.includes('run-now') && r.run.includes('不改变原来的定时排期'), `run ${r.run}`)
    const create = r.seen.find((x) => x.method === 'POST' && x.path === '/runtime/bots/bot-routine/routines' && x.body?.name === '周报')
    const update = r.seen.find((x) => x.method === 'PATCH')
    const run = r.seen.find((x) => x.method === 'POST' && x.path.endsWith('/run'))
    assert(create?.body?.modelRole === 'daily', `create 字段没翻对 ${JSON.stringify(create)}`)
    assert(update?.body?.instruction === '整理昨日重点' && update?.body?.active === false, `update body ${JSON.stringify(update)}`)
    assert(run?.path === '/runtime/routines/rt-daily/run', `run path ${JSON.stringify(run)}`)
  })

  await test('每一跳都带席位票，按 id 操作还钉当前 botId', () => {
    assert(r.seen.every((x) => x.auth === 'Bearer sat_routine_probe'), `有请求没带席位票 ${JSON.stringify(r.seen)}`)
    const byId = r.seen.filter((x) => x.path.startsWith('/runtime/routines/'))
    assert(byId.length >= 3 && byId.every((x) => x.query.botId === 'bot-routine'), `按 id 的请求没钉 botId ${JSON.stringify(byId)}`)
  })
}
