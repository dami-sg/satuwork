/**
 * 流水行上记下这一笔吃的是哪个桶。
 *
 * 原来余额是「(套餐赠送 + 充值) − 全部历史花费」。套餐一到期赠送额度归零，**但它已经
 * 花掉的那部分仍然留在花费里**，等于从充值余额上再扣一遍：一月送 $10 花掉 $10，二月
 * 套餐过期后充 $5，算出来的余额是 −$5，刚付过钱的公司所有调用被拒。
 *
 * 分桶记账才对得上：`bonusMicros` 是这一笔里由套餐赠送承担的部分，剩下的
 * （`amountMicros - bonusMicros`）是充值承担的。赠送按当前账期算，充值累计不过期。
 *
 * 老行默认 0 = 全算充值。这是保守的一侧：把历史花费算成吃了充值，只会让余额偏小，
 * 不会让人白花钱。
 */
export const SQL = `
  alter table connector_calls add column if not exists "bonusMicros" bigint not null default 0;

  -- 一家公司对一个连接器只能有一条禁令。
  --
  -- 它是 catalog_items 里的一行普通记录，靠「先查后插」维护——管理员双击一下「禁用」，
  -- 两个请求都查到空，各插一行。之后点「解禁」只更新得到其中一行，界面说已解禁，
  -- 而另一行还是 blocked：连接器仍然用不了，谁也说不出为什么。
  create unique index if not exists catalog_one_block
    on catalog_items ("companyId", (definition->>'connectorId'))
    where kind = 'connector' and scope = 'company';
`
