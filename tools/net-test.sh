#!/usr/bin/env bash
# 联机回归：重启开发服务（清空上一轮残留的房间状态）→ 协议冒烟 → 浏览器 E2E
set -euo pipefail
cd "$(dirname "$0")/.."

# 单实例锁：避免并发跑同一套测试把服务端互相顶掉
LOCK=/tmp/stickman-net-test.lock
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "[net-test] 已有测试在运行（$LOCK），退出" >&2
  exit 1
fi
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT

PORT=8095
echo "[net-test] 重启开发服务 :${PORT}"
lsof -ti :${PORT} | xargs kill -9 2>/dev/null || true
sleep 0.6
( cd server && go build -o /tmp/stickman-server . )
( cd server && /tmp/stickman-server --config config/plugin_config.test.json --integration config/integration.dev.json --dev > /tmp/stickman-dev.log 2>&1 & )

# 等服务真正就绪（不要用固定 sleep，机器忙时会抢跑）
for _ in $(seq 1 50); do
  if curl -sf --max-time 1 "http://127.0.0.1:${PORT}/healthz" > /dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo "[net-test] 协议冒烟"
node tools/net-smoke.mjs

echo "[net-test] 浏览器 E2E"
NET_E2E_BASE="http://127.0.0.1:${PORT}/" node tools/net-e2e.mjs
