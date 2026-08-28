/**
 * 多 Bot 看板（见 docs/kanban.md §16）。
 *
 * 三屏：板列表、一块板、一张卡。数据全来自 Gateway 那几张表——板要横跨这个人的全部
 * 席位，而那些卡分散在好几条会话上。
 *
 * **只有板的主人看得见**（口径〇）：接口那侧对别人一律 404，这一页照着接口回的东西画，
 * 不自己判权限——两处各判一次的话，迟早有一处判错，而判错的那次是静默的。
 *
 * **拖拽换状态不做**（Hermes 有）。板上的状态是**算出来的**，不是人摆出来的：
 * `todo → ready` 由依赖决定，`ready → running` 由调度器决定。给一个能拖的界面，等于
 * 承诺一件做不到的事——人把一张 todo 拖进 running，我们能做的只有把它拒回去。人能做的
 * 动作是按钮：解锁、打回、撤销、改派、停止。
 */

/** 一张卡现在算哪一态，说给人听。列表上要一眼扫过。 */
function cardStateTag(c) {
  if (c.state === 'running') return `<span class="tag tag-accent">${t('在跑', 'Running')}</span>`
  if (c.state === 'ready') return `<span class="tag tag-accent-2">${t('待派', 'Ready')}</span>`
  if (c.state === 'todo') return `<span class="tag tag-neutral">${t('等依赖', 'Waiting')}</span>`
  if (c.state === 'blocked') return `<span class="tag tag-warn">${t('卡住了', 'Blocked')}</span>`
  if (c.state === 'done') return `<span class="tag tag-neutral">${t('做完了', 'Done')}</span>`
  return `<span class="tag tag-neutral">${esc(c.state)}</span>`
}

/**
 * 档位那一行小字。
 *
 * **理由要跟着档位一起显示**：光一个 `utility` 人判不出选得对不对，配上「格式定死、
 * 漏一行一眼能看见」当场就判得出来。降过级的要标出来，否则人会以为那一档是模型选的。
 */
function cardModelLine(c) {
  if (!c.modelReason && !c.modelDowngraded) return ''
  const down = c.modelDowngraded ? t('（降下来的，不是它选的）', ' (downgraded)') : ''
  return `<div class="satu-kanban-why">${esc(c.modelRole)}${esc(down)} · ${esc(c.modelReason || '')}</div>`
}

/** 板上那一列里的一张卡。 */
function cardChip(c, bots) {
  const who = c.assigneeBotId ? bots.get(c.assigneeBotId) || c.assigneeBotId : t('没人认领', 'unassigned')
  const stuck = c.state === 'blocked' && c.blockedReason ? `<div class="satu-kanban-why">${esc(c.blockedReason)}</div>` : ''
  return `<button type="button" class="satu-kanban-card" data-act="kanban-card" data-id="${esc(c.id)}">
    <div class="satu-kanban-title">${esc(c.title || t('（没写标题）', '(untitled)'))}</div>
    <div class="satu-kanban-meta">${esc(who)}</div>
    ${cardModelLine(c)}
    ${stuck}
  </button>`
}

/** 板列表：我的板，每块带一个「要人管的有几张」。 */
function kanbanListPage() {
  const boards = state.kanbanBoards || []
  const rows = boards.length
    ? boards
        .map((b) => {
          const n = b.counts || {}
          const bits = [
            n.running ? t(`${n.running} 张在跑`, `${n.running} running`) : '',
            n.ready ? t(`${n.ready} 张待派`, `${n.ready} ready`) : '',
            n.blocked ? `<strong>${t(`${n.blocked} 张要人管`, `${n.blocked} need you`)}</strong>` : '',
          ].filter(Boolean)
          return `<button type="button" class="satu-kanban-boardrow" data-act="kanban-board" data-id="${esc(b.id)}">
            <span class="satu-kanban-boardname">${esc(b.name || t('（没起名字）', '(unnamed)'))}</span>
            <span class="satu-kanban-boardmeta">${bits.join(' · ') || t('板上还没有卡', 'no cards yet')}</span>
          </button>`
        })
        .join('')
    : `<p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t(
        '还没有板。一块板 = 你名下几颗 Bot 共用的一份待办清单：写下要做的事、指给某颗 Bot，它到点自己会去做。',
        'No boards yet. A board is a shared to-do list for your own bots.',
      )}</p>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('看板', 'Boards')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t(
            '你名下的几颗 Bot 共用的待办。卡跑完结论写在卡上——浏览器关着也照跑。',
            'Shared to-do lists across your own bots. Cards run whether or not this page is open.',
          )}</p>
        </div>
        ${flashes()}
        <form data-act="kanban-new-board" style="display: flex; gap: var(--space-2); flex-wrap: wrap;">
          <input class="input" name="name" placeholder="${esc(t('新板叫什么', 'New board name'))}" style="max-width: 260px;" />
          <button type="submit" class="btn btn-secondary">${t('建一块板', 'New board')}</button>
        </form>
        <div class="satu-kanban-boards">${rows}</div>
      </div>
    </div>`
}

