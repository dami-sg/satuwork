/**
 * 对话。整个前端最重的一块，也是唯一有长连接的一块：
 * 每个 Bot 一条 SSE、事件折叠成消息、增量重绘、以及对话页本身。
 */
let chatAbort = null
let chatStreamId = ''
/**
 * 排着的那次「再拿一遍会话」。同一时刻只允许一条链——见 retryChatSession。
 * 声明摆在这里（而不是挨着那两个函数）：stopChatStream 也要清它，那一个在文件更上面。
 */
let sessionRetryTimer = null
/**
 * 那条重试链认输了没有。输入框底下那行小字要靠它区分「还在等」和「等不到了」——
 * 只看「有没有会话」的话，认输之后那一行还在许愿「接上之后就能发消息」，而这会儿
 * 已经没有任何人在试了。
 */
let sessionGaveUp = false

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
 * botId -> { sessionId, ac, events, sum, hydrated }
 * sum = { busy, lastAt, lastText }，**增量维护**：每次渲染名单都去 fold 一遍全部事件，
 * 几个 Bot 各七百多条，光滚个侧栏就能把 CPU 吃满。
 * hydrated = 这个桶里的历史是不是已经用 HTTP 补全过（见 hydrateChat）。流上只垫一轮，
 * 不补的话点进去只看得见最后那一问一答。
 */
const botStreams = new Map()

/** 同时开着的流的上限。名单通常只有两三个 Bot，这道闸是防意外，不是常态。 */
const BOT_STREAM_MAX = 8

function botStreamOf(botId) {
  let row = botStreams.get(botId)
  if (!row) {
    row = { sessionId: '', ac: null, events: [], sum: { state: 'idle', lastAt: 0, lastText: '' }, hydrated: false, hydrating: null }
    botStreams.set(botId, row)
  }
  return row
}

/**
 * 换了一条会话（席位重建过）——这一行上属于旧会话的东西**全部**作废。
 *
 * 「全部」包括还在飞的那两样，它们才是真正咬人的：
 *
 * · **那条流**。留着它有两笔账。startChatStream 的「已经在跑」闸认的是
 *   `row.sessionId === sessionId && row.ac`，而调用方紧接着就把 sessionId 改成新的
 *   ——闸于是误触发、直接 return，**新会话一条流都开不出来**。同时旧流自己还活着：
 *   它的读循环里 `isActive()` 已经是 false，两道 break 都不成立，于是继续往这只
 *   （刚清空的）桶里灌旧会话的事件，画出来就是另一条对话。
 *
 * · **在飞的那次 hydrate**。它拉的是旧会话的历史。不清掉的话，hydrateChat 那道
 *   「别拉两遍」的闸会把新会话挡在门外，并且返回旧会话那只 promise；旧的一醒来发现
 *   串台就自己走了，于是**新会话的历史从此没人去拉**，界面永远停在流垫的那一轮。
 *
 * 数据那三样漏清也各有症状：漏 sum 是名单上挂着上一条会话的摘要，漏 hydrated 是
 * 新会话永远不去拉历史。
 */
function resetBotStream(row) {
  if (row.ac) {
    try {
      row.ac.abort()
    } catch {}
    // 它可能正是「当前那条」。闩留着指向一个已经掐掉的流，后面谁也认不回来。
    if (chatAbort === row.ac) {
      chatAbort = null
      chatStreamId = ''
    }
    row.ac = null
  }
  row.hydrating = null
  row.events.length = 0
  row.sum = { state: 'idle', lastAt: 0, lastText: '' }
  row.hydrated = false
}

/** 事件到了就地更新摘要。O(1)，不 fold。 */
function noteBotEvent(botId, ev) {
  const row = botStreams.get(botId)
  if (!row) return
  const sum = row.sum
  const before = sum.state + '|' + sum.lastAt + '|' + sum.lastText
  if (ev.type === 'turn/start') sum.state = 'busy'
  else if (ev.type === 'turn/end') sum.state = 'idle'
  // **「待人工处理」现在有数据源了。** 高风险确认会让那次工具调用真的停在席位上等人
  // 拍板（policy/approvals.ts），席位为此发一条 `tool/approval`。名单上那颗点因此有了
  // 第三态：不是在跑，也不是跑完了，而是**在等你**——而人多半正在别的 Bot 那一屏，
  // 名单是他唯一会瞥到的地方。
  else if (ev.type === 'tool/approval') {
    // 终态**只把 review 翻回 busy**，不碰别的状态。无条件写 busy 是错的：点了停止那一
    // 下，`agent.abort()` 不等已经开跑的工具（见 bot 的 bridgeTools），于是 turn/end
    // 完全可能排在这条终态前面到达——那样这颗点会从「空闲」被翻回「正在执行」，然后
    // 一直停在那儿，直到下一轮开始。
    if ((ev.data || {}).state === 'pending') sum.state = 'review'
    else if (sum.state === 'review') sum.state = 'busy'
  } else if (ev.type === 'user/message' || ev.type === 'assistant/message') {
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

/**
 * 从桶里重新认一遍「最近一条消息」。
 *
 * `hydrateChat` 往桶的**开头**塞一段历史，这些事件不能走 noteBotEvent——那一个是按
 * 「刚到的就是最新的」写的，会把名单上的摘要改成二十轮之前那句话。所以补完历史之后
 * 走这里：从后往前找第一条有正文的消息，**比手上这条新才认**。
 */
function refreshSum(row) {
  const sum = row.sum
  for (let i = row.events.length - 1; i >= 0; i--) {
    const ev = row.events[i] || {}
    if (ev.type !== 'user/message' && ev.type !== 'assistant/message') continue
    const text = messageText((ev.data || {}).message) || (ev.data || {}).text || ''
    if (!text) continue
    const at = Number(ev.time) || 0
    if (at < sum.lastAt) return
    sum.lastText = text.replace(/\s+/g, ' ').trim().slice(0, 120)
    sum.lastAt = at || sum.lastAt
    scheduleRosterPaint()
    return
  }
}

/**
 * 往桶里追一条事件，**已经有的就不追**。返回它是不是新的。
 *
 * 桶按 seq 有序（seq 是会话日志的行号，天然单调），所以判据就是「比尾巴还大」。
 *
 * 这道闸是给两条路准备的：历史走 HTTP、实时走 SSE，而流上还垫了一轮
 * （STREAM_TAIL_TURNS）用来给名单和第一帧兜底。那一轮和 hydrateChat 拉回来的最后
 * 一轮**必然重叠**——HTTP 先到的话，流的重放段就是一段桶里全有的事件，照追不误的
 * 结果是最后一问一答在屏幕上出现两遍。
 *
 * 反方向由 hydrateChat 那边的「比头还小才收」挡着。两头都挡上，谁先到就无所谓了。
 */
function pushBotEvent(botId, ev) {
  const list = botStreamOf(botId).events
  const seq = Number(ev && ev.seq)
  if (Number.isFinite(seq)) {
    for (let i = list.length - 1; i >= 0; i--) {
      const last = Number(list[i] && list[i].seq)
      if (!Number.isFinite(last)) continue
      if (seq <= last) return false
      break
    }
  }
  list.push(ev)
  return true
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
 * 消息里的 `@` 点名块。
 *
 * 落盘的是结构（`{type:'mention', kind, id, label}`，见 bot 的 session/types.ts），
 * 正文里一个字都没有——`messageText` 也是这么约定的。所以要显示成药丸只能从这里取。
 */
/**
 * 一颗点名药丸的内容：**有图标就画图标，没有才画那个 `@`**。
 *
 * 两者说的是同一件事——「这一颗是点名，不是随手带的附件」。图标把它说得更清楚（一眼
 * 认出是哪一家），那就不必再顶一个 `@` 在前面；图标取不到时才轮到 `@` 顶上，不然药丸
 * 退化成一个看不出来历的普通标签。
 *
 * 图标只有候选清单里有（`/mentions` 的 `logo`）。消息里存的是 `{kind,id,label}`，所以
 * 历史那条要按 id 回候选里查（候选在 loadChatPage 里就拉了）。
 *
 * 图标 404 的那一下也要接住：`replaceWith('@')` 把它原地换成 `@`，不是删掉——删掉的话
 * 那颗药丸既没图标也没 `@`。这里能直接写字符串是因为它不含引号，不像 connectorLogo
 * 那段要把一整段 HTML 塞进属性（见 pages-connectors.js 里那个转义两次的坑）。
 */
function mentionPill(m) {
  const logo = m.logo || (state.mentionOptions || []).find((x) => x.id === m.id)?.logo || ''
  const head = logo ? `<img src="${esc(logo)}" alt="" onerror="this.replaceWith('@')">` : '@'
  return `<span class="sw-mention">${head}<span>${esc(m.label)}</span>`
}

function messageMentions(msg) {
  const content = msg && msg.content
  if (!Array.isArray(content)) return []
  return content
    .filter((b) => b && b.type === 'mention' && b.label)
    .map((b) => ({ kind: b.kind || 'connector', id: b.id || '', label: String(b.label) }))
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
 * 打开对话只取最近几轮，往上翻再一页页往前推。以前是整段推——实测 1078 条，慢，而且
 * 尾巴容易压在下游缓冲里出不来，那正是「历史缺一截 + 永远正在处理」的成因。
 * `firstSeq` 是手上最靠前那条的 seq，也就是再往前翻的游标。
 *
 * **三个地方都写这一对**：`hydrateChat` 拉回第一页、`loadOlderChat` 往前翻、流上的
 * `replay/done`。所以写入统一走 noteChatPage，别各写各的。
 */
const chatPages = new Map()

/**
 * 记下「手上最靠前那条是谁」和「它前面还有没有」。
 *
 * 规矩只有一条：**谁知道得更早，谁说了算。**
 *
 * 三个写入方看到的窗口不一样大——流上只垫一轮（STREAM_TAIL_TURNS），HTTP 一次二十
 * 轮，往前翻又是另一页——而谁先落地取决于网络。窄窗口晚到时如果照写，游标就被推回
 * 「最后一轮的开头」，于是「加载更早的对话」去取的是一页手上全有的事件：归并那两道
 * 闸（进桶比尾巴大、补历史比头小）会把它们全滤掉，按钮点了没反应。
 *
 * `hasMore` 必须跟着 `firstSeq` 一起走——那句「前面还有没有」问的是**这一条**之前。
 * 拆开取会配出一对互相矛盾的值。
 *
 * `loading` 只有 loadOlderChat 说了算（它是唯一会把按钮置灰的人），别人不传就保持
 * 原样：顺手写一个 `loading: false` 会把正在飞的那次翻页从界面上「解灰」，人一点就
 * 又发一次。
 */
function noteChatPage(sessionId, next) {
  const cur = chatPages.get(sessionId) || {}
  const known = typeof cur.firstSeq === 'number' ? cur.firstSeq : null
  const first = typeof next.firstSeq === 'number' ? next.firstSeq : null
  // 带来了更早的游标就是它赢；一条游标都没带（空会话、续传）时，只有在我们本来也
  // 什么都不知道的情况下才认它那句 hasMore。
  const wins = first != null ? known == null || first < known : known == null
  chatPages.set(sessionId, {
    ...cur,
    firstSeq: wins && first != null ? first : cur.firstSeq,
    hasMore: wins && typeof next.hasMore === 'boolean' ? next.hasMore : cur.hasMore,
    loading: next.loading !== undefined ? next.loading : Boolean(cur.loading),
  })
  scheduleLoadMorePaint()
}

/**
 * 每条会话排着的消息：`[{ id, text, mentions, images, createdAt }]`。
 *
 * **真相在席位那边**，这里只是它推过来的一份副本。放浏览器里自己记的话，刷新一次
 * 就丢、两个标签页各排各的，而消息其实已经发出去了——「界面上没有但它还是跑了」是
 * 最糟的一种状态。
 */
const chatQueues = new Map()

/** 历史一页几轮。人来是看最近说了什么的，更早的等他往上翻。 */
const CHAT_TAIL_TURNS = 20

/**
 * 流上垫几轮历史。
 *
 * **历史和实时拆成了两条路**：历史走 HTTP（`hydrateChat` / `loadOlderChat`，一次
 * 请求一页，promise 落地就是「拿全了」），SSE 只管实时那一段。
 *
 * 为什么不是 0：
 *
 *   · 名单上那行灰字（最近一条消息 + 时间）要有个来源，垫一轮就够，而 `tail=0` 在
 *     席位那边的含义是「整段推」（historySlice 的 turns=0 不切），正好相反；
 *   · 点进一个 Bot 的**第一帧**要有东西可看。历史那次 HTTP 还在路上时，屏幕上先有
 *     最后一问一答，比空白诚实。
 *
 * 为什么不是 20：名单上每个 Bot 都挂一条流（warmBotStreams），二十轮乘几个 Bot，
 * 全在主线程上 JSON.parse——而那一堆事件最后只换来侧栏的一行字。
 */
const STREAM_TAIL_TURNS = 1

/**
 * 用户消息开头那段「我上传了文件，在工作区里：」是 composeChatBody 自己拼的
 * （同一个文件里，往下找）。这里把它认回来。
 *
 * **为什么值得认**：不认的话，附件在气泡里就是一行不能点的路径文本，而 Bot 生成的
 * 文件早就是可以点开预览的药丸了——同一个东西，自己传上去的反而看不了，这说不通。
 *
 * 敢按文本认，是因为这段文本**是我们自己生成的**，格式由 composeChatBody 定死；
 * 而且判据卡得很紧：首行必须整句相等（中英两版都列在下面，一条消息可能在另一种
 * 语言下被打开），随后必须是连续的 `- \`uploads/…\`` 行。这和「拿正则去扫模型写的
 * 散文猜路径」是两回事——那种一改措辞就散架，这种不会。
 */
const UPLOAD_LEADS = ['我上传了文件，在工作区里：', 'I uploaded some files. They are in the workspace at:']

function splitUploads(text) {
  const src = String(text == null ? '' : text)
  const lead = UPLOAD_LEADS.find((x) => src.startsWith(x + '\n'))
  if (!lead) return { text: src, files: [] }
  const lines = src.slice(lead.length + 1).split('\n')
  const files = []
  let i = 0
  for (; i < lines.length; i++) {
    const m = /^- `(uploads\/[^`]+)`$/.exec(lines[i])
    if (!m) break
    files.push({ path: m[1], name: m[1].split('/').pop() || m[1] })
  }
  if (!files.length) return { text: src, files: [] }
  return { text: lines.slice(i).join('\n').trim(), files }
}

function fold(events, live) {
  const blocks = []
  let assistant = null
  let tools = []
  let status = ''
  // 空壳工具调用的 callId（见下面 tool/call）。它们的结果也要一起跳过。
  const phantoms = new Set()
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
      const raw = messageText(data.message) || data.text || ''
      const up = splitUploads(raw)
      blocks.push({
        kind: 'user',
        text: up.text,
        // 附件列表拆出来单独画成药丸；正文只留人真正打的那句话。
        files: up.files,
        // **点名要跟着消息留下来。** 它是这条消息的一部分（决定了这一轮的工具表），
        // 不是输入框上一个发完就没的装饰。丢掉的话翻上去看昨天那条，「@ 了谁」就消失了，
        // 而那正是「它为什么去读了我的邮箱」的唯一答案。
        mentions: messageMentions(data.message),
        // **raw 不能省。** mergePending 靠「文字一模一样」认回执，而它手上那份是
        // 拼好的完整正文。只留拆过的 text，带附件的消息就永远认不回来——那条 pending
        // 销不掉，界面会一直挂着「正在思考」。
        raw,
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
      assistant.endTime = at
    } else if (type === 'assistant/chunk') {
      const chunk = data.chunk || {}
      if (chunk.type === 'text-delta' && chunk.text) {
        if (!assistant) {
          assistant = { kind: 'assistant', text: '', tools, time: at, seq: ev.seq }
          blocks.push(assistant)
        }
        assistant.text += chunk.text
        assistant.endTime = at
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
      // **没有名字的不画。** 那是 bot 那边一个已经修掉的下标错位留下的空壳（见
      // llm/gateway.ts 的 toolSlot），它从来没跑过、也跑不起来，pi 一句「找不到叫「」
      // 的工具」就把它判失败了。可**已经写下的日志里还留着**，翻上去看昨天那轮，
      // 每一轮开头都挂一颗红色的「tool · 失败」，点开里面什么都没有。
      // 结果也一起跳过（见下面 tool/result）：不跳的话它会按「第一条还没有结果的」
      // 认过去，把一次成功的调用标成失败。
      if (!String(data.name || '').trim()) {
        phantoms.add(data.callId)
        continue
      }
      // arguments 要留着：工具药丸的悬浮窗全靠它回答「这次到底拿什么跑的」。存的是
      // bot 那边 JSON.stringify 过的原串，展示时再 parse 一次做缩进（见 toolPopBody）。
      tools.push({
        callId: data.callId,
        name: data.name,
        args: typeof data.arguments === 'string' ? data.arguments : '',
        result: null,
        failed: false,
      })
      assistant.tools = tools
      assistant.endTime = at
    } else if (type === 'tool/result') {
      if (phantoms.has(data.callId)) continue
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
      if (assistant) assistant.endTime = at
    } else if (type === 'tool/approval') {
      /**
       * 高风险确认。**挂在助手那一块上，不另起一块。**
       *
       * 另起一块的话，卡片会插在正在跑的这一轮中间：上面是已经吐出来的正文、下面是
       * 后续的正文，而工具药丸和它的结果分属两块——`tool/result` 按 callId 认药丸，
       * 认不回去就会把一次成功的调用标成失败。挂在块上，位置就在那颗药丸底下，
       * 也正是人要找它的地方。
       */
      if (!assistant) {
        assistant = { kind: 'assistant', text: '', tools, time: at, seq: ev.seq }
        blocks.push(assistant)
      }
      const list = assistant.approvals || (assistant.approvals = [])
      const cur = list.find((a) => a.callId === data.callId)
      if (cur) {
        // 同一个 callId 会来两条：先 pending，人点了之后再来终态。取最后一条。
        cur.state = data.state || cur.state
        if (data.scope) cur.scope = data.scope
        // 终态那条带的是**最终**那一份（人改过的话就是改后的），覆盖掉起草时那份。
        if (typeof data.arguments === 'string') cur.args = data.arguments
        if (data.form && Array.isArray(data.form.fields)) cur.form = data.form
        if (Array.isArray(data.edited)) cur.edited = data.edited
      } else {
        list.push({
          callId: data.callId,
          name: data.name || '',
          args: typeof data.arguments === 'string' ? data.arguments : '',
          reason: data.reason || '',
          // 这次用哪张卡、卡上哪几格。**席位算好的**，界面照着画（见 policy/forms.ts）。
          form: data.form && Array.isArray(data.form.fields) ? data.form : null,
          edited: Array.isArray(data.edited) ? data.edited : null,
          state: data.state || 'pending',
          expiresAt: Number(data.expiresAt) || 0,
          // 这条 pending 落在日志的第几行。核对现况时拿它跟快照的水位比——
          // **不拿时间比**，那是两台机器各自的钟（见 approvalDead）。
          seq: ev.seq,
        })
      }
      assistant.endTime = at
    } else if (type === 'turn/start') {
      status = 'running'
    } else if (type === 'turn/end') {
      status = ''
      // **这一轮真正收口的时刻。** 气泡下面那个时间要的是「输出完毕」而不是「开始
      // 输出」，靠的就是它：比最后一条 chunk 准，也覆盖「只调工具、一个字没吐」的
      // 那种轮次（那种轮里根本没有 chunk 可以取时间）。
      if (assistant) assistant.endTime = at
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
  // 排着的那次「再拿一遍会话」也一起停。退出登录走的就是这条路（见 app.js 的
  // logout），留着它的话，票都清了它还会照着上一个人的 Bot 再敲十几次接口。
  cancelSessionRetry()
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
 * 把最近一页历史用**一次 HTTP** 拉回来，填进这个 Bot 的事件桶。
 *
 * 这是「历史」和「实时」拆成两条路里的那一条。以前两件事挤在同一条 SSE 上：连上先推
 * 二十轮历史，推完发一条 `replay/done` 说「后面是实时的了」。挤在一起有三笔账：
 *
 *   · **「放完了没有」只能猜。** 历史和实时是同样的 `data:` 帧，客户端分不出来，只好
 *     靠 replay/done 这个标记加三个定时器（REPLAY_QUIET/MAX/STALL）兜着。HTTP 不用
 *     猜——promise 落地就是拿全了。
 *   · **尾巴会压在下游缓冲里。** 实测 bot 报重放 1078 条、客户端只收到 1054 条，
 *     replay/done 从没到达（见 bot 的 web/index.ts）。JSON body 没有这个失败模式：
 *     要么整段拿到，要么抛。
 *   · **名单上每个 Bot 都要开一条流**，二十轮乘几个 Bot 全在主线程上 parse，换来的
 *     只是侧栏一行字。
 *
 * 和往上翻用的是同一个接口、同一个切片函数（席位那边的 historySlice），区别只是不带
 * `before`——也就是「最新的一页」。
 *
 * **不 await 也能用**：调用方开完流就走，这边拉回来自己重画。屏幕上先是流垫的那一轮，
 * 历史到了再从上面接进去。
 */
async function hydrateChat(botId, sessionId) {
  const row = botStreamOf(botId)
  if (!sessionId || row.sessionId !== sessionId || row.hydrated) return
  // 两个入口都会叫它（切过去时一次、席位回来重连时一次），别拉两遍。
  if (row.hydrating) return row.hydrating
  const job = (async () => {
    let data
    try {
      data = await api('GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/history?turns=${CHAT_TAIL_TURNS}`)
    } catch (err) {
      // 席位没上线之类。**不置 runtimeError**：流那边正在为同一件事重试，两处都喊
      // 会把「实例还没上线」和「连接断开」轮流刷在同一行上。留着 hydrated=false，
      // 下次切过来再试，人也可以点顶上那个「加载更早的对话」自己重来。
      return
    } finally {
      // 只清自己那一把。会话换过之后这里可能已经是**新一轮**的 job 了，清掉它就等于
      // 把那道「别拉两遍」的闸打开。
      if (row.hydrating === job) row.hydrating = null
    }
    // 拉回来这一路上，席位可能重建过会话——那这份历史属于另一条对话，认了就是串台。
    if (row.sessionId !== sessionId) return
    // **空 body 也是 200。** api() 在 body 为空时返回 null（Gateway 的 proxyJson 同样
    // 把席位的空 body 转成 200 + null），下面那几个 data.xxx 会当场抛——而 hydrated
    // 已经置位了，于是这个 Bot 从此不再重拉，永远停在流垫的那一轮。当成拉失败处理：
    // 不置 hydrated，切走再切回来会重来一次。
    if (!data) return
    const older = data.events || []
    // **只收比手上最靠前那条还早的。** 流垫的那一轮和这一页必然重叠，而 seq 是日志
    // 行号、天然单调，所以「比头还小」既是去重也保证了插进去之后仍然有序。
    const head = row.events.length ? Number(row.events[0].seq) : Infinity
    const add = older.filter((ev) => Number(ev.seq) < head)
    if (add.length) {
      const thread = state.chatSessionId === sessionId ? document.getElementById('chat-thread') : null
      // 往开头插东西会把视线甩走，和翻页是同一个补法（见 loadOlderChat）。
      chatAnchorHeight = thread ? thread.scrollHeight : 0
      row.events.unshift(...add)
    }
    row.hydrated = true
    // 这些是**旧**事件，不能走 noteBotEvent（它按「刚到的最新」写）。
    refreshSum(row)
    noteChatPage(sessionId, { firstSeq: data.firstSeq, hasMore: data.hasMore })
    if (state.chatSessionId === sessionId) paintChat()
    void syncApprovals(botId, sessionId)
  })()
  row.hydrating = job
  return job
}

