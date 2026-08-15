import { Confirm, GROUP_ICONS, groupIcon, html, icon, ICONS, NavItem, t, useEffect, useHost, useRef, useState } from '@satu/shell'

/**
 * 账号管理。
 *
 * 成员这一半是**真的**：底下就是登录用的那张用户表。所以这一屏的每个动作都有
 * 后果——停用会当场断掉对方的会话，重置口令会作废他所有登录。界面因此在两处
 * 特别啰嗦：一次性口令只显示一次，破坏性操作一律先确认。
 */

const ICON = ['M2 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2', 'M8 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z', 'M19 8v6', 'M22 11h-6']
const COPY = ['M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z', 'M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1']

/** 角色只有两档。 */
const ROLES = () => [
  { key: 'admin', label: t('管理员', 'Admin') },
  { key: 'member', label: t('成员', 'Member') },
]
const ROLE_LABEL = () => Object.fromEntries(ROLES().map((r) => [r.key, r.label]))
/** 状态。同样按稿子：已激活 / 待接受 / 已停用。 */
const STATUS = () => ({
  active: { label: t('已激活', 'Active'), tag: 'tag-accent-2' },
  invited: { label: t('待接受', 'Pending'), tag: 'tag-accent' },
  disabled: { label: t('已停用', 'Disabled'), tag: 'tag-neutral' },
})

const ago = (ts) => {
  if (!ts) return t('从未登录', 'never')
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return t('刚刚', 'just now')
  if (m < 60) return t(`${m} 分钟前`, `${m} min ago`)
  if (m < 60 * 24) return t(`${Math.floor(m / 60)} 小时前`, `${Math.floor(m / 60)} h ago`)
  return t(`${Math.floor(m / 1440)} 天前`, `${Math.floor(m / 1440)} d ago`)
}

function AccountsNav({ ctx, path }) {
  return html`<${NavItem} ctx=${ctx} path=${path} href="/accounts" icon=${icon(ICON)} label=${t('账号管理', 'Accounts')} />`
}

function Notice({ text }) {
  return html`<div style="flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted-foreground);">${text}</div>`
}

function Stat({ label, value }) {
  return html`
    <div class="satu-stat">
      <span style="font-size: 12px; color: var(--muted-foreground);">${label}</span>
      <span style="font-family: var(--font-heading); font-size: 26px; line-height: 1;">${value}</span>
    </div>
  `
}

/**
 * 邀请链接。
 *
 * 给的是链接不是口令：口令一旦由管理员生成，就多了一次「谁经手过这把秘密」的
 * 环节；链接让本人自己设口令，管理员从头到尾不知道它是什么。链接**只显示这一
 * 次**（服务端只存哈希），所以这个框要说清楚，并且让复制一步完成。
 */
function InviteLink({ title, email, url, expiresAt, onClose }) {
  const [copied, setCopied] = useState(false)
  return html`
    <div
      style="position: fixed; inset: 0; z-index: 25; display: flex; align-items: center; justify-content: center; padding: var(--space-6); background: color-mix(in srgb, var(--color-neutral-900) 42%, transparent);"
      onClick=${(e) => e.target === e.currentTarget && onClose()}
    >
      <div style="width: 100%; max-width: 440px; box-sizing: border-box; background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-4);">
        <div>
          <h2 style="font-size: 20px; margin: 0 0 4px;">${title}</h2>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
            ${t('把这条链接发给', 'Send this link to')} <b>${email}</b>${t('，他打开后自行设置口令。', ' — they set their own password.')}
            ${t('链接只显示这一次，', 'It is shown once, ')}${t(`${Math.round((expiresAt - Date.now()) / 86400000)} 天后过期，用过即失效。`, `expires in ${Math.round((expiresAt - Date.now()) / 86400000)} days, and stops working once used.`)}
          </p>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-2);">
          <code class="satu-code" style="flex: 1; min-width: 0; padding: 10px var(--space-3); font-size: 12.5px; overflow-x: auto; white-space: nowrap;">${url}</code>
          <button
            type="button"
            class="btn btn-secondary"
            style="flex: none;"
            onClick=${async () => {
              await navigator.clipboard.writeText(url)
              setCopied(true)
            }}
          >${icon(COPY, 15)} ${copied ? t('已复制', 'Copied') : t('复制', 'Copy')}</button>
        </div>

        <div style="display: flex; justify-content: flex-end;">
          <button type="button" class="btn btn-primary" onClick=${onClose}>${t('我记下了', 'Got it')}</button>
        </div>
      </div>
    </div>
  `
}

