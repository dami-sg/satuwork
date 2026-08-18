#!/bin/bash
# 部署一个席位。由机器管家在本机以 root 运行——**没有 sudo，也没有占位符替换**，
# 全部参数走环境变量（见下面的 `: "${VAR:?}"` 一组）。
#
# 它的前身是 Gateway 通过 SSH 灌进来的 remote-deploy.sh。搬到管家之后少了两样东西：
# 每次 scp 一份安装包（改成管家按版本缓存在 SEAT_ASSETS 之外的 releases 目录），
# 以及满屏的 sudo。逻辑本身没动。
#
# 粒度：**一个员工一个 Linux 账号**（$LINUX_USER），账号下**一个 bot 一个席位**
# （$SEAT_ID）。所以对账号的部分是幂等复用的，对席位的部分才是新建。
#
#   $HOME_DIR/work                 共享工作区。同员工的所有席位都看得见，这是共享入口。
#   $HOME_DIR/.satuwork/$SEAT_ID   席位私有：$SATUWORK_HOME、app、Chrome profile、XDG 各目录
set -euo pipefail

: "${LINUX_USER:?}"
: "${SEAT_ID:?}"
: "${HOME_DIR:?}"
: "${WORK_DIR:?}"
: "${SEAT_DIR:?}"
: "${DISPLAY_NUM:?}"
: "${RFB:?}"
: "${HTTP:?}"
: "${BOT_PORT:?}"
: "${CDP:?}"
: "${BOT_VERSION:?}"
# 管家已经把发布包解好了，这里只管拷。管家保证同一版本全机只解一次。
: "${BOT_EXTRACT:?}"
# 管家自己包里的 seat 资源目录：两个 .service 模板、两个启动脚本。
: "${SEAT_ASSETS:?}"
: "${VNC_PASSWORD:?}"
: "${GATEWAY_URL:?}"
: "${GATEWAY_TOKEN:?}"
: "${GATEWAY_API_KEY:?}"
: "${SATUWORK_BOT_ID:?}"

# 以 root 跑，下面这些值会变成 mkdir/chown 的目标和 systemd 单元里的字段。管家的
# specOf 已经按形状校过一遍并且**自己推导路径**；这里再兜一层，理由和
# remove-seat.sh 里那段 case 一样：脚本可能被手工调用，而且这一层的代价近乎零。
case "$LINUX_USER" in
  *[!A-Za-z0-9_-]* | '') echo "refusing: bad LINUX_USER" >&2; exit 1 ;;
esac
case "$SEAT_ID" in
  *[!A-Za-z0-9_-]* | '') echo "refusing: bad SEAT_ID" >&2; exit 1 ;;
esac
# 路径必须正好长成席位应该在的样子，否则拒绝——不然一个 HOME_DIR=/etc 就是
# chown -R "$LINUX_USER" /etc。
[ "$HOME_DIR" = "/home/$LINUX_USER" ] || { echo "refusing: HOME_DIR $HOME_DIR" >&2; exit 1; }
[ "$WORK_DIR" = "$HOME_DIR/work" ] || { echo "refusing: WORK_DIR $WORK_DIR" >&2; exit 1; }
[ "$SEAT_DIR" = "$HOME_DIR/.satuwork/$SEAT_ID" ] || { echo "refusing: SEAT_DIR $SEAT_DIR" >&2; exit 1; }

DISPLAY_VAR=":${DISPLAY_NUM}"

if ! id "$LINUX_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$LINUX_USER"
fi

PKGS="xorg xvfb dbus-x11 x11-xserver-utils xfwm4 thunar xfce4-terminal plank picom hsetroot x11vnc novnc python3-websockify"
NEED=""
for p in $PKGS; do
  if ! dpkg -s "$p" >/dev/null 2>&1; then NEED="$NEED $p"; fi
done
if [ -n "$NEED" ]; then
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y $NEED
fi
if ! command -v google-chrome-stable >/dev/null 2>&1 && ! command -v google-chrome >/dev/null 2>&1 && ! command -v chromium >/dev/null 2>&1 && ! command -v chromium-browser >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y chromium 2>/dev/null || true
fi

mkdir -p /usr/local/bin /etc/systemd/system
# 账号级：共享工作区。已存在就别动，里面是员工和 bot 的资料。
mkdir -p "$HOME_DIR" "$WORK_DIR" "$HOME_DIR/.satuwork"
chown "$LINUX_USER:$LINUX_USER" "$HOME_DIR" "$WORK_DIR" "$HOME_DIR/.satuwork"
# 席位级：整棵子树都归这个席位，chown -R 只扫它，不扫可能很大的 work/。
mkdir -p "$SEAT_DIR" "$SEAT_DIR/app" "$SEAT_DIR/bin" "$SEAT_DIR/chrome" "$SEAT_DIR/cache" \
  "$SEAT_DIR/config/picom" "$SEAT_DIR/config/plank/dock1/launchers" "$SEAT_DIR/share/applications"
