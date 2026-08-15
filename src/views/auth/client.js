import { Service } from '@deepseek-ai/cordis'
import { html, icon, ICONS, locale, setLocale, setTheme, t, theme, useEffect, useReducer, useState } from '@satu/shell'

/**
 * 登录 / 初始化。
 *
 * 一个页面两种形态：库里一个用户都没有时它是**创建管理员**，否则是登录。判断在
 * 服务端（`/api/auth/state` 的 `needsSetup`），前端只是照着画——否则「能不能创建
 * 第一个管理员」这件事就有两个答案了。
 *
 * 它认领的是 `root`，所以未登录时主界面**根本没渲染**：没有藏起来的侧栏，也不会
 * 有哪个组件在背后偷偷打接口。
 */

// ── 状态 ───────────────────────────────────────────────────────────────────
class Auth extends Service {
  constructor(ctx) {
    super(ctx, 'auth')
    this.state = { loading: true, needsSetup: false, user: null }
    this.listeners = new Set()
    this.refresh()

    // 任何一条请求撞上 401，就说明会话没了（过期、被登出、服务端重置）。
    // 与其让每屏各自处理，不如在这里统一收：状态一变，root 上的链式选择自然
    // 把登录页请回来。
    ctx.on('host/unauthorized', () => {
      if (this.state.user) this.set({ user: null })
    })
  }

  async refresh() {
    try {
      const data = await this.ctx.host.get('/api/auth/state')
      this.set({ loading: false, needsSetup: data.needsSetup, user: data.user })
    } catch (e) {
      this.set({ loading: false, error: e.message })
    }
  }

  async login(email, password) {
    const { user } = await this.ctx.host.post('/api/auth/login', { email, password })
    this.enter(user)
  }

  async setup(input) {
    const { user } = await this.ctx.host.post('/api/auth/setup', input)
    this.enter(user)
  }

  /**
   * 进门之后统一做三件事。
   *
   * 落到新建对话那一屏，是因为登录前停在哪儿是**上一次会话**的事：可能是被 401
   * 弹回来的 `/accounts`，也可能是随手输的深链接。登录后回到那里既不安全（他现在
   * 未必还有权限）也不自然。
   */
  enter(user) {
    // 账号上存的偏好覆盖本机的——「换台机器能跟过去」就是这一行的意思。
    if (user.theme && user.theme !== theme()) setTheme(user.theme)
    if (user.locale && user.locale !== locale()) setLocale(user.locale)
    this.set({ user, needsSetup: false })
    this.ctx.router.go('/')
  }

  async logout() {
    await this.ctx.host.post('/api/auth/logout')
    this.set({ user: null })
  }

