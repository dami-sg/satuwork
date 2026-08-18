import { mkdirSync } from 'node:fs'
import { Db, databaseUrl } from './db.ts'
import { hashPassword, loadKeys } from './crypto.ts'
import { Router, listen } from './http.ts'
import { gatewayHome } from './home.ts'
import { attach } from './routes.ts'

/**
 * Satuwork Gateway。控制面：公司、账号、套餐、席位、目录、JWT。
 *
 * 聊天不进这个进程。数据在 PostgreSQL；磁盘上只留 JWT 密钥对和 Bot 发布包——
 * 那两样重启不能变，也不适合塞进库里。
 */
const home = gatewayHome()
mkdirSync(home, { recursive: true })
const url = databaseUrl()
// 连接串里有口令，日志只留 host/库名。
const shown = url.replace(/\/\/[^@]*@/, '//')
console.log(`satuwork-gateway: 数据目录 ${home}${process.env.SATUWORK_GATEWAY_HOME ? '（来自 $SATUWORK_GATEWAY_HOME）' : ''}`)
console.log(`satuwork-gateway: 数据库 ${shown}${process.env.GATEWAY_PG_SCHEMA ? `（schema ${process.env.GATEWAY_PG_SCHEMA}）` : ''}`)

const db = new Db({ url })
await db.init()

/**
 * 可选的自动播种。**没有它也能起**：一个 owner 都没有时，打开页面就是「创建系统
 * 管理员」那一屏。这条留给自动化（e2e、容器编排）在无人值守时把第一个人写进去。
 */
async function seedOwner() {
  if (process.env.GATEWAY_SEED_OWNER === '0') return
  if ((await db.owners()).length) return
  const password = process.env.GATEWAY_OWNER_PASSWORD
  if (!password) {
    console.log('satuwork-gateway: 还没有系统管理员，打开首页按提示创建')
    return
  }
  const email = (process.env.GATEWAY_OWNER_EMAIL || 'owner@satuwork.test').trim().toLowerCase()
  const passwordHash = await hashPassword(password)
  await db.insertAccount({ companyId: null, email, passwordHash, role: 'owner' })
  console.log(`satuwork-gateway: 已写入系统管理员 ${email}`)
}

async function liftCompanyData() {
  const lifted = await db.liftCompanyDataToPlatform()
  if (lifted.settings) console.log('satuwork-gateway: 已把公司日常/utility 提升为平台设置')
  for (const provider of lifted.providers) {
    console.log(`satuwork-gateway: 已把供应商 ${provider} 提升为平台密钥`)
  }
}

await seedOwner()
await liftCompanyData()

// 公司的订阅是订单算出来的：起来时对一遍，把到期没人碰的、以及旧规则（当时未付款也写
// 订阅）留下的脏值收干净。
const resynced = await db.syncAllPlansFromOrders()
if (resynced) console.log(`satuwork-gateway: 已按订单重算 ${resynced} 家公司的订阅`)

const keys = loadKeys(home)
const router = new Router()
attach(router, db, keys)
const server = listen(router)

let closing = false
function shutdown() {
  if (closing) return
  closing = true
  server.close(() => {
    void db.close()
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
