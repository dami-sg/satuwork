import { Service } from '@deepseek-ai/cordis'

/**
 * Slot 注册表。
 *
 * 一条规则贯穿始终：**声明即渲染授权**。一个位置只有被它的父组件在注册时显式
 * 声明过，别的插件才能往里贡献；往没人声明的位置注册直接抛错，而不是悄悄什么
 * 都不显示——后者会让人去查数据、查权限，唯独查不到「这个位置根本不存在」。
 *
 * entry 的 disposer **递归塌掉**它声明的子 slot：父插件卸载时，挂在它子位置上的
 * 一切跟着消失。UI 的生命周期与插件的生命周期是同一条轴，这是整套设计的立足点。
 *
 * 服务里**不用 `#private` 字段**：cordis 按 context 给服务派生实例
 * （`Object.create(instance)`），派生对象上没有原对象的私有字段，一访问就是
 * 「Cannot read private member」。这条对下面几个服务同样成立。
 */
export class Slots extends Service {
  constructor(ctx) {
    super(ctx, 'slots')
    /** slot 名 → 贡献进来的 entry 集合。'root' 是先验存在的那一个。 */
    this.slots = new Map([['root', new Set()]])
    this.listeners = new Set()
  }

  /**
   * 往 `spec.name` 里贡献一个组件，同时声明它自己开放的子位置。
   *
   * `select` 让 entry **自荐**而不是由调用点按 key 挑选：第一个返回非 null 的
   * 胜出。路由就是这么落地的——视图自己认领路径，布局不需要知道有哪些视图。
   */
  register(spec, Component) {
    const slot = this.slots.get(spec.name)
    if (!slot) throw new Error(`slots: ${spec.name} 未声明——声明即渲染授权`)
    for (const child of spec.children ?? []) {
      if (this.slots.has(child)) throw new Error(`slots: ${child} 已被声明，一个位置只能有一个主人`)
      this.slots.set(child, new Set())
    }

    const entry = { ...spec, Component, children: spec.children ?? [], priority: spec.priority ?? 0 }
    slot.add(entry)
    this.bump()

    return this.ctx.effect(() => () => {
      slot.delete(entry)
      for (const child of entry.children) this.collapse(child)
      this.bump()
    })
  }

  /**
   * 把「某个位置已被声明」当成依赖。
   *
   * 贡献者与声明它的那个插件是两个独立的插件，谁先挂上不确定；直接 register 会
   * 撞上「未声明」而挂不上。这是 slot 层的 `inject`：位置在，就立刻跑；不在，就
   * 等它出现。声明塌掉时把回调注册的东西一并撤掉，重新声明再跑一次。
   *
   * 回调可以返回一个 disposer、一组 disposer，或者用生成器把多次注册 `yield`
   * 出来——那样一组注册就是一笔事务，中途失败前面的会回滚。
   */
  inject(names, callback) {
    const list = [].concat(names)
    let disposers = null

    const stop = () => {
      for (const dispose of (disposers ?? []).reverse()) dispose()
      disposers = null
    }

    const check = () => {
      const ready = list.every((name) => this.slots.has(name))
      if (ready === !!disposers) return
      if (!ready) return stop()
      disposers = []
      try {
        const result = callback()
        for (const dispose of typeof result === 'function' ? [result] : (result ?? [])) disposers.push(dispose)
      } catch (e) {
        stop()
        throw e
      }
    }

    return this.ctx.effect(() => {
      const off = this.subscribe(check)
      check()
      return () => {
        off()
        stop()
      }
    })
  }

  /** 塌掉一个子 slot 及其下面声明的所有位置。 */
  collapse(name) {
    for (const entry of this.slots.get(name) ?? []) {
      for (const child of entry.children) this.collapse(child)
    }
    this.slots.delete(name)
  }

  /** 某个位置上的贡献，按 priority 升序，同级按注册顺序。 */
  entries(name) {
    return [...(this.slots.get(name) ?? [])].sort((a, b) => a.priority - b.priority)
  }

  /** 链式位置：让 entry 自荐，第一个非 null 的胜出，返回 [entry, matched]。 */
  elect(name, input) {
    for (const entry of this.entries(name)) {
      const matched = entry.select?.(input)
      if (matched != null) return [entry, matched]
    }
    return []
  }

  declared(name) {
    return this.slots.has(name)
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  bump() {
    for (const listener of this.listeners) listener()
  }
}
