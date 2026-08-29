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
  if (c.state === 'pending') return `<span class="tag tag-neutral">${t('待定', 'Pending')}</span>`
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

/**
 * 卡上的时刻，说成「多久以前」。
 *
 * 板上一屏几十张卡，绝对时刻得一个数字一个数字地读，而人在板前问的只有一句「这张
 * 躺了多久」。超过一周才换回绝对时刻——到那时候「9 天前」已经不回答任何问题了。
 * 绝对的那份挂在 title 上，鼠标停一下就有。
 */
function cardAgo(ms) {
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

/** 跑了多久。**秒起步**：一张 40 秒跑完的卡写「0 分钟」等于没写。 */
function cardDur(from, to) {
  if (!from || !to || to < from) return ''
  const sec = Math.round((to - from) / 1000)
  if (sec < 60) return t(`${sec} 秒`, `${sec}s`)
  const min = Math.floor(sec / 60)
  if (min < 60) return t(`${min} 分 ${sec % 60} 秒`, `${min}m ${sec % 60}s`)
  const hr = Math.floor(min / 60)
  return t(`${hr} 小时 ${min % 60} 分`, `${hr}h ${min % 60}m`)
}

/**
 * 卡上的长文（正文、结论、卡住的原因）**按 Markdown 画**。
 *
 * 这几段是模型写出来的，天生带 `**加粗**`、`- 列表`、行内代码。原来这里是 esc() 加
 * `white-space: pre-wrap`，于是星号和减号原样摊在屏幕上——一屏结论读起来像日志。
 * 渲染器就是气泡里那一份（markdown.js：原始 HTML 一律转义、链接只放行白名单协议），
 * 它没加载出来就退回纯文本，页面不会坏。
 */
function cardMd(src) {
  const s = String(src ?? '')
  if (!s.trim()) return ''
  return `<div class="sw-md satu-kanban-md">${window.satuMd ? window.satuMd.render(s) : `<p class="satu-kanban-plain">${esc(s)}</p>`}</div>`
}

/** 板上那一列里的一张卡。**待定的可拖**：拖进「待派」这一列就是把它派出去。 */
function cardChip(c, bots) {
  const who = c.assigneeBotId ? bots.get(c.assigneeBotId) || c.assigneeBotId : t('没人认领', 'unassigned')
  const stuck = c.state === 'blocked' && c.blockedReason ? `<div class="satu-kanban-why">${esc(c.blockedReason)}</div>` : ''
  const draggable = c.state === 'pending'
  /**
   * 时刻取的是**这张卡最近一次动**：在跑的取开跑那一刻（人要的是「跑了多久」），
   * 收了口的取收口那一刻，其余的取开卡那一刻。一律取 createdAt 的话，一张排了三天
   * 队、今天早上才跑完的卡，上面写着「3 天前」——而它三分钟前刚出结论。
   */
  const at = c.state === 'running' ? c.startedAt || c.createdAt : c.endedAt || c.createdAt
  return `<button type="button" class="satu-kanban-card${draggable ? ' satu-kanban-drag' : ''}" data-act="kanban-card" data-id="${esc(c.id)}"${
    draggable ? ` draggable="true" data-state="pending" title="${esc(t('拖到「待派」就开始执行', 'Drag to Ready to start'))}"` : ''
  }>
    <div class="satu-kanban-title">${esc(c.title || t('（没写标题）', '(untitled)'))}</div>
    <div class="satu-kanban-meta">
      <span>${esc(who)}</span>
      ${at ? `<time data-at="${at}" title="${esc(fmtTime(at))}">${esc(cardAgo(at))}</time>` : ''}
    </div>
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
          <button type="submit" class="btn btn-primary">${t('建一块板', 'New board')}</button>
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
  const col = (key, label, drop = false) => {
    const list = cards.filter((c) => c.state === key)
    return `<div class="satu-kanban-col"${drop ? ' data-drop="ready"' : ''}>
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
        ${/* 板名和「开一张任务卡」一行：开卡是这一屏的主动作，按钮跟标题站在同一行右端，
              和「建一块板」那颗一样用主按钮样式。 */ ''}
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${esc(d.board.name || t('（没起名字）', '(unnamed)'))}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(d.board.brief || '')}</p>
            <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted-foreground);">${t('板上的 Bot：', 'Bots: ')}${members || t('还没加人', 'none yet')}</p>
          </div>
          <button type="button" class="btn btn-primary" data-act="kanban-card-open">${t('开一张任务卡', 'New task card')}</button>
        </div>
        ${flashes()}
        <div class="satu-kanban-cols">
          ${/* 待定排在最前：开卡先落这儿，人从这里把它拖进「待派」才开始跑。 */ ''}
          ${col('pending', t('待定', 'Pending'))}
          ${col('ready', t('待派', 'Ready'), true)}
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

