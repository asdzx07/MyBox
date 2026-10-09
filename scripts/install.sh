#!/bin/sh
# MyBox 安装脚本
#
#   OpenWrt / iStoreOS:
#     curl -fsSL https://raw.githubusercontent.com/asdzx07/mybox/main/scripts/install.sh | sh
#   Debian / Ubuntu:
#     curl -fsSL https://raw.githubusercontent.com/asdzx07/mybox/main/scripts/install.sh | sudo sh
#
# 可选参数：
#   --port <端口>      面板端口（默认 3036）
#   --mirror           下载走加速镜像
#   --src <目录>       用本地目录安装（开发用）
#   --skip-kernel      只装面板，不下载内核
#   --node-version <v> 指定 Node 版本（OpenWrt 用，默认 v22.22.0）
set -eu

REPO="asdzx07/mybox"
BRANCH="main"
ROOT=/opt/mybox
PORT=""
USE_MIRROR=0
SRC_DIR=""
SKIP_KERNEL=0
NODE_VERSION="v22.22.0"
MIRRORS="https://ghfast.top https://gh-proxy.com"
NODE_MIRROR="https://unofficial-builds.nodejs.org/download/release"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --mirror) USE_MIRROR=1; shift ;;
    --src) SRC_DIR="$2"; shift 2 ;;
    --skip-kernel) SKIP_KERNEL=1; shift ;;
    --node-version) NODE_VERSION="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }
# busybox 没有 install 命令，用 cp + chmod 代替
put()  { cp "$2" "$3" && chmod "$1" "$3"; }

[ "$(id -u)" = "0" ] || die "请用 root 运行（OpenWrt 直接 root 登录；Debian 用 sudo）"

# ---------------------------------------------------------------- 平台
if [ -f /etc/openwrt_release ]; then
  PLATFORM=openwrt
  . /etc/openwrt_release
  say "平台：OpenWrt 系（$DISTRIB_DESCRIPTION）"
elif [ -d /run/systemd/system ]; then
  PLATFORM=systemd
  say "平台：Linux + systemd"
else
  die "不支持的平台：既不是 OpenWrt，也没有 systemd"
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l) ARCH=armv7 ;;
  *) die "不支持的架构：$(uname -m)" ;;
esac
say "架构：$(uname -m) → $ARCH"

