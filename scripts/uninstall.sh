#!/bin/sh
# MyBox 卸载脚本。
#
#   curl -fsSL https://raw.githubusercontent.com/asdzx07/mybox/main/scripts/uninstall.sh | sudo sh
#
# 默认只停服务、删程序，保留 data/（订阅、设置）。加 --purge 连数据一起删。
set -eu

ROOT=/opt/mybox
PURGE=0
[ "${1:-}" = "--purge" ] && PURGE=1

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 运行"

if [ -d /run/systemd/system ]; then
  say "停止服务"
  systemctl stop mybox-kernel 2>/dev/null || true
  systemctl stop mybox-panel 2>/dev/null || true
  systemctl disable mybox-kernel 2>/dev/null || true
  systemctl disable mybox-panel 2>/dev/null || true
  rm -f /etc/systemd/system/mybox-kernel.service /etc/systemd/system/mybox-panel.service
  systemctl daemon-reload
fi

say "还原 dnsmasq"
if [ -f "$ROOT/data/netstack-state.json" ]; then
  CONF=$(sed -n 's/.*"file": *"\([^"]*\)".*/\1/p' "$ROOT/data/netstack-state.json" | head -n 1)
  if [ -n "$CONF" ] && [ -f "$CONF" ]; then
    rm -f "$CONF"
    if [ -f /etc/openwrt_release ]; then
      /etc/init.d/dnsmasq restart 2>/dev/null || true
    else
      systemctl restart dnsmasq 2>/dev/null || true
    fi
    say "已删除 $CONF 并重启 dnsmasq"
  fi
fi

# 残留的 tun 网卡和 nft 表
ip link del mybox-tun 2>/dev/null || true
nft delete table inet mybox 2>/dev/null || true

if [ "$PURGE" = "1" ]; then
  say "删除 $ROOT（含数据）"
  rm -rf "$ROOT"
else
  say "保留数据目录，只删程序"
  for d in server panel system bin etc node_modules package.json package-lock.json; do
    rm -rf "$ROOT/$d"
  done
fi

say "卸载完成"
[ "$PURGE" = "0" ] && say "订阅与设置保留在 $ROOT/data，重新安装后可直接沿用"
