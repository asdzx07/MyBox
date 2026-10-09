#!/bin/sh
# 一键重置或清空 MyBox 面板密码
# 用法:
#   sh /opt/mybox/scripts/reset-password.sh <新密码>
#   sh /opt/mybox/scripts/reset-password.sh --clear
set -eu

ROOT=/opt/mybox
NODE="$ROOT/node/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node 2>/dev/null || true)"
[ -n "$NODE" ] || { echo "未找到 Node 运行时"; exit 1; }

NEW_PASS="${1:-}"
if [ -z "$NEW_PASS" ]; then
  printf '请输入要设置的新密码（或输入 --clear 清空）: '
  read -r NEW_PASS
fi

MYBOX_ROOT="$ROOT" "$NODE" "$ROOT/tools/reset-password.mjs" "$NEW_PASS"
