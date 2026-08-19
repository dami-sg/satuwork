/**
 * 页面骨架与重绘：pageView / appView / render()，外加各种表单的保存与提交。
 *
 * render() 是整页 innerHTML 换掉，所以对话正文不走它——那边是 paintChat 增量填（见 chat.js）。
 */
function pageView() {
  if (state.path.startsWith('/bots/')) return botDetailPage()
  if (state.path.startsWith('/companies/') && state.path !== '/companies') return companyDetailPage()
  if (state.path.startsWith('/users/') && state.path !== '/users') return userDetailPage()
  if (state.path.startsWith('/machines/') && state.path !== '/machines') return machineDetailPage()
  if (state.path.startsWith('/audit/') && state.path !== '/audit') return auditDetailPage()
  if (isChatPath(state.path)) return chatPage()
  switch (state.path) {
    case '/bots':
      return botsPage()
    case '/skills':
      return skillsPage()
    case '/models':
      return modelsPage()
    case '/providers':
      return providersPage()
    case '/company':
      return companyPage()
    case '/accounts':
      return accountsPage()
    case '/audit':
      return auditPage()
    case '/machines':
      return machinesPage()
    case '/releases':
      return releasesPage()
    case '/companies':
      return companiesPage()
    case '/users':
      return usersPage()
    case '/orders':
      return ordersPage()
    case '/plans':
      return plansPage()
    case '/stats':
      return statsPage()
    case '/billing':
    case '/costs':
      return billingPage()
    case '/usage':
      return usagePage()
    case '/catalog':
      return placeholderPage(t('公司目录'), t('公司 Bot / Skill / MCP'))
    case '/profile':
      return profilePage()
    default:
      return overviewPage()
  }
}

/**
 * 当前页面的右侧栏。目前只有对话页有。
 *
 * 折叠时不是 `display:none`，而是留一条 34px 的竖条 —— 收起来之后还得有地方点回去，
 * 而且列宽从 280 变 34 有过渡，不会突然跳一下。
 */
function pageAside() {
  if (!hasAside()) return ''
  // 折叠 = 整个不渲染。开关挪到了对话 header 上，这里不用再留一条竖条给人点回去。
  if (!asidePref.open) return ''
  return `<aside class="gw-aside">
    <div class="gw-aside-grip" data-act="aside-grip" title="${esc(t('拖动调整宽度'))}"></div>
    <div class="gw-aside-body">
      <h3>${t('运行环境')}</h3>
      ${chatMachinePanel()}
    </div>
  </aside>`
}

/** 右栏开关。放在对话 header 上，所以折叠之后仍然点得到——右栏本身是整个不渲染的。 */
function asideToggle() {
  if (!hasAside()) return ''
  const open = asidePref.open
  return `<button type="button" class="btn btn-ghost btn-icon" style="margin-left: auto; flex: none;"
    data-act="aside-toggle" aria-pressed="${open}"
    aria-label="${esc(open ? t('收起运行环境') : t('展开运行环境'))}"
    title="${esc(t('运行环境'))}">${svg(MONITOR, 16)}</button>`
}

/** 在不在对话页。顶栏换不换成会话身份行、右栏开不开，都看它，免得两处判断漂移。 */
function onChatPage() {
  if (!state.me) return false
  const onChat = state.path === '/chat' || state.path.startsWith('/a/') || (memberChatHome() && state.path === '/')
  return onChat && Boolean(chatBotIdOf(state.path) || state.chatBotId)
}

/** 这一页有没有右栏可开。 */
function hasAside() {
  return onChatPage()
}

