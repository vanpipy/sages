#!/usr/bin/env bash
#
# ~/Project/sages/pi-yunxiao/scripts/install-mcp-server.sh
#
# 一次性安装云效 MCP server 到全局 npm（加速冷启动到 < 1s）
# 等价于: npm i -g alibabacloud-devops-mcp-server
set -euo pipefail

PKG="alibabacloud-devops-mcp-server"

echo "==> Installing $PKG globally..."

if ! command -v npm &>/dev/null; then
  echo "Error: npm not found. Install Node.js first."
  exit 1
fi

if command -v "$PKG" &>/dev/null; then
  echo "$PKG already installed at $(command -v $PKG)"
  npm list -g "$PKG" --depth=0 2>/dev/null || true
  exit 0
fi

npm install -g "$PKG"

echo ""
echo "Installed: $(command -v $PKG)"
echo ""
echo "Next: set YUNXIAO_ACCESS_TOKEN and restart pi"
