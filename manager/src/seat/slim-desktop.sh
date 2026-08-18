#!/bin/bash
# 一个席位的桌面栈：Xvfb + xfwm4 + picom + plank + x11vnc + websockify。
#
# 一个员工只有一个 Linux 账号，但可以有多个席位（多个 bot），所以**凡是会重名的
# 东西都必须按席位分开**，而不是按用户名——否则同一个员工的两块屏会抢同一个
# XDG_RUNTIME_DIR、同一份 Chrome profile、同一份 plank 配置。分法是把 XDG 三件套
# 整体指进席位目录：plank、dconf、picom、.desktop 全都跟着走，不用逐个改。
#
# 共享的只有 $HOME/work——同一员工的所有席位都看得见，这是「bot 之间共享资料」的
# 唯一入口。$HOME 下别的东西都不该被两个席位同时写。
set -euo pipefail
SEAT_ID="${1:-}"
[ -n "$SEAT_ID" ] || { echo "usage: slim-desktop.sh <seatId>" >&2; exit 1; }
: "${SEAT_DIR:?SEAT_DIR unset - check /etc/systemd/system/slim-desktop@${SEAT_ID}.service.d/seat.conf}"
: "${HOME:?HOME unset - same drop-in}"

ENV_FILE="$SEAT_DIR/desktop.env"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
DISPLAY_NUM="${DISPLAY_NUM:-10}"
RFB="${RFB:-5910}"
HTTP="${HTTP:-6081}"
CDP="${CDP:-9222}"

export DISPLAY=":${DISPLAY_NUM}"
unset WAYLAND_DISPLAY
export XDG_SESSION_TYPE=x11
export GDK_BACKEND=x11
# logind（PAMName=login）会把 XDG_RUNTIME_DIR 设成 /run/user/<uid>，那是**按 uid**
# 的，同一员工的两块屏会撞在一起。改成按席位。
export XDG_RUNTIME_DIR="/tmp/xdg-runtime-${SEAT_ID}"
export XDG_CONFIG_HOME="$SEAT_DIR/config"
export XDG_DATA_HOME="$SEAT_DIR/share"
export XDG_CACHE_HOME="$SEAT_DIR/cache"
mkdir -p "$XDG_RUNTIME_DIR" "$XDG_CONFIG_HOME/picom" "$XDG_CONFIG_HOME/plank/dock1/launchers" \
  "$XDG_DATA_HOME/applications" "$XDG_CACHE_HOME" "$SEAT_DIR/bin" "$SEAT_DIR/chrome"
chmod 700 "$XDG_RUNTIME_DIR" || true

# dbus 按 X display 区分自启动缓存，各席位的 display 不同，各自一条总线。
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ]; then eval "$(dbus-launch --sh-syntax)"; fi
Xvfb "$DISPLAY" -screen 0 1280x800x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
ready=0
for _ in $(seq 1 50); do
  if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then ready=1; break; fi
  sleep 0.2
done
if [ "$ready" != 1 ]; then echo "X display did not become ready" >&2; exit 1; fi
hsetroot -solid "#e8e8e8" || xsetroot -solid "#e8e8e8" || true
PASSFILE="$SEAT_DIR/vnc-passwd"
x11vnc -display "$DISPLAY" -localhost -rfbauth "$PASSFILE" -shared -forever -noxdamage -rfbport "$RFB" &
NOVNC_WEB="/usr/share/novnc"
# 只听回环：对外那一跳由管家反代，并且要过 Gateway 签的桌面票。绑 0.0.0.0 会让
# 6081+N 直接暴露在网上，票就白验了——停用的员工照样能连上桌面。
websockify --web="$NOVNC_WEB" --heartbeat=30 "127.0.0.1:${HTTP}" "localhost:${RFB}" &
xfwm4 --compositor=off &
for _ in $(seq 1 40); do
  xprop -root _NET_SUPPORTING_WM_CHECK >/dev/null 2>&1 && break
  sleep 0.2
done
PICOM_CONF="$XDG_CONFIG_HOME/picom/picom.conf"
if [ -f "$PICOM_CONF" ]; then picom --config "$PICOM_CONF" &
else picom --backend xrender --no-vsync --no-use-damage &
fi
CHROME_BIN=""
if command -v google-chrome-stable >/dev/null 2>&1; then CHROME_BIN=google-chrome-stable
elif command -v google-chrome >/dev/null 2>&1; then CHROME_BIN=google-chrome
elif command -v chromium >/dev/null 2>&1; then CHROME_BIN=chromium
elif command -v chromium-browser >/dev/null 2>&1; then CHROME_BIN=chromium-browser
fi
if [ -n "$CHROME_BIN" ]; then
  # profile 必须按席位分。同一个 --user-data-dir 上起第二个 Chrome 不会启动，它会把
  # 「开个标签页」发给第一个实例然后自己退出——于是 B 席位要看的网页开在了 A 的屏上。
  WRAP="$SEAT_DIR/bin/seat-chrome"
  echo "#!/bin/bash" > "$WRAP"
  echo "exec $CHROME_BIN --password-store=basic --no-first-run --no-default-browser-check --remote-debugging-port=${CDP} --remote-debugging-address=127.0.0.1 --user-data-dir=$SEAT_DIR/chrome \"\$@\"" >> "$WRAP"
  chmod +x "$WRAP"
  D="$XDG_DATA_HOME/applications/seat-chrome.desktop"
  echo "[Desktop Entry]" > "$D"
  echo "Type=Application" >> "$D"
  echo "Name=Chrome" >> "$D"
  echo "Exec=$WRAP --new-window %U" >> "$D"
  echo "Icon=google-chrome" >> "$D"
  echo "Categories=Network;WebBrowser;" >> "$D"
fi
LAUNCH="$XDG_CONFIG_HOME/plank/dock1/launchers"
mkdir -p "$LAUNCH"
if [ -f "$XDG_DATA_HOME/applications/seat-chrome.desktop" ]; then printf "[PlankDockItemPreferences]\nLauncher=file://%s\n" "$XDG_DATA_HOME/applications/seat-chrome.desktop" > "$LAUNCH/chrome.dockitem"; fi
if [ -f /usr/share/applications/thunar.desktop ]; then printf "[PlankDockItemPreferences]\nLauncher=file://%s\n" /usr/share/applications/thunar.desktop > "$LAUNCH/thunar.dockitem"; fi
if [ -f /usr/share/applications/xfce4-terminal.desktop ]; then printf "[PlankDockItemPreferences]\nLauncher=file://%s\n" /usr/share/applications/xfce4-terminal.desktop > "$LAUNCH/xfce4-terminal.dockitem"; fi
# dconf 也认 XDG_CONFIG_HOME（$XDG_CONFIG_HOME/dconf/user），所以这几行是写进席位的。
dconf write /net/launchpad/plank/docks/dock1/hide-mode "'none'" 2>/dev/null || true
dconf write /net/launchpad/plank/docks/dock1/position "'bottom'" 2>/dev/null || true
dconf write /net/launchpad/plank/docks/dock1/icon-size 48 2>/dev/null || true
dconf write /net/launchpad/plank/docks/dock1/theme "'Transparent'" 2>/dev/null || true
plank --name dock1 &
wait "$XVFB_PID"
