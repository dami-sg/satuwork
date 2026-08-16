# Satuwork：Gateway 与 Bot 框架

把现有仓库收成 **Bot 框架**（运行面），另起 **Gateway**（控制面）。本文是执行规范，不是意向。和本文冲突的旧结论以本文为准。

相关但不被本文改写的文档：

- [dsh-capability-map.md](./dsh-capability-map.md) 里「租户 / 席位 / 账单放在引擎之外」「将来另起 gateway」两条仍然成立，细节以本文为准
- [session-event-field-map.md](./session-event-field-map.md) 的事件信封继续用；会话根记录必须带上 `agentId`

---

## 1. 目标与非目标

**做成：**

1. 侧栏是助理名册，主区是那个助理的长对话（产品形态，不是 25 屏后台）
2. 一家公司一台运行机器；一个席位 = 一个账号 = 机器上一个框架进程；一个进程里可以有多个 Bot
3. 模型 / Skill / MCP / Bot 定义分 **全局** 和 **公司** 两层，存在 Gateway；用户还可以在自己的实例里自建 Bot
4. 聊天流量直连公司访问地址，不进 Gateway 进程
5. Gateway 只保存聊天**索引**；全文留在运行机器，按需拉取
6. Gateway 做公司级审计（登录、改配置、用了哪个官方/公司 Bot）

**先不做：**

- 知识库、业务数据库的实现和部署
- 多公司挤一台机器、跨机器调度、会话迁到 Gateway
- 把 Agent 编译成 per-session 的 `cordis.yml` preset
- 重写 Cordis / 会话 JSONL / SQLite / pi-agent-core / pi-ai
- 电脑（box）、子代理、群、项目
- Gateway 对聊天做应用层反代
- 把用户自建 Bot 默认同步到 Gateway（公司要共用，由管理员做成公司 Bot）

---

## 2. 总拓扑

```
用户浏览器
  ├─ 管理（注册、公司、套餐、目录、审计索引）──► Gateway
  └─ 聊天（SSE / 发消息）─────────────────────► 公司访问地址
                                                    │
                                                    ▼
                                          公司运行机器
                                          ├─ 监督进程
                                          ├─ 账号 A 实例  ($SATUWORK_HOME/A)
                                          ├─ 账号 B 实例
                                          └─ 账号 C 实例
                                                │
                                                ├─ 拉目录 / 验 JWT / 报用量 / 报索引 ──► Gateway
                                                └─ 被 Gateway 按 sessionId 拉全文 ◄──── Gateway（按需）
```

Gateway **不跑** 一轮对话，不当聊天的工作副本。

---

## 3. 实体

| 实体 | 活在哪 | 含义 |
|---|---|---|
| 平台 | Gateway | 全局目录的所有者 |
| 公司 | Gateway | 租户。有套餐、席位、一台运行机器、一个访问地址 |
| 套餐 | Gateway | 先管席位数和模型额度 |
| 席位 | Gateway | 可开通的账号名额 |
| 账号 | Gateway | 一个人。占用一个席位，绑定一台机器上的一个实例 |
| 运行机器 | Gateway 登记，现场部署 | v1：一家公司一台 |
| 访问地址 | Gateway 分配 | 例如 `https://acme.satuwork.com`，解析到该公司机器 |
| 框架实例 | 运行机器 | 现有 Satuwork 进程。一个账号一个。数据目录隔离 |
| Bot | 定义在 Gateway（全局/公司）或实例（我的） | 侧栏里的一个人。有自己的长会话 |
| 会话 | 只在实例上 | JSONL。根事件带 `agentId` |
| 会话索引 | Gateway | 能找到会话的指针，没有正文 |
| 审计事件 | Gateway | 谁在何时做了什么，不是聊天全文 |

席位、账号、实例一一对应。用全局 Bot 或公司 Bot **不**多占席位。

---

## 4. 职责

### Gateway

- 注册、登录、JWT（JWKS 对外）
- 公司、账号、角色（至少 `admin` / `member`）、套餐、席位
- 机器池：派机器、收回、记录该公司的访问地址
- 目录：模型、Skill、MCP、Bot，每条带 `scope: global | company` 和 `companyId?`
- 公司密钥（模型 / 需鉴权的 MCP）。**不**下发到浏览器
- 用量汇聚与额度扣减（实例上报）
- 会话索引的写入与检索
- 按索引向机器拉全文，给公司管理员看
- 审计事件

