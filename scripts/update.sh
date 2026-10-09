#!/bin/sh
# MyBox 升级脚本：更新面板代码，保留 data/（订阅、设置、开关文件）。
#
#   curl -fsSL https://raw.githubusercontent.com/asdzx07/mybox/main/scripts/update.sh | sudo sh
#
# 内核不在本脚本里升级——在面板「设置 → 内核」里点「安装/更新官方内核」，
# 这样内核版本和面板版本可以各自独立。
set -eu

REPO="asdzx07/mybox"
BRANCH="main"
ROOT=/opt/mybox
USE_MIRROR=0
SRC_DIR=""

while [ $# -gt 0 ]; do
  case "$1" in
    --mirror) USE_MIRROR=1; shift ;;
    --src) SRC_DIR="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 运行"
[ -d "$ROOT" ] || die "$ROOT 不存在，请先安装"

MIRRORS="https://ghfast.top https://gh-proxy.com"

if [ -n "$SRC_DIR" ]; then
  say "从本地目录升级：$SRC_DIR"
  SRCDIR="$SRC_DIR"
else
  say "下载最新源码"
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
fi

say "备份当前代码"
STAMP=$(date +%Y%m%d%H%M%S)
BACKUP="$ROOT/.backup-$STAMP"
mkdir -p "$BACKUP"
for d in server panel system; do
  [ -d "$ROOT/$d" ] && cp -R "$ROOT/$d" "$BACKUP/" 2>/dev/null || true
done

say "替换代码（data/ 不动）"
for d in server panel system; do
  rm -rf "$ROOT/$d"
  cp -R "$SRCDIR/$d" "$ROOT/"
done
cp "$SRCDIR/package.json" "$ROOT/"

say "更新依赖"
cd "$ROOT"
if command -v npm >/dev/null 2>&1; then
  npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1 || say "npm install 有告警，继续"
fi

if [ -f /etc/openwrt_release ]; then
  say "更新服务脚本（procd）"
  for s in mybox-panel mybox-kernel; do
    [ -f "$ROOT/system/openwrt/initd/$s" ] && install -m 0755 "$ROOT/system/openwrt/initd/$s" "/etc/init.d/$s"
  done

  KERNEL_WAS_RUNNING=0
  /etc/init.d/mybox-kernel status 2>/dev/null | grep -q running && KERNEL_WAS_RUNNING=1

  say "重启面板"
  /etc/init.d/mybox-panel restart || die "面板重启失败，代码已备份在 $BACKUP"

  if [ "$KERNEL_WAS_RUNNING" = "1" ]; then
    say "重启内核"
    /etc/init.d/mybox-kernel restart || true
  fi
else
  say "更新 systemd 单元"
  for unit in mybox-panel mybox-kernel; do
    [ -f "$ROOT/system/$unit.service" ] && install -m 0644 "$ROOT/system/$unit.service" "/etc/systemd/system/$unit.service"
  done
  systemctl daemon-reload

  say "重启面板"
  systemctl restart mybox-panel || die "面板重启失败，代码已备份在 $BACKUP"

  # 内核如果本来在跑，重启一次让新配置生效
  if systemctl is-active --quiet mybox-kernel; then
    say "重启内核"
    systemctl restart mybox-kernel || true
  fi
fi

[ -n "${TMP:-}" ] && rm -rf "$TMP"

say "升级完成（备份：$BACKUP）"
