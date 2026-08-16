# Satuwork：Gateway 与 Bot 框架

把现有仓库收成 **Bot 框架**（运行面），另起 **Gateway**（控制面 + 唯一聊天 UI）。本文是执行规范，不是意向。和本文冲突的旧结论以本文为准。

相关但不被本文改写的文档：

- [dsh-capability-map.md](./dsh-capability-map.md) 里「租户 / 席位 / 账单放在引擎之外」「将来另起 gateway」两条仍然成立，细节以本文为准
- [session-event-field-map.md](./session-event-field-map.md) 的事件信封继续用；会话根记录必须带上 `botId`（v2 的 `agentId` 启动时迁过来）

---

## 1. 目标与非目标

**做成：**

1. Gateway 是唯一聊天 UI：侧栏是助理名册，主区是那个助理的长对话（产品形态，不是 25 屏后台）。Bot 无头，不发 SPA
2. 一家公司一台 Debian 运行机器。部署按 **(account, botId) pair**，不是按账号。一个 Bot 进程恰好一个 Bot，进程内没有多名册
3. 模型 / Skill / MCP / Bot 定义分 **全局** 和 **公司** 两层，存在 Gateway。部署实例钉目录里的那一颗（`SATUWORK_BOT_ID`）；未设该环境变量的本地进程才种 `default`
4. 浏览器只打 Gateway。Gateway 把该 pair 的 SSE / 发消息反代到席位实例。全文 JSONL 留在机器。Gateway 只存**索引**
5. Gateway 做公司级审计（登录、改配置、用了哪个官方/公司 Bot）

**先不做：**

- 知识库、业务数据库的实现和部署
- 多公司挤一台机器、跨机器调度、会话迁到 Gateway
- 把 Agent 编译成 per-session 的 `cordis.yml` preset
- 重写 Cordis / 会话 JSONL / SQLite / pi-agent-core
- 电脑（box）、子代理、群、项目
- 一个进程里跑多个 Bot；聊天绕过 Gateway 直连实例
- 把用户自建 Bot 默认同步到 Gateway（公司要共用，由管理员做成公司 Bot）

---

## 2. 总拓扑

```
用户浏览器
  ├─ 管理（注册、公司、套餐、目录、审计索引）──► Gateway
  └─ 聊天 UI（名册 / SSE / 发消息）─────────────► Gateway
                                                    │
                                                    ├─ /v1/*（API Key 或登录 JWT；sat_ 不行）
                                                    ├─ 反代该 pair 的 SSE / messages
                                                    └─ 按 sessionId 拉全文
                                                    │
                                                    ▼
                                          公司运行机器（Debian，v1 一台）
                                          ├─ pair (账号A, botX)  linuxUser / slim-desktop@ / satuwork-bot@
                                          ├─ pair (账号A, botY)
                                          └─ pair (账号B, botX)
                                                │
                                                ├─ 拉目录 / ready / 报用量 / 报索引 ──► Gateway
                                                └─ 模型 /v1/*（sk_sw_）──────────────► Gateway（pi-ai / 透传）
```

Gateway **不跑** 一轮对话，不当聊天的工作副本。浏览器聊天进 Gateway，由 Gateway 反代到该 pair 的实例。**模型调用**由 Bot 进程打 Gateway `/v1/*`。全文留在机器。

---

## 3. 实体

| 实体 | 活在哪 | 含义 |
|---|---|---|
| 平台 | Gateway | 全局目录的所有者 |
| 公司 | Gateway | 租户。有套餐、席位、一台运行机器 |
| 套餐 | Gateway | 先管席位数和模型额度 |
| 席位 | Gateway | 可开通的**账号**名额。多开 Bot **不**多占席位 |
| 账号 | Gateway | 一个人。`owner` 是平台账号，不占席位、不属于公司。`admin` / `member` 属于一家公司，占一席 |
| 运行机器 | Gateway 登记，现场部署 | v1：一家公司一台 Debian |
| 访问地址 | Gateway 分配 | 公司记录里的 `accessUrl`（派机器时写入）。**聊天 Host 是 Gateway**，不是这个地址 |
| pair 实例 | 运行机器 | 一个 (account, botId) 一个 Bot 进程 + 一份 `$SATUWORK_HOME` + 一套瘦桌面。无头 |
| Bot | 定义在 Gateway（全局/公司） | 侧栏里的一个人。有自己的长会话。部署实例只钉 `SATUWORK_BOT_ID` 那一颗 |
| 会话 | 只在实例上 | JSONL。根事件带 `botId` |
| 会话索引 | Gateway | 能找到会话的指针，没有正文 |
| 审计事件 | Gateway | 谁在何时做了什么，不是聊天全文 |

