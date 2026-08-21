import { Service, type Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '../llm/index.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolService
  }
  interface Events {
    /**
     * 执行前。**waterfall**：调 next() 放行，不调直接短路——策略在这里表态。
     * 审批、权限、沙箱都挂这里，工具本身不需要知道有策略存在。
     */
    'tools/pre-execute'(call: ToolCall, next: () => Promise<ToolResult>): Promise<ToolResult>
    /** 环绕执行。**waterfall**：超时、重试、计时这类横切关注点挂这里。 */
    'tools/execute'(call: ToolCall, next: () => Promise<ToolResult>): Promise<ToolResult>
    /** 执行后。**waterfall**：改写结果、脱敏、截断。 */
    'tools/post-execute'(call: ToolCall, result: ToolResult, next: () => Promise<ToolResult>): Promise<ToolResult>
  }
}

export interface ToolCall {
  callId: string
  name: string
  /** 原始 JSON 字符串，不预先解析——解析失败是这个工具的业务失败，不是管道故障。 */
  arguments: string
  sessionId: string
  /**
   * 这一轮的中止信号。**跑得久的工具必须自己响应它**——pi-agent 的 abort() 掐的是
   * 模型那条流，管不到已经开跑的工具。
   *
   * 没有这个信号时，界面上那颗停止按钮在最需要它的时候是失效的：模型刚发起一条
   * `bash`，人看出来跑错了想喊停，而 bash 的超时上限是十分钟——按钮按下去，日志里
   * 那一轮照样跑到底，看起来就是「点了没反应」。
   */
  signal?: AbortSignal
}

/** 工具产出（或改动）的一个文件。路径相对工作区根目录。 */
export interface WorkspaceFile {
  path: string
  name: string
}

export interface ToolResult {
  /** 给模型看的文本。业务失败也写在这里，用工具自己的语义表达。 */
  text: string
  /**
   * **管道层**失败：抛异常、超时、执行前被拒。
   * 命令退出码非零、查询没结果这类**业务失败**不置位——它们是正常返回。
   */
  failed?: boolean
  /**
   * 这次调用落地的文件。**给人看的，不给模型看**——它已经从 text 里知道自己写了什么。
   *
   * 存在的理由是「用户怎么发现 Bot 生成的东西」：没有它，界面只能去正则扫工具结果
   * 的文本找路径，而那段文本是给模型写的散文，措辞一改就扫不出来了。让产出文件的
   * 那个工具直接报出来，是这条链路上唯一不靠猜的一环。
   */
  files?: WorkspaceFile[]
}

/**
 * 这把工具会干出什么性质的事。**策略据此判断要不要拦**——没有它，「高风险操作需确认」
 * 只能靠工具名去猜，而 MCP 的工具名是远端起的，猜到的永远是上一版。
 *
 *  - `read`：只看，不改任何东西
 *  - `write`：改数据（本地文件、远端记录、发出去一封邮件）
 *  - `external`：出这台席位，打别人家的系统
 *  - `destructive`：能不可逆地毁掉东西
 */
export type ToolRisk = 'read' | 'write' | 'external' | 'destructive'

/**
 * 没标注的工具按什么算。**最高风险**，不是最低。
 *
 * 反过来（不标注 = 只读）意味着任何一把新注册的工具默认绕过全部边界，而新工具恰恰是
 * 最没被审视过的那些。宁可多问一次。
 */
export const UNKNOWN_RISK: ToolRisk[] = ['external', 'write']

export interface ToolDefinition extends ToolSchema {
  /** 见 ToolRisk。不写 = UNKNOWN_RISK。 */
  risk?: ToolRisk[]
  execute(args: unknown, call: ToolCall): Promise<ToolResult> | ToolResult
}

/**
 * 工具注册表与执行管道。
 *
 * 决策必须在做出它的那个操作里强制执行：拒绝只能来自 pre-execute 短路，
 * 不能靠「不把 schema 给模型看」——那不是强制，是遮掩，直接调用照样能绕过去。
 */
export class ToolService extends Service {
  private defs = new Map<string, ToolDefinition>()

  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(def: ToolDefinition) {
    if (this.defs.has(def.name)) throw new Error(`tools: ${def.name} 已注册`)
    this.defs.set(def.name, def)
    return this.ctx.effect(() => () => {
      this.defs.delete(def.name)
    })
  }

  unregister(name: string) {
    this.defs.delete(name)
  }

  schemas(): ToolSchema[] {
    return [...this.defs.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }))
  }

  has(name: string) {
    return this.defs.has(name)
  }

  /**
   * 这把工具的风险面。**认不出的按最高风险算**（见 UNKNOWN_RISK）。
   *
   * 「认不出」有两种，都必须往严了算：工具压根没注册（模型编了个名字，那次调用会被
   * run() 判失败，但策略在它之前就要表态），以及注册了却没标注 risk。
   */
  riskOf(name: string): ToolRisk[] {
    const def = this.defs.get(name)
    if (!def || !Array.isArray(def.risk) || !def.risk.length) return UNKNOWN_RISK
    return def.risk
  }

  /**
   * 跑完整条管道。**永远 resolve**，不 reject——报告失败是调用方的职责，
   * 不是异常路径；异常会让 agent 循环没法把结果写回日志。
   */
  async execute(call: ToolCall): Promise<ToolResult> {
    const run = async (): Promise<ToolResult> => {
      const def = this.defs.get(call.name)
      if (!def) return { text: `未知工具 ${call.name}`, failed: true }
      let args: unknown
      try {
        args = call.arguments.trim() ? JSON.parse(call.arguments) : {}
      } catch (e) {
        // 参数不是合法 JSON 是模型的问题，告诉它，让它重试——不算管道故障。
        return { text: `参数不是合法 JSON：${(e as Error).message}` }
      }
      return await def.execute(args, call)
    }

    try {
      return await this.ctx.waterfall('tools/pre-execute', call, async () => {
        const result = await this.ctx.waterfall('tools/execute', call, run)
        return await this.ctx.waterfall('tools/post-execute', call, result, async () => result)
      })
    } catch (e) {
      return { text: `工具执行失败：${(e as Error).message}`, failed: true }
    }
  }
}

export const name = 'satu-tools'

export function apply(ctx: Context) {
  ctx.plugin(ToolService)
}
