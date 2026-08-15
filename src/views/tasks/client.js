import { agentIcon, Confirm, EXEC_MODES, html, icon, ICONS, NavItem, useEffect, useHost, useState, t } from '@satu/shell'

/**
 * 定时任务：列表、新建/编辑、详情。
 *
 * 数据走 `/api/tasks*`——现在那头回的是假数据，但这一屏不知道，也不该知道。
 * 写操作（启用开关、创建、删除）现在只改本地状态：`satu-scheduler` 出来之前
 * 假装写成功了，比留一个点不动的按钮更糟。所以它们都停在本地，并且说出来。
 */

const TAG = { 成功: 'tag-accent-2', 失败: 'tag-accent', 未运行: 'tag-neutral' }

function TasksNav({ ctx, path }) {
  return html`<${NavItem} ctx=${ctx} path=${path} href="/tasks" icon=${icon(ICONS.schedule)} label=${t('我的定时任务', 'Scheduled tasks')} />`
}

function Stat({ label, value, big = true }) {
  return html`
    <div class="satu-stat">
      <span style="font-size: 12px; color: var(--muted-foreground);">${label}</span>
      <span style=${big ? 'font-family: var(--font-heading); font-size: 26px; line-height: 1;' : 'font-size: 16px; font-weight: 600;'}>${value}</span>
    </div>
  `
}

function Notice({ text }) {
  return html`<div style="flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted-foreground);">${text}</div>`
}

// ── 列表 ───────────────────────────────────────────────────────────────────
function Row({ ctx, task, enabled, onToggle, onEdit, onDuplicate, onDelete, menuOpen, onMenu }) {
  return html`
    <div class="satu-taskrow">
      <button type="button" class="satu-tasklink" onClick=${() => ctx.router.go(`/tasks/${task.id}`)}>
        <span style="font-weight: 600; font-size: 14px;">${task.name}</span>
        <span style="font-size: 12px; color: var(--muted-foreground);">${task.desc}</span>
      </button>
      <span style="font-size: 13px;">${task.freq}</span>
      <span style="font-size: 13px; color: var(--muted-foreground);">${task.next}</span>
      <span class=${`tag ${TAG[task.result] ?? 'tag-neutral'}`}>${task.result}</span>
      <div class="satu-rowactions" style="display: flex; align-items: center; gap: var(--space-1); justify-content: flex-end;">
        <button
          type="button"
          class="satu-switch"
          aria-pressed=${String(enabled)}
          aria-label=${enabled ? t('停用', 'Disable') : t('启用', 'Enable')}
          onClick=${onToggle}
        ><span></span></button>
        <div style="position: relative;">
          <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('更多', 'More')} data-menu-toggle onClick=${onMenu}>${icon(ICONS.dots, 16)}</button>
          ${menuOpen &&
          html`
            <div class="satu-menu">
              <button type="button" class="satu-menuitem" onClick=${() => ctx.router.go(`/tasks/${task.id}`)}>${t('查看详情', 'Open details')}</button>
              <button type="button" class="satu-menuitem" onClick=${onMenu}>${t('立即运行', 'Run now')}</button>
              <button type="button" class="satu-menuitem" onClick=${onEdit}>${t('编辑任务', 'Edit task')}</button>
              <button type="button" class="satu-menuitem" onClick=${onDuplicate}>${t('复制任务', 'Duplicate')}</button>
              <button type="button" class="satu-menuitem" onClick=${onToggle}>${enabled ? t('停用任务', 'Disable task') : t('启用任务', 'Enable task')}</button>
              <div style="height: 1px; background: var(--border); margin: 4px 0;"></div>
              <button type="button" class="satu-menuitem" data-danger="true" onClick=${onDelete}>${t('删除任务', 'Delete task')}</button>
            </div>
          `}
        </div>
      </div>
    </div>
  `
}