席位按**账号**计，不按 Bot 实例。`owner` 不占席位。用全局 Bot 或公司 Bot、同一账号再部署几个 pair，**都不多占席位**。3 席 × N 个 Bot = 最多 3N 个进程。

### 3.1 部署与桌面

部署单位是 **(accountId, botId)**，不是账号。

- `linuxUser` = `'bot-' + sha256(accountId + '\n' + botId).hex.slice(0, 12)`
- 槽 N（公司内从 0 起）：`DISPLAY=10+N`，RFB=`5910+N`，noVNC HTTP=`6081+N`，CDP=`9222+N`（`127.0.0.1`），Bot HTTP=`3200+N`
- 每个 pair：一个 linux 用户、一套瘦桌面（Xvfb `1280x800x24` + x11vnc `localhost`+密码 + noVNC 内网）、一个 Bot HTTP
- systemd：`slim-desktop@{linuxUser}`、`satuwork-bot@{linuxUser}`
- 管理 SSH 是 `debian`（sudo）。席位用户无 sudo
- 员工能看见：noVNC URL、VNC 密码、linuxUser、botVersion。看不见 CDP、sudo、LLM 密钥
- Bot 环境必有 `SATUWORK_BOT_ID`。目录 `GET /runtime/catalog?botId=`，只钉那一颗，不种本地 `default`
- Bot 运行包在 Gateway 按版本发布；部署指定版本。公司可批量更新已部署的 pair：`POST /platform/orgs/:id/runtime/update`
- `$SATUWORK_HOME` 是 `/home/{linuxUser}/.satuwork`，pair 之间不共用

### 账号与角色

Gateway 账号分两类，公司账号再分两种。JWT 带 `role`：`owner` | `admin` | `member`。`owner` 没有 `companyId`。

| 角色 | 账号类型 | 谁 | 在 Gateway 管什么 |
|---|---|---|---|
| `owner` | 系统管理员 | 平台，不属于任何公司 | 所有注册公司；所有注册用户与公司管理员；模型供应商与可用模型（密钥只在这里）；全站日常模型 / utility 模型；系统级 Skill / MCP / 默认 Bot；订阅套餐；全站统计；Bot 运行包版本 |
| `admin` | 公司管理员 | 属于一家公司 | 本公司席位；本公司员工；对话审计（索引 + 按需拉全文）；费用；公司统计；公司 scope 的 Skill / MCP / Bot；给员工 deploy pair |
| `member` | 公司员工 | 属于一家公司 | 只能看自己的统计。聊天走 Gateway UI，Gateway 反代到该 pair 的实例 |

公司管理员**不管**供应商、不管日常/utility、不管套餐 SKU、不管全局目录。员工在 Gateway **没有**公司管理入口。

自助注册仍创建一家公司 + 该公司第一个 `admin`。`owner` 可以查看、停用、改套餐，也可以再建公司或再建 `owner`。

日常模型、utility 模型、供应商密钥、可用模型白名单，都是**平台一份**，由 `owner` 写。不再按公司各设一套。Bot 发消息仍用该 Bot 的 `provider` + `model`，但必须落在 owner 放开的可用模型里；没指定时回落到平台日常或 utility。

---

## 4. 职责

### Gateway

- 注册、登录、JWT（JWKS 对外）。聊天 UI 在这里
- 公司、账号、角色（`owner` / `admin` / `member`）、套餐、席位
- 机器池：派机器、收回、记录该公司的访问地址
- 按 pair 部署：SSH 以 `debian` 建 linux 用户、起 `slim-desktop@` 与 `satuwork-bot@`
- 目录：模型、Skill、MCP、Bot，每条带 `scope: global | company` 和 `companyId?`
- 平台密钥（模型 / 需鉴权的 MCP），由 `owner` 配置。**不**下发到浏览器，**也不下发到 Bot 磁盘/环境**。公司不再各自贴 key
- 模型代理：`GET /v1/models`、`POST /v1/chat/completions`、`POST /v1/responses`、`POST /v1/messages`。鉴权是席位 API Key（`sk_sw_`）或登录 JWT；`sat_` 不行。上游 key 由 Gateway 按 provider 选取（平台密钥 > 环境变量）
- 平台模型角色：`owner` 指定全站 **日常任务模型**（daily）和 **utility 模型**（轻量/快速），以及可用模型白名单。经平台 settings 读写，出现在 `GET /me` 里给 Bot 读。只存 provider + model，密钥仍按供应商留在 Gateway，不下发
- 用量汇聚与额度扣减（实例上报）
- 会话索引的写入与检索
- 按索引向机器拉全文，给公司管理员看
- 审计事件
- 把浏览器的会话 / SSE / 发消息反代到该 pair 的实例

