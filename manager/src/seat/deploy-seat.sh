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

# procps/iproute2：slim-desktop.sh 靠 pkill 和 ss 清上一轮的残留，少了它们那段会静默失效。
PKGS="xorg xvfb dbus-x11 x11-xserver-utils xfwm4 thunar xfce4-terminal plank picom hsetroot x11vnc novnc python3-websockify procps iproute2"
NEED=""
for p in $PKGS; do
  if ! dpkg -s "$p" >/dev/null 2>&1; then NEED="$NEED $p"; fi
done
if [ -n "$NEED" ]; then
  apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y $NEED
fi
# ── 浏览器 ────────────────────────────────────────────────────────────
# bot 干活主要靠它（开网页、填表单、截图），dock 上第一格也是它。所以这是部署的一
# 部分，不是「顺手装装看」：每次部署都确认在位，不在就装，装完再确认一次。
#
# 原来这里是一句 `apt-get install -y chromium 2>/dev/null || true`——**失败完全静默**。
# 源里没有、网络不通、包名不对，结果都一样：部署照常成功，桌面起来了，dock 上少一
# 格，没有任何地方说得出为什么。
#
# **按架构分。** Google 官方只为 linux/amd64 发 Chrome，arm64 上没有这个包；在 arm 机
# 器上去配 Google 的 apt 源，`apt update` 会 404，还会把整条 apt 链路弄脏。所以只有
# amd64 才走官方源，arm64 一律用 Debian 自己的 Chromium——对 bot 来说两者等价。
chrome_bin() {
  for c in google-chrome-stable google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1; then echo "$c"; return 0; fi
  done
  return 1
}

install_google_chrome() {
  local key=/usr/share/keyrings/google-chrome.gpg
  local need=""
  for p in curl gnupg ca-certificates; do
    dpkg -s "$p" >/dev/null 2>&1 || need="$need $p"
  done
  if [ -n "$need" ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y $need >/dev/null 2>&1 || return 1
  fi
  curl -fsSL --max-time 60 https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o "$key" 2>/dev/null || return 1
  echo "deb [arch=amd64 signed-by=$key] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  # 只刷 Google 这一个源。整库 update 在慢网上要好几分钟，而这里只关心一个包。
  apt-get update \
    -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/google-chrome.list \
    -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 >/dev/null 2>&1 || return 1
  DEBIAN_FRONTEND=noninteractive apt-get install -y google-chrome-stable >/dev/null 2>&1
}

ensure_chrome() {
  local have
  if have=$(chrome_bin); then
    echo "chrome: 已在位（$have）"
    return 0
  fi
  local arch
  arch=$(dpkg --print-architecture 2>/dev/null || echo unknown)
  echo "chrome: 没找到浏览器，开始安装（arch=$arch）"
  if [ "$arch" = "amd64" ]; then
    install_google_chrome || echo "chrome: 官方源装不上，回落到 Chromium" >&2
  fi
  if ! chrome_bin >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y chromium >/dev/null 2>&1 || true
  fi
  if ! chrome_bin >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y chromium-browser >/dev/null 2>&1 || true
  fi
  if have=$(chrome_bin); then
    echo "chrome: 装好了（$have）"
    return 0
  fi
  # **不让部署失败。** 没有浏览器，桌面、终端、文件管理器和 bot 的其它能力都还在；
  # 而部署失败会让整个席位起不来，代价大得多。但必须吼出来——静默正是上一版的毛病。
  echo "chrome: 装不上（源里没有或网络不通），这个席位没有浏览器可用" >&2
  return 0
}
ensure_chrome

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
WORK_DIR=$WORK_DIR
EOF_ENV
# stderr 也要吞：x11vnc 把「stored passwd in file: …」这句**正常输出**打在 stderr 上，
# 不吞的话它会混进部署失败时收集的错误里，还恰好排在最前面——真正的原因被挤到后面，
# 而错误信息在界面上是截断显示的，于是看到的第一句永远是这句无关的话。
runuser -u "$LINUX_USER" -- x11vnc -storepasswd "$VNC_PASSWORD" "$SEAT_DIR/vnc-passwd" >/dev/null 2>&1
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
# **两个都要 restart，不能用 `enable --now`。**
# `--now` 的语义是「没在跑就起来」——已经在跑就什么都不做。桌面这条以前正是
# `enable --now`，于是重新部署时：新的 VNC 口令写进了 vnc-passwd，而 x11vnc 是启动
# 那一刻用 -rfbauth 读的文件，进程没重启，内存里还是**上一次部署**的旧口令。
# 表现是界面上明明写着口令、照着输却一直 password check failed，而且怎么重新部署
# 都不会好——因为每次都不重启。
enable_and_restart() {
  systemctl enable "$1" >/dev/null 2>&1 || true
  systemctl restart "$1"
}
enable_and_restart "slim-desktop@$SEAT_ID.service"
enable_and_restart "satuwork-bot@$SEAT_ID.service"

# ── 部署完自证：那两个端口上蹲着的得是**这个席位的**进程 ────────────────
# 「起完就算成功」在这里是不够的。机器上完全可能有另一套 VNC 占着 6081——这台就
# 撞过：一个 Aug 16 起的 x11vnc :3 + websockify 0.0.0.0:6081 → localhost:5902，口令在
# /home/slim/.vnc/passwd。它把席位的 websockify 挤得起不来，而管家照样上报 ready。
#
# 结果是界面上「部署成功」，点开桌面也**真的能连上**——连的是那一套，于是照着界面
# 输口令永远 password check failed，重新部署多少次都一样。这种失败不会自己浮出来，
# 只能靠人去 ps 里翻。所以在这里就断掉，把原因写进部署错误里报回 Gateway。
verify_seat_listener() {
  local port="$1" what="$2" pid owner
  # 等 30 秒。**新建席位第一次起屏比想象的慢**：adduser、daemon-reload、Xvfb 就绪、
  # 上一轮残留的端口释放，叠起来轻松过十秒——等太短会把「慢」判成「坏」。
  for _ in $(seq 1 120); do
    pid=$(ss -ltnp 2>/dev/null | grep -E ":${port}\b" | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
    if [ -n "${pid:-}" ]; then
      owner=$(ps -o user:32= -p "$pid" 2>/dev/null | tr -d ' ')
      [ "$owner" = "$LINUX_USER" ] && return 0
      # 端口被**别人**占着：这是确定的错误，而且没人去动它就永远不会自己好。
      # 这一条必须让部署失败——否则又变成「部署成功但连进去是另一套 VNC」。
      echo "端口 $port（$what）被 ${owner:-?} 的进程 $pid 占着，不是这个席位的：" >&2
      ps -o pid,user:32,cmd -p "$pid" >&2 || true
      echo "这台机器上有别的 VNC/桌面在跑。确认无用后停掉它再重新部署——" >&2
      echo "不停的话「打开桌面」进的是那一套，口令永远对不上。" >&2
      exit 43
    fi
    sleep 0.25
  done
  # **超时不算部署失败。** 端口空着只说明「还没起来」，说不清是坏了还是慢；而
  # systemd 的 Restart=on-failure 本来就会继续拉。部署失败会让整个席位不可用，
  # 把一次「起得慢」升级成「用不了」，比漏报贵得多。吼一声，让它继续。
  echo "$what 还没在端口 $port 上起来（等了 30 秒）；systemd 会继续拉起。" >&2
  echo "若一直不好：journalctl -u slim-desktop@$SEAT_ID" >&2
}
verify_seat_listener "$RFB" x11vnc
verify_seat_listener "$HTTP" websockify
