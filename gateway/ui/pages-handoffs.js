/**
 * 转人工待办：跨 Bot 的那一页（见 docs/handoff.md §6 第 2 层）。
 *
 * **它和会话里那张卡不是同一件事。** 卡片答的是「这一屏上这件事怎么办」，这一页答的是
 * 「我名下还欠着几件事」——而人多半正在别的 Bot 那一屏，甚至根本没打开过那颗 Bot
 * （半夜的日常任务开出来的单子就是这样）。
 *
 * 数据来自 Gateway 那张表（`/runtime/handoffs`），不是某一台席位：管理员要看的是
 * 全公司的，而那些单子分散在好几台机器上。正文（summary、交还时写的那段）只有席位
 * 有，点进对话去看。
 */

/** 一张单现在算哪一态，说给人听。列表上要一眼扫过，所以比卡片上那句还短。 */
function handoffStateTag(h) {
  if (h.state === 'open') return `<span class="tag tag-accent">${t('等人接手', 'Waiting')}</span>`
  if (h.state === 'claimed') return `<span class="tag tag-accent-2">${t('处理中', 'In progress')}</span>`
  if (h.state === 'returned') return `<span class="tag tag-neutral">${t('已交还', 'Handed back')}</span>`
  if (h.state === 'expired') return `<span class="tag tag-neutral">${t('没人接', 'Nobody took it')}</span>`
  return `<span class="tag tag-neutral">${t('已结束', 'Closed')}</span>`
}

/**
 * 该谁处理。
 *
 * `assignee` 空着不是「没人管」，是**全体管理员**——模版上写的就是这一档（见
 * `escalateToOf`）。写成「未指派」的话，管理员会以为这条不归自己。
 */
function handoffWho(h) {
  if (h.claimedName) return t('由 ', 'by ') + h.claimedName
  if (h.assigneeName) return t('等 ', 'waiting on ') + h.assigneeName
  return t('等管理员', 'waiting on an admin')
}

/**
 * 一段时长，说给人听。
 *
 * 不复用对话里那个读秒（`elapsedText`）：它给的是 `m:ss`，而这里的量级是小时和天
 * ——一张挂了两小时的单会显示成「120:00」，没有人读得出那是两小时。
 */
function handoffDuration(ms) {
  const min = Math.max(0, Math.round((Number(ms) || 0) / 60_000))
  if (min < 60) return t(`${min} 分钟`, `${min} min`)
  const h = Math.round(min / 6) / 10
  if (h < 48) return t(`${h} 小时`, `${h} h`)
  return t(`${Math.round(h / 24)} 天`, `${Math.round(h / 24)} d`)
}

/**
 * 顶上那三个数：最近 30 天开了几张、现在还欠着几张、多久有人接。
 *
 * **「多久有人接」用中位数**（服务端算的，见 db.handoffStats）：一张挂了两天没人接的
 * 单会把平均值拖到没法看，而这一格要答的是「一般多久有人应」。
 *
 * 没有数据就整条不画——三个 0 摆在那儿，看着像功能坏了。
 */
function handoffStatsStrip() {
  const st = state.handoffStats
  if (!st || !st.opened) return ''
  const p50 = st.p50ClaimMs == null ? t('还没有人接过', 'nobody has taken one yet') : handoffDuration(st.p50ClaimMs)
  return `<div style="display: flex; gap: var(--space-6); flex-wrap: wrap; padding: var(--space-3) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
    <div><div style="font-size: 12px; color: var(--muted-foreground);">${t('近 30 天开出', 'Opened, 30d')}</div><div style="font-size: 20px; font-weight: 600;">${st.opened}</div></div>
    <div><div style="font-size: 12px; color: var(--muted-foreground);">${t('还欠着', 'Still waiting')}</div><div style="font-size: 20px; font-weight: 600;">${st.waiting}</div></div>
    <div><div style="font-size: 12px; color: var(--muted-foreground);">${t('没人接手', 'Nobody took')}</div><div style="font-size: 20px; font-weight: 600;">${st.expired}</div></div>
    <div><div style="font-size: 12px; color: var(--muted-foreground);">${t('多久有人接（中位）', 'Median time to take')}</div><div style="font-size: 20px; font-weight: 600;">${esc(p50)}</div></div>
  </div>`
}

