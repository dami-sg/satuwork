import { Service } from '@deepseek-ai/cordis'
import {
  agentIcon,
  EXEC_MODES,
  html,
  icon,
  ICONS,
  NavItem,
  useEffect,
  useHost,
  useReducer,
  useRef,
  useState,
  locale,
  t,
} from '@satu/shell'

/**
 * 会话：新建对话与对话详情。
 *
 * 这一屏接的是**真** API（SSE 事件流、steering、中止），不是 mock。它同时是别的
 * 屏的参照：数据从事件折出来，渲染永远是折出来那份状态的纯函数。
 */

// ── 会话列表（浏览器侧的服务）───────────────────────────────────────────────
// 侧栏和正文都要它，且新建之后两边都得跟上。放进 ctx 而不是各自 fetch 一遍，
// 「谁是权威」就只有一个答案。
class Sessions extends Service {
  listeners = new Set()

  constructor(ctx) {
    super(ctx, 'sessions')
    this.list = []
    this.loaded = false
  }

  /**
   * 第一次真的有人要看列表时才拉。
   *
   * 插件挂载 ≠ 界面要用它：未登录时整块屏幕归登录页，会话列表一个组件都没渲染，
   * 这时候去打接口只会拿回一个 401，还是一条没人接的 rejection。
   */
  ensure() {
    if (this.loaded) return
    this.loaded = true
    this.reload()
  }

  async reload() {
    this.list = await this.ctx.host.get('/api/sessions')
    this.bump()
  }

  async create() {
    const { id } = await this.ctx.host.post('/api/sessions')
    await this.reload()
    return id
  }

  /** 发消息。跑起来时这条走 steering，宿主那边自己分支，前端不需要知道。 */
  send(id, text) {
    return this.ctx.host.post(`/api/sessions/${id}/messages`, { text })
  }

