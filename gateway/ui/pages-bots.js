/** Bot 与它的能力（技能、MCP），以及账单与用量两页。 */
function pickId(o) {
  return typeof o === 'string' ? o : o && typeof o === 'object' ? String(o.id ?? o.name ?? '') : String(o ?? '')
}
function pickLabel(o) {
  return typeof o === 'string' ? o : o && typeof o === 'object' ? String(o.name ?? o.id ?? '') : String(o ?? '')
}

function botPicks(key, options, selected, hint) {
  const sel = Array.isArray(selected) ? selected : []
  const buttons = (options || [])
    .map((o) => {
      const id = pickId(o)
      const on = sel.includes(id)
      return `<button type="button" class="satu-assignee" style="padding: 5px 12px;" aria-pressed="${String(on)}" data-act="bot-pick" data-key="${esc(key)}" data-value="${esc(id)}">${esc(pickLabel(o))}</button>`
    })
    .join('')
  const empty = options && options.length ? '' : `<span style="font-size: 12px; color: var(--muted-foreground);">${esc(hint || t('没有可选项'))}</span>`
  return `<div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${buttons}${empty}</div>`
}

function botToggle(title, desc, on, act, extra = '') {
  return `<div class="satu-toggleRow">
    <div style="min-width: 0;">
      <div style="font-size: 13.5px; font-weight: 600;">${esc(title)}</div>
      <div style="font-size: 12px; color: var(--muted-foreground);">${esc(desc)}</div>
    </div>
    <button type="button" class="satu-switch" aria-pressed="${String(!!on)}" aria-label="${esc(title)}" data-act="${esc(act)}" ${extra}><span></span></button>
  </div>`
}

