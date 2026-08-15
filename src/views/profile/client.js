import { Confirm, html, icon, ICONS, locale, setLocale, setTheme, t, theme, useHost, useState } from '@satu/shell'

/**
 * 个人设置。
 *
 * 真的那些：基本资料（写回 `/api/me`）、修改口令（验旧口令、改完其他设备全部
 * 掉线）、登录设备（列的是真会话，注销即刻生效）、外观与语言（本机立刻生效，
 * 并同步到账号）。
 *
 * 不真的那些，都在旁边写了缺什么：通知三项没有投递渠道，渠道配对码没有渠道。
 */

const GEAR = [
  'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.65 1.65 0 0 0 15 19.4a1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
]

const ROLE_LABEL = () => ({
  owner: t('所有者', 'Owner'),
  admin: t('管理员', 'Admin'),
  member: t('成员', 'Member'),
})
const THEMES = () => [
  { key: 'light', label: t('浅色', 'Light'), hint: t('始终使用浅色', 'Always light') },
  { key: 'dark', label: t('深色', 'Dark'), hint: t('始终使用深色', 'Always dark') },
  { key: 'system', label: t('跟随系统', 'System'), hint: t('跟随操作系统设置', 'Follow your OS setting') },
]
const LANGS = [
  { key: 'zh', label: '中文' },
  { key: 'en', label: 'English' },
]

/** 通知偏好。稿子上有这三项，业务还没有——开关能动，但不落库。 */
const NOTICES = () => [
  {
    key: 'digest',
    title: t('每日工作摘要', 'Daily digest'),
    desc: t('每天 09:00 汇总 AI 员工的执行结果发到邮箱', 'A 09:00 roundup of what your AI employees did, by email'),
  },
  {
    key: 'review',
    title: t('待复核提醒', 'Review requests'),
    desc: t('有任务需要人工确认时立即通知我', 'Notify me the moment a task needs human confirmation'),
  },
  {
    key: 'fail',
    title: t('任务失败提醒', 'Failure alerts'),
    desc: t('定时任务执行失败时发送站内通知', 'In-app notice when a scheduled task fails'),
  },
]

const initialOf = (user) => (user?.name ?? user?.email ?? '·').trim().slice(0, 1).toUpperCase()

