/**
 * 平台侧的机器管理：一张全平台的机器表，点进去是一台机器的详情页。
 *
 * **和公司详情里那块「运行机器」不是一回事。** 那块答的是「这家公司手上有几台」，
 * 进得去的前提是先挑一家公司；这一页答的是「这台 Gateway 上现在挂着哪些机器、哪台
 * 出事了」。差别不只是入口——没派给任何公司的机器（刚配对完还没分的、原公司被删之后
 * 落单的）在按公司列的那条路上**永远列不出来**，而它们恰恰最需要被人看见。
 *
 * 灯、时区、版本这些的口径跟公司侧完全一致（`machineHead` / `LINK_TEXT` / `sinceMs`
 * 都是直接借 pages-audit.js 那份），不重造一套——同一台机器在两个页面上说两种话，
 * 比少一个页面糟得多。
 */

/** 这是哪台机器。地址最认得出来，没有地址就退到短 id。 */
function machineTitleOf(card) {
  const m = (card && card.machine) || {}
  return m.host || (m.id ? String(m.id).slice(0, 8) : '')
}

/** 通联筛选的五档。计数跟着当前列表算，空的那档也留着——「失联 0 台」本身就是答案。 */
const MACHINE_FILTERS = [
  { key: '', label: '全部' },
  { key: 'online', label: '在线' },
  { key: 'stale', label: '心跳迟了' },
  { key: 'offline', label: '失联' },
  { key: 'unpaired', label: '未配对' },
]

function machineLinkOf(m) {
  return (m && m.link) || (m && m.paired === false ? 'unpaired' : 'unknown')
}

/** 灯 + 一句话。列表和详情共用，免得两处对同一个状态说不同的词。 */
function machineLinkCell(m) {
  const link = machineLinkOf(m)
  const label = (LINK_TEXT[link] || LINK_TEXT.unknown)()
  return `<span style="display: flex; align-items: center; gap: var(--space-2); min-width: 0;">
    <span class="satu-linkdot" data-link="${esc(link)}" title="${esc(label)}"></span>
    <span style="font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(label)}</span>
  </span>`
}

