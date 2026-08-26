import type { Context } from '@deepseek-ai/cordis'

/**
 * 无副作用的内置工具。
 *
 * 时间必须是工具而不是提示词里的一句话：进程可以跑上好几天，写进 system 的
 * 「今天是几号」当场就开始过期，而模型不会知道它拿到的是旧的。
 *
 * 干活的那套手：看文件改文件的四把（read_file / write_file / patch / search_files）在
 * tools/file.ts，跑命令的那把（terminal）在 tools/terminal.ts。
 */
export const name = 'satu-tools-builtin'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register({
    name: 'now',
    risk: ['read'],
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
}
