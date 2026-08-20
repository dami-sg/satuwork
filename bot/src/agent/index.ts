import { Service, type Context } from '@deepseek-ai/cordis'
import { Agent, type AgentEvent, type AgentMessage } from '@earendil-works/pi-agent-core'
import { randomUUID } from 'node:crypto'
import type { ContentBlock, Message, SessionEventMap, StreamChunk, Usage } from '../session/types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentService
  }
}

export interface Config {
  provider?: string
  model?: string
  system?: string
  /**
   * 估算的提示词占到上下文窗口这个比例时，轮次结束后压缩一次。
   *
   * 留 30% 给「这一轮之后还要长的东西」：工具结果、模型的输出、以及压缩本身
   * 落地之前的那一两轮。压得太早白花摘要的钱，压得太晚就直接撞墙了。
   */
  compactAt?: number
  /** 压缩后保留的近期对话占窗口的比例。摘要之外留这么多原文。 */
  compactKeep?: number
  /**
   * 硬顶。轮次开始时估算已经超过它，就**同步**压一次再发——这一轮会因此慢几秒，
   * 但另一条路是直接被 provider 拒掉。只有在轮末那次压缩失败或没赶上时才会走到。
   */
  compactHard?: number
  /** 窗口未知时（目录没给 contextWindow）按这个 token 数当窗口。 */
  contextWindowFallback?: number
}

const EMPTY_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }

/**
 * Agent 循环。
 *
 * 循环本身是 `@earendil-works/pi-agent-core`——它带 steering（**工具跑到一半也能
 * 插话**）、follow-up 队列、中止、思考预算，以及 `transformContext` 这个注入外部
 * 上下文的钩子（知识库检索与长期记忆以后挂那里）。自己写这些没有收益。
 *
 * 但**持久记录仍然是我们自己的**：订阅它的事件，投影进我们的会话日志。运行时
 * 状态归它、durable 记录归我们，单向流动不会漂移。它的会话后端
 * （`pi-session-backend-sqlite-node`）刻意不用——那会把日志格式交出去。
 */
export class AgentService extends Service {
  /** 正在跑的 agent。steering 要够得着它，所以不能只是个局部变量。 */
  private live = new Map<string, Agent>()
  /**
   * 已经开跑、但 Agent 还没造出来的会话。
   *
   * send() 里「检查在不在跑」和「登记进 live」之间隔着好几个 await（读历史、组 system、
   * 查模型）。只看 live 的话，两个并发的 send 会双双通过检查，于是同一条会话上跑起两个
   * agent：事件交错写进同一份 JSONL，用量也记两遍。占位必须在**第一个 await 之前**
   * 同步做掉。
   */
  private starting = new Set<string>()
  /**
   * 正在压缩的会话。轮末那次是后台跑的，下一轮很可能在它还没写完时就开始了——
   * 两次压缩同时算，会各自按自己看到的历史挑边界，然后写下两条互相矛盾的压缩点。
   */
  private compacting = new Map<string, Promise<boolean>>()

  constructor(
    ctx: Context,
    private config: Config = {},
  ) {
    super(ctx, 'agents')
  }

  /**
   * 生效配置：设置库 > cordis.yml > 内置默认。
   * **在使用点读取**，不在构造时缓存——界面上改完下一轮就生效。
   */
  private setting<T>(key: string, fallback: T): T {
    return this.ctx.storage.getSetting<T>('agent', key) ?? fallback
  }
  get provider() {
    return this.setting('provider', this.config.provider ?? 'deepseek')
  }
  get model() {
    return this.setting('model', this.config.model ?? 'deepseek-v4-flash')
  }
  get system() {
    return this.setting(
      'system',
      this.config.system ?? '你是 Satuwork 的 AI 员工，用简洁、专业的中文回答。',
    )
  }

  isRunning(sessionId: string) {
    return this.live.has(sessionId) || this.starting.has(sessionId)
  }

  /**
   * 跑到一半插话。agent 不在跑时返回 false，由调用方决定改成普通消息。
   *
   * **读盘要排在取 agent 之前。** 带图时得先把字节读出来，而那是个 await；若先取
   * agent 再去读盘，这一轮完全可能在读盘期间跑完（runTurn 结束时会 `live.delete`），
   * 等回过神来投递，消息就交给了一个已经收口的 agent——安静地丢掉，而调用方那边
   * 早就回了「接住了」。先读后取，取和投递落在同一个 tick 里，这个窗口就不存在：
   * 轮次结束了就是 `live.get` 拿不到，如实返回 false，调用方改走 send 开新一轮。
   */
  async steer(sessionId: string, text: string, images: ImageRef[] = []): Promise<boolean> {
    // 先探一下，省得为一个根本没在跑的会话白读一遍图。
    if (!this.live.has(sessionId)) return false
    const content = images.length
      ? await userContentFor({ id: '', role: 'user', content: userBlocks(text, images) }, this.ctx)
      : text
    const agent = this.live.get(sessionId)
    if (!agent) return false
    const at = Date.now()
    agent.steer({ role: 'user', content: stampContent(content, at), timestamp: at } as AgentMessage)
    return true
  }

  abort(sessionId: string): boolean {
    const agent = this.live.get(sessionId)
    if (!agent) return false
    agent.abort()
    return true
  }

  async send(sessionId: string, text: string, images: ImageRef[] = []): Promise<void> {
    if (this.isRunning(sessionId)) {
      // 这条以前是静默的，而它意味着**用户那句话被丢掉了**——steer 没接住、send 又
      // 拒收。界面上什么都看不出来，日志里也没有。
      this.ctx.logger?.warn?.(`agents: 会话 ${sessionId} 已在运行，这条消息没能进去`)
      throw new Error('agents: 该会话正在运行中')
    }
    // 同步占位，之后才允许出现 await。
    this.starting.add(sessionId)
    try {
      await this.runTurn(sessionId, text, images)
    } finally {
      this.starting.delete(sessionId)
    }
  }