/** 一块板：按状态分列。`todo` 收在折叠区里——它们不需要任何人做决定。 */
function kanbanBoardPage() {
  const d = state.kanbanBoard
  if (!d) return `<div class="gw-page"><div class="gw-page-inner">${t('正在打开…', 'Opening…')}</div></div>`
  const bots = new Map((d.members || []).map((m) => [m.botId, m.name || m.botId]))
  const cards = d.cards || []
  const col = (key, label) => {
    const list = cards.filter((c) => c.state === key)
    return `<div class="satu-kanban-col">
      <div class="satu-kanban-colhead">${label}<span>${list.length}</span></div>
      ${list.map((c) => cardChip(c, bots)).join('') || `<div class="satu-kanban-empty">—</div>`}
    </div>`
  }
  const waiting = cards.filter((c) => c.state === 'todo')
  const members = (d.members || [])
    .map((m) => `${esc(m.name || m.botId)}${m.role ? `（${esc(m.role)}）` : ''}`)
    .join('、')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <button type="button" class="btn btn-ghost" data-act="go" data-href="/kanban">${t('← 所有板', '← All boards')}</button>
          <h1 style="font-size: 24px; margin: 8px 0 4px;">${esc(d.board.name || t('（没起名字）', '(unnamed)'))}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(d.board.brief || '')}</p>
          <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted-foreground);">${t('板上的 Bot：', 'Bots: ')}${members || t('还没加人', 'none yet')}</p>
        </div>
        ${flashes()}
        <form data-act="kanban-new-card" data-board="${esc(d.board.id)}" style="display: flex; gap: var(--space-2); flex-wrap: wrap; align-items: center;">
          <input class="input" name="title" placeholder="${esc(t('要做的一件事', 'Something to do'))}" style="flex: 1; min-width: 220px;" />
          <select class="input" name="assignee" style="max-width: 180px;">
            <option value="">${esc(t('交给哪颗 Bot', 'Assign to'))}</option>
            ${(d.members || []).map((m) => `<option value="${esc(m.botId)}">${esc(m.name || m.botId)}</option>`).join('')}
          </select>
          <button type="submit" class="btn btn-secondary">${t('开一张卡', 'Add card')}</button>
        </form>
        <div class="satu-kanban-cols">
          ${col('ready', t('待派', 'Ready'))}
          ${col('running', t('在跑', 'Running'))}
          ${col('blocked', t('要人管', 'Needs you'))}
          ${col('done', t('做完了', 'Done'))}
        </div>
        ${
          waiting.length
            ? `<details><summary style="cursor: pointer; font-size: 13px; color: var(--muted-foreground);">${t(
                `等依赖的 ${waiting.length} 张`,
                `${waiting.length} waiting on dependencies`,
              )}</summary><div class="satu-kanban-cols">${waiting.map((c) => cardChip(c, bots)).join('')}</div></details>`
            : ''
        }
      </div>
    </div>`
}

/** 一张卡：正文 + 依赖 + 一条时间线（评论和系统行混排）+ 每次跑的流水。 */
function kanbanCardPage() {
  const d = state.kanbanCard
  if (!d) return `<div class="gw-page"><div class="gw-page-inner">${t('正在打开…', 'Opening…')}</div></div>`
  const c = d.card
  const line = (x) =>
    `<li class="${x.kind === 'system' ? 'satu-kanban-sys' : ''}"><span>${esc(x.authorBotId || (x.kind === 'system' ? '' : t('我', 'me')))}</span>${esc(x.body)}</li>`
  const runRow = (r) =>
    `<li>${t(`第 ${r.attempt + 1} 次`, `try ${r.attempt + 1}`)} · ${esc(r.status)}${r.steps ? ` · ${r.steps} ${t('步', 'steps')}` : ''}${
      r.error ? ` · ${esc(r.error)}` : ''
    }${r.sessionId ? ` · <a href="#" data-act="kanban-open-run" data-id="${esc(r.sessionId)}">${t('看过程', 'transcript')}</a>` : ''}</li>`
  /**
   * `running` 的卡只有「停止」一颗按钮，停完了才出现「撤销」。
   *
   * 撤一张正在跑的卡而不掐掉那一轮，留下的是一个没人认领的进程（同 delegation §7.3）。
   */
  const acts =
    c.state === 'running'
      ? `<button type="button" class="btn btn-ghost" data-act="kanban-abort" data-id="${esc(c.id)}">${t('停止', 'Stop')}</button>`
      : [
          c.state === 'blocked'
            ? `<button type="button" class="btn btn-primary" data-act="kanban-unblock" data-id="${esc(c.id)}">${t('我处理好了，接着跑', 'Unblock')}</button>`
            : '',
          c.state === 'done'
            ? `<button type="button" class="btn btn-ghost" data-act="kanban-reopen" data-id="${esc(c.id)}">${t('打回重做', 'Reopen')}</button>`
            : '',
          c.state === 'done'
            ? `<button type="button" class="btn btn-ghost" data-act="kanban-archive" data-id="${esc(c.id)}">${t('归档', 'Archive')}</button>`
            : '',
          c.state === 'cancelled' || c.state === 'archived'
            ? ''
            : `<button type="button" class="btn btn-ghost" data-act="kanban-cancel" data-id="${esc(c.id)}">${t('撤销', 'Cancel')}</button>`,
        ]
          .filter(Boolean)
          .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <button type="button" class="btn btn-ghost" data-act="kanban-board" data-id="${esc(c.boardId)}">${t('← 回到板上', '← Back to board')}</button>
        <div>
          <h1 style="font-size: 22px; margin: 8px 0 4px;">${esc(c.title)}</h1>
          <div style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">${cardStateTag(c)}${cardModelLine(c)}</div>
        </div>
        ${flashes()}
        ${c.body ? `<div class="satu-kanban-body">${esc(c.body)}</div>` : ''}
        ${c.blockedReason ? `<div class="satu-kanban-body"><strong>${t('卡在：', 'Stuck: ')}</strong>${esc(c.blockedReason)}</div>` : ''}
        ${c.summary ? `<div class="satu-kanban-body"><strong>${t('结论：', 'Result: ')}</strong>${esc(c.summary)}</div>` : ''}
        <div style="display: flex; gap: var(--space-2); flex-wrap: wrap;">${acts}</div>
        ${
          (d.parents || []).length
            ? `<div><strong style="font-size: 13px;">${t('要等这几张', 'Waits on')}</strong><ul class="satu-kanban-line">${d.parents
                .map((p) => `<li><a href="#" data-act="kanban-card" data-id="${esc(p.id)}">${esc(p.title)}</a> · ${esc(p.state)}</li>`)
                .join('')}</ul></div>`
            : ''
        }
        <form data-act="kanban-comment" data-id="${esc(c.id)}" style="display: flex; gap: var(--space-2);">
          <input class="input" name="body" placeholder="${esc(t('留一句话——做这张卡的 Bot 开工时读得到', 'Leave a note — the bot reads it before starting'))}" style="flex: 1;" />
          <button type="submit" class="btn btn-secondary">${t('留言', 'Comment')}</button>
        </form>
        <div><strong style="font-size: 13px;">${t('这张卡发生过什么', 'Timeline')}</strong><ul class="satu-kanban-line">${(d.timeline || [])
          .map(line)
          .join('')}</ul></div>
        ${
          (d.runs || []).length
            ? `<div><strong style="font-size: 13px;">${t('跑过几次', 'Runs')}</strong><ul class="satu-kanban-line">${d.runs.map(runRow).join('')}</ul></div>`
            : ''
        }
      </div>
    </div>`
}

