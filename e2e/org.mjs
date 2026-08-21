/**
 * 建一家公司加它的管理员，**走产品真实的那条路**。
 *
 * 以前各套用例都打 `POST /auth/register`：一次无鉴权请求就能建出公司 + admin，
 * `seats` 还由请求体自己指定。那条路已经删了——它没有任何产品入口用（界面上建公司
 * 走的是 owner-only 的 `POST /platform/orgs`），却默认开着，任何能打到 Gateway 的人
 * 都能给自己开一家公司。测试用的捷径不该在生产上留一扇门。
 *
 * 换成这里的三步，和管理员在界面上做的完全一样：
 *
 *   1. owner 登录（各套用例起 Gateway 时都种了 owner）
 *   2. `POST /platform/orgs` 建公司 + 第一个管理员席位
 *   3. 要多于一席就 `PUT /platform/orgs/:id/plan`——建公司只开管理员那一席，
 *      加席位是订阅那一步的事
 *   4. 充一笔额度。**不是为了测计费，是为了公司能用**——余额熔断默认开着，
 *      余额为 0 的公司发不出任何要收钱的调用（模型、连接器、网页搜索）。生产上
 *      每家公司都会有订单，测试里的公司也该有。想验「余额为 0 会怎样」传
 *      `topup: 0`，或者去 e2e/billing.mjs——那一份就是专门验熔断的。
 *
 * 顺带好处：`/platform/orgs` 和 `/plan` 这两条产品路径每套用例都会走一遍。
 */

/**
 * @param req    run.mjs 里那个 req
 * @param base   Gateway 基址
 * @param opts   ownerToken 有就直接用，没有就拿 ownerEmail/ownerPassword 登一次
 * @returns `{ token, ownerToken, company, account }`——token 是**管理员**的票
 */
export async function createCompany(req, base, opts) {
  const {
    ownerToken,
    ownerEmail,
    ownerPassword,
    email,
    password,
    companyName,
    slug,
    seats = 1,
    topup = 100,
    contactName = '联系人',
    contactPhone = '+86 138 0000 0000',
  } = opts

  let ownerTok = ownerToken
  if (!ownerTok) {
    const login = await req(base, 'POST', '/auth/login', { body: { email: ownerEmail, password: ownerPassword } })
    if (login.status !== 200) throw new Error(`owner 登录失败 ${login.status} ${login.text}`)
    ownerTok = login.json.token
  }

  const created = await req(base, 'POST', '/platform/orgs', {
    token: ownerTok,
    body: {
      name: companyName,
      slug,
      contactName,
      contactPhone,
      contactEmail: email,
      adminEmail: email,
      adminPassword: password,
    },
  })
  if (created.status !== 201) throw new Error(`建公司失败 ${created.status} ${created.text}`)

  const company = created.json.company
  if (seats > 1) {
    const plan = await req(base, 'PUT', `/platform/orgs/${company.id}/plan`, { token: ownerTok, body: { seats } })
    if (plan.status !== 200) throw new Error(`设席位失败 ${plan.status} ${plan.text}`)
  }

  if (topup > 0) {
    const paid = await req(base, 'POST', '/platform/orders', {
      token: ownerTok,
      body: { companyId: company.id, kind: 'topup', amount: topup, payStatus: 'paid', note: 'e2e' },
    })
    if (paid.status !== 201) throw new Error(`充值失败 ${paid.status} ${paid.text}`)
  }

  // 管理员自己的票要自己登一次拿：建公司那条返回的是 owner 视角的结果，不带 admin 的票。
  const login = await req(base, 'POST', '/auth/login', { body: { email, password } })
  if (login.status !== 200) throw new Error(`管理员登录失败 ${login.status} ${login.text}`)

  return { token: login.json.token, ownerToken: ownerTok, company, account: login.json.account }
}
