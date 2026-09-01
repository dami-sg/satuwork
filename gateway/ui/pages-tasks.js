/**
 * 任务看板（见 docs/task-board.md §10）。
 *
 * **一屏，不是三屏。** 板列表和卡详情页都随执行面一起删了：任务是从对话里抽出来的，
 * 没有任何人能选它落在哪块板上，「板」那一层就是个恒等映射。
 *
 * 人在这一屏上能做的动作只有四个：**改状态、改标题、删除、打开原对话**。没有「派给
 * 谁」「重跑」「解锁」——那些是执行面的按钮，而执行面没了（不变量 1）。
 *
 * **拖拽换状态这一版做**（和上一版相反）。上一版不做的理由是「状态是算出来的，给一个能
 * 拖的界面等于承诺一件做不到的事」；这一版的状态是**判断**——模型的判断，人随时可以纠正，
 * 而纠正过的字段抽取器不再覆盖。拖一下正是那个纠正动作最短的写法。
 */

/** 四列的顺序和名字。**已放弃排在最后**：它是收尾档，不是日常要扫的那三列。 */
const TASK_COLS = [
  ['proposed', '提案', 'Proposed'],
  ['doing', '进行中', 'In progress'],
  ['done', '完成', 'Done'],
  ['dropped', '已放弃', 'Dropped'],
]

/** 这条任务上次真的动过是多久以前。超过一周换回绝对时刻——「9 天前」不回答任何问题。 */
function taskAgo(ms) {
  if (!ms) return ''
  const d = Date.now() - ms
  if (d < 60000) return t('刚刚', 'just now')
  const min = Math.floor(d / 60000)
  if (min < 60) return t(`${min} 分钟前`, `${min} min ago`)
  const hr = Math.floor(min / 60)
  if (hr < 24) return t(`${hr} 小时前`, `${hr} h ago`)
  const day = Math.floor(hr / 24)
  if (day < 7) return t(`${day} 天前`, `${day} d ago`)
  return fmtTime(ms)
}

/**
 * 「停滞 N 天」。
 *
 * **只是显示，不改状态**（§5 规矩 3）：自动改掉的话，板上会出现一批没有任何人做过决定
 * 的状态。按 `stateAt` 算，不按 `updatedAt`——抽取器每把 `lastSeq` 往后推一次都会动
 * `updatedAt`，那样没有一条任务显得停滞过。
 */
const TASK_STALE_MS = 7 * 24 * 3600 * 1000
function taskStale(x) {
  if (x.state !== 'doing') return ''
  const d = Date.now() - (x.stateAt || 0)
  if (d < TASK_STALE_MS) return ''
  return t(`停滞 ${Math.floor(d / 86400000)} 天`, `stalled ${Math.floor(d / 86400000)} d`)
}

/** 人碰过的字段标一下：告诉他「这一格模型不会再改回去」。 */
function taskHumanMark(x) {
  return (x.humanFields || []).length ? `<span class="satu-task-human" title="${esc(t('你改过的字段，抽取器不会再覆盖', 'You edited this; the extractor will not overwrite it'))}">✎</span>` : ''
}

/** 板上一张任务。**可拖**——拖进另一列就是把状态改成那一档。 */
function taskChip(x, bots) {
  const who = bots.get(x.botId) || x.botId
  const stale = taskStale(x)
  return `<button type="button" class="satu-task-card" draggable="true" data-act="task-open" data-id="${esc(x.id)}">
    <div class="satu-task-title">${esc(x.title)}${taskHumanMark(x)}</div>
    <div class="satu-task-meta">
      <span>${esc(who)}</span>
      <time data-at="${x.stateAt || x.createdAt || 0}" title="${esc(fmtTime(x.stateAt || x.createdAt || 0))}">${esc(taskAgo(x.stateAt || x.createdAt))}</time>
    </div>
    ${x.summary ? `<div class="satu-task-why">${esc(x.summary)}</div>` : ''}
    ${stale ? `<div class="satu-task-stale">${esc(stale)}</div>` : ''}
  </button>`
}

/**
 * 这一屏。
 *
 * 顶上一行是「哪颗 Bot」的过滤——一个人名下几颗 Bot 各干各的，混在一起扫不动。
 */