  set(patch) {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
    // root 的归属跟着登录状态变，所以状态一动就得让 root 重新选一次。
    this.ctx.slots.bump()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function useAuth(auth) {
  const [, force] = useReducer((n) => n + 1, 0)
  useEffect(() => {
    const off = auth.subscribe(force)
    force()
    return off
  }, [auth])
  return auth.state
}

// ── 文案 ───────────────────────────────────────────────────────────────────
const COPY = () => ({
  login: {
    title: t('登录 Satuwork', 'Sign in to Satuwork'),
    subtitle: t('进入控制台，管理你的 AI 员工', 'Enter the console to manage your AI employees'),
    submit: t('登录', 'Sign in'),
    busy: t('登录中…', 'Signing in…'),
    foot: t('还没有账号？联系管理员开通。', 'No account yet? Ask your admin to create one.'),
  },
  setup: {
    title: t('创建管理员', 'Create an admin'),
    subtitle: t('这台实例还没有任何账号，第一个账号就是所有者', 'This instance has no accounts yet — the first one becomes the owner'),
    submit: t('创建并进入', 'Create and continue'),
    busy: t('创建中…', 'Creating…'),
    foot: t('创建之后，其他成员由你在「账号管理」里邀请。', 'After this, you invite the rest from Accounts.'),
  },
})

/**
 * 登录 / 初始化 / 接受邀请共用的两栏骨架。
 *
 * 对访客来说这是同一道门的三种进法，所以左半边（品牌、图、宣传语）只写一次。
 */
function Shell({ children }) {
  return html`
    <div style="min-height: 100vh; display: grid; grid-template-columns: 1fr 1fr; background: var(--color-bg); font-family: var(--font-body); color: var(--color-text);">

      <div class="satu-authside" style="position: relative; padding: var(--space-8); display: flex; flex-direction: column; justify-content: space-between; background: var(--color-surface); overflow: hidden;">
        <div style="position: absolute; top: -60px; right: -60px; width: 220px; height: 220px; border-radius: 50%; background: var(--color-accent-2-200); opacity: 0.6;"></div>
        <div style="position: relative; display: flex; align-items: center; gap: var(--space-2);">
          <img src="/assets/satuwork-logo.png" alt="Satuwork" style="width: 34px; height: 34px; border-radius: 999px;" />
          <span style="font-family: var(--font-heading); font-size: 20px;">Satuwork</span>
        </div>

        <div style="position: relative; display: flex; flex-direction: column; gap: var(--space-4); max-width: 440px;">
          <div style="width: 100%; aspect-ratio: 4/3; border-radius: var(--radius-lg); overflow: hidden; box-shadow: var(--shadow-lg);">
            <img src="/assets/login-hero.png" alt="" style="width: 100%; height: 100%; object-fit: cover;" />
          </div>
          <p style="font-family: var(--font-heading); font-size: 26px; line-height: 1.2; margin: 0;">
            ${t('你的云端 AI 员工，随时待命。', 'Your cloud AI employees, always on duty.')}
          </p>
          <p style="margin: 0; color: color-mix(in srgb, var(--color-text) 65%, transparent); font-size: 14px; line-height: 1.6;">
            ${t(
              'Satuwork 部署可执行任务的 AI Agent，接入团队工作流，7x24 小时处理重复工作。',
              'Satuwork deploys task-executing AI agents into your team workflow, handling repetitive work around the clock.',
            )}
          </p>
        </div>

        <div style="position: relative; display: flex; gap: var(--space-4); font-size: 12px; color: color-mix(in srgb, var(--color-text) 55%, transparent);">
          <span>© 2026 Satuwork</span>
          <span>${t('隐私政策', 'Privacy')}</span>
          <span>${t('服务条款', 'Terms')}</span>
        </div>
      </div>
      <div style="position: relative; display: flex; align-items: center; justify-content: center; padding: var(--space-8);">
        <div style="width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: var(--space-6);">
          ${children}
        </div>
      </div>
    </div>
  `
}

// ── 接受邀请 ───────────────────────────────────────────────────────────────
/**
 * `/join/<token>`。
 *
 * 它和登录页共用同一块布局（左边宣传、右边表单），因为对访客来说这就是同一道门
 * 的两种进法。三种状态照稿子：可用、已加入、已失效。
 */
function JoinPage({ ctx, auth, token }) {
  const [invite, setInvite] = useState({ loading: true })
  const [form, setForm] = useState({ password: '', confirm: '' })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    ctx.host
      .get(`/api/invites/${token}`)
      .then((data) => live && setInvite({ ...data, loading: false, name: data.name }))
      .catch((e) => live && setInvite({ valid: false, loading: false, error: e.message }))
    return () => {
      live = false
    }
  }, [ctx, token])

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    if (form.password !== form.confirm) return setError(t('两次输入的口令不一致', 'The two passwords do not match'))
    setBusy(true)
    try {
      // 名字不再问一遍：管理员建号时已经填过，它就显示在上面那张卡里。
      const { user } = await ctx.host.post(`/api/invites/${token}/accept`, { password: form.password })
      // 接受即登录，服务端已经把会话种好了——直接进门，不必再走一次登录页。
      auth.enter(user)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  if (invite.loading) return html`<${Shell}><${Booting} /><//>`

  if (!invite.valid) {
    return html`
      <${Shell}>
        <div style="display: flex; flex-direction: column; gap: var(--space-4); align-items: flex-start;">
          <span class="tag tag-accent">${t('邀请已失效', 'Invite expired')}</span>
          <h1 style="font-size: 28px; margin: 0;">${t('这条邀请链接不可用', 'This invite link no longer works')}</h1>
          <p style="margin: 0; color: var(--muted-foreground); font-size: 14px; line-height: 1.6;">
            ${t('链接可能已过期、已被使用，或管理员重新生成了新的邀请。请联系邀请你的人重新发一条。', 'It may have expired, been used already, or been replaced by a newer one. Ask whoever invited you for a fresh link.')}
          </p>
          <button type="button" class="btn btn-secondary" onClick=${() => ctx.router.go('/')}>${t('返回登录', 'Back to sign in')}</button>
        </div>
      <//>
    `
  }

  return html`
    <${Shell}>
      <div style="display: flex; flex-direction: column; gap: var(--space-6);">
        <div>
          <span class="tag tag-accent-2">${t('邀请有效', 'Invite valid')}</span>
          <h1 style="font-size: 28px; margin: var(--space-3) 0 var(--space-2);">${t('设置登录口令', 'Set your password')}</h1>
          <p style="margin: 0; color: var(--muted-foreground); font-size: 14px;">
            ${t('你的账号信息已由管理员填好，设置口令即可加入。', 'Your account is already set up — choose a password to join.')}
          </p>
        </div>

        <form style="display: flex; flex-direction: column; gap: var(--space-4);" onSubmit=${submit}>
          <div style="display: flex; align-items: center; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
            <span style="width: 36px; height: 36px; flex: none; border-radius: 999px; background: var(--color-accent-200); color: var(--color-accent-800); display: flex; align-items: center; justify-content: center; font-family: var(--font-heading); font-size: 15px;">
              ${(invite.name ?? invite.email).slice(0, 1).toUpperCase()}
            </span>
            <div style="min-width: 0;">
              <div style="font-size: 14px; font-weight: 600;">${invite.name}</div>
              <div style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${invite.email}</div>
            </div>
          </div>

          <${Field}
            id="jn-pw"
            label=${t('设置口令', 'Password')}
            type="password"
            value=${form.password}
            onInput=${(e) => setForm({ ...form, password: e.target.value })}
            placeholder=${t('至少 10 位', 'At least 10 characters')}
            autocomplete="new-password"
          />
          <${Field}
            id="jn-pw2"
            label=${t('确认口令', 'Confirm password')}
            type="password"
            value=${form.confirm}
            onInput=${(e) => setForm({ ...form, confirm: e.target.value })}
            placeholder=${t('再输一次', 'Repeat it')}
            autocomplete="new-password"
          />

          ${error &&
          html`<div style="font-size: 13px; line-height: 1.6; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">${error}</div>`}

          <button type="submit" class="btn btn-primary btn-block" disabled=${busy}>
            ${busy ? t('加入中…', 'Joining…') : t('加入 Satuwork', 'Join Satuwork')} ${!busy && icon(ICONS.arrowRight, 14)}
          </button>
        </form>

        <p style="text-align: center; margin: 0; font-size: 14px; color: color-mix(in srgb, var(--color-text) 60%, transparent);">
          ${t('已经有账号？', 'Already have an account?')}
          <button type="button" class="satu-linkbtn" onClick=${() => ctx.router.go('/')}>${t('直接登录', 'Sign in')}</button>
        </p>
      </div>
    <//>
  `
}

// ── 界面 ───────────────────────────────────────────────────────────────────
function Field({ id, label, type, value, onInput, placeholder, autocomplete, hint, right }) {
  return html`
    <div class="field">
      <div style="display: flex; justify-content: space-between; align-items: baseline;">
        <label for=${id} style="margin: 0;">${label}</label>
        ${right}
      </div>
      <input
        class="input satu-input"
        id=${id}
        type=${type}
        value=${value}
        placeholder=${placeholder}
        autocomplete=${autocomplete}
        onInput=${onInput}
        required
      />
      ${hint && html`<span style="font-size: 12px; color: var(--muted-foreground);">${hint}</span>`}
    </div>
  `
}

function AuthPage({ ctx, auth }) {
  const state = useAuth(auth)
  const [form, setForm] = useState({ email: '', name: '', password: '', confirm: '' })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)

