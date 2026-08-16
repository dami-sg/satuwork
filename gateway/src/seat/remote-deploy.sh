#!/bin/bash
set -euo pipefail
LINUX_USER=__LINUX_USER__
HOME_DIR=__HOME_DIR__
SW_HOME=__SW_HOME__
DISPLAY_NUM=__DISPLAY_NUM__
RFB=__RFB__
HTTP=__HTTP__
BOT_PORT=__BOT_PORT__
CDP=__CDP__
DISPLAY_VAR=__DISPLAY_VAR__
BOT_VERSION=__BOT_VERSION__
BOT_TGZ=__BOT_TGZ_Q__
BOT_EXTRACT=__BOT_EXTRACT_Q__
VNC_PASSWORD=__VNC_PASSWORD_Q__
GATEWAY_URL=__GATEWAY_URL_Q__
GATEWAY_TOKEN=__GATEWAY_TOKEN_Q__
GATEWAY_API_KEY=__GATEWAY_API_KEY_Q__
GATEWAY_MACHINE_TOKEN=__MACHINE_TOKEN_Q__
SATUWORK_BOT_ID=__BOT_ID_Q__
DESK_B64=__DESK_B64_Q__
DESK_UNIT_B64=__DESK_UNIT_B64_Q__
BOT_UNIT_B64=__BOT_UNIT_B64_Q__
PICOM_B64=__PICOM_B64_Q__

if ! id "$LINUX_USER" >/dev/null 2>&1; then
  sudo adduser --disabled-password --gecos "" "$LINUX_USER"
fi

PKGS="xorg xvfb dbus-x11 x11-xserver-utils xfwm4 thunar xfce4-terminal plank picom hsetroot x11vnc novnc python3-websockify"
NEED=""
for p in $PKGS; do
  if ! dpkg -s "$p" >/dev/null 2>&1; then NEED="$NEED $p"; fi
done
if [ -n "$NEED" ]; then
  sudo apt-get update -y
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y $NEED
fi
if ! command -v google-chrome-stable >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y chromium 2>/dev/null || true
fi

sudo mkdir -p /usr/local/bin /etc/systemd/system "$HOME_DIR" "$SW_HOME" "$HOME_DIR/.vnc" "$HOME_DIR/.config/picom" "$HOME_DIR/.config/plank/dock1/launchers" "$HOME_DIR/.local/share/applications"
sudo chown -R "$LINUX_USER:$LINUX_USER" "$HOME_DIR"

printf "%s" "$DESK_B64" | base64 -d | sudo tee /usr/local/bin/slim-desktop.sh >/dev/null
sudo chmod 755 /usr/local/bin/slim-desktop.sh
printf "%s" "$DESK_UNIT_B64" | base64 -d | sudo tee /etc/systemd/system/slim-desktop@.service >/dev/null
printf "%s" "$BOT_UNIT_B64" | base64 -d | sudo tee /etc/systemd/system/satuwork-bot@.service >/dev/null

sudo tee "$SW_HOME/desktop.env" >/dev/null << EOF_ENV
DISPLAY_NUM=$DISPLAY_NUM
DISPLAY=$DISPLAY_VAR
RFB=$RFB
HTTP=$HTTP
CDP=$CDP
EOF_ENV
sudo chown "$LINUX_USER:$LINUX_USER" "$SW_HOME/desktop.env"
sudo chmod 600 "$SW_HOME/desktop.env"
sudo -u "$LINUX_USER" x11vnc -storepasswd "$VNC_PASSWORD" "$HOME_DIR/.vnc/passwd" >/dev/null
sudo chown "$LINUX_USER:$LINUX_USER" "$HOME_DIR/.vnc/passwd"
sudo chmod 600 "$HOME_DIR/.vnc/passwd"
printf "%s" "$PICOM_B64" | base64 -d | sudo -u "$LINUX_USER" tee "$HOME_DIR/.config/picom/picom.conf" >/dev/null

sudo systemctl daemon-reload
sudo systemctl enable --now "slim-desktop@$LINUX_USER.service"

if [ ! -f "$BOT_TGZ" ]; then
  echo "机器上没有 Bot 安装包" >&2
  exit 42
fi

sudo mkdir -p "$BOT_EXTRACT"
sudo tar -xzf "$BOT_TGZ" -C "$BOT_EXTRACT"
printf '%s\n' "$BOT_VERSION" | sudo tee "$BOT_EXTRACT/VERSION" >/dev/null
if [ ! -f "$BOT_EXTRACT/bin/satuwork.mjs" ]; then
  echo "Bot 安装包缺少 bin/satuwork.mjs" >&2
  exit 42
fi

sudo mkdir -p "$HOME_DIR/satuwork-bot"
if command -v rsync >/dev/null 2>&1; then
  sudo rsync -a --delete "$BOT_EXTRACT/" "$HOME_DIR/satuwork-bot/"
else
  sudo cp -a "$BOT_EXTRACT/." "$HOME_DIR/satuwork-bot/"
fi
printf '%s\n' "$BOT_VERSION" | sudo tee "$HOME_DIR/satuwork-bot/VERSION" >/dev/null
sudo chown -R "$LINUX_USER:$LINUX_USER" "$HOME_DIR/satuwork-bot"
if [ -f "$HOME_DIR/satuwork-bot/cordis.yml" ]; then
  # Bot HTTP 听 0.0.0.0：Gateway 在远端，必须能打到 3200+N。请用防火墙把该口只放给 Gateway。
  sudo sed -i -E "s/^([[:space:]]*host:).*/\1 0.0.0.0/" "$HOME_DIR/satuwork-bot/cordis.yml"
  sudo sed -i -E "s/^([[:space:]]*port:)[[:space:]]*[0-9]+/\1 $BOT_PORT/" "$HOME_DIR/satuwork-bot/cordis.yml"
fi

sudo -u "$LINUX_USER" tee "$SW_HOME/bot.env" >/dev/null << EOF_ENV
GATEWAY_URL=$GATEWAY_URL
GATEWAY_TOKEN=$GATEWAY_TOKEN
GATEWAY_API_KEY=$GATEWAY_API_KEY
GATEWAY_MACHINE_TOKEN=$GATEWAY_MACHINE_TOKEN
SATUWORK_BOT_ID=$SATUWORK_BOT_ID
SATUWORK_HOME=$SW_HOME
SATUWORK_PORT=$BOT_PORT
DISPLAY=$DISPLAY_VAR
XDG_SESSION_TYPE=x11
GDK_BACKEND=x11
HOME=$HOME_DIR
EOF_ENV
sudo chown "$LINUX_USER:$LINUX_USER" "$SW_HOME/bot.env"
sudo chmod 600 "$SW_HOME/bot.env"

sudo systemctl enable "satuwork-bot@$LINUX_USER.service"
sudo systemctl restart "satuwork-bot@$LINUX_USER.service"
rm -f "$BOT_TGZ" || true
