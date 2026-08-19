#!/bin/bash
# 自升级的兜底：新版本起来了却连不上 Gateway 时，把 current 搬回去。
#
# 自检只能证明「新包起得来」，证明不了「它还能跟 Gateway 说上话」。后者失败 = 机器
# 失联，而这套架构里已经没有 SSH 可以上去救。所以留这一手。
#
# **这份脚本随管家的发布包走**（manager/src/seat/manager-confirm.sh）：装机时由安装脚本
# 从包里拷出来，之后每次管家启动都会照着自己包里的这一份刷新一遍。这样修它不必重装
# 机器——跟着一次正常升级就到位了。
#
# ── 宽限期是这份脚本的关键 ────────────────────────────────────────────────
#
# 定时器每 120 秒敲一次，**不管有没有在升级**。而每一次升级都必然经过一段
# 「current 已经是新版、confirmedVersion 还是旧版」的窗口：从换链接到新进程第一次心
# 跳成功，中间有 systemd-run 的 2 秒延迟、停机 drain、进程启动，六到三十秒很正常。
#
# 早先这里没有宽限期，于是定时器撞进那个窗口就会把一次**本来好好的**升级判成失败、
# 搬回旧版、删掉 previous。旧版起来之后管家的熔断又会认定「包里的 VERSION 和登记的版本
# 号不一致」，从此拒绝再升这个版本——一次运气不好的定时器，变成一个看起来像发布包
# 坏了的永久故障。撞上的概率大约是窗口除以 120 秒，十次里有一两次。
#
# 所以只在**距离换版已经超过宽限期**时才判它失败。宽限期要大于「换链接 → 新进程第一
# 次心跳」的最坏情况：2 秒延迟 + 15 秒 TimeoutStopSec + 启动 + 一轮心跳，180 秒留得很宽。
#
# ROOT / STATE 可以用环境变量顶掉，`SATUWORK_CONFIRM_DECIDE_ONLY=1` 则只打印结论
# （rollback / keep 加一句理由）就退出，不动任何东西。**这两个口子是给测试用的**：
# 判断部分正是出过 bug 的地方，不能只靠读代码确认；而真正动手那几行（换链接、重启）
# 是四条众所周知的命令，留在测试外面。
set -euo pipefail
ROOT="${SATUWORK_MANAGER_ROOT:-/opt/satuwork/manager}"
STATE="${SATUWORK_MANAGER_STATE:-/etc/satuwork/manager.json}"
GRACE_MS="${SATUWORK_CONFIRM_GRACE_MS:-180000}"

decide() {
  if [ "${SATUWORK_CONFIRM_DECIDE_ONLY:-}" = "1" ]; then
    echo "$1 $2"
    exit 0
  fi
}

if [ ! -L "$ROOT/previous" ]; then decide keep no-previous; exit 0; fi
if [ ! -f "$STATE" ]; then decide keep no-state; exit 0; fi

CUR="$(basename "$(readlink -f "$ROOT/current")")"
read -r OK AT <<EOF
$(node -p '
const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
[s.confirmedVersion || "-", Number(s.lastUpgradeAt) || 0].join(" ")
' "$STATE" 2>/dev/null || echo "- 0")
EOF

[ "$OK" = "-" ] && OK=""
# 从没配对过的机器没有 confirmedVersion 可比，别把它当成升级失败。
if [ -z "$OK" ]; then decide keep never-paired; exit 0; fi
if [ "$OK" = "$CUR" ]; then decide keep confirmed; exit 0; fi

# 还在宽限期里：新版本可能连起都还没起来（换链接之后重启是延迟发起的）。
# 老管家不写 lastUpgradeAt，那时 AT=0，下面这一步永远为假——退回「立刻判定」的老行为，
# 它至少不会让机器失联，而这种机器再升一次就带上新脚本了。
NOW_MS=$(( $(date +%s) * 1000 ))
if [ "$AT" -gt 0 ] && [ $(( NOW_MS - AT )) -lt "$GRACE_MS" ]; then
  decide keep within-grace
  exit 0
fi
decide rollback stale

PREV="$(basename "$(readlink -f "$ROOT/previous")")"
logger -t satuwork-manager "version $CUR started but never checked in; rolling back to $PREV"
ln -sfn "$(readlink -f "$ROOT/previous")" "$ROOT/.current.tmp"
mv -T "$ROOT/.current.tmp" "$ROOT/current"
rm -f "$ROOT/previous"
# 留个记号给管家：这次版本对不上是**回滚**造成的，不是发布包里的 VERSION 写错了。
# 两者的处置完全不同（一个去查网络，一个去查打包），而管家自己分不出来。
printf '%s' "$CUR" > "$ROOT/rolled-back"
systemctl restart satuwork-manager.service
