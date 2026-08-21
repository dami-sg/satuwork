import type { Db } from '../db.ts'
import type { JwtKeys } from '../crypto.ts'
import type { Llm } from '../llm.ts'
import type { Meter } from '../lib/meter.ts'

/**
 * 每组路由都收这一个。
 *
 * 以前 attach() 是一个 3600 行的函数，`db` / `keys` / `llm` 靠闭包捕获，于是任何一条
 * 路由都拆不出去——平台账单的改动和聊天反代的改动会在同一个文件里冲突。改成显式
 * 依赖之后，每组路由是一个独立模块，routes.ts 只负责按顺序把它们挂上去。
 */
export interface RouteCtx {
  db: Db
  keys: JwtKeys
  llm: Llm
  /**
   * 计费适配器。**整个进程一个**——它记着每家公司的余额，拆成多份就等于多份各算各的
   * 记忆，谁都不知道别人扣过了。
   */
  meter: Meter
}
