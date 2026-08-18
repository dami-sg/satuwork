# Satuwork

本目录是运行面（Bot 框架），无头：不发 SPA，不是产品聊天 UI。

仓库已拆成 bot/ 与 gateway/ 两个包。产品聊天在 Gateway。规范：[docs/gateway-runtime.md](../docs/gateway-runtime.md)。

一个进程恰好一个 Bot。部署按 (account, botId) pair。

本地开发仍听 3082，那是给 Gateway 反代 / 调试用的 HTTP，不要把它当产品界面打开。

基于 Cordis 的 AI 员工运行时。框架包用 DeepSeek vendor 的那套（cordis 4.0.1）而不是上游。dsh 的产品包一个不用，那些自己写。

package.json 里有一条别名把 cordis 指向同一个物理包，避免加载两份框架。启动器里有断言守着这条线。

## 跑起来

部署实例由 Gateway 拉起（satuwork-bot@{seatId}），环境里必有 SATUWORK_BOT_ID。
未接 Gateway 的本地进程可以不设该变量，此时才种 default。

## 配置模型

复制 .env.example 为 .env。不要填供应商密钥。

| 变量 | 作用 |
|---|---|
| GATEWAY_URL | Gateway 基址，例如 http://127.0.0.1:3080 |
| GATEWAY_TOKEN | 席位 access token（sat_ 前缀）。Gateway 与 Bot 双向 |
| GATEWAY_API_KEY | 席位 API Key（sk_sw_ 前缀）。打 /v1，用量记在该用户 |
| GATEWAY_MACHINE_TOKEN | 机器凭证。internal 口（ready、索引、拉全文） |
| SATUWORK_BOT_ID | 部署必填。目录只钉这一颗，不种本地 default |

模型调用走 Gateway /v1（Chat Completions / Responses / Anthropic Messages）。pi-ai 和上游密钥都在 Gateway。每个 Bot 有自己的 provider + model。

## 数据存在哪

默认 ~/.satuwork，可用 SATUWORK_HOME 覆盖。不用启动目录——否则在哪儿敲的命令会决定看到谁的历史。部署时是 /home/{linuxUser}/.satuwork/{seatId}，席位之间不共用。

同一个员工的多个 bot 跑在**同一个 Linux 账号**下，共享 /home/{linuxUser}/work（部署时注入 SATUWORK_WORK_DIR）。除了这个目录，别的都按席位隔离。

$SATUWORK_HOME/sessions/<id>.jsonl  会话日志：追加式，一行一条事件
$SATUWORK_HOME/satuwork.db          运行时配置与非会话数据（SQLite）

两种数据分开存，是因为访问形态不同：

- 会话日志只追加不改写，要能按 seq 增量拉取（SSE 断线重连靠它）、能直接 grep、能整目录拷走备份。格式带自己的版本号，对不上直接拒绝加载，不猜也不半读
- 配置与业务数据要被查询。这类用文件做会很快变难看，所以放 SQLite

SQLite 用 Node 24 内置的 node:sqlite：零依赖，不用编译原生模块。

ctx.storage 给三样东西：命名空间化的设置（写入后广播 settings/change，插件据此自我更新，不用重启）、文档集合（Bot、任务、连接器），以及一个原生库句柄——需要真正的 SQL 时用它，别硬套文档接口。

## 结构

cordis.yml        根组合：每行一个插件条目
src/home.ts       数据目录解析（SATUWORK_HOME）
src/storage/      运行时配置与非会话数据（ctx.storage，SQLite）
src/session/      追加式事件日志（ctx.sessions），一切从它派生
src/llm/          模型接缝（ctx.llm），Gateway /v1 的薄客户端
src/tools/        工具注册表与执行管道（ctx.tools），策略挂在它的 waterfall 上
src/agent/        turn/step 循环（ctx.agents）
src/web/          无头 HTTP API（含 SSE）；不发 SPA
ui/               遗留前端，不是产品路径
design/           遗留设计稿（25 个视图），不是产品路径
docs/             事件模型设计参考（仓库根 docs/）

## API

| 路由 | 作用 |
|---|---|
| GET /api/bots | 本进程钉住的那一颗 Bot（含 provider+model）；配置在 Gateway |
| POST /api/bots | 410：Bot 配置在 Gateway |
| POST /api/bots/pin | 钉一条公司/全局 Bot（部署路径由 SATUWORK_BOT_ID 钉，不走这条产品入口） |
| GET /api/bots/:id/session | 该 Bot 的长会话（没有就建） |
| GET /api/sessions | 会话列表 |
| POST /api/sessions | 新建会话（必须带 botId） |
| GET /api/sessions/:id/events | SSE：先补历史再转推实时，after=seq 用于断线重连 |
| POST /api/sessions/:id/messages | 发消息，立即返回；结果走 SSE |
| GET /api/models | 代理 Gateway 目录，本机无密钥 |

产品聊天走 Gateway 反代这些口，不要把浏览器指到本进程端口。

## Cordis 的工作方式

插件是一个导出 apply(ctx) 的模块。ctx 是它注册一切的入口，注册项在插件卸载时
自动撤销——事件监听、服务、路由都不需要手工清理，非框架管理的资源用
ctx.effect 包一层 disposer。

inject 声明硬依赖，Cordis 会把插件挂起在 PENDING 直到依赖就绪；依赖在运行期
消失也会触发卸载，回来再重新加载。所以 apply 里不需要写「服务还在吗」的防御
判断。可选依赖用 ctx.get(name) 探测。

服务是 Service 子类，注册后其他插件通过 ctx.name 拿到；配上 cordis 模块的接口
合并就有完整类型。

事件有五种派发模式：emit（同步广播）、parallel（并发等待）、serial（顺序、
首个非空返回胜出）、bail（serial 的同步版）、waterfall（环绕中间件，可改写下游
结果或直接短路）。模式是事件契约的一部分。

cordis.yml 的条目并发挂载，行序不决定加载顺序——顺序来自 inject。
