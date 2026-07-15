#!/usr/bin/env bash
# pi-graphify start-mcp.sh
#
# Wrapper for the graphify MCP server. Runs BEFORE the server starts:
#   1. Auto-detects the sage workspace root via git toplevel + .sages/workspace marker
#   2. If graphify-out/graph.json is missing there, runs `graphify . --no-viz` (~3-5 min)
#   3. Launches the graphify MCP server with uv run
#
# Why git toplevel + .sages/workspace marker:
# - pi-mcp-adapter defaults MCP server cwd to pi session cwd (which can be a subdirectory)
# - Walking up to the NEAREST `.sages/workspace` would match pi/.sages/workspace (created
#   by LuBan tests during sage workflow), which is wrong
# - Using git toplevel finds the actual sage workspace root (sage workflow only runs in
#   git repos by convention)
#
# To disable auto-build: set PI_GRAPHIFY_AUTO_BUILD=skip in your shell.
#
# Usage from mcp.json:
#   {
#     "command": "bash",
#     "args": ["<path>/start-mcp.sh"]
#   }

set -euo pipefail

# ─── Step 1: find sage workspace root ────────────────────────────────────────
SAGE_ROOT=""

# Strategy 1: git toplevel + .sages/workspace marker
CWD="$(pwd)"
if command -v git >/dev/null 2>&1; then
  if GIT_TOP=$(git -C "$CWD" rev-parse --show-toplevel 2>/dev/null); then
    if [[ -d "$GIT_TOP/.sages/workspace" ]]; then
      SAGE_ROOT="$GIT_TOP"
    fi
  fi
fi

# Strategy 2: walk up to nearest .sages/workspace (fallback for non-git dirs)
if [[ -z "$SAGE_ROOT" ]]; then
  DIR="$CWD"
  while [[ "$DIR" != "/" ]]; do
    if [[ -d "$DIR/.sages/workspace" ]]; then
      SAGE_ROOT="$DIR"
      break
    fi
    DIR=$(dirname "$DIR")
  done
fi

# Fallback: not in a sage workspace. Use cwd as-is.
if [[ -z "$SAGE_ROOT" ]]; then
  SAGE_ROOT="$CWD"
fi

GRAPH_JSON="$SAGE_ROOT/graphify-out/graph.json"
SKIP_BUILD_VAR="${PI_GRAPHIFY_AUTO_BUILD:-}"

echo "[start-mcp.sh] sage_root=$SAGE_ROOT" >&2
echo "[start-mcp.sh] graph_json=$GRAPH_JSON" >&2

# ─── Step 2: lazy auto-build if missing ──────────────────────────────────────
if [[ "$SKIP_BUILD_VAR" == "0" || "$SKIP_BUILD_VAR" == "false" || "$SKIP_BUILD_VAR" == "skip" ]]; then
  echo "[start-mcp.sh] PI_GRAPHIFY_AUTO_BUILD=$SKIP_BUILD_VAR, skipping build check" >&2
elif [[ ! -f "$GRAPH_JSON" ]]; then
  echo "[start-mcp.sh] graphify-out/graph.json NOT FOUND in sage root" >&2
  echo "[start-mcp.sh] auto-running: graphify . --no-viz (this takes ~3-5 min on first build)" >&2
  cd "$SAGE_ROOT"
  graphify . --no-viz
  cd - >/dev/null 2>&1 || true
else
  echo "[start-mcp.sh] graph already built at $GRAPH_JSON" >&2
fi

# ─── Step 3: launch MCP server ───────────────────────────────────────────────
exec uv run --with graphifyy --with mcp -m graphify.serve "$GRAPH_JSON"