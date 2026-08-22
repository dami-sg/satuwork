/**
 * 浏览器那几把工具的判据。**纯函数**，不碰 CDP 也不碰上下文——策略要在工具执行的
 * 关键路径上调它们，一次超时就是一次卡住的对话（和 shell.ts 同一条理由）。
 *
 * 两件事：
 *
 *  1. 这个地址能不能开（硬黑名单 + 公司白名单）
 *  2. 这次动作算不算「提交」，要不要人拍板
 */

/** 只走 http/https。file:// 能读整块盘，chrome:// 和 devtools:// 能改浏览器自己。 */
const SCHEME = /^https?:$/

/**
 * 这些后缀指的都是这台机器或这个内网。
 *
 * 和 Gateway 那份 LOCAL_SUFFIX 是同一套（gateway/src/lib/catalog.ts），改一边就要改
 * 另一边——两个包各自打包，中间没有共享类型。
 */
const LOCAL_SUFFIX = ['.local', '.localhost', '.internal', '.home.arpa']

/**
 * 取主机名。**用 URL 解析，不用正则切**——`https://evil.com@127.0.0.1/` 这种写法里，
 * 正则切出来的是 `evil.com`，而浏览器真正会去连的是 `127.0.0.1`。判错方向恰好是最坏
 * 的那个方向。
 */