function kanbanPage() {
  if (state.kanbanCardId) return kanbanCardPage()
  if (state.kanbanBoardId) return kanbanBoardPage()
  return kanbanListPage()
}

/**
 * 拉数据。三屏各拉各的（见 state.kanbanBoards 那段注释）。
 *
 * **拉不到就保持上一份，不清零**：一块突然空掉的板会让人以为卡都没了。
 */
async function loadKanban() {
  if (!state.me || !state.me.account || !state.me.account.companyId) return
  try {
    const data = await api('GET', '/kanban/boards')
    state.kanbanBoards = Array.isArray(data.boards) ? data.boards : []
    state.kanbanBlocked = Number(data.blocked) || 0
    paintHandoffBadge()
  } catch {
    /* 保持上一份 */
  }
}

async function loadKanbanBoard(id) {
  const data = await api('GET', `/kanban/boards/${encodeURIComponent(id)}`)
  state.kanbanBoard = data
  state.kanbanBoardId = id
  state.kanbanCardId = ''
  state.kanbanCard = null
}

async function loadKanbanCard(id) {
  const data = await api('GET', `/kanban/cards/${encodeURIComponent(id)}`)
  state.kanbanCard = data
  state.kanbanCardId = id
}

/**
 * 这一屏上有没有正在跑的东西。轮询的快慢全看它。
 *
 * 三条规矩全部抄自[日常任务详情页那次教训](../../docs/routines.md §7)：
 *
 * 1. **有 running 才转得快**（5 秒），没有就退到 30 秒；页面藏起来就停。不然一个开着
 *    的标签页会永远每五秒一个请求
 * 2. **问完了没变化就一下都不画**（下面那个 shot）。`render()` 是整页重绘，而板页上
 *    正被人编辑的那个输入框会跟着被换掉
 * 3. 表单收在 submit 上，不是 input——理由同上
 */
