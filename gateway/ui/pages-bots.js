/** Bot 与它的能力（技能、MCP），以及账单与用量两页。 */
function pickId(o) {
  return typeof o === 'string' ? o : o && typeof o === 'object' ? String(o.id ?? o.name ?? '') : String(o ?? '')
}
function pickLabel(o) {
  return typeof o === 'string' ? o : o && typeof o === 'object' ? String(o.name ?? o.id ?? '') : String(o ?? '')
}

/** `ro` = 只读：药丸连 disabled 一起给上，不然它看着还能按，按了改的是一份存不下去的草稿。 */
function botPicks(key, options, selected, hint, ro = false) {
  const sel = Array.isArray(selected) ? selected : []
  const buttons = (options || [])
    .map((o) => {
      const id = pickId(o)
      const on = sel.includes(id)
      const act = ro ? 'disabled' : `data-act="bot-pick" data-key="${esc(key)}" data-value="${esc(id)}"`
      return `<button type="button" class="satu-assignee" style="padding: 5px 12px;" aria-pressed="${String(on)}" ${act}>${esc(pickLabel(o))}</button>`
    })
    .join('')
  const empty = options && options.length ? '' : `<span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint || t('没有可选项'))}</span>`
  return `<div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${buttons}${empty}</div>`
}

/** `act` 传空串 = 只读：开关连 disabled 一起给上，不然它看着还能按，按了没反应。 */
function botToggle(title, desc, on, act, extra = '') {
  return `<div class="satu-toggleRow">
    <div style="min-width: 0;">
      <div style="font-size: 13.5px; font-weight: 600;">${esc(title)}</div>
      <div style="font-size: 12px; color: var(--muted-foreground);">${esc(desc)}</div>
    </div>
    <button type="button" class="satu-switch" aria-pressed="${String(!!on)}" aria-label="${esc(title)}" ${act ? `data-act="${esc(act)}"` : 'disabled'} ${extra}><span></span></button>
  </div>`
}

/**
 * `/bots` 有两副面孔。
 *
 * owner 那边是**全局 Bot 名录**：他建的那几个所有公司都看得见，还是列表 + 详情。
 * 公司管理员那边是**一份 Bot 模版**——公司这一层不再有「一批共享的 Bot」，员工自己
 * 建的每个 Bot 都长在这份底座上（见 gateway/src/lib/catalog.ts 的 publicBot）。
 */
function botsPage() {
  return isOwner() ? globalBotsPage() : botTemplatePage()
}

function globalBotsPage() {
  const rows = (state.bots || [])
    .map((a) => {
      const on = a.enabled !== false
      const ro = readOnlyItem(a)
      return `<div class="satu-agentrow">
        <button type="button" class="satu-tasklink" data-act="go" data-href="/bots/${esc(a.id)}">
          <span style="display: flex; align-items: center; gap: var(--space-3); min-width: 0;">
            ${botAvatar(a.icon, 34, a.origin)}
            <span style="min-width: 0; display: flex; flex-direction: column; gap: 1px; text-align: left;">
              <span style="font-size: 14px; font-weight: 600;">${esc(a.name)}${ro ? ` <span class="tag tag-accent-2" style="font-size: 11px;">${t('全局')}</span>` : ''}</span>
              <span style="font-size: 12px; color: var(--muted-foreground);">${esc(a.description || '')}</span>
            </span>
          </span>
        </button>
        <span class="tag ${on ? 'tag-accent-2' : 'tag-neutral'}">${on ? t('已上线') : t('未上线')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(a.skillCount ?? '—')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(a.mcpCount ?? '—')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(a.usage ?? '—')}</span>
        <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-2); justify-content: flex-end;">
          <button type="button" class="satu-switch" aria-pressed="${String(on)}" aria-label="${esc(t('上线'))}" data-act="bot-list-enabled" data-id="${esc(a.id)}" ${ro ? 'disabled title="' + esc(t('全局 Bot 由系统管理员维护')) + '"' : ''}><span></span></button>
          <button type="button" class="satu-linkbtn" data-act="go" data-href="/bots/${esc(a.id)}">${ro ? t('查看') : t('配置')}</button>
        </div>
      </div>`
    })
    .join('')
  const body = rows || `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有 Bot')}</div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('全局 Bot')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('这里建的 Bot 所有公司都能用。公司自己的 Bot 由员工按本公司模版创建。', 'Bots created here are available to every company. Inside a company, members create their own from the company template.')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" data-act="bot-create">
            ${svg(['M12 5v14', 'M5 12h14'], 15)} ${t('新建 Bot', 'New bot')}
          </button>
        </div>
        ${flashes()}
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-agenthead">
            <span>Bot</span><span>${t('状态')}</span><span>Skill</span><span>MCP</span><span>${t('本月执行')}</span><span></span>
          </div>
          ${body}
        </div>
      </div>
    </div>`
}

/** 名字长长的一段：这一页改的是全公司的底座，得先把这件事说清楚再让人动手。 */
function botTemplatePage() {
  const tpl = state.template
  const a = state.templateDraft
  if (!tpl || !a) {
    return `<div class="gw-page"><div class="gw-page-inner" style="max-width: 820px;">${flashes()}<p style="color: var(--muted-foreground);">${t('载入中…')}</p></div></div>`
  }
  const opts = state.templateOptions || { skills: [], mcps: [] }
  const others = (state.bots || []).filter((b) => b.scope !== 'user')
  return `
    <div class="gw-page">
      <div class="gw-page-inner" style="max-width: 820px; gap: var(--space-4);">
        <div>
          <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
            <h1 style="font-size: 24px; margin: 0;">${t('Bot 模版')}</h1>
            <span class="tag tag-accent-2">v${esc(String(tpl.version))}</span>
          </div>
          <p style="margin: 4px 0 0; font-size: 14px; color: var(--muted-foreground);">
            ${t('公司里每个人自己建的 Bot 都长在这份底座上：人设、行为边界、记忆策略、能用哪些 Skill 和 MCP。保存即生效——版本号加一，各人的 Bot 一分钟内自己跟上，不用挨个改。', 'Every bot your members create sits on this base: persona, guardrails, memory policy, and which skills and MCP servers it may use. Saving takes effect immediately — the version bumps and each seat picks it up within a minute.')}
          </p>
        </div>
        ${flashes()}

        <div class="satu-panel">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
            <span class="satu-panel-title" style="text-transform: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; letter-spacing: 0;">soul.md</span>
            <span style="font-size: 12px; color: var(--muted-foreground);" data-bot-prompt-len>${t(`${esc(String(a.prompt.length))} 字 · 每轮随上下文注入`, `${esc(String(a.prompt.length))} chars · injected each turn`)}</span>
          </div>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('这份文件定义全公司 Bot 的身份、语气与工作原则。员工可以在自己的 Bot 上追加一段补充说明，接在这段后面，不会替掉它。', 'This defines the identity, tone and working principles shared by every bot in the company. Members can append their own note on their bot; it goes after this text and never replaces it.')}</p>
          <textarea class="input satu-code" rows="12" data-bot="prompt">${esc(a.prompt)}</textarea>
        </div>

        ${guardsPanel(a, false)}
        ${capabilityPanel(a, opts, false)}
        ${memoryPanel(a, false)}

        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
          <button type="button" class="satu-linkbtn" style="text-align: left;" data-act="template-redeploy" ${state.busy ? 'disabled' : ''}>${t('立即下发到全部席位')}</button>
          <button type="button" class="btn btn-primary" data-act="template-save" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('保存模版')}</button>
        </div>
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">
          ${t('「立即下发」会把公司已部署的席位挨个重铺一遍，正在进行的对话会断。平时不用按它：席位自己在盯着版本号。', 'Force-push reinstalls every deployed seat and drops ongoing conversations. You normally do not need it — seats watch the version themselves.')}
        </p>

        ${others.length ? `<div style="margin-top: var(--space-4);">
          <h2 style="font-size: 16px; margin: 0 0 4px;">${t('其它 Bot')}</h2>
          <p style="margin: 0 0 var(--space-2); font-size: 13px; color: var(--muted-foreground);">
            ${t('平台维护的全局 Bot，以及改版前建的公司 Bot（已停用，可以删掉）。员工自己建的不在这里——那些只有本人看得见。', 'Global bots maintained by the platform, plus company bots created before the template (now disabled; safe to delete). Bots your members created are not listed here — only they can see those.')}
          </p>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            ${others.map(legacyBotRow).join('')}
          </div>
        </div>` : ''}
      </div>
    </div>`
}

