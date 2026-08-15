import type { StorageService } from '../storage/index.ts'

/**
 * pi-ai 的 `CredentialStore`，落在我们的 SQLite 上。
 *
 * 契约很小：`read` / `list` / `modify` / `delete`。其中 **`modify` 是唯一的写路径**，
 * 而且是串行化的读-改-写——OAuth 的 token 刷新在它里面跑，并发请求不会重复刷新一个
 * 已经轮换过的 token。所以这里必须真的串起来，不能各改各的。
 *
 * pi-ai 的规则：**存了的凭据拥有该 provider**，环境变量只在什么都没存时才查。
 * 也就是说界面上填过 key 之后，`.env` 里的同名变量不再生效——这是有意的，
 * 否则一次失败的刷新会静默回落到一把旧钥匙。
 *
 * 密钥在库里是明文。这是本地优先应用的常规做法，保护来自文件权限
 * （`~/.satuwork/satuwork.db`）而不是加密——真要加密就得再引入一个主密钥，
 * 那个主密钥同样要落在某处，只是把问题挪了个位置。`list()` 契约上不解析密钥，
 * 所以「哪些 provider 配好了」这种查询不会把明文读出来。
 */
export function createCredentialStore(storage: StorageService) {
  const NS = 'credentials'
  // 串行化写：一条 Promise 链，保证 modify 之间不交错。
  let tail: Promise<unknown> = Promise.resolve()

  const read = (providerId: string) => storage.getSetting<unknown>(NS, providerId)

  return {
    async read(providerId: string) {
      return read(providerId) ?? undefined
    },

    /** 只返回非机密元数据——契约明确要求枚举不得解析密钥。 */
    async list() {
      return Object.entries(storage.allSettings(NS)).map(([providerId, value]) => ({
        providerId,
        type: (value as { type?: string })?.type ?? 'api_key',
      }))
    },

    async modify(providerId: string, fn: (current: unknown) => unknown | Promise<unknown>) {
      const run = async () => {
        const next = await fn(read(providerId))
        if (next === undefined || next === null) storage.setSetting(NS, providerId, null)
        else storage.setSetting(NS, providerId, next)
        return next
      }
      tail = tail.then(run, run)
      return tail
    },

    async delete(providerId: string) {
      await this.modify(providerId, () => null)
    },
  }
}
