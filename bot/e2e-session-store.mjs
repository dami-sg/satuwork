/**
 * 直接驱动 SessionService 的探针。**不走 HTTP**——要测的是同一条会话上的并发读写，
 * 那在 HTTP 层没法稳定复现。
 *
 * 由 e2e/session-store.mjs 用 `node --import tsx` 拉起，结果以 __RESULT__ 一行 JSON 回去。
 *
 * 放 bot/ 而不是 e2e/：ESM 的裸导入按**文件所在目录**往上找 node_modules，
 * 放在 e2e/ 下解析不到 @deepseek-ai/cordis。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionService } from './src/session/index.ts'

/** 每次都要一个空缓存的服务——竞态只在「还没缓存」那一刻存在。 */
async function freshService(root) {
  const ctx = new Context()
  ctx.plugin(SessionService, { root })
  await ctx.inject(['sessions'], () => {})
  return ctx.sessions
}

const CONCURRENCY = 20

function textOf(i) {
  return `并发消息-${i}`
}

function linesOf(file) {
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
}

async function appendMany(sessions, id) {
  const events = await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      sessions.append(id, 'user/message', {
        message: { id: `m-${i}`, role: 'user', content: [{ type: 'text', text: textOf(i) }] },
        source: { kind: 'user' },
      }),
    ),
  )
  return events.map((e) => e.seq)
}

/** 场景一：已经是当前格式，只测并发追加会不会各记各的 seq。 */
async function concurrentAppend() {
  const root = mkdtempSync(join(tmpdir(), 'satuwork-sess-a-'))
  const first = await freshService(root)
  const id = await first.create({ botId: 'default', title: '并发' })
  const file = join(root, `${id}.jsonl`)

  // 换一个空缓存的服务：模拟进程重启后第一次访问就撞上并发。
  const sessions = await freshService(root)
  const seqs = await appendMany(sessions, id)

  const reloaded = await freshService(root)
  const events = await reloaded.events(id)
  return {
    uniqueSeqs: new Set(seqs).size,
    expectedSeqs: CONCURRENCY,
    fileLines: linesOf(file).length,
    reloadedEvents: events.length,
    expectedEvents: 1 + CONCURRENCY,
    distinctTexts: new Set(
      events.filter((e) => e.type === 'user/message').map((e) => e.data.message.content[0].text),
    ).size,
  }
}

/** 场景二：旧格式（v1，无 botId），迁移重写和并发追加撞在一起。 */
async function migrateUnderLoad() {
  const root = mkdtempSync(join(tmpdir(), 'satuwork-sess-b-'))
  const id = 's-legacy-under-load'
  const file = join(root, `${id}.jsonl`)
  const legacy = [
    { seq: 1, time: 1, type: 'session', data: { version: 1, id, createdAt: 1, title: '旧会话' } },
    {
      seq: 2,
      time: 2,
      type: 'user/message',
      data: { message: { id: 'm0', role: 'user', content: [{ type: 'text', text: 'LEGACY-KEEP' }] }, source: { kind: 'user' } },
    },
  ]
  writeFileSync(file, legacy.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const sessions = await freshService(root)
  const seqs = await appendMany(sessions, id)

  const reloaded = await freshService(root)
  const events = await reloaded.events(id)
  const root0 = events[0]
  return {
    uniqueSeqs: new Set(seqs).size,
    expectedSeqs: CONCURRENCY,
    fileLines: linesOf(file).length,
    reloadedEvents: events.length,
    expectedEvents: legacy.length + CONCURRENCY,
    rootVersion: root0?.data?.version,
    rootBotId: root0?.data?.botId,
    keptLegacyBody: events.some(
      (e) => e.type === 'user/message' && e.data.message.content[0].text === 'LEGACY-KEEP',
    ),
    strays: readdirSync(root).filter((f) => !f.endsWith('.jsonl')),
  }
}

/**
 * 场景三：上个进程死在一轮对话中间——日志末尾留着一条没有配对 turn/end 的 turn/start。
 *
 * 崩溃、机器重启、以及每一次「重新部署」都会造出这个形状。不收口的话，界面按
 * 「最后一条 turn/start 之后有没有 turn/end」判断，会永远显示「正在处理」。
 */
async function danglingTurn() {
  const root = mkdtempSync(join(tmpdir(), 'satuwork-sess-c-'))

  // 3a. 悬着的一轮：写到 turn/start 和一条助手消息就断电
  const cut = 's-cut'
  writeFileSync(
    join(root, `${cut}.jsonl`),
    [
      { seq: 1, time: 1, type: 'session', data: { version: 2, id: cut, createdAt: 1, title: '断电', botId: 'default', origin: 'local' } },
      { seq: 2, time: 2, type: 'user/message', data: { message: { id: 'm0', role: 'user', content: [{ type: 'text', text: '在吗' }] }, source: { kind: 'user' } } },
      { seq: 3, time: 3, type: 'turn/start', data: { turn: 7 } },
    ]
      .map((l) => JSON.stringify(l))
      .join('\n') + '\n',
  )

  // 3b. 正常收口的一轮：不该被动
  const done = 's-done'
  const doneLines = [
    { seq: 1, time: 1, type: 'session', data: { version: 2, id: done, createdAt: 1, title: '正常', botId: 'default', origin: 'local' } },
    { seq: 2, time: 2, type: 'turn/start', data: { turn: 1 } },
    { seq: 3, time: 3, type: 'turn/end', data: { turn: 1, reason: 'completed' } },
  ]
  writeFileSync(join(root, `${done}.jsonl`), doneLines.map((l) => JSON.stringify(l)).join('\n') + '\n')

  const sessions = await freshService(root)
  const cutEvents = await sessions.events(cut)
  const doneEvents = await sessions.events(done)
  const last = cutEvents[cutEvents.length - 1]

  // 补的那条也要落盘：只补在内存里的话，下次重启又变回悬着的。
  const reloaded = await freshService(root)
  const cutAgain = await reloaded.events(cut)

  return {
    healedType: last?.type,
    healedTurn: last?.data?.turn,
    healedReason: last?.data?.reason,
    // seq 必须接着往下发，不能撞号——SSE 的 ?after= 游标靠它
    healedSeq: last?.seq,
    persisted: linesOf(join(root, `${cut}.jsonl`)).length,
    // 再读一次不该再补一条
    stableOnReload: cutAgain.filter((e) => e.type === 'turn/end').length,
    untouchedDone: doneEvents.length,
  }
}

const result = {
  concurrentAppend: await concurrentAppend(),
  migrateUnderLoad: await migrateUnderLoad(),
  danglingTurn: await danglingTurn(),
}
console.log('__RESULT__' + JSON.stringify(result))
process.exit(0)
