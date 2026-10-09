#!/bin/sh
# MyBox 安装脚本（Debian / Ubuntu，systemd）
#
#   curl -fsSL https://raw.githubusercontent.com/asdzx07/mybox/main/scripts/install.sh | sudo sh
#
# 可选参数：
#   --port <端口>     指定面板端口（默认 3036）
#   --mirror          下载走加速镜像
#   --src <目录>      用本地目录里的源码安装（开发用）
#   --skip-kernel     只装面板，不下载内核
set -eu

REPO="asdzx07/mybox"
BRANCH="main"
ROOT=/opt/mybox
PORT=""
USE_MIRROR=0
SRC_DIR=""
SKIP_KERNEL=0
MIRRORS="https://ghfast.top https://gh-proxy.com"

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --mirror) USE_MIRROR=1; shift ;;
    --src) SRC_DIR="$2"; shift 2 ;;
    --skip-kernel) SKIP_KERNEL=1; shift ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 运行（或 sudo sh）"

# ---------------------------------------------------------------- 系统检查
[ -d /run/systemd/system ] || die "需要 systemd。OpenWrt 请等 OpenWrt 版适配。"

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l) ARCH=armv7 ;;
  *) die "不支持的架构：$(uname -m)" ;;
esac
say "架构：$(uname -m) → $ARCH"

# ---------------------------------------------------------------- Node 检查
need_node=1
if command -v node >/dev/null 2>&1; then
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -ge 20 ] 2>/dev/null; then
    say "Node $(node -v) 可用"
    need_node=0
  else
    warn "Node 版本过低（$(node -v)），需要 20 以上"
  fi
fi

if [ "$need_node" = "1" ]; then
  say "尝试通过 apt 安装 Node.js"
  apt-get update -qq >/dev/null 2>&1 || true
  apt-get install -y -qq nodejs npm >/dev/null 2>&1 || true
  if ! command -v node >/dev/null 2>&1; then
    die "装不上 Node.js。请先安装 Node 20+ 后重试，参考 https://nodejs.org/"
  fi
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  [ "$major" -ge 20 ] 2>/dev/null || die "apt 里的 Node 太旧（$(node -v)）。请装 Node 20+ 后重试。"
fi

# ---------------------------------------------------------------- 准备目录
say "准备 $ROOT"
mkdir -p "$ROOT" "$ROOT/data"

# ---------------------------------------------------------------- 取源码
if [ -n "$SRC_DIR" ]; then
  say "从本地目录安装：$SRC_DIR"
  [ -d "$SRC_DIR/server" ] || die "$SRC_DIR 里没有 server/，不是 MyBox 源码目录"
  cp -R "$SRC_DIR/server" "$ROOT/"
  cp -R "$SRC_DIR/panel"  "$ROOT/"
  cp -R "$SRC_DIR/system" "$ROOT/" 2>/dev/null || true
  cp "$SRC_DIR/package.json" "$ROOT/"
else
  say "下载源码"
  TMP=$(mktemp -d)
  TARBALL="$TMP/mybox.tar.gz"
  URL="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"
  ok=0
  if [ "$USE_MIRROR" = "1" ]; then
    for m in $MIRRORS; do
      if curl -fsSL "$m/$URL" -o "$TARBALL" 2>/dev/null; then ok=1; break; fi
    done
  fi
  if [ "$ok" = "0" ]; then
    curl -fsSL "$URL" -o "$TARBALL" || die "下载源码失败"
  fi
  tar -xzf "$TARBALL" -C "$TMP"
  SRCDIR=$(find "$TMP" -maxdepth 1 -type d -name "mybox-*" | head -n 1)
  [ -n "$SRCDIR" ] || die "解包后找不到源码目录"
  rm -rf "$ROOT/server" "$ROOT/panel" "$ROOT/system"
  cp -R "$SRCDIR/server" "$ROOT/"
  cp -R "$SRCDIR/panel"  "$ROOT/"
  cp -R "$SRCDIR/system" "$ROOT/"
  cp "$SRCDIR/package.json" "$ROOT/"
  cp -R "$SRCDIR/scripts" "$ROOT/" 2>/dev/null || true
  rm -rf "$TMP"