function machinesPage() {
  const all = state.allMachines || []
  const totals = state.machineTotals || { machines: 0, paired: 0, online: 0, accounts: 0, max: 0, seats: 0 }
  const counts = {}
  for (const c of all) counts[machineLinkOf(c.machine)] = (counts[machineLinkOf(c.machine)] || 0) + 1
  const filter = state.machineFilter || ''
  const rows = filter ? all.filter((c) => machineLinkOf(c.machine) === filter) : all
  // 先筛后分页。**上面那排计数不能跟着分页走**：它们答的是「这一档有几台」，
  // 按当前这一页去数，「失联 3 台」会随着翻页变成 1 台——那是句假话。
  const view = pageSlice('machines', rows)
  const cols = '120px minmax(180px, 2fr) minmax(120px, 1.2fr) 110px 72px minmax(140px, 1.2fr) minmax(110px, 1fr)'
  const dim = (text) =>
    `<span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(text || '—')}</span>`
  const tabs = MACHINE_FILTERS.map((f) => {
    const n = f.key ? counts[f.key] || 0 : all.length
    return `<button type="button" class="btn ${filter === f.key ? 'btn-primary' : ''}" data-act="machine-filter" data-filter="${esc(f.key)}">${t(f.label)} ${n}</button>`
  }).join('')
  const body = view.rows
    .map((card) => {
      const m = card.machine || {}
      // **整行可点，而不是行尾一个「查看」**：这张表上的每一列都是「这台机器怎么样」，
      // 看到哪一列不对就想点进去，没理由把人的视线甩回行尾。
      return `<div class="satu-memberrow" style="cursor: pointer; grid-template-columns: ${cols};" data-act="go" data-href="/machines/${esc(m.id)}">
        ${machineLinkCell(m)}
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(m.host || t('还没有地址'))}</div>
          <div style="font-size: 12px; color: var(--muted-foreground); font-family: var(--font-mono);">${esc(String(m.id || '').slice(0, 8))}</div>
        </div>
        ${
          card.company
            ? `<span style="font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(card.company.name)}</span>`
            : `<span class="tag tag-neutral">${t('未分配')}</span>`
        }
        <span style="font-size: 13px;">${m.paired ? `${esc(card.accounts)} / ${esc(card.maxAccounts)}` : '—'}${card.full ? ` <span class="tag">${t('已满')}</span>` : ''}</span>
        ${dim(String(card.seats))}
        ${dim(m.managerVersion || t('未知'))}
        ${dim(m.lastHeartbeatAt ? sinceMs(m.heartbeatAge) : t('从未心跳'))}
      </div>`
    })
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('机器管理')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('连到这台 Gateway 上的所有运行机器，包括还没派给公司的那些。点进去看详情、改配置、下指令。')}</p>
        </div>
        ${flashes()}
        <div class="satu-panel" style="flex-direction: row; flex-wrap: wrap; gap: var(--space-6); align-items: baseline;">
          ${machineStat(t('在线'), `${totals.online} / ${totals.machines}`, t('台'))}
          ${machineStat(t('已配对'), String(totals.paired), t('台'))}
          ${machineStat(t('账号位'), `${totals.accounts} / ${totals.max}`, '')}
          ${machineStat(t('已部署 Bot'), String(totals.seats), t('个'))}
        </div>
        <div style="display: flex; gap: var(--space-2); flex-wrap: wrap;">${tabs}</div>
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-memberhead" style="grid-template-columns: ${cols};">
            <span>${t('状态')}</span><span>${t('机器')}</span><span>${t('归属公司')}</span><span>${t('账号位')}</span><span>${t('已部署 Bot')}</span><span>${t('管家版本')}</span><span>${t('最近心跳')}</span>
          </div>
          ${body || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${all.length ? t('这一档下没有机器') : t('还没有机器配对进来。到某家公司的详情页生成配对码，在那台 Debian 上跑一条命令即可。')}</div>`}
          ${listPager('machines', view, '台')}
        </div>
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('机器是在公司名下配对进来的：新增一台请到公司详情页生成配对码。这里管的是已经进来的那些。')}</p>
      </div>
    </div>`
}

function machineStat(label, value, unit) {
  return `<div style="display: flex; flex-direction: column; gap: 2px;">
    <span style="font-size: 11.5px; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted-foreground);">${esc(label)}</span>
    <span style="font-family: var(--font-heading); font-size: 22px; line-height: 1;">${esc(value)}${unit ? `<span style="font-size: 13px; color: var(--muted-foreground); margin-left: 4px;">${esc(unit)}</span>` : ''}</span>
  </div>`
}

function machineDetailPage() {
  // 载到的那一条要跟地址里的 id 对得上。state.machineDetail 是留在内存里的，不比对
  // 就会在新的一条还没到时顶着上一条的名字画一整页——那比空着糟得多。
  const card = state.machineDetail?.machine?.id === machineIdOfPath(state.path) ? state.machineDetail : null
  if (!card || !card.machine) {
    return `<div class="gw-page"><div class="gw-page-inner">${flashes()}<p style="color: var(--muted-foreground);">${t('载入中…')}</p></div></div>`
  }
  const m = card.machine
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        ${/* 刷新摆在标题这一行的最右边：这一整页——心跳、席位、版本、容量——都是一次
              拉回来的快照，会过期的是整页，不是某一块，所以按钮属于页头而不是某个面板。 */ ''}
        <div style="display: flex; align-items: flex-start; gap: var(--space-4);">
        <div style="min-width: 0; flex: 1;">
          <h1 style="font-size: 24px; margin: 0 0 4px; word-break: break-all;">${esc(machineTitleOf(card) || t('机器详情'))}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground); display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
            ${machineLinkCell(m)}
            ${m.lastHeartbeatAt ? `· ${esc(sinceMs(m.heartbeatAge))}` : ''}
            ${card.company ? `· <button type="button" class="satu-linkbtn" data-act="go" data-href="/companies/${esc(card.company.id)}">${esc(card.company.name)}</button>` : `· ${t('未分配给任何公司')}`}
          </p>
        </div>
        <button type="button" class="btn btn-secondary" style="flex: none;" data-act="machine-refresh"
          data-scope="platform" data-machine="${esc(m.id)}" data-id="${esc(m.id)}" ${state.busy ? 'disabled' : ''}
          title="${esc(t('重新拉一遍这台机器的信息'))}">${state.busy ? t('载入中…') : t('刷新')}</button>
        </div>
        ${flashes()}
        ${m.lastError ? `<div class="gw-flash gw-flash-err">${esc(m.lastError)}</div>` : ''}
        ${machineInfoPanel(card)}
        ${machineCapacityPanel(card)}
        ${machineVersionPanel(card)}
        ${machineSeatsPanel(card)}
        ${machineDangerPanel(card)}
        ${timezoneOptions()}
      </div>
    </div>`
}

