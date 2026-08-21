import { Service, type Context } from '@deepseek-ai/cordis'
import { guardsOf, type BotRecord } from '../registry/index.ts'
import type { ToolCall, ToolResult } from '../tools/index.ts'
import { ApprovalGate, type Verdict } from './approvals.ts'
import { formOf, unwrapCall } from './forms.ts'
import { scanPii } from './pii.ts'
import { destructiveCommand, networkCommand } from './shell.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    policy: PolicyService
  }
  interface Events {
    /**
     * 一次边界表态。审计上报挂在这里（见 session/gateway.ts），策略自己不发网络请求——
     * 它跑在工具执行的关键路径上，一次超时就是一次卡住的对话。
     */
    'policy/decision'(decision: PolicyDecision): void
  }
}

/** 三个开关的 id。和 Gateway 的 BOT_GUARD_IDS 是同一套键，改一边就要改另一边。 */
export type GuardId = 'high-risk' | 'pii' | 'no-external'

export interface PolicyDecision {
  sessionId: string
  botId: string
  callId: string
  tool: string
  guard: GuardId | 'escalate'
  outcome: 'blocked' | 'approved' | 'denied' | 'timeout' | 'redacted' | 'escalated'
  reason: string
  at: number
}

/**
 * 行为边界的执行点。
 *
 * **落在 `tools/pre-execute` 上，不落在提示词里。** 提示词里写「付款前先问一句」只是
 * 建议：模型可以照做，也可以不照做，而一次不照做就是一封已经发出去的邮件。真正的
 * 边界是这里——短路了它就没跑，跟模型怎么想没有关系（见 tools/index.ts 顶上的说明）。
 *
 * 三条开关来自公司模版，随目录同步下发到席位（catalog → roster.pin → BotRecord.guards）。
 * 模版一改，版本号 +1，这台席位一分钟内跟上，不需要为「边界生效」另造一条同步通道。
 *
 * 这个插件**不叫 guard**：`src/guard/index.ts` 是入站席位票的闸门，两件事同名只会让
 * 下一个人在错误的文件里找错误的东西。
 */
export class PolicyService extends Service {
  static inject = ['tools', 'sessions', 'roster']

  /** 高风险确认的往返。web/index.ts 那两条路由和它说话。 */
  readonly approvals: ApprovalGate

  /**
   * 这一轮里被挡下了几次。轮首清零（听 turn/start）。
   *
   * 存在的理由：模型撞墙之后的默认反应是换个写法再试一遍，而边界不会因为写法变了就
   * 放行。连着撞几次还没绕出去，说明这件事**本来就需要人**——那时候该做的是转人工，
   * 不是让它在步数硬顶里把剩下的一百步走完。
   */
  private blocks = new Map<string, number>()

  /**
   * 会话 → 它属于哪颗 Bot。**记住，不要每次都去读日志。**
   *
   * `sessions.events()` 返回的是整份事件数组的 `slice()`（见 session/index.ts），而这
   * 条路每次工具调用都要走一遍——一条只增不减的长会话攒到几万条之后，光是为了读第一条
   * 里的 botId，每次调用都要复制一遍整个数组，而且是在决定「三个开关开没开」之前。
   * 会话根事件写下就不再变，所以认一次就够。
   */
  private botIds = new Map<string, string>()

  constructor(ctx: Context) {
    super(ctx, 'policy')
    this.approvals = new ApprovalGate(ctx)
    ctx.on('session/event', (sessionId: string, event: { type: string }) => {
      // 轮首清零。不清的话，一整条长会话累计几次之后，每一次拦截都会带上转人工那句话。
      if (event.type === 'turn/start') {
        this.blocks.delete(sessionId)
        // 轮首也清一次：上一轮要是在中途硬死过，它的 turn/end 根本没写下来。
        this.approvals.clearTurn(sessionId)
      }
      /**
       * **「这一轮都批准」和「这一轮别再试了」都到这儿为止。**
       *
       * 一个 Bot 一辈子只有一条会话（registry 的 ensureSession），所以按会话记的名单
       * 等于永久生效——而按钮上写的是「这一轮」。范围必须跟着轮次收口，不然那两颗按钮
       * 就是在说一件它们做不到的事。
       */
      if (event.type === 'turn/end') this.approvals.clearTurn(sessionId)
    })
  }

