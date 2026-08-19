import { Logger, type Context } from '@deepseek-ai/cordis'

/**
 * 把框架的 logger 接到 stdout 上。
 *
 * **在此之前一个字都出不来。** cordis 自带 `ctx.logger`，但它默认只有一个 exporter：
 * 往一个 1000 条的内存环里塞，没人读。于是代码里那 16 处 `ctx.logger?.warn?.(...)`
 * 看着都在写日志，实际全丢进了那个环——席位的 journal 里除了 systemd 和启动那两行
 * 什么都没有，出了问题只能靠猜。
 *
 * 还有一道坑在级别数值上：error=0、info=1、**warn=2**、debug=3，而默认门槛是 1，
 * 判据是 `门槛 < level` 就丢。也就是说**默认配置下 warn 是被丢掉的**，而那 16 处里
 * 有 14 处是 warn。所以这里显式把门槛提到 2。
 *
 * 不打对话正文：日志是给排查用的，不是第二份会话记录。正文在 JSONL 里，那边有权限
 * 管着；这里只留「谁在跑、跑到哪、花了多久、错在哪」。
 */
export const name = 'satu-logger'

export function apply(ctx: Context) {
  const exporter = {
    // journald 不需要 ANSI，带色只会让 journalctl 里多一串转义符。
    colors: 0 as const,
    levels: { default: process.env.SATUWORK_DEBUG === '1' ? 3 : 2 },
    export(message: { type: string; level: number; name?: string; args: unknown[] }) {
      const text = Logger.format(exporter as never, message as never)
      const scope = message.name && message.name !== 'logger' ? `${message.name} ` : ''
      const line = `[${message.type.toUpperCase()}] ${scope}${text}`
      // systemd 按 stdout/stderr 分流，错误进 stderr 才能被 `journalctl -p err` 捞出来。
      if (message.level <= 0) console.error(line)
      else console.log(line)
    },
  }
  ctx.logger.exporter(exporter as never)
}
