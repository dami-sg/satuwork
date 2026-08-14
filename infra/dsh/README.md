# dsh 配置层

[`cordis.patch.yml`](cordis.patch.yml) 是 Satuwork 叠在 dsh 之上的配置补丁，集中记录这一路定下的每一条配置决定。

## 补丁怎么叠

dsh 启动时把插件树按顺序叠出来，后面的层覆盖前面的：

```
dsh-base  →  dsh-web-app  →  profile 的 cordis.patch.yml  →  home 级的  →  --patch 覆盖层
```

补丁**按 id 定位行**，命中就**替换该行的整个 `config`**——所以每一行都要重写它拥有的全部键，不能只写要改的那一个。没有 `id` 的条目是新插入的行。

### 试用（不落地）

```bash
pnpm dsh web --patch /path/to/cordis.patch.yml
```

### 常驻

放进 profile 的 `cordis.patch.yml`（在 Harness home 下，具体路径用下面的 dump 确认）。

## 每次改完都要验证

```bash
pnpm dsh --profile web --dump-config
```

这条命令打印机器实际启动的整棵树。补丁生效了，对应行就会带上 `patched by` 标记或新的值。**改了不 dump 等于没改。**

## 当前的决定

| 行 | 做了什么 | 为什么 |
|---|---|---|
| `llm-deepseek` | 停用 | dsh 的双适配器是它自己的[设计验证孪生](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md)，下游维护两套配置面没有收益 |
| `llm-pi-ai` | 配置 `deepseek` + `anthropic` 两个 catalog route | 通用多 provider 适配器，加 provider 是配置不是代码 |
| `agent-default-model` | 改指 `deepseek` route | 路由名从 `deepseek-official` 变成 `deepseek` |
| `session-telemetry-otel` | 停用 | 出厂 exporter 硬编码指向 deepseek 的服务器，与「数据不出网」冲突 |
| `session-query-sqlite` | 改成文件 + `openAt: first-search` | 出厂是 `:memory:` + 从不打开，「全部对话」搜索用不了 |
| MCP | 模板待启用 | 出厂 profile 没挂 `dsh-mcp-client`，Agent 配置页依赖它 |
| `session-persistence-jsonl` | TODO | 等 `satu-session-persistence` 写完替换，见[决策 1](../../docs/dsh-capability-map.md#1--会话持久化自己接管) |

## 切换 llm 适配器的三项验收

1. **推理档位还在** —— 模型下拉旁边的 `High` 选择器。[twin-adapters note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-06-13-twin-llm-adapters.md) 记录直连适配器暴露 `thinking`/`reasoningEffort` 两个旋钮而 pi-ai 只有一个 `reasoning` level；那是 2026-06 的记录，pi-ai 现在有 `reasoningEfforts`、`thinkingBudgets` 和 `getSupportedThinkingLevels`，大概率已追平——但要实测
2. **`claude-sonnet-4-5` 出现在模型下拉里** —— 证明 catalog route 真的是配置而非代码
3. **新会话的缓存命中率** —— 底栏那个百分比

⚠️ **老会话的缓存命中会掉。** replay state 只在历史 route 与目标 route 由同一个 `PiAiAdapter` 实例拥有时才传递；`deepseek-official` 记下的历史换到 `deepseek` 之后会被当作外部 provider 的中立内容处理，拿不到原生复用。新会话不受影响。

同一个道理以后做「按场景选模型」时也要记账：**跨 provider 切换会丢 KV cache**，路由策略不能只看单价。

## 待验证

- `!!js dshHomePath(...)` 在补丁层的表达式上下文里能不能用。base 层用了它，补丁层应该同样可用，但没实测过——如果 dump 出来报错，换成绝对路径