  /**
   * turn/start 已经写下了才挂：补一条「出错了」再收口。
   *
   * 少了这一对，日志里留下的是一个永不结束的轮次——界面上那一轮一直转着，链路视图里
   * 是一段空白，而进程这边其实早就放弃了。
   */
  private async failAfterTurnStart(sessionId: string, turn: number, e: Error): Promise<void> {
    const { sessions } = this.ctx
    await sessions.append(sessionId, 'assistant/message', {
      turn,
      step: 0,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: [{ type: 'text', text: `出错了：${e.message}` }],
      },
      usage: EMPTY_USAGE,
    })
    await sessions.append(sessionId, 'turn/end', { turn, reason: 'error' })
  }

  /**
   * 这一轮还什么都没落盘就挂了：把用户那句话补进日志，再按上面那条收口。
   *
   * 不补的话，用户的消息只存在于那次 HTTP 请求里——而请求早就回了 accepted:true。
   * 界面上是一片空白，日志里什么都没有，事后连「他到底发没发」都查不出来。
   */
  private async failBeforeTurn(
    sessionId: string,
    history: Awaited<ReturnType<Context['sessions']['events']>>,
    text: string,
    images: ImageRef[],
    e: Error,
  ): Promise<void> {
    const { sessions } = this.ctx
    const turn = history.filter((ev) => ev.type === 'turn/start').length + 1
    await sessions.append(sessionId, 'user/message', {
      message: { id: randomUUID(), role: 'user', content: userBlocks(text, images) },
      source: { kind: 'user' },
    })
    await sessions.append(sessionId, 'turn/start', { turn })
    await this.failAfterTurnStart(sessionId, turn, e)
  }

  private async runTurn(sessionId: string, text: string, images: ImageRef[] = []): Promise<void> {
    const { sessions, llm } = this.ctx
    let history = await sessions.events(sessionId)
    let system: { text: string; base: string; skills: string }
    let provider: string
    let modelId: string
    let model: ReturnType<typeof llm.modelOf>
    let toolSchemas: { name: string; description: string; parameters?: unknown }[]
    try {
      const bot = this.botOf(history)
      system = this.composeSystem(bot)
      provider = bot?.provider?.trim() || this.provider
      modelId = bot?.model?.trim() || this.model
      model = llm.modelOf(provider, modelId)
      toolSchemas = this.toolSchemasFor(bot)
    } catch (e) {
      await this.failBeforeTurn(sessionId, history, text, images, e as Error)
      throw e
    }

    // 兜底：轮末那次压缩可能失败了、也可能上个进程根本没跑到那一步。已经顶到硬顶
    // 还往上游发，换来的是一个 400，用户看到的是「出错了」。宁可这一轮多等几秒。
    //
    // **这一整段都不能连累这一轮**，判断条件也算在内。此刻 user/message 和 turn/start
    // 都还没落盘：异常从这里穿出去，用户那句话就既不在日志里、也不在 SSE 上，界面什么
    // 都不显示——而 HTTP 早就回了 accepted:true。
    //
    // 以前 try 只圈住了 maybeCompact，条件里那次 `await toAgentMessages` 露在外面。
    // 它不是纯计算：要读图、要碰 ctx.workspace。workspace 一度没进这个插件的 inject，
    // 于是**一条会话只要带过一次图，之后每条消息都在这一行静默消失**——注释写着「压缩
    // 失败不能连累这一轮」，实际连累的恰恰是这一行。inject 已经补上，这个 try 是它的
    // 第二道保险：估算上下文长度是优化，不是正确性的一部分，失败了就带着原上下文往下走。
    const hard = (this.windowOf(provider, modelId) ?? this.config.contextWindowFallback ?? 128_000) *
      (this.config.compactHard ?? 0.9)
    try {
      if (estMessages(await toAgentMessages(history, model, this.ctx)) > hard) {
        this.ctx.logger?.warn?.(`agents: ${sessionId} 已顶到上下文硬顶，先同步压一次`)
        if (await this.maybeCompact(sessionId, provider, modelId, true)) {
          history = await sessions.events(sessionId)
        }
      }
    } catch (e) {
      this.ctx.logger?.warn?.(`agents: ${sessionId} 硬顶检查/同步压缩失败，带原上下文继续：${(e as Error).message}`)
    }

    const turn = history.filter((e) => e.type === 'turn/start').length + 1

    await sessions.append(sessionId, 'user/message', {
      message: { id: randomUUID(), role: 'user', content: userBlocks(text, images) },
      source: { kind: 'user' },
    })
    await sessions.append(sessionId, 'turn/start', { turn })

    // 重建历史从 new Agent 的参数位上抽了出来，但**仍然排在上面两次 append 之后**。
    //
    // 抽出来是因为它会抛（要读图、要碰 ctx.workspace），留在参数位上一抛就是
    // turn/start 已经写下、turn/end 永远不来——日志里一个永不收口的轮次，界面上那一轮
    // 一直转着。现在失败走 failAfterTurnStart，补一条「出错了」再收口。
    //
    // 不再往前挪是因为它**慢**：最多 4 张（MAX_LIVE_IMAGES）× 3.5 MB（MAX_IMAGE_BYTES）
    // 的读盘加 base64。排在 append 前面的话，进程要是在这段窗口里硬死（OOM、systemd
    // 重启、SIGKILL），用户那句话就一个字都没留下。先落盘，慢活儿在后面。
    //
    // history 是 append 之前的快照（sessions.events() 返回 state.events.slice()），
    // 所以这两次 append 不会进 messages——这一轮的消息是靠下面 prompt() 送进去的。
    let messages: AgentMessage[]
    try {
      messages = await toAgentMessages(history, model, this.ctx)
    } catch (e) {
      await this.failAfterTurnStart(sessionId, turn, e as Error)
      throw e
    }

    const agent = new Agent({
      initialState: {
        systemPrompt: system.text,
        model,
        messages,
        tools: this.bridgeTools(sessionId, new Set(toolSchemas.map((t) => t.name))),
      },
      streamFn: llm.streamFn,
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      sessionId,
    } as any)

    this.live.set(sessionId, agent)
    const isMcp = (t: { name: string }) => t.name.startsWith('mcp_')
    const off = agent.subscribe(
      this.projector(sessionId, turn, {
        provider,
        model: modelId,
        system: system.text,
        tools: toolSchemas,
        contextWindow: this.windowOf(provider, modelId),
        sections: {
          system: estTokens(system.base),
          skills: estTokens(system.skills),
          builtinTools: estTokens(toolsText(toolSchemas.filter((t) => !isMcp(t)))),
          mcpTools: estTokens(toolsText(toolSchemas.filter(isMcp))),
        },
      }),
    )

    let reason: 'completed' | 'error' | 'aborted' = 'completed'
    const startedAt = Date.now()
    this.ctx.logger?.info?.(`agents: 会话 ${sessionId} 第 ${turn} 轮开始（${provider}/${modelId}）`)
    try {
      // 盖时间的是**送进模型的那份**，不是落盘的那份：日志里存原文，信封上已经有 time。
      //
      // **这一轮的图片必须从这里进去。** 上面那份 `messages` 是从 `history` 重建的，
      // 而 `history` 是在 append 这条用户消息**之前**取的快照（sessions.events() 返回
      // 的是 state.events.slice()），所以这一轮的消息根本不在里面——它是靠这行
      // prompt() 送进去的。只传文本的话，图就要等到下一轮重建历史时才被读出来，
      // 表现成「问第一遍它没看见，再问一句就看见了」。
      const now = Date.now()
      if (images.length) {
        // 走 userContentFor 而不是自己拼：base64 缓存、单张大小上限、读不到时降级成
        // 一句说明，这些都在那儿，重写一遍迟早会漂。时间戳也复用 stampContent，
        // 跟 steer 那条路盖成同一个形状。
        const content = await userContentFor(
          { id: '', role: 'user', content: userBlocks(text, images) },
          this.ctx,
        )
        await agent.prompt({ role: 'user', content: stampContent(content, now), timestamp: now } as AgentMessage)
      } else {
        await agent.prompt(stampUser(text, now))
      }
      // pi-agent **不抛**模型侧错误，它落在 state.errorMessage / 最终消息的
      // stopReason 上。不显式检查的话，一个失败的 turn 会被记成 completed，
      // 而对话里只剩一条空的助手消息。
      const failure = (agent.state as any)?.errorMessage
      if (failure) {
        reason = 'error'
        await sessions.append(sessionId, 'assistant/message', {
          turn,
          step: 0,
          message: {
            id: randomUUID(),
            role: 'assistant',
            content: [{ type: 'text', text: `模型调用失败：${failure}` }],
          },
          usage: EMPTY_USAGE,
        })
      }
    } catch (e) {
      reason = 'error'
      // 失败也要留在日志里，否则这个 turn 在链路视图上就是一段空白。
      await sessions.append(sessionId, 'assistant/message', {
        turn,
        step: 0,
        message: {
          id: randomUUID(),
          role: 'assistant',
          content: [{ type: 'text', text: `出错了：${(e as Error).message}` }],
        },
        usage: EMPTY_USAGE,
      })
    } finally {
      off()
      this.live.delete(sessionId)
      await sessions.append(sessionId, 'turn/end', { turn, reason })
      // 有这一行，「那一轮到底结束没有」就不用再猜了。
      this.ctx.logger?.info?.(
        `agents: 会话 ${sessionId} 第 ${turn} 轮结束（${reason}，${Date.now() - startedAt}ms）`,
      )
      // 压缩放在**回复送出之后**：它自己也要跑一次模型，摆在轮首用户就得干等。
      // 不 await——这一轮已经结束了，压缩失败也只是下一轮再试。
      void this.maybeCompact(sessionId, provider, modelId).catch((e: Error) =>
        this.ctx.logger?.warn?.(`agents: ${sessionId} 压缩失败 ${e.message}`),
      )
    }
  }

  /**
   * 到阈值就把旧的那一段换成摘要。
   *
   * 三件事按顺序决定：**要不要压**（估算 vs 窗口）、**压到哪**（边界必须落在
   * turn/end 上）、**摘要写什么**（跑一次模型）。任何一步不成立就原样返回——
   * 压缩是优化，不是正确性的一部分，失败了大不了这一轮多花点 token。
   */
  private async maybeCompact(sessionId: string, provider: string, modelId: string, force = false): Promise<boolean> {
    // 已经有一次在跑：轮末那次是后台的，下一轮很可能撞上。同步兜底那条路**要等它**——
    // 直接返回 false 的话，这一轮就带着已经顶到硬顶的上下文发出去了。
    const inflight = this.compacting.get(sessionId)
    if (inflight) return force ? await inflight : false

    const run = this.compactOnce(sessionId, provider, modelId, force)
    this.compacting.set(sessionId, run)
    try {
      return await run
    } finally {
      this.compacting.delete(sessionId)
    }
  }

  private async compactOnce(sessionId: string, provider: string, modelId: string, force: boolean): Promise<boolean> {
    const window = this.windowOf(provider, modelId) ?? this.config.contextWindowFallback ?? 128_000
    const at = this.config.compactAt ?? 0.7
    const keep = this.config.compactKeep ?? 0.3
    const events = await this.ctx.sessions.events(sessionId)
    const before = estMessages(await toAgentMessages(events, undefined, this.ctx))
    if (!force && before < window * at) return false

    // **只在上一个压缩点之后挑新边界。** 压过一次之后，前面那一段在日志里还是原样，
    // 按全量去挑会挑到更早的位置——而 toAgentMessages 认的是最后一条压缩事件，
    // 于是"再压一次"反而把上次压掉的原文放了回来，越压越大。
    const cut = compactionPoint(scopeAfterLastCompact(events), window * keep)
    if (!cut) {
      // 近期那几轮自己就超预算了——没有能切的位置，切了也不省。这种情况只可能是
      // 单轮塞进了巨大的工具结果，压缩帮不上忙，交给别的手段。
      this.ctx.logger?.warn?.(`agents: ${sessionId} 到了压缩阈值，但找不到能切的轮次边界`)
      return false
    }

    // older 从**全量**里切，不是从 scope：这样它带上了上一条压缩事件，
    // toAgentMessages 会把"上次的摘要 + 这段新对话"折成一份再交给模型去总结。
    const older = events.filter((e) => e.seq <= cut.seq)
    const olderMessages = await toAgentMessages(older, undefined, this.ctx)
    const summary = await this.summarize(olderMessages, provider, modelId)
    if (!summary) return false
    const kept = events.filter((e) => e.seq > cut.seq)
    const span = { throughSeq: cut.seq, from: events[0]?.time ?? cut.time, to: cut.time, summary }
    const data: SessionEventMap['session/compact'] = {
      ...span,
      droppedMessages: olderMessages.length,
      tokensBefore: before,
      tokensAfter:
        estTokens(summaryText({ ...span, droppedMessages: 0, tokensBefore: 0, tokensAfter: 0 })) +
        estMessages(await toAgentMessages(kept, undefined, this.ctx)),
    }
    await this.ctx.sessions.append(sessionId, 'session/compact', data)
    this.ctx.logger?.info?.(
      `agents: ${sessionId} 压缩到 seq ${cut.seq}，${data.tokensBefore} → ${data.tokensAfter} tokens（窗口 ${window}）`,
    )
    return true
  }

  /**
   * 让模型给旧对话写摘要。
   *
   * 不走 pi 的 Agent：这是一次性的、无工具的调用，套一层循环没有意义。直接用
   * streamFn，读到 done 为止。
   */
  private async summarize(older: AgentMessage[], provider: string, modelId: string): Promise<string> {
    const transcript = clampTranscript(
      older
        .map((m: any) => `${m.role}: ${typeof m.content === 'string' ? m.content : contentDigest(m.content)}`)
        .join('\n'),
    )
    const stream = this.ctx.llm.streamFn(
      this.ctx.llm.modelOf(provider, modelId),
      {
        systemPrompt: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: transcript, timestamp: Date.now() }],
        tools: [],
      },
      {},
    )
    for await (const event of stream as AsyncIterable<any>) {
      if (event.type !== 'done') continue
      const text = (event.message?.content ?? [])
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('')
        .trim()
      return text
    }
    return ''
  }

  /**
   * 把 ctx.tools 的注册表桥成 pi 的 AgentTool。
   *
   * 两边的失败约定相反：我们的 execute **永远 resolve**（业务失败写进 text），
   * pi 要求**失败抛异常**。所以只有管道层失败（`failed`）才抛——业务失败照常作为
   * 内容返回，模型读得到、能自己重试。
   */
  private bridgeTools(sessionId: string, allowed?: Set<string>) {
    const schemas = allowed
      ? this.ctx.tools.schemas().filter((s) => allowed.has(s.name))
      : this.ctx.tools.schemas()
    return schemas.map((schema) => ({
      name: schema.name,
      label: schema.name,
      description: schema.description,
      parameters: schema.parameters,
      execute: async (toolCallId: string, params: unknown) => {
        const result = await this.ctx.tools.execute({
          callId: toolCallId,
          name: schema.name,
          arguments: JSON.stringify(params ?? {}),
          sessionId,
        })
        if (result.failed) throw new Error(result.text)
        // files 走 details 而不是 content：content 是给模型的，它已经从 text 里知道
        // 自己写了什么；details 是 pi 留给「日志与界面渲染」的那一格，正好是这个用途。
        return {
          content: [{ type: 'text' as const, text: result.text }],
          details: result.files?.length ? { files: result.files } : undefined,
        }
      },
    })) as any
  }

  /** 会话根上的 botId → 名册里的提示词 / provider+model。没有就回落全局设置。 */
  private botOf(history: Awaited<ReturnType<Context['sessions']['events']>>) {
    const root = history.find((e) => e.type === 'session')
    const data = root?.data as { botId?: string; agentId?: string } | undefined
    const botId = data?.botId ?? data?.agentId
    if (!botId) return undefined
    type Row = { prompt?: string; model?: string; provider?: string; skills?: string[]; mcps?: string[] }
    return this.ctx.storage.collection<Row>('bots').get(botId)
      ?? this.ctx.storage.collection<Row>('agents').get(botId)
  }

  /**
   * 把该 Bot 挂上的、且已启用的 Skill 正文拼进系统提示词。
   * 没有 skills 列表 → 本机所有启用的 Skill；空数组 → 不加。
   *
   * 返回时把两段分开留一份：上下文占比要分别报「提示词」和「Skill」，拼完再去切
   * 字符串既脆（提示词里出现同样的小标题就切错）又白算一遍。
   */
  private composeSystem(
    bot: { prompt?: string; skills?: string[] } | undefined,
  ): { text: string; base: string; skills: string } {
    const base = `${bot?.prompt?.trim() || this.system}\n\n${runtimeBlock()}`
    const col = this.ctx.storage.collection<{ id: string; name: string; body: string; enabled?: boolean }>('skills')
    const ids = bot?.skills
    const picked =
      ids === undefined
        ? col.list().map((r) => r.value).filter((s) => s.enabled !== false)
        : ids
            .map((id) => col.get(id))
            .filter((s): s is { id: string; name: string; body: string; enabled?: boolean } => !!s && s.enabled !== false)
    if (!picked.length) return { text: base, base, skills: '' }
    const extra = picked.map((s) => `## Skill: ${s.name}\n${s.body}`).join('\n\n')
    return { text: `${base}\n\n${extra}`, base, skills: extra }
  }

  /** 模型的上下文窗口，来自 Gateway 目录。拉不到就没有——界面那条占比会自己让位。 */
  private windowOf(provider: string, model: string): number | undefined {
    const found = this.ctx.llm
      .catalog()
      .find((p) => p.provider === provider)
      ?.models.find((m) => m.id === model)
    return typeof found?.contextWindow === 'number' ? found.contextWindow : undefined
  }

  /** 内置工具始终在。MCP 工具只在成功 list 之后才注册，再按 Bot.mcps 过滤。 */
  private toolSchemasFor(bot: { mcps?: string[] } | undefined) {
    const all = this.ctx.tools.schemas()
    const mcpNames = new Set<string>()
    const catalog = this.ctx.catalog
    const assigned = bot?.mcps
    if (assigned === undefined) {
      for (const s of catalog.servers) for (const n of s.tools) mcpNames.add(n)
    } else {
      for (const n of catalog.toolNamesFor(assigned)) mcpNames.add(n)
    }
    return all.filter((t) => !t.name.startsWith('mcp_') || mcpNames.has(t.name))
  }

  /**
   * pi 的事件 → 我们的会话日志。
   *
   * 名称对不上要留意：pi 的一个 **turn** 是「一次模型调用加它的工具」，也就是我们
   * 的 **step**；我们的 turn 是一次用户输入引发的全部工作。
   */
  private projector(
    sessionId: string,
    turn: number,
    used: {
      provider: string
      model: string
      system: string
      tools: { name: string; description: string }[]
      contextWindow?: number
      sections?: { system: number; skills: number; builtinTools: number; mcpTools: number }
    },
  ) {
    const { sessions } = this.ctx
    let step = 0

    const chunk = (c: StreamChunk) =>
      sessions.append(sessionId, 'assistant/chunk', { turn, step, chunk: c })

    return async (event: AgentEvent) => {
      switch (event.type) {
        case 'turn_start': {
          step += 1
          await sessions.append(sessionId, 'step/start', { turn, step })
          // 每一步的有效提示词与工具表：链路视图的 SYSTEM 段读的就是这条。
          await sessions.append(sessionId, 'request/header', {
            turn,
            step,
            provider: used.provider,
            model: used.model,
            system: used.system,
            tools: used.tools.map((t) => ({ name: t.name, description: t.description })),
            contextWindow: used.contextWindow,
            sections: used.sections,
          })
          break
        }

        case 'message_update': {
          const e = event.assistantMessageEvent as any
          const index = e.contentIndex ?? 0
          if (e.type === 'text_start') await chunk({ type: 'block-start', index, kind: 'text' })
          else if (e.type === 'text_delta') await chunk({ type: 'text-delta', index, text: e.delta })
          else if (e.type === 'thinking_start')
            await chunk({ type: 'block-start', index, kind: 'reasoning' })
          else if (e.type === 'thinking_delta')
            await chunk({ type: 'reasoning-delta', index, text: e.delta })
          else if (e.type === 'text_end' || e.type === 'thinking_end')
            await chunk({ type: 'block-end', index })
          break
        }

        case 'turn_end': {
          const msg = event.message as any
          const content = fromAgentContent(msg?.content ?? [])
          // 空消息不入日志：模型调用失败时 pi 也会发一次 turn_end，内容是空的，
          // 记下来只会在对话和链路视图里留一条什么都没有的气泡。
          if (!content.length) {
            await sessions.append(sessionId, 'step/end', { turn, step })
            break
          }
          await sessions.append(sessionId, 'assistant/message', {
            turn,
            step,
            message: {
              id: msg?.id ?? randomUUID(),
              role: 'assistant',
              content,
            },
            usage: toUsage(msg?.usage),
          })
          await sessions.append(sessionId, 'step/end', { turn, step })
          break
        }

        case 'tool_execution_start':
          await sessions.append(sessionId, 'tool/call', {
            turn,
            step,
            callId: event.toolCallId,
            name: event.toolName,
            arguments: JSON.stringify(event.args ?? {}),
          })
          break

        case 'tool_execution_end':
          await sessions.append(sessionId, 'tool/result', {
            turn,
            step,
            callId: event.toolCallId,
            text: textOf(event.result),
            failed: Boolean(event.isError),
            files: filesOf(event.result),
          })
          break
      }
    }
  }
}

