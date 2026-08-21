/**
 * 连接器：目录多出 `connector` 这一种，外加安装、连接、调用流水三张表。
 *
 * 见 docs/connectors.md §10。三张表一起建，是因为它们只有一起存在才有意义——
 * 安装没有连接是个死状态，连接没有流水就没法计费。
 */
export const SQL = `
  -- kind 上的 check 是建表时 PG 自动起名的，按定义找出来换掉（同 0002 的写法）。
  do $$
  declare c text;
  begin
    select con.conname into c
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = current_schema() and rel.relname = 'catalog_items'
      and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%kind%'
      and pg_get_constraintdef(con.oid) not like '%connector%';
    if c is not null then
      execute format('alter table catalog_items drop constraint %I', c);
      alter table catalog_items add check (kind in ('model', 'skill', 'mcp', 'bot', 'bot-template', 'provider', 'connector'));
    end if;
  end
  $$;

  -- 员工装了什么，以及开了哪几个工具。装了不等于能用，能不能用看 connector_connections。
  create table if not exists connector_installs (
    id              text primary key,
    "connectorId"   text not null references catalog_items(id) on delete cascade,
    "accountId"     text not null references accounts(id) on delete cascade,
    "companyId"     text not null references companies(id) on delete cascade,
    -- 空数组 = 全开。存**开着的**那些而不是关掉的那些：上游加了新工具，默认不给，
    -- 员工没点过头的东西不该因为供应商发版就自己出现在他的 Bot 里。
    "enabledTools"  jsonb not null default '[]',
    "createdAt"     bigint not null,
    "updatedAt"     bigint not null
  );
  create unique index if not exists install_one on connector_installs ("connectorId", "accountId");
  create index if not exists install_account on connector_installs ("accountId");

  -- 一把授权 = 一个外部账号。一个安装可以有好几把（default / personal / company）。
  create table if not exists connector_connections (
    id                 text primary key,
    "connectorId"      text not null references catalog_items(id) on delete cascade,
    vendor             text not null,
    scope              text not null check (scope in ('user', 'company')),
    -- 员工起的名字，会进工具名前缀，所以限长限字符集，且同一安装下唯一。
    label              text not null,
    "accountId"        text references accounts(id) on delete cascade,
    "companyId"        text not null references companies(id) on delete cascade,
    "externalUserId"   text not null,
    "externalId"       text,
    status             text not null check (status in ('pending', 'active', 'failed', 'revoked')),
    -- 打开 = 这把连接不进默认工具表，只有本轮被 @ 点名才注入。个人邮箱这类用它。
    "mentionOnly"      boolean not null default false,
    "lastError"        text,
    "connectedAt"      bigint,
    "createdAt"        bigint not null,
    "updatedAt"        bigint not null
  );
  create unique index if not exists conn_user on connector_connections ("connectorId", "accountId", label)
    where scope = 'user';
  create unique index if not exists conn_company on connector_connections ("connectorId", "companyId", label)
    where scope = 'company';
  create index if not exists conn_account on connector_connections ("accountId");
  create index if not exists conn_company_all on connector_connections ("companyId");

  -- 调用流水。connector / label / tool 存字面量不存外键：连接断了、连接器下架了，
  -- 「上个月谁烧了多少」还得查得到（同 llm_calls 的处理）。
  create table if not exists connector_calls (
    id             text primary key,
    "companyId"    text,
    "accountId"    text not null,
    "connectionId" text,
    "botId"        text,
    "sessionId"    text,
    vendor         text not null,
    connector      text not null,
    label          text not null default '',
    tool           text not null,
    status         text not null check (status in ('ok', 'failed', 'timeout', 'denied', 'error')),
    -- 微元（百万分之一美元）。一次调用值半厘是常态，用厘存会被舍成 0。
    "amountMicros" bigint not null default 0,
    "latencyMs"    integer not null default 0,
    -- 这一轮用户 @ 点名了这把连接。出事时第一个问题是「人点的还是 agent 自己决定的」。
    "viaMention"   boolean not null default false,
    "createdAt"    bigint not null
  );
  create index if not exists calls_company_time on connector_calls ("companyId", "createdAt");
  create index if not exists calls_account_time on connector_calls ("accountId", "createdAt");
`
