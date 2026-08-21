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

/**
 * 列表里的那一格负载：**最吃紧的那一项**，不是三项并排。
 *
 * 这张表要答的是「哪台机器要出事了」，而一行只有一百多像素——三个 40% 挤在一起，
 * 谁也不会去逐行比对。所以只画最高的那一项并写出它是谁（「盘 92%」），另外两项进
 * title，想看全的点进详情页。
 *
 * 没报过的给「—」，**不给 0%**：一台失联机器的 0% 和一台空闲机器的 0% 看着一样，
 * 而结论完全相反。
 */
function machineLoadCell(m) {
  const load = (m.telemetry && m.telemetry.metrics) || null
  if (!load) return `<span style="font-size: 13px; color: var(--muted-foreground);">—</span>`
  const disks = load.disks || []
  const worstDisk = disks.reduce((a, b) => (b.usage > (a ? a.usage : -1) ? b : a), null)
  const items = [
    { key: t('CPU'), usage: load.cpu ? load.cpu.usage : null },
    { key: t('内存'), usage: load.memory ? load.memory.usage : null },
    { key: worstDisk ? `${t('盘')} ${worstDisk.mount}` : t('盘'), usage: worstDisk ? worstDisk.usage : null },
  ]
  const worst = items.reduce((a, b) => ((b.usage ?? -1) > (a.usage ?? -1) ? b : a), items[0])
  const title = items.map((x) => `${x.key} ${pctText(x.usage)}`).join(' · ')
  return `<span style="display: flex; align-items: center; gap: var(--space-2); min-width: 0;" title="${esc(title)}">
    ${meter(worst.usage)}
    <span style="font-size: 12.5px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(worst.key)} ${esc(pctText(worst.usage))}</span>
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
  const cols = '120px minmax(180px, 2fr) minmax(120px, 1.2fr) 110px 72px minmax(130px, 1.2fr) minmax(140px, 1.2fr) minmax(110px, 1fr)'
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
        ${machineLoadCell(m)}
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
            <span>${t('状态')}</span><span>${t('机器')}</span><span>${t('归属公司')}</span><span>${t('账号位')}</span><span>${t('已部署 Bot')}</span><span>${t('负载')}</span><span>${t('管家版本')}</span><span>${t('最近心跳')}</span>
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
        ${machineLoadPanel(card)}
        ${machineLogDiskPanel(card)}
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

// ── 负载与日志占用 ────────────────────────────────────────────────────
//
// 这两块都是**机器自报**的（心跳 30 秒一轮带上来），不是 Gateway 去量的——没有 SSH，
// 量不了。所以每一块都得先答「这份数是什么时候的」：一台失联机器上的 CPU 5%，和一台
// 正在冒烟的机器上五分钟前的 CPU 5%，是同一个数字、完全相反的结论。

/**
 * 字节。**不复用 fmtSize**：那个到 MB 就封顶了（它量的是发布包），一块 900 GB 的盘
 * 会被它写成「915527.3 MB」。
 */
function fmtBytes(n) {
  const x = Number(n)
  if (!Number.isFinite(x) || x < 0) return '—'
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  let i = 0
  let v = x
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i += 1
  }
  return (i === 0 ? v : v.toFixed(v < 10 ? 1 : 0)) + ' ' + u[i]
}

/** 出网速率。`null` = 这一轮算不出来（第一次采样、计数器回绕），不写成 0。 */
function fmtRate(n) {
  return n == null ? t('取样中') : fmtBytes(n) + '/s'
}

/**
 * 百分数。`null` = 算不出来，那时说的是 `unknown` 那句话。
 *
 * **默认那句是「取样中」，但不是所有算不出来都叫取样中**：journal 那一行在上限为 0
 * （这台机器不自动清）时同样没有百分比可算，而机器一直在正常上报——写成「取样中」
 * 会让人以为采样坏了，跑去查一件根本没坏的事。
 */
function pctText(x, unknown) {
  return x == null ? unknown || t('取样中') : Math.round(Math.min(1, Math.max(0, x)) * 100) + '%'
}

/**
 * 一根占用条。
 *
 * 三档颜色，**门槛定在 75% 和 90%**：这一页的用处是在机器出事之前看见它，而盘和内存
 * 从 90% 到满只要几个小时。全绿一片的话，人只会在它已经满了之后才来看这一页。
 *
 * 算不出来时画一根**空心虚线的槽**，一个字都不写：那句话由旁边的数值格去说（见
 * loadRow）——两处都写就是同一行里出现两遍「取样中」。虚线是为了和「实心槽 + 0%」
 * 分开：后者是真的量到了 0，两者结论完全不同，不能长成一个样子（同通联灯那条规矩）。
 */
function meter(usage) {
  if (usage == null) return `<span class="satu-meter" data-level="none"></span>`
  const v = Math.min(1, Math.max(0, Number(usage) || 0))
  const level = v >= 0.9 ? 'hot' : v >= 0.75 ? 'warn' : 'ok'
  return `<span class="satu-meter" data-level="${level}" title="${esc(pctText(v))}"><span style="width: ${(v * 100).toFixed(1)}%;"></span></span>`
}

/**
 * 一行「名字 · 条 · 数值 · 备注」。四块面板的行都长这样，别各写各的。
 *
 * `unknown` 是「算不出百分比时那一格写什么」，透给 pctText。
 */
function loadRow(label, usage, value, note, unknown) {
  return `<div class="satu-kv"><span>${esc(label)}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
    ${meter(usage)}
    <span style="font-size: 13px; min-width: 42px;">${esc(pctText(usage, unknown))}</span>
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(value || '')}</span>
    ${note ? `<span style="font-size: 12px; color: var(--muted-foreground);">${esc(note)}</span>` : ''}
  </span></div>`
}

/**
 * CPU、内存、盘、出网。
 *
 * 出网那一格**主角是速率不是累计**：累计是「开机以来」，机器一重启就归零，拿它对
 * 月度流量账是错的；而「现在正在往外发多少」才是这一页能答、也答得准的问题。累计
 * 仍然给出来，标明口径，用来看「这台机器一直在往外倒东西吗」。
 */
function machineLoadPanel(card) {
  const m = card.machine || {}
  const load = (m.telemetry && m.telemetry.metrics) || null
  const age = m.telemetryAge == null ? '' : sinceMs(m.telemetryAge)
  if (!load) {
    return `<div class="satu-panel">
      <span class="satu-panel-title">${t('机器负载')}</span>
      <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${
        m.paired
          ? t('这台机器还没报过负载。老版本的管家不报这一项，升级它之后下一轮心跳就有了。', 'This machine has never reported load. Older managers do not report it — upgrade and it arrives on the next heartbeat.')
          : t('还没有配对，机器不会上报任何东西。')
      }</p>
    </div>`
  }
  const cpu = load.cpu || {}
  const mem = load.memory || {}
  const net = load.net || {}
  const disks = load.disks || []
  const days = Math.floor((load.uptime || 0) / 86400)
  const hours = Math.floor(((load.uptime || 0) % 86400) / 3600)
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('机器负载')}</span>
    ${/* 数是机器自报的，隔一轮心跳才来一次。先说清楚它有多新，再给数——不然一台失联
          机器上的「CPU 5%」看着和好机器一模一样。 */ ''}
    <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">
      ${age ? t(`机器自报，采样于 ${age}`, `Reported by the machine, sampled ${age}`) : t('机器自报')}
      ${load.uptime ? ` · ${t(`已运行 ${days} 天 ${hours} 小时`, `up ${days}d ${hours}h`)}` : ''}
    </p>
    ${loadRow(t('CPU'), cpu.usage, `${esc(String(cpu.cores || '?'))} ${t('核')}`, t(`负载 ${cpu.load1 ?? '—'}`, `load ${cpu.load1 ?? '—'}`))}
    ${loadRow(
      t('内存'),
      mem.usage,
      `${fmtBytes(mem.used)} / ${fmtBytes(mem.total)}`,
      mem.swapTotal ? t(`交换区 ${fmtBytes(mem.swapUsed)} / ${fmtBytes(mem.swapTotal)}`, `swap ${fmtBytes(mem.swapUsed)} / ${fmtBytes(mem.swapTotal)}`) : '',
    )}
    ${
      disks.length
        ? disks
            .map((d) =>
              loadRow(
                `${t('磁盘')} ${d.mount}`,
                d.usage,
                `${fmtBytes(d.used)} / ${fmtBytes(d.total)}`,
                t(`剩 ${fmtBytes(d.free)}`, `${fmtBytes(d.free)} free`),
              ),
            )
            .join('')
        : `<div class="satu-kv"><span>${t('磁盘')}</span><span style="font-size: 13px; color: var(--muted-foreground);">${t('机器没报')}</span></div>`
    }
    <div class="satu-kv"><span>${t('出网流量')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap; font-size: 13px;">
      ↑ ${esc(fmtRate(net.txRate))}
      <span style="color: var(--muted-foreground);">· ↓ ${esc(fmtRate(net.rxRate))}</span>
      <span style="color: var(--muted-foreground);">· ${t(`开机以来出网 ${fmtBytes(net.txBytes)}`, `${fmtBytes(net.txBytes)} out since boot`)}</span>
      ${net.interfaces && net.interfaces.length ? `<span style="color: var(--muted-foreground); font-family: var(--font-mono); font-size: 12px;">${esc(net.interfaces.join(' '))}</span>` : ''}
    </span></div>
    <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('累计是「开机以来」，机器重启会归零——对流量账要看的是速率那一格。回环和 docker、veth 这些虚拟网卡不算在内。')}</p>
  </div>`
}

