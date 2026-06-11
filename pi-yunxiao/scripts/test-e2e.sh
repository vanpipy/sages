#!/usr/bin/env bash
# ~/Project/sages/pi-yunxiao/scripts/test-e2e.sh
#
# Run E2E tests separately from unit tests.
# E2E tests require:
# - YUNXIAO_ACCESS_TOKEN (or ~/.config/yunxiao/credentials)
# - alibabacloud-devops-mcp-server running on port 3000
#
# Behavior:
# - If token not set, prints SKIP message and exits 0 (suitable for CI)
# - If MCP server not running, starts it (with nohup)
# - If server start fails, exits 1
# - Otherwise, runs all test/e2e/*.e2e.test.ts
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PKG_DIR"

MCP_PORT=3000
LOG_FILE="${YUNXIAO_MCP_LOG:-$HOME/.cache/yunxiao-mcp/server.log}"
mkdir -p "$(dirname "$LOG_FILE")"

# ──────────────────────────────────────────────
# 1. Token check
# ──────────────────────────────────────────────
TOKEN="${YUNXIAO_ACCESS_TOKEN:-}"
if [[ -z "$TOKEN" && -f "$HOME/.config/yunxiao/credentials" ]]; then
  TOKEN="$(cat "$HOME/.config/yunxiao/credentials" | tr -d '\n\r ')"
fi

if [[ -z "$TOKEN" ]]; then
  echo "════════════════════════════════════════════════════"
  echo "  E2E tests SKIPPED"
  echo "════════════════════════════════════════════════════"
  echo ""
  echo "  Reason: YUNXIAO_ACCESS_TOKEN not set and"
  echo "          ~/.config/yunxiao/credentials not found"
  echo ""
  echo "  To run E2E tests:"
  echo "    export YUNXIAO_ACCESS_TOKEN=pt-xxxxx"
  echo "    bash scripts/test-e2e.sh"
  echo ""
  exit 0
fi
echo "✅ Token found (${#TOKEN} chars)"
echo ""

# ──────────────────────────────────────────────
# 2. MCP server health
# ──────────────────────────────────────────────
is_server_up() {
  # Server returns 200 even on first call; any TCP-level success means it's up
  local code
  code=$(curl -s --max-time 2 -o /dev/null -w "%{http_code}" "http://localhost:${MCP_PORT}/mcp" \
    -X POST -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"e2e","version":"0.1.0"}}}') || code=000
  [[ "$code" =~ ^(200|400|415)$ ]]
}

if is_server_up; then
  echo "✅ MCP server already running on :${MCP_PORT}"
else
  echo "▶ Starting MCP server..."
  if ! command -v alibabacloud-devops-mcp-server &>/dev/null; then
    echo "❌ alibabacloud-devops-mcp-server not found. Run scripts/install-mcp-server.sh first."
    exit 1
  fi
  nohup alibabacloud-devops-mcp-server --streamable-http > "$LOG_FILE" 2>&1 &
  MCP_PID=$!
  echo "  PID: $MCP_PID, log: $LOG_FILE"

  for i in {1..30}; do
    if is_server_up; then
      echo "✅ Server ready (took ${i}×100ms)"
      break
    fi
    sleep 0.1
  done
  if ! is_server_up; then
    echo "❌ Server failed to start within 3s"
    tail -10 "$LOG_FILE"
    exit 1
  fi
fi
echo ""

# ──────────────────────────────────────────────
# 3. Run E2E tests
# ──────────────────────────────────────────────
echo "════════════════════════════════════════════════════"
echo "  Running E2E tests (test/e2e/*.e2e.test.ts)"
echo "════════════════════════════════════════════════════"
echo ""

set +e
YUNXIAO_ACCESS_TOKEN="$TOKEN" bun test test/e2e/*.e2e.test.ts
TEST_EXIT=$?
set -e

echo ""
if [[ $TEST_EXIT -eq 0 ]]; then
  echo "════════════════════════════════════════════════════"
  echo "  ✅ E2E TESTS PASSED"
  echo "════════════════════════════════════════════════════"
else
  echo "════════════════════════════════════════════════════"
  echo "  ❌ E2E TESTS FAILED (exit $TEST_EXIT)"
  echo "════════════════════════════════════════════════════"
fi

exit $TEST_EXIT