function legacyBotRow(b) {
  const tag = b.legacy
    ? `<span class="tag tag-neutral">${t('已停用')}</span>`
    : `<span class="tag tag-accent-2">${t('全局')}</span>`
  return `<div class="satu-agentrow" style="grid-template-columns: 1fr auto auto;">
    <button type="button" class="satu-tasklink" data-act="go" data-href="/bots/${esc(b.id)}">
      <span style="display: flex; align-items: center; gap: var(--space-3); min-width: 0;">
        ${botAvatar(b.icon, 30, b.origin)}
        <span style="min-width: 0; display: flex; flex-direction: column; gap: 1px; text-align: left;">
          <span style="font-size: 14px; font-weight: 600;">${esc(b.name)}</span>
          <span style="font-size: 12px; color: var(--muted-foreground);">${esc(b.description || '')}</span>
        </span>
      </span>
    </button>
    ${tag}
    <div style="display: flex; align-items: center; gap: var(--space-2); justify-content: flex-end;">
      ${b.legacy ? `<button type="button" class="satu-linkbtn" data-act="legacy-bot-delete" data-id="${esc(b.id)}" data-name="${esc(b.name)}">${t('删除')}</button>` : ''}
      <button type="button" class="satu-linkbtn" data-act="go" data-href="/bots/${esc(b.id)}">${t('查看')}</button>
    </div>
  </div>`
}

// ── 模版页和 Bot 详情页共用的那几块。──────────────────────────────────
//
// 行为边界、记忆、能力这三块在两页上长得一模一样，改的只是哪一份草稿（见 state.js
// 的 editingDraft）。抄成两份的话，下次给记忆加一个选项就会只加在其中一页上。

function guardsPanel(a, ro) {
  const guards = (a.guards || []).map((g) => botToggle(g.title, g.desc, g.on, ro ? '' : 'bot-guard', `data-id="${esc(g.id)}"`)).join('')
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('行为边界')}</span>
    ${guards}
    <div class="field">
      <label for="bot-escalate">${t('升级人工的条件')}</label>
      <input class="input" id="bot-escalate" type="text" data-bot="escalate" value="${esc(a.escalate || '')}" ${ro ? 'disabled' : ''}>
    </div>
    <span style="font-size: 12px; color: var(--muted-foreground);">${t('这几条落在席位上工具执行前的拦截里，不是提示词里的一句话：拦下来的调用没跑过。「升级人工的条件」原样进提示词，配一把 escalate_to_human 工具，调用会留痕。', 'These are enforced on the seat before a tool runs — a blocked call never executed. The escalation rule goes into the prompt verbatim, paired with an escalate_to_human tool whose calls are recorded.')}</span>
  </div>`
}

function capabilityPanel(a, opts, ro) {
  if (ro) {
    const names = (ids, list) => (ids || []).map((id) => (list || []).find((o) => pickId(o) === id)).filter(Boolean).map(pickLabel)
    const chips = (labels) =>
      labels.length
        ? labels.map((n) => `<span class="tag tag-neutral">${esc(n)}</span>`).join(' ')
        : `<span style="font-size: 12px; color: var(--muted-foreground);">${t('没有')}</span>`
    return `<div class="satu-panel">
      <span class="satu-panel-title">${t('可用 Skill')}</span>
      <div style="display: flex; flex-wrap: wrap; gap: 6px;">${chips(names(a.skills, opts.skills))}</div>
      <span class="satu-panel-title" style="margin-top: var(--space-2);">${t('可用 MCP 服务器')}</span>
      <div style="display: flex; flex-wrap: wrap; gap: 6px;">${chips(names(a.mcps, opts.mcps))}</div>
    </div>`
  }
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('可用 Skill')}</span>
    ${botPicks('skills', opts.skills, a.skills, t('没有可选项'))}
    <span class="satu-panel-title" style="margin-top: var(--space-2);">${t('可用 MCP 服务器')}</span>
    ${botPicks('mcps', opts.mcps, a.mcps, t('没有可选项'))}
    <span style="font-size: 12px; color: var(--muted-foreground);">${t('未勾选的能力，Agent 在任务中不可调用。')}</span>
  </div>`
}

function memoryPanel(a, ro) {
  const scopePills = MEMORY_SCOPES.map(
    (sc) =>
      `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(a.scope === sc)}" ${ro ? 'disabled' : `data-act="bot-scope" data-value="${esc(sc)}"`}>${esc(t(sc))}</button>`,
  ).join('')
  // value 用中文原串当键（存的就是它），只翻显示的那一份。
  const ttlOpts = MEMORY_TTLS.map((ttl) => `<option value="${esc(ttl)}" ${ttl === a.ttl ? 'selected' : ''}>${esc(t(ttl))}</option>`).join('')
  const body = a.memoryOn
    ? `<div style="display: flex; flex-direction: column; gap: var(--space-4);">
        <div class="field">
          <label>${t('记忆范围')}</label>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${scopePills}</div>
        </div>
        <div class="field">
          <label>${t('记录哪些内容')}</label>
          ${/* id 保持中文原串（存的是它），只翻显示的 label；botPicks 也喂用户数据，不能整体翻。 */ ''}
          ${botPicks('kinds', MEMORY_KINDS.map((k) => ({ id: k, name: t(k) })), a.kinds, '', ro)}
        </div>
        <div class="satu-agentpair">
          <div class="field">
            <label for="bot-ttl">${t('保留时长')}</label>
            <select class="input" id="bot-ttl" data-act="bot-ttl" ${ro ? 'disabled' : ''}>${ttlOpts}</select>
          </div>
          <div class="field">
            <label for="bot-cap" data-bot-cap-label>${t(`注入上限 · ${esc(a.cap)} 条`, `Injection cap · ${esc(a.cap)}`)}</label>
            <input class="input" id="bot-cap" type="range" min="5" max="50" step="5" value="${esc(a.cap)}" data-bot="cap" ${ro ? 'disabled' : ''} style="padding: 0; border: 0; background: transparent; accent-color: var(--color-accent);">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('每次对话最多注入的记忆条数')}</span>
          </div>
        </div>
        ${botToggle(t('写入前需用户确认'), t('Agent 提议记住某条信息时先征求同意'), a.confirmOn, ro ? '' : 'bot-confirm')}
        ${botToggle(t('不记录敏感信息'), t('手机号、证件号、银行卡等自动跳过'), a.piiOn, ro ? '' : 'bot-pii')}
        <div style="display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
            <span style="font-size: 13.5px; font-weight: 600;">${t('已存记忆')}</span>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t(`${(a.memories || []).length} 条`, `${(a.memories || []).length} items`)}</span>
          </div>
          <div style="padding: 6px 0; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted-foreground);">${t('没有已存记忆')}</div>
        </div>
      </div>`
    : ''
  return `<div class="satu-panel">
    <span class="satu-panel-title">${t('记忆')}</span>
    <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('决定这个 Agent 能记住什么、记多久，以及记忆如何参与后续对话。')}</p>
    ${botToggle(t('启用长期记忆'), t('关闭后每次对话都从空白上下文开始'), a.memoryOn, ro ? '' : 'bot-memory')}
    ${body}
  </div>`
}

function botDetailPage() {
  const bot = state.bot
  const a = state.botDraft
  if (!bot || !a) {
    return `<div class="gw-page"><div class="gw-page-inner" style="max-width: 820px;">${flashes()}<p style="color: var(--muted-foreground);">${t('载入中…')}</p></div></div>`
  }
  // 自己建的那种：能改的只有身份和一段补充说明，底座在公司模版里。
  if (isMyBot(bot)) return myBotPage(bot, a)
  return fullBotPage(bot, a)
}

/**
 * 「我的 Bot」。
 *
 * 这一页故意不给提示词、行为边界、Skill 勾选——它们来自公司模版，在这儿摆一份能改的
 * 副本，人改完却不生效（服务端不收），比不摆更糟。所以底座在下面**只读**地列出来，
 * 旁边写清楚它归谁管。
 */
