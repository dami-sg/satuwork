/**
 * 对话。整个前端最重的一块，也是唯一有长连接的一块：
 * 每个 Bot 一条 SSE、事件折叠成消息、增量重绘、以及对话页本身。
 */
let chatAbort = null
let chatStreamId = ''

/**
 * 每个 Bot 一条事件流。
 *
 * 侧栏那份名单要显示「最近一条回复的时间 + 摘要 + 在不在跑」，这三样只能从会话事件里
 * 拿。**只盯当前这条会话是不够的**：人在 A 上派了活、切到 B 去看别的，最想知道的恰恰
 * 是 A 什么时候干完——而以前一切走就把 A 的流掐了，从此两眼一抹黑。
 *
 * 摘要为什么不让 Gateway 给：db.ts 那边写着「会话索引只存指针，不存 user/message 或
 * assistant/message 正文」——正文留在席位机器上，Gateway 只有 sessionId 和计数。为了
 * 名单上一行灰字去破这条边界不划算，而流里本来就有全文。
 *
 * botId -> { sessionId, ac, events, sum }
 * sum = { busy, lastAt, lastText }，**增量维护**：每次渲染名单都去 fold 一遍全部事件，
 * 几个 Bot 各七百多条，光滚个侧栏就能把 CPU 吃满。
 */
const botStreams = new Map()

/** 同时开着的流的上限。名单通常只有两三个 Bot，这道闸是防意外，不是常态。 */
const BOT_STREAM_MAX = 8

function botStreamOf(botId) {
  let row = botStreams.get(botId)
  if (!row) {
    row = { sessionId: '', ac: null, events: [], sum: { state: 'idle', lastAt: 0, lastText: '' } }
    botStreams.set(botId, row)
  }
  return row
}

/** 事件到了就地更新摘要。O(1)，不 fold。 */
function noteBotEvent(botId, ev) {
  const row = botStreams.get(botId)
  if (!row) return
  const sum = row.sum
  const before = sum.state + '|' + sum.lastAt + '|' + sum.lastText
  if (ev.type === 'turn/start') sum.state = 'busy'
  else if (ev.type === 'turn/end') sum.state = 'idle'
  // **「待人工处理」还没有数据源。** 系统里的「需审批」目前只是 MCP 的配置项
  // （routes.ts 的 MCP_PERMS），运行时并没有「停下来等人点头」这件事——bot 要么在跑，
  // 要么跑完了。等哪天 bot 会为此发一条事件（比如 turn 挂起等审批），在这里加一行
  // `sum.state = 'review'` 就接上了，点的样式和三态判断都已经在位。
  else if (ev.type === 'user/message' || ev.type === 'assistant/message') {
    const text = messageText((ev.data || {}).message) || (ev.data || {}).text || ''
    if (text) {
      sum.lastText = text.replace(/\s+/g, ' ').trim().slice(0, 120)
      sum.lastAt = Number(ev.time) || sum.lastAt
    }
  } else if (ev.type === 'assistant/chunk') {
    // 流式期间也把时间往前推，否则「最近回复」会停在上一轮，看着像卡住了。
    sum.lastAt = Number(ev.time) || sum.lastAt
  }
  if (before !== sum.state + '|' + sum.lastAt + '|' + sum.lastText) scheduleRosterPaint()
}

/** 关掉一个 Bot 的流。事件留着——切回去时就不用再重放一遍历史。 */
function closeBotStream(botId) {
  const row = botStreams.get(botId)
  if (!row) return
  if (row.ac) {
    try {
      row.ac.abort()
    } catch {}
  }
  row.ac = null
}

function closeAllBotStreams() {
  for (const id of botStreams.keys()) closeBotStream(id)
  botStreams.clear()
}

/** 超出上限就先关最久没动静的那条，事件也一并丢掉。 */
function trimBotStreams(keepId) {
  if (botStreams.size <= BOT_STREAM_MAX) return
  const rows = [...botStreams.entries()].filter(([id, r]) => id !== keepId && r.sum.state === 'idle')
  rows.sort((a, b) => a[1].sum.lastAt - b[1].sum.lastAt)
  while (botStreams.size > BOT_STREAM_MAX && rows.length) {
    const [id] = rows.shift()
    closeBotStream(id)
    botStreams.delete(id)
  }
}

/**
 * 用户消息里的图片块（会话格式 v4 起）。
 *
 * 日志里存的是**路径**不是字节（见 bot 的 session/types.ts），所以这里拿到的也是路径，
 * 要显示还得走一趟预览接口——和点开产出文件是同一条路。
 */
function messageImages(msg) {
  const content = msg && msg.content
  if (!Array.isArray(content)) return []
  return content.filter((b) => b && b.type === 'image' && b.path).map((b) => ({ path: b.path, mime: b.mime || '' }))
}

function messageText(msg) {
  if (!msg) return ''
  if (typeof msg === 'string') return msg
  const content = msg.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((b) => (b && (b.type === 'text' || b.type === 'reasoning') ? b.text || '' : ''))
    .join('')
}

/**
 * 每条会话「此刻在不在跑」——**bot 亲口说的那一份**，不是扫事件扫出来的。
 *
 * 扫出来的那个（fold 里的 status）有个前提：手上这份历史是完整的。而它经常不成立，
 * 两种情况都很常见，表现完全一样——界面一直挂着「正在处理」，那边其实什么都没在跑：
 *
 *   · 流断在重放中途，尾巴那条 turn/end 没到；
 *   · 进程半路没了（崩溃、机器重启、每一次「重新部署」），日志里那条 turn/end 根本
 *     没写成，要等 bot 下次从磁盘读这条会话才补得上。
 *
 * 所以 bot 在 replay/done 上带了 live，收到就以它为准，之后再由实时的 turn 事件维护
 * ——那些是连着的时候一条条来的，可信。
 *
 * 键是 sessionId 而不是 botId：低层直接开的流（重连、测试）没有归属，但一样要有结论。
 * 没有这一项就说明 bot 没表态（老版本不带这个字段，或者流断在 replay/done 之前），
 * 那就回落到扫描——和以前一个样，不会更差。
 */
const chatLive = new Map()

/**
 * 每条会话的翻页状态：`{ firstSeq, hasMore, loading }`。
 *
 * 打开对话只取最近几轮（流上的 `tail` 参数），往上翻再一页页往前推。以前是整段推——
 * 实测 1078 条，慢，而且尾巴容易压在下游缓冲里出不来，那正是「历史缺一截 + 永远正在
 * 处理」的成因。`firstSeq` 是手上最靠前那条的 seq，也就是再往前翻的游标。
 */
const chatPages = new Map()

/** 打开一条会话先要几轮。人来是看最近说了什么的，更早的等他往上翻。 */
const CHAT_TAIL_TURNS = 20

function fold(events, live) {
  const blocks = []
  let assistant = null
  let tools = []
  let status = ''
  for (const ev of events || []) {
    const type = ev.type
    const data = ev.data || {}
    // 事件自带 time（bot 那边 append 时打的）。界面上要按天分隔、每条标时刻，
    // 所以 fold 得把它带出来——只有块的**第一条**事件的时间算数，流式续写的那些
    // chunk 不该让一条消息的时间一直往后跳。
    const at = Number(ev.time) || 0
    if (type === 'user/message') {
      if (data.source && data.source.kind && data.source.kind !== 'user') continue
      assistant = null
      tools = []
      blocks.push({
        kind: 'user',
        text: messageText(data.message) || data.text || '',
        images: messageImages(data.message),
        time: at,
        seq: ev.seq,
      })
    } else if (type === 'assistant/message') {
      const text = messageText(data.message)
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      if (text) assistant.text = text
    } else if (type === 'assistant/chunk') {
      const chunk = data.chunk || {}
      if (chunk.type === 'text-delta' && chunk.text) {
        if (!assistant) {
          assistant = { kind: 'assistant', text: '', tools, time: at, seq: ev.seq }
          blocks.push(assistant)
        }
        assistant.text += chunk.text
      }
    } else if (type === 'tool/call') {
      // 工具常常在助手吐出第一个字**之前**就开始跑（先查订单再回话）。以前只在已经有
      // 助手块时才把工具挂上去，于是这一段时间里工具痕迹无处可去，等回答开始才突然
      // 冒出来——正好是最想知道「它在干什么」的那几秒什么都看不到。这里补一条：工具
      // 一开跑就把助手块建出来，正文留空，界面上就是一个带工具痕迹的「正在想」气泡。
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      tools.push({ callId: data.callId, name: data.name || 'tool', result: null, failed: false })
      assistant.tools = tools
    } else if (type === 'tool/result') {
      const hit =
        tools.find((x) => x.callId && x.callId === data.callId && x.result == null) ||
        tools.find((x) => x.result == null) ||
        tools[tools.length - 1]
      if (hit) {
        hit.result = data.text || ''
        hit.failed = Boolean(data.failed)
        // 工具自己报出来的产出文件。老日志没有这个字段，也**不去扫 text 猜路径**——
        // 那段文本是写给模型的散文，措辞一改就扫不出来了。
        hit.files = Array.isArray(data.files) ? data.files : null
      }
    } else if (type === 'turn/start') {
      status = 'running'
    } else if (type === 'turn/end') {
      status = ''
    }
  }
  // bot 说过话就听它的：这份历史可能是截断的，而扫描对截断毫无抵抗力（见 chatLive）。
  if (typeof live === 'boolean') status = live ? 'running' : ''
  return { blocks, status }
}

/**
 * 放掉「当前流」这把闩，但不 abort。
 *
 * 建连失败的几条路径（fetch 抛、503、非 2xx）以前直接 return，把 chatAbort /
 * chatStreamId 留在「已占用」状态。ensureChatSession 和 startChatStream 都靠这两个值
 * 判断「已经有流在跑」，于是一次实例还没起来的 503 之后，聊天再也不会重连——要刷新
 * 整页才回得来。
 */
function releaseChatStream(ac, owner) {
  // 还要把 Bot 那一行的 ac 清掉：它是「这条流还活着」的唯一判据——warmBotStreams 靠它
  // 决定要不要补一条，ensureChatSession 的热路径靠它决定要不要直接把正文接回去。留着
  // 一个已经死掉的 ac，那两处就都以为流还在跑，于是谁也不再重连：切回这个 Bot 只会接到
  // 一个空的事件桶，刷新整页才回得来。
  const row = owner ? botStreams.get(owner) : null
  if (row && row.ac === ac) row.ac = null
  if (chatAbort !== ac) return
  chatAbort = null
  chatStreamId = ''
}

function stopChatStream() {
  if (chatAbort) {
    try {
      chatAbort.abort()
    } catch {}
  }
  chatAbort = null
  chatStreamId = ''
}

async function loadRuntimeBots() {
  state.runtimeError = ''
  try {
    const data = await api('GET', '/runtime/bots')
    state.runtimeBots = data.bots || []
  } catch (err) {
    state.runtimeBots = []
    throw err
  }
}

async function loadRuntimeMachine() {
  const id = orgId()
  if (!id || isOwner()) {
    state.runtimeMachine = null
    return
  }
  try {
    const data = await api('GET', `/orgs/${encodeURIComponent(id)}/machine`)
    state.runtimeMachine = data.machine || null
  } catch {
    state.runtimeMachine = null
  }
}

/**
 * 现在这一屏对着的是哪个 Bot。地址优先于 state：`go()` 先改地址再去拉数据，切换
 * 途中 state.chatBotId 还是上一个（见 ensureChatSession），照它去拉就是拉错人。
 */
function chatBotIdNow() {
  return chatBotIdOf(state.path) || state.chatBotId
}

async function loadDesktopRuntime(botId) {
  const id = botId || chatBotIdNow()
  if (isOwner() || !id) {
    state.desktopRuntime = null
    state.desktopRuntimeAt = 0
    return
  }
  let rt
  try {
    rt = await api('GET', '/runtime/desktop?botId=' + encodeURIComponent(id))
  } catch {
    // 期间人已经切走了：这次的失败也不作数，别把新 Bot 的席位清成 null。
    if (chatBotIdNow() !== id) return
    state.desktopRuntime = null
    state.desktopRuntimeAt = 0
    return
  }
  // 这一份是给 `id` 拉的。人在等待期间换了 Bot 的话，认领它就等于把新 Bot 的席位
  // 顶掉——右栏会显示上一个 Bot 的路径和桌面，而对话是新的那个。
  if (chatBotIdNow() !== id) return
  state.desktopRuntime = rt
  state.desktopRuntimeAt = Date.now()
}

/**
 * 把当前会话换成这个 Bot 的。
 *
 * **换 Bot 的第一件事是清场，不是去拿新会话。** 原先是等新会话拿回来、比对出
 * sessionId 变了才清 state.chatEvents——于是只要那一步没走到，屏幕上就还挂着上一个
 * Bot 的对话。而它非常容易走不到：新 Bot 的席位没起来时，`/runtime/bots/:id/session`
 * 直接 503「实例还没上线」，catch 里记一笔就返回了。结果是切过去之后，你看着的是**另
 * 一个 Bot 的聊天记录**，旧的那条流还连着，还在往里追新消息。
 *
 * 所以顺序反过来：Bot 一变，立刻停掉旧流、把正文和状态清空。拿不到新会话就是一片空
 * 白加一句「实例还没上线」——空白是诚实的，别人的对话不是。
 */