/** 身份与地址。id 摆全（要拿它去查日志、对工单），地址可改并当场探活。 */
function machineInfoPanel(card) {
  const m = card.machine
  const companies = card.companies || []
  const options = [`<option value="">${esc(t('未分配'))}</option>`]
    .concat(
      companies.map(
        (c) => `<option value="${esc(c.id)}" ${c.id === (card.company && card.company.id) ? 'selected' : ''}>${esc(c.name)}</option>`,
      ),
    )
    .join('')
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('机器信息')}</span>
    <div class="satu-kv"><span>id</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; word-break: break-all; font-family: var(--font-mono); font-size: 12px;">
      ${esc(m.id)}
      <button type="button" class="satu-linkbtn" data-act="copy-machine-id" data-machine="${esc(m.id)}">${t('复制')}</button>
    </span></div>
    <div class="satu-kv"><span>${t('架构')}</span><span>${esc(m.arch || t('等第一次心跳自报'))}</span></div>
    <div class="satu-kv"><span>${t('管家协议')}</span><span>${esc(String(m.protocol ?? 0))}${m.protocolTooOld ? ` · ${t('版本过旧，等它自升级')}` : ''}</span></div>
    <div class="satu-kv"><span>${t('配对时间')}</span><span>${esc(m.pairedAt ? fmtTime(m.pairedAt) : t('还没有配对'))}</span></div>
    <div class="satu-kv"><span>${t('最近心跳')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
      ${m.lastHeartbeatAt ? esc(new Date(m.lastHeartbeatAt).toLocaleString()) : t('还没有')}
      ${m.paired ? `<button type="button" class="satu-linkbtn" data-act="machine-logs" data-scope="platform" data-machine="${esc(m.id)}">${t('查看日志')}</button>` : ''}
    </span></div>
    ${m.lastError ? `<div class="satu-kv"><span>lastError</span><span style="word-break: break-all;">${esc(m.lastError)}</span></div>` : ''}
    <form data-form="machine" data-scope="platform" data-machine="${esc(m.id)}" style="display: flex; gap: var(--space-2); align-items: flex-end; flex-wrap: wrap;">
      <div class="field" style="margin: 0; flex: 1; min-width: 220px;">
        <label for="md-host">${t('管家地址')}</label>
        <input class="input" id="md-host" name="host" value="${esc(m.host || '')}" placeholder="http://10.0.0.12:8443" autocomplete="off">
      </div>
      <button type="submit" class="btn" ${state.busy ? 'disabled' : ''}>${t('保存并探活')}</button>
    </form>
    <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('只改地址，没有任何凭据字段——机器的身份是配对时签发的机器票。换 IP、换端口用它；换机器请重新配对。')}</p>
    <form data-form="machine-company" data-machine="${esc(m.id)}" style="display: flex; gap: var(--space-2); align-items: flex-end; flex-wrap: wrap;">
      <div class="field" style="margin: 0; flex: 1; min-width: 220px;">
        <label for="md-company">${t('归属公司')}</label>
        <select class="input" id="md-company" name="companyId">${options}</select>
      </div>
      <button type="submit" class="btn" ${state.busy || card.seats ? 'disabled' : ''}>${t('改归属')}</button>
    </form>
    <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${
      card.seats
        ? t('这台机器上还有部署好的 Bot，改不了归属——它们的账号和目录是按公司建的，换个东家不会把它们搬走。先把这些 Bot 拆掉。')
        : t('留空 = 收回，变成一台待分配的机器。新东家一台都没有时，它会成为那家的默认机器。')
    }</p>
  </div>`
}

/** 容量与时区：这两件事决定「还能往上放几个人」和「机器上的钟对不对」。 */
function machineCapacityPanel(card) {
  const m = card.machine
  const cur = m.currentTimezone || (m.paired ? t('机器没报') : '—')
  const note = card.timezonePending
    ? ` · ${t('已下指令，等机器改')} → ${esc(m.timezone || '')}`
    : m.timezone
      ? ` · ${t('已生效')}`
      : ` · ${t('没有指定，跟机器现状')}`
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('容量与时区')}</span>
    <div class="satu-kv"><span>${t('账号位')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
      ${m.paired ? `${esc(card.accounts)} / ${esc(card.maxAccounts)}` : `<span style="color: var(--muted-foreground);">${t('未配对，不提供账号位')}</span>`}${card.full ? ` <span class="tag">${t('已满')}</span>` : ''}
      <form data-form="machine-capacity" data-scope="platform" data-machine="${esc(m.id)}" style="display: inline-flex; gap: 6px; align-items: center;">
        <input class="input" name="maxAccounts" type="number" min="1" max="1000" value="${esc(card.maxAccounts)}" style="width: 84px;">
        <button type="submit" class="satu-linkbtn" ${state.busy ? 'disabled' : ''}>${t('改容量')}</button>
      </form>
    </span></div>
    ${/* 这个数原先叫「席位」，摆在讲容量的这一栏里，谁也对不上它和 2/3 的关系——它其实
          是**这台机器上部署了几个 Bot**：两名员工各两个 Bot 就是 4。名字改对了，两行放
          在一起才读得通：2 个人、4 个 Bot。 */ ''}
    <div class="satu-kv"><span>${t('已部署 Bot')}</span><span>${esc(String(card.seats))}</span></div>
    <div class="satu-kv"><span>${t('时区')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
      ${esc(cur)}${note}
      <form data-form="machine-timezone" data-scope="platform" data-machine="${esc(m.id)}" style="display: inline-flex; gap: 6px; align-items: center;">
        <input class="input" name="timezone" list="satu-timezones" value="${esc(m.timezone || '')}" placeholder="Asia/Shanghai" autocomplete="off" spellcheck="false" style="width: 200px;">
        <button type="submit" class="satu-linkbtn" ${state.busy ? 'disabled' : ''}>${t('改时区')}</button>
      </form>
    </span></div>
    <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('账号位算的是激活账号数，不是 Bot 数——一个员工的多个 Bot 落在同一台机器上，只占一个账号位。容量调小到低于当前占用不会赶人，只是不再往上放。')}</p>
  </div>`
}

