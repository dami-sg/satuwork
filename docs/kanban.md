# 多 Bot 看板（Kanban）

一张板 = **一个员工名下的几颗 Bot 共用的一份待办清单**。一张卡从板上派到某颗 Bot 的席位
上，在一条独立的任务会话里跑完，把结论写回卡上；卡与卡之间靠依赖串成流水线。

**派卡的那一刻，没有人在等着看。** 这一句决定了下面几乎所有的取舍——它和
[delegation.md](./delegation.md) 那件事最大的分别就在这里：委派是主代理 `await` 在一次工具
调用上、人对着一个转圈的图标；看板是人把活挂上去就走了，可能明天才回来看。

本文和 [gateway-runtime.md](./gateway-runtime.md) 冲突处以那一份为准；本文在它的席位模型、
会话事件、计费与审计口径上**加一类东西**——不改席位边界，不改 `@` 点名的语义，不改
「Gateway 不留正文」那条不变量。

前置阅读：[delegation.md](./delegation.md)（一条不是主会话的会话长什么样、工具怎么继承）、
[handoff.md](./handoff.md)（一个跨轮、落盘、要指派给别人的对象长什么样）、
[routines.md](./routines.md)（一条不面对人的执行路径要注意什么）。

参考的是 Hermes Agent 的看板（`user-guide/features/kanban`）。骨架照抄：**一份持久的任务表 +
多个具名 agent 认领 + 依赖驱动的流转**。分歧全在一个地方——**它的 agent 是同一个进程里的
几份配置，我们的 Bot 是几个各自独立的席位进程**：各有各的 `$SATUWORK_HOME`、各有各的会话、
各有各的一块屏，只有 `~/work` 是共的（§6.1）。所以「派一张卡」在它那儿是一次函数调用，
在我们这儿是一次跨进程的投递，要经过 Gateway。

---

## 1. 原来缺的是什么

| 原来就有的 | 原来缺的 |
|---|---|
| `todo`（[todo-tool.md](./todo-tool.md)）：一轮之内的清单，跨轮跨重启都在 | 它是**一颗 Bot 自己**的清单。别人看不见，也接不了 |
| `delegate_task`（[delegation.md](./delegation.md)）：开一条干净的上下文做一件事 | 同步（主轮 `await` 在那儿）、深度定死 1、**只能派给它自己**。换一颗 Bot 的提示词和 Skill 来做这件事，表达不出来 |
| `routines`（[routines.md](./routines.md)）：到点自己去做的一段指令 | 触发器只有时间。「A 做完了 B 才能开始」表达不出来 |
| `handoffs`（[handoff.md](./handoff.md)）：一件事从 Bot 交到**人**手上，跨 Bot、跨机器、能指派 | 它的另一头永远是人。「从 Bot 交到**另一颗 Bot**手上」没有对象 |
| 一个员工可以给自己建 M 颗 Bot，各挂各的提示词和 Skill | 它们之间**没有任何一条路**。他自己那颗设计 Bot 做完的东西，要他手动复制到文案 Bot 的对话框里 |

所以今天一件需要两颗 Bot 接力的事，只有一条路：**人当传送带**。他要记得第一颗做完了，
要把结论粘过去，要记得第二颗在等什么——而这三件事里的任何一件他忘了，那条链子就断在
那儿，没有任何东西会提醒他。

看板要修的就是这个空洞：**把「谁接着做」从人的记性里挪成一份读得回来的状态。**

---

## 2. 五个任务对象，各管一段

新加一个待办对象是很贵的事——它会和已有的四个在界面上、在模型的判断里互相挤。所以先把
分工写死，这张表同时是工具描述里要教给模型的判据：

| | 范围 | 谁在等 | 存在哪 | 跨 Bot |
|---|---|---|---|---|
| `todo` | **一轮之内**的步骤 | 这一轮自己 | 席位 SQLite | 否 |
| `delegate_task` | 一轮之内的**一段子活** | 主代理 `await` 着 | 内存 + 子会话 JSONL | 否（同一席位） |
| `routine` | 一段**到点重跑**的指令 | 没人 | Gateway `routines` | 否（钉死一对） |
| `handoff` | 一件**要人**做的事 | 一个具体的人 | Gateway `handoffs` | 是（指派给人） |
| **`card`（本文）** | 一件**要自己另一颗 Bot 做**的事 | 没人 | Gateway `cards` | **是（同一个人名下）** |

判据一句话：**这件事做完之前，这一轮还在不在？** 在 → `todo` / `delegate_task`；不在 →
后三个。**做完它的是不是这颗 Bot 自己？** 是 → `delegate_task`；是人 → `handoff`；
是他自己另一颗 Bot → `card`。

**不合并 `handoff` 和 `card`**，尽管两者形状很像（都落盘、都能指派、都有未闭合列表）。
理由是另一头不一样，而这决定了几乎所有行为：交接单等的是一个人，所以它要催办、要升级、
要 webhook 推到群里、超时要收；卡等的是一台机器，所以它要调度、要并发闸、要重试、要
依赖解算。硬塞进一张表，得到的是一个每个字段都有一半行不通的对象。

**但通知层复用**（§14）：一张 blocked 的卡和一张开着的交接单，对人是同一件事——「有活等
着你」。那一层不该有两套。

---

## 3. 从 Hermes 借什么，不借什么

| Hermes | 我们 | 为什么 |
|---|---|---|
| 板存在 `~/.hermes/kanban.db`（本机 SQLite） | **Gateway 的 PostgreSQL** | 卡要**跨席位**指派，而一台席位只知道自己那一颗 Bot 的事——「板上还有谁、那张卡归谁」在那儿根本表达不出来（同 [handoff.md §3](./handoff.md)）。何况席位随时会被重装 |
| assignee 是一个 profile 名 | assignee 是**一颗 Bot**（板归属一个账号，所以只要 botId） | 我们的「profile」就是席位。工具、Skill、连接器、浏览器、`~/work` 全挂在 (accountId, botId) 那一对上，而 accountId 由板给出 |
| 谁都能派给谁（同一个用户的几份配置） | **只能派给这块板的成员 Bot，成员名单只有人能改** | 这一条其实和它是同一个形状：板整个关在一个账号里（§6），派也派不出这个人自己的地盘 |
| 调度器每 60 秒扫一次，PID + TTL 判崩溃 | **挂在已有的 Gateway tick 上**（`GATEWAY_ROUTINE_TICK_MS`，30 秒），按「有多久了」判回收 | 不新起定时器（同 [handoff.md §6](./handoff.md)）。PID 判不了：跑卡的进程在另一台机器上 |
| `workspace: scratch / dir:<path> / worktree` | **不抄**。卡跑在席位那唯一的 `~/work` 里，草稿写 `cards/<cardId>/` | 三种工作区是「一台机器上开一堆隔离目录」的解法。我们的隔离早就做在别处了——不同账号是不同 Linux 用户；同一账号的几颗 Bot 共用 `~/work` 是[故意的](./delegation.md)（§7.2） |
| `tenant` 命名空间做数据隔离 | 不抄 | 我们有「公司」和「账号」两层，而且它们是真的隔离（库里的外键、席位上的 Linux 用户），不是一个字符串前缀 |
| 自动拆解（`auto_decompose`，每 tick 跑编排器） | **v1 不做** | 见 §20。它要一个每 tick 都在花钱的进程，而且它产出的任务图**没人看过就直接开跑** |
| `review` 状态 + `sdlc-review` 自动派评审 | **不做这个状态**。评审是一张普通的下游卡 | 少一个状态、少一条路径，而「A 干活 → B 评审」用依赖已经表达得完整。评审说不行，走 `reopen`（§7） |
| `kanban_heartbeat` 由模型自己调 | **不给模型这把工具**，席位每 60 秒替它报 | 让模型负责保活，是把一个运维问题伪装成一个提示词问题——它会忘，而忘了的表现是一张明明在跑的卡被判成崩了 |
| 多板：`~/.hermes/kanban/boards/<slug>/` | 多板：**一个人**可以有多张，一行 `boardId` | 同一条理由（一件事一张板），实现上我们本来就有库。代价是工具那边要点名往哪块板建，见 §10.1 |
| 跨板连线禁止 | 照抄 | 一条依赖链要能被一屏看完 |
| Dashboard 走 WebSocket 推 `task_events` | **轮询** | 同 [handoff.md §6](./handoff.md) 那条：为一个还没人用的页面在 Gateway 上长期养一条连接不划算。轮询的规矩见 §16 |
| `/api/plugins/` 路由跳过鉴权（假设只听本机） | 不抄，一条都不跳 | 我们的 Gateway 是公网入口 |

---

## 4. 五条定死的口径

**〇、一块板只有它的主人看得见。** 板、板上的成员、板上的每一张卡、每一条评论、每一次跑的
流水——**除了归属的那个员工，谁都看不见，公司管理员和平台 owner 也不例外**。接口一律回
**404，不是 403**。这一条排在最前面，是因为下面每一条都在它划出的地里：卡派不出这个人的
席位、文件不出这个人的 `~/work`、钱不出这个人的账号。展开见 §6。

**一、一张卡跑在一条独立的任务会话上，`kind: 'card'`。** 不是主会话里的一段，也不是委派
那种子会话。理由和 [delegation.md §4](./delegation.md) 一字不差：主会话的事件流是这颗 Bot
和它主人之间的那条时间线，塞第二条进去，所有按顺序读它的东西都要重新学一遍怎么读。

**二、卡片会话不上报会话索引，板上那一行就是它的指针。** 同
[delegation.md §4](./delegation.md)：控制面的会话索引是「这个人有哪几条对话」。**那条会话的
全文**照旧留在席位上，`GET /internal/sessions/:id` 对它原样可用（反代那条路认的是 id，不认
kind）。注意别和 §5 那条搞混：**卡这个对象**的正文在 Gateway，**卡跑起来的现场**在席位。

**三、卡片会话里没有人。** 没有 `escalate_to_human`，没有 `clarify`，也不许写长期记忆
（§10.4）。卡住只有一条出路：`kanban_block(reason)` ——**卡自己就是那张待办**，再开一张
交接单等于同一件事在两个清单里各挂一次，而两边的状态一定会分叉。

配套的一处**必须一起改**，否则这条口径当场破功：`ESCALATE_AFTER` 那段话术
（[policy/index.ts:447](../bot/src/policy/index.ts:447)）连着被挡 3 次之后会劝模型
「调用 `escalate_to_human`」——委派那一版已经为子会话加过一档（`inTask`），而它的判据是
`taskOf`，**对卡片会话返回 undefined**，于是卡片会话拿到的是给主会话写的那句话，去调一把
它没有的工具，把剩下的步数全耗在这上面。判据要从「是不是子任务」扩成三档，卡片会话那一档
说的是：**停下来，调 `kanban_block` 把卡在哪儿写清楚。**

**四、结论回到卡上，不回到任何一条对话里。** 默认不叫醒任何人。要「做完告诉我」的，卡上
有一格 `notify`（§14），走的是[交接单交还](./handoff.md)那条现成的路：新起一轮，带
`source = { kind: 'plugin', plugin: 'kanban', form: <卡号> }`。

---

## 5. 东西放在哪

