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
| SATUWORK_WORK_DIR | 文件与命令工具的工作区根目录。部署注入 /home/{linuxUser}/work；本地回落 $SATUWORK_HOME/work |
| SATUWORK_UPLOAD_MAX | 单个附件上限（字节）。默认 100 MiB |

模型调用走 Gateway /v1（Chat Completions / Responses / Anthropic Messages）。pi-ai 和上游密钥都在 Gateway。每个 Bot 有自己的 provider + model。

## 数据存在哪

默认 ~/.satuwork，可用 SATUWORK_HOME 覆盖。不用启动目录——否则在哪儿敲的命令会决定看到谁的历史。部署时是 /home/{linuxUser}/.satuwork/{seatId}，席位之间不共用。

同一个员工的多个 bot 跑在**同一个 Linux 账号**下，共享 /home/{linuxUser}/work（部署时注入 SATUWORK_WORK_DIR）。除了这个目录，别的都按席位隔离。

## 附件

聊天里传上来的文件走 `POST /api/sessions/:id/files`（裸字节，文件名在 `x-filename`，
URL 编码），落进 `$SATUWORK_WORK_DIR/uploads/<sessionId>/`。**发给模型的是路径，不是
内容**——它自己用 read/bash 去取，几百页的 PDF 不会一次撑爆上下文。

反过来，`GET /api/workspace/file?path=` 把工作区里的文件流回去给浏览器预览。上传进来的
和 Bot 自己写出来的走同一条路，因为它们本来就在同一个目录里。能不能内联由扩展名白名单
决定（见 `src/workspace/index.ts`）：**SVG 和 HTML 不在里面**，它们能带脚本，内联等于让
上传者在 Gateway 的源上执行代码；这两种照样能传、能下载，只是不给内联。

Bot 写出来的文件怎么让人看见：`write` / `edit` 在工具结果里报出路径（`ToolResult.files`），
经 `tool/result` 事件到界面，渲染成可点开的预览。**不去正则扫工具结果的文本猜路径**——
那段文本是写给模型看的散文，措辞一改就扫不出来了。

### 文档：read 读得了 PDF / Word / Excel

`read` 碰到 `.pdf` / `.docx` / `.xlsx` 会先转成文本，再照常按行分页。**在 read 的时候转，
不在上传的时候转**：一份 50 页的 PDF 转出来几万 token，上传即转等于每次对话都把它整个
灌进上下文，而 `read` 本来就有 offset/limit，模型想读哪段读哪段。转换结果按
（路径 + mtime + 大小）缓存几份，翻页时不会反复重解析。

PDF 用 `unpdf`（自带 pdfjs，不需要原生 canvas），按页分段。Word 用 `mammoth` 转 HTML
再转 Markdown——**不用它的 `convertToMarkdown`**，那个 API 官方标了 deprecated，而且会
把表格拍平成一列文本。Excel 用 `exceljs`，每个工作表转 CSV，公式取缓存的计算结果。

有一类救不了：**扫描件 PDF 没有文字层**，提取出来是空的。那种会明说读不出来，而不是
返回一片空白让人以为文件坏了。

### 图片：模型是真能看见的

图片除了能预览，还能作为**视觉输入**发给模型。发消息时带 `images: [{path, mime}]`
（路径是工作区里的，文件早就传上去了），席位这边校验路径不越界、文件在、格式在白名单
（png / jpeg / gif / webp）里，然后写成一个 `image` 内容块。

会话日志里**存路径不存字节**（见 `session/types.ts`，格式 v4）。组模型请求时才读盘转
base64：OpenAI 走 `image_url` 的 data URI，Anthropic 走 `source` 对象。单张超过 3.5 MB
的不发——各家上限不一样，取最紧的那个留了余量；超了会换成一句说明，模型至少知道有
这么个东西。

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
                  builtin.ts 是 now；workspace.ts 是 read/write/edit/ls/find/grep/bash
src/agent/        turn/step 循环（ctx.agents）
src/web/          无头 HTTP API（含 SSE）；不发 SPA
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
| POST /api/sessions/:id/messages | 发消息，立即返回；结果走 SSE。可带 `images: [{path, mime}]` |
| POST /api/sessions/:id/files | 上传附件：裸字节，文件名在 `x-filename`（URL 编码）|
| GET /api/workspace/file?path= | 取工作区里的一个文件；`download=1` 强制另存 |
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