async function ensureChatSession(botId) {
  if (!botId) return
  if (state.chatBotId === botId && state.chatSessionId && chatStreamId === state.chatSessionId) return
  // 这个 Bot 的流一直开着（切走时没掐）——把正文接回去就行，不用重新拉一遍会话。
  const warm = botStreams.get(botId)
  if (warm && warm.ac && warm.sessionId && state.chatBotId !== botId) {
    if (state.chatBotId) state.chatDrafts[state.chatBotId] = { text: state.chatDraft, files: state.chatFiles }
    const kept = state.chatDrafts[botId] || { text: '', files: [] }
    state.chatBotId = botId
    state.chatSessionId = warm.sessionId
    state.chatEvents = warm.events
    state.chatReplaying = false
    state.chatDraft = kept.text
    state.chatFiles = kept.files
    chatAbort = warm.ac
    chatStreamId = warm.sessionId
    paintChat()
    return
  }
  if (state.chatBotId !== botId) {
    // **不掐上一个 Bot 的流。** 它可能正在干活，而名单上的转圈和「最近回复」就靠它。
    // 只把「当前会话」这把闩放开——正文渲染换到新 Bot 那边去。
    chatAbort = null
    chatStreamId = ''
    // 没发出去的草稿和附件是写给上一个 Bot 的，跟着它一起收起来；切回去还在。
    if (state.chatBotId) state.chatDrafts[state.chatBotId] = { text: state.chatDraft, files: state.chatFiles }
    const kept = state.chatDrafts[botId] || { text: '', files: [] }
    state.chatBotId = botId
    state.chatSessionId = ''
    // 正文直接指向这个 Bot 自己的事件桶：切回去时历史还在，不用再重放一遍。
    state.chatEvents = botStreamOf(botId).events
    state.chatStatus = ''
    state.chatReplaying = false
    state.chatDraft = kept.text
    state.chatFiles = kept.files
  }
  try {
    const data = await api('GET', '/runtime/bots/' + encodeURIComponent(botId) + '/session')
    const sessionId = data.sessionId
    if (!sessionId) throw new Error('没有会话')
    // 期间人又切走了：这次的结果已经不作数，认领了就会把新会话顶掉。
    if (state.chatBotId !== botId) return
    const row = botStreamOf(botId)
    if (row.sessionId && row.sessionId !== sessionId) {
      // 换了一条会话（席位重建过）——旧事件作废。
      row.events.length = 0
      row.sum = { state: 'idle', lastAt: 0, lastText: '' }
    }
    state.chatEvents = row.events
    state.chatSessionId = sessionId
    state.chatStatus = ''
    void startChatStream(sessionId, 0, botId)
  } catch (err) {
    const msg = String(err.message || '')
    if (msg.includes('实例还没上线')) state.runtimeError = '实例还没上线'
    else throw err
  }
}

async function loadChatPage() {
  state.chatCtxOpen = false
  // loadRuntimeBots 由 loadPage 统一拉（名单是全局侧栏，不只这一页要）。
  await loadRuntimeMachine()
  // 上下文占比要知道模型的窗口有多大。新日志的 request/header 自带，老日志没有，
  // 目录是那种情况下的唯一来源。**不 await，也不让它的失败冒出来**——一条灰字的提示
  // 不值得把整页的加载拖住或者拖挂。
  if (!(state.catalog || []).length) void loadCatalog().catch(() => {})
  const botId = chatBotIdOf(state.path)
  await loadDesktopRuntime(botId)
  if (botId) await ensureChatSession(botId)
  // 名单上每个 Bot 都挂一条流。刷新页面之后也能立刻看出谁在干活、谁最近说了什么——
  // 只连当前这一个的话，那两列信息要等人挨个点进去才出得来。
  void warmBotStreams()
}

/**
 * 给名单上的每个 Bot 都开一条流（当前这个除外，它自己会开）。
 *
 * 串着来、不并发：每条流一上来都要重放整段历史，几个 Bot 同时灌会把主线程压住，
 * 而这些数据只是侧栏上的一行字，不该跟正文抢。
 */
async function warmBotStreams() {
  for (const b of state.runtimeBots || []) {
    if (!b || !b.id) continue
    // 当前这个由 ensureChatSession 开（它还要接正文），这里只管别的。
    if (b.id === state.chatBotId && botStreams.get(b.id)?.ac) continue
    const row = botStreams.get(b.id)
    if (row && row.ac) continue
    try {
      const data = await api('GET', '/runtime/bots/' + encodeURIComponent(b.id) + '/session')
      if (!data.sessionId) continue
      const r = botStreamOf(b.id)
      if (r.sessionId && r.sessionId !== data.sessionId) {
        r.events.length = 0
        r.sum = { state: 'idle', lastAt: 0, lastText: '' }
      }
      void startChatStream(data.sessionId, 0, b.id)
    } catch {
      // 席位没上线之类——名单上这一行就没有时间和摘要，不该让整页跟着出错。
    }
  }
}

/**
 * 事件流游标。断线重连时带上它，服务端从这一条之后继续发。
 *
 * 事件里的 `seq` 是会话日志的行号，天然单调，所以「续传」就是把最后见到的那个数
 * 回传过去——不需要去重，也不会重放已经画出来的内容。
 */
function chatCursor(botId) {
  const list = botId ? botStreamOf(botId).events : state.chatEvents
  for (let i = list.length - 1; i >= 0; i--) {
    const n = Number(list[i] && list[i].seq)
    if (Number.isFinite(n)) return n
  }
  return null
}

/** 这条会话归哪个 Bot。事件回来时要知道记到谁头上。 */
function botIdOfSession(sessionId) {
  for (const [id, row] of botStreams) if (row.sessionId === sessionId) return id
  return ''
}

/**
 * 断了自己接回来。
 *
 * 以前是「流断了就停，下次打开会话才重连」——网络抖一下、或者机器管家换版重启一
 * 次，正在看的对话就无声地卡住了，人还以为 bot 在想。退避重试到第 6 次为止，
 * 之后才把「连接断开」摆到界面上。
 */
const CHAT_RETRY_MAX = 6
/** 连接活够这么久，就算「真的连上过」，退避档位归零。 */
const CHAT_ALIVE_MS = 10_000

async function startChatStream(sessionId, attempt = 0, botId = '') {
  const owner = botId || botIdOfSession(sessionId)
  const isActive = () => state.chatSessionId === sessionId
  if (attempt === 0) {
    const row = owner ? botStreamOf(owner) : null
    // 这条流已经在跑就别再开一条。**换 Bot 不再掐流**：名单要靠它继续报「跑完没有」。
    if (row && row.sessionId === sessionId && row.ac) {
      // 但**必须把它认领成当前那条**，不能只是 return。
      //
      // 它很可能是 warmBotStreams 当后台流开的——loadPage 里那句 `void warmBotStreams()`
      // 跑在 loadChatPage 前面，正在打开的这个 Bot 也在名单里。开的时候它还不是当前会
      // 话，chatAbort / chatStreamId 都没设。随后 ensureChatSession 把 chatSessionId 指
      // 过来，这条流在读循环里就同时满足了「是当前会话」和「chatStreamId 对不上」——那
      // 正是「人已经切走了」的判据，于是它自己收摊；retryChatStream 又拿同一把闩去认它，
      // 一次都不重连。结果就是正文一片空白、名单上没时间没摘要，切走再切回来还是空的
      // （热路径看见 ac 还在，以为流好着呢），只能刷新整页——而刷新之后这场竞态照样掷骰子。
      if (isActive() && chatAbort !== row.ac) {
        chatAbort = row.ac
        chatStreamId = sessionId
      }
      return
    }
    if (isActive()) stopChatStream()
  }
  const ac = new AbortController()
  if (owner) {
    const row = botStreamOf(owner)
    row.sessionId = sessionId
    row.ac = ac
    trimBotStreams(owner)
  }
  // `|| !owner`：没归到哪个 Bot 名下的流（低层直接调用、测试）按老规矩走单流那一套，
  // 否则它既不在 botStreams 里、又不是当前会话，就成了没人认领的孤儿——断了不重连，
  // 也没人把「连接断开」摆到界面上。
  if (isActive() || !owner) {
    chatAbort = ac
    chatStreamId = sessionId
    // 断线重连（带 after）也可能补一大段，同样先拉闸。
    beginReplay()
  }
  const t = token()
  const after = chatCursor(owner)
  // 头一次连（手上还没有事件）才要 tail；续传时 after 说了算，要的是「补上错过的」。
  const q = after != null ? '?after=' + encodeURIComponent(after) : '?tail=' + CHAT_TAIL_TURNS
  let res
  try {
    res = await fetch('/runtime/sessions/' + encodeURIComponent(sessionId) + '/events' + q, {
      headers: {
        accept: 'text/event-stream',
        ...(t ? { authorization: 'Bearer ' + t } : {}),
      },
      signal: ac.signal,
    })
  } catch (err) {
    releaseChatStream(ac, owner)
    endReplay()
    if (ac.signal.aborted) return
    state.runtimeError = '实例还没上线'
    paintChat()
    return
  }
  if (res.status === 503) {
    releaseChatStream(ac, owner)
    endReplay()
    state.runtimeError = '实例还没上线'
    paintChat()
    return
  }
  if (!res.ok || !res.body) {
    releaseChatStream(ac, owner)
    endReplay()
    state.runtimeError = (await res.text().catch(() => '')) || '实例还没上线'
    paintChat()
    return
  }
  const reader = res.body.getReader()
  // 重放卡在半路的看门狗。收到 replay/done 就撤——那之后长时间没动静是正常的。
  let sawDone = false
  let stallTimer = null
  const disarmStall = () => {
    sawDone = true
    clearTimeout(stallTimer)
  }
  const armStall = () => {
    if (sawDone) return
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => {
      if (sawDone || ac.signal.aborted) return
      try {
        ac.abort()
      } catch {}
      // 把这一行的 ac 让出去，否则重连会撞上「已经在跑」的那道闸。
      if (owner) {
        const r = botStreams.get(owner)
        if (r && r.ac === ac) r.ac = null
      }
      void startChatStream(sessionId, 0, owner)
    }, REPLAY_STALL_MS)
  }
  armStall()
  const openedAt = Date.now()
  const decoder = new TextDecoder()
  let buf = ''
  /**
   * 下一次重连用哪个退避档位。
   *
   * 判据是**这次连接活了多久**，不是「有没有连上」。两头都要照顾：
   *
   * - 只看「连上了没有」：bot 在崩溃重启循环里（接受连接后立刻断），每次都拿到 200，
   *   档位每次归零，于是每 500ms 重连一次、永远停不下来，也永远走不到「连接断开」。
   * - 只看「一共重连过几次」：一个开着一整天的标签页，被中间那一跳定期掐断 6 次之后
   *   就再也接不回来了——可每一次它都是连上的。
   *
   * 活够 CHAT_ALIVE_MS 才算一次真连接，归零；没活够就沿用当前档位继续退避。
   */
  const nextAttempt = () => (Date.now() - openedAt >= CHAT_ALIVE_MS ? 0 : attempt)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // 这条流已经不是「当前那条」了就收摊。切 Bot 的一瞬间，旧流手上可能还攥着一段
      // 已经收到、还没解析的数据；不在这里拦住，它会落进新会话的事件数组里，画出来
      // 就是两个 Bot 的消息串在一起。
      //
      // 判据以 chatStreamId 为准（换 Bot 必经 stopChatStream，它就是那把闩）。
      // chatSessionId 只在**已经认定了某条会话**时才参与——低层直接调 startChatStream
      // 的路径（重连、测试）还没来得及认领，不该被当成「串台」拦掉。
      if (ac.signal.aborted) break
      // **不再因为「不是当前会话」就收摊**：后台那几条流正是名单上时间、摘要和转圈的
      // 唯一来源。只有当前这条要盯 chatStreamId（重连时它会被换掉）。
      if (isActive() && chatStreamId !== sessionId) break
      armStall()
      buf += decoder.decode(value, { stream: true })
      buf = buf.replace(/\r\n/g, '\n')
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue
          let ev
          try {
            ev = JSON.parse(line.slice(6))
          } catch {
            continue
          }
          if (!ev || typeof ev !== 'object') continue
          if (ev.type === 'replay/done') {
            disarmStall()
            // bot 明说历史放完了。它不是会话事件，不进事件桶。
            // 顺带说了这条会话此刻在不在跑——这句是权威，压过扫出来的那个结论。
            if (typeof ev.firstSeq === 'number' || typeof ev.hasMore === 'boolean') {
              const cur = chatPages.get(sessionId) || {}
              chatPages.set(sessionId, {
                ...cur,
                // 续传（after>0）那次 bot 不给这两个值，别把已有的覆盖掉。
                firstSeq: typeof ev.firstSeq === 'number' ? ev.firstSeq : cur.firstSeq,
                hasMore: typeof ev.hasMore === 'boolean' ? ev.hasMore : cur.hasMore,
                loading: false,
              })
              scheduleLoadMorePaint()
            }
            if (typeof ev.live === 'boolean') {
              chatLive.set(sessionId, ev.live)
              // 名单上那颗点也是扫出来的，同样会挂在「正在执行」上下不来。
              if (owner) {
                botStreamOf(owner).sum.state = ev.live ? 'busy' : 'idle'
                scheduleRosterPaint()
              }
            }
            if (isActive()) {
              endReplay()
              // **必须无条件重画。** endReplay 的第一行是「闸已经开过了就 return」，
              // 而重放一段长历史（实测 988 条）必然撞上 4 秒硬上限或 120ms 静默兜底，
              // 闸早就自己开了。于是走到这儿时 endReplay 直接返回——bot 刚给的结论
              // 存进了 chatLive，却一帧都没画出来。而这之后没有任何事件会再来触发重绘
              // （正因为它说的就是「没在跑」），界面就永远停在开闸那一刻的样子：
              // 一个悬着的 turn/start，一句「正在处理」，等多久都不变。
              schedulePaintChat()
            }
            continue
          }
          // bot 表过态之后，这个结论就由实时的 turn 事件接着维护。表态之前不碰它——
          // 那会儿来的是重放的历史，正是不能拿来下结论的那一批。
          if (chatLive.has(sessionId) && (ev.type === 'turn/start' || ev.type === 'turn/end')) {
            chatLive.set(sessionId, ev.type === 'turn/start')
          }
          if (owner) {
            botStreamOf(owner).events.push(ev)
            noteBotEvent(owner, ev)
          } else if (isActive()) {
            // 没有归属又不是当前会话的流，事件无处可放——**绝不能倒进 chatEvents**，
            // 那正是「切走了，旧流剩下的半截落进新会话」的老毛病。
            state.chatEvents.push(ev)
          }
          if (!isActive()) continue
          if (state.chatReplaying) bumpReplayQuiet()
          else schedulePaintChat()
        }
      }
    }
  } catch (err) {
    disarmStall()
    endReplay()
    if (!ac.signal.aborted) return retryChatStream(sessionId, ac, nextAttempt())
    return
  }
  disarmStall()
  endReplay()
  // 正常读到 done 也要重连：SSE 被中间那一跳掐掉时看起来就是干净的流结束。
  if (!ac.signal.aborted) return retryChatStream(sessionId, ac, nextAttempt())
}

