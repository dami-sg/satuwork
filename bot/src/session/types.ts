/**
 * 会话事件模型。
 *
 * 形状参考 docs/session-event-field-map.md——那是从一个生产系统的真实日志逆向出来
 * 的，省掉我们从零试错。但**格式与版本号是我们自己的**：会话历史是产品资产，不能
 * 压在别人不作兼容承诺的格式上。
 */

/** 落盘格式版本。任何破坏性结构变更都要 +1，并同时给出迁移。 */
export const SESSION_FORMAT_VERSION = 4

/** 会话根上的 Bot 来源。M1 只有 local；company / global 是物化预留。 */
export type SessionOrigin = 'local' | 'company' | 'global'

/** 每条事件共有的信封。 */
export interface EventEnvelope<T extends keyof SessionEventMap = keyof SessionEventMap> {
  /** 会话内单调递增，从 1 开始。 */
  seq: number
  /** Unix 毫秒。 */
  time: number
  type: T
  data: SessionEventMap[T]
}

/** 消息内容块。 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; callId: string; name: string; arguments: string }
  | { type: 'tool-result'; callId: string; text: string; failed?: boolean }
  /**
   * 一张给模型看的图（v4 起）。
   *
   * **存路径，不存 base64。** 一张 2 MB 的图 base64 之后是 2.7 MB，直接落进 JSONL 会让
   * 单行大到没法 grep、没法 tail，整条会话的重放也要把它搬一遍。图片本体就在工作区里，
   * 组模型请求的时候现读现转就行。
   */
  | { type: 'image'; path: string; mime: string }

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

/**
 * 消息来源。判别联合，可扩展——这是整个模型里最值钱的一处设计：
 * 注入内容的**出处**挂在这里，而不是新增事件族。知识库检索、长期记忆、
 * 运行时上下文快照都用自己的 `kind` 挂载各自的结构化载荷，
 * 「引用回溯」直接从载荷渲染。
 */
export type MessageSource =
  | { kind: 'user' }
  | { kind: 'plugin'; plugin: string; form?: string; [extra: string]: unknown }

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  reasoningTokens: number
  /** 美元。由模型目录的单价算出——缓存读与普通输入单价不同，别自己乘。 */
  cost?: number
}

/** 流式增量。适配器把各家协议翻译成这一套词汇。 */
export type StreamChunk =
  | { type: 'block-start'; index: number; kind: ContentBlock['type'] }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; callId?: string; name?: string; arguments?: string }
  | { type: 'block-end'; index: number }
  | { type: 'usage'; usage: Usage }
  | { type: 'finish'; reason: 'stop' | 'tool-calls' | 'length' | 'error'; error?: string }

/**
 * 事件类型到载荷的映射。加一种模型可见的输入就要在这里加一项——
 * 凡是进入模型请求的东西都必须能从日志重建，否则调用链路那屏放不出来。
 */
export interface SessionEventMap {
  /** 会话根记录，每个会话第一条。v3 起必须带 botId（v2 的 agentId 迁过来）。 */
  session: {
    version: number
    id: string
    createdAt: number
    title?: string
    /** 本实例内 Bot id。打开 /a/:id 靠它找回这条长会话。 */
    botId: string
    origin: SessionOrigin
    /** origin 不是 local 时，Gateway 上的定义 id。M1 用不到。 */
    remoteId?: string
  }
  'session/title': { title: string }

  /**
   * 上下文压缩点。
   *
   * 一个 Bot 一条长会话，会话只增不减，而每一轮都把全量历史重建成 messages 发出去——
   * 这条路走到底必然撞上下文窗口。所以到了阈值就把**旧的那一段**换成一段摘要。
   *
   * **换的只是送进模型的那一份。** JSONL 一条不删，界面、审计、`/internal/sessions/:id`
   * 看到的仍然是全量原文；模型想看原文也调得到（history_read / history_search）。
   * 这正是这件事敢做的前提：压缩不是丢弃，是把远处的东西挪到伸手可及的地方。
   *
   * **throughSeq 必须落在 turn/end 上。** 边界切在一轮中间的话，带 tool_calls 的助手
   * 消息会被摘要吃掉、而它的 tool/result 留在后面——provider 直接拒收
   * 「role 'tool' 必须紧跟在带 tool_calls 的消息之后」。
   *
   * 加这一种事件不算破坏性变更：老版本读到不认识的 type 会跳过，退化成发全量历史，
   * 也就是加它之前的行为。所以不动 SESSION_FORMAT_VERSION。
   */
  'session/compact': {
    /** 摘要覆盖到这一条（含）为止。之后的事件照旧逐条进上下文。 */
    throughSeq: number
    /** 覆盖区间的首尾时间。摘要正文里要写出来，否则「昨天」在压缩之后就断了。 */
    from: number
    to: number
    summary: string
    /** 诊断用：压掉了多少条消息、前后各值多少 token（估算）。 */
    droppedMessages: number
    tokensBefore: number
    tokensAfter: number
  }

  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: 'completed' | 'error' | 'aborted' }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }

  /** 每次模型请求的有效提示词与工具表；调用链路的 SYSTEM 段读这里。 */
  'request/header': {
    turn: number
    step: number
    provider: string
    model: string
    system: string
    tools: { name: string; description: string }[]
    /** 这个模型的上下文窗口。目录没拉到就没有这个字段。 */
    contextWindow?: number
    /**
     * 提示词各段占多少 token（估算）。
     *
     * **只有 bot 这边算得了**：事件里的 `tools` 只留了名字和描述，而参数表通常比描述
     * 还大，界面拿这份去估会把工具那段算漏一大半；`system` 里的 Skill 正文同理，拼完
     * 再切字符串既脆又白算一遍。所以在拼提示词的地方顺手量一次，量完带出来。
     *
     * 老日志没有这个字段——界面会退回只报总量，不编一个分段出来。
     */
    sections?: { system: number; skills: number; builtinTools: number; mcpTools: number }
  }

  'user/message': { message: Message; source: MessageSource }
  'assistant/chunk': { turn: number; step: number; chunk: StreamChunk }
  'assistant/message': { turn: number; step: number; message: Message; usage: Usage }

  'tool/call': { turn: number; step: number; callId: string; name: string; arguments: string }
  'tool/result': {
    turn: number
    step: number
    callId: string
    text: string
    /** 管道层失败（抛异常、超时、执行前被拒）。业务失败请写进 text。 */
    failed: boolean
    /**
     * 这次调用落地的文件，路径相对工作区根目录。界面据此给出可点开的预览。
     *
     * 可选字段，老日志没有——界面退回只显示工具名，**不去正则扫 text 猜路径**：
     * 那段文本是写给模型看的散文，措辞一改就扫不出来了。
     */
    files?: { path: string; name: string }[]
  }
}

export type SessionEvent = {
  [T in keyof SessionEventMap]: EventEnvelope<T>
}[keyof SessionEventMap]
