#!/usr/bin/env bash
# ClipWarp —— macOS LaunchAgent 本地部署（沿用 CloudClaude 模式）
#
#   ./scripts/deploy-launchd.sh
#
# 作用：把 ClipWarp 装成 launchd 常驻服务（开机自启、崩溃自拉起）。
# 数据与代码分离：代码留在仓库，数据/日志统一放 ~/.config/clipwarp（可用 CLIPWARP_HOME 覆盖），
# git pull / 重新构建都不会动到账号与 clips 数据。再次运行本脚本即"重新部署"（重建前端 + 重启，数据保留）。
#
# 可调环境变量：PORT(默认 2547)、HOST(默认 0.0.0.0)、CLIPWARP_HOME(默认 ~/.config/clipwarp)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="lol.jiangtao.clipwarp"
UID_NUM="$(id -u)"
DATA_ROOT="${CLIPWARP_HOME:-$HOME/.config/clipwarp}"
LOG_DIR="$DATA_ROOT/logs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-2547}"
HOSTBIND="${HOST:-0.0.0.0}"
# loopback：直连时忽略 X-Forwarded-For（防伪造 IP 绕过限速），反代在本机时信任其转发的真实 IP。
TRUST_PROXY_VAL="${TRUST_PROXY:-loopback}"
# 本地/LAN http 默认关；挂在 HTTPS 反代后设 COOKIE_SECURE=1 重新部署即可给会话 cookie 加 Secure。
COOKIE_SECURE_VAL="${COOKIE_SECURE:-0}"

echo "==> 仓库: $ROOT"
echo "==> 数据根: $DATA_ROOT"

# 1) 构建前端（每次部署都重装依赖 + 重建，确保升级后依赖与代码都是最新；web 还没初始化时跳过）
#    npm install 幂等：依赖无变化时很快，有变化时才真正下载——故不再用 node_modules 是否存在来短路。
if [ -f "$ROOT/web/package.json" ]; then
  echo "==> 安装前端依赖"; (cd "$ROOT/web" && npm install)
  echo "==> 构建前端"; (cd "$ROOT/web" && npm run build)
else
  echo "!! web/package.json 不存在，跳过前端构建（仅部署 API 服务）"
fi

# 2) 服务端依赖（同样每次都装，避免升级后依赖过期）
echo "==> 安装服务端依赖"; (cd "$ROOT/server" && npm install)

# 3) 数据 / 日志目录（仅属主可读写；服务端启动时也会自检 chmod 700）
mkdir -p "$DATA_ROOT/data" "$LOG_DIR"
chmod 700 "$DATA_ROOT" "$DATA_ROOT/data" 2>/dev/null || true

# 4) 解析 node 绝对路径（launchd 的 PATH 很精简，必须写死）
NODE_BIN="$(command -v node || true)"; [ -n "$NODE_BIN" ] || NODE_BIN="$HOME/.local/bin/node"
[ -x "$NODE_BIN" ] || { echo "找不到 node 可执行文件: $NODE_BIN" >&2; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"
PATH_VAL="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
echo "==> node: $NODE_BIN"

# 5) 生成 LaunchAgent plist
#    TRUST_PROXY=loopback：直连忽略 XFF（防伪造 IP 绕过限速），本机反代时信任其真实 IP。
#    COOKIE_SECURE 默认关：本地 http/LAN 直接可用；挂 HTTPS 反代后 COOKIE_SECURE=1 ./deploy 即可。
mkdir -p "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/server/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT/server</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
    <key>HOST</key><string>$HOSTBIND</string>
    <key>CLIPWARP_HOME</key><string>$DATA_ROOT</string>
    <key>TRUST_PROXY</key><string>$TRUST_PROXY_VAL</string>
    <key>COOKIE_SECURE</key><string>$COOKIE_SECURE_VAL</string>
    <key>HOME</key><string>$HOME</string>
    <key>PATH</key><string>$PATH_VAL</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>$LOG_DIR/stdout.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/stderr.log</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF
echo "==> 已写入 $PLIST"

# 6) (重新)加载并重启
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
# 旧实例释放监听 socket 需要时间；bootstrap 抢跑会报 "5: Input/output error"。
# 带退避重试，单次 1s 往往不够（实测旧进程偶尔要 2~3s 才完全释放）。
bootstrap_ok=0
for attempt in 1 2 3 4 5; do
  sleep "$attempt" # 退避：1s,2s,3s...
  if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
    bootstrap_ok=1
    break
  fi
  echo "==> bootstrap 第 $attempt 次未成功（旧实例 socket 仍在释放），重试…"
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
done
if [ "$bootstrap_ok" -ne 1 ]; then
  echo "!! bootstrap 多次失败，请稍后手动重试: launchctl bootstrap gui/$UID_NUM $PLIST" >&2
fi
launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true

# 7) 健康检查（绑定到具体网卡时不能 curl 127.0.0.1，否则会误报失败）
sleep 2
case "$HOSTBIND" in
  0.0.0.0|""|::) HEALTH_HOST="127.0.0.1" ;;
  *) HEALTH_HOST="$HOSTBIND" ;;
esac
if curl -fsS "http://$HEALTH_HOST:$PORT/api/health" >/dev/null 2>&1; then
  echo "==> ✅ 已部署并在线：http://localhost:$PORT  (LAN: http://$(ipconfig getifaddr en0 2>/dev/null || echo '<本机IP>'):$PORT)"
  echo "    日志: $LOG_DIR/stdout.log  |  停止/卸载: ./scripts/undeploy-launchd.sh"
  if [ -f "$DATA_ROOT/initial-admin-password.txt" ]; then
    echo "    初始 admin 密码: $DATA_ROOT/initial-admin-password.txt"
  fi
else
  echo "!! 健康检查未通过，请查看日志: $LOG_DIR/stderr.log" >&2
  tail -n 20 "$LOG_DIR/stderr.log" 2>/dev/null || true
  exit 1
fi
