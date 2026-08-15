import { Service } from '@deepseek-ai/cordis'
import { useEffect, useState } from 'preact/hooks'

/**
 * 与宿主的连接。
 *
 * 浏览器与宿主之间的契约是**我们自己的** HTTP + SSE，没有中间协议层。所有插件
 * 都从这里出去，好处是失败形态只有一种：非 2xx 一律抛，错误文本取响应里的
 * `error` 字段——各插件不用各自发明一套「请求失败了怎么办」。
 */
export class Host extends Service {
  constructor(ctx) {
    super(ctx, 'host')
  }

  async request(method, path, body) {
    const res = await fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : null
    // 401 说明会话没了（过期、被登出、服务端重置）。广播一次，让认证插件把
    // 登录页请回来——各屏不用自己判断这件事，也不该判断。
    if (res.status === 401) this.ctx.emit('host/unauthorized')
    if (!res.ok) throw new Error(data?.error ?? `${method} ${path} → ${res.status}`)
    return data
  }

  get(path) {
    return this.request('GET', path)
  }

  post(path, body) {
    return this.request('POST', path, body ?? {})
  }

  put(path, body) {
    return this.request('PUT', path, body ?? {})
  }

  patch(path, body) {
    return this.request('PATCH', path, body ?? {})
  }

  delete(path) {
    return this.request('DELETE', path)
  }

  /** 事件流。返回 disposer，交给 `ctx.effect` 就随插件卸载而断开。 */
  stream(path, onEvent, onError) {
    const source = new EventSource(path)
    source.onmessage = (m) => onEvent(JSON.parse(m.data))
    if (onError) source.onerror = onError
    return () => source.close()
  }
}

/**
 * 读一次宿主数据。
 *
 * 返回 `{ data, error, loading, reload }`——三种状态都显式表达出来，界面就不会
 * 把「还没回来」和「回来是空的」画成同一个样子。
 */
export function useHost(ctx, path, deps = []) {
  const [state, setState] = useState({ loading: true })
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    let live = true
    setState({ loading: true })
    ctx.host
      .get(path)
      .then((data) => live && setState({ data, loading: false }))
      .catch((error) => live && setState({ error, loading: false }))
    return () => {
      live = false
    }
  }, [ctx, path, nonce, ...deps])
  return { ...state, reload: () => setNonce((n) => n + 1) }
}