function handoffRow(h) {
  const mine = state.me && state.me.account ? state.me.account.id : ''
  const canClaim = h.state === 'open'
  const open = state.handoffOpenId === h.id
  return `
    <div class="satu-handoffrow">
      <div style="min-width: 0;">
        <div style="font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(h.ask || t('（没写要做什么）', '(no ask)'))}</div>
        <div style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(h.reason || '')}</div>
      </div>
      <span>${handoffStateTag(h)}</span>
      <span style="font-size: 12.5px; color: var(--muted-foreground);">${esc(h.ownerName || h.accountId)}</span>
      <span style="font-size: 12.5px; color: var(--muted-foreground);">${esc(handoffWho(h))}${h.claimedBy && h.claimedBy === mine ? ' · ' + esc(t('我', 'me')) : ''}</span>
      <span style="font-size: 12px; color: var(--muted-foreground);">${esc(fmtTime(h.createdAt))}</span>
      <div class="satu-rowactions" style="display: flex; gap: var(--space-2); justify-content: flex-end;">
        ${/**
           * 「去处理」**只对自己的 Bot 给**。
           *
           * 别人名下的 Bot 打不开：`/runtime/bots/:id` 按「这颗 Bot 是不是你的」判
           * （visibleBotOf → botsFor），管理员点过去落在一句「没有这个 Bot」上——而管理员
           * 恰恰是这套东西里最该处理别人单子的人。所以那种就地展开处理（下面那张卡）。
           */ ''}
        ${canClaim ? `<button type="button" class="btn btn-ghost" data-act="handoff-claim" data-id="${esc(h.id)}">${t('我来接手', 'Take it')}</button>` : ''}
        ${
          h.accountId === mine
            ? `<button type="button" class="btn btn-secondary" data-act="handoff-open" data-bot="${esc(h.botId)}">${t('去对话里处理', 'Open the chat')}</button>`
            : `<button type="button" class="btn btn-secondary" data-act="handoff-detail" data-id="${esc(h.id)}" aria-expanded="${open}">${open ? t('收起', 'Close') : t('展开处理', 'Handle here')}</button>`
        }
      </div>
    </div>${open ? handoffPanel(h) : ''}`
}

/**
 * 就地处理的那张卡（别人名下的 Bot，对话打不开）。
 *
 * 长得和会话里那张一样（同一套 `.sw-approval` / `.sw-handoff` 样式、同一个
 * `.sw-handoff-note`），所以接手 / 交还走的是同一条代码路（chat.js 的 actOnHandoff /
 * returnHandoff），不另写一套。
 *
 * **正文要现拉**：Gateway 那张表只留了 reason / ask 各一段，而接手的人真正要看的是
 * 「Bot 已经做到哪一步」。拉不到就说明白是席位没应答，不要画成「这张单没有内容」。
 */
function handoffPanel(h) {
  const d = (state.handoffDetail || {})[h.id]
  const body =
    d === undefined
      ? `<div class="sw-handoff-who">${esc(t('正在取 Bot 做到哪一步…', 'Fetching what the bot got done…'))}</div>`
      : d === null
        ? `<div class="sw-handoff-who">${esc(t('席位没应答，看不到 Bot 那边的进度；下面照样可以接手和交还。', 'The seat did not answer, so its notes are unavailable — you can still take it and hand it back.'))}</div>`
        : d.summary
          ? `<pre class="sw-approval-args">${esc(d.summary)}</pre>`
          : `<div class="sw-handoff-who">${esc(t('Bot 没写它做到哪一步。', 'The bot did not say how far it got.'))}</div>`
  return `<div class="satu-handoffpanel">
    <div class="sw-approval sw-handoff" data-state="${esc(h.state)}" data-handoff="${esc(h.id)}">
      <div class="sw-handoff-ask">${esc(h.ask || t('接手处理这件事', 'Take this over'))}</div>
      ${h.reason ? `<div class="sw-approval-why">${esc(h.reason)}</div>` : ''}
      ${body}
      <textarea class="input sw-handoff-note" data-handoff="${esc(h.id)}" rows="2"
        placeholder="${esc(t('你做了什么、结论是什么？Bot 要靠它接着做', 'What did you do, and what came of it? The bot continues from this'))}"></textarea>
      <div class="sw-approval-acts">
        <button type="button" class="btn btn-primary" data-act="chat-handoff-return" data-id="${esc(h.id)}" data-disp="done">${t('处理完了，交还', 'Done — hand back')}</button>
        <button type="button" class="btn btn-ghost" data-act="chat-handoff-return" data-id="${esc(h.id)}" data-disp="instructions">${t('换个做法', 'Do it differently')}</button>
        <button type="button" class="btn btn-ghost" data-act="chat-handoff-cancel" data-id="${esc(h.id)}">${t('不用处理了', 'Never mind')}</button>
      </div>
    </div>
  </div>`
}

