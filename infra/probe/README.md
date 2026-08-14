# 宿主能力探针

验证一台机器能不能承载 dsh 引擎。查 7 项：Landlock ABI、user namespace（root 与非特权两种身份）、bubblewrap 全 unshare、seccomp 状态、PTY 设备、进程组信号、持久路径可写与容量。

这些不是随手挑的——它们对应 dsh 的 `sandbox` / `subprocess` / `shell` / `terminal` / `lsp` 几个包实际依赖的内核能力。任何一项 FAIL 都意味着对应的工具在这台机器上没有隔离层。

## 在自己的服务器上跑（不需要容器）

```bash
sudo apt-get install -y bubblewrap gcc libc6-dev linux-libc-dev util-linux
gcc -O1 -o /usr/local/bin/landlock-abi landlock-abi.c
sudo useradd -m -u 10001 prober 2>/dev/null || true
sudo bash probe.sh
```

`probe.sh` 末尾有 `sleep 3600` 是为了在容器里保持存活好读日志，直接在机器上跑可以先删掉那一行。

## 在容器平台上跑（Fly / Railway / Cloudflare 对照用）

同一个镜像丢到不同平台，结论才可比。

```bash
docker build -t dsh-probe .
docker run --rm dsh-probe            # 默认 profile
docker run --rm --security-opt seccomp=unconfined dsh-probe   # 放开后对照
```

两次对照能区分**内核没有这个能力**和**平台策略把它关掉了**——这是选平台时真正要区分的两件事。

## 已有结果

### Fly.io · sin · 2026-08-14

完整输出见 [`result-fly-sin.log`](result-fly-sin.log)。机器 `shared-cpu-1x` / 512MB + 1GB volume，跑完即销毁。

| 检查项 | 结果 |
|---|---|
| Landlock | ❌ **UNAVAILABLE（errno 38 ENOSYS）** |
| user namespace（root / 非特权） | ✅ / ✅ |
| bubblewrap `--unshare-all`（root / 非特权） | ✅ / ✅ |
| seccomp | `Seccomp: 0`，平台未加过滤 |
| PTY | ✅ |
| 进程组信号 | ✅ |
| volume `/data` | ✅ 908M free（1GB 卷） |

主机是 Firecracker v1.14.4，内核 `6.12.91-fly`，x86_64。

**要点**：内核版本 6.12 远超 Landlock 需要的 5.13，但 Fly 编译内核时没有开 Landlock——ENOSYS 表示系统调用不存在，而不是被禁用（那会是 EOPNOTSUPP）。同一个二进制在本地 Docker 的 LinuxKit 6.12 上返回 ABI v6，所以这是 Fly 的内核构建选项，不是探针的问题。

结论是 dsh 在 Fly 上必须显式使用 bwrap 后端，不能走 Landlock。

### 自购云服务器 · Ubuntu 22.04.5 · 2026-08-14 ✅ 部署目标

完整输出见 [`result-selfhosted-ubuntu2204.log`](result-selfhosted-ubuntu2204.log)。内核 `5.15.0-164-generic`，x86_64。

| 检查项 | 结果 |
|---|---|
| Landlock | ✅ **ABI v1**，且在启动的 LSM 列表里（`lockdown,capability,landlock,yama,apparmor`） |
| user namespace（root / 非特权） | ✅ / ✅（`unprivileged_userns_clone = 1`） |
| bubblewrap `--unshare-all`（root / 非特权） | ✅ / ✅ |
| seccomp | `Seccomp: 0`，无外部过滤 |
| PTY | ✅ |
| 进程组信号 | ✅ |
| 磁盘 | 31G free / 50G |

**全过，且比 Fly 多一个 Landlock。** dsh 的两个 Linux 沙箱后端在这台机器上都可用。

两点要留意：

- **Landlock 只有 ABI v1**（内核 5.15）。v1 缺少后续版本的能力：`REFER`（跨目录 rename，v2/5.19）、`TRUNCATE`（v3/6.2）、网络限制（v4/6.7）、`IOCTL_DEV`（v5/6.10）。也就是说 v1 的 Landlock **管不住 truncate 和网络**。网络隔离由 bwrap 的 netns 补上；如果 dsh 的 Landlock 后端要求最低 ABI 高于 1，就退回 bwrap。跑起来 dsh 时确认它选了哪个后端。
- **实际规格是 2 vCPU / 3.8GB**。首个租户 2 个用户，够用：embedding 与推理都是远程 API，本地不跑模型；内存大头是 LanceDB 常驻索引（设计稿量级 4,796 切片 / 157MB）与并发会话，估算 1.5–2GB，余量约一倍。需要重新评估的信号是知识库涨到百万级切片、改用本地 embedding 模型，或出现大量并发长时工具执行。

### 本地 Docker Desktop（LinuxKit 6.12, arm64）· 对照基线

| 检查项 | 默认 profile | `seccomp=unconfined` |
|---|---|---|
| Landlock ABI | v6 | v6 |
| user namespace（root / 非特权） | ❌ / ❌ | ✅ / ✅ |
| bubblewrap（root / 非特权） | ❌ / ❌ | ✅ / ✅ |

Docker 默认 seccomp profile 拦 `unshare`，放开即全过。这组数据用来证明探针的判别力：它能分清"内核不行"和"平台不让"。

### 待补

- [ ] Railway（如果重新进入候选）
