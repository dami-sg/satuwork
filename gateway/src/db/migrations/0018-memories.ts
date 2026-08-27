/**
 * 长期记忆：Bot 跨对话记住的一句事实（见 docs/memory.md §3）。
 *
 * **单独一张表，不像私有档 Skill 那样往 `catalog_items` 上加一列。** 一条 Skill 本来
 * 就是目录项，加一维 `botId` 就够了；一条记忆不是——它有层、有类别、有到期时间，
 * 数量还大一个量级。挂上去只会把 `catalog_items` 变成一张什么都装的表。
 *
 * **四层，两种来源**（docs/memory.md §3）：`bot` / `self` 模型自己写得了，
 * `group` / `company` 只有管理员在界面上写。后两层会逐字进入别人的系统提示词，
 * 那是一条权限边界，不是省事。
 *
 * 归属那几列都是真外键 + `on delete cascade`，照 `routines`（0011）那张表的写法：
 *
 * - **`self` 层不挂 `botId`。** 它是这个人所有 Bot 共用的一份——删掉销售助理，不该
 *   让数据助理忘了他姓什么（docs/memory.md §12 ④）。`bot` 层才跟着 Bot 走。
 * - `accountId` 挂 `accounts`：删员工时那几条跟着走。少了它，`delete from accounts`
 *   会被外键挡住，删员工整条路走不通（同 `catalog_items` 那次）。
 *
 * 索引按两条真实查询路径建：席位每分钟按 (accountId, botId) 取一次自己那两层，
 * 界面按公司取上面两层。
 */
export const SQL = `
  create table if not exists memories (
    id            text primary key,
    -- bot | self | group | company。检查约束写在这儿，是因为「哪几层」是这套东西的
    -- 权限边界本身，不是一个可以在应用层将就的枚举。
    layer         text not null check (layer in ('bot', 'self', 'group', 'company')),
    "companyId"   text not null references companies(id) on delete cascade,
    -- layer = bot/self 时是本人；group/company 时为 null。
    "accountId"   text references accounts(id) on delete cascade,
    -- **只有 layer = 'bot' 有**。self 层留空，见文件头。
    "botId"       text references catalog_items(id) on delete cascade,
    "groupId"     text references groups(id) on delete cascade,
    -- 偏好 | 事实 | 联系人。**没有「流程」**：那一类走私有档 Skill，一段有步骤有分支
    -- 的东西值得单独展开来读，一句事实展开了还是它自己（docs/memory.md §1）。
    kind          text not null check (kind in ('偏好', '事实', '联系人')),
    text          text not null default '',
    -- 谁写的。界面和审计要分得出「人改的」和「Bot 自己记的」。
    "by"          text not null check ("by" in ('agent', 'user')),
    -- 哪条会话里记下的。by = 'agent' 时有，用来回答「它怎么知道这件事的」。
    "sourceSessionId" text,
    -- 席位扫出来的敏感类型（手机号 / 身份证号 / 银行卡号）。**只存不判**：判据那一份
    -- 在席位上（bot/src/policy/pii.ts），抄第二份就会分叉。界面拿它标红。
    pii           jsonb not null default '[]',
    -- 钉住的不参与注入上限的挤压、也不过期。
    pinned        boolean not null default false,
    -- null = 永久保留。到期只是停止注入，不删（docs/memory.md §8）。
    "expiresAt"   bigint,
    "createdAt"   bigint not null,
    "updatedAt"   bigint not null
  );

  -- 席位每分钟取一次「这颗 Bot 读得到的下面两层」，走的就是这一条。
  create index if not exists memory_owner on memories ("accountId", layer, "botId");
  -- 界面按公司取上面两层，以及删公司时的连坐。
  create index if not exists memory_company on memories ("companyId", layer);
`