function myBotPage(bot, a) {
  const tplVersion = bot.templateVersion || state.template?.version || 1
  const opts = state.botOptions || { skills: [], mcps: [] }
  const iconPick = avatarKeysFor('company').map((key) => {
    const on = a.icon === key
    const label = t(BOT_AVATARS[key]?.label || key)
    return `<button type="button" class="satu-iconpick" aria-pressed="${String(on)}" aria-label="${esc(label)}" title="${esc(label)}" data-act="bot-icon" data-icon="${esc(key)}">${botAvatar(key, 30, 'company')}</button>`
  }).join('')
  const base = { ...a, prompt: state.template?.prompt || '', skills: state.template?.skills || [], mcps: state.template?.mcps || [] }
  return `
    <div class="gw-page">
      <div class="gw-page-inner" style="max-width: 820px; gap: var(--space-4);">
        <div class="satu-panel">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
            <div style="display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; flex: 1;">
              ${botAvatar(a.icon, 42, 'company')}
              <div style="min-width: 0; flex: 1; display: flex; flex-direction: column; gap: var(--space-2);">
                <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
                  <input class="input" style="max-width: 280px; font-family: var(--font-heading); font-size: 16px; font-weight: 600;" data-bot="name" value="${esc(a.name)}" placeholder="${esc(t('助理名字'))}">
                  <span class="tag ${a.enabled ? 'tag-accent-2' : 'tag-neutral'}">${a.enabled ? t('已上线') : t('未上线')}</span>
                </div>
                <input class="input" data-bot="description" value="${esc(a.description)}" placeholder="${esc(t('简介'))}">
                <div style="font-size: 12.5px; color: var(--muted-foreground);">${t(`模型 ${esc(a.model || '—')}（平台指定）`, `model ${esc(a.model || '—')} (set by the platform)`)}</div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px;">${iconPick}</div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
              <button type="button" class="satu-switch" aria-pressed="${String(!!a.enabled)}" aria-label="${esc(t('上线'))}" data-act="bot-enabled"><span></span></button>
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('这个 Bot 的补充说明')}</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
            ${t('写它专门负责什么、有什么习惯。这段接在公司模版的人设<b>后面</b>，不会替掉它——公司改了模版，你这段还在。', 'Say what this one is for and how it should behave. It is appended <b>after</b> the company persona, never replaces it — when the template changes, your note stays.')}
          </p>
          <textarea class="input satu-code" rows="6" data-bot="extraPrompt" placeholder="${esc(t('例如：你专门跟进华东区的客户回访，回复里带上客户名和上次联系时间。'))}">${esc(a.extraPrompt || '')}</textarea>
          <div class="field">
            <label for="bot-greeting">${t('开场问候')}</label>
            <input class="input" id="bot-greeting" type="text" data-bot="greeting" value="${esc(a.greeting)}">
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap; margin-top: var(--space-2);">
          <h2 style="font-size: 16px; margin: 0;">${t('继承自公司模版')}</h2>
          <span class="tag tag-accent-2">v${esc(String(tplVersion))}</span>
          <span style="font-size: 12.5px; color: var(--muted-foreground);">${t('由公司管理员统一维护，改了这里所有人的 Bot 一起变。', 'Maintained by your company admin; a change here moves everyone at once.')}</span>
        </div>
        <div class="satu-panel">
          <span class="satu-panel-title" style="text-transform: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; letter-spacing: 0;">soul.md</span>
          <textarea class="input satu-code" rows="8" disabled>${esc(base.prompt)}</textarea>
        </div>
        ${guardsPanel(base, true)}
        ${capabilityPanel(base, opts, true)}

        ${flashes()}
        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);">
          <button type="button" class="satu-linkbtn" style="text-align: left;" data-act="bot-delete">${t('删除这个 Bot')}</button>
          <button type="button" class="btn btn-primary" data-act="bot-save" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : t('保存配置')}</button>
        </div>
        <p style="margin: 0 0 var(--space-4); font-size: 12px; color: var(--muted-foreground);">${t('删除会连它的席位一起拆掉，机器上那块屏和这个 Bot 的会话都不再保留。', 'Deleting also tears down its seat — that screen and this bot\'s conversations are gone.')}</p>
      </div>
    </div>`
}

/** 全局 Bot（owner 编辑 / 公司侧只读），以及改版前留下的公司 Bot。 */
function fullBotPage(bot, a) {
  const ro = readOnlyItem(bot)
  const opts = state.botOptions || { skills: [], mcps: [], groups: [], kbs: [] }
  const iconPick = avatarKeysFor(bot.origin).map((key) => {
    const on = a.icon === key
    const label = t(BOT_AVATARS[key]?.label || key)
    return `<button type="button" class="satu-iconpick" aria-pressed="${String(on)}" aria-label="${esc(label)}" title="${esc(label)}" data-act="bot-icon" data-icon="${esc(key)}" ${ro ? 'disabled' : ''}>${botAvatar(key, 30, bot.origin)}</button>`
  }).join('')
  const roNote = bot.legacy
    ? t('这个 Bot 建于 Bot 模版之前，已经停用。公司的底座现在在「Bot 模版」那一页。', 'This bot predates the company template and is disabled. The company base now lives on the Bot template page.')
    : t('全局 Bot 由系统管理员维护')
  return `
    <div class="gw-page">
      <div class="gw-page-inner" style="max-width: 820px; gap: var(--space-4);">
        ${/* 「已保存」画在最下面那排按钮旁边——保存键在页尾，结论也该在那儿。 */ ''}
        <div class="satu-panel">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
            <div style="display: flex; align-items: flex-start; gap: var(--space-3); min-width: 0; flex: 1;">
              ${botAvatar(a.icon, 42, bot.origin)}
              <div style="min-width: 0; flex: 1; display: flex; flex-direction: column; gap: var(--space-2);">
                <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
                  <input class="input" style="max-width: 280px; font-family: var(--font-heading); font-size: 16px; font-weight: 600;" data-bot="name" value="${esc(a.name)}" placeholder="${esc(t('助理名字'))}" ${ro ? 'disabled' : ''}>
                  <span class="tag ${a.enabled ? 'tag-accent-2' : 'tag-neutral'}">${a.enabled ? t('已上线') : t('未上线')}</span>
                  ${bot.legacy ? `<span class="tag tag-neutral">${t('已停用')}</span>` : ''}
                </div>
                <input class="input" data-bot="description" value="${esc(a.description)}" placeholder="${esc(t('简介'))}" ${ro ? 'disabled' : ''}>
                ${/* 模型不给挑：平台在「模型配置」里定的那一个，所有 Bot 都用它。 */ ''}
                <div style="font-size: 12.5px; color: var(--muted-foreground);">${t(`本月执行 ${esc(bot.usage || '—')}`, `${esc(bot.usage || '—')} this month`)} · ${t(`模型 ${esc(a.model || '—')}（平台指定）`, `model ${esc(a.model || '—')} (set by the platform)`)}</div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px;">${iconPick}</div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
              <button type="button" class="satu-switch" aria-pressed="${String(!!a.enabled)}" aria-label="${esc(t('上线'))}" data-act="bot-enabled" ${ro ? 'disabled' : ''}><span></span></button>
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
            <span class="satu-panel-title" style="text-transform: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; letter-spacing: 0;">soul.md</span>
            <span style="font-size: 12px; color: var(--muted-foreground);" data-bot-prompt-len>${t(`${esc(String(a.prompt.length))} 字 · 每轮随上下文注入`, `${esc(String(a.prompt.length))} chars · injected each turn`)}</span>
          </div>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('这份文件定义 Agent 的身份、语气与工作原则，每次对话都会随上下文一起注入。')}</p>
          <textarea class="input satu-code" rows="12" data-bot="prompt" ${ro ? 'disabled' : ''}>${esc(a.prompt)}</textarea>
          <div class="field">
            <label for="bot-greeting">${t('开场问候')}</label>
            <input class="input" id="bot-greeting" type="text" data-bot="greeting" value="${esc(a.greeting)}" ${ro ? 'disabled' : ''}>
          </div>
        </div>

        ${guardsPanel(a, ro)}
        ${capabilityPanel(a, opts, ro)}
        ${memoryPanel(a, ro)}

        ${ro ? '' : `<div class="satu-panel">
          <span class="satu-panel-title">${t('可访问范围')}</span>
          <div class="field">
            <label>${t('可使用该 Agent 的分组')}</label>
            ${botPicks('groups', opts.groups, a.groups, t('没有可选项'))}
          </div>
          <div class="field">
            <label>${t('知识库')}</label>
            ${botPicks('kbs', opts.kbs, a.kbs, t('没有可选项'))}
          </div>
        </div>`}

        ${flashes()}
        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);">
          ${ro && !bot.legacy ? '' : `<button type="button" class="satu-linkbtn" style="text-align: left;" data-act="${bot.legacy ? 'legacy-bot-delete' : 'bot-delete'}" data-id="${esc(bot.id)}" data-name="${esc(bot.name)}">${t('删除这个 Bot')}</button>`}
          <div style="display: flex; gap: var(--space-2);">
            <button type="button" class="btn btn-primary" data-act="bot-save" ${state.busy || ro ? 'disabled' : ''} ${ro ? 'title="' + esc(roNote) + '"' : ''}>${state.busy ? t('保存中…') : ro ? t('只读') : t('保存配置')}</button>
          </div>
        </div>
        <p style="margin: 0 0 var(--space-4); font-size: 12px; color: var(--muted-foreground);">${ro ? esc(roNote) : t('这一页的设置都会写回目录。行为边界保存即生效（席位一分钟内跟上，拦截发生在工具执行前）。记忆现在还只是存下来：注入还没接到 Bot 上。分组与知识库也还没有落点。', 'Everything here is persisted to the catalog. Guardrails take effect on save — seats pick them up within a minute and enforcement happens before a tool runs. Memory is still stored only: injection is not wired into the bot yet. Groups and knowledge bases have no home yet either.')}</p>
      </div>
    </div>`
}