/**
 * 邀请成员。
 *
 * 给的是**一次性链接**而不是口令：口令一旦由管理员生成，就多了一次「谁经手过这
 * 把秘密」的环节；链接让本人自己设口令，管理员从头到尾不知道它是什么。
 *
 * 链接生成后就地显示在表单里（稿子如此），并同时写进剪贴板——这个框存在的唯一
 * 目的就是把那段字符交出去。
 */
const TTLS = () => [
  { days: 1, label: t('1 天', '1 day') },
  { days: 7, label: t('7 天', '7 days') },
  { days: 30, label: t('30 天', '30 days') },
]

function InviteDialog({ ctx, onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', email: '', role: 'member', ttlDays: 7 })
  const [link, setLink] = useState(null)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const on = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  /**
   * 复制成功只在按钮上**闪一下**就退回去。
   *
   * 一直停在「已复制」的话，第二次点等于没有反馈——而这颗按钮的用途就是让人
   * 反复点到复制成功为止。按钮定了宽，字数变了它不跟着缩。
   */
  const timer = useRef(0)
  useEffect(() => () => clearTimeout(timer.current), [])
  const flash = () => {
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1600)
  }

  /**
   * 复制，成功失败都要说话。
   *
   * 浏览器可以拒绝写剪贴板（没有焦点、权限被关）。这颗按钮的全部意义就是把那段
   * 字符交出去，所以失败时必须明说「自己选中复制」，不能静悄悄什么都不发生。
   */
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text)
      setError(null)
      flash()
    } catch {
      setError(t('复制失败，请手动选中上面的链接复制。', 'Copy failed — select the link above and copy it manually.'))
    }
  }

  const submit = async (e) => {
    e.preventDefault()
    if (link) {
      await copy(link)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const { user, invite } = await ctx.host.post('/api/accounts/members', { ...form, ttlDays: Number(form.ttlDays) })
      setLink(invite.url)
      // 生成即复制：稿子上这颗按钮叫「生成并复制链接」，那就真的一步做完。
      await copy(invite.url)
      onCreated(user)
    } catch (err) {
      setError(err.message)
    }
    setBusy(false)
  }

  return html`
    <div
      style="position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; padding: var(--space-6); background: color-mix(in srgb, var(--color-neutral-900) 42%, transparent);"
      onClick=${(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        onSubmit=${submit}
        style="width: 100%; max-width: 500px; max-height: 88vh; overflow-y: auto; box-sizing: border-box; background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-4);"
      >
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h2 style="font-size: 20px; margin: 0 0 4px;">${t('邀请成员', 'Invite a member')}</h2>
            <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
              ${t('生成一条一次性邀请链接，发给要加入的同事。', 'Generate a single-use invite link and send it to your colleague.')}
            </p>
          </div>
          <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('关闭', 'Close')} onClick=${onClose}>${icon(ICONS.close, 16)}</button>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
          <div class="field">
            <label for="iv-name">${t('姓名', 'Name')}</label>
            <input class="input" id="iv-name" type="text" value=${form.name} onInput=${on('name')} placeholder=${t('受邀人姓名', 'Their name')} disabled=${!!link} />
          </div>
          <div class="field">
            <label for="iv-email">${t('邮箱', 'Email')}</label>
            <input class="input" id="iv-email" type="email" required value=${form.email} onInput=${on('email')} placeholder="name@acme.com" disabled=${!!link} />
          </div>
        </div>
        <span style="font-size: 12px; color: var(--muted-foreground); margin-top: calc(var(--space-3) * -1);">
          ${t('链接只对该邮箱有效，对方打开后仅需设置口令即可加入。', 'The link works only for that address; they just set a password to join.')}
        </span>

        <div class="field">
          <label for="iv-link">${t('一次性邀请链接', 'Single-use invite link')}</label>
          <input
            class="input"
            id="iv-link"
            type="text"
            readonly
            value=${link ?? ''}
            placeholder=${t('点下方按钮生成', 'Generate it below')}
            style="min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;"
          />
          <span style="font-size: 12px; color: var(--muted-foreground);">
            ${t('仅可使用 1 次，生成后按下方有效期失效。链接只显示这一次。', 'Single use, expires per the setting below. Shown only once.')}
          </span>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
          <div class="field">
            <label for="iv-role">${t('角色', 'Role')}</label>
            <select class="input" id="iv-role" value=${form.role} onChange=${on('role')} disabled=${!!link}>
              ${ROLES().map((r) => html`<option key=${r.key} value=${r.key}>${r.label}</option>`)}
            </select>
          </div>
          <div class="field">
            <label for="iv-ttl">${t('链接有效期', 'Link expires in')}</label>
            <select class="input" id="iv-ttl" value=${String(form.ttlDays)} onChange=${on('ttlDays')} disabled=${!!link}>
              ${TTLS().map((o) => html`<option key=${o.days} value=${String(o.days)}>${o.label}</option>`)}
            </select>
          </div>
        </div>

        ${error &&
        html`<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${error}</div>`}

        <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
          <button type="button" class="btn btn-secondary" onClick=${onClose}>${link ? t('完成', 'Done') : t('取消', 'Cancel')}</button>
          <button type="submit" class="btn btn-primary" style="min-width: 104px;" disabled=${busy}>
            ${busy
              ? t('生成中…', 'Generating…')
              : link
                ? copied
                  ? t('已复制', 'Copied')
                  : t('再复制一次', 'Copy again')
                : t('生成并复制链接', 'Generate and copy link')}
          </button>
        </div>
      </form>
    </div>
  `
}

