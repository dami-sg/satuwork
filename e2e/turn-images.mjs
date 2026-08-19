/**
 * 当前这一轮发的图，模型这一轮就得看见。探针在 bot/e2e-turn-images.mjs。
 *
 * 这条路**不走历史重建**，所以 vision 那一组照不到它：runTurn 里的 `history` 是 append
 * 用户消息**之前**取的快照（`sessions.events()` 返回 `state.events.slice()`），这一轮的
 * 消息不在里面——它是靠 `agent.prompt()` 单独送进去的。prompt 只传文本的话，图要等到
 * 下一轮随历史进上下文，表现成「问第一遍它没看见，再问一句就看见了」。
 *
 * 断言落在 `llm.streamFn` 收到的 context 上：那是真正要发给模型的东西，比检查我们自己
 * 拼的中间结构可信。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

function runProbe(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'bot/e2e-turn-images.mjs')], {
      cwd: join(root, 'bot'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GATEWAY_URL: '', GATEWAY_API_KEY: '', SATUWORK_BOT_ID: '' },
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

export async function runTurnImages({ root, test, assert, log }) {
  log('\n# turn-images')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.firstTurn && r.nextTurn, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('第一轮就带图：模型这一轮就看得见', () => {
    // 这条是整组的重点。没有它，用户发图问「这是什么」会得到一个像没看见图的回答，
    // 而再问一句「你看到图了吗」就正常了——现象诡异，从日志上完全看不出原因，
    // 因为图确实写进 JSONL 了。
    assert(r.firstTurn.有图, '这一轮送进模型的用户消息里没有图片块')
    assert(r.firstTurn.图带了字节, '有图片块但 data 是空的')
    assert(r.firstTurn.正文还在, '带图之后正文丢了')
    assert(r.firstTurn.盖了时间戳, '带图的那条没盖上时间戳，跟纯文本那条对不齐')
    assert(r.firstTurn.用户消息条数 === 1, `第一轮该只有一条用户消息，实为 ${r.firstTurn.用户消息条数}`)
  })

  await test('下一轮：那张图从历史里读回来，不重不丢', () => {
    assert(r.nextTurn.用户消息条数 === 2, `该有两条用户消息，实为 ${r.nextTurn.用户消息条数}`)
    // 正好一条带图：多了说明当前轮那条被重复塞进去了（prompt 送一次、历史重建又送一次），
    // 少了说明它没落进日志。
    assert(r.nextTurn.带图的条数 === 1, `带图的该只有一条，实为 ${r.nextTurn.带图的条数}`)
    assert(r.nextTurn.最后一条没有图, '这一轮本来没带图，却多出了图片块')
  })

  await test('不带图的一轮：形状没被这次改动带歪', () => {
    assert(r.plain.没有图, '纯文本的一轮多出了图片块')
    assert(r.plain.只有文本块 && r.plain.正文在, `纯文本那条的内容不对：${JSON.stringify(r.plain)}`)
  })
}
