/**
 * 真实组合里，该在的服务和工具在不在。探针在 bot/e2e-mounted.mjs。
 *
 * 补一次事故补出来的：`BrowserService` 上写了 `static inject = ['logger']`，而 logger
 * 根本不是服务——那条 inject 永远满足不了，服务不启动，依赖它的十二把工具跟着一直挂着。
 * **一声不响**：进程起来了、健康检查通过、类型检查干净、日志一个字都没有，只有模型在
 * 对话里说「我没有这个功能」。
 *
 * 别的套件都测不到这一类：它们各自 `ctx.plugin(服务)` 手动挂，**绕过了 inject**。
 * 真正的组合只发生在 Loader 读 cordis.yml 那一刻。
 */
import { rmSync } from 'node:fs'
import { runProbe as sharedProbe } from './probe.mjs'

const HOME = '/tmp/satuwork-e2e-mounted'

/**
 * **每次从干净的目录起。**
 *
 * 一个专门回答「组合对不对」的套件，带着上一次跑剩的库和名册跑，本身就拆了自己的
 * 前提。ui-smoke 那边也是先删再起。
 */
const runProbe = (root) => {
  rmSync(HOME, { recursive: true, force: true })
  return sharedProbe(root, 'bot/e2e-mounted.mjs', { env: { SATUWORK_HOME: HOME, SATUWORK_PORT: '18124' }, timeout: 40_000 })
}

export async function runMounted({ root, test, assert, log }) {
  log('\n# mounted')
  const r = await runProbe(root)

  await test('cordis.yml 里挂的服务，一个不少地起来了', () => {
    /**
     * 挂不上的插件**不会报错，只会一直挂着**（cordis 的 inject 就是这个语义）。
     * 所以这条断言看的是「起来了没有」，不是「有没有出错」——后者永远是没有。
     */
    const down = Object.entries(r.provided).filter(([, ok]) => !ok).map(([k]) => k)
    // 带上等了多久：探针轮询到 25 秒才放弃，报出来才分得清「真挂不上」和「机器太慢」。
    assert(!down.length, `这几个服务没起来（多半是它们的 inject 满足不了，等了 ${r.waited} ms）：${down.join('、')}`)
  })

  await test('reflect 那几条接缝，在真实组合里够得着而且对面有方法', () => {
    /**
     * 策略要在工具执行的关键路径上够到 catalog / agents / browser，浏览器服务要够到
     * workspace——四处都是 `reflect.get('名字') as 某个形状`，**类型检查一个字都看不见**。
     * 写错名字、对面删了方法、或者那个服务压根没起来，`tsc` 全都不响。
     *
     * 运行时的样子还特别难认：够不到 browser 的话，每一次 click 都会因为拿不到当前页
     * 地址而被判成「还没有打开任何页面」——和真的没打开页面一模一样。
     *
     * guards 那个套件够不到这一层：它给 browser / catalog 塞的是替身，接缝那一步被
     * 绕过去了。（catalog 那条早先就单独钉过一次，理由一样。）
     */
    const bad = Object.entries(r.seams).filter(([, ok]) => !ok).map(([k]) => k)
    assert(!bad.length, `这几条接缝断了：${bad.join('、')}`)
  })

  await test('工具表和 cordis.yml 对得上：一把不少，也没有多出来的', () => {
    // 少一把的代价是模型说「我没有这个功能」，而所有别的信号都是绿的——那正是这条
    // 断言存在的全部理由。多出来的也要管：一把没进过名单的工具是没被审视过的工具。
    assert(!r.missing.length, `少了这几把工具（等了 ${r.waited} ms）：${r.missing.join('、')}`)
    assert(!r.extra.length, `多了这几把没在名单里的工具：${r.extra.join('、')}`)
  })
}
