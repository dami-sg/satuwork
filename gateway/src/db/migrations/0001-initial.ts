/**
 * 0001 · 初始 schema。**已冻结，不要再改这个文件。**
 *
 * 它就是编号迁移之前那一段幂等脚本，原样搬过来：`create table if not exists` 加上
 * 一串 `alter table ... add column if not exists`。冻结它有两个理由：
 *
 * 1. **存量库靠它做基线。** 生产库早就有这些表了，第一次带着迁移机制起来时跑这一条
 *    等于空转，然后记一行 `schema_migrations`——不需要任何人工标定。前提是它必须
 *    仍然是幂等的。
 * 2. 校验和盯着它。改了内容，下次起进程会当场停机并说清楚（见 migrate.ts 的 verify）。
 *
 * 要加列、改约束、建索引，写 `0002-xxx.ts`。
 */
export const SQL = `
      create table if not exists companies (
        id             text primary key,
        slug           text not null unique,
        name           text not null,
        status         text not null default 'active',
        "contactName"  text not null default '',
        "contactPhone" text not null default '',
        "contactEmail" text not null default '',
        address        text not null default '',
        website        text not null default '',
        "machineId"    text,
        "accessUrl"    text,
        "createdAt"    bigint not null,
        "updatedAt"    bigint not null
      );
      -- 联系人字段和启用状态比这张表晚落地，已经建过的库要补列。
      -- 状态不写库级 check：alter 加列带不上，新老库会长得不一样，值由 companyOf 归一。
      alter table companies add column if not exists status text not null default 'active';
      alter table companies add column if not exists "contactName" text not null default '';
      alter table companies add column if not exists "contactPhone" text not null default '';
      alter table companies add column if not exists "contactEmail" text not null default '';
      alter table companies add column if not exists address text not null default '';
      alter table companies add column if not exists website text not null default '';
      create table if not exists accounts (
        id                  text primary key,
        "companyId"         text references companies(id),
        email               text not null unique,
        name                text not null default '',
        title               text not null default '',
        phone               text not null default '',
        theme               text not null default 'system',
        locale              text not null default 'zh',
        "passwordHash"      text not null,
        role                text not null check (role in ('owner', 'admin', 'member')),
        status              text not null default 'active' check (status in ('active', 'disabled', 'invited')),
        "lastSeenAt"        bigint,
        "passwordChangedAt" bigint,
        "tokenRevokedAt"    bigint,
        "createdAt"         bigint not null,
        "updatedAt"         bigint not null
      );
      create table if not exists invites (
        id          text primary key,
        "userId"    text not null,
        "companyId" text not null,
        "createdBy" text not null,
        "createdAt" bigint not null,
        "expiresAt" bigint not null
      );
      create index if not exists invites_user on invites ("userId");
      create table if not exists plans (
        "companyId" text primary key references companies(id),
        seats       integer not null,
        "skuId"     text,
        "expiresAt" bigint,
        "updatedAt" bigint not null
      );
      -- 订阅的套餐和到期时间比席位晚落地，已经建过的库要补列。
      alter table plans add column if not exists "skuId" text;
      alter table plans add column if not exists "expiresAt" bigint;
      create table if not exists plan_skus (
        id            text primary key,
        name          text not null,
        "nameEn"      text not null default '',
        "amountMils"  bigint not null default 0,
        seats         integer not null,
        period        text not null default 'month',
        "bonusMils"   bigint not null default 0,
        "createdAt"   bigint not null,
        "updatedAt"   bigint not null
      );
      -- 这张表比双语名和赠送额度先落地，已经建过的库要补列。
      -- 跟上面 companies 一样：create table if not exists 加不了列，只能 alter。
      alter table plan_skus add column if not exists "nameEn" text not null default '';
      alter table plan_skus add column if not exists "bonusMils" bigint not null default 0;
      alter table plan_skus add column if not exists "amountMils" bigint not null default 0;
      alter table plan_skus add column if not exists period text not null default 'month';
      -- 金额从「分」改存「厘」：老值 ×10 搬过去，再把老列去掉。
      -- 只在老列还在时跑一次；新库压根没有 amountCents，这段是空转。
      do $$
      begin
        if exists (
          select 1 from information_schema.columns
          where table_schema = current_schema() and table_name = 'plan_skus' and column_name = 'amountCents'
        ) then
          update plan_skus set "amountMils" = "amountCents" * 10;
          alter table plan_skus drop column "amountCents";
        end if;
        -- 赠送额度从「token 个数」改成「钱」：原来填的数字当美元看，×1000 变厘。
        -- 填 100 的那条迁完显示 $100.00，跟当初敲进去的数字一致。
        if exists (
          select 1 from information_schema.columns
          where table_schema = current_schema() and table_name = 'plan_skus' and column_name = 'bonusTokens'
        ) then
          update plan_skus set "bonusMils" = "bonusTokens" * 1000;
          alter table plan_skus drop column "bonusTokens";
        end if;
      end
      $$;
      create table if not exists plan_orders (
        id           text primary key,
        "companyId"  text not null references companies(id),
        kind         text not null default 'plan',
        note         text not null default '',
        "planId"     text references plan_skus(id),
        "planName"   text not null,
        "planNameEn" text not null default '',
        period       text not null default 'month',
        seats        integer not null,
        "amountMils" bigint not null default 0,
        "bonusMils"  bigint not null default 0,
        "startAt"    bigint not null,
        "endAt"      bigint not null,
        "payStatus"  text not null default 'unpaid',
        "createdAt"  bigint not null,
        "updatedAt"  bigint not null
      );
      create index if not exists plan_orders_company on plan_orders ("companyId");
      -- 付款状态、单据类型（套餐/充值）和备注比订单晚落地，已经建过的库要补列。
      alter table plan_orders add column if not exists "payStatus" text not null default 'unpaid';
      alter table plan_orders add column if not exists kind text not null default 'plan';
      alter table plan_orders add column if not exists note text not null default '';
      create table if not exists invoices (
        id            text primary key,
        "companyId"   text not null references companies(id),
        "orderId"     text references plan_orders(id),
        "planName"    text not null,
        "planNameEn"  text not null default '',
        "amountMils"  bigint not null default 0,
        "periodStart" bigint not null,
        "periodEnd"   bigint not null,
        status        text not null default 'unpaid',
        "paidAt"      bigint,
        "createdAt"   bigint not null,
        "updatedAt"   bigint not null
      );
      create index if not exists invoices_company on invoices ("companyId", "periodStart" desc);
      create table if not exists topups (
        id           text primary key,
        "companyId"  text not null references companies(id),
        "orderId"    text references plan_orders(id),
        "amountMils" bigint not null,
        note         text not null default '',
        "createdBy"  text,
        "createdAt"  bigint not null
      );
      create index if not exists topups_company on topups ("companyId", "createdAt" desc);
      -- 充值记录改成由充值单付款后开出来，已经建过的库要补这一列。
      alter table topups add column if not exists "orderId" text references plan_orders(id);
      -- 一笔充值单只开一条充值记录：改单是改这条，不是再记一笔。
      create unique index if not exists topups_order on topups ("orderId") where "orderId" is not null;
      -- 一条订单只开一张账单：改订单是改这张，不是再开一张。
      create unique index if not exists invoices_order on invoices ("orderId") where "orderId" is not null;
      -- 重名的套餐在列表里分不出谁是谁，库这层就挡住。中英各管各的。
      create unique index if not exists plan_skus_name on plan_skus (name);
      -- 英文名允许留空（留空就回落到中文名），空串不参与唯一性。
      create unique index if not exists plan_skus_name_en on plan_skus ("nameEn") where "nameEn" <> '';
      create table if not exists machines (
        id                text primary key,
        host              text,
        "companyId"       text references companies(id),
        "lastHeartbeatAt" bigint,
        "createdAt"       bigint not null,
        "pairedAt"        bigint,
        "managerVersion"  text,
        protocol          integer not null default 0,
        "lastError"       text,
        "desiredManagerVersion" text,
        "maxAccounts"     integer not null default 10,
        token             text
      );
      create unique index if not exists machines_token on machines (token);
      -- 管家在心跳里自报 process.arch。发布包带的是原生二进制，架构不对就起不来，
      -- 所以选包必须认它——不认的话「最新」有一半概率是错架构的包。
      alter table machines add column if not exists arch text;
      -- 部署路径从「Gateway SSH 进去」换成「机器上常驻的管家」。Gateway 因此不再
      -- 持有任何能登录机器的凭据，这几列必须真的消失，不能只是不再读。
      alter table machines add column if not exists "pairedAt" bigint;
      alter table machines add column if not exists "managerVersion" text;
      alter table machines add column if not exists protocol integer not null default 0;
      alter table machines add column if not exists "lastError" text;
      -- 单台钉版本做灰度：空就跟平台的全局期望版本走。
      alter table machines add column if not exists "desiredManagerVersion" text;
      -- 一家公司可以有多台机器，每台限一个激活账号上限。
      alter table machines add column if not exists "maxAccounts" integer not null default 10;
      -- 机器时区。期望值由人在界面上定，实际值由管家心跳自报——两列分开存，
      -- 只有一列的话「已经改上了」和「还没改上」在界面上是一个样子。
      alter table machines add column if not exists timezone text;
      alter table machines add column if not exists "currentTimezone" text;
      -- 移除是两步：先立墓碑把信送到机器上，管家收拾完回执了才真删。见 Machine.removedAt。
      alter table machines add column if not exists "removedAt" bigint;
      -- 老库里 host 存的是 bot 直连地址，现在这一列的语义是管家基址；ssh 那套已经
      -- 没有对应物了。整行留着但清空 host，逼这台机器重新配对——留着旧值会让
      -- Gateway 一直往一个打不通的地方发部署。
      do $$
      begin
        if exists (
          select 1 from information_schema.columns
          where table_schema = current_schema() and table_name = 'machines' and column_name = 'sshHost'
        ) then
          update machines set host = null, "lastError" = '部署方式已改为机器管家，请重新配对';
          alter table machines drop column if exists "sshHost";
          alter table machines drop column if exists "sshPort";
          alter table machines drop column if exists "sshUser";
          alter table machines drop column if exists "sshAuth";
          alter table machines drop column if exists "sshSecret";
        end if;
      end
      $$;
      create table if not exists machine_pairings (
        code        text primary key,
        "companyId" text not null references companies(id),
        "createdBy" text,
        "createdAt" bigint not null,
        "expiresAt" bigint not null,
        "usedAt"    bigint,
        "machineId" text
      );
      create index if not exists machine_pairings_company on machine_pairings ("companyId", "createdAt" desc);
      create table if not exists catalog_items (
        id          text primary key,
        kind        text not null check (kind in ('model', 'skill', 'mcp', 'bot', 'provider')),
        scope       text not null check (scope in ('global', 'company')),
        "companyId" text references companies(id),
        name        text not null,
        definition  jsonb not null,
        "createdAt" bigint not null,
        "updatedAt" bigint not null
      );
      create index if not exists catalog_scope on catalog_items (kind, scope, "companyId");
      -- 老库的 kind 约束里没有 'provider'。约束名是 PG 自动起的，按名字找出来换掉，
      -- 不是无脑 drop——这张表上还有别的 check。
      do $$
      declare c text;
      begin
        select con.conname into c
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = current_schema() and rel.relname = 'catalog_items'
          and con.contype = 'c' and pg_get_constraintdef(con.oid) like '%kind%'
          and pg_get_constraintdef(con.oid) not like '%provider%';
        if c is not null then
          execute format('alter table catalog_items drop constraint %I', c);
          alter table catalog_items add check (kind in ('model', 'skill', 'mcp', 'bot', 'provider'));
        end if;
      end
      $$;
      create table if not exists credentials (
        id          text primary key,
        "companyId" text not null references companies(id),
        provider    text not null,
        secret      text not null,
        "createdAt" bigint not null,
        "updatedAt" bigint not null,
        unique ("companyId", provider)
      );
      create table if not exists audit_events (
        id          text primary key,
        "companyId" text not null,
        "accountId" text,
        action      text not null,
        detail      jsonb not null,
        "createdAt" bigint not null
      );
      create index if not exists audit_company on audit_events ("companyId", "createdAt" desc);
      create table if not exists settings (
        "companyId" text primary key references companies(id),
        payload     jsonb not null,
        "updatedAt" bigint not null
      );
      create table if not exists platform_credentials (
        provider    text primary key,
        secret      text not null,
        "createdAt" bigint not null,
        "updatedAt" bigint not null
      );
      create table if not exists platform_settings (
        id          text primary key,
        payload     jsonb not null,
        "updatedAt" bigint not null
      );
      create table if not exists groups (
        id          text primary key,
        "companyId" text not null references companies(id),
        name        text not null,
        "desc"      text not null default '',
        icon        text not null default 'chat',
        role        text not null check (role in ('admin', 'member')),
        members     jsonb not null default '[]'::jsonb,
        agents      jsonb not null default '[]'::jsonb,
        "createdAt" bigint not null
      );
      create index if not exists groups_company on groups ("companyId");
      create table if not exists skill_tags (
        "companyId" text not null,
        tag         text not null,
        seq         bigserial,
        primary key ("companyId", tag)
      );
      create table if not exists session_index (
        "sessionId"    text primary key,
        "companyId"    text not null,
        "accountId"    text not null,
        "botId"        text,
        "machineId"    text,
        origin         text,
        "remoteId"     text,
        "messageCount" integer,
        title          text,
        "createdAt"    bigint,
        "updatedAt"    bigint
      );
      create index if not exists session_index_company on session_index ("companyId", "updatedAt" desc);
      -- 翻页是 keyset 的，排序键是 ("updatedAt" desc, "sessionId" desc)：updatedAt 会撞
      -- （同一毫秒上报两条），只按它翻页会漏行或重复。索引跟着排序键走。
      create index if not exists session_index_page on session_index ("companyId", "updatedAt" desc, "sessionId" desc);
      create table if not exists instances (
        "accountId"   text not null,
        "botId"       text not null,
        "companyId"   text,
        host          text not null,
        "lastReadyAt" bigint not null,
        primary key ("accountId", "botId")
      );
      create table if not exists seat_runtimes (
        "accountId"   text not null,
        "botId"       text not null,
        "companyId"   text not null,
        "linuxUser"   text not null,
        "seatId"      text not null default '',
        "machineId"   text not null default '',
        slot          integer not null,
        display       integer not null,
        "vncPort"     integer not null,
        "novncPort"   integer not null,
        "botPort"     integer not null,
        "vncPassword" text not null,
        status        text not null check (status in ('none', 'deploying', 'ready', 'error')),
        "lastError"   text,
        "deployedAt"  bigint,
        "updatedAt"   bigint not null,
        "botVersion"  text,
        primary key ("accountId", "botId")
      );
      create index if not exists seat_runtimes_account on seat_runtimes ("accountId");
      -- 一家公司可以有多台机器。**槽位因此按机器唯一，不是按公司**——端口是从槽位
      -- 算出来的（3200+N 等），两台机器上各自的 slot 0 互不冲突，按公司唯一会白白
      -- 把第二台机器的端口段浪费掉，还会在满 N 席之后拒绝部署。
      alter table seat_runtimes add column if not exists "machineId" text not null default '';
      do $$
      declare c text;
      begin
        select con.conname into c
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = current_schema() and rel.relname = 'seat_runtimes'
          and con.contype = 'u' and pg_get_constraintdef(con.oid) like '%slot%'
          and pg_get_constraintdef(con.oid) like '%companyId%';
        if c is not null then
          execute format('alter table seat_runtimes drop constraint %I', c);
        end if;
      end
      $$;
      -- 老行没有 machineId，补成该公司那台唯一的机器。
      update seat_runtimes s set "machineId" = m.id
      from machines m where m."companyId" = s."companyId" and s."machineId" = '';
      create unique index if not exists seat_runtimes_slot on seat_runtimes ("machineId", slot);
      -- 席位从「一个 bot 一个 Linux 账号」改成「一个员工一个账号」。linuxUser 不再
      -- 唯一（同员工的多个 bot 共用它，共享文件正是靠这个），唯一性移到 seatId 上。
      alter table seat_runtimes add column if not exists "seatId" text not null default '';
      -- 老库那条 unique(companyId, linuxUser) 现在会挡住同员工的第二个 bot。约束名
      -- 是 PG 自动起的，按定义找出来删——这张表上还有 unique(companyId, slot)。
      do $$
      declare c text;
      begin
        select con.conname into c
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = current_schema() and rel.relname = 'seat_runtimes'
          and con.contype = 'u' and pg_get_constraintdef(con.oid) like '%linuxUser%';
        if c is not null then
          execute format('alter table seat_runtimes drop constraint %I', c);
        end if;
      end
      $$;
      -- 老行的 linuxUser / 实例名都是旧方案算出来的，就地换成新方案，并**打回
      -- error**：机器上跑的还是 bot-xxxx 那套单元，DB 说 ready 就是在撒谎。重新
      -- 部署一次会按新命名建账号和单元；旧的 bot-xxxx 账号需要人工清理。
      update seat_runtimes set
        "linuxUser" = 'sw-' || substr(encode(sha256(convert_to("accountId", 'UTF8')), 'hex'), 1, 12),
        "seatId"    = 'sw-' || substr(encode(sha256(convert_to("accountId", 'UTF8')), 'hex'), 1, 12)
                      || '-' || substr(encode(sha256(convert_to("botId", 'UTF8')), 'hex'), 1, 12),
        status      = 'error',
        "lastError" = '席位命名已改为「一员工一账号」，请重新部署'
      where "seatId" = '';
      create unique index if not exists seat_runtimes_seat on seat_runtimes ("companyId", "seatId");
      create table if not exists bot_releases (
        kind        text not null default 'bot',
        version     text not null,
        sha256      text not null,
        size        bigint not null,
        "createdAt" bigint not null,
        note        text not null default '',
        url         text not null default '',
        primary key (kind, version)
      );
      -- 机器管家自己也按版本发布，跟 bot 走同一套上传/校验/下发。老库只有 bot 那
      -- 一种，主键从 version 换成 (kind, version)：同名的 bot 和 manager 包要能共存。
      alter table bot_releases add column if not exists kind text not null default 'bot';
      -- 发布包也可以只登记地址、字节放在别处（对象存储、内网 HTTP）。空 = 在本机磁盘上。
      alter table bot_releases add column if not exists url text not null default '';
      do $$
      declare c text;
      begin
        select con.conname into c
        from pg_constraint con
        join pg_class rel on rel.oid = con.conrelid
        join pg_namespace ns on ns.oid = rel.relnamespace
        where ns.nspname = current_schema() and rel.relname = 'bot_releases'
          and con.contype = 'p' and pg_get_constraintdef(con.oid) not like '%kind%';
        if c is not null then
          execute format('alter table bot_releases drop constraint %I', c);
          alter table bot_releases add primary key (kind, version);
        end if;
      end
      $$;
      create table if not exists account_secrets (
        "accountId"   text primary key references accounts(id),
        "apiKey"      text not null unique,
        "accessToken" text not null unique,
        "createdAt"   bigint not null
      );
      create table if not exists llm_calls (
        id                 text primary key,
        "accountId"        text not null,
        "companyId"        text,
        provider           text not null,
        model              text not null,
        "promptTokens"     bigint not null default 0,
        "completionTokens" bigint not null default 0,
        "createdAt"        bigint not null
      );
      -- promptTokens 是**整个提示词**，命中缓存的那部分也在里面；cachedTokens 是其中
      -- 命中的一截，两者不相加。缓存读单价低，折价要用得上这个细分。
      -- 老行都是 0：那时候我们连缓存命中都没记，追不回来了。
      alter table llm_calls add column if not exists "cachedTokens" bigint not null default 0;
      create index if not exists llm_calls_company on llm_calls ("companyId", "createdAt" desc);
      create index if not exists llm_calls_account on llm_calls ("accountId");
`
