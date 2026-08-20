/**
 * 每家公司种一份 Bot 模版，并把旧的公司 Bot 停用。
 *
 * 这条数据迁移和上一条的结构变更是绑死的：公司这一层的语义变了——原来是「一批共享
 * 的 Bot」，现在是「一份所有人共用的底座」。不搬这一下，升上来的库里公司层就是空的，
 * 而每家公司管理员当初写的提示词、勾的 Skill 会凭空消失。
 *
 * 模版的初值取该公司**最早**那一条公司 Bot 的配置：多数公司只建过一两个，最早那条
 * 通常就是「主力助理」，拿它当底座比拿一份出厂默认更接近原样。一条都没有的公司拿
 * 出厂默认（和 lib/catalog.ts 里那几个常量对齐，改那边记得改这里）。
 *
 * 旧的公司 Bot **不删**：它们名下有已经部署的席位和会话索引，删掉之后那些席位就成了
 * 没有目录项的孤儿，连名字都显示不出来。停用（`enabled:false` + `legacy:true`）之后
 * 它们在名册里仍然认得出、管理员可以逐个收拾。
 */
export const SQL = `
  insert into catalog_items (id, kind, scope, "companyId", "accountId", name, definition, "createdAt", "updatedAt")
  select
    'tpl-' || c.id,
    'bot-template',
    'company',
    c.id,
    null,
    'Bot 模版',
    jsonb_build_object(
      'version', 1,
      'prompt', coalesce(nullif(b.definition->>'prompt', ''), '你是 Satuwork 的 AI 员工。用简洁、专业的中文回答。需要当前时间、查看或修改文件、执行命令时调用工具，不要凭猜测。'),
      'escalate', coalesce(b.definition->>'escalate', ''),
      'guards', coalesce(b.definition->'guards', '{"high-risk":true,"pii":true,"no-external":true}'::jsonb),
      'memory', coalesce(b.definition->'memory', '{"on":true,"scope":"所属分组","kinds":["偏好","事实"],"ttl":"90 天","cap":20,"confirm":true,"pii":true}'::jsonb),
      'skills', coalesce(b.definition->'skills', '[]'::jsonb),
      'mcps', coalesce(b.definition->'mcps', '[]'::jsonb),
      'updatedAt', (extract(epoch from now()) * 1000)::bigint
    ),
    (extract(epoch from now()) * 1000)::bigint,
    (extract(epoch from now()) * 1000)::bigint
  from companies c
  left join lateral (
    select ci.definition
    from catalog_items ci
    where ci.kind = 'bot' and ci.scope = 'company' and ci."companyId" = c.id
    order by ci."createdAt" asc
    limit 1
  ) b on true
  where not exists (
    select 1 from catalog_items t where t.kind = 'bot-template' and t."companyId" = c.id
  );

  update catalog_items
     set definition = definition || '{"enabled":false,"legacy":true}'::jsonb,
         "updatedAt" = (extract(epoch from now()) * 1000)::bigint
   where kind = 'bot' and scope = 'company';
`