/**
 * 日志占用与清理。
 *
 * 这台机器上的日志只有一个去处：journald（bot、桌面、管家三个单元都不写日志文件）。
 * 所以「日志把盘吃满了」等价于「journal 太大了」，清理也只有一个动作。`/var/log` 里
 * 别的文件归 logrotate 管，这里只报大小不动手——管家伸手进去删，是在和系统自己的
 * 轮转策略打架。
 *
 * 上限是**期望值**：填在这里只是下指令，真正清的是机器上的管家，下一轮心跳才认。
 */
function machineLogDiskPanel(card) {
  const m = card.machine || {}
  const logs = (m.telemetry && m.telemetry.logs) || null
  const capMb = m.logCapMb
  // 机器**实际**在用的上限。和期望值分两格：机器上可以用 SATUWORK_LOG_CAP_MB 本地
  // 钉死，那时两个数对不上，而那正是要看得见的事——不然人会以为自己刚才改上了。
  const actual = logs ? logs.capMb : null
  const pending = logs && capMb != null && actual !== capMb
  const over = logs && actual > 0 && logs.journalBytes > actual * 1024 * 1024
  const v = logs && logs.lastVacuum
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('日志占用')}</span>
    ${
      logs
        ? `${loadRow(
            'journal',
            actual > 0 ? Math.min(1, logs.journalBytes / (actual * 1024 * 1024)) : null,
            `${fmtBytes(logs.journalBytes)}${actual > 0 ? ` / ${actual} MB` : ''}`,
            over ? t('超过上限，管家会自己清') : actual === 0 ? t('这台机器不自动清') : '',
            // 上限是 0 就没有百分比这回事——不是没量到。
            t('不限'),
          )}
      <div class="satu-kv"><span>/var/log</span><span style="font-size: 13px;">${esc(fmtBytes(logs.varLogBytes))} <span style="color: var(--muted-foreground);">${t('（含 journal）')}</span></span></div>`
        : `<p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${
            m.paired ? t('这台机器还没报过日志占用。老版本的管家不报这一项，升级它之后下一轮心跳就有了。') : t('还没有配对，机器不会上报任何东西。')
          }</p>`
    }
    <div class="satu-kv"><span>${t('上限')}</span><span style="display: flex; gap: var(--space-2); align-items: center; flex-wrap: wrap;">
      <form data-form="machine-log-cap" data-scope="platform" data-machine="${esc(m.id)}" style="display: inline-flex; gap: 6px; align-items: center;">
        <input class="input" name="logCapMb" type="number" min="0" max="1048576" value="${capMb == null ? '' : esc(String(capMb))}" placeholder="1024" style="width: 110px;">
        <span style="font-size: 13px; color: var(--muted-foreground);">MB</span>
        <button type="submit" class="satu-linkbtn" ${state.busy ? 'disabled' : ''}>${t('保存上限')}</button>
      </form>
      ${/* **本机钉死排在 pending 前面。** 机器上钉了 SATUWORK_LOG_CAP_MB 的话，期望值
             永远追不上实际值，pending 于是恒为真——按原来的顺序，那句「这里改不动它」
             恰好在唯一需要它的场景下永远画不出来，界面只会一直说「等机器认」，而没有
             任何指令在路上。 */ ''}
      ${
        logs && logs.capSource === 'env'
          ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t(`机器上用 SATUWORK_LOG_CAP_MB 钉死在 ${actual} MB，这里改不动它`, `Pinned to ${actual} MB by SATUWORK_LOG_CAP_MB on the machine; this field cannot override it`)}</span>`
          : pending
            ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t(`已下指令，机器现在用的是 ${actual} MB`, `Instruction sent; the machine is still on ${actual} MB`)}</span>`
            : ''
      }
      <button type="button" class="btn" data-act="machine-logs-vacuum" data-scope="platform" data-machine="${esc(m.id)}" ${state.busy || !m.paired ? 'disabled' : ''}>${t('立刻清理')}</button>
    </span></div>
    ${
      v
        ? `<div class="satu-kv"><span>${t('上次清理')}</span><span style="font-size: 13px; ${v.error ? 'word-break: break-all;' : ''}">${
            v.error
              ? esc(v.error)
              : esc(t(`${fmtBytes(v.before)} → ${fmtBytes(v.after)}，腾出 ${fmtBytes(v.freed)}`, `${fmtBytes(v.before)} → ${fmtBytes(v.after)}, freed ${fmtBytes(v.freed)}`))
          }</span></div>`
        : ''
    }
    ${
      logs && logs.top && logs.top.length
        ? `<div class="satu-kv"><span>${t('其它大文件')}</span><span style="font-size: 12px; color: var(--muted-foreground); font-family: var(--font-mono); word-break: break-all;">${logs.top
            .map((f) => `${esc(f.path)} ${esc(fmtBytes(f.size))}`)
            .join('<br>')}</span></div>`
        : ''
    }
    <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('席位上的 bot、桌面和管家都只写 journald，所以清理就是 journalctl --vacuum-size：留下最近的那截，删掉最老的。留空 = 跟管家默认的 1024 MB 走，填 0 = 这台机器不自动清。/var/log 里别的文件归 logrotate 管，这里只报大小，不动它们。')}</p>
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