function textOf(result: any): string {
  if (typeof result === 'string') return result
  const content = result?.content
  if (Array.isArray(content)) return content.map((c: any) => c?.text ?? '').join('')
  return JSON.stringify(result ?? null)
}

/**
 * 工具报出来的产出文件（见 tools/index.ts 的 `ToolResult.files`）。
 *
 * 逐字段挑而不是整个 details 塞进日志：details 是 `unknown`，工具想放什么都行，
 * 原样落盘等于让任意一个工具决定会话日志的形状。
 */
function filesOf(result: any): { path: string; name: string }[] | undefined {
  const raw = result?.details?.files
  if (!Array.isArray(raw)) return undefined
  const files = raw
    .filter((f: any) => typeof f?.path === 'string' && typeof f?.name === 'string')
    .map((f: any) => ({ path: f.path as string, name: f.name as string }))
  return files.length ? files : undefined
}

/**
 * 估算 token 数。
 *
 * 没有分词器，也不该为了输入框上一行灰字去装一个：那要么按模型各配一份词表，要么把
 * 整段提示词再跑一遍分词。CJK 大致一字一 token，其余按 ~3.6 字符一 token，够撑一条
 * 「占了多少」的提示。**总量不用它**——那个是模型自己回报的，见 usage。
 */
function estTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length
  return Math.round(cjk + (text.length - cjk) / 3.6)
}