  /** 连着被挡几次就该转人工。三次：够排除「第一次写错参数」，又不至于让它撞满一轮。 */
  static readonly ESCALATE_AFTER = 3

  /**
   * 这次调用要不要人拍板；要的话返回**为什么**（那句话会印在卡片上）。
   *
   * 三条判据，从严到宽：
   *
   *  1. `bash` 单独看命令。它的 risk 是最坏情况的并集（写 + 毁 + 外联），照着并集
   *     判的话每一条 `ls` 都要弹一张卡片——那不是收紧边界，那是让人学会闭眼点批准。
   *  2. 能不可逆地毁东西的，一律要。
   *  3. **对外的写**要（发邮件、改远端记录、付款）。工作区里的 write / edit 不要：
   *     那是 Bot 干活的常态，界面上那句「对外发送、改写数据或付款前先征求同意」
   *     说的也是对外那一侧。
   */
  needsApproval(call: ToolCall, risk: readonly string[]): string | null {
    if (call.name === 'bash') {
      const hit = destructiveCommand(call.arguments)
      return hit ? `这条命令会不可逆地改动系统（${hit}）` : null
    }
    /**
     * 话里说的是**剥壳之后**那把工具。
     *
     * 连接器工具太多时它们会收进 `SW_RUN`，真正的工具名在参数里。照着壳的名字写，
     * 卡片上就是「mcp_github_default_sw_run 会往外部系统写入或发送内容」——人看不出
     * 自己在批什么，而这张卡片除了「让人看清楚」没有别的用处。
     */
    const tool = unwrapCall(call).tool
    if (risk.includes('destructive')) return `${tool} 可能不可逆地删除或覆盖数据`
    if (risk.includes('external') && risk.includes('write')) return `${tool} 会往外部系统写入或发送内容`
    return null
  }

  /**
   * 这条会话属于哪颗 Bot。
   *
   * 从会话根事件读 botId 再查名册——**不信调用方**：`ToolCall` 上只有 sessionId，
   * 那是执行管道给的，模型改不了；而 botId 决定了适用哪一份边界，让它从别处进来
   * 就等于让模型自己挑一份宽松的。
   */
  async botOf(sessionId: string): Promise<BotRecord | undefined> {
    if (!sessionId) return undefined
    const known = this.botIds.get(sessionId)
    // 名册那一份是现取的：模版改了、Bot 停用了，下一次调用就该按新的算。
    // 记住的只有「这条会话属于谁」，那一件事不会变。
    if (known) return this.ctx.roster.get(known)
    try {
      const events = await this.ctx.sessions.events(sessionId)
      const root = events.find((e) => e.type === 'session')
      const data = root?.data as { botId?: string; agentId?: string } | undefined
      const botId = data?.botId ?? data?.agentId
      if (!botId) return undefined
      this.botIds.set(sessionId, botId)
      return this.ctx.roster.get(botId)
    } catch {
      // 读不到会话（文件被删、id 是编的）：按**没有 Bot** 走，下面 guardsOf 会回落
      // 到全开。宁可多拦，不能因为读不到日志就把边界一起松掉。**不记进缓存**：
      // 下一次还要再试一遍，一次读盘失败不该把这条会话永远钉在「认不出」上。
      return undefined
    }
  }

  guardsOf(bot: BotRecord | undefined): Record<string, boolean> {
    return guardsOf(bot)
  }

  /**
   * 这一轮被 `@` 点名的连接。点名会让 `mentionOnly` 的连接进这一轮的工具表，
   * 所以它也得算进「允许的外部系统」里，否则点了名照样被拦。
   *
   * 走 `reflect.get` 而不是 inject：`agents` 那边 inject 了 `catalog`，而这里要在
   * 工具执行的路径上被调到，静态依赖绕回去两边都起不来。取不到就当没点名。
   */
  private mentioned(sessionId: string): Set<string> {
    try {
      const agents = (this.ctx as unknown as { reflect?: { get?: (name: string) => unknown } }).reflect?.get?.(
        'agents',
      ) as { mentionedIn?: (id: string) => Set<string> | undefined } | undefined
      return agents?.mentionedIn?.(sessionId) ?? new Set<string>()
    } catch {
      return new Set<string>()
    }
  }

