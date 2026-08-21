/** 管理侧的页面：概览、模型配置、供应商、统计、公司资料、成员与分组。 */
function overviewPage() {
  // 公司侧（管理员和员工）的 / 就是对话页；概览那一屏已经去掉了。
  if (isOwner()) return ownerOverviewPage()
  return chatPage()
}

function ownerOverviewPage() {
  const orgs = state.orgs || []
  const users = state.users || []
  const configured = [...configuredSet()]
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('概览')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('平台公司、用户、已配置供应商，以及日常 / utility 模型。')}</p>
        </div>
        ${flashes()}
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--space-3);">
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('公司')}</span>
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(orgs.length)}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('用户')}</span>
            <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(users.length)}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('日常任务模型')}</span>
            <span style="font-family: var(--font-heading); font-size: 18px; line-height: 1.2;">${esc(roleLabel('daily'))}</span>
          </div>
          <div class="satu-stat">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('Utility 模型')}</span>
            <span style="font-family: var(--font-heading); font-size: 18px; line-height: 1.2;">${esc(roleLabel('utility'))}</span>
          </div>
        </div>
        <div class="satu-panel">
          <span class="satu-panel-title">${t('已配置供应商')}</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('只显示名称。密钥不会出现在这里。')}</p>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
            ${
              configured.length
                ? configured.map((p) => `<span class="tag tag-accent">${esc(p)}</span>`).join('')
                : `<span style="font-size: 13px; color: var(--muted-foreground);">${t('还没有配置供应商。到「供应商」页添加密钥。')}</span>`
            }
          </div>
        </div>
      </div>
    </div>`
}


function configuredProviders() {
  const configured = configuredSet()
  const list = state.catalog.filter((p) => configured.has(p.provider)).map((p) => ({
    provider: p.provider,
    name: p.name || p.provider,
    models: p.models || [],
  }))
  const seen = new Set(list.map((p) => p.provider))
  for (const provider of configured) {
    if (!seen.has(provider)) list.push({ provider, name: provider, models: [] })
  }
  return list
}

function providerOptions(selected) {
  const list = configuredProviders()
  if (selected && !list.some((p) => p.provider === selected)) list.unshift({ provider: selected, name: selected, models: [] })
  return list.map((p) => `<option value="${esc(p.provider)}" ${p.provider === selected ? 'selected' : ''}>${esc(p.name || p.provider)}</option>`).join('')
}

function modelOptions(provider, selected) {
  const shown = state.catalog.find((p) => p.provider === provider)
  const models = shown?.models?.length ? shown.models : selected ? [{ id: selected }] : []
  if (selected && !models.some((m) => m.id === selected)) models.unshift({ id: selected })
  return models.map((m) => `<option value="${esc(m.id)}" ${m.id === selected ? 'selected' : ''}>${esc(m.id)}</option>`).join('')
}

/** 当前生效的报价倍率。没设过就是 1（按原价）。 */
function priceMultiplier() {
  const n = Number(state.settings?.priceMultiplier)
  return Number.isFinite(n) && n > 0 ? n : 1
}

/**
 * 目录里「没有价」和「免费」长得一样：pi-ai 对没收录价格的模型（zai 这些）
 * 一律填 0。两个方向都是 0 时按「不知道」画成 —— 写成 $0.000 会被读成免费。
 */
function hasRates(cost) {
  return Number(cost?.input) > 0 || Number(cost?.output) > 0
}

function ratePair(cost, factor) {
  if (!hasRates(cost)) return `<span title="${esc(t('目录里没有这个模型的价格', 'The catalog has no price for this model'))}">—</span>`
  return `${esc(money(Number(cost.input || 0) * factor))} / ${esc(money(Number(cost.output || 0) * factor))}`
}

/** 倍率输入。改完即存，和上面两个角色面板一样不设「保存」按钮。 */
function pricePanel() {
  const mult = priceMultiplier()
  return `
    <div class="satu-panel">
      <span class="satu-panel-title">${t('单价倍率')}</span>
      <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('对外报价 = 模型原价 × 倍率。填 1 就是按原价。', 'Quoted price = list price × multiplier. 1 means list price.')}</p>
      <div class="satu-toggleRow">
        <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('倍率')}</div></div>
        <input class="input" style="width: 250px; flex: none;" type="number" inputmode="decimal"
          min="0.01" max="100" step="0.05" value="${esc(String(mult))}"
          data-act="price-multiplier" ${state.savingMultiplier ? 'disabled' : ''}>
      </div>
      <div class="satu-toggleRow">
        <div style="min-width: 0; font-size: 12px; color: var(--muted-foreground);">${t(`当前 ${mult} 倍，表里「倍率单价」按它算。`, `Currently ${mult}×; the "marked-up" column uses it.`)}</div>
      </div>
    </div>`
}

function rolePanel(role, title, hint) {
  const cur = state.settings?.[role] || { provider: '', model: '' }
  return `
    <div class="satu-panel">
      <span class="satu-panel-title">${esc(title)}</span>
      <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(hint)}</p>
      <div class="satu-toggleRow">
        <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('供应商')}</div></div>
        <select class="input" style="width: 250px; flex: none;" data-act="role-provider" data-role="${esc(role)}">
          <option value="">${t('选择供应商')}</option>
          ${providerOptions(cur.provider)}
        </select>
      </div>
      <div class="satu-toggleRow">
        <div style="min-width: 0;"><div style="font-size: 13.5px; font-weight: 600;">${t('模型')}</div></div>
        <select class="input" style="width: 250px; flex: none;" data-act="role-model" data-role="${esc(role)}">
          <option value="">${t('选择模型')}</option>
          ${modelOptions(cur.provider, cur.model)}
        </select>
      </div>
      <div class="satu-toggleRow">
        <div style="min-width: 0;">${testMark('role', role)}</div>
        <button type="button" class="btn btn-ghost" style="flex: none;" data-act="test-role" data-role="${esc(role)}" ${!cur.provider || !cur.model || state.tests['role:' + role]?.status === 'busy' ? 'disabled' : ''}>${t('测试连通性')}</button>
      </div>
    </div>`
}

function modelsPage() {
  const shown = state.catalog.find((p) => p.provider === state.selectedProvider)
  const selected = shown?.provider || state.selectedProvider || ''
  const daily = state.settings?.daily || {}
  const utility = state.settings?.utility || {}
  const mult = priceMultiplier()

  const modelRows = (shown?.models || [])
    .map((m) => {
      const isDaily = daily.provider === shown.provider && daily.model === m.id
      const isUtil = utility.provider === shown.provider && utility.model === m.id
      const cost = m.cost && typeof m.cost === 'object' ? m.cost : {}
      const actions = `
        <div class="satu-rowactions">
          ${isDaily ? `<span class="tag tag-accent">${t('日常')}</span>` : `<button type="button" class="satu-linkbtn" data-act="set-role" data-role="daily" data-provider="${esc(shown.provider)}" data-model="${esc(m.id)}">${t('设为日常')}</button>`}
          ${isUtil ? '<span class="tag tag-accent-2">utility</span>' : `<button type="button" class="satu-linkbtn" data-act="set-role" data-role="utility" data-provider="${esc(shown.provider)}" data-model="${esc(m.id)}">${t('设为 utility')}</button>`}
        </div>`
      return `<div class="satu-modelrow">
        <div class="satu-tasklink" style="cursor: default;">
          <span style="font-weight: 600; font-size: 14px;">${esc(m.name)}</span>
          <span style="font-size: 12px; color: var(--muted-foreground);">${esc(m.id)}</span>
        </div>
        <span style="font-size: 13px;">${esc(shown.name || shown.provider)}</span>
        <div class="gw-caps">${capTags(m)}</div>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(tokens(m.contextWindow))}${m.maxTokens ? t(` · 出 ${esc(tokens(m.maxTokens))}`, ` · out ${esc(tokens(m.maxTokens))}`) : ''}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${ratePair(cost, 1)}</span>
        <span style="font-size: 13px; color: var(--foreground);">${ratePair(cost, mult)}</span>
        ${actions}
      </div>`
    })
    .join('')

  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('模型配置')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('目录来自 pi-ai；密钥在供应商页配置。密钥留在 Gateway，不会出现在本机磁盘或环境。')}</p>
        </div>
        ${flashes()}
        <div class="gw-roles">
          ${rolePanel('daily', t('日常任务模型'), t('用于日常工作。'))}
          ${rolePanel('utility', t('Utility 模型'), t('用于轻量、快速的任务。'))}
        </div>
        ${isOwner() ? pricePanel() : ''}
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
            <div style="display: flex; align-items: baseline; gap: var(--space-3);">
              <h2 style="font-size: 18px; margin: 0;">${t(`${esc(shown?.name || shown?.provider || '模型')} 的模型`, `${esc(shown?.name || shown?.provider || 'Provider')} models`)}</h2>
              <span style="font-size: 12px; color: var(--muted-foreground);">${t(`共 ${shown?.models.length ?? 0} 个`, `${shown?.models.length ?? 0} total`)}</span>
            </div>
            <select class="input" style="width: 220px; flex: none;" data-act="select-provider">
              <option value="">${t('选择供应商')}</option>
              ${providerOptions(selected)}
            </select>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-modelhead">
              <span>${t('模型')}</span><span>${t('供应商')}</span><span>${t('能力')}</span><span>${t('上下文 / 输出')}</span><span>${t('单价 / 1M tok')}</span><span>${t(`倍率单价 ×${mult}`, `Marked-up ×${mult}`)}</span><span></span>
            </div>
            ${modelRows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('选择已配置的供应商查看模型。')}</div>`}
          </div>
        </div>
      </div>
    </div>`
}

function addProviderModal() {
  if (!state.addOpen) return ''
  const configured = configuredSet()
  const available = state.catalog.filter((p) => !configured.has(p.provider))
  const options = available.length
    ? available.map((p) => `<option value="${esc(p.provider)}">${esc(p.name || p.provider)}</option>`).join('')
    : `<option value="">${t('没有可添加的供应商')}</option>`
  return `
    <div class="gw-modal-backdrop" data-act="add-close">
      <div class="gw-modal" data-act="add-dialog" role="dialog" aria-modal="true" aria-labelledby="add-prov-title">
        <div>
          <h2 id="add-prov-title" style="font-size: 20px; margin: 0 0 4px;">${t('添加供应商')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('从目录选择尚未配置的供应商，粘贴 API 密钥。密钥只存在 Gateway，保存后不会回显。')}</p>
        </div>
        <form data-form="add-cred" style="display: flex; flex-direction: column; gap: var(--space-4);">
          <div class="field">
            <label for="add-provider">${t('供应商')}</label>
            <select class="input" id="add-provider" name="provider" required ${available.length ? '' : 'disabled'}>
              ${options}
            </select>
          </div>
          <div class="field">
            <label for="add-secret">${t('API 密钥')}</label>
            <input class="input" id="add-secret" name="secret" type="password" autocomplete="off" placeholder="${esc(t('API 密钥'))}" required>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
            <button type="button" class="btn btn-ghost" data-act="add-close">${t('取消')}</button>
            <button type="submit" class="btn btn-primary" ${state.busy || !available.length ? 'disabled' : ''}>${t('保存')}</button>
          </div>
        </form>
      </div>
    </div>`
}

/**
 * 列表 = 已配好密钥的内置供应商 ∪ 全部自定义供应商。
 *
 * 自定义的即使还没配密钥也要列出来——它是刚建出来的，不列的话没有地方能给它贴密钥。
 */
function providerRows() {
  const credBy = new Map((state.creds || []).map((c) => [c.provider, c]))
  const rows = configuredProviders().map((p) => ({
    provider: p.provider,
    name: p.name || p.provider,
    models: p.models || [],
    custom: null,
    cred: credBy.get(p.provider),
  }))
  const seen = new Set(rows.map((r) => r.provider))
  for (const c of state.customProviders || []) {
    const models = state.catalog.find((x) => x.provider === c.id)?.models || []
    const existing = rows.find((r) => r.provider === c.id)
    if (existing) {
      existing.custom = c
      existing.name = c.name || c.id
      continue
    }
    seen.add(c.id)
    rows.push({ provider: c.id, name: c.name || c.id, models, custom: c, cred: credBy.get(c.id) })
  }
  return rows.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'))
}

/** 用量金额。可能很小（$0.0004），也可能很大；小额要多给两位，否则全是 $0.00。 */
function usage$(n) {
  const x = Number(n)
  if (!Number.isFinite(x)) return '—'
  if (x === 0) return '$0'
  if (x < 0.01) return `$${x.toFixed(4)}`
  if (x < 1) return `$${x.toFixed(3)}`
  return `$${x.toFixed(2)}`
}

/** 精确的 token 数。tokens() 是给目录里的窗口用的，会四舍五入成 128K，统计不能那样。 */
function exactTokens(n) {
  return Number(n || 0).toLocaleString('en-US')
}

function statsPage() {
  const d = state.stats
  const month = state.statsMonth || thisMonth()
  const pill = (key, label) =>
    `<button type="button" class="btn ${state.statsRange === key ? 'btn-primary' : 'btn-ghost'}" data-act="stats-range" data-range="${key}">${label}</button>`

  const totals = d?.totals || { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0, quotedUsd: 0, unpricedCalls: 0 }
  const cards = [
    [t('调用次数'), exactTokens(totals.calls)],
    [t('输入 Tokens'), exactTokens(totals.promptTokens)],
    [t('输出 Tokens'), exactTokens(totals.completionTokens)],
    [t('总 Tokens'), exactTokens(totals.promptTokens + totals.completionTokens)],
    [t('成本价'), usage$(totals.costUsd)],
    [t(`报价 ×${d?.multiplier ?? 1}`, `Quoted ×${d?.multiplier ?? 1}`), usage$(totals.quotedUsd)],
  ]
    .map(
      ([label, value]) => `<div class="satu-panel" style="gap: 4px;">
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(label)}</span>
        <span style="font-size: 22px; font-weight: 600;">${esc(value)}</span>
      </div>`,
    )
    .join('')

  const rows = (d?.byCompany || [])
    .map(
      (c) => `<div class="satu-statrow">
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(c.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${c.lastAt ? esc(fmtTime(c.lastAt)) : t('无调用')}</div>
        </div>
        <span style="font-size: 13px;">${esc(exactTokens(c.calls))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(exactTokens(c.promptTokens))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(exactTokens(c.completionTokens))}</span>
        <span style="font-size: 13px; font-weight: 600;">${esc(exactTokens(c.promptTokens + c.completionTokens))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(usage$(c.costUsd))}</span>
        <span style="font-size: 13px;">${esc(usage$(c.quotedUsd))}${c.unpricedCalls ? ` <span class="tag" title="${esc(t('这家公司有调用用的是没有单价的模型，金额没算进去'))}">${t('不全')}</span>` : ''}</span>
      </div>`,
    )
    .join('')

  const modelRows = (d?.byModel || [])
    .map(
      (m) => `<div class="satu-statrow" style="grid-template-columns: 2fr 1fr 1fr 1fr 1fr 1fr 1fr;">
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600;">${esc(m.model)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.provider)}</div>
        </div>
        <span style="font-size: 13px;">${esc(exactTokens(m.calls))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(exactTokens(m.promptTokens))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(exactTokens(m.completionTokens))}</span>
        <span style="font-size: 13px; font-weight: 600;">${esc(exactTokens(m.promptTokens + m.completionTokens))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${m.priced ? esc(usage$(m.costUsd)) : `<span title="${esc(t('目录里没有这个模型的单价'))}">—</span>`}</span>
        <span style="font-size: 13px;">${m.priced ? esc(usage$(m.quotedUsd)) : '—'}</span>
      </div>`,
    )
    .join('')

  const unpriced = d?.unpricedModels || []

  /**
   * 网页工具按**次**算钱，跟 token 不是一个量纲，所以单开一块，不混进上面的合计。
   * 金额是写行那一刻的报价，这里只求和，不重算——重算会让改价追溯改动历史账单。
   */
  const web = d?.web || { byCompany: [], byBackend: [], totals: { calls: 0, units: 0, mils: 0 } }
  const webRows = (web.byBackend || [])
    .map(
      (b) => `<div class="satu-statrow" style="grid-template-columns: 2fr 1fr 1fr 1fr 1fr;">
        <span style="font-size: 13.5px; font-weight: 600;">${esc(b.backend)}</span>
        <span style="font-size: 13px;">${esc(String(b.search))}</span>
        <span style="font-size: 13px;">${esc(String(b.extract))}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(String(b.units))}</span>
        <span style="font-size: 13px; font-weight: 600;">${esc(usd(b.mils))}</span>
      </div>`,
    )
    .join('')

  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('统计')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('各公司的 token 消耗。金额按模型单价折算，报价一列再乘单价倍率。', 'Token consumption per company. Amounts use model list prices; the quoted column also applies the price multiplier.')}</p>
        </div>
        ${flashes()}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          ${pill('today', t('今日'))}
          ${pill('7d', t('近 7 天'))}
          ${pill('month', t('月'))}
          ${state.statsRange === 'month' ? `<input class="input" type="month" style="width: 170px; flex: none;" value="${esc(month)}" data-act="stats-month">` : ''}
          <select class="input" style="width: 200px; flex: none;" data-act="stats-company">
            <option value="">${t('全部公司')}</option>
            ${(d?.companies || []).map((c) => `<option value="${esc(c.id)}" ${c.id === state.statsCompany ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
          <span style="font-size: 12px; color: var(--muted-foreground);">${state.statsLoading ? t('统计中…') : d ? `${esc(fmtTime(d.from))} — ${esc(fmtTime(d.to))}` : ''}</span>
        </div>
        ${
          unpriced.length
            ? `<div class="gw-flash gw-flash-err">${esc(t(`${unpriced.length} 个模型在目录里没有单价（${unpriced.slice(0, 3).join('、')}${unpriced.length > 3 ? ' …' : ''}），它们的调用没有计入金额。`, `${unpriced.length} model(s) have no price in the catalog (${unpriced.slice(0, 3).join(', ')}${unpriced.length > 3 ? ' …' : ''}); their calls are excluded from the amounts.`))}</div>`
            : ''
        }
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: var(--space-3);">
          ${cards}
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <h2 style="font-size: 18px; margin: 0;">${t('按公司')}</h2>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-stathead">
              <span>${t('公司')}</span><span>${t('调用')}</span><span>${t('输入')}</span><span>${t('输出')}</span><span>${t('总计')}</span><span>${t('成本价')}</span><span>${t('报价')}</span>
            </div>
            ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${state.statsLoading ? t('统计中…') : t('这个时间段里没有调用。')}</div>`}
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: baseline; gap: var(--space-3); flex-wrap: wrap;">
            <h2 style="font-size: 18px; margin: 0;">${t('网页工具')}</h2>
            <span style="font-size: 12px; color: var(--muted-foreground);">
              ${t(`${web.totals.calls} 次调用 · ${web.totals.units} 条 · ${esc(usd(web.totals.mils))}`, `${web.totals.calls} calls · ${web.totals.units} units · ${esc(usd(web.totals.mils))}`)}
            </span>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-stathead" style="grid-template-columns: 2fr 1fr 1fr 1fr 1fr;">
              <span>${t('后端')}</span><span>${t('搜索')}</span><span>${t('提取')}</span><span>${t('计费条数')}</span><span>${t('报价')}</span>
            </div>
            ${webRows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${state.statsLoading ? t('统计中…') : t('这个时间段里没有网页调用。')}</div>`}
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <h2 style="font-size: 18px; margin: 0;">${t('按模型')}</h2>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-stathead" style="grid-template-columns: 2fr 1fr 1fr 1fr 1fr 1fr 1fr;">
              <span>${t('模型')}</span><span>${t('调用')}</span><span>${t('输入')}</span><span>${t('输出')}</span><span>${t('总计')}</span><span>${t('成本价')}</span><span>${t('报价')}</span>
            </div>
            ${modelRows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${state.statsLoading ? t('统计中…') : t('这个时间段里没有调用。')}</div>`}
          </div>
        </div>
      </div>
    </div>`
}

function providersPage() {
  const list = providerRows()

  const rows = list
    .map((p, i) => {
      const busy = state.tests['provider:' + p.provider]?.status === 'busy'
      const status = p.custom?.broken
        ? `<span class="tag tag-accent">${t('定义有误')}</span>`
        : p.cred
          ? `<span class="tag tag-accent">${t('已配置')}</span>`
          : `<span class="tag">${t('缺密钥')}</span>`
      return `<div class="satu-provrow">
        <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
          ${mark(p.name, i % 2 === 1)}
          <div style="min-width: 0;">
            <div style="font-size: 14px; font-weight: 600;">${esc(p.name)}${p.custom ? ` <span class="tag tag-accent-2">${t('自定义')}</span>` : ''}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${esc(p.provider)}${p.custom && !p.custom.broken ? ` · ${esc(p.custom.api)}` : ''}</div>
          </div>
        </div>
        <span style="font-size: 13px; color: var(--muted-foreground);">${t(`${p.models.length} 个`, `${p.models.length} models`)}</span>
        ${status}
        <form class="gw-secret" data-form="cred" data-provider="${esc(p.provider)}" data-id="${esc(p.cred?.id || '')}">
          <input class="input" name="secret" type="password" autocomplete="off" placeholder="${esc(p.cred ? t('输入新密钥以更新') : t('粘贴 API 密钥'))}" required>
        </form>
        <div class="gw-provactions">
          ${testMark('provider', p.provider) ? `<div class="gw-testline">${testMark('provider', p.provider)}</div>` : ''}
          ${p.custom ? `<button type="button" class="btn btn-ghost" data-act="prov-edit" data-provider="${esc(p.provider)}">${t('编辑')}</button>` : ''}
          ${p.custom ? `<button type="button" class="btn btn-ghost" data-act="prov-models" data-provider="${esc(p.provider)}">${t(`模型 ${p.custom.models?.length ?? 0}`, `Models ${p.custom.models?.length ?? 0}`)}</button>` : ''}
          <button type="button" class="btn btn-ghost" data-act="test-provider" data-provider="${esc(p.provider)}" ${busy ? 'disabled' : ''}>${t('测试')}</button>
          <button type="button" class="btn btn-primary" data-act="save-cred" data-provider="${esc(p.provider)}" data-id="${esc(p.cred?.id || '')}">${t('更新')}</button>
          <button type="button" class="satu-linkbtn" data-act="prov-delete" data-provider="${esc(p.provider)}" data-custom="${p.custom ? '1' : ''}">${t('删除')}</button>
        </div>
      </div>`
    })
    .join('')

  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('供应商')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('内置供应商配好密钥才列在这里；自定义供应商建出来就一直在。密钥只存在 Gateway，保存后不会回显。')}</p>
          </div>
          <div style="display: flex; gap: var(--space-2); flex: none;">
            ${isOwner() ? `<button type="button" class="btn btn-secondary" data-act="prov-new">${t('添加自定义供应商')}</button>` : ''}
            <button type="button" class="btn btn-primary" data-act="add-open">${t('添加供应商')}</button>
          </div>
        </div>
        ${flashes()}
        <div class="gw-credlist" style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-provhead">
            <span>${t('供应商')}</span><span>${t('模型')}</span><span>${t('状态')}</span><span>${t('密钥')}</span><span></span>
          </div>
          ${rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有配置供应商。点击「添加供应商」从目录里选一家并粘贴密钥，或者「添加自定义供应商」接一个自建端点。')}</div>`}
        </div>
      </div>
      ${addProviderModal()}
      ${customProviderModal()}
      ${providerModelsModal()}
    </div>`
}

/** 建 / 改自定义供应商。字段就是 pi-ai createProvider 的入参。 */
function customProviderModal() {
  const d = state.providerDraft
  if (!d) return ''
  const apis = state.customApis?.length ? state.customApis : ['openai-completions']
  return `
    <div class="gw-modal-backdrop" data-act="prov-close">
      <div class="gw-modal" data-stop role="dialog" aria-modal="true">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${d.editing ? t('编辑自定义供应商') : t('添加自定义供应商')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('字段与 pi-ai 的 createProvider 一致。建好之后在这一行贴密钥、加模型。', 'Fields match pi-ai createProvider. Add the key and models on the row afterwards.')}</p>
        </div>
        ${d.error ? `<div class="gw-flash gw-flash-err">${esc(d.error)}</div>` : ''}
        <div class="field">
          <label>${t('id')}</label>
          <input class="input" data-act="prov-field" data-field="id" value="${esc(d.id)}" ${d.editing ? 'disabled' : ''}
            placeholder="my-llm" autocomplete="off">
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('小写字母开头，字母数字和连字符。建好之后不能改——角色、密钥、用量都按它存。', 'Lowercase start, alphanumerics and hyphens. Immutable once created.')}</span>
        </div>
        <div class="field">
          <label>${t('名称')}</label>
          <input class="input" data-act="prov-field" data-field="name" value="${esc(d.name)}" placeholder="My LLM" autocomplete="off">
        </div>
        <div class="field">
          <label>baseUrl</label>
          <input class="input" data-act="prov-field" data-field="baseUrl" value="${esc(d.baseUrl)}" placeholder="https://api.example.com/v1" autocomplete="off">
        </div>
        <div class="field">
          <label>api</label>
          <select class="input" data-act="prov-field" data-field="api">
            ${apis.map((a) => `<option value="${esc(a)}" ${a === d.api ? 'selected' : ''}>${esc(a)}</option>`).join('')}
          </select>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('自建端点大多是 openai-completions。', 'Self-hosted endpoints are usually openai-completions.')}</span>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
          <button type="button" class="btn btn-ghost" data-act="prov-close">${t('取消')}</button>
          <button type="button" class="btn btn-primary" data-act="prov-save" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
        </div>
      </div>
    </div>`
}

/** 某个自定义供应商的模型清单。改完一次性提交整个 models 数组。 */
function providerModelsModal() {
  if (!state.modelsFor) return ''
  const p = customProvider(state.modelsFor)
  if (!p) return ''
  const d = state.modelDraft
  const rows = (p.models || [])
    .map(
      (m) => `<div class="satu-provrow" style="grid-template-columns: 2fr 1fr 1fr 88px;">
        <div style="min-width: 0;">
          <div style="font-size: 13.5px; font-weight: 600;">${esc(m.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.id)}</div>
        </div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(tokens(m.contextWindow))} / ${esc(tokens(m.maxTokens))}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(money(m.cost?.input))} / ${esc(money(m.cost?.output))}</span>
        <button type="button" class="satu-linkbtn" data-act="prov-model-del" data-model="${esc(m.id)}">${t('删除')}</button>
      </div>`,
    )
    .join('')
  return `
    <div class="gw-modal-backdrop" data-act="prov-models-close">
      <div class="gw-modal" data-stop role="dialog" aria-modal="true" style="max-width: 720px;">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t(`${esc(p.name)} 的模型`, `${esc(p.name)} models`)}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('单价按每 100 万 token 的美元填，和内置目录同一个单位。', 'Prices are USD per 1M tokens, same unit as the built-in catalog.')}</p>
        </div>
        ${state.providerError ? `<div class="gw-flash gw-flash-err">${esc(state.providerError)}</div>` : ''}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg);">
          ${rows || `<div style="padding: var(--space-5); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有模型。')}</div>`}
        </div>
        ${
          d
            ? `<div class="satu-panel">
          <span class="satu-panel-title">${t('新模型')}</span>
          <div class="field"><label>${t('模型 id')}</label><input class="input" data-act="model-field" data-field="id" value="${esc(d.id)}" placeholder="my-model" autocomplete="off"></div>
          <div class="field"><label>${t('名称')}</label><input class="input" data-act="model-field" data-field="name" value="${esc(d.name)}" placeholder="My Model" autocomplete="off"></div>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="field"><label>${t('上下文窗口')}</label><input class="input" type="number" min="1" data-act="model-field" data-field="contextWindow" value="${esc(d.contextWindow)}"></div>
            <div class="field"><label>${t('最大输出')}</label><input class="input" type="number" min="1" data-act="model-field" data-field="maxTokens" value="${esc(d.maxTokens)}"></div>
            <div class="field"><label>${t('输入单价 / 1M')}</label><input class="input" type="number" min="0" step="0.01" data-act="model-field" data-field="costInput" value="${esc(d.costInput)}"></div>
            <div class="field"><label>${t('输出单价 / 1M')}</label><input class="input" type="number" min="0" step="0.01" data-act="model-field" data-field="costOutput" value="${esc(d.costOutput)}"></div>
          </div>
          <div class="satu-toggleRow">
            <div style="font-size: 13.5px; font-weight: 600;">${t('推理模型')}</div>
            <input type="checkbox" data-act="model-field" data-field="reasoning" ${d.reasoning ? 'checked' : ''}>
          </div>
          <div class="satu-toggleRow">
            <div style="font-size: 13.5px; font-weight: 600;">${t('支持图片输入')}</div>
            <input type="checkbox" data-act="model-field" data-field="image" ${d.image ? 'checked' : ''}>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
            <button type="button" class="btn btn-ghost" data-act="prov-model-cancel">${t('取消')}</button>
            <button type="button" class="btn btn-primary" data-act="prov-model-save" ${state.busy ? 'disabled' : ''}>${t('添加')}</button>
          </div>
        </div>`
            : `<button type="button" class="btn btn-secondary" data-act="prov-model-new">${t('添加模型')}</button>`
        }
        <div style="display: flex; justify-content: flex-end;">
          <button type="button" class="btn btn-ghost" data-act="prov-models-close">${t('完成')}</button>
        </div>
      </div>
    </div>`
}

function companyPage() {
  const c = state.org || state.me?.company || {}
  const plan = state.plan || state.me?.plan || { seats: 1, used: 0 }
  return `
    <div class="gw-page">
      <div class="gw-page-inner narrow">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('公司')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('名称、slug、联系人和访问地址。席位由系统管理员分配。')}</p>
        </div>
        ${flashes()}
        <form id="company-form" class="satu-panel" style="gap: var(--space-4);">
          <span class="satu-panel-title">${t('资料')}</span>
          <div class="field">
            <label for="co-name">${t('名称')}</label>
            <input class="input" id="co-name" name="name" value="${esc(c.name || '')}" required>
          </div>
          <div class="field">
            <label for="co-slug">slug</label>
            <input class="input" id="co-slug" name="slug" value="${esc(c.slug || '')}" required>
          </div>
          <div class="field">
            <label for="co-url">${t('访问地址')}</label>
            <input class="input" id="co-url" name="accessUrl" value="${esc(c.accessUrl || '')}" placeholder="https://acme.satuwork.com">
          </div>
          <div class="field">
            <label for="co-contact-name">${t('联系人')}</label>
            <input class="input" id="co-contact-name" name="contactName" value="${esc(c.contactName || '')}" required>
          </div>
          <div class="field">
            <label for="co-contact-phone">${t('电话')}</label>
            ${phoneField('co-contact-phone', c.contactPhone)}
          </div>
          <div class="field">
            <label for="co-contact-email">${t('联系邮箱')}</label>
            <input class="input" id="co-contact-email" name="contactEmail" type="email" value="${esc(c.contactEmail || '')}" required>
          </div>
          <div class="field">
            <label for="co-address">${t('公司地址')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
            <input class="input" id="co-address" name="address" value="${esc(c.address || '')}">
          </div>
          <div class="field">
            <label for="co-website">${t('网站')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('选填')}</span></label>
            <input class="input" id="co-website" name="website" value="${esc(c.website || '')}" placeholder="https://acme.com">
          </div>
          <div class="field">
            <label>${t('席位')}</label>
            <p style="margin: 0; font-size: 14px;">${t(`已用 ${esc(plan.used || 0)} / ${esc(plan.seats || 0)}`, `${esc(plan.used || 0)} / ${esc(plan.seats || 0)} used`)}</p>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('席位由系统管理员分配')}</span>
          </div>
          <div class="field">
            <label>${t('订阅套餐')}</label>
            <p style="margin: 0; font-size: 14px;">${esc(planLabel(plan) || t('无套餐'))}</p>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('到期时间')} ${esc(plan.expiresAt ? dayISO(plan.expiresAt) : t('不限期'))}</span>
          </div>
          <div style="display: flex; justify-content: flex-end;">
            <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${t('保存')}</button>
          </div>
        </form>
      </div>
    </div>`
}

function memberMeId() {
  return state.memberMe?.id || state.me?.account?.id || ''
}

function roleLabelOf(role) {
  if (role === 'admin') return t('管理员')
  if (role === 'owner') return t('系统管理员')
  return t('成员')
}

const GROUP_ICONS = [
  { key: 'chat', name: '对话', paths: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'] },
  { key: 'chart', name: '数据', paths: ['M3 3v16a2 2 0 0 0 2 2h16', 'M8 17v-4', 'M13 17v-9', 'M18 17v-6'] },
  {
    key: 'users',
    name: '团队',
    paths: [
      'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2',
      'M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z',
      'M22 21v-2a4 4 0 0 0-3-3.87',
      'M16 3.13a4 4 0 0 1 0 7.75',
    ],
  },
  { key: 'guest', name: '外部', paths: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3a13 13 0 0 1 0 18 13 13 0 0 1 0-18z'] },
  { key: 'code', name: '研发', paths: ['m8 8-4 4 4 4', 'm16 8 4 4-4 4', 'm13 6-2 12'] },
  { key: 'deal', name: '销售', paths: ['M3 3h8l10 10-8 8L3 11z', 'M7 7h.01'] },
  { key: 'shield', name: '权限', paths: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'] },
  { key: 'star', name: '重点', paths: ['m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8 6.2 20.9l1.1-6.5L2.6 9.8l6.5-.9z'] },
]

function groupIcon(key, size = 16) {
  const g = GROUP_ICONS.find((x) => x.key === key) || GROUP_ICONS[0]
  return svg(g.paths, size)
}

function emptyGroupForm() {
  return { name: '', desc: '', icon: 'chat', role: 'member', members: [] }
}

function syncGroupForm() {
  const name = document.getElementById('gp-name')
  const desc = document.getElementById('gp-desc')
  if (name instanceof HTMLInputElement) state.groupForm.name = name.value
  if (desc instanceof HTMLInputElement) state.groupForm.desc = desc.value
}

function groupById(id) {
  return (state.groups || []).find((g) => g.id === id)
}

const MEMBER_STATUS = {
  active: { label: '已激活', tag: 'tag-accent-2', hint: '可正常登录并使用已授权的 AI 员工。' },
  invited: { label: '待接受', tag: 'tag-accent', hint: '等 TA 用邀请链接设完口令，会自动转为已激活。' },
  disabled: { label: '已停用', tag: 'tag-neutral', hint: '立即断开其全部登录，且无法再登录。历史记录保留。' },
}

function ago(ts) {
  if (!ts) return t('从未登录')
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return t('刚刚')
  if (m < 60) return t(`${m} 分钟前`, `${m} min ago`)
  if (m < 60 * 24) return t(`${Math.floor(m / 60)} 小时前`, `${Math.floor(m / 60)} h ago`)
  return t(`${Math.floor(m / 1440)} 天前`, `${Math.floor(m / 1440)} d ago`)
}

function canBeStatus(member, key) {
  return key === 'invited' ? member.status === 'invited' : member.status !== 'invited' || key === 'disabled'
}

function whyNotStatus(key) {
  return key === 'invited'
    ? t('已激活的账号退不回待接受。要让 TA 重设口令，用下面的重置链接。')
    : t('等 TA 用邀请链接设完口令，会自动转为已激活。')
}

function iconCopy() {
  return svg(
    [
      'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z',
      'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
    ],
    15,
  )
}

function statCard(label, value) {
  return `<div class="satu-stat">
    <span style="font-size: 12px; color: var(--muted-foreground);">${esc(label)}</span>
    <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(value)}</span>
  </div>`
}

function confirmModal() {
  const c = state.confirm
  if (!c) return ''
  return `<div class="gw-modal-backdrop" data-act="confirm-cancel">
    <div class="gw-modal" data-stop>
      <div>
        <h2 style="font-size: 20px; margin: 0 0 4px;">${esc(c.title)}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${esc(c.body)}</p>
      </div>
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="confirm-cancel">${t('取消')}</button>
        <button type="button" class="btn btn-primary" data-act="confirm-ok">${esc(t(c.label))}</button>
      </div>
    </div>
  </div>`
}

function secretModal() {
  const s = state.secret
  if (!s) return ''
  const days = Math.max(0, Math.round((s.expiresAt - Date.now()) / 86400000))
  const hours = Math.max(0, Math.round((s.expiresAt - Date.now()) / 3600000))
  const ttl = days >= 1 ? t(`${days} 天后过期`, `expires in ${days} d`) : t(`${hours || 1} 小时内有效`, `valid for ${hours || 1} h`)
  return `<div class="gw-modal-backdrop" data-act="secret-close">
    <div class="gw-modal" data-stop>
      <div>
        <h2 style="font-size: 20px; margin: 0 0 4px;">${esc(s.title)}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
          ${t(`把这条链接发给 <b>${esc(s.email)}</b>，他打开后自行设置口令。链接只显示这一次，${esc(ttl)}，用过即失效。`, `Send this link to <b>${esc(s.email)}</b>; they set their own password. Shown once, ${esc(ttl)}, single use.`)}
        </p>
      </div>
      <div style="display: flex; align-items: center; gap: var(--space-2);">
        <code class="satu-code" style="flex: 1; min-width: 0; padding: 10px var(--space-3); font-size: 12.5px; overflow-x: auto; white-space: nowrap;">${esc(s.url)}</code>
        <button type="button" class="btn btn-secondary" style="flex: none;" data-act="secret-copy">${iconCopy()} ${state.inviteCopied && state.secret ? t('已复制') : t('复制')}</button>
      </div>
      <div style="display: flex; justify-content: flex-end;">
        <button type="button" class="btn btn-primary" data-act="secret-close">${t('我记下了')}</button>
      </div>
    </div>
  </div>`
}

function inviteModal() {
  if (!state.inviteOpen) return ''
  const f = state.inviteForm
  const link = state.inviteLink
  const btn = state.busy
    ? t('生成中…')
    : link
      ? state.inviteCopied
        ? t('已复制')
        : t('再复制一次')
      : t('生成并复制链接')
  return `<div class="gw-modal-backdrop" data-act="invite-close">
    <form id="invite-form" class="gw-modal" style="max-width: 500px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('邀请成员')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('生成一条一次性邀请链接，发给要加入的同事。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="invite-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
        <div class="field">
          <label for="iv-name">${t('姓名')}</label>
          <input class="input" id="iv-name" name="name" type="text" value="${esc(f.name)}" placeholder="${esc(t('受邀人姓名'))}" ${link ? 'disabled' : ''}>
        </div>
        <div class="field">
          <label for="iv-email">${t('邮箱')}</label>
          <input class="input" id="iv-email" name="email" type="email" required value="${esc(f.email)}" placeholder="name@acme.com" ${link ? 'disabled' : ''}>
        </div>
      </div>
      <span style="font-size: 12px; color: var(--muted-foreground); margin-top: calc(var(--space-3) * -1);">${t('链接只对该邮箱有效，对方打开后仅需设置口令即可加入。')}</span>
      <div class="field">
        <label for="iv-link">${t('一次性邀请链接')}</label>
        <input class="input" id="iv-link" type="text" readonly value="${esc(link)}" placeholder="${esc(t('点下方按钮生成'))}" style="min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;">
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('仅可使用 1 次，生成后按下方有效期失效。链接只显示这一次。')}</span>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
        <div class="field">
          <label for="iv-role">${t('角色')}</label>
          <select class="input" id="iv-role" name="role" ${link ? 'disabled' : ''}>
            <option value="member" ${f.role === 'member' ? 'selected' : ''}>${t('成员')}</option>
            <option value="admin" ${f.role === 'admin' ? 'selected' : ''}>${t('管理员')}</option>
          </select>
        </div>
        <div class="field">
          <label for="iv-ttl">${t('链接有效期')}</label>
          <select class="input" id="iv-ttl" name="ttlDays" ${link ? 'disabled' : ''}>
            <option value="1" ${String(f.ttlDays) === '1' ? 'selected' : ''}>${t('1 天')}</option>
            <option value="7" ${String(f.ttlDays) === '7' ? 'selected' : ''}>${t('7 天')}</option>
            <option value="30" ${String(f.ttlDays) === '30' ? 'selected' : ''}>${t('30 天')}</option>
          </select>
        </div>
      </div>
      ${state.inviteError ? `<div class="gw-flash gw-flash-err">${esc(state.inviteError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="invite-close">${link ? t('完成') : t('取消')}</button>
        <button type="submit" class="btn btn-primary" style="min-width: 104px;" ${state.busy ? 'disabled' : ''}>${btn}</button>
      </div>
    </form>
  </div>`
}

