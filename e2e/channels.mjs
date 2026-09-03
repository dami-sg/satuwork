/**
 * 渠道绑定：用本地 Telegram API 验完整控制面，不依赖公网或真实 token。
 */
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { rmSync } from 'node:fs'
import { PG_URL } from './pg.mjs'
import { schemaOf, tmpOf } from './isolate.mjs'
import { freePort } from './ports.mjs'
import { createCompany } from './org.mjs'
import { closeServer } from './probe.mjs'
import { runProbe } from './probe.mjs'

const TOKEN = '123456789:telegram-e2e-token-never-store-plain'
const APPROVAL_KEY = 'AbCdEfGhIjKlMnOpQrStUv'
const APPROVAL_EMAIL_BODY = [
  'Hi,',
  '',
  '这是一封需要完整展示的审批邮件。',
  `详细内容：${'很长但不能省略。'.repeat(80)}`,
  '',
  '- 第一项',
  '- 第二项',
  '',
  '——完整正文结尾——',
].join('\n')

async function mockSeat() {
  const seen = { messages: [], approvals: [], approved: false, successfulApprovals: 0 }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch {}
      const path = new URL(req.url, 'http://seat.test').pathname
      res.setHeader('content-type', 'application/json')
      if (/\/api\/channels\/[^/]+\/messages$/.test(path)) {
        seen.messages.push(body)
        if (!seen.approved) {
          res.statusCode = 202
          res.end(JSON.stringify({
            status: 'approval', sessionId: 'session-telegram',
            approval: {
              key: APPROVAL_KEY, callId: 'tool-call-secret', name: 'mcp_mail_send',
              arguments: JSON.stringify({ to: 'alice@example.test', subject: '测试' }),
              reason: '即将向外部系统发送内容，需要确认。',
              form: { kind: 'email', tool: 'MAIL_SEND', fields: [
                { key: 'to', label: '收件人', value: 'alice@example.test' },
                { key: 'subject', label: '主题', value: '测试', editable: true },
                { key: 'body', label: '正文', value: APPROVAL_EMAIL_BODY, editable: true, multiline: true },
              ] },
            },
          }))
          return
        }
        res.end(JSON.stringify({ sessionId: 'session-telegram', reply: '审批通过，操作已经完成。' }))
        return
      }
      if (/\/api\/channels\/[^/]+\/approvals\/[A-Za-z0-9_-]+$/.test(path)) {
        seen.approvals.push({ path, body })
        if (seen.approved) {
          res.statusCode = 409
          res.end(JSON.stringify({ error: '这条确认已经结束了' }))
          return
        }
        seen.approved = true
        seen.successfulApprovals += 1
        res.end(JSON.stringify({ ok: true, ...body }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ error: `unknown ${path}` }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` }
}

async function mockTelegram() {
  const seen = {
    deleteWebhook: 0, commands: [], leaveChats: [], sent: [], chatActions: [], polls: [], updates: [],
    callbackAnswers: [], callbackAnswerAttempts: [], editedMarkups: [],
  }
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      const url = new URL(req.url, 'http://telegram.test')
      const method = url.pathname.replace(`/bot${TOKEN}/`, '')
      let body = {}
      try { body = JSON.parse(raw || '{}') } catch {}
      const send = (result) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, result }))
      }
      if (method === 'getMe') return send({ id: 88776655, is_bot: true, first_name: 'E2E', username: 'satuwork_e2e_bot' })
      if (method === 'deleteWebhook') {
        seen.deleteWebhook += 1
        return send(true)
      }
      if (method === 'setMyCommands') {
        seen.commands = body.commands || []
        return send(true)
      }
      if (method === 'sendMessage') {
        seen.sent.push({ method, ...body })
        return send({ message_id: seen.sent.length })
      }
      if (method === 'sendRichMessage') {
        seen.sent.push({ method, ...body })
        return send({ message_id: seen.sent.length })
      }
      if (method === 'sendChatAction') {
        seen.chatActions.push(body)
        return send(true)
      }
      if (method === 'answerCallbackQuery') {
        seen.callbackAnswerAttempts.push(body)
        if (body.callback_query_id === 'callback-expired') {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: query is too old and response timeout expired or query ID is invalid',
          }))
          return
        }
        seen.callbackAnswers.push(body)
        return send(true)
      }
      if (method === 'editMessageReplyMarkup') {
        seen.editedMarkups.push(body)
        return send({ message_id: body.message_id })
      }
      if (method === 'leaveChat') {
        seen.leaveChats.push(String(body.chat_id))
        return send(true)
      }
      if (method === 'getUpdates') {
        const offset = Number(body.offset || 0)
        seen.polls.push(body)
        return send(seen.updates.filter((u) => Number(u.update_id) >= offset))
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, description: `unknown ${method}` }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, seen, url: `http://127.0.0.1:${server.address().port}` }
}

async function waitFor(check, label, timeout = 6000) {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const value = await check()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`等不到：${label}`)
}

export async function runChannels({ gwRoot, test, req, start, waitHttp, assert, log }) {
  const GW_HOME = tmpOf('satuwork-e2e-channels')
  const GW_PORT = await freePort()
  const base = `http://127.0.0.1:${GW_PORT}`
  const schema = schemaOf('e2e_channels')
  rmSync(GW_HOME, { recursive: true, force: true })
  log('\n# channels')

  const telegram = await mockTelegram()
  const seat = await mockSeat()
  const gw = start('channels-gw', ['--import', 'tsx', `${gwRoot}/src/index.ts`], {
    cwd: gwRoot,
    env: {
      SATUWORK_GATEWAY_HOME: GW_HOME,
      GATEWAY_DATABASE_URL: PG_URL,
      GATEWAY_PG_SCHEMA: schema,
      GATEWAY_PG_RESET: '1',
      GATEWAY_HOST: '127.0.0.1',
      GATEWAY_PORT: String(GW_PORT),
      GATEWAY_ACCESS_HOST: 'satuwork.com',
      GATEWAY_SEED_OWNER: '0',
      TELEGRAM_API_BASE: telegram.url,
      GATEWAY_CHANNEL_TICK_MS: '600000',
      GATEWAY_CHANNEL_POLL_SCAN_MS: '250',
      GATEWAY_CHANNEL_POLL_TIMEOUT_SECONDS: '1',
    },
  })
  await waitHttp(`${base}/health`, { child: gw, what: 'channels gateway' })

  let token = ''
  let pairingCode = ''
  let bindingId = ''
  let botId = ''
  try {
    await test('短租约到期后可接管，旧 Gateway 不能续租或覆盖新结果', async () => {
      const result = await runProbe(new URL('..', import.meta.url).pathname, 'gateway/e2e-channel-event-lease.mjs', {
        env: {
          E2E_DATABASE_URL: PG_URL,
          E2E_CHANNEL_LEASE_SCHEMA: schemaOf('e2e_channel_lease'),
          GATEWAY_PG_RESET: '1',
        },
      })
      assert(result.oldClaim && result.oldRenew, `旧进程没有正常认领/续租：${JSON.stringify(result)}`)
      assert(result.earlyTakeover === false, `租约有效期内被提前接管：${JSON.stringify(result)}`)
      assert(result.takeover, `租约到期后没有接管：${JSON.stringify(result)}`)
      assert(result.staleRenew === false && result.staleCommit === false, `旧进程还能续租或回写：${JSON.stringify(result)}`)
      assert(result.saveReply && result.delivered, `接管者没有完成落盘与投递：${JSON.stringify(result)}`)
      assert(result.finalStatus === 'delivered' && result.finalReply === '接管后的回复' && result.leaseCleared,
        `最终状态不对：${JSON.stringify(result)}`)
    })

    await test('绑定 Telegram 时自动创建固定名称 Bot 和一次性配对码，token 不回显', async () => {
      const setup = await req(base, 'POST', '/auth/setup', {
        body: { email: 'owner@channels.test', name: 'owner', password: 'correct-horse-1' },
      })
      assert(setup.status === 201, `setup ${setup.status} ${setup.text}`)
      const company = await createCompany(req, base, {
        ownerToken: setup.json.token,
        email: 'admin@channels.test', password: 'correct-horse-2',
        companyName: 'Channels', slug: 'channels-co', topup: 0,
      })
      token = company.token

      const bound = await req(base, 'POST', '/channels/telegram', {
        token, body: { token: TOKEN, allowGroups: true },
      })
      assert(bound.status === 201, `bind ${bound.status} ${bound.text}`)
      assert(bound.json.channel.status === 'active', `status ${bound.text}`)
      assert(bound.json.channel.bot?.name === 'telegram bot', `Bot 名不对：${bound.text}`)
      assert(bound.json.channel.allowGroups === false, '即使客户端传 allowGroups 也不得开启群聊')
      assert(bound.json.channel.paired === false, '刚绑定不应已经配对')
      assert(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(bound.json.pairingCode), `配对码格式不对：${bound.text}`)
      assert(!bound.text.includes(TOKEN), '响应回显了 Telegram token')
      bindingId = bound.json.channel.id
      botId = bound.json.channel.botId
      pairingCode = bound.json.pairingCode

      assert(telegram.seen.deleteWebhook === 1, '绑定时没有清掉旧 Webhook')
      assert(telegram.seen.commands.map((c) => c.command).join(',') === 'new,tasks,mentions', 'Telegram 私聊命令菜单没有注册完整')
      await waitFor(() => telegram.seen.polls.length > 0, 'Gateway 发起 getUpdates')
      assert(telegram.seen.polls.every((p) => Array.isArray(p.allowed_updates)
        && p.allowed_updates.join(',') === 'message,callback_query,my_chat_member'), '长轮询没有订阅消息、审批回调和 Bot 成员状态')

      const bots = await req(base, 'GET', '/runtime/bots', { token })
      assert(bots.status === 200, `bots ${bots.status} ${bots.text}`)
      assert(bots.json.bots.some((b) => b.id === botId && b.name === 'telegram bot'), '自动创建的 Bot 不在名册里')
      assert(bots.json.bots.find((b) => b.id === botId)?.channel === 'telegram', '名册没有标明 Telegram 渠道归属')

      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      try {
        const stored = await client.query(`select "credentialCiphertext","pairingCodeHash" from "${schema}".channel_bindings where id = $1`, [bindingId])
        assert(stored.rowCount === 1, '数据库里没有渠道绑定')
        assert(!stored.rows[0].credentialCiphertext.includes(TOKEN), '数据库明文保存了 Telegram token')
        assert(!stored.rows[0].credentialCiphertext.includes(pairingCode), '数据库明文保存了配对码')
        assert(stored.rows[0].pairingCodeHash !== pairingCode, '配对码摘要列保存了明文')
      } finally { await client.end() }
    })

    await test('未配对消息不入队；私聊输入正确配对码后只接受该 Telegram 身份', async () => {
      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      const ownership = await client.query(`select "accountId","companyId" from "${schema}".channel_bindings where id = $1`, [bindingId])
      assert(ownership.rowCount === 1, '找不到渠道所属账号')
      await client.query(
        `insert into "${schema}".instances ("accountId","botId","companyId",host,"lastReadyAt") values ($1,$2,$3,$4,$5)
         on conflict ("accountId","botId") do update set host=excluded.host,"lastReadyAt"=excluded."lastReadyAt"`,
        [ownership.rows[0].accountId, botId, ownership.rows[0].companyId, seat.url, Date.now()],
      )
      telegram.seen.updates.push(
        // 正确码发在群里也不能配对，避免一次性口令被公开。
        { update_id: 9001, message: { message_id: 1, chat: { id: -100, type: 'supergroup', title: '团队群' }, from: { id: 456, is_bot: false, first_name: 'Alice' }, text: pairingCode } },
        { update_id: 9002, message: { message_id: 2, chat: { id: 999, type: 'private' }, from: { id: 999, is_bot: false, first_name: 'Mallory' }, text: '猜错了' } },
        { update_id: 9003, message: { message_id: 3, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'Alice', username: 'alice' }, text: pairingCode.toLowerCase() } },
      )
      await waitFor(async () => {
        const channels = await req(base, 'GET', '/channels', { token })
        return channels.json.channels?.[0]?.paired === true
      }, 'Telegram 身份完成配对')
      await waitFor(() => telegram.seen.leaveChats.includes('-100'), '私人 Bot 自动退出群聊')

      // 同一个 update 放两次，队列里仍只能有一条；陌生用户和群聊也不能进。
      const hello = { update_id: 9004, message: { message_id: 4, chat: { id: 456, type: 'private' }, from: { id: 456, is_bot: false, first_name: 'Alice', username: 'alice' }, text: '你好' } }
      telegram.seen.updates.push(hello, hello,
        { update_id: 9005, message: { message_id: 5, chat: { id: 999, type: 'private' }, from: { id: 999, is_bot: false, first_name: 'Mallory' }, text: '盗用' } },
        { update_id: 9006, message: { message_id: 6, message_thread_id: 88, chat: { id: -100, type: 'supergroup', title: '团队群' }, from: { id: 456, is_bot: false, first_name: 'Alice', username: 'alice' }, text: '群里的问题' } },
      )
      try {
        await waitFor(async () => {
          const events = await client.query(`select count(*)::int as n from "${schema}".channel_events where "bindingId" = $1`, [bindingId])
          return events.rows[0].n === 1
        }, '配对后的私聊消息进入队列')
        const events = await client.query(`select "externalConversationId" from "${schema}".channel_events where "bindingId" = $1 order by "externalEventId"`, [bindingId])
        assert(events.rowCount === 1, `重复、陌生用户或群聊 update 入队后共有 ${events.rowCount} 条`)
        assert(events.rows[0].externalConversationId === '456', '私聊会话 id 不对')
        const identities = await client.query(`select * from "${schema}".channel_identities where "bindingId" = $1`, [bindingId])
        assert(identities.rowCount === 1 && identities.rows[0].externalUserId === '456', '配对身份没有正确保存')
      } finally { await client.end() }
      const pairedReply = telegram.seen.sent.find((m) => String(m.rich_message?.markdown || m.text).includes('配对成功'))
      assert(pairedReply, 'Telegram 没收到配对成功提示')
      assert(pairedReply.method === 'sendRichMessage', '出站回复没有使用 Telegram RichMessage')
      assert(typeof pairedReply.rich_message?.markdown === 'string', 'RichMessage 没有传 markdown 内容')
      await waitFor(() => telegram.seen.chatActions.length > 0, 'Telegram 显示正在处理状态')
      assert(telegram.seen.chatActions.some((a) => String(a.chat_id) === '456' && a.action === 'typing'),
        '渠道消息进入处理时没有发送 typing chat action')
    })

    await test('配对用户可在 Telegram 审批，陌生用户不能批，重复点击不会重复执行', async () => {
      const prompt = await waitFor(
        () => telegram.seen.sent.find((m) => String(m.rich_message?.markdown || m.text).includes('需要你的批准')),
        'Telegram 收到审批卡',
      )
      assert(prompt.method === 'sendRichMessage', '审批卡没有使用 RichMessage')
      const promptMarkdown = String(prompt.rich_message?.markdown || '')
      assert(promptMarkdown.includes('### 邮件内容') && promptMarkdown.includes('### 正文'), '邮件审批没有按邮件结构排版')
      assert(promptMarkdown.includes('> Hi,') && promptMarkdown.includes('> - 第一项'), '邮件正文没有保留段落和列表格式')
      assert(promptMarkdown.includes('——完整正文结尾——'), '邮件正文仍被截断')
      assert(!promptMarkdown.includes("'''text"), '邮件正文的 Markdown 围栏仍被破坏')
      const buttons = prompt.reply_markup?.inline_keyboard?.flat() || []
      assert(buttons.length === 4, `审批按钮不是四个：${buttons.length}`)
      assert(buttons.every((b) => Buffer.byteLength(b.callback_data, 'utf8') <= 64), '审批按钮 callback_data 超过 64 字节')

      telegram.seen.updates.push({
        update_id: 9007,
        callback_query: {
          id: 'callback-unauthorized', data: `swa:${APPROVAL_KEY}:a1`, from: { id: 999 },
          message: { message_id: prompt.message_id || 1, chat: { id: 999, type: 'private' } },
        },
      })
      await waitFor(() => telegram.seen.callbackAnswers.find((a) => a.callback_query_id === 'callback-unauthorized'), '陌生用户审批被应答')
      assert(seat.seen.approvals.length === 0, '陌生 Telegram 用户触发了席位审批')

      telegram.seen.updates.push({
        update_id: 9008,
        callback_query: {
          id: 'callback-approved', data: `swa:${APPROVAL_KEY}:a1`, from: { id: 456 },
          message: { message_id: prompt.message_id || 1, chat: { id: 456, type: 'private' } },
        },
      })
      await waitFor(() => seat.seen.successfulApprovals === 1, '席位收到 Telegram 批准')
      await waitFor(() => telegram.seen.sent.some((m) => String(m.rich_message?.markdown || m.text).includes('审批通过，操作已经完成')), '审批后原轮次完成并回复')
      assert(seat.seen.approvals[0].body.decision === 'approve' && seat.seen.approvals[0].body.scope === 'once', '批准范围传错')
      assert(telegram.seen.callbackAnswers.some((a) => a.callback_query_id === 'callback-approved' && String(a.text).includes('已批准')), '批准回调没有应答')
      assert(telegram.seen.editedMarkups.some((m) => Array.isArray(m.reply_markup?.inline_keyboard) && m.reply_markup.inline_keyboard.length === 0), '审批完成后没有移除按钮')

      telegram.seen.updates.push({
        update_id: 9009,
        callback_query: {
          id: 'callback-duplicate', data: `swa:${APPROVAL_KEY}:a1`, from: { id: 456 },
          message: { message_id: prompt.message_id || 1, chat: { id: 456, type: 'private' } },
        },
      })
      await waitFor(() => telegram.seen.callbackAnswers.find((a) => a.callback_query_id === 'callback-duplicate'), '重复审批被应答')
      assert(seat.seen.successfulApprovals === 1, '重复点击导致二次批准')
      assert(telegram.seen.callbackAnswers.some((a) => a.callback_query_id === 'callback-duplicate' && String(a.text).includes('已经结束')), '重复点击没有提示审批已结束')
    })

    await test('过期审批回调不能毒死长轮询，后续私聊继续入队', async () => {
      const before = seat.seen.messages.length
      telegram.seen.updates.push(
        {
          update_id: 9010,
          callback_query: {
            id: 'callback-expired', data: `swa:${APPROVAL_KEY}:a1`, from: { id: 456 },
            message: { message_id: 1, chat: { id: 456, type: 'private' } },
          },
        },
        {
          update_id: 9011,
          message: {
            message_id: 11, chat: { id: 456, type: 'private' },
            from: { id: 456, is_bot: false, first_name: 'Alice', username: 'alice' },
            text: '过期按钮后面的正常消息',
          },
        },
      )
      await waitFor(() => telegram.seen.callbackAnswerAttempts.some((a) => a.callback_query_id === 'callback-expired'), '过期审批回调被处理')
      await waitFor(() => seat.seen.messages.length > before, '过期回调之后的正常消息送到席位')

      const require = createRequire(new URL('../gateway/package.json', import.meta.url))
      const pg = require('pg')
      const client = new pg.Client({ connectionString: PG_URL })
      await client.connect()
      try {
        const row = await waitFor(async () => {
          const result = await client.query(
            `select "pollOffset","pollLastError",status from "${schema}".channel_bindings where id=$1`,
            [bindingId],
          )
          return Number(result.rows[0]?.pollOffset) >= 9012 ? result.rows[0] : null
        }, '长轮询游标越过毒消息')
        assert(Number(row.pollOffset) >= 9012, `游标仍卡在 ${row.pollOffset}`)
        assert(row.status === 'active', `过期回调把整个渠道标成了 ${row.status}`)
        assert(row.pollLastError == null, `成功处理后仍留着轮询错误：${row.pollLastError}`)
      } finally { await client.end() }
    })

    await test('重新生成配对码会撤销旧身份', async () => {
      const reset = await req(base, 'POST', `/channels/${bindingId}/pairing-code`, { token, body: {} })
      assert(reset.status === 200, `reset pairing ${reset.status} ${reset.text}`)
      assert(reset.json.pairingCode !== pairingCode, '重新生成后配对码没有变化')
      assert(reset.json.channel.paired === false, '旧身份没有解除')
      assert(reset.json.channel.pairingCode === reset.json.pairingCode, '页面接口拿不到新配对码')
    })

    await test('同一账号不能重复绑定；解绑清渠道但保留 Bot', async () => {
      const duplicate = await req(base, 'POST', '/channels/telegram', { token, body: { token: TOKEN } })
      assert(duplicate.status === 409, `重复绑定拿到 ${duplicate.status} ${duplicate.text}`)

      const removed = await req(base, 'DELETE', `/channels/${bindingId}`, { token })
      assert(removed.status === 200, `unbind ${removed.status} ${removed.text}`)
      const channels = await req(base, 'GET', '/channels', { token })
      assert(channels.status === 200 && channels.json.channels.length === 0, `渠道没清掉：${channels.text}`)
      const bots = await req(base, 'GET', '/runtime/bots', { token })
      assert(bots.json.bots.some((b) => b.id === botId), '解绑不应顺手删除历史 Bot')
    })
  } finally {
    gw.kill()
    await closeServer(telegram.server, 'telegram mock')
    await closeServer(seat.server, 'seat mock')
  }
}