  const setup = state.needsSetup
  // 局部不叫 t：那个名字是取词函数，遮住它之后这一屏就没法翻译了。
  const copy = setup ? COPY().setup : COPY().login
  const on = (key) => (e) => setForm({ ...form, [key]: e.target.value })

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    if (setup && form.password !== form.confirm) return setError(t('两次输入的口令不一致', 'The two passwords do not match'))
    setBusy(true)
    try {
      if (setup) await auth.setup({ email: form.email, name: form.name, password: form.password })
      else await auth.login(form.email, form.password)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return html`
    <${Shell}>
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
            <div>
              <h1 style="font-size: 30px; margin: 0 0 var(--space-2);">${copy.title}</h1>
              <p style="margin: 0; color: color-mix(in srgb, var(--color-text) 60%, transparent); font-size: 14px;">${copy.subtitle}</p>
            </div>
            <div class="satu-lang" style="flex: none;">
              ${[
                { key: 'zh', label: '中文' },
                { key: 'en', label: 'EN' },
              ].map(
                (l) => html`
                  <button key=${l.key} type="button" aria-pressed=${String(locale() === l.key)} onClick=${() => setLocale(l.key)}>${l.label}</button>
                `,
              )}
            </div>
          </div>

          <form style="display: flex; flex-direction: column; gap: var(--space-4);" onSubmit=${submit}>
            ${setup &&
            html`
              <${Field}
                id="auth-name"
                label=${t('你的名字', 'Your name')}
                type="text"
                value=${form.name}
                onInput=${on('name')}
                placeholder=${t('张三', 'Jane Doe')}
                autocomplete="name"
              />
            `}

            <${Field}
              id="auth-email"
              label=${t('邮箱', 'Email')}
              type="email"
              value=${form.email}
              onInput=${on('email')}
              placeholder="you@company.com"
              autocomplete=${setup ? 'email' : 'username'}
            />

            <${Field}
              id="auth-pw"
              label=${t('口令', 'Password')}
              type="password"
              value=${form.password}
              onInput=${on('password')}
              placeholder=${setup ? t('至少 10 位', 'At least 10 characters') : t('输入口令', 'Enter your password')}
              autocomplete=${setup ? 'new-password' : 'current-password'}
              hint=${setup ? t('存的是 scrypt 派生值，忘了只能从服务器上重置。', 'Stored as a scrypt digest — if you forget it, it can only be reset on the server.') : null}
              right=${!setup &&
              html`<span style="font-size: 12px; color: var(--muted-foreground);">${t('忘记口令？联系管理员', 'Forgot it? Ask your admin')}</span>`}
            />

            ${setup &&
            html`
              <${Field}
                id="auth-confirm"
                label=${t('再输一次', 'Confirm password')}
                type="password"
                value=${form.confirm}
                onInput=${on('confirm')}
                placeholder=${t('确认口令', 'Repeat the password')}
                autocomplete="new-password"
              />
            `}

            ${error &&
            html`
              <div style="font-size: 13px; line-height: 1.6; color: var(--color-accent-800); background: var(--color-accent-100); border-radius: var(--radius-sm); padding: 10px var(--space-3);">
                ${error}
              </div>
            `}

            <button type="submit" class="btn btn-primary btn-block" disabled=${busy}>
              ${busy ? copy.busy : copy.submit} ${!busy && icon(ICONS.arrowRight, 14)}
            </button>
          </form>

          <p style="text-align: center; margin: 0; font-size: 14px; color: color-mix(in srgb, var(--color-text) 60%, transparent);">
            ${copy.foot}
          </p>
    <//>
  `
}

/** 状态还没问回来时不要闪一下登录页——那一下会让人以为自己被登出了。 */
function Booting() {
  return html`
    <div style="min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--color-bg); color: var(--muted-foreground); font-family: var(--font-body);">
      ${t('载入中…', 'Loading…')}
    </div>
  `
}

export default {
  name: 'satu-auth',
  inject: ['slots', 'host', 'router'],
  apply(ctx) {
    // 直接拿实例，不通过 `ctx.auth` 回读：cordis 要求读服务前先 `inject`，而自己
    // 提供的服务没法 inject 自己（那是一个等不到的依赖）。构造函数里的
    // `super(ctx, 'auth')` 已经把它注册进去了，随插件卸载而撤销。
    const auth = new Auth(ctx)

    ctx.slots.inject(['root'], function* () {
      yield ctx.slots.register(
        {
          name: 'root',
          id: 'auth',
          // 优先级比布局高（数字小）：没登录时它先认领整块屏幕。
          priority: 0,
          select: (ctx) => {
            // 邀请链接**不看登录状态**：点进来的人多半还没有账号，而已登录的人
            // 点到它也该看到「这条邀请给谁」，而不是被静默丢回工作台。
            const path = ctx.router.path
            if (path.startsWith('/join/')) return { join: path.slice('/join/'.length) }
            if (auth.state.loading) return { booting: true }
            return auth.state.user ? null : {}
          },
        },
        ({ matched, ctx }) =>
          matched.join
            ? html`<${JoinPage} ctx=${ctx} auth=${auth} token=${matched.join} />`
            : matched.booting
              ? html`<${Booting} />`
              : html`<${AuthPage} ctx=${ctx} auth=${auth} />`,
      )
    })
  },
}
