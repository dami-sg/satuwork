/**
 * 0024 · 任务看板：从对话里总结出来的任务（见 docs/task-board.md §8）。
 *
 * 和它一起来的 0025 把旧的那七张看板表删掉。**两条分开**：先建后删，中间那一版两套并存，
 * 回滚只回滚后一条。合成一条的话，任务表建歪了就只能连着旧数据一起回。
 */
export const SQL = `
  create table if not exists tasks (
    id          text primary key,
    -- 归属照旧是账号。任务从这个人的某颗 Bot 的某条会话里来，不可能跨账号。
    "accountId" text not null references accounts(id) on delete cascade,
    "companyId" text not null references companies(id) on delete cascade,
    -- 哪颗 Bot 做的。板上按它分组、按它过滤。**不设外键**：Bot 从目录里删掉之后，
    -- 「它当时办过什么」仍然该查得到——那正是这块板存在的理由。
    "botId"     text not null,
    -- 哪条会话。点「看原话」拿它去席位拉；会话没了就把那个链接灰掉，任务留着。
    "sessionId" text not null,
    title       text not null,
    -- 给人看的摘要，上限 300 字（服务端截）。它是派生物不是正文（§3）。
    summary     text not null default '',
    state       text not null check (state in ('proposed','doing','done','dropped')),
    -- 抽取器给的稳定标识，跨轮 upsert 靠它（§4.3）。
    key         text not null,
    -- 这件事在会话里的哪一段。摘要是模型写的，摘要错了只有原文能纠——没有这两个数，
    -- 人手上就只剩模型的一面之词。
    "firstSeq"  bigint not null,
    "lastSeq"   bigint not null,
    -- 「凭什么判成这个状态」，一句。人核对时先看它，不用点进会话。
    evidence    text not null default '',
    -- 人碰过哪几个字段。碰过的抽取器不再覆盖（§9）。
    "humanFields" jsonb not null default '[]'::jsonb,
    -- 哪个模型、哪一版提示词抽的。抽错一批要能圈出来重抽，也要能回答「换了模型之后是不是
    -- 变准了」。不记的话，出问题时手上一个可分组的维度都没有。
    "extractModel"   text not null default '',
    "extractVersion" integer not null default 0,
    "createdAt" bigint not null,
    "updatedAt" bigint not null,
    -- **状态最后一次真的变了**是什么时候。界面上「停滞 N 天」按它算，不按 updatedAt：
    -- 抽取器每次把 lastSeq 往后推都会动 updatedAt，那样没有一条任务显得停滞过。
    "stateAt"   bigint not null,
    "doneAt"    bigint
  );
  -- 同一条会话、同一个 key 只有一条。这是并发下最后那道闸：两次抽取重叠时（席位重启后
  -- 水位倒回去，或者去抖没拦住），两边给的是同一个 key，唯一索引是唯一原子的那个。
  create unique index if not exists tasks_key on tasks ("sessionId", key);
  -- 板上那一屏：我的任务，按状态分列，列内按状态变更时间倒序（keyset 翻页的排序键）。
  create index if not exists tasks_board on tasks ("accountId", state, "stateAt" desc);
  create index if not exists tasks_of_bot on tasks ("accountId", "botId", state, "stateAt" desc);
  -- 一条会话现在开着哪些任务：抽取时要回喂给模型，也是那条每会话上限的计数。
  create index if not exists tasks_of_session on tasks ("sessionId", "firstSeq");

  -- 一条时间线：抽取器改的 + 人改的，混在一起按时间排。
  -- **抽取器每一次改状态都要留一行**：板上一条任务昨天还是提案、今天成了完成，人得查得到
  -- 是哪一轮把它推过去的。
  create table if not exists task_events (
    id          text primary key,
    "taskId"    text not null references tasks(id) on delete cascade,
    kind        text not null check (kind in ('extract','human')),
    "fromState" text,
    "toState"   text,
    note        text not null default '',
    "createdAt" bigint not null
  );
  create index if not exists task_event_of on task_events ("taskId", "createdAt");
`
