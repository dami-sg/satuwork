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
    // 已放弃这一列没有东西就整列不画：它是收尾档，空着摆在那儿只占地方。
    if (key === 'dropped' && !rows.length) return ''
    return `<div class="satu-task-col" data-drop="${key}">
      <div class="satu-task-colhead">${t(zh, en)}<span>${counts[key] || rows.length}</span></div>
      ${rows.map((x) => taskChip(x, bots)).join('') || `<div class="satu-task-empty">—</div>`}
    </div>`
  }
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('任务看板', 'Task board')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">
            ${t(
              '这里的每一条都是从你和 Bot 的对话里总结出来的。改状态、改标题、删掉都行——你改过的，它不会再改回去。',
              'Every item here is summarised from your conversations with your bots. Edit or delete freely — what you change stays changed.',
            )}
          </p>
        </div>
        ${flashes()}
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${filters}</div>
        <div class="satu-task-cols">${TASK_COLS.map(col).join('')}</div>
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
    ${taskModal()}`
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

/** 拉一屏。**拉不到就保持上一份**：一块突然空掉的板会让人以为任务都没了。 */
async function loadTasks() {
  if (!state.me || !state.me.account) return
  try {
    const q = state.taskBot ? `?bot=${encodeURIComponent(state.taskBot)}` : ''
    const data = await api('GET', `/tasks${q}`)
    state.tasks = Array.isArray(data.tasks) ? data.tasks : []
    state.taskCounts = data.counts || {}
  } catch {
    /* 保持上一份 */
  }
}

async function loadTask(id) {
  const data = await api('GET', `/tasks/${encodeURIComponent(id)}`)
  state.taskOpen = data
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
  if (state.path !== '/tasks' || document.hidden) return
  taskTimer = setTimeout(async () => {
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
  if (!root) return
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
