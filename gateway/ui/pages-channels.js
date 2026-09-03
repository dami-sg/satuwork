/** 外部消息渠道。目前接入 Telegram。 */

async function loadChannels() {
  const data = await api('GET', '/channels')
  state.channels = Array.isArray(data.channels) ? data.channels : []
}

function channelStatus(c) {
  if (!c) return ['未绑定', 'Not connected', 'tag-neutral']
  if (c.status === 'active' && !c.paired) return ['等待配对', 'Pairing required', 'tag-accent']
  if (c.status === 'active' && c.runtime?.status === 'ready') return ['已连接', 'Connected', 'tag-accent-2']
  if (c.status === 'active') return ['Bot 部署中', 'Bot deploying', 'tag-accent']
  if (c.status === 'binding') return ['绑定中', 'Connecting', 'tag-accent']
  if (c.status === 'paused') return ['已暂停', 'Paused', 'tag-neutral']
  return ['异常', 'Error', 'tag-warn']
}

function channelBindModal() {
  if (!state.channelBindOpen) return ''
  return `<div class="gw-modal-backdrop" data-act="channel-bind-close">
    <div class="gw-modal" style="max-width: 520px;" data-stop>
      <div>
        <h2 style="font-size: 20px; margin: 0 0 4px;">${t('绑定 Telegram Bot', 'Connect Telegram bot')}</h2>
        <p style="margin: 0; font-size: 13px; color: var(--muted-foreground);">${t(
          '在 Telegram 中向 @BotFather 创建 Bot，然后把 token 粘贴到这里。系统会创建 telegram bot，并生成一个只能在私聊中使用的配对码。',
          'Create a bot with @BotFather, then paste its token here. Satuwork creates telegram bot and a pairing code that can only be used in a private chat.',
        )}</p>
      </div>
      ${state.channelBindError ? `<div class="gw-flash gw-flash-err">${esc(state.channelBindError)}</div>` : ''}
      <form id="channel-bind-form" style="display: flex; flex-direction: column; gap: var(--space-4);">
        <div class="field">
          <label for="channel-token">Bot token</label>
          <input class="input" id="channel-token" name="token" type="password" autocomplete="off" placeholder="123456789:AA…" required>
          <span style="font-size: 12px; color: var(--muted-foreground);">${t('Token 会加密保存，绑定后不会再次显示。', 'The token is encrypted at rest and is never shown again.')}</span>
        </div>
        <div style="border: 1px solid var(--border); border-radius: 12px; padding: var(--space-3); font-size: 13px; color: var(--muted-foreground);">
          ${t('这是一个私人 Bot：同时只能配对一个 Telegram 用户，仅接收私聊，不处理任何群聊消息。', 'This is a private bot: it pairs with one Telegram user at a time, accepts private chats only, and ignores every group message.')}
        </div>
        <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
          <button type="button" class="btn btn-secondary" data-act="channel-bind-close">${t('取消')}</button>
          <button type="submit" class="btn btn-primary" ${state.busy ? 'disabled' : ''}>${state.busy ? t('绑定中…', 'Connecting…') : t('绑定并创建 Bot', 'Connect and create bot')}</button>
        </div>
      </form>
    </div>
  </div>`
}

function telegramChannelCard(c) {
  const [zh, en, cls] = channelStatus(c)
  return `<div class="satu-panel" style="gap: var(--space-4);">
    <div style="display: flex; align-items: flex-start; gap: var(--space-3);">
      <span style="width: 42px; height: 42px; flex: none; border-radius: 12px; display: grid; place-items: center; background: #229ed9; color: white; font-weight: 700;">TG</span>
      <div style="min-width: 0; flex: 1;">
        <div style="display: flex; align-items: center; gap: var(--space-2); flex-wrap: wrap;">
          <b>Telegram</b><span class="tag ${cls}">${t(zh, en)}</span>
        </div>
        <p style="margin: 4px 0 0; font-size: 13px; color: var(--muted-foreground);">${c
          ? t(`@${c.externalUsername || c.externalBotId} · 关联 ${c.bot?.name || 'telegram bot'}`, `@${c.externalUsername || c.externalBotId} · ${c.bot?.name || 'telegram bot'}`)
          : t('把 Telegram 私聊接入 Satuwork。Web 和 Telegram 消息会混合在同一条 Bot 对话中，并显示来源标签。', 'Connect a private Telegram chat to Satuwork. Web and Telegram messages share one bot conversation and show their source labels.')}</p>
      </div>
    </div>
    ${c?.lastError ? `<div class="gw-flash gw-flash-err" style="margin: 0;">${esc(c.lastError)}</div>` : ''}
    ${c && !c.paired && c.pairingCode ? `<div style="border: 1px solid var(--border); border-radius: 12px; padding: var(--space-4); background: var(--muted);">
      <div style="font-size: 12px; color: var(--muted-foreground); margin-bottom: var(--space-2);">${t('在 Telegram 中私聊这个 Bot，并发送一次性配对码', 'Open a private chat with this bot in Telegram and send the one-time pairing code')}</div>
      <code style="display: block; font-size: 24px; letter-spacing: .12em; font-weight: 700; user-select: all;">${esc(c.pairingCode)}</code>
      <div style="font-size: 12px; color: var(--muted-foreground); margin-top: var(--space-2);">${t('配对完成前，任何消息都不会进入 AI。配对码只能在私聊中使用一次。', 'No message reaches the AI before pairing. The code can be used once and only in a private chat.')}</div>
    </div>` : ''}
    ${c?.pairedIdentity ? `<div style="border: 1px solid var(--border); border-radius: 12px; padding: var(--space-3); font-size: 13px;">
      <span style="color: var(--muted-foreground);">${t('已配对身份', 'Paired identity')}</span><br>
      <b>${esc(c.pairedIdentity.externalDisplayName || c.pairedIdentity.externalUserId)}</b>${c.pairedIdentity.externalUsername ? ` · @${esc(c.pairedIdentity.externalUsername)}` : ''}
    </div>` : ''}
    ${c ? `<div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-3); font-size: 13px;">
      <div><span style="color: var(--muted-foreground);">${t('最近收到', 'Last received')}</span><br>${esc(c.lastReceivedAt ? fmtTime(c.lastReceivedAt) : t('还没有消息', 'No messages yet'))}</div>
      <div><span style="color: var(--muted-foreground);">${t('使用范围', 'Scope')}</span><br>${t('单用户私聊', 'One private user')}</div>
    </div>` : ''}
    <div style="display: flex; justify-content: flex-end; gap: var(--space-2);">
      ${!c
        ? `<button type="button" class="btn btn-primary" data-act="channel-bind-open">${t('绑定 Telegram', 'Connect Telegram')}</button>`
        : `${c.status === 'error' ? `<button type="button" class="btn btn-secondary" data-act="channel-reconnect" data-id="${esc(c.id)}">${t('重新连接', 'Reconnect')}</button>` : ''}
           <button type="button" class="btn btn-secondary" data-act="channel-pair-reset" data-id="${esc(c.id)}">${c.paired ? t('更换配对账号', 'Change paired account') : t('重新生成配对码', 'New pairing code')}</button>
           <button type="button" class="btn btn-ghost" data-act="channel-unbind" data-id="${esc(c.id)}">${t('解除绑定', 'Disconnect')}</button>`}
    </div>
  </div>`
}