### Bot 框架（本仓库，跑在实例里）

- 现有能力全部留下：Cordis 根、插件生命周期、会话 JSONL、`ctx.storage`、pi-agent-core、pi-ai、工具管道、SSE、steering、侧栏 slot
- 侧栏 `sidebar.nav.main` 是 Bot 名册；主区是 `/a/:agentId` 的长对话
- 物化全局/公司 Bot 为侧栏上的助理（只读定义 + 本机长会话）
- 用户自建 Bot（可写提示词、选模型、挂 Skill / MCP）
- 本地 `$SATUWORK_HOME`：`satuwork.db` + `sessions/*.jsonl`
- 启动时拉目录，运行中听变更；验 Gateway JWT；上报用量和会话索引
- 提供「按 sessionId 出全文」的内网接口，只接受 Gateway 的服务凭证

### 监督进程（跑在运行机器上，不是本仓库现有代码）

- 听 Gateway 的开通 / 停用
- 为每个账号起停一个框架进程
- 隔离：独立 `$SATUWORK_HOME`、独立端口或路径
- 健康检查、把进程状态回写 Gateway

---

## 5. 配置三层

所有「能被 Bot 用到的定义」只有三层。看得见才能用。

| 层 | 谁写 | 谁看见 | 存在哪 |
|---|---|---|---|
| 全局 | 平台 | 所有公司的所有账号 | Gateway |
| 公司 | 该公司 admin | 该公司账号 | Gateway |
| 我的 | 该账号 | 仅该账号 | 该实例 |

目录种类：Bot、Skill、MCP、模型（模型密钥按公司，不按用户散落）。

**物化规则：**

- 用全局 / 公司 Bot = 在本实例登记一条引用（`origin: global|company` + 远程 id），侧栏出现一行，会话写在本机。提示词和官方挂载只读
- 自建 Bot = `origin: local`，本机可改
- 公司要复用某个自建 Bot：admin 在 Gateway 做成公司 Bot，不是实例自动上传

Skill / MCP：**定义**在 Gateway，**进程**跑在实例旁边。实例按当前账号可见集合成请求头里的工具表。公司密钥只下发到实例。

---

## 6. 开通

1. 在 Gateway 建公司（得到 `companyId`、`slug`）
2. 购买套餐，例如 3 席
3. Gateway 从机器池派一台给该公司，写入访问地址（`https://{slug}.satuwork.com`）
4. 边缘 / DNS 把该地址指到这台机器。换机器只改解析，地址不变
5. 开通最多 3 个账号。每个账号占用一席
6. Gateway 通知该机器监督进程：为账号 X 起实例
7. 监督进程拉起进程，写入 `SATUWORK_HOME`、实例口令、Gateway 基址
8. 用户登录 Gateway，被重定向到公司访问地址；之后聊天不再打 Gateway

v1 约束：一家公司一台机器；机器先按**进程**隔离，不上容器套容器。

---

## 7. 访问地址

- 每家公司**一个**对外地址，由 Gateway 在派机器时发出，写在公司记录里
- 三个实例用路径或端口隔开，用户看到的仍是这一个主机名
- 该地址终止 TLS、按主机名落到机器。这是边缘，不是 Gateway 应用反代聊天
- 浏览器：管理页打 Gateway；聊天 SSE / 发消息打公司访问地址

---

## 8. 认证

- 密码、注册、重置只在 Gateway
- Gateway 发 JWT，带 `accountId` `companyId` `role`，并暴露 JWKS
- 实例只验 JWT，并核对该账号是否派在本机。对不上拒绝
- 实例不存密码
- Gateway 拉全文、下发开通：用机器级服务凭证，和用户 JWT 分开
- 现有 `src/auth` 改成验 Gateway 票，不再自管注册表（实现阶段再改，本文先定边界）

---

## 9. Bot 与会话

一个 Bot 一条长会话。打开 `/a/:id` 复用，不每次新建。

会话根事件在现有信封上增加：

```
session: {
  version, id, createdAt, title?,
  agentId,          // 本实例内 Bot id
  origin,           // local | company | global
  remoteId?         // origin 不是 local 时，Gateway 上的定义 id
}
```