function retryChatStream(sessionId, ac, attempt) {
  const owner = botIdOfSession(sessionId)
  const row = owner ? botStreams.get(owner) : null
  // 后台流也要重连——名单上的「跑完没有」全指望它。
  if (row ? row.ac !== ac : chatAbort !== ac || chatStreamId !== sessionId) return
  if (attempt >= CHAT_RETRY_MAX) {
    // 认输了就把 ac 清掉。留着它，切回这个 Bot 时热路径会以为流还开着，直接接一个
    // 空事件桶上去，再也不会重连。
    releaseChatStream(ac, owner)
    state.runtimeError = '连接断开，刷新页面重试'
    paintChat()
    return
  }
  const delay = Math.min(500 * 2 ** attempt, 8000)
  setTimeout(() => {
    // 判据要和上面那一条一样。后台流不在 chatAbort 名下，拿当前会话那把闩去认它，
    // 它就永远等不到这次重连——名单上的时间和摘要从此停在断线那一刻。
    const r = owner ? botStreams.get(owner) : null
    if (r ? r.ac !== ac : chatAbort !== ac || chatStreamId !== sessionId) return
    void startChatStream(sessionId, attempt + 1, owner)
  }, delay)
}

/**
 * 重放闸。
 *
 * 打开一条会话时，SSE 会把**全部历史**从头推一遍，和后续的实时事件走同一个通道。
 * 一条 8 轮的对话就是 789 条事件（其中 706 条是流式 chunk）。以前每收到一条就重绘一
 * 次：每次都要 fold 全量事件、比对整棵 DOM、把最后那段 Markdown 重渲染一遍——O(n²)，
 * 而且屏幕上能看见消息一条条往外冒。
 *
 * 更糟的是**状态是错的**：重放到某轮的 `turn/start` 就显示「正在处理」，要等重放出
 * 配对的 `turn/end` 才消失。实测 789 帧里有 772 帧（98%）挂着「正在处理」，而那期间
 * 什么都没在跑——它说的是几小时前那一轮。
 *
 * 所以重放期间只收不画，历史放完再画一次。两个判据：
 *   1. bot 发的 `replay/done`（准确，但要 bot 也升级）
 *   2. 静默 120ms（兜底：重放是连续灌的，一停就是灌完了）
 * 外加 4 秒硬上限，免得某条流一直断续把闸卡死。
 */
/**
 * 重放停在半路多久算「卡住了」。
 *
 * bot 把整段历史 enqueue 完就立刻发 `replay/done`，两者在网线上几乎是挨着的。所以
 * 「收着收着没了、而且迟迟等不到 replay/done」只有一种解释：尾巴压在下游某一层的
 * 缓冲里，而一条安静的会话再也不会有新字节把它顶出去。实测就是这样丢了 24 条。
 *
 * 到点就带着游标重连——bot 会把缺的那截补上，`replay/done` 也跟着来。比干等强，
 * 也比整页刷新强：刷新是从 0 再放一遍，缓冲边界照样可能卡在同一个地方。
 */
const REPLAY_STALL_MS = 8000
const REPLAY_QUIET_MS = 120
const REPLAY_MAX_MS = 4000
let replayQuietTimer = null
let replayCapTimer = null

function beginReplay() {
  state.chatReplaying = true
  clearTimeout(replayCapTimer)
  replayCapTimer = setTimeout(() => endReplay(), REPLAY_MAX_MS)
  bumpReplayQuiet()
}

/** 又来一条：重放还在继续，把「静默」判定往后推。 */
function bumpReplayQuiet() {
  if (!state.chatReplaying) return
  clearTimeout(replayQuietTimer)
  replayQuietTimer = setTimeout(() => endReplay(), REPLAY_QUIET_MS)
}

function endReplay() {
  clearTimeout(replayQuietTimer)
  clearTimeout(replayCapTimer)
  if (!state.chatReplaying) return
  state.chatReplaying = false
  paintChat()
}

let chatPaintQueued = false

/**
 * 流式渲染期间合并重绘。
 *
 * 每个 token 都整块 innerHTML 重建一次会话，是 O(n²)：第 n 个 token 要连带重画前面
 * n-1 条消息。一帧一次就够，人眼分辨不出差别，长会话下差别很大。
 */
function schedulePaintChat() {
  if (chatPaintQueued) return
  chatPaintQueued = true
  const run = () => {
    chatPaintQueued = false
    paintChat()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 16)
}

/* ══ 对话渲染 ════════════════════════════════════════════════════════
   一轮回答期间 paintChat 每帧跑一次，所以这里只有一条规矩：**只动变了的那一块**。
   两层各管一段：

     消息层  syncThread —— 按 data-key 比对，新消息插进来，旧的连节点都不换
     正文层  syncMd     —— 把正文切成 Markdown 顶层块，只重画正在长的那一块

   两层都要。只做消息层的话，一条越写越长的回答每帧都要重排整段正文，连带把里面
   已经画好的 mermaid 图和公式重画一遍；只做正文层的话，每帧还是在重建整条消息流。
   分开之后稳定的部分节点身份不变，markdown.js 打在上面的 data-done 才作数。
   ══════════════════════════════════════════════════════════════════ */

/* 时间戳统一按这个时区读。跟 fmtTime 保持一致——同一屏上两套时区最难查。 */
const CHAT_TZ = 'Asia/Kuching'

