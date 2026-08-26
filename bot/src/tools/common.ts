import type { Context } from '@deepseek-ai/cordis'
import { WorkspaceError } from '../workspace/index.ts'
import type { ToolCall, ToolRisk, WorkspaceFile } from './index.ts'

/**
 * 工作区那几把工具共用的一点东西：业务失败怎么表达、结果长什么样、怎么注册。
 *
 * 单独成一个文件而不是各写一份，是因为**「什么算业务失败」必须只有一个口径**：这一层
 * 判错了，模型收到的就是「工具执行失败」这种管道故障的说法，而它对应的动作（重试、
 * 报错给用户）和「文件不存在」完全不一样。
 */

/** 业务失败：参数不对、文件不存在、命令没找到。**不是**管道故障，照常返回文本。 */
export class ToolFailure extends Error {}

export function fail(message: string): never {
  throw new ToolFailure(message)
}

/** 截断并说清楚截了多少。悄悄截掉会让模型以为它看到的就是全部。 */
export function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`
}

/** 工具返回的东西：一段文本，外加它落地的（files）与看到的（refs）文件。 */
export type ToolOut = { text: string; files?: WorkspaceFile[]; refs?: WorkspaceFile[] }

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  risk?: ToolRisk[]
}

/**
 * 注册一把工作区工具，顺手把业务失败收成文本。
 *
 * 管道故障（真异常）继续往上抛，由 ToolService 标 `failed`。越界、文件不存在、没权限
 * 这些是模型写错了参数，跟「命令退出码非零」同类——告诉它，让它改。
 */
export function registerTool(
  ctx: Context,
  def: ToolDef,
  execute: (args: any, call: ToolCall) => Promise<string | ToolOut> | string | ToolOut,
) {
  ctx.tools.register({
    ...def,
    async execute(args, call) {
      try {
        const out = await execute((args ?? {}) as any, call)
        return typeof out === 'string' ? { text: out } : out
      } catch (e) {
        if (e instanceof WorkspaceError) return { text: e.message }
        if (e instanceof ToolFailure) return { text: e.message }
        const err = e as NodeJS.ErrnoException
        if (err?.code === 'ENOENT') return { text: `文件或目录不存在：${err.path ?? ''}` }
        if (err?.code === 'EACCES') return { text: `没有权限：${err.path ?? ''}` }
        if (err?.code === 'EISDIR') return { text: `这是一个目录，不是文件：${err.path ?? ''}` }
        throw e
      }
    },
  })
}