function tasksPage() {
  const list = state.tasks || []
  const counts = state.taskCounts || {}
  const bots = new Map((state.runtimeBots || []).map((b) => [b.id, b.name || b.id]))
  const picked = state.taskBot || ''
  const chip = (id, label) =>
    `<button type="button" class="satu-assignee" aria-pressed="${String(picked === id)}" data-act="task-bot" data-id="${esc(id)}" style="padding: 5px 12px;">${esc(label)}</button>`
  const filters = [chip('', t('全部 Bot', 'All bots')), ...(state.runtimeBots || []).map((b) => chip(b.id, b.name || b.id))].join('')
  const col = ([key, zh, en]) => {
    const rows = list.filter((x) => x.state === key)
    // 已放弃这一列没有东西就整列不画。**除非还有没加载完的**：那时它可能只是还在后面，
    // 整列不画会让「拖到已放弃」这个动作凭空消失。
    if (key === 'dropped' && !rows.length && !state.taskCursor) return ''
    /**
     * 列头那个数**只数这一列真的画出来了几张**。
     *
     * 原来放的是服务端算的该状态总数，而卡片只有第一页——一个攒了 120 条任务的人，
     * 列头写着 78、列里只有 30 张，剩下 48 条既看不见也翻不到，他看到的是「我完成的事
     * 凭空少了一批」。总数改到下面那行「还有 N 条」上说，那儿跟着一颗加载得动的按钮。
     */
    return `<div class="satu-task-col" data-drop="${key}">
      <div class="satu-task-colhead">${t(zh, en)}<span>${rows.length}</span></div>
      ${rows.map((x) => taskChip(x, bots)).join('') || `<div class="satu-task-empty">—</div>`}
    </div>`
  }
  /** 还有多少条没画出来。四列的总数减去手上这一页。 */
  const total = TASK_COLS.reduce((n, [key]) => n + (Number(counts[key]) || 0), 0)
  const rest = Math.max(0, total - list.length)
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div class="satu-task-heading">
          <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('任务看板', 'Task board')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">
            ${t(
              '这里的每一条都是从你和 Bot 的对话里总结出来的。改状态、改标题、删掉都行——你改过的，它不会再改回去。',
              'Every item here is summarised from your conversations with your bots. Edit or delete freely — what you change stays changed.',
            )}
          </p>
          </div>
          <button type="button" class="btn btn-secondary" data-act="task-logs">${t('查看判定日志', 'View decision log')}</button>
        </div>
        ${flashes()}
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${filters}</div>
        <div class="satu-task-cols">${TASK_COLS.map(col).join('')}</div>
        ${
          state.taskCursor
            ? `<div style="display: flex; align-items: baseline; gap: var(--space-3);">
                <button type="button" class="btn btn-secondary" data-act="task-more"${state.taskMore ? ' disabled' : ''}>${
                  state.taskMore ? t('加载中…', 'Loading…') : t('加载更多', 'Load more')
                }</button>
                <span style="font-size: 13px; color: var(--muted-foreground);">${t(
                  `一共 ${total} 条，还有 ${rest} 条没显示`,
                  `${total} in total, ${rest} not shown`,
                )}</span>
              </div>`
            : ''
        }
        ${
          list.length
            ? ''
            : `<p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t(
                '还没有任何任务。和 Bot 说点要办的事，办过的会自己出现在这儿。',
                'Nothing yet. Ask a bot to get something done and it will show up here.',
              )}</p>`
        }
      </div>
    </div>
    ${taskModal()}${taskLogModal()}`
}

const TASK_LOG_LABELS = {
  tasks_created: ['创建了任务', 'Tasks created'],
  tasks_updated: ['更新了已有任务', 'Existing tasks updated'],
  existing_unchanged: ['已有任务没有变化', 'Existing tasks unchanged'],
  model_no_task: ['模型判断没有符合规则的任务', 'Model found no qualifying task'],
  invalid_model_tasks: ['模型结果未通过字段校验', 'Model output failed validation'],
  no_user_request: ['没有读到用户提出的要求', 'No user request was found'],
  read_only_short: ['仅查询 / 读取，未达到建任务条件', 'Read-only query did not qualify'],
  utility_model_missing: ['未配置任务抽取模型', 'Task extraction model is not configured'],
  gateway_unavailable: ['任务服务暂时不可用', 'Task service was unavailable'],
  gateway_rejected: ['任务服务拒绝了这次结果', 'Task service rejected the result'],
  extract_failed: ['任务抽取失败', 'Task extraction failed'],
}

function taskLogText(x) {
  const pair = TASK_LOG_LABELS[x.reason]
  let label = pair ? t(pair[0], pair[1]) : (x.detail || x.reason)
  if (x.reason === 'tasks_created' && x.createdCount) label += t(`（${x.createdCount} 条）`, ` (${x.createdCount})`)
  if (x.reason === 'tasks_updated' && x.updatedCount) label += t(`（${x.updatedCount} 条）`, ` (${x.updatedCount})`)
  return label
}

function taskLogModal() {
  if (!state.taskLogsOpen) return ''
  const bots = new Map((state.runtimeBots || []).map((b) => [b.id, b.name || b.id]))
  const rows = (state.taskLogs || []).map((x) => {
    const span = x.fromSeq || x.toSeq ? `seq ${x.fromSeq || '?'}–${x.toSeq || '?'}` : ''
    return `<li class="satu-task-log" data-outcome="${esc(x.outcome)}">
      <span class="satu-task-log-dot" aria-hidden="true"></span>
      <div class="satu-task-log-body">
        <div><b>${esc(taskLogText(x))}</b><time>${esc(fmtTime(x.createdAt))}</time></div>
        ${x.detail && !['tasks_created', 'tasks_updated'].includes(x.reason) ? `<p>${esc(x.detail)}</p>` : ''}
        <small>${esc(bots.get(x.botId) || x.botId)} · ${esc(span)}${x.model ? ` · ${esc(x.model)}` : ''}</small>
      </div>
    </li>`
  }).join('')
  return `<div class="gw-modal-backdrop" data-act="task-log-close">
    <div class="gw-modal" style="max-width: 680px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div class="satu-task-log-head">
        <div><h2>${t('任务判定日志', 'Task decision log')}</h2>
        <p>${t('记录每次为什么创建、更新或不创建任务；不保存对话正文。', 'Shows why tasks were created, updated, or skipped. Conversation text is not stored.')}</p></div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="task-log-close">${svg(TASK_CLOSE_ICON, 16)}</button>
      </div>
      ${state.taskLogsLoading
        ? `<p class="satu-task-empty">${t('加载中…', 'Loading…')}</p>`
        : rows
          ? `<ul class="satu-task-logs">${rows}</ul>`
          : `<p class="satu-task-empty">${t('还没有判定日志。新对话结束后会在这里留下创建或不创建的原因。', 'No decision logs yet. New conversations will leave a create-or-skip reason here.')}</p>`}
    </div>
  </div>`
}

/**
 * 一条任务的详情。
 *
 * **弹窗而不是一屏**：这一屏上一条任务只有五样东西（标题、摘要、凭据、时间线、原对话），
 * 撑不起一整页，而单开一页要多一套返回、多一个路由、多一处复位。
 */
function taskModal() {
  const d = state.taskOpen
  if (!d) return ''
  const x = d.task
  const bots = new Map((state.runtimeBots || []).map((b) => [b.id, b.name || b.id]))
  const stateBtn = ([key, zh, en]) =>
    `<button type="button" class="btn ${x.state === key ? 'btn-primary' : 'btn-secondary'}" data-act="task-state" data-id="${esc(x.id)}" data-state="${key}">${t(zh, en)}</button>`
  const line = (e) => {
    const who = e.kind === 'human' ? t('你', 'You') : t('自动识别', 'Auto')
    const move = e.fromState ? `${esc(e.fromState)} → ${esc(e.toState || '')}` : t(`认出这件事（${e.toState || ''}）`, `spotted (${e.toState || ''})`)
    return `<li><span class="satu-task-evtext"><b>${esc(who)}</b>${move}${e.note ? ` · ${esc(e.note)}` : ''}</span><time>${esc(fmtTime(e.createdAt))}</time></li>`
  }
  return `<div class="gw-modal-backdrop" data-act="task-close">
    <div class="gw-modal" style="max-width: 560px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3);">
        <div style="flex: 1; min-width: 0;">
          ${/* 标题**收在 change 上，不是 input**：保存要 render，而 render 会把输入框换掉
                ——边打边存等于每敲一个字丢一次焦点（同日常任务详情页那次教训）。 */ ''}
          <input class="input" value="${esc(x.title)}" data-act="task-title" data-id="${esc(x.id)}" aria-label="${esc(t('任务标题', 'Task title'))}">
          <p style="margin: 6px 0 0; font-size: 13px; color: var(--muted-foreground);">
            ${esc(bots.get(x.botId) || x.botId)} · ${esc(fmtTime(x.stateAt || x.createdAt))}
          </p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="task-close">${svg(TASK_CLOSE_ICON, 16)}</button>
      </div>
      ${x.summary ? `<p style="margin: 0; font-size: 14px; line-height: 1.7;">${esc(x.summary)}</p>` : ''}
      ${
        x.evidence
          ? `<p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('凭据：', 'Evidence: ')}${esc(x.evidence)}</p>`
          : ''
      }
      <div class="satu-task-acts">${TASK_COLS.map(stateBtn).join('')}</div>
      ${
        (d.events || []).length
          ? `<ul class="satu-task-line">${d.events.map(line).join('')}</ul>`
          : ''
      }
      <div class="satu-task-acts" style="justify-content: space-between;">
        ${/* 「看原话」跳这颗 Bot 的对话。**摘要是模型写的，错了只有原文能纠**——
              没有这条路，人手上就只剩模型的一面之词。 */ ''}
        <button type="button" class="btn btn-secondary" data-act="task-session" data-bot="${esc(x.botId)}">${t('打开这段对话', 'Open the conversation')}</button>
        <button type="button" class="btn btn-ghost" data-act="task-delete" data-id="${esc(x.id)}">${t('删掉这条', 'Delete')}</button>
      </div>
    </div>
  </div>`
}

// 名字带前缀：这些脚本是普通 <script>，顶层 const 共享同一个全局作用域，撞名会把整个
// 文件炸掉（表现是「别的页面都好，只有这一页整页空白」）。
const TASK_CLOSE_ICON = ['M18 6 6 18', 'M6 6l12 12']

/**
 * 拉一屏。**拉不到就保持上一份**：一块突然空掉的板会让人以为任务都没了。
 *
 * `more` = 接着上一页往下拉（keyset 游标），拉到的**追加**在后面。轮询走的是不带 more
 * 的那条，它把整份换掉——已经翻开的几页会缩回第一页，这是有意的：轮询要的是「现在是什么
 * 样」，而不是把一个越滚越长的列表永远留在内存里。
 */
async function loadTasks({ more } = {}) {
  if (!state.me || !state.me.account) return
  try {
    const q = []
    if (state.taskBot) q.push(`bot=${encodeURIComponent(state.taskBot)}`)
    if (more && state.taskCursor) q.push(`cursor=${encodeURIComponent(state.taskCursor)}`)
    const data = await api('GET', `/tasks${q.length ? `?${q.join('&')}` : ''}`)
    const rows = Array.isArray(data.tasks) ? data.tasks : []
    state.tasks = more ? [...state.tasks, ...rows] : rows
    state.taskCounts = data.counts || {}
    state.taskCursor = data.cursor || ''
  } catch {
    /* 保持上一份 */
  }
}

async function loadTask(id) {
  const data = await api('GET', `/tasks/${encodeURIComponent(id)}`)
  state.taskOpen = data
}

async function loadTaskLogs() {
  const q = state.taskBot ? `?bot=${encodeURIComponent(state.taskBot)}` : ''
  const data = await api('GET', `/tasks/logs${q}`)
  state.taskLogs = Array.isArray(data.logs) ? data.logs : []
}

/** 这一屏现在长什么样，压成一个字符串。变了才画（见 tasksPoll）。 */
function taskShot() {
  return JSON.stringify([state.tasks, state.taskOpen])
}

/**
 * 轮询。
 *
 * 三条规矩照抄[日常任务详情页那次教训](../../docs/routines.md)：
 *
 * 1. **30 秒一次，页面藏起来就停。** 这一版没有「在跑」这回事——抽取是轮末去抖过的，
 *    本来就落后一两分钟，5 秒那一档在这儿只是白刷
 * 2. **问完了没变化就一下都不画**：`render()` 是整页重绘，弹窗里正被人编辑的标题输入框
 *    会跟着被换掉
 * 3. 标题**收在 change 上，不是 input**（见 taskModal 里那句）
 */
let taskTimer = 0
function tasksPoll() {
  clearTimeout(taskTimer)
  if (state.path !== '/tasks') return
  taskTimer = setTimeout(async () => {
    /**
     * **判据在这儿再走一遍，不能只在排的时候判。**
     *
     * 排下去和真的响之间隔着 30 秒，人早走开了：照「只在排的时候判」写的话，这一响
     * 仍然会去打一次接口、还可能 render() 整页——而人此刻正站在别的页上填表单，输入框
     * 当场被换掉。e2e 里更狠：那一响落在下一个套件中间，而它拿到的是一个连
     * querySelectorAll 都没有的 DOM 垫片，未捕获的异常直接把整个 node 进程带走
     * （整场 e2e 停在那儿，剩下十几个套件根本没跑）。
     */
    if (state.path !== '/tasks') return
    /**
     * 标签页在后台：**只重排，不请求**。
     *
     * `return` 掉的话这条轮询就此永远停了——人切回来看到的是一屏他离开时的样子，而且
     * 再也不会自己变。空转一次的代价只有一个定时器，浏览器还会把后台的定时器节流到
     * 分钟级。
     */
    if (document.hidden) return tasksPoll()
    const before = taskShot()
    try {
      await loadTasks()
      if (state.taskOpen) await loadTask(state.taskOpen.task.id).catch(() => {})
    } catch {
      /* 保持上一份 */
    }
    // 数据没变就只刷时刻，不整页重画（「3 分钟前」是拿 Date.now() 算的，一个字节的
    // 数据都不依赖——不刷的话它永远停在打开那一刻）。
    if (taskShot() !== before) render()
    else paintTaskTimes()
    tasksPoll()
  }, 30_000)
}

function paintTaskTimes() {
  const root = document.getElementById('app')
  // 拿不到、或者拿到的是个查不了的壳（e2e 那层 DOM 垫片）：这一笔不画。它只是把
  // 「3 分钟前」刷新一下，值不上为它抛一个没人接的异常。
  if (!root || typeof root.querySelectorAll !== 'function') return
  for (const el of root.querySelectorAll('.satu-task-card time[data-at]')) {
    el.textContent = taskAgo(Number(el.getAttribute('data-at')) || 0)
  }
}

/**
 * 改一条任务：状态、标题，都走这一条。
 *
 * 服务端会把改过的字段记进 `humanFields`，从此抽取器绕开它们——所以这里**改完要把整条
 * 重新拉回来**，不能只在本地改一个字段：那面「你改过」的小旗子是服务端给的。
 */
async function patchTask(id, patch) {
  try {
    await api('PATCH', `/tasks/${encodeURIComponent(id)}`, patch)
    await loadTasks()
    if (state.taskOpen && state.taskOpen.task.id === id) await loadTask(id)
    render()
    tasksPoll()
  } catch (err) {
    flash('err', (err && err.message) || t('这一下没成', 'That did not go through'))
  }
}

/**
 * 拖到另一列 = 把状态改成那一档。
 *
 * 每一列都收得下（和上一版只有「待派」收得下相反）：这一版的四档全是**判断**，人有权
 * 把任何一条挪到任何一档，包括模型永远不会给的 `dropped`（§5）。
 */
let taskDragId = ''
document.addEventListener('dragstart', (e) => {
  const card = e.target && e.target.closest && e.target.closest('.satu-task-card')
  if (!card) return
  taskDragId = card.getAttribute('data-id')
  try {
    e.dataTransfer.setData('text/plain', taskDragId)
    e.dataTransfer.effectAllowed = 'move'
  } catch {}
})
document.addEventListener('dragover', (e) => {
  const col = e.target && e.target.closest && e.target.closest('.satu-task-col[data-drop]')
  if (!col || !taskDragId) return
  e.preventDefault()
  col.classList.add('satu-task-over')
})
document.addEventListener('dragleave', (e) => {
  const col = e.target && e.target.closest && e.target.closest('.satu-task-col[data-drop]')
  if (col) col.classList.remove('satu-task-over')
})
document.addEventListener('drop', (e) => {
  const col = e.target && e.target.closest && e.target.closest('.satu-task-col[data-drop]')
  const id = taskDragId
  if (col) col.classList.remove('satu-task-over')
  if (!col || !id) return
  e.preventDefault()
  taskDragId = ''
  const next = col.getAttribute('data-drop')
  const now = (state.tasks || []).find((x) => x.id === id)
  if (!now || now.state === next) return
  void patchTask(id, { state: next })
})