function chatClock(ms) {
  if (!ms) return ''
  return new Intl.DateTimeFormat('en-GB', { timeZone: CHAT_TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
}

/** YYYY-MM-DD，只用来比「是不是同一天」。 */
function chatDayKey(ms) {
  if (!ms) return ''
  return new Intl.DateTimeFormat('en-CA', { timeZone: CHAT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
}

function chatDayLabel(ms) {
  const key = chatDayKey(ms)
  if (!key) return ''
  const now = Date.now()
  if (key === chatDayKey(now)) return t('今天')
  if (key === chatDayKey(now - 86400000)) return t('昨天')
  return key
}

const ICON_CLIP =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>'
const ICON_X =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'

/* 发送 / 停止。同一个按钮的两副面孔，所以放在一起。 */
const ICON_SEND =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>'
const ICON_STOP =
  '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="none" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'

const ICON_BOT =
  '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>'
const ICON_TOOL =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>'
const ICON_DOWN =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>'
const ICON_FILE =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h6"/></svg>'

/** 当前这条对话属于哪个 Bot。抬头和导出都要用。 */
function chatBotOf() {
  const id = chatBotIdOf(state.path) || state.chatBotId
  return (state.runtimeBots || []).find((b) => b.id === id) || null
}

/**
 * 一条工具痕迹。
 *
 * 只露名字和状态，**不展开结果**：工具结果动辄几千字（一次文件读、一次搜索），摊在
 * 对话里会把真正的回答挤到屏幕外。要看细节去右栏的运行环境。
 */
/**
 * 这条消息里 Bot 落地的文件，按路径去重。
 *
 * 同一个文件被 edit 三次只该出现一次——人关心的是「产出了什么」，不是「被碰了几下」。
 */
function outputFiles(tools) {
  const seen = new Map()
  for (const x of tools || []) {
    for (const f of x.files || []) {
      if (f && f.path && !seen.has(f.path)) seen.set(f.path, f)
    }
  }
  return [...seen.values()]
}

/**
 * 缩略图自动加载的上限。
 *
 * 缩略图取的是**原图**——没有服务端缩放（那要拉原生图像库，而部署包是预打的 arm64）。
 * 所以大图不自动拉，留占位，点开再说：一屏十张 8 MB 的图会把内存和带宽一起吃掉。
 */
const SHOT_AUTO_MAX = 2 * 1024 * 1024

/** path → blob URL。同一张图在历史里可能出现多次，只取一次。 */
const SHOT_CACHE = new Map()
const SHOT_CACHE_MAX = 40

function shotCachePut(path, url) {
  SHOT_CACHE.set(path, url)
  while (SHOT_CACHE.size > SHOT_CACHE_MAX) {
    const oldest = SHOT_CACHE.keys().next().value
    const dead = SHOT_CACHE.get(oldest)
    SHOT_CACHE.delete(oldest)
    /**
     * **只吊销没人再看的那份。**
     *
     * 被挤出缓存不等于没人用：那张图多半还挂在上面某条消息的 <img> 上。吊销掉，
     * 那个节点下次重绘（往前翻一页历史、或者这一行的 data-sig 变了）就会拿着一个
     * 已经作废的 blob: 去取图，显示成永久破图——而缓存里已经没有它，fillShots 也
     * 只认带 data-shot 的占位元素，不会再去补。
     */
    if (dead && !shotInUse(dead)) setTimeout(() => URL.revokeObjectURL(dead), 0)
  }
}

/** 这个 blob URL 还挂在页面上吗。遍历而不是拼属性选择器——省掉一层转义的坑。 */
function shotInUse(url) {
  for (const img of document.querySelectorAll('.sw-shot img')) {
    if (img.src === url) return true
  }
  return false
}

/** 把占位换成真图。失败就留占位——一张图没取到，不该让整条消息看起来出了错。 */
async function fillShots(host) {
  if (!host || !state.chatSessionId) return
  const sessionId = state.chatSessionId
  for (const el of host.querySelectorAll('.sw-shot[data-shot]')) {
    const path = el.getAttribute('data-shot')
    // 取过就别再取：这个函数每帧都可能被调到。
    el.removeAttribute('data-shot')
    if (!path) continue
    const cached = SHOT_CACHE.get(path)
    if (cached) {
      el.innerHTML = '<img src="' + esc(cached) + '" alt="">'
      continue
    }
    try {
      const url = '/runtime/sessions/' + encodeURIComponent(sessionId) + '/files?path=' + encodeURIComponent(path)
      const res = await fetch(url, { headers: authHeaders() })
      // 不读的响应体要显式收掉，否则连接和缓冲会一直挂着——一屏十张大图就是十条，
      // 正好是下面那道大小闸想省下的开销。
      if (!res.ok) {
        await res.body?.cancel().catch(() => {})
        continue
      }
      if (Number(res.headers.get('content-length') || 0) > SHOT_AUTO_MAX) {
        await res.body?.cancel().catch(() => {})
        continue
      }
      const blob = await res.blob()
      const objectUrl = URL.createObjectURL(blob)
      shotCachePut(path, objectUrl)
      el.innerHTML = '<img src="' + esc(objectUrl) + '" alt="">'
    } catch {
      /* 留占位 */
    }
  }
}

/**
 * 用户发的一张图。
 *
 * 用 <img> 直接指预览接口是不行的——Gateway 认 Authorization 头，而 src= 带不了头。
 * 所以先画一个占位，等 loadShot 把 blob 取回来再填进去。
 */
function shotHtml(img) {
  return (
    `<button type="button" class="sw-shot" data-act="chat-preview" data-path="${esc(img.path)}" ` +
    `data-name="${esc(img.path.split('/').pop() || img.path)}" data-shot="${esc(img.path)}" ` +
    `title="${esc(img.path)}"><span class="sw-shot-ph">${ICON_FILE}</span></button>`
  )
}

/** 一个可点开的产出文件。这是「用户怎么发现 Bot 生成了东西」的那一环。 */
function fileChipHtml(f) {
  return (
    `<button type="button" class="sw-chip sw-filechip" data-act="chat-preview" ` +
    `data-path="${esc(f.path)}" data-name="${esc(f.name || f.path)}" title="${esc(f.path)}">` +
    `${ICON_FILE}<span>${esc(f.name || f.path)}</span></button>`
  )
}

function chipHtml(x) {
  const state_ = x.result == null ? 'running' : x.failed ? 'error' : 'done'
  const label = x.result == null ? t('调用中') : x.failed ? t('失败') : t('完成')
  return `<span class="sw-chip" data-state="${state_}" title="${esc(x.name + ' · ' + label)}">${ICON_TOOL}<span>${esc(x.name)} · ${esc(label)}</span></span>`
}

/** 一条消息的外壳。正文和工具条留空，交给 updateRow 填——它俩每帧都可能变。 */
function rowShell(b, key) {
  const account = (state.me && state.me.account) || {}
  const avatar = b.kind === 'user' ? esc(initialOf(account)) : ICON_BOT
  // 时间戳两侧一致，都挂在气泡外面（见 chat.css 里 .sw-time 的说明）。
  const time = b.time ? `<time class="sw-time" datetime="${new Date(b.time).toISOString()}">${esc(chatClock(b.time))}</time>` : ''
  return (
    `<div class="sw-msg" data-role="${b.kind}" data-key="${key}">` +
    `<div class="sw-msg-avatar" aria-hidden="true">${avatar}</div>` +
    `<div class="sw-msg-col">` +
    `<div class="sw-bubble" data-role="${b.kind}"><div class="sw-md"></div><div class="sw-chips" hidden></div></div>` +
    `${time}</div></div>`
  )
}

/**
 * 把 host 的子节点对齐到 text 渲染出的 Markdown 块。
 *
 * 每个子节点记着自己那一块的**源文本**（data-sig）。源文本没变就整块跳过——节点原地
 * 保留，里面已经渲染好的 KaTeX、高亮、mermaid 图跟着一起留下。流式输出下只有最后一块
 * 在变，所以每帧真正重画的就那一块。
 */
function syncMd(host, text, streaming) {
  const md = window.satuMd
  if (!md) {
    host.textContent = String(text || '')
    return
  }
  // healStream 看的是整段正文的末尾，所以要先补齐再切块，不能切完逐块补。
  const src = streaming ? md.healStream(text) : String(text == null ? '' : text)
  const parts = src.trim() ? md.splitBlocks(src) : []
  const kids = host.children
  for (let i = 0; i < parts.length; i++) {
    const cur = kids[i]
    if (cur && cur.getAttribute('data-sig') === parts[i]) continue
    const box = document.createElement('div')
    box.className = 'sw-mdblock'
    box.setAttribute('data-sig', parts[i])
    box.innerHTML = md.render(parts[i])
    if (cur) host.replaceChild(box, cur)
    else host.appendChild(box)
  }
  while (kids.length > parts.length) host.removeChild(kids[kids.length - 1])
}

/** 正文 + 工具条就地更新。streaming 指「这条还在写」，只有最后一条会是 true。 */
function updateRow(el, b, streaming) {
  const bubble = el.querySelector('.sw-bubble')
  const md = bubble.querySelector('.sw-md')
  const chips = bubble.querySelector('.sw-chips')

  // 用户发的图：缩略图排在正文上面，点开走预览。没有这一段，人发完图只看得见
  // 自己那句话，图像是发进了黑洞。
  const shots = b.images || []
  let strip = bubble.querySelector('.sw-shots')
  const shotSig = shots.map((x) => x.path).join('|')
  if (shots.length && !strip) {
    strip = document.createElement('div')
    strip.className = 'sw-shots'
    bubble.insertBefore(strip, md)
  }
  if (strip && strip.getAttribute('data-sig') !== shotSig) {
    strip.setAttribute('data-sig', shotSig)
    strip.innerHTML = shots.map(shotHtml).join('')
    strip.hidden = !shots.length
    void fillShots(strip)
  }

  if (!String(b.text || '').trim() && streaming) {
    // 还没吐字。给一个空气泡里的三点——它就地长成正文，位置不跳。
    if (!md.querySelector('.sw-typing')) md.innerHTML = '<span class="sw-typing"><i></i><i></i><i></i></span>'
  } else {
    if (md.querySelector('.sw-typing')) md.innerHTML = ''
    syncMd(md, b.text, streaming)
  }

  const tools = b.tools || []
  const outs = outputFiles(tools)
  const sig =
    tools.map((x) => x.name + (x.result == null ? '·' : x.failed ? '!' : '=')).join('|') +
    '#' +
    outs.map((f) => f.path).join('|')
  if (chips.getAttribute('data-sig') !== sig) {
    chips.setAttribute('data-sig', sig)
    chips.innerHTML = tools.map(chipHtml).join('') + outs.map(fileChipHtml).join('')
    chips.hidden = !tools.length && !outs.length
  }
}

/**
 * 要画哪些行。日期分隔是**算出来的**，不是数据里的——相邻两条不在同一天就插一条。
 */
/**
 * 往前翻一页。
 *
 * 插在**开头**，所以要做两件事，缺一件人就会失去位置感：
 *   · 节点按 key 认（见 syncThread），插进来的只是开头那几条，别的原地不动；
 *   · 补回滚动位置——内容在上面长高了多少，scrollTop 就往下推多少，视线才不会跳。
 */
async function loadOlderChat(sessionId) {
  const page = chatPages.get(sessionId)
  if (!page || !page.hasMore || page.loading || !page.firstSeq) return
  chatPages.set(sessionId, { ...page, loading: true })
  paintLoadMore()
  try {
    const data = await api(
      'GET',
      `/runtime/sessions/${encodeURIComponent(sessionId)}/history?turns=${CHAT_TAIL_TURNS}&before=${page.firstSeq}`,
    )
    const older = (data && data.events) || []
    const owner = botIdOfSession(sessionId)
    const list = owner ? botStreamOf(owner).events : state.chatEvents
    if (older.length) {
      const thread = document.getElementById('chat-thread')
      chatAnchorHeight = thread ? thread.scrollHeight : 0
      list.unshift(...older)
    }
    chatPages.set(sessionId, {
      firstSeq: typeof data.firstSeq === 'number' ? data.firstSeq : page.firstSeq,
      hasMore: Boolean(data.hasMore),
      loading: false,
    })
  } catch (err) {
    // 翻不动就把「加载更多」放回去，别把这一段历史永久锁死。
    chatPages.set(sessionId, { ...page, loading: false })
    state.runtimeError = errText(err.message) || err.message
  }
  paintChat()
}

/** 上一次往前插之前，正文有多高。插完拿它补回滚动位置。0 表示这一帧没插东西。 */
let chatAnchorHeight = 0

function loadMoreRow(sessionId) {
  const page = chatPages.get(sessionId)
  if (!page || !page.hasMore) return null
  const label = page.loading ? t('加载中…') : t('加载更早的对话')
  return {
    kind: 'more',
    // key 带上状态：loading 一变就是新节点，省得再为一行字做一套「就地更新」。
    key: page.loading ? 'more-loading' : 'more',
    html: `<div class="sw-more" style="display: flex; justify-content: center; padding: var(--space-3) 0;"><button type="button" class="satu-linkbtn" data-act="chat-older" ${page.loading ? 'disabled' : ''}>${esc(label)}</button></div>`,
  }
}

let loadMorePaintQueued = false

/** 只重画顶部那一行，不动正文。 */
function scheduleLoadMorePaint() {
  if (loadMorePaintQueued) return
  loadMorePaintQueued = true
  const run = () => {
    loadMorePaintQueued = false
    paintLoadMore()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 16)
}

function paintLoadMore() {
  if (document.getElementById('chat-thread')) paintChat()
}

function threadRows(folded, sessionId) {
  const blocks = folded.blocks || []
  const rows = []
  const more = sessionId ? loadMoreRow(sessionId) : null
  if (more) rows.push(more)
  let lastDay = ''
  blocks.forEach((b, i) => {
    const day = chatDayKey(b.time)
    if (day && day !== lastDay) {
      lastDay = day
      rows.push({ kind: 'day', key: 'd' + day, html: `<div class="sw-daydiv"><span>${esc(chatDayLabel(b.time) + ' ' + chatClock(b.time))}</span></div>` })
    }
    // key 必须**跟着这一块自己**走，不能用下标：往前翻加载旧消息会让所有下标移位，
    // 于是整棵 DOM 重建——Markdown 全部重渲染，滚动位置也跟着没了。
    rows.push({ kind: 'msg', key: 'm' + (b.seq != null ? b.seq : 'i' + i), block: b })
  })
  // 轮次开着但助手那条还没建出来（工具先跑、或者刚发出去）——补一条空的，
  // 让「正在想」有地方待着，而不是让输入框上面挂一行状态文字。
  const last = blocks[blocks.length - 1]
  if (folded.status && (!last || last.kind === 'user')) {
    rows.push({ kind: 'msg', key: 'm' + blocks.length, block: { kind: 'assistant', text: '', tools: [], time: 0 } })
  }
  return rows
}

function syncThread(thread, folded, sessionId) {
  const rows = threadRows(folded, sessionId)
  // 空会话就留空。以前这里摆一句「继续这段对话…」——它只在**刚开一条新对话**时出现
  // 一瞬间，而输入框的 placeholder 已经说了该干什么。多一句灰字只是让空屏更吵。
  if (!rows.length) {
    if (thread.getAttribute('data-empty') !== '1') {
      thread.setAttribute('data-empty', '1')
      thread.innerHTML = ''
    }
    return
  }
  if (thread.getAttribute('data-empty') === '1') {
    thread.removeAttribute('data-empty')
    thread.innerHTML = ''
  }
  // **按 key 认节点，不按位置。** 位置对齐在「只往后追加」的年代够用，但往前翻会在
  // 开头插一批，之后每个位置都对不上，于是每个节点都被替换掉——看着是「重绘了一下」，
  // 实际是整段 Markdown 重渲染 + 滚动位置丢失。
  const byKey = new Map()
  for (const kid of [...thread.children]) {
    const k = kid.getAttribute('data-key')
    if (k) byKey.set(k, kid)
  }
  let prev = null
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    let node = byKey.get(row.key)
    if (node) byKey.delete(row.key)
    else {
      const box = document.createElement('div')
      box.innerHTML = row.html ? row.html : rowShell(row.block, row.key)
      node = box.firstElementChild
      if (row.html) node.setAttribute('data-key', row.key)
    }
    const want = prev ? prev.nextSibling : thread.firstChild
    if (node !== want) thread.insertBefore(node, want)
    if (row.kind === 'msg') updateRow(node, row.block, folded.status ? i === rows.length - 1 : false)
    prev = node
  }
  for (const stale of byKey.values()) {
    if (stale.parentNode === thread) thread.removeChild(stale)
  }
}

/**
 * 贴底。
 *
 * 以前是每帧无条件 `scrollTop = scrollHeight`：往上翻历史时，回答每吐一个字就把人拽
 * 回底部，根本读不了前面。改成「本来就在底部附近才跟着走」，翻上去了就停住，另外给一
 * 个「回到底部」的按钮把路留回来。
 */
const STICK_SLACK = 80

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_SLACK
}

function paintChat() {
  const thread = document.getElementById('chat-thread')
  const folded = fold(state.chatEvents, chatLive.get(state.chatSessionId))
  state.chatStatus = folded.status
  if (!thread) return

  const stick = thread.getAttribute('data-touched') !== '1' || nearBottom(thread)
  syncThread(thread, folded, state.chatSessionId)
  if (window.satuMd) satuMd.enhance(thread)
  if (chatAnchorHeight) {
    // 刚往开头插了一批：内容在上面长高了多少，就把 scrollTop 往下推多少。不补的话
    // 视线会直接被甩到几十条之前，人根本认不出自己刚才在看哪儿。
    const grew = thread.scrollHeight - chatAnchorHeight
    chatAnchorHeight = 0
    if (grew > 0) thread.scrollTop += grew
  } else if (stick) thread.scrollTop = thread.scrollHeight
  paintChatChrome(folded)
}

/** 抬头的在线灯、输入区的提示和中止按钮——都不重绘整页，就地改。 */
function paintChatChrome(folded) {
  const busy = Boolean(folded.status)
  const live = document.getElementById('chat-live')
  if (live) {
    const ready = state.desktopRuntime && state.desktopRuntime.status === 'ready'
    live.setAttribute('data-live', busy ? 'busy' : ready ? '1' : '0')
    live.lastElementChild.textContent = busy ? t('正在处理') : ready ? t('在线') : t('离线')
  }
  const meta = document.getElementById('chat-meta')
  if (meta) meta.textContent = chatMetaText(folded)
  const tip = document.getElementById('chat-tip')
  if (tip) tip.textContent = busy ? t('正在思考…（可以继续输入来打断）') : t('Enter 发送，Shift + Enter 换行')
  const send = document.getElementById('chat-send')
  if (send && send.getAttribute('data-state') !== (busy ? 'stop' : 'send')) {
    // 停止态改成 type=button 并挂上 chat-abort：留着 submit 的话，点它会走发送。
    // 回车不受影响——那条路径仍是提交表单，也就是「边跑边补一句」，本来就该照发。
    send.setAttribute('data-state', busy ? 'stop' : 'send')
    send.type = busy ? 'button' : 'submit'
    send.innerHTML = busy ? ICON_STOP : ICON_SEND
    const label = busy ? t('停止') : t('发送')
    send.setAttribute('aria-label', label)
    send.title = label
    if (busy) send.setAttribute('data-act', 'chat-abort')
    else send.removeAttribute('data-act')
  }
  // 名单上的时间/摘要/转圈由 paintRoster 管——它认每个 Bot 自己那条流，
  // 不再只看当前这一条。
  paintRoster()
  const jump = document.getElementById('chat-jump')
  const thread = document.getElementById('chat-thread')
  if (jump && thread) jump.hidden = nearBottom(thread)
  paintChatCtx()
}

function chatMetaText(folded) {
  const blocks = (folded && folded.blocks) || []
  const account = (state.me && state.me.account) || {}
  const who = account.name || account.email || ''
  const first = blocks.find((b) => b.time)
  const parts = []
  if (who) parts.push(t('发起人') + ' ' + who)
  parts.push(blocks.length + ' ' + t('条消息'))
  if (first) parts.push(t('开始于') + ' ' + chatDayLabel(first.time) + ' ' + chatClock(first.time))
  return parts.join(' · ')
}

/* ── 上下文占了多少 ────────────────────────────────────────────────────
   长会话唯一真正会撞上的墙是上下文窗口，而撞上之前界面上一点征兆都没有：答着答着
   开始忘事，谁也不知道为什么。所以把「用了多少 / 一共多少」摆在输入框底下那一行，
   点开再看它被什么占着。

   **数字全部来自事件流，一个都不是界面编的**：总量是 `assistant/message.usage`，
   模型自己回报的；窗口大小和分段来自 `request/header`，bot 在拼提示词时量的
   （只有那儿拿得到完整的工具 schema，见 session/types.ts 上的注释）。老会话的
   日志里没有后两样——那就只报总量，不摆一个看起来很精确的假分段。 */

/** 分段的颜色。表在这里，渲染处直接内联——不是用户输入，不用转义。 */
const CTX_COLORS = {
  msg: 'var(--color-accent-500)',
  sys: 'var(--color-accent-2-400)',
  skill: 'var(--color-ok-500)',
  tool: 'var(--color-warn-500)',
  mcp: 'var(--color-accent-2-600)',
  free: 'var(--color-neutral-300)',
}

/**
 * 紧凑的 token 数：98.8k、1M。
 *
 * 不用上面那个 tokens()——它是给模型目录用的，会把 98,800 写成 99K。这一行要让人看出
 * 「还剩多少」，那一档精度正好是有用的那一档。
 */
function ctxNum(n) {
  const v = Math.max(0, Math.round(Number(n) || 0))
  if (v >= 1000000) return (v / 1000000).toFixed(v % 1000000 ? 1 : 0).replace(/\.0$/, '') + 'M'
  if (v >= 1000) return (v / 1000).toFixed(v >= 100000 ? 0 : 1).replace(/\.0$/, '') + 'k'
  return String(v)
}

function ctxWindowOf(provider, model) {
  const p = (state.catalog || []).find((x) => x.provider === provider)
  const m = p && (p.models || []).find((x) => x.id === model)
  return Number(m && m.contextWindow) || 0
}

/**
 * 从事件流里算出当前的上下文占用。没有真实用量就返回 null——一条写着「—」的提示
 * 比没有这条提示更让人分心。
 */
function chatContextStat(events) {
  const list = events || []
  let header = null
  let usage = null
  // 从后往前找，找齐两样就停：这两条在长会话里都在末尾附近，没必要从头扫一遍。
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = list[i] || {}
    const data = ev.data || {}
    if (!usage && ev.type === 'assistant/message') {
      const u = data.usage
      // 出错时补的那几条助手消息带的是全零 usage，跳过——认了它，占比会在一次
      // 模型调用失败之后归零，看着像上下文被清空了。
      if (u && (u.inputTokens || u.cacheReadTokens || u.outputTokens)) usage = u
    }
    if (!header && ev.type === 'request/header') header = data
    if (usage && header) break
  }
  if (!usage) return null
  const bot = chatBotOf()
  const provider = (header && header.provider) || (bot && bot.provider) || ''
  const model = (header && header.model) || (bot && bot.model) || ''
  const window = Number(header && header.contextWindow) || ctxWindowOf(provider, model)
  if (!window) return null

  const prompt = (usage.inputTokens || 0) + (usage.cacheReadTokens || 0)
  const used = prompt + (usage.outputTokens || 0)
  const sec = header && header.sections
  const parts = []
  if (sec) {
    const fixed = (sec.system || 0) + (sec.skills || 0) + (sec.builtinTools || 0) + (sec.mcpTools || 0)
    // 分段是估的，总量是真的。估出来比模型报的提示词还多时，按比例压回去——
    // 直接相减的话「对话消息」会变成负数，那一格在条上就消失了。
    const k = fixed > prompt && fixed > 0 ? prompt / fixed : 1
    const sys = Math.round((sec.system || 0) * k)
    const skills = Math.round((sec.skills || 0) * k)
    const builtin = Math.round((sec.builtinTools || 0) * k)
    const mcp = Math.round((sec.mcpTools || 0) * k)
    parts.push({ key: 'msg', label: '对话消息', tokens: Math.max(0, used - sys - skills - builtin - mcp) })
    parts.push({ key: 'sys', label: '系统提示词', tokens: sys })
    parts.push({ key: 'skill', label: 'Skill', tokens: skills })
    parts.push({ key: 'tool', label: '内置工具', tokens: builtin })
    parts.push({ key: 'mcp', label: 'MCP 工具', tokens: mcp })
  } else {
    parts.push({ key: 'msg', label: '已用', tokens: used })
  }
  return {
    used,
    window,
    prompt,
    cached: usage.cacheReadTokens || 0,
    model: provider && model ? provider + ' / ' + model : '',
    split: Boolean(sec),
    ratio: Math.min(1, used / window),
    parts: parts.filter((p) => p.tokens > 0),
  }
}

/** 浮层正文。条 + 明细 + 一行脚注，脚注写清楚哪些数是估的。 */
function chatCtxPop(stat) {
  const pct = (n) => ((n / stat.window) * 100).toFixed(1) + '%'
  const rows = [...stat.parts, { key: 'free', label: '剩余空间', tokens: Math.max(0, stat.window - stat.used) }]
  const bar = stat.parts
    .map((p) => `<i style="width: ${((p.tokens / stat.window) * 100).toFixed(2)}%; background: ${CTX_COLORS[p.key]};"></i>`)
    .join('')
  const list = rows
    .map(
      (p) => `<div class="sw-ctxrow">
        <span class="sw-ctxdot" style="background: ${CTX_COLORS[p.key]};"></span>
        <span class="sw-ctxname">${esc(t(p.label))}</span>
        <span class="sw-ctxnum">${esc(exactTokens(p.tokens))}</span>
        <span class="sw-ctxpct">${pct(p.tokens)}</span>
      </div>`,
    )
    .join('')
  const notes = []
  if (stat.model) notes.push(esc(stat.model))
  if (stat.prompt > 0 && stat.cached > 0) {
    notes.push(t('缓存命中') + ' ' + Math.round((stat.cached / stat.prompt) * 100) + '%')
  }
  if (stat.split) notes.push(t('分段为估算，总量来自模型回报'))
  return `<div class="sw-ctxhead">
      <span>${t('上下文窗口')}</span>
      <b>${esc(ctxNum(stat.used))} / ${esc(ctxNum(stat.window))}</b>
    </div>
    <div class="sw-ctxbar">${bar}</div>
    <div class="sw-ctxlist">${list}</div>
    <p class="sw-ctxnote">${notes.join(' · ')}</p>`
}

/**
 * 就地更新那颗药丸和它的浮层。
 *
 * 不走 render()：整页重绘会把输入框换掉，正打着字的人会丢焦点和光标位置——为了右下角
 * 一行灰字付这个代价说不过去。
 */
function paintChatCtx() {
  const box = document.getElementById('chat-ctx')
  if (!box) return
  const stat = chatContextStat(state.chatEvents)
  if (!stat) {
    box.hidden = true
    state.chatCtxOpen = false
    return
  }
  box.hidden = false
  const pct = Math.round(stat.ratio * 100)
  const chip = document.getElementById('chat-ctx-chip')
  const pop = document.getElementById('chat-ctx-pop')
  if (!chip || !pop) return
  chip.textContent = `${ctxNum(stat.used)} / ${ctxNum(stat.window)} (${pct}%)`
  // 七成开始变色、九成变警告色：撞墙之前得有征兆，而不是满了才知道。
  chip.setAttribute('data-level', pct >= 90 ? 'high' : pct >= 70 ? 'mid' : 'low')
  chip.setAttribute('aria-expanded', String(state.chatCtxOpen))
  chip.title = t('上下文用量')
  pop.hidden = !state.chatCtxOpen
  if (state.chatCtxOpen) pop.innerHTML = chatCtxPop(stat)
}

/** 导出成 Markdown。工具痕迹一起带上——只留回答的话，出问题时对不上做过什么。 */
function chatExportText() {
  const folded = fold(state.chatEvents)
  const bot = chatBotOf()
  const account = (state.me && state.me.account) || {}
  const me = account.name || account.email || t('我')
  const title = (bot && bot.name) || t('对话')
  const out = ['# ' + title, '', '> ' + chatMetaText(folded), '']
  for (const b of folded.blocks || []) {
    out.push('## ' + (b.kind === 'user' ? me : title) + (b.time ? ' · ' + fmtTime(b.time) : ''), '')
    for (const x of b.tools || []) {
      out.push('- ' + t('工具') + ' `' + x.name + '` · ' + (x.result == null ? t('调用中') : x.failed ? t('失败') : t('完成')))
      for (const f of x.files || []) out.push('  - ' + t('产出') + ' `' + f.path + '`')
    }
    if ((b.tools || []).length) out.push('')
    out.push(String(b.text || '').trim(), '')
  }
  return out.join('\n')
}

function downloadFile(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type || 'text/plain;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function deployBotButton(botId, label) {
  if (!botId) return ''
  const cls = label ? 'btn' : 'btn btn-primary'
  return `<button type="button" class="${cls}" data-act="runtime-deploy" data-bot="${esc(botId)}" ${state.deploying ? 'disabled' : ''}>${state.deploying ? t('部署中…') : label || t('部署这个 Bot')}</button>`
}

/**
 * 对话页右侧的「这个 Bot 的机器」栏。
 *
 * 部署按钮和环境信息原来挤在左边名册的上方，两者都不好用。挪到右栏之后：名册只管
 * 选人，中间只管对话，机器的事集中在一处。
 *
 * **桌面地址做成按钮,不打印 URL。** 那条 URL 里带着一整段 JWT 票（五分钟有效），
 * 渲染成文本会占掉半屏，而且没人会去手抄它——它唯一的用法就是点开。
 */
function chatMachinePanel() {
  const selected = chatBotIdOf(state.path) || state.chatBotId
  if (!selected) return ''
  const mine = state.desktopRuntime
  const bound = !!(state.runtimeMachine && state.runtimeMachine.paired)
  const rows = []

  if (!bound) {
    rows.push(
      `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground); line-height: 1.6;">${t('公司的运行机器还没有配对机器管家，请系统管理员在公司详情里生成配对码。')}</p>`,
    )
  } else if (!mine || mine.status === 'none') {
    rows.push(`<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('实例还没上线')}</p>`)
    rows.push(deployBotButton(selected))
    if (state.deployHint) {
      rows.push(`<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${esc(state.deployHint)}</p>`)
    }
  } else if (mine.status === 'error') {
    rows.push(`<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(mine.lastError || t('部署失败'))}</div>`)
    rows.push(deployBotButton(selected))
  } else if (mine.status === 'deploying') {
    rows.push(`<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('部署中…')}</p>`)
  }

  if (mine && mine.status === 'ready') {
    if (mine.novncUrl && deskEmbeddable(mine.novncUrl)) {
      // 只放一个空槽。真正的 iframe 挂在 #app 外面的常驻层里（见 syncDesktop），
      // 整页重绘换不掉它——换掉一次就是断一次 VNC。
      rows.push(
        `<div class="sw-desk">
          <div class="sw-desk-slot" id="sw-desk-slot"><span>${t('正在连桌面…')}</span></div>
          <p class="sw-desk-cap">${esc(deskCaption())}</p>
        </div>`,
      )
    } else if (mine.novncUrl) {
      // 页面是 https、管家是 http：iframe 会被浏览器按混合内容拦掉，且拦得没有声音。
      // 这种情况下退回原来那颗按钮——新标签页没有这条限制。
      rows.push(
        `<a class="btn btn-primary" href="${esc(mine.novncUrl)}" target="_blank" rel="noopener noreferrer" style="text-align: center;">${t('打开桌面')}</a>`,
      )
    }
    /**
     * 席位的家底收进一个默认收起的折叠面板。
     *
     * **VNC 口令不再露面。** 桌面就嵌在上面那块屏里，票里已经带着口令自动填进
     * noVNC——留着那一行的唯一效果，是把一条随时能看的凭据摆在每个人的屏幕上。
     * 要看它的人（管理员排查）在公司详情的席位卡里仍然看得到。
     *
     * 剩下的路径、linuxUser、版本号，还有日志与重铺这两个入口，都是「出事那天」
     * 才用一次的东西。天天挂在右栏里，只会把真正每天要看的那块屏往下挤。
     */
    const open = !!state.seatInfoOpen
    const detail = [
      `<div class="satu-kv"><span>${t('共享目录')}</span><span>${esc(mine.sharedDir || '—')}</span></div>`,
      `<div class="satu-kv"><span>linuxUser</span><span>${esc(mine.linuxUser || '—')}</span></div>`,
      mine.botVersion ? `<div class="satu-kv"><span>${t('Bot 版本')}</span><span>${esc(mine.botVersion)}</span></div>` : '',
      // 重新部署留在这儿：换了 Bot 版本、或者席位坏了，这是唯一的自助入口。
      // **要确认**：它会重启席位，正在跑的对话和开着的桌面会断。
      // 运行日志。和「重新部署」放在一起，因为它俩是同一件事的两头：出问题时先看日志，
      // 看不出来再重铺。**别放到 Bot 配置页**——那页是人设和能力，跟这台机器无关。
      `<div style="display: flex; gap: var(--space-2);"><button type="button" class="btn btn-secondary" data-act="logs-open" data-bot="${esc(selected)}">${t('运行日志')}</button><button type="button" class="btn btn-secondary" data-act="runtime-redeploy" data-bot="${esc(selected)}" ${state.deploying ? 'disabled' : ''}>${state.deploying ? t('部署中…') : t('重新部署')}</button></div>`,
    ].join('')
    rows.push(
      `<div class="sw-seatinfo">
        <button type="button" class="sw-seatinfo-head" data-act="seat-info" aria-expanded="${open}">
          <span class="sw-seatinfo-arrow" data-open="${open}">${svg(CHEVRON_RIGHT, 13)}</span>${t('席位详情')}
        </button>
        ${open ? `<div class="sw-seatinfo-body">${detail}</div>` : ''}
      </div>`,
    )
  }

  return rows.join('')
}

/* ── 内嵌桌面 ─────────────────────────────────────────────────────────────
 *
 * 右栏里那块屏是**真的桌面**，不是截图：一个连着席位 noVNC 的 iframe。鼠标移上去
 * 出「打开」，点一下撑成全屏遮罩，键鼠这时才交给它。
 *
 * **iframe 不能画在 #app 里面。** render() 是整页 innerHTML 换掉的，画在里面等于
 * 每重绘一次就重连一次 VNC——发条消息、切个状态，桌面就黑一下。所以它挂在 body 上
 * 的一个常驻层里，位置每次跟着右栏那个空槽（#sw-desk-slot）算出来。全屏也是同一个
 * 层改几何，不重新挂——不然「点开」这个动作本身就会把连接掐断再连一次。
 *
 * 预览态不做 view_only：那是 URL 参数，换它要重载页面。改成在上面盖一层挡片，
 * 点击进不去，键盘也拿不到焦点，代价只有一个 div。
 */

/** 票只有五分钟。挂之前超过这个岁数就先换一张，不然 iframe 一开就是 401。 */
const DESK_TICKET_FRESH_MS = 180_000
/** 当前挂着的是哪个席位、用的哪个地址。**地址变了也要重挂**——见 syncDesktop。 */
let deskMounted = null
let deskMounting = false
let deskSlotSeen = null
let deskObserver = null
let deskPlacePending = false
/** 页面被切到后台的时刻。回来得太晚就重挂，因为票早过期了，noVNC 自己连不回来。 */
let deskHiddenAt = 0

function deskCaption() {
  const name = (chatBotOf() || {}).name || t('这个 Bot')
  return localeMode === 'en' ? `${name}'s screen` : `${name} 的桌面`
}

/**
 * 这个地址能不能内嵌。
 *
 * 页面是 https、管家是 http 的时候，iframe 会被浏览器按混合内容拦掉，而且拦得**没有
 * 声音**——什么都不显示，控制台以外看不出所以然。这种情况下不如不嵌，退回按钮。
 */
function deskEmbeddable(url) {
  if (!url) return false
  return !(location.protocol === 'https:' && /^http:/i.test(url))
}

/** 内嵌用的地址：按预览尺寸缩放，别把桌面裁成左上角一小块。 */
function deskUrl() {
  const rt = state.desktopRuntime
  if (!rt || rt.status !== 'ready' || !rt.novncUrl || !deskEmbeddable(rt.novncUrl)) return ''
  return rt.novncUrl + (rt.novncUrl.includes('?') ? '&' : '?') + 'resize=scale&reconnect=1&bell=false'
}

const DESK_EXPAND = ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7']
const DESK_SHRINK = ['M9 3v6H3', 'M15 21v-6h6', 'M3 9l7-7', 'M21 15l-7 7']

function deskLayer() {
  return document.getElementById('sw-deskl')
}

function unmountDesktop() {
  const layer = deskLayer()
  if (layer) layer.remove()
  const back = document.getElementById('sw-deskb')
  if (back) back.remove()
  if (deskObserver) {
    deskObserver.disconnect()
    deskObserver = null
  }
  deskSlotSeen = null
  deskMounted = null
  state.deskFull = false
}

function mountDesktop(url, seatId) {
  // 换一块屏不等于收起这块屏：重连时人可能正开着全屏，unmountDesktop 会把它清掉。
  const wasFull = state.deskFull
  unmountDesktop()
  const back = document.createElement('div')
  back.id = 'sw-deskb'
  back.className = 'sw-deskb'
  back.addEventListener('click', () => setDeskFull(false))
  const layer = document.createElement('div')
  layer.id = 'sw-deskl'
  layer.className = 'sw-deskl'
  /**
   * `sandbox` 不能省。框进来的是席位自己供的页面，没有沙箱它就能 `top.location = …`
   * 把整个 Gateway 界面换掉——原来那颗「打开桌面」是新标签页加 `rel=noopener`，没这
   * 条路；一内嵌就有了。
   *
   * `allow-same-origin` 必须留着：路径限定的那张 cookie 靠它才发得出去，去掉就是
   * 一页 401。它不会让沙箱失效——能自己摘掉沙箱的只有和父页同源的框，而这一个是
   * 跨源的。`allow-forms` 是留给「票里没带口令」时那个登录框的。
   */
  layer.innerHTML = `
    <iframe class="sw-deskl-frame" title="${esc(t('桌面'))}" tabindex="-1"
      sandbox="allow-scripts allow-same-origin allow-forms" allow="clipboard-read; clipboard-write"></iframe>
    <button type="button" class="sw-deskl-shield" data-desk="open">
      <span class="sw-deskl-open">${svg(DESK_EXPAND, 15)}${esc(t('打开'))}</span>
    </button>
    <div class="sw-deskl-bar">
      <span class="sw-deskl-title"></span>
      <span class="sw-deskl-acts">
        <button type="button" class="sw-deskl-btn" data-desk="reload">${esc(t('重连'))}</button>
        <button type="button" class="btn btn-ghost btn-icon sw-deskl-close" data-desk="close"
          aria-label="${esc(t('收起桌面'))}" title="${esc(t('收起桌面'))}">${svg(DESK_SHRINK, 16)}</button>
      </span>
    </div>`
  layer.addEventListener('click', (e) => {
    const hit = e.target instanceof Element ? e.target.closest('[data-desk]') : null
    if (!hit) return
    const act = hit.getAttribute('data-desk')
    if (act === 'reload') void remountDesktop(true)
    else setDeskFull(act === 'open')
  })
  document.body.appendChild(back)
  document.body.appendChild(layer)
  // src 最后给：DOM 先进树，iframe 才只加载一次。
  layer.querySelector('.sw-deskl-frame').src = url
  deskMounted = { seat: seatId, url }
  state.deskFull = wasFull
}

/** 预览 ⇄ 全屏。几何变化加一段过渡，拖右栏宽度时不加——那是每帧都在动的。 */
function setDeskFull(on) {
  const layer = deskLayer()
  if (!layer || state.deskFull === on) return
  state.deskFull = on
  layer.style.transition = 'top .22s ease, left .22s ease, width .22s ease, height .22s ease, border-radius .22s ease'
  clearTimeout(setDeskFull.timer)
  setDeskFull.timer = setTimeout(() => {
    layer.style.transition = ''
  }, 260)
  syncDesktop()
  if (on) {
    const frame = layer.querySelector('.sw-deskl-frame')
    // 焦点交给 iframe，键盘才进得去桌面。noVNC 会自己抓键盘。
    if (frame) setTimeout(() => frame.focus(), 240)
  }
}

/**
 * 把常驻层对齐到右栏那个空槽上，顺带管挂载与卸载。render() 之后、以及右栏尺寸或
 * 滚动变化时都要调一次。
 */
function syncDesktop() {
  const slot = document.getElementById('sw-desk-slot')
  const url = deskUrl()
  const seatId = (state.desktopRuntime && state.desktopRuntime.seatId) || ''
  if (!slot || !url) {
    if (deskMounted) unmountDesktop()
    return
  }
  // **地址也要比，不只是席位。** 重新部署之后席位 id 一个字都没变，变的是票；只比
  // 席位的话，那张新票永远用不上，屏上留着的是重装前那条已经死掉的连接。
  if (!deskMounted || deskMounted.seat !== seatId || deskMounted.url !== url) {
    void remountDesktop()
    return
  }
  if (slot !== deskSlotSeen) {
    // 整页重绘换了个新的槽元素：观察器要跟着换过去。
    deskSlotSeen = slot
    if (deskObserver) deskObserver.disconnect()
    if (typeof ResizeObserver === 'function') {
      deskObserver = new ResizeObserver(() => placeSoon())
      deskObserver.observe(slot)
    }
  }
  placeDesktop()
}

/**
 * 票过期了就先换一张再挂。
 *
 * 五分钟的票换成的是 path 限定 cookie，连上之后 WebSocket 一直活着；但 iframe
 * **重新加载**的那一刻要拿票换 cookie，票馊了就是一页 401。
 *
 * `force` 是「重连」那颗按钮走的路：不管票看着新不新都换一张。掉过一次线之后
 * noVNC 自己重连不回来——它手里那张 cookie 里的票早过期了，升级请求一律 401——
 * 所以人得有一个确定能把它救回来的动作。
 */
async function remountDesktop(force = false) {
  if (deskMounting) return
  deskMounting = true
  try {
    const want = chatBotIdNow()
    if (force || Date.now() - (state.desktopRuntimeAt || 0) > DESK_TICKET_FRESH_MS) {
      await loadDesktopRuntime(want)
      // 等票的这段时间里人切了 Bot：这一轮作废，新的那个 Bot 自己会触发一次。
      if (chatBotIdNow() !== want) return
    }
    const url = deskUrl()
    const slot = document.getElementById('sw-desk-slot')
    if (!url || !slot) {
      unmountDesktop()
      return
    }
    mountDesktop(url, (state.desktopRuntime && state.desktopRuntime.seatId) || '')
    deskSlotSeen = null
  } finally {
    deskMounting = false
  }
  syncDesktop()
}

function placeDesktop() {
  const layer = deskLayer()
  const back = document.getElementById('sw-deskb')
  if (!layer) return
  layer.classList.toggle('is-full', !!state.deskFull)
  if (back) back.classList.toggle('is-on', !!state.deskFull)
  const title = layer.querySelector('.sw-deskl-title')
  if (title) title.textContent = deskCaption()
  // 挡片只挡得住鼠标。iframe 本身还在 Tab 序里，键盘一路 Tab 过去就进了那块两百
  // 像素宽的预览，之后敲的每个字都送进了真桌面。预览态直接把它从 Tab 序里摘掉。
  const frame = layer.querySelector('.sw-deskl-frame')
  if (frame) {
    if (state.deskFull) frame.removeAttribute('tabindex')
    else frame.setAttribute('tabindex', '-1')
  }
  if (state.deskFull) {
    const vw = window.innerWidth || 0
    const vh = window.innerHeight || 0
    const pad = Math.round(Math.min(vw, vh) * 0.035)
    layer.style.top = pad + 'px'
    layer.style.left = pad + 'px'
    layer.style.width = vw - pad * 2 + 'px'
    layer.style.height = vh - pad * 2 + 'px'
    layer.style.clipPath = ''
    layer.style.visibility = ''
    return
  }
  const slot = document.getElementById('sw-desk-slot')
  if (!slot) {
    unmountDesktop()
    return
  }
  const r = slot.getBoundingClientRect()
  layer.style.top = r.top + 'px'
  layer.style.left = r.left + 'px'
  layer.style.width = r.width + 'px'
  layer.style.height = r.height + 'px'
  // 层是 fixed 的，不受右栏的 overflow 裁剪——右栏一滚，它会浮到别的东西上面去。
  // 自己按右栏可视区裁一刀。
  const body = slot.closest('.gw-aside-body')
  if (!body || !r.height) {
    layer.style.clipPath = ''
    layer.style.visibility = r.height ? '' : 'hidden'
    return
  }
  const b = body.getBoundingClientRect()
  const top = Math.max(0, b.top - r.top)
  const bottom = Math.max(0, r.bottom - b.bottom)
  layer.style.visibility = top + bottom >= r.height ? 'hidden' : ''
  layer.style.clipPath = `inset(${top}px 0px ${bottom}px 0px round 10px)`
}

/**
 * 一帧最多重排一次。
 *
 * 下面那个 scroll 是捕获阶段挂在 window 上的——消息流每吐一段就自动跟随一次，那些
 * 滚动全从这儿过。直接调 placeDesktop 的话，每一次都要量两个 getBoundingClientRect
 * 再写六条内联样式，等于在流式输出最吃帧的时候反复强制同步布局。
 */
function placeSoon() {
  if (deskPlacePending) return
  if (typeof requestAnimationFrame !== 'function') {
    placeDesktop()
    return
  }
  deskPlacePending = true
  requestAnimationFrame(() => {
    deskPlacePending = false
    placeDesktop()
  })
}

// 窗口尺寸、右栏滚动都会挪动那个槽。滚动用捕获，因为滚的是右栏自己而不是 window。
window.addEventListener('resize', placeSoon)
window.addEventListener('scroll', placeSoon, true)
/**
 * 回到前台时，离开得够久就重挂。
 *
 * 合盖、切标签页几十分钟回来，那条 WebSocket 基本已经断了，而 noVNC 的自动重连注定
 * 失败——cookie 里那张票只活五分钟。这时候重挂的代价是一秒钟的黑屏，不重挂的代价是
 * 一块永远回不来的死屏。
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    deskHiddenAt = Date.now()
    return
  }
  const away = deskHiddenAt ? Date.now() - deskHiddenAt : 0
  deskHiddenAt = 0
  if (deskMounted && away > DESK_TICKET_FRESH_MS) void remountDesktop(true)
})
window.addEventListener('keydown', (e) => {
  // 焦点在 iframe 里时这一条收不到（noVNC 把键盘抓走了），所以标题栏那颗收起按钮
  // 必须一直看得见——Esc 只是顺手。
  if (e.key === 'Escape' && state.deskFull) setDeskFull(false)
})

/**
 * 运行日志。
 *
 * 没有 SSH 的时候，「bot 到底卡在哪一步」谁也看不见——诊断快照能说「它活着」，
 * 说不了「它在干什么」。而这一层最贵的故障恰恰都不报错：单元 active、端口有人听，
 * 只是那一轮永远不结束。
 *
 * 走 SSE，和聊天一条路子。机器票留在 Gateway，浏览器只带自己的席位票；日志在管家
 * 那侧就过了脱敏（席位票、API key、VNC 口令一律盖掉）。
 */
const LOG_MAX = 2000
let logAbort = null

function stopLogStream() {
  if (logAbort) {
    try {
      logAbort.abort()
    } catch {}
  }
  logAbort = null
}

async function startLogStream(url) {
  stopLogStream()
  const ac = new AbortController()
  logAbort = ac
  state.logLines = []
  state.logError = ''
  paintLogs()
  let res
  try {
    res = await fetch(url, {
      headers: { accept: 'text/event-stream', ...(token() ? { authorization: 'Bearer ' + token() } : {}) },
      signal: ac.signal,
    })
  } catch {
    if (!ac.signal.aborted) {
      state.logError = t('连不上机器管家')
      paintLogs()
    }
    return
  }
  if (!res.ok || !res.body) {
    state.logError = (await res.text().catch(() => '')) || t('拿不到日志')
    paintLogs()
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (ac.signal.aborted) break
      buf += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      let idx
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx)
        buf = buf.slice(idx + 2)
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data: ')) continue
          try {
            const ev = JSON.parse(line.slice(6))
            if (ev.error) state.logError = String(ev.error)
            else if (typeof ev.line === 'string') state.logLines.push(ev.line)
          } catch {}
        }
        // 不封顶的话，一个话多的 bot 能把标签页吃垮。
        if (state.logLines.length > LOG_MAX) state.logLines.splice(0, state.logLines.length - LOG_MAX)
        scheduleLogPaint()
      }
    }
  } catch {
    /* 关面板 / 断线 */
  }
  if (logAbort === ac) logAbort = null
}