function botsPage() {
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
            <h1 style="font-size: 24px; margin: 0 0 4px;">${isOwner() ? t('全局 Bot') : t('Bot 配置')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${isOwner() ? t('这里建的 Bot 所有公司都能用。公司自己建的只在自己公司里可见。', 'Bots created here are available to every company. Company-created bots stay inside that company.') : t('管理 AI 员工的人设、能力与可访问范围。带「全局」标的由系统管理员维护，只能查看。', 'Manage personas, capabilities and access. Items tagged 全局 are maintained by the system owner and are read-only.')}</p>
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

function botDetailPage() {
  const bot = state.bot
  const a = state.botDraft
  if (!bot || !a) {
    return `<div class="gw-page"><div class="gw-page-inner" style="max-width: 820px;">${flashes()}<p style="color: var(--muted-foreground);">${t('载入中…')}</p></div></div>`
  }
  // 公司管理员打开的是全局 Bot：能看，不能存也不能删。
  const ro = readOnlyItem(bot)
  const opts = state.botOptions || { skills: [], mcps: [], groups: [], kbs: [] }
  const iconPick = avatarKeysFor(bot.origin).map((key) => {
    const on = a.icon === key
    const label = t(BOT_AVATARS[key]?.label || key)
    return `<button type="button" class="satu-iconpick" aria-pressed="${String(on)}" aria-label="${esc(label)}" title="${esc(label)}" data-act="bot-icon" data-icon="${esc(key)}" ${ro ? 'disabled' : ''}>${botAvatar(key, 30, bot.origin)}</button>`
  }).join('')
  const guards = (a.guards || [])
    .map((g) => botToggle(g.title, g.desc, g.on, 'bot-guard', `data-id="${esc(g.id)}"`))
    .join('')
  const scopePills = MEMORY_SCOPES.map(
    (sc) =>
      `<button type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed="${String(a.scope === sc)}" data-act="bot-scope" data-value="${esc(sc)}">${esc(t(sc))}</button>`,
  ).join('')
  // value 用中文原串当键（存的就是它），只翻显示的那一份。
  const ttlOpts = MEMORY_TTLS.map((ttl) => `<option value="${esc(ttl)}" ${ttl === a.ttl ? 'selected' : ''}>${esc(t(ttl))}</option>`).join('')
  const memoryBody = a.memoryOn
    ? `<div style="display: flex; flex-direction: column; gap: var(--space-4);">
        <div class="field">
          <label>${t('记忆范围')}</label>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">${scopePills}</div>
        </div>
        <div class="field">
          <label>${t('记录哪些内容')}</label>
          ${/* id 保持中文原串（存的是它），只翻显示的 label；botPicks 也喂用户数据，不能整体翻。 */ ''}
          ${botPicks('kinds', MEMORY_KINDS.map((k) => ({ id: k, name: t(k) })), a.kinds)}
        </div>
        <div class="satu-agentpair">
          <div class="field">
            <label for="bot-ttl">${t('保留时长')}</label>
            <select class="input" id="bot-ttl" data-act="bot-ttl">${ttlOpts}</select>
          </div>
          <div class="field">
            <label for="bot-cap" data-bot-cap-label>${t(`注入上限 · ${esc(a.cap)} 条`, `Injection cap · ${esc(a.cap)}`)}</label>
            <input class="input" id="bot-cap" type="range" min="5" max="50" step="5" value="${esc(a.cap)}" data-bot="cap" style="padding: 0; border: 0; background: transparent; accent-color: var(--color-accent);">
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('每次对话最多注入的记忆条数')}</span>
          </div>
        </div>
        ${botToggle(t('写入前需用户确认'), t('Agent 提议记住某条信息时先征求同意'), a.confirmOn, 'bot-confirm')}
        ${botToggle(t('不记录敏感信息'), t('手机号、证件号、银行卡等自动跳过'), a.piiOn, 'bot-pii')}
        <div style="display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
            <span style="font-size: 13.5px; font-weight: 600;">${t('已存记忆')}</span>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t(`${(a.memories || []).length} 条`, `${(a.memories || []).length} items`)}</span>
          </div>
          <div style="padding: 6px 0; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted-foreground);">${t('没有已存记忆')}</div>
        </div>
      </div>`
    : ''
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
                  <input class="input" style="max-width: 280px; font-family: var(--font-heading); font-size: 16px; font-weight: 600;" data-bot="name" value="${esc(a.name)}" placeholder="${esc(t('助理名字'))}">
                  <span class="tag ${a.enabled ? 'tag-accent-2' : 'tag-neutral'}">${a.enabled ? t('已上线') : t('未上线')}</span>
                </div>
                <input class="input" data-bot="description" value="${esc(a.description)}" placeholder="${esc(t('简介'))}">
                ${/* 模型不给挑：平台在「模型配置」里定的那一个，所有 Bot 都用它。 */ ''}
                <div style="font-size: 12.5px; color: var(--muted-foreground);">${t(`本月执行 ${esc(bot.usage || '—')}`, `${esc(bot.usage || '—')} this month`)} · ${t(`模型 ${esc(a.model || '—')}（平台指定）`, `model ${esc(a.model || '—')} (set by the platform)`)}</div>
                <div style="display: flex; flex-wrap: wrap; gap: 6px;">${iconPick}</div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
              <button type="button" class="satu-switch" aria-pressed="${String(!!a.enabled)}" aria-label="${esc(t('上线'))}" data-act="bot-enabled"><span></span></button>
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
            <span class="satu-panel-title" style="text-transform: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; letter-spacing: 0;">soul.md</span>
            <span style="font-size: 12px; color: var(--muted-foreground);" data-bot-prompt-len>${t(`${esc(String(a.prompt.length))} 字 · 每轮随上下文注入`, `${esc(String(a.prompt.length))} chars · injected each turn`)}</span>
          </div>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('这份文件定义 Agent 的身份、语气与工作原则，每次对话都会随上下文一起注入。')}</p>
          <textarea class="input satu-code" rows="12" data-bot="prompt">${esc(a.prompt)}</textarea>
          <div class="field">
            <label for="bot-greeting">${t('开场问候')}</label>
            <input class="input" id="bot-greeting" type="text" data-bot="greeting" value="${esc(a.greeting)}">
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('行为边界')}</span>
          ${guards}
          <div class="field">
            <label for="bot-escalate">${t('升级人工的条件')}</label>
            <input class="input" id="bot-escalate" type="text" data-bot="escalate" value="${esc(a.escalate)}">
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('这几条最终落在工具执行前的拦截上（tools/pre-execute），不是提示词里的一句话——现在还没接。')}</span>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('可用 Skill')}</span>
          ${botPicks('skills', opts.skills, a.skills, t('没有可选项'))}
          <span class="satu-panel-title" style="margin-top: var(--space-2);">${t('可用 MCP 服务器')}</span>
          ${botPicks('mcps', opts.mcps, a.mcps, t('没有可选项'))}
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('未勾选的能力，Agent 在任务中不可调用。')}</span>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('记忆')}</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('决定这个 Agent 能记住什么、记多久，以及记忆如何参与后续对话。')}</p>
          ${botToggle(t('启用长期记忆'), t('关闭后每次对话都从空白上下文开始'), a.memoryOn, 'bot-memory')}
          ${memoryBody}
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('可访问范围')}</span>
          <div class="field">
            <label>${t('可使用该 Agent 的分组')}</label>
            ${botPicks('groups', opts.groups, a.groups, t('没有可选项'))}
          </div>
          <div class="field">
            <label>${t('知识库')}</label>
            ${botPicks('kbs', opts.kbs, a.kbs, t('没有可选项'))}
          </div>
        </div>

        ${flashes()}
        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);">
          ${ro ? '' : `<button type="button" class="satu-linkbtn" style="text-align: left;" data-act="bot-delete">${t('删除这个 Bot')}</button>`}
          <div style="display: flex; gap: var(--space-2);">
            <button type="button" class="btn btn-primary" data-act="bot-save" ${state.busy || ro ? 'disabled' : ''} ${ro ? 'title="' + esc(t('全局 Bot 由系统管理员维护')) + '"' : ''}>${state.busy ? t('保存中…') : ro ? t('只读') : t('保存配置')}</button>
          </div>
        </div>
        <p style="margin: 0 0 var(--space-4); font-size: 12px; color: var(--muted-foreground);">${t('这一页的设置都会写回目录。行为边界与记忆现在只是存下来：拦截和注入还没接到 Bot 上。分组与知识库也还没有落点。', 'Everything here is persisted to the catalog. Guardrails and memory are stored only — enforcement and injection are not wired into the bot yet. Groups and knowledge bases have no home yet either.')}</p>
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


