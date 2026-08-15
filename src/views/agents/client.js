import { agentIcon, Confirm, html, icon, ICONS, NavItem, useHost, useState, t } from '@satu/shell'

/**
 * Agent 配置：列表与详情。
 *
 * 详情页是这套产品里**信息密度最高**的一屏——人设、行为边界、能力、记忆、可访问
 * 范围五段。稿子把它们切成五张 panel，这里照搬：每段自己成立，不需要读上一段才
 * 看得懂这一段。
 */

const ICON = ['M3 8h18a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z', 'M12 4v4', 'M8 14h.01', 'M16 14h.01']

function AgentsNav({ ctx, path }) {
  return html`<${NavItem} ctx=${ctx} path=${path} href="/agents" icon=${icon(ICON)} label=${t('Agent 配置', 'Agents')} />`
}

function Notice({ text }) {
  return html`<div style="flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted-foreground);">${text}</div>`
}

/** 一组多选按钮。可用 Skill、MCP、分组、知识库、记忆类型全是这个形状。 */
function Picks({ options, selected, onToggle, hint }) {
  return html`
    <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
      ${options.map(
        (o) => html`
          <button
            key=${o}
            type="button"
            class="satu-assignee"
            style="padding: 5px 12px;"
            aria-pressed=${String(selected.includes(o))}
            onClick=${() => onToggle(o)}
          >${o}</button>
        `,
      )}
      ${!options.length && html`<span style="font-size: 12px; color: var(--muted-foreground);">${hint ?? t('没有可选项', 'Nothing to choose from')}</span>`}
    </div>
  `
}

function Toggle({ title, desc, on, onToggle }) {
  return html`
    <div class="satu-toggleRow">
      <div style="min-width: 0;">
        <div style="font-size: 13.5px; font-weight: 600;">${title}</div>
        <div style="font-size: 12px; color: var(--muted-foreground);">${desc}</div>
      </div>
      <button type="button" class="satu-switch" aria-pressed=${String(on)} aria-label=${title} onClick=${onToggle}><span></span></button>
    </div>
  `
}