  /** 工具名 → MCP 服务器 id。同样走 reflect：catalog 可能还没起来。 */
  private serverOf(toolName: string): string | undefined {
    try {
      const catalog = (this.ctx as unknown as { reflect?: { get?: (name: string) => unknown } }).reflect?.get?.(
        'catalog',
      ) as { serverOf?: (name: string) => string | undefined } | undefined
      return catalog?.serverOf?.(toolName)
    } catch {
      return undefined
    }
  }

  /**
   * 「禁止访问未授权的外部系统」。
   *
   * 允许集合 = 这颗 Bot 挂上的 MCP（模版里勾的那些）∪ 这一轮点名的连接。
   *
   * 注意这**不是** `toolSchemasFor()` 那一层的重复：那一层只决定「工具表里出现谁」，
   * 是遮掩不是强制——模型直接报一个没在表里的名字照样能调到。这里才是拦。
   */
  checkExternal(bot: BotRecord | undefined, call: ToolCall): { ok: true } | { ok: false; reason: string } {
    const name = call.name
    if (name.startsWith('mcp_')) {
      const serverId = this.serverOf(name)
      // 认不出属于哪台服务器：拒。这只可能是目录刚卸掉它、而模型还攥着上一轮的工具表。
      if (!serverId) return { ok: false, reason: `${name} 不属于任何已授权的 MCP 服务器` }
      /**
       * **查不到 Bot 就拒。**
       *
       * 这里以前写的是 `bot?.mcps === undefined → 放行`，本意是「本机自建的 Bot 没有
       * 模版管它」。但 `bot` 自己是 undefined 时（会话根事件读不到、名册里没有这颗
       * Bot、botId 是上一版留下的）走的是同一条分支——于是最该保守的那几种情况反而
       * 一路放行。缺省必须是全拦，`local` 是那条**明写出来**的例外。
       */
      if (!bot) return { ok: false, reason: `认不出这条会话属于哪个 Bot，不能确认 ${name} 是否被授权` }
      const assigned = bot.mcps
      if (assigned === undefined) {
        // 本机自建：没有公司模版，也就没有「授权名单」这回事。
        if (bot.origin === 'local') return { ok: true }
        this.ctx.logger?.warn?.(`policy: ${bot.id} 是公司 Bot 却没有 mcps 名单，按未授权处理`)
        return { ok: false, reason: `这个 Bot 还没拿到外部系统的授权名单` }
      }
      if (assigned.includes(serverId)) return { ok: true }
      if (this.mentioned(call.sessionId).has(serverId)) return { ok: true }
      return { ok: false, reason: `这个 Bot 没有被授权使用 ${name} 所在的外部系统` }
    }
    /**
     * 网页搜索与抓取：**放行**。
     *
     * 它们的出口在 Gateway（`/runtime/web/*`），密钥也在那边，席位这侧拿不到任何
     * 凭据；平台开没开这项能力由平台决定。把它算成「未授权的外部系统」，这条边界
     * 一打开 Bot 就查不了任何资料，而那跟「别碰没授权的业务系统」不是一回事。
     */
    if (name === 'web_search' || name === 'web_extract') return { ok: true }
    if (name === 'bash') {
      const hit = networkCommand(call.arguments)
      if (hit) return { ok: false, reason: `命令里的 ${hit} 会连到外部网络` }
      return { ok: true }
    }
    // 到这儿还带 external 的，是一把没人认识的工具（UNKNOWN_RISK 兜底的那种）。
    return { ok: false, reason: `${name} 会访问外部系统，而它不在已授权的名单里` }
  }

  /**
   * 记一笔并生成给模型看的那句话。
   *
   * `failed: true` 是有意的：`ToolResult.failed` 的定义里就写着「执行前被拒」算管道层
   * 失败。文本要说清楚**是什么挡的、下一步能干什么**——模型读到一句没有出路的拒绝，
   * 多半会原样再调一次，然后在步数硬顶里空转到底。
   */
  async deny(call: ToolCall, bot: BotRecord | undefined, guard: GuardId, reason: string, hint: string): Promise<ToolResult> {
    await this.record({
      sessionId: call.sessionId,
      botId: bot?.id ?? '',
      callId: call.callId,
      tool: call.name,
      guard,
      outcome: 'blocked',
      reason,
      at: Date.now(),
    })
    const hits = (this.blocks.get(call.sessionId) ?? 0) + 1
    this.blocks.set(call.sessionId, hits)
    let tail = ''
    if (hits >= PolicyService.ESCALATE_AFTER) {
      tail =
        `\n\n这一轮已经被挡下 ${hits} 次了。别再换写法重试——这件事需要人来处理：` +
        `调用 escalate_to_human 说明卡在哪儿，然后停下来等人接手。`
      await this.record({
        sessionId: call.sessionId,
        botId: bot?.id ?? '',
        callId: call.callId,
        tool: call.name,
        guard: 'escalate',
        outcome: 'escalated',
        reason: `这一轮连着被边界挡下 ${hits} 次`,
        at: Date.now(),
      })
    }
    return { text: `这次调用被公司的行为边界挡下了：${reason}。${hint}${tail}`, failed: true }
  }