/**
 * 两行版本，两个按钮。
 *
 * 「升级」都只是**下指令**：管家换版由机器自己在下一轮心跳里做（要挑不忙的时候、
 * 要自检、失败要回滚，这些只有机器上做得了），Bot 那条是逐个席位重铺。所以按下之后
 * 的提示语是「等机器换版」，不是「已升级」。
 */
function machineVersionPanel(card) {
  const m = card.machine
  const list = card.botVersions || []
  const botText = list.length
    ? list.map((v) => `${esc(v.version || t('未部署'))} × ${v.seats}`).join('、')
    : t('还没有部署 Bot')
  const mgrNote = card.managerPending
    ? ` · ${t('已下指令，等机器换版')} → ${esc(card.managerDesired || '')}`
    : m.protocolTooOld
      ? ' · ' + t('版本过旧，等它自升级')
      : card.managerOutdated
        ? ` · ${t('最新')} ${esc(state.managerLatest || '')}`
        : ''
  const mgrBtn = card.managerOutdated
    ? `<button type="button" class="btn" data-act="upgrade-manager" data-scope="platform" data-machine="${esc(m.id)}" ${state.busy ? 'disabled' : ''}>${t('升级管家')}</button>`
    : ''
  const botBtn = card.botOutdated
    ? `<button type="button" class="btn" data-act="machine-bot-update" data-machine="${esc(m.id)}" ${state.updatingRuntime ? 'disabled' : ''}>${state.updatingRuntime ? t('更新中…') : t('全部升级')}</button>`
    : ''
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('版本')}</span>
    <div class="satu-kv"><span>${t('管家版本')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">${esc(m.managerVersion || '—')}${mgrNote}${mgrBtn}</span></div>
    <div class="satu-kv"><span>${t('期望版本')}</span><span>${esc(card.managerDesired || t('跟平台的最新发布走'))}</span></div>
    <div class="satu-kv"><span>${t('Bot 运行时')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">${botText}${card.botOutdated ? ` · ${t('最新')} ${esc(state.botLatest || '')}` : ''}${botBtn}</span></div>
    <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('一台机器上同时躺着几个 Bot 版本不是错误——有的部署得早。「全部升级」把这台机器上的 Bot 逐个重铺到最新版，正在进行的对话会断。')}</p>
  </div>`
}

/**
 * 席位状态 → 一个词 + 一枚标签。
 *
 * **出错的那一档用最扎眼的 accent，正常的用安静的 accent-2**，跟公司/成员那几处标签
 * 的轻重一致（见 MEMBER_STATUS）。反过来的话，这张表上最先抓住眼睛的会是好好跑着的
 * 那几行——而人来这一页就是为了找坏掉的那个。
 *
 * 主题里没有红色标签，accent 是现有几档里最响的一档。
 */
const SEAT_STATUS = {
  ready: { label: '运行中', tag: 'tag-accent-2' },
  error: { label: '出错', tag: 'tag-accent' },
  deploying: { label: '部署中', tag: 'tag-outline' },
  none: { label: '未部署', tag: 'tag-neutral' },
}

/** 这台机器上跑着谁。出事时第一眼看的就是它，所以 lastError 直接摊在行里，不藏。 */
function machineSeatsPanel(card) {
  const seats = card.seatList || []
  const cols = 'minmax(150px, 1.6fr) minmax(120px, 1.2fr) 90px 72px minmax(140px, 1.2fr) 80px'
  const rows = seats
    .map((s) => {
      // 认不出来的状态照原样显示，别硬塞进某一档——多出一个状态时，屏幕上要看得见
      // 那个新词，而不是被冒充成「运行中」。
      const st = SEAT_STATUS[s.status] || { label: s.status || '—', tag: 'tag-neutral' }
      return `<div class="satu-memberrow" style="grid-template-columns: ${cols};">
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(s.whoName || s.who)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground); font-family: var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(s.seatId)}</div>
        </div>
        ${/* Bot 名由接口给（见 withSeatNames）。**不走 botNameOfId**：那个查的是
             state.bots，而这一页从不加载它——直接打开这个地址时整列会是一串 uuid。 */ ''}
        <span style="font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(s.botName || s.botId)}</span>
        <span class="tag ${st.tag}">${t(st.label)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(String(s.slot))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${esc(s.lastError || '')}">${esc(s.lastError || s.botVersion || t('未部署'))}</span>
        <button type="button" class="satu-linkbtn" data-act="machine-logs" data-scope="platform" data-machine="${esc(card.machine.id)}" data-seat="${esc(s.seatId)}">${t('日志')}</button>
      </div>`
    })
    .join('')
  return `<div style="display: flex; flex-direction: column; gap: var(--space-3);">
    <h2 style="font-size: 18px; margin: 0;">${t('部署的 Bot')} <span style="font-size: 13px; font-weight: 400; color: var(--muted-foreground);">${seats.length}</span></h2>
    <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
      <div class="satu-memberhead" style="grid-template-columns: ${cols};">
        <span>${t('成员 / 实例 ID')}</span><span>Bot</span><span>${t('状态')}</span><span>${t('槽位')}</span><span>${t('版本 / 错误')}</span><span></span>
      </div>
      ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('这台机器上还没有部署 Bot')}</div>`}
    </div>
  </div>`
}