`SESSION_FORMAT_VERSION` 因此 +1，并写迁移：旧会话没有 `agentId` 的，挂到该实例的默认 Bot，或只读不可续聊。二选一，实现时定，但必须有迁移，不能丢文件。

---

## 10. 会话索引（Gateway）与全文（机器）

实例在这些时刻**只报索引**，不报正文：

- 会话创建
- 标题变更
- 一轮结束（可带最后活动时间、消息条数，仍无正文）

索引记录至少：

```
sessionId
companyId
accountId
agentId
origin
remoteId?
machineId
title
createdAt
updatedAt
messageCount?
```

公司管理员在 Gateway 按人 / Bot / 时间检索到索引。点开时：

1. Gateway 用服务凭证向该 `machineId` 要 `GET /internal/sessions/:sessionId`
2. 机器读本地 JSONL，返回事件列表
3. Gateway **不落盘**这次响应，用完即弃（或仅进程内缓存，重启即无）

机器不在线：只能看索引，并明确提示「机器不可达」。

---

## 11. 审计

记在 Gateway，和聊天正文分开。至少这些事件：

- 登录 / 登出
- 开通、停用账号或实例
- 新建 / 修改 / 删除公司 Bot、公司 Skill、公司 MCP、公司模型密钥
- 账号把某个全局 / 公司 Bot 钉到侧栏
- 套餐、席位变更
- Gateway 拉取某条会话全文（谁、何时、哪条 sessionId）

审计事件**不是** `user/message` 原文。

---

## 12. 一轮对话（只在实例里）

1. 用户打开 `/a/:agentId`
2. 没有长会话就 `sessions.create`，根事件带 `agentId` / `origin` / `remoteId`，并上报索引
3. 发消息：已在跑则 steering，否则新 turn（现有行为）
4. 组请求：系统提示词来自该 Bot；工具表 = 该 Bot 挂上的、且当前账号可见的 Skill / MCP
5. 模型：公司密钥或平台额度，由实例向已配置的 provider 调用
6. 事件追加到本机 JSONL，经现有 SSE 推前端
7. turn 结束：报索引（`updatedAt`、`messageCount`），报用量（token、费用、模型）

聊天路径上**没有** Gateway。

---

## 13. 实例进程

每账号：

```
$SATUWORK_HOME/
  satuwork.db          设置、本机 Bot、物化引用、队列（待上报的索引/用量）
  sessions/<id>.jsonl  工作副本，唯一全文
```

上报失败必须落本地队列，下次重试。聊天不因 Gateway 短暂不可用而失败。

本仓库要改的产品形状（实现阶段）：

- `satu-agent-registry`：`storage.collection('agents')`，取代 `src/views/agents` 的 mock
- 会话属于 Bot；`/` 回到最近一个 Bot
- 模型 / Skill / MCP **目录**以 Gateway 为准；本机只缓存
- `accounts` / `billing` / 套餐屏从本仓库产品主路径拿掉，入口在 Gateway
- 聊天、名册留在本仓库

---

## 14. 接口契约（实现时按此立路由，名字可微调，语义不能软）

### Gateway（用户 JWT）

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/auth/register` `/auth/login` | 注册登录 |
| GET | `/me` | 当前账号、公司、访问地址 |
| CRUD | `/orgs/:id` `/orgs/:id/accounts` `/orgs/:id/plan` | 公司与席位 |
| GET | `/catalog/models` `/catalog/skills` `/catalog/mcp` `/catalog/bots` | 可见的全局 + 本公司 |
| CRUD | `/orgs/:id/bots` `/orgs/:id/skills` `/orgs/:id/mcp` `/orgs/:id/credentials` | 公司目录，admin |
| GET | `/orgs/:id/sessions` | 会话索引检索 |
| GET | `/orgs/:id/sessions/:sessionId` | **现场**向机器拉全文，Gateway 不存 |
| GET | `/orgs/:id/audit` | 审计事件 |

### Gateway（机器服务凭证）

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/internal/machines/:id/heartbeat` | 监督进程心跳 |
| POST | `/internal/instances/:accountId/ready` | 实例起来了 |
| POST | `/internal/sessions/index` | 上报索引（幂等：同 sessionId 覆盖） |
| POST | `/internal/usage` | 上报用量 |