  abort(id) {
    return this.ctx.host.post(`/api/sessions/${id}/abort`)
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  bump() {
    for (const listener of this.listeners) listener()
  }
}

function useSessions(ctx) {
  const [, force] = useReducer((n) => n + 1, 0)
  useEffect(() => {
    const off = ctx.sessions.subscribe(force)
    ctx.sessions.ensure()
    // 列表是异步拉的，很可能在这个订阅装上之前就回来了——装好先自查一次。
    force()
    return off
  }, [ctx])
  return ctx.sessions.list
}

// ── 事件 → 可渲染状态 ──────────────────────────────────────────────────────
/**
 * 把一条会话事件折进渲染状态。
 *
 * **前端只有这一处理解事件语义**。多一处就会出现两套对「一轮结束了没有」的理解，
 * 而它们只在出错的时候才会分道扬镳。
 */
function fold(blocks, event, setStatus) {
  const d = event.data
  const next = [...blocks]
  const time = event.time
  if (event.type === 'user/message' && d.source?.kind === 'user') {
    next.push({ role: 'user', kind: 'text', time, text: d.message.content.map((c) => c.text ?? '').join('') })
  } else if (event.type === 'assistant/message') {
    for (const c of d.message.content) {
      if (c.type === 'text') next.push({ role: 'assistant', kind: 'text', time, text: c.text })
      else if (c.type === 'reasoning') next.push({ role: 'assistant', kind: 'reasoning', time, text: c.text })
    }
  } else if (event.type === 'tool/call') {
    next.push({ role: 'assistant', kind: 'tool', time, callId: d.callId, name: d.name, args: d.arguments })
  } else if (event.type === 'tool/result') {
    const i = next.findIndex((b) => b.kind === 'tool' && b.callId === d.callId)
    if (i >= 0) next[i] = { ...next[i], result: d.text }
  } else if (event.type === 'turn/start') {
    // 跑起来之后输入框不锁：这时发消息走 steering，工具跑到一半也能插话。
    setStatus({ text: t('正在思考…（可以继续输入来打断）', 'Thinking… (keep typing to interrupt)'), running: true })
  } else if (event.type === 'turn/end') {
    setStatus({ text: d.reason === 'completed' ? '' : t(`本轮以 ${d.reason} 结束`, `Turn ended: ${d.reason}`), running: false })
  }
  return next
}

/**
 * 原始事件流。
 *
 * 「调用链路」那屏要的是**事件本身**，不是折出来的可渲染状态——折叠是有损的，
 * 系统提示词、工具表、用量都在折的过程中被丢掉了。所以两屏各取所需：对话屏用
 * `useThread`，链路屏用这个。同一条流，两种读法。
 */
function useEvents(ctx, id) {
  const [events, setEvents] = useState([])

  useEffect(() => {
    setEvents([])
    if (!id) return
    let acc = []
    return ctx.host.stream(`/api/sessions/${id}/events`, (event) => {
      acc = [...acc, event]
      setEvents(acc)
    })
  }, [ctx, id])

  return events
}

function useThread(ctx, id) {
  const [blocks, setBlocks] = useState([])
  const [status, setStatus] = useState({ text: '', running: false })

  useEffect(() => {
    setBlocks([])
    setStatus({ text: '', running: false })
    if (!id) return
    let acc = []
    // SSE 先补历史再转推实时，所以这里不用另外拉一次历史。
    return ctx.host.stream(
      `/api/sessions/${id}/events`,
      (event) => {
        acc = fold(acc, event, setStatus)
        setBlocks(acc)
      },
      () => setStatus({ text: t('连接断开', 'Disconnected'), running: false }),
    )
  }, [ctx, id])

  return { blocks, status }
}

// ── 界面 ───────────────────────────────────────────────────────────────────
// 参数不叫 `t`：那个名字是取词函数，遮住它这一屏就没法翻译了。
const hhmm = (ts) =>
  ts ? new Date(ts).toLocaleTimeString(locale() === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''

/**
 * 把折出来的块**按显示单位**再合一次。
 *
 * 连续的工具调用在稿子上是一个「步骤」盒子，不是一行一个框。分组只发生在渲染这
 * 一侧：折叠那一步保留每次调用的原样，谁想看细节（以后的「调用链路」那一屏）还
 * 能拿到完整的一条条。
 */
function group(blocks) {
  const rows = []
  for (const block of blocks) {
    const last = rows[rows.length - 1]
    if (block.kind === 'tool' && last?.kind === 'steps') last.items.push(block)
    else if (block.kind === 'tool') rows.push({ kind: 'steps', time: block.time, items: [block] })
    else rows.push(block)
  }
  return rows
}

function Thread({ blocks, status }) {
  const box = useRef(null)
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [blocks])

  const rows = group(blocks)
  // 正文底部留出输入卡的高度：那张卡压在正文之上，不留这段的话滚到底时最后一条
  // 会被压住——而且是「看起来已经滚到头了」的那种压住。
  return html`
    <div ref=${box} style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6) var(--space-6) 108px;">
      <div style="max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-6);">
        ${rows.map((row, i) => html`<${Row} key=${i} row=${row} />`)}
        ${status.running && html`<${Typing} />`}
      </div>
    </div>
  `
}

/** 头像列的宽度，步骤盒与推理块靠它对齐到正文那一栏。 */
const INDENT = 'margin-left: calc(30px + var(--space-3));'

function Row({ row }) {
  if (row.kind === 'steps') {
    return html`
      <div class="satu-steps" style=${INDENT}>
        ${row.items.map(
          (tool) => html`
            <div class="satu-step" key=${tool.callId}>
              ${tool.result === undefined
                ? html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/></svg>`
                : html`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 13 4 4L19 7"/></svg>`}
              <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                ${tool.name} ${tool.result === undefined ? t('执行中…', 'running…') : `→ ${tool.result}`}
              </span>
            </div>
          `,
        )}
      </div>
    `
  }

  if (row.kind === 'reasoning') {
    return html`
      <div style=${`${INDENT} font-size: 13px; line-height: 1.7; color: var(--muted-foreground); border-left: 2px solid var(--color-accent-300); padding-left: var(--space-3); white-space: pre-line;`}>
        ${row.text}
      </div>
    `
  }

  const mine = row.role === 'user'
  return html`
    <div class="satu-msg" data-role=${row.role}>
      <div
        class="satu-avatar"
        style=${mine
          ? 'background: var(--color-neutral-300); color: var(--color-neutral-800);'
          : 'background: var(--color-accent-200); color: var(--color-accent-800);'}
      >${mine ? t('我', 'Me') : 'S'}</div>
      <div style="min-width: 0; flex: 1; display: flex; flex-direction: column; gap: var(--space-2);">
        <div style="display: flex; align-items: baseline; gap: var(--space-2);">
          <span style="font-weight: 600; font-size: 13.5px;">${mine ? t('我', 'Me') : 'Satuwork'}</span>
          <span style="font-size: 11.5px; color: var(--muted-foreground);">${hhmm(row.time)}</span>
        </div>
        <div class="satu-bubble" data-role=${row.role}>${row.text}</div>
      </div>
    </div>
  `
}

/** 一轮跑起来了但还没有任何输出时的占位。空着会让人以为消息没发出去。 */
function Typing() {
  return html`
    <div class="satu-msg" data-role="agent">
      <div class="satu-avatar" style="background: var(--color-accent-200); color: var(--color-accent-800);">S</div>
      <div style="display: flex; align-items: center; font-size: 13px; color: var(--muted-foreground); min-height: 30px;">${t('正在思考…', 'Thinking…')}</div>
    </div>
  `
}

/**
 * 悬浮的输入卡。
 *
 * 稿子上它压在正文之上（负的上外边距 + 阴影），而不是一条分隔线下面的输入框——
 * 视觉上「对话还在继续」，不是「上面是记录、下面是表单」。
 */
function Composer({ ctx, sessionId, status }) {
  const [text, setText] = useState('')
  const [mode, setMode] = useState('ask')
  const execMode = EXEC_MODES.find((m) => m.key === mode)

  const submit = async () => {
    const body = text.trim()
    if (!body) return
    setText('')
    await ctx.sessions.send(sessionId, body)
  }

  return html`
    <div style="flex: none; margin-top: calc(var(--space-6) * -1); padding: 0 var(--space-6) var(--space-4); pointer-events: none;">
      <div style="max-width: 720px; margin: 0 auto; background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: var(--space-3); display: flex; flex-direction: column; gap: var(--space-2); pointer-events: auto;">
        <textarea
          class="satu-prompt satu-grow"
          rows="2"
          placeholder=${t('继续这段对话…', 'Continue this chat…')}
          value=${text}
          onInput=${(e) => setText(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        ></textarea>

        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: nowrap;">
          <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('附件', 'Attachment')} title=${t('附件：还没接上', 'Attachments: not wired up yet')} disabled style="flex: none;">
            ${icon(ICONS.clip)}
          </button>
          <div style="display: flex; align-items: center; gap: 4px; min-width: 0;">
            <span class="satu-selicon">${icon(execMode.paths)}</span>
            <select
              class="satu-inlinesel"
              style="flex: 0 1 auto;"
              aria-label=${t('执行模式', 'Execution mode')}
              title=${execMode.hint}
              value=${mode}
              onChange=${(e) => setMode(e.target.value)}
            >
              ${EXEC_MODES.map((m) => html`<option key=${m.key} value=${m.key}>${m.label}</option>`)}
            </select>
          </div>
          <div style="display: flex; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; margin-left: auto;">
            <${ModelSelect} ctx=${ctx} />
          </div>
          ${status.running
            ? html`<button type="button" class="btn btn-secondary" style="flex: none;" onClick=${() => ctx.sessions.abort(sessionId)}>${t('停止', 'Stop')}</button>`
            : ''}
          <button type="button" class="btn btn-primary btn-icon" aria-label=${t('发送', 'Send')} style="flex: none;" onClick=${submit}>
            ${icon(ICONS.arrowRight, 16)}
          </button>
        </div>
      </div>
      ${status.text &&
      html`<div style="max-width: 720px; margin: 6px auto 0; font-size: 12px; color: var(--muted-foreground);">${status.text}</div>`}
    </div>
  `
}

// ── 顶栏 ───────────────────────────────────────────────────────────────────
/** 从地址里认出会话。`/chat/<id>` 与 `/chat/<id>/log` 是同一个会话的两个视角。 */
function sessionOf(path) {
  const rest = path.startsWith('/chat/') && path.slice('/chat/'.length)
  if (!rest) return null
  const [id, tail] = rest.split('/')
  return id ? { id, log: tail === 'log' } : null
}

/** 会话屏在顶栏右侧放的东西。别的屏进来时这一组自己消失。 */
function ChatHeaderActions({ ctx, path }) {
  const agents = useHost(ctx, '/api/agents')
  const [agent, setAgent] = useState(null)
  const target = sessionOf(path)
  if (!target) return null

  const list = agents.data?.agents ?? []
  const picked = list.find((a) => a.name === agent) ?? list[0]

  return html`
    <${'div'} style="display: flex; align-items: center; gap: var(--space-2);">
      <div style="display: flex; align-items: center; gap: 4px; min-width: 0;">
        <span class="satu-selicon">${agentIcon(picked?.icon)}</span>
        <select
          class="satu-inlinesel"
          aria-label=${t('选择 AI 员工', 'Pick an AI employee')}
          value=${picked?.name ?? ''}
          onChange=${(e) => setAgent(e.target.value)}
        >
          ${list.map((a) => html`<option key=${a.id} value=${a.name}>${a.name}</option>`)}
        </select>
      </div>
      <div style="width: 1px; height: 18px; background: var(--border);"></div>
      <button
        type="button"
        class="btn btn-ghost btn-icon"
        aria-label=${t('调用链路', 'Trace')}
        aria-pressed=${String(target.log)}
        onClick=${() => ctx.router.go(target.log ? `/chat/${target.id}` : `/chat/${target.id}/log`)}
      >
        ${icon(['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'], 16)}
      </button>
      <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('重命名', 'Rename')} title=${t('重命名：还没做', 'Rename: not built yet')} disabled>
        ${icon(['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'], 16)}
      </button>
      <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('导出', 'Export')} title=${t('导出：还没做', 'Export: not built yet')} disabled>
        ${icon(['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 10 5 5 5-5', 'M12 15V3'], 16)}
      </button>
    <//>
  `
}

function ConversationPage({ matched, ctx }) {
  const { blocks, status } = useThread(ctx, matched.sessionId)
  return html`
    <div style="flex: 1; min-height: 0; display: flex; flex-direction: column;">
      <${Thread} blocks=${blocks} status=${status} />
      <${Composer} ctx=${ctx} sessionId=${matched.sessionId} status=${status} />
    </div>
  `
}

// ── 调用链路 ───────────────────────────────────────────────────────────────
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n}ms`)
const json = (v) => JSON.stringify(v, null, 2)

/**
 * 把事件流派生成一串「调用」。
 *
 * 这一屏是 **model-visible ⟺ logged** 这条规则的兑现处：凡是进过模型请求的东西
 * 都必须能从日志重建出来。所以这里只做派生，不做补充——派生不出来的字段就不显示，
 * 而不是填一个看着合理的值。
 */
function trace(events) {
  const calls = []
  let sysShown = false

  for (const e of events) {
    if (e.type === 'request/header') {
      const d = e.data
      // 系统段只在**变化时**出一条：每一步都重复同一份提示词，看的人会以为它每次都不一样。
      const digest = `${d.system} ${d.tools.map((t) => t.name).join(',')}`
      if (!sysShown || sysShown !== digest) {
        sysShown = digest
        calls.push({
          kind: 'system',
          time: e.time,
          title: t('系统提示词与工具表', 'System prompt and tools'),
          meta: t(`${d.tools.length} 个工具`, `${d.tools.length} tools`),
          sections: [
            { label: t('系统提示词', 'System prompt'), body: d.system || t('（空）', '(empty)') },
            { label: t('工具表', 'Tools'), body: d.tools.map((tool) => `${tool.name} — ${tool.description}`).join('\n') || t('（无）', '(none)') },
          ],
        })
      }
      calls.push({
        kind: 'model',
        time: e.time,
        turn: d.turn,
        step: d.step,
        title: `${d.provider} / ${d.model}`,
        pending: true,
        sections: [],
      })
    } else if (e.type === 'assistant/message') {
      const d = e.data
      // 回填最近一条还没有结果的模型调用。请求与回复是同一次调用的两端，
      // 拆成两张卡会让「一共调了几次模型」这个数当场翻倍。
      const call = [...calls].reverse().find((c) => c.kind === 'model' && c.pending && c.turn === d.turn && c.step === d.step)
      if (!call) continue
      const u = d.usage ?? {}
      const text = d.message.content
        .map((c) => (c.type === 'text' ? c.text : c.type === 'reasoning' ? `[推理] ${c.text}` : `[调用] ${c.name} ${c.arguments}`))
        .join('\n\n')
      call.pending = false
      call.duration = e.time - call.time
      call.usage = u
      call.meta = `${ms(call.duration)} · ${u.inputTokens ?? 0} → ${u.outputTokens ?? 0} tokens`
      call.sections = [
        { label: t('输出', 'Output'), body: text || t('（空）', '(empty)') },
        { label: t('用量', 'Usage'), body: json(u) },
      ]
    } else if (e.type === 'tool/call') {
      calls.push({
        kind: 'tool',
        time: e.time,
        callId: e.data.callId,
        title: e.data.name,
        pending: true,
        meta: t('执行中…', 'running…'),
        sections: [{ label: t('参数', 'Arguments'), body: e.data.arguments || '{}' }],
      })
    } else if (e.type === 'tool/result') {
      const call = calls.find((c) => c.kind === 'tool' && c.callId === e.data.callId)
      if (!call) continue
      call.pending = false
      call.duration = e.time - call.time
      call.failed = e.data.failed
      call.meta = `${ms(call.duration)}${e.data.failed ? t(' · 失败', ' · failed') : ''}`
      call.sections = [...call.sections, { label: t('结果', 'Result'), body: e.data.text }]
    } else if (e.type === 'user/message' && e.data.source?.kind !== 'user') {
      // 插件注入的上下文。出处挂在 source 上，所以「这段是谁塞进来的」有据可查。
      calls.push({
        kind: 'context',
        time: e.time,
        title: t(`注入上下文 · ${e.data.source.plugin}`, `Injected context · ${e.data.source.plugin}`),
        meta: e.data.source.form ?? '',
        sections: [
          { label: t('内容', 'Content'), body: e.data.message.content.map((c) => c.text ?? '').join('\n') },
          { label: t('出处', 'Provenance'), body: json(e.data.source) },
        ],
      })
    }
  }
  return calls
}

const KIND_LABEL = { system: 'SYSTEM', context: 'CONTEXT', model: 'MODEL', tool: 'TOOL' }
const FILTERS = ['全部', 'SYSTEM', 'CONTEXT', 'MODEL', 'TOOL']

function Call({ call, index, open, onToggle }) {
  return html`
    <div class="satu-call">
      <button type="button" class="satu-callhead" aria-expanded=${String(open)} onClick=${onToggle}>
        <span class="satu-callidx">${index}</span>
        <span class="satu-calltype" data-kind=${call.kind}>${KIND_LABEL[call.kind]}</span>
        <span class="satu-calltitle">${call.title}</span>
        <span class="satu-callmeta">${call.meta}</span>
        <svg class="satu-callchev" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
      </button>
      ${open &&
      html`
        <div class="satu-callbody">
          ${call.sections.map(
            (s) => html`
              <div key=${s.label} style="display: flex; flex-direction: column; gap: 6px;">
                <span class="satu-panel-title">${s.label}</span>
                <pre class="satu-code">${s.body}</pre>
              </div>
            `,
          )}
        </div>
      `}
    </div>
  `
}

function CallLogPage({ ctx, matched }) {
  const events = useEvents(ctx, matched.sessionId)
  const [filter, setFilter] = useState('全部')
  const [closed, setClosed] = useState([])

  const calls = trace(events)
  const shown = calls.filter((c) => filter === '全部' || KIND_LABEL[c.kind] === filter)
  const models = calls.filter((c) => c.kind === 'model')
  const tools = calls.filter((c) => c.kind === 'tool')
  const sum = (pick) => models.reduce((n, c) => n + (pick(c.usage ?? {}) ?? 0), 0)
  const cost = sum((u) => u.cost)
  const span = events.length ? events[events.length - 1].time - events[0].time : 0

  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6);">
      <div style="max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-4);">

        <div style="min-width: 0;">
          <h1 style="font-size: 22px; margin: 0;">${t('调用链路', 'Trace')}</h1>
          <p style="margin: 6px 0 0; font-size: 13.5px; color: var(--muted-foreground);">
            ${matched.sessionId} · ${t(`共 ${calls.length} 次调用`, `${calls.length} calls`)} · ${ms(span)}
          </p>
        </div>

        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-3);">
          <div class="satu-stat"><span style="font-size: 12px; color: var(--muted-foreground);">${t('模型调用', 'Model calls')}</span><span style="font-size: 16px; font-weight: 600;">${models.length}</span></div>
          <div class="satu-stat"><span style="font-size: 12px; color: var(--muted-foreground);">${t('工具调用', 'Tool calls')}</span><span style="font-size: 16px; font-weight: 600;">${tools.length}</span></div>
          <div class="satu-stat"><span style="font-size: 12px; color: var(--muted-foreground);">${t('输入 / 输出 Token', 'Input / output tokens')}</span><span style="font-size: 16px; font-weight: 600;">${sum((u) => u.inputTokens)} / ${sum((u) => u.outputTokens)}</span></div>
          <div class="satu-stat"><span style="font-size: 12px; color: var(--muted-foreground);">${t('费用', 'Cost')}</span><span style="font-size: 16px; font-weight: 600;">${cost ? `$${cost.toFixed(4)}` : '—'}</span></div>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('类型', 'Kind')}</span>
          ${FILTERS.map(
            (f) => html`
              <button
                key=${f}
                type="button"
                class="satu-assignee"
                style="padding: 4px 12px;"
                aria-pressed=${String(filter === f)}
                onClick=${() => setFilter(f)}
              >${f}</button>
            `,
          )}
        </div>

        <div style="display: flex; flex-direction: column; gap: var(--space-2);">
          ${shown.map((c, i) => {
            const key = `${c.kind}-${c.time}-${i}`
            return html`
              <${Call}
                key=${key}
                call=${c}
                index=${i + 1}
                open=${!closed.includes(key)}
                onToggle=${() => setClosed((l) => (l.includes(key) ? l.filter((x) => x !== key) : [...l, key]))}
              />
            `
          })}
          ${!shown.length &&
          html`<div style="padding: var(--space-6); text-align: center; color: var(--muted-foreground); font-size: 13px;">${filter === '全部' ? t('这段会话里没有调用记录', 'No calls in this chat yet') : t(`这段会话里没有 ${filter} 类型的调用`, `No ${filter} calls in this chat`)}</div>`}
        </div>
      </div>
    </div>
  `
}

