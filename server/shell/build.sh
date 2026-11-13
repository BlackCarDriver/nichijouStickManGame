#!/usr/bin/env bash
# 构建游戏服务二进制（默认 Linux amd64；本机调试可用 TARGET_OS/TARGET_ARCH 覆盖）
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET_OS="${TARGET_OS:-linux}"
TARGET_ARCH="${TARGET_ARCH:-amd64}"
OUT="${OUT:-stickman-server}"

echo "[build] GOOS=${TARGET_OS} GOARCH=${TARGET_ARCH} → server/${OUT}"
CGO_ENABLED=0 GOOS="${TARGET_OS}" GOARCH="${TARGET_ARCH}" \
  go build -trimpath -ldflags "-s -w" -o "${OUT}" .
echo "[build] done: $(ls -lh "${OUT}" | awk '{print $5}')"