| 东西 | 在哪 | 为什么 |
|---|---|---|
| 板、成员、卡、依赖、评论、每次跑的流水 | Gateway 的 `boards` / `board_members` / `cards` / `card_links` / `card_comments` / `card_runs` | 一台席位只认得自己那一颗 Bot，板要横跨这个人的全部席位；而且席位随时会被重装，板不能跟着一起没 |
| 卡的全部过程（每一步、每次工具调用） | 卡片会话的 JSONL，在**执行方**那台席位上 | 和主会话一模一样的格式。调用链路那屏、审计、重放全都不用改，换个 id 就能看 |
| 卡的正文（title / body / summary） | **两边都有一段，全文在 Gateway** | 这一条和会话索引口径**不一样**，见下 |
| 产出的文件 | `~/work` | 板上所有 Bot 共用同一个（§6.1），所以下游卡直接读得到 |

**为什么卡的正文可以落在 Gateway，而会话正文不行。** 会话正文是人和 Bot 说的话，它是内容，
Gateway [明确不当内容库](./gateway-runtime.md)。而一张卡的 title / body 是**调度所需的输入**：
同一个账号的几颗 Bot 共用 `~/work`，但**不共用会话**——每个席位有自己的 `$SATUWORK_HOME`
（[gateway-runtime.md §4](./gateway-runtime.md)），下游 Bot 读不到上游那条卡片会话，卡上这几段
就是它全部的交底书。

把正文留在席位上还有一个更硬的问题：「派卡」这个动作发生在 Gateway 的 tick 里，而那一刻
**整台机器可能是关着的**——人昨晚在板上写好了三张卡就合上电脑了。正文不在 Gateway 的话，
第二天机器起来之前，连「这块板上有什么活」都答不出来。

同一条理由不适用于 `summary`：它也必须在 Gateway，因为下游卡的 `kanban_show` 要读它。所以
**卡是一个 Gateway 上的完整对象**，席位那边只有它的执行现场。这是本文和 handoff 最大的
一处分歧，值得单独记住。

---

## 6. 板是一个人的，成员是他自己的几颗 Bot

### 6.1 归属：一个账号

一块板归属**一个员工**，板上的成员只能是**他自己名下的 Bot**。

**别人一个字都看不见**，包括本公司的 `admin` 和平台 `owner`：板列表里没有、板详情 404、
卡详情 404、评论和流水一并 404。判据是一句 `boards.accountId === jwt.accountId`，没有第二种
写法，也没有「管理员除外」这个分支。

**404 不是 403**，抄 [routines.md §1](./routines.md)：403 等于告诉他这块板存在、只是他进不去，
而板名本身就是内容（「面试候选人筛选」「离职交接」）。

这和 [handoff](./handoff.md) 的口径**故意相反**，值得点名：交接单要指派给不是这颗 Bot 主人
的人，所以它的判据是 `canActOn`（同公司 + 被指派 / 是主人 / 是管理员）。板不是待办分发器，
是一个人自己的工作台——它更像 [routines](./routines.md)（归属跟着人走，别人看不见也删不掉），
不像交接单。

跨员工的板不做，理由见 §20。这里只说这条线画下去之后白捡了什么——每一件都是「派活给别人
的 Bot」那条路上最难的地方：

| 白捡的 | 因为 |
|---|---|
| **文件天然共享** | 一个员工的所有 Bot 落在同一台机器、同一个 Linux 用户下（[gateway-runtime.md §3.0](./gateway-runtime.md)：账号粘住机器），共用一个 `~/work`。父卡写下的东西子卡直接读得到，不需要「只传结论不传文件」那一套 |
| **没有越权** | [连接器绑账号不绑 Bot](./connectors.md)，工作区和公司模版边界也都在账号/公司那一层。同一个人的两颗 Bot 面对的是同一批连接、同一棵树、同一份边界——A 派给 B，干不成任何 A 自己干不了的事 |
| **钱对得上** | 卡跑在他自己的席位上、用他自己那把 `sk_sw_`。「这笔用量算谁的」这个问题根本不存在 |

代价也说清楚，它是真的：**一块板的活全部落在一台机器上。** 同时派给三颗 Bot，就是三个
进程在同一台机器上、同一棵 `~/work` 上一起跑。所以并发闸按**账号**设，不只按席位设（§8）；
机器负载本来就在采样（[gateway-runtime.md §3.2](./gateway-runtime.md)），板忙起来的时候那一屏
看得见。

### 6.2 成员名单还是要有

名单不是一条安全边界（上面那张表第二行已经把它拿掉了），但它仍然要有，理由换成两条：

1. **它是模型的可派名册。** `board_members.role`（「出图」「审校」「查资料」）会出现在
   `kanban_list` 的返回里——派活的那颗 Bot 靠它挑人。没有名单，它只能按 Bot 的名字猜，
   而名字是人起的、给自己看的（「小蓝」「阿吉」）
2. **它是人的一次显式圈定。** 一个人名下多半有一颗只用来处理私事的 Bot。哪几颗进这块板，
   是他做的决定，不是模型每次现挑

所以规矩不变：**模型只能派给名单上的 Bot，名单只有人能改。** 派到名单外的，工具回错并把
名单原样列出来——这比一句「没有这个 assignee」有用得多，它下一步就能改对。

**建板、加/减成员进审计**（`kanban.board.create` / `.delete` / `kanban.member.add` / `.remove`）。
口径抄 [routines.md §6](./routines.md)：审计那一栏只记「这个 Bot 会不会自己动」——把一颗 Bot
放进板，正是让它会自己动。卡的状态流转**不进审计**，那是每天几十条的东西，会把这两行淹掉。

### 6.3 那么管理员到底看得见什么

「板不可见」不等于「这家公司什么都不知道」。三条既有的路一条没断，而它们给的都是**元信息，
不是内容**：

| 管理员看得见 | 从哪 | 长什么样 |
|---|---|---|
| 甲的某颗 Bot 被放进了某块板（于是它会自己动了） | 审计 | `kanban.member.add`，带板 id + botId。**不带板名，不带卡** |
| 甲这个月花了多少、哪个模型花的 | [账本](./billing.md) | 本来就有，卡的花费自动落在里面 |
| 甲和他的 Bot 的对话全文 | 会话审计（索引 + 按需拉全文） | 本来就有 |

**最后一行有个缺口，写出来。** 卡片会话[不上报会话索引](./delegation.md)（§4 口径二），所以
管理员在会话审计那一屏**看不到卡里发生了什么**——一颗 Bot 在板上自己动了一整天，审计里只有
当初那一行「它被放进了板」。

不在这一版补，因为补法只有两种，都不该顺手做：给管理员开一个看板入口（正面违反口径〇），
或者让卡片会话上报索引（那时它进的是**已有的**会话审计，形状对，但要连带回答「一条没有人
在里面说话的会话，在审计页上算谁的对话」——那是会话索引那份文档的事）。后者是正确方向，
留给下一版。

### 6.4 共用一棵 `~/work`：并发写谁来拦

没人拦。同 [delegation.md §7.2](./delegation.md)：加了也没用（两个模型商量好写同一个文件的
方式，不是锁能表达的）。换成两条规矩：

- **草稿一律写 `cards/<cardId>/`**，成品才写正常位置。中间产物撞车的概率比成品高一个量级
- **成品路径必须写进结论**（`kanban_complete` 的 `metadata.changed_files`）。下游卡靠它找东西，
  不是靠猜一个约定俗成的目录

再加一道钝的：账号级并发闸（§8）。它拦不住两张卡写同一个文件，但它把「同时在写的卡」压在
一个人还看得懂的数量上。

---

## 7. 卡：状态机

主路一条，短：

```
建卡 ──► ready ──► running ──► done ──► archived
          ▲           │
          │           └──► blocked
          └──────────────────────┘
        （重试 / 解锁 / 打回，全都回 ready）
```

`todo` 是主路上多出来的一段，只在**有父卡**时经过。别的边都是回边，画进图里只会让这五个
框看不清，所以列成表：

| 从 | 到 | 谁触发 | 条件 |
|---|---|---|---|
| — | `todo` | 建卡 | **有父卡**时 |
| — | `ready` | 建卡 | 没有父卡时**直接** `ready`，不经过 `todo` |
| `todo` | `ready` | 调度器 | 父卡全部 `done`（§8 第 1 步） |
| `ready` | `running` | 调度器 | 过了退避、两道并发闸都有位（§8 第 3 步） |
| `running` | `done` | 模型 | `kanban_complete` |
| `running` | `blocked` | 模型 | `kanban_block`（`by-model`） |
| `running` | `ready` | 调度器 | 一次失败，且 `attempt < 2`（退避 5 分钟，§12） |
| `running` | `blocked` | 调度器 | 第二次失败（`failed`） |
| `running` | `ready` | 席位 | 回 409 busy / 503 静默 / 不在线（**不算失败**，短退避） |
| `running` | `blocked` | 人 | 按停止（`stopped`，§13） |
| `blocked` | `ready` | **人** | `unblock`。模型没有这把工具（见下） |
| `done` | `ready` | 人 / 上游卡 | `reopen`，上限 2；第 3 次拒绝并转 `blocked`（`reopen-cap`） |
| `done` | `archived` | **人** | 手动归档，不自动（见下） |
| 任何非终态 | `cancelled` | 人 | `running` 的要先 `abort` |

**没有父卡的卡直接进 `ready`。** `todo` 的定义是「还有父卡没做完」，一张没有依赖的卡在那儿
待着，只会让人以为还差点什么。

**`cancel` 之前 `running` 的那张要先 `abort`。** 撤一张正在跑的卡而不掐掉那一轮，留下的是
一个没人认领的进程（同 [delegation.md §7.3](./delegation.md) 那件事）。所以界面上 `running`
的卡只有「停止」一颗按钮，停完了才出现「撤销」。

**`done → archived` 是人的动作，不自动。** 不给「N 天后自动归档」：那个数字定成多少都会在
某个人身上出错，而板上 `done` 那一列本来就是折叠的（§16）。板归档时它底下的卡跟着一起收。

| 状态 | 意思 |
|---|---|
| `todo` | 建出来了，但还有父卡没做完 |
| `ready` | 依赖满足了，等着被派 |
| `running` | 已经派到那颗 Bot 的席位上，正在跑 |
| `blocked` | 停住了，**等人**。原因写在卡上，而**为什么停**分四档，见下 |
| `done` | 有结论了 |
| `archived` | 收进历史，板上默认不显示 |
| `cancelled` | 人撤掉的 |

**没有 `triage`。** Hermes 那一档是给自动拆解用的暂存区，而我们 v1 不做拆解（§20）。一张
写得不清楚的卡就是一张写得不清楚的卡，它该被人改清楚，不该有一个专门的状态来盛放它。

**没有 `failed`。** 失败两次的卡进 `blocked`，原因是最后一次的报错。理由是这两个状态对人
的意思完全一样——「这儿停住了，去看看」——而分成两个，人就要学会哪个该管哪个不用管。

**`reopen` 有次数上限 2**（`cards.reopens`）。没有这个数，「评审卡打回干活卡 → 干活卡重做 →
评审卡重跑 → 又打回」就是一个每轮都在花钱的死循环，而它在板上看起来一直很忙。到顶之后
那张卡进 `blocked`，reason 写「被打回 2 次，需要人看一眼」。

**`unblock` 只有人能做。** 不给模型这把工具：`blocked` 的定义就是「要人」，让模型自己解自己
的锁，等于让它把一件它已经承认干不了的事再干一遍。

### `blocked` 要分档（`blockedKind`）