/**
 * 「新建 Bot」弹窗。员工自己建，建完还没有席位——要真的能聊，得在对话页上再点一次部署。
 *
 * 只问身份：名字、头像、简介、一段补充说明。其余的来自公司模版，这里不问也不给改。
 */
function newBotModal() {
  const f = state.newBot
  if (!f) return ''
  const icons = avatarKeysFor('company').map((key) => {
    const label = t(BOT_AVATARS[key]?.label || key)
    return `<button type="button" class="satu-iconpick" aria-pressed="${String(f.icon === key)}" aria-label="${esc(label)}" title="${esc(label)}" data-act="new-bot-icon" data-icon="${esc(key)}">${botAvatar(key, 30, 'company')}</button>`
  }).join('')
  const version = state.template?.version
  return `<div class="gw-modal-backdrop" data-act="new-bot-close">
    <div class="gw-modal" data-stop style="max-width: 520px;">
      <div>
        <h2 style="font-size: 20px; margin: 0 0 4px;">${t('新建 Bot')}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
          ${t(`它会用公司的 Bot 模版${version ? ` v${version}` : ''} 当底座——人设、能用的 Skill 和 MCP 都在那儿。这里只填它是谁。`, `It runs on your company's bot template${version ? ` v${version}` : ''} — persona, skills and MCP servers all come from there. Here you just say who it is.`)}
        </p>
      </div>
      <div class="field">
        <label for="nb-name">${t('名字')}</label>
        <input class="input" id="nb-name" data-newbot="name" value="${esc(f.name)}" placeholder="${esc(t('例如：回访助手'))}" autofocus>
      </div>
      <div class="field">
        <label for="nb-desc">${t('简介')}</label>
        <input class="input" id="nb-desc" data-newbot="description" value="${esc(f.description)}" placeholder="${esc(t('一句话说清它管什么'))}">
      </div>
      <div class="field">
        <label>${t('头像')}</label>
        <div style="display: flex; flex-wrap: wrap; gap: 6px;">${icons}</div>
      </div>
      <div class="field">
        <label for="nb-extra">${t('补充说明')}</label>
        <textarea class="input satu-code" id="nb-extra" rows="4" data-newbot="extraPrompt" placeholder="${esc(t('可留空。写了就接在公司人设后面。'))}">${esc(f.extraPrompt)}</textarea>
      </div>
      ${state.newBotError ? `<p style="margin: 0; font-size: 13px; color: var(--color-danger, #d33);">${esc(state.newBotError)}</p>` : ''}
      <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
        <button type="button" class="btn btn-secondary" data-act="new-bot-close">${t('取消')}</button>
        <button type="button" class="btn btn-primary" data-act="new-bot-save" ${state.busy ? 'disabled' : ''}>${state.busy ? t('创建中…') : t('创建')}</button>
      </div>
    </div>
  </div>`
}

function dayISO(ts) {
  if (!ts) return '—'
  return new Date(ts).toISOString().slice(0, 10)
}

function kbOf(n) {
  const x = Number(n) || 0
  return x < 1024 ? `${x} B` : x < 1024 * 1024 ? `${(x / 1024).toFixed(1)} KB` : `${(x / 1024 / 1024).toFixed(1)} MB`
}

function stepsOfBody(body) {
  return String(body || '')
    .split('\n')
    .filter((l) => /^\s*(?:\d+[.)]|[-*+])\s+/.test(l)).length
}

const SKILL_ICON = ['M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z']
const EDIT_ICON = ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z']
const FILE_ICON = ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6']
const UPLOAD_ICON = ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'm7 9 5-5 5 5', 'M12 4v12']
const CHECK_ICON = ['m5 13 4 4L19 7']
const PLUS_ICON = ['M12 5v14', 'M5 12h14']
const CLOSE_ICON = ['M18 6 6 18', 'M6 6l12 12']
const SKILL_SOURCES = [
  { key: '手动编写', label: '手动编写' },
  { key: '单文件 Skill', label: '单文件 Skill' },
  { key: 'ZIP 包', label: 'ZIP 包' },
]
const MCP_KINDS = ['stdio', 'SSE', 'HTTP']
const MCP_PERMS = [
  { key: '只读', label: '只读', tag: 'tag-neutral' },
  { key: '可写', label: '可写', tag: 'tag-accent' },
  { key: '需审批', label: '需审批', tag: 'tag-accent-2' },
]
function permTag(perm) {
  return MCP_PERMS.find((p) => p.key === perm)?.tag || 'tag-neutral'
}

function emptySkillForm(item) {
  return {
    name: item?.name || '',
    body: item?.body || '',
    tags: Array.isArray(item?.tags) ? [...item.tags] : [],
    source: item?.source || '手动编写',
    enabled: item ? item.enabled !== false : true,
    fileName: item?.fileName || '',
  }
}

function emptyServerForm(item) {
  const env = item?.env && typeof item.env === 'object' && Object.keys(item.env).length ? JSON.stringify(item.env, null, 2) : ''
  return {
    name: item?.name || '',
    kind: item?.kind || 'SSE',
    endpoint: item?.endpoint || '',
    token: '',
    env,
    perm: item?.perm || '只读',
    enabled: item ? item.enabled !== false : true,
    hasToken: !!item?.hasToken,
  }
}

function syncSkillForm() {
  const f = state.skillForm
  if (!f) return
  const name = document.getElementById('sk-name')
  const body = document.getElementById('sk-body')
  const endpoint = document.getElementById('tl-endpoint')
  const token = document.getElementById('tl-token')
  const env = document.getElementById('tl-env')
  if (name) f.name = name.value
  if (body) f.body = body.value
  if (endpoint) f.endpoint = endpoint.value
  if (token) f.token = token.value
  if (env) f.env = env.value
}

function closeSkillDialog() {
  state.skillDialog = null
  state.skillForm = null
  state.skillError = ''
  state.skillFile = null
  state.skillEntries = null
  state.skillTagManage = false
  state.skillTagAdding = false
}

function pickRow(label, options, value, act, hint) {
  const buttons = options
    .map((o) => {
      const key = o.key || o
      const lab = o.label || o
      return `<button type="button" class="satu-assignee" style="padding: 5px 12px;" aria-pressed="${String(value === key)}" data-act="${esc(act)}" data-value="${esc(key)}">${esc(lab)}</button>`
    })
    .join('')
  return `<div class="field">
    <label>${esc(label)}</label>
    <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${buttons}</div>
    ${hint ? `<span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint)}</span>` : ''}
  </div>`
}

function skillEnableRow(enabled) {
  return `<div class="satu-toggleRow" style="border-top: 0; padding: 0;">
    <div>
      <div style="font-size: 13.5px; font-weight: 600;">${t('保存后立即启用')}</div>
      <div style="font-size: 12px; color: var(--muted-foreground);">${t('关闭则仅保存，不对 Agent 开放')}</div>
    </div>
    <button type="button" class="satu-switch" aria-pressed="${String(!!enabled)}" aria-label="${esc(t('立即启用'))}" data-act="skill-enabled"><span></span></button>
  </div>`
}

function skillTagPicker(known, picked) {
  const manage = state.skillTagManage
  const chips = (known || [])
    .map((tag) =>
      manage
        ? `<button type="button" class="satu-assignee" style="padding: 5px 10px 5px 12px; gap: 6px; color: var(--color-accent-800);" aria-label="${t(`删除标签 ${esc(tag)}`, `Delete tag ${esc(tag)}`)}" data-act="skill-tag-delete" data-tag="${esc(tag)}">${esc(tag)} ${svg(CLOSE_ICON, 12)}</button>`
        : `<button type="button" class="satu-assignee" style="padding: 5px 12px;" aria-pressed="${String(picked.includes(tag))}" data-act="skill-tag-pick" data-tag="${esc(tag)}">${esc(tag)}</button>`,
    )
    .join('')
  const add = manage
    ? ''
    : state.skillTagAdding
      ? `<input class="input" id="sk-tag-draft" style="width: 120px; padding: 4px 10px; font-size: 13px;" autofocus data-skill-tag-draft placeholder="${esc(t('新标签'))}">`
      : `<button type="button" class="satu-assignee" style="padding: 5px 12px;" data-act="skill-tag-add">${svg(PLUS_ICON, 12)} ${t('新建标签', 'New tag')}</button>`
  const hint = manage
    ? t('点一个标签把它删掉——用到它的 Skill 上那一个也会一起去掉。')
    : t('可多选，用于筛选与归类')
  return `<div class="field">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
      <label style="margin: 0;">${t('标签')}</label>
      <button type="button" class="satu-linkbtn" style="font-size: 12px;" data-act="skill-tag-manage">${manage ? t('完成') : t('管理')}</button>
    </div>
    <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${chips}${add}</div>
    <span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint)}</span>
  </div>`
}

function skillEmpty(title, note) {
  return `<div style="display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; padding: var(--space-8) var(--space-4); border: 1px dashed var(--input-border); border-radius: var(--radius-lg); background: var(--card);">
    <div style="font-size: 14px; font-weight: 600;">${esc(title)}</div>
    <div style="font-size: 12.5px; color: var(--muted-foreground);">${esc(note)}</div>
  </div>`
}

function skillCard(skill) {
  // 全局项在公司侧只能看。owner 自己那份页面里不算只读。
  const ro = readOnlyItem(skill)
  const tags = (skill.tags || []).map((tag) => `<span class="tag tag-neutral" style="font-size: 11px; padding: 2px 8px;">${esc(tag)}</span>`).join('')
  const steps = skill.steps ? `<span>${t(`${esc(String(skill.steps))} 个步骤`, `${esc(String(skill.steps))} steps`)}</span>` : ''
  return `<div class="satu-card">
    <div style="display: flex; align-items: flex-start; gap: var(--space-3);">
      <span class="satu-providermark" style="background: var(--color-accent-100); color: var(--color-accent-800);">${svg(SKILL_ICON, 16)}</span>
      <div style="flex: 1; min-width: 0;">
        <div class="satu-name">${esc(skill.name)}${ro ? ` <span class="tag tag-accent-2" style="font-size: 11px;">${t('全局')}</span>` : ''}</div>
        <div style="display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px;">${tags}</div>
      </div>
      <button type="button" class="satu-switch" aria-pressed="${String(skill.enabled !== false)}" aria-label="${esc(t('启用'))}" data-act="skill-toggle" data-id="${esc(skill.id)}" ${ro ? 'disabled title="' + esc(t('全局 Skill 由系统管理员维护')) + '"' : ''}><span></span></button>
    </div>
    <p class="satu-desc">${esc(skill.summary || t('（还没写正文）'))}</p>
    <div style="height: 1px; background: var(--color-divider);"></div>
    <div class="satu-meta">
      ${steps}
      <span>${esc(skill.source || t('手动编写'))}</span>
      <span>${t(`更新于 ${esc(dayISO(skill.updatedAt))}`, `Updated ${esc(dayISO(skill.updatedAt))}`)}</span>
    </div>
    <div style="display: flex; gap: var(--space-2); margin-top: auto;">
      <button type="button" class="btn btn-secondary" style="flex: 1; justify-content: center;" data-act="skill-edit" data-id="${esc(skill.id)}" ${ro ? 'disabled title="' + esc(t('全局 Skill 由系统管理员维护')) + '"' : ''}>${ro ? t('查看') : t('编辑')}</button>
      <button type="button" class="btn btn-secondary" style="flex: none;" disabled title="${esc(t('试运行要等 Skill 接进 Agent 循环'))}">${t('试运行')}</button>
    </div>
  </div>`
}

function skillDialogView() {
  const d = state.skillDialog
  if (!d || d.type !== 'skill') return ''
  const f = state.skillForm || emptySkillForm(d.item)
  const skill = d.item
  const zip = f.source === 'ZIP 包'
  const upload = f.source !== '手动编写' && !skill
  const steps = stepsOfBody(f.body)
  const known = state.skillTags || []
  const file = state.skillFile
  const entries = state.skillEntries
  let uploadBlock = ''
  if (upload) {
    const accept = zip ? '.zip' : '.md,.markdown,.yaml,.yml,.json,.txt'
    const title = zip ? t('选择 .zip 技能包') : t('选择 SKILL.md / .yaml / .json')
    const hint = zip
      ? t('就在这台浏览器里解开，看清楚了再保存。')
      : t('文件内容就是这个 Skill 的定义，导入后可以直接在下面改。')
    const reqs = zip
      ? `<div style="display: flex; flex-direction: column; gap: 6px; padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
          <span class="satu-panel-title">${t('ZIP 包结构要求')}</span>
          ${[t('根目录含 SKILL.md（名称、说明、步骤）'), t('可选 scripts/、templates/、assets/ 子目录'), t('单包不超过 5 MB、200 个文件')]
            .map((line) => `<div class="satu-step" style="color: var(--muted-foreground);">${svg(CHECK_ICON, 13)} ${esc(line)}</div>`)
            .join('')}
        </div>`
      : ''
    const fileRow = file
      ? `<div class="satu-uploadrow">
          <span class="satu-dropicon" style="width: 32px; height: 32px;">${svg(FILE_ICON, 16)}</span>
          <div style="min-width: 0; flex: 1;">
            <div style="font-size: 13.5px; font-weight: 600;">${esc(file.name)}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${esc(kbOf(file.size))}${entries ? t(` · 解出 ${entries.length} 个文件`, ` · ${entries.length} files extracted`) : ''} · 读到 ${steps} 个步骤</div>
          </div>
          <span class="tag tag-accent-2">${zip ? t('已解开') : t('已读取')}</span>
        </div>`
      : ''
    const tree = zip && entries
      ? `<div class="satu-filetree" style="max-height: 168px;">
          ${entries
            .map(
              (entry) => `<div class="satu-fileitem" style="cursor: default;">
                <span class="satu-fileicon">${svg(FILE_ICON, 13)}</span>
                <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(entry.path)}</span>
                <span style="margin-left: auto; font-size: 11.5px; color: var(--muted-foreground);">${esc(kbOf(entry.bytes ? entry.bytes.length : 0))}</span>
              </div>`,
            )
            .join('')}
        </div>`
      : ''
    uploadBlock = `<div style="display: flex; flex-direction: column; gap: var(--space-3);">
      <label class="satu-drop">
        <input type="file" accept="${esc(accept)}" style="position: absolute; inset: 0; opacity: 0; cursor: pointer;" data-skill-file="1">
        <span class="satu-dropicon">${svg(UPLOAD_ICON, 20)}</span>
        <span style="font-size: 14px; font-weight: 600;">${esc(title)}</span>
        <span style="font-size: 12px; color: var(--muted-foreground); text-align: center;">${esc(hint)}</span>
      </label>
      ${reqs}
      ${fileRow}
      ${tree}
    </div>`
  }
  const showBody = !upload || file
  const bodyField = showBody
    ? `<div class="field">
        <label for="sk-body">${esc(skill?.fileName || t('Skill 说明'))}</label>
        <textarea class="input${skill || file ? ' satu-code' : ''}" id="sk-body" rows="${skill || file ? 14 : 6}" style="border-radius: var(--radius-md); resize: vertical;" placeholder="${esc(t('描述这个 Skill 解决什么问题、按什么步骤执行'))}">${esc(f.body)}</textarea>
        <span style="font-size: 12px; color: var(--muted-foreground);">${t(`按步骤写：每一条列表项算一个步骤，现在是 ${steps} 个。`, `Write it as steps: each list item counts as one. Currently ${steps}.`)}</span>
      </div>`
    : ''
  const sourceRow = skill ? '' : pickRow(t('创建方式'), SKILL_SOURCES, f.source, 'skill-source')
  const err = state.skillError
    ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${esc(state.skillError)}</div>`
    : ''
  const del = skill
    ? `<button type="button" class="satu-linkbtn" style="margin-right: auto; color: var(--color-accent-800);" data-act="skill-delete">${t('删除这个 Skill')}</button>`
    : ''
  return `<div class="gw-modal-backdrop" data-act="skill-close">
    <form id="skill-form" class="gw-modal" style="max-width: 560px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${skill ? t('编辑 Skill') : t('新建 Skill')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('Skill 把一组步骤和 MCP 工具打包成可复用的工作方法。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="skill-close">${svg(CLOSE_ICON, 16)}</button>
      </div>
      <div class="field">
        <label for="sk-name">${t('名称')}</label>
        <input class="input" id="sk-name" type="text" required value="${esc(f.name)}" placeholder="${esc(t('例如：工单归类与摘要'))}">
      </div>
      ${sourceRow}
      ${uploadBlock}
      ${bodyField}
      ${skillTagPicker(known, f.tags || [])}
      ${skillEnableRow(f.enabled)}
      ${err}
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2);">
        ${del}
        <button type="button" class="btn btn-secondary" data-act="skill-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : skill ? t('保存修改') : t('保存')}</button>
      </div>
    </form>
  </div>`
}