  /** 落一条会话事件 + 广播。审计上报由监听者去做，策略自己不碰网络。 */
  async record(decision: PolicyDecision): Promise<void> {
    try {
      await this.ctx.sessions.append(decision.sessionId, 'tool/policy', {
        callId: decision.callId,
        name: decision.tool,
        guard: decision.guard,
        outcome: decision.outcome,
        reason: decision.reason,
      })
    } catch (e) {
      // 会话写不进去也不能让这次拦截失效——拦是拦住了，只是这条记录没留下。
      this.ctx.logger?.warn?.(`policy: 记录失败 ${(e as Error).message}`)
    }
    this.ctx.emit('policy/decision', decision)
  }
}

export const name = 'satu-policy'
export const inject = ['tools', 'sessions', 'roster']

export function apply(ctx: Context) {
  ctx.plugin(PolicyService)

  ctx.inject(['policy'], (ctx: Context) => {
    /**
     * 转人工。
     *
     * **必须是一把工具，不能只是提示词里的一句话。** 提示词能让模型「说」它要转人工，
     * 但说完它照样会接着自己干；而这一把调用会在会话日志和审计里留下一条明确的记录，
     * 那才是「这件事已经交出去了」的凭据。
     *
     * 它自己 `risk: ['read']`——转人工这个动作本身不该被任何一条边界挡住，否则模型
     * 撞墙之后连唯一的出口也没有了。
     */
    ctx.tools.register({
      name: 'escalate_to_human',
      risk: ['read'],
      description:
        '把这件事转给人处理。满足公司规定的转人工条件、或者你连着被行为边界挡下、没法在权限内推进时调用它。' +
        '调用之后就停下来，在回复里把情况和已经做到哪一步说清楚，不要再想办法绕过去。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '为什么需要人接手，一句话。' },
          summary: { type: 'string', description: '已经做到哪一步、卡在什么地方。接手的人要靠它继续。' },
        },
        required: ['reason'],
      },
      execute: async (args, call) => {
        const a = (args ?? {}) as { reason?: unknown; summary?: unknown }
        const reason = String(a.reason ?? '').trim() || '没有说明原因'
        const bot = await ctx.policy.botOf(call.sessionId)
        await ctx.policy.record({
          sessionId: call.sessionId,
          botId: bot?.id ?? '',
          callId: call.callId,
          tool: 'escalate_to_human',
          guard: 'escalate',
          outcome: 'escalated',
          reason,
          at: Date.now(),
        })
        return {
          text:
            '已经记下：这件事需要人接手。现在停下来，在回复里把原因、已经做完的部分和卡住的地方说清楚，' +
            '让接手的人不用从头问一遍。不要再尝试绕过刚才那道边界。',
        }
      },
    })

    /**
     * **prepend。** 这条要排在别的 pre-execute 监听者（以后的审批、限流、沙箱）前面：
     * 边界拦下来的调用，不该先被别的横切关注点跑一遍副作用。
     */
    ctx.on(
      'tools/pre-execute',
      async (call: ToolCall, next: () => Promise<ToolResult>) => {
        // 压根没注册的工具交给 run() 去答「未知工具」——在这里拦，模型收到的是一句
        // 「边界挡下了」，而它其实只是名字打错了。
        if (!ctx.tools.has(call.name)) return next()

        const bot = await ctx.policy.botOf(call.sessionId)
        const guards = ctx.policy.guardsOf(bot)
        const risk = ctx.tools.riskOf(call.name)

        if (guards['no-external'] && risk.includes('external')) {
          const verdict = ctx.policy.checkExternal(bot, call)
          if (!verdict.ok) {
            return await ctx.policy.deny(
              call,
              bot,
              'no-external',
              verdict.reason,
              '换一条已经授权的路子，或者请用户在 Bot 模版里放开它。',
            )
          }
        }

        /**
         * 「拦截个人敏感信息」。**扫的是出去的那一份**（工具参数），不是回来的。
         *
         * 顺序在高风险确认**之前**：一次注定要被拦的调用，不该先把人叫来点一次头。
         */
        if (guards.pii && outboundOf(call, risk)) {
          const kinds = scanPii(call.arguments)
          if (kinds.length) {
            return await ctx.policy.deny(
              call,
              bot,
              'pii',
              `参数里有${kinds.join('、')}，按公司边界不外发`,
              '把它去掉再试；确实需要带上的话，请用户自己去做这一步，或者请管理员在 Bot 模版里放开这条。',
            )
          }
        }

        if (guards['high-risk']) {
          const why = ctx.policy.needsApproval(call, risk)
          if (why) {
            // 表单在**席位这边**算：剥元工具的壳、认字段、定哪几格能改，全在 forms.ts。
            const { verdict, viaGrant, viaBlock, edited } = await ctx.policy.approvals.ask(call, why, formOf(call))
            await ctx.policy.record({
              sessionId: call.sessionId,
              botId: bot?.id ?? '',
              callId: call.callId,
              tool: call.name,
              guard: 'high-risk',
              outcome: verdict === 'approved' ? 'approved' : verdict === 'timeout' ? 'timeout' : 'denied',
              // **靠这句话才看得出这次为什么没弹卡片。** 「本会话都批准」之后的每一次
              // 放行，日志上都只是一条 approved；不写清楚出处，事后翻记录的人会以为
              // 有人一次次点过头。
              reason: viaGrant
                ? `${why}（这一轮此前已批准同一把工具）`
                : viaBlock
                  ? `${why}（这一轮此前已拒绝同一把工具，没有再问）`
                  : edited?.length
                    ? `${why}（批准时改过：${edited.join('、')}）`
                    : why,
              at: Date.now(),
            })
            if (verdict !== 'approved') return blockedByUser(verdict, why, viaBlock)
          }
        }

        return next()
      },
      true,
    )
  })
}