// ── 新建对话 ───────────────────────────────────────────────────────────────
/**
 * 模型下拉。
 *
 * 这一处是**真的**：目录与凭据状态来自 `/api/models`，选中项写回 `/api/settings`，
 * 下一轮立刻生效。没配凭据的 provider 也列出来但标出来——藏起来只会让人以为
 * 「不支持」，而真相是「还没填 key」。
 */
function ModelSelect({ ctx }) {
  const models = useHost(ctx, '/api/models')
  const settings = useHost(ctx, '/api/settings')
  const [value, setValue] = useState(null)

  if (models.loading || settings.loading || models.error || settings.error) {
    return html`<span style="font-size: 12px; color: var(--muted-foreground);">${t('模型…', 'Model…')}</span>`
  }

  const current = value ?? settings.data.model
  const entry = models.data.catalog.find((c) => c.provider === settings.data.provider)

  return html`
    <select
      class="satu-inlinesel satu-modelsel"
      aria-label=${t('对话模型', 'Chat model')}
      value=${current}
      onChange=${(e) => {
        setValue(e.target.value)
        ctx.host.put('/api/settings', { model: e.target.value })
      }}
    >
      ${(entry?.models ?? []).map((m) => html`<option key=${m.id} value=${m.id}>${m.id}</option>`)}
      ${!entry && html`<option value=${current}>${current}</option>`}
    </select>
  `
}

