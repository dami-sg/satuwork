import { h } from 'preact'
import { useEffect, useReducer } from 'preact/hooks'

/**
 * Slot 注册表与渲染的绑定。
 *
 * 注册表本身不认识 preact——它只管谁声明了什么、谁贡献了什么。这里是唯一知道
 * 「怎么把它画出来」的地方，换渲染库只动这个文件。
 */

/**
 * 订阅注册表变更。插件挂载/卸载后界面自己跟上，没有手工刷新这一步。
 *
 * 订阅是在**首次渲染之后**才装上的（effect 跑在渲染之后），这中间到达的变更没有
 * 听众。所以装好之后立刻自查一次——插件是异步挂载的，这段窗口每次启动都会撞上。
 */
export function useSlots(ctx) {
  const [, force] = useReducer((n) => n + 1, 0)
  useEffect(() => {
    const off = ctx.slots.subscribe(force)
    force()
    return off
  }, [ctx])
}

/**
 * 渲染一个位置上的全部贡献。
 *
 * 交给组件的 `renderSlot` 被**限制在它自己声明过的子位置**上：画一个没声明的
 * 位置是编程错误，当场抛，而不是渲染出一片空白让人去猜。
 */
export function renderSlot(ctx, name, props = {}) {
  return ctx.slots.entries(name).map((entry) => h(Contribution, { key: entry.id ?? entry.name, ctx, entry, props }))
}

/** 链式位置：谁自荐成功谁出场，都没中就交给调用方的兜底。 */
export function renderSlotChain(ctx, name, input, fallback = null) {
  const [entry, matched] = ctx.slots.elect(name, input)
  if (!entry) return fallback
  return h(Contribution, { key: entry.id ?? entry.name, ctx, entry, props: { matched } })
}

function Contribution({ ctx, entry, props }) {
  const render = (name, childProps) => {
    if (!entry.children.includes(name)) {
      throw new Error(`slots: ${entry.id ?? entry.name} 没有声明 ${name}，不能渲染它`)
    }
    return renderSlot(ctx, name, childProps)
  }
  const chain = (name, input, fallback) => {
    if (!entry.children.includes(name)) {
      throw new Error(`slots: ${entry.id ?? entry.name} 没有声明 ${name}，不能渲染它`)
    }
    return renderSlotChain(ctx, name, input, fallback)
  }
  return h(entry.Component, { ...props, ctx, renderSlot: render, renderSlotChain: chain })
}

/**
 * 整棵界面的根。
 *
 * root 是**链式**的：登录页与主界面各自认领整块屏幕，谁上场由它们自己按当前状态
 * 决定（`select`），shell 不认识「登录」这个概念。这也是为什么未登录时主界面不是
 * 「藏起来」而是**根本没渲染**——它不存在，也就不会有半个组件偷偷去打接口。
 */
export function Root({ ctx }) {
  useSlots(ctx)
  return renderSlotChain(ctx, 'root', ctx, h(Nobody, {}))
}

function Nobody() {
  return h(
    'div',
    { style: 'display: flex; height: 100vh; align-items: center; justify-content: center; color: #6e6d68;' },
    'shell: 没有插件认领 root',
  )
}
