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

## 主题

[`satuwork-theme.css`](satuwork-theme.css) 把 dsh 的 `--dsw-alias-*` 语义令牌覆盖成 [design/theme.css](../../design/theme.css) 的值。

这条路是官方认的：ui-theme 的 README 写着第三方主题「**就是覆盖同名 alias 变量**」。dsh 的样式纪律是功能组件只准读 `--dsw-alias-*`、不准写字面色值，所以换肤不用碰任何功能组件。

### 试跑（临时，改的是 vendored 源码）

```bash
scp infra/dsh/satuwork-theme.css root@<服务器>:/tmp/
```

服务器上追加到 dsh 自己的令牌表末尾：

```bash
cat /tmp/satuwork-theme.css >> ~/deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css
```

追加到 `design-platform.css` 末尾是安全的：`scrollbar.css` 必须排在它之后，仍然读得到覆盖后的滚动条令牌。

客户端有 `client-hmr`，CSS 改动大概率热更新；没反应就重启 `pnpm dsh web`，仍没有就单独构建 `packages/client/ui-theme`。

**这是实验用的一次性改法**，验证完要改成一个 Satuwork 自己的客户端插件，别把 vendored 源码的修改留在那里——下次同步 dsh 会冲突。

### 预期能看到什么

改完最明显的是**主按钮从近黑变赭红**——dsh 出厂的 `brand-primary` 是 `neutral-bluish-1000`（近黑），Satuwork 是 `#c96442`。其次是纸面从纯白变暖白 `#faf9f5`、侧栏变 `#f5f4ee`、描边从中性灰透明度变暖墨色。

### 客户端 bundle 的格式（踩过两个坑）

产物**不是 ESM**，是 dsh 客户端模块表要求的 lazy-CJS：

```js
window.__ModuleLoader__.load({ id: 'satuwork-harness', factory: (require) => { … } })
```

脚本执行时只注册工厂；模块体的副作用（**包括注入 CSS**，这是它文档里明写的预期用法）在首次 materialize 时才跑。发普通 ESM 会得到 `loaded without registering "…" via __ModuleLoader__.load` 并让整页启动失败。

另一个坑更隐蔽：扫描用的是 `require.resolve('<pkg>/package.json')`，而一旦包声明了 `exports`，Node 的 exports 闸门会挡掉 `./package.json`，包直接被判为「不是客户端包」、静默跳过。`exports` 里必须显式写 `"./package.json": "./package.json"`。

改完 CSS 要重启服务：bundle 按内容哈希的 `rev` 做缓存，只有 `rebuilt()` 才会更新它。

### 令牌覆盖不到的地方

实测：**151 个客户端 UI 包里 16 个含字面色值，共约 35 处**（同包多路径有重复，去重后更少）。也就是说令牌纪律在九成以上的界面成立，剩下的是明确的例外——ui-theme 的 README 自己承认了这一点（"values absent from cssdesign… are deliberately not appended"）。

已确认的一处：**输入框的发送按钮硬编码 `rgb(65, 118, 230)`**，即使 `--dsw-alias-brand-primary-new-colorprimary-new-color` 已被覆盖成 `#c96442` 也不跟着变。这类要逐个用组件级 CSS 规则盖，不能靠令牌。

### 已知改不动的

- **圆角**：令牌表里没有 radius 变量，各组件在自己的 CSS Modules 里写死。设计稿的 `--radius: 1rem` 覆盖不到，要逐组件改
- **字体**：`--dsw-font-family` 已指向 Outfit，但服务器上没有这个字体文件，浏览器会退到系统栈。要真用上得把 Outfit 装进客户端资源
- **信息架构**：颜色变了，布局和导航结构还是 dsh 的

前两条是「改造 dsh 客户端」这条路的头两个具体摩擦点，值得在决定继续之前先看看实际效果有多接近。

### 暗色

设计稿只有亮色。CSS 里的暗色一段是从亮色调板推导的（同色相族、赭红提亮），不是设计产出。设计稿补了暗色之后应当整体替换那一段。

## 待验证

- `!!js dshHomePath(...)` 在补丁层的表达式上下文里能不能用。base 层用了它，补丁层应该同样可用，但没实测过——如果 dump 出来报错，换成绝对路径