function appView() {
  const rail = state.rail
  const crumbs = crumbsOf(state.path)
  // 对话页不要面包屑也不要「对话」两个字——顶栏整条让给会话身份行。
  const head = onChatPage()
    ? chatHeadInline()
    : crumbs
    ? `<button type="button" class="btn btn-ghost btn-icon" style="flex: none;" data-act="go" data-href="${esc(crumbs.href)}" aria-label="${esc(t('返回'))}" title="${esc(crumbs.parent)}">${svg(BACK_ARROW, 17)}</button>
        <nav class="satu-crumbs" aria-label="${esc(t('面包屑', 'Breadcrumb'))}">
          <button type="button" class="satu-crumblink" data-act="go" data-href="${esc(crumbs.href)}">${esc(crumbs.parent)}</button>
          <span class="satu-crumbsep" aria-hidden="true">/</span>
          <span class="satu-crumbcur" aria-current="page">${esc(crumbs.current)}</span>
        </nav>`
    : `<span style="font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(pageTitle(state.path))}</span>`
  const account = state.me?.account || {}
  const email = account.email || ''
  const displayName = account.name || email || '…'
  const initial = initialOf(account)
  const nav = navForRole()
  const home = nav[0]
  const rest = nav.slice(1)
  const roster = chatRosterNav()
  const groupLabel = isOwner() ? t('平台') : isAdmin() ? t('公司') : ''
  const mainNav = home ? navItem(home) : ''
  const restNav = rest.map(navItem).join('')
  // 右栏和 header 同高：把 main 做成两行两列的 grid，侧栏跨两行占右列。做成 header
  // 下面的兄弟节点就顶不上去了。
  const aside = pageAside()
  const asideCols = aside
    ? `grid-template-columns: minmax(0, 1fr) ${asidePref.width}px;`
    : 'grid-template-columns: minmax(0, 1fr);'
  return `
  <div style="height: 100vh; overflow: hidden; display: grid; grid-template-columns: ${rail ? '62px' : '248px'} 1fr; gap: var(--space-4); padding: var(--space-4); background: var(--color-bg); font-family: var(--font-body); color: var(--color-text); box-sizing: border-box;">
    <aside class="${rail ? 'satu-rail' : ''}" style="height: 100%; min-height: 0; overflow: hidden; box-sizing: border-box; display: flex; flex-direction: column; background: var(--color-surface); border-radius: var(--radius-md); padding: var(--space-4) var(--space-2) var(--space-2);">
      <button type="button" class="satu-brand" data-act="go" data-href="/" style="display: flex; align-items: center; gap: var(--space-2); padding: 0 var(--space-3) var(--space-4); border: 0; background: transparent; cursor: pointer; color: inherit;">
        <img src="/assets/satuwork-logo.png" alt="Satuwork" style="width: 32px; height: 32px; min-width: 32px; flex: none; object-fit: contain; border-radius: var(--radius-sm);">
        <span class="satu-brandtext" style="font-family: var(--font-heading); font-size: 19px;">Satuwork</span>
      </button>
      ${/* 名单吃掉剩下的全部高度并自己滚；下面那组导航沉到底，不跟着一起滚走。
            Bot 是这一屏的主体，页面入口是配角，位置上就该这么分。

            **但没有名单时不能留那个占位。** 平台管理员这一侧永远没有 Bot（他没有席位，
            /runtime/bots 对他 403），于是占位每次都撑满，把整组菜单压到屏幕底部，上面
            空一大片——沉底的理由是「给名单让位」，名单不在，理由也就不在了。 */ ''}
      <div style="flex: 1; min-height: 0; display: flex; flex-direction: column;">
        ${roster ? `<div class="satu-botlist">${roster}</div>` : ''}
        ${
          mainNav || restNav
            ? `<div class="satu-navfoot">
          <div class="satu-sep"></div>
          ${groupLabel ? `<p class="satu-group">${esc(groupLabel)}</p>` : ''}
          ${mainNav}${restNav}
        </div>`
            : ''
        }
      </div>
      ${/* box-sizing 必须写死：侧栏是 border-box，这一行不写就按 content-box 算，
            宽度比容器多出左右内边距，齿轮会顶出侧栏外沿。 */ ''}
      <div class="satu-userrow" style="display: flex; align-items: center; gap: var(--space-2); box-sizing: border-box; width: 100%; padding: var(--space-3); margin-top: var(--space-2); border-top: 1px solid var(--color-divider);">
        <div style="width: 30px; height: 30px; flex: none; border-radius: 999px; background: var(--color-accent-200); display: flex; align-items: center; justify-content: center; font-family: var(--font-heading); font-size: 13px; color: var(--color-accent-800);">${esc(initial)}</div>
        <div class="satu-userinfo" style="line-height: 1.25; min-width: 0; flex: 1;">
          <div style="font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(displayName)}</div>
          <div style="font-size: 11px; color: color-mix(in srgb, var(--color-text) 50%, transparent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(email)}</div>
        </div>
        <button type="button" class="btn btn-ghost btn-icon satu-usercog" style="flex: none;" data-act="go" data-href="/profile" aria-label="${esc(t('个人设置'))}" aria-pressed="${String(state.path === '/profile')}">${svg(GEAR, 16)}</button>
      </div>
    </aside>
    <main id="gw-main" class="gw-main${aside ? ' gw-main-aside' : ''}" style="${asideCols}">
      <div class="gw-head">
        <button type="button" class="btn btn-ghost btn-icon" data-act="rail" aria-label="${rail ? t('展开侧栏') : t('收起侧栏')}">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></svg>
        </button>
        <div style="width: 1px; height: 18px; background: var(--color-divider);"></div>
        ${head}
        ${asideToggle()}
      </div>
      <div class="gw-body">${pageView()}</div>
      ${aside}
    </main>
    ${confirmModal()}
    ${logsModal()}
    ${previewModal()}
  </div>`
}

/** 上一帧画的是哪个页面。换页要回到顶部，原地重绘不能动——见 render()。 */
let paintedPath = null

/**
 * 重绘。整页是 innerHTML 整块换掉的，滚动位置跟着一起没——在同一个页面上按一个
 * 开关（记忆范围、勾选项这些都会重绘一次）视线就被扔回页首，页面越长越难受。
 * 所以换之前记下内容区滚到哪儿，换完贴回去；只有真的换了页面才落回顶部。
 */
function render() {
  const root = document.getElementById('app')
  // 对话页没有 .gw-page（自己那套滚动容器由 paintChat 管），这里就是 null，跳过。
  const before = document.querySelector('.gw-page')
  const keep = before && paintedPath === state.path ? before.scrollTop : 0
  paintedPath = state.path
  if (state.path.startsWith('/join/')) {
    root.innerHTML = joinView()
    syncDesktop()
    return
  }
  if (!state.me && state.needsSetup) {
    root.innerHTML = setupView()
    syncDesktop()
    return
  }
  root.innerHTML = state.me ? appView() : loginView()
  // 对话页的正文不在 appView 里——chatPage 只搭空壳，消息由 paintChat 增量填。
  // 整页重绘会把那个壳换掉，所以每次 render 之后要补一次。
  if (document.getElementById('chat-thread')) paintChat()
  // 日志面板同理：壳在 render 里，内容由 paintLogs 增量填。
  if (document.getElementById('log-body')) paintLogs()
  // 内嵌桌面那块屏活在 #app 外面（重绘换不掉它），但它的位置是照着右栏里的空槽算
  // 的——壳换过一次就得重新对齐。
  syncDesktop()
  if (!keep) return
  const after = document.querySelector('.gw-page')
  if (after) after.scrollTop = keep
}