/**
 * 这次调用会不会把参数**送出这台席位**。
 *
 * 和 `risk.includes('external')` 差在 `bash` 上：它那份 risk 是最坏情况的并集，照着
 * 判的话 `grep 13800138000 客户.txt` 也算外发——而那句命令从头到尾没离开工作区。
 * 一次这样的误伤，用户学到的就是「把这个开关关掉」，比一开始就没有它更糟。
 * 所以 bash 看它到底联不联网。
 */
function outboundOf(call: ToolCall, risk: readonly string[]): boolean {
  if (call.name === 'bash') return Boolean(networkCommand(call.arguments))
  return risk.includes('external')
}

/**
 * 没批准时给模型的那句话。
 *
 * 三种不批准分开说：**「他说不行」和「他没看见」不是一回事**。前者模型该换个做法，
 * 后者它该在对话里把这件事重新提一遍——合成一句「操作被拒绝」，第二种情况下用户回来
 * 看到的是一条毫无线索的失败。
 */
function blockedByUser(verdict: Verdict, why: string, viaBlock?: boolean): ToolResult {
  /**
   * 人这一轮说过「别再试了」。
   *
   * **要说清楚是「这一轮」而不是「永远」**，也要说清楚该往哪走：不这么说的话，模型的
   * 下一步多半是换个措辞再调一次——而它每换一次，人就得再看一条失败。
   */
  if (viaBlock) {
    return {
      text:
        `用户这一轮已经拒绝过这把工具（${why}），并且说了这一轮别再试。` +
        `换一条不需要它的路子；实在绕不开就把话说清楚交给他，等他下一句话再说。`,
      failed: true,
    }
  }
  if (verdict === 'aborted') {
    return { text: `这次调用还没等到确认，用户就点了停止（${why}）。`, failed: true }
  }
  if (verdict === 'timeout') {
    return {
      text: `这次调用需要用户确认（${why}），但一直没人回应，已经按不执行处理。在对话里说明你要做什么、为什么需要它，等用户回来再说。`,
      failed: true,
    }
  }
  return {
    text: `用户拒绝了这次调用（${why}）。别再用同一个办法重试——问清楚他顾虑的是哪一点，或者换一条不需要这项权限的路子。`,
    failed: true,
  }
}