/** 新建 / 编辑分组。 */
function GroupDialog({ ctx, group, members, onClose, onSaved }) {
  const [name, setName] = useState(group?.name ?? '')
  const [desc, setDesc] = useState(group?.desc ?? '')
  const [iconKey, setIconKey] = useState(group?.icon ?? 'chat')
  const [role, setRole] = useState(group?.role ?? 'member')
  const [picked, setPicked] = useState(group?.members ?? [])
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const body = { name, desc, icon: iconKey, role, members: picked }
      if (group) await ctx.host.patch(`/api/accounts/groups/${group.id}`, body)
      else await ctx.host.post('/api/accounts/groups', body)
      onSaved()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return html`
    <div
      style="position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; padding: var(--space-6); background: color-mix(in srgb, var(--color-neutral-900) 42%, transparent);"
      onClick=${(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        onSubmit=${submit}
        style="width: 100%; max-width: 460px; max-height: 88vh; overflow-y: auto; box-sizing: border-box; background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-4);"
      >
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h2 style="font-size: 20px; margin: 0 0 4px;">${group ? t('管理分组', 'Manage group') : t('新建分组', 'New group')}</h2>
            <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
              ${t('分组用于批量授权与统计，成员可同时属于多个分组。', 'Groups grant access in bulk; a member can belong to several at once.')}
            </p>
          </div>
          <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('关闭', 'Close')} onClick=${onClose}>${icon(ICONS.close, 16)}</button>
        </div>

        <div class="field">
          <label for="gp-name">${t('分组名称', 'Group name')}</label>
          <input class="input" id="gp-name" type="text" required value=${name} onInput=${(e) => setName(e.target.value)} placeholder=${t('例如：客服组', 'e.g. Support team')} />
        </div>

        <div class="field">
          <label for="gp-desc">${t('说明（可选）', 'Description (optional)')}</label>
          <input class="input" id="gp-desc" type="text" value=${desc} onInput=${(e) => setDesc(e.target.value)} placeholder=${t('这个分组负责什么', 'What is this group for')} />
        </div>

        <div class="field">
          <label>${t('分组图标', 'Group icon')}</label>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
            ${GROUP_ICONS.map(
              (g) => html`
                <button
                  key=${g.key}
                  type="button"
                  class="satu-iconpick"
                  aria-pressed=${String(iconKey === g.key)}
                  aria-label=${g.name}
                  title=${g.name}
                  onClick=${() => setIconKey(g.key)}
                >${icon(g.paths)}</button>
              `,
            )}
          </div>
        </div>

        <div class="field">
          <label>${t('默认角色', 'Default role')}</label>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
            ${ROLES().map(
              (r) => html`
                <button
                  key=${r.key}
                  type="button"
                  class="satu-assignee"
                  style="padding: 5px 14px;"
                  aria-pressed=${String(role === r.key)}
                  onClick=${() => setRole(r.key)}
                >${r.label}</button>
              `,
            )}
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">
            ${t('只影响之后被加进这个组的人，不改动已有成员的角色。', 'Applies to people added later; existing members keep their role.')}
          </span>
        </div>

        <div class="field">
          <label>${t('成员', 'Members')}</label>
          <div style="display: flex; flex-direction: column; gap: 1px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-2); max-height: 220px; overflow-y: auto;">
            ${members.map(
              (m) => html`
                <button
                  key=${m.id}
                  type="button"
                  class="satu-fileitem"
                  aria-current=${String(picked.includes(m.id))}
                  onClick=${() => setPicked((l) => (l.includes(m.id) ? l.filter((x) => x !== m.id) : [...l, m.id]))}
                >
                  <span class="satu-avatar" style="width: 24px; height: 24px; font-size: 11px; background: var(--color-neutral-300); color: var(--color-neutral-800);">
                    ${(m.name ?? m.email).slice(0, 1).toUpperCase()}
                  </span>
                  <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${m.name ? `${m.name} · ${m.email}` : m.email}
                  </span>
                  ${picked.includes(m.id) && html`<span style="margin-left: auto; display: flex;">${icon(['m5 13 4 4L19 7'], 14)}</span>`}
                </button>
              `,
            )}
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t(`已选 ${picked.length} 人`, `${picked.length} selected`)}</span>
        </div>

        ${error &&
        html`<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${error}</div>`}

        <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
          <button type="button" class="btn btn-secondary" onClick=${onClose}>${t('取消', 'Cancel')}</button>
          <button type="submit" class="btn btn-primary" disabled=${busy}>${busy ? t('保存中…', 'Saving…') : group ? t('保存', 'Save') : t('创建分组', 'Create group')}</button>
        </div>
      </form>
    </div>
  `
}