/** 工具表进模型时的实际形状。参数表往往比描述还大，只量描述会差出一大截。 */
function toolsText(tools: { name: string; description: string; parameters?: unknown }[]): string {
  return tools
    .map((t) => JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters ?? {} }))
    .join('')
}

function toUsage(u: any): Usage {
  if (!u) return EMPTY_USAGE
  return {
    inputTokens: u.input ?? 0,
    outputTokens: u.output ?? 0,
    cacheReadTokens: u.cacheRead ?? 0,
    reasoningTokens: u.reasoning ?? 0,
    cost: u.cost?.total,
  }
}

/** pi 的内容块 → 我们的。 */
function fromAgentContent(content: any[]): ContentBlock[] {
  const out: ContentBlock[] = []
  for (const c of content) {
    if (c?.type === 'text') out.push({ type: 'text', text: c.text })
    else if (c?.type === 'thinking') out.push({ type: 'reasoning', text: c.thinking ?? c.text ?? '' })
    else if (c?.type === 'toolCall')
      out.push({
        type: 'tool-call',
        callId: c.id,
        name: c.name,
        arguments: JSON.stringify(c.arguments ?? {}),
      })
  }
  return out
}

/**
 * 从日志重建 pi 的历史。
 *
 * 只读三种事件；推理块不回传——它是给人看的，回传既费 token 又可能干扰下一轮。
 *
 * **顺序要重排**：日志按真实时序记录，而 pi 在 `turn_end` 才给出最终助手消息，
 * 所以带 tool-call 的那条排在它自己的 tool/result 之后。直接按 seq 喂回去，
 * provider 会拒绝——「role 'tool' 必须紧跟在带 tool_calls 的消息之后」。
 * 这里把每个 step 的工具结果挂到该 step 助手消息的后面。
 *
 * **时间从事件信封上取，不是重建的时刻。** 以前这里是 `const ts = Date.now()`，
 * 一份盖在所有消息上：一条跨了三天的长会话，在模型眼里每一句都是「刚刚」说的。
 * 「我昨天跟你说了什么」于是无解——不是历史没进上下文，是历史进去了但没有时间。
 */
