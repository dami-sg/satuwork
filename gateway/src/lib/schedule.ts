/**
 * 「每天九点」是哪一刻：触发器 → 下一次的时间戳。
 *
 * 纯函数，不碰库也不碰网，因为它是整个日常任务里**最容易错、也最难当场看出错**的
 * 一段：算早了半小时没人会发现，算成明天同一时刻的人只会以为「今天没跑」。
 *
 * ## 为什么不用 cron 串
 *
 * 存的是 `{ every, at, weekday, day, tz }` 而不是 `0 21 * * *`。界面上那一行要能读成
 * 「每天 21:00」并且能改回去，cron 串每次都得解析一遍；而人写得出来的 cron 串远比
 * 这套结构能表达的多（步长、区间、月末那个 L），一旦存进去，界面就画不出来了——存一个
 * 自己画不出来的东西，等于承诺了一个做不到的编辑器。
 *
 * ## 时区
 *
 * 全部按**触发器自带的 tz** 算，不是服务器本地时间，也不是机器时区。做法是标准的
 * 两步逼近：先按「当成 UTC」估一个偏移，再用估出来的时刻取一次真实偏移。夏令时切换
 * 那两个小时里，第一次估出来的偏移可能是旧的，第二次就对了。
 */
import type { RoutineTrigger } from '../db.ts'

interface Parts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  weekday: number
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/**
 * 按时区缓存 formatter。`new Intl.DateTimeFormat` 是这条路上最贵的一步（要加载时区
 * 数据），而审计调度每个 tick 要对每家公司算上百个窗口边界，每个边界四次 partsIn——
 * 原来每次都新建一个。时区字符串的取值是有限的，缓存不会涨。
 */
const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterOf(tz: string): Intl.DateTimeFormat {
  const hit = formatters.get(tz)
  if (hit) return hit
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    // hourCycle 要写死：只给 hour12: false 的话，某些实现会把午夜给成「24 点」，
    // 而那个 24 点配的是**前一天**的日期，日历加减一步就全错位。
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  })
  formatters.set(tz, fmt)
  return fmt
}

/** 某个时刻在某个时区里是几点几分、星期几。 */
export function partsIn(tz: string, ms: number): Parts {
  const fmt = formatterOf(tz)
  const got: Record<string, string> = {}
  for (const p of fmt.formatToParts(new Date(ms))) got[p.type] = p.value
  return {
    year: Number(got.year),
    month: Number(got.month),
    day: Number(got.day),
    hour: Number(got.hour),
    minute: Number(got.minute),
    weekday: WEEKDAYS[got.weekday] ?? 0,
  }
}

/** 这个时区在这一刻比 UTC 快多少毫秒。 */
function offsetAt(tz: string, ms: number): number {
  const p = partsIn(tz, ms)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000
}

/**
 * 某个时区的**墙上时间** → 时间戳。
 *
 * 夏令时那天有两个坑，两个都只能认了、不能装作没有：往前跳的那一小时里，那个时刻
 * 根本不存在（跳过去之后的第一刻），往回拨的那一小时里有两个。这里的取法是「逼近之后
 * 落在哪儿算哪儿」——一年两天、只差一小时，比为它发明一套语义划算。
 */
export function fromZoned(tz: string, y: number, mo: number, d: number, h: number, mi: number): number {
  const asUtc = Date.UTC(y, mo - 1, d, h, mi)
  const guess = asUtc - offsetAt(tz, asUtc)
  return asUtc - offsetAt(tz, guess)
}

/** 日历上往后 n 天。**不是加 86400 秒**——夏令时那天的一天不是 24 小时。 */
function addDays(y: number, mo: number, d: number, n: number): { y: number; mo: number; d: number } {
  const t = new Date(Date.UTC(y, mo - 1, d + n))
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate() }
}

/** 这个月有几天。`month` 是 1..12。 */
function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate()
}

/**
 * 下一次什么时候跑。**严格大于 `from`**，不会算出「就是现在」——那会让调度器在同一
 * 秒里反复抢同一条。
 */
export function nextFireAt(trigger: RoutineTrigger, from: number): number {
  const tz = trigger.tz || 'UTC'
  const [h, mi] = trigger.at.split(':').map((x) => Number(x))
  const now = partsIn(tz, from)
  if (trigger.every === 'hour') {
    // 只认分钟：本小时的那一分钟过了就下一小时。整点加减一小时不能在墙上时间里做
    // （夏令时那天会多出或少掉一小时），所以直接在时间戳上加。
    //
    // **加一次不够，要加到真的过了 `from` 为止。** 夏令时回拨那一小时里同一个墙上
    // 时刻出现两遍，`fromZoned` 解析到的是**第一遍**；`from` 落在第二遍里的时候，
    // 加一小时仍然可能还在过去。返回一个过去的时间戳，调度器就会每一轮都判它到点、
    // 抢到、跑一次——那一小时里反复跑，每次都是一轮真的模型调用。
    let at = fromZoned(tz, now.year, now.month, now.day, now.hour, mi)
    while (at <= from) at += 3_600_000
    return at
  }
  if (trigger.every === 'day') {
    const today = fromZoned(tz, now.year, now.month, now.day, h, mi)
    if (today > from) return today
    const next = addDays(now.year, now.month, now.day, 1)
    return fromZoned(tz, next.y, next.mo, next.d, h, mi)
  }
  if (trigger.every === 'week') {
    const want = trigger.weekday
    // 先算「今天那个点」，再按星期差往后推整天数。推的是**日历上的天**，不是
    // 86400 秒——夏令时那周差一小时，按秒推会让每周一的九点变成八点。
    const cur = fromZoned(tz, now.year, now.month, now.day, h, mi)
    let delta = (want - now.weekday + 7) % 7
    if (delta === 0 && cur <= from) delta = 7
    const at = addDays(now.year, now.month, now.day, delta)
    return fromZoned(tz, at.y, at.mo, at.d, h, mi)
  }
  // 每月。**该月没有这一天就落在最后一天**：31 号的任务在二月不该整月不跑，
  // 而「跳过」和「28 号跑」之间，后者才是人设它的本意。
  let y = now.year
  let mo = now.month
  for (let i = 0; i < 60; i++) {
    const d = Math.min(trigger.day, daysInMonth(y, mo))
    const at = fromZoned(tz, y, mo, d, h, mi)
    if (at > from) return at
    mo++
    if (mo > 12) {
      mo = 1
      y++
    }
  }
  // 走不到这儿：上面那圈最多找五年。真走到了说明触发器坏了，报一个「不排」。
  return 0
}

/**
 * 这条任务的下一次。停用、没触发器、算不出来都返回 null——库里那一列的 null 就是
 * 「不排」，调度器的查询直接把它们滤掉了。
 */
export function nextRunAtOf(input: { active: boolean; triggers: RoutineTrigger[] }, from = Date.now()): number | null {
  if (!input.active || !input.triggers.length) return null
  let best = 0
  for (const trigger of input.triggers) {
    const at = nextFireAt(trigger, from)
    if (at > 0 && (best === 0 || at < best)) best = at
  }
  return best || null
}