/**
 * 核对一遍「哪几条确认还真的等着」。
 *
 * 卡片本身是从会话事件折出来的，可日志只说「那时候它在等」。**等待方是席位进程里的
 * 一个 Promise**：席位重启过、或者那条早就超时而这台浏览器当时没连着，日志上那条
 * pending 就永远停在那儿——人点下去什么都不会发生，只换回一句 409。
 *
 * 所以拉一次现况，比它早的 pending 只要不在清单里就画成失效。**「比它早」按 seq 算，
 * 不按时间算**：事件上的 time 是席位盖的，而「现在几点」是浏览器这边的——两台机器的
 * 钟差几十秒是常态（虚拟机漂移），席位慢一点的话，拉取之后新冒出来的确认会显得比快照
 * 还早，于是一张真的在等的卡片被画成失效、按钮消失，人只能眼看着它五分钟后超时。
 * seq 是会话日志的行号，两边看到的是同一个数，没有这个问题。
 *
 * 水位取在**发请求之前**：那之后落下的事件，席位的回执里可能来不及包含。
 */
function maxSeqOf(events) {
  let max = 0
  for (const ev of events || []) {
    const seq = Number(ev && ev.seq)
    if (Number.isFinite(seq) && seq > max) max = seq
  }
  return max
}

async function syncApprovals(botId, sessionId) {
  const upto = maxSeqOf(botStreamOf(botId).events)
  try {
    const data = await api('GET', `/runtime/sessions/${encodeURIComponent(sessionId)}/approvals`)
    const ids = new Set(((data && data.pending) || []).map((p) => p.callId))
    state.chatApprovals = { sessionId, ids, upto }
    if (state.chatSessionId === sessionId) paintChat()
  } catch {
    // 席位没上线、或者这台席位还是老版本没有这条路由。**什么都不做**：宁可留着一张
    // 可能点不动的卡片，也不要把一条真的在等的确认画成失效——那会让人以为不用管它。
  }
}

/**
 * 这张卡片还点得动吗。
 *
 * 只有一条判据，而且必须是「确定不在等了」：这条确认在核对那一刻之前就落了盘，
 * 而席位报回来的待办里没有它。超时那一路不靠这里——席位超时时会自己补一条终态事件，
 * 那条走同一条流回来，比在浏览器这边拿两台机器的钟去猜可靠得多。
 */
function approvalDead(a) {
  if (a.state !== 'pending') return false
  const snap = state.chatApprovals
  if (!snap || snap.sessionId !== state.chatSessionId || !snap.upto) return false
  return Boolean(a.seq && a.seq <= snap.upto && !snap.ids.has(a.callId))
}

/**
 * 拿会话这一跳没成就退避重来。
 *
 * **「刚部署完，字打得进去、点发送没反应，刷新一下就好了」漏的就是这一环。** 席位
 * 报 ready 之后还有几十秒接不了话，而且有**两副面孔**：
 *
 * · 进程还没听上端口 → Gateway 转不过去，503「实例还没上线」；
 * · 端口听上了，但公司目录还没同步下来（名册里还没有这颗 Bot，见 bot 的
 *   registry `ensureSession`）→ 404「没有这个助理」。
 *
 * 两种原先都是「记一笔就完」：chatSessionId 留空，而 sendChat 开头那道闸认的正是它，
 * 于是每一次发送都被无声地吞掉——屏幕上一个字都没有，只有刷新（重跑 loadChatPage）
 * 才会再拿一次会话。所以这里跟着流那边的做法退避重连：席位回来了，这一页自己接上，
 * 不用人去刷新。
 *
 * 上限 60 次（约 5 分钟，前 4 次退避到 5 秒，之后每次 5 秒）。真的一直不回来，才把话摆
 * 到界面上——那时候「稍等」是骗人的。
 *
 * **48 秒是不够的**，和流那边（CHAT_RETRY_MAX）同一个理由：重铺一个席位要拉发布包、
 * 解包、rsync、重启两个单元、再各自自证端口，几分钟是常态；换版之前管家还会先等席位
 * 把手上那一轮跑完（见 manager/src/seats.ts 的排空），那一段最长又是两分钟。等不够就
 * 认输的话，人在换版期间刷了一次页面，这一页就再也接不上了。
 */
const SESSION_RETRY_MAX = 60

function cancelSessionRetry() {
  if (sessionRetryTimer) clearTimeout(sessionRetryTimer)
  sessionRetryTimer = null
}

/**
 * 这个错值不值得再来一次。
 *
 * 认状态码，不认文案——文案是会被翻译的（见 api()）。503/502/504 是席位那一跳没通，
 * 没有状态码是请求压根没发出去。
 *
 * **404 不在其列，而且必须不在。** 这条接口上的 404 只剩一个含义了：这颗 Bot 不是你的
 * ／已经删了（visibleBotOf）——等一万年也是同一个答案，重试只会白敲十几次接口，然后
 * 拿「实例还没接上」盖掉真正的原因。席位那种「我还不认识它」的 404 由 Gateway 折成了
 * 503（见 routes/runtime.ts 里 `/runtime/bots/:id/session` 的那段），走上面那一路。
 * 403 / 401 同理，不重试。
 */
function seatWarmingUp(err) {
  const st = Number(err && err.status)
  return !st || st === 502 || st === 503 || st === 504
}

function retryChatSession(botId, attempt) {
  cancelSessionRetry()
  if (attempt >= SESSION_RETRY_MAX) {
    // **这一句要看得见。** '实例还没上线' 被 runtimeDownBanner 挡在界面外（它是常态，
    // 不该每次重新部署都弹一条红字），可等了快一分钟还没接上就不是常态了。
    sessionGaveUp = true
    state.runtimeError = '实例还没接上，等一会儿再试，或者重新部署一次'
    render()
    return
  }
  const delay = Math.min(500 * 2 ** attempt, 5000)
  sessionRetryTimer = setTimeout(() => {
    sessionRetryTimer = null
    // 人切走了、或者别的路子已经把会话拿到了——这次重排就此作废。
    if (state.chatBotId !== botId || state.chatSessionId) return
    void ensureChatSession(botId, attempt + 1).catch((err) => {
      // 重试路上冒出来的「答案不会变」的错（权限变了、Bot 被删了）。这一路没有调用方
      // 接得住它，只能自己摆出来——**而且要 render**：flash 只写 state，不重绘就要等
      // 下一次别的什么触发重绘，那时候人已经又按了三次发送。
      sessionGaveUp = true
      flash('err', err.message)
      render()
    })
  }, delay)
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
async function ensureChatSession(botId, attempt = 0) {
  if (!botId) return
  // 这一跳现在就要发，排在后面那次重排作废（换 Bot 时同理：它盯的是上一个 Bot）。
  cancelSessionRetry()
  sessionGaveUp = false
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
    // 先把手上有的画出来——流垫的那一轮已经在桶里，切过去是**这一帧**就有东西看。
    paintChat()
    // 更早的那些走 HTTP 补。不 await：补回来自己重画，视线用 chatAnchorHeight 钉住。
    void hydrateChat(botId, warm.sessionId)
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
    // 换了一条会话（席位重建过）——旧事件、旧摘要、旧的「历史补过了」一起作废。
    if (row.sessionId && row.sessionId !== sessionId) resetBotStream(row)
    row.sessionId = sessionId
    state.chatEvents = row.events
    state.chatSessionId = sessionId
    state.chatStatus = ''
    // 接上了。等席位那段时间挂的话要撤掉，否则界面上会一直留着一句已经不成立的
    // 「还没接上」——流那边要是断了，它自己会再挂一次。
    state.runtimeError = ''
    // **两条路一起发，谁先到算谁的。** 历史走 HTTP，实时走 SSE（只垫一轮）；两边都
    // 带 seq，hydrateChat 按「比头还小才收」归并，重叠的那一轮不会画两遍。
    //
    // 都不 await：多等一个 RTT 才切页面，人按下去那一下就是白等。
    void hydrateChat(botId, sessionId)
    void startChatStream(sessionId, 0, botId)
  } catch (err) {
    const msg = String(err.message || '')
    // 席位还在热身（见 retryChatSession 上面那段）：排一次重来，**并且不往外抛**——
    // 抛出去就是一条红字，而这会儿正确的说法是「还没好」，不是「坏了」。
    if (seatWarmingUp(err)) {
      if (state.chatBotId === botId) retryChatSession(botId, attempt)
      if (msg.includes('实例还没上线')) state.runtimeError = '实例还没上线'
      // 输入框底下那行小字要跟着改口（见 paintChatChrome）：人正对着它等。
      paintChat()
      return
    }
    // 剩下的是「答案不会变」的那些（没权限、这颗 Bot 不是你的）：照旧往外抛，由
    // loadPage 摆成一条红字。
    throw err
  }
}

