/**
 * 图片一路走到 provider 请求体里。探针在 bot/e2e-vision.mjs。
 *
 * 这条链上有**三处**会把用户消息拍成字符串（bot 的 toOpenAI / toAnthropic、Gateway 的
 * v1）。漏掉任何一处，图都是**安静地**消失——不报错、不告警，模型只是看不见它，然后
 * 一本正经地答一个跟图无关的答案。没有比这更难从现象倒推的坏法，所以三处各钉一遍。
 */
import { runProbe as sharedProbe } from './probe.mjs'

const runProbe = (root) => sharedProbe(root, 'bot/e2e-vision.mjs')

export async function runVision({ root, test, assert, log }) {
  log('\n# vision')
  let r
  await test('探针跑得完', async () => {
    r = await runProbe(root)
    assert(r && r.openai && r.anthropic && r.reasoningTransport && r.gatewayV1, `结果不完整：${JSON.stringify(r)}`)
  })

  await test('Bot → OpenAI：图片进 image_url 的 data URI', () => {
    assert(r.openai.是数组, 'user content 被拍成字符串了，图没了')
    assert(r.openai.有图, '没有 image_url')
    assert(r.openai.是dataURI, 'image_url 不是 data URI')
    assert(r.openai.带上了字节, 'data URI 里没有图片字节')
    assert(r.openai.正文还在, '带图之后正文丢了')
  })

  await test('Bot → Anthropic：图片进 source 对象', () => {
    assert(r.anthropic.是数组, 'user content 被拍成字符串了，图没了')
    // Anthropic 不认 data URI，塞过去只会换回一个 400。
    assert(r.anthropic.用source, '没有用 source 对象')
    assert(r.anthropic.媒体类型对 && r.anthropic.带上了字节, 'source 里的类型或字节不对')
    assert(r.anthropic.正文还在, '带图之后正文丢了')
  })

  await test('推理强度翻成 OpenAI 与 Anthropic 各自的请求参数', () => {
    const x = r.reasoningTransport
    assert(x.openai档位 && x.openai关闭时不发送, `OpenAI 推理参数不对：${JSON.stringify(x)}`)
    assert(x.anthropic档位 && x.anthropic给正文留空间 && x.anthropic关闭时不发送, `Anthropic thinking 参数不对：${JSON.stringify(x)}`)
  })

  await test('Gateway 的 /v1 不再把图拍平', () => {
    // 这一层最容易漏：Bot 那边发对了，到这儿再被 contentText() 拍成字符串，图照样没。
    assert(r.gatewayV1.是数组, 'Gateway 把 user content 拍成字符串了')
    assert(r.gatewayV1.有图 && r.gatewayV1.带上了字节, 'Gateway 丢了图片')
    assert(r.gatewayV1.媒体类型对, '媒体类型不对')
    assert(r.gatewayV1.正文还在, 'Gateway 丢了正文')
  })

  await test('远程图片 URL 不去取——那是 SSRF', () => {
    // 让 Gateway 去 fetch 一个别人给的 URL，等于把它变成打内网的跳板。
    assert(r.gatewaySsrf.没有图, 'Gateway 接受了远程 URL 形式的图片')
    assert(r.gatewaySsrf.没带出地址, '远程地址被带进了请求体')
  })

  await test('没有图的消息还是字符串，没被这次改动带胖', () => {
    // 绝大多数消息都没有图。为了统一形状让它们全变成数组，只会让请求体变大、
    // 抓包出来的东西变难认。
    assert(r.openaiPlain.还是字符串 && r.openaiPlain.值 === '你好', `OpenAI 纯文本被改形状了：${JSON.stringify(r.openaiPlain)}`)
    assert(r.anthropicPlain.还是字符串, 'Anthropic 纯文本被改形状了')
    assert(r.gatewayV1Plain.还是字符串, 'Gateway 纯文本被改形状了')
  })

  await test('历史里的图只有最近几张带字节，更早的降级成说明', () => {
    // 不加这道闸，历史里每张图每轮都要重新读盘、重新 base64、重新发给模型——开销随
    // 图片数线性涨且只增不减：十张 3 MB 的图就是每轮 30 MB 磁盘读加一两万 token。
    assert(r.window.用户消息数 === 6, `消息数不对：${r.window.用户消息数}`)
    assert(r.window.带字节的 === 4, `带字节的应为 4 张，实为 ${r.window.带字节的}`)
    assert(r.window.降级成说明的 === 2, `降级的应为 2 张，实为 ${r.window.降级成说明的}`)
    // 窗口必须开在**末尾**：人问的几乎总是刚发的那张。
    assert(r.window.最后一条带字节, '最近那张图反而没带字节')
    assert(r.window.第一条已降级, '最早那张图仍然带着字节')
  })

  await test('会话日志里存路径，不存 base64', () => {
    assert(r.logShape.存了路径, '事件里没有图片路径')
    // 一张 2 MB 的图 base64 之后是 2.7 MB。直接落进 JSONL，这一行就没法 grep、没法
    // tail，整条会话的重放还要把它再搬一遍。
    assert(r.logShape.没存base64, '图片字节被写进会话日志了')
    assert(r.logShape.一行够短, `事件行 ${r.logShape.一行够短} 太长了`)
    /**
     * **不钉死具体版本号。** image 块是 v4 加的，所以不能比 4 老；再往上是别人的事
     * （v5 加了 `mention` 块）。钉成 `=== 4` 的话，以后每加一种内容块都会让这一组
     * 无关的用例变红，而它想守的其实是「图这条路还在当前格式里成立」。
     */
    assert(r.formatVersion >= 4, `图片块是 v4 加的，版本不该比它老，实为 v${r.formatVersion}`)
  })
}
