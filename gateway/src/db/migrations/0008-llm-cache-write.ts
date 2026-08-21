/**
 * 0008 · `llm_calls` 记下缓存写的那一截 token。
 *
 * `v1.ts` 的 `usageFromPayload` 早就把 `cache_creation_input_tokens` 算出来了，
 * 但只把它并进 `promptTokens` 就丢掉了。而缓存写的单价和输入不是一回事——Anthropic
 * 那边是输入价的 1.25 倍——被当成普通输入算，每一次写缓存都少收两成半。
 *
 * 和 `cachedTokens` 一样，它是 `promptTokens` 的**子集**，不是加项：
 * 未命中的部分 = promptTokens − cachedTokens − cacheWriteTokens。
 *
 * 老行都是 0：那时候根本没往下传，追不回来了。0 的后果是那些行按「全是未命中输入」
 * 计价——偏高一点，是保守的那一侧。
 */
export const SQL = `
  alter table llm_calls add column if not exists "cacheWriteTokens" bigint not null default 0;
`
