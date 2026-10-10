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
TMP=""
STAGE=""
BACKUP=""
NODE_BIN=""
TXN_HELPER=""
UPDATE_APPLIED=0
if [ -f /etc/openwrt_release ]; then PLATFORM=openwrt; else PLATFORM=systemd; fi

TOKEN="${GITHUB_TOKEN:-}"

while [ $# -gt 0 ]; do
  case "$1" in
    --mirror) USE_MIRROR=1; shift ;;
    --src) SRC_DIR="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
put()  { cp "$2" "$3" && chmod "$1" "$3"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

backup_external() {
  target=$1
  key=$2
  mkdir -p "$BACKUP/external"
  if [ -e "$target" ]; then
    cp -p "$target" "$BACKUP/external/$key"
    : > "$BACKUP/external/$key.present"
  else
    : > "$BACKUP/external/$key.missing"
  fi
}

restore_external() {
  target=$1
  key=$2
  if [ -f "$BACKUP/external/$key.present" ]; then
    mkdir -p "$(dirname "$target")"
    cp -p "$BACKUP/external/$key" "$target"
  elif [ -f "$BACKUP/external/$key.missing" ]; then
    rm -f "$target"
  fi
}

restore_external_files() {
  if [ "$PLATFORM" = openwrt ]; then
    restore_external /etc/init.d/mybox-panel openwrt-panel
    restore_external /etc/init.d/mybox-kernel openwrt-kernel
    restore_external /usr/lib/lua/luci/controller/mybox.lua luci-controller
    restore_external /usr/lib/lua/luci/view/mybox/status.htm luci-status
    rm -rf /tmp/luci-indexcache 2>/dev/null || true
  else
    restore_external /etc/systemd/system/mybox-panel.service systemd-panel
    restore_external /etc/systemd/system/mybox-kernel.service systemd-kernel
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
}

restore_commit_marker() {
  [ -n "$BACKUP" ] || return 0
  if [ -f "$BACKUP/commit.sha.present" ]; then
    cp -p "$BACKUP/commit.sha" "$ROOT/data/commit.sha"
  elif [ -f "$BACKUP/commit.sha.missing" ]; then
    rm -f "$ROOT/data/commit.sha"
  fi
}

cleanup_update() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ "$status" -ne 0 ] && [ "$UPDATE_APPLIED" = 1 ]; then
    say "更新失败，正在恢复上一版代码"
    if [ -n "$NODE_BIN" ] && [ -f "$TXN_HELPER" ]; then
      "$NODE_BIN" "$TXN_HELPER" rollback "$ROOT" "$BACKUP" || say "代码自动回滚未完成，请从 $BACKUP 手动恢复"
    fi
    restore_external_files || say "外部服务文件自动恢复未完成，请从 $BACKUP/external 手动恢复"
    restore_commit_marker || say "commit.sha 自动恢复失败"
    if [ "$PLATFORM" = openwrt ]; then
      /etc/init.d/mybox-panel restart >/dev/null 2>&1 || say "上一版面板未能自动启动，请检查服务日志"
    else
      systemctl restart mybox-panel >/dev/null 2>&1 || say "上一版面板未能自动启动，请检查服务日志"
    fi
  fi
  [ -n "$STAGE" ] && rm -rf "$STAGE"
  [ -n "$TMP" ] && rm -rf "$TMP"
  exit "$status"
}

[ "$(id -u)" = "0" ] || die "请用 root 运行"
[ -d "$ROOT" ] || die "$ROOT 不存在，请先安装"
TMP=$(mktemp -d)
trap cleanup_update EXIT
trap 'exit 1' HUP INT TERM

MIRRORS="https://ghfast.top https://gh-proxy.com"

if [ -n "$SRC_DIR" ]; then
  say "从本地目录升级：$SRC_DIR"
  SRCDIR="$SRC_DIR"