export function hostOf(url: string): string | null {
  try {
    const u = new URL(String(url || '').trim())
    if (!SCHEME.test(u.protocol)) return null
    // IPv6 字面量带方括号，去掉再判。
    return u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

function ipv4Private(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  if (a === 127 || a === 0 || a === 10) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  // 169.254/16 里住着云厂商的 metadata（169.254.169.254），那是一把机器凭据。
  if (a === 169 && b === 254) return true
  // 100.64/10（CGNAT，Tailscale 这类）也不是「外部系统」。
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

function ipv6Private(host: string): boolean {
  if (!host.includes(':')) return false
  if (host === '::1' || host === '::') return true
  // fc00::/7 唯一本地地址、fe80::/10 链路本地。
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true
  // ::ffff:127.0.0.1 这类映射写法：把后面那截 IPv4 拿出来再判一次。
  const mapped = /:((?:\d{1,3}\.){3}\d{1,3})$/.exec(host)
  if (mapped && ipv4Private(mapped[1])) return true
  return false
}

/**
 * 这个主机**永远**不许打开，不受任何开关控制。
 *
 * 拦的不是「越权访问外部系统」——那是 no-external 那条开关的事，它可以被管理员关掉。
 * 这里防的是**用浏览器回头打自己**：席位上听着 bot 口（3200+N）、CDP 口（9222+N）和
 * 管家的口，src/guard/index.ts 顶上那段注释已经为「员工在桌面里打得到
 * 127.0.0.1:<botPort>」删过一整套账号体系。从浏览器这边把同一个洞再开一次，Bot 就能
 * 给自己发指令、读自己的席位票、或者直接跟管家说话。
 *
 * 返回一句给人看的话，没问题时返回 null。
 */
export function blockedHost(host: string | null): string | null {
  if (!host) return '只能打开 http / https 的地址'
  if (host === 'localhost' || host.endsWith('.localhost')) return '本机地址不许打开'
  if (LOCAL_SUFFIX.some((suffix) => host.endsWith(suffix))) return '内网地址不许打开'
  if (ipv4Private(host) || ipv6Private(host)) return '本机或内网地址不许打开'
  /**
   * **不带点的主机名一律拒。** 内网里的机器多半就叫 `gitlab`、`nas`、`erp` 这样一个词，
   * 靠 DNS 搜索域补全出全名——那正是一条绕开上面全部判据的路。
   */
  if (!host.includes('.')) return '认不出这是哪个站点（主机名里没有域名）'
  return null
}

/**
 * 一条带 `*` 的站点 → 正则。
 *
 * **`*` 只在一段标签之内顶字符，不跨点。** 这是整条通配符设计的全部安全性所在：跨点的话
 * `*.com` 就等于整个互联网，而它在界面上看起来只是一条普通的白名单。所以 `*` 展开成
 * `[a-z0-9-]+`（域名标签的字符集），点保持是点。
 *
 * 顺带一条：**至少配一个字符**，不是零个。`*.example.com` 不该把 `.example.com` 或者
 * `example.com` 本身算进去——想连自己一起覆盖就写裸域名，那是另一种写法，语义更宽也更
 * 直白。
 */
function wildcardRe(site: string): RegExp {
  const body = site
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[a-z0-9-]+')
  return new RegExp(`^${body}$`)
}

/**
 * 这个主机在公司白名单里吗。两种写法：
 *
 * - **裸域名含子域**：`example.com` 覆盖它自己和 `app.example.com`。SaaS 在 `login.` /
 *   `app.` / `api.` 之间来回跳是常态，逐个子域列一定会漏，而漏掉的表现是任务跑到一半
 *   被拦在半路。反过来不成立：写 `app.example.com` 不会放行 `example.com`，更不会放行
 *   `evil-example.com`（`endsWith` 前面那个点就是为它加的）。
 * - **带 `*` 的按字面配**，不再额外含子域：`*.example.com` 就是「任意一段 +
 *   .example.com」，配得上 `app.example.com`，配不上 `a.b.example.com`，也配不上
 *   `example.com` 自己。写得越具体，覆盖面越窄——这条顺序不能反过来。
 *
 * 白名单本身在 Gateway 那边过 `botSiteOf`，`*.com` 这类进不来（要求至少两段钉死）。
 * 但这里**不假设**它一定过过那道关：名单是从目录同步下来的，而同步下来的东西不该被
 * 当成已经验过。`[a-z0-9-]+` 不跨点这一条，在这儿是独立成立的。
 */
export function siteAllowed(host: string, sites: readonly string[]): boolean {
  for (const raw of sites) {
    const site = String(raw || '').trim().toLowerCase()
    if (!site) continue
    if (site.includes('*')) {
      if (wildcardRe(site).test(host)) return true
      continue
    }
    if (host === site) return true
    if (host.endsWith(`.${site}`)) return true
  }
  return false
}

/** 这次动作作用在什么东西上。由浏览器服务提供，策略只读不写。 */
export interface ActionContext {
  /** 目标元素的可访问名（按钮上印的字）。取不到就没有这一项。 */
  label?: string
  /** 目标元素的角色（button / link / textbox…）。 */
  role?: string
  /** 这次 browser_dialog 面对的是哪种原生对话框。 */
  dialog?: 'alert' | 'confirm' | 'prompt' | 'beforeunload'
  /** 当前页面地址。没有 url 参数的那几把工具靠它判域名。 */
  url?: string
}

/**
 * 按钮上印着这些字，就当它是一次提交。
 *
 * 覆盖界面上那句「对外发送、改写数据或付款前先征求同意」说的三件事：发送、改写、付钱。
 */
/**
 * 这几种角色没名字时不弹卡。
 *
 * 一个没文字的链接、菜单项、复选框，点下去最多是换一页或者改个勾选状态；而一个没文字的
 * **按钮**很可能就是那个只有垃圾桶图标的删除键。角色本身认不出来的更要问——见 submitAction。
 */
const SAFE_UNNAMED_ROLES = new Set(['link', 'menuitem', 'tab', 'option', 'checkbox', 'radio', 'switch'])

const SUBMIT_WORDS =
  /(提交|发送|发出|保存|确认|确定|删除|移除|清空|支付|付款|下单|购买|结算|转账|申请|批准|同意|发布|上传|注销|退订|归档|submit|send|save|confirm|delete|remove|pay|checkout|order|buy|purchase|publish|post|upload|apply|approve|transfer|archive)/i

function argsOf(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}')
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** 回车这几种写法都算。 */
const ENTER = /^(enter|numpadenter|return)$/i

/**
 * 这次浏览器动作要不要人拍板；要的话返回**为什么**（那句话会印在卡片上）。
 *
 * **不能照 `external + write` 直接判。** `browser_click` 正好是这个组合，照着判的结果
 * 是每一次点击都弹一张卡片——那不是收紧边界，那是让人学会闭眼点批准（needsApproval
 * 里给 bash 单开一条分支时写过同一件事）。
 *
 * 所以只认「看起来像提交」的那几种。**这是启发式，一定会漏**——一个写着「下一步」的
 * 按钮就漏了。漏掉的那次靠事后审计兜（策略在动作完成后记一条非幂等请求），不是靠把
 * 这份词表越堆越长：堆到最后就是每次点击都弹卡，绕回它一开始要避开的那件事。
 */
export function submitAction(tool: string, rawArgs: string, cx: ActionContext | undefined): string | null {
  const args = argsOf(rawArgs)
  const label = String(cx?.label ?? '').trim()
  const named = label ? `「${label}」` : ''

  if (tool === 'browser_type') {
    // submit=true 就是「填完直接回车」，和点提交按钮是同一件事。
    if (args.submit === true) return `在${named || '这个输入框'}里填完直接提交`
    return null
  }
  if (tool === 'browser_press') {
    /**
     * 回车要确认，尽管它常常只是搜索框里的一次搜索。
     *
     * 放过它的话，`browser_type(submit:true)` 要确认而「先 type 再 press Enter」不要——
     * 同一件事换个写法就绕过去了，而模型换写法不需要任何恶意，它本来就在试各种写法。
     * 多出来的那几张卡片由「这一轮都批准」消化。
     */
    if (ENTER.test(String(args.key ?? ''))) return '在页面上按回车提交'
    return null
  }
  if (tool === 'browser_dialog') {
    // alert 只有一个「知道了」，点掉它什么也没发生。confirm / beforeunload 不一样：
    // 那一下「确定」正是不可逆的那一下。
    if (args.action !== 'accept') return null
    if (cx?.dialog === 'confirm' || cx?.dialog === 'beforeunload') return '接受页面弹出的确认框'
    return null
  }
  if (tool === 'browser_click') {
    /**
     * **认不出来就问。**
     *
     * 先写的是「没名字就放行」，那是个真洞：企业后台里的删除按钮常常只有一个垃圾桶
     * 图标，既没有文字也没有 aria-label，快照里就是 `- button "" [@e12]`。照那条规则，
     * 一次不可逆的删除**一张卡片都不会弹**。
     *
     * 所以反过来：叫不出名字的按钮要问一句「它会做什么」。链接和菜单项几乎总有文字，
     * 真正落到这条上的就是图标按钮那一小撮，多出来的卡片由「这一轮都批准」消化。
     */
    if (!label) {
      const role = String(cx?.role ?? '')
      // 有名字才算数的那几种角色：它们没名字时点下去也不会提交什么（多半就是个空链接）。
      // 反过来，**角色都认不出来**（ref 不在上一次快照里）时不能当成安全——那正是最
      // 看不清的一种情况。
      if (role && SAFE_UNNAMED_ROLES.has(role)) return null
      return '点一个看不出会做什么的元素（它在快照里没有名字）'
    }
    if (!SUBMIT_WORDS.test(label)) return null
    return `点${named}`
  }
  return null
}
