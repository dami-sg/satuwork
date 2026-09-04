import { randomBytes, randomUUID } from 'node:crypto'
import type { RouteCtx } from './ctx.ts'
import { HttpError, json, type Router } from '../http.ts'
import { bodyOf, strField } from '../lib/validate.ts'
import { requireUser } from '../lib/guards.ts'
import { requireSeat, pairRuntime } from '../lib/runtime.ts'
import { encryptChannelSecret, decryptChannelSecret } from '../crypto.ts'
import { startSeatDeploy } from '../deploy.ts'
import { botContext, publicBot } from '../lib/catalog.ts'
import { newPairingCode, pairingCodeHash } from '../channels/pairing.ts'
import { telegramDeleteWebhook, telegramGetMe, telegramSetMyCommands } from '../channels/telegram.ts'
import { USER_BOT_QUOTA_LOCK } from './runtime.ts'

const MAX_USER_BOTS = Math.max(1, Math.trunc(Number(process.env.GATEWAY_MAX_USER_BOTS) || 10))
// 绑渠道顺手建的那颗 Bot 和 POST /runtime/bots 数的是同一个配额，锁也得是同一把（键定义在那边）。
const CHANNEL_BIND_LOCK = USER_BOT_QUOTA_LOCK

interface StoredSecret { token: string; pairingCode: string }

function publicBinding(row: Awaited<ReturnType<RouteCtx['db']['channelBinding']>>, bot?: unknown, runtime?: unknown, pairingCode = '', identity?: Awaited<ReturnType<RouteCtx['db']['channelIdentity']>>) {
  if (!row) return null
  return {
    id: row.id, kind: row.kind, status: row.status, botId: row.botId,
    externalBotId: row.externalBotId, externalUsername: row.externalUsername,
    allowGroups: false, lastReceivedAt: row.lastReceivedAt,
    lastPolledAt: row.lastPolledAt, lastError: row.lastError || row.pollLastError, createdAt: row.createdAt, updatedAt: row.updatedAt,
    paired: Boolean(identity),
    ...(identity ? { pairedIdentity: {
      externalUserId: identity.externalUserId, externalUsername: identity.externalUsername,
      externalDisplayName: identity.externalDisplayName, pairedAt: identity.pairedAt, lastSeenAt: identity.lastSeenAt,
    } } : {}),
    ...(pairingCode ? { pairingCode } : {}),
    ...(bot ? { bot } : {}), ...(runtime !== undefined ? { runtime } : {}),
  }
}

async function fullBinding(ctx: RouteCtx, row: NonNullable<Awaited<ReturnType<RouteCtx['db']['channelBinding']>>>) {
  const item = await ctx.db.catalog(row.botId)
  const account = await ctx.db.account(row.accountId)
  let bot: unknown = undefined
  let runtime: unknown = null
  if (item && account?.companyId) {
    const { pinned, tpl } = await botContext(ctx.db, account.companyId)
    bot = publicBot(item, pinned, tpl)
    runtime = await pairRuntime(ctx.db, account, item.id).catch(() => null)
  }
  const identity = await ctx.db.channelIdentity(row.id)
  let pairingCode = ''
  if (!identity && row.pairingCodeHash) {
    try { pairingCode = decryptChannelSecret<StoredSecret>(ctx.channelKey, row.credentialCiphertext).pairingCode } catch {}
  }
  return publicBinding(row, bot, runtime, pairingCode, identity)
}

