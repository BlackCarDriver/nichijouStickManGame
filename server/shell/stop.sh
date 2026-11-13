#!/usr/bin/env bash
# 停止由 run.sh 启动的游戏服务
set -euo pipefail
cd "$(dirname "$0")/.."

PID_FILE="shell/stickman.pid"
if [[ ! -f "${PID_FILE}" ]]; then
  echo "[stop] 没有 pid 文件，服务可能未启动"
  exit 0
fi
PID="$(cat "${PID_FILE}")"
if kill -0 "${PID}" 2>/dev/null; then
  kill "${PID}"
  for _ in $(seq 1 20); do
    kill -0 "${PID}" 2>/dev/null || break
    sleep 0.2
  done
  kill -9 "${PID}" 2>/dev/null || true
  echo "[stop] 已停止 pid ${PID}"
else
  echo "[stop] 进程 ${PID} 不存在"
fi
rm -f "${PID_FILE}"
