#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="wechat-codex-bridge"
UNIT_SRC="$PROJECT_DIR/deploy/$SERVICE_NAME.service"
UNIT_DEST="/etc/systemd/system/$SERVICE_NAME.service"

mkdir -p "$PROJECT_DIR/logs"

if [ "$(id -u)" -ne 0 ]; then
  echo "请使用 root 或 sudo 安装系统服务："
  echo "  sudo bash $0"
  exit 1
fi

if [ ! -f "$UNIT_SRC" ]; then
  echo "找不到服务文件：$UNIT_SRC"
  exit 1
fi

cp "$UNIT_SRC" "$UNIT_DEST"
chmod 0644 "$UNIT_DEST"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl status "$SERVICE_NAME" --no-pager