### Bot 框架（本仓库，跑在 pair 实例里）

- 现有能力全部留下：Cordis 根、插件生命周期、会话 JSONL、`ctx.storage`、pi-agent-core、工具管道、SSE、steering
- **无头**：不发 SPA。产品聊天 UI 在 Gateway。本仓库 `ui/` `design/` 不是产品路径
- **pi-ai 不在 Bot 进程**。模型目录与上游调用在 Gateway（`/v1/*`）
- 一个进程恰好一个 Bot。`GET /api/bots` 返回钉住的那一颗（部署时由 `SATUWORK_BOT_ID` 钉目录项）
- 本地 `$SATUWORK_HOME`：`satuwork.db` + `sessions/*.jsonl`
- 启动时 `GET /runtime/catalog?botId=`，只钉这一颗；不种本地 `default`（`SATUWORK_BOT_ID` 已设）
- 验 `GATEWAY_TOKEN`（`sat_`）与 `GATEWAY_MACHINE_TOKEN`；上报用量和会话索引
- 提供「按 sessionId 出全文」的内网接口，只接受 Gateway 的服务凭证
- 环境：`GATEWAY_URL`、`GATEWAY_TOKEN`（`sat_`）、`GATEWAY_API_KEY`（`sk_sw_`）、`GATEWAY_MACHINE_TOKEN`、`SATUWORK_BOT_ID`。没有 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`

开通 / 停用由 Gateway 经 `debian` SSH 做，不是机器上另跑一个监督进程。

---

## 5. 配置三层

所有「能被 Bot 用到的定义」只有三层。看得见才能用。

| 层 | 谁写 | 谁看见 | 存在哪 |
|---|---|---|---|
| 全局 | `owner` | 所有公司的所有账号 | Gateway |
| 公司 | 该公司 `admin` | 该公司账号 | Gateway |
| 我的 | 仅本地未设 `SATUWORK_BOT_ID` 时种 `default` | 该进程 | 该实例 |

目录种类：Bot、Skill、MCP、模型。模型密钥在平台，由 `owner` 配，不按公司、不按用户散落。可用模型由 `owner` 从 pi-ai 目录里放开。

**物化规则：**

- 部署实例：`GET /runtime/catalog?botId=`，只钉这一颗（`origin: global|company` + 远程 id），会话写在本机。提示词和官方挂载只读。不种 `default`，不自建
- 本地无 Gateway / 未设 `SATUWORK_BOT_ID`：可种 `origin: local` 的 `default`，便于单机验收
- 公司要复用某个定义：admin 在 Gateway 做成公司 Bot，不是实例自动上传

Skill / MCP：**定义**在 Gateway，**进程**跑在实例旁边。实例按当前账号可见集合成请求头里的工具表。公司密钥只下发到实例。

---

## 6. 开通

1. 在 Gateway 建公司（得到 `companyId`、`slug`）
2. 购买套餐，例如 3 席（3 个账号，不是 3 个进程）
3. Gateway 从机器池派一台 Debian 给该公司，写入访问地址
4. 开通最多 3 个账号。每个账号占用一席
5. 用户登录 Gateway。聊天 UI 留在 Gateway，不跳到公司访问地址
6. `POST /runtime/deploy` `{ botId }`（必填）；管理员可 `POST /orgs/:id/accounts/:accountId/deploy` `{ botId }`
7. Gateway 以 `debian` SSH 到该公司机器：建 `linuxUser`、写 `$SATUWORK_HOME`、起 `slim-desktop@` 与 `satuwork-bot@`，注入 `SATUWORK_BOT_ID` 与三把票（`sat_` / `sk_sw_` / machine token）
8. 实例 `POST /internal/instances/:accountId/ready` `{ host, botId }`

v1 约束：一家公司一台机器；机器先按 **pair 进程** 隔离，不上容器套容器。

---

## 7. 访问地址

- 每家公司**一个** `accessUrl`，由 Gateway 在派机器时发出，写在公司记录里。这是机器/DNS 登记，不是聊天入口
- 浏览器：管理页和聊天都打 Gateway。SSE / 发消息由 Gateway 反代到该 pair 的 Bot HTTP（`3200+N`）
- 桌面：员工拿该 pair 的 noVNC URL（`http://{sshHost}:{6081+N}/vnc.html`）和 VNC 密码。x11vnc 只听 localhost；CDP 只听 `127.0.0.1`