fi

# ---------------------------------------------------------------- 依赖
say "安装面板依赖"
cd "$ROOT"
if command -v npm >/dev/null 2>&1; then
  npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || warn "npm install 失败，面板可能起不来"
else
  warn "没有 npm，跳过依赖安装"
fi

# ---------------------------------------------------------------- 端口
if [ -z "$PORT" ]; then
  printf '面板端口 [3036]: '
  read -r PORT </dev/tty 2>/dev/null || PORT=""
  [ -n "$PORT" ] || PORT=3036
fi
case "$PORT" in
  *[!0-9]*) die "端口必须是数字：$PORT" ;;
esac
for reserved in 53 22 80 443 9095 7853 7891; do
  [ "$PORT" = "$reserved" ] && die "端口 $PORT 被内核或系统占用，请换一个"
done
echo "$PORT" > "$ROOT/data/panel-port"
say "面板端口：$PORT"

# ---------------------------------------------------------------- 内核
if [ "$SKIP_KERNEL" = "0" ]; then
  say "下载官方 sing-box 内核"
  if [ -x "$ROOT/bin/sing-box" ]; then
    say "已存在内核，跳过（面板里可以更新）"
  else
    LIBC=glibc
    VERSION=$(curl -fsSL "https://api.github.com/repos/SagerNet/sing-box/releases/latest" \
      | grep -o '"tag_name": *"[^"]*"' | head -n 1 | cut -d'"' -f4) || VERSION=""
    [ -n "$VERSION" ] || die "查询 sing-box 最新版本失败，稍后可在面板里安装"
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
    if [ "$got" = "0" ]; then
      curl -fsSL "$DL" -o "$TMP/$ASSET" || die "下载内核失败：$ASSET"
    fi
    tar -xzf "$TMP/$ASSET" -C "$TMP"
    BIN=$(find "$TMP" -type f -name sing-box | head -n 1)
    [ -n "$BIN" ] || die "解包后找不到 sing-box"
    mkdir -p "$ROOT/bin"
    install -m 0755 "$BIN" "$ROOT/bin/sing-box"
    rm -rf "$TMP"
    say "内核已安装：$("$ROOT/bin/sing-box" version | head -n 1)"
  fi
fi

# ---------------------------------------------------------------- 服务
say "安装 systemd 服务"
UNIT_SRC="$ROOT/system"

for unit in mybox-panel mybox-kernel; do
  if [ -f "$UNIT_SRC/$unit.service" ]; then
    install -m 0644 "$UNIT_SRC/$unit.service" "/etc/systemd/system/$unit.service"
  fi
done

if [ ! -f /etc/systemd/system/mybox-panel.service ]; then
  die "找不到 systemd 单元文件（$UNIT_SRC），无法安装服务"
fi

systemctl daemon-reload
systemctl enable --now mybox-panel >/dev/null 2>&1 || warn "面板服务启动失败，看 journalctl -u mybox-panel"

IP=$(ip -4 route get 1.1.1.1 2>/dev/null | grep -o 'src [0-9.]*' | awk '{print $2}')
[ -n "$IP" ] || IP=$(hostname -I 2>/dev/null | awk '{print $1}')
[ -n "$IP" ] || IP="<本机IP>"

cat <<EOF

  MyBox 安装完成。

  面板地址：http://$IP:$PORT
  首次打开会要求设置面板密码。

  下一步：
    1. 打开面板，添加订阅并刷新节点
    2. 在「设置」里确认 DNS 接管方式，点「保存并部署」
    3. 把局域网设备的网关/DNS 指向本机（$IP）

  常用命令：
    systemctl status mybox-panel     # 面板状态
    journalctl -u mybox-panel -f     # 面板日志
    journalctl -u mybox-kernel -f    # 内核日志
    卸载：curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/uninstall.sh | sudo sh

EOF