export async function toAgentMessages(
  events: Awaited<ReturnType<Context['sessions']['events']>>,
  model: { api?: string; provider?: string; id?: string } = {},
  ctx?: Context,
): Promise<AgentMessage[]> {
  const stepKey = (t: number, s: number) => `${t}:${s}`

  // 最后一个压缩点之前的事件不逐条回传，换成一条摘要消息。多次压缩只认最后一个：
  // 每次压缩都是把「摘要 + 这段时间的新对话」再压一次，所以后一个必然覆盖前一个。
  const compact = [...events].reverse().find((e) => e.type === 'session/compact')
  if (compact) events = events.filter((e) => e.seq > compact.data.throughSeq)

  // 先找出每个 step 的助手消息落在哪个 seq，工具结果据此排到它后面。
  const assistantSeq = new Map<string, number>()
  for (const e of events) {
    if (e.type === 'assistant/message') {
      assistantSeq.set(stepKey(e.data.turn, e.data.step), e.seq)
    }
  }

  /**
   * 哪几张图这一轮真的要带上字节。
   *
   * 不加这道闸，历史里每一张图每一轮都会被重新读盘、重新 base64、重新发给模型——
   * 开销随图片数线性涨，而且**只增不减**：十张 3 MB 的图就是每轮 30 MB 磁盘读、
   * 约 40 MB 字符串同时驻留、外加一两万 token。人真正在问的几乎总是最近那几张，
   * 更早的换成一句说明就够。
   */
  const imageKeys: string[] = []
  for (const e of events) {
    if (e.type !== 'user/message') continue
    e.data.message.content.forEach((c, i) => {
      if (c.type === 'image') imageKeys.push(`${e.seq}:${i}`)
    })
  }
  const liveImages = new Set(imageKeys.slice(-MAX_LIVE_IMAGES))

  const entries: { order: number; message: AgentMessage }[] = []
  let resultIndex = 0

  for (const e of events) {
    if (e.type === 'user/message') {
      entries.push({
        order: e.seq,
        message: {
          role: 'user',
          content: stampContent(
            await userContentFor(e.data.message, ctx, (i) => liveImages.has(`${e.seq}:${i}`)),
            e.time,
          ),
          timestamp: e.time,
        } as AgentMessage,
      })
    } else if (e.type === 'assistant/message') {
      const content = e.data.message.content
        .filter((c) => c.type !== 'reasoning')
        .map((c) =>
          c.type === 'tool-call'
            ? { type: 'toolCall', id: c.callId, name: c.name, arguments: safeParse(c.arguments) }
            : { type: 'text', text: (c as { text: string }).text },
        )
      if (!content.length) continue
      // 重建的助手消息必须跟 pi 自己产出的**同形**：除了 content，还要带 usage 与
      // api/provider/model。少了 usage，pi 在后续轮次读它的 totalTokens 时会炸——
      // 症状是第一轮正常、第二轮起全部失败。
      entries.push({
        order: e.seq,
        message: {
          role: 'assistant',
          content,
          api: model.api ?? 'unknown',
          provider: model.provider ?? 'unknown',
          model: model.id ?? 'unknown',
          usage: piUsage(e.data.usage),
          timestamp: e.time,
        } as any,
      })
    } else if (e.type === 'tool/result') {
      const anchor = assistantSeq.get(stepKey(e.data.turn, e.data.step)) ?? e.seq
      entries.push({
        // 小数偏移把结果排到锚点之后、下一条整数 seq 之前，同时保持批内先后。
        order: anchor + 1e-6 * ++resultIndex,
        message: {
          role: 'toolResult',
          toolCallId: e.data.callId,
          toolName: '',
          content: [{ type: 'text', text: e.data.text }],
          isError: e.data.failed,
          timestamp: e.time,
        } as any,
      })
    }
  }

  const messages = entries.sort((a, b) => a.order - b.order).map((x) => x.message)
  if (!compact) return messages

  // 摘要**并进保留段的第一条用户消息**，而不是自己单独占一条。
  //
  // 单独占一条的话前两条必然都是 user：压缩边界固定落在 turn/end 上，其后第一条
  // 一定是 user/message。Anthropic 的 messages 要求角色交替，两条连续 user 会被
  // 整个请求拒掉——症状是「一旦压缩过，这个 Bot 就再也答不了话」，而 OpenAI 兼容口
  // 完全正常，本地和 e2e 都照不出来。并进去就没有这个问题，任何家都一样。
  const first = messages.findIndex((m: any) => m.role === 'user')
  const head = summaryText(compact.data)
  if (first < 0) {
    // 保留段里一条用户消息都没有。compactionPoint 保证至少留一整轮，正常到不了这里；
    // 真到了就单独挂一条，起码不把摘要丢了。
    return [{ role: 'user', content: head, timestamp: compact.data.to } as AgentMessage, ...messages]
  }
  const target = messages[first] as any
  messages[first] = { ...target, content: `${head}\n\n${target.content}` }
  return messages
}