---

## 8. 认证

三把票，用途不混：

| 票 | 前缀 / 名 | 谁用 | 干什么 |
|---|---|---|---|
| 登录 JWT | Gateway 签发 | 浏览器 / 控制台 | dashboard 与 Gateway UI。带 `accountId` `role`（`owner` \| `admin` \| `member`）；公司账号再带 `companyId`。暴露 JWKS |
| API Key | `sk_sw_…` | Bot 调 `/v1/*`；也可登录 JWT 调 `/v1` | 开 admin/member 时签发，用量记在这个用户上。owner 账号详情 `/users/:id`（`GET /platform/accounts/:id`）可见。列表 API 永不带出。`owner` 账号没有 |
| Access token | `sat_…` | Gateway ↔ Bot 双向，该席位用户 | Bot 环境 `GATEWAY_TOKEN`。同一用户的多个 Bot 实例共用一把。不能调 `/v1` |
| Machine token | `smt_…`（环境名仍是 `GATEWAY_MACHINE_TOKEN`） | 一台机器一把 | 心跳、会话索引、ready、用量。写在 `machines.token`，部署时注入该机器的 `bot.env`。**不是**集群共用票 |
| Bootstrap machine token | 环境变量 `GATEWAY_MACHINE_TOKEN`（引导值） | 监督进程登记机器 | 只用于 `POST /internal/machines`。登记响应里带一次该机器的 `smt_`，之后心跳/ready/索引/用量都用那把 |

- 密码、注册、重置只在 Gateway
- 实例不存密码。部署实例验 `sat_`（及 `/internal/sessions` 上的**该机器** `smt_`），不是「只验用户 JWT」
- 现有 `src/auth` 的本机 cookie 登录不是产品路径（实现阶段遗留）

---

## 9. Bot 与会话

一个 Bot 一条长会话。Gateway 打开该 Bot 复用，不每次新建。部署实例一个进程只有这一颗。

会话根事件在现有信封上增加：

```
session: {
  version, id, createdAt, title?,
  botId,            // 本实例内 Bot id（v2 字段名是 agentId，启动时迁过来）
  origin,           // local | company | global
  remoteId?         // origin 不是 local 时，Gateway 上的定义 id
}
```

每个 Bot 有自己的 `provider` + `model`。发消息用这一对，不是进程全局默认。本地未设 `SATUWORK_BOT_ID` 时仍可种 `default`（`deepseek` + 默认模型 id），只有 Gateway 配了对应密钥才能真正调通。

`SESSION_FORMAT_VERSION` 因此再 +1（v3），并写迁移：旧会话没有 `botId` 的，取原 `agentId`，再没有则挂到该实例的默认 Bot。必须有迁移，不能丢文件。

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
botId
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
- 开通、停用账号或实例；pair 部署 / 批量更新版本
- 新建 / 修改 / 删除公司 Bot、公司 Skill、公司 MCP、公司模型密钥
- 账号部署某个全局 / 公司 Bot（钉到该 pair）
- 套餐、席位变更
- Gateway 拉取某条会话全文（谁、何时、哪条 sessionId）

审计事件**不是** `user/message` 原文。

---

## 12. 一轮对话（浏览器打 Gateway；Gateway 反代到该 pair；模型走 `/v1`）