function channelsPage() {
  const telegram = (state.channels || []).find((c) => c.kind === 'telegram')
  return `<div class="gw-page">
    <div class="gw-page-inner" style="max-width: 920px;">
      <div><h1 style="font-size: 24px; margin: 0 0 4px;">${t('渠道', 'Channels')}</h1>
      <p style="margin: 0; font-size: 14px; color: var(--muted-foreground);">${t('让外部消息进入你的 Bot。渠道会话仍使用现有的审计和用量规则。', 'Let external messages reach your bots. Channel conversations use the same audit and usage rules.')}</p></div>
      ${flashes()}
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: var(--space-4);">
        ${telegramChannelCard(telegram)}
      </div>
    </div>
    ${channelBindModal()}
  </div>`
}

async function submitChannelBinding(e) {
  e.preventDefault()
  const fd = new FormData(e.target)
  state.busy = true
  state.channelBindError = ''
  render()
  try {
    const data = await api('POST', '/channels/telegram', {
      token: String(fd.get('token') || '').trim(),
    })
    state.channelBindOpen = false
    await Promise.all([loadChannels(), loadRuntimeBots().catch(() => {})])
    if (data.channel?.status === 'error') flash('err', data.channel.lastError || t('Telegram 长轮询启动失败', 'Telegram polling failed to start'))
    else if (data.deployError) flash('err', t(`渠道已绑定，但 Bot 暂未部署：${data.deployError}`, `Channel connected, but the bot is not deployed yet: ${data.deployError}`))
    else flash('ok', t('Telegram 已绑定，请把页面上的配对码发送给 Bot', 'Telegram connected. Send the pairing code shown on this page to the bot.'))
  } catch (err) {
    state.channelBindError = err.message
  } finally {
    state.busy = false
    render()
  }
}

async function channelAct(act, btn) {
  if (!act || !act.startsWith('channel-')) return false
  if (act === 'channel-bind-open') { state.channelBindOpen = true; state.channelBindError = ''; render(); return true }
  if (act === 'channel-bind-close') { state.channelBindOpen = false; state.channelBindError = ''; render(); return true }
  if (act === 'channel-unbind') {
    state.confirm = {
      kind: 'channel-unbind', id: btn.getAttribute('data-id'), title: t('解除 Telegram 绑定？', 'Disconnect Telegram?'),
      body: t('系统会停止长轮询并删除保存的 token；telegram bot 与历史会话会保留。', 'Polling will stop and the saved token will be removed. The Satuwork bot and conversation history stay.'),
      label: t('解除绑定', 'Disconnect'),
    }
    render(); return true
  }
  if (act === 'channel-pair-reset') {
    state.confirm = {
      kind: 'channel-pair-reset', id: btn.getAttribute('data-id'),
      title: t('重新生成配对码？', 'Generate a new pairing code?'),
      body: t('当前已配对的 Telegram 身份会立即失效，必须使用新码重新配对。', 'The currently paired Telegram identity will be revoked immediately and must pair again with the new code.'),
      label: t('生成新配对码', 'Generate new code'),
    }
    render(); return true
  }
  if (act === 'channel-reconnect') {
    state.busy = true; render()
    try {
      await api('POST', `/channels/${encodeURIComponent(btn.getAttribute('data-id'))}/reconnect`, {})
      await loadChannels(); flash('ok', t('Telegram 已重新连接', 'Telegram reconnected'))
    } catch (err) { flash('err', err.message) }
    finally { state.busy = false; render() }
    return true
  }
  return false
}