四条路都通向 `blocked`，但它们对人的意思完全不同——而**通知层必须分得清**（§14）：

| `blockedKind` | 谁弄的 | 要不要推给人 |
|---|---|---|
| `by-model` | 模型自己调了 `kanban_block` | **要**。它明确说了要人 |
| `failed` | 连着失败两次（§12） | **要**。人不管就一直停在这儿 |
| `reopen-cap` | 被打回两次（§7） | **要**。这条链子转不出去了 |
| `stopped` | **人自己按的停止**（§13） | **不推** |

最后一档是这一节存在的全部理由。不分档的话，人在板上点一下停止，**下一秒手机上弹出一条
「你有一张卡卡住了」**——他刚按的那一下就是原因，而系统回头把它当成一件要他处理的事报给他。
顶栏那个计数同理：人停下来是为了改点什么，改之前那张卡不该在他的待办数字里。

`blockedReason` 那一列照旧存人话（「第三家的页面要登录」「跑到步数上限」「人停的」），
`blockedKind` 是给代码判的——**两列不合并**：把「要不要推」写成对 reason 文本的匹配，
是把一个判断挂在一句会被随手改掉的话上。

---

## 8. 调度：一次派卡，六步

调度挂在**已有的** Gateway tick 上（`GATEWAY_ROUTINE_TICK_MS`，默认 30 秒，设 0 就不起），
不新起定时器。每一轮：

1. **收依赖**：把「所有父卡都 `done`」的 `todo` 卡推成 `ready`。一条 SQL
2. **收死的**：两条判据，**先看心跳**——`running` 且最后一次心跳在
   `GATEWAY_KANBAN_STALE_MS`（默认 **3 分钟**）之前的，算一次失败（§12）；墙钟
   （`GATEWAY_KANBAN_TIMEOUT_MS`，默认 60 分钟）只当兜底上限
3. **选卡**：`ready` 且过了退避时间（`retryAfter`，§12）的卡，按 `priority desc, createdAt asc`，
   再过两道并发闸——这颗 Bot 已经有卡在跑的跳过；这个账号已经满 3 张的，它名下的卡这一轮
   整批跳过（§8 末）
4. **抢**：一条带旧值的 update（`ready` → `running`，CAS）。升级换版那几十秒里新旧两代进程
   会同时在跑，没有这一句，那一刻的卡会被派两遍（同 [routines.md §3](./routines.md) 的
   `claimRoutine`）
5. **派**：找到执行方席位（`instances.host` + 席位票 + 机器票，复用
   [gateway/src/lib/runtime.ts](../gateway/src/lib/runtime.ts) 的 `seatBearer` /
   `machineTokenFor`），`POST {seat}/api/cards` 把卡的执行包发过去
6. **等回报**：这一跳**立即返回**。卡跑完由席位主动打 `/internal/kanban/cards/:id/result`

第 5 步和 [routines.md §3](./routines.md) 那条路最大的区别是**不挂事件流、不等 `turn/end`**。
routine 要等是因为它把消息发进人的主会话、要知道那一轮的收口；卡跑在自己的会话上，收口
判据是 `kanban_complete` 那次调用本身，而它由席位直接回报。少一条要维护的长连接，也少了
「等到超时但事情其实早就做完了」那个毛病。

#### 为什么按心跳判，不按墙钟判

席位每 60 秒替这张卡报一次心跳（§15.2，**模型不管这件事**，见 §3）。判据要落在它上面，
否则那条心跳是白报的：

| 判据 | 席位被 kill 之后 |
|---|---|
| 只看墙钟（`startedAt + 60 分钟`） | 那张卡**干等 61 分钟**才回收，而心跳早在第 2 分钟就停了。人回来看到的是一张「正在跑」的卡，而跑它的进程一个小时前就没了 |
| **先看心跳（3 分钟）** | 三分钟内收成一次失败，下一轮重派。而墙钟仍然留着——它管的是另一件事：**进程还活着但那一轮陷进去了**，心跳照报，只有墙钟拦得住 |

两条判据管两种死法，都要有。3 分钟 = 三次心跳的间隔再加一点：一次网络抖动、一次 GC 停顿
都不该把一张正常的卡判死，而连着三次报不上来，那台席位多半是真没了。

**心跳只写 `cards.heartbeatAt` 一列，不写流水。** 一张跑一小时的卡会报 60 次，落成 60 行
`card_runs` 的话，人点开那张卡看到的是一屏「还活着」——而他要找的那行结论被顶到了最后。

**席位不在线 / 回 5xx / 回 `quiesced`**：卡**退回 `ready`**，不算失败，下一轮再派。理由同
[handoff.md §6](./handoff.md) 那条「席位不在线时退回上一档下轮重来」：机器整夜关着是常态，
把它记成失败的话，第二天早上一板子的红。退回时在时间线上写一行（§16），静静地退回和
「一直没被派」在界面上长得一模一样。

**席位回 409 `busy`**：同样退回 `ready`。这条是给独占资源准备的，见下。

上面三种退回**都不算失败、都不动 `attempt`**，但都要压一个**短退避**（`retryAfter` = 下一个
tick）——否则排空那几十秒里，同一张卡会每 30 秒被派一次、每次 503，日志里刷出一片，而什么
都没发生。

### 席位是资源的唯一权威

Gateway 只判两件事：席位在不在线、这台席位上有没有卡在跑。**它不判浏览器**。

一张卡要不要浏览器，写在卡上（`needsBrowser`）；而浏览器此刻是不是被别人占着，只有席位
自己知道——那是一个[席位单例](./delegation.md)（§7.1），人正对着那块屏。所以判据放在席位
的 `POST /api/cards` 入口：要浏览器、而它已经被占着 → 回 409 `busy`，Gateway 放回 `ready`。

理由和 [handoff.md §5](./handoff.md) 那条「抢单的 CAS 在席位那一个进程里」一模一样：**两边
各判一次，就会有一次判错，而判错的那次是静默的。**

#### 这道租约今天不存在，要造

说清楚，因为照抄 delegation 会落空：那边的 `leases` 是**一次委派批次内部**的分配
（[agent/index.ts:541](../bot/src/agent/index.ts:541) 那个 `tasks` Map，记的是「这一批的三条
子任务里，浏览器归第几条」），**主会话从来不持有任何租约**。所以「主会话正握着租约」这句话
在今天的代码里查不到东西，`taskOf(主会话)` 恒为 undefined。

要的是一个**席位级的、跨会话的**互斥：

```ts
/** 席位上那一颗浏览器，同一时刻只有一条会话在驱动它。 */
interface BrowserLease {
  /** 谁在用。主会话、委派子会话、卡片会话，一视同仁。 */
  sessionId: string
  /** 委派那批的租约仍然在批次内部再分一次，不冲突：这里管的是「哪条会话」。 */
  at: number
}
```

- **取**：任何一条会话第一次调 `browser_*` 时取；已经被别人拿着就拒（现有的
  `checkBrowser` 那道谁都关不掉的闸上加一条判据，见 [policy/browser.ts](../bot/src/policy/browser.ts)，
  写法同 delegation §7.1）
- **放**：那条会话的 `turn/end`。主会话一轮结束就放，所以「人正在用浏览器」的窗口是**一轮**，
  不是「这个人今天开着浏览器」——后者会让需要浏览器的卡整天派不出去
- **卡片会话怎么用**：在 `POST /api/cards` 入口**试取一次**（`needsBrowser` 为真时），取不到
  回 409 `busy`；取到了就一路持有到那张卡收口

**为什么不是「派了再说，跑到 `browser_*` 那一步再拒」**：那样卡已经跑了十几步、花了钱，才
发现最关键的那把工具用不了，而它多半会把「我打不开浏览器」写成结论收口——一张看起来做完了
的废卡。在入口拒掉，代价只是等 30 秒下一轮。

**为什么租约按会话发、不按「主会话优先」**：写成「主会话来了就把卡踢掉」的话，人随手点开
一个网页就会掐断一张跑到一半的卡。反过来「卡优先」更糟——人对着一块自己动不了的屏。先到先
得 + 一轮就放，是唯一不需要人理解规则的那种。

### 并发：一颗 Bot 一张卡，一个账号三张

两道闸，因为有两样共用的东西：

| 闸 | 默认 | 共用的是什么 |
|---|---|---|
| 一颗 Bot（一台席位）同时在跑的卡 | **1**（`kanban.seat_concurrency`） | 那个进程，和它那块屏 |
| 一个账号同时在跑的卡 | **3**（`kanban.account_concurrency`） | 一台机器上的一个 Linux 用户：CPU、内存、那棵 `~/work` |

第一道是 1，不是 2 或 3，理由是 `~/work`：[delegation.md §7.2](./delegation.md) 已经决定不给
工作区加锁，靠的是「一批并发委派的 goal 里各自划清文件范围」——那句话有个前提，**是同一个
主代理一次写出这一批的**。板上的卡来自不同的时候、可能不同的 Bot，没有任何一个环节会去划
这个范围。

第二道是这一版才需要的：板整个关在一个账号里（§6.1），于是一块板的活**全部落在一台机器
上**。默认 3 不是算出来的，是「一个人回来看的时候还读得懂」的数——机器扛不扛得住在
[负载那一屏](./gateway-runtime.md)看得见，真不够就调它。

**人和 Bot 的主会话都不计入这两道闸。** 它是人的：人随时会说话，而这颗 Bot 因为在跑一张卡
就不理他，是最糟的一种表现。代价是卡片会话和主会话可能同时在跑——它们本来就跑得起来（子
会话进 `live` 那条路已经在用），独占资源由上面那道租约兜住。

---

## 9. 席位那一侧：卡片会话

### 9.1 执行包

Gateway 派过来的就是一张卡的全部：

```jsonc
POST {seat}/api/cards
{
  "cardId": "c_7f3a",
  "boardId": "b_ops",
  "title":   "把这三家的报价整理成对比表",
  "body":    "……人或上游 Bot 写的交底书……",
  "brief":   "……这块板上跑的活是什么，板级的交底书……",
  "parents": [ { "id": "c_1", "title": "…", "summary": "…", "metadata": {…} } ],
  "comments": [ { "author": "张三", "body": "第三家的页面要登录，跳过" } ],
  "attempt": 2,
  "lastFailure": "第 1 次：跑到步数上限。最后一步在比对第三家的交期，页面要登录。",
  "modelRole": "utility",
  "maxSteps": 60,
  "needsBrowser": false,
  "deadlineAt": 1756280000000
}
```

`brief` 是**板级**的交底书（`boards.brief`），每张卡都带一份。它答的是「这块板在干什么」，
而 `body` 答的是「这张卡要做什么」——两句话分开写，人才不会在每张卡的 body 里把同一段背景
抄一遍，而抄漏的那次没有任何东西会提醒他。

`attempt` / `lastFailure` 只在重试时有（§12）。**必须带**：不带的话第二次会一字不差地重演
第一次，包括那个错。

`parents` 里带**结论和交付证据**，不带过程——这正是看板的全部价值所在（同
[delegation.md](./delegation.md) 开篇那句：这件事的价值是上下文，不是并发）。**文件不用带**：
父卡就在同一棵 `~/work` 里跑的（§6.1），`metadata.changed_files` 里那几个路径直接读得开。
这是把板关在一个账号里换来的最实在的一件东西。

### 9.2 会话根事件

在 [delegation](./delegation.md) 已经加过的两个可选字段上**扩一个取值**，不加新字段：

