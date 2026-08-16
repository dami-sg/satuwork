#!/bin/bash
set -euo pipefail
USER_NAME="${1:-$(id -un)}"
HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
HOME_DIR="${HOME_DIR:-/home/$USER_NAME}"
ENV_FILE="$HOME_DIR/.satuwork/desktop.env"
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
DISPLAY_NUM="${DISPLAY_NUM:-10}"
export DISPLAY=":${DISPLAY_NUM}"
export HOME="$HOME_DIR"
unset WAYLAND_DISPLAY
export XDG_SESSION_TYPE=x11
export GDK_BACKEND=x11
export XDG_RUNTIME_DIR="/tmp/xdg-runtime-${USER_NAME}"
mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.vnc" "$HOME/.config/picom" "$HOME/.config/plank/dock1/launchers" "$HOME/.local/share/applications" "$HOME/.local/bin"
chmod 700 "$XDG_RUNTIME_DIR" || true
RFB="${RFB:-5910}"
HTTP="${HTTP:-6081}"
CDP="${CDP:-9222}"
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
PASSFILE="$HOME/.vnc/passwd"
x11vnc -display "$DISPLAY" -localhost -rfbauth "$PASSFILE" -shared -forever -noxdamage -rfbport "$RFB" &
NOVNC_WEB="/usr/share/novnc"
websockify --web="$NOVNC_WEB" --heartbeat=30 "0.0.0.0:${HTTP}" "localhost:${RFB}" &
xfwm4 --compositor=off &
for _ in $(seq 1 40); do
  xprop -root _NET_SUPPORTING_WM_CHECK >/dev/null 2>&1 && break
  sleep 0.2
done
PICOM_CONF="$HOME/.config/picom/picom.conf"
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
  WRAP="$HOME/.local/bin/seat-chrome"
  echo "#!/bin/bash" > "$WRAP"
  echo "exec $CHROME_BIN --password-store=basic --no-first-run --no-default-browser-check --remote-debugging-port=${CDP} --remote-debugging-address=127.0.0.1 --user-data-dir=\$HOME/.config/chrome \"\$@\"" >> "$WRAP"
  chmod +x "$WRAP"
  D="$HOME/.local/share/applications/seat-chrome.desktop"
  echo "[Desktop Entry]" > "$D"
  echo "Type=Application" >> "$D"
  echo "Name=Chrome" >> "$D"
  echo "Exec=$WRAP --new-window %U" >> "$D"
  echo "Icon=google-chrome" >> "$D"
  echo "Categories=Network;WebBrowser;" >> "$D"
fi
LAUNCH="$HOME/.config/plank/dock1/launchers"
mkdir -p "$LAUNCH"
if [ -f "$HOME/.local/share/applications/seat-chrome.desktop" ]; then printf "[PlankDockItemPreferences]\nLauncher=file://%s\n" "$HOME/.local/share/applications/seat-chrome.desktop" > "$LAUNCH/chrome.dockitem"; fi
if [ -f /usr/share/applications/thunar.desktop ]; then printf "[PlankDockItemPreferences]\nLauncher=file://%s\n" /usr/share/applications/thunar.desktop > "$LAUNCH/thunar.dockitem"; fi
if [ -f /usr/share/applications/xfce4-terminal.desktop ]; then printf "[PlankDockItemPreferences]\nLauncher=file://%s\n" /usr/share/applications/xfce4-terminal.desktop > "$LAUNCH/xfce4-terminal.dockitem"; fi
dconf write /net/launchpad/plank/docks/dock1/hide-mode "'none'" 2>/dev/null || true
dconf write /net/launchpad/plank/docks/dock1/position "'bottom'" 2>/dev/null || true
dconf write /net/launchpad/plank/docks/dock1/icon-size 48 2>/dev/null || true
dconf write /net/launchpad/plank/docks/dock1/theme "'Transparent'" 2>/dev/null || true
plank --name dock1 &
wait "$XVFB_PID"
