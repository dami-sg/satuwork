import { Service } from '@deepseek-ai/cordis'
import { agentIcon, html, useEffect, useReducer } from '@satu/shell'

/**
 * 侧栏名册。
 *
 * 主位是人，不是「对话 / 任务 / 配置」。点一行打开那个 Bot 的长会话。
 * 列表放进 ctx.roster，侧栏和别处共用同一份。
 * 新建 / 改配置在 Gateway，这里只列已经钉下来的和默认 Bot。
 */

const LAST_KEY = 'satuwork.lastBotId'

class Roster extends Service {
  listeners = new Set()

  constructor(ctx) {
    super(ctx, 'roster')
    this.list = []
    this.loaded = false
  }

  ensure() {
    if (this.loaded) return
    this.loaded = true
    this.reload()
  }

  async reload() {
    const data = await this.ctx.host.get('/api/bots')
    this.list = data.bots ?? []
    this.bump()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  bump() {
    for (const listener of this.listeners) listener()
  }
}

function useRoster(ctx) {
  const [, force] = useReducer((n) => n + 1, 0)
  useEffect(() => {
    const off = ctx.roster.subscribe(force)
    ctx.roster.ensure()
    force()
    return off
  }, [ctx])
  return ctx.roster.list
}

function agentOf(path) {
  const rest = path.startsWith('/a/') && path.slice('/a/'.length)
  if (!rest) return null
  const [id] = rest.split('/')
  return id || null
}

function RosterNav({ ctx, path }) {
  const agents = useRoster(ctx)
  const current = agentOf(path)

  return html`
    <${'div'} style="display: flex; flex-direction: column; gap: 2px;">
      ${agents.map(
        (a) => html`
          <button
            key=${a.id}
            type="button"
            class="satu-nav"
            aria-current=${String(current === a.id)}
            title=${a.description ?? a.name}
            onClick=${() => {
              try {
                localStorage.setItem(LAST_KEY, a.id)
              } catch {}
              ctx.router.go(`/a/${a.id}`)
            }}
          >
            ${agentIcon(a.icon)}
            <span class="satu-label" style=${a.enabled === false ? 'opacity: 0.55;' : ''}>${a.name}</span>
          </button>
        `,
      )}
    <//>
  `
}

export default {
  name: 'satu-agent-registry',
  inject: ['slots', 'host', 'router'],
  apply(ctx) {
    ctx.plugin(Roster)
    ctx.slots.inject(['sidebar.nav.main'], function* () {
      yield ctx.slots.register({ name: 'sidebar.nav.main', id: 'roster', priority: 0 }, RosterNav)
    })
  },
}