function handoffsPage() {
  const list = state.handoffs || []
  const me = state.me && state.me.account ? state.me.account.id : ''
  const mineOnly = state.handoffScope === 'mine'
  const rows = mineOnly
    ? list.filter((h) => h.assignee === me || h.claimedBy === me || (!h.assignee && isAdmin()))
    : list
  const body = rows.length
    ? `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
        <div class="satu-handoffhead">
          <span>${t('要人做什么', 'What is asked')}</span>
          <span>${t('状态', 'State')}</span>
          <span>${t('谁的 Bot', 'Whose bot')}</span>
          <span>${t('谁在处理', 'Who')}</span>
          <span>${t('开出来', 'Opened')}</span>
          <span></span>
        </div>
        ${rows.map(handoffRow).join('')}
      </div>`
    : `<p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t(
        '没有等着人处理的事。Bot 卡住、或者撞上公司规定要人拍板的事情时，会在这里开一张单。',
        'Nothing waiting. When a bot gets stuck or hits a rule that needs a person, it opens a ticket here.',
      )}</p>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('转人工待办', 'Handoffs')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t(
            'Bot 交出来等人处理的事。处理完在对话里交还，它会接着往下做。',
            'Things the bots handed over. Hand it back in the chat and the bot picks up from there.',
          )}</p>
        </div>
        ${handoffStatsStrip()}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          <button type="button" class="btn ${mineOnly ? 'btn-ghost' : 'btn-secondary'}" data-act="handoff-scope" data-scope="all">${t('全部', 'All')}</button>
          <button type="button" class="btn ${mineOnly ? 'btn-secondary' : 'btn-ghost'}" data-act="handoff-scope" data-scope="mine">${t('要我处理的', 'Mine')}</button>
        </div>
        ${flashes()}
        ${body}
      </div>
    </div>`
}

/**
 * 顶栏那个数：**要我处理、还没处理完**的有几张。
 *
 * 就地改，不走 render()：整页重绘会把正在打字的输入框换掉，而这个数每 30 秒就要动
 * 一次（见 chat.js 的 loadHandoffs）。
 */
function paintHandoffBadge() {
  const node = document.querySelector('.satu-handoffcount')
  if (!node) return
  /**
   * **交接单和 blocked 的卡加在一起**（见 docs/kanban.md §14 第 2 层）。
   *
   * 一张卡住的卡和一张开着的交接单，对人是同一件事——「有活等着你」。分成两个数字、
   * 两页清单的话，人要学会看两个地方，而他只会记住一个。
   *
   * 人自己按停止的那些不在里面：Gateway 那侧已经把 `stopped` 那一档排掉了。
   */
  const n = (Number(state.handoffCount) || 0) + (Number(state.kanbanBlocked) || 0)
  node.textContent = n > 99 ? '99+' : String(n)
  node.hidden = !n
}

const ICON_HANDOFF = [
  'M18 11V6a1.5 1.5 0 0 0-3 0',
  'M15 10V4a1.5 1.5 0 0 0-3 0v6',
  'M12 10V5a1.5 1.5 0 0 0-3 0v7',
  'M9 12V8a1.5 1.5 0 0 0-3 0v6a7 7 0 0 0 7 7h1a7 7 0 0 0 7-7v-3',
]

/**
 * 顶栏那颗按钮。
 *
 * **只对公司里的人出现**：owner 没有席位、也没有 Bot，那一侧永远是 0。
 * 数字为 0 时按钮照样在——待办入口消失的话，人只能靠记性想起来去哪儿找它。
 */
/**
 * 顶栏那颗看板按钮。
 *
 * 和交接单那颗并排，**不共用一个入口**：那个数是两件事加起来的，但点进去要去两个
 * 地方——合成一个按钮的话，人点开待办页看到三张单，而真正卡住的是板上那张卡。
 */
function kanbanBell() {
  if (!state.me || isOwner() || !state.me.account || !state.me.account.companyId) return ''
  const label = t('看板', 'Boards')
  return `<button type="button" class="btn btn-ghost btn-icon" style="flex: none;"
    data-act="go" data-href="/kanban" aria-label="${esc(label)}" title="${esc(label)}">
    ${svg(['M4 5h16v14H4z', 'M9 5v14', 'M15 5v14'], 17)}
  </button>`
}

function handoffBell() {
  if (!state.me || isOwner() || !state.me.account || !state.me.account.companyId) return ''
  const n = Number(state.handoffCount) || 0
  const label = t('转人工待办', 'Handoffs')
  return `<button type="button" class="btn btn-ghost btn-icon satu-handoffbell" style="margin-left: auto; flex: none; position: relative;"
    data-act="go" data-href="/handoffs" aria-label="${esc(label)}" title="${esc(label)}">
    ${svg(ICON_HANDOFF, 17)}
    <span class="satu-handoffcount" ${n ? '' : 'hidden'}>${n > 99 ? '99+' : n}</span>
  </button>`
}