else
  say "下载最新源码"
  TARBALL="$TMP/mybox.tar.gz"
  ok=0

  if [ -n "$TOKEN" ]; then
    say "检测到 GitHub Token，使用认证 API 下载源码"
    API_URL="https://api.github.com/repos/$REPO/tarball/$BRANCH"
    if curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$API_URL" -o "$TARBALL"; then
      ok=1
    fi
  else
    URL="https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz"
    if [ "$USE_MIRROR" = "1" ]; then
      for m in $MIRRORS; do
        if curl -fsSL "$m/$URL" -o "$TARBALL" 2>/dev/null; then ok=1; break; fi
      done
    fi
    if [ "$ok" = "0" ]; then
      curl -fsSL "$URL" -o "$TARBALL" 2>/dev/null && ok=1 || true
    fi
  fi

  [ "$ok" = "1" ] || die "下载源码失败（若是私有仓库，请传 --token <TOKEN> 或设置 GITHUB_TOKEN 环境变量）"

  tar -xzf "$TARBALL" -C "$TMP"
  SRCDIR=$(find "$TMP" -maxdepth 1 -type d -name "*mybox*" | head -n 1)
  [ -n "$SRCDIR" ] || die "解包后找不到源码目录"
fi

[ -d "$SRCDIR/server" ] || die "源码里没有 server/"
[ -d "$SRCDIR/panel" ] || die "源码里没有 panel/"
[ -f "$SRCDIR/package.json" ] || die "源码里没有 package.json"
[ -f "$SRCDIR/scripts/update-transaction.mjs" ] || die "源码里没有更新事务工具"

say "准备暂存目录并备份当前代码"
STAMP=$(date +%Y%m%d%H%M%S)
BACKUP="$ROOT/.backup-$STAMP-$$"
STAGE="$ROOT/.update-stage-$STAMP-$$"
mkdir -p "$BACKUP" "$STAGE"
TXN_HELPER="$TMP/update-transaction.mjs"
cp "$SRCDIR/scripts/update-transaction.mjs" "$TXN_HELPER"

for d in server panel system tools scripts; do
  [ -d "$SRCDIR/$d" ] || continue
  cp -R "$SRCDIR/$d" "$STAGE/$d"
done
cp "$SRCDIR/package.json" "$STAGE/package.json"
if [ -f "$SRCDIR/VERSION" ]; then
  cp "$SRCDIR/VERSION" "$STAGE/VERSION"
else
  echo "1.0.0" > "$STAGE/VERSION"
fi
[ -d "$STAGE/server" ] && [ -d "$STAGE/panel" ] && [ -d "$STAGE/tools" ] || die "暂存源码缺少必需目录"

# Node / npm 依赖先在 staging 中准备；失败时正式目录保持不动。
for c in "$ROOT/node/bin/node" "$(command -v node 2>/dev/null)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NODE_BIN="$c"; break; fi
done
[ -n "$NODE_BIN" ] || die "找不到 Node，无法验证暂存代码"
NPM_BIN=""
for c in "$ROOT/node/bin/npm" "$(command -v npm 2>/dev/null)"; do
  if [ -n "$c" ] && [ -x "$c" ]; then NPM_BIN="$c"; break; fi
done
if [ -n "$NPM_BIN" ]; then
  say "在暂存目录安装依赖"
  PATH="$ROOT/node/bin:$PATH" "$NPM_BIN" --prefix "$STAGE" install --omit=dev --no-audit --no-fund >/dev/null || die "暂存依赖安装失败，正式版本未更改"
elif [ -d "$ROOT/node_modules" ]; then
  say "没找到 npm，保留现有依赖目录"
  cp -R "$ROOT/node_modules" "$STAGE/node_modules"
else
  die "没找到 npm 或现有 node_modules，无法准备更新"
fi

