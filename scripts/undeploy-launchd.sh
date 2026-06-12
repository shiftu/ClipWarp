#!/usr/bin/env bash
# ClipWarp —— 卸载 launchd 服务（保留数据目录 ~/.config/clipwarp）。
#
#   ./scripts/undeploy-launchd.sh
set -euo pipefail

LABEL="lol.jiangtao.clipwarp"
UID_NUM="$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DATA_ROOT="${CLIPWARP_HOME:-$HOME/.config/clipwarp}"

if launchctl print "gui/$UID_NUM/$LABEL" >/dev/null 2>&1; then
  echo "==> 停止服务 $LABEL"
  launchctl bootout "gui/$UID_NUM/$LABEL"
else
  echo "==> 服务未在运行: $LABEL"
fi

if [ -f "$PLIST" ]; then
  rm -f "$PLIST"
  echo "==> 已删除 $PLIST"
fi

echo "==> ✅ 已卸载。数据保留在 $DATA_ROOT（如需彻底清除请手动删除）。"