# ---------------------------------------------------------------- 依赖
if [ "$PLATFORM" = openwrt ]; then
  say "检查内核模块与基础依赖"
  MISSING=""
  for pkg in kmod-tun kmod-nft-queue kmod-nft-redir ip-full ca-bundle; do
    opkg list-installed 2>/dev/null | grep -q "^$pkg " || MISSING="$MISSING $pkg"
  done
  if [ -n "$MISSING" ]; then
    say "尝试安装：$MISSING"
    opkg update >/dev/null 2>&1 || warn "opkg update 失败，继续尝试"
    # shellcheck disable=SC2086
    opkg install $MISSING >/dev/null 2>&1 || warn "部分依赖装不上。软件源不通时可以稍后手动装，不影响面板启动"
  fi
  if [ ! -e /dev/net/tun ]; then
    modprobe tun >/dev/null 2>&1 || true
    [ -e /dev/net/tun ] || warn "没有 /dev/net/tun，内核起不来。请装 kmod-tun 后重试"
  fi
  if [ ! -d /sys/module/nft_queue ] && [ ! -e /lib/modules/*/nft_queue.ko ]; then
    warn "没有 nft_queue 模块：auto_redirect 可能降级，吞吐会低一些"
  fi
fi

# ---------------------------------------------------------------- Node
if [ "$PLATFORM" = openwrt ]; then
  if [ -x "$ROOT/node/bin/node" ]; then
    say "Node 已存在：$("$ROOT/node/bin/node" -v)"
  else
    say "下载 Node $NODE_VERSION（musl 版）"
    case "$ARCH" in
      amd64) NARCH=x64 ;;
      arm64) NARCH=arm64 ;;
      armv7) NARCH=armv7l ;;
    esac
    NODE_ASSET="node-$NODE_VERSION-linux-$NARCH-musl"
    TMP=$(mktemp -d)
    got=0
    for ext in tar.xz tar.gz; do
      if curl -fsSL "$NODE_MIRROR/$NODE_VERSION/$NODE_ASSET.$ext" -o "$TMP/node.$ext" 2>/dev/null; then got=1; break; fi
    done
    [ "$got" = "1" ] || die "下载 Node 失败（$NODE_ASSET）"
    mkdir -p "$ROOT/node"
    tar -xf "$TMP/node."* -C "$TMP"
    NDIR=$(find "$TMP" -maxdepth 1 -type d -name "node-*" | head -n 1)
    [ -n "$NDIR" ] || die "解包 Node 失败"
    cp -R "$NDIR"/. "$ROOT/node/"
    rm -rf "$TMP"
    say "Node 已安装：$("$ROOT/node/bin/node" -v)"
  fi
  NODE_BIN="$ROOT/node/bin/node"
  NPM_BIN="$ROOT/node/bin/npm"
else
  NODE_BIN=""
  NPM_BIN=""
  need=1
  if command -v node >/dev/null 2>&1; then
    major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    if [ "$major" -ge 20 ] 2>/dev/null; then say "Node $(node -v) 可用"; need=0; fi
  fi
  if [ "$need" = "1" ]; then
    say "通过 apt 安装 Node.js"
    apt-get update -qq >/dev/null 2>&1 || true
    apt-get install -y -qq nodejs npm >/dev/null 2>&1 || true
    command -v node >/dev/null 2>&1 || die "装不上 Node.js，请手动装 Node 20+ 后重试"
    major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
    [ "$major" -ge 20 ] 2>/dev/null || die "apt 里的 Node 太旧（$(node -v)），请装 Node 20+"
  fi
  NODE_BIN="$(command -v node)"
  NPM_BIN="$(command -v npm || true)"
fi

# ---------------------------------------------------------------- 源码
say "准备 $ROOT"
mkdir -p "$ROOT" "$ROOT/data"

TMP_SRC=""
if [ -n "$SRC_DIR" ]; then
  say "从本地目录安装：$SRC_DIR"
  [ -d "$SRC_DIR/server" ] || die "$SRC_DIR 里没有 server/，不是 MyBox 源码目录"
  SRCDIR="$SRC_DIR"
else
  say "下载源码"
  TMP_SRC=$(mktemp -d)
  TARBALL="$TMP_SRC/mybox.tar.gz"
  URL="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"
  ok=0
  if [ "$USE_MIRROR" = "1" ]; then
    for m in $MIRRORS; do
      if curl -fsSL "$m/$URL" -o "$TARBALL" 2>/dev/null; then ok=1; break; fi
    done
  fi
  if [ "$ok" = "0" ]; then curl -fsSL "$URL" -o "$TARBALL" || die "下载源码失败"; fi
  tar -xzf "$TARBALL" -C "$TMP_SRC"
  SRCDIR=$(find "$TMP_SRC" -maxdepth 1 -type d -name "mybox-*" | head -n 1)
  [ -n "$SRCDIR" ] || die "解包后找不到源码目录"
fi

for d in server panel system; do
  rm -rf "$ROOT/$d"
  cp -R "$SRCDIR/$d" "$ROOT/"
done
cp "$SRCDIR/package.json" "$ROOT/"
cp -R "$SRCDIR/scripts" "$ROOT/" 2>/dev/null || true
[ -n "$TMP_SRC" ] && rm -rf "$TMP_SRC"

# ---------------------------------------------------------------- 依赖
say "安装面板依赖（express / yaml）"
cd "$ROOT"
if [ -x "$NPM_BIN" ]; then
  # OpenWrt 上 npm 是 JS 脚本，要靠随包的 node 解释，PATH 里得带上它
  PATH="$(dirname "$NODE_BIN"):$PATH" "$NPM_BIN" install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null 2>&1 \
    || warn "npm install 失败，面板可能起不来。可手动在 $ROOT 下执行 npm install"
else
  warn "没有 npm，跳过依赖安装"
fi

# ---------------------------------------------------------------- 端口
if [ -z "$PORT" ]; then
  printf '面板端口 [3036]: '
  read -r PORT </dev/tty 2>/dev/null || PORT=""
  [ -n "$PORT" ] || PORT=3036
fi
case "$PORT" in *[!0-9]*) die "端口必须是数字：$PORT" ;; esac
for reserved in 53 22 80 443 9095 7853 7891; do
  [ "$PORT" = "$reserved" ] && die "端口 $PORT 被内核或系统占用，请换一个"
done
echo "$PORT" > "$ROOT/data/panel-port"
say "面板端口：$PORT"

# ---------------------------------------------------------------- 内核
if [ "$SKIP_KERNEL" = "0" ]; then
  if [ -x "$ROOT/bin/sing-box" ]; then
    say "内核已存在：$("$ROOT/bin/sing-box" version 2>/dev/null | head -n 1)，跳过"
  else
    say "下载官方 sing-box 内核"
    if [ "$PLATFORM" = openwrt ]; then LIBC=musl; else LIBC=glibc; fi
    VERSION=$(curl -fsSL "https://api.github.com/repos/SagerNet/sing-box/releases/latest" \
      | grep -o '"tag_name": *"[^"]*"' | head -n 1 | cut -d'"' -f4) || VERSION=""
    [ -n "$VERSION" ] || die "查询 sing-box 版本失败，稍后可在面板里安装"
    VER_NUM=$(echo "$VERSION" | sed 's/^v//')
    ASSET="sing-box-$VER_NUM-linux-$ARCH-$LIBC.tar.gz"
    DL="https://github.com/SagerNet/sing-box/releases/download/$VERSION/$ASSET"
    TMP=$(mktemp -d)
    got=0
    if [ "$USE_MIRROR" = "1" ]; then
      for m in $MIRRORS; do
        if curl -fsSL "$m/$DL" -o "$TMP/$ASSET" 2>/dev/null; then got=1; break; fi
      done
    fi
    if [ "$got" = "0" ]; then curl -fsSL "$DL" -o "$TMP/$ASSET" || die "下载内核失败：$ASSET"; fi
    tar -xzf "$TMP/$ASSET" -C "$TMP"
    BIN=$(find "$TMP" -type f -name sing-box | head -n 1)
    [ -n "$BIN" ] || die "解包后找不到 sing-box"
    mkdir -p "$ROOT/bin"
    put 0755 "$BIN" "$ROOT/bin/sing-box"
    rm -rf "$TMP"
    say "内核已安装：$("$ROOT/bin/sing-box" version | head -n 1)"
  fi
fi

# ---------------------------------------------------------------- 服务
say "安装服务脚本"
if [ "$PLATFORM" = openwrt ]; then
  for s in mybox-panel mybox-kernel; do
    put 0755 "$ROOT/system/openwrt/initd/$s" "/etc/init.d/$s"
  done
  # LuCI 兜底页
  mkdir -p /usr/lib/lua/luci/controller /usr/lib/lua/luci/view/mybox
  cp "$ROOT/system/openwrt/luci/controller/mybox.lua" /usr/lib/lua/luci/controller/mybox.lua
  cp "$ROOT/system/openwrt/luci/view/mybox/status.htm" /usr/lib/lua/luci/view/mybox/status.htm
  rm -rf /tmp/luci-indexcache 2>/dev/null || true
  /etc/init.d/mybox-panel enable >/dev/null 2>&1 || warn "开机自启设置失败"
  /etc/init.d/mybox-panel start >/dev/null 2>&1 || warn "面板启动失败，看 logread -e mybox"
  sleep 1
  say "面板服务状态：$(/etc/init.d/mybox-panel status 2>&1)"
  LOGHINT="logread -e mybox"
else
  for s in mybox-panel mybox-kernel; do
    [ -f "$ROOT/system/$s.service" ] && put 0644 "$ROOT/system/$s.service" "/etc/systemd/system/$s.service"
  done
  systemctl daemon-reload
  systemctl enable --now mybox-panel >/dev/null 2>&1 || warn "面板服务启动失败，看 journalctl -u mybox-panel"
  LOGHINT="journalctl -u mybox-panel -f"
fi

IP=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | awk '{print $2}')
[ -n "$IP" ] || IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$IP" ] || IP="<本机IP>"

cat <<EOF

  MyBox 安装完成。

  面板地址：http://$IP:$PORT
  首次打开会要求设置面板密码。

  下一步：
    1. 打开面板，添加订阅并刷新节点
    2. 「设置」里确认 DNS 接管方式与「直连不进内核」，点「保存并部署」
    3. 把局域网设备的网关/DNS 指向本机（$IP）

  常用命令：
    /etc/init.d/mybox-panel status     # 面板状态
    /etc/init.d/mybox-kernel restart   # 重启内核
    $LOGHINT
    卸载：curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/uninstall.sh | sh

EOF
