import { mkdirSync } from 'node:fs'
import { Db } from './db.ts'
import { hashPassword, loadKeys } from './crypto.ts'
import { Router, listen } from './http.ts'
import { gatewayHome } from './home.ts'
import { attach } from './routes.ts'

/**
 * Satuwork Gateway。控制面：公司、账号、套餐、席位、目录、JWT。
 *
 * 聊天不进这个进程。跑的是自己的包、自己的库，跟 Bot 框架不是一棵树。
 */
const home = gatewayHome()
mkdirSync(home, { recursive: true })
const dbPath = gatewayHome('gateway.db')
console.log(`satuwork-gateway: 数据目录 ${home}${process.env.SATUWORK_GATEWAY_HOME ? '（来自 $SATUWORK_GATEWAY_HOME）' : ''}`)
console.log(`satuwork-gateway: 数据库 ${dbPath}`)

const db = new Db(dbPath)

async function seedOwner() {
  if (process.env.GATEWAY_SEED_OWNER === '0') return
  if (db.owners().length) return
  const password = process.env.GATEWAY_OWNER_PASSWORD
  if (!password) {
    console.log('satuwork-gateway: 未设置 GATEWAY_OWNER_PASSWORD，跳过写入系统管理员')
    return
  }
  const email = (process.env.GATEWAY_OWNER_EMAIL || 'owner@satuwork.test').trim().toLowerCase()
  const passwordHash = await hashPassword(password)
  db.insertAccount({ companyId: null, email, passwordHash, role: 'owner' })
  console.log(`satuwork-gateway: 已写入系统管理员 ${email}`)
}

function liftCompanyData() {
  const lifted = db.liftCompanyDataToPlatform()
  if (lifted.settings) console.log('satuwork-gateway: 已把公司日常/utility 提升为平台设置')
  for (const provider of lifted.providers) {
    console.log(`satuwork-gateway: 已把供应商 ${provider} 提升为平台密钥`)
  }
}

await seedOwner()
liftCompanyData()

const keys = loadKeys(home)
const router = new Router()
attach(router, db, keys)
const server = listen(router)

function shutdown() {
  server.close()
  db.close()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
