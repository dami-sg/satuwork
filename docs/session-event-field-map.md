# Session 事件 → UI 字段对照

从一份真实的 dsh session 日志（1,553 条事件，25 个工具，deepseek-v4-pro）逆向出的事件结构，用来回答一个问题：**dsh 的 session 日志够不够喂出设计稿的「会话详情」和「调用链路」两屏。**

结论：**够。** 缺的三块都是 Satuwork 自己该加的东西，不是 dsh 的缺陷。

## 通用信封

每条事件都有 `seq`（单调递增）、`time`、`type`、`data`。派生事件另带 `sourceEventSeqs`（指回它由哪些 chunk 事件汇总而成）和 `surfaceOp`（观察到 `append`）。

会话根记录只出现一次：

```json
{"type":"session","version":0,"id":"session-<uuid>","createdAt":1786632053231,
 "cwd":"...","delegationDepth":0,"agentPreset":"standard"}
```

`version: 0` 就是 `SESSION_FORMAT_VERSION`——[决策 1](dsh-capability-map.md#1--会话持久化自己接管) 担心的那个不作兼容承诺的版本号，实物确认。`agentPreset` 直接挂在根上，Agent 归属不用另找。

## 事件族

| 事件 | `data` 的键 |
|---|---|
| `session` | `version` `id` `createdAt` `cwd` `delegationDepth` `agentPreset` |
| `request/header` | `header{config, system, tools[], adapterDefaults}` `reason: "initial" \| "resume"` |
| `request/context` | `provider` `model` `contextWindow` |
| `turn/start` · `turn/end` | `turn`；end 另带 `reason{kind:"completed"}` |
| `step/start` · `step/end` | `turn` `step` |
| `user/message` | `id` `role` `content[]` **`source`（判别联合，见下）** |
| `assistant/chunk` | `turn` `step` `chunk{type}` |
| `assistant/message` | `turn` `step` `message{content[]}` **`usage{}`** |
| `tool/call` | `turn` `step` `callId` `name` `arguments` |
| `tool/result` | `turn` `step` `message{content[]}` **`meta`（按工具而异）** |
| `agent/inbox/spliced` | `target` `start` `inserted` |
| `sandbox/mode` · `permission/preset` · `approval/policy` | `mode` / `preset` / `policy` |
| `session/title` | `title` `source` `messageSeqs` |
| `command/run` · `command/done` | — |

`assistant/chunk` 的 `chunk.type` 取值：`block-start` `block-end` `text-delta` `reasoning-delta` `tool-call-delta` `usage` `finish`。

`assistant/message.usage`：

```json
{"inputTokens":6069,"outputTokens":572,"cacheReadTokens":9472,"reasoningTokens":333}
```

## 最重要的发现：`user/message.data.source` 是个可扩展判别联合

日志里实际出现的五种 source：

| `source` | 含义 |
|---|---|
| `{kind:"user", rpcId, clientTimeZone}` | 真人输入 |
| `{kind:"plugin", plugin:"user-approval"}` | 插件通知（审批策略变更） |
| `{kind:"plugin", plugin:"@deepseek-ai/dsh-system-prompt", form:"snapshot", sections:[{name,text}]}` | runtime context 快照，带**分段结构** |
| `{kind:"agent-instructions", form:"instructions", baseline, baselineIdentity, changes:[{action,scope,path,digest}]}` | 工作区指令注入，带**文件路径与 digest** |
| `{kind:"skill-catalog", form:"catalog", entries:[{name,description}]}` | Skill 目录注入，带**条目结构** |

**这解决了 [决策 3](dsh-capability-map.md#3--凡是要出现在调用链路里的必须是-session-事件)。** 注入内容的来源元数据挂在 `source` 上，dsh 自己已经有四种用法作先例。`satu-kb` 照抄这个形态即可：

```jsonc
source: { kind: "plugin", plugin: "satu-kb", form: "retrieval",
          hits: [{ kbId, docId, chunkId, score, path }] }
```

**不需要新增事件族，不需要扩 `SessionEventMap`。** 引用回溯直接从 `hits` 渲染。`satu-memory` 同理。

## 会话详情（`chat`）

| UI 元素 | 读什么 |
|---|---|
| 用户气泡 | `user/message`，`source.kind == "user"` |
| 助手气泡 | `assistant/message`，`message.content[]` 里 `type=="text"` 的块 |
| 推理过程 | `content[].type=="reasoning"`，流式来自 `reasoning-delta` |
| 步骤卡 | 同 `turn`+`step` 下的 `tool/call` 与 `tool/result`，用 `callId` 配对 |
| 模型徽章 | `request/header.data.header.config`（`model` + `reasoningEffort`） |
| 流式渲染 | `assistant/chunk` 的 `text-delta` / `reasoning-delta` |
| 会话标题 | `session/title.title` |
| 审批档位 | `permission/preset.preset` + `approval/policy.policy` + `sandbox/mode.mode` |

设计稿里没有推理过程，但 DeepSeek 有完整推理链（这份日志 804 条 `reasoning-chunks`），值得考虑展示——客服助手为什么这么答，运营会想看。

## 调用链路（`chatLog`）

| 设计稿分段 | 读什么 |
|---|---|
| **SYSTEM** | `request/header.data.header.system`（本例 6,021 字符）+ `tools[]`（25 个完整 schema）+ `reason` |
| **CONTEXT** | `user/message` 中 `source.kind != "user"` 的全部，按 `form` 分类渲染 |
| **MODEL** | `assistant/message` + `usage` |
| **TOOL** | `tool/call` → `tool/result`，`callId` 关联；`meta` 按工具带结构化附加（`read` 给 `{lang,lines,offset,path,totalLines}`，`glob` 给 `{files,shape,total,truncated}`，`web_search` 给 `{sources,truncated}`） |
| 每步耗时 | 相邻事件 `time` 差——dsh 自己的轨迹视图也标着 `Timing source: Session timestamps` |
| Token | `usage` 四个字段 |
| 缓存命中率 | `cacheReadTokens / (inputTokens + cacheReadTokens)` |

## 三块缺口，精确化

**1. 费用** —— `usage` 分四类 token，单价表必须分档：`inputTokens`、`cacheReadTokens`（缓存读单价不同，本例命中率 70%，算错会差很多）、`outputTokens`，`reasoningTokens` 通常并入输出计价。这是 `satu-usage-rollup` 的活。

**2. Prompt 的模板与变量** —— `header.system` 是**已渲染的最终文本**，模板名和变量没有留痕。但 `source.sections[{name,text}]` 说明系统提示是**分段注册**的，能拿到段名（如 `sandbox:policy`、`approval:policy`）。要做到设计稿那种 `template: agent.base.v7` + `variables: {tenant, user, locale, tools_enabled}`，得在 `ctx.systemPrompt` 之上自己加一层模板层并把变量写进 `source`。

**3. trace id** —— 没有独立 trace id。用 `session.id` + `turn`/`step` 组合即可，或在自己的持久化 provider 里补一个。

## 失败形态：`isError` 不能用

三份补测日志（退出码非零、命令不存在、沙箱拒绝）里，`data.message.content[0].isError` **无一例外都是 `false`**。

**失败只编码在文本标记里**，运行日志那屏必须解析这些前缀，不能读布尔字段：

| 标记 | 含义 |
|---|---|
| `[exit code: N]` | 非零退出 |
| `[stderr]` | 后随 stderr 内容 |
| `[sandbox: file access denied under <mode> mode]` | **策略拒绝**，不是命令本身失败 |
| `[sandbox: escalation available — …]` | 可升级提示 |
| `(no output)` | 无输出 |

`isError` 应当是留给**管道层**失败的（工具抛异常、超时、执行前被拒），这三份日志里没有样本。所以 UI 上要分两类：**业务失败**按工具语义解析文本，**管道失败**读 `isError`。

### 沙箱拒绝与升级，实物流程

`mkdir -p /etc/satuwork-test` 在 `workspace-write` 下的完整返回：

```
[stderr]
mkdir: cannot create directory '/etc/satuwork-test': Read-only file system
[sandbox: file access denied under workspace-write mode]
[sandbox: escalation available — retry this exact command once with sandbox_permissions
 (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]
[exit code: 1]
```

模型随后走完了整条升级路径：调 `ask_user_question` 问用户意图 → 用户确认 → 带参数重试：

```jsonc
{ "command": "mkdir -p /etc/satuwork-test && ls -ld /etc/satuwork-test",
  "sandbox_permissions": "danger-full-access",
  "justification": "用户已确认要创建 /etc/satuwork-test，该路径位于 /etc 系统目录、超出工作区，需要完整文件系统访问权限才能执行 mkdir。" }
```

→ 成功。

**这是设计稿「高风险操作需人工确认」那条开关的现成实现**：工具级拒绝 + 结构化升级 + 用户审批，而且 `justification` 是模型自己写的自然语言，可以直接展示给运营看，不用另做解释文案。

## Steering：是排队，不是打断

`agent/inbox/spliced` 的 `data.target` 观察到的值是 **`next-turn`**，三段式：

```
spliced {target:"next-turn", inserted:[msgId]}   ← 入队
spliced {target:"next-turn", inserted:[]}        ← 被认领，队列清空
user/message {source:{kind:"user"}}              ← 落库
```

关键是时序。log 4 里消息在 `seq 1481`（turn 1 的 step 3 进行中）入队，但 `turn/end` 到 `seq 2120` 才发生，消息在 `seq 2124`、**turn 2 的 step 1** 才被认领：

```
2119  step/end    turn 1 step 4
2120  turn/end    turn 1
2121  turn/start  turn 2
2123  step/start  turn 2 step 1
2124  user/message  ← 这里才落地
```

**`next-turn` 是排队等本轮跑完，不打断当前轮。** 架构文档里提到的 `next-step`（当前轮内下一步认领）在 Web UI 的默认行为里没出现。如果设计稿要"跑到一半插话立刻改变行为"，得确认 Web 客户端能不能指定 `next-step` 目标——否则用户看到的就是"我说了但它还在跑上一个任务"。

## `tool/result.meta` 的已知形态

| 工具 | `meta` 键 |
|---|---|
| `read` | `lang` `lines` `offset` `path` `totalLines` |
| `write` / `edit` | `diffs` |
| `glob` | `paths`（另一份日志作 `files`）`shape` `total` `truncated` |
| `web_search` | `sources` `truncated` |
| `bash` / `ask_user_question` | `null` |

`meta` 是**按工具而异的结构化附加数据**，正是设计稿里工具卡片要渲染的东西（diff 视图读 `diffs`，文件卡片读 `path`+`totalLines`，搜索卡片读 `sources`）。

## 仍未验证

- **管道层失败**（`isError: true`）的实际样本
- `next-step` 目标的 steering
- compaction 事件族：web profile 禁用了 `compaction-basic`，且 DeepSeek-V4 的 `contextWindow` 是 1,000,000，短期撞不到
