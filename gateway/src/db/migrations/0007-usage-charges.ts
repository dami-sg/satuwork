/**
 * 0007 · 计费账本。
 *
 * 三条会花钱的路——模型（`llm_calls`）、连接器（`connector_calls`）、网页工具
 * （`web_calls`）——此前各记各的钱：模型压根不记，另两条各有一列自己的金额，单位还
 * 不一样（微元 vs 厘）。于是「这家公司还剩多少额度」这个问题没有一个地方答得了，
 * 而它是每一次调用都要问一遍的。
 *
 * 这张表是**钱的唯一去处**。领域表继续记各自的事实（token、耗时、抓了几条），
 * 靠 `refId` 串回去；钱只在这里。
 *
 * 为什么不是三张表各加金额列：熔断判定在每一次模型调用的热路径上。一张表一条 sum，
 * 三张表就是三条 sum 加一次加法——而且第四种计费方式出现的那天（文档提取、桌面时长），
 * 加漏一条就是白送。
 *
 * ## 下面那个 `multiplier real` 别照抄
 *
 * float4 存不下 1.2（写进去读回来是 1.2000000476837158，会原样画到计费明细上）。
 * 迁移 0009 已经把它换成 double precision。这一行冻在这儿是因为**已经跑过的迁移不能
 * 改**——校验和是对下面那段 SQL 算的，往里加一行注释都会让下次起进程被 migrate.ts
 * 拦下来（「在应用之后被改过」）。这段说明只能待在模板字符串外面。
 */
export const SQL = `
  create table if not exists usage_charges (
    id             text primary key,
    -- null = owner 自己发起的调用。照样记账，但没有公司余额可扣，也不熔断。
    "companyId"    text,
    "accountId"    text not null,
    -- 哪颗 Bot、哪条会话。**现在只有连接器那条路填得上 botId**（席位调用时带在
    -- query 上），模型那条两个都是 null：/v1 收到的是一个 OpenAI 兼容请求，里面
    -- 没有会话这个概念。留着这两列是因为「这笔钱是哪次对话花的」迟早要答，而那时
    -- 补数据比补列容易。
    --
    -- （注意：这段 SQL 在一个模板字符串里，注释里不能出现反引号。）
    "botId"        text,
    "sessionId"    text,
    kind           text not null check (kind in ('llm', 'connector', 'web')),
    -- 收费对象的字面量：'anthropic/claude-haiku-4-5' / 'gmail:GMAIL_SEND_EMAIL' /
    -- 'tavily:search'。存字面量不存外键——连接器下架、模型从目录里删掉之后，
    -- 上个月的账还得看得懂（同 llm_calls / connector_calls 的处理）。
    subject        text not null,
    status         text not null check (status in ('ok', 'failed', 'timeout', 'denied', 'error')),
    -- 计量明细。kind 决定里面有什么：llm 是四项 token，connector 空，web 是 { units }。
    -- 用 jsonb 而不是摊成列：摊开是五列、每行只用得上两三列，而且每加一种计费方式就
    -- 要加一次列。这两个字段只被「查一行的明细」读，不参与聚合，不需要索引。
    quantity       jsonb not null default '{}',
    -- 写行那一刻的单价快照。**「为什么收这么多」唯一说得清的地方。**
    -- 有它才敢说金额不重算：单价改了，历史行照旧解释得通。
    "unitPrice"    jsonb not null default '{}',
    multiplier     real not null default 1,
    -- 这一笔一共多少微元，其中多少由套餐赠送承担；差额 = 充值承担。
    -- 两个桶必须分开记，理由见迁移 0005：合成一个数的话，套餐一到期，它已经花掉的
    -- 部分会从充值余额上再扣一遍。
    "amountMicros" bigint not null default 0,
    "bonusMicros"  bigint not null default 0,
    -- 查不到单价。金额是 0，但那**不等于免费**——界面要据此喊出来，不然 $0.00 会被
    -- 读成「这个模型不要钱」。
    unpriced       boolean not null default false,
    -- 指回 llm_calls / connector_calls / web_calls 的那一行。不设外键：那三张表本来
    -- 就允许行被清理，账本不能跟着被级联删掉。
    "refId"        text,
    "createdAt"    bigint not null
  );
  -- 余额判定（按公司 sum）和计费明细（按公司倒序翻页）都走第一条。
  create index if not exists usage_company_time on usage_charges ("companyId", "createdAt" desc);
  create index if not exists usage_account_time on usage_charges ("accountId", "createdAt" desc);
  create index if not exists usage_company_kind on usage_charges ("companyId", kind, "createdAt" desc);
  -- 领域表那几张统计要按 refId 把金额接回去（connector_calls 有 label / tool / 耗时
  -- 这些账本里没有的维度，钱在账本里），所以这一条是连接的那一头。
  create index if not exists usage_ref on usage_charges ("refId");
`