/**
 * 编辑成员。照稿子：角色、状态、密码重置链接三段。
 *
 * 角色**只在这里改**，列表那一列是只读的——一列下拉挨着一列下拉，手一滑就把别人
 * 的权限改了，而这个动作没有撤销。
 */
const STATUS_HINT = () => ({
  active: t('可正常登录并使用已授权的 AI 员工。', 'Can sign in and use the AI employees they are granted.'),
  disabled: t('立即断开其全部登录，且无法再登录。历史记录保留。', 'Signs them out immediately and blocks sign-in. History is kept.'),
  invited: t('退回未接受状态：当前登录立即失效，需要用新的邀请链接重新设置口令。', 'Back to pending: current sessions end and they need a fresh invite link.'),
})

function EditMember({ ctx, member, isSelf, onClose, onSaved, onFail }) {
  const [name, setName] = useState(member.name)
  const [role, setRole] = useState(member.role)
  const [status, setStatus] = useState(member.status)
  const [link, setLink] = useState(null)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  /**
   * 哪些状态是这个账号现在能去的。
   *
   * 「待接受」只属于**还没设过口令**的那一段：一旦本人设过口令、账号激活过，就
   * 回不去了——那个状态的含义是「口令还没被人设过」，而它已经被设过了。反过来，
   * 待接受的账号也不能由管理员直接点成已激活：他手上那把口令是建号时随机塞的，
   * 谁都不知道，点完只会得到一个登不进来的「已激活」账号。
   */
  const canBe = (key) => (key === 'invited' ? member.status === 'invited' : member.status !== 'invited' || key === 'disabled')
  const whyNot = (key) =>
    key === 'invited'
      ? t('已激活的账号退不回待接受。要让 TA 重设口令，用下面的重置链接。', 'An activated account cannot go back to pending. Use the reset link below instead.')
      : t('等 TA 用邀请链接设完口令，会自动转为已激活。', 'It flips to active once they set a password via the invite link.')

  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    try {
      const patch = { name }
      // 自己的角色与状态改不了，服务端也拦——这里不发出去，省一次注定失败的请求。
      if (!isSelf) {
        if (role !== member.role) patch.role = role
        if (status !== member.status) patch.status = status
      }
      await ctx.host.patch(`/api/accounts/members/${member.id}`, patch)
      onSaved()
    } catch (err) {
      onFail(err.message)
      setBusy(false)
      onClose()
    }
  }

  const makeLink = async () => {
    try {
      const { invite } = await ctx.host.post(`/api/accounts/members/${member.id}/reset`)
      setLink(invite.url)
      setCopied(false)
    } catch (err) {
      onFail(err.message)
    }
  }

  return html`
    <div
      style="position: fixed; inset: 0; z-index: 24; display: flex; align-items: center; justify-content: center; padding: var(--space-6); background: color-mix(in srgb, var(--color-neutral-900) 42%, transparent);"
      onClick=${(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        onSubmit=${submit}
        style="width: 100%; max-width: 460px; max-height: 88vh; overflow-y: auto; box-sizing: border-box; background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-4);"
      >
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h2 style="font-size: 20px; margin: 0 0 4px;">${t('编辑成员', 'Edit member')}</h2>
            <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
              ${t('修改角色与状态，或给 TA 发一条口令重置链接。', 'Change role and status, or send them a password reset link.')}
            </p>
          </div>
          <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('关闭', 'Close')} onClick=${onClose}>${icon(ICONS.close, 16)}</button>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
          <span class="satu-avatar" style="background: var(--color-accent-2-200); color: var(--color-accent-2-800);">${(member.name ?? member.email).slice(0, 1).toUpperCase()}</span>
          <div style="min-width: 0;">
            <div style="font-size: 14px; font-weight: 600;">${member.name}</div>
            <div style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${member.email}</div>
          </div>
        </div>

        <div class="field">
          <label for="em-name">${t('姓名', 'Name')}</label>
          <input class="input" id="em-name" type="text" required value=${name} onInput=${(e) => setName(e.target.value)} />
        </div>

        <div class="field">
          <label>${t('角色', 'Role')}</label>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
            ${ROLES().map(
              (r) => html`
                <button
                  key=${r.key}
                  type="button"
                  class="satu-assignee"
                  style="padding: 5px 14px;"
                  aria-pressed=${String(role === r.key)}
                  disabled=${isSelf}
                  onClick=${() => setRole(r.key)}
                >${r.label}</button>
              `,
            )}
          </div>
        </div>

        <div class="field">
          <label>${t('状态', 'Status')}</label>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
            ${['active', 'disabled', 'invited'].map(
              (key) => html`
                <button
                  key=${key}
                  type="button"
                  class="satu-assignee"
                  style="padding: 5px 14px;"
                  aria-pressed=${String(status === key)}
                  disabled=${isSelf || !canBe(key)}
                  title=${canBe(key) ? '' : whyNot(key)}
                  onClick=${() => setStatus(key)}
                >${STATUS()[key].label}</button>
              `,
            )}
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">${STATUS_HINT()[status]}</span>
        </div>

        ${isSelf &&
        html`<span style="font-size: 12px; color: var(--muted-foreground);">${t('不能改自己的角色与状态——手滑一次就把自己关在门外。', 'You cannot change your own role or status — one slip would lock you out.')}</span>`}

        <div style="display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3);">
            <div style="min-width: 0;">
              <div style="font-size: 13.5px; font-weight: 600;">${t('口令重置链接', 'Password reset link')}</div>
              <div style="font-size: 12px; color: var(--muted-foreground);">
                ${t('生成后自行发给成员，1 小时内有效且仅能使用一次', 'Generate it, pass it on yourself — valid for one hour, single use')}
              </div>
            </div>
            <button type="button" class="btn btn-secondary" style="flex: none;" onClick=${makeLink}>
              ${link ? t('重新生成', 'Regenerate') : t('生成链接', 'Generate link')}
            </button>
          </div>
          ${link &&
          html`
            <div style="display: flex; align-items: center; gap: var(--space-2);">
              <code class="satu-code" style="flex: 1; min-width: 0; padding: 8px var(--space-3); font-size: 12px; overflow-x: auto; white-space: nowrap;">${link}</code>
              <button
                type="button"
                class="btn btn-secondary"
                style="flex: none;"
                onClick=${async () => {
                  await navigator.clipboard.writeText(link)
                  setCopied(true)
                }}
              >${icon(COPY, 15)} ${copied ? t('已复制', 'Copied') : t('复制', 'Copy')}</button>
            </div>
            <span style="font-size: 12px; color: var(--muted-foreground);">
              ${t('生成的同时，TA 当前的登录已全部失效。链接只显示这一次。', 'Their existing sessions are already invalidated. The link is shown only once.')}
            </span>
          `}
        </div>

        <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
          <button type="button" class="btn btn-secondary" onClick=${onClose}>${t('取消', 'Cancel')}</button>
          <button type="submit" class="btn btn-primary" disabled=${busy}>${busy ? t('保存中…', 'Saving…') : t('保存', 'Save')}</button>
        </div>
      </form>
    </div>
  `
}