function NewChatPage({ ctx }) {
  const agents = useHost(ctx, '/api/agents')
  const suggestions = useHost(ctx, '/api/suggestions')
  const [text, setText] = useState('')
  const [agent, setAgent] = useState(null)
  const [mode, setMode] = useState('ask')
  const box = useRef(null)

  const list = agents.data?.agents ?? []
  const picked = list.find((a) => a.name === agent) ?? list[0]
  const execMode = EXEC_MODES.find((m) => m.key === mode)

  const start = async (prompt) => {
    const body = (prompt ?? text).trim()
    if (!body) return
    const id = await ctx.sessions.create()
    ctx.router.go(`/chat/${id}`)
    // 选中的 AI 员工与执行模式还没有落点：Agent 注册表与审批档位都没做。先不
    // 假装它们生效了——发出去的就是这段文字，别的等 satu-agent-registry。
    await ctx.sessions.send(id, body)
  }

  // 整块垂直居中用首尾的 `margin: auto` 顶开，而不是 justify-content: center——
  // 后者在内容比可视区高的时候会把顶部推到滚不到的地方，auto 外边距在空间不够时
  // 自己退化成 0。
  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; align-items: center; gap: var(--space-6); padding: var(--space-8) var(--space-6);">

      <div style="margin-top: auto; display: flex; flex-direction: column; align-items: center; gap: var(--space-3); text-align: center;">
        <div style="width: 52px; height: 52px; border-radius: var(--radius-md); background: var(--color-accent-100); display: flex; align-items: center; justify-content: center; color: var(--color-accent-700);">
          ${icon(ICONS.bubble, 26)}
        </div>
        <h1 style="font-size: 26px; margin: 0;">${t('今天想做什么？', 'What shall we do today?')}</h1>
        <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('描述你的任务，剩下的交给我们。', 'Describe the task; we will take it from there.')}</p>
      </div>

      <div style="width: 100%; max-width: 720px; display: flex; flex-direction: column; gap: var(--space-3);">
        <div style="background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3);">
          <textarea
            ref=${box}
            class="satu-prompt"
            rows="4"
            placeholder=${t('例如：把本周的客服工单按主题归类，输出一份摘要发到我的邮箱', 'e.g. Group this week\'s support tickets by topic and email me a summary')}
            value=${text}
            onInput=${(e) => setText(e.target.value)}
            onKeyDown=${(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                start()
              }
            }}
          ></textarea>

          <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; row-gap: var(--space-2);">
            <div style="display: flex; align-items: center; gap: 4px; min-width: 0; flex: 1 1 320px;">
              <span class="satu-selicon">${agentIcon(picked?.icon)}</span>
              <select
                class="satu-inlinesel"
                aria-label=${t('选择 AI 员工', 'Pick an AI employee')}
                value=${picked?.name ?? ''}
                onChange=${(e) => setAgent(e.target.value)}
              >
                ${list.map((a) => html`<option key=${a.id} value=${a.name}>${a.name}</option>`)}
              </select>

              <span class="satu-selicon">${icon(execMode.paths)}</span>
              <select
                class="satu-inlinesel"
                aria-label=${t('执行模式', 'Execution mode')}
                title=${execMode.hint}
                value=${mode}
                onChange=${(e) => setMode(e.target.value)}
              >
                ${EXEC_MODES.map((m) => html`<option key=${m.key} value=${m.key}>${m.label}</option>`)}
              </select>

              <div style="width: 1px; height: 18px; background: var(--border);"></div>
              ${[
                [t('附件', 'Attachment'), ICONS.clip],
                [t('知识库', 'Knowledge'), ICONS.book],
                [t('数据库', 'Database'), ICONS.db],
                [t('定时执行', 'Schedule'), ICONS.clock],
              ].map(
                ([label, paths]) => html`
                  <button
                    key=${label}
                    type="button"
                    class="btn btn-ghost btn-icon"
                    aria-label=${label}
                    title=${t(`${label}：还没接上`, `${label}: not wired up yet`)}
                    disabled
                  >${icon(paths)}</button>
                `,
              )}
            </div>

            <div style="display: flex; align-items: center; justify-content: flex-end; gap: 4px; min-width: 0; margin-left: auto;">
              <${ModelSelect} ctx=${ctx} />
            </div>
            <button type="button" class="btn btn-primary" style="flex: none;" onClick=${() => start()}>
              ${t('发送', 'Send')} ${icon(ICONS.arrowRight, 15)}
            </button>
          </div>
        </div>
      </div>

      <div style="width: 100%; max-width: 720px; margin-bottom: auto; display: flex; flex-direction: column; gap: var(--space-3);">
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('常用任务', 'Common tasks')}</span>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: var(--space-3);">
          ${(suggestions.data?.suggestions ?? []).map(
            (s) => html`
              <button key=${s.id} type="button" class="satu-suggest" onClick=${() => start(s.prompt)}>
                <span style="font-weight: 600;">${s.title}</span>
                <span style="font-size: 12px; color: var(--muted-foreground);">${s.hint}</span>
              </button>
            `,
          )}
        </div>
      </div>
    </div>
  `
}

// ── 导航 ───────────────────────────────────────────────────────────────────
function NewChatNav({ ctx, path }) {
  return html`<${NavItem} ctx=${ctx} path=${path} href="/" icon=${icon(ICONS.plus)} label=${t('新建对话', 'New chat')} exact />`
}

function HistoryNav({ ctx, path }) {
  const sessions = useSessions(ctx)
  const [open, setOpen] = useState(true)
  return html`
    <${'div'}>
      <button type="button" class="satu-nav" aria-expanded=${String(open)} onClick=${() => setOpen(!open)}>
        ${icon(ICONS.bubble)}
        <span class="satu-label">${t('全部对话', 'All chats')}</span>
        <span class="satu-label satu-caret" data-open=${String(open)} style="margin-left: auto; display: flex;">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
        </span>
      </button>
      ${open &&
      html`
        <div class="satu-sublist">
          ${sessions.map(
            (s) => html`
              <div class="satu-subrow" key=${s.id}>
                <button
                  type="button"
                  class="satu-subitem"
                  title=${s.title}
                  aria-current=${String(sessionOf(path)?.id === s.id)}
                  onClick=${() => ctx.router.go(`/chat/${s.id}`)}
                >${s.title}</button>
              </div>
            `,
          )}
          ${!sessions.length && html`<div class="satu-subitem" style="cursor: default;">${t('还没有对话', 'No chats yet')}</div>`}
        </div>
      `}
    <//>
  `
}

export default {
  name: 'satu-chat',
  inject: ['slots', 'host', 'router'],
  apply(ctx) {
    ctx.plugin(Sessions)
    // 位置由布局插件声明，两个插件谁先挂上不确定——所以等它，而不是假设它在。
    ctx.slots.inject(['header.actions'], function* () {
      yield ctx.slots.register({ name: 'header.actions', id: 'chat.header' }, ChatHeaderActions)
    })

    ctx.slots.inject(['sidebar.nav.main', 'main'], function* () {
      yield ctx.slots.register({ name: 'sidebar.nav.main', id: 'chat.new' }, NewChatNav)
      yield ctx.slots.register({ name: 'sidebar.nav.main', id: 'chat.history', priority: 20 }, HistoryNav)
      // 两屏各自认领各自的地址，而不是一个组件里再分支——它们的数据来源、
      // 生命周期都不一样，合在一起只会让「现在到底在哪一屏」变成一个状态。
      yield ctx.slots.register(
        { name: 'main', id: 'chat.new', select: (path) => (path === '/' ? { title: t('新建对话', 'New chat') } : null) },
        NewChatPage,
      )
      yield ctx.slots.register(
        {
          name: 'main',
          id: 'chat.session',
          select: (path) => {
            const target = sessionOf(path)
            return target && !target.log ? { title: t('会话', 'Chat'), sessionId: target.id } : null
          },
        },
        ConversationPage,
      )
      yield ctx.slots.register(
        {
          name: 'main',
          id: 'chat.log',
          select: (path) => {
            const target = sessionOf(path)
            return target?.log
              ? { title: t('调用链路', 'Trace'), sessionId: target.id, back: { to: `/chat/${target.id}`, label: t('返回对话', 'Back to chat') } }
              : null
          },
        },
        CallLogPage,
      )
    })
  },
}