let logPaintQueued = false

/** 和正文一样合并到一帧：日志可以刷得很快，一行一次重绘顶不住。 */
function scheduleLogPaint() {
  if (logPaintQueued) return
  logPaintQueued = true
  const run = () => {
    logPaintQueued = false
    paintLogs()
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
  else setTimeout(run, 16)
}

function paintLogs() {
  const box = document.getElementById('log-body')
  if (!box) return
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight <= 60
  box.textContent = state.logError
    ? state.logError
    : state.logLines.length
      ? state.logLines.join('\n')
      : t('还没有日志')
  if (stick) box.scrollTop = box.scrollHeight
}

/**
 * 日志面板。一个面板管两处：
 *   · 员工侧的运行环境——只有自己这个 Bot 一个来源；
 *   · 平台侧公司详情的运行机器——管家自己，加上这台机器上的每个席位。
 *
 * state.logsOpen = { title, active, sources: [{ key, label, url }] }
 */
/** 开面板并接上第一个来源。两处入口都走它，别各写一份。 */
function openLogs(title, sources) {
  state.logsOpen = { title, sources, active: sources[0] && sources[0].key }
  state.logLines = []
  state.logError = ''
  render()
  // 先 render 再开流：paintLogs 往 #log-body 里填，那个节点得先存在。
  if (sources[0]) void startLogStream(sources[0].url)
}

function switchLogSource(key) {
  const box = state.logsOpen
  if (!box) return
  const hit = (box.sources || []).find((x) => x.key === key)
  if (!hit || key === box.active) return
  stopLogStream()
  box.active = key
  state.logLines = []
  state.logError = ''
  render()
  void startLogStream(hit.url)
}

/**
 * 打开一个工作区文件的预览。
 *
 * **先取成 blob 再显示**，而不是把 URL 直接给 <img src>：Gateway 认 Authorization 头，
 * 而 src= 发出去的请求带不了头。顺带还有个好处——blob: 是 opaque origin，即使哪天
 * 白名单放进了带脚本的类型，它也够不着 Gateway 这一侧的登录态。
 *
 * 大文件不预览：整个读进内存只为看一眼不值当，给下载就行。判断用响应头里的
 * content-length，在读 body **之前**——否则「太大所以不看」的代价是先下完它。
 */
async function openPreview(path, name) {
  if (!state.chatSessionId) return
  revokePreview()
  state.preview = { path, name, loading: true, url: '', type: '', size: 0, error: '' }
  render()
  const url = '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/files?path=' + encodeURIComponent(path)
  const ac = new AbortController()
  state.preview.abort = ac
  try {
    const res = await fetch(url, { headers: authHeaders(), signal: ac.signal })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let json = null
      try {
        json = text ? JSON.parse(text) : null
      } catch {}
      throw new Error(errText((json && json.error) || 'HTTP ' + res.status))
    }
    const type = (res.headers.get('content-type') || '').split(';')[0].trim()
    const size = Number(res.headers.get('content-length') || 0)
    // 席位那边判成不能内联的（SVG、HTML、未知格式）会带 attachment 回来。照办，
    // 不去覆盖它——那张白名单就是干这个的。
    const attachment = (res.headers.get('content-disposition') || '').includes('attachment')
    if (attachment || (size && size > CHAT_PREVIEW_MAX)) {
      ac.abort()
      if (!state.preview || state.preview.path !== path) return
      state.preview = { path, name, loading: false, url: '', type, size, error: '', tooBig: true }
      render()
      return
    }
    const blob = await res.blob()
    if (!state.preview || state.preview.path !== path) return
    state.preview = { path, name, loading: false, url: URL.createObjectURL(blob), type, size: blob.size, error: '' }
  } catch (err) {
    if (ac.signal.aborted) return
    if (!state.preview || state.preview.path !== path) return
    state.preview = { path, name, loading: false, url: '', type: '', size: 0, error: err.message }
  }
  render()
}