// ── 主屏 ───────────────────────────────────────────────────────────────────
function AccountsPage({ ctx }) {
  const { data, error, loading, reload } = useHost(ctx, '/api/accounts')
  const [tab, setTab] = useState('members')
  const [menu, setMenu] = useState(null)
  // 靠底部的行要向上弹，否则菜单开在可视区外，看起来像「点了没反应」。
  const [flip, setFlip] = useState(false)
  const [invite, setInvite] = useState(false)
  const [groupDialog, setGroupDialog] = useState(null)
  const [secret, setSecret] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [editing, setEditing] = useState(null)
  const [failure, setFailure] = useState(null)

  useEffect(() => {
    if (!menu) return
    const onClick = (e) => {
      if (!e.target.closest?.('.satu-menu, [data-menu-toggle]')) setMenu(null)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [menu])

  if (loading) return html`<${Notice} text=${t('载入中…', 'Loading…')} />`
  if (error) return html`<${Notice} text=${error.message} />`

  const { members, groups, seats, me } = data
  const canManage = me.role === 'owner' || me.role === 'admin'

  /** 所有写操作走这一条：失败就把服务端那句话原样显示出来。 */
  const run = async (fn) => {
    setMenu(null)
    try {
      await fn()
      reload()
    } catch (e) {
      setFailure(e.message)
    }
  }

  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6);">
      <div style="max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-6);">

        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('账号管理', 'Accounts')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('邀请同事加入，并管理成员角色与权限。', 'Invite colleagues and manage their roles.')}</p>
          </div>
          <button
            type="button"
            class="btn btn-primary"
            style="flex: none;"
            disabled=${!canManage}
            title=${canManage ? '' : t('需要管理员权限', 'Requires admin')}
            onClick=${() => (tab === 'members' ? setInvite(true) : setGroupDialog({}))}
          >
            ${icon(ICONS.plus, 15)} ${tab === 'members' ? t('邀请成员', 'Invite member') : t('新建分组', 'New group')}
          </button>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          ${[{ key: 'members', label: t('成员', 'Members') }, { key: 'groups', label: t('分组', 'Groups') }].map(
            (item) => html`
              <button key=${item.key} type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed=${String(tab === item.key)} onClick=${() => setTab(item.key)}>${item.label}</button>
            `,
          )}
        </div>

        ${failure &&
        html`
          <div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-md); padding: 10px var(--space-4); display: flex; justify-content: space-between; gap: var(--space-3);">
            <span>${failure}</span>
            <button type="button" class="satu-linkbtn" onClick=${() => setFailure(null)}>${t('知道了', 'Dismiss')}</button>
          </div>
        `}

        ${tab === 'members'
          ? html`
              <div style="display: flex; flex-direction: column; gap: var(--space-6);">
                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-3);">
                  <${Stat} label=${t('成员', 'Members')} value=${members.length} />
                  <${Stat} label=${t('管理员', 'Admins')} value=${members.filter((m) => m.role === 'admin').length} />
                  <${Stat} label=${t('待接受邀请', 'Pending invites')} value=${members.filter((m) => m.status === 'invited').length} />
                  <${Stat} label=${t('席位余量', 'Seats left')} value=${seats.total - seats.used} />
                </div>

                <div style="display: flex; flex-direction: column; gap: var(--space-3);">
                  <div style="display: flex; align-items: baseline; justify-content: space-between;">
                    <h2 style="font-size: 18px; margin: 0;">${t('成员', 'Members')}</h2>
                    <span style="font-size: 12px; color: var(--muted-foreground);">${t(`共 ${members.length} 人`, `${members.length} members`)}</span>
                  </div>
                  <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
                    <div class="satu-memberhead">
                      <span>${t('成员', 'Member')}</span><span>${t('角色', 'Role')}</span><span>${t('状态', 'Status')}</span><span>${t('最近活跃', 'Last active')}</span><span></span>
                    </div>
                    ${members.map(
                      (m) => html`
                        <div class="satu-memberrow" key=${m.id}>
                          <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
                            <span class="satu-avatar" style="background: var(--color-neutral-300); color: var(--color-neutral-800);">${(m.name ?? m.email).slice(0, 1).toUpperCase()}</span>
                            <div style="min-width: 0;">
                              <div style="font-size: 13.5px; font-weight: 600;">${m.name}${m.id === me.id ? t(' · 你', ' · you') : ''}</div>
                              <div style="font-size: 12px; color: var(--muted-foreground);">${m.email}</div>
                            </div>
                          </div>
                          <span style="font-size: 13px;">${ROLE_LABEL()[m.role] ?? m.role}</span>
                          <span class=${`tag ${STATUS()[m.status].tag}`}>${STATUS()[m.status].label}</span>
                          <span style="font-size: 13px; color: var(--muted-foreground);">
                            ${m.id === me.id
                              ? t('正在使用', 'active now')
                              : m.status === 'invited'
                                ? t(`邀请于 ${new Date(m.createdAt).toLocaleDateString('zh-CN')}`, `invited ${new Date(m.createdAt).toLocaleDateString('en-US')}`)
                                : ago(m.lastSeenAt)}
                          </span>
                          <div class="satu-rowactions" style="display: flex; justify-content: flex-end; position: relative;">
                            ${m.id === me.id && html`<span style="font-size: 12px; color: var(--muted-foreground);">${t('你', 'you')}</span>`}
                            ${canManage &&
                            html`
                              <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('编辑成员', 'Edit member')} onClick=${() => setEditing(m)}>
                                ${icon(['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'], 15)}
                              </button>
                            `}
                            ${canManage && m.id !== me.id &&
                            html`
                              <button
                                type="button"
                                class="btn btn-ghost btn-icon"
                                aria-label=${t('更多操作', 'More actions')}
                                data-menu-toggle
                                onClick=${(e) => {
                                  // 靠底部的行向上弹：菜单开在可视区外，看起来就是「点了没反应」。
                                  setFlip(e.currentTarget.getBoundingClientRect().bottom > innerHeight - 260)
                                  setMenu(menu === m.id ? null : m.id)
                                }}
                              >
                                ${icon(ICONS.dots, 16)}
                              </button>
                            `}
                            ${menu === m.id &&
                            html`
                              <div class="satu-menu" data-flip=${String(flip)}>
                                <button type="button" class="satu-menuitem" onClick=${() => setEditing(m)}>${t('编辑成员', 'Edit member')}</button>
                                <button type="button" class="satu-menuitem" onClick=${() => run(async () => {
                                  const { invite } = await ctx.host.post(`/api/accounts/members/${m.id}/reset`)
                                  setSecret({
                                    title: m.status === 'invited' ? t('新的邀请链接', 'New invite link') : t('口令重设链接', 'Password reset link'),
                                    email: m.email,
                                    ...invite,
                                  })
                                })}>${m.status === 'invited' ? t('重发邀请', 'Resend invite') : t('重置口令', 'Reset password')}</button>
                                ${m.status !== 'active' &&
                                html`
                                  <button
                                    type="button"
                                    class="satu-menuitem"
                                    disabled=${m.status === 'invited'}
                                    title=${m.status === 'invited' ? t('等 TA 用邀请链接设完口令，会自动转为已激活。', 'It flips to active once they set a password via the invite link.') : ''}
                                    onClick=${() =>
                                      setConfirm({
                                        title: t('恢复这名成员？', 'Re-enable this member?'),
                                        body: t(`「${m.name}」将可以重新登录。`, `${m.name} will be able to sign in again.`),
                                        label: t('已激活', 'Activate'),
                                        run: () => ctx.host.patch(`/api/accounts/members/${m.id}`, { status: 'active' }),
                                      })}
                                  >${STATUS().active.label}</button>
                                `}
                                ${m.status !== 'disabled' &&
                                html`
                                  <button
                                    type="button"
                                    class="satu-menuitem"
                                    onClick=${() =>
                                      setConfirm({
                                        title: t('停用这名成员？', 'Disable this member?'),
                                        body: t(
                                          `「${m.name}」当前的登录会立即失效，之后也无法再登录。历史记录保留。`,
                                          `${m.name}'s sessions end immediately and they cannot sign in. History is kept.`,
                                        ),
                                        label: t('已停用', 'Disable'),
                                        run: () => ctx.host.patch(`/api/accounts/members/${m.id}`, { status: 'disabled' }),
                                      })}
                                  >${STATUS().disabled.label}</button>
                                `}
                                <div style="height: 1px; background: var(--border); margin: 4px 0;"></div>
                                <button type="button" class="satu-menuitem" data-danger="true" onClick=${() =>
                                  setConfirm({
                                    title: t('删除这名成员？', 'Delete this member?'),
                                    body: t(
                                      `「${m.name}」的账号将被删除，登录立即失效。他创建的会话与定时任务保留但不再执行。`,
                                      `${m.name}'s account is deleted and their sessions end. Their chats and tasks remain but stop running.`,
                                    ),
                                    label: t('删除', 'Delete'),
                                    run: () => ctx.host.delete(`/api/accounts/members/${m.id}`),
                                  })}>${t('删除', 'Delete')}</button>
                              </div>
                            `}
                          </div>
                        </div>
                      `,
                    )}
                  </div>
                </div>
              </div>
            `
          : html`
              <div style="display: flex; flex-direction: column; gap: var(--space-3);">
                <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
                  <div class="satu-grouphead">
                    <span>${t('分组', 'Group')}</span><span>${t('成员', 'Members')}</span><span>${t('默认角色', 'Default role')}</span><span>${t('创建时间', 'Created')}</span><span></span>
                  </div>
                  ${groups.map(
                    (g) => html`
                      <div class="satu-grouprow" key=${g.id}>
                        <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
                          <span class="satu-providermark" style=${g.builtin
                            ? 'background: var(--color-accent-100); color: var(--color-accent-800);'
                            : 'background: var(--color-accent-2-100); color: var(--color-accent-2-800);'}>${groupIcon(g.icon, 16)}</span>
                          <div style="min-width: 0;">
                            <div style="display: flex; align-items: center; gap: var(--space-2);">
                              <span style="font-size: 14px; font-weight: 600;">${g.name}</span>
                              ${g.builtin && html`<span class="tag tag-accent-2">${t('固定分组', 'Built-in')}</span>`}
                            </div>
                            <div style="font-size: 12px; color: var(--muted-foreground);">${g.desc}</div>
                          </div>
                        </div>
                        <span style="font-size: 13px;">${t(`${g.members.length} 人`, `${g.members.length}`)}</span>
                        <span style="font-size: 13px;">${g.builtin ? t('按成员设置', 'Per member') : (ROLE_LABEL()[g.role] ?? g.role)}</span>
                        <span style="font-size: 13px; color: var(--muted-foreground);">${new Date(g.createdAt).toISOString().slice(0, 10)}</span>
                        <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-3); justify-content: flex-end;">
                          ${g.builtin
                            ? html`<span style="font-size: 12px; color: var(--muted-foreground);">${t('自动包含全部成员', 'Everyone, always')}</span>`
                            : html`
                                <button type="button" class="satu-linkbtn" disabled=${!canManage} onClick=${() => setGroupDialog(g)}>${t('管理成员', 'Manage members')}</button>
                                <button
                                  type="button"
                                  class="btn btn-ghost btn-icon"
                                  aria-label=${t('删除分组', 'Delete group')}
                                  disabled=${!canManage}
                                  onClick=${() =>
                                    setConfirm({
                                      title: t('删除这个分组？', 'Delete this group?'),
                                      body: t(
                                        `「${g.name}」删除后，它授权的 Agent 访问范围随之失效。成员账号不受影响。`,
                                        `Deleting ${g.name} removes the agent access it granted. Member accounts are untouched.`,
                                      ),
                                      label: t('删除', 'Delete'),
                                      run: () => ctx.host.delete(`/api/accounts/groups/${g.id}`),
                                    })}
                                >${icon(['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14'], 15)}</button>
                              `}
                        </div>
                      </div>
                    `,
                  )}
                </div>
                <span style="font-size: 12px; color: var(--muted-foreground);">
                  ${t('「全体成员」为系统固定分组，新成员加入后自动进入，不可删除或移除成员。', '"Everyone" is built in: new members join it automatically, and it cannot be deleted or edited.')}
                </span>
              </div>
            `}

        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">
          ${t('成员这一半是真的：停用会当场断掉对方的会话，重置口令会作废他所有登录。角色与权限的判断在服务端，界面上的禁用只是提前告诉你结果。', 'The member half is real: disabling ends their sessions on the spot, and a reset invalidates every sign-in. Authorization is enforced server-side; the greyed-out controls only tell you the answer early.')}
        </p>
      </div>
    </div>

    ${editing &&
    html`
      <${EditMember}
        ctx=${ctx}
        member=${editing}
        isSelf=${editing.id === me.id}
        onClose=${() => setEditing(null)}
        onSaved=${() => {
          setEditing(null)
          reload()
        }}
        onFail=${(msg) => setFailure(msg)}
      />
    `}

    ${invite &&
    html`
      <${InviteDialog}
        ctx=${ctx}
        onClose=${() => {
          setInvite(false)
          // 列表在**关掉之后**才刷新：弹窗还开着时 reload 会让页面进 loading
          // 早退，把这个弹窗连同刚生成的链接一起卸载掉。
          reload()
        }}
        onCreated=${() => {}}
      />
    `}

    ${groupDialog &&
    html`
      <${GroupDialog}
        ctx=${ctx}
        group=${groupDialog.id ? groupDialog : null}
        members=${members}
        onClose=${() => setGroupDialog(null)}
        onSaved=${() => {
          setGroupDialog(null)
          reload()
        }}
      />
    `}

    ${secret && html`<${InviteLink} ...${secret} onClose=${() => setSecret(null)} />`}

    ${confirm &&
    html`
      <${Confirm}
        title=${confirm.title}
        body=${confirm.body}
        confirmLabel=${confirm.label}
        onCancel=${() => setConfirm(null)}
        onConfirm=${() => {
          const job = confirm.run
          setConfirm(null)
          run(job)
        }}
      />
    `}
  `
}

export default {
  name: 'satu-view-accounts',
  inject: ['slots', 'host', 'router', 'auth'],
  apply(ctx) {
    // 普通成员看不到这一屏，连导航项都不出现。这**不是**安全措施——真正的拦截
    // 在服务端（每条路由都 requireAdmin）；这里只是别把一个点进去就 403 的入口
    // 摆在人家眼前。
    const admin = () => ['owner', 'admin'].includes(ctx.auth.state.user?.role)

    ctx.slots.inject(['sidebar.nav.admin', 'main'], function* () {
      yield ctx.slots.register(
        { name: 'sidebar.nav.admin', id: 'accounts.nav', priority: 40 },
        (props) => (admin() ? html`<${AccountsNav} ...${props} />` : null),
      )
      yield ctx.slots.register(
        {
          name: 'main',
          id: 'accounts',
          select: (path) => (path === '/accounts' && admin() ? { title: t('账号管理', 'Accounts') } : null),
        },
        AccountsPage,
      )
    })
  },
}