// 参数不叫 `t`：那个名字已经是取词函数了，在这里遮住它迟早出事。
const day = (ts) =>
  ts
    ? new Date(ts).toLocaleDateString(locale() === 'en' ? 'en-US' : 'zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
    : t('从未修改', 'never')

const when = (ts) => {
  const m = Math.floor((Date.now() - ts) / 60000)
  if (m < 1) return t('刚刚', 'just now')
  if (m < 60) return t(`${m} 分钟前`, `${m} min ago`)
  if (m < 60 * 24) return t(`${Math.floor(m / 60)} 小时前`, `${Math.floor(m / 60)} h ago`)
  return t(`${Math.floor(m / 1440)} 天前`, `${Math.floor(m / 1440)} d ago`)
}

/** User-Agent → 一句人话。认不出来就说认不出来，别猜。 */
function deviceName(agent) {
  if (!agent) return t('未知设备', 'Unknown device')
  const os = /Mac OS X/.test(agent) ? 'macOS' : /Windows/.test(agent) ? 'Windows' : /Android/.test(agent) ? 'Android' : /iPhone|iPad/.test(agent) ? 'iOS' : /Linux/.test(agent) ? 'Linux' : null
  const browser = /Edg\//.test(agent) ? 'Edge' : /Chrome\//.test(agent) ? 'Chrome' : /Safari\//.test(agent) ? 'Safari' : /Firefox\//.test(agent) ? 'Firefox' : null
  if (!os && !browser) return t('未知设备', 'Unknown device')
  return [browser, os].filter(Boolean).join(' · ')
}

function Notice({ text }) {
  return html`<div style="flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted-foreground);">${text}</div>`
}

/** 侧栏底部那一行。当前登录的人来自 `/api/me`，是真的。 */
function ProfileFooter({ ctx, path }) {
  const { data } = useHost(ctx, '/api/me')
  const user = data?.user
  return html`
    <${'div'} style="display: flex; align-items: center; gap: var(--space-2); width: 100%; min-width: 0;">
      <div style="width: 30px; height: 30px; flex: none; border-radius: 999px; background: var(--color-accent-200); display: flex; align-items: center; justify-content: center; font-family: var(--font-heading); font-size: 13px; color: var(--color-accent-800);">
        ${initialOf(user)}
      </div>
      <div class="satu-userinfo" style="line-height: 1.25; min-width: 0; flex: 1;">
        <div style="font-size: 13px; font-weight: 600;">${user?.name ?? '…'}</div>
        <div style="font-size: 11px; color: color-mix(in srgb, var(--color-text) 50%, transparent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${user?.email ?? ''}</div>
      </div>
      <button
        type="button"
        class="btn btn-ghost btn-icon satu-usercog"
        aria-label=${t('个人设置', 'Preferences')}
        aria-pressed=${String(path === '/profile')}
        onClick=${() => ctx.router.go('/profile')}
      >${icon(GEAR, 16)}</button>
    <//>
  `
}

/** 修改口令。要求写的就是服务端检查的那一条，不多写一条它不查的。 */
function PasswordDialog({ ctx, onClose, onDone }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const on = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  const submit = async (e) => {
    e.preventDefault()
    if (form.next !== form.confirm) return setError(t('两次输入的新口令不一致', 'The two new passwords do not match'))
    setBusy(true)
    setError(null)
    try {
      await ctx.host.post('/api/me/password', { current: form.current, next: form.next })
      onDone()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return html`
    <div
      style="position: fixed; inset: 0; z-index: 26; display: flex; align-items: center; justify-content: center; padding: var(--space-6); background: color-mix(in srgb, var(--color-neutral-900) 42%, transparent);"
      onClick=${(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        onSubmit=${submit}
        style="width: 100%; max-width: 420px; max-height: 88vh; overflow-y: auto; box-sizing: border-box; background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-4);"
      >
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h2 style="font-size: 20px; margin: 0 0 4px;">${t('修改口令', 'Change password')}</h2>
            <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('改完之后，其他设备上的登录会立即失效。', 'Every other device is signed out immediately.')}</p>
          </div>
          <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('关闭', 'Close')} onClick=${onClose}>${icon(ICONS.close, 16)}</button>
        </div>

        <div class="field">
          <label for="pw-old">${t('当前口令', 'Current password')}</label>
          <input class="input" id="pw-old" type="password" autocomplete="current-password" required value=${form.current} onInput=${on('current')} />
        </div>
        <div class="field">
          <label for="pw-new">${t('新口令', 'New password')}</label>
          <input class="input" id="pw-new" type="password" autocomplete="new-password" required value=${form.next} onInput=${on('next')} placeholder=${t('至少 10 位', 'At least 10 characters')} />
        </div>
        <div class="field">
          <label for="pw-new2">${t('确认新口令', 'Confirm new password')}</label>
          <input class="input" id="pw-new2" type="password" autocomplete="new-password" required value=${form.confirm} onInput=${on('confirm')} />
        </div>

        <div style="display: flex; flex-direction: column; gap: 5px; padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
          <span class="satu-panel-title">${t('要求', 'Requirements')}</span>
          <div class="satu-step" style="color: var(--muted-foreground);">
            ${icon(['m5 13 4 4L19 7'], 13)} ${t('至少 10 个字符', 'At least 10 characters')}
          </div>
          <div class="satu-step" style="color: var(--muted-foreground);">
            ${icon(['m5 13 4 4L19 7'], 13)} ${t('不能与当前口令相同', 'Different from the current one')}
          </div>
        </div>

        ${error &&
        html`<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${error}</div>`}

        <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
          <button type="button" class="btn btn-secondary" onClick=${onClose}>${t('取消', 'Cancel')}</button>
          <button type="submit" class="btn btn-primary" disabled=${busy}>${busy ? t('保存中…', 'Saving…') : t('保存新口令', 'Save new password')}</button>
        </div>
      </form>
    </div>
  `
}

function ProfilePage({ ctx }) {
  const me = useHost(ctx, '/api/me')
  const sessions = useHost(ctx, '/api/me/sessions')
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState(null)
  const [pwOpen, setPwOpen] = useState(false)
  const [pendingRevoke, setPendingRevoke] = useState(null)
  const [notifyOff, setNotifyOff] = useState([])

  if (me.loading) return html`<${Notice} text=${t('载入中…', 'Loading…')} />`
  if (me.error) return html`<${Notice} text=${me.error.message} />`

  const u = me.data.user
  const form = draft ?? { name: u.name, title: u.title ?? '', phone: u.phone ?? '' }
  const dirty = draft && (form.name !== u.name || form.title !== (u.title ?? '') || form.phone !== (u.phone ?? ''))
  const on = (key) => (e) => {
    setSaved(false)
    setDraft({ ...form, [key]: e.target.value })
  }

  const saveProfile = async () => {
    setSaving(true)
    setError(null)
    try {
      await ctx.host.patch('/api/me', form)
      setDraft(null)
      setSaved(true)
      me.reload()
    } catch (e) {
      setError(e.message)
    }
    setSaving(false)
  }

  /**
   * 外观与语言：**先在本机生效，再往账号上同步**。
   *
   * 顺序是有意的。这两样要立刻看得见，而请求可能慢、可能失败；等服务端回话再切
   * 会有一段说不清的延迟。同步失败也不回滚——本机这份已经是用户要的了，下次登录
   * 从账号读回来的那份不一致，也只是少跟一次。
   */
  const save = (patch) => {
    if (patch.theme) setTheme(patch.theme)
    if (patch.locale) setLocale(patch.locale)
    ctx.host.patch('/api/me', patch).catch((e) => setError(e.message))
  }

  const rows = sessions.data?.sessions ?? []

  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6);">
      <div style="max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-6);">

        <div>
          <h1 style="font-size: 24px; margin: 0 0 4px;">${t('个人设置', 'Preferences')}</h1>
          <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('管理你的账号信息、偏好与安全设置。', 'Manage your account details, preferences, and security.')}</p>
        </div>

        <div style="display: flex; align-items: center; gap: var(--space-4); padding: var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-lg);">
          <div style="width: 56px; height: 56px; flex: none; border-radius: 999px; background: var(--color-accent-200); display: flex; align-items: center; justify-content: center; font-family: var(--font-heading); font-size: 22px; color: var(--color-accent-800);">${initialOf(u)}</div>
          <div style="flex: 1; min-width: 0;">
            <div style="font-size: 16px; font-weight: 600;">${u.name}</div>
            <div style="font-size: 13px; color: var(--muted-foreground);">
              ${u.email} · ${ROLE_LABEL()[u.role] ?? u.role} · ${t('加入于', 'Joined')} ${day(u.createdAt)}
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('基本资料', 'Profile')}</span>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
            <div class="field">
              <label for="pf-name">${t('姓名', 'Name')}</label>
              <input class="input" id="pf-name" type="text" value=${form.name} onInput=${on('name')} />
            </div>
            <div class="field">
              <label for="pf-title">${t('职位', 'Job title')}</label>
              <input class="input" id="pf-title" type="text" value=${form.title} onInput=${on('title')} placeholder=${t('例如：运营负责人', 'e.g. Head of Operations')} />
            </div>
            <div class="field">
              <label for="pf-email">${t('邮箱', 'Email')}</label>
              <input class="input" id="pf-email" type="email" value=${u.email} readonly disabled />
              <span style="font-size: 12px; color: var(--muted-foreground);">${t('邮箱是登录身份，改它要另一套验证流程，暂时不开放。', 'Email is your sign-in identity; changing it needs a verification flow we do not have yet.')}</span>
            </div>
            <div class="field">
              <label for="pf-phone">${t('手机号', 'Phone')}</label>
              <input class="input" id="pf-phone" type="tel" value=${form.phone} onInput=${on('phone')} placeholder=${t('选填', 'Optional')} />
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('渠道配对码', 'Channel pairing code')}</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
            ${t(
              '用来把微信、Telegram 这类渠道里的对话绑到你的账号上。渠道本身还没接入，所以现在没有可配对的东西。',
              'Binds conversations from channels like WeChat or Telegram to your account. No channel is wired up yet, so there is nothing to pair with.',
            )}
          </p>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('偏好', 'Preferences')}</span>
          <div class="field">
            <label>${t('界面外观', 'Appearance')}</label>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-3);">
              ${THEMES().map(
                (item) => html`
                  <button
                    key=${item.key}
                    type="button"
                    class="satu-themecard"
                    aria-pressed=${String(theme() === item.key)}
                    onClick=${() => save({ theme: item.key })}
                  >
                    <span class="satu-themeswatch" data-mode=${item.key}>
                      <span class="satu-themebar"></span>
                      <span class="satu-themebody"></span>
                    </span>
                    <span style="font-size: 13px; font-weight: 600;">${item.label}</span>
                    <span style="font-size: 11.5px; color: var(--muted-foreground); text-align: center;">${item.hint}</span>
                  </button>
                `,
              )}
            </div>
          </div>

          <div class="field">
            <label>${t('界面语言', 'Language')}</label>
            <div style="display: flex; gap: var(--space-2); flex-wrap: wrap;">
              ${LANGS.map(
                (l) => html`
                  <button
                    key=${l.key}
                    type="button"
                    class="satu-assignee"
                    style="padding: 5px 14px;"
                    aria-pressed=${String(locale() === l.key)}
                    onClick=${() => save({ locale: l.key })}
                  >${l.label}</button>
                `,
              )}
            </div>
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">
            ${t('两项都存在这台机器上，并同步到你的账号——换台机器登录会自动跟过去。', 'Both are stored on this machine and synced to your account, so they follow you to another machine.')}
          </span>

          ${NOTICES().map(
            (n) => html`
              <div class="satu-toggleRow" key=${n.key}>
                <div style="min-width: 0;">
                  <div style="font-size: 13.5px; font-weight: 600;">${n.title}</div>
                  <div style="font-size: 12px; color: var(--muted-foreground);">${n.desc}</div>
                </div>
                <button
                  type="button"
                  class="satu-switch"
                  aria-pressed=${String(!notifyOff.includes(n.key))}
                  aria-label=${n.title}
                  onClick=${() => setNotifyOff((l) => (l.includes(n.key) ? l.filter((x) => x !== n.key) : [...l, n.key]))}
                ><span></span></button>
              </div>
            `,
          )}
          <span style="font-size: 12px; color: var(--muted-foreground);">
            ${t(
              '这三项还没有落点：发通知要先有定时任务与通知渠道，两者都还没做。开关是真的，记不住。',
              'These three have nowhere to land yet — notifications need the scheduler and a delivery channel, and neither exists. The switches move, but nothing is stored.',
            )}
          </span>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('安全', 'Security')}</span>
          <div class="satu-toggleRow">
            <div>
              <div style="font-size: 13.5px; font-weight: 600;">${t('登录口令', 'Password')}</div>
              <div style="font-size: 12px; color: var(--muted-foreground);">${t('上次修改于', 'Last changed')} ${day(u.passwordChangedAt ?? u.createdAt)}</div>
            </div>
            <button type="button" class="btn btn-secondary" style="flex: none;" onClick=${() => setPwOpen(true)}>${t('修改口令', 'Change password')}</button>
          </div>
        </div>

        <div class="satu-panel">
          <div style="display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-3);">
            <span class="satu-panel-title">${t('登录设备', 'Signed-in devices')}</span>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t(`共 ${rows.length} 个会话`, `${rows.length} session(s)`)}</span>
          </div>
          ${rows.map(
            (s) => html`
              <div class="satu-toggleRow" key=${s.id}>
                <div style="min-width: 0;">
                  <div style="font-size: 13.5px; font-weight: 600;">${deviceName(s.agent)}${s.current ? t(' · 当前设备', ' · this device') : ''}</div>
                  <div style="font-size: 12px; color: var(--muted-foreground);">${t('登录于', 'Signed in')} ${when(s.createdAt)}</div>
                </div>
                ${s.current
                  ? html`<span class="tag tag-accent-2" style="flex: none;">${t('使用中', 'Active')}</span>`
                  : html`<button type="button" class="satu-linkbtn" style="flex: none;" onClick=${() => setPendingRevoke(s)}>${t('注销', 'Sign out')}</button>`}
              </div>
            `,
          )}
          ${!rows.length && html`<span style="font-size: 13px; color: var(--muted-foreground);">${t('载入中…', 'Loading…')}</span>`}
        </div>

        ${error &&
        html`<div style="font-size: 13px; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-md); padding: 10px var(--space-4);">${error}</div>`}

        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4);">
          <button type="button" class="satu-linkbtn" style="text-align: left;" onClick=${() => ctx.auth.logout()}>${t('退出登录', 'Sign out')}</button>
          <div style="display: flex; align-items: center; gap: var(--space-3);">
            ${saved && html`<span style="font-size: 12.5px; color: var(--muted-foreground);">${t('已保存', 'Saved')}</span>`}
            <button type="button" class="btn btn-secondary" disabled=${!dirty} onClick=${() => setDraft(null)}>${t('取消', 'Cancel')}</button>
            <button type="button" class="btn btn-primary" disabled=${!dirty || saving} onClick=${saveProfile}>${saving ? t('保存中…', 'Saving…') : t('保存更改', 'Save changes')}</button>
          </div>
        </div>
      </div>
    </div>

    ${pwOpen &&
    html`
      <${PasswordDialog}
        ctx=${ctx}
        onClose=${() => setPwOpen(false)}
        onDone=${() => {
          setPwOpen(false)
          setSaved(true)
          me.reload()
          sessions.reload()
        }}
      />
    `}

    ${pendingRevoke &&
    html`
      <${Confirm}
        title=${t('注销这个会话？', 'Sign out this session?')}
        body=${t(
          `「${deviceName(pendingRevoke.agent)}」上的登录会立即失效，需要重新登录。`,
          `The session on ${deviceName(pendingRevoke.agent)} ends immediately and will need to sign in again.`,
        )}
        confirmLabel=${t('注销', 'Sign out')}
        onCancel=${() => setPendingRevoke(null)}
        onConfirm=${async () => {
          const id = pendingRevoke.id
          setPendingRevoke(null)
          await ctx.host.delete(`/api/me/sessions/${id}`)
          sessions.reload()
        }}
      />
    `}
  `
}

export default {
  name: 'satu-view-profile',
  inject: ['slots', 'host', 'router', 'auth'],
  apply(ctx) {
    ctx.slots.inject(['sidebar.footer'], function* () {
      yield ctx.slots.register({ name: 'sidebar.footer', id: 'profile.footer' }, ProfileFooter)
    })
    ctx.slots.inject(['main'], function* () {
      yield ctx.slots.register(
        { name: 'main', id: 'profile', select: (path) => (path === '/profile' ? { title: t('个人设置', 'Preferences') } : null) },
        ProfilePage,
      )
    })
  },
}