function kanbanHasRunning() {
  if (state.kanbanCard) return state.kanbanCard.card.state === 'running'
  if (state.kanbanBoard) return (state.kanbanBoard.cards || []).some((c) => c.state === 'running')
  return (state.kanbanBoards || []).some((b) => (b.counts || {}).running)
}

/** 这一屏现在长什么样，压成一个字符串。变了才画。 */
function kanbanShot() {
  if (state.kanbanCard) return JSON.stringify(state.kanbanCard)
  if (state.kanbanBoard) return JSON.stringify(state.kanbanBoard)
  return JSON.stringify(state.kanbanBoards)
}

let kanbanTimer = 0
function kanbanPoll() {
  clearTimeout(kanbanTimer)
  if (state.path !== '/kanban' || document.hidden) return
  const wait = kanbanHasRunning() ? 5000 : 30_000
  kanbanTimer = setTimeout(async () => {
    const before = kanbanShot()
    try {
      if (state.kanbanCardId) await loadKanbanCard(state.kanbanCardId)
      else if (state.kanbanBoardId) await loadKanbanBoard(state.kanbanBoardId)
      else await loadKanban()
    } catch {
      /* 保持上一份 */
    }
    if (kanbanShot() !== before) render()
    kanbanPoll()
  }, wait)
}

/**
 * 建板、建卡、留言：三个表单一条路。
 *
 * **收在 submit 上，不是 input**：保存要 render（那一列、计数都跟着变），而 render 会
 * 把输入框换掉——边打边存等于每敲一个字丢一次焦点（同日常任务详情页那次）。
 */
async function submitKanban(e, kind) {
  e.preventDefault()
  const form = e.target
  const data = new FormData(form)
  try {
    if (kind === 'kanban-new-board') {
      const name = String(data.get('name') || '').trim()
      if (!name) return
      const out = await api('POST', '/kanban/boards', { name })
      await loadKanban()
      await loadKanbanBoard(out.board.id)
    } else if (kind === 'kanban-new-card') {
      const title = String(data.get('title') || '').trim()
      if (!title) return
      const boardId = form.getAttribute('data-board') || ''
      await api('POST', `/kanban/boards/${encodeURIComponent(boardId)}/cards`, {
        title,
        assigneeBotId: String(data.get('assignee') || ''),
      })
      await loadKanbanBoard(boardId)
    } else {
      const body = String(data.get('body') || '').trim()
      if (!body) return
      const id = form.getAttribute('data-id') || ''
      await api('POST', `/kanban/cards/${encodeURIComponent(id)}/comments`, { body })
      await loadKanbanCard(id)
    }
    form.reset()
    render()
    kanbanPoll()
  } catch (err) {
    flash('err', (err && err.message) || t('这一下没成', 'That did not go through'))
  }
}
