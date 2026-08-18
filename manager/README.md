# satuwork-manager

席位机器上的常驻服务。一台机器一个，root systemd 服务。

取代了原来「Gateway 用 SSH 登进机器」那条路径。Gateway 因此不再持有任何能登录这
台机器的凭据，只有一把可吊销的 `smt_`；席位的 bot 口和 noVNC 口全部收回
`127.0.0.1`，对外只剩管家这一个端口。

## 装

在 Gateway 的公司详情页点「生成配对码」，把那条命令贴到 Debian 上用 root 跑：

```
curl -fsSL https://gw.example.com/install-manager.sh | sudo bash -s -- --code SW-XXXX-XXXX
```

装完就配对好了。这台机器之后**不需要再敲任何命令**——建席位账号、装桌面栈、起
bot、以后自己升级，全归管家。

可重复运行：换过配对码、或者自升级卡住了，重跑一次就是修复手段。

## 打包

**包里带 esbuild 的原生二进制**（tsx 依赖它），而 `pnpm deploy` 只实体化当前平台那
一份。所以**必须在 Linux 上打包**——在 Mac 上打的包解到 Debian 上 tsx 加载不了
esbuild，管家起不来，而那台机器上已经没有 SSH 可以救。`pack.mjs` 会拦住这种包。

架构也要对上：x86_64 的 Debian 要 `linux-x64` 的包，arm 的要 `linux-arm64`。

### 正路：CI

```
git tag manager-v0.1.0 && git push --tags
```

`.github/workflows/manager-release.yml` 在 ubuntu-latest 上打包并 PUT 到
`/platform/manager-releases/:version`。传包本身**不会**立刻改变任何一台机器——除非
「期望版本」是空的（那时跟最新发布走）。

### 本地：过一层 Docker

见 [../docs/local-release.md](../docs/local-release.md)——那里连 bot 一起打，还记了版本号
撞车、传进本地 Gateway、以及**传包会让没 pin 的机器自动升级**这几件事。

## 它管什么

```
PUT    /seats/:seatId      建/更新一个席位          smt_
DELETE /seats/:seatId      拆一个席位              smt_
GET    /seats              名册                    smt_
GET    /health             版本 + 席位状态          smt_（配对回拨时走 challenge）
ANY    /seats/:id/bot/*    反代到 127.0.0.1:3200+N  smt_
GET+WS /seats/:id/vnc/*    反代到 127.0.0.1:6081+N  Gateway 签的桌面票
```

bot 那条**原样透传 `authorization`**——bot 自己要验席位票（`sat_`），管家不掺和，
所以用一个自己的头 `x-satuwork-machine`，两层互不干扰。

## 落盘

```
/etc/satuwork/manager.env    安装脚本写的启动参数（配对成功后会抹掉配对码）
/etc/satuwork/manager.json   配对结果：machineId、smt_、Gateway 公钥。0600
/etc/satuwork/seats.json     席位名册。反代靠它把 seatId 翻成端口
/opt/satuwork/manager/
  releases/<version>/        解开的管家包
  current -> releases/X      systemd ExecStart 指这里
  previous -> releases/W     回滚指回它
/opt/satuwork/releases/      bot 发布包，按版本全机共享
```

## 自升级

心跳驱动，不是 Gateway 推送——推送要求推的那一刻机器在线且可达，心跳驱动只要机器
最终上线就会收敛。心跳响应带 `desiredManagerVersion`，不一样就换。

换版之前先跑一次新版本的 `--selftest`（起一次、答一次 `/health`、退出），挡掉「包
坏了 / 语法错 / 依赖缺失」。Node 版本不够就**不升**，心跳里报出来等人重跑安装脚本
——升到起不来比不升坏得多。

重启由一个瞬态单元发起（`systemd-run --on-active=2s`），不能由管家的子进程直接
`systemctl restart`：那会连自己一起被杀，命令发不出去。

换版 120 秒后 `satuwork-manager-confirm.timer` 检查一次：新管家只有**成功心跳一次**
之后才会写 `confirmedVersion`，没写就指回 `previous` 并重启。这一层是必须的——自检
只能证明「能起来」，证明不了「能跟 Gateway 说上话」，而后者失败就是机器失联。

席位不受影响：`slim-desktop@` / `satuwork-bot@` 是独立的 system unit，不是管家的子
进程，所以管家单元用 `KillMode=process`。

## 本地跑

```
SATUWORK_MANAGER_HOME=/tmp/mgr \
SATUWORK_MANAGER_DRYRUN=1 \
SATUWORK_MANAGER_HOST=127.0.0.1 SATUWORK_MANAGER_PORT=18443 \
pnpm --filter satuwork-manager dev
```

`SATUWORK_MANAGER_DRYRUN=1` 跳过 `deploy-seat.sh` 和 systemd（那些要 root 和一台
Debian），但 HTTP、配对、鉴权、反代全走真的。`e2e/manager.mjs` 就是靠它在开发机上
盯住整条接缝的。
