# Satuwork × DeepSeek Harness 能力映射

把 [design/Satuwork Dashboard.dc.html](../design/Satuwork%20Dashboard.dc.html) 的 25 个视图逐个拆到 dsh（[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)）的服务与事件上，作为拆任务的依据。

三档标注：

- **A｜直接用** — dsh 已有对应服务/事件，接上就行
- **B｜写插件** — dsh 没有现成实现，但有明确的挂点（seam / 事件 / 注册表）
- **C｜产品层** — 与 dsh 无关，在它之外自建

> dsh 服务键与事件名取自其 `docs/architecture.md`、`docs/capability-seams.md`、`docs/tool-execution-pipeline.md`。标 *(推测)* 的是只见于包说明、未见到具体 `ctx` 键的。

---

## 总表

| # | 视图 | 数据来源（dsh） | 需要新写的插件 | 纯前端 / 产品层 |
|---|---|---|---|---|
| 1 | 新建对话 `new` | **A** `ctx.agents` 建会话；`ctx.agentPresets` 选 Agent；`ctx.agentDefaultModel` 模型下拉；`ctx.tools` 出能力徽章；审批档位取 `interaction` 的 permission preset | **B** 常用任务卡（任务模板）：`ctx.commands` 注册，或 `satu-task-template` | 空态排版 |
| 2 | 会话详情 `chat` | **A** 整屏由 `session/event` 渲染：`user/message`、`assistant/chunk`/`assistant/message`、`tool/call`/`tool/result`、`turn/*`、`step/*`；步骤卡 = 一个 step 内的 tool 调用分组；消息上的模型徽章取 `assistant/message` 的 usage；`Ask for approval` = `ctx.approval`；附件 = `ctx.attachments` | — | 气泡、Markdown、代码块渲染 |
| 3 | 调用链路 `chatLog` | **A** dsh 最契合的一屏。SYSTEM 段 = `system-prompt/assemble` waterfall 产物；MODEL 段 = `agent/request` → `llm/stream` → `assistant/message`；TOOL 段 = `tools/pre-execute`→`tools/execute`→`tools/post-execute`→`tools/result`；Token = `ctx.tokenMeter`；trace/耗时 = `ctx.sessionTelemetry`(OTel) | **B** CONTEXT 段必须新增 session 事件（见下方决策 3）；费用 = 单价表换算，自建 | 折叠/展开、类型过滤 |
| 4 | 我的定时任务 `tasks` | **B** dsh 的 `packages/schedule` 只是**会话内**跟进，撑不住这屏 | **B** `satu-scheduler`：`ctx.jobs` + `ctx.storage`，带 cron、归属人、启用开关、上次结果。触发器与执行现阶段都在实例内，见[部署形态](#部署形态) | 列表、开关 |
| 5 | 任务详情 `taskDetail` | **A** 触发时用 `ctx.agents` 起一个会话 | **B** 同上（任务定义存 `ctx.storageDomain`） | 表单 |
| 6 | 运行日志 `runLog` | **A** 一次运行 = 一个 session，日志即 session 日志；检索用 `ctx.sessionQuery`（SQLite 全文）；失败重试挂 `agent/request-error` waterfall | **B** run → sessionId 索引，放在 `satu-scheduler` 里 | 时间线 |
| 7 | 连接器 `cn` | **A** 凭据引用走 `ctx.credentials` seam | **B** `satu-connectors`：OAuth 授权 / token 刷新 / 同步状态，并注册一个 credentials provider 把 token 喂给 MCP 与工具 | 卡片、授权跳转 |
| 8 | 连接器详情 `cnDetail` | **A** 权限勾选（读取文件 / 写入文件 / 发表评论…）落到 `ctx.tools` 的 **monotonic guard**（只能拒绝或弃权），这是唯一正确的强制点 | **B** `satu-connector-scope-guard` | 权限矩阵 UI |
| 9 | 渠道 `ch` | **B** dsh 只有 ACP / JSON-RPC 两个入口，没有入站网关；挂点是 agent 统一 inbox + `ctx.agents.withInitiator()` | **B** `satu-channel`（注册表 seam）+ `satu-channel-wechat` / `satu-channel-telegram` | 卡片 |
| 10 | 渠道详情 `chDetail` | **A** 会话数 / 首响 / 转人工率从 session 日志投影（`ctx.sessionProjections`） | **B** 同上 | 指标卡 |
| 11 | 渠道会话 `chSession` | **A** 渠道会话 = 带 channel 元数据的普通 session；转人工可用 `ctx.userQuestions` | **B** channel 元数据要进 `SessionEventMap` | — |
| 12 | 知识库 `kb` | **C→B** dsh **没有任何 RAG / 向量 / embedding 子系统**（`session-query-sqlite` 的全文检索只对会话日志生效）。原文件可用 `ctx.attachments`，索引任务用 `ctx.jobs` | **B** `satu-kb` 按 dsh 的三角色规范建 seam：Definition（检索接口）/ Provider（LanceDB）/ Consumer（检索工具）；embedding 单独一个 seam 以便换模型 | 卡片、索引进度条 |
| 13 | 知识库详情 `kbDetail` | **A** 切片 / 索引进度 = `ctx.jobs` 的作业状态 | **B** 同上 | 列表 |
| 14 | 知识库文档 `kbDoc` | **A** 原文件 `ctx.attachments` | **B** 同上 | 阅读器、引用高亮 |
| 15 | 数据库 `db` | **B** dsh 无对应能力 | **B** `satu-db`：本地 SQLite 文档库 seam + `sql.query` 工具 + Excel/CSV 导入工具 | 集合列表 |
| 16 | 用 AI 建集合 `dbBuild` | **A** 本质就是一次带工具的 agent 会话，现成 | — | 向导 UI |
| 17 | 集合详情 `collection` | **B** 「建集合 / 改结构需人工确认」= `ctx.approval`；「记录完整查询审计日志」= `tools/post-execute` 或自有 session 事件 | **B** 同 `satu-db` | 表格 |
| 18 | Agent 配置 `agents` | **A** 核心是 `ctx.agentPresets`（per-session 能力组合，service row 需 `isolate` realm） | **B** `satu-agent-registry`：把 UI 上的 Agent 定义编译成 preset `cordis.yml` | 列表、上线开关 |
| 19 | Agent 详情 `agentDetail` | **A** `soul.md` → `ctx.systemPrompt` 的 prompt section；可用 Skill → `ctx.skills`；可用 MCP → `packages/mcp`；三条行为边界 → `ctx.approval` + tools guard；升级人工条件 → `agent/turn-stopping`（serial，无 `next()`） | **B** `satu-memory`：长期记忆的范围（用户/团队/客户）、保留时长、**注入上限 20 条**、写入前确认 → `agent.inject()` + `ctx.storage` + 在 `agent/pre-step` 里做注入预算 | 编辑器 UI |
| 20 | 模型配置 `models` | **A** 覆盖度比预期高得多。`llm-pi-ai` 是**通用多 provider 适配器**（基于 `@earendil-works/pi-ai`）：catalog route 直接继承 pi-ai 自带 provider 的端点/协议/模型目录再逐字段覆盖，pi-ai 没有的 route 整个手写声明——README 原话是"配置而不是代码改动"。它把自己的 Config schema 注册到 `ctx.settings` 并按 provider 逐个合并，**改完下一次请求即生效、无需重启**；写入经 `validate` 校验，不合法直接 `settings-rejected`。`ctx.llm.registerModelDiscovery` 专供配置界面探测某 route 有哪些模型；`listModels` / `resolveModelInfo` 给上下文窗口、输出上限、可选推理档位 | **B** 只剩按场景路由（对话与问答 / 定时与批量 / 图像与文档识别）→ `agent/request` waterfall 按标签选 route。**provider 管理本身不用写** | 表单（含自定义 provider 与"测试连接/拉取模型"，后端现成） |
| 21 | Skill 与 MCP `skills` | **A** `ctx.skills`（provider 注册表 + filesystem provider + 目录/加载工具）；MCP 走 `packages/mcp`；「试运行」= headless profile 起一次性会话 | **B** Skill 编辑与版本；调用次数从 session 日志投影 | 卡片、编辑器 |
| 22 | 账号管理 `accounts` | **C** dsh 的 `identity` 只是共享匿名身份，`interaction/permission` 是**工具权限**不是组织权限 | — | 成员 / 角色 / 席位 / 邀请 / 注册审核，全部产品层；dsh 侧只消费"当前用户"作为 `withInitiator()` 的 initiator |
| 23 | 用量统计 `usage` | **A** `ctx.tokenMeter` + `ctx.sessionTelemetry` + session 日志聚合 | **B** 按成员 / Agent / 渠道的聚合与配额 | 图表 |
| 24 | 账单 `billing` | **C** 与 dsh 完全无关 | — | 订阅、席位、发票、充值 |
| 25 | 个人设置 `profile` | **A** `ctx.settings`（用户设置 seam + 文件 provider） | — | 主题（浅色 / 深色 / 跟随系统） |

---

## 三条必须先定的架构决策

### 1. 会话持久化自己接管

dsh 的 `SESSION_FORMAT_VERSION` 停在 `0` 且 README 明确**不作任何兼容承诺**，backend 直接拒绝旧的磁盘格式。会话历史是 Satuwork 的产品资产，不能跟着上游的破坏性变更走。

**做法**：在 `ctx.sessionPersistence` seam 上挂自己的 provider，落盘格式与版本号由我们定，dsh 只当内存态与事件源。

### 2. 租户 / 席位 / 账单放在 dsh 之外

设计稿是「一个团队一套本地部署 + 席位订阅」，不是共享多租户 SaaS——知识库和数据库都明确写了"数据不出网"、路径在 `~/satuwork/`。这正是 dsh 单用户本地优先假设成立的场景。

**做法**：成员 / 角色 / 席位 / 计费全在 dsh 外面，dsh 侧只认一个 initiator（`ctx.agents.withInitiator()`）和一份 preset。不要试图把组织模型塞进 `identity`。

### 3. 凡是要出现在「调用链路」里的，必须是 session 事件

dsh 的硬规则是 **model-visible ⟺ logged**：任何进入模型请求的内容都必须能从 session 日志重建，运行时有 invariant 断言这一点。

**2026-08-15 修正**：早前判断"CONTEXT 段没有对应事件"过头了。dsh 已实现 Trajectory 视图（`ui-trajectory` 就在 web profile 里），其 [Agent Note](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-08-11-trajectory-conversation-context-assembly.md) 列出的业务分解显示骨架已经齐了：

| Trajectory 业务 | 已有的持久来源 |
|---|---|
| Request header | 保留 effective prompt 与本次实际变化，贡献 prompt 与 tool-schema 来源 |
| User / steering / **injected message** | 注入的上下文本身就是持久 message 事件，渲染成 context Node |
| Compaction | fold start / summary / end / replacement checkpoint |

所以 SYSTEM 段、注入上下文、历史裁剪**都已经能从日志重建**。真正要补的收窄成**注入内容的来源元数据**——是哪个知识库、哪几个切片、相似度多少、哪条记忆条目。这部分是 Satuwork 特有的，先确认能不能挂在现有事件的字段上，挂不上再新增事件族。

`satu-kb` 与 `satu-memory` 的工作量因此少一块，但"来源可回溯"这个要求本身不变——引用回溯是知识库那屏的核心卖点。

---

## 部署形态

**现阶段：单租户，自购 4C8G 服务器（约 $28/月），dsh 引擎、SQLite、LanceDB、前端全在这一台上。**

比过的方案与放弃理由：

| 平台 | 结论 |
|---|---|
| **自购服务器** | ✅ **采用**。单实例天天用满，按需计费省不出钱；本地盘直接兑现"数据不出网" |
| Fly Machines | 常驻 4C8G + 30GB volume 约 $48/月，比自购贵 71%。盈亏平衡点是每天醒 13.2 小时——单租户达不到。**它的价值在多租户空转时才出现**，留到那时候再上 |
| Vercel | ❌ 没有常驻进程，`ctx.agents` 的内存活对象无处安放 |
| Cloudflare | ❌ 容器磁盘全 ephemeral，睡醒即回镜像初始状态；LanceDB/SQLite 只能 FUSE 挂 R2，官方明说慢于原生 SSD |
| Railway | ❌ 共享内核容器，bwrap 能力未验证；4C8G 常驻 $160/月 |

宿主能力必须先用 [`infra/probe`](../infra/probe/README.md) 验证，重点是 bwrap 与 Landlock——Fly 的实测结果是 Landlock 缺失、bwrap 可用，普通发行版内核两者通常都有。

**组合形态**：Satuwork 拥有自己的 Cordis 根 [`cordis.yml`](../cordis.yml)，dsh 的包是逐行挂进来的依赖，由 [`bin/satuwork.mjs`](../bin/satuwork.mjs) 启动。不是「装一个 dsh 再打补丁」——那种形态下组合权在 dsh 手里。每条偏离 dsh 默认值的决定都在 `cordis.yml` 里标了「Satuwork 决定」并附理由：只用 `llm-pi-ai` 一个适配器、关死遥测、会话检索落盘、持久化待换。我们自己的插件在 [`harness/`](../harness/README.md)。

**将来做多租户时**：另起一个 gateway 项目，每租户一台服务器，Satuwork 实例连它。届时有两处要改，现在先记下：

1. `satu-scheduler` 的**触发器上移到 gateway**（执行仍在实例内），否则每台租户机器都得常驻，吃掉按需计费的全部收益
2. 席位、成员、角色、账单归 gateway，实例侧只消费一个 initiator——这正是[决策 2](#2--租户席位账单放在-dsh-之外) 说的事

## 需要新写的插件清单

| 插件 | 依赖的 dsh 挂点 | 粒度 |
|---|---|---|
| `satu-scheduler` | `ctx.jobs` + `ctx.storage` | 中 |
| `satu-kb`（Definition / LanceDB Provider / 检索工具 Consumer） | 新 seam + `ctx.jobs` + `ctx.attachments` + 新 session 事件 | **大** |
| `satu-embedding`（Definition + provider） | 新 seam | 小 |
| `satu-db` | 新 seam + `ctx.tools` + `ctx.approval` | 中 |
| `satu-memory` | `agent.inject()` + `agent/pre-step` + `ctx.storage` + 新 session 事件 | 中 |
| `satu-connectors` | `ctx.credentials` provider | 中 |
| `satu-connector-scope-guard` | `ctx.tools` monotonic guard | 小 |
| `satu-channel` + 各渠道实现 | agent inbox + `withInitiator()` + 新 session 事件 | **大** |
| `satu-agent-registry` | `ctx.agentPresets` | 中 |
| `satu-model-router` | `agent/request` waterfall | 小 |
| `satu-usage-rollup` | `ctx.tokenMeter` + `ctx.sessionProjections` | 小 |
| `satu-session-persistence` | `ctx.sessionPersistence` seam | 中 |

对照 dsh 的包规范：每个插件都要自带 `./invariant` 伴生（有可断言关系就写检查，没有就写明 `No runtime invariant: <理由>`），注册必须返回 disposer 并有 HMR 卸载测试，可配置项必须是 `Config` 字段而不是 `DEFAULT_*` 常量。

---

## 建议的里程碑

1. **打通一条链路**：`satu-session-persistence` + 会话详情 + 调用链路。只用 dsh 现成能力，验证 `session/event` 能否 1:1 喂出设计稿要的两屏；这一步也把决策 1、3 落地。
2. **Agent 与能力面**：`satu-agent-registry` + Skill / MCP / 模型配置。这几屏 dsh 覆盖度最高，见效快。
3. **知识库**：最大的一块自研，独立推进，先定 seam 契约再选 LanceDB 绑定。
4. **调度与渠道**：`satu-scheduler` → `satu-channel`。渠道依赖调度之外的入站语义，放最后。
5. **产品层**：账号 / 席位 / 账单，与 1–4 并行，无技术依赖。