// 名字带前缀：这些脚本全是普通 <script>，顶层 const 共享同一个全局作用域——
// pages-bots.js 里已经有同名的 CLOSE_ICON / UPLOAD_ICON，撞名会把整个文件炸掉
// （表现是「别的页面都好，只有看板整页空白」）。
const KANBAN_CLOSE_ICON = ['M18 6 6 18', 'M6 6l12 12']
const KANBAN_UPLOAD_ICON = ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 9 5-5 5 5', 'M12 4v12']

/**
 * 「开一张任务卡」弹窗。
 *
 * 组件和「新建 Skill」是同一套（pages-bots.js 的 skillDialogView）：gw-modal 直接架在
 * form 上、右上角关闭、`.field` + `.input`、挑选用 `.satu-assignee` 药丸。不再自造
 * 控件——两扇弹窗长得不一样，人就会疑心它们不是一回事。
 *
 * **没有标题栏**：标题是 utility 模型从需求正文里总结出来的（后端建卡时生成），人只
 * 写需求——两件事别让同一个人做两遍。正文因此是这一屏的主角，输入框给到够高。
 *
 * 指派是药丸 chips 不是 `<select>`：select 画不了头像。选中态只改 DOM
 * （data-act="kanban-card-pick"），**不走 render**——一 render，正文和已选的文件就没了。
 */