function billingPage() {
  const data = state.billing || {
    plan: { name: '席位套餐', status: '生效中', cycle: '—', seats: '—', period: '—', renew: '—', amount: '—', autoRenew: false },
    invoices: [],
    balance: { amount: '—', spentThisMonth: '—', alertAt: '—' },
    topups: [],
  }
  const plan = data.plan || {}
  const tab = state.billingTab === 'topup' ? 'topup' : 'sub'
  const renewing = state.billingAutoRenew ?? !!plan.autoRenew
  const invoices = Array.isArray(data.invoices) ? data.invoices : []
  const topups = Array.isArray(data.topups) ? data.topups : []
  const balance = data.balance || { amount: '—', spentThisMonth: '—', alertAt: '—' }
  const tabs = [
    { key: 'sub', label: '订阅' },
    { key: 'topup', label: '充值' },
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
              <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(balance.planBonus || '—')}</span>
              <span style="font-size: 13px; color: var(--muted-foreground);">${bonusExpiry}</span>
            </div>
            <div class="satu-kv"><span>${t('来源')}</span><span>${esc(plan.name || t('席位套餐'))}</span></div>
            <div class="satu-kv"><span>${t('当前周期')}</span><span>${esc(plan.period || '—')}</span></div>
            <p style="margin: auto 0 0; font-size: 12px; color: var(--muted-foreground);">${t('跟着套餐走：续订会重新发一笔，到期不结转。')}</p>
          </div>
          <div class="satu-panel">
            <span class="satu-panel-title">${t('账户余额')}</span>
            <div style="display: flex; align-items: baseline; gap: var(--space-3); margin-top: 6px;">
              <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${esc(balance.amount || '—')}</span>
              <span style="font-size: 13px; color: var(--muted-foreground);">${t(`本月已用 ${esc(balance.spentThisMonth || '—')}`, `${esc(balance.spentThisMonth || '—')} used this month`)}</span>
            </div>
            ${/* 合计里含左边那一笔，所以这儿把两笔各自摊开，省得看着像两个不相干的数。 */ ''}
            <div class="satu-kv">
              <span>${t('充值余额')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('不过期')}</span></span>
              <span>${esc(balance.topup || '—')}</span>
            </div>
            <div class="satu-kv">
              <span>${t('套餐赠送余额')}<span style="color: var(--muted-foreground); font-weight: 400;"> · ${t('会过期')}</span></span>
              <span>${esc(balance.planBonus || '—')}</span>
            </div>
            <div class="satu-kv"><span>${t('余额预警线')}</span><span>${esc(balance.alertAt || '—')}</span></div>
            <p style="margin: auto 0 0; font-size: 12px; color: var(--muted-foreground);">${t('充值由平台代充：需要加额度请联系平台管理员。')}</p>
          </div>
        </div>`
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
        ${tab === 'sub' ? subBody : topupBody}
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('账单是公司产品层的事，不走 Bot 运行时。发票、扣款、充值都还没接，数字空着，不编。')}</p>
      </div>
    </div>`
}

function usageMeter(name, value, pct, alt, mono) {
  const font = mono ? ' font-family: ui-monospace, SFMono-Regular, Menlo, monospace;' : ''
  return `<div style="display: flex; flex-direction: column; gap: 5px;">
      <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3);">
        <span style="min-width: 0; font-size: 13.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;${font}">${esc(name)}</span>
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
          ${empty(t('还没有每日用量。实例上报之后会画在这里。'))}`
  const agentBody = byAgent.length
    ? byAgent.map((a) => usageMeter(a.name, a.value, a.pct, false, false)).join('')
    : empty('还没有按 Bot 的用量。')
  const modelBody = byModel.length
    ? byModel.map((m) => usageMeter(m.name, m.value, m.pct, true, true)).join('')
    : empty('还没有按模型的用量。')
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
        <span style="font-size: 13px; color: var(--muted-foreground);">${esc(m.fail)}</span>
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
          <div class="satu-panel">
            <span class="satu-panel-title">${t('按 Bot')}</span>
            ${agentBody}
          </div>
          <div class="satu-panel">
            <span class="satu-panel-title">${t('按模型')}</span>
            ${modelBody}
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
              <span>${t('成员')}</span><span>${t('任务')}</span><span>Tokens</span><span>${t('失败率')}</span><span>${t('最近使用')}</span>
            </div>
            ${memberRows || empty(t('还没有成员。'))}
          </div>
        </div>
        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">${t('费用还没有账单，显示 —。调用次数和 token 来自 Gateway 记下的 llm_calls，没有就 0。')}</p>
      </div>
    </div>`
}

