#!/usr/bin/env bash
# pi-graphify start-mcp.sh
#
# Wrapper for the graphify MCP server. Runs BEFORE the server starts:
#   1. Checks if graphify-out/graph.json exists in the workspace
#   2. If not, runs `graphify . --no-viz` to build it (~3-5 min)
#   3. Then launches the graphify MCP server with uv run
#
# This achieves lazy auto-build: the first time the LLM (or user) tries
# to call an `mcp_graph_*` tool, the graph gets built transparently.
#
# Required: PI_GRAPHIFY_AUTO_BUILD must NOT be set to "0" or "false" to disable.
# (Default behavior is to build if missing — set PI_GRAPHIFY_AUTO_BUILD=skip
#  to skip even on missing graph, useful for offline / quick MCP start)
#
# Usage from mcp.json:
#   {
#     "command": "bash",
#     "args": ["<path>/start-mcp.sh", "<workspace_folder>"]
#   }

set -euo pipefail

WORKSPACE="${1:-$(pwd)}"
GRAPH_JSON="$WORKSPACE/graphify-out/graph.json"
SKIP_BUILD_VAR="${PI_GRAPHIFY_AUTO_BUILD:-}"

# Respect explicit opt-out
if [[ "$SKIP_BUILD_VAR" == "0" || "$SKIP_BUILD_VAR" == "false" || "$SKIP_BUILD_VAR" == "skip" ]]; then
  echo "[start-mcp.sh] PI_GRAPHIFY_AUTO_BUILD=$SKIP_BUILD_VAR, skipping build check" >&2
else
  # Build if missing
  if [[ ! -f "$GRAPH_JSON" ]]; then
    echo "[start-mcp.sh] graphify-out/graph.json NOT FOUND in $WORKSPACE" >&2
    echo "[start-mcp.sh] auto-running: graphify . --no-viz (this takes ~3-5 min on first build)" >&2
    cd "$WORKSPACE"
    graphify . --no-viz
  else
    echo "[start-mcp.sh] graph already built at $GRAPH_JSON" >&2
  fi
fi

# Hand off to the actual MCP server (uv run graphify.serve)
exec uv run --with graphifyy --with mcp -m graphify.serve "$GRAPH_JSON"