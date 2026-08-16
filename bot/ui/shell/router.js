import { Service } from '@deepseek-ai/cordis'
import { useEffect, useReducer } from 'preact/hooks'

/**
 * 地址栏。
 *
 * 路由表不在这里——视图在链式 slot 上**自荐**（见 slots.js 的 `elect`）。
 * 这个服务只负责「当前是哪个地址」和「换一个地址」，加一屏不需要动它。
 *
 * 用 History API 而不是 hash：宿主那边的 SPA 兜底本来就把未知路径回落到
 * index.html，深链接直接可用，没必要在 URL 里挂一个 `#`。
 */
export class Router extends Service {
  constructor(ctx) {
    super(ctx, 'router')
    this.path = location.pathname
    this.listeners = new Set()
    ctx.effect(() => {
      const sync = () => {
        this.path = location.pathname
        this.bump()
      }
      addEventListener('popstate', sync)
      return () => removeEventListener('popstate', sync)
    })
  }

  go(path) {
    if (path === this.path) return
    history.pushState(null, '', path)
    this.path = path
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

/** 订阅地址变化。 */
export function useRoute(ctx) {
  const [, force] = useReducer((n) => n + 1, 0)
  useEffect(() => {
    const off = ctx.router.subscribe(force)
    force()
    return off
  }, [ctx])
  return ctx.router.path
}
