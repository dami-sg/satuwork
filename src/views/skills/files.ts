import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { satuworkHome } from '../../home.ts'

/**
 * ZIP 包 Skill 的文件，落在 `$SATUWORK_HOME/skills/<id>/`。
 *
 * **不塞进 SQLite**：包里有脚本、模板，还可能有图片——那是文件，不是文档。存成一行
 * JSON 里的 base64 会让一次「读一个 Skill 的名字」把几 MB 的附件一起读出来，而且
 * 想看看包里到底有什么，还得先写个工具。摊在磁盘上，`ls` 就能回答。
 *
 * 路径**一律当作不可信**：解压出来的名字来自那个 zip，`../` 是它可以写的东西。
 * 每一次读写都先归一化再确认落在这个 Skill 自己的目录里，越界当场抛。
 */

const rootOf = (id: string) => satuworkHome('skills', id)

/** 归一化并确认没跑出 `skills/<id>/`。这是这个文件里唯一重要的一行。 */
export function confine(id: string, rel: string): string {
  const root = resolve(rootOf(id))
  const file = resolve(join(root, normalize(rel)))
  if (file !== root && !file.startsWith(root + sep)) throw new Error(`路径越界：${rel}`)
  if (file === root) throw new Error('要给出文件名')
  return file
}

/** 文本还是二进制：拿严格 UTF-8 解一遍，解不开就是二进制。不猜扩展名。 */
export function isBinary(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return false
  } catch {
    return true
  }
}

export interface Incoming {
  path: string
  /** 文本文件给 text，二进制给 base64。两者只会有一个。 */
  text?: string
  base64?: string
}

export function writeAll(id: string, files: Incoming[]): void {
  removeAll(id)
  for (const file of files) {
    const target = confine(id, file.path)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, file.base64 !== undefined ? Buffer.from(file.base64, 'base64') : (file.text ?? ''))
  }
}

export function writeOne(id: string, rel: string, text: string): void {
  const target = confine(id, rel)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text)
}

export function readOne(id: string, rel: string): Buffer {
  const target = confine(id, rel)
  if (!existsSync(target) || statSync(target).isDirectory()) throw new Error(`没有这个文件：${rel}`)
  return readFileSync(target)
}

export function removeOne(id: string, rel: string): void {
  const target = confine(id, rel)
  if (!existsSync(target)) throw new Error(`没有这个文件：${rel}`)
  rmSync(target, { recursive: true })
}

export function removeAll(id: string): void {
  rmSync(rootOf(id), { recursive: true, force: true })
}

export interface Entry {
  path: string
  size: number
  binary: boolean
}

/**
 * 包内文件清单。
 *
 * 顺序自己定死：先按层级、再按路径。跟着文件系统的返回顺序走，树每次画出来都可能
 * 不一样；而根目录的文件排在前面，SKILL.md 才会在最上面——它是这个包的正文。
 */
export function list(id: string): Entry[] {
  const root = rootOf(id)
  if (!existsSync(root)) return []
  const out: Entry[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else {
        const bytes = readFileSync(full)
        out.push({ path: relative(root, full).split(sep).join('/'), size: bytes.length, binary: isBinary(bytes) })
      }
    }
  }
  walk(root)
  const depth = (p: string) => p.split('/').length
  return out.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))
}