async function loadChatPage() {
  state.chatCtxOpen = false
  // 换了会话，上一条还没发出去的 `@` 不该跟过来——它指的是「这一条消息带谁」。
  state.chatMentions = []
  state.mentionPick = null
  // 候选清空：换 Bot 之后连接没变，但换公司/换人之后就变了，重开一页重拉一次不亏。
  state.mentionOptions = null
  /**
   * 候选**这一页就拉**，不等人打 `@`。
   *
   * 历史消息里的点名药丸要画连接器的图标，而消息里只有 `{kind,id,label}`——图标得按 id
   * 回这份候选里查。等打 `@` 才拉的话，刚进页面翻上去看昨天那条，药丸上是没有图标的，
   * 打一次 `@` 之后又突然有了。**不 await**：它只影响药丸上那个小图标，不该把整页拖住。
   */
  void api('GET', '/mentions')
    .then((r) => {
      state.mentionOptions = r.mentions || []
      paintChat()
    })
    .catch(() => {})
  // loadRuntimeBots 由 loadPage 统一拉（名单是全局侧栏，不只这一页要）。
  await loadRuntimeMachine()
  // 上下文占比要知道模型的窗口有多大。新日志的 request/header 自带，老日志没有，
  // 目录是那种情况下的唯一来源。**不 await，也不让它的失败冒出来**——一条灰字的提示
  // 不值得把整页的加载拖住或者拖挂。
  if (!(state.catalog || []).length) void loadCatalog().catch(() => {})
  const botId = chatBotIdOf(state.path)
  await loadDesktopRuntime(botId)
  // 右栏那一列日常任务。**不 await**：它只画右栏，不该让正文晚一个 RTT 才出来。
  void loadRoutines(botId)
  if (botId) await ensureChatSession(botId)
  // 名单上每个 Bot 都挂一条流。刷新页面之后也能立刻看出谁在干活、谁最近说了什么——
  // 只连当前这一个的话，那两列信息要等人挨个点进去才出得来。
  void warmBotStreams()
}

/**
 * 给名单上的每个 Bot 都开一条流（当前这个除外，它自己会开）。
 *
 * 这些流**只为侧栏那一行字**：在不在跑、最近说了什么、什么时候说的。所以它们垫的
 * 历史是 STREAM_TAIL_TURNS（一轮），不是打开对话要看的那二十轮——那二十轮改由
 * hydrateChat 在人真的点进去时才拉。
 *
 * 串着来、不并发：拿 sessionId 那一跳是每个 Bot 一个请求，几个 Bot 同时发会跟正文
 * 抢席位那边的连接，而这些数据只是侧栏上的一行字。
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
      if (r.sessionId && r.sessionId !== data.sessionId) resetBotStream(r)
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
 * 次，正在看的对话就无声地卡住了，人还以为 bot 在想。退避重试到这个档位为止，
 * 之后才把「连接断开」摆到界面上。
 *
 * **6 档（约 24 秒）不够。** 它挡得住网络抖一下，挡不住一次换版：重铺一个席位要拉
 * 发布包、解包、rsync 一份 app、重启两个单元，两个端口还各自自证 30 秒——几分钟是
 * 常态。24 秒之后这条流就认输了，而认输之后消息照发照跑：POST 走的是另一条请求，
 * 回答经 SSE 送出来时没人在听，屏幕上那句「正在思考」于是一直挂着，bot 日志里那一轮
 * 明明写着 completed。刷新一下就好，因为那会重开一条流——「更新完运行时，回复卡在
 * 界面上不动，刷新才看得见」说的就是这件事。
 *
 * 40 档 ≈ 5 分钟（前 5 档退避到 8 秒，之后每档 8 秒），够一次换版走完。真的一直不
 * 回来才认输，而认输也不再是死局：见 reviveChatStream——发消息、切回这个标签页、
 * 点那句话里的「重新连接」，任意一样都会当场再开一条。
 */