1. 用户在 Gateway 打开该 Bot（名册 `GET /runtime/bots`，200 即使实例未上线；每条带 `runtime` 或 null）
2. 未部署 → 会话/SSE/发消息 503 `实例还没上线`
3. 已上线：Gateway 把 `/runtime/bots/:id/session`、SSE、发消息反代到**该 pair** 的实例
4. 没有长会话就 `sessions.create`，根事件带 `botId` / `origin` / `remoteId`，并上报索引
5. 发消息：已在跑则 steering，否则新 turn（现有行为）
6. 组请求：系统提示词来自该 Bot；工具表 = 该 Bot 挂上的、且当前账号可见的 Skill / MCP
7. 模型：Bot 用该 Bot 的 `provider` + `model`，以 **API Key（`sk_sw_`）** 打 Gateway `/v1/*`。**不**在实例上调 provider，**不**持有上游 key
   - `openai` → `/v1/chat/completions` 或 `/v1/responses`
   - `anthropic` → `/v1/messages`
   - `deepseek` 及其他 OpenAI Chat 兼容协议 → `/v1/chat/completions`
8. Gateway 用 pi-ai（Chat Completions）或把 Responses / Anthropic Messages 透传到官方上游；密钥按 provider 从平台选取，永不回显
9. 事件追加到本机 JSONL，经现有 SSE 推（Gateway 再转给浏览器）
10. turn 结束：报索引（`updatedAt`、`messageCount`），报用量（token、费用、模型）

浏览器的聊天 SSE / 发消息打 Gateway，不直连实例。**模型调用**是 Bot 进程打 Gateway `/v1`。

---

## 13. 实例进程

每个 pair：

```
$SATUWORK_HOME/          # /home/{linuxUser}/.satuwork，pair 之间不共用
  satuwork.db            设置、本机钉住的 Bot、队列（待上报的索引/用量）
  sessions/<id>.jsonl    工作副本，唯一全文
```

上报失败必须落本地队列，下次重试。聊天不因 Gateway 短暂不可用而失败（已建连的 turn）；未部署的 pair 在 Gateway 上 503。

本仓库要改的产品形状（实现阶段，对照现状）：

- `satu-agent-registry`：`storage.collection('bots')`；部署时只有钉住的那一颗
- 会话属于 Bot
- 模型 / Skill / MCP **目录**以 Gateway 为准；本机只缓存。Bot 的 llm 层是 Gateway `/v1/*` 的薄客户端（API Key）
- `accounts` / `billing` / 套餐屏从本仓库产品主路径拿掉，入口在 Gateway
- 聊天 UI、名册在 Gateway；实例无头

---

## 14. 接口契约（实现时按此立路由，名字可微调，语义不能软）

### Gateway（用户 JWT；`sat_` 可调 runtime 拉目录 / 反代，不能当登录进控制台写操作的替代）

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/auth/register` `/auth/login` | 注册登录 |
| GET | `/me` | 当前账号、角色；公司账号带公司与访问地址；平台日常/utility 与可用模型 |
| CRUD | `/platform/orgs` `/platform/accounts` `/platform/plans` `/platform/providers` `/platform/settings` | `owner`：公司、用户、套餐、供应商、日常/utility、可用模型、系统级目录 |
| GET | `/platform/accounts/:id` | `owner` 账号详情：`apiKey` / `accessToken`（`owner` 账号均为 null）。列表接口永不带这两项 |
| CRUD | `/orgs/:id` `/orgs/:id/accounts` `/orgs/:id/plan` | 公司管理员：本公司与席位、员工 |
| GET | `/catalog/models` `/catalog/skills` `/catalog/mcp` `/catalog/bots` | 可见的全局 + 本公司（员工只读） |
| CRUD | `/orgs/:id/bots` `/orgs/:id/skills` `/orgs/:id/mcp` | 公司目录，公司 admin |
| GET | `/orgs/:id/sessions` | 会话索引检索，公司 admin |
| GET | `/orgs/:id/sessions/:sessionId` | **现场**向机器拉全文，Gateway 不存，公司 admin |
| GET | `/orgs/:id/audit` | 公司审计，公司 admin |
| GET | `/me/stats` | 员工看自己的统计；admin / owner 看各自范围 |
| GET | `/runtime/bots` | Gateway 目录名册，200 即使实例未上线；每条 `runtime` 或 null |
| GET | `/runtime/bots/:id/session` 等 | 反代到**该 pair**；未部署 503 `实例还没上线` |
| GET | `/runtime/desktop?botId=` | 该 pair 的桌面（noVNC / 密码 / linuxUser / botVersion）。`botId` 必填 |
| POST | `/runtime/deploy` | `{ botId }` 必填。给当前席位部署该 Bot |
| POST | `/orgs/:id/accounts/:accountId/deploy` | admin：给该账号部署 `{ botId }` |
| GET | `/runtime/catalog?botId=` | 实例拉目录。有 `botId` 时只返回那一颗 |
| POST | `/platform/bot-releases` | `owner` 发布版本化 Bot 运行包 |
| POST | `/platform/orgs/:id/runtime/update` | 公司批量把已部署 pair 更新到某版本 |

### Gateway（模型代理；API Key `sk_sw_` 或登录 JWT。`sat_` → 401。`x-api-key` 若出现也只当席位 API Key / JWT，不是上游密钥）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/v1/models` | 调用方可见的模型（`owner` 放开的可用集 ∪ 本公司模型条目），无密钥 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions。`stream: true` 时 SSE（`text/event-stream`）。底下是 pi-ai |
| POST | `/v1/responses` | OpenAI Responses API（当前 `/v1/responses`，不是旧 assistants）。可 stream。透传到官方上游 |
| POST | `/v1/messages` | Anthropic Messages API。请求可带 `anthropic-version`；`x-api-key` **不是**上游 key。Gateway 附上平台的 Anthropic 密钥 |