```ts
'session': {
  /** `task` = 一次委派开出来的子会话；`card` = 一张看板卡。缺省按 `main` 读。 */
  kind?: 'main' | 'task' | 'card'
  /** 谁开的。`card` 这一档里 taskId 就是卡号，sessionId/callId 为空。 */
  parent?: { sessionId: string; callId: string; taskId: string }
}
```

不动 `SESSION_FORMAT_VERSION`（同 delegation 那条：加取值不是破坏性变更）。卡片会话 id 用
`c-` 前缀（主会话 `s-`，委派子会话 `t-`），**但代码里不许拿前缀做判断**——事实源是 `kind`。

标题一律写成 `卡：<title 的前 30 字>`。理由和子会话那条一样：回滚一版之后过滤就没了，
侧栏里会冒出一批卡片会话，那时它们必须自己说得清自己是什么。

#### 「加一个取值」实际要动五处，一处都不能漏

委派那一版把 `'task'` 硬写进了判断里，所以第三个取值出现时它们全都要从「是不是 task」
改成「**是不是 main**」。这不是洁癖：漏掉任何一处，表现都是静默的。

| 在哪 | 现在 | 改成 | 漏了会怎样 |
|---|---|---|---|
| [session/index.ts:81](../bot/src/session/index.ts:81) | `kind === 'task' && !opts.parent` 就抛 | `kind && kind !== 'main'` 都要有 parent | 卡片会话的 `parent` 只有 taskId，**这条断言当场把它拦下来**，一张卡都开不出来 |
| [session/index.ts:89](../bot/src/session/index.ts:89) | id 前缀 `task ? 't' : 's'` | 三档：`main→s` / `task→t` / `card→c` | 卡片会话拿到 `s-` 前缀，运维时 `ls` 分不开（只是不便，不是错） |
| [session/index.ts:100](../bot/src/session/index.ts:100) | 只有 task 才写 `kind` 和 `parent` | 非 main 都写 | **根事件里没有 `kind`**，于是下面两条过滤全部失效 |
| [session/index.ts:159](../bot/src/session/index.ts:159) | `if (data.kind === 'task' && !opts.tasks) return null` | `if (data.kind && data.kind !== 'main' && !opts.tasks) return null` | 卡片会话进 `list()`，于是被 `ensureSession` 认领成主会话——**某个人的对话变成了昨天某张卡的现场** |
| [session/gateway.ts:374](../bot/src/session/gateway.ts:374) | `isTask()` 判 `kind === 'task'` | 判 `kind !== 'main'`（函数改名 `isSideSession`） | 卡片会话上报会话索引，违反口径二，而且控制面的会话列表里天天多出几十条 |

**[registry/index.ts:352](../bot/src/registry/index.ts:352) 和
[:382](../bot/src/registry/index.ts:382) 反而不用改**——它们调的是 `sessions.list()`，而
过滤本来就做在 `list()` 里面（上表第四行）。这一点值得写下来：把判据留在**产出那一侧**，
调用方一个都不用学，而这次多一个 `kind` 正好验证了当初那个选择是对的。

### 9.3 systemPrompt

在 `composeSystem` 的产物上减一段、加一段（对照 [delegation.md §12.4](./delegation.md)）：

| 段 | 卡片会话 |
|---|---|
| Bot 提示词 | **继承**。派给这颗 Bot 就是要它以这个身份干活 |
| Skill 正文 | **继承**。「这家公司怎么做这件事」不能因为换了条会话就没了 |
| [长期记忆](./memory.md)正文 | **继承**（但不许写，§10.4）。同上一条：它是「这颗 Bot 知道的事」 |
| `runtimeBlock()` | 继承 |
| `escalateBlock()` | **不加**（§4 口径三） |
| `cardBlock()` **新增** | 你在做板上的一张卡；**你面前没有人，问不了问题**；卡住调 `kanban_block` 并把卡在哪儿写清楚；做完调 `kanban_complete`；草稿写 `cards/<cardId>/`；上游卡的结论在 `kanban_show` 里，**它列出的文件就在你的 `~/work` 里，直接读**；你写的成品路径要写进结论 |

### 9.4 收口：跑完了但没交结论

一轮 `turn/end` 了，卡还是 `running` —— 也就是模型既没 `complete` 也没 `block`。

**算一次失败**（走 §12 那条重试/blocked），把最后那段 assistant 文本原样附在失败原因里。

不把最后那段文本当成结论收成 `done`：那是**编**。同
[delegation.md §12.3](./delegation.md) 那条「没有文本时置 failed，编一段摘要出来是最糟的
选项」——而这里更糟，因为下游卡会拿这段编出来的东西当交底书继续做。

---

## 10. 工具

### 10.1 两组，注册判据不同

| 组 | 有哪些 | 在哪注册 |
|---|---|---|
| **板上的** | `kanban_list` `kanban_create` `kanban_link` `kanban_comment` | 这颗 Bot 是**某块板的成员**时。主会话、卡片会话都有 |
| **卡上的** | `kanban_show` `kanban_complete` `kanban_block` | **只有卡片会话有**。主会话里没有「当前这张卡」这个东西 |

第一组在主会话里必须有：「帮我把这事拆成三张卡派给设计 Bot」是这个功能最自然的入口，而
它发生在人和 Bot 的对话里。

#### 席位怎么知道自己在板上：目录里多一格，而且要进指纹

「这颗 Bot 是某块板的成员」这句话的事实源在 Gateway 的 `board_members`，而**决定注不注册工具
的是席位**。中间那条路只有一条：`/runtime/catalog`（席位启动拉一次、之后按探针重拉）。

所以目录里多一格，形状和它已有的那几格一样：

```jsonc
{ "boards": [ { "id": "b_ops", "name": "运营", "role": "出图" } ] }
```

**`catalogStamp` 必须把它算进去**（[gateway/src/routes/runtime.ts:46](../gateway/src/routes/runtime.ts:46)）。
不算的话：人把一颗 Bot 加进板 → `catalog_items` **一个字节都没变** → 每分钟那次探针判「没变」
→ 席位永远不重拉 → **那几把工具永远不出现**，直到有人重新部署这个席位。而界面上那次「加进
板」明明回了成功。

这个洞这个仓里已经踩过三次，每次都写进了那个函数的注释里：连接器那一截、平台钉的两个模型
角色、[长期记忆](./memory.md)。**它是同一个洞的第四次**——所以这里不重新论证，只把它列进
落地清单，并在验收里留一条（§19）。

顺带一件白捡的事：`role` 那一列（§15.1）跟着目录下来，`kanban_list` 在席位本地就答得出
「这块板上有谁、各干什么」，不用每次问 Gateway。

#### 往哪块板建：必须点名

一个人可以有好几块板（§3），一颗 Bot 可以同时在其中几块上。**主会话里没有「当前这块板」
这个东西**——人上一句在聊别的，下一句说「派给设计 Bot」，谁也说不出他指的是哪块板。

所以：

- `kanban_list()` 不带参数时，返回**这颗 Bot 所在的全部板**，按板分组，每块板带自己的
  成员名单和未闭合的卡。它同时是「有哪些板」和「板上有谁」这两个问题的答案——**模型只有
  一把工具可以问路，别让它猜**
- `kanban_create` 的 `board` **必填**，而且是**整次调用一个**（不是每张卡一个）：一次调用
  里的几张卡本来就该是同一件事的几步，允许它们散到不同板上，只会让模型有机会把一条流水线
  拆到两块板上，而依赖不跨板（§3），那条链子当场断掉
- 卡片会话里 `board` 可以省，省了就是**当前这张卡那块板**。这一档是白给的：那条会话本来
  就是从一张卡开出来的

`board` 写了个不存在的、或者不是这颗 Bot 所在的，回错并把 `kanban_list` 那份名单原样附上
——同 `assignee` 那条（§6.2）：告诉它有哪些选项，比告诉它「你错了」有用。

**没有 `kanban_heartbeat`**（§3）。**没有 `kanban_unblock`**（§7）。**没有 `kanban_assign`**：
改指派是人的动作，模型要换人做，建一张新卡。

### 10.2 委派标注

每一把内置工具都要回答 [delegation.md §6.1](./delegation.md) 那四个问题（漏答的话
`ToolService.register` 在启动时直接抛，进程起不来）。这七把的答案：

| 工具 | `mode` | 为什么 |
|---|---|---|
| `kanban_show` / `kanban_list` / `kanban_comment` | `inherit` | 读和留言没有归属问题。卡片会话里派出去的子代理**该**看得见自己在做哪张卡 |
| `kanban_complete` / `kanban_block` | **`root-only`** | 收口是这张卡那一轮的事。子代理替它收口的话，主流程还在跑，而卡已经 `done` 了 |
| `kanban_create` / `kanban_link` | **`root-only`** | 挡的是「子代理绕过深度限制去派活」：委派深度定死 1，但如果子代理能建卡，它就能派出一张跑在别的席位上的活——那正是深度限制要拦的东西，只是绕了一圈 |

`exclusive` / `rebind` / `retains` 七把全不标。

**`history_read` / `history_search` 在卡片会话里不注册。**

它们标着 `rebind: true`，而那个标注的判据是[「它摸的那份东西属于什么」](./delegation.md)（§6.1）：
`history_*` 摸的是**这场对话**，所以在委派里重绑到主会话——因为子代理和主代理确实在同一场
对话里。**一张卡不属于任何一场对话**：它可能是人在板上敲出来的，可能是另一颗 Bot 派的，
中间隔着几个小时。重绑到执行方那颗 Bot 的主会话，读回来的是一段和这张卡无关的聊天；不
重绑就是读它自己那条刚开的会话，读了等于没读。两个答案都不对，说明这把工具在这里没有位置。

它本来的作用（子代理靠它补主代理没写全的交底书）由 `kanban_show` 顶上：父卡结论 + 评论就是
这张卡该知道的全部，而这份东西是**在板上、人看得见**的。它看不懂，是 body 写得不清楚，
该有人去改那张卡——而不是让它自己去翻聊天记录里碰运气。

### 10.3 卡片会话里能不能再委派：能

`delegate_task` 标着 `mode: 'root-only'`，但那条强制的判据是
[policy/index.ts:611](../bot/src/policy/index.ts:611) 的 `agents.taskOf(call.sessionId)`——一张
**内存里的、只登记「哪条子会话属于哪次委派」的表**。卡片会话不是委派开出来的，`taskOf` 查
不到它，所以这把工具在卡片会话里**天然是通的**。

这正是我们要的，写下来是因为它太容易被当成漏网之鱼补掉：**一张卡是它那一层的根。** 委派
深度定死 1 拦的是「子代理再派子代理」那种指数展开（3×3×3），而卡和主会话是平级的两个根，
各自往下一层。一张跑 60 步的卡里有一段脏活要交出去，和主会话里那件事没有任何区别。

两件配套的小事：

- **拒绝话术要加一档。** 那段短路现在说的是「由主代理再派一次」「由主代理去问人」——写给
  委派的。卡片会话里的子代理撞上 `kanban_complete` 时，该说的是「收口是那张卡自己的事，
  把结论交回给派你出来的那一层」。按 `taskOf` 拿到的那次委派的**根是不是卡片会话**来分档
