# Satuwork

Two packages: `bot/` (headless runtime) and `gateway/` (control plane + the only chat UI). Spec: [docs/gateway-runtime.md](docs/gateway-runtime.md)

Deploy is per (account, botId) pair. One Bot process = one bot. Chat goes through Gateway; instances do not serve a product SPA.

## 起步

```bash
pnpm install
docker compose up -d postgres
cd gateway && pnpm dev
```

开 <http://127.0.0.1:3080>。第一次进去是「创建系统管理员」那一屏，建完就是登录态。

整套跑在容器里：`docker compose up -d`（Gateway + PostgreSQL）。
Bot 不在 compose 里——它由席位机器上的机器管家按 (账号, botId) 部署，不是容器编排出来的。

Gateway 的业务数据在 PostgreSQL；宿主机端口用 **5434**（5432 一般已被别的实例占着）。
`SATUWORK_GATEWAY_HOME` 只放 JWT 密钥对和 Bot 发布包。

## 桌面端

`desktop/` 是个 Tauri 壳，**包里没有前端**——它只记住「连哪台 Gateway」，然后开一个
没有地址栏的窗口装 Gateway 自己发的那份界面。为什么是这个形状、以及换系统时该先跑
哪个自检，见 [desktop/README.md](desktop/README.md)。

## 出包

本地测试包（过一层 Docker 打 Linux 包、传进本地 Gateway）见
[docs/local-release.md](docs/local-release.md)。生产走 CI：推 `bot-v*` / `manager-v*` tag。

## 计费

模型（含缓存读写）、连接器、网页搜索都按次落在一张账本上，实时从「套餐赠送 → 账户
余额」里扣，两个桶都空了就熔断这家公司所有要收钱的调用。口径、账本表、上线顺序见
[docs/billing.md](docs/billing.md)。

升级到带账本的版本之后**立刻**跑一次回填，否则历史花费在余额里不存在。
**先起一次 Gateway**（迁移在进程启动时跑），再回填：

```bash
GATEWAY_DATABASE_URL=... node gateway/scripts/backfill-charges.mjs --dry-run
```

看一眼条数对不对，再去掉 `--dry-run` 真跑。脚本可以重复跑。

## 检查

```bash
node e2e/run.mjs          # 全量端到端，要先起 postgres
cd gateway && pnpm typecheck
```
