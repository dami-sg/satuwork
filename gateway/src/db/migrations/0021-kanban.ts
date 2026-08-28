/**
 * 多 Bot 看板（见 docs/kanban.md）：板、成员、卡、依赖、时间线、每次执行的流水。
 *
 * **一块板归属一个员工**，成员只能是他自己名下的 Bot。所以 `boards.accountId` 是这几张
 * 表的总判据：卡派到哪台席位、文件在谁的 `~/work` 里、用量算谁的，全从它推出来。别人
 * 一个字都看不见（口径〇），管理员和平台 owner 也不例外。
 *
 * **为什么在 Gateway 而不在席位**：一台席位只认得自己那一颗 Bot，而板要横跨这个人的
 * 全部席位；何况席位随时会被重装，板不能跟着一起没（同 routines / handoffs）。
 *
 * **卡的正文落在这里，和会话索引口径不同，是有意的**（docs/kanban.md §5）：下游 Bot 在
 * 另一个席位上，读不到上游那条卡片会话，卡上这几段就是它全部的交底书；而「派卡」发生在
 * Gateway 的 tick 里，那一刻整台机器可能是关着的。
 */
export const SQL = `
  create table if not exists boards (
    id          text primary key,
    -- 归属一个员工。成员 Bot 必须都在他名下，所以这一列是**全表的判据**。
    "accountId" text not null references accounts(id) on delete cascade,
    -- 计费和隔离照旧在公司这一层。冗余一列是为了不用每次 join accounts。
    "companyId" text not null references companies(id) on delete cascade,
    name        text not null default '',
    -- 这块板上跑的活是什么。会进每张卡的执行包，当作板级的交底书——这样人就不用在
    -- 每张卡的 body 里把同一段背景抄一遍，而抄漏的那次没有任何东西会提醒他。
    brief       text not null default '',
    archived    boolean not null default false,
    "createdAt" bigint not null,
    "updatedAt" bigint not null
  );
  create index if not exists board_of_account on boards ("accountId") where not archived;

  -- 成员名单。**只有人能改**，模型只能在这张表里挑。
  --
  -- **没有 accountId 这一列**：成员恒等于板归属那个人名下的 Bot。存一份的话，它和
  -- boards.accountId 就有了两个事实源，而不一致的那天没有任何东西会响。
  create table if not exists board_members (
    "boardId"   text not null references boards(id) on delete cascade,
    "botId"     text not null references catalog_items(id) on delete cascade,
    -- 这颗 Bot 在这块板上干什么（「出图」「审校」「查资料」）。会出现在别的 Bot 的
    -- kanban_list 里——派活的那颗靠它挑人，没有它就只能按名字猜，而名字是人起的、
    -- 给自己看的（「小蓝」「阿吉」）。
    role        text not null default '',
    "addedAt"   bigint not null,
    primary key ("boardId", "botId")
  );

  create table if not exists cards (
    id          text primary key,
    "boardId"   text not null references boards(id) on delete cascade,
    -- 这两列都从板上冗余下来，为的是调度那条 SQL 不用 join：选卡要按账号数并发。
    "accountId" text not null references accounts(id) on delete cascade,
    "companyId" text not null references companies(id) on delete cascade,
    title       text not null default '',
    body        text not null default '',
    -- 派给哪颗 Bot。必须在 board_members 里，建卡和改派都验。
    -- 席位是 (cards.accountId, assigneeBotId) 那一对——**账号不从这里取**，从板上取。
    "assigneeBotId" text references catalog_items(id) on delete set null,
    state       text not null check (state in ('todo','ready','running','blocked','done','archived','cancelled')),
    priority    integer not null default 0,
    -- 人建的这一列空；Bot 建的记那颗 Bot。板归属谁已经在 accountId 上了，不重复存。
    "createdByBotId" text,
    "modelRole"   text not null default 'utility' check ("modelRole" in ('daily','utility')),
    -- 选这一档的理由。**给人看的**，不进模型。降过级的这里写降级后的实情。
    "modelReason" text not null default '',
    "modelDowngraded" boolean not null default false,
    "needsBrowser" boolean not null default false,
    "maxSteps"    integer not null default 60,
    -- 做完了要不要吭一声。report = 往做完它的那颗 Bot 的主会话发一条。
    -- **不叫 owner**：那个名字读起来像「发给板主人」，而它发给的是 assignee。
    notify        text not null default 'none' check (notify in ('none','report')),
    -- 跑在哪条会话上。点进去就是全文（去席位拉）。每次重试都会换一条。
    "sessionId"   text,
    -- 席位最后一次说「这张卡还活着」是什么时候（席位每 60 秒一次，模型不管）。
    -- **回收主要看它**，不看 startedAt：席位被 kill 之后心跳当场停，而墙钟还有 59 分钟
    -- 才到——那 59 分钟里界面上是一张正在跑的卡，跑它的进程早没了。
    "heartbeatAt" bigint,
    -- 失败了几次（上限 2 → blocked）、被打回几次（上限 2 → blocked）。
    attempt     integer not null default 0,
    reopens     integer not null default 0,
    -- 在这个时间之前别再派它。真失败等 5 分钟，busy / 静默只等一个 tick。
    -- null = 随时可派。没有它的话，一张撞了确定性错误的卡会在一分钟内烧完两次重试。
    "retryAfter" bigint,
    -- 结论，和交付证据（changed_files / verification / residual_risk…）。
    summary     text not null default '',
    metadata    jsonb,
    -- 为什么停住了。**给代码判的**（通知要不要推、算不算进待办计数）。
    -- 和下面那行人话**不合并**：把「要不要推」写成对 reason 文本的匹配，是把一个判断
    -- 挂在一句会被随手改掉的话上。
    "blockedKind" text check ("blockedKind" in ('by-model','failed','reopen-cap','stopped')),
    -- blocked 的原因，人话。人在板上看到的就是这一行。
    "blockedReason" text not null default '',
    -- 同一颗 Bot、同一个 title 指纹、**同一个 5 分钟时间桶**只建一张。
    -- 桶号一定要进指纹：不进的话，下面那条唯一索引是**永久**的，同一个标题隔一天再建
    -- 会撞唯一键，而人看到的是一次莫名其妙的失败。
    "dedupeKey"  text,
    "createdAt" bigint not null,
    "startedAt" bigint,
    "endedAt"   bigint,
    "updatedAt" bigint not null
  );
  -- 调度器每半分钟扫的就是这两个条件。
  create index if not exists card_ready on cards ("accountId", "retryAfter", priority desc, "createdAt") where state = 'ready';
  -- 收死的：先按心跳扫（主路），墙钟那条兜底扫的是同一批行，一个索引够用。
  create index if not exists card_running on cards ("heartbeatAt", "startedAt") where state = 'running';
  -- 板上那一屏；待办计数。
  create index if not exists card_of_board on cards ("boardId", state, "updatedAt" desc);
  create index if not exists card_assignee on cards ("accountId", "assigneeBotId", state);
  create unique index if not exists card_dedupe on cards ("boardId", "dedupeKey") where "dedupeKey" is not null;

  -- 依赖。**不跨板**：建链时验两头的 boardId 相同——一条依赖链要能被一屏看完。
  create table if not exists card_links (
    "parentId" text not null references cards(id) on delete cascade,
    "childId"  text not null references cards(id) on delete cascade,
    primary key ("parentId", "childId")
  );
  -- 收依赖那一步反着查：这张卡的父卡都 done 了没有。
  create index if not exists card_link_child on card_links ("childId");

  -- 一条时间线：人写的评论 + 系统写的状态变更，混在一起按时间排。
  --
  -- **没有单独的 card_events 表**：Hermes 有一张，因为它的 dashboard 靠 WebSocket 推那张
  -- 表；我们轮询，而人真正要读的时间线只有一条。两张表的话，界面上要 merge 两个源再按
  -- 时间排，而其中一个源人根本读不懂。
  create table if not exists card_comments (
    id         text primary key,
    "cardId"   text not null references cards(id) on delete cascade,
    kind       text not null check (kind in ('comment','system')),
    -- 人写的带 accountId；Bot 写的带 botId；系统写的两个都空。
    "authorAccountId" text references accounts(id) on delete set null,
    "authorBotId"     text,
    body       text not null default '',
    "createdAt" bigint not null
  );
  create index if not exists card_comment_of on card_comments ("cardId", "createdAt");

  -- 每一次执行一行。重试时执行包里带上一行——不带的话，第二次会一字不差地重演第一次，
  -- 包括那个错。
  create table if not exists card_runs (
    id          text primary key,
    "cardId"    text not null references cards(id) on delete cascade,
    attempt     integer not null,
    "sessionId" text,
    -- 跑在哪颗 Bot 上。卡改派之后这一行仍然指得回当时那颗。
    "botId"     text not null,
    "machineId" text,
    -- stale = 席位失联（心跳停了），和 error（席位报了错）分开：前者查不出那一轮
    -- 做到哪儿了，写成 error 是在编（同 delegation 那条 lost）。
    status      text not null check (status in ('running','ok','error','stale','aborted')),
    steps       integer,
    "toolCalls" integer,
    error       text,
    "startedAt" bigint not null,
    "endedAt"   bigint
  );
  create index if not exists card_run_of on card_runs ("cardId", "startedAt" desc);
`
