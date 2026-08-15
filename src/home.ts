import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Satuwork 的数据目录。
 *
 * 默认 `~/.satuwork`，可用 `SATUWORK_HOME` 覆盖。
 *
 * **不用启动目录**：那会让「在哪儿敲的命令」决定「看到谁的历史」，换个目录启动就
 * 是另一套数据。以后部署成服务、或者用别的工作目录跑同一个实例时，这是必踩的坑。
 */
export function satuworkHome(...segments: string[]): string {
  const root = process.env.SATUWORK_HOME
    ? resolve(process.env.SATUWORK_HOME)
    : join(homedir(), '.satuwork')
  return segments.length ? join(root, ...segments) : root
}
