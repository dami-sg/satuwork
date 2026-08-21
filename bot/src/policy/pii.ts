/**
 * 个人敏感信息的识别。
 *
 * **只认三样：手机号、身份证号、银行卡号。** 界面上那句说明写的就是这三样
 * （见 gateway/ui/prefs.js 的 DEFAULT_BOT_GUARDS）。邮箱**不在内**，而且是有意的：
 * 连接器发一封邮件、查一个联系人，收件地址本来就是参数，把它算进去这条边界一开，
 * 邮件类的连接器就整个不能用了——那不是收紧，是关掉。
 *
 * **每一种都带校验位。** 纯正则会把订单号、时间戳、跟单号一起判成身份证；而这条
 * 边界只要误伤过一次，用户学到的就是「把这个开关关掉」——那比一开始就没有它更糟。
 */
export type PiiKind = '手机号' | '身份证号' | '银行卡号'

/** 中国大陆手机号：1 开头、第二位 3–9、共 11 位，且前后不能再接数字。 */
const PHONE = /(?<!\d)1[3-9]\d{9}(?!\d)/g

/** 身份证：17 位数字 + 1 位校验位（数字或 X）。 */
const ID_CARD = /(?<!\d)\d{17}[\dXx](?![\dA-Za-z])/g

/**
 * 银行卡候选：**15–19 位**。
 *
 * 不从 13 位起，是为了躲开毫秒时间戳（13 位）——随机 13 位数里大约十分之一能过
 * Luhn，而工具参数里出现时间戳是家常便饭。代价是极少数 13/14 位的老卡号认不出来；
 * 这个方向的错宁可犯：漏判一次是这条边界没帮上忙，误判一次是它开始碍事。
 */
const CARD = /(?<!\d)\d{15,19}(?!\d)/g

const ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const ID_CHECKS = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2']

function validIdCard(value: string): boolean {
  let sum = 0
  for (let i = 0; i < 17; i++) sum += Number(value[i]) * ID_WEIGHTS[i]
  return ID_CHECKS[sum % 11] === value[17].toUpperCase()
}

function luhn(value: string): boolean {
  let sum = 0
  let double = false
  for (let i = value.length - 1; i >= 0; i--) {
    let digit = Number(value[i])
    if (double) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    sum += digit
    double = !double
  }
  return sum % 10 === 0
}

/**
 * 这段文字里有哪几类敏感信息。
 *
 * **返回类别，不返回值本身。** 命中的原文一个字都不往外带：拒绝的那句话会进模型的
 * 上下文、也会进会话日志和审计，把刚拦下来的号码原样抄进去，等于挡了一道门、又从
 * 窗户递出去。
 */
export function scanPii(text: string): PiiKind[] {
  const src = String(text ?? '')
  if (!src) return []
  const hits = new Set<PiiKind>()
  /**
   * 身份证先扫：它的 18 位里含着一个 17 位数字段，先扫银行卡会把它认成卡号。
   *
   * **候选和「验过的」必须分开两个数组。** 早先这里只有一个 `ids`，装的是全部候选
   * （含校验位不过的），而下面银行卡那一圈又拿它当「这个已经认过了，跳过」的名单——
   * 于是一个 18 位的卡号先被身份证的正则捞进候选、校验位一算不是身份证、接着又被当成
   * 「已经认过」跳掉，Luhn 根本没机会跑。实测 `622700000000000004`（18 位、过 Luhn）
   * 扫出来是空的，而 15/16/17/19 位都正常——**唯独 18 位的卡号一张都拦不住**。
   */
  const candidates: string[] = src.match(ID_CARD) ?? []
  const ids: string[] = []
  for (const value of candidates) {
    if (!validIdCard(value)) continue
    hits.add('身份证号')
    ids.push(value)
  }
  for (const value of src.match(PHONE) ?? []) {
    // 落在某个身份证号里的 11 位数字不是手机号。
    if (ids.some((id) => id.includes(value))) continue
    hits.add('手机号')
  }
  for (const value of src.match(CARD) ?? []) {
    // 跳过的只能是**验过的**身份证：它已经按身份证记上了，不该再算一次卡号。
    if (ids.includes(value)) continue
    if (luhn(value)) hits.add('银行卡号')
  }
  return [...hits]
}
