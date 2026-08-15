import { html, icon, ICONS, NavItem, useHost, useState, t } from '@satu/shell'

/**
 * 模型配置。
 *
 * 全屏真数据：供应商与模型元数据来自 pi-ai 的目录（40 家），凭据存在本机
 * SQLite，默认模型写回 `/api/settings`，改完下一轮就生效。
 *
 * 稿子上那张「已接入供应商」表在这里的含义是**已配凭据的那些**——目录里 40 家
 * 全列出来没有意义，那是一份能力清单不是接入状态。没配的那些收进「接入供应商」
 * 的选择器里。
 */

const ICON = [
  'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z',
  'M9 9h6v6H9z',
  'M9 3v2',
  'M15 3v2',
  'M9 19v2',
  'M15 19v2',
]

const money = (n) => (n === undefined || n === null ? '—' : n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(3)}`)
const tokens = (n) => (!n ? '—' : n >= 1000000 ? `${(n / 1000000).toFixed(n % 1000000 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`)

function ModelsNav({ ctx, path }) {
  return html`<${NavItem} ctx=${ctx} path=${path} href="/models" icon=${icon(ICON)} label=${t('模型配置', 'Models')} />`
}

/** 供应商首字母块。目录里没有图标，用首字母加两种色调区分，和稿子一致。 */
function Mark({ text, alt }) {
  return html`
    <span
      class="satu-providermark"
      style=${alt
        ? 'background: var(--color-accent-2-100); color: var(--color-accent-2-800);'
        : 'background: var(--color-accent-100); color: var(--color-accent-800);'}
    >${text.slice(0, 2).toUpperCase()}</span>
  `
}

/**
 * 填 / 改一家的 key。
 *
 * 密钥单独一条路由，不跟别的设置混在一个请求里，响应也**不回显**——存进去之后
 * 界面只知道「存了」，不知道存的是什么。这条界线在后端，前端跟着它走。
 */
function KeyDialog({ ctx, provider, onClose, onSaved }) {
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const save = async (value) => {
    setBusy(true)
    setError(null)
    try {
      await ctx.host.put(`/api/credentials/${provider.provider}`, { key: value })
      onSaved()
    } catch (e) {
      setError(e.message)
      setBusy(false)
    }
  }

  return html`
    <div
      style="position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; padding: var(--space-6); background: color-mix(in srgb, var(--color-neutral-900) 42%, transparent);"
      onClick=${(e) => e.target === e.currentTarget && onClose()}
    >
      <div style="width: 100%; max-width: 460px; box-sizing: border-box; background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-4);">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h2 style="font-size: 20px; margin: 0 0 4px;">${t(`接入 ${provider.name}`, `Connect ${provider.name}`)}</h2>
            <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
              ${provider.auth?.apiKey?.name ?? 'API Key'} · 存在本机 <code>~/.satuwork/satuwork.db</code>
            </p>
          </div>
          <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('关闭', 'Close')} onClick=${onClose}>${icon(ICONS.close, 16)}</button>
        </div>

        <div class="field">
          <label for="pv-key">${t('凭据', 'Credential')}</label>
          <input
            class="input"
            id="pv-key"
            type="password"
            autocomplete="off"
            placeholder=${provider.hasKey ? t('留空表示不改动', 'Leave blank to keep') : 'sk-…'}
            value=${key}
            onInput=${(e) => setKey(e.target.value)}
          />
          <span style="font-size: 12px; color: var(--muted-foreground);">
            ${t('存过之后，同名环境变量不再生效；删掉就重新回落到环境变量。', 'Once stored, the matching env var is ignored; delete it to fall back again.')}
          </span>
        </div>

        ${error && html`<div style="font-size: 13px; color: var(--color-accent-700);">${error}</div>`}

        <div style="display: flex; justify-content: space-between; gap: var(--space-2); margin-top: var(--space-2);">
          ${provider.hasKey
            ? html`<button type="button" class="satu-linkbtn" disabled=${busy} onClick=${() => save('')}>${t('删除凭据', 'Delete credential')}</button>`
            : html`<span></span>`}
          <div style="display: flex; gap: var(--space-2);">
            <button type="button" class="btn btn-secondary" onClick=${onClose}>${t('取消', 'Cancel')}</button>
            <button type="button" class="btn btn-primary" disabled=${busy || !key.trim()} onClick=${() => save(key.trim())}>
              ${busy ? t('保存中…', 'Saving…') : t('保存', 'Save')}
            </button>
          </div>
        </div>
      </div>
    </div>
  `
}

/** 从目录里挑一家还没接入的。40 家，所以是搜索而不是罗列。 */
function AddProvider({ list, onPick, onClose }) {
  const [q, setQ] = useState('')
  const hits = list.filter((p) => (p.name + p.provider).toLowerCase().includes(q.trim().toLowerCase()))

  return html`
    <div
      style="position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; padding: var(--space-6); background: color-mix(in srgb, var(--color-neutral-900) 42%, transparent);"
      onClick=${(e) => e.target === e.currentTarget && onClose()}
    >
      <div style="width: 100%; max-width: 460px; max-height: 80vh; box-sizing: border-box; background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-4);">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h2 style="font-size: 20px; margin: 0 0 4px;">${t('接入供应商', 'Add a provider')}</h2>
            <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t(`目录里共 ${list.length} 家待接入，选一家填凭据。`, `${list.length} providers available — pick one and add its credential.`)}</p>
          </div>
          <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('关闭', 'Close')} onClick=${onClose}>${icon(ICONS.close, 16)}</button>
        </div>

        <input class="input" type="search" placeholder=${t('搜索供应商…', 'Search providers…')} value=${q} onInput=${(e) => setQ(e.target.value)} />

        <div style="flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 1px;">
          ${hits.map(
            (p, i) => html`
              <button
                key=${p.provider}
                type="button"
                class="satu-fileitem"
                style="padding: 8px var(--space-2);"
                onClick=${() => onPick(p)}
              >
                <${Mark} text=${p.name} alt=${i % 2 === 1} />
                <span style="min-width: 0; display: flex; flex-direction: column; text-align: left;">
                  <span style="font-size: 13.5px; font-weight: 600;">${p.name}</span>
                  <span style="font-size: 11.5px; color: var(--muted-foreground);">${t(`${p.models.length} 个模型`, `${p.models.length} models`)}</span>
                </span>
              </button>
            `,
          )}
          ${!hits.length && html`<div style="padding: var(--space-4); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('没有匹配的供应商', 'No matching provider')}</div>`}
        </div>
      </div>
    </div>
  `
}

function ModelsPage({ ctx }) {
  const models = useHost(ctx, '/api/models')
  const settings = useHost(ctx, '/api/settings')
  const [dialog, setDialog] = useState(null)
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState(null)

  if (models.loading || settings.loading) return html`<${Notice} text=${t('载入中…', 'Loading…')} />`
  if (models.error || settings.error) return html`<${Notice} text=${(models.error ?? settings.error).message} />`

  const { catalog, configured, available } = models.data
  const current = draft ?? settings.data
  // 「已接入」= 存了 key 或环境变量已就绪。目录里剩下的 30 多家是**可接入**，
  // 不是「已接入但坏了」——这两件事画在一张表里，状态列就没法说清楚。
  const live = catalog
    .map((p) => ({ ...p, hasKey: configured.includes(p.provider), ready: available.includes(p.provider) }))
    .filter((p) => p.hasKey || p.ready)
  const rest = catalog.filter((p) => !live.some((l) => l.provider === p.provider))
  const shown = catalog.find((p) => p.provider === current.provider)

  const setDefault = async (patch) => {
    setDraft({ ...current, ...patch })
    await ctx.host.put('/api/settings', patch)
  }

  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6);">
      <div style="max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-6);">

        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('模型配置', 'Models')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('先接入供应商，再挑一个默认模型。换 provider 是配置，不是改代码。', 'Connect a provider, then pick a default model. Switching providers is configuration, not code.')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" onClick=${() => setAdding(true)}>
            ${icon(ICONS.plus, 15)} ${t('接入供应商', 'Add provider')}
          </button>
        </div>

        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: baseline; justify-content: space-between;">
            <h2 style="font-size: 18px; margin: 0;">${t('已接入供应商', 'Connected providers')}</h2>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t(`目录共 ${catalog.length} 家 · 已接入 ${live.length} 家`, `${live.length} of ${catalog.length} connected`)}</span>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-provhead">
              <span>${t('供应商', 'Provider')}</span><span>${t('状态', 'Status')}</span><span>${t('凭证', 'Credential')}</span><span>${t('模型', 'Models')}</span><span>${t('接入方式', 'Source')}</span><span></span>
            </div>
            ${live.map(
              (p, i) => html`
                <div class="satu-provrow" key=${p.provider}>
                  <div style="min-width: 0; display: flex; align-items: center; gap: var(--space-3);">
                    <${Mark} text=${p.name} alt=${i % 2 === 1} />
                    <div style="min-width: 0;">
                      <div style="font-size: 14px; font-weight: 600;">${p.name}</div>
                      <div style="font-size: 12px; color: var(--muted-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${p.endpoint ?? p.provider}</div>
                    </div>
                  </div>
                  <span class=${`tag ${p.ready ? 'tag-accent-2' : 'tag-neutral'}`}>${p.ready ? t('可用', 'Ready') : t('待校验', 'Unverified')}</span>
                  <span style="font-size: 13px; color: var(--muted-foreground);">${p.hasKey ? t('已存储', 'Stored') : '—'}</span>
                  <span style="font-size: 13px; color: var(--muted-foreground);">${t(`${p.models.length} 个`, String(p.models.length))}</span>
                  <span style="font-size: 13px; color: var(--muted-foreground);">${p.hasKey ? t('本机存储', 'Local store') : t('环境变量', 'Env var')}</span>
                  <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-2); justify-content: flex-end;">
                    <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('编辑凭据', 'Edit credential')} onClick=${() => setDialog(p)}>
                      ${icon(['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'], 15)}
                    </button>
                  </div>
                </div>
              `,
            )}
            ${!live.length &&
            html`<div style="padding: var(--space-6); text-align: center; font-size: 13px; color: var(--muted-foreground);">${t('还没有接入任何供应商——右上角挑一家填 key，或者设同名环境变量。', 'No provider connected yet — add one above, or set the matching environment variable.')}</div>`}
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('默认模型', 'Default model')}</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
            ${t('没有单独指定时，所有会话走这一个。改完下一轮就生效，不用重启。', 'Used by every chat unless overridden. Takes effect on the next turn — no restart.')}
          </p>
          <div class="satu-toggleRow">
            <div style="min-width: 0;">
              <div style="font-size: 13.5px; font-weight: 600;">${t('供应商', 'Provider')}</div>
              <div style="font-size: 12px; color: var(--muted-foreground);">${t('只列已接入的那些', 'Connected ones only')}</div>
            </div>
            <select
              class="input"
              style="width: 250px; flex: none;"
              value=${current.provider}
              onChange=${(e) => {
                const p = catalog.find((x) => x.provider === e.target.value)
                setDefault({ provider: p.provider, model: p.models[0]?.id ?? current.model })
              }}
            >
              ${(live.length ? live : catalog).map((p) => html`<option key=${p.provider} value=${p.provider}>${p.name}</option>`)}
            </select>
          </div>
          <div class="satu-toggleRow">
            <div style="min-width: 0;">
              <div style="font-size: 13.5px; font-weight: 600;">${t('模型', 'Model')}</div>
              <div style="font-size: 12px; color: var(--muted-foreground);">${t(`${shown?.name ?? current.provider} 目录里的全部模型`, `Everything in the ${shown?.name ?? current.provider} catalog`)}</div>
            </div>
            <select class="input" style="width: 250px; flex: none;" value=${current.model} onChange=${(e) => setDefault({ model: e.target.value })}>
              ${(shown?.models ?? []).map((m) => html`<option key=${m.id} value=${m.id}>${m.id}</option>`)}
            </select>
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">
            ${t('按场景分流（对话 / 定时批量 / 文档识别）还没做——那需要在 agent 请求上挂一层路由，不是这一屏能假装的。', 'Per-scenario routing (chat / batch / document) is not built — it needs a router on the agent request, which this screen cannot fake.')}
          </span>
        </div>

        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: baseline; gap: var(--space-3);">
            <h2 style="font-size: 18px; margin: 0;">${t(`${shown?.name ?? ''} 的模型`, `${shown?.name ?? ''} models`)}</h2>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t(`共 ${shown?.models.length ?? 0} 个 · 元数据来自供应商目录`, `${shown?.models.length ?? 0} models · metadata from the provider catalog`)}</span>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-modelhead">
              <span>${t('模型', 'Model')}</span><span>${t('供应商', 'Provider')}</span><span>${t('能力', 'Ability')}</span><span>${t('上下文', 'Context')}</span><span>${t('单价 / 1M tok', 'Price / 1M tok')}</span><span></span>
            </div>
            ${(shown?.models ?? []).map(
              (m) => html`
                <div class="satu-modelrow" key=${m.id}>
                  <div class="satu-tasklink" style="cursor: default;">
                    <span style="font-weight: 600; font-size: 14px;">${m.name}</span>
                    <span style="font-size: 12px; color: var(--muted-foreground);">${m.id}</span>
                  </div>
                  <span style="font-size: 13px;">${shown.name}</span>
                  <span class="tag tag-neutral">${m.reasoning ? t('推理', 'Reasoning') : t('对话', 'Chat')}</span>
                  <span style="font-size: 13px; color: var(--muted-foreground);">${tokens(m.contextWindow)}</span>
                  <span style="font-size: 13px; color: var(--muted-foreground);">${money(m.cost?.input)} / ${money(m.cost?.output)}</span>
                  <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-1); justify-content: flex-end;">
                    ${m.id === current.model
                      ? html`<span class="tag tag-accent">${t('默认', 'Default')}</span>`
                      : html`<button type="button" class="satu-linkbtn" onClick=${() => setDefault({ provider: shown.provider, model: m.id })}>${t('设为默认', 'Make default')}</button>`}
                  </div>
                </div>
              `,
            )}
          </div>
        </div>
      </div>
    </div>

    ${dialog &&
    html`
      <${KeyDialog}
        ctx=${ctx}
        provider=${dialog}
        onClose=${() => setDialog(null)}
        onSaved=${() => {
          setDialog(null)
          models.reload()
        }}
      />
    `}

    ${adding &&
    html`
      <${AddProvider}
        list=${rest}
        onClose=${() => setAdding(false)}
        onPick=${(p) => {
          setAdding(false)
          setDialog({ ...p, hasKey: false })
        }}
      />
    `}
  `
}

function Notice({ text }) {
  return html`<div style="flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted-foreground);">${text}</div>`
}

export default {
  name: 'satu-view-models',
  inject: ['slots', 'host', 'router'],
  apply(ctx) {
    ctx.slots.inject(['sidebar.nav.admin', 'main'], function* () {
      yield ctx.slots.register({ name: 'sidebar.nav.admin', id: 'models.nav', priority: 20 }, ModelsNav)
      yield ctx.slots.register(
        { name: 'main', id: 'models', select: (path) => (path === '/models' ? { title: t('模型配置', 'Models') } : null) },
        ModelsPage,
      )
    })
  },
}