function serverDialogView() {
  const d = state.skillDialog
  if (!d || d.type !== 'server') return ''
  const f = state.skillForm || emptyServerForm(d.item)
  const server = d.item
  const stdio = f.kind === 'stdio'
  const err = state.skillError
    ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${esc(state.skillError)}</div>`
    : ''
  const del = server
    ? `<button type="button" class="satu-linkbtn" style="margin-right: auto; color: var(--color-accent-800);" data-act="mcp-delete">${t('移除这台服务器')}</button>`
    : ''
  const tokenHint = f.hasToken
    ? t('已存了一把。留空表示不动它，填了就换成新的。')
    : t('存在本机库里，不会再从服务端发回浏览器。')
  return `<div class="gw-modal-backdrop" data-act="skill-close">
    <form id="server-form" class="gw-modal" style="max-width: 520px; max-height: 88vh; overflow-y: auto;" data-stop>
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${server ? t('编辑 MCP 服务器') : t('接入 MCP 服务器')}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('接入之后，它提供的工具即可被 Agent 调用。')}</p>
        </div>
        <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('关闭'))}" data-act="skill-close">${svg(CLOSE_ICON, 16)}</button>
      </div>
      <div class="field">
        <label for="tl-name">${t('名称')}</label>
        <input class="input" id="tl-name" name="name" type="text" required value="${esc(f.name)}" placeholder="${esc(t('例如：zendesk-mcp'))}">
      </div>
      ${pickRow(t('传输方式'), MCP_KINDS.map((k) => ({ key: k, label: k })), f.kind, 'mcp-kind')}
      <div class="field">
        <label for="tl-endpoint">${stdio ? t('启动命令') : t('服务器地址')}</label>
        <input class="input" id="tl-endpoint" type="text" required value="${esc(f.endpoint)}" placeholder="${stdio ? 'npx -y @acme/mcp-server' : 'https://mcp.example.com/sse'}" ${stdio ? 'style="font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;"' : ''}>
        ${stdio ? `<span style="font-size: 12px; color: var(--muted-foreground);">${t('本机启动的进程，按 stdio 通信')}</span>` : ''}
      </div>
      <div class="field">
        <label for="tl-token">${t('鉴权 Token（可选）')}</label>
        <input class="input" id="tl-token" type="password" value="${esc(f.token)}" placeholder="${f.hasToken ? '••••••••' : 'Bearer …'}">
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(tokenHint)}</span>
      </div>
      <div class="field">
        <label for="tl-env">${t('环境变量（JSON，可选）')}</label>
        <textarea class="input" id="tl-env" rows="3" style="border-radius: var(--radius-md); resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;" placeholder='{"WORKSPACE_ID":"acme"}'>${esc(f.env)}</textarea>
      </div>
      ${pickRow(t('权限'), MCP_PERMS, f.perm, 'mcp-perm', t('这一档现在只是登记，真正的拦截要等工具管线接上 MCP。'))}
      ${skillEnableRow(f.enabled)}
      ${err}
      <div style="display: flex; align-items: center; justify-content: flex-end; gap: var(--space-2);">
        ${del}
        <button type="button" class="btn btn-secondary" data-act="skill-close">${t('取消')}</button>
        <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('保存中…') : server ? t('保存修改') : t('保存')}</button>
      </div>
    </form>
  </div>`
}

function skillsPage() {
  const tab = state.skillsTab === 'MCP 与工具' ? t('MCP 与工具') : 'Skill'
  const isSkill = tab === 'Skill'
  const skills = state.skills || []
  const servers = state.mcpServers || []
  const tabs = ['Skill', 'MCP 与工具']
    .map(
      (name) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === name)}" data-act="skills-tab" data-tab="${esc(name)}">${esc(name)}</button>`,
    )
    .join('')
  const failure = state.skillFailure
    ? `<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-md); padding: 10px var(--space-4); display: flex; justify-content: space-between; gap: var(--space-3);">
        <span>${esc(state.skillFailure)}</span>
        <button type="button" class="satu-linkbtn" data-act="skill-dismiss">${t('知道了')}</button>
      </div>`
    : ''
  let body
  if (isSkill) {
    body = skills.length
      ? `<div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: var(--space-4);">${skills.map(skillCard).join('')}</div>`
      : skillEmpty(t('还没有 Skill'), t('点右上角新建一个：手动写，或导入一份 SKILL.md。'))
  } else {
    const rows = servers
      .map(
        (s) => `<div class="satu-toolrow">
          <div style="min-width: 0; display: flex; flex-direction: column; gap: 2px;">
            <span style="font-weight: 600; font-size: 14px;">${esc(s.name)}${readOnlyItem(s) ? ` <span class="tag tag-accent-2" style="font-size: 11px;">${t('全局')}</span>` : ''}</span>
            <span style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(s.endpoint)}</span>
          </div>
          <span style="font-size: 13px;">${esc(s.kind)}</span>
          <span style="font-size: 13px; color: var(--muted-foreground);" title="${esc(t('接上之后才知道'))}">—</span>
          <span class="tag ${permTag(s.perm)}">${esc(s.perm)}</span>
          <span style="font-size: 13px; color: var(--muted-foreground);">${esc(dayISO(s.updatedAt))}</span>
          <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-1); justify-content: flex-end;">
            <button type="button" class="satu-switch" aria-pressed="${String(s.enabled !== false)}" aria-label="${esc(t('启用'))}" data-act="mcp-toggle" data-id="${esc(s.id)}" ${readOnlyItem(s) ? 'disabled title="' + esc(t('全局 MCP 由系统管理员维护')) + '"' : ''}><span></span></button>
            <button type="button" class="btn btn-ghost btn-icon" aria-label="${esc(t('编辑 MCP 服务器'))}" data-act="mcp-edit" data-id="${esc(s.id)}" ${readOnlyItem(s) ? 'disabled title="' + esc(t('全局 MCP 由系统管理员维护')) + '"' : ''}>${svg(EDIT_ICON, 15)}</button>
          </div>
        </div>`,
      )
      .join('')
    const table = servers.length
      ? `<div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-toolhead">
            <span>${t('MCP 服务器')}</span><span>${t('传输')}</span><span>${t('工具数')}</span><span>${t('权限')}</span><span>${t('更新时间')}</span><span></span>
          </div>
          ${rows}
        </div>`
      : skillEmpty(t('还没接入 MCP 服务器'), t('点右上角接入一台：填地址与权限，先把配置登记下来。'))
    body = `<div style="display: flex; flex-direction: column; gap: var(--space-6);">
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <div style="display: flex; align-items: baseline; justify-content: space-between;">
          <h2 style="font-size: 18px; margin: 0;">${t('内置工具')}</h2>
        </div>
        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover); padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('内置工具在 Bot 运行时上，Gateway 这一屏不列。')}</div>
      </div>
      <div style="display: flex; flex-direction: column; gap: var(--space-3);">
        <div style="display: flex; align-items: baseline; justify-content: space-between;">
          <h2 style="font-size: 18px; margin: 0;">${t('已接入 MCP 服务器')}</h2>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t(`共 ${servers.length} 个`, `${servers.length} total`)}</span>
        </div>
        ${table}
        <span style="font-size: 12px; color: var(--muted-foreground);">${t('这里存的是连接配置。MCP 客户端还没接上，所以「工具数」要等真握上手才知道，先空着。')}</span>
      </div>
    </div>`
  }
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('Skill 与 MCP')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('Skill 是可复用的工作方法，MCP 服务器提供 AI 员工实际可调用的工具。')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" data-act="${isSkill ? 'skill-create' : 'mcp-create'}">
            ${svg(PLUS_ICON, 15)} ${isSkill ? t('新建 Skill') : t('接入 MCP')}
          </button>
        </div>
        ${flashes()}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('分类')}</span>
          ${tabs}
        </div>
        ${failure}
        ${body}
      </div>
    </div>
    ${skillDialogView()}
    ${serverDialogView()}`
}


/**
 * 余额见底的横幅。
 *
 * **措辞跟着 enforce 走**：真会停下来和只是记账不拦截，是两件事。写死成「调用已暂停」
 * 而实际没停，公司会去查一个不存在的故障；反过来更糟。
 */
function creditWarning(balance) {
  const left = Number(balance.leftMicros)
  if (!Number.isFinite(left)) return ''
  const granted = Number(balance.grantedMicros) || 0
  if (left > 0) {
    // 见底之后才提醒等于没提醒——那时调用已经停了。一成是「还来得及去充」的量级。
    if (!granted || left > granted * 0.1) return ''
    return `<div class="gw-flash" style="margin: 0;">${esc(
      t(`额度还剩不到一成（${balance.left}），用完之后需要计费的调用会停下来。`,
        `Less than 10% of the credit is left (${balance.left}); billable calls stop when it runs out.`),
    )}</div>`
  }
  const msg = balance.enforce
    ? t('额度已用完，需要计费的调用（模型、连接器、网页搜索）已经停下来了。联系平台管理员充值后立刻恢复。',
        'Out of credit. Billable calls — model, connector and web search — are stopped. They resume as soon as the platform tops you up.')
    : t('额度已用完。平台目前没有开启熔断，调用还在继续，但这些钱是欠着的。',
        'Out of credit. The platform has not switched on enforcement, so calls still go through — but they are being booked against a negative balance.')
  return `<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(msg)}</div>`
}

function billingPage() {
  const data = state.billing || {
    plan: { name: '席位套餐', status: '生效中', cycle: '—', seats: '—', period: '—', renew: '—', amount: '—', autoRenew: false },
    invoices: [],
    balance: { amount: '—', spentThisPeriod: '—', alertAt: '—' },
    topups: [],
  }
  const plan = data.plan || {}
  const tab = ['topup', 'usage'].includes(state.billingTab) ? state.billingTab : 'sub'
  const renewing = state.billingAutoRenew ?? !!plan.autoRenew
  const invoices = Array.isArray(data.invoices) ? data.invoices : []
  const topups = Array.isArray(data.topups) ? data.topups : []
  const balance = data.balance || { amount: '—', spentThisPeriod: '—', alertAt: '—' }
  const tabs = [
    { key: 'sub', label: '订阅' },
    { key: 'topup', label: '充值' },
    { key: 'usage', label: '用量明细' },
  ]
    .map(
      (item) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(tab === item.key)}" data-act="billing-tab" data-tab="${item.key}">${t(item.label)}</button>`,
    )
    .join('')
  const invoiceRows = invoices
    .map(
      (b) => `<div class="satu-billrow">
        <span style="font-size: 13.5px;">${esc(b.period)}</span>
        <span style="font-size: 13.5px;">${esc(b.amount)}</span>
        <span class="tag tag-accent-2">${esc(b.status)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(b.paid)}</span>
        <div style="display: flex; align-items: center; gap: var(--space-3); justify-content: flex-end;">
          <button type="button" class="satu-linkbtn" disabled title="${esc(t('发票开具还没做'))}">${t('发票')}</button>
        </div>
      </div>`,
    )
    .join('')
  const topupRows = topups
    .map(
      (row) => `<div class="satu-billrow">
        <span style="font-size: 13.5px;">${esc(row.time)}</span>
        <span style="font-size: 13.5px;">${esc(row.amount)}</span>
        <span class="tag tag-accent-2">${t('已到账')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${esc(row.note || '—')}</span>
        <span></span>
      </div>`,
    )
    .join('')
  const empty = (msg) =>
    `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${esc(msg)}</div>`
  const subBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-6);">
          <div class="satu-panel">
            <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
              <div>
                <span class="satu-panel-title">${t('当前订阅')}</span>
                <div style="display: flex; align-items: baseline; gap: var(--space-2); margin-top: 6px;">
                  <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(plan.name || t('席位套餐'))}</span>
                  <span class="tag tag-accent-2">${esc(plan.status || t('生效中'))}</span>
                </div>
                <p style="margin: 6px 0 0; font-size: 13px; color: var(--muted-foreground);">${esc(plan.cycle || '—')} · ${esc(plan.seats || '—')}</p>
              </div>
              <button type="button" class="btn btn-secondary" style="flex: none;" disabled title="${esc(t('订阅体系还没做'))}">${t('管理订阅')}</button>
            </div>
            <div class="satu-kv"><span>${t('当前周期')}</span><span>${esc(plan.period || '—')}</span></div>
            <div class="satu-kv"><span>${t('下次续订')}</span><span>${esc(plan.renew || '—')}</span></div>
            <div class="satu-kv"><span>${t('周期费用')}</span><span>${esc(plan.amount || '—')}</span></div>
            <div class="satu-toggleRow">
              <div>
                <div style="font-size: 13.5px; font-weight: 600;">${t('自动续订')}</div>
                <div style="font-size: 12px; color: var(--muted-foreground);">${t('续订还没接，这个开关现在只是界面。')}</div>
              </div>
              <button type="button" class="satu-switch" aria-pressed="${String(renewing)}" aria-label="${esc(t('自动续订'))}" data-act="billing-autorenew"><span></span></button>
            </div>
          </div>
          <div style="display: flex; flex-direction: column; gap: var(--space-3);">
            <h2 style="font-size: 18px; margin: 0;">${t('订阅账单')}</h2>
            <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
              <div class="satu-billhead">
                <span>${t('账期')}</span><span>${t('金额')}</span><span>${t('状态')}</span><span>${t('付款时间')}</span><span></span>
              </div>
              ${invoiceRows || empty(t('还没有订阅账单。支付接上之后，账期会列在这里。'))}
            </div>
          </div>
        </div>`
  // 余额跟两个 tab 都有关（订阅送的 + 自己充的），所以提到 tab 上面，切 tab 也不换走。
  //
  // 两张卡并排：左边是会过期的那一笔，右边是账户合计。分开摆是因为这两笔的规矩不一样
  // ——赠送的跟着套餐到期清零，充的不过期。混在一张卡里只剩一个合计数，看不出该先花哪笔。
  const bonusExpiry = balance.planBonusExpires && balance.planBonusExpires !== '—'
    ? t(`${esc(balance.planBonusExpires)} 到期，没用完清零`, `expires ${esc(balance.planBonusExpires)}, unused amount is cleared`)
    : t('没有生效中的套餐')
  const balanceCard = `
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: var(--space-4);">
          <div class="satu-panel">
            <span class="satu-panel-title">${t('套餐赠送余额')}</span>
            <div style="display: flex; align-items: baseline; gap: var(--space-3); margin-top: 6px;">
              <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(balance.planBonusLeft || balance.planBonus || '—')}</span>
              <span style="font-size: 13px; color: var(--muted-foreground);">${bonusExpiry}</span>
            </div>
            ${/* 发的和剩的是两个数。只报「发了多少」等于让人盯着一个永远不动的数猜自己还能用多久。 */ ''}
            <div class="satu-kv"><span>${t('本期发放')}</span><span>${esc(balance.planBonus || '—')}</span></div>
            <div class="satu-kv"><span>${t('来源')}</span><span>${esc(plan.name || t('席位套餐'))}</span></div>
            <div class="satu-kv"><span>${t('当前周期')}</span><span>${esc(plan.period || '—')}</span></div>
            <p style="margin: auto 0 0; font-size: 12px; color: var(--muted-foreground);">${t('跟着套餐走：续订会重新发一笔，到期不结转。')}</p>
          </div>
          <div class="satu-panel">
            <span class="satu-panel-title">${t('账户余额')}</span>
            <div style="display: flex; align-items: baseline; gap: var(--space-3); margin-top: 6px;">
              <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(balance.left || balance.amount || '—')}</span>
              <span style="font-size: 13px; color: var(--muted-foreground);">${t(`本期已扣 ${esc(balance.spentThisPeriod || '—')}`, `${esc(balance.spentThisPeriod || '—')} charged this period`)}</span>
            </div>
            ${/* 合计里含左边那一笔，所以这儿把两笔各自摊开，省得看着像两个不相干的数。 */ ''}
            <div class="satu-kv">
              <span>${t('充值余额')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('不过期')}</span></span>
              <span>${esc(balance.topupLeft || balance.topup || '—')}</span>
            </div>
            <div class="satu-kv">
              <span>${t('套餐赠送余额')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('会过期')}</span></span>
              <span>${esc(balance.planBonusLeft || balance.planBonus || '—')}</span>
            </div>
            <div class="satu-kv"><span>${t('扣费顺序')}</span><span>${t('先赠送，再充值', 'bonus first, then top-up')}</span></div>
            <p style="margin: auto 0 0; font-size: 12px; color: var(--muted-foreground);">${t('充值由平台代充：需要加额度请联系平台管理员。')}</p>
          </div>
        </div>
        ${creditWarning(balance)}`
  const topupBody = `
        <div style="display: flex; flex-direction: column; gap: var(--space-6);">
          <div style="display: flex; flex-direction: column; gap: var(--space-3);">
            <h2 style="font-size: 18px; margin: 0;">${t('充值记录')}</h2>
            <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
              <div class="satu-billhead">
                <span>${t('时间')}</span><span>${t('金额')}</span><span>${t('状态')}</span><span>${t('备注')}</span><span></span>
              </div>
              ${topupRows || empty(t('还没有充值记录。'))}
            </div>
          </div>
        </div>`
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('账单')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('查看订阅状态、充值余额与历史账单。')}</p>
        </div>
        ${balanceCard}
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">${tabs}</div>
        ${flashes()}
        ${tab === 'sub' ? subBody : tab === 'topup' ? topupBody : chargeTable('org')}
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('账单是公司产品层的事，不走 Bot 运行时。发票和在线支付还没接，那两处的数字空着，不编；余额和扣费是真的。')}</p>
      </div>
    </div>`
}