选模型不在可见目录 → 404。该 provider 没有密钥 → 402（或上游不可达 503）。JSON 错误，无 stack。用量记在持有该 API Key / JWT 的用户上。

Bot 配置：`GATEWAY_URL`（例如 `http://127.0.0.1:3080`）+ `GATEWAY_TOKEN`（`sat_`）+ `GATEWAY_API_KEY`（`sk_sw_`）+ `GATEWAY_MACHINE_TOKEN`（该机器的 `smt_`）+ `SATUWORK_BOT_ID`。进程里没有 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY`。

### Gateway（机器服务凭证）

登记机器用环境变量引导票 `GATEWAY_MACHINE_TOKEN`。登记成功后每台机器有自己的 `smt_`（`machines.token`），之后心跳 / ready / 索引 / 用量都用那把。部署写入 `bot.env` 的名字仍是 `GATEWAY_MACHINE_TOKEN`，值是该机器的 `smt_`。

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/internal/machines` | 引导票登记机器。响应带一次 `token`（`smt_`） |
| POST | `/internal/machines/:id/heartbeat` | 该机器的 `smt_`；票必须对应 `:id` |
| POST | `/internal/instances/:accountId/ready` | 该机器的 `smt_`。body `{ host, botId }`，`botId` 必填；pair 必须已部署；机器必须属于该账号的公司 |
| POST | `/internal/sessions/index` | 该机器的 `smt_`。公司从机器派生，不能替别的公司报索引 |
| POST | `/internal/usage` | 该机器的 `smt_`。上报真实 token，不编费用 |

### 实例（`sat_` 或 machine token；Gateway 反代，浏览器不直连）

现有 `/api/sessions*` 留下；产品名词是 Bot，主 API 是 `/api/bots*`：

- `POST /api/sessions` 必须带 `botId`
- `GET /api/bots` 返回本进程钉住的那一颗；每条带 `provider` + `model`
- `POST /api/bots` 410：Bot 配置在 Gateway（本机不自建）
- `GET /api/models` 代理 Gateway 目录，不提供「粘贴 API key」