async function saveProfile() {
  if (!profileDirty()) return
  const form = profileForm()
  state.busy = true
  state.profileError = ''
  render()
  try {
    await api('PATCH', '/me', { name: form.name, title: form.title, phone: form.phone })
    state.profileDraft = null
    state.profileSaved = true
    await loadMe()
  } catch (err) {
    state.profileError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function submitPassword(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const current = String(fd.get('current') || '')
  const next = String(fd.get('next') || '')
  const confirm = String(fd.get('confirm') || '')
  state.pwForm = { current, next, confirm }
  if (next !== confirm) {
    state.pwError = t('两次输入的新口令不一致', 'The two new passwords do not match')
    render()
    return
  }
  state.busy = true
  state.pwError = ''
  render()
  try {
    const data = await api('POST', '/me/password', { current, next })
    if (data.token) setToken(data.token)
    state.pwOpen = false
    state.pwForm = { current: '', next: '', confirm: '' }
    state.profileSaved = true
    await loadMe()
  } catch (err) {
    state.pwError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function onSetup(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const email = String(fd.get('email') || '').trim()
  const name = String(fd.get('name') || '').trim()
  const password = String(fd.get('password') || '')
  const confirm = String(fd.get('confirm') || '')
  state.setupEmail = email
  state.setupName = name
  if (password !== confirm) {
    state.setupError = '两次输入的口令不一致'
    render()
    return
  }
  state.busy = true
  state.setupError = ''
  render()
  try {
    const data = await api('POST', '/auth/setup', { email, name, password })
    if (!data.token) throw new Error('创建响应没有 token')
    setToken(data.token)
    state.needsSetup = false
    await loadMe()
    state.path = '/'
    history.replaceState({}, '', '/')
    await loadPage()
  } catch (err) {
    // 别人抢先建好了就退回登录页，而不是让人对着一个永远失败的表单再点一次。
    if (String(err.message).includes('已经有系统管理员')) {
      state.needsSetup = false
      state.loginError = '系统管理员已创建，请登录'
    } else {
      state.setupError = err.message || '创建失败'
    }
  } finally {
    state.busy = false
    render()
  }
}

async function onLogin(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const email = String(fd.get('email') || '').trim()
  const password = String(fd.get('password') || '')
  state.busy = true
  state.loginError = ''
  state.loginEmail = email
  render()
  try {
    const data = await api('POST', '/auth/login', { email, password })
    if (!data.token) throw new Error('登录响应没有 token')
    setToken(data.token)
    await loadMe()
    state.path = '/'
    history.replaceState({}, '', '/')
    flash('ok', '')
    await loadPage()
  } catch (err) {
    clearToken()
    state.me = null
    state.loginError = err.message || '登录失败'
  } finally {
    state.busy = false
    render()
  }
}

async function saveSettings(patch) {
  const next = {
    daily: { ...(state.settings.daily || { provider: '', model: '' }) },
    utility: { ...(state.settings.utility || { provider: '', model: '' }) },
    enabledModels: Array.isArray(state.settings.enabledModels) ? state.settings.enabledModels : [],
    priceMultiplier: priceMultiplier(),
    ...patch,
  }
  if (patch.daily) next.daily = patch.daily
  if (patch.utility) next.utility = patch.utility
  // 换了模型，上一次的连通性结论就不作数了——留着那个绿字比没有还糟。
  for (const role of ['daily', 'utility']) {
    if (!patch[role]) continue
    const cur = state.settings?.[role] || {}
    if (cur.provider !== next[role].provider || cur.model !== next[role].model) delete state.tests[`role:${role}`]
  }
  state.settings = next
  render()
  try {
    const path = isOwner() ? '/platform/settings' : `/orgs/${encodeURIComponent(orgId())}/settings`
    state.settings = await api('PUT', path, next)
    if (state.me) state.me.settings = state.settings
    flash('ok', '已保存模型角色')
  } catch (err) {
    flash('err', err.message)
  }
  render()
}

/**
 * 存倍率。服务端也校验区间——这里先挡一道，是为了让输入框里那个手滑的值
 * 当场退回上一个有效值，而不是先画出来再被一条错误提示纠正。
 */
async function savePriceMultiplier(raw) {
  const prev = priceMultiplier()
  const n = Number(String(raw).trim())
  if (!Number.isFinite(n) || n < 0.01 || n > 100) {
    flash('err', '倍率只能是 0.01 到 100 之间的数字')
    render()
    return
  }
  if (n === prev) return
  state.savingMultiplier = true
  state.settings = { ...state.settings, priceMultiplier: n }
  render()
  try {
    const saved = await api('PUT', '/platform/settings', { ...state.settings, priceMultiplier: n })
    state.settings = saved
    if (state.me) state.me.settings = saved
    flash('ok', '已保存单价倍率')
  } catch (err) {
    state.settings = { ...state.settings, priceMultiplier: prev }
    flash('err', err.message)
  } finally {
    state.savingMultiplier = false
    render()
  }
}

async function testLlm(kind, payload) {
  const key = kind === 'role' ? `role:${payload.role}` : `provider:${payload.provider}`
  state.tests[key] = { status: 'busy', text: '测试中…' }
  render()
  try {
    const path = isOwner() ? '/platform/llm/test' : `/orgs/${encodeURIComponent(orgId())}/llm/test`
    const data = await api('POST', path, payload)
    if (data.ok) {
      const text = t(`通了 ${data.latencyMs}ms · ${data.provider}/${data.model}`, `OK ${data.latencyMs}ms · ${data.provider}/${data.model}`)
      state.tests[key] = { status: 'ok', text }
      flash('ok', text)
    } else {
      const text = data.error || '不通'
      state.tests[key] = { status: 'err', text }
      flash('err', text)
    }
  } catch (err) {
    state.tests[key] = { status: 'err', text: err.message }
    flash('err', err.message)
  }
  render()
}

/** 建或改自定义供应商。改的时候要把已有的 models 原样带上，否则一保存模型就没了。 */
async function saveCustomProvider() {
  const d = state.providerDraft
  if (!d) return
  state.busy = true
  d.error = ''
  render()
  try {
    const body = { name: d.name.trim() || d.id.trim(), baseUrl: d.baseUrl.trim(), api: d.api }
    if (d.editing) {
      body.models = customProvider(d.id)?.models || []
      await api('PUT', `/platform/providers/${encodeURIComponent(d.id)}`, body)
    } else {
      await api('POST', '/platform/providers', { ...body, id: d.id.trim(), models: [] })
    }
    await Promise.all([loadCustomProviders(), loadCatalog()])
    state.providerDraft = null
    flash('ok', d.editing ? '已保存' : '已添加自定义供应商')
  } catch (err) {
    d.error = err.message
  } finally {
    state.busy = false
    render()
  }
}

/** 模型清单是整份提交的：读出当前那份，改完再整份写回去。 */
async function putModels(providerId, models) {
  const p = customProvider(providerId)
  if (!p) throw new Error('自定义供应商不存在')
  await api('PUT', `/platform/providers/${encodeURIComponent(providerId)}`, {
    name: p.name,
    baseUrl: p.baseUrl,
    api: p.api,
    ...(p.headers ? { headers: p.headers } : {}),
    models,
  })
  await Promise.all([loadCustomProviders(), loadCatalog()])
}

async function saveCustomModel() {
  const d = state.modelDraft
  const p = customProvider(state.modelsFor)
  if (!d || !p) return
  state.busy = true
  state.providerError = ''
  render()
  try {
    const next = [...(p.models || []), {
      id: String(d.id).trim(),
      name: String(d.name).trim() || String(d.id).trim(),
      contextWindow: Number(d.contextWindow),
      maxTokens: Number(d.maxTokens),
      reasoning: !!d.reasoning,
      input: d.image ? ['text', 'image'] : ['text'],
      cost: { input: Number(d.costInput) || 0, output: Number(d.costOutput) || 0, cacheRead: 0, cacheWrite: 0 },
    }]
    await putModels(state.modelsFor, next)
    state.modelDraft = null
    flash('ok', '已添加模型')
  } catch (err) {
    state.providerError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function deleteCustomModel(modelId) {
  const p = customProvider(state.modelsFor)
  if (!p) return
  state.busy = true
  state.providerError = ''
  render()
  try {
    await putModels(state.modelsFor, (p.models || []).filter((m) => m.id !== modelId))
    flash('ok', '已删除模型')
  } catch (err) {
    state.providerError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function saveCred(provider, secret, credId) {
  state.busy = true
  render()
  try {
    if (isOwner()) {
      const exists = (state.creds || []).some((c) => c.provider === provider) || !!credId
      if (exists) await api('PUT', `/platform/credentials/${encodeURIComponent(provider)}`, { secret })
      else await api('POST', '/platform/credentials', { provider, secret })
    } else {
      throw new Error('供应商由系统管理员配置')
    }
    await loadCreds()
    // 换了密钥，之前那次测试测的是旧密钥。
    delete state.tests[`provider:${provider}`]
    for (const role of ['daily', 'utility']) {
      if (state.settings?.[role]?.provider === provider) delete state.tests[`role:${role}`]
    }
    state.addOpen = false
    flash('ok', '已配置')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function saveCompany(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const id = orgId()
  const name = String(fd.get('name') || '').trim()
  const slug = String(fd.get('slug') || '').trim()
  const accessUrl = String(fd.get('accessUrl') || '').trim()
  state.busy = true
  render()
  try {
    await api('PATCH', `/orgs/${encodeURIComponent(id)}`, {
      name,
      slug,
      accessUrl: accessUrl || null,
      contactName: String(fd.get('contactName') || '').trim(),
      contactPhone: phoneValue(fd),
      contactEmail: String(fd.get('contactEmail') || '').trim(),
      address: String(fd.get('address') || '').trim(),
      website: String(fd.get('website') || '').trim(),
    })
    await loadOrg()
    await loadMe()
    flash('ok', '已保存')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function submitAuditFilter(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  state.sessionAccountId = String(fd.get('accountId') || '').trim()
  state.sessionFrom = String(fd.get('from') || '')
  state.sessionTo = String(fd.get('to') || '')
  try {
    await loadSessions()
  } catch (err) {
    flash('err', err.message)
  }
  render()
}

async function createOrg(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const adminPassword = String(fd.get('adminPassword') || '')
  if (adminPassword !== String(fd.get('adminPassword2') || '')) {
    state.orgCreateError = t('两次输入的口令不一致')
    render()
    return
  }
  state.orgCreateError = ''
  const body = {
    name: String(fd.get('name') || '').trim(),
    slug: String(fd.get('slug') || '').trim(),
    contactName: String(fd.get('contactName') || '').trim(),
    contactPhone: phoneValue(fd),
    contactEmail: String(fd.get('contactEmail') || '').trim(),
    address: String(fd.get('address') || '').trim(),
    website: String(fd.get('website') || '').trim(),
    adminEmail: String(fd.get('adminEmail') || '').trim(),
    adminPassword,
  }
  state.busy = true
  render()
  try {
    await api('POST', '/platform/orgs', body)
    state.orgCreateOpen = false
    await loadOrgs()
    flash('ok', '已创建公司')
  } catch (err) {
    // 弹窗不关，报错留在填错的那张表单上。
    state.orgCreateError = err.message
  } finally {
    state.busy = false
    render()
  }
}

/**
 * 机器上的动作分两条路：公司详情页那块面板管的是「这家公司的第 n 台」，平台的机器
 * 管理页管的是「平台上的这一台」。两边的动作**完全一样**，不同的只有接口前缀和改完
 * 该刷新谁——所以处理器只有一套，靠元素上的 `data-scope` 分流，而不是两份迟早会各自
 * 漂移的相似代码。
 *
 * 没写 `data-scope` 的一律当公司侧：公司详情页那些元素是先有的，不该为这件事全部改一遍。
 */
function machineScope(el) {
  return machineTarget(
    el.getAttribute('data-scope') === 'platform' ? 'platform' : 'org',
    el.getAttribute('data-id') || '',
    el.getAttribute('data-machine') || '',
  )
}

/**
 * 接口前缀 + 改完刷新谁。**只有这一份**——确认框那条路手上没有元素（弹窗关了之后
 * 才真去删），照着抄一遍的话，两边迟早对不上。
 */
function machineTarget(scope, orgId, machineId) {
  return {
    scope,
    orgId,
    machineId,
    base:
      scope === 'platform'
        ? `/platform/machines/${encodeURIComponent(machineId)}`
        : `/platform/orgs/${encodeURIComponent(orgId)}/machines/${encodeURIComponent(machineId)}`,
    reload: () => (scope === 'platform' ? loadMachineDetail(machineId) : loadCompanyDetail(orgId)),
  }
}

async function saveMachine(e) {
  e.preventDefault()
  const form = e.target
  const s = machineScope(form)
  const host = String(new FormData(form).get('host') || '').trim()
  state.busy = true
  render()
  try {
    // 公司侧那条老接口收的是 `{host, machineId}`（它还兼着「把这台设成公司默认机器」），
    // 平台侧是纯粹的改地址。两者的响应形状一样，下面这段共用。
    const data =
      s.scope === 'platform'
        ? await api('PUT', `${s.base}/host`, { host })
        : await api('PUT', `/platform/orgs/${encodeURIComponent(s.orgId)}/machine`, { host, machineId: s.machineId })
    await s.reload()
    // 存下来还不够——地址写错了要当场知道，不能等到第一次部署。
    flash(data.reachable ? 'ok' : 'err', data.reachable ? '已保存，管家可达' : `已保存，但打不到管家：${data.error || '无响应'}`)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

/**
 * 改这台机器归谁。留空 = 收回，变成待分配。
 *
 * 有席位时后端会 409 顶回来——席位是按公司建的账号和目录，改归属并不会把它们搬走。
 * 界面上那颗按钮本来就是禁的，这里不重复判断：真到了两边不一致的时候，以后端为准。
 */
async function saveMachineCompany(e) {
  e.preventDefault()
  const form = e.target
  const machineId = form.getAttribute('data-machine') || ''
  const companyId = String(new FormData(form).get('companyId') || '')
  state.busy = true
  render()
  try {
    await api('PUT', `/platform/machines/${encodeURIComponent(machineId)}/company`, { companyId })
    await loadMachineDetail(machineId)
    flash('ok', companyId ? '已改归属' : '已收回，这台机器现在待分配')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

/** 把这台机器上的席位逐个重铺到最新的 Bot 版本。慢是正常的：一个席位一次真部署。 */
async function updateMachineRuntime(machineId) {
  if (!machineId || state.updatingRuntime) return
  const version = state.botLatest || state.latestRelease
  if (!version) {
    flash('err', '还没有发布 Bot 版本')
    render()
    return
  }
  state.updatingRuntime = true
  render()
  try {
    const data = await api('POST', `/platform/machines/${encodeURIComponent(machineId)}/runtime/update`, { version })
    const results = Array.isArray(data.results) ? data.results : []
    const ok = results.filter((r) => r.status === 'ready' && !r.error).length
    const bad = results.filter((r) => r.error || r.status === 'error').length
    if (!results.length) flash('ok', t('没有需要更新的席位', 'No seats needed updating'))
    else flash(bad && !ok ? 'err' : 'ok', t(`更新 ${data.version}：成功 ${ok}，失败 ${bad}`, `Updated ${data.version}: ${ok} ok, ${bad} failed`))
    await loadMachineDetail(machineId)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.updatingRuntime = false
    render()
  }
}

/**
 * 提交「新增版本」。慢是正常的——Gateway 要把包整个拉下来核对，26 MiB 的包在内网
 * 也要几秒，所以按钮上写「验证中…」而不是「保存中…」。
 */
async function addRelease(e) {
  e.preventDefault()
  const form = e.target
  const kind = form.getAttribute('data-kind') === 'manager' ? 'manager' : 'bot'
  const fd = new FormData(form)
  const body = {
    version: String(fd.get('version') || '').trim(),
    size: String(fd.get('size') || '').trim(),
    sha256: String(fd.get('sha256') || '').trim().toLowerCase(),
    url: String(fd.get('url') || '').trim(),
  }
  state.busy = true
  state.addRelease = kind
  render()
  try {
    const path = kind === 'manager' ? '/platform/manager-releases' : '/platform/bot-releases'
    const data = await api('POST', path, body)
    await loadReleases()
    state.addRelease = ''
    flash('ok', `已登记 ${data.release.version}`)
    form.reset()
  } catch (err) {
    // 验证失败时表单保持展开：填错的往往只有一项，重填比重来强。
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function saveManagerVersion(e) {
  e.preventDefault()
  const managerVersion = String(new FormData(e.target).get('managerVersion') || '').trim()
  state.busy = true
  render()
  try {
    await api('PUT', '/platform/settings', { managerVersion })
    await loadReleases()
    flash('ok', managerVersion ? `期望版本已设为 ${managerVersion}` : '期望版本已清空，跟最新发布走')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

/**
 * 手动重拉一遍机器信息。
 *
 * **只重拉，不去戳机器。** 心跳是机器主动打的（30 秒一轮），Gateway 没有把它叫醒的
 * 路子——这颗按钮能做的就是把 Gateway 手上这一份再取一次。所以刚下完指令马上点，
 * 大概率还是旧值，得等机器自己下一轮心跳。
 */
async function refreshMachine(id) {
  if (!id) return
  state.busy = true
  render()
  try {
    await loadMachines(id)
    flash('ok', t('已刷新'))
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

/** 手上那张卡片。确认框要按它说话：几个席位、机器在不在线。 */
function machineCardOf(s) {
  return s.scope === 'platform'
    ? state.machineDetail
    : (state.machines || []).find((m) => m.machine && m.machine.id === s.machineId)
}

/**
 * 移除一台机器的登记。**只是从 Gateway 上抹掉记录**，不碰机器本身。
 *
 * 公司侧和平台侧共用它，靠元素上的 data-scope 分流（见 machineScope）。
 *
 * 上面还有席位时先问一句：席位的登记会跟着一起没，那几位员工要重新部署，而这件事
 * 从按钮上看不出来。空机器不问——那一下没有任何人会受影响。
 *
 * 在线和离线的后果不一样，确认框要分开说：在线的机器会收到通知自己停干净，离线的
 * 收不到信，上面的东西会一直跑着。把两种说成一种，人就会按错的预期去处置。
 */
function removeMachine(el) {
  const s = machineScope(el)
  if (!s.machineId || (s.scope === 'org' && !s.orgId)) return
  const card = machineCardOf(s)
  const seats = (card && card.seats) || 0
  if (!seats) return doRemoveMachine(s)
  const online = card && card.machine && card.machine.link === 'online'
  const tail = online
    ? t(
        '这台机器在线，会在下一轮心跳（≤30 秒）收到通知，自己停掉这些席位、取消开机自启并退出；~/work 里的文件留在机器上。',
        'The machine is online: on its next heartbeat (≤30s) it stops those seats, disables its own autostart and exits. Files in ~/work stay on the box.',
      )
    : t(
        '这台机器当前不在线，收不到通知——上面的管家和席位进程会一直跑着，要停得上去停。',
        'The machine is offline and will not get the notice — its manager and seat processes keep running and must be stopped there.',
      )
  state.confirm = {
    title: t('移除这台机器的登记？'),
    body:
      t(
        `这台机器上的 ${seats} 个席位登记会一起抹掉，那几位员工再进来是「未部署」，重新部署会落到别的机器上。`,
        `The ${seats} seat registrations on this machine are erased with it. Those members will see "not deployed" and a redeploy lands on another machine.`,
      ) +
      tail,
    label: '移除',
    kind: 'remove-machine',
    scope: s.scope,
    orgId: s.orgId,
    machineId: s.machineId,
  }
  render()
}

/** 真去删。确认框和「空机器直接删」两条路都走它。 */
async function doRemoveMachine(s) {
  state.busy = true
  render()
  try {
    const data = await api('DELETE', s.base)
    // 平台侧删的就是当前这一页——它已经不存在了，留在原地会去拉一条 404。回列表。
    if (s.scope === 'platform') {
      state.machineDetail = null
      go('/machines')
    } else {
      await s.reload()
    }
    const seats = (data && data.seats) || 0
    // 「已下指令」而不是「已经停了」：真正停席位、停自己的是机器，它得先收到那一轮
    // 心跳。收不到信的（离线）更要说清楚，不然人会以为机器上已经干净了。
    flash(
      'ok',
      data && data.pending
        ? t(
            `已移除。这台机器会在下一轮心跳收到通知，自己停掉${seats ? ` ${seats} 个席位并` : ''}退出。`,
            `Removed. On its next heartbeat the machine stops${seats ? ` its ${seats} seats and ` : ' and '}exits.`,
          )
        : t(
            `已移除这台机器的登记${seats ? `，连同 ${seats} 个席位登记` : ''}。它不在线，机器上的东西不会自己停，要停得上去停。`,
            `Machine registration removed${seats ? ` along with ${seats} seat registrations` : ''}. It is offline, so nothing on the box stops by itself — stop it there.`,
          ),
    )
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function saveCapacity(e) {
  e.preventDefault()
  const form = e.target
  const s = machineScope(form)
  const maxAccounts = Number(new FormData(form).get('maxAccounts'))
  state.busy = true
  render()
  try {
    await api('PUT', `${s.base}/capacity`, { maxAccounts })
    await s.reload()
    flash('ok', `容量改为 ${maxAccounts} 个账号`)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function saveTimezone(e) {
  e.preventDefault()
  const form = e.target
  const s = machineScope(form)
  const timezone = String(new FormData(form).get('timezone') || '').trim()
  state.busy = true
  render()
  try {
    const data = await api('PUT', `${s.base}/timezone`, { timezone })
    await s.reload()
    // 「已下指令」而不是「已改好」：真正改的是机器，下一轮心跳才知道成没成。
    flash('ok', !timezone ? '不再管这台机器的时区' : data.pending ? `已下指令：${timezone}，等机器改` : `时区改为 ${timezone}`)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

/**
 * 给这台机器钉一个新的管家版本。
 *
 * 只是下指令——换版、自检、失败回滚都在机器上做，所以提示语说的是「等机器换版」。
 */
async function upgradeManager(el) {
  const s = machineScope(el)
  if (!s.machineId || (s.scope === 'org' && !s.orgId)) return
  state.busy = true
  render()
  try {
    const data = await api('POST', `${s.base}/upgrade`, {})
    await s.reload()
    flash('ok', data.pending ? `已下指令升到 ${data.version}，等机器下一轮心跳换版` : `已经是 ${data.version}`)
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function makePairingCode(id) {
  state.busy = true
  render()
  try {
    state.pairingCode = await api('POST', `/platform/orgs/${encodeURIComponent(id)}/pairing-code`)
    flash('ok', '配对码已生成，30 分钟内有效')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}


async function saveOrder(e) {
  e.preventDefault()
  const form = e.target
  const id = form.getAttribute('data-id')
  const fd = new FormData(form)
  // 改单时类型下拉是 disabled，表单里没有它——以这张单子自己的类型为准，
  // 别回落到 'plan'，否则改一张充值单会当成套餐单发出去。
  const cur = id ? (state.orders || []).find((o) => o.id === id) : null
  const kind = (cur?.kind || String(fd.get('kind') || state.orderEdit?.kind || 'plan')) === 'topup' ? 'topup' : 'plan'
  const body = kind === 'topup'
    ? {
        // 改单不带 kind：类型本来就不让改，服务端按原单子的类型处理。
        ...(id ? {} : { kind }),
        companyId: String(fd.get('companyId') || ''),
        amount: Number(fd.get('amount')),
        note: String(fd.get('note') || '').trim(),
        startAt: String(fd.get('startAt') || ''),
        payStatus: String(fd.get('payStatus') || 'unpaid'),
      }
    : {
        ...(id ? {} : { kind }),
        companyId: String(fd.get('companyId') || ''),
        planId: String(fd.get('planId') || ''),
        period: String(fd.get('period') || 'month'),
        seats: Number(fd.get('seats')),
        amount: Number(fd.get('amount')),
        bonusTokens: Number(fd.get('bonusTokens') || 0),
        startAt: String(fd.get('startAt') || ''),
        payStatus: String(fd.get('payStatus') || 'unpaid'),
      }
  state.busy = true
  state.orderError = ''
  render()
  try {
    if (id) await api('PUT', `/platform/orders/${encodeURIComponent(id)}`, body)
    else await api('POST', '/platform/orders', body)
    state.orderEdit = null
    // 下单会改公司的订阅，公司列表跟着刷一遍，省得回去看到的还是旧套餐。
    await Promise.all([loadOrders(), loadOrgs().catch(() => {})])
    flash('ok', id ? t('已保存订单') : t('已创建订单'))
  } catch (err) {
    // 报错留在弹窗里，连同刚填的值——draft 的字段名要跟弹窗读的对上。
    state.orderError = err.message
    state.orderEdit = {
      id,
      kind,
      draft: {
        kind, companyId: body.companyId, planId: body.planId, period: body.period,
        seats: body.seats, amount: body.amount, bonus: body.bonusTokens, startAt: body.startAt,
        payStatus: body.payStatus, note: body.note || '',
      },
    }
  } finally {
    state.busy = false
    render()
  }
}

/** 公司详情页那张资料表单。跟公司自己那张（saveCompany）走同一条 PATCH，多一个状态。 */
async function saveOrgProfile(e) {
  e.preventDefault()
  const form = e.target
  const id = form.getAttribute('data-id')
  const fd = new FormData(form)
  const accessUrl = String(fd.get('accessUrl') || '').trim()
  state.busy = true
  render()
  try {
    // 状态不在这张表单里：它单独一条 PATCH，改完立刻生效。
    await api('PATCH', `/orgs/${encodeURIComponent(id)}`, {
      name: String(fd.get('name') || '').trim(),
      slug: String(fd.get('slug') || '').trim(),
      contactName: String(fd.get('contactName') || '').trim(),
      contactPhone: phoneValue(fd),
      contactEmail: String(fd.get('contactEmail') || '').trim(),
      address: String(fd.get('address') || '').trim(),
      website: String(fd.get('website') || '').trim(),
      accessUrl: accessUrl || null,
    })
    await loadOrgs()
    await loadCompanyDetail(id)
    flash('ok', '已保存')
  } catch (err) {
    flash('err', err.message)
  } finally {
    state.busy = false
    render()
  }
}

async function savePlanSku(e) {
  e.preventDefault()
  const form = e.target
  const id = form.getAttribute('data-id')
  const fd = new FormData(form)
  const body = {
    name: String(fd.get('name') || '').trim(),
    nameEn: String(fd.get('nameEn') || '').trim(),
    amount: Number(fd.get('amount')),
    seats: Number(fd.get('seats')),
    period: String(fd.get('period') || 'month'),
    bonusTokens: Number(fd.get('bonusTokens') || 0),
  }
  state.busy = true
  state.planSkuError = ''
  render()
  try {
    if (id) await api('PUT', `/platform/plans/${encodeURIComponent(id)}`, body)
    else await api('POST', '/platform/plans', body)
    state.planSkuEdit = null
    await loadPlanSkus()
    flash('ok', id ? t('已保存套餐') : t('已创建套餐'))
  } catch (err) {
    // 报错留在弹窗里，连同刚填的值——关掉弹窗再去页面顶上找提示是白丢一次输入。
    state.planSkuError = err.message
    // draft 要按弹窗读的字段名存：body 里叫 bonusTokens（接口的名字），
    // 弹窗读的是 bonus——直接塞 body 会让赠送额度那一栏在报错后变空。
    state.planSkuEdit = {
      id,
      draft: { name: body.name, nameEn: body.nameEn, amount: body.amount, seats: body.seats, period: body.period, bonus: body.bonusTokens },
    }
  } finally {
    state.busy = false
    render()
  }
}

// 席位不在界面上改：它跟套餐、到期时间一样由订单决定，下单时一起写进去。

function orgAccountsPath(extra) {
  const id = orgId()
  return `/orgs/${encodeURIComponent(id)}/accounts${extra || ''}`
}

function memberById(id) {
  return (state.accounts || []).find((m) => m.id === id)
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

function closeMemberUi() {
  state.orgCreateOpen = false
  state.orgCreateError = ''
  state.inviteOpen = false
  state.inviteLink = ''
  state.inviteError = ''
  state.editing = null
  state.editLink = ''
  state.editCopied = false
  state.menu = null
  state.confirm = null
  state.secret = null
  state.groupDialog = null
  state.groupError = ''
}

async function submitInvite(e) {
  e.preventDefault()
  if (state.inviteLink) {
    const ok = await copyText(state.inviteLink)
    state.inviteCopied = ok
    state.inviteError = ok ? '' : '复制失败，请手动选中上面的链接复制。'
    render()
    return
  }
  const fd = new FormData(e.target)
  state.inviteForm = {
    name: String(fd.get('name') || '').trim(),
    email: String(fd.get('email') || '').trim(),
    role: String(fd.get('role') || 'member'),
    ttlDays: Number(fd.get('ttlDays') || 7),
  }
  state.busy = true
  state.inviteError = ''
  render()
  try {
    const data = await api('POST', orgAccountsPath('/members'), {
      name: state.inviteForm.name,
      email: state.inviteForm.email,
      role: state.inviteForm.role,
      ttlDays: state.inviteForm.ttlDays,
    })
    state.inviteLink = data.invite?.url || ''
    state.inviteEmail = data.user?.email || state.inviteForm.email
    state.inviteExpiresAt = data.invite?.expiresAt || 0
    const ok = state.inviteLink ? await copyText(state.inviteLink) : false
    state.inviteCopied = ok
    if (!ok && state.inviteLink) state.inviteError = '复制失败，请手动选中上面的链接复制。'
  } catch (err) {
    state.inviteError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function submitEdit(e) {
  e.preventDefault()
  const member = state.editing
  if (!member) return
  const fd = new FormData(e.target)
  const name = String(fd.get('name') || '').trim()
  const isSelf = member.id === memberMeId()
  const body = { name }
  if (!isSelf) {
    if (state.editForm.role !== member.role) body.role = state.editForm.role
    if (state.editForm.status !== member.status) body.status = state.editForm.status
  }
  state.busy = true
  render()
  try {
    await api('PATCH', orgAccountsPath('/' + encodeURIComponent(member.id)), body)
    state.editing = null
    state.editLink = ''
    await loadAccounts()
    flash('ok', '已保存')
  } catch (err) {
    flash('err', err.message)
    state.editing = null
  } finally {
    state.busy = false
    render()
  }
}

async function submitGroup(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const name = String(fd.get('name') || '').trim()
  const desc = String(fd.get('desc') || '').trim()
  state.groupForm = { ...state.groupForm, name, desc }
  state.groupError = ''
  if (!name) {
    state.groupError = '分组要有名字'
    render()
    return
  }
  const body = {
    name,
    desc,
    icon: state.groupForm.icon || 'chat',
    role: state.groupForm.role === 'admin' ? 'admin' : 'member',
    members: state.groupForm.members || [],
  }
  state.busy = true
  render()
  try {
    const id = state.groupDialog && state.groupDialog.id
    if (id) await api('PATCH', orgAccountsPath('/groups/' + encodeURIComponent(id)), body)
    else await api('POST', orgAccountsPath('/groups'), body)
    state.groupDialog = null
    state.groupError = ''
    await loadAccounts()
  } catch (err) {
    state.groupError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function submitJoin(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  const name = String(fd.get('name') || '').trim()
  const password = String(fd.get('password') || '')
  const confirm = String(fd.get('confirm') || '')
  state.joinForm = { name, password: '', confirm: '' }
  state.joinError = ''
  if (password !== confirm) {
    state.joinError = '两次输入的口令不一致'
    render()
    return
  }
  if (password.length < 10) {
    state.joinError = '口令至少 10 位'
    render()
    return
  }
  state.busy = true
  render()
  try {
    const data = await api('POST', `/invites/${encodeURIComponent(joinToken())}/accept`, { name, password })
    if (!data.token) throw new Error('加入响应没有 token')
    setToken(data.token)
    await loadMe()
    state.path = '/'
    history.replaceState({}, '', '/')
    await loadPage()
  } catch (err) {
    state.joinError = err.message || '加入失败'
  } finally {
    state.busy = false
    render()
  }
}

async function resetMember(id, viaEdit) {
  const m = memberById(id) || state.editing
  if (!m) return
  try {
    const data = await api('POST', orgAccountsPath('/' + encodeURIComponent(m.id) + '/reset'))
    const invite = data.invite || {}
    if (viaEdit) {
      state.editLink = invite.url || ''
      state.editCopied = false
    } else {
      state.secret = {
        title: m.status === 'invited' ? t('新的邀请链接') : t('口令重设链接'),
        email: m.email,
        url: invite.url,
        expiresAt: invite.expiresAt,
      }
      state.inviteCopied = false
      state.menu = null
    }
    render()
  } catch (err) {
    flash('err', err.message)
    state.menu = null
    render()
  }
}

async function submitSkill(e) {
  e.preventDefault()
  syncSkillForm()
  const f = state.skillForm
  const base = catalogBase()
  if (!base || !f) return
  const payload = {
    name: f.name,
    body: f.body,
    tags: f.tags,
    enabled: f.enabled,
    source: f.source,
    fileName: (state.skillFile && state.skillFile.name) || f.fileName,
  }
  if (f.source === 'ZIP 包' && state.skillEntries && window.satuUnzip) {
    payload.files = window.satuUnzip.toPayload(state.skillEntries).filter((x) => typeof x.text === 'string')
  }
  state.busy = true
  state.skillError = ''
  render()
  try {
    const item = state.skillDialog && state.skillDialog.item
    if (item) await api('PATCH', `${base}/skills/${encodeURIComponent(item.id)}`, payload)
    else await api('POST', `${base}/skills`, payload)
    closeSkillDialog()
    await loadSkills()
  } catch (err) {
    state.skillError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function submitServer(e) {
  e.preventDefault()
  syncSkillForm()
  const f = state.skillForm
  const base = catalogBase()
  if (!base || !f) return
  const nameEl = document.getElementById('tl-name')
  if (nameEl) f.name = nameEl.value
  const payload = { name: f.name, kind: f.kind, endpoint: f.endpoint, env: f.env, perm: f.perm, enabled: f.enabled }
  if (f.token) payload.token = f.token
  state.busy = true
  state.skillError = ''
  render()
  try {
    const item = state.skillDialog && state.skillDialog.item
    if (item) await api('PATCH', `${base}/mcp-servers/${encodeURIComponent(item.id)}`, payload)
    else await api('POST', `${base}/mcp-servers`, payload)
    closeSkillDialog()
    await loadSkills()
  } catch (err) {
    state.skillError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function createSkillTag(raw) {
  const tag = String(raw || '').trim()
  syncSkillForm()
  state.skillTagAdding = false
  if (!tag) {
    render()
    return
  }
  const base = catalogBase()
  try {
    const data = await api('POST', `${base}/skills/tags`, { name: tag })
    state.skillTags = data.tags || []
    if (state.skillForm && !state.skillForm.tags.includes(tag)) state.skillForm.tags = state.skillForm.tags.concat(tag)
  } catch (err) {
    state.skillError = err.message
  }
  render()
}

async function takeSkillFile(input) {
  const picked = input.files && input.files[0]
  input.value = ''
  if (!picked) return
  syncSkillForm()
  const zip = state.skillForm && state.skillForm.source === 'ZIP 包'
  state.skillError = ''
  if (!zip) {
    const text = await picked.text()
    state.skillForm.body = text
    state.skillFile = { name: picked.name, size: picked.size }
    if (!state.skillForm.name) state.skillForm.name = picked.name.replace(/\.(md|markdown|ya?ml|json)$/i, '')
    state.skillEntries = null
    render()
    return
  }
  const unzip = window.satuUnzip
  if (!unzip) {
    state.skillError = '解压器还没载入，请稍后再试'
    render()
    return
  }
  try {
    const list = unzip.stripTopDir(await unzip.unzip(picked))
    const readme = list.find((f) => f.path.toLowerCase() === 'skill.md')
    if (!readme) throw new Error('包的根目录里没有 SKILL.md')
    state.skillEntries = list
    state.skillFile = { name: picked.name, size: picked.size }
    state.skillForm.body = new TextDecoder().decode(readme.bytes)
    if (!state.skillForm.name) state.skillForm.name = picked.name.replace(/[-_]?skill\.zip$|\.zip$/i, '')
  } catch (err) {
    state.skillEntries = null
    state.skillFile = null
    state.skillError = err.message
  }
  render()
}