/** 摘要输入的上限。 */
const MAX_SUMMARY_INPUT = 60_000
/** 超限时头部至少保住这么多字符——上一次的摘要就在这里。 */
const SUMMARY_HEAD_KEEP = 20_000

/**
 * 摘要输入超限时**掐中间**，头尾都留。
 *
 * 不能简单地 slice(-N) 只留末尾：级联压缩时 toAgentMessages 把上一次的摘要放在
 * 第一条，于是「只留末尾」第一个丢掉的就是它——新摘要因此不含第一次压缩之前的任何
 * 事实，摘要链当场断掉，而且没有任何报错。头部留一段、尾部留一段，中间那截标注
 * 掉了多少：中间那些原文仍在 JSONL 里，模型需要就用 history_read 调。
 */
export function clampTranscript(text: string): string {
  if (text.length <= MAX_SUMMARY_INPUT) return text
  const head = text.slice(0, SUMMARY_HEAD_KEEP)
  const tail = text.slice(-(MAX_SUMMARY_INPUT - SUMMARY_HEAD_KEEP))
  const dropped = text.length - head.length - tail.length
  return `${head}\n\n…（中间省略约 ${dropped} 字，原文仍可用 history_read 按时间调取）…\n\n${tail}`
}

const SUMMARY_SYSTEM = [
  '你在给一段对话写摘要，它会替代原文进入后续对话的上下文。读它的是接着聊下去的 AI 助理，不是人。',
  '',
  '必须保留：',
  '- 用户交代过的事实、偏好、约束（名字、账号、口径、忌讳）',
  '- 已经做出的决定和结论，以及为什么',
  '- **没做完的事**：待办、承诺过要做的、卡住的地方',
  '- 关键的时间点，写成「8月18日 22:10」这样的绝对时间，不要写「昨天」',
  '- 产出物的位置（文件路径、链接、命令）',
  '',
  '可以丢掉：寒暄、重复、工具调用的原始输出（只留结论）、已经被推翻的中间过程。',
  '',
  '用中文，分条写，不要客套，不要写「以下是摘要」这类开场白。直接从内容开始。',
].join('\n')

/**
 * content 数组压成一行，估算和摘要输入用。
 *
 * 两种形状都要收：pi 的 `toolCall` 和我们日志里的 `tool-call`。估算走的是日志事件、
 * 摘要走的是重建后的消息，漏掉一种就会把带工具的那些轮次估成 0。
 */
export function contentDigest(content: any): string {
  if (!Array.isArray(content)) return String(content ?? '')
  return content
    .map((c: any) => {
      if (c?.type === 'toolCall' || c?.type === 'tool-call') return `[调用 ${c.name}]${argsText(c.arguments)}`
      if (c?.type === 'tool-result') return c.text ?? ''
      // 图片：**不要把 base64 拼进来**。一张 2 MB 的图 base64 之后是 2.7 MB 字符，
      // 拼进摘要输入会瞬间吃满上限，还会把真正有用的对话挤掉。给一句占位就够，
      // 至于它值多少 token 由 estEvent 单独计。
      if (c?.type === 'image') return `[图片 ${c.path ?? c.mimeType ?? ''}]`
      return c?.text ?? ''
    })
    .join('')
}

/**
 * 工具参数转文本。**两种形状的 arguments 不能用同一种转法**：日志事件里它已经是
 * JSON 字符串，再 stringify 一遍会包上引号并转义每个双引号，长度凭空涨五成；
 * pi 的消息里它是对象，必须 stringify 才有内容。转错的代价是估算偏大，
 * compactionPoint 于是切得比需要的早、留的原文比能留的少。
 */
function argsText(args: unknown): string {
  if (args == null) return ''
  return typeof args === 'string' ? args : JSON.stringify(args)
}

/** 一组消息进模型时的估算大小。 */
function estMessages(messages: AgentMessage[]): number {
  return messages.reduce((n, m: any) => {
    const body = typeof m.content === 'string' ? m.content : contentDigest(m.content)
    return n + estTokens(body) + 4 // 每条消息的角色和分隔开销，粗算
  }, 0)
}

/**
 * 挑压缩边界：**从后往前**累加，直到近期这一段吃满预算，切在再往前的那个 turn/end 上。
 *
 * 只切在 `turn/end` 上，这条是硬的。切在一轮中间的话，带 tool_calls 的助手消息会被
 * 摘要吃掉，而它的 tool/result 留在后面——provider 直接拒收整个请求。切在 turn/end
 * 上，边界两侧各自都是完整的轮次。
 *
 * 返回 undefined 表示没有可切的位置：要么压根没跑完过一轮，要么最近一轮自己就超了
 * 预算（单轮塞进巨大的工具结果就会这样）。这两种情况压缩都帮不上忙。
 */
/**
 * 挑新压缩边界时能看的范围：上一个压缩点之后的部分。
 *
 * 压过一次之后，前面那一段在日志里还是原样躺着。按全量去挑，挑到的位置可能比上次
 * 更早——而 toAgentMessages 认的是**最后**一条压缩事件，于是「再压一次」反而把上次
 * 压掉的原文放了回来，越压越大。边界必须单调向前。
 */