### 实例（用户 JWT，经公司访问地址）

现有 `/api/sessions*`、`/api/agents*` 留下，并改为：

- `POST /api/sessions` 必须带 `agentId`
- `GET /api/agents` 返回本机 Bot + 已物化的全局/公司 Bot
- `POST /api/agents` 只创建 `origin: local`
- `POST /api/agents/pin` 物化一个全局/公司 Bot

### 实例（Gateway 服务凭证，不暴露给浏览器）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/internal/sessions/:sessionId` | 返回该 JSONL 的事件数组 |

没有服务凭证或 session 不属于本机：404，不泄露是否存在。

---

## 15. 不变量

1. 一个席位最多一个正在运行的实例
2. 一个实例的 `$SATUWORK_HOME` 不被另一个账号打开
3. 聊天请求的 Host 是公司访问地址，不是 Gateway 主机
4. Gateway 磁盘上不出现会话事件正文（索引字段除外）
5. 进入模型的内容必须能从**该实例**的 JSONL 重建（现有 session 规则）
6. 全局 / 公司定义只读；改定义只发生在 Gateway，实例下次拉取生效
7. 公司密钥不进浏览器、不进用户 JWT
8. 机器不在线不影响 Gateway 上的索引与审计查看，只影响全文和该司聊天
9. 上报失败不得丢本地 JSONL，也不得阻断 `agents.send`

---

## 16. 里程碑（按此拆任务，不要并行铺 25 屏）

**M0 — 规范冻结（本文）**
本文件进仓库。旧文档冲突处加一句指向本文。

**M1 — 本仓库：名册 + 长对话**
- Agent 落 `storage.collection('agents')`，去掉 mock 名册
- 会话根带 `agentId`，一 Bot 一长会话
- 侧栏是名册，`/a/:id` 是聊天
- 不接 Gateway。单机可跑、可验收

**M2 — Gateway 骨架**
- 公司、账号、套餐、席位、JWT、JWKS
- 机器登记与访问地址
- 空目录（模型 / Skill / MCP / Bot）能读写，带 scope

**M3 — 监督进程 + 开通**
- 买 3 席 → 派机器 → 起 3 个实例
- 用户登录后跳到公司访问地址
- 实例验 JWT

**M4 — 目录下发与物化**
- 实例拉全局 + 公司目录
- 侧栏可钉官方 / 公司 Bot，可自建
- 公司密钥下发到实例

**M5 — 索引、审计、按需全文**
- 实例上报索引与用量
- Gateway 检索索引
- 点开向机器拉全文
- 审计事件落地

知识库、业务库、多租户挤机器：M5 之后另开文档，不挤进上述里程碑。

---

## 17. 验收（对着打勾）

**M1**

- 刷新后侧栏是人，不是「对话 / 任务 / 配置」抢主位
- 点一个助理能接着上次聊
- 新建助理立刻多一行
- `~/.satuwork/sessions/*.jsonl` 根事件有 `agentId`
- `/api/agents` 响应不再带 `mock: true`

**M3**

- 3 席公司在一台机器上正好 3 个进程、3 份数据目录
- 账号 A 看不到账号 B 的会话文件
- 未派到本机的 JWT 被实例拒绝

**M5**

- Gateway 库里搜不到任何 `user/message` 正文
- 有一条索引能指向机器上的全文，机器关掉则全文失败、索引仍在
- 公司 admin 拉全文会多一条审计

---

## 18. 与旧结论的对照

| 旧说法 | 现在 |
|---|---|
| 单机 4C8G 包办一切 | 控制面 / 运行面拆开；会话仍在运行机器 |
| Agent = 编译成 preset 的配置行 | Agent = 侧栏上的人，有长会话 |
| 会话正文不上 Gateway | **索引**上 Gateway，正文不上 |
| 聊天可走 Gateway 反代 | 不走。统一地址是 DNS / 边缘，不是 Gateway 进程 |
| 25 屏产品主路径 | 账号 / 套餐 / 目录在 Gateway；聊天和名册在实例 |
| 用户自建 Bot 同步到 Gateway | 不同步；要共用就做成公司 Bot |