function groupModal() {
  if (!state.groupDialog) return ''
  const f = state.groupForm
  const editing = !!(state.groupDialog && state.groupDialog.id)
  const icons = GROUP_ICONS.map((g) => {
    const on = f.icon === g.key
    return `<button type="button" class="satu-iconpick" aria-pressed="${String(on)}" aria-label="${esc(g.name)}" title="${esc(g.name)}" data-act="group-icon" data-icon="${esc(g.key)}">${svg(g.paths)}</button>`
  }).join('')
  const roles = ['admin', 'member']
    .map(
      (key) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(f.role === key)}" data-act="group-role" data-role="${key}">${roleLabelOf(key)}</button>`,
    )
    .join('')
  const picked = new Set(f.members || [])
  const people = (state.accounts || [])
    .map((m) => {
      const on = picked.has(m.id)
      const label = m.name ? `${m.name} · ${m.email}` : m.email
      return `<button type="button" class="satu-fileitem" aria-current="${String(on)}" data-act="group-toggle-member" data-id="${esc(m.id)}">
        <span class="satu-avatar" style="width: 24px; height: 24px; font-size: 11px; background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc((m.name || m.email).slice(0, 1).toUpperCase())}</span>
        <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(label)}</span>
        ${on ? `<span style="margin-left: auto; display: flex;">${svg(['m5 13 4 4L19 7'], 14)}</span>` : ''}
      </button>`
    })
    .join('')
  return `<div class="gw-modal-backdrop" data-act="group-close">
    <form id="group-form" class="gw-modal" style="max-width: 460px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${editing ? t('管理分组') : t('新建分组')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('分组用于批量授权与统计，成员可同时属于多个分组。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="group-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div class="field">
        <label for="gp-name">${t('分组名称')}</label>
        <input class="input" id="gp-name" name="name" type="text" required value="${esc(f.name)}" placeholder="${esc(t('例如：客服组'))}">
      </div>
      <div class="field">
        <label for="gp-desc">${t('说明（可选）')}</label>
        <input class="input" id="gp-desc" name="desc" type="text" value="${esc(f.desc)}" placeholder="${esc(t('这个分组负责什么'))}">
      </div>
      <div class="field">
        <label>${t('分组图标')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${icons}</div>
      </div>
      <div class="field">
        <label>${t('默认角色')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${roles}</div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('只影响之后被加进这个组的人，不改动已有成员的角色。')}</span>
      </div>
      <div class="field">
        <label>${t('成员')}</label>
        <div style="display: flex; flex-direction: column; gap: 1px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-2); max-height: 220px; overflow-y: auto;">
          ${people || `<span style="font-size: 12px; color: var(--muted-foreground); padding: 6px var(--space-2);">${t('还没有成员')}</span>`}
        </div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${t(`已选 ${picked.size} 人`, `${picked.size} selected`)}</span>
      </div>
      ${state.groupError ? `<div class="gw-flash gw-flash-err">${esc(state.groupError)}</div>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="group-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : editing ? t('保存') : t('创建分组')}</button>
      </div>
    </form>
  </div>`
}

function editModal() {
  const member = state.editing
  if (!member) return ''
  const isSelf = member.id === memberMeId()
  const f = state.editForm
  const statusBtns = ['active', 'disabled', 'invited']
    .map((key) => {
      const ok = canBeStatus(member, key)
      const disabled = isSelf || !ok
      return `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(f.status === key)}" ${disabled ? 'disabled' : ''} title="${ok ? '' : esc(whyNotStatus(key))}" data-act="edit-status" data-status="${key}">${t(MEMBER_STATUS[key].label)}</button>`
    })
    .join('')
  const roleBtns = ['admin', 'member']
    .map(
      (key) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(f.role === key)}" ${isSelf ? 'disabled' : ''} data-act="edit-role" data-role="${key}">${roleLabelOf(key)}</button>`,
    )
    .join('')
  const hint = MEMBER_STATUS[f.status]?.hint || ''
  return `<div class="gw-modal-backdrop" data-act="edit-close">
    <form id="edit-member-form" class="gw-modal" style="max-width: 460px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${t('编辑成员')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('修改角色与状态，或给 TA 发一条口令重置链接。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="edit-close">${svg(['M18 6 6 18', 'M6 6l12 12'], 16)}</button>
      </div>
      <div style="display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
        <span class="satu-avatar" style="background: var(--color-accent-2-200); color: var(--color-accent-2-800);">${esc((member.name || member.email).slice(0, 1).toUpperCase())}</span>
        <div style="min-width: 0;">
          <div style="font-size: 14px; font-weight: 600;">${esc(member.name)}</div>
          <div style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(member.email)}</div>
        </div>
      </div>
      <div class="field">
        <label for="em-name">${t('姓名')}</label>
        <input class="input" id="em-name" name="name" type="text" required value="${esc(f.name)}">
      </div>
      <div class="field">
        <label>${t('角色')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${roleBtns}</div>
      </div>
      <div class="field">
        <label>${t('状态')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${statusBtns}</div>
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint)}</span>
      </div>
      ${isSelf ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('不能改自己的角色与状态——手滑一次就把自己关在门外。')}</span>` : ''}
      <div style="display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3);">
          <div style="min-width: 0;">
            <div style="font-size: 13.5px; font-weight: 600;">${t('口令重置链接')}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${t('生成后自行发给成员，1 小时内有效且仅能使用一次')}</div>
          </div>
          <button type="button" class="btn btn-secondary" style="flex: none;" data-act="edit-reset">${state.editLink ? t('重新生成') : t('生成链接')}</button>
        </div>
        ${
          state.editLink
            ? `<div style="display: flex; align-items: center; gap: var(--space-2);">
            <code class="satu-code" style="flex: 1; min-width: 0; padding: 8px var(--space-3); font-size: 12px; overflow-x: auto; white-space: nowrap;">${esc(state.editLink)}</code>
            <button type="button" class="btn btn-secondary" style="flex: none;" data-act="edit-copy">${iconCopy()} ${state.editCopied ? t('已复制') : t('复制')}</button>
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('生成的同时，TA 当前的登录已全部失效。链接只显示这一次。Gateway 没有会话表，签发早于作废时间的 JWT 会被拒，未过期的票在此之前仍可能可用。')}</span>`
            : ''
        }
      </div>
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="edit-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('保存')}</button>
      </div>
    </form>
  </div>`
}

function memberRow(m) {
  const meId = memberMeId()
  const isSelf = m.id === meId
  const st = MEMBER_STATUS[m.status] || MEMBER_STATUS.active
  const last =
    isSelf ? t('正在使用') : m.status === 'invited' ? t(`邀请于 ${new Date(m.createdAt).toLocaleDateString('zh-CN')}`, `Invited ${new Date(m.createdAt).toLocaleDateString('en-US')}`) : ago(m.lastSeenAt)
  const canManage = isAdmin() || isOwner()
  const menu = state.menu === m.id
    ? `<div class="satu-menu" data-flip="${String(!!state.menuFlip)}">
        <button type="button" class="satu-menuitem" data-act="edit-open" data-id="${esc(m.id)}">${t('编辑成员')}</button>
        <button type="button" class="satu-menuitem" data-act="member-reset" data-id="${esc(m.id)}">${m.status === 'invited' ? t('重发邀请') : t('重置口令')}</button>
        ${
          m.status !== 'active'
            ? `<button type="button" class="satu-menuitem" ${m.status === 'invited' ? 'disabled' : ''} title="${m.status === 'invited' ? t('等 TA 用邀请链接设完口令，会自动转为已激活。') : ''}" data-act="member-enable" data-id="${esc(m.id)}">${t(MEMBER_STATUS.active.label)}</button>`
            : ''
        }
        ${
          m.status !== 'disabled'
            ? `<button type="button" class="satu-menuitem" data-act="member-disable" data-id="${esc(m.id)}">${t(MEMBER_STATUS.disabled.label)}</button>`
            : ''
        }
        <div style="height: 1px; background: var(--border); margin: 4px 0;"></div>
        <button type="button" class="satu-menuitem" data-danger="true" data-act="member-delete" data-id="${esc(m.id)}">${t('删除')}</button>
      </div>`
    : ''
  return `<div class="satu-memberrow">
    <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
      <span class="satu-avatar" style="background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc((m.name || m.email).slice(0, 1).toUpperCase())}</span>
      <div style="min-width: 0;">
        <div style="font-size: 13.5px; font-weight: 600;">${esc(m.name || m.email)}${isSelf ? t(' · 你') : ''}</div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${esc(m.email)}</div>
      </div>
    </div>
    <span style="font-size: 13px;">${esc(roleLabelOf(m.role))}</span>
    <span class="tag ${st.tag}">${t(st.label)}</span>
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(last)}</span>
    <div class="satu-rowactions" style="display: flex; justify-content: flex-end; position: relative;">
      ${isSelf ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('你')}</span>` : ''}
      ${
        canManage
          ? `<button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('编辑成员'))}" data-act="edit-open" data-id="${esc(m.id)}">${svg(['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'], 15)}</button>`
          : ''
      }
      ${
        canManage && !isSelf
          ? `<button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('更多操作'))}" data-menu-toggle data-act="menu-toggle" data-id="${esc(m.id)}">${svg(['M12 6h.01', 'M12 12h.01', 'M12 18h.01'], 16)}</button>`
          : ''
      }
      ${menu}
    </div>
  </div>`
}

function groupRow(g) {
  const canManage = isAdmin() || isOwner()
  const markStyle = g.builtin
    ? 'background: var(--color-accent-100); color: var(--color-accent-800);'
    : 'background: var(--color-accent-2-100); color: var(--color-accent-2-800);'
  const actions = g.builtin
    ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('自动包含全部成员')}</span>`
    : `<button type="button" class="satu-linkbtn" ${canManage ? '' : 'disabled'} data-act="group-edit" data-id="${esc(g.id)}">${t('管理成员')}</button>
       <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('删除分组'))}" ${canManage ? '' : 'disabled'} data-act="group-delete" data-id="${esc(g.id)}">${svg(['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14'], 15)}</button>`
  const role = g.builtin ? t('按成员设置') : roleLabelOf(g.role)
  const created = g.createdAt ? new Date(g.createdAt).toISOString().slice(0, 10) : '—'
  const n = Array.isArray(g.members) ? g.members.length : 0
  return `<div class="satu-grouprow">
    <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
      <span class="satu-providermark" style="${markStyle}">${groupIcon(g.icon, 16)}</span>
      <div style="min-width: 0;">
        <div style="display: flex; align-items: center; gap: var(--space-2);">
          <span style="font-size: 14px; font-weight: 600;">${esc(g.name)}</span>
          ${g.builtin ? `<span class="tag tag-accent-2">${t('固定分组')}</span>` : ''}
        </div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${esc(g.desc || '')}</div>
      </div>
    </div>
    <span style="font-size: 13px;">${t(`${n} 人`, `${n} people`)}</span>
    <span style="font-size: 13px;">${esc(role)}</span>
    <span style="font-size: 13px; color: var(--muted-foreground);">${esc(created)}</span>
    <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-3); justify-content: flex-end;">${actions}</div>
  </div>`
}