/**
 * 移除登记。
 *
 * 说清楚它**不碰机器本身**：管家还在那台 Debian 上跑着，要停得上去停。
 *
 * **有席位也删得掉**，席位的登记跟着一起没（后端是同一个事务，见 DELETE
 * /platform/machines/:id）。只删机器不删席位的话，那些行会指向一台不存在的机器，
 * 聊天请求会带着别的机器的票发出去。所以不再禁按钮，改成点下去先问一句——代价
 * 摆在确认框里，而不是让人对着一颗灰按钮猜为什么。
 */
function machineDangerPanel(card) {
  const m = card.machine
  const seats = card.seats || 0
  return `<div class="satu-panel" style="border-color: var(--destructive);">
    <span class="satu-panel-title">${t('移除登记')}</span>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('机器在线的话，它会在下一轮心跳收到通知，自己停掉这些 Bot、取消开机自启并退出；~/work 里的文件留在机器上。不在线的收不到通知，上面的东西要停得上去停。要让它重新回来，在机器上重跑一次配对。')}</p>
    <div><button type="button" class="btn btn-secondary" data-act="machine-remove" data-scope="platform" data-machine="${esc(m.id)}" ${state.busy ? 'disabled' : ''}>${t('移除这台机器的登记')}</button></div>
    ${seats ? `<p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t(`这台机器上的 ${seats} 个 Bot 登记会一起抹掉，那几位员工要重新部署。`, `The ${seats} bot registrations on this machine go with it; those members will need to redeploy.`)}</p>` : ''}
  </div>`
}