function kanbanCardModal() {
  const m = state.kanbanNewCard
  if (!m) return ''
  const board = state.kanbanBoard?.board
  if (!board) return ''
  const bots = state.runtimeBots || []
  const memberIds = new Set((state.kanbanBoard?.members || []).map((x) => x.botId))
  const picked = m.assignee || ''
  const err = m.error
    ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${esc(m.error)}</div>`
    : ''
  const chip = (id, inner) =>
    `<button type="button" class="satu-assignee" style="padding: 5px 12px 5px 6px;" aria-pressed="${String(picked === id)}" data-act="kanban-card-pick" data-id="${esc(id)}">${inner}</button>`
  const botChips = [
    chip('', `<span class="satu-botpick-none" aria-hidden="true">—</span>${esc(t('暂不派发，先放着', 'Leave unassigned'))}`),
    ...bots.map((b) =>
      chip(
        b.id,
        `${botAvatar(b.icon, 20, b.origin)}<span>${esc(b.name || b.id)}</span>${
          memberIds.has(b.id) ? '' : `<em style="font-style: normal; font-size: 11px; color: var(--muted-foreground);">${esc(t('会加进这块板', 'will join'))}</em>`
        }`,
      ),
    ),
  ].join('')
  return `<div class="gw-modal-backdrop" data-act="kanban-card-close">
    <form data-act="kanban-new-card" data-board="${esc(board.id)}" class="gw-modal" style="max-width: 560px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('开一张任务卡', 'New task card')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
            ${t(`写清楚要做的事，派给一颗 Bot。标题会按需求自动生成。`, `Describe the task and assign it to a bot. The title is generated from your description.`)}
          </p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="kanban-card-close">${svg(KANBAN_CLOSE_ICON, 16)}</button>
      </div>
      <div class="field">
        <label for="kc-body">${t('任务需求', 'Requirements')}</label>
        <textarea class="input" id="kc-body" name="body" rows="10" style="border-radius: var(--radius-md); resize: vertical;" placeholder="${esc(t('写成做这张卡的 Bot 拿到手就能开工的程度：要什么、交到哪、有什么约束。', 'Write it so the bot can start right away: what to produce, where to put it, what to watch out for.'))}">${esc(m.body || '')}</textarea>
      </div>
      <div class="field">
        <label for="kc-file">${t('附件（可选）', 'Attachments (optional)')}</label>
        ${/* 一颗紧凑的小按钮，不是一整块投放区：附件在这张卡上是配角。input 带
              multiple，一次可以挑好几个。 */ ''}
        <label class="satu-drop" style="min-height: 0; flex-direction: row; justify-content: flex-start; padding: 8px var(--space-3); gap: var(--space-2);">
          <input type="file" multiple style="position: absolute; inset: 0; opacity: 0; cursor: pointer;" data-kanban-files>
          <span class="satu-dropicon" style="width: 26px; height: 26px;">${svg(KANBAN_UPLOAD_ICON, 14)}</span>
          <span style="font-size: 13px; font-weight: 600;">${t('添加附件', 'Add attachments')}</span>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('可多选，单个不超过 10 MB，随卡送到席位。', 'Multiple allowed, up to 10 MB each. They travel with the card.')}</span>
        </label>
        <p class="satu-kanban-filelist" style="margin: 6px 0 0; font-size: 12px; color: var(--muted-foreground);" hidden></p>
      </div>
      <div class="field">
        <label>${t('指派 Bot', 'Assign to')}</label>
        ${bots.length ? `<div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${botChips}</div>` : `<p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('你还没有 Bot。先在侧栏「新建 Bot」建一颗，再来开卡。', 'You have no bots yet. Create one from the sidebar first.')}</p>`}
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('不在板上的会自动加进成员，下一次开卡就能直接选。', 'Bots not on this board join it automatically and stay selectable.')}</span>
      </div>
      ${err}
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="kanban-card-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${m.busy ? 'disabled' : ''}>${m.busy ? t('开卡中…') : t('开出这张卡', 'Create card')}</button>
      </div>
    </form>
  </div>`
}

/**
 * 一张卡：交底 + 结论 + 依赖 + 一条时间线（评论和系统行混排）+ 每次跑的流水。
 *
 * **每一块都是一张 `.satu-panel`**——和账号详情、机器详情、审计详情用的是同一个壳
 * （这套界面里的 Card：`--card` 底、`--border` 边、`--radius-lg` 角，标题一律
 * `.satu-panel-title`）。原来这一屏是一堆裸 `<div>` 加行内 style 平铺，一句「做完了」
 * 和一屏带列表的结论挨在一起，中间只有间距——短的那几段会连成一片。
 *
 * 顺序按**人打开这一屏是来干什么的**排：先看它现在怎么了（状态、时刻、能按的按钮），
 * 再看它交出了什么（结论 / 卡在哪儿），最后才是当初交代了什么、路上发生过什么。
 */
function kanbanCardPage() {
  const d = state.kanbanCard
  if (!d) return `<div class="gw-page"><div class="gw-page-inner">${t('正在打开…', 'Opening…')}</div></div>`
  const c = d.card
  const panel = (title, inner, cls = '') =>
    `<div class="satu-panel${cls ? ` ${cls}` : ''}"><span class="satu-panel-title">${title}</span>${inner}</div>`
  const kv = (k, v) => (v ? `<div class="satu-kv"><span>${k}</span><span>${v}</span></div>` : '')
  /**
   * 时间线上的一行。**时刻要跟着每一条**：「派给了 X（第 1 次）」「做完了」单独看
   * 都对，但人在这一屏要判的是「它停在哪一步、停了多久」，而那个问题只有时刻答得了。
   */
  const line = (x) => {
    const who = x.authorBotId || (x.kind === 'system' ? '' : t('我', 'me'))
    return `<li${x.kind === 'system' ? ' class="satu-kanban-sys"' : ''}>
      <span class="satu-kanban-evtext">${who ? `<b>${esc(who)}</b>` : ''}${esc(x.body)}</span>
      ${x.createdAt ? `<time data-at="${x.createdAt}" title="${esc(fmtTime(x.createdAt))}">${esc(cardAgo(x.createdAt))}</time>` : ''}
    </li>`
  }
  const runRow = (r) => {
    const bits = [
      t(`第 ${r.attempt + 1} 次`, `try ${r.attempt + 1}`),
      esc(r.status),
      r.steps ? `${r.steps} ${t('步', 'steps')}` : '',
      cardDur(r.startedAt, r.endedAt),
      r.error ? esc(r.error) : '',
    ].filter(Boolean)
    /**
     * 「看过程」落在**这颗 Bot 的对话**上：卡就是在主会话里跑的（见 agent 的 runCard
     * ——它把卡当成一条带标识的用户消息发进主会话），说的话和调的工具全画在那条会话里。
     *
     * 原来这里指向 `/s/<sessionId>`，而前端根本没有这条路由：pathOf 认不出就退回 `/`，
     * 点一下「看过程」等于被静静送回首页。
     */
    const trace = r.botId
      ? `<button type="button" class="satu-linkbtn" data-act="kanban-open-run" data-bot="${esc(r.botId)}">${t('看过程', 'transcript')}</button>`
      : ''
    return `<li>
      <span class="satu-kanban-evtext">${bits.join(' · ')}</span>
      ${r.startedAt ? `<time data-at="${r.startedAt}" title="${esc(fmtTime(r.startedAt))}">${esc(cardAgo(r.startedAt))}</time>` : ''}
      ${trace}
    </li>`
  }
  /**
   * `running` 的卡只有「停止」一颗按钮，停完了才出现「撤销」。
   *
   * 撤一张正在跑的卡而不掐掉那一轮，留下的是一个没人认领的进程（同 delegation §7.3）。
   */
  const acts =
    c.state === 'running'
      ? `<button type="button" class="btn btn-ghost" data-act="kanban-abort" data-id="${esc(c.id)}">${t('停止', 'Stop')}</button>`
      : c.state === 'pending'
        ? `<button type="button" class="btn btn-primary" data-act="kanban-promote" data-id="${esc(c.id)}">${t('派出去，开始执行', 'Dispatch now')}</button>`
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
  /**
   * 概况那一格。**在跑的那张用「到现在」当终点**：一张跑了四十分钟的卡，人第一眼要的
   * 就是这个数，而它在收口之前一个字都没有。那个数字自己会走（见 paintKanbanTimes），
   * 所以挂个 `data-since` 的记号。
   */
  const running = c.state === 'running'
  const took = cardDur(c.startedAt, c.endedAt || (running ? Date.now() : 0))
  const facts = [
    kv(t('状态', 'State'), cardStateTag(c)),
    kv(t('开卡', 'Created'), c.createdAt ? esc(fmtTime(c.createdAt)) : ''),
    kv(t('开跑', 'Started'), c.startedAt ? esc(fmtTime(c.startedAt)) : ''),
    kv(t('收口', 'Ended'), c.endedAt ? esc(fmtTime(c.endedAt)) : ''),
    kv(
      running ? t('已经跑了', 'Running for') : t('用时', 'Took'),
      took ? (running ? `<time data-since="${c.startedAt}">${esc(took)}</time>` : esc(took)) : '',
    ),
    kv(t('重试', 'Retries'), c.attempt ? String(c.attempt) : ''),
    kv(
      t('档位', 'Model'),
      c.modelRole
        ? `${esc(c.modelRole)}${c.modelDowngraded ? esc(t('（降下来的，不是它选的）', ' (downgraded)')) : ''}${
            c.modelReason ? ` · ${esc(c.modelReason)}` : ''
          }`
        : '',
    ),
  ].join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${esc(c.title)}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('看板任务卡', 'Task card')}</p>
        </div>
        ${flashes()}
        ${acts ? `<div class="satu-kanban-acts">${acts}</div>` : ''}
        ${panel(t('概况', 'Overview'), facts)}
        ${c.blockedReason ? panel(t('卡在哪儿', 'Stuck on'), cardMd(c.blockedReason), 'satu-kanban-stuck') : ''}
        ${c.summary ? panel(t('结论', 'Result'), cardMd(c.summary)) : ''}
        ${c.body ? panel(t('这张卡要做什么', 'The ask'), cardMd(c.body)) : ''}
        ${
          (d.files || []).length
            ? panel(
                t('随卡的附件', 'Attachments'),
                `<ul class="satu-kanban-line">${d.files
                  .map((f) => `<li><span class="satu-kanban-evtext">${esc(f.name)}</span><span class="satu-kanban-side">${Math.ceil(f.size / 1024)} KB</span></li>`)
                  .join('')}</ul>`,
              )
            : ''
        }
        ${
          (d.parents || []).length
            ? panel(
                t('要等这几张', 'Waits on'),
                `<ul class="satu-kanban-line">${d.parents
                  .map(
                    (p) =>
                      `<li><button type="button" class="satu-linkbtn satu-kanban-evtext" data-act="kanban-card" data-id="${esc(p.id)}">${esc(
                        p.title,
                      )}</button><span class="satu-kanban-side">${esc(p.state)}</span></li>`,
                  )
                  .join('')}</ul>`,
              )
            : ''
        }
        ${panel(
          t('这张卡发生过什么', 'Timeline'),
          `<form data-act="kanban-comment" data-id="${esc(c.id)}" class="satu-kanban-say">
            <input class="input" name="body" placeholder="${esc(
              t('留一句话——做这张卡的 Bot 开工时读得到', 'Leave a note — the bot reads it before starting'),
            )}" />
            <button type="submit" class="btn btn-secondary">${t('留言', 'Comment')}</button>
          </form>
          <ul class="satu-kanban-line">${(d.timeline || []).map(line).join('')}</ul>`,
        )}
        ${(d.runs || []).length ? panel(t('跑过几次', 'Runs'), `<ul class="satu-kanban-line">${d.runs.map(runRow).join('')}</ul>`) : ''}
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

/** 板上还有没走到终点的卡（待定、待派、在跑、要人管、等依赖）。轮询快慢看它。 */
function kanbanHasLive() {
  const live = (c) => !['done', 'archived', 'cancelled', 'blocked'].includes(c.state)
  if (state.kanbanCard) return live(state.kanbanCard.card)
  if (state.kanbanBoard) return (state.kanbanBoard.cards || []).some(live)
  return (state.kanbanBoards || []).some((b) => {
    const n = b.counts || {}
    return (n.pending || 0) + (n.todo || 0) + (n.ready || 0) + (n.running || 0) > 0
  })
}

/**
 * 「待定 → 待派」的拖拽。
 *
 * 只有**待定的卡**拿得起来（draggable 只画在它身上），也只有**待派那一列**收得下
 * （data-drop 只画在它身上）——其余每一态都是算出来的（依赖、调度、成败），人拖不动，
 * 那就不给拖的假象。拖的时候画一道虚线框在目标列上，让人知道松手会落在哪儿。
 */
let kanbanDragId = ''
document.addEventListener('dragstart', (e) => {
  const card = e.target && e.target.closest && e.target.closest('.satu-kanban-card[data-state="pending"]')
  if (!card) return
  kanbanDragId = card.getAttribute('data-id')
  try {
    e.dataTransfer.setData('text/plain', kanbanDragId)
    e.dataTransfer.effectAllowed = 'move'
  } catch {}
})
document.addEventListener('dragover', (e) => {
  const col = e.target && e.target.closest && e.target.closest('.satu-kanban-col[data-drop="ready"]')
  if (!col || !kanbanDragId) return
  e.preventDefault()
  col.classList.add('satu-kanban-over')
})
document.addEventListener('dragleave', (e) => {
  const col = e.target && e.target.closest && e.target.closest('.satu-kanban-col[data-drop="ready"]')
  if (col) col.classList.remove('satu-kanban-over')
})
document.addEventListener('drop', async (e) => {
  const col = e.target && e.target.closest && e.target.closest('.satu-kanban-col[data-drop="ready"]')
  const id = kanbanDragId
  if (col) col.classList.remove('satu-kanban-over')
  if (!col || !id) return
  e.preventDefault()
  kanbanDragId = ''
  try {
    await api('POST', `/kanban/cards/${encodeURIComponent(id)}/promote`)
    if (state.kanbanBoardId) await loadKanbanBoard(state.kanbanBoardId)
    render()
    kanbanPoll()
  } catch (err) {
    flash('err', (err && err.message) || t('没派出去', 'Dispatch failed'))
  }
})

/**
 * 只把时刻刷一遍。**不碰别的**——整页重绘会把正在打字的留言框换掉（同日常任务
 * 详情页那次）。`data-at` 是「那一刻」，`data-since` 是「从那一刻到现在」。
 */
function paintKanbanTimes() {
  const root = document.getElementById('app')
  if (!root) return
  for (const el of root.querySelectorAll('time[data-at]')) el.textContent = cardAgo(Number(el.getAttribute('data-at')) || 0)
  for (const el of root.querySelectorAll('time[data-since]')) el.textContent = cardDur(Number(el.getAttribute('data-since')) || 0, Date.now())
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
  // 在跑 5 秒；没在跑但还有活（待定等拖、待派等调度）10 秒——**状态流转要看得见**，
  // 全静止才退到 30 秒。
  const wait = kanbanHasRunning() ? 5000 : kanbanHasLive() ? 10_000 : 30_000
  kanbanTimer = setTimeout(async () => {
    const before = kanbanShot()
    try {
      if (state.kanbanCardId) await loadKanbanCard(state.kanbanCardId)
      else if (state.kanbanBoardId) await loadKanbanBoard(state.kanbanBoardId)
      else await loadKanban()
    } catch {
      /* 保持上一份 */
    }
    /**
     * 数据没变就**只刷时刻，不整页重画**。
     *
     * 这一屏上的时刻（「已经跑了 8 分钟」「3 分钟前」）是拿 Date.now() 算的，一个字节
     * 的数据都不依赖——不刷的话，一张跑了半小时的卡上永远写着「刚刚」。而 render() 是
     * 整页 innerHTML 换掉：为了这个数字每 5 秒重画一次，正在写留言的人每 5 秒被清空
     * 一次。所以走一个只改文字的小画笔。
     */
    if (kanbanShot() !== before) render()
    else paintKanbanTimes()
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
      const body = String(data.get('body') || '').trim()
      // 选中态以 DOM 为准（aria-pressed 那颗），state 只是出错重绘时的备忘——
      // pick 是异步委托写的，点完立刻提交的话 state 可能还没落。
      const assignee =
        form.querySelector('.satu-assignee[aria-pressed="true"]')?.getAttribute('data-id') ||
        state.kanbanNewCard?.assignee ||
        ''
      const boardId = form.getAttribute('data-board') || ''
      if (!body) {
        if (state.kanbanNewCard) {
          // 报错要重绘，重绘会把表单换掉——已写的字先收回 state，弹窗重开时填回去。
          // 文件收不回来（input 的值存不进 state），重选一次，别为此把弹窗做复杂。
          state.kanbanNewCard = { error: t('先把任务需求写清楚', 'Describe the task first'), busy: false, body, assignee }
          render()
        }
        return
      }
      /**
       * 派发对象必须是板成员（后端 assertBoardMember 硬性要求），而弹窗里的名单是
       * 自己名下全部 Bot——选了不在板上的那颗，就在这儿顺手加进去。人不需要知道
       * 「板成员」这个概念，他只知道「派给了谁」。
       */
      if (assignee && !(state.kanbanBoard?.members || []).some((x) => x.botId === assignee)) {
        await api('POST', `/kanban/boards/${encodeURIComponent(boardId)}/members`, { botId: assignee })
      }
      let cardId = ''
      try {
        const out = await api('POST', `/kanban/boards/${encodeURIComponent(boardId)}/cards`, {
          body,
          assigneeBotId: assignee,
        })
        cardId = out.card.id
      } catch (err) {
        // 开卡失败把错留在弹窗里——弹窗还开着，flash 在它后面看不见。
        if (state.kanbanNewCard) {
          state.kanbanNewCard = {
            error: (err && err.message) || t('这一下没成', 'That did not go through'),
            busy: false,
            body,
            assignee,
          }
          await loadKanbanBoard(boardId).catch(() => {})
          render()
          return
        }
        throw err
      }
      // 标题是后端用 utility 模型生成的；附件跟在卡后头传，一份失败不连累卡——
      // 卡已经在了，少一份材料时间线上会说。
      const input = form.querySelector('input[type="file"]')
      for (const f of (input ? [...input.files] : [])) {
        const r = await fetch(`/kanban/cards/${encodeURIComponent(cardId)}/files`, {
          method: 'POST',
          headers: authHeaders({
            'content-type': 'application/octet-stream',
            'x-filename': encodeURIComponent(f.name),
          }),
          body: f,
        }).catch(() => null)
        if (!r || !r.ok) {
          const text = r ? await r.text().catch(() => '') : ''
          flash('err', `${f.name}：${text.slice(0, 120) || t('没传上去', 'upload failed')}`)
        }
      }
      state.kanbanNewCard = null
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