- **`healTasks()` 要扫卡片会话。** [agent/index.ts](../bot/src/agent/index.ts) 那个「席位起来时
  把停在 `running` 的 `agent/task` 补成 `lost`」的扫描，遍历的是 `sessions.list()`——而卡片
  会话不在里面（§9.2 那张表第四行）。卡里委派出去的那几条要是停在 `running`，界面上那张卡
  片里的委派会永远转着。扫描要显式带上 `{ tasks: true }` 之外的那一档

### 10.4 长期记忆：读得到，写不了

[长期记忆](./memory.md)刚合进来，它那两把工具在卡片会话里各是什么待遇，要当场定死——
不定的话默认值是错的那一档：`memory_write` 标着 `mode: 'root-only'`，而那条强制看的是
`taskOf`（§10.3），对卡片会话返回 undefined，所以**它默认是通的**。

| | 卡片会话 | 为什么 |
|---|---|---|
| 记忆正文进提示词 | **继承** | 和 Skill 同一档（§9.3）：它是「这颗 Bot 知道的事」。缺了它，卡会用一套和人平时聊天时不一样的口径把活干完 |
| `memory_list` | **给** | 读没有归属问题 |
| `memory_write` | **不注册** | 见下 |

两条理由，第二条是决定性的：

1. **写入这条路的兜底是「人能拦下来」。** [memory.md §4](./memory.md) 把它和「决定要不要发
   一封邮件」归成同一类动作——留痕、过策略闸、能被人拦。而卡片会话面前没有人（口径三），
   那道兜底在这儿是空的
2. **记忆有上限。** 一块板一天几十张卡，每张顺手记一条，几天就把上限填满了——而被挤出去的
   正是**人亲口让它记的**那几条。「以后所有对外邮件都抄送法务」被一条「这家供应商的报价页
   要登录」顶掉，是这个功能最坏的一种失效方式，而且它是静默的

卡里真学到了值得记的东西怎么办？**写进结论**。人在板上看得见，觉得该记就在对话里说一句
——那时它走的是有人看着的那条路。

### 10.5 `risk`

`kanban_show` / `kanban_list` 是 `['read']`；其余五把是 `['write']`。

**不是 `external`**，尽管 `kanban_create` 的后果是让另一台机器跑起来。理由和
[delegation.md §12.1](./delegation.md) 那条一模一样：`checkExternal` 判的是「这次调用打的是
哪个外部系统」，而它打的是 Gateway，没有那个东西可判，只会落到兜底那句上——于是开着
`no-external` 的 Bot **一张卡都建不了**。真正会发出去的是执行方那些调用，它们每一次都单独
过同一条管道。

也**不弹审批卡**（`needsApproval` = external + write，纯 write 不弹）。一张卡派出去，最远也
只到这个人自己的另一台席位、自己的那棵 `~/work`（§6.1）——真正会出去的动作在那颗 Bot 手上，
到时候单独过闸。每建一张卡弹一次，只会训练人闭着眼睛点同意。

---

## 11. 模型档位与钱

卡上一格 `modelRole`，取值和 [routines](./routines.md) / [delegation](./delegation.md) 同一套
（`TurnModelRole`），**默认 `utility`**。

默认落在便宜那一档，判据和 routines 一字不差：**没人在等着看**。一块板一天几十张卡，全跑
面对面聊天那一档模型是这个功能唯一能把钱烧穿的方式。

**Bot 建卡时必须逐条表态并给理由**，抄 [delegation.md §8.3](./delegation.md)：`model_reason`
排在 `model_role` **前面**，没写理由的 `utility` 一律降成 `daily`。先蹦出档位再补理由，写
出来的是事后合理化。

人在界面上建卡时是一个两项的开关，默认 `utility`，旁边写着那两问：**做法定死了吗？做错了
看结论看得出来吗？** 两个都是「是」才给 `utility`。

四处**故意不保证**照抄 [routines.md §4](./routines.md)：席位取不到 utility 就照旧跑并留 warn；
装不进 utility 的窗口就退回 Bot 自己的模型；旧版席位当这个字段不存在。第四条（话被插进正在
跑的那一轮）在这里不成立——卡自己开一条会话，没有插话这件事。

### 钱记在谁头上

卡跑在他自己的席位上，用的是他那把 `sk_sw_`，所以 `llm_calls` 那一行落在**他**名下——和他
自己跟这颗 Bot 聊天时一模一样。板关在一个账号里（§6.1）把「替别人跑的卡算谁的」这个问题
整个消掉了，计费链路一个字都不用改。

要看得更细的话是一条 join：`llm_calls` 带 sessionId，卡片会话 id 反查得到卡号，所以「这张卡
花了多少」「这块板这个月花了多少」都算得出来。板详情页上直接给这个数（§16）——一块板跑起来
之后，它是人唯一会问的那个数。

---

## 12. 三个数，和失败怎么办

| 闸 | 默认 | 可调 | 到顶怎么办 |
|---|---|---|---|
| 一张卡的步数 | **60** | 卡上 `maxSteps`，上限 = 主代理的 `maxSteps` | 收口成一次失败，原因「跑到步数上限」+ 它最后说的那段 |
| 一颗 Bot 同时在跑的卡 | **1** | `kanban.seat_concurrency` | 别的卡留在 `ready`，下一轮再看 |
| 一个账号同时在跑的卡 | **3** | `kanban.account_concurrency` | 同上 |
| 席位多久没心跳算死了 | **3 分钟** | `GATEWAY_KANBAN_STALE_MS` | 算一次失败（§8）。这是**主要**的回收路径 |
| 一张卡的墙钟 | **60 分钟** | `GATEWAY_KANBAN_TIMEOUT_MS` | 席位自己 abort；Gateway 那边超一分钟还没等到回报也当失败。**兜底，不是主路** |

60 步不是委派的 30、也不是主会话的 120：一张卡是被**单独描述清楚**的完整任务（比一段子活
大），但它没有「装环境、跑测试、按报错改再跑」那条主会话才有的长链子。

墙钟**两层都要有**，这一条和委派不同：委派只需要主轮里 abort，因为主轮就在那儿；卡的执行方
可能整台机器掉线，那时唯一还醒着的是 Gateway。席位那层负责把进程收干净，Gateway 那层负责
让卡不要永远停在 `running`——**少了后者，界面上那张卡会永远转着，而人唯一能做的是怀疑自己
的浏览器**（同 [delegation.md §10](./delegation.md) 那条 `lost`）。

但 Gateway 那层**平时走的是心跳那条**（§8），墙钟只在「进程还活着、那一轮陷进去了」时才轮
得到——那时心跳照报，只有墙钟拦得住。两条判据管两种死法。

### 失败与重试

一次失败 = 席位回报了错、跑完没交结论（§9.4）、**心跳停了 3 分钟**、或者墙钟到顶。

**席位不在线、409 busy、换版静默不算**（§8）——那三种是「这一轮没派出去」，不是「派出去
做砸了」。

```
失败 1 次 → 回 ready，attempt+1，**至少等 5 分钟**再重派
失败 2 次 → blocked（`blockedKind: 'failed'`），reason 写最后一次的错
```

上限 2 抄 Hermes 的 `failure_limit`。重试**不换模型档位**——那是主动的补救，见下。

**那 5 分钟（`GATEWAY_KANBAN_RETRY_DELAY_MS`）不能省。** 不等的话，下一个 tick（30 秒）就
重派，于是一张撞了确定性错误的卡**在一分钟内把两次 attempt 全烧完**，直接进 `blocked`——
而重试这件事本来是为「上一次是个偶然」准备的。落地上是一列 `retryAfter`，选卡那条 SQL 多
一个 `and ("retryAfter" is null or "retryAfter" <= now)`。

顺带它也修掉换版静默那个毛病：排空那几十秒里卡会被派、回 503、退回 `ready`，不等的话
这个循环每 30 秒转一次，而**它退回的不是失败**（§8），所以 attempt 不动、退避也不该按失败
那一档算——静默和 busy 走的是**短退避（一个 tick）**，只有真失败才等 5 分钟。

**重试时它看得见上一次。** `card_runs` 一次一行，执行包里带上「上一次是怎么失败的」（同
Hermes 的 `task_runs`：workers see prior attempts）。不带的话，第二次会一字不差地重演第一次，
包括那个错。

**档位选低了长什么样**：一张 `utility` 的卡撞满 60 步、结论停在半路。这时正确的动作是人（或
上游 Bot）把它 `reopen`、`modelRole` 改成 `daily`——所以**档位必须出现在卡上和结论里**，
不能只留在库里（同 [delegation.md §12.3](./delegation.md)：模型看不见事件）。

---

## 13. 生命周期

### 人按停止

板上每张 `running` 的卡有一颗停止。点了 → Gateway 打席位 `POST /api/cards/:id/abort` →
那一轮的 `signal` → 卡收成 `blocked`，`blockedKind: 'stopped'`，reason「人停的」。**不算失败**，
不占 attempt：人停它是因为他要改点什么，不是因为它做错了。

**这一档不推通知、也不进顶栏计数**（§7 那张分档表）：他刚按完停止，紧接着收到一条「你有
一张卡卡住了」，是这套通知最容易失去信任的一种方式。

### 换版静默

`quiesced()` 期间**不接新卡**（在 `POST /api/cards` 入口判，回 503 + `QUIET_MESSAGE`），
Gateway 把卡放回 `ready`。已经在跑的那张照旧——它进了 `live`，`busy().running` 自动把它算上，
排空会等它（同 [delegation.md §10](./delegation.md)，**同样要写进验收，因为它靠的是卡片会话
进 `live` 这个实现细节**）。

### 席位进程重启

卡片会话不恢复。会话最后停在一个不收口的轮次上，下次读盘由 `healDanglingTurn` 补上
（[session/index.ts:277](../bot/src/session/index.ts:277)）；Gateway 那边那张卡停在 `running`，
**三分钟内由心跳判据收成一次失败**（§8），下一轮重派。

三分钟不是一个将就的数：席位重启本来就在这个量级（换版排空 + 进程起来 + 拉目录），所以
「重启一次」和「进程死了」在 Gateway 看来本来就该是同一件事——**都是这张卡没人在跑了**，
而处理方式也该一样：收掉，重派。

**席位启动时不要去扫「我有没有没跑完的卡」。** 权威在 Gateway，而席位不知道自己该有哪些卡
——它扫出来的只有一堆孤儿会话。让墙钟去收，多等最多一分钟，但只有一个地方说了算。

### Gateway 进程重启

`running` 的卡靠 `startedAt` 判，不靠内存里有没有 watcher（这一条抄
[routines.md §5](./routines.md)：**判据是「有多久了」，不是「有没有在跑」**）。一把收掉所有
`running` 会踩到活人——升级换版那几十秒里新旧两代同时在跑，新进程一起来就会把旧进程刚派
出去的卡判成失败。

### 卡被删 / 板被删

卡删了 → 席位那边如果还在跑，下一次心跳带回 404，席位 abort 掉那一轮。板删了 → 卡级联删。
**席位上的卡片会话 JSONL 不删**：日志一条不删是[全仓通用的规矩](./chat-commands.md)，而且
「这张卡当时干了什么」正是删掉之后最可能被问的问题。

---

## 14. 通知

复用[交接单那三层](./handoff.md)，一层都不新造：

| 层 | 场景 | 怎么做 |
|---|---|---|
| 1 | 人正看着板 | 板上那张卡自己变色（轮询，§16） |
| 2 | 人在别的屏 | 顶栏那个待办计数**同时数**「指给我的未闭合交接单」和「我自己板上的 blocked 卡」——**`blockedKind: 'stopped'` 的不算**（§7） |
| 3 | 人不在场 | 复用 `companies.handoffWebhook` 那条 URL |

