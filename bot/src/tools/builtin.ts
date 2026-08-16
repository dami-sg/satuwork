import type { Context } from '@deepseek-ai/cordis'

/**
 * 两个无副作用的内置工具，用来把工具链路跑通。
 *
 * 它们存在的意义是**证明管道**：模型能看到 schema、能发起调用、结果能回到日志、
 * 再回到模型。真正的业务工具（知识库检索、SQL、连接器）按同一个形状加。
 */
export const name = 'satu-tools-builtin'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'now',
    description: '返回当前日期与时间。需要知道“今天”“现在”时用它，不要凭猜测回答。',
    parameters: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA 时区名，如 Asia/Shanghai。默认用服务器时区。' },
      },
    },
    execute(args) {
      const { timezone } = (args ?? {}) as { timezone?: string }
      try {
        const text = new Intl.DateTimeFormat('zh-CN', {
          dateStyle: 'full',
          timeStyle: 'medium',
          timeZone: timezone,
        }).format(new Date())
        return { text }
      } catch {
        // 时区名无效是模型给错了参数，告诉它——这是业务失败，不是管道故障。
        return { text: `无效时区：${timezone}` }
      }
    },
  })

  ctx.tools.register({
    name: 'calc',
    description: '计算一个算术表达式，支持 + - * / % ( ) 与小数。需要精确数值时用它。',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: '例如 (1200 * 1.06) / 3' } },
      required: ['expression'],
    },
    execute(args) {
      const { expression } = (args ?? {}) as { expression?: string }
      if (!expression) return { text: '缺少 expression 参数' }
      // 白名单字符后再求值：这里不接受标识符，所以拿不到任何作用域内的东西。
      if (!/^[\d\s+\-*/%.()]+$/.test(expression)) {
        return { text: '表达式只能包含数字、空白与 + - * / % ( ) . 这些字符' }
      }
      try {
        const value = Function(`"use strict";return (${expression})`)() as number
        if (!Number.isFinite(value)) return { text: '结果不是有限数' }
        return { text: String(value) }
      } catch (e) {
        return { text: `无法计算：${(e as Error).message}` }
      }
    },
  })
}
