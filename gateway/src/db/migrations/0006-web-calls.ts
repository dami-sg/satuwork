/**
 * 0006 · 网页工具的按次计量表。
 *
 * 网页搜索/提取按**次**算钱，不按 token，所以不能挤进 `llm_calls`——那张表的每一列
 * 都是 token 口径的。
 *
 * `mils` 是**写行那一刻的报价快照**（单价 × 条数 × 倍率），不是回头重算的：模型单价
 * 来自 pi-ai 目录，是外部事实，重算还是那个数；搜索单价是人在配置屏里手填的，管理员
 * 一改价，重算会把上个月的账单也跟着改掉。
 */
export const SQL = `
      create table if not exists web_calls (
        id          text primary key,
        "accountId" text not null,
        "companyId" text,
        kind        text not null,
        backend     text not null,
        units       int  not null default 1,
        mils        int  not null default 0,
        "createdAt" bigint not null
      );
      create index if not exists web_calls_company on web_calls ("companyId", "createdAt" desc);
      create index if not exists web_calls_account on web_calls ("accountId");
`