export function scopeAfterLastCompact(
  events: Awaited<ReturnType<Context['sessions']['events']>>,
): Awaited<ReturnType<Context['sessions']['events']>> {
  const prior = [...events].reverse().find((e) => e.type === 'session/compact')
  return prior ? events.filter((e) => e.seq > prior.data.throughSeq) : events
}

export function compactionPoint(
  events: Awaited<ReturnType<Context['sessions']['events']>>,
  keepBudget: number,
): { seq: number; time: number } | undefined {
  // 每条事件进模型时值多少 token，一次算完；再求后缀和，于是「切在这里之后还剩多少」
  // 是 O(1)。挨个切点重跑一遍 toAgentMessages 是 O(n²)，长会话上会明显卡一下。
  const cost = events.map(estEvent)
  const suffix = new Array<number>(events.length + 1).fill(0)
  for (let i = events.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + cost[i]

  const ends: { seq: number; time: number; after: number }[] = []
  for (let i = 0; i < events.length; i++) {
    if (events[i].type === 'turn/end') ends.push({ seq: events[i].seq, time: events[i].time, after: suffix[i + 1] })
  }
  // 至少要压掉一轮、也至少要留一轮，所以可切的位置是 ends[0 .. length-2]。
  if (ends.length < 2) return undefined

  const maxCut = ends.length - 2
  // 从最早的切点往后找第一个「保留部分装得下」的：越早切保留得越多，第一个装得下的
  // 就是在预算内能留住最多原文的那个。
  for (let i = 0; i <= maxCut; i++) {
    if (ends[i].after <= keepBudget) return { seq: ends[i].seq, time: ends[i].time }
  }
  // 一个都装不下——连只留最后一轮都超预算。那就切在最靠后的允许位置，能省多少省多少。
  return { seq: ends[maxCut].seq, time: ends[maxCut].time }
}

/**
 * 一张图进上下文时按多少 token 算。
 *
 * 各家按分块数算，一张常见截图落在一两千之间。这个数字只用来决定「什么时候该压」，
 * 宁可估高一点：估低的代价是撞窗口，估高的代价只是早压一轮。
 */
const EST_TOKENS_PER_IMAGE = 1_500

/** 单条事件进模型时的估算大小。不进上下文的事件（chunk、header…）算 0。 */
function estEvent(e: Awaited<ReturnType<Context['sessions']['events']>>[number]): number {
  if (e.type === 'user/message') {
    // 图片按张计，别按 textFrom 的结果算——textFrom 只取文本块，一条「看看这张图」
    // 会被估成十几个 token，而它实际值一两千。带图的会话会因此一路估不到阈值，
    // 等真撞上窗口时压缩根本没触发过。
    const images = e.data.message.content.filter((c) => c.type === 'image').length
    return estTokens(textFrom(e.data.message)) + 12 + images * EST_TOKENS_PER_IMAGE // 12 ≈ [时间] 前缀
  }
  if (e.type === 'assistant/message') return estTokens(contentDigest(e.data.message.content)) + 4
  if (e.type === 'tool/result') return estTokens(e.data.text) + 4
  return 0
}

/** 摘要消息的正文。**必须写出覆盖区间**，否则压缩之后「昨天」就断了。 */
function summaryText(d: SessionEventMap['session/compact']): string {
  return [
    `[对话摘要 · ${humanTime(d.from)} 至 ${humanTime(d.to)}]`,
    '这一段是更早的对话被压缩后的摘要，不是用户说的话。',
    '原始对话一条没删：需要原文就用 history_read 按时间区间调出来，找具体某句话用 history_search。',
    '',
    d.summary,
  ].join('\n')
}

const textFrom = (m: Message) => m.content.map((c) => (c.type === 'text' ? c.text : '')).join('')

/** 一张要给模型看的图。路径相对工作区。 */
export interface ImageRef {
  path: string
  mime: string
}

/**
 * 单张图喂给模型的上限（原始字节）。
 *
 * 各家上限不一样（Anthropic 5 MB、OpenAI 20 MB，都按 base64 之后算，要再打七折），
 * 这里取最紧的那个再留些余量。超了不缩放——缩放要拉原生图像库，而部署包是预打的
 * arm64，为这件事拉一个原生依赖不划算。超限就换成一句说明，模型至少知道有这么个东西。
 */
const MAX_IMAGE_BYTES = 3.5 * 1024 * 1024

/** 用户这一条消息的内容块：图片排在正文前面，先给材料再给指令。 */
function userBlocks(text: string, images: ImageRef[]): ContentBlock[] {
  const blocks: ContentBlock[] = images.map((img) => ({ type: 'image' as const, path: img.path, mime: img.mime }))
  if (text || !blocks.length) blocks.push({ type: 'text', text })
  return blocks
}

/**
 * 一轮里最多带几张真图。再往前的换成一句说明。
 *
 * 每张图大约值一两千 token，而人问的几乎总是最近那几张。这个数字是「上下文里同时
 * 摆得下几张图」，不是「一条消息最多几张」——一条消息带十张图，也只有最后几张进得去。
 */
const MAX_LIVE_IMAGES = 4

/**
 * 已经读过的图。键里带 mtime 和 size，文件被改过自然不命中。
 *
 * 一轮之内同一张图只读一次，多轮之间也复用——没有它，每发一句话都要把上下文里那几张
 * 图整个重新读一遍盘、重新 base64 一遍。
 */
const IMAGE_CACHE = new Map<string, string>()
const IMAGE_CACHE_MAX = 8

function imageCacheGet(key: string): string | undefined {
  const hit = IMAGE_CACHE.get(key)
  // 命中就挪到末尾，砍的总是最久没用的那份。
  if (hit !== undefined) {
    IMAGE_CACHE.delete(key)
    IMAGE_CACHE.set(key, hit)
  }
  return hit
}

function imageCachePut(key: string, data: string) {
  IMAGE_CACHE.set(key, data)
  while (IMAGE_CACHE.size > IMAGE_CACHE_MAX) IMAGE_CACHE.delete(IMAGE_CACHE.keys().next().value as string)
}

/**
 * 日志里的用户消息 → 喂给 pi 的内容。
 *
 * 没有图片时返回**字符串**，跟以前一模一样——绝大多数消息走的是这条路，没必要为了
 * 统一形状让每条消息都变成数组。
 *
 * 有图片时现读现转 base64：日志里存的是路径（见 session/types.ts 的 image 块）。
 * 读不到就退化成一句说明，不让整轮对话因为一张图没了而失败。
 *
 * `isLive` 决定这一张要不要真的带字节（见 MAX_LIVE_IMAGES）。不给就全带——steer
 * 那条路只有当下这一条消息，没有「太靠前」可言。
 */
async function userContentFor(m: Message, ctx?: Context, isLive?: (index: number) => boolean): Promise<any> {
  const picked = m.content
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.type === 'image') as { c: { type: 'image'; path: string; mime: string }; i: number }[]
  if (!picked.length) return textFrom(m)
  const out: any[] = []
  for (const { c, i } of picked) {
    out.push(isLive && !isLive(i) ? stale(c) : await loadImage(c, ctx))
  }
  const text = textFrom(m)
  if (text) out.push({ type: 'text', text })
  return out
}

