/**
 * 日常任务用哪个模型跑。探针在 bot/e2e-routine-model.mjs。
 *
 * 这一组守的是一条**不会自己喊出来**的线：选了 utility，那一轮就得真按 utility 跑。
 * 塌了的表现是任务照跑、对话照出、流水照绿，只有账单不对——而账单要有人去翻，还得
 * 把某一笔和某条定时任务对上。所以它必须由测试盯着。
 *
 * 另外几条是这个开关的边界：`daily` 的意思是**不覆盖**（不是「钉到平台日常模型」），
 * 平台没配 utility 时**照旧跑**，会话装不进 utility 的窗口时也**照旧跑**（退回 Bot 自己
 * 的模型）——省钱是目的，不是前提。最后那一条还兼管另一件事：**压缩一律按 Bot 自己的
 * 窗口算**。压缩会写进会话日志，而那条会话是人和定时任务共用的一条；按便宜模型的小窗口
 * 去压，等于人什么都没做，第二天回来上下文就没了。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-routine-model.mjs', { env: { GATEWAY_URL: '', GATEWAY_API_KEY: '', SATUWORK_BOT_ID: '' } })

export async function runRoutineModel({ root, test, assert, log }) {
  log('\n# routine-model')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.utility && r.notPinned && r.reasoning && r.noRole && r.tooBig, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('选了 utility，那一轮真的按 utility 跑', () => {
    assert(r.utility.换成了平台那一对, '还是按 Bot 自己的模型跑——这个开关等于摆设，账单一分不省')
    assert(r.utility.用的不是Bot自己的, '没换掉')
    assert(r.utility.推理强度生效, 'utility 模型换对了，但推理强度没有送进模型调用')
  })

  await test('日常模型的推理强度用于普通聊天与 daily 任务', () => {
    assert(r.reasoning.daily生效, '日常模型的推理强度没有送进模型调用')
  })

  await test('daily 与不给这个值：都不覆盖 Bot 自己的模型', () => {
    assert(r.notPinned.daily不覆盖, 'daily 把 Bot 自己的模型换掉了')
    assert(r.notPinned.不给也不覆盖, '不给角色名时也换了——那所有普通对话都会被带偏')
    assert(r.notPinned.daily不是平台日常, 'daily 被当成「钉到平台日常模型」，管理员给这颗 Bot 单独挑的模型就废了')
  })

  await test('平台还没钉 utility：照旧跑，不是不跑', () => {
    assert(r.noRole.照旧跑得起来, '取不到角色就不跑了——省钱成了跑起来的前提')
    assert(r.noRole.用的是Bot自己的, '回落的不是 Bot 自己那一对')
  })

  await test('会话装不进 utility 的窗口：这一轮退回 Bot 自己的模型，不去压这条会话', () => {
    assert(
      r.tooBig.这一轮退回Bot自己的,
      '照钉的模型发出去了——会话比它的窗口大，provider 会以超长顶回来，这条任务从此每天记一条 error',
    )
    assert(
      r.tooBig.没有偷偷压一次,
      '压缩按 utility 的窗口算了。压缩会写进会话日志，而这条会话是人和定时任务共用的一条——' +
        '一条选了 utility 的日常任务，会拿便宜模型的小窗口削掉人的聊天上下文，摘要还是那个便宜模型写的',
    )
  })
}