const CHAT_RETRY_MAX = 40
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
  // 头一次连（手上还没有事件）才要 tail，而且**只垫一轮**——打开对话要看的那二十轮
  // 走 HTTP（hydrateChat）。续传时 after 说了算，要的是「补上错过的」。
  const q = after != null ? '?after=' + encodeURIComponent(after) : '?tail=' + STREAM_TAIL_TURNS
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
    endReplay()
    if (ac.signal.aborted) {
      releaseChatStream(ac, owner)
      return
    }
    // **连不上要接着退避重试，不能就此认输。** 见下面 503 那条的说明。
    noteStreamWarming(sessionId)
    return retryChatStream(sessionId, ac, attempt + 1)
  }
  /**
   * 503 = 席位此刻不在（Gateway 对席位的 fetch 抛了或没回 2xx，见 runtime.ts 的
   * proxySse）。**这是「正在重启」，不是「坏了」**：每一次重新部署、每一次管家换版，
   * 都必然有几秒钟落在这个窗口里。
   *
   * 以前这里直接 return，于是撞上这几秒的那次重连就是最后一次——流断了、也不再重来。
   * 席位一分钟后好端端地回来了，页面却再也接不回去：消息 POST 走的是另一条请求，
   * 照发照跑，回答经 SSE 送出来时没人在听。屏幕上就一直挂着「正在思考」——因为
   * mergePending 手上那条 pending 只能靠 SSE 回来的 user/message 销账（见 mergePending）。
   * bot 日志里那一轮明明写着 completed，这是那个「日志跑完了、网页还转着」的成因。
   *
   * 退避重试到 CHAT_RETRY_MAX 为止（约 5 分钟，够一次换版走完）；真的一直不回来，
   * retryChatStream 会把「连接断开」摆到界面上。
   */
  if (res.status === 503) {
    endReplay()
    noteStreamWarming(sessionId)
    return retryChatStream(sessionId, ac, attempt + 1)
  }
  /**
   * 剩下的非 2xx 分两类，处置相反，所以必须分开。
   *
   * · **401 / 403 / 404 是「答案不会变」**：票过期了、这颗 Bot 不是你的、席位在那台
   *   机器上已经没了。重试只会白敲接口，再拿一句「实例还没上线」把真正的原因盖掉。
   *   当场认输，把席位那句原话摆出来。
   *
   * · **其余（500、502、504、以及 ok 但没有 body 的那种）跟 503 一路**：那是中间这
   *   几跳的临时故障——管家反代不到席位时回的正是 502（见 manager/src/proxy.ts），
   *   而换版那几分钟里它就是这个样子。以前这里一律认输，于是一次 502 和「席位永远
   *   没了」在界面上是同一件事。
   */
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    releaseChatStream(ac, owner)
    endReplay()
    // **render，不是 paintChat**（见 noteStreamDown 与 retryChatStream 认输那一处的
    // 长注释）：那句话摆在顶上那条横幅里，而横幅只由 chatPage() 拼。
    noteStreamDown(sessionId, (await res.text().catch(() => '')) || '实例还没上线')
    return
  }
  if (!res.ok || !res.body) {
    endReplay()
    noteStreamWarming(sessionId)
    return retryChatStream(sessionId, ac, attempt + 1)
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
          /**
           * 排队的消息有变。**不是会话事件**，不进事件桶——它还没发生，进了桶就会被
           * 当成历史画成气泡。它只画在输入框顶上那一行 dock 里。
           */
          if (ev.type === 'queue/change') {
            chatQueues.set(sessionId, Array.isArray(ev.queued) ? ev.queued : [])
            if (isActive()) paintChatQueue()
            continue
          }
          if (ev.type === 'replay/done') {
            disarmStall()
            // 刷新页面之后 dock 要能原样回来：队列在席位那边，这里只是接住它。
            if (Array.isArray(ev.queued)) {
              chatQueues.set(sessionId, ev.queued)
              if (isActive()) paintChatQueue()
            }
            // bot 明说历史放完了。它不是会话事件，不进事件桶。
            // 顺带说了这条会话此刻在不在跑——这句是权威，压过扫出来的那个结论。
            // 续传（after>0）那次 bot 不给这两个值；流垫的又只有一轮，比 hydrateChat
            // 那二十轮窄。两种情况都由 noteChatPage 挡住，别把已经知道的覆盖掉。
            if (typeof ev.firstSeq === 'number' || typeof ev.hasMore === 'boolean') {
              noteChatPage(sessionId, { firstSeq: ev.firstSeq, hasMore: ev.hasMore })
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
            if (!pushBotEvent(owner, ev)) {
              // 重复的——历史那条路已经收过这一条了。不进桶、不改摘要，但它证明流还
              // 活着，重放的静默判定要跟着往后推，否则一段全是重复的重放会让闸提前开。
              if (isActive() && state.chatReplaying) bumpReplayQuiet()
              continue
            }
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
    /**
     * **必须 render()，paintChat() 是不够的。**
     *
     * 这句话和旁边那颗「重新连接」按钮画在顶上那条横幅里，而横幅只在 chatPage() 里
     * 拼一次（见 runtimeDownBanner 的调用处）；paintChat 只重画消息流和输入区那几个
     * 已有节点，横幅一个字都不会变。
     *
     * 而这一刻的处境恰恰是「再也不会有别的东西来触发重绘」——流已经死了，事件不会
     * 再来，tickClocks 只改 .sw-time 的文本。于是屏幕上什么都没有：认输了、没人再
     * 重连、也没有那颗能救回来的按钮，界面就那么静静挂着——正是这次要修的那个症状。
     * retryChatSession 认输那一处走的就是 render()。
     *
     * 整页重绘的代价（输入框被换掉、正打着字的人丢焦点和光标位置，见 paintChatCtx 上
     * 的注释）在这里认了：它一整条流只发生**一次**，而且是在连着五分钟接不上之后；
     * 草稿本身跟着 state.chatDraft 回来，不会丢。而后台那几条流断了不走这一下——
     * 见 noteStreamDown。
     */
    noteStreamDown(sessionId, '连接断开')
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
 * 「这条流断了」摆到界面上。
 *
 * **只有人正看着的那一条有资格占用那条横幅。** 名单上每个 Bot 都挂着一条流（见
 * warmBotStreams），其中任何一条断掉都会走到这里——而它说的是另一个 Bot 的事：屏幕上
 * 那条对话好好的，却被扣上一句「连接断开」，人会去点那颗「重新连接」，重连的也是另一
 * 条流。更实在的代价是**那一下是整页重绘**：正在打字的人当场丢焦点和光标位置，而起因
 * 是他根本没在看的一个 Bot。
 *
 * 后台流断了就安静地放手：名单上那一行停在最后一次摘要上，人点进去时 ensureChatSession
 * 会重新拿会话、重新开流。
 */
function noteStreamDown(sessionId, message) {
  if (state.chatSessionId !== sessionId) return
  state.runtimeError = message
  // **人不在对话页上就只记下来，不重绘。** 横幅只由 chatPage() 拼，在别的页上重绘一
  // 次谁也看不到那句话，代价却是把人正在填的表单换掉（切走不掐流，所以这条流完全
  // 可能在人已经翻到「机器」页之后才认输）。他回到对话页时 loadPage 自己会重绘。
  if (isChatPath(state.path)) render()
}

/**
 * 「这条流还在热身，正在退避重连」。同样只对人正看着的那一条说。
 *
 * runtimeDownBanner 把「实例还没上线」挡在界面外（它是常态，不该每次重新部署都弹红
 * 字），所以这一句本身不上屏——但它**会盖掉正摆着的那一句**。名单上那几个 Bot 的流
 * 各自在退避重连，谁都会往这一格里写：当前这条会话刚拿到一句「这颗 Bot 不是你的」，
 * 半秒后就被另一个 Bot 的 503 抹成「实例还没上线」，然后横幅连带着消失，人什么都
 * 看不到了。scope 一道，这一格就只由人正看着的那条会话写。
 */
function noteStreamWarming(sessionId) {
  if (state.chatSessionId !== sessionId) return
  state.runtimeError = '实例还没上线'
  // 同上：不在对话页上就没有可画的（paintChat 找不到 chat-thread 会直接返回，但在那
  // 之前它已经把整份事件 fold 了一遍——长会话上这不便宜，而且每一档退避都来一次）。
  if (isChatPath(state.path)) paintChat()
}

/** 这条会话此刻有没有人在听。判据和 startChatStream 那道「已经在跑」的闸一致。 */
function chatStreamAlive(sessionId, botId) {
  if (!sessionId) return false
  const row = botId ? botStreams.get(botId) : null
  if (row && row.sessionId === sessionId && row.ac) return true
  return chatStreamId === sessionId && Boolean(chatAbort)
}

/**
 * 没人在听就当场再开一条。
 *
 * **认输不该是死局。** retryChatStream 退避到头会把 ac 清掉、摆一句「连接断开」——
 * 那之后没有任何东西会再去重连，而这一屏还好端端地开着：消息照发照跑，回答经 SSE
 * 送出来时没人接，屏幕上一直挂着「正在思考」。原先唯一的出路是刷新整页。
 *
 * 三个入口都走这里：发消息之前（人正要用它，这是最该确认的一刻）、标签页回到前台
 * （合盖一小时回来，中间那一跳早把流掐了）、以及那句话里的「重新连接」。
 *
 * 重连带 after 游标（见 chatCursor），断线期间错过的那几条会一起补回来——所以这不是
 * 「从现在开始听」，是真的把断掉的那一段接上。
 */
function reviveChatStream(sessionId, botId) {
  const owner = botId || botIdOfSession(sessionId)
  if (!sessionId || chatStreamAlive(sessionId, owner)) return false
  /**
   * 这句话是上一次认输留下的，现在正要重来，先撤掉。
   *
   * **撤掉要连着 render()。** 它和那颗「重新连接」按钮画在顶上那条横幅里，而横幅只由
   * chatPage() 拼——只清 state 不重绘的话，屏幕上那句「连接断开」会一直挂着，人一边看
   * 着「断了」一边收到新回复。这一下只在「上次认输过、现在正接回来」时发生，罕见到
   * 值得为它付一次整页重绘（正打着字的人会丢焦点，见 paintChatCtx 上的注释）。
   */
  if (state.runtimeError === '连接断开') {
    state.runtimeError = ''
    // 同 noteStreamDown：人不在对话页上就没有可撤的横幅，别为它把这一页整块换掉。
    if (isChatPath(state.path)) render()
  }
  void startChatStream(sessionId, 0, owner)
  return true
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
/** 发信那张卡的抬头。信封比盾牌说得更准：这一张问的是「这封信发不发」。 */
const ICON_MAIL =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>'

/** 确认卡上那面盾。用盾不用感叹号：这是一道**边界**，不是一次故障。 */
const ICON_SHIELD =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.6-3 8.4-7 10-4-1.6-7-5.4-7-10V6z"/><path d="M9 12l2 2 4-4"/></svg>'
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

/**
 * 一条工具痕迹。
 *
 * **不再挂 title**：原生 tooltip 要等一秒才出、只能显示一行纯文本，而且会和下面那个
 * 悬浮窗同时冒出来。详情改由 sw-toolpop 给——参数和结果都在里面，那两样才是「它刚才
 * 到底干了什么」的答案，尤其是失败的那几颗，以前只能去导出记录里翻。
 *
 * 详情**不塞进 data-***：一次 bash 的参数加输出动辄几 KB，进属性要转义、要整份重复
 * 写进 DOM，而 chips 每次状态变化都重画一遍。改成 updateRow 把工具对象直接挂在节点上。
 */
function chipHtml(x, i) {
  const state_ = x.result == null ? 'running' : x.failed ? 'error' : 'done'
  const label = x.result == null ? t('调用中') : x.failed ? t('失败') : t('完成')
  return `<span class="sw-chip sw-toolchip" data-state="${state_}" data-i="${i}" tabindex="0">${ICON_TOOL}<span>${esc(x.name)} · ${esc(label)}</span></span>`
}

/**
 * 正文里被**行内代码**点了名的产出文件。
 *
 * 判据是 markdown 源码里出现 `` `路径` ``，而不是去渲染后的 DOM 里找。两个理由：
 * 一是它要参与 chips 那条的 sig（决定底下还摆哪几颗），必须在渲染之前就算得出来；
 * 二是源码里的反引号是模型明确写下的「这是个路径」，比事后按文本匹配可靠。
 *
 * **不做模糊匹配**：只认整段相等的完整路径。截一半的、拼在句子里的一律不动——
 * 那正是「拿正则扫散文猜路径」的老毛病，措辞一改就散架。
 */
function mentionedFiles(text, files) {
  const src = String(text == null ? '' : text)
  const set = new Set()
  for (const f of files || []) if (f && f.path && src.includes('`' + f.path + '`')) set.add(f.path)
  return set
}

/**
 * 把正文里那几段路径原地换成可以点开的药丸。
 *
 * 模型写出来的是 `uploads/s-0189cf21-787b-4c33-a4d4-c3daf292da34/Receipt-2095.md`
 * 这样一长串——占掉整行、看不出重点，而且不能点。换成药丸之后，「它生成了什么」
 * 就在说这句话的地方，不用再往下找。
 *
 * **跳过代码块里的**：那里面的路径是给人抄去执行的命令的一部分，换成按钮就抄不走了。
 */
function inlineFileChips(host, files) {
  const byPath = new Map((files || []).filter((f) => f && f.path).map((f) => [f.path, f]))
  if (!byPath.size) return
  for (const code of [...host.querySelectorAll('code')]) {
    if (code.closest('pre')) continue
    const hit = byPath.get(code.textContent.trim())
    if (!hit) continue
    const box = document.createElement('span')
    box.innerHTML = fileChipHtml(hit)
    const chip = box.firstElementChild
    if (!chip) continue
    chip.classList.add('sw-filechip-inline')
    code.replaceWith(chip)
  }
}

/** 药丸上那几个字。比卡片上那句话短——药丸要一眼扫过，长了就换行。 */
const APPROVAL_CHIP_LABEL = {
  approved: () => t('已批准', 'approved'),
  denied: () => t('已拒绝', 'denied'),
  timeout: () => t('超时未批', 'timed out'),
  aborted: () => t('已作废', 'voided'),
  expired: () => t('已失效', 'expired'),
}

/** 这条确认现在算哪一态。失效是界面自己判出来的（见 approvalDead），日志里没有。 */
function approvalState(a) {
  return approvalDead(a) ? 'expired' : a.state
}

/**
 * 有结论的确认，收成一颗药丸。
 *
 * **和工具痕迹用同一个类（sw-toolchip）**，为的是复用悬浮窗那一整套——触发、定位、
 * chips 重画之后把浮层接回新节点。多加一个 sw-approvalchip 只是为了让挂 `__tool`
 * 那两个循环分得开彼此，别把下标错位（见 updateRow）。
 *
 * 批准的用普通底色：那是常态，不该每条对话里都跳出来。没批准的走 error 那一档——
 * 它往往正是「它后来为什么没干成」的答案，翻记录时要找得到。
 */
function approvalChipHtml(a, i) {
  const state = approvalState(a)
  const label = (APPROVAL_CHIP_LABEL[state] || APPROVAL_CHIP_LABEL.denied)()
  const tone = state === 'approved' ? 'done' : 'error'
  const mail = a.form && a.form.kind === 'email'
  // 药丸上写**剥壳之后**那把工具的名字：`mcp_github_default_sw_run` 谁也看不出是什么。
  const name = (a.form && a.form.tool) || a.name
  const edited = (a.edited || []).length ? ' · ' + t('已改', 'edited') : ''
  return (
    `<span class="sw-chip sw-toolchip sw-approvalchip" data-state="${tone}" data-i="${i}" tabindex="0">` +
    `${mail ? ICON_MAIL : ICON_SHIELD}<span>${esc(name)} · ${esc(label)}${esc(edited)}</span></span>`
  )
}

/** 挂到药丸上给悬浮窗读的那份。`approval: true` 是分支标记，见 toolPopBody。 */
function approvalPop(a) {
  return {
    approval: true,
    name: (a.form && a.form.tool) || a.name,
    args: a.args,
    form: a.form || null,
    edited: a.edited || null,
    reason: a.reason,
    state: approvalState(a),
  }
}

/**
 * 卡片上改到一半的内容：`callId::key` → 当前值。
 *
 * **必须存在渲染之外。** 气泡会因为别的事重画（同一轮里又来了一条工具结果、另一条
 * 确认冒出来），而重画是 innerHTML 整体换掉——正在写的那段正文会跟着没。这张表在
 * 重画之后把值填回去，人写到哪儿还是哪儿。
 */
const approvalDrafts = new Map()

function draftKey(callId, key) {
  return callId + '::' + key
}

/** 这张卡现在这几格的值：人改过就用改过的，没改过就是模型起草的那份。 */
function approvalValue(a, field) {
  const draft = approvalDrafts.get(draftKey(a.callId, field.key))
  return draft === undefined ? field.value || '' : draft
}

/** 这张卡被人动过没有。动过就不许再点「这次对话都批准」，见下面按钮上的说明。 */
function approvalTouched(a) {
  const fields = (a.form && a.form.fields) || []
  return fields.some((f) => f.editable && approvalValue(a, f) !== (f.value || ''))
}

/** 卡片底下那排按钮。发信那张的第一个按钮说「批准并发送」——它就是要干这件事。 */
function approvalActs(a, okLabel) {
  const touched = approvalTouched(a)
  return (
    `<div class="sw-approval-acts">` +
    `<button type="button" class="btn btn-primary" data-act="chat-approve" data-call="${esc(a.callId)}" data-scope="once">${esc(okLabel)}</button>` +
    /**
     * **「这一轮」，不是「这次对话」。**
     *
     * 一个 Bot 一辈子只有一条会话（席位那边的 ensureSession 有就复用），所以按会话
     * 放行等于给出一张永久通行证——而人点它时想的是「我让它发三封信，别问我三遍」。
     * 范围收在这一轮里，下一句话重新问。按钮上的话要跟真实范围对得上，
     * 否则这颗按钮就是在替人做一个他没同意的决定。
     */
    `<button type="button" class="btn btn-secondary" data-act="chat-approve" data-call="${esc(a.callId)}" data-scope="turn"` +
    (touched
      ? // 改过的这一次不能顺带放行后面几次：后面那些带的是模型自己写的内容，不是人刚改的这份。
        ` disabled title="${esc(t('这一次改过内容，只能批准这一次', 'You edited this one, so it can only be approved once'))}"`
      : ` title="${esc(t('从你刚才那句话到它答完，这把工具不再问；下一句话会重新问。', 'Until this reply finishes, this tool won\'t ask again; your next message starts over.'))}"`) +
    `>${esc(t('这一轮都批准', 'Approve for this turn'))}</button>` +
    `<button type="button" class="btn btn-ghost" data-act="chat-deny" data-call="${esc(a.callId)}" data-scope="once">${esc(t('拒绝', 'Deny'))}</button>` +
    /**
     * 拒绝那一侧也配一颗带范围的，和批准那一对对称。
     *
     * 只有「拒绝」的话，模型下一步换个措辞再调一遍同样的东西，人得一次次点——而每一次
     * 都长得差不多。点这颗，这一轮里同一把工具直接挡掉，理由如实告诉模型「刚拒过」，
     * 让它去换做法，不是换措辞。
     *
     * **单独一颗，不做成「拒绝」的默认行为**：默认就挡的话，「拒绝 → 我跟它说改发给
     * 李总 → 它重发」这条最自然的路会被自己挡死（插话是插进同一轮的）。
     */
    `<button type="button" class="btn btn-ghost" data-act="chat-deny" data-call="${esc(a.callId)}" data-scope="turn"` +
    ` title="${esc(t('这一轮里同一把工具直接挡掉，不再问你；下一句话会重新开始。', 'Blocks this tool for the rest of this reply; your next message starts over.'))}"` +
    `>${esc(t('这一轮别再试', 'Block for this turn'))}</button>` +
    `</div>`
  )
}

/**
 * 发信那张卡。
 *
 * **为什么单独做一张**：通用卡把整份 JSON 摊出来，而人在批一封信的时候要看的是
 * 「发给谁、写了什么」，不是一段带转义符的 JSON。更要紧的是**得能改**——模型起草的
 * 正文十有八九要动一两句，只能「批准/拒绝」的话，人就得拒掉、再去跟它解释一遍，
 * 而它下一稿仍然是它写的。
 *
 * 改动最终落在**真正要执行的那份参数**上（见 policy/approvals.ts 的 decide），
 * 不是这儿改个样子。哪几格能改由席位说了算，这里只负责画和收。
 */
function approvalEmailHtml(a) {
  const fields = (a.form && a.form.fields) || []
  const rows = fields
    .map((f) => {
      const value = approvalValue(a, f)
      if (!f.editable) {
        // 只读的那几格（收件人、抄送、附件…）**照样摆出来**：藏起来的话，人以为自己
        // 看到了这封信的全部，而实际发出去的可能带着别的东西。
        return value
          ? `<div class="sw-mail-row"><span class="sw-mail-k">${esc(f.label)}</span><span class="sw-mail-v">${esc(value)}</span></div>`
          : ''
      }
      const attrs = `data-edit="${esc(f.key)}" data-call="${esc(a.callId)}"`
      return f.multiline
        ? `<div class="sw-mail-body"><span class="sw-mail-k">${esc(f.label)}</span>` +
            `<textarea class="input sw-mail-text" rows="8" ${attrs}>${esc(value)}</textarea></div>`
        : `<div class="sw-mail-row"><span class="sw-mail-k">${esc(f.label)}</span>` +
            `<input class="input sw-mail-input" type="text" value="${esc(value)}" ${attrs}></div>`
    })
    .join('')
  return (
    `<div class="sw-approval sw-approval-mail" data-state="pending" data-call="${esc(a.callId)}">` +
    `<div class="sw-approval-head">${ICON_MAIL}<span>${esc(t('这封邮件要发出去了', 'This email is about to be sent'))}</span></div>` +
    `<div class="sw-approval-why">${esc(t('可以直接改主题和正文，改完发出去的就是你现在看到的这一份。', 'Edit the subject or body if you like — what you see is what gets sent.'))}</div>` +
    `<div class="sw-mail">${rows}</div>` +
    `<div class="sw-approval-tool"><code>${esc((a.form && a.form.tool) || a.name)}</code></div>` +
    approvalActs(a, t('批准并发送', 'Approve and send')) +
    `</div>`
  )
}

/**
 * 一张确认卡。**只画还等着人点的那些**——有结论的收成药丸（approvalChipHtml）。
 *
 * 按席位给的 `form.kind` 分流：认得的走定制样式（发信那张），认不出的走下面这张通用卡。
 * **认不出不是理由把参数藏起来**——通用卡把整份 JSON 摆出来，人照样看得见自己在批什么。
 *
 * **参数要摆出来。** 「Bot 想调用 send_email，批准吗」这句话本身没有信息量——人要批的
 * 是「发给谁、写了什么」，看不到这些就只能凭信任点，那和没有这个开关是一样的。
 */
function approvalHtml(a) {
  if (a.form && a.form.kind === 'email' && (a.form.fields || []).length) return approvalEmailHtml(a)
  const args = prettyArgs(a.args)
  return (
    `<div class="sw-approval" data-state="pending" data-call="${esc(a.callId)}">` +
    `<div class="sw-approval-head">${ICON_SHIELD}<span>${esc(t('需要你确认', 'Needs your approval'))}</span></div>` +
    `<div class="sw-approval-why">${esc(a.reason)}</div>` +
    `<div class="sw-approval-tool"><code>${esc(a.name)}</code></div>` +
    (args ? `<pre class="sw-approval-args">${esc(clip(args))}</pre>` : '') +
    approvalActs(a, t('批准这一次', 'Approve once')) +
    `</div>`
  )
}

/** 一条消息的外壳。正文和工具条留空，交给 updateRow 填——它俩每帧都可能变。 */
function rowShell(b, key) {
  const account = (state.me && state.me.account) || {}
  const avatar = b.kind === 'user' ? esc(initialOf(account)) : ICON_BOT
  // 时间戳两侧一致，都挂在气泡外面（见 chat.css 里 .sw-time 的说明）。
  //
  // 内容留空，交给 updateRow：助手那条**还在输出时是读秒**、输出完了才换成时刻，
  // 而 rowShell 只在节点新建时跑一次，盯不住这个变化。
  const time = '<time class="sw-time" hidden></time>'
  return (
    `<div class="sw-msg" data-role="${b.kind}" data-key="${key}"${b.pending ? ' data-pending="1"' : ''}>` +
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

  /**
   * 这条消息 `@` 了谁。画在正文**上面**，和输入框里那排是同一种药丸——发出去前后
   * 长得一样，人才认得出这就是刚才点的那个。
   *
   * 和附件缩略图一条路子：签名没变就不重画，否则流式那几帧会把它反复换掉。
   */
  const ments = b.mentions || []
  const mentSig = ments.map((m) => m.label).join('|')
  let mentBox = bubble.querySelector('.sw-mentions-in')
  if (ments.length && !mentBox) {
    mentBox = document.createElement('div')
    mentBox.className = 'sw-mentions-in'
    bubble.insertBefore(mentBox, bubble.firstChild)
  }
  if (mentBox && mentBox.getAttribute('data-sig') !== mentSig) {
    mentBox.setAttribute('data-sig', mentSig)
    mentBox.innerHTML = ments.map((m) => `${mentionPill(m)}</span>`).join('')
    mentBox.hidden = !ments.length
  }

  const tools = b.tools || []
  // 产出文件 + 上传的附件。两边是同一种东西（工作区里一个能点开的文件），
  // 用同一种药丸，点开走同一个预览。
  const outs = outputFiles(tools).concat(b.files || [])
  // 正文里已经点了名的那些，就地换成药丸（见 inlineFileChips），底下那条就不再
  // 重复摆一遍——同一个文件在一条消息里出现两次是噪音，而且下面那颗离它被提到的
  // 那句话隔了好几行。
  const inlined = mentionedFiles(b.text, outs)

  if (!String(b.text || '').trim() && streaming) {
    // 还没吐字。给一个空气泡里的三点——它就地长成正文，位置不跳。
    if (!md.querySelector('.sw-typing')) md.innerHTML = '<span class="sw-typing"><i></i><i></i><i></i></span>'
  } else {
    if (md.querySelector('.sw-typing')) md.innerHTML = ''
    syncMd(md, b.text, streaming)
    if (inlined.size) inlineFileChips(md, outs)
  }

  /**
   * 确认卡分两拨：**还等着人点的摊开，已经有结论的收成一颗药丸。**
   *
   * 摊开是给「你要批的到底是什么」用的——参数看不见就只能凭信任点，那和没有这个开关
   * 一样。可人点完之后它就只是一条痕迹了，再占着半屏参数，往上翻这一轮的对话会被
   * 几张已经作废的卡片挡住。收起来之后和工具痕迹排在一起，详情走同一个悬浮窗。
   */
  const apps = b.approvals || []
  const waiting = apps.filter((a) => a.state === 'pending' && !approvalDead(a))
  const settled = apps.filter((a) => !waiting.includes(a))

  // 底下只留没被正文点过名的。
  const rest = outs.filter((f) => !inlined.has(f.path))
  const sig =
    tools.map((x) => x.name + (x.result == null ? '·' : x.failed ? '!' : '=')).join('|') +
    '#' +
    rest.map((f) => f.path).join('|') +
    '#' +
    settled.map((a) => a.callId + ':' + approvalState(a)).join('|')
  if (chips.getAttribute('data-sig') !== sig) {
    chips.setAttribute('data-sig', sig)
    chips.innerHTML =
      tools.map(chipHtml).join('') +
      rest.map(fileChipHtml).join('') +
      settled.map((a, i) => approvalChipHtml(a, tools.length + i)).join('')
    chips.hidden = !tools.length && !rest.length && !settled.length
    /**
     * 工具对象直接挂到节点上，悬浮窗按需取。
     *
     * **选择器要把确认那几颗排除掉**：它们也叫 sw-toolchip（为的是复用悬浮窗那一整套
     * 触发、定位、重接），混进来的话下标就错位了，鼠标停在一颗工具药丸上会弹出另一次
     * 调用的参数。产出文件那几颗是 sw-filechip，本来就不在这个选择器里。
     */
    const nodes = chips.querySelectorAll('.sw-toolchip:not(.sw-approvalchip)')
    for (let i = 0; i < nodes.length; i++) nodes[i].__tool = tools[i]
    // data-i 是「在这个容器的 .sw-toolchip 列表里排第几」，所以确认那几颗接在工具后面
    // 数（见 approvalChipHtml 的调用处）——refreshToolPop 靠它把浮层接回新节点。
    const apNodes = chips.querySelectorAll('.sw-approvalchip')
    for (let i = 0; i < apNodes.length; i++) apNodes[i].__tool = approvalPop(settled[i])
    // 这一批节点刚被换掉。开着的悬浮窗要么跟着换到新节点上，要么关掉——
    // 「调用中 → 完成」正好是人盯着它看的那一刻，不该在那时候闪没。
    refreshToolPop()
  }

  /**
   * 高风险确认卡。摆在工具药丸**底下**——它说的就是那颗还在转的药丸在等什么。
   *
   * 和别处一样按签名跳过重绘：不这么做的话，流式那几帧会把卡片连同上面的按钮一起
   * 换掉，人正要点的那一下就落空了。
   */
  let apbox = bubble.querySelector('.sw-approvals')
  if (waiting.length && !apbox) {
    apbox = document.createElement('div')
    apbox.className = 'sw-approvals'
    bubble.appendChild(apbox)
  }
  if (apbox) {
    const apSig = waiting.map((a) => a.callId).join('|')
    if (apbox.getAttribute('data-sig') !== apSig) {
      apbox.setAttribute('data-sig', apSig)
      apbox.innerHTML = waiting.map(approvalHtml).join('')
      apbox.hidden = !waiting.length
    }
  }
  paintRowTime(el, b, streaming)
}

/**
 * 气泡下面那一行时间。
 *
 * 还在输出时显示**读秒**，输出完了显示**收口的时刻**。
 *
 * 以前两种情况都显示「开始的时刻」，于是一轮跑了三分钟的对话，下面写着的是三分钟前
 * 那个数字，而且从头到尾一动不动——既看不出它在跑，也看不出它跑了多久。而人在等的
 * 时候最想知道的恰恰是「已经等了多久」。
 *
 * 只有助手那条读秒：status 是 'sending' 时（消息刚发出去、还没有回执）最后一条是
 * 用户自己那句，给它挂个秒表没有意义。
 */
function paintRowTime(el, b, streaming) {
  const node = el.querySelector('.sw-time')
  if (!node) return
  const running = Boolean(streaming) && b.kind === 'assistant' && Boolean(b.time)
  if (running) {
    node.hidden = false
    node.setAttribute('data-running', '1')
    node.setAttribute('data-since', String(b.time))
    node.removeAttribute('datetime')
    node.textContent = elapsedText(Date.now() - b.time)
    return
  }
  // endTime 是这一块最后一条事件的时间（turn/end 最准）。老会话没有它——那时候
  // 事件里也拿不出更好的答案，回落到开始时刻，和以前一个样，不会更差。
  const at = b.endTime || b.time
  node.removeAttribute('data-running')
  node.removeAttribute('data-since')
  if (!at) {
    node.hidden = true
    node.textContent = ''
    return
  }
  node.hidden = false
  node.setAttribute('datetime', new Date(at).toISOString())
  node.textContent = chatClock(at)
}

/** 读秒的文本。一分钟以内就是秒，超过了给 m:ss——纯秒数到了几百就读不出来了。 */
function elapsedText(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000))
  if (s < 60) return s + 's'
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}

/**
 * 读秒的心跳。
 *
 * 只在**屏幕上真有**一个读秒中的时间戳时才转，转完自己停——挂一个长明的
 * setInterval 在这种页面上是白烧电，标签页在后台时尤其。
 */
let clockTimer = null
function tickClocks() {
  const nodes = document.querySelectorAll('.sw-time[data-running]')
  if (!nodes.length) {
    clearInterval(clockTimer)
    clockTimer = null
    return
  }
  for (const n of nodes) {
    const since = Number(n.getAttribute('data-since')) || 0
    if (since) n.textContent = elapsedText(Date.now() - since)
  }
}

function ensureClockTick() {
  const has = document.querySelector('.sw-time[data-running]')
  if (has && !clockTimer) clockTimer = setInterval(tickClocks, 1000)
  else if (!has && clockTimer) {
    clearInterval(clockTimer)
    clockTimer = null
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
    const owner = botIdOfSession(sessionId)
    const list = owner ? botStreamOf(owner).events : state.chatEvents
    // 和 hydrateChat 一个判据：只收比手上最靠前那条还早的。正常情况下 before=firstSeq
    // 已经保证了这一点，这里挡的是两条路撞在一起的那几次（补历史和翻页同时在跑）。
    const head = list.length ? Number(list[0].seq) : Infinity
    const older = ((data && data.events) || []).filter((ev) => Number(ev.seq) < head)
    if (older.length) {
      const thread = document.getElementById('chat-thread')
      chatAnchorHeight = thread ? thread.scrollHeight : 0
      list.unshift(...older)
    }
    // 走 noteChatPage 而不是直接 set：这一页也可能比手上知道的窄——等这一跳的工夫
    // hydrateChat 落了地，它那二十轮盖过了这里的一页，游标就不该再退回来。
    // loading 归零由这里说了算，翻页这件事从头到尾只有它一个人管。
    noteChatPage(sessionId, { firstSeq: data && data.firstSeq, hasMore: data && data.hasMore, loading: false })
  } catch (err) {
    // 翻不动就把「加载更多」放回去，别把这一段历史永久锁死。**读最新的那份**：
    // page 是发请求之前的快照，照它写回去会把这期间 hydrateChat 记下的游标抹掉。
    noteChatPage(sessionId, { loading: false })
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

/**
 * 本地回显。**发出去的那一刻就画上，不等流把它送回来。**
 *
 * 消息流是单向的：POST 出去，等席位那边把 `user/message` 事件经 SSE 回传，界面才画。
 * Bot 一忙，这中间就是几秒到几十秒的**纯空白**——输入框清空了，屏幕上什么都没多，人
 * 完全看不出自己那一下有没有生效，只好再按一次。
 *
 * 回执一到就撤掉本地这条，换成流里的真货（它带 seq 和服务端时间）。
 *
 * **只认「发出去之后」的那些**：拿 afterSeq 卡住。不卡的话，历史里任何一条同样文字的
 * 消息都会把它抵消掉——发第二遍「好的」时，本地这条会在流还没回来时就凭空消失。
 */
function mergePending(folded, sessionId) {
  const all = state.chatPending || []
  const mine = all.filter((p) => p.sessionId === sessionId)
  if (!mine.length) return folded
  const fresh = folded.blocks.filter((b) => b.kind === 'user' && b.seq != null)
  const left = []
  for (const p of mine) {
    // 比的是 raw（拼好的完整正文），不是显示用的 text——后者已经把附件那段拆走了。
    const hit = fresh.findIndex((b) => b.seq > p.afterSeq && (b.raw != null ? b.raw : b.text) === p.text)
    if (hit >= 0) fresh.splice(hit, 1)
    else left.push(p)
  }
  if (left.length !== mine.length) {
    state.chatPending = all.filter((p) => p.sessionId !== sessionId || left.includes(p))
  }
  if (!left.length) return folded
  for (const p of left) {
    // 回执还没回来的那几秒也要长成最终的样子，否则附件会先以一行路径文本出现、
    // 再突然变成药丸——同一条消息在屏幕上跳两次。
    const up = splitUploads(p.text)
    folded.blocks.push({
      kind: 'user',
      text: up.text,
      files: up.files,
      raw: p.text,
      images: p.images || [],
      mentions: p.mentions || [],
      time: p.at,
      pending: true,
    })
  }
  // 没回执之前也要有「正在想」：那一行是人按下回车之后唯一的进度反馈。
  if (!folded.status) folded.status = 'sending'
  return folded
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
  const folded = mergePending(fold(state.chatEvents, chatLive.get(state.chatSessionId)), state.chatSessionId)
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
  ensureClockTick()
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
  // 会话还没拿到（席位刚起来那几十秒）就直说。这一行是人在按发送之前唯一会看的地
  // 方，而那期间按下去是发不出去的——不说的话就是「点了没反应」。
  if (tip) {
    tip.textContent = !state.chatSessionId
      ? sessionGaveUp
        ? t('实例还没接上，这会儿发不出去')
        : t('实例还在上线，接上之后就能发消息…')
      : busy
        ? t('正在思考…（可以继续输入来打断）')
        : t('Enter 发送，Shift + Enter 换行')
  }
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
/**
 * 这个 Bot 的席位走到哪一步了：`unbound` / `none` / `deploying` / `error` / `ready`。
 *
 * 抽出来是因为有两处要看它——对话正文中间那块「去部署」，和右栏。两处各判一次的话，
 * 迟早出现「中间说没部署、右栏说在线」这种自相矛盾的画面。
 */
function seatStage() {
  if (!(state.runtimeMachine && state.runtimeMachine.paired)) return 'unbound'
  const mine = state.desktopRuntime
  if (!mine || mine.status === 'none') return 'none'
  if (mine.status === 'error' || mine.status === 'deploying') return mine.status
  return mine.status === 'ready' ? 'ready' : 'none'
}

/**
 * 席位没上线时，**把话说在正文中间**，而不是只摆在右栏里。
 *
 * 原先这套提示只有右栏一份：而右栏可以收起（默认也常常是收起的），于是人看到的是一
 * 片空白的对话，外加一个能打字、发出去却没有任何反应的输入框——最需要指路的那一刻，
 * 屏幕正中什么也没说。
 *
 * 输入框在这个状态下整个不渲染。留着它就是留一个「看着能用、按了没用」的东西，比没有
 * 更糟。
 */
function chatDeployPrompt(botId) {
  const stage = seatStage()
  if (stage === 'ready') return ''
  const name = (chatBotOf() || {}).name || t('这个 Bot')
  let title = ''
  let body = ''
  let action = ''
  if (stage === 'unbound') {
    title = t('公司的运行机器还没配好')
    body = t('公司的运行机器还没有配对机器管家，请系统管理员在公司详情里生成配对码。')
  } else if (stage === 'deploying') {
    title = t('正在部署…')
    body = t('机器那边正在装这个席位，通常一两分钟。装好之后这里会自己变成对话。')
  } else if (stage === 'error') {
    title = t('上一次部署没成功')
    body = (state.desktopRuntime && state.desktopRuntime.lastError) || t('部署失败')
    action = deployBotButton(botId, t('重新部署'))
  } else {
    title = t('%s 还没有部署').replace('%s', name)
    body = t('部署之后它才有自己的机器和桌面，也才收得到消息。这一步要几分钟。')
    action = deployBotButton(botId)
  }
  const hint = state.deployHint ? `<p class="sw-nodeploy-hint">${esc(state.deployHint)}</p>` : ''
  return `<div class="gw-chat-empty-main"><div class="sw-nodeploy">
    <span class="sw-nodeploy-icon">${svg(MONITOR, 26)}</span>
    <h2>${esc(title)}</h2>
    <p>${esc(body)}</p>
    ${action}${hint}
  </div></div>`
}

function chatMachinePanel() {
  const selected = chatBotIdOf(state.path) || state.chatBotId
  if (!selected) return ''
  const mine = state.desktopRuntime
  const stage = seatStage()
  const rows = []

  // 没上线时右栏只报状态，**不再摆第二颗部署按钮**——那句话和那颗按钮现在在正文
  // 中间，同一块屏幕上放两个一模一样的主操作，只会让人先分辨该点哪一个。
  if (stage === 'unbound') {
    rows.push(
      `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground); line-height: 1.6;">${t('公司的运行机器还没有配对机器管家，请系统管理员在公司详情里生成配对码。')}</p>`,
    )
  } else if (stage === 'none') {
    rows.push(`<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('实例还没上线')}</p>`)
  } else if (stage === 'error') {
    rows.push(`<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(mine.lastError || t('部署失败'))}</div>`)
  } else if (stage === 'deploying') {
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
      // 嵌不了的时候退回原来那颗按钮——新标签页是顶层导航，没有 iframe 那些限制。
      rows.push(
        `<a class="btn btn-primary" href="${esc(mine.novncUrl)}" target="_blank" rel="noopener noreferrer" style="text-align: center;">${t('打开桌面')}</a>`,
      )
    }
    /**
     * **右栏到这儿就结束了。**
     *
     * 这里原先还挂着一个「席位详情」折叠面板：共享目录、linuxUser、Bot 版本，以及
     * 「运行日志」「重新部署」两个入口。它们都是「出事那天」才用一次的东西，而这一
     * 栏每天要看的只有上面那块屏——多一个可展开的标题，就多一次「这里面是什么」的
     * 分神。
     *
     * **日志和重铺跟着一起下线了，这是有代价的**：员工手上暂时没有自助重铺的入口，
     * 席位坏了要找管理员。要把它们放回来的话，位置应该是桌面全屏时那条标题栏——出问
     * 题的是那块屏，人当时也正看着它。
     */
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
 * 桌面地址现在是 Gateway 同域的一条相对路径（`/desktop/:seatId/`），所以这条基本不
 * 会再触发。留着是因为它挡的那个失败**没有声音**：页面是 https、地址是 http 的时候，
 * iframe 被浏览器按混合内容拦掉，什么都不显示，控制台以外看不出所以然。真有哪天地址
 * 又变回绝对的，这里退回按钮，比留一块黑屏强。
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
  /**
   * 那条聊天流也要认一遍。
   *
   * 后台标签页里 setTimeout 会被节流到分钟级，退避重试因此更容易走到头；而合盖一小时
   * 回来，中间那一跳早把连接掐了。回到前台是「人马上要看这一屏」的时刻，没人在听就
   * 当场接回来——带 after 游标，睡着那段时间的回复会一起补上。
   */
  if (state.chatSessionId) reviveChatStream(state.chatSessionId, state.chatBotId)
  // 会话本身都还没拿到（那条重试链在后台被节流着走完了、认输了）：也在这儿再试一次。
  // 不然人回到这一页看到的是一句「实例还没接上」，而没有任何人在替他重试。
  //
  // **只在对话页上做。** state.chatBotId 在人走开之后仍然留着（切走不掐流，见
  // ensureChatSession），拿它在别的页上重试的话：白敲一串接口不说，那条链认输时会
  // render() 整页——正在填的表单当场被换掉，而起因是一个他此刻根本没在看的 Bot。
  else if (state.chatBotId && isChatPath(state.path)) void ensureChatSession(state.chatBotId).catch(() => {})
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
/**
 * 文本类的扩展名。这几种取回来直接当文字看，比塞进 iframe 强——iframe 里的纯文本
 * 不会换行、没有主题色、也没法选中复制成一段。
 */
const PREVIEW_TEXT_EXT = new Set([
  'txt', 'log', 'csv', 'tsv', 'json', 'yml', 'yaml', 'xml', 'ini', 'toml', 'conf',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'sh', 'bash', 'zsh', 'py',
  'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sql', 'env', 'gitignore', 'diff', 'patch',
])

/** 这几种在浏览器里没有原生渲染，得靠席位那边先提取成文本（见 fetchDocText）。 */
const PREVIEW_DOC_EXT = new Set(['docx', 'xlsx', 'xlsm', 'pptx'])

function extOf(name) {
  const base = String(name || '').split('/').pop() || ''
  const i = base.lastIndexOf('.')
  return i > 0 ? base.slice(i + 1).toLowerCase() : ''
}

/**
 * 这个文件用哪种方式看。
 *
 * **按扩展名判，不按 content-type**：席位那边对不在内联白名单里的一律回
 * `application/octet-stream`（HTML、docx 都是），光看类型什么都分不出来。
 */
function previewKindOf(name, type) {
  const ext = extOf(name)
  if (String(type || '').startsWith('image/') || ['png','jpg','jpeg','gif','webp','avif','bmp','ico','svg'].includes(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'html' || ext === 'htm') return 'html'
  if (PREVIEW_TEXT_EXT.has(ext)) return 'text'
  if (PREVIEW_DOC_EXT.has(ext)) return 'doc'
  return ''
}

/** 文本类不该按图片那个尺度收：一份 2MB 的日志已经没人会在弹窗里读了。 */
const PREVIEW_TEXT_MAX = 2 * 1024 * 1024

async function openPreview(path, name) {
  if (!state.chatSessionId) return
  revokePreview()
  const kind = previewKindOf(name || path, '')
  state.preview = { path, name, loading: true, url: '', type: '', size: 0, error: '', kind, mode: 'view' }
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
    const k = kind || previewKindOf(name || path, type)
    const cap = k === 'markdown' || k === 'html' || k === 'text' ? PREVIEW_TEXT_MAX : CHAT_PREVIEW_MAX
    /**
     * **不再拿 content-disposition 当「能不能看」的判据。**
     *
     * 席位那张白名单回答的是「这段字节能不能带着自己的 MIME 在浏览器里跑起来」——
     * HTML 不在里面，理由是它带得动 `<script>`，内联渲染等于让上传者在 Gateway 的源
     * 上执行代码。那个理由是对的，白名单不动。
     *
     * 但**我们并不是让它在 Gateway 的源上跑**：字节取回来变成 blob，塞进一个
     * `sandbox` 不带任何 allow-* 的 iframe——脚本、表单、同源、导航全关，里面的
     * `<script>` 一行都不会执行。Gateway 那一跳还压了一条同样含义的 CSP
     * （见 lib/runtime.ts 的 proxyDownload），直接把文件地址粘到地址栏也一样跑不起来。
     *
     * 所以这里改成按**扩展名**决定看法，只有真的没法看的（未知格式）才回落到下载。
     */
    if (!k || (size && size > cap)) {
      ac.abort()
      if (!state.preview || state.preview.path !== path) return
      state.preview = { path, name, loading: false, url: '', type, size, error: '', kind: k, mode: 'view', tooBig: true }
      render()
      return
    }
    if (k === 'doc') {
      const blob = await res.blob()
      if (!state.preview || state.preview.path !== path) return
      state.preview = { path, name, loading: false, url: '', type, size: blob.size, error: '', kind: k, mode: 'view', docLoading: true }
      render()
      void fetchDocText(path, name)
      return
    }
    const blob = await res.blob()
    if (!state.preview || state.preview.path !== path) return
    const next = { path, name, loading: false, url: '', type, size: blob.size, error: '', kind: k, mode: 'view' }
    if (k === 'markdown' || k === 'html' || k === 'text') {
      next.text = await blob.text()
      // HTML 要一个**自称 text/html** 的 blob，iframe 才会当页面渲染。原始响应是
      // octet-stream（白名单没放行它），照搬只会得到一个下载。重打类型是安全的：
      // 保护来自 iframe 的 sandbox，不来自这个 MIME。
      // **charset 不能省。** 这个 blob 是从 JS 字符串造的，就是 UTF-8；不写的话浏览器
      // 会按自己的默认编码猜，中文当场变成一片乱码（实测就是这样）。
      if (k === 'html') next.url = URL.createObjectURL(new Blob([next.text], { type: 'text/html; charset=utf-8' }))
    } else if (k === 'pdf') {
      // **类型钉死。** 下面那个 iframe 不带 sandbox（不带才有 PDF 阅读器，见
      // previewBody），所以绝不能让这段字节有机会被当成 HTML 解释。blob 的 type
      // 就是浏览器认的 Content-Type：写死 application/pdf，一个改名成 .pdf 的
      // HTML 只会交给 PDF 阅读器然后解析失败，而不是变成一个页面跑起来。
      next.url = URL.createObjectURL(new Blob([await blob.arrayBuffer()], { type: 'application/pdf' }))
    } else {
      next.url = URL.createObjectURL(blob)
    }
    state.preview = next
  } catch (err) {
    if (ac.signal.aborted) return
    if (!state.preview || state.preview.path !== path) return
    state.preview = { path, name, loading: false, url: '', type: '', size: 0, error: err.message, kind, mode: 'view' }
  }
  render()
  // 刚画出来的 Markdown 里可能有代码块 / 公式 / mermaid，和聊天气泡一样要过一遍。
  if (state.preview && state.preview.kind === 'markdown' && window.satuMd) {
    const host = document.querySelector('.sw-preview-md')
    if (host) window.satuMd.enhance(host)
  }
}

/**
 * Word / Excel / PPT：浏览器打不开，让席位提取成 Markdown 再看。
 *
 * 走的是 `read` 工具用的同一套提取（bot 的 workspace/extract.ts），所以这里看到的
 * 和模型读到的是同一份东西——这一点本身就有用：内容对不上时能一眼看出是提取的问题
 * 还是模型的问题。
 *
 * **老席位没有这个接口**，那时候如实退回「下载下来看吧」，而不是转个圈就空在那儿。
 */
async function fetchDocText(path, name) {
  const url =
    '/runtime/sessions/' + encodeURIComponent(state.chatSessionId) + '/files?path=' + encodeURIComponent(path) + '&as=text'
  try {
    const res = await fetch(url, { headers: authHeaders({ accept: 'application/json' }) })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const data = await res.json()
    if (!state.preview || state.preview.path !== path) return
    state.preview.docLoading = false
    state.preview.text = String((data && data.text) || '')
    state.preview.docNote = String((data && data.note) || '')
    if (!state.preview.text) state.preview.tooBig = true
  } catch {
    if (!state.preview || state.preview.path !== path) return
    state.preview.docLoading = false
    state.preview.tooBig = true
    state.preview.docNote = t('这个席位还不支持把 Office 文档提取出来预览（要更新 Bot 版本）。')
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

/** 渲染视图和原文之间的切换。只有两者都成立的类型才给，别摆一颗按不动的按钮。 */
function previewTabs(p) {
  const both = (p.kind === 'markdown' || p.kind === 'html') && !p.tooBig && !p.error && !p.loading
  if (!both) return ''
  const tab = (mode, label) =>
    `<button type="button" class="sw-preview-tab" data-act="preview-mode" data-mode="${mode}"` +
    `${p.mode === mode ? ' data-on="1"' : ''}>${esc(label)}</button>`
  return `<div class="sw-preview-tabs">${tab('view', t('预览'))}${tab('source', t('原文'))}</div>`
}

/**
 * 内容自己加载完之前先转圈。
 *
 * 取字节那一段有 p.loading 管，但**字节到手不等于看得见**：iframe 里的 PDF 阅读器、
 * 大图的解码，都还要一会儿，而那段时间框里是纯白的——和「坏了」长得一模一样。
 *
 * 清除用内联 onload：它随 HTML 字符串走，每次整页重绘都自动带上。挂 JS 监听的话，
 * 任何一次无关的 render() 都会把节点换掉、监听丢掉，圈就永远转下去。
 */
const DONE_JS = "this.parentNode.removeAttribute('data-busy')"

function busyBox(inner) {
  return `<div class="sw-preview-load" data-busy="1"><span class="sw-preview-spin" aria-hidden="true"></span>${inner}</div>`
}

function spinNote(text) {
  return `<p class="sw-preview-note"><span class="sw-preview-spin" aria-hidden="true"></span>${esc(text)}</p>`
}

function previewBody(p) {
  if (p.loading) return spinNote(t('正在取文件…'))
  if (p.error) return `<p class="sw-preview-note sw-preview-err">${esc(p.error)}</p>`
  if (p.docLoading) return spinNote(t('正在提取文档内容…'))
  if (p.tooBig) {
    const why = p.docNote || t('这个文件不适合在浏览器里打开（太大，或者是不认识的格式）。下载下来看吧。')
    return `<p class="sw-preview-note">${esc(why)}</p>`
  }
  if (p.kind === 'image') {
    return busyBox(
      `<img class="sw-preview-img" src="${esc(p.url)}" alt="${esc(p.name)}" ` +
        `onload="${DONE_JS}" onerror="${DONE_JS}">`,
    )
  }
  if (p.kind === 'pdf') {
    /**
     * PDF 交给浏览器自带的阅读器，**这个 iframe 不能带 sandbox**。
     *
     * 带上就是一片白：sandbox 的 opaque origin 会把 PDF 阅读器整个挡掉，页面根本
     * 起不来。这不是新问题，之前一直是这么写的——只是没人点过 PDF。实测对照过
     * `sandbox=""` / 无 sandbox / `<embed>` 三种，只有不带 sandbox 的那两种能起阅读器。
     *
     * 去掉它安全吗：安全，因为**类型是钉死的**。上面 openPreview 把这段字节重新包成
     * 了 `application/pdf` 的 blob，浏览器只会把它交给 PDF 阅读器，没有任何路径能让它
     * 被当成 HTML 解释——而 sandbox 在这里防的正是「HTML 跑起脚本」。
     */
    return busyBox(`<iframe class="sw-preview-frame" src="${esc(p.url)}" title="${esc(p.name)}" onload="${DONE_JS}"></iframe>`)
  }
  if (p.kind === 'html' && p.mode === 'view') {
    /**
     * **`sandbox` 一个 allow-* 都不能加。** 这是让 HTML 能被预览的全部依据：没有
     * allow-scripts 就没有脚本执行，没有 allow-same-origin 就是 opaque origin，
     * 拿不到 Gateway 这一侧的任何东西。加任何一项都会把这条推翻。
     *
     * 和上面 PDF 那条的差别就在这里：HTML **要**当页面跑，所以必须锁死；PDF 不当
     * 页面跑，锁死反而只剩一片白。
     */
    return busyBox(
      `<iframe class="sw-preview-frame" src="${esc(p.url)}" sandbox title="${esc(p.name)}" onload="${DONE_JS}"></iframe>`,
    )
  }
  if (p.kind === 'markdown' && p.mode === 'view') {
    // satuMd 对原始 HTML 一律转义、链接只放行白名单协议（见 markdown.js 开头第 3 条），
    // 所以这段 innerHTML 是安全的——和聊天气泡里渲染模型输出走的是同一条路。
    const md = window.satuMd
    const html = md ? md.render(String(p.text || '')) : ''
    if (md) return `<div class="sw-preview-md sw-md">${html}</div>`
  }
  // 其余一律看原文：Markdown/HTML 的「原文」页、纯文本、以及提取出来的 Office 文档。
  return `<pre class="sw-preview-src">${esc(String(p.text || ''))}</pre>`
}

function previewModal() {
  const p = state.preview
  if (!p) return ''
  const meta = p.size ? fileSize(p.size) : ''
  return `<div class="gw-modal-backdrop" data-act="preview-close">
    <div class="gw-modal sw-preview" data-stop>
      <div class="sw-preview-head">
        <div style="min-width: 0;">
          <h2>${esc(p.name)}</h2>
          <p><code>${esc(p.path)}</code>${meta ? ' · ' + esc(meta) : ''}</p>
        </div>
        <div class="sw-preview-acts">
          ${previewTabs(p)}
          <button type="button" class="btn" data-act="preview-download" data-path="${esc(p.path)}" data-name="${esc(p.name)}">${t('下载')}</button>
          <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="preview-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
        </div>
      </div>
      <div class="sw-preview-body" data-flow="${p.error || p.loading || p.docLoading || p.tooBig || p.kind === 'image' ? 'center' : 'top'}">${previewBody(p)}</div>
    </div>
  </div>`
}

/** 切「预览 / 原文」。只改一个字段，字节早就在手上了，不用再取一次。 */
function setPreviewMode(mode) {
  if (!state.preview || state.preview.mode === mode) return
  state.preview.mode = mode === 'source' ? 'source' : 'view'
  render()
  // 渲染出来的 Markdown 里可能有代码块、公式、mermaid——和聊天气泡一样要 enhance 一次，
  // 否则代码不高亮、公式显示 TeX 原文。
  if (state.preview.mode === 'view' && window.satuMd) {
    const host = document.querySelector('.sw-preview-md')
    if (host) window.satuMd.enhance(host)
  }
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
  // 这一栏里的话是我们自己写进 state 的中文常量（见 startChatStream / retryChatSession），
  // 过一遍译表才能跟着界面语言走；查不到的原样回来，不会变成空白。
  //
  // 「连接断开」那一句要**能点**：它是退避认输留下的，而认输之后没有任何东西会再去
  // 重连。原话让人去刷新整页——那会连草稿和还没发出去的附件一起丢掉，而真正要做的
  // 只是重开一条流。
  const retry =
    err === '连接断开'
      ? ` <button type="button" class="btn btn-ghost" style="margin-left: var(--space-2); height: 24px; padding: 0 8px; font-size: 12px;" data-act="chat-reconnect">${t('重新连接')}</button>`
      : ''
  return `<div class="gw-flash gw-flash-err">${esc(t(err))}${retry}</div>`
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
          ${/* 自己建的那种才给设置入口：别人的、全局的，这一页上没有可改的东西。 */ ''}
          ${isMyBot(bot) ? `<button type="button" class="satu-menuitem" data-act="go" data-href="/bots/${esc(bot.id)}">${t('Bot 设置')}</button>` : ''}
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
  /**
   * **flashes() 这一页以前没有。**
   *
   * flash() 写的是 state.error / state.notice，而这一页从头到尾只画 runtimeDownBanner
   * ——于是 chat.js 里那一串 flash 全是哑的：附件没传上去、这条消息没发出去、几个 `@`
   * 已经失效、「已中止，正在跑的那个工具要等它自己收尾」，一句都到不了屏幕上。人看到
   * 的就是「点了没反应」，而代码里明明写着话。别的页早就都拼了这一句（见各 pages-*.js）。
   * 导航时 go() 会清掉这两格，不会把上一页的红字带过来。
   */
  const banner = flashes() + runtimeDownBanner()
  if (!selected) {
    return `<div class="gw-chat"><section class="gw-chat-main">${banner}
      <div class="gw-chat-empty-main"><p>${bots.length ? t('从左边选一个 Bot 开始对话。') : t('还没有 Bot。点左下角「新建 Bot」建一个，它会用公司的 Bot 模版当底座。', 'No bots yet. Use “New bot” at the bottom left — it will run on your company template.')}</p></div>
    </section></div>`
  }
  // 席位没上线：正文换成一块「去部署」，连输入框一起不渲染（见 chatDeployPrompt）。
  const nodeploy = chatDeployPrompt(selected)
  if (nodeploy) {
    return `<div class="gw-chat"><section class="gw-chat-main">${banner}${nodeploy}</section></div>`
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
          <div class="sw-queue" id="chat-queue" hidden></div>
          <form id="chat-form" class="sw-composer-box">
            <div class="sw-pickbox" id="chat-mentionpick" hidden></div>
            <div class="sw-files" id="chat-mentions" hidden></div>
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

/**
 * 排队 dock：输入框顶上那一行小字。
 *
 * **一条一行，纯文字，不展开附件**——图片不出缩略图，`@` 出来的药丸也不画。它是
 * 「等会儿要说的话」的一个提醒，不是消息气泡的预演；把气泡那一套搬上去，输入框会被
 * 顶掉半屏。多条就多行，最多画 3 行，再多第一行变成「还有 N 条」。
 */
function paintChatQueue() {
  const box = document.getElementById('chat-queue')
  if (!box) return
  const rows = chatQueues.get(state.chatSessionId) || []
  box.hidden = !rows.length
  if (!rows.length) {
    box.innerHTML = ''
    return
  }
  const shown = rows.slice(-3)
  const hidden = rows.length - shown.length
  box.innerHTML =
    (hidden ? `<div class="sw-queue-more">${esc(t(`还有 ${hidden} 条`))}</div>` : '') +
    shown
      .map((r) => {
        const line = (r.text || '').replace(/\s+/g, ' ').trim() || t('（只有附件）')
        return `<div class="sw-queue-row">
          <span class="sw-queue-dot" aria-hidden="true"></span>
          <span class="sw-queue-text">${esc(line)}</span>
          <button type="button" class="sw-file-x" data-act="chat-queue-cancel" data-id="${esc(r.id)}"
            aria-label="${esc(t('取消'))}">${ICON_X}</button>
        </div>`
      })
      .join('')
}

/**
 * 已经选中的 `@`：输入框上方那排药丸。
 *
 * 和 dock 不是一回事——这排是**这一条还没发出去的**消息带着谁，dock 是**已经发出去、
 * 排着队**的那几条。
 */
function paintChatMentions() {
  const box = document.getElementById('chat-mentions')
  if (!box) return
  const picked = state.chatMentions || []
  box.hidden = !picked.length
  box.innerHTML = picked
    .map(
      (m, i) => `${mentionPill(m)}
        <button type="button" class="sw-file-x" data-act="chat-mention-drop" data-i="${i}"
          aria-label="${esc(t('移除'))} ${esc(m.label)}">${ICON_X}</button>
      </span>`,
    )
    .join('')
}

/** `@` 选单。候选来自 /mentions（现在只有连接器；Bot 和 Routine 以后往里加）。 */
function paintMentionPick() {
  const box = document.getElementById('chat-mentionpick')
  if (!box) return
  const pick = state.mentionPick
  if (!pick || !pick.open) {
    box.hidden = true
    box.innerHTML = ''
    return
  }
  const q = (pick.q || '').toLowerCase()
  const taken = new Set((state.chatMentions || []).map((m) => m.id))
  const list = (state.mentionOptions || [])
    .filter((m) => !taken.has(m.id))
    .filter((m) => !q || m.label.toLowerCase().includes(q) || (m.toolkit || '').includes(q))
    .slice(0, 8)
  box.hidden = false
  box.innerHTML = list.length
    ? list
        .map(
          (m, i) => `<button type="button" class="sw-pick${i === (pick.index || 0) ? ' is-on' : ''}"
        data-act="chat-mention-pick" data-id="${esc(m.id)}">
        ${m.logo ? `<img class="sw-pick-logo" src="${esc(m.logo)}" alt="" onerror="this.remove()">` : ''}
        <span>${esc(m.label)}</span>
        ${m.mentionOnly ? `<small>${esc(t('仅 @ 时可用'))}</small>` : ''}
      </button>`,
        )
        .join('')
    : `<div class="sw-pick-empty">${esc(t('没有可用的连接。去「连接器」装一个再连上。'))}</div>`
}

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
  const mentions = state.chatMentions || []
  const sessionId = state.chatSessionId
  if ((!text && !files.length && !mentions.length) || state.chatUploading) return
  /**
   * **没有会话不能一声不吭地咽下去。** 席位刚部署完的那几十秒里 chatSessionId 就是空
   * 的（见 ensureChatSession），而这里原先和「草稿是空的」共用一句 `return`：字打得
   * 进去，点发送什么都不发生，一个字的解释也没有——刷新一下页面又好了，因为那会重
   * 新拿一次会话。
   *
   * 现在说清楚，并且当场催一次（ensureChatSession 自己会退避重来）。**不 await**：
   * 那一跳最长十几秒，等它回来再发的话，这期间人多半已经又按了一次回车——两次都停在
   * 同一个 await 上，会话一到就把同一条话发两遍。
   */
  if (!sessionId) {
    const botId = state.chatBotId || chatBotIdOf(state.path)
    if (botId) void ensureChatSession(botId).catch(() => {})
    flash('err', t('实例还在上线，这条还发不出去；等它接上再发'))
    render()
    return
  }
  /**
   * **发之前先确认还有人在听。**
   *
   * 回答是经 SSE 回来的，而这条消息走的是另一条请求——两者互不相干，流断着照样发得
   * 出去、bot 照样跑完。屏幕上于是挂着一句「正在思考」，日志里那一轮明明已经
   * completed，只能刷新（刷新管用，正是因为它重开了一条流）。换版那几分钟里退避真
   * 认过一次输，那之后每一条消息都会落进这个坑。
   *
   * 不 await：重连带 after 游标，错过的会补回来，没必要让人多等一个 RTT。
   */
  reviveChatStream(sessionId, state.chatBotId)

  state.chatDraft = ''
  state.chatMentions = []
  closeMentionPick()
  paintChatMentions()
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
      // 传失败就把草稿、附件和点名原样还回去，别让人重新选一遍文件、重新 @ 一遍。
      state.chatUploading = false
      state.chatDraft = text
      state.chatMentions = mentions
      paintChatFiles()
      paintChatMentions()
      flash('err', t('附件没传上去：') + err.message)
      render()
      return
    }
    state.chatUploading = false
  }
  state.chatFiles = []
  paintChatFiles()

  const images = pickImages(uploaded)
  const body = composeChatBody(uploaded, text)
  /**
   * 先画上，再发。**这一条是给人看的回执**：POST 出去到席位把 user/message 经 SSE 送
   * 回来，中间少则几百毫秒、多则几十秒（bot 在忙的时候），原先那段时间屏幕上什么也
   * 没有，人只能再按一次回车。
   *
   * afterSeq 记住「此刻流走到哪儿了」，回执认领时只认它之后的——见 mergePending。
   */
  const afterSeq = (state.chatEvents || []).reduce((m, ev) => (ev.seq > m ? ev.seq : m), -1)
  // mentions 也带上：回执那几秒里那条消息要长成最终的样子，否则药丸会先没有、
  // 等席位把事件送回来才突然冒出来——同一条消息在屏幕上跳两次。
  const pending = { sessionId, text: body, images, mentions, at: Date.now(), afterSeq }
  state.chatPending = (state.chatPending || []).concat(pending)
  paintChat()
  try {
    const r = await api('POST', '/runtime/sessions/' + encodeURIComponent(sessionId) + '/messages', {
      text: body,
      ...(images.length ? { images } : {}),
      ...(mentions.length ? { mentions: mentions.map((m) => ({ kind: m.kind, id: m.id, label: m.label })) } : {}),
    })
    /**
     * 排队了：把刚画上的那条气泡撤掉，改画成输入框顶上的一行。
     *
     * 席位那边紧接着会经 SSE 推一次 `queue/change`，这里先自己填一行是为了「点了发送
     * 立刻有反应」——那一跳来回几百毫秒，中间屏幕上什么都没有的话，人会再按一次。
     */
    if (r && r.queued) {
      state.chatPending = (state.chatPending || []).filter((p) => p !== pending)
      const rows = chatQueues.get(sessionId) || []
      chatQueues.set(sessionId, rows.concat({ id: r.queueId, text: body, mentions, createdAt: Date.now() }))
      paintChat()
      paintChatQueue()
    }
    // Gateway 把失效的点名剔掉了（断了、被公司禁了、根本不是我的）。人要知道为什么，
    // 不然那几颗药丸就是无声消失的。
    if (r && Array.isArray(r.droppedMentions) && r.droppedMentions.length) {
      flash('err', t(`有 ${r.droppedMentions.length} 个 @ 已经失效，这一条没带上它们`))
      render()
    }
  } catch (err) {
    // 没发出去就把这条回显撤掉，别让屏幕上留一条其实不存在的消息。
    state.chatPending = (state.chatPending || []).filter((p) => p !== pending)
    // 文件已经传上去了，退回来的只有草稿——附件不还，还了会传第二遍。
    state.chatDraft = text
    /**
     * **点名也要还。** 只还正文的话，人按重发时这一条不带任何 `@`——而
     * `mentionOnly` 的连接（比如个人邮箱）这一轮根本不在工具表里，Bot 会回一句
     * 「没有可用的邮箱」，用户却以为自己点过名了。
     */
    state.chatMentions = mentions
    paintChatMentions()
    if (uploaded.length) flash('err', t('附件已经在工作区里了，但这条消息没发出去。'))
    if (String(err.message || '').includes('实例还没上线')) state.runtimeError = '实例还没上线'
    else if (!uploaded.length) flash('err', err.message)
    render()
  }
}

/**
 * 中止这一轮。
 *
 * 以前是 `catch {}` 一把吞掉。三种完全不同的情况在界面上长得一模一样——请求没发出去、
 * 席位不认这条会话、这一轮其实早就结束了——都是「点了没反应」，连往哪儿查都给不出。
 *
 * **它止不住已经开跑的工具。** bot 那边 `agent.abort()` 掐的是模型那条流，而工具的
 * execute 拿不到这个信号（bot/src/agent/index.ts 的 bridgeTools 没接）。所以点在一颗
 * `bash·调用中` 上时，这里是成功的，画面却要等 bash 自己跑完——最长十分钟。这句如实
 * 说出来，别让人对着一个其实生效了的按钮反复点。
 */
async function abortChat() {
  const sessionId = state.chatSessionId
  if (!sessionId) return
  const stillRunning = Boolean(document.querySelector('.sw-toolchip[data-state="running"]'))
  try {
    const r = await api('POST', '/runtime/sessions/' + encodeURIComponent(sessionId) + '/abort', {})
    if (r && r.aborted === false) flash('err', t('这一轮已经结束了'))
    else if (stillRunning) flash('ok', t('已中止；正在跑的那个工具要等它自己收尾'))
    render()
  } catch (err) {
    flash('err', t('没能中止：') + (err && err.message ? err.message : ''))
    render()
  }
}

/**
 * 批准 / 拒绝一次高风险调用。
 *
 * **按下去先把卡片停用。** 终态是靠 SSE 那条事件回来的，一来一回几百毫秒，这期间
 * 按钮还亮着——人会以为没点上再点一次，而第二次点的是一条已经结束的确认，席位回
 * 409，界面上无端冒出一句「这条确认已经结束了」。
 *
 * 失败了要把它恢复回去：那次真的没送到，卡片得还能点。
 */
/**
 * 卡片上这几格现在是什么值。
 *
 * **点下去那一刻从 DOM 里现读**，不用上面那张草稿表：草稿表是为了重画之后不丢字，
 * 而「要发出去的是哪一份」只能以人眼前看到的那一份为准。两者不一致时（重画的竞态），
 * 眼前的那份才是他刚才读过的。
 */
function approvalEdits(callId) {
  const edits = {}
  for (const el of document.querySelectorAll('[data-edit]')) {
    if (el.getAttribute('data-call') !== callId) continue
    edits[el.getAttribute('data-edit')] = el.value
  }
  return edits
}

async function decideApproval(callId, decision, scope) {
  const sessionId = state.chatSessionId
  if (!sessionId || !callId) return
  const box = [...document.querySelectorAll('.sw-approval')].find((el) => el.getAttribute('data-call') === callId)
  if (box) {
    if (box.getAttribute('data-busy') === '1') return
    box.setAttribute('data-busy', '1')
  }
  try {
    const edits = decision === 'approve' ? approvalEdits(callId) : null
    await api(
      'POST',
      '/runtime/sessions/' + encodeURIComponent(sessionId) + '/approvals/' + encodeURIComponent(callId),
      { decision, scope: scope || 'once', ...(edits && Object.keys(edits).length ? { edits } : {}) },
    )
    // 这一条已经落定，草稿留着只会在下一次同名 callId 上冒出来（不会发生，但也没用了）。
    for (const key of [...approvalDrafts.keys()]) {
      if (key.startsWith(callId + '::')) approvalDrafts.delete(key)
    }
  } catch (err) {
    if (box) box.removeAttribute('data-busy')
    // 409 是「这条早就结束了」——超时、被停止、或者另一个标签页先点了。它不是错误，
    // 但必须说出来：人点了一下什么都没发生才是最糟的。
    flash('err', err && err.message ? err.message : t('没能提交这次确认', 'Could not submit that decision'))
  }
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
    /**
     * 「有会话在跑，这次没换」**单独数**，不进「失败」。
     *
     * 那是管家等到超时也没等到席位空下来（见 manager/src/seats.ts 的排空）：机器上
     * 一个字节都没动，席位还是原来的版本、还在好好地跑，晚点再来一次就是了。混进
     * 失败里的话，一次「中午大家都在用」会被报成一片红，人会去查根本不存在的故障。
     */
    const held = results.filter((r) => r.busy).length
    const bad = results.filter((r) => !r.busy && (r.error || r.status === 'error')).length
    const tail = held ? t(`，${held} 个有会话在跑没换`, `, ${held} skipped (busy)`) : ''
    if (!results.length) flash('ok', t('没有需要更新的席位', 'No seats needed updating'))
    else
      flash(
        bad && !ok ? 'err' : 'ok',
        t(`更新 ${data.version}：成功 ${ok}，失败 ${bad}`, `Updated ${data.version}: ${ok} ok, ${bad} failed`) + tail,
      )
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


/* ── `@` 点名 ──────────────────────────────────────────────────────────
   输入框里打 `@` 弹选单，选中之后变成输入框上方的一颗药丸——**不是**往正文里塞一串
   字。点名是结构化的东西：它决定这一轮的工具表（`mentionOnly` 的连接只有被点名才
   出现），而一句「我提到了 Gmail」和「用户点名了这把连接」在进程那边是两回事。 */

/** 光标前面刚打出来的 `@xxx`。不在词首（前面挨着字母）不算，邮箱地址不该触发选单。 */
function mentionQueryAt(el) {
  if (!el) return null
  const pos = el.selectionStart ?? el.value.length
  const before = el.value.slice(0, pos)
  const at = before.lastIndexOf('@')
  if (at < 0) return null
  const prev = at > 0 ? before[at - 1] : ' '
  if (!/[\s(（]/.test(prev)) return null
  const word = before.slice(at + 1)
  if (/[\s\n]/.test(word)) return null
  return { at, q: word }
}

function closeMentionPick() {
  state.mentionPick = null
  paintMentionPick()
}

async function openMentionPick(q) {
  /**
   * **只在选单从关到开的那一下重拉候选**，不是每敲一个字拉一次，也不是一整页只拉一次。
   *
   * 一页只拉一次的话，人在另一个标签页刚连上的账号 `@` 不出来，只能刷新页面；每敲一个
   * 字拉一次又太吵。开合这一下正好：`/mentions` 就是两条查询，而人打开选单时本来就
   * 在等一小会儿。
   */
  const opening = !state.mentionPick
  state.mentionPick = { open: true, q, index: 0 }
  paintMentionPick()
  if (opening || !state.mentionOptions) {
    try {
      state.mentionOptions = (await api('GET', '/mentions')).mentions || []
    } catch {
      state.mentionOptions = state.mentionOptions || []
    }
    // 拉回来的时候人可能已经把选单关掉了（打了个空格）。那就别再画。
    if (state.mentionPick) paintMentionPick()
  }
}

/** 选中一个：把输入框里那截 `@xxx` 抹掉，改成上方的一颗药丸。 */
function takeMention(id) {
  const one = (state.mentionOptions || []).find((m) => m.id === id)
  if (!one) return
  const el = document.getElementById('chat-input')
  const hit = mentionQueryAt(el)
  if (el && hit) {
    const pos = el.selectionStart ?? el.value.length
    el.value = el.value.slice(0, hit.at) + el.value.slice(pos)
    el.selectionStart = el.selectionEnd = hit.at
    state.chatDraft = el.value
  }
  const picked = state.chatMentions || []
  if (!picked.some((m) => m.id === id)) state.chatMentions = picked.concat(one)
  closeMentionPick()
  paintChatMentions()
  el?.focus()
}

/** 取消一条排队的消息。已经开跑的席位回 409——那时如实说，不装作取消成功。 */
async function cancelQueued(id) {
  const sessionId = state.chatSessionId
  if (!sessionId) return
  try {
    await api('DELETE', `/runtime/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(id)}`)
    chatQueues.set(sessionId, (chatQueues.get(sessionId) || []).filter((r) => r.id !== id))
    paintChatQueue()
  } catch (err) {
    // 409 = 这一刻它正好被取出开跑了。把它从 dock 上撤下来——它已经不在队里了，
    // 接下来会以正常消息的样子从 SSE 上过来。
    chatQueues.set(sessionId, (chatQueues.get(sessionId) || []).filter((r) => r.id !== id))
    paintChatQueue()
    flash('err', err.status === 409 ? t('这条已经开始执行了') : err.message)
    render()
  }
}

/* ── 工具痕迹的悬浮窗 ────────────────────────────────────────────────────
 *
 * 药丸上只有「工具名 · 状态」，而人真正想知道的是**它拿什么参数跑的、跑出了什么**。
 * 失败的那几颗尤其——以前想知道为什么失败，只能去「导出记录」里翻整段 JSON。
 *
 * 浮层挂在 body 上，不放进气泡里：气泡有自己的圆角和 overflow，浮层长在里面会被裁掉
 * 一角；而且最后一条消息贴着输入框时，往上弹还是往下弹得按视口算，气泡内的坐标系
 * 算不出来。
 *
 * 鼠标移开有一小段宽限，且移到浮层上算「还在看」——否则一个能滚动的浮层，人刚要伸手
 * 去滚它就没了。
 */
const TOOLPOP_HIDE_MS = 160
const TOOLPOP_MAX_CHARS = 4000
let toolPop = null
let toolPopAnchor = null
let toolPopHost = null
let toolPopIndex = -1
let toolPopHideTimer = null

function toolPopEl() {
  if (toolPop) return toolPop
  toolPop = document.createElement('div')
  toolPop.className = 'sw-toolpop'
  toolPop.hidden = true
  toolPop.addEventListener('mouseenter', () => clearTimeout(toolPopHideTimer))
  toolPop.addEventListener('mouseleave', () => hideToolPop(TOOLPOP_HIDE_MS))
  document.body.appendChild(toolPop)
  return toolPop
}

/** 参数是 bot 那边 stringify 过的原串。能 parse 就缩进展示，不能就原样——不猜格式。 */
function prettyArgs(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!text) return ''
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** 超长就截断并说清楚截了多少。悄悄截掉会让人以为工具真的只输出了这么点。 */
function clip(text) {
  const s = String(text == null ? '' : text)
  if (s.length <= TOOLPOP_MAX_CHARS) return s
  return s.slice(0, TOOLPOP_MAX_CHARS) + '\n\n…（还有 ' + (s.length - TOOLPOP_MAX_CHARS) + ' 个字符，完整内容见「导出记录」）'
}

function toolPopBody(x) {
  if (x && x.approval) return approvalPopBody(x)
  const label = x.result == null ? t('调用中') : x.failed ? t('失败') : t('完成')
  const state_ = x.result == null ? 'running' : x.failed ? 'error' : 'done'
  const args = prettyArgs(x.args)
  const rows = [
    `<div class="sw-toolpop-head"><span class="sw-toolpop-name">${esc(x.name)}</span>` +
      `<span class="sw-toolpop-state" data-state="${state_}">${esc(label)}</span></div>`,
  ]
  // 参数为空是常事（now、ls 这种），那就不摆一个空框——空框看着像「读不出来」。
  if (args) rows.push(`<div class="sw-toolpop-k">${esc(t('参数'))}</div><pre>${esc(clip(args))}</pre>`)
  if (x.result == null) {
    rows.push(`<div class="sw-toolpop-wait">${esc(t('还在跑，结果出来后这里会填上'))}</div>`)
  } else {
    const out = String(x.result || '').trim()
    rows.push(
      `<div class="sw-toolpop-k">${esc(x.failed ? t('错误') : t('结果'))}</div>` +
        (out ? `<pre>${esc(clip(out))}</pre>` : `<div class="sw-toolpop-wait">${esc(t('（没有输出）'))}</div>`),
    )
  }
  return rows.join('')
}

/**
 * 收起来的那颗确认，展开之后要看到的东西：为什么要确认、当时批的是什么参数。
 *
 * 参数留在这里而不是留在气泡里，是因为**它只在被问起时才重要**：批的那一刻必须摊开，
 * 批完之后是一条痕迹。翻旧对话的人要的是「这一步谁点的头」，需要细看时再停一下鼠标。
 */
function approvalPopBody(a) {
  const label = (APPROVAL_CHIP_LABEL[a.state] || APPROVAL_CHIP_LABEL.denied)()
  const rows = [
    `<div class="sw-toolpop-head"><span class="sw-toolpop-name">${esc(a.name)}</span>` +
      `<span class="sw-toolpop-state" data-state="${a.state === 'approved' ? 'done' : 'error'}">${esc(label)}</span></div>`,
  ]
  if (a.reason) rows.push(`<div class="sw-toolpop-k">${esc(t('为什么要确认', 'Why approval was needed'))}</div><div>${esc(a.reason)}</div>`)
  /**
   * **改过要说出来，而且要说改了哪几格。**
   *
   * 下面摆的是最终那一份（席位在终态事件里给的就是改后的）。不写这一行的话，翻记录
   * 的人会以为模型起草的就是这个样子——而「这句话是谁写的」正是事后最要紧的问题。
   */
  if ((a.edited || []).length) {
    rows.push(
      `<div class="sw-toolpop-k">${esc(t('批准时改过', 'Edited before approving'))}</div><div>${esc(a.edited.join('、'))}</div>`,
    )
  }
  const fields = (a.form && a.form.fields) || []
  if (fields.length) {
    // 有表单就按表单摆（收件人 / 主题 / 正文），比一段带转义符的 JSON 好读得多。
    rows.push(
      `<div class="sw-toolpop-k">${esc(t('内容', 'Content'))}</div>` +
        fields
          .filter((f) => f.value)
          .map(
            (f) =>
              `<div class="sw-toolpop-field"><span>${esc(f.label)}</span>${
                f.multiline ? `<pre>${esc(clip(f.value))}</pre>` : `<div>${esc(f.value)}</div>`
              }</div>`,
          )
          .join(''),
    )
  } else {
    const args = prettyArgs(a.args)
    if (args) rows.push(`<div class="sw-toolpop-k">${esc(t('参数'))}</div><pre>${esc(clip(args))}</pre>`)
  }
  return rows.join('')
}

/**
 * 定位。先填内容再量高度——内容是刚换的，没量过就不知道往上弹放不放得下。
 * 放不下就翻到下面，两边都不够时贴住视口，宁可挡一点也不要跑到屏幕外面去。
 */
function placeToolPop(chip) {
  const pop = toolPopEl()
  const r = chip.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  pop.style.maxWidth = Math.min(520, vw - 24) + 'px'
  const box = pop.getBoundingClientRect()
  const above = r.top >= box.height + 12
  let top = above ? r.top - box.height - 8 : r.bottom + 8
  if (!above && top + box.height > vh - 8) top = Math.max(8, vh - box.height - 8)
  let left = r.left
  if (left + box.width > vw - 12) left = vw - 12 - box.width
  if (left < 12) left = 12
  pop.style.top = Math.max(8, top) + 'px'
  pop.style.left = left + 'px'
  pop.setAttribute('data-side', above ? 'top' : 'bottom')
}

function showToolPop(chip) {
  const x = chip.__tool
  if (!x) return
  clearTimeout(toolPopHideTimer)
  const pop = toolPopEl()
  // 同一颗药丸重复触发（鼠标在药丸里移动）就别重画了，否则滚动位置每帧都被重置。
  if (toolPopAnchor !== chip || pop.hidden) {
    toolPopAnchor = chip
    toolPopHost = chip.parentElement
    toolPopIndex = Number(chip.getAttribute('data-i'))
    pop.innerHTML = toolPopBody(x)
    pop.hidden = false
    placeToolPop(chip)
  }
}

function hideToolPop(delay) {
  clearTimeout(toolPopHideTimer)
  const run = () => {
    if (toolPop) toolPop.hidden = true
    toolPopAnchor = null
    toolPopHost = null
    toolPopIndex = -1
  }
  if (!delay) run()
  else toolPopHideTimer = setTimeout(run, delay)
}

/**
 * chips 重画之后把浮层接到新节点上。
 *
 * 节点是 innerHTML 整体换掉的，原来那个 anchor 已经脱离文档。按容器 + 下标重新认一次
 * ——「调用中 → 完成」正是人盯着它看的那一刻，那时候浮层闪没最难受。认不回来才关。
 */
function refreshToolPop() {
  if (!toolPop || toolPop.hidden) return
  if (toolPopAnchor && document.contains(toolPopAnchor)) return
  const list = toolPopHost ? toolPopHost.querySelectorAll('.sw-toolchip') : []
  const next = toolPopIndex >= 0 ? list[toolPopIndex] : null
  if (!next || !next.__tool) return hideToolPop(0)
  toolPopAnchor = next
  toolPop.innerHTML = toolPopBody(next.__tool)
  placeToolPop(next)
}

/**
 * 卡片上打的字，随手记进草稿表。
 *
 * 挂在 document 上而不是每张卡上：卡片是 innerHTML 换出来的，节点每次重画都是新的，
 * 挂在节点上的监听会跟着没。
 */
document.addEventListener('input', (e) => {
  const el = e.target instanceof Element ? e.target : null
  const key = el && el.getAttribute && el.getAttribute('data-edit')
  if (!key) return
  const callId = el.getAttribute('data-call') || ''
  approvalDrafts.set(draftKey(callId, key), el.value)
  /**
   * 改过之后「这次对话都批准」就不能点了。**当场变灰**，不等下一次重画——重画是别的
   * 事件驱动的，可能一直不来；而这颗按钮亮着，人点下去就是「把之后所有没人看过的信
   * 也一起放行」。席位那边也会把改过的这一次强制成 once（见 approvals.ts），
   * 这里变灰是让人看得见，不是唯一的一道。
   */
  const card = el.closest('.sw-approval')
  const wide = card && card.querySelector('[data-act="chat-approve"][data-scope="session"]')
  if (wide) {
    wide.disabled = true
    wide.title = t('这一次改过内容，只能批准这一次', 'You edited this one, so it can only be approved once')
  }
})

document.addEventListener('mouseover', (e) => {
  const el = e.target instanceof Element ? e.target : null
  if (!el) return
  const chip = el.closest('.sw-toolchip')
  if (chip) return showToolPop(chip)
  if (el.closest('.sw-toolpop')) return
  if (toolPop && !toolPop.hidden) hideToolPop(TOOLPOP_HIDE_MS)
})

// 键盘也要能看。药丸带 tabindex，Tab 到就出，离开就收。
document.addEventListener('focusin', (e) => {
  const el = e.target instanceof Element ? e.target : null
  const chip = el && el.closest('.sw-toolchip')
  if (chip) showToolPop(chip)
  else if (el && !el.closest('.sw-toolpop')) hideToolPop(0)
})

/**
 * 滚动时立刻收：浮层是 fixed 的，跟不上锚点，留在原地就是一块飘着的脏东西。
 *
 * **但浮层自己滚不算。** 结果那一段有自己的滚动区（`.sw-toolpop pre`，最高 220px），
 * 内容一长就得在里面滚着看——而这个监听器是捕获阶段挂在 window 上的，滚它也照收不误：
 * 手一动窗口就没了，长输出永远看不完。这里按事件源头分一下：源头在浮层里就不收。
 */
window.addEventListener(
  'scroll',
  (e) => {
    const el = e.target instanceof Element ? e.target : null
    if (el && el.closest('.sw-toolpop')) return
    hideToolPop(0)
  },
  true,
)
window.addEventListener('resize', () => hideToolPop(0))
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && toolPop && !toolPop.hidden) hideToolPop(0)
})
