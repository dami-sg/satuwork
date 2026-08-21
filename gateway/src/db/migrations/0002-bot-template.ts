/**
 * Bot 模版层：目录项多出 `bot-template` 这一种、`user` 这一层，以及主人是谁。
 *
 * 结构改动单独一条，数据（种模版、停用旧的公司 Bot）在 0003——一条迁移一件事，
 * 出事时只回滚这一条。
 */
export const SQL = `
  alter table catalog_items add column if not exists "accountId" text references accounts(id);

  -- kind / scope 上的 check 是建表时 PG 自动起名的，按定义找出来换掉，别无脑 drop：
  -- 这张表上两条 check 并存，drop 错一条会把另一层的约束也带走。
  do $$
  declare c text;
  begin
    select con.conname into c
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = current_schema() and rel.relname = 'catalog_items'
      and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%kind%'
      and pg_get_constraintdef(con.oid) not like '%bot-template%';
    if c is not null then
      execute format('alter table catalog_items drop constraint %I', c);
      alter table catalog_items add check (kind in ('model', 'skill', 'mcp', 'bot', 'bot-template', 'provider'));
    end if;
  end
  $$;

  do $$
  declare c text;
  begin
    select con.conname into c
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace ns on ns.oid = rel.relnamespace
    where ns.nspname = current_schema() and rel.relname = 'catalog_items'
      and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%scope%'
      and pg_get_constraintdef(con.oid) not like '%user%';
    if c is not null then
      execute format('alter table catalog_items drop constraint %I', c);
      alter table catalog_items add check (scope in ('global', 'company', 'user'));
    end if;
  end
  $$;

  -- 员工的名册每次对话都要查一遍（按 accountId 取自己那几条），单独一条索引。
  create index if not exists catalog_owner on catalog_items (kind, scope, "accountId");
  -- 一家公司只能有一份模版。并发保存时靠它兜底，不是靠「先查再插」。
  create unique index if not exists catalog_one_template on catalog_items ("companyId") where kind = 'bot-template';
`