export function attachChannels(router: Router, ctx: RouteCtx) {
  const { db, keys, channelKey } = ctx

  router.get('/channels', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const rows = await db.channelBindings(account.id)
    json(res, 200, { channels: await Promise.all(rows.map((r) => fullBinding(ctx, r))) })
  })

  router.post('/channels/telegram', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const body = bodyOf(req)
    const token = strField(body, 'token').trim()
    if (token.length < 20 || token.length > 256) throw new HttpError(400, 'Telegram token 格式不对')
    const info = await telegramGetMe(token).catch((e: Error) => { throw new HttpError(400, `Telegram token 验证失败：${e.message}`) })
    if (!info.is_bot) throw new HttpError(400, '这个 token 不是 Telegram Bot')
    const pairingCode = newPairingCode()
    const publicId = randomBytes(18).toString('base64url')

    const created = await db.tx(async () => {
      await db.lockExclusive(CHANNEL_BIND_LOCK)
      if (await db.channelBindingForAccount(account.id, 'telegram')) throw new HttpError(409, '你已经绑定了 Telegram 渠道')
      const usedElsewhere = await db.channelBindingByExternal('telegram', String(info.id))
      if (usedElsewhere) throw new HttpError(409, '这个 Telegram Bot 已被其他账号绑定')
      if (await db.countUserBots(account.id) >= MAX_USER_BOTS) throw new HttpError(409, `最多建 ${MAX_USER_BOTS} 个 Bot，请先释放一个名额`)
      const bot = await db.insertCatalog({
        kind: 'bot', scope: 'user', companyId: account.companyId, accountId: account.id,
        name: 'telegram bot',
        definition: {
          description: '通过 Telegram 渠道接收和回复消息', greeting: '', extraPrompt: '',
          icon: 'c-chat', enabled: true,
        },
      })
      const binding = await db.insertChannelBinding({
        id: randomUUID(), companyId: account.companyId!, accountId: account.id, botId: bot.id,
        kind: 'telegram', status: 'binding', externalBotId: String(info.id),
        externalUsername: String(info.username || ''), publicId,
        credentialCiphertext: encryptChannelSecret(channelKey, { token, pairingCode } satisfies StoredSecret),
        webhookSecretHash: '', pairingCodeHash: pairingCodeHash(pairingCode),
        config: { allowGroups: false },
      })
      return { bot, binding }
    })

    let status: 'active' | 'error' = 'active'
    let lastError: string | null = null
    // getUpdates 和 Webhook 互斥；绑定时显式清掉旧 Webhook，后续完全由长轮询接收。
    try {
      await telegramDeleteWebhook(token, true)
      await telegramSetMyCommands(token)
    } catch (e) {
      status = 'error'
      lastError = (e as Error).message.slice(0, 300)
    }
    const binding = await db.updateChannelBinding(created.binding.id, { status, lastError })
    let deployError = ''
    try {
      const started = await startSeatDeploy(db, account, { botId: created.bot.id })
      if (!started.ok) deployError = started.error
    } catch (e) { deployError = (e as Error).message }
    await db.audit({
      companyId: account.companyId!, accountId: account.id, action: 'channel.telegram.bind',
      detail: { id: binding.id, botId: binding.botId, externalBotId: binding.externalBotId, status },
    })
    json(res, 201, { channel: await fullBinding(ctx, binding), pairingCode, deployError })
  })

  router.post('/channels/:id/reconnect', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const binding = await db.channelBinding(req.params.id)
    if (!binding || binding.accountId !== account.id) throw new HttpError(404, '渠道不存在')
    const secret = decryptChannelSecret<StoredSecret>(channelKey, binding.credentialCiphertext)
    await telegramGetMe(secret.token).catch((e: Error) => { throw new HttpError(502, e.message) })
    await telegramDeleteWebhook(secret.token).catch((e: Error) => { throw new HttpError(502, e.message) })
    await telegramSetMyCommands(secret.token).catch((e: Error) => { throw new HttpError(502, e.message) })
    const next = await db.updateChannelBinding(binding.id, { status: 'active', lastError: null, pollLastError: null, pollLeaseUntil: null })
    json(res, 200, { channel: await fullBinding(ctx, next) })
  })

  /** 换 Telegram 身份：旧身份立即失效，新码仍然只允许在私聊里消费一次。 */
  router.post('/channels/:id/pairing-code', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const binding = await db.channelBinding(req.params.id)
    if (!binding || binding.accountId !== account.id) throw new HttpError(404, '渠道不存在')
    const old = decryptChannelSecret<StoredSecret>(channelKey, binding.credentialCiphertext)
    const pairingCode = newPairingCode()
    await db.tx(async () => {
      await db.lockChannelBinding(binding.id)
      await db.deleteChannelIdentities(binding.id)
      await db.updateChannelBinding(binding.id, {
        pairingCodeHash: pairingCodeHash(pairingCode),
        credentialCiphertext: encryptChannelSecret(channelKey, { token: old.token, pairingCode } satisfies StoredSecret),
        status: 'active', lastError: null,
      })
    })
    await db.audit({
      companyId: account.companyId!, accountId: account.id, action: 'channel.telegram.pairing.reset',
      detail: { id: binding.id, botId: binding.botId },
    })
    json(res, 200, { channel: await fullBinding(ctx, (await db.channelBinding(binding.id))!), pairingCode })
  })

  router.delete('/channels/:id', async (req, res) => {
    const account = await requireUser(req, db, keys)
    requireSeat(account)
    const binding = await db.channelBinding(req.params.id)
    if (!binding || binding.accountId !== account.id) throw new HttpError(404, '渠道不存在')
    await db.deleteChannelBinding(binding.id)
    await db.audit({
      companyId: account.companyId!, accountId: account.id, action: 'channel.telegram.unbind',
      detail: { id: binding.id, botId: binding.botId, externalBotId: binding.externalBotId },
    })
    json(res, 200, { deleted: true, botId: binding.botId })
  })
}