/** blob: 的生命周期得自己管——不撤销，这一份就在内存里待到刷新页面为止。 */
function revokePreview() {
  const p = state.preview
  if (!p) return
  if (p.abort) try { p.abort.abort() } catch {}
  if (p.url) setTimeout(() => URL.revokeObjectURL(p.url), 0)
}

function closePreview() {
  revokePreview()
  state.preview = null
  render()
}

/** 直接把工作区里的文件存下来。走 fetch 而不是 <a href>，同样是为了带上票。 */
async function downloadWorkspaceFile(path, name) {
  if (!state.chatSessionId) return
  const url =
    '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/files?path=' + encodeURIComponent(path) + '&download=1'
  try {
    const res = await fetch(url, { headers: authHeaders() })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const blob = await res.blob()
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = name || path.split('/').pop() || 'file'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(href), 1000)
  } catch (err) {
    flash('err', t('下载失败：') + err.message)
  }
}

function previewModal() {
  const p = state.preview
  if (!p) return ''
  let body
  if (p.loading) {
    body = `<p class="sw-preview-note">${t('正在取文件…')}</p>`
  } else if (p.error) {
    body = `<p class="sw-preview-note sw-preview-err">${esc(p.error)}</p>`
  } else if (p.tooBig) {
    body = `<p class="sw-preview-note">${t('这个文件不适合在浏览器里打开（太大，或者是不能安全内联的格式）。下载下来看吧。')}</p>`
  } else if (p.type.startsWith('image/')) {
    body = `<img class="sw-preview-img" src="${esc(p.url)}" alt="${esc(p.name)}">`
  } else {
    /**
     * PDF 与纯文本走 iframe。`sandbox` 不带任何 allow-*：脚本、表单、同源全关。
     * blob: 本来就是 opaque origin，这条是叠在上面的第二道——两道都便宜。
     */
    body = `<iframe class="sw-preview-frame" src="${esc(p.url)}" sandbox title="${esc(p.name)}"></iframe>`
  }
  const meta = p.size ? fileSize(p.size) : ''
  return `<div class="gw-modal-backdrop" data-act="preview-close">
    <div class="gw-modal sw-preview" data-stop>
      <div class="sw-preview-head">
        <div style="min-width: 0;">
          <h2>${esc(p.name)}</h2>
          <p><code>${esc(p.path)}</code>${meta ? ' · ' + esc(meta) : ''}</p>
        </div>
        <div class="sw-preview-acts">
          <button type="button" class="btn" data-act="preview-download" data-path="${esc(p.path)}" data-name="${esc(p.name)}">${t('下载')}</button>
          <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="preview-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
        </div>
      </div>
      <div class="sw-preview-body">${body}</div>
    </div>
  </div>`
}