/** 太靠前、这一轮不带字节的图。说清楚它存在过，模型才不会以为自己漏看了什么。 */
function stale(img: { path: string }) {
  return { type: 'text', text: `（前面有一张图 ${img.path}，离现在太远，这一轮没有放进上下文。）` }
}

async function loadImage(img: { path: string; mime: string }, ctx?: Context) {
  const miss = (why: string) => ({ type: 'text', text: `（附了一张图 ${img.path}，但${why}。）` })
  // ctx 缺席才走这条路：ctx 本身是可选参数（userContentFor / toAgentMessages 都声明成
  // `ctx?`），给不出上下文的调用方——测试里手搓一份历史、以后可能有的离线重放——
  // 应该看到一句说明，而不是崩掉。
  if (!ctx) return miss('这个运行时读不到工作区')
  try {
    // 取工作区的两种失败**都得在 try 里面**，因为 cordis 对这两种的反应不一样：
    //
    // - 插件上下文（fiber.runtime 有值）没 inject 这个服务：读属性直接**抛**
    //   `cannot get property "workspace" without inject`。曾经的 `!ctx?.workspace`
    //   就是栽在这儿——它写在 try 外面，一次都没兜住，反而把异常带出整轮。
    // - 裸的根上下文（`new Context()`，探针在造的那种）：cordis 走
    //   `reflect.get(prop, false)`，服务没注册就是 **undefined**，不抛。
    //
    // 所以抛的那支交给下面的 catch，undefined 那支自己判一次——不判的话就是一个
    // `Cannot read properties of undefined (reading 'resolve')` 冒充「读不出来」。
    const ws = ctx.workspace
    if (!ws) return miss('这个运行时读不到工作区')
    const file = ws.resolve(img.path)
    const { readFile, stat } = await import('node:fs/promises')
    const info = await stat(file)
    if (info.size > MAX_IMAGE_BYTES) {
      return miss(`它有 ${(info.size / 1024 / 1024).toFixed(1)} MB，超过了能直接看的大小`)
    }
    const key = `${file}|${info.mtimeMs}|${info.size}`
    let data = imageCacheGet(key)
    if (data === undefined) {
      data = (await readFile(file)).toString('base64')
      imageCachePut(key, data)
    }
    return { type: 'image', data, mimeType: img.mime }
  } catch (e) {
    return miss(`读不出来：${(e as Error).message}`)
  }
}

/** 席位所在时区。部署时由管家写进环境，本机跑就是本机时区。 */
function timeZone(): string {
  return (
    process.env.SATUWORK_TZ?.trim() ||
    process.env.TZ?.trim() ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    'UTC'
  )
}

/** `2026年8月19日 星期三 11:30`。给模型看的，所以用中文长格式，别用 ISO。 */
function humanTime(at: number, tz = timeZone()): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(at))
}

/**
 * 给用户消息盖上时间。
 *
 * **必须写进正文**：pi 的 `timestamp` 字段停在 pi 那一层，`llm/gateway.ts` 的
 * toOpenAI / toAnthropic 往请求体里只放 role 和 content，时间戳一个字都不会到
 * 模型手上。所以「只把 timestamp 改对」是不够的——那修好的是我们自己的日志，
 * 不是模型的认知。
 *
 * 只盖用户消息：助手消息的时间模型能从相邻的用户消息推出来，每条都盖是白花 token。
 */
function stampUser(text: string, at: number): string {
  return `[${humanTime(at)}]\n${text}`
}

/**
 * 给用户消息的内容盖时间，**带图的那种也要盖**。
 *
 * userContentFor 没图时返回字符串、有图时返回内容块数组（图在前、正文在后）。
 * 只处理字符串的话，凡是带图的消息就没有时间——而带图那几条往往正是之后会被问起的
 * 「上周发你的那张图」。数组形式下时间单独作为第一个文本块，不去改正文那一块，
 * 免得把它跟图的先后关系弄乱。
 */
function stampContent(content: unknown, at: number): any {
  if (typeof content === 'string') return stampUser(content, at)
  if (!Array.isArray(content)) return stampUser(String(content ?? ''), at)
  return [{ type: 'text', text: `[${humanTime(at)}]` }, ...content]
}

/**
 * 拼在系统提示词后面的运行时约定。
 *
 * **这里不放当前时间。** 系统提示词是整个请求的前缀，而上游做的是前缀缓存：塞一个
 * 每轮都变的时钟进去，等于每一轮都从第一个 token 开始重算。这笔账很实在——同一条
 * 会话里，缓存命中的那几轮提示词只按 54、103 个 token 计费，冷缓存那一轮是 3151。
 *
 * 时间由最后那条用户消息上的 `[时间]` 提供：它本来就在末尾、本来就每轮都新，
 * 缓存边界落在它前面，一个 token 都不多花。这里只需要把这个约定讲清楚——不讲的话
 * 模型可能把前缀当成用户打的字，也可能在自己的回复里跟着照抄。
 */
function runtimeBlock(): string {
  return [
    '## 时间',
    `对话里每条用户消息开头的 \`[时间]\` 是这句话发出的时刻（时区 ${timeZone()}），由系统加上，不是用户打的字。`,
    '最后一条用户消息上的时间就是现在，据此回答「今天」「昨天」「上周」这类问题，不必再去查。',
    '你自己的回复不要加这个前缀。',
  ].join('\n')
}

/** 我们的 usage → pi 的形状。字段名不同，且它多一个 totalTokens 与分项成本。 */
function piUsage(u: Usage | undefined) {
  const input = u?.inputTokens ?? 0
  const output = u?.outputTokens ?? 0
  return {
    input,
    output,
    cacheRead: u?.cacheReadTokens ?? 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: u?.cost ?? 0 },
  }
}

function safeParse(s: string): unknown {
  try {
    return s.trim() ? JSON.parse(s) : {}
  } catch {
    return {}
  }
}

export const name = 'satu-agent'
// 'workspace' 是给 loadImage 用的：日志里的 image 块存的是路径，重建历史时要靠
// ctx.workspace.resolve 把它变成绝对路径再读字节。**不列在这里不是「拿到 undefined」**
// ——cordis 的上下文代理对没 inject 的服务是直接抛 `cannot get property "workspace"
// without inject`，于是任何一条带图的历史都会让 toAgentMessages 抛，整轮静默丢掉。
// 装载顺序不看 cordis.yml 的行序、只看 inject（见那份文件开头的说明），所以这一行
// 就是「workspace 必须排在我前面」的全部声明，不用再动 yml。
export const inject = ['sessions', 'llm', 'tools', 'storage', 'catalog', 'workspace']

export function apply(ctx: Context, config: Config = {}) {
  ctx.plugin(AgentService, config)
}