function usageMeter(name, value, pct, alt, mono) {
  const font = mono ? ' font-family: ui-monospace, SFMono-Regular, Menlo, monospace;' : ''
  return `<div style="display: flex; flex-direction: column; gap: 5px;">
      <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3);">
        ${/* 面板窄，长名字（provider/model）必然被省略号切掉——把全名挂在 title 上，
              悬停能看全，不然「zaicodingplan/glm-…」两行长得一模一样。 */ ''}
        <span title="${esc(name)}" style="min-width: 0; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;${font}">${esc(name)}</span>
        <span style="flex: none; font-size: 12.5px; color: var(--muted-foreground);">${esc(value)}</span>
      </div>
      <div class="satu-meter"><div class="satu-meterfill" data-alt="${alt ? 'true' : 'false'}" style="width: ${Number(pct) || 0}%;"></div></div>
    </div>`
}

function usagePage() {
  const data = state.usage || {
    stats: [
      { label: '任务执行', value: '0', delta: '—' },
      { label: '输入 Tokens', value: '0', delta: '—' },
      { label: '输出 Tokens', value: '0', delta: '—' },
      { label: '费用', value: '—', delta: '—' },
    ],
    daily: [],
    byAgent: [],
    byKind: [],
    byModel: [],
    quota: [],
    seats: 0,
    byMember: [],
  }
  const ranges = ['近 7 天', '近 30 天', '本月']
  const range = state.usageRange || '近 30 天'
  const stats = Array.isArray(data.stats) ? data.stats : []
  const daily = Array.isArray(data.daily) ? data.daily : []
  const byAgent = Array.isArray(data.byAgent) ? data.byAgent : []
  const byModel = Array.isArray(data.byModel) ? data.byModel : []
  const byKind = Array.isArray(data.byKind) ? data.byKind : []
  const byMember = Array.isArray(data.byMember) ? data.byMember : []
  const seats = Number(data.seats) || 0
  const empty = (msg) =>
    `<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${esc(msg)}</div>`
  const pills = ranges
    .map(
      (r) =>
        `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(range === r)}" data-act="usage-range" data-range="${esc(r)}">${esc(r)}</button>`,
    )
    .join('')
  const statCards = stats
    .map(
      (s) => `<div class="satu-stat">
        <span style="font-size: 12px; color: var(--muted-foreground);">${esc(t(s.label))}</span>
        <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(s.value)}</span>
        <span style="font-size: 11.5px; color: var(--color-accent-2-800);">${esc(s.delta || '—')}</span>
      </div>`,
    )
    .join('')
  const dailyBody = daily.length
    ? (() => {
        const peak = Math.max(...daily.map((d) => Number(d.value) || 0), 0)
        const cols = daily
          .map((d) => {
            const v = Number(d.value) || 0
            const h = peak ? Math.round((v / peak) * 100) : 0
            return `<div class="satu-barcol" title="${esc(t(`${d.label} · ${v} 次`, `${d.label} · ${v} calls`))}">
                <div class="satu-barstack">
                  <div class="satu-barfill" style="height: ${h}%;"></div>
                </div>
                <span class="satu-barlabel">${esc(d.label)}</span>
              </div>`
          })
          .join('')
        return `<div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3); flex-wrap: wrap;">
            <span class="satu-panel-title">${t('每日任务执行量')}</span>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t(`峰值 ${peak} 次`, `peak ${peak} calls`)}</span>
          </div>
          <div class="satu-bars">${cols}</div>`
      })()
    : `<span class="satu-panel-title">${t('每日任务执行量')}</span>
          ${empty(t('这个时间段里还没有调用。'))}`
  const agentBody = byAgent.length
    ? byAgent.map((a) => usageMeter(a.name, a.value, a.pct, false, false)).join('')
    // 「没有数」和「这一维盖不全」是两件事。模型调用还带不上 Bot 标识（Gateway 收到的
    // 是一个 OpenAI 兼容请求，里面没有会话这个概念），所以这一块空着多半不是没用过。
    : empty(t('模型调用还没带上 Bot 标识，这里只数带得上的那些（连接器）。'))
  const modelBody = byModel.length
    ? byModel.map((m) => usageMeter(m.name, m.value, m.pct, true, true)).join('')
    : empty(t('这个时间段里还没有模型调用。'))
  const kindBody = byKind.length
    ? byKind.map((k) => usageMeter(k.name, k.value, k.pct, false, false)).join('')
    : empty(t('这个时间段里还没有计费记录。'))
  const memberRows = byMember
    .map((m) => {
      // 「已离职员工」是服务端兜出来的合计行，不是某个人——它的名字要翻译，真人的
      // 名字不能进译表。所以按标记分流，不是把所有 name 都塞进 t()。
      const label = m.departed
        ? `${t('已离职员工')}${m.count > 0 ? `（${m.count}）` : ''}`
        : m.name
      return `<div class="satu-usagerow"${m.departed ? ' style="opacity: 0.75;"' : ''}>
        <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
          <span class="satu-avatar" style="width: 26px; height: 26px; font-size: 11px; background: var(--color-neutral-300); color: var(--color-neutral-800);">${esc(m.initial || initialOf(m))}</span>
          <span style="min-width: 0; font-size: 13.5px;">${esc(label)}</span>
        </div>
        <span style="font-size: 13px;">${esc(m.tasks)}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(m.tokens)}</span>
        <span style="font-size: 13px;">${esc(m.amount || '—')}</span>
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(m.last)}</span>
      </div>`
    })
    .join('')
  return `
    <div class="gw-page">
      <div class="gw-page-inner">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('用量统计')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${esc(range)} · ${esc((Number((stats.find((x) => x.label === t('任务执行')) || {}).value) || 0) > 0 ? t('已记录调用') : t('还没有调用'))}</p>
          </div>
          <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
            ${pills}
            <button type="button" class="btn btn-secondary" disabled title="${esc(t('导出需要统计投影'))}">${t('导出 CSV')}</button>
          </div>
        </div>
        ${flashes()}
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: var(--space-3);">
          ${statCards}
        </div>
        <div class="satu-panel">
          ${dailyBody}
        </div>
        <div class="satu-agentpair">
          ${/* 按类型排在最前：模型 / 连接器 / 网页三条路是**盖得全**的那一维，
                钱就是从这三处出去的。另外两块各自只覆盖一部分。 */ ''}
          <div class="satu-panel">
            <span class="satu-panel-title">${t('按类型')}</span>
            ${kindBody}
          </div>
          <div class="satu-panel">
            <span class="satu-panel-title">${t('按模型')}</span>
            ${modelBody}
          </div>
          <div class="satu-panel">
            <span class="satu-panel-title">${t('按 Bot')}</span>
            ${agentBody}
          </div>
        </div>
        <div class="satu-panel">
          <div>
            <span class="satu-panel-title">${t('套餐额度')}</span>
            <p style="margin: 6px 0 0; font-size: 13px; color: var(--muted-foreground);">${t(`当前套餐只约束席位（${seats} 个），还没有任务次数和 token 额度。`, `The current plan only caps seats (${seats}); there is no task or token quota yet.`)}</p>
          </div>
        </div>
        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <h2 style="font-size: 18px; margin: 0;">${t('成员用量')}</h2>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-usagehead">
              ${/* 「失败率」那一列永远是 —（从来没接过），换成真的能填上的东西。 */ ''}
              <span>${t('成员')}</span><span>${t('任务')}</span><span>Tokens</span><span>${t('金额')}</span><span>${t('最近使用')}</span>
            </div>
            ${memberRows || empty(t('还没有成员。'))}
          </div>
        </div>
        ${chargeTable((isAdmin() || isOwner()) && orgId() ? 'org' : 'me')}
      </div>
    </div>`
}

