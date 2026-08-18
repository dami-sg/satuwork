import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { bootConfig } from './config.ts'
import { run } from './run.ts'

/**
 * 机器时区。
 *
 * 部署机器一律是 Debian，时区归 systemd 的 `timedatectl` 管——所以这里做的事只有
 * 一件：把 Gateway 在心跳响应里带下来的期望时区，落成 `timedatectl set-timezone`。
 *
 * 为什么必须是机器这边做：Gateway 没有登录这台机器的凭据（那正是管家取代 SSH 的
 * 意义），能做的只有把期望值放进心跳响应。所以它和自升级是同一条路——**心跳驱动、
 * 最终收敛**，机器什么时候上线什么时候改。
 *
 * 心跳里同时自报**实际**时区。期望和实际分开上报，界面才说得清「指令下了」和
 * 「已经改上了」的区别；只报一个的话，改失败在界面上和改成功长得一模一样。
 *
 * **不重启席位。** 已经在跑的桌面和 bot 是在旧时区下起来的，libc 把时区缓存在进程
 * 里，改 `/etc/localtime` 追不上它们。而重启席位会掐断正在进行的会话和桌面——为了
 * 一个时区把人的活干断，代价比「等下次重新部署」大得多。所以这里只改系统时区，
 * 什么时候跟上由人决定（重新部署那个席位即可）。
 */

/** dryRun 下没有 timedatectl 也不该去动开发机的时区，用一份内存值顶替。 */
let fakeTimezone = ''
let lastError = ''

export const timezoneError = () => lastError

/**
 * 和 gateway/src/deploy.ts 的 normalizeTimezone 同一套口径。
 *
 * 两边各校验一次不是重复：这个值会变成 `timedatectl` 的参数和 `/usr/share/zoneinfo`
 * 底下的路径，而**它来自网络**——Gateway 校过什么，管家这边一个字都不该采信。
 */
function shaped(tz: string): boolean {
  return tz.length > 0 && tz.length <= 64 && /^[A-Za-z0-9+_-]+(\/[A-Za-z0-9+_-]+)*$/.test(tz) && !tz.includes('..')
}

/**
 * 这台机器现在是什么时区。
 *
 * 先看 `/etc/localtime` 指向哪儿——systemd 维护的就是这个符号链接，它是权威；
 * `/etc/timezone` 是 Debian 的老约定，可能和链接对不上（有人手工改过一边），
 * 所以只当兜底。两个都读不出来就报空，而不是编一个出来。
 */
export function currentTimezone(): string {
  if (bootConfig().dryRun) return fakeTimezone
  try {
    const target = readlinkSync('/etc/localtime')
    const hit = /zoneinfo\/(.+)$/.exec(target)
    if (hit?.[1] && shaped(hit[1])) return hit[1]
  } catch {
    /* 不是链接、或者根本没有这个文件：往下走兜底那条。 */
  }
  try {
    const tz = readFileSync('/etc/timezone', 'utf8').trim()
    if (shaped(tz)) return tz
  } catch {
    /* 两条都没有：这台机器答不上来，报空。 */
  }
  return ''
}

/**
 * 心跳响应里带了期望时区就去改。
 *
 * 空 = 没人指定过，**什么都不做**——不能把「没指定」理解成「改成 UTC」，那会在
 * 没人碰过时区的机器上凭空改掉它。
 */
export async function maybeSetTimezone(want: string | null | undefined): Promise<void> {
  const tz = (want || '').trim()
  if (!tz) {
    lastError = ''
    return
  }
  if (!shaped(tz)) {
    lastError = `timezone ${tz} is malformed`
    return
  }
  if (tz === currentTimezone()) {
    lastError = ''
    return
  }

  if (bootConfig().dryRun) {
    fakeTimezone = tz
    lastError = ''
    return
  }

  // 名字认不认识由这台机器上的 zoneinfo 说了算。少了这一条，一个装了半套 tzdata 的
  // 机器上 `timedatectl` 会报一句很难懂的错，而真正的原因是「这台机器上没有这个时区」。
  if (!existsSync(`/usr/share/zoneinfo/${tz}`)) {
    lastError = `timezone ${tz} is not in /usr/share/zoneinfo on this box`
    return
  }

  const r = await run('timedatectl', ['set-timezone', tz], { timeout: 30_000 })
  if (r.code !== 0) {
    lastError = `timedatectl set-timezone ${tz} failed: ${(r.stderr || r.stdout).replace(/\s+/g, ' ').trim().slice(-200)}`
    console.error('satuwork-manager: ' + lastError)
    return
  }
  lastError = ''
  console.log(`satuwork-manager: timezone -> ${tz}`)
}
