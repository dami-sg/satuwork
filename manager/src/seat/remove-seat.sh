#!/bin/bash
# 拆掉一个席位。停单元、删 drop-in、删席位私有目录。
#
# **不删 Linux 账号，也不碰 $HOME_DIR/work**：同一个员工的别的席位还在用这个账号，
# 而 work/ 里是人的资料，不是这个席位的运行态。账号的回收是另一件事，要单独做。
#
# **这条脚本的成败只由一件事决定：那两个 systemd 单元还在不在。** 它们背后是一组
# 端口（3200+N / 6081+N）和一块屏，槽位能不能重新分出去看的就是它。删 drop-in、删
# 席位目录失败只是留下垃圾，不该把整次拆除判成失败——那些步骤都排在「单元已经停
# 掉」之后，一旦据此报错，Bot 已经聊不了了，而 Gateway 那边的删除每次都以同一个
# 理由失败：界面上于是挂着一颗既用不了也删不掉的 Bot。真发生过。
#
# 因此这里**不用 `set -e`**：每一步自己判，最后统一按「单元还活着吗」给退出码。
set -uo pipefail

: "${LINUX_USER:?}"
: "${SEAT_ID:?}"
: "${SEAT_DIR:?}"

BOT_UNIT="satuwork-bot@$SEAT_ID.service"
DESKTOP_UNIT="slim-desktop@$SEAT_ID.service"

warn() { echo "remove-seat: $*" >&2; }

# 停一个单元。**给它一个上限**：管家只等 120 秒，一个卡在 stopping 的单元能把这点
# 预算全吃掉，然后连「停下来没有」都来不及看。先好好停，停不动就 SIGKILL。
stop_unit() {
  local unit="$1"
  if timeout 30 systemctl disable --now "$unit" >/dev/null 2>&1; then return; fi
  warn "$unit 没在 30 秒内停下，改用 SIGKILL"
  systemctl kill -s KILL "$unit" >/dev/null 2>&1
  timeout 15 systemctl stop "$unit" >/dev/null 2>&1
  systemctl disable "$unit" >/dev/null 2>&1
}

stop_unit "$BOT_UNIT"
stop_unit "$DESKTOP_UNIT"

rm -rf "/etc/systemd/system/$BOT_UNIT.d" "/etc/systemd/system/$DESKTOP_UNIT.d" ||
  warn "drop-in 没删干净"
systemctl daemon-reload >/dev/null 2>&1 || warn "daemon-reload 失败"

# 目录里有会话日志，删之前确认路径确实长得像一个席位目录——这段是以 root 跑的。
# 不长得像就跳过：这是一道防手滑的闸，不是拆除失败。
case "$SEAT_DIR" in
  /home/"$LINUX_USER"/.satuwork/"$SEAT_ID") rm -rf "$SEAT_DIR" || warn "席位目录没删干净：$SEAT_DIR" ;;
  *) warn "席位目录 $SEAT_DIR 不在它该在的位置，跳过删除" ;;
esac
rm -rf "/tmp/xdg-runtime-$SEAT_ID" || warn "运行时目录没删干净"

# 退出码只答一个问题：端口还被这个席位占着吗。
#
# `is-active` 对 activating / deactivating 也回非零，那两种状态下进程还在、端口还
# 占着——所以按状态名判，不按退出码判。
rc=0
for unit in "$BOT_UNIT" "$DESKTOP_UNIT"; do
  state=$(systemctl is-active "$unit" 2>/dev/null)
  case "$state" in
    inactive | failed | unknown | '') ;;
    *)
      warn "$unit 还是 $state"
      rc=1
      ;;
  esac
done
exit "$rc"
