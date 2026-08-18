/**
 * 给一家公司配一台机器。取代了原来 `PUT /platform/orgs/:id/machine` 那一段 SSH 绑定。
 *
 * 走的是真流程：owner 生成配对码 → 「机器」拿码换 `smt_`。Gateway 会立刻回拨一次
 * `GET /health` 确认可达——**e2e 里默认没有管家在听，所以 reachable 是 false**，
 * 这不是失败，配对本身照样成立。要测反代的用例自己先把管家起起来。
 */
export async function pairMachine({ req, gwBase, ownerTok, orgId, managerPort = 18999, challenge = '' }) {
  const code = await req(gwBase, 'POST', `/platform/orgs/${encodeURIComponent(orgId)}/pairing-code`, { token: ownerTok })
  if (code.status !== 201) throw new Error(`pairing-code ${code.status} ${code.text}`)
  const paired = await req(gwBase, 'POST', '/machines/pair', {
    body: {
      code: code.json.code,
      managerPort,
      hostname: 'e2e',
      managerVersion: 'e2e',
      protocol: 1,
      ...(challenge ? { challenge } : {}),
    },
  })
  if (paired.status !== 201) throw new Error(`pair ${paired.status} ${paired.text}`)
  return {
    code: code.json.code,
    installCommand: code.json.installCommand,
    machineId: paired.json.machineId,
    token: paired.json.token,
    host: paired.json.host,
    reachable: paired.json.reachable,
  }
}
