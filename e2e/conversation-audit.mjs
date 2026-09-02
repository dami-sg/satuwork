import { runProbe } from './probe.mjs'
import { PG_URL } from './pg.mjs'
import { schemaOf } from './isolate.mjs'

export async function runConversationAudit({ root, test, assert, log }) {
  log('\n# conversation-audit')
  const gateway = await runProbe(root, 'gateway/e2e-conversation-audit.mjs', {
    env: {
      E2E_DATABASE_URL: PG_URL,
      E2E_AUDIT_SCHEMA: schemaOf('e2e_conversation_audit'),
      GATEWAY_PG_RESET: '1',
      GATEWAY_AUDIT_GRACE_MS: '0',
    },
  })
  const bot = await runProbe(root, 'bot/e2e-conversation-audit.mjs')
  for (const [side, result] of [['Gateway', gateway], ['Bot', bot]]) {
    for (const [group, checks] of Object.entries(result)) {
    for (const [name, ok] of Object.entries(checks)) {
        await test(`${side} ${group}：${name}`, () => assert(ok === true, `${side} ${group}：${name} 不成立`))
      }
    }
  }
}