function logsModal() {
  if (!state.logsOpen) return ''
  const { title, sources = [], active } = state.logsOpen
  const picker =
    sources.length > 1
      ? `<select class="input" data-act="logs-source" style="max-width: 260px;">${sources
          .map((x) => `<option value="${esc(x.key)}" ${x.key === active ? 'selected' : ''}>${esc(x.label)}</option>`)
          .join('')}</select>`
      : ''
  return `<div class="gw-modal-backdrop" data-act="logs-close">
    <div class="gw-modal" style="max-width: 900px;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div style="min-width: 0;">
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('运行日志')}</h2>
          <p style="margin: 0 0 var(--space-2); font-size: 13px; color: var(--muted-foreground);">${esc(title || '')}</p>
          ${picker}
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="logs-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <pre id="log-body" style="margin: var(--space-4) 0 0; max-height: 60vh; overflow: auto; font-size: 12px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; background: var(--muted); border-radius: var(--radius); padding: var(--space-3);"></pre>
      <p style="margin: var(--space-2) 0 0; font-size: 11.5px; color: var(--muted-foreground);">${t('凭据已在机器那侧盖掉。日志里会有对话正文和执行过的命令。')}</p>
    </div>
  </div>`
}

/** 非「未上线」的错误仍然贴在名册上方——那是整页级别的问题，不属于某一个 Bot。 */
function runtimeDownBanner() {
  const err = state.runtimeError
  if (!err || String(err).includes('实例还没上线')) return ''
  return `<div class="gw-flash gw-flash-err">${esc(err)}</div>`
}

/**
 * 会话身份行，**直接长在页面顶栏里**。
 *
 * 它原本是消息流上面单独一条 header，于是顶栏写着「对话」、下面一行写着这条对话是
 * 谁——两条横杠叠在一起，上面那条还是一句永远不变的废话。合成一条之后，顶栏在对话页
 * 上说的就是「你正在跟谁说话、它现在什么状态」，这才是这一页需要一直挂在眼前的东西。
 *
 * 返回的是 .gw-head 的内容片段（身份 + 操作），外壳和内边距由 .gw-head 给。
 */
