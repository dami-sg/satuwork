#!/bin/bash
# 拆掉一个席位。停单元、删 drop-in、删席位私有目录。
#
# **不删 Linux 账号，也不碰 $HOME_DIR/work**：同一个员工的别的席位还在用这个账号，
# 而 work/ 里是人的资料，不是这个席位的运行态。账号的回收是另一件事，要单独做。
set -euo pipefail

: "${LINUX_USER:?}"
: "${SEAT_ID:?}"
: "${SEAT_DIR:?}"

systemctl disable --now "satuwork-bot@$SEAT_ID.service" 2>/dev/null || true
systemctl disable --now "slim-desktop@$SEAT_ID.service" 2>/dev/null || true
rm -rf "/etc/systemd/system/satuwork-bot@$SEAT_ID.service.d" \
  "/etc/systemd/system/slim-desktop@$SEAT_ID.service.d"
systemctl daemon-reload

# 目录里有会话日志，删之前确认路径确实长得像一个席位目录——这段是以 root 跑的。
case "$SEAT_DIR" in
  /home/"$LINUX_USER"/.satuwork/"$SEAT_ID") rm -rf "$SEAT_DIR" ;;
  *) echo "seat dir $SEAT_DIR is not where it should be; refusing to delete" >&2; exit 1 ;;
esac
rm -rf "/tmp/xdg-runtime-$SEAT_ID"