function accountsPage() {
  const members = state.accounts || []
  const groups = state.groups || []
  const seats = state.seats || { total: 0, used: 0 }
  const admins = members.filter((m) => m.role === 'admin').length
  const pending = members.filter((m) => m.status === 'invited').length
  const left = (seats.total || 0) - (seats.used || 0)
  const canManage = isAdmin() || isOwner()
  const tab = state.accountsTab === 'groups' ? 'groups' : 'members'
  const headerAct = tab === 'members' ? 'invite-open' : 'group-open'
  const headerLabel = tab === 'members' ? t('邀请成员') : t('新建分组')
  const tabs = [
    { key: 'members', label: '成员' },
    { key: 'groups', label: '分组' },
  ]
    .map(
      (item) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === item.key)}" data-act="accounts-tab" data-tab="${item.key}">${t(item.label)}</button>`,
    )
    .join('')
  const membersBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-6);">
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-3);">
            ${statCard(t('成员'), members.length)}
            ${statCard(t('管理员'), admins)}
            ${statCard(t('待接受邀请'), pending)}
            ${statCard(t('席位余量'), left)}
          </div>
          <div style="display: flex; flex-direction: column; gap: var(--space-3);">
            <div style="display: flex; align-items: baseline; justify-content: space-between;">
              <h2 style="font-size: 18px; margin: 0;">${t('成员')}</h2>
              <span style="font-size: 12px; color: var(--muted-foreground);">${t(`共 ${members.length} 人`, `${members.length} people`)}</span>
            </div>
            <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
              <div class="satu-memberhead">
                <span>${t('成员')}</span><span>${t('角色')}</span><span>${t('状态')}</span><span>${t('最近活跃')}</span><span></span>
              </div>
              ${members.map(memberRow).join('') || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有成员')}</div>`}
            </div>
          </div>
        </div>`
  const groupsBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-grouphead">
              <span>${t('分组')}</span><span>${t('成员')}</span><span>${t('默认角色')}</span><span>${t('创建时间')}</span><span></span>
            </div>
            ${groups.map(groupRow).join('') || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有分组')}</div>`}
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('「全体成员」为系统固定分组，新成员加入后自动进入，不可删除或移除成员。')}</span>
        </div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('账号管理')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('邀请同事加入，并管理成员角色与权限。')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" ${canManage ? '' : 'disabled'} title="${canManage ? '' : t('需要管理员权限')}" data-act="${headerAct}">
            ${svg(['M12 5v14', 'M5 12h14'], 15)} ${headerLabel}
          </button>
        </div>
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">${tabs}</div>
        ${flashes()}
        ${tab === 'members' ? membersBody : groupsBody}
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('成员这一半是真的：停用会当场作废对方已签发的 JWT（签发早于作废时间的票会被拒），重置口令同样作废旧登录。角色与权限的判断在服务端，界面上的禁用只是提前告诉你结果。Gateway 没有会话表，未过期且签发于作废之后的 JWT 仍可用，直到过期；停用账号登录会被拒绝。')}</p>
      </div>
    </div>
    ${inviteModal()}
    ${editModal()}
    ${groupModal()}
    ${secretModal()}`
}
