/**
 * 席位半路死掉，管家反代要把「断」传下去。
 *
 * 换版就是 `systemctl restart`：正开着的那条聊天 SSE 从席位那头被掐断。反代这一跳要是
 * 把下游悬着不关（pipe 只在干净的 end 上收尾 res），Gateway 和浏览器就拿着一条「看着
 * 还开着、再也不会有字节」的流干等——重连、退避、长跑全都不触发，因为它们等的都是
 * 「断」。界面上的表现就是那句修了几轮的「回答其实出了、屏幕上看不见、刷新才好」。
 *
 * 真反代 + 假席位，走探针（见 manager/e2e-proxy-close.mjs）。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'manager/e2e-proxy-close.mjs')

export async function runProxyClose({ root, test, assert, log }) {
  log('\n# proxy-close')
  const r = await runProbe(root)

  await test('SSE 穿得过反代：正常路上字节到得了客户端', async () => {
    assert(r.status === 200, `反代没接通：status=${r.status}`)
    assert(r.bytesBeforeKill > 0, '席位在发心跳，客户端却一个字节都没收到')
  })

  await test('席位半路死掉：下游几秒内看见「断」，不许悬着', async () => {
    // 悬着的代价不是慢，是**永远**：浏览器那头所有重连逻辑等的都是「断」，
    // 而「断」不传下去，那条对话就只能靠人刷新。
    assert(r.ended, `席位死了 5 秒，下游还开着（endedBy=${r.endedBy}）——半死流又回来了`)
    assert(r.endedInMs < 3000, `「断」传下来花了 ${r.endedInMs}ms，太久`)
  })
}
