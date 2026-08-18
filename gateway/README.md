# Satuwork Gateway

Control plane and the only chat UI: companies, accounts, plans, seats, catalogs, JWT, chat proxy, `/v1`.
Default listen port is 3080. Business data lives in **PostgreSQL**; the data dir
(`SATUWORK_GATEWAY_HOME`, default `~/.satuwork-gateway`) only holds the JWT keypair and Bot release tarballs.

控制面 + 聊天 UI：公司、账号、套餐、席位、目录、JWT、按 pair 部署、把 SSE/消息反代到该席位实例。

## 起一个

```bash
docker compose up -d postgres          # 宿主机 5434 → 容器 5432
cd gateway && pnpm dev
```

整套（含 Gateway 容器）：

```bash
docker compose up -d
```

然后开 <http://127.0.0.1:3080>。**一个系统管理员都没有时，首页就是「创建系统管理员」那一屏**，
建完当场就是登录态。`GATEWAY_OWNER_PASSWORD` 只是给无人值守的自动化留的口子，不是启动的前提。

## 环境变量

`GATEWAY_DATABASE_URL` 必填（没有默认值，缺了会直接报错并给出示例）。其余见 `.env.example`：
`GATEWAY_HOST`、`GATEWAY_PORT`、`GATEWAY_PG_SCHEMA`、`GATEWAY_ACCESS_HOST`、`GATEWAY_JWT_TTL_SECONDS`、
`GATEWAY_ISS`、`GATEWAY_MACHINE_TOKEN`、`GATEWAY_PLATFORM_TOKEN`。

进程**不读 `.env`**，要用得 `node --env-file=.env --import tsx src/index.ts`。

`GATEWAY_PG_RESET=1` 会在启动时把自己那个 schema drop 掉重建，**只对非 public schema 生效**——
给 e2e 用的，生产跑在 public 上碰不到。

## 检查

```bash
pnpm typecheck        # tsc，无输出即通过
node smoke.mjs        # 单进程冒烟，自带临时 schema
node ../e2e/run.mjs   # 全量 e2e（要先起 postgres）
```

Passwords are scrypt. Credential secrets never appear in list/get or JWT.
Deploy is per (account, botId) pair, not per account. Seats still count accounts.

## Bot 发布包

Gateway **不构建 Bot**，只存和发。生产上由 CI 打包并传上来：

```bash
GATEWAY_PLATFORM_TOKEN=… node bot/pack.mjs --upload https://gw.example.com
```

`bot/pack.mjs` 走 `pnpm deploy` 把依赖实体化进包里（仓库里的 `bot/node_modules` 全是
指向 workspace 的软链，直接 tar 出去到席位机器上就是断链），然后 PUT 上来。
手工传现成的包也行：

```bash
curl -sf -X PUT "$GATEWAY_URL/platform/bot-releases/1.2.3+$(git rev-parse --short HEAD)" \
  -H "Authorization: Bearer $GATEWAY_PLATFORM_TOKEN" \
  -H "X-Bot-Sha256: $(shasum -a 256 bot.tgz | cut -d' ' -f1)" \
  --data-binary @bot.tgz
```

校验 sha256、是 gzip 的 tar、里面有 `bin/satuwork.mjs`；不过关就删文件不入库。
上限 `GATEWAY_RELEASE_MAX_BYTES`（默认 256 MiB）。

机器管家的包走同一套：`PUT /platform/manager-releases/:version`，入口文件换成
`bin/satuwork-manager.mjs`。

**只有上传这一条路。** 原来还有一条「从本机 bot 源码现打」，已经拆掉：它只有本地
开发的 Gateway 能走，而且打出来的包带的是**那台机器**的 esbuild 原生二进制（tsx 依赖
它），传到席位机器上加载不了，进程起不来。包必须在和席位机器同架构的 Linux 上打，
`pack.mjs` 会拦住不合规的包。

包只在 Gateway 本机磁盘上，机器管家按版本来拉，所以 **Gateway 目前是单实例**。

## LLM proxy

pi-ai 只活在这里。Bot 进程用席位 API Key（`sk_sw_…`）调；登录 JWT 也行；`sat_…` 不行。
上游密钥不出 Gateway：

- GET /v1/models
- POST /v1/chat/completions
- POST /v1/responses
- POST /v1/messages

`/runtime/catalog` 会带出 MCP 的明文 token 与 env，**只认席位 `sat_`**——登录 JWT 会被 401 挡掉。
