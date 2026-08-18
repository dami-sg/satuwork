#!/bin/bash
# satuwork-bot@<seatId>.service 的入口。
#
# 存在的理由只有一个：bot 代码装在席位私有目录里（路径逐席位不同），而 ExecStart 是
# 列表型设置，drop-in 覆盖它要先写一行空的 `ExecStart=` 再重设，容易写错也难看。
# 让单元固定指向这个脚本，路径的事交给 $SEAT_DIR。
set -euo pipefail
SEAT_ID="${1:-}"
: "${SEAT_DIR:?SEAT_DIR unset - check /etc/systemd/system/satuwork-bot@${SEAT_ID}.service.d/seat.conf}"
APP="$SEAT_DIR/app"
if [ ! -f "$APP/bin/satuwork.mjs" ]; then
  echo "no bot code for seat $SEAT_ID at $APP" >&2
  exit 1
fi
cd "$APP"
exec /usr/bin/node --import tsx "$APP/bin/satuwork.mjs"