// ── 列表 ───────────────────────────────────────────────────────────────────
function AgentsPage({ ctx }) {
  const { data, error, loading, reload } = useHost(ctx, '/api/agents')
  const [flipped, setFlipped] = useState([])

  if (loading) return html`<${Notice} text=${t('载入中…', 'Loading…')} />`
  if (error) return html`<${Notice} text=${error.message} />`

  const enabledOf = (a) => (flipped.includes(a.id) ? !a.enabled : a.enabled)

  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6);">
      <div style="max-width: 980px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-6);">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('Agent 配置', 'Agents')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('管理 AI 员工的人设、能力与可访问范围。', 'Manage each AI employee\'s persona, capabilities, and reach.')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" disabled title=${t('Agent 注册表还没做', 'The agent registry is not built yet')}>
            ${icon(ICONS.plus, 15)} ${t('新建 Agent', 'New agent')}
          </button>
        </div>

        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-agenthead">
            <span>Agent</span><span>${t('状态', 'Status')}</span><span>Skill</span><span>MCP</span><span>${t('本月执行', 'Runs this month')}</span><span></span>
          </div>
          ${data.agents.map(
            (a) => html`
              <div class="satu-agentrow" key=${a.id}>
                <button type="button" class="satu-tasklink" onClick=${() => ctx.router.go(`/agents/${a.id}`)}>
                  <span style="display: flex; align-items: center; gap: var(--space-3); min-width: 0;">
                    <span class="satu-providermark" style="width: 34px; height: 34px; background: var(--color-accent-200); color: var(--color-accent-800);">${agentIcon(a.icon)}</span>
                    <span style="min-width: 0; display: flex; flex-direction: column; gap: 1px; text-align: left;">
                      <span style="font-size: 14px; font-weight: 600;">${a.name}</span>
                      <span style="font-size: 12px; color: var(--muted-foreground);">${a.role}</span>
                    </span>
                  </span>
                </button>
                <span class=${`tag ${enabledOf(a) ? 'tag-accent-2' : 'tag-neutral'}`}>${enabledOf(a) ? t('已上线', 'Live') : t('未上线', 'Offline')}</span>
                <span style="font-size: 13px; color: var(--muted-foreground);">${a.skillCount}</span>
                <span style="font-size: 13px; color: var(--muted-foreground);">${a.mcpCount}</span>
                <span style="font-size: 13px; color: var(--muted-foreground);">${a.usage}</span>
                <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-2); justify-content: flex-end;">
                  <button
                    type="button"
                    class="satu-switch"
                    aria-pressed=${String(enabledOf(a))}
                    aria-label=${t('上线', 'Live')}
                    onClick=${() => setFlipped((l) => (l.includes(a.id) ? l.filter((x) => x !== a.id) : [...l, a.id]))}
                  ><span></span></button>
                  <button type="button" class="satu-linkbtn" onClick=${() => ctx.router.go(`/agents/${a.id}`)}>${t('配置', 'Configure')}</button>
                </div>
              </div>
            `,
          )}
        </div>
      </div>
    </div>
  `
}

// ── 详情 ───────────────────────────────────────────────────────────────────
const MEMORY_SCOPES = ['仅本人', '所属分组', '全公司']
const MEMORY_KINDS = ['偏好', '事实', '流程', '联系人']
const TTLS = ['30 天', '90 天', '180 天', '永久保留']

function AgentDetailPage({ ctx, matched }) {
  const { data, error, loading } = useHost(ctx, `/api/agents/${matched.id}`)
  const options = useHost(ctx, '/api/agents/options')
  const [draft, setDraft] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(false)

  if (loading || options.loading) return html`<${Notice} text=${t('载入中…', 'Loading…')} />`
  if (error) return html`<${Notice} text=${error.message} />`

  // 编辑全部停在本地：写入要等 satu-agent-registry，假装保存成功比按钮点不动更糟。
  const a = draft ?? { ...data.agent, guards: data.guards, memories: data.memories, memoryOn: true, scope: '所属分组', kinds: ['偏好', '事实'], ttl: '90 天', cap: 20, confirmOn: true, piiOn: true }
  const set = (patch) => setDraft({ ...a, ...patch })
  const toggleIn = (key, value) => set({ [key]: a[key].includes(value) ? a[key].filter((x) => x !== value) : [...a[key], value] })

  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6);">
      <div style="max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-4);">

        <div class="satu-panel">
          <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); flex-wrap: wrap;">
            <div style="display: flex; align-items: center; gap: var(--space-3); min-width: 0;">
              <span class="satu-providermark" style="width: 42px; height: 42px; background: var(--color-accent-200); color: var(--color-accent-800);">${agentIcon(a.icon, 20)}</span>
              <div style="min-width: 0;">
                <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
                  <span style="font-family: var(--font-heading); font-size: 18px;">${a.name}</span>
                  <span class=${`tag ${a.enabled ? 'tag-accent-2' : 'tag-neutral'}`}>${a.enabled ? t('已上线', 'Live') : t('未上线', 'Offline')}</span>
                </div>
                <div style="font-size: 12.5px; color: var(--muted-foreground);">${a.role} · ${t(`本月执行 ${a.usage}`, `${a.usage} runs this month`)} · ${a.model}</div>
              </div>
            </div>
            <div style="display: flex; align-items: center; gap: var(--space-2); flex: none;">
              <button type="button" class="satu-switch" aria-pressed=${String(a.enabled)} aria-label=${t('上线', 'Live')} onClick=${() => set({ enabled: !a.enabled })}><span></span></button>
              <button type="button" class="btn btn-secondary" disabled title=${t('Agent 注册表还没做', 'The agent registry is not built yet')}>${t('编辑基本信息', 'Edit basics')}</button>
            </div>
          </div>
        </div>

        <div class="satu-panel">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
            <span class="satu-panel-title" style="text-transform: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; letter-spacing: 0;">soul.md</span>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t(`${a.prompt.length} 字 · 每轮随上下文注入`, `${a.prompt.length} chars · injected every turn`)}</span>
          </div>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('这份文件定义 Agent 的身份、语气与工作原则，每次对话都会随上下文一起注入。', 'This file defines the agent\'s identity, tone, and working rules. It is injected with every conversation.')}</p>
          <textarea class="input satu-code" rows="12" value=${a.prompt} onInput=${(e) => set({ prompt: e.target.value })}></textarea>
          <div class="field">
            <label for="ag-greeting">${t('开场问候', 'Greeting')}</label>
            <input class="input" id="ag-greeting" type="text" value=${a.greeting} onInput=${(e) => set({ greeting: e.target.value })} />
          </div>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('行为边界', 'Guardrails')}</span>
          ${a.guards.map(
            (g) => html`
              <${Toggle}
                key=${g.id}
                title=${g.title}
                desc=${g.desc}
                on=${g.on}
                onToggle=${() => set({ guards: a.guards.map((x) => (x.id === g.id ? { ...x, on: !x.on } : x)) })}
              />
            `,
          )}
          <div class="field">
            <label for="ag-escalate">${t('升级人工的条件', 'Escalate to a human when')}</label>
            <input class="input" id="ag-escalate" type="text" value="连续 2 次无法解决，或用户明确要求人工" />
          </div>
          <span style="font-size: 12px; color: var(--muted-foreground);">
            ${t('这几条最终落在工具执行前的拦截上（tools/pre-execute），不是提示词里的一句话——现在还没接。', 'These land on the pre-execute hook, not a line in the prompt — not wired up yet.')}
          </span>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('可用 Skill', 'Available skills')}</span>
          <${Picks} options=${options.data.skills} selected=${a.skills} onToggle=${(v) => toggleIn('skills', v)} />
          <span class="satu-panel-title" style="margin-top: var(--space-2);">${t('可用 MCP 服务器', 'Available MCP servers')}</span>
          <${Picks} options=${options.data.mcps} selected=${a.mcps} onToggle=${(v) => toggleIn('mcps', v)} />
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('未勾选的能力，Agent 在任务中不可调用。', 'Anything unchecked cannot be called during a task.')}</span>
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('记忆', 'Memory')}</span>
          <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t('决定这个 Agent 能记住什么、记多久，以及记忆如何参与后续对话。', 'What this agent remembers, for how long, and how it feeds later conversations.')}</p>

          <${Toggle}
            title=${t('启用长期记忆', 'Long-term memory')}
            desc=${t('关闭后每次对话都从空白上下文开始', 'Off means every conversation starts blank')}
            on=${a.memoryOn}
            onToggle=${() => set({ memoryOn: !a.memoryOn })}
          />

          ${a.memoryOn &&
          html`
            <div style="display: flex; flex-direction: column; gap: var(--space-4);">
              <div class="field">
                <label>${t('记忆范围', 'Memory scope')}</label>
                <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
                  ${MEMORY_SCOPES.map(
                    (s) => html`
                      <button key=${s} type="button" class="satu-assignee" style="padding: 5px 14px;" aria-pressed=${String(a.scope === s)} onClick=${() => set({ scope: s })}>${s}</button>
                    `,
                  )}
                </div>
              </div>

              <div class="field">
                <label>${t('记录哪些内容', 'What to remember')}</label>
                <${Picks} options=${MEMORY_KINDS} selected=${a.kinds} onToggle=${(v) => toggleIn('kinds', v)} />
              </div>

              <div class="satu-agentpair">
                <div class="field">
                  <label for="ag-ttl">${t('保留时长', 'Retention')}</label>
                  <select class="input" id="ag-ttl" value=${a.ttl} onChange=${(e) => set({ ttl: e.target.value })}>
                    ${TTLS.map((t) => html`<option key=${t} value=${t}>${t}</option>`)}
                  </select>
                </div>
                <div class="field">
                  <label for="ag-cap">${t(`注入上限 · ${a.cap} 条`, `Injection cap · ${a.cap} items`)}</label>
                  <input
                    class="input"
                    id="ag-cap"
                    type="range"
                    min="5"
                    max="50"
                    step="5"
                    value=${a.cap}
                    onInput=${(e) => set({ cap: Number(e.target.value) })}
                    style="padding: 0; border: 0; background: transparent; accent-color: var(--color-accent);"
                  />
                  <span style="font-size: 12px; color: var(--muted-foreground);">${t('每次对话最多注入的记忆条数', 'Most memories injected into one conversation')}</span>
                </div>
              </div>

              <${Toggle} title=${t('写入前需用户确认', 'Confirm before writing')} desc=${t('Agent 提议记住某条信息时先征求同意', 'Ask before the agent stores something')} on=${a.confirmOn} onToggle=${() => set({ confirmOn: !a.confirmOn })} />
              <${Toggle} title=${t('不记录敏感信息', 'Skip sensitive data')} desc=${t('手机号、证件号、银行卡等自动跳过', 'Phone numbers, IDs, and card numbers are skipped')} on=${a.piiOn} onToggle=${() => set({ piiOn: !a.piiOn })} />

              <div style="display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
                <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);">
                  <span style="font-size: 13.5px; font-weight: 600;">${t('已存记忆', 'Stored memories')}</span>
                  <span style="font-size: 12px; color: var(--muted-foreground);">${t(`${a.memories.length} 条`, `${a.memories.length} items`)}</span>
                </div>
                ${a.memories.map(
                  (m) => html`
                    <div key=${m.id} style="display: flex; align-items: flex-start; gap: var(--space-3); padding: 6px 0; border-top: 1px solid var(--border);">
                      <span class="tag tag-neutral" style="flex: none;">${m.kind}</span>
                      <span style="flex: 1; min-width: 0; font-size: 13px; line-height: 1.55;">${m.text}</span>
                      <span style="flex: none; font-size: 11.5px; color: var(--muted-foreground);">${m.time}</span>
                      <button
                        type="button"
                        class="btn btn-ghost btn-icon"
                        aria-label=${t('删除这条记忆', 'Delete this memory')}
                        onClick=${() => set({ memories: a.memories.filter((x) => x.id !== m.id) })}
                      >${icon(['M3 6h18', 'M8 6V4h8v2', 'M6 6l1 14h10l1-14'], 14)}</button>
                    </div>
                  `,
                )}
                ${!a.memories.length && html`<div style="padding: 6px 0; border-top: 1px solid var(--border); font-size: 13px; color: var(--muted-foreground);">${t('没有已存记忆', 'Nothing stored yet')}</div>`}
              </div>
            </div>
          `}
        </div>

        <div class="satu-panel">
          <span class="satu-panel-title">${t('可访问范围', 'Reach')}</span>
          <div class="field">
            <label>${t('可使用该 Agent 的分组', 'Groups that can use this agent')}</label>
            <${Picks} options=${options.data.groups} selected=${a.groups} onToggle=${(v) => toggleIn('groups', v)} />
          </div>
          <div class="field">
            <label>${t('知识库', 'Knowledge bases')}</label>
            <${Picks} options=${options.data.kbs} selected=${a.kbs} onToggle=${(v) => toggleIn('kbs', v)} />
          </div>
        </div>

        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-4);">
          <button type="button" class="satu-linkbtn" style="text-align: left;" onClick=${() => setPendingDelete(true)}>${t('删除这个 Agent', 'Delete this agent')}</button>
          <div style="display: flex; gap: var(--space-2);">
            <button type="button" class="btn btn-secondary" disabled title=${t('试运行需要 Agent 注册表', 'Dry runs need the agent registry')}>${t('试运行', 'Dry run')}</button>
            <button type="button" class="btn btn-primary" disabled=${!draft} title=${t('写入需要 satu-agent-registry', 'Saving needs the agent registry')}>${t('保存配置', 'Save')}</button>
          </div>
        </div>

        <p style="margin: 0 0 var(--space-4); font-size: 12px; color: var(--muted-foreground);">
          ${t('这一屏的改动都停在浏览器里：Agent 注册表还没做，保存下去没有落点。', 'Edits here stay in the browser — the agent registry does not exist yet, so there is nowhere to save them.')}
        </p>
      </div>
    </div>

    ${pendingDelete &&
    html`
      <${Confirm}
        title=${t('删除这个 Agent？', 'Delete this agent?')}
        body=${t(`「${a.name}」的人设、能力配置与已存记忆会一并删除，正在用它的定时任务与渠道会失效。`, `${a.name}'s persona, capabilities, and stored memories go with it. Tasks and channels using it will fail.`)}
        onCancel=${() => setPendingDelete(false)}
        onConfirm=${() => ctx.router.go('/agents')}
      />
    `}
  `
}

export default {
  name: 'satu-view-agents',
  inject: ['slots', 'host', 'router'],
  apply(ctx) {
    ctx.slots.inject(['sidebar.nav.admin', 'main'], function* () {
      yield ctx.slots.register({ name: 'sidebar.nav.admin', id: 'agents.nav', priority: 10 }, AgentsNav)
      yield ctx.slots.register(
        { name: 'main', id: 'agents', select: (path) => (path === '/agents' ? { title: t('Agent 配置', 'Agents') } : null) },
        AgentsPage,
      )
      yield ctx.slots.register(
        {
          name: 'main',
          id: 'agents.detail',
          select: (path) => {
            const id = path.startsWith('/agents/') && path.slice('/agents/'.length)
            return id ? { title: t('Agent 详情', 'Agent details'), id, back: { to: '/agents', label: t('返回 Agent 列表', 'Back to agents') } } : null
          },
        },
        AgentDetailPage,
      )
    })
  },
}