第 2 层那个计数是这一节的关键：**一张 blocked 的卡和一张开着的交接单，对人是同一件事**。
分成两个数字、两页清单的话，人要学会看两个地方，而他只会记住一个。

第 3 层**只推 `blocked`，而且只推其中三档**（`by-model` / `failed` / `reopen-cap`，见 §7），
不推 `done`，也不推人自己停的那些。一块板一天几十张卡跑完，全推进群里，那个群一周内
就会被静音——而静音之后，真正要人管的那条 `blocked` 也一起没了。催办和升级那两档
（`T1` / `T2`）在卡上**不做**：卡没有「超时就作废」这回事，它就停在 `blocked` 等着，板上
看得见。

**这条 webhook 是公司级的，而板只有主人看得见**（口径〇），所以推出去的那条消息**连标题都
不带**：只有归属人 + 卡号 + 一句「有一张卡卡住了」。

看着没用，其实正好够：**这一层的作用是把人叫回来，不是让他在群里把事读完。** 带上标题就是
把一块私人板的内容一天几条地倒进公司群，而板名和卡名恰恰是最能说明问题的两样东西
（「离职交接」「面试候选人筛选」）。要更细的，点链接回来看——那时判据又是那句
`boards.accountId === jwt.accountId`，一条路一个口径。

### `notify`：做完了告诉我

卡上一格，两个值：

| 值 | 完成时 |
|---|---|
| `none`（默认） | 什么都不做。结论在卡上 |
| `report` | 往**做完这张卡的那颗 Bot** 的主会话发一条 plugin 消息，起新一轮 |

走的是 [handoff 交还](./handoff.md)那条现成的路（`source = { kind: 'plugin', plugin: 'kanban',
form: <卡号> }`），正文是拼好的一段：哪张卡、结论是什么。

**这一档叫 `report`，不叫 `owner`。** 上一稿写的是 `owner`，而它发给的是 assignee——名字
读起来像「发给板主人」，看代码的人会照着错的那个意思去改。

**为什么发给 assignee 那颗 Bot，不是发给建卡的人常用的那颗。** 人看到汇报之后第一句多半是
追问（「那第三家呢」），而唯一还能接住这句的是刚做完那件事的那颗——它至少在自己主会话里
拿得到那段结论，还能 `kanban_list` 找回这张卡。发给别的 Bot 的话，人问出去的那句话砸在一颗
完全不知情的 Bot 身上，它只能回一句「我不清楚」。

**Bot 建卡时默认 `none`，而且工具描述里要教它别改**：它要拿下游的结果，正确做法是**建一张
依赖卡指给自己**——那是板本来就有的东西，而且它不会在人的对话里凭空冒出一段汇报。`report`
这一档是给**人**建卡时用的：他挂完就走了，希望有人喊他。

---

## 15. 契约

### 15.1 库（迁移 `0021-kanban`）

编号迁移，见 [gateway/src/db/migrate.ts](../gateway/src/db/migrate.ts)，**不要回去改老的那几条**。

```sql
create table if not exists boards (
  id          text primary key,
  -- 归属一个员工（§6.1）。成员 Bot 必须都在他名下，所以这一列是**全表的判据**：
  -- 卡派到哪台席位、文件在谁的 ~/work 里、用量算谁的，全从这里推。
  "accountId" text not null references accounts(id) on delete cascade,
  -- 计费和隔离照旧在公司这一层。冗余一列是为了不用每次 join accounts。
  "companyId" text not null references companies(id) on delete cascade,
  name        text not null default '',
  -- 这块板上跑的活是什么。会进每张卡的执行包，当作板级的交底书。
  brief       text not null default '',
  archived    boolean not null default false,
  "createdAt" bigint not null,
  "updatedAt" bigint not null
);
create index if not exists board_of_account on boards ("accountId") where not archived;

-- 成员名单。**只有人能改**（§6.2），模型只能在这张表里挑。
-- **没有 accountId 这一列**：成员恒等于板归属那个人名下的 Bot（§6.1）。
-- 存一份的话，它和 boards.accountId 就有了两个事实源，而不一致的那天没有任何东西会响。
create table if not exists board_members (
  "boardId"   text not null references boards(id) on delete cascade,
  "botId"     text not null references catalog_items(id) on delete cascade,
  -- 这颗 Bot 在这块板上干什么。会出现在别的 Bot 的 kanban_list 里——
  -- 派活的那颗要靠它挑人，没有它就只能按名字猜。
  role        text not null default '',
  "addedAt"   bigint not null,
  primary key ("boardId", "botId")
);

create table if not exists cards (
  id          text primary key,
  "boardId"   text not null references boards(id) on delete cascade,
  -- 都从板上冗余下来，为的是调度那条 SQL 不用 join：选卡要按账号数并发（§8）。
  "accountId" text not null references accounts(id) on delete cascade,
  "companyId" text not null references companies(id) on delete cascade,
  title       text not null default '',
  body        text not null default '',
  -- 派给哪颗 Bot。必须在 board_members 里，建卡和改派都验。
  -- 席位是 (cards.accountId, assigneeBotId) 那一对——**账号不从这里取**，从板上取。
  "assigneeBotId" text references catalog_items(id) on delete set null,
  state       text not null check (state in ('todo','ready','running','blocked','done','archived','cancelled')),
  priority    integer not null default 0,
  -- 人建的这一列空；Bot 建的记那颗 Bot。板归属谁已经在 accountId 上了，不重复存。
  "createdByBotId" text,
  "modelRole"   text not null default 'utility' check ("modelRole" in ('daily','utility')),
  -- 选这一档的理由。**给人看的**，不进模型（§11）。降过级的这里写降级后的实情。
  "modelReason" text not null default '',
  "modelDowngraded" boolean not null default false,
  "needsBrowser" boolean not null default false,
  "maxSteps"    integer not null default 60,
  -- 做完了要不要吭一声。`report` = 往做完它的那颗 Bot 的主会话发一条（§14）。
  -- **不叫 `owner`**：那个名字读起来像「发给板主人」，而它发给的是 assignee。
  notify        text not null default 'none' check (notify in ('none','report')),
  -- 跑在哪条会话上。点进去就是全文（去席位拉）。每次重试都会换一条。
  "sessionId"   text,
  -- 席位最后一次说「这张卡还活着」是什么时候（席位每 60 秒一次，模型不管）。
  -- **回收主要看它**，不看 startedAt：席位被 kill 之后心跳当场停，而墙钟还有 59 分钟
  -- 才到——那 59 分钟里界面上是一张正在跑的卡，跑它的进程早没了（§8）。
  "heartbeatAt" bigint,
  -- 失败了几次（上限 2 → blocked）、被打回几次（上限 2 → blocked）。
  attempt     integer not null default 0,
  reopens     integer not null default 0,
  -- 在这个时间之前别再派它（§12 的退避）。真失败等 5 分钟，busy / 静默只等一个 tick。
  -- null = 随时可派。
  "retryAfter" bigint,
  -- 结论，和交付证据（changed_files / verification / residual_risk…）。
  summary     text not null default '',
  metadata    jsonb,
  -- 为什么停住了。**给代码判的**（通知要不要推、算不算进顶栏计数，见 §7）。
  -- 和下面那行人话**不合并**：把「要不要推」写成对 reason 文本的匹配，是把一个判断
  -- 挂在一句会被随手改掉的话上。
  "blockedKind" text check ("blockedKind" in ('by-model','failed','reopen-cap','stopped')),
  -- blocked 的原因，人话。人在板上看到的就是这一行。
  "blockedReason" text not null default '',
  -- 同一颗 Bot、同一个 title 指纹、**同一个 5 分钟时间桶**只建一张（§15.4）。
  -- 桶号一定要进指纹：不进的话，下面那条唯一索引是**永久**的，同一个标题隔一天再建会
  -- 撞唯一键，而人看到的是一次莫名其妙的失败。
  "dedupeKey"  text,
  "createdAt" bigint not null,
  "startedAt" bigint,
  "endedAt"   bigint,
  "updatedAt" bigint not null
);
-- 调度器每半分钟扫的就是这两个条件。
create index if not exists card_ready on cards ("accountId", "retryAfter", priority desc, "createdAt") where state = 'ready';
-- 收死的：先按心跳扫（主路），墙钟那条兜底扫的是同一批行，一个索引够用。
create index if not exists card_running on cards ("heartbeatAt", "startedAt") where state = 'running';
-- 板上那一屏；顶栏那个 blocked 计数。
create index if not exists card_of_board on cards ("boardId", state, "updatedAt" desc);
create index if not exists card_assignee on cards ("accountId", "assigneeBotId", state);
create unique index if not exists card_dedupe on cards ("boardId", "dedupeKey") where "dedupeKey" is not null;

-- 依赖。**不跨板**（§3）：建链时验两头的 boardId 相同。
create table if not exists card_links (
  "parentId" text not null references cards(id) on delete cascade,
  "childId"  text not null references cards(id) on delete cascade,
  primary key ("parentId", "childId")
);

-- 一条时间线：人写的评论 + 系统写的状态变更，混在一起按时间排。
create table if not exists card_comments (
  id         text primary key,
  "cardId"   text not null references cards(id) on delete cascade,
  kind       text not null check (kind in ('comment','system')),
  -- 人写的带 accountId；Bot 写的带 botId；系统写的两个都空。
  "authorAccountId" text references accounts(id) on delete set null,
  "authorBotId"     text,
  body       text not null default '',
  "createdAt" bigint not null
);
create index if not exists card_comment_of on card_comments ("cardId", "createdAt");

-- 每一次执行一行。重试时执行包里带上一行，见 §12。
create table if not exists card_runs (
  id          text primary key,
  "cardId"    text not null references cards(id) on delete cascade,
  attempt     integer not null,
  "sessionId" text,
  -- 跑在哪颗 Bot 上。卡改派之后这一行仍然指得回当时那颗。
  "botId"     text not null,
  "machineId" text,
  -- `stale` = 席位失联（心跳停了），和 `error`（席位报了错）分开：
  -- 前者查不出那一轮做到哪儿了，写成 error 是在编（同 delegation 那条 `lost`）。
  status      text not null check (status in ('running','ok','error','stale','aborted')),
  steps       integer,
  "toolCalls" integer,
  error       text,
  "startedAt" bigint not null,
  "endedAt"   bigint
);
create index if not exists card_run_of on card_runs ("cardId", "startedAt" desc);
```

**为什么没有 `card_events` 表。** Hermes 有一张，因为它的 dashboard 靠 WebSocket 推那张表。
我们轮询，而人真正要读的时间线只有一条——`card_comments` 里 `kind: 'system'` 那些行就是它
（「张三改派给了设计 Bot」「第 1 次失败：跑到步数上限」「被打回：第三家的价钱抄错了」）。
两张表的话，界面上要 merge 两个源再按时间排，而其中一个源人根本读不懂。

审计那一栏另有出处（§6.2 / §6.3），它记的是另一个问题：**这颗 Bot 会不会自己动**，不是这块板
每天发生了什么。

### 15.2 Gateway 接口

