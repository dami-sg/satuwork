/**
 * 一轮的步数硬顶。探针在 bot/e2e-max-steps.mjs（要 tsx 才 import 得了 .ts）。
 *
 * 为什么值得单开一个套件：跑飞是**没人叫停就不会停**的那类故障。循环的退出条件是
 * 「模型不再要工具」，上下文又有压缩兜着，一个绕不出来的工具循环能一直烧钱烧到有人
 * 恰好看见界面还在转。刹车只有 `shouldStopAfterTurn` 这一个口子，而它是 pi 的 API——
 * 升级一次就可能改名或改语义，静悄悄地把刹车拆掉。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

function runProbe(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'bot/e2e-max-steps.mjs')], {
      cwd: join(root, 'bot'),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    // 刹车失灵的样子就是探针永远跑不完，别让它把整套 e2e 一起拖死。
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('探针没能在 60 秒内跑完——循环没有停下，正是这条测试要防的'))
    }, 60000)
    child.on('error', reject)
    child.on('close', (code) => {
      clearTimeout(timer)
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

export async function runMaxSteps({ root, test, assert, log }) {
  log('\n# max-steps')
  const r = await runProbe(root)

  await test('模型永远在要工具：到上限就停，不再往下烧', () => {
    assert(!r.runaway.threw, `一轮没能收口：${r.runaway.threw}`)
    assert(r.runaway.capped, '跑飞了但硬顶没触发')
    assert(r.runaway.steps === r.maxSteps, `停在第 ${r.runaway.steps} 步，应该是 ${r.maxSteps}`)
    // 数到了但没真拦住，是最难发现的一种坏法：日志上写着「已收口」，钱照烧。
    assert(
      r.runaway.executed === r.maxSteps,
      `工具跑了 ${r.runaway.executed} 次，超出上限 ${r.maxSteps}——数着了但没拦住`,
    )
  })

  await test('停得干净：agent_end 收工，不是抛异常，也不算模型故障', () => {
    // 抛出来的话 runTurn 会记成 error，对话里留一句「出错了：…」——它其实什么都没错。
    assert(r.runaway.endedCleanly, '最后一个事件不是 agent_end，收口路径不对')
    // runTurn 里模型失败优先于撞顶。这条挂了，撞顶就会被写成「模型调用失败」。
    assert(!r.runaway.errorMessage, `撞顶被记成了模型故障：${r.runaway.errorMessage}`)
  })

  await test('没撞顶的正常一轮不受影响——只会掐是不算修好的', () => {
    assert(!r.polite.capped, '模型自己收口的一轮被硬顶误伤')
    assert(r.polite.steps === 2, `正常一轮记了 ${r.polite.steps} 步，应该是 2`)
    // 模型不再要工具的那一步不带工具结果，不能算进步数——算了的话，硬顶就从
    // 「防跑飞」变成了「一轮最多说 N 句话」。
    assert(r.polite.toolCalls === 2, `工具调用记了 ${r.polite.toolCalls} 次，应该是 2`)
  })
}