# 先归属，后写文件：下面 x11vnc -storepasswd 是以员工身份跑的，目录还归 root 就写不进去。
chown -R "$LINUX_USER:$LINUX_USER" "$SEAT_DIR"

install -m 755 "$SEAT_ASSETS/slim-desktop.sh" /usr/local/bin/slim-desktop.sh
install -m 755 "$SEAT_ASSETS/satuwork-bot.sh" /usr/local/bin/satuwork-bot.sh
install -m 644 "$SEAT_ASSETS/slim-desktop@.service" /etc/systemd/system/slim-desktop@.service
install -m 644 "$SEAT_ASSETS/satuwork-bot@.service" /etc/systemd/system/satuwork-bot@.service

# 模板里的 %i 是席位 ID，不再是用户名，所以 User= 只能从这儿来。模板里的
# User=nobody 是兜底；drop-in 在主文件之后加载，标量设置后写覆盖先写。
mkdir -p "/etc/systemd/system/slim-desktop@$SEAT_ID.service.d" \
  "/etc/systemd/system/satuwork-bot@$SEAT_ID.service.d"
cat > "/etc/systemd/system/slim-desktop@$SEAT_ID.service.d/seat.conf" << EOF_DESK_DROPIN
[Service]
User=$LINUX_USER
Group=$LINUX_USER
Environment=HOME=$HOME_DIR
Environment=SEAT_DIR=$SEAT_DIR
EOF_DESK_DROPIN
cat > "/etc/systemd/system/satuwork-bot@$SEAT_ID.service.d/seat.conf" << EOF_BOT_DROPIN
[Service]
User=$LINUX_USER
Group=$LINUX_USER
Environment=HOME=$HOME_DIR
Environment=SEAT_DIR=$SEAT_DIR
EnvironmentFile=-$SEAT_DIR/bot.env
EOF_BOT_DROPIN

cat > "$SEAT_DIR/desktop.env" << EOF_ENV
DISPLAY_NUM=$DISPLAY_NUM
DISPLAY=$DISPLAY_VAR
RFB=$RFB
HTTP=$HTTP
CDP=$CDP
EOF_ENV
runuser -u "$LINUX_USER" -- x11vnc -storepasswd "$VNC_PASSWORD" "$SEAT_DIR/vnc-passwd" >/dev/null
printf 'backend = "xrender";\nvsync = false;\nuse-damage = false;\n' > "$SEAT_DIR/config/picom/picom.conf"

if [ ! -f "$BOT_EXTRACT/bin/satuwork.mjs" ]; then
  echo "release $BOT_VERSION has no bin/satuwork.mjs" >&2
  exit 42
fi

# 每个席位还是各自一份 app：cordis.yml 里的监听端口是逐席位 sed 出来的，共享一份
# 目录就没法让两个席位听不同的口。版本也因此能逐席位钉死。
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete "$BOT_EXTRACT/" "$SEAT_DIR/app/"
else
  rm -rf "$SEAT_DIR/app"
  mkdir -p "$SEAT_DIR/app"
  cp -a "$BOT_EXTRACT/." "$SEAT_DIR/app/"
fi
printf '%s\n' "$BOT_VERSION" > "$SEAT_DIR/app/VERSION"
if [ -f "$SEAT_DIR/app/cordis.yml" ]; then
  # bot 只听 127.0.0.1：对外那一跳由管家反代，席位端口不再需要暴露到网络上。
  sed -i -E "s/^([[:space:]]*host:).*/\1 127.0.0.1/" "$SEAT_DIR/app/cordis.yml"
  sed -i -E "s/^([[:space:]]*port:)[[:space:]]*[0-9]+/\1 $BOT_PORT/" "$SEAT_DIR/app/cordis.yml"
fi

cat > "$SEAT_DIR/bot.env" << EOF_ENV
GATEWAY_URL=$GATEWAY_URL
GATEWAY_TOKEN=$GATEWAY_TOKEN
GATEWAY_API_KEY=$GATEWAY_API_KEY
SATUWORK_BOT_ID=$SATUWORK_BOT_ID
SATUWORK_HOME=$SEAT_DIR
SATUWORK_PORT=$BOT_PORT
SATUWORK_WORK_DIR=$WORK_DIR
DISPLAY=$DISPLAY_VAR
XDG_SESSION_TYPE=x11
XDG_CONFIG_HOME=$SEAT_DIR/config
XDG_DATA_HOME=$SEAT_DIR/share
XDG_CACHE_HOME=$SEAT_DIR/cache
XDG_RUNTIME_DIR=/tmp/xdg-runtime-$SEAT_ID
GDK_BACKEND=x11
HOME=$HOME_DIR
EOF_ENV

chown -R "$LINUX_USER:$LINUX_USER" "$SEAT_DIR"
chmod 600 "$SEAT_DIR/desktop.env" "$SEAT_DIR/vnc-passwd" "$SEAT_DIR/bot.env"

systemctl daemon-reload
systemctl enable --now "slim-desktop@$SEAT_ID.service"
systemctl enable "satuwork-bot@$SEAT_ID.service"
systemctl restart "satuwork-bot@$SEAT_ID.service"