function TasksPage({ ctx }) {
  const { data, error, loading } = useHost(ctx, '/api/tasks')
  const [flipped, setFlipped] = useState([])
  const [deleted, setDeleted] = useState([])
  const [menu, setMenu] = useState(null)
  const [dialog, setDialog] = useState(null)
  const [pendingDelete, setPendingDelete] = useState(null)

  /**
   * 点别处收起菜单。
   *
   * 判据是**点到了哪里**，不是「过了多久」——排一拍再装监听那种写法依赖
   * mousedown/click 落在同一个任务里，合成事件（自动化、部分输入法）下不成立，
   * 表现是菜单闪一下就没了。
   */
  useEffect(() => {
    if (!menu) return
    const onClick = (e) => {
      if (!e.target.closest?.('.satu-menu, [data-menu-toggle]')) setMenu(null)
    }
    document.addEventListener('click', onClick)
    return () => document.removeEventListener('click', onClick)
  }, [menu])

  if (loading) return html`<${Notice} text=${t('载入中…', 'Loading…')} />`
  if (error) return html`<${Notice} text=${t(`载不出来：${error.message}`, `Could not load: ${error.message}`)} />`

  const tasks = data.tasks.filter((row) => !deleted.includes(row.id))
  const enabledOf = (row) => (flipped.includes(row.id) ? !row.enabled : row.enabled)
  const toggle = (id) => setFlipped((l) => (l.includes(id) ? l.filter((x) => x !== id) : [...l, id]))

  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6);">
      <div style="max-width: 960px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-6);">
        <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h1 style="font-size: 24px; margin: 0 0 4px;">${t('我的定时任务', 'Scheduled tasks')}</h1>
            <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('让任务按时自动跑起来，结果送到你手上。', 'Let tasks run on schedule and deliver results to you.')}</p>
          </div>
          <button type="button" class="btn btn-primary" style="flex: none;" onClick=${() => setDialog({ mode: 'create' })}>
            ${icon(ICONS.plus, 15)} ${t('新建定时任务', 'New task')}
          </button>
        </div>

        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-4);">
          <${Stat} label=${t('启用中', 'Enabled')} value=${tasks.filter(enabledOf).length} />
          <${Stat} label=${t('今日已执行', 'Ran today')} value=${data.stats.ranToday} />
          <${Stat} label=${t('近 7 天失败', 'Failed in 7d')} value=${data.stats.failed7d} />
        </div>

        <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
          <div class="satu-taskhead">
            <span>${t('任务', 'Task')}</span><span>${t('频率', 'Frequency')}</span><span>${t('下次运行', 'Next run')}</span><span>${t('上次结果', 'Last result')}</span><span></span>
          </div>
          ${tasks.map(
            (row) => html`
              <${Row}
                key=${row.id}
                ctx=${ctx}
                task=${row}
                enabled=${enabledOf(row)}
                menuOpen=${menu === row.id}
                onMenu=${() => setMenu(menu === row.id ? null : row.id)}
                onToggle=${() => toggle(row.id)}
                onEdit=${() => {
                  setMenu(null)
                  setDialog({ mode: 'edit', task: row })
                }}
                onDuplicate=${() => {
                  setMenu(null)
                  setDialog({ mode: 'create', task: { ...row, name: t(`${row.name} 副本`, `${row.name} copy`) } })
                }}
                onDelete=${() => {
                  // 菜单得先收起来：弹窗盖上去之后它还留在下面，看着像两层都在等输入。
                  setMenu(null)
                  setPendingDelete(row)
                }}
              />
            `,
          )}
          ${!tasks.length && html`<div style="padding: var(--space-6); text-align: center; color: var(--muted-foreground); font-size: 13px;">${t('还没有定时任务', 'No scheduled tasks yet')}</div>`}
        </div>
      </div>
    </div>

    ${dialog && html`<${TaskDialog} ctx=${ctx} mode=${dialog.mode} task=${dialog.task} onClose=${() => setDialog(null)} />`}

    ${pendingDelete &&
    html`
      <${Confirm}
        title=${t('删除这个定时任务？', 'Delete this task?')}
        body=${t(`「${pendingDelete.name}」及其运行历史将被永久删除，无法恢复。`, `${pendingDelete.name} and its run history will be permanently deleted.`)}
        onCancel=${() => setPendingDelete(null)}
        onConfirm=${() => {
          setDeleted((l) => [...l, pendingDelete.id])
          setPendingDelete(null)
        }}
      />
    `}
  `
}

// ── 新建 / 编辑 ────────────────────────────────────────────────────────────
const FREQ = ['每天', '每小时', '每 4 小时', '每周', '每月', '自定义 Cron']
const NOTIFY = ['邮件', '站内通知', 'Slack', '不通知']

function Pick({ active, label, iconEl, hint, onClick, compact = false }) {
  return html`
    <button
      type="button"
      class="satu-assignee"
      aria-pressed=${String(active)}
      title=${hint}
      onClick=${onClick}
      style=${compact ? 'padding: 5px 12px;' : ''}
    >
      ${iconEl && html`<span class="satu-pickicon">${iconEl}</span>`}${label}
    </button>
  `
}

/**
 * 新建 / 编辑定时任务。
 *
 * 两种模式共用一个组件，因为它们的字段完全一样——分成两个组件迟早会有一边漏改。
 * 差别只在标题、副标题和提交按钮上，那三处显式列出来。
 */
function TaskDialog({ ctx, mode, task, onClose }) {
  const agents = useHost(ctx, '/api/agents')
  const [name, setName] = useState(task?.name ?? '')
  const [prompt, setPrompt] = useState(task?.desc ?? '')
  const [agent, setAgent] = useState(null)
  const [execMode, setExecMode] = useState('ask')
  const [freq, setFreq] = useState(task?.freq && FREQ.includes(task.freq) ? task.freq : '每天')
  const [time, setTime] = useState('09:00')
  const [notify, setNotify] = useState(['邮件'])
  const [enabled, setEnabled] = useState(true)

  const list = agents.data?.agents ?? []
  const picked = agent ?? list[0]?.name
  const editing = mode === 'edit'

  const toggleNotify = (label) =>
    setNotify((l) => (label === '不通知' ? ['不通知'] : l.filter((x) => x !== '不通知').includes(label) ? l.filter((x) => x !== label) : [...l.filter((x) => x !== '不通知'), label]))

  return html`
    <div
      style="position: fixed; inset: 0; z-index: 20; display: flex; align-items: center; justify-content: center; padding: var(--space-6); background: color-mix(in srgb, var(--color-neutral-900) 42%, transparent);"
      onClick=${(e) => e.target === e.currentTarget && onClose()}
    >
      <div style="width: 100%; max-width: 540px; max-height: 88vh; overflow-y: auto; box-sizing: border-box; background: var(--popover); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-lg); padding: var(--space-6); display: flex; flex-direction: column; gap: var(--space-4);">

        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div>
            <h2 style="font-size: 20px; margin: 0 0 4px;">${editing ? t('编辑定时任务', 'Edit task') : t('新建定时任务', 'New task')}</h2>
            <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">
              ${editing ? t('修改后从下一次运行开始生效，已在跑的这次不受影响。', 'Changes apply from the next run; the current one is unaffected.') : t('描述要做的事和执行节奏，剩下的交给 AI 员工。', 'Describe the work and the cadence; your AI employee handles the rest.')}
            </p>
          </div>
          <button type="button" class="btn btn-ghost btn-icon" aria-label=${t('关闭', 'Close')} onClick=${onClose}>${icon(ICONS.close, 16)}</button>
        </div>

        <div class="field">
          <label for="nt-name">${t('任务名称', 'Task name')}</label>
          <input class="input" id="nt-name" type="text" placeholder=${t('例如：客服工单日报', 'e.g. Daily ticket digest')} value=${name} onInput=${(e) => setName(e.target.value)} />
        </div>

        <div class="field">
          <label for="nt-prompt">${t('任务内容', 'What to do')}</label>
          <textarea
            class="input"
            id="nt-prompt"
            rows="3"
            style="border-radius: var(--radius-md); resize: vertical;"
            placeholder=${t('描述每次执行要做的事，例如：归类前一日全部工单，输出摘要并发送邮件', 'What each run should do, e.g. group yesterday\'s tickets and email a summary')}
            value=${prompt}
            onInput=${(e) => setPrompt(e.target.value)}
          ></textarea>
        </div>

        <div class="field">
          <label>${t('执行的 AI 员工', 'Assigned AI employee')}</label>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
            ${list.map(
              (a) => html`
                <${Pick} key=${a.id} label=${a.name} iconEl=${agentIcon(a.icon)} active=${picked === a.name} onClick=${() => setAgent(a.name)} />
              `,
            )}
          </div>
        </div>

        <div class="field">
          <label>${t('执行模式', 'Execution mode')}</label>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
            ${EXEC_MODES.map(
              (m) => html`
                <${Pick} key=${m.key} label=${m.label} hint=${m.hint} iconEl=${icon(m.paths)} active=${execMode === m.key} onClick=${() => setExecMode(m.key)} />
              `,
            )}
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-3);">
          <div class="field">
            <label for="nt-freq">${t('频率', 'Frequency')}</label>
            <select class="input" id="nt-freq" value=${freq} onChange=${(e) => setFreq(e.target.value)}>
              ${FREQ.map((f) => html`<option key=${f} value=${f}>${f}</option>`)}
            </select>
          </div>
          <div class="field">
            <label for="nt-time">${t('执行时间', 'Run at')}</label>
            <input class="input" id="nt-time" type="time" value=${time} onInput=${(e) => setTime(e.target.value)} />
          </div>
        </div>

        <div class="field">
          <label>${t('结果通知', 'Notify via')}</label>
          <div style="display: flex; flex-wrap: wrap; gap: var(--space-2);">
            ${NOTIFY.map(
              (n) => html`<${Pick} key=${n} label=${n} compact active=${notify.includes(n)} onClick=${() => toggleNotify(n)} />`,
            )}
          </div>
        </div>

        <div style="display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); padding: var(--space-3) var(--space-4); background: var(--card); border: 1px solid var(--border); border-radius: var(--radius-md);">
          <div>
            <div style="font-size: 13.5px; font-weight: 600;">${t('创建后立即启用', 'Enable on creation')}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${t('关闭则保存为草稿，稍后手动启用', 'Off saves it as a draft you enable later')}</div>
          </div>
          <button type="button" class="satu-switch" aria-pressed=${String(enabled)} aria-label=${t('创建后立即启用', 'Enable on creation')} onClick=${() => setEnabled(!enabled)}><span></span></button>
        </div>

        <p style="margin: 0; font-size: 12px; color: var(--muted-foreground);">
          ${t('调度还没有后端（satu-scheduler），这里保存不会真的建出任务来。', 'The scheduler backend does not exist yet, so saving will not actually create a task.')}
        </p>

        <div style="display: flex; justify-content: flex-end; gap: var(--space-2); margin-top: var(--space-2);">
          <button type="button" class="btn btn-secondary" onClick=${onClose}>${t('取消', 'Cancel')}</button>
          <button type="button" class="btn btn-primary" onClick=${onClose}>${editing ? t('保存修改', 'Save changes') : t('创建任务', 'Create task')}</button>
        </div>
      </div>
    </div>
  `
}

// ── 详情 ───────────────────────────────────────────────────────────────────
function Panel({ title, children }) {
  return html`
    <div class="satu-panel">
      <span class="satu-panel-title">${title}</span>
      ${children}
    </div>
  `
}

function TaskDetailPage({ ctx, matched }) {
  const { data, error, loading } = useHost(ctx, `/api/tasks/${matched.id}`)
  const [dialog, setDialog] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(false)

  if (loading) return html`<${Notice} text=${t('载入中…', 'Loading…')} />`
  if (error) return html`<${Notice} text=${error.message} />`

  const task = data.task
  return html`
    <div style="flex: 1; min-height: 0; overflow-y: auto; padding: var(--space-6);">
      <div style="max-width: 880px; margin: 0 auto; display: flex; flex-direction: column; gap: var(--space-6);">

        <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4);">
          <div style="min-width: 0;">
            <div style="display: flex; align-items: center; gap: var(--space-3); flex-wrap: wrap;">
              <h1 style="font-size: 24px; margin: 0;">${task.name}</h1>
              <span class=${`tag ${task.enabled ? 'tag-accent-2' : 'tag-neutral'}`}>${task.enabled ? t('启用中', 'Enabled') : t('已暂停', 'Paused')}</span>
            </div>
            <p style="margin: 6px 0 0; font-size: 14px; color: var(--muted-foreground);">${task.desc}</p>
          </div>
          <div style="display: flex; gap: var(--space-2); flex: none;">
            <button type="button" class="btn btn-secondary">${t('立即运行', 'Run now')}</button>
            <button type="button" class="btn btn-primary" onClick=${() => setDialog(true)}>${t('编辑任务', 'Edit task')}</button>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--space-3);">
          <${Stat} label=${t('频率', 'Frequency')} value=${task.freq} big=${false} />
          <${Stat} label=${t('下次运行', 'Next run')} value=${task.next} big=${false} />
          <${Stat} label=${t('近 30 天成功率', 'Success rate (30d)')} value=${task.successRate} big=${false} />
          <${Stat} label=${t('平均耗时', 'Avg duration')} value=${task.avgDuration} big=${false} />
        </div>

        <div style="display: grid; grid-template-columns: 1.4fr 1fr; gap: var(--space-4); align-items: start;">
          <${Panel} title=${t('任务内容', 'What it does')}>
            <p style="margin: 0; font-size: 14px; line-height: 1.7;">${task.prompt}</p>
          <//>
          <${Panel} title=${t('配置', 'Configuration')}>
            <div class="satu-kv"><span>${t('执行的 AI 员工', 'AI employee')}</span><span>${task.agent}</span></div>
            <div class="satu-kv"><span>${t('执行模式', 'Execution mode')}</span><span>${EXEC_MODES.find((m) => m.key === task.mode)?.label ?? task.mode}</span></div>
            <div class="satu-kv"><span>${t('结果通知', 'Notify via')}</span><span>${task.notify.join('、') || t('不通知', 'None')}</span></div>
            <div class="satu-kv"><span>${t('失败重试', 'Retries')}</span><span>${task.retry}</span></div>
            <div class="satu-kv"><span>${t('超时', 'Timeout')}</span><span>${task.timeout}</span></div>
            <div class="satu-kv"><span>${t('创建时间', 'Created')}</span><span>${task.createdAt}</span></div>
          <//>
        </div>

        <div style="display: flex; flex-direction: column; gap: var(--space-3);">
          <div style="display: flex; align-items: baseline; justify-content: space-between;">
            <h2 style="font-size: 18px; margin: 0;">${t('运行历史', 'Run history')}</h2>
            <span style="font-size: 12px; color: var(--muted-foreground);">${t('保留最近 90 天', 'Last 90 days')}</span>
          </div>
          <div style="border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--popover);">
            <div class="satu-runhead">
              <span>${t('开始时间', 'Started')}</span><span>${t('耗时', 'Duration')}</span><span>${t('结果', 'Result')}</span><span>${t('输出', 'Output')}</span><span></span>
            </div>
            ${task.runs.map(
              (r) => html`
                <div class="satu-runrow" key=${r.id}>
                  <span style="font-size: 13px;">${r.start}</span>
                  <span style="font-size: 13px; color: var(--muted-foreground);">${r.duration}</span>
                  <span class=${`tag ${TAG[r.result] ?? 'tag-neutral'}`}>${r.result}</span>
                  <span style="font-size: 13px; color: var(--muted-foreground);">${r.output}</span>
                  <button type="button" class="satu-linkbtn">${t('查看日志', 'View log')}</button>
                </div>
              `,
            )}
          </div>
        </div>

        <div class="satu-danger">
          <div>
            <div style="font-size: 13.5px; font-weight: 600;">${t('删除这个定时任务', 'Delete this task')}</div>
            <div style="font-size: 12px; color: var(--muted-foreground);">${t('删除后历史运行记录一并移除，无法恢复。', 'Run history goes with it. This cannot be undone.')}</div>
          </div>
          <button type="button" class="btn btn-secondary" style="flex: none;" onClick=${() => setPendingDelete(true)}>${t('删除任务', 'Delete task')}</button>
        </div>
      </div>
    </div>

    ${dialog && html`<${TaskDialog} ctx=${ctx} mode="edit" task=${task} onClose=${() => setDialog(false)} />`}

    ${pendingDelete &&
    html`
      <${Confirm}
        title=${t('删除这个定时任务？', 'Delete this task?')}
        body=${t(`「${task.name}」及其运行历史将被永久删除，无法恢复。`, `${task.name} and its run history will be permanently deleted.`)}
        onCancel=${() => setPendingDelete(false)}
        onConfirm=${() => ctx.router.go('/tasks')}
      />
    `}
  `
}

export default {
  name: 'satu-view-tasks',
  inject: ['slots', 'host', 'router'],
  apply(ctx) {
    ctx.slots.inject(['sidebar.nav.main', 'main'], function* () {
      yield ctx.slots.register({ name: 'sidebar.nav.main', id: 'tasks.nav', priority: 10 }, TasksNav)
      yield ctx.slots.register(
        { name: 'main', id: 'tasks', select: (path) => (path === '/tasks' ? { title: t('我的定时任务', 'Scheduled tasks') } : null) },
        TasksPage,
      )
      yield ctx.slots.register(
        {
          name: 'main',
          id: 'tasks.detail',
          select: (path) => {
            const id = path.startsWith('/tasks/') && path.slice('/tasks/'.length)
            // 上一级声明在这里，返回按钮由布局统一画在顶栏。
            return id ? { title: t('任务详情', 'Task details'), id, back: { to: '/tasks', label: t('返回定时任务', 'Back to tasks') } } : null
          },
        },
        TaskDetailPage,
      )
    })
  },
}
