/**
 * 转人工的交接单（见 docs/handoff.md）。
 *
 * 为什么在 Gateway 也要有一张表：待办要**跨 Bot、跨机器**，还要指派给不是这颗 Bot
 * 主人的人（公司管理员）。一台席位只知道自己那个账号的事，而"谁该来处理这件事"这个
 * 问题在那儿根本表达不出来。
 *
 * **正文不落这里。** 和会话索引同一条口径（gateway-runtime.md §10）：这张表存的是
 * 「有这么一张单、归谁、什么状态」，`reason` / `ask` 各留一段供列表显示，全文点进去时
 * 从席位拉。
 */
export const SQL = `
  create table if not exists handoffs (
    id           text primary key,
    "sessionId"  text not null,
    "botId"      text not null,
    -- 这颗 Bot 归谁。**不是**接手人：交接的意义正在于这两者可以不是同一个人。
    "accountId"  text not null references accounts(id) on delete cascade,
    "companyId"  text not null references companies(id) on delete cascade,
    -- 拉全文、发交还都要敲这台机器。服务端算出来的，不收上报方指定。
    "machineId"  text,
    state        text not null check (state in ('open','claimed','returned','closed','expired','cancelled')),
    -- 指派解算之后的结果。**null = 全体管理员**（模版上写的是 admin，或者指定的人已经离职）。
    assignee     text references accounts(id) on delete set null,
    -- 谁真的接了。抢单的 CAS 在席位那一个进程里（一条会话只有一台席位），这边只跟着记。
    "claimedBy"  text references accounts(id) on delete set null,
    -- 人不处理这件事是不是就停在这儿。日常任务据此决定跳不跳过这一次。
    blocking     boolean not null default true,
    -- 同一件事被合并进来几次（模型换个措辞又撞了一次）。
    repeats      integer not null default 0,
    reason       text not null default '',
    ask          text not null default '',
    -- 催办推到第几档：0 没推过，1 推过一次，2 已升级给管理员。重启之后不会从头再推一遍。
    "notifyStep" integer not null default 0,
    "createdAt"  bigint not null,
    "claimedAt"  bigint,
    "returnedAt" bigint,
    "closedAt"   bigint,
    "updatedAt"  bigint not null
  );
  -- 待办页和催办扫描都是这个条件：一家公司里还没闭合的那几张。
  create index if not exists handoff_live on handoffs ("companyId", state) where state in ('open','claimed','returned');
  -- 会话里那张卡片、以及「这条会话上还有没有挡路的单子」。
  create index if not exists handoff_of_session on handoffs ("sessionId", "createdAt" desc);
  -- 顶栏那个计数：指给我的 + 我名下的。
  create index if not exists handoff_assignee on handoffs (assignee, state);
`
