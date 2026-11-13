#!/usr/bin/env bash
# 后台启动游戏服务：pid 写入 shell/stickman.pid，日志追加到 shell/stickman.log
set -euo pipefail
cd "$(dirname "$0")/.."

BIN="${BIN:-./stickman-server}"
PID_FILE="shell/stickman.pid"
LOG_FILE="shell/stickman.log"

if [[ ! -x "${BIN}" ]]; then
  echo "[run] 找不到可执行文件 ${BIN}，先执行 ./shell/build.sh" >&2
  exit 1
fi
if [[ -f "${PID_FILE}" ]] && kill -0 "$(cat "${PID_FILE}")" 2>/dev/null; then
  echo "[run] 已在运行 (pid $(cat "${PID_FILE}"))"
  exit 0
fi

nohup "${BIN}" "$@" >> "${LOG_FILE}" 2>&1 &
echo $! > "${PID_FILE}"
echo "[run] 已启动 pid $(cat "${PID_FILE}")，日志: ${LOG_FILE}"