function chatHeadInline() {
  const bot = chatBotOf()
  const name = (bot && bot.name) || t('未选择')
  const menu =
    state.menu === 'chat'
      ? `<div class="satu-menu" data-flip="${String(Boolean(state.menuFlip))}">
          <button type="button" class="satu-menuitem" data-act="chat-copy-all">${t('复制全文')}</button>
          <button type="button" class="satu-menuitem" data-act="chat-export">${t('导出 Markdown')}</button>
        </div>`
      : ''
  return `<div class="sw-convo-avatar" aria-hidden="true">${ICON_BOT}</div>
    <div class="sw-convo-id">
      <div class="sw-convo-title">
        <span class="sw-convo-name">${esc(name)}</span>
        <span class="sw-convo-live" id="chat-live" data-live="0"><i aria-hidden="true"></i><span>${t('离线')}</span></span>
      </div>
      <p class="sw-convo-meta" id="chat-meta"></p>
    </div>
    <div class="sw-convo-actions">
      <button type="button" class="btn btn-secondary" data-act="chat-export">${t('导出记录')}</button>
      <button type="button" class="btn btn-ghost btn-icon" data-menu-toggle data-act="chat-menu"
        aria-label="${esc(t('更多操作'))}">${svg(['M12 6h.01', 'M12 12h.01', 'M12 18h.01'], 16)}</button>
      ${menu}
    </div>`
}

function chatPage() {
  const bots = state.runtimeBots || []
  const selected = chatBotIdOf(state.path) || state.chatBotId
  const banner = runtimeDownBanner()
  if (!selected) {
    return `<div class="gw-chat"><section class="gw-chat-main">${banner}
      <div class="gw-chat-empty-main"><p>${bots.length ? t('从左边选一个 Bot 开始对话。') : t('还没有 Bot。公司后台配置并上线后会出现在这里。')}</p></div>
    </section></div>`
  }
  /* 正文一律留空：消息、在线灯、提示行全部由 paintChat 增量填。在这里先渲染一遍
     再让 paintChat 覆盖，等于每次换页把同一份内容画两遍，还会把已经渲染好的图冲掉。 */
  return `
    <div class="gw-chat">
      <section class="gw-chat-main">
        ${banner}
        <div class="sw-threadwrap">
          <div class="sw-thread" id="chat-thread"></div>
          <button type="button" class="sw-jump" id="chat-jump" data-act="chat-jump" hidden>${ICON_DOWN}${t('回到底部')}</button>
        </div>
        <div class="sw-composer">
          <form id="chat-form" class="sw-composer-box">
            <div class="sw-files" id="chat-files" hidden></div>
            <textarea id="chat-input" class="satu-prompt satu-grow" rows="1"
              placeholder="${esc(t('输入消息'))}">${esc(state.chatDraft || '')}</textarea>
            <div class="sw-composer-row">
              ${/* 席位的消息接口目前只收 text，没有二进制通道。所以附件走「随消息一起
                    贴成正文」这条路：选中的文本文件在发送时以围栏代码块拼进去，模型看到
                    的就是文件内容本身。二进制在选择那一刻当场挡掉并说明白，不做成一个
                    看起来能传、传完没反应的按钮。 */ ''}
              <button type="button" class="sw-iconbtn" data-act="chat-attach"
                aria-label="${esc(t('添加附件'))}" title="${esc(t('添加附件'))}">${ICON_CLIP}</button>
              <input type="file" id="chat-file" multiple hidden>
              <span class="sw-spacer"></span>
              ${/* 发送和停止是同一个按钮的两副面孔——它们指的是同一件事（这一轮对话的
                    开与关），而且永远只有一个有意义。摆两个按钮的话，其中一个总是灰的，
                    还得让人先分辨哪个能点。切换由 paintChatChrome 就地改，不重绘整页。 */ ''}
              <button type="submit" class="sw-send" id="chat-send" data-state="send"
                aria-label="${esc(t('发送'))}" title="${esc(t('发送'))}">${ICON_SEND}</button>
            </div>
          </form>
          <div class="sw-composer-tip">
            <span id="chat-tip"></span>
            <span class="sw-spacer"></span>
            ${/* 占比摆在这一行的最右边：它跟左边那句一样是「发之前顺带知道一下」的东西，
                  不值得单占一行，也不该跑到消息流里去抢正文的位置。内容由 paintChatCtx
                  就地填，没有真实用量时整块隐藏。 */ ''}
            <span class="sw-ctx" id="chat-ctx" hidden>
              <button type="button" class="sw-ctx-chip" id="chat-ctx-chip" data-act="chat-ctx"
                aria-expanded="false"></button>
              <div class="sw-ctxpop" id="chat-ctx-pop" hidden></div>
            </span>
          </div>
        </div>
      </section>
    </div>`
}

/**
 * 预览能在浏览器里直接打开的上限。
 *
 * 预览得把整个文件读成 blob 才能喂给 <img>/<iframe>——Gateway 认的是 Authorization
 * 头，而 src= 发出去的请求带不了头。所以这个数字是「愿意为看一眼吃多少内存」，
 * 超过就只给下载，不是不给看。
 *
 * 上传**没有**前端上限：文件是流着走的，不进模型上下文，把关的是席位那边的
 * SATUWORK_UPLOAD_MAX。
 */
const CHAT_PREVIEW_MAX = 25 * 1024 * 1024

function paintChatFiles() {
  const box = document.getElementById('chat-files')
  if (!box) return
  const files = state.chatFiles || []
  box.hidden = !files.length
  const busy = Boolean(state.chatUploading)
  box.innerHTML = files
    .map(
      (f, i) =>
        `<span class="sw-file">` +
        `<span>${esc(f.name)}</span><small>${esc(fileSize(f.size))}</small>` +
        // 传的时候不给「移除」：那一下删得掉列表项，删不掉已经在路上的请求。
        (busy
          ? ''
          : `<button type="button" class="sw-file-x" data-act="chat-file-drop" data-i="${i}" ` +
            `aria-label="${esc(t('移除'))} ${esc(f.name)}">${ICON_X}</button>`) +
        `</span>`,
    )
    .join('')
}

function fileSize(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}

/**
 * 记下选中的附件。**不读内容**——文件在发送时整个流给席位，落进工作区，Bot 用
 * read/bash 自己取。
 *
 * 以前这里要 file.text() 把正文贴进消息，于是 256 KB 就是天花板，PDF、Excel、图片
 * 一概传不了（贴成乱码对谁都没用）。现在传的是路径，格式和大小都不再是这一层的事。
 */
function takeChatFiles(input) {
  const picked = Array.from(input.files || [])
  input.value = ''
  if (!picked.length) return
  state.chatFiles = [...(state.chatFiles || []), ...picked.map((file) => ({ name: file.name, size: file.size, file }))]
  paintChatFiles()
}

/** 带登录票的请求头。预览和上传都不走 api()——它们收发的不是 JSON。 */
function authHeaders(extra) {
  const headers = { ...(extra || {}) }
  const tok = token()
  if (tok) headers.authorization = 'Bearer ' + tok
  return headers
}

/**
 * 把一个文件传进这条会话的工作区，返回 { path, name, size }。
 *
 * 文件名走 header：查询串会进访问日志，而文件名常常就是内容本身
 * （「二季度裁员名单.xlsx」）。header 只认 ASCII，所以先 encodeURIComponent，
 * 席位那边解回来。
 */
async function uploadChatFile(sessionId, file) {
  const res = await fetch('/runtime/sessions/' + encodeURIComponent(sessionId) + '/files', {
    method: 'POST',
    headers: authHeaders({
      accept: 'application/json',
      'content-type': 'application/octet-stream',
      'x-filename': encodeURIComponent(file.name),
    }),
    body: file,
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  if (!res.ok) throw new Error(errText((json && json.error) || 'HTTP ' + res.status))
  return json
}

/**
 * 附件在正文里的样子。
 *
 * 给的是**路径，不是内容**：文件已经躺在工作区里了，Bot 想读哪段读哪段，几百页的
 * PDF 也不会一次撑爆上下文。
 *
 * 排在正文前面——先给材料再给指令，模型读到「照这个文件改」时文件已经在眼前。
 */
function composeChatBody(files, text) {
  if (!files.length) return text
  const list = files.map((f) => '- `' + f.path + '`').join('\n')
  return t('我上传了文件，在工作区里：') + '\n' + list + (text ? '\n\n' + text : '')
}

/**
 * 模型真能看的图片格式。跟席位那边的白名单是同一张表（web/index.ts 的
 * MODEL_IMAGE_MIME）——这边先分好，能少一趟注定要被拒的往返。
 */
const MODEL_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/**
 * 传上去的东西里，哪些能直接给模型看。
 *
 * 图片走 `images`（到了模型那边是真正的视觉输入），其余的只在正文里留个路径——
 * 后者模型得自己去 read。两条路都要有：图片的路径也列进正文，因为模型可能想用
 * 工具再处理它，而 image 块里是没有路径的。
 */
function pickImages(files) {
  return files
    .map((f) => ({ path: f.path, mime: String(f.contentType || '').split(';')[0].trim() }))
    .filter((f) => f.path && MODEL_IMAGE.has(f.mime))
}

async function sendChat() {
  const text = (state.chatDraft || '').trim()
  const files = state.chatFiles || []
  const sessionId = state.chatSessionId
  if ((!text && !files.length) || !sessionId || state.chatUploading) return

  state.chatDraft = ''
  const input = document.getElementById('chat-input')
  if (input) {
    input.value = ''
    input.style.height = ''
  }

  // 附件先落地，再发消息。反过来的话，模型会先读到路径、文件还没到。
  let uploaded = []
  if (files.length) {
    state.chatUploading = true
    paintChatFiles()
    render()
    try {
      for (const f of files) uploaded.push(await uploadChatFile(sessionId, f.file))
    } catch (err) {
      // 传失败就把草稿和附件原样还回去，别让人重新选一遍文件。
      state.chatUploading = false
      state.chatDraft = text
      paintChatFiles()
      flash('err', t('附件没传上去：') + err.message)
      render()
      return
    }
    state.chatUploading = false
  }
  state.chatFiles = []
  paintChatFiles()

  const images = pickImages(uploaded)
  try {
    await api('POST', '/runtime/sessions/' + encodeURIComponent(sessionId) + '/messages', {
      text: composeChatBody(uploaded, text),
      ...(images.length ? { images } : {}),
    })
  } catch (err) {
    // 文件已经传上去了，退回来的只有草稿——附件不还，还了会传第二遍。
    state.chatDraft = text
    if (uploaded.length) flash('err', t('附件已经在工作区里了，但这条消息没发出去。'))
    if (String(err.message || '').includes('实例还没上线')) state.runtimeError = '实例还没上线'
    else if (!uploaded.length) flash('err', err.message)
    render()
  }
}

async function abortChat() {
  if (!state.chatSessionId) return
  try {
    await api('POST', '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/abort', {})
  } catch {}
}

async function updateOrgRuntime() {
  const org = state.org && state.org.id
  if (!org || state.updatingRuntime) return
  const version = state.latestRelease
  if (!version) {
    flash('err', '还没有发布 Bot 版本')
    render()
    return
  }
  state.updatingRuntime = true
  render()
  try {
    const data = await api('POST', `/platform/orgs/${encodeURIComponent(org)}/runtime/update`, { version })
    const results = Array.isArray(data.results) ? data.results : []
    const ok = results.filter((r) => r.status === 'ready' && !r.error).length
    const bad = results.filter((r) => r.error || r.status === 'error').length
    if (!results.length) flash('ok', t('没有需要更新的席位', 'No seats needed updating'))
    else flash(bad && !ok ? 'err' : 'ok', t(`更新 ${data.version}：成功 ${ok}，失败 ${bad}`, `Updated ${data.version}: ${ok} ok, ${bad} failed`))
    await loadCompanyDetail(org)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.updatingRuntime = false
    render()
  }
}

async function deployMyRuntime(botId, opts = {}) {
  const id = botId || chatBotIdOf(state.path) || state.chatBotId
  if (state.deploying || isOwner() || !id) return
  state.deploying = true
  state.deployHint = opts.update ? '正在重新部署…' : '正在部署…'
  render()
  try {
    // `update` 不能省：席位已经是 ready 且版本没变时，服务端会直接把现状还回来，
    // 什么都不做——那样「重新部署」这个按钮就成了摆设。
    // force：见 gateway/src/deploy.ts 里那道「已经 ready 就跳过」的门。不带它的话，
    // 「重新部署」在最需要它的时候（版本对、状态 ready、但机器上不对）什么都不会做。
    const body = { botId: id }
    if (opts.update) body.update = true
    if (opts.force) body.force = true
    await api('POST', '/runtime/deploy', body)
    const startAt = Date.now()
    while (Date.now() - startAt < 15000) {
      try {
        const rt = await api('GET', '/runtime/desktop?botId=' + encodeURIComponent(id))
        state.desktopRuntime = rt
        state.desktopRuntimeAt = Date.now()
        if (rt.status === 'ready' || rt.status === 'error') break
      } catch {}
      await new Promise((r) => setTimeout(r, 400))
    }
    await loadRuntimeBots()
    if (state.chatBotId === id || chatBotIdOf(state.path) === id) {
      state.runtimeError = ''
      await ensureChatSession(id)
    }
    if (state.desktopRuntime && state.desktopRuntime.status === 'error') {
      state.deployHint = state.desktopRuntime.lastError || '部署失败'
    } else if (!state.runtimeError) {
      state.deployHint = ''
      flash('ok', '已部署')
    } else {
      state.deployHint = '已登记，实例还在上线'
    }
  } catch (err) {
    state.deployHint = err.message
    flash('err', err.message)
  } finally {
    state.deploying = false
    render()
  }
}