```
# 用户 JWT
GET    /kanban/boards                         我的板 + 每块板的未闭合计数
POST   /kanban/boards                         建板
PATCH  /kanban/boards/:id                     改名 / 改 brief / 归档
GET    /kanban/boards/:id                     一块板：成员 + 卡（按状态分组）+ 本月花费
POST   /kanban/boards/:id/members             加一颗**我自己名下**的 Bot 进板。**进审计**
DELETE /kanban/boards/:id/members/:botId      移除成员。**进审计**
POST   /kanban/boards/:id/cards               建卡
GET    /kanban/cards/:id                      一张卡：全文 + 依赖 + 时间线 + 每次跑的流水
PATCH  /kanban/cards/:id                      改标题/正文/指派/优先级/档位。running 的卡只让改优先级
POST   /kanban/cards/:id/comments             留言
POST   /kanban/cards/:id/unblock              解锁 → ready（**只有人能调**，§7）
POST   /kanban/cards/:id/reopen               打回一张 done 的卡 { reason }。上限 2
POST   /kanban/cards/:id/abort                停掉正在跑的这一轮
POST   /kanban/cards/:id/cancel               撤销
POST   /kanban/links                          建依赖 { parentId, childId }。跨板 400
DELETE /kanban/links                          删依赖

# 模型调的那几把工具：席位那把 runtime 票（`sat_`）+ `?botId=`，服务端 seatBotOf 验归属
GET    /runtime/kanban/boards?botId=             `kanban_list`：这颗 Bot 所在的板 + 成员 + 卡
GET    /runtime/kanban/cards/:id?botId=          `kanban_show`：卡全文 + 父卡结论 + 评论
POST   /runtime/kanban/cards?botId=              `kanban_create`。**body 带 board**
POST   /runtime/kanban/cards/:id/links?botId=    `kanban_link`
POST   /runtime/kanban/cards/:id/comments?botId= `kanban_comment`

# 席位运行面报的（不是模型调的）：机器票 / 席位票，同 requireInternalCaller 口径
POST   /internal/kanban/cards/:id/result      收口 { status, summary, metadata, steps, toolCalls, error }
POST   /internal/kanban/cards/:id/heartbeat   还活着（席位每 60 秒一次，模型不管）
```

**`kanban_complete` / `kanban_block` 一调就打 `/result`，不等 `turn/end`。** 这一条决定了
§9.4 那个判据成不成立，必须写死：

| 走法 | 结果 |
|---|---|
| 等 `turn/end` 一起报 | 模型 `complete` 之后还可能接着说两句、还可能撞上步数上限被截断——**那时收口已经发生了，但 Gateway 不知道**。而 §9.4 判的正是「`turn/end` 时卡还 `running`」，等报的话这个判据永远为真，每张卡都算失败一次 |
| **一调就报** | Gateway 那边卡当场进终态；席位这边工具返回一句「已收口，接下来只需要收尾」，那一轮自己结束。`turn/end` 时卡已经不是 `running` 了，§9.4 那条自然不触发 |

工具返回的那句话要明确说「这张卡已经收口了，别再调第二次」——**第二次调 `/result` 一律回
409 并原样告诉模型**，不要静静地覆盖：两段不一样的结论，后写的那段未必是对的那段。

**这一组全部按「是不是我的板」鉴权，别人一律 404，不是 403**（同
[routines.md §1](./routines.md)：403 等于告诉他这块板存在）。判据是
`boards.accountId === jwt.accountId`，一个 `boardOf` 兜住，不要在每条路由里各写一遍。

#### 拆成两组的判据是「谁在说话」，不是「谁在敲门」

两组都从席位打过来，但说话的是两个不同的东西，所以走两条路——这一条**照抄
[私有 Skill](./skills.md) 和[长期记忆](./memory.md)刚趟出来的那条**，不要另发明：

| | 谁在说话 | 走哪 | 认什么 |
|---|---|---|---|
| `kanban_list` / `show` / `create` / `link` / `comment` | **模型**（一次工具调用） | `/runtime/kanban/*` | 席位那把 runtime 票（和 `/runtime/catalog` 同一把）+ `?botId=` |
| `/result` / `/heartbeat` | **席位的运行面** | `/internal/kanban/*` | `requireInternalCaller`（同会话索引、guard-events、ready、用量） |

**`botId` 从 query 取，而且服务端要验它真是这个账号的**（`seatBotOf`，
[gateway/src/routes/runtime.ts:333](../gateway/src/routes/runtime.ts:333)）。理由和
[memory.md §5](./memory.md) 那句一字不差：**请求体是模型拼的**——不验的话，一个编出来的
botId 就能拿别人的 Bot 身份往板上建卡。同理 `board`：验它属于 `seatBotOf` 认出来的那个账号，
并且这颗 Bot 在它的成员名单里。**判据一律服务端现算，不收 body**（同会话索引那条）。

那为什么 `/result` / `/heartbeat` 不也走 `/runtime`：它们不是模型说的话，是**这台机器在
汇报**——和「这条会话结束了」「这次用了多少 token」同一类。混进 `/runtime` 的话，模型有一天
就能自己报一句「这张卡跑完了」。

### 15.3 席位接口

```
POST   /api/cards            派一张卡（执行包见 §9.1）。立即返回；busy → 409；静默中 → 503
POST   /api/cards/:id/abort  掐掉那一轮
```

**只有 Gateway 调**（服务凭证）。浏览器不走这条：它手上只有当前打开那颗 Bot 的反代路径，
而卡多半跑在这个人的**另一台席位**上；何况派卡这件事发生在 tick 里，那时多半没有浏览器
开着。

### 15.4 `kanban_create` 的形状

```jsonc
{
  "name": "kanban_create",
  "risk": ["write"],
  "parameters": {
    "board": "b_ops",        // **必填**（卡片会话里可省 = 当前卡那块板），见 §10.1
    "cards": [{
      "title":        "一句祈使句：要做成什么。不是话题，是完成判据",
      "body":         "他需要知道的全部：背景、已经试过什么、什么算做完。**他看不见这段对话**",
      "assignee":     "bot_design",              // 必须在 kanban_list 给出的成员名单里
      "parents":      ["c_1"],                   // 可选，同板
      "model_reason": "抓取加填表，格式定死了，漏一行一眼能看见",  // **必填，排在前面**
      "model_role":   "utility",                 // **必填**
      "needs_browser": false,
      "max_steps":    60
    }]
  }
}
```

**只有 `cards` 数组一种形状**，单张也要写成一个元素（同
[delegation.md §12.1](./delegation.md)：两种形状 = 两条解析路径，省下的是两个方括号）。
一次上限 **5** 张，超了回 400 并说明。

工具描述里要写死的：**什么时候建卡**（要另一颗 Bot 的手艺 / 要跨过这一轮 / 几件事有先后）；
**什么时候别建**（这颗 Bot 自己一轮里就能做完的 → `todo`；要人拍板的 → `escalate_to_human`；
要它自己开一份干净上下文的 → `delegate_task`）；**`body` 必须自足**；**`assignee` 只能从
`kanban_list` 里挑**（那是这个人自己的几颗 Bot，各带一句它是干什么的）；**`notify` 别设成
`report`，要结果就建一张指给自己的依赖卡**（§14）。

**去重**：同一颗 Bot、同一块板、同一个 `title` 指纹，5 分钟内只建一张，后面的合并进已有那张
并回它的卡号。抄 [handoff.md §8](./handoff.md) 的去重，理由一样：模型换个措辞又撞一次是常态，
而板上出现三张一模一样的卡，人会把三张都派出去。

**指纹里必须带时间桶**：

```
dedupeKey = sha1(botId + '\n' + normalize(title) + '\n' + floor(now / 5min))
```

- **不带桶就是个 bug**：`unique (boardId, dedupeKey)` 是永久约束，而「5 分钟」是个窗口。
  不带的话，同一个标题隔一天再建会撞唯一键——回的是一次数据库错误，而人做的事完全正当
  （一张每天都要建的卡，标题当然一样）
- **为什么是唯一索引，不是像 handoff 那样先查一遍**：那边一张单来自一次 `escalate`，天然
  是串行的；这边模型可以在**一次调用**里给出五张卡，而它们同一毫秒落库。先查后插在这里
  拦不住自己——唯一索引是唯一原子的那个
- **桶边界会漏一次**（4:59 建的和 5:01 建的算两张）。接受：这条去重防的是「模型换个措辞
  连着撞几次」，那几次全在几秒之内；为了补上边界，滑动窗口要么改成先查后插（拦不住并发），
  要么给每张卡存指纹再扫一遍（为一个 5 分钟的窗口养一张索引）。漏一次的代价是板上多一张
  重复卡，人一眼看得见、删得掉

---

## 16. 界面

一个新分片 `pages-kanban.js`。**加分片要同步改两处**：[gateway/ui/index.html](../gateway/ui/index.html)
和 [gateway/src/http.ts:100](../gateway/src/http.ts:100) 的 `UI_PARTS`——漏一处的表现是本地开发
一切正常、打出来的包少一个文件。

三屏：

- **板列表**：我的板（**只有我的**），每块带一个「要人管的有几张」（blocked 数）
- **板**：按状态分列（`ready` / `running` / `blocked` / `done`），`todo` 那些收在「等依赖」
  的折叠区里——它们不需要任何人做决定，摊在最前面只会占地方。每张卡上：标题 + 头像（哪颗
  Bot）+ 档位 + 那句 `model_reason` 的一行小字（降过级的要标出来，否则人会以为那一档是模型
  选的，同 [delegation.md §13](./delegation.md)）
- **卡**：正文 + 依赖（上下游各一行，可点）+ 一条时间线（评论和系统行混排）+ 每次跑的流水，
  流水那一行点得进会话全文

轮询三条规矩，全部抄自[日常任务详情页那次教训](./routines.md)：

1. **有 `running` 的卡才转**，5 秒一次；没有就退到 30 秒；页面藏起来就停。不然一个开着的
   标签页会永远每五秒一个请求
2. **问完了没变化就一下都不画**（`boardShot`）。`render()` 是整页重绘，而板页上正在被人编辑
   的那个输入框会跟着被换掉
3. 名字、正文、档位**收在 `change` 上，不是 `input`**：保存要 render，而 render 会把输入框
   换掉——边打边存等于每敲一个字丢一次焦点

**拖拽换状态不做**（Hermes 有）。板上的状态是**算出来的**，不是人摆出来的：`todo → ready` 由
依赖决定，`ready → running` 由调度器决定。给一个能拖的界面，等于承诺一件做不到的事——人把
一张 `todo` 拖进 `running`，我们能做的只有把它拒回去。人能做的动作是按钮：解锁、打回、撤销、
改派、停止。

---

## 17. 不变量

1. **一块板、板上的成员 Bot、板上的每一张卡，全部属于同一个账号。** 没有任何一条路能让
   一张卡跑到别人的席位上——`assigneeBotId` 落在 `board_members` 里，而那张表只装板归属
   那个人名下的 Bot
2. **别人碰这块板一律 404，不是 403**——`admin` 和 `owner` 也一样，代码里没有「管理员除外」
   这个分支
3. **一颗 Bot 只能派活给成员名单上的 Bot**，名单只有人能改，改动进审计
4. **卡片会话不上报会话索引**，也永远不会被 `ensureSession` 认领成某颗 Bot 的主会话
5. **卡片会话里没有 `escalate_to_human`、没有 `history_*`、没有 `memory_write`**——但
   Bot 提示词、Skill、长期记忆的**正文**照旧继承
