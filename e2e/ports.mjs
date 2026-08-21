/**
 * e2e 的端口分配。
 *
 * 以前每套用例在文件头写死一个数（18680、18780、18880…）。人挑数字迟早会撞，而撞
 * 上之后的现象**和真实原因毫无关系**：`migrate` 和 `ui-smoke` 都用 18680，migrate
 * 那套里有几条用例故意让进程起不来，某条断言先炸导致进程没停，于是 ui-smoke 的网关
 * 绑不上端口，`waitHttp` 探到的是那个残留进程——接着 23 条 UI 用例一起红，报的是
 * 「没画初始化页」。查到真因要绕一大圈。
 *
 * 现在向内核要：`listen(0)` 拿一个当下空闲的端口，记进 `taken` 免得同一次跑里重复
 * 分配。**关掉再交给子进程之间有一个窗口**，理论上能被别的进程抢走——但那种情况下
 * 子进程会绑失败并当场报错，而不是像上面那样安静地连到别人身上。要的就是这个区别。
 */
import { createServer } from 'node:net'

const taken = new Set()

/** 要一个空闲端口。 */
export async function freePort() {
  for (let i = 0; i < 50; i++) {
    const port = await new Promise((resolve, reject) => {
      const s = createServer()
      s.once('error', reject)
      s.listen(0, '127.0.0.1', () => {
        const p = s.address().port
        s.close(() => resolve(p))
      })
    })
    if (taken.has(port)) continue
    taken.add(port)
    return port
  }
  throw new Error('挑不到空闲端口')
}

/** 一次要几个（管家那套要网关、管家、bot、noVNC 四个）。 */
export async function freePorts(n) {
  const out = []
  for (let i = 0; i < n; i++) out.push(await freePort())
  return out
}
