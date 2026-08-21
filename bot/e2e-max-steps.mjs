/**
 * 一轮的步数硬顶（`Config.maxSteps`）。
 *
 * pi 的循环是「模型还在要工具就接着跑」，模型自己不停就永远不停——上下文那条路有
 * 压缩兜着，撞不到窗口那堵墙。刹车只有一个：`shouldStopAfterTurn`。这里用一个**永远
 * 在要工具**的假模型把跑飞演出来，钉住三件事：
 *
 *   1. 到了上限真的停，而且停得**干净**——是 agent_end 收工，不是抛异常。异常那条路
 *      会被 runTurn 记成 error，对话里留一句「出错了」，而它其实什么都没错。
 *   2. 停下来时 `errorMessage` 是空的。runTurn 里模型失败优先于撞顶，这条不成立的话
 *      撞顶会被写成模型故障。
 *   3. **没撞顶的正常一轮不受影响**。只做到第 1 条太容易了：每轮都停也满足它。
 *      模型自己收口的那一步不带工具结果，不能算进步数——算了的话硬顶就变成
 *      「一轮最多说 N 句话」。
 *
 * 探针要 tsx 才 import 得了 .ts，所以由 e2e/max-steps.mjs 另起一个进程跑。
 */
import { Agent } from '@earendil-works/pi-agent-core'
import { AssistantMessageEventStream, stubModel, emptyAssistant } from './src/llm/stream.ts'

const MAX_STEPS = 5
const model = stubModel('deepseek', 'probe')

/**
 * 假模型。`stopAfter` 步之后不再要工具（模型自己收口）；Infinity 就是跑飞。
 *
 * 形状照 gateway.ts 的 consumeOpenAI 摆：start → toolcall_start/end → done，
 * stopReason 用 'toolUse'。摆错的话 pi 根本不会去执行工具，这条测试就成了空转。
 */
function fakeStreamFn(stopAfter) {
  let calls = 0
  return () => {
    const n = ++calls
    const stream = new AssistantMessageEventStream()
    const partial = emptyAssistant(model)
    queueMicrotask(() => {
      stream.push({ type: 'start', partial })
      if (n <= stopAfter) {
        partial.content.push({ type: 'toolCall', id: `c${n}`, name: 'noop', arguments: {} })
        stream.push({ type: 'toolcall_start', contentIndex: 0, partial })
        stream.push({ type: 'toolcall_end', contentIndex: 0, toolCall: partial.content[0], partial })
        partial.stopReason = 'toolUse'
        stream.push({ type: 'done', reason: 'toolUse', message: partial })
      } else {
        partial.content.push({ type: 'text', text: '做完了' })
        partial.stopReason = 'stop'
        stream.push({ type: 'done', reason: 'stop', message: partial })
      }
    })
    return stream
  }
}

/** 跑一轮，把「跑了几步、停在哪、是怎么停的」带回来。刹车逻辑与 agent/index.ts 同形。 */
async function runTurn(stopAfter) {
  let executed = 0
  let steps = 0
  let toolCalls = 0
  let capped = false
  const events = []

  const agent = new Agent({
    initialState: {
      systemPrompt: '',
      model,
      messages: [],
      tools: [
        {
          name: 'noop',
          label: 'noop',
          description: '什么都不做，只为把循环转起来',
          parameters: { type: 'object', properties: {} },
          execute: async () => {
            executed += 1
            return { output: 'ok' }
          },
        },
      ],
    },
    streamFn: fakeStreamFn(stopAfter),
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
    shouldStopAfterTurn: ({ toolResults }) => {
      if (!toolResults.length) return false
      steps += 1
      toolCalls += toolResults.length
      if (steps < MAX_STEPS) return false
      capped = true
      return true
    },
  })

  agent.subscribe((e) => {
    events.push(e.type)
  })

  let threw = ''
  try {
    // 挂住就是这条测试要防的那个 bug 本身——它不能把整套 e2e 一起拖死。
    await Promise.race([
      agent.prompt('开始'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('一轮没能在 10 秒内收口')), 10_000)),
    ])
  } catch (e) {
    threw = e.message
  }

  return {
    steps,
    toolCalls,
    executed,
    capped,
    threw,
    errorMessage: agent.state?.errorMessage ?? '',
    endedCleanly: events[events.length - 1] === 'agent_end',
  }
}

const out = {
  maxSteps: MAX_STEPS,
  // 永远在要工具：跑飞。
  runaway: await runTurn(Infinity),
  // 上限之内自己收口：不该被硬顶碰到。
  polite: await runTurn(2),
}

console.log('__RESULT__' + JSON.stringify(out))