### 实例（Gateway 服务凭证，不暴露给浏览器）

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/internal/sessions/:sessionId` | 返回该 JSONL 的事件数组 |

没有服务凭证或 session 不属于本机：404，不泄露是否存在。

---

## 15. 不变量

1. 一个 **pair** 最多一个正在运行的实例
2. 一个进程恰好一个 Bot
3. 一个 pair 的 `$SATUWORK_HOME` 不被另一个 pair 打开
4. 聊天请求的 Host 是 Gateway，不是公司访问地址、也不是实例端口
5. `/v1` 用 API Key 或登录 JWT 认人；`sat_` 不能调 `/v1`
6. Gateway 磁盘上不出现会话事件正文（索引字段除外）
7. 进入模型的内容必须能从**该实例**的 JSONL 重建（现有 session 规则）
8. 全局 / 公司定义只读；改定义只发生在 Gateway，实例下次拉取生效
9. 平台密钥不进浏览器、不进用户 JWT、不进 Bot 环境里的 provider key
10. **Bot 磁盘与环境永不包含 provider API key**（`DEEPSEEK_API_KEY` 等只允许出现在 Gateway）
11. 机器不在线不影响 Gateway 上的索引与审计查看，只影响全文和该 pair 的聊天
12. 上报失败不得丢本地 JSONL，也不得阻断发消息
13. 每个 Bot 有自己的 `provider` + `model`；发消息用这一对
14. 席位按账号计；多部署几个 Bot 不多占席位
15. `linuxUser` 由 `accountId` **和** `botId` 一起哈希，不是只由 `accountId`

---

## 16. 里程碑（按此拆任务，不要并行铺 25 屏）

**M0 — 规范冻结（本文）**
本文件进仓库。旧文档冲突处加一句指向本文。

**M1 — 本仓库：名册 + 长对话**
- Bot 落 `storage.collection('bots')`，去掉 mock 名册
- 会话根带 `botId`，一 Bot 一长会话
- ~~侧栏是名册，`/a/:id` 是聊天~~ **已取代**：聊天 UI 在 Gateway；实例无头
- 不接 Gateway。单机可跑、可验收（未设 `SATUWORK_BOT_ID` 时可种 `default`）

**M2 — Gateway 骨架**
- 公司、账号、套餐、席位、JWT、JWKS
- 机器登记与访问地址
- 空目录（模型 / Skill / MCP / Bot）能读写，带 scope

**M3 — 开通 + pair 部署**
- ~~买 3 席 → 派机器 → 起 3 个实例~~ **已取代**：买 3 席 → 派机器 → 按 (账号, botId) 部署；3 席 × N 个 Bot = 3N 个进程
- ~~用户登录后跳到公司访问地址~~ **已取代**：登录后留在 Gateway 聊天 UI
- 实例验 `sat_`（及 machine token），不是只验用户 JWT

**M4 — 目录下发与物化**
- 实例拉全局 + 公司目录；部署时 `?botId=` 只钉一颗
- ~~侧栏可钉官方 / 公司 Bot，可自建~~ **已取代（部署路径）**：名册在 Gateway；部署实例不自建
- ~~公司密钥下发到实例~~ **否**：密钥留在 Gateway，实例只打 `/v1/*`

**M5 — 索引、审计、按需全文**
- 实例上报索引与用量
- Gateway 检索索引
- 点开向机器拉全文
- 审计事件落地

知识库、业务库、多租户挤机器：M5 之后另开文档，不挤进上述里程碑。

---

## 17. 验收（对着打勾）

**M1**

- ~~刷新后侧栏是人，不是「对话 / 任务 / 配置」抢主位~~ **已取代**：名册在 Gateway UI
- 点一个助理能接着上次聊
- ~~新建助理立刻多一行~~ **已取代（部署路径）**：Bot 定义在 Gateway 目录；部署实例不自建
- `~/.satuwork/sessions/*.jsonl` 根事件有 `botId`
- `/api/bots` 响应不再带 `mock: true`；条目有 `provider` + `model`；部署实例只有钉住的那一颗

**M3**

- ~~3 席公司在一台机器上正好 3 个进程、3 份数据目录~~ **已取代**：3 席 × N 个已部署 Bot = 3N 个进程、3N 份 `$SATUWORK_HOME`（linuxUser 含 botId）
- 账号 A 看不到账号 B 的会话文件；同一账号的不同 Bot 也不共用 HOME
- 未派到本 pair 的票被实例拒绝

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
| 聊天可走 Gateway 反代 → 不走 | **走**。浏览器只打 Gateway；Gateway 反代到该 pair。公司访问地址不是聊天入口 |
| 一个席位 = 一个账号 = 一个进程；一个进程里多个 Bot | 席位仍按账号计。部署按 pair。一个进程恰好一个 Bot。3 席 × N Bot = 3N 进程 |
| 25 屏产品主路径 | 账号 / 套餐 / 目录 / 聊天名册都在 Gateway；实例无头 |
| 一家公司一个 admin 后台，兼管供应商和日常/utility | 拆成 owner 控制台与公司后台。供应商、可用模型、日常/utility、套餐 SKU、系统级目录只在 owner；公司 admin 管席位/员工/审计/费用/公司目录；员工只看自己的统计 |
| 用户自建 Bot 同步到 Gateway | 不同步；部署实例不自建。要共用就做成公司 Bot |
| `/v1` 只收用户 JWT；`x-api-key` 也当 JWT | `/v1` 收 API Key（`sk_sw_`）或登录 JWT。`sat_` 不行。用量记在该用户 |
| `linuxUser` 只由 accountId 派生 | `linuxUser` = `bot-` + sha256(`accountId` + `\n` + `botId`) 前 12 hex |