say "验证暂存代码"
"$NODE_BIN" --check "$STAGE/server/index.mjs"
"$NODE_BIN" "$STAGE/tools/check-syntax.mjs"
for script in "$STAGE"/scripts/*.sh; do
  [ -f "$script" ] || continue
  sh -n "$script"
done

# 记录上一版 commit 标记，以便失败回滚时恢复；此文件位于 data/，不参与代码替换。
mkdir -p "$ROOT/data"
if [ -f "$ROOT/data/commit.sha" ]; then
  cp -p "$ROOT/data/commit.sha" "$BACKUP/commit.sha"
  : > "$BACKUP/commit.sha.present"
else
  : > "$BACKUP/commit.sha.missing"
fi

# 备份更新时会触及的系统服务文件，失败时恢复原件。
if [ "$PLATFORM" = openwrt ]; then
  backup_external /etc/init.d/mybox-panel openwrt-panel
  backup_external /etc/init.d/mybox-kernel openwrt-kernel
  backup_external /usr/lib/lua/luci/controller/mybox.lua luci-controller
  backup_external /usr/lib/lua/luci/view/mybox/status.htm luci-status
else
  backup_external /etc/systemd/system/mybox-panel.service systemd-panel
  backup_external /etc/systemd/system/mybox-kernel.service systemd-kernel
fi

# 查询版本号失败不阻断更新，只影响展示 commit SHA。
AUTH_HDR=""
[ -n "$TOKEN" ] && AUTH_HDR="Authorization: Bearer $TOKEN"
COMMIT=$(curl -fsSL ${AUTH_HDR:+-H "$AUTH_HDR"} "https://api.github.com/repos/$REPO/commits/$BRANCH" 2>/dev/null | grep -o '"sha": "[a-f0-9]*"' | head -1 | cut -d'"' -f4 | cut -c1-7 || true)

say "原子切换代码（data/ 不动）"
UPDATE_APPLIED=1
"$NODE_BIN" "$TXN_HELPER" apply "$ROOT" "$STAGE" "$BACKUP" server panel system tools scripts package.json VERSION node_modules
[ -z "$COMMIT" ] || printf '%s\n' "$COMMIT" > "$ROOT/data/commit.sha"

if [ "$PLATFORM" = openwrt ]; then
  say "更新服务脚本（procd）"
  for s in mybox-panel mybox-kernel; do
    [ -f "$ROOT/system/openwrt/initd/$s" ] && put 0755 "$ROOT/system/openwrt/initd/$s" "/etc/init.d/$s"
  done

  say "安装 LuCI 兜底页"
  if [ -f "$ROOT/system/openwrt/luci/controller/mybox.lua" ]; then
    mkdir -p /usr/lib/lua/luci/controller /usr/lib/lua/luci/view/mybox
    cp "$ROOT/system/openwrt/luci/controller/mybox.lua" /usr/lib/lua/luci/controller/mybox.lua
    cp "$ROOT/system/openwrt/luci/view/mybox/status.htm" /usr/lib/lua/luci/view/mybox/status.htm
    rm -rf /tmp/luci-indexcache 2>/dev/null || true
  fi

  KERNEL_WAS_RUNNING=0
  /etc/init.d/mybox-kernel status 2>/dev/null | grep -q running && KERNEL_WAS_RUNNING=1

  say "重启面板"
  /etc/init.d/mybox-panel stop 2>/dev/null || true
  killall -9 node 2>/dev/null || true
  sleep 1
  /etc/init.d/mybox-panel start || /etc/init.d/mybox-panel restart || die "面板重启失败，正在回滚并恢复上一版"

  if [ "$KERNEL_WAS_RUNNING" = "1" ]; then
    say "重启内核"
    /etc/init.d/mybox-kernel restart || true
  fi
else
  say "更新 systemd 单元"
  for unit in mybox-panel mybox-kernel; do
    [ -f "$ROOT/system/$unit.service" ] && put 0644 "$ROOT/system/$unit.service" "/etc/systemd/system/$unit.service"
  done
  systemctl daemon-reload

  say "重启面板"
  systemctl restart mybox-panel || die "面板重启失败，正在回滚并恢复上一版"

  # 内核如果本来在跑，重启一次让新配置生效
  if systemctl is-active --quiet mybox-kernel; then
    say "重启内核"
    systemctl restart mybox-kernel || true
  fi
fi

"$NODE_BIN" "$TXN_HELPER" finalize "$BACKUP"
UPDATE_APPLIED=0
say "升级完成（备份：$BACKUP）"