6. **一颗 Bot 同时最多一张卡，一个账号同时最多三张**，人的主会话不受它影响
7. **`running` 的卡一定会离开 `running`**：席位回报、心跳停了被收、或者墙钟兜底。没有第四
   种结局，而**主路是心跳那条**（3 分钟），不是墙钟（60 分钟）
8. **失败两次进 `blocked`，打回两次进 `blocked`**，而且两次之间至少隔 5 分钟。没有任何一条
   路能让一张卡无限重跑，也没有任何一条路能让它在一分钟内烧完重试次数
9. **人自己按停止的卡不推通知、不进待办计数**（`blockedKind: 'stopped'`）
10. **依赖不跨板**；一次 `kanban_create` 只往一块板建
11. **一颗席位上的浏览器同一时刻只有一条会话在驱动**，先到先得，一轮就放
12. **卡的正文在 Gateway，会话正文在席位**。这一条和会话索引口径不同，是有意的（§5）

---

## 18. 落地清单

按这个顺序，每一段都能单独跑起来。

**一、库和 Gateway 的读写（不接席位）**
1. 迁移 `0021-kanban`（§15.1）——`0018` 到 `0020` 已经被长期记忆、席位部署进度、
   日常任务退避占了。**编号是身份**：撞号意味着两套库各自记着「跑过了」，跑的却是不同的东西
2. `gateway/src/lib/kanban.ts`：`boardOf`（**不是我的一律 404，没有管理员分支**）/ 成员校验
   （这颗 Bot 在不在我名下）/ 依赖解算 / 去重指纹
3. `gateway/src/routes/kanban.ts`：§15.2 用户那一组
3a. `/runtime/catalog` 多一格 `boards`，**并把它算进 `catalogStamp`**（§10.1）。漏了这一步，
    「加进板」在界面上成功、在席位上永远不生效
4. 审计：`kanban.board.create` / `.delete` / `kanban.member.add` / `.remove`

**二、席位那一侧**
5. `session.kind` 加 `'card'`——**§9.2 那张表五处一起改**，特别是
   [session/index.ts:81](../bot/src/session/index.ts:81) 那条 parent 断言（不改的话一张卡都
   开不出来）和 [:159](../bot/src/session/index.ts:159) 那条过滤（不改的话**某个人的对话会
   变成昨天某张卡的现场**）
6. 席位级 `BrowserLease`（§8）：`checkBrowser` 上加一条判据，`turn/end` 释放。**这是新东西**，
   不是复用委派那批 `leases`
7. `bot/src/tools/kanban.ts`：七把工具 + §10.2 那张委派标注表；root-only 的拒绝话术加 card
   一档（§10.3）
8. `cardBlock()`；卡片会话里不注册 `history_*` / `escalate_to_human` / `memory_write`
   （§10.4）；`ESCALATE_AFTER` 话术加卡片会话那一档
   （[policy/index.ts:447](../bot/src/policy/index.ts:447)，§4 口径三）；`healTasks()` 扫描
   带上卡片会话（§10.3）
9. `POST /api/cards` / `/abort`：开会话、起一轮、立即返回；`needsBrowser` 在入口试取租约，
   取不到回 409；`quiesced()` 回 503
10. 60 秒心跳（只写 `heartbeatAt`，不写流水）；`kanban_complete` / `kanban_block` **一调就打
    `/result`**；`turn/end` 时卡还 `running` → 报一次失败（§9.4）

**三、调度**
11. 挂进已有的 tick：收依赖 → **收死的（先心跳后墙钟）** → 选卡（**退避 + 两道并发闸：
    席位 1、账号 3**）→ CAS 抢 → 派 → 回报（§8）
12. `/runtime/kanban/*`（模型那五条，`seatBotOf` 验 botId 和 board 的归属）+
    `/internal/kanban/*`（`/result` / `/heartbeat`），见 §15.2

**四、界面与通知**
13. `pages-kanban.js` + `index.html` + `UI_PARTS`
14. 顶栏计数扩成「交接单 + blocked 卡」，**`stopped` 那档不算**（§7 / §14）
15. webhook 只推 `by-model` / `failed` / `reopen-cap` 三档，且只带「谁的哪张卡」不带标题（§14）

---

## 19. 验收（对着打勾）

- [ ] 甲的 A Bot 建一张派给他自己 B Bot 的卡：B 的席位跑起来，结论回到卡上，**A 和 B 的
      主会话里一个字都没多**
- [ ] A 试图派给**不在板上**的 Bot：工具回错，并把它能派的那几个原样列出来
- [ ] 接口层：拿乙的 JWT 打甲的板 / 卡 / 评论 / 流水 / 建卡，**每一条都是 404**（不是 403，
      不是 200 空数组）
- [ ] 同上，换成本公司 `admin` 的 JWT：**还是 404**。再换平台 `owner`：**还是 404**
- [ ] `GET /kanban/boards` 用 admin 打：只有他自己的板，甲的一块都不在里面
- [ ] 拿乙的席位票打 `/internal/kanban/cards` 往甲的板里建卡：拒绝
- [ ] 把**别人名下**的 botId 塞进 `POST /kanban/boards/:id/members`：400，板上不留痕
- [ ] 父卡 done 之后，子卡在下一个 tick 里从 `todo` 变 `ready` 并被派出去
- [ ] 父卡在 `~/work` 里写了一个文件，子卡跑在**另一颗 Bot** 上：那个文件读得开
- [ ] 同一颗 Bot 上两张 `ready` 的卡：第二张等第一张跑完，而**人在这期间和它聊天照常**
- [ ] 一个账号上四张 `ready` 的卡分给四颗 Bot：同时只跑三张，第四张下一轮才动
- [ ] 一张 `needsBrowser` 的卡，在主会话**这一轮**正驱动浏览器时被派：席位回 409，卡退回
      `ready`；那一轮 `turn/end` 之后下一轮就派成了
- [ ] 反过来：卡正握着浏览器时人在主会话里让它开网页——被拒，而且拒得说得清是谁在用
- [ ] 席位关机：卡退回 `ready` 并在时间线上写明，**不算失败**
- [ ] 席位跑到一半被 kill：**3 分钟内**（不是 60 分钟）卡被收成一次失败，`card_runs` 那行
      记 `stale`；第二次重试的执行包里**带着第一次的报错**
- [ ] 席位活着但那一轮陷住（心跳照报）：60 分钟墙钟收得掉
- [ ] 失败一次之后**立刻**再扫一轮：那张卡不会被重派（退避 5 分钟）
- [ ] 连着失败两次：卡进 `blocked`（`failed`），顶栏计数 +1，webhook 推了一条，而**那条消息
      里没有卡的标题**
- [ ] 人在板上点停止：卡进 `blocked`（`stopped`），**顶栏计数不动，webhook 一条都不推**
- [ ] 管理员打开会话审计：**看不到任何卡片会话**（它不上报索引）；审计里能查到的只有当初
      那一行 `kanban.member.add`
- [ ] 模型跑完一轮但没调 `kanban_complete`：算失败，**不把最后那段话当成结论**
- [ ] 卡片会话里的子代理调 `kanban_complete`：被 pre-execute 短路挡住（不是「schema 里没有
      所以它不会调」）
- [ ] 卡片会话里连着被边界挡 3 次：话术说的是「调 `kanban_block`」，**不是**「调
      `escalate_to_human`」（那把工具在这儿不存在）
- [ ] 卡片会话里调 `memory_write`：拿不到这把工具；而系统提示词里**记忆正文照旧在**
- [ ] 换版静默期间：新卡回 503 退回 `ready`，正在跑的那张**排空会等它**
- [ ] 席位重装之后打开这颗 Bot：侧栏里是他自己的那条长会话，不是某张卡的现场
- [ ] 一张 `notify: report` 的卡跑完：**assignee 那颗 Bot** 的主会话里冒出一条汇报，人追问
      一句它接得住
- [ ] 一张卡的花费在板详情里查得到，且等于它那条会话上 `llm_calls` 的和
- [ ] `reopen` 第 3 次：拒绝，卡进 `blocked`（`reopen-cap`）
- [ ] 把一颗 Bot 加进板之后**不重新部署席位**：一分钟内那几把 `kanban_*` 工具就出现了
      （`catalogStamp` 算进了 `boards`）
- [ ] 席位拿别人的 botId 打 `/runtime/kanban/cards?botId=`：被 `seatBotOf` 挡下
- [ ] `board` 填一块**这颗 Bot 不在其中**的板：拒绝，且拒绝发生在服务端，不是靠工具描述
- [ ] 一颗在两块板上的 Bot 调 `kanban_create` 不给 `board`：回错，并把它所在的板列出来
- [ ] 同一次调用里给两张一模一样的卡：只建出一张（唯一索引挡住），回同一个卡号
- [ ] **隔一天**再建一张同样标题的卡：正常建出来，**不是**唯一键冲突
- [ ] `kanban_complete` 调两次：第二次 409，且模型收到的是一句说得清的话
- [ ] 卡片会话里调 `delegate_task`：**通**（卡是它那一层的根）；那个子代理再调
      `delegate_task` 或 `kanban_complete`：被短路挡住，话术里说的是「交回给派你出来的那一层」
- [ ] 板页开着但没有 `running` 的卡：请求退到 30 秒一次；切到别的标签页：停

---

## 20. 这一版不做的

| 不做 | 为什么 |
|---|---|
| **跨员工的板**（甲的设计 Bot → 乙的文案 Bot） | 三条边界要同时重做，而且每一条单拿出来都够写一份文档：① [连接器绑账号不绑 Bot](./connectors.md)——乙自己装的 Gmail 在乙的席位上是一把随时能用的手，甲派一张「把收件箱里带发票的邮件转给我」过去，乙的 Bot 会照做而乙什么都不知道；② `~/work` 不再共享，产物传不过去，整条流水线退化成只能传文字；③ 用量落在执行方头上，乙的个人页里会多出一堆不是他干的活。这一版把板整个关在一个账号里，这三条一条都不用碰。真要做，第一步是「授权」这个对象——乙点头把自己的某颗 Bot 借给某块板，而不是甲单方面把它拉进来 |
| **自动拆解**（Hermes 的 `auto_decompose` + 编排器） | 它每 tick 都在花钱，而产出的任务图没人看过就直接开跑。人点一下的手动拆解（读板 brief + 成员名单，吐一个任务图给人过目再落）是下一版第一件事——那时它拆出来的东西全在这个人自己的地盘里，风险小得多 |
| **`review` 状态、自动派评审** | 用依赖卡表达（§3）。真到了「每张卡都要评审」的那天，它是板上的一条规则，不是卡上的一个状态 |
| **定时开卡** | [routines](./routines.md) 已经是那个东西。要「每周一开一张周报卡」，是给 routine 加一种动作，不是给卡加一个触发器——**两个地方都能设定时，人就要记住自己当初设在哪儿** |
| **卡上的工作区类型**（scratch / worktree） | §3。等真有「一张卡要一个干净的 git worktree」的用户再说 |
| **WebSocket 实时** | 轮询够用，见 §16。真要做，它该是一条**账号级**的流，同时喂交接单和卡——为板单独造一条，第二个用户出现时就要重来 |
| **卡的附件走 Gateway** | 那会让 Gateway 变成内容库（[gateway-runtime.md](./gateway-runtime.md) 明确拒绝过）。这一版根本不需要它：板上所有 Bot 共用一棵 `~/work`（§6.1），传文件就是写文件 |
