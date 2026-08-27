/**
 * 两份 e2e 同时在跑的时候，别互相拆台。
 *
 * 这个仓库里「两个 worktree、两个会话各跑一遍 e2e」是常态，而套件里那些共享资源的
 * 名字全是写死的：PostgreSQL 的 schema（`e2e_manager`…）、`/tmp` 下的数据目录
 * （`/tmp/satuwork-e2e-manager-gw`…）。两边都在起手处把自己那份**清掉重建**，于是
 * 后开跑的那个进程一句 `drop schema cascade` / `rmSync` 就把前一个正在跑的端了。
 *
 * 坏在这上头的现象一律指不回真正的原因：
 *
 * - schema 被清 → 表在重建窗口里查不到（`relation ... does not exist`）、账号 id
 *   全换了新的（401「账号不存在」），而日志里没有任何一句提到有人清过库；
 * - 数据目录被删 → `ENOENT: jwt-private.pem` / `manager.json`，看着像本机环境坏了。
 *
 * 所以名字统一带上一个后缀，**按 checkout 路径散列**：
 *
 * - 两个 worktree 天然分开，谁也碰不到谁；
 * - 同一个 worktree 反复跑还是同一批名字，库里和 /tmp 下不会越攒越多；
 * - 同一个 worktree 同时跑两份仍然会撞——那本来就是使用错误，由 Gateway 那侧的认领
 *   锁当场报出来（见 gateway/src/db.ts 的 claimSchema），而不是把数据抹掉。
 */
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUFFIX = createHash('sha256')
  .update(resolve(dirname(dirname(fileURLToPath(import.meta.url)))))
  .digest('hex')
  .slice(0, 8)

/**
 * 套件的 schema 名。**所有写死的 `e2e_xxx` 都要从这里过一遍**——漏一处，那一套的
 * Gateway 和它的探针客户端就会看着两个不同的 schema，症状是「表在库里，代码说没有」。
 */
export function schemaOf(name) {
  return `${name}_${SUFFIX}`
}

/** 套件在 /tmp 下的目录。同理，写死的 `/tmp/satuwork-e2e-xxx` 都要从这里过。 */
export function tmpOf(name) {
  return `/tmp/${name}-${SUFFIX}`
}
