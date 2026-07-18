#!/usr/bin/env python3
"""
Patch mcp-cache.json: prepend `[PREFERRED — replaces X for Y]` tags to descriptions
of serena_*, codebase_memory_*, graphify_* tools.

LLM reads tool descriptions at every tool-selection decision. A `[PREFERRED over grep]`
prefix raises the description's salience vs `grep`'s default description.

Persistence: this survives until cache regenerates (configHash change or 7-day TTL).
For permanent fix, write a pi extension that re-patches on session_start.
"""

import json
import sys
from pathlib import Path

CACHE = Path.home() / ".pi/agent/mcp-cache.json"

# Per-tool override tags. If a tool isn't here, fall back to server-level generic tag.
TOOL_TAGS = {
    "serena": {
        "find_symbol":             "PREFERRED over `grep -rn \"class Foo\"` for symbol-level queries",
        "get_symbols_overview":     "PREFERRED over `read` whole file then scroll for file structure",
        "find_referencing_symbols": "PREFERRED over `grep` + manual chase for who-calls/who-imports queries",
        "replace_symbol_body":      "PREFERRED over `edit` with full body — preserves indentation via LSP",
        "insert_after_symbol":      "PREFERRED over `edit` with manual line counting — insert at symbol boundary",
        "insert_before_symbol":     "PREFERRED over `edit` with manual line counting — insert before symbol",
        "read_file":                "PREFERRED over builtin `read` for sage-scope file reads (chunks for large files)",
        "search_for_pattern":       "ripgrep-style search within a file tree (use serena_find_symbol first for symbol queries)",
    },
    "codebase-memory-mcp": {
        "search_graph":       "PREFERRED over `grep -r` for finding symbols — qualified-name aware, no false positives",
        "search_code":        "PREFERRED over shell `grep` for full-text search in indexed code (faster)",
        "trace_path":         "PREFERRED over `grep` + `read` chain for multi-hop call-graph traversal",
        "detect_changes":     "PREFERRED over `bash git diff` for impact analysis — maps diff to affected symbols",
        "get_architecture":   "PREFERRED over `find` + read many files for project structure overview",
        "get_code_snippet":   "PREFERRED over `serena_read_file` for getting a function body by name (no path needed)",
        "query_graph":        "Cypher for complex multi-hop patterns — when search_graph isn't enough",
        "list_projects":      "list all indexed projects (required first step before any graph query)",
        "index_status":       "check if a project is indexed (returns 'no index' if not — run index_repository first)",
        "index_repository":   "build/rebuild the knowledge graph (one-time cost, then queries are <10ms)",
        "delete_project":     "remove a project + all its graph data (irreversible)",
        "manage_adr":         "CRUD Architecture Decision Records",
        "ingest_traces":      "ingest runtime traces to enrich the graph (validate HTTP_CALLS edges)",
        "get_graph_schema":   "introspect node labels and edge types before writing cypher",
    },
    "graphify": {
        "query_graph":     "PREFERRED over grep for cross-module concept search (embedding similarity — no grep equivalent)",
        "shortest_path":   "PREFERRED over grep for concept-graph traversal between two ideas (no grep equivalent)",
        "god_nodes":       "find most-imported / most-connected abstractions (entry points — no grep equivalent)",
        "get_community":   "find module/cluster boundaries via Leiden community detection (no grep equivalent)",
        "get_neighbors":   "find adjacency around a node (replaces manual grep + read chase for 'neighbors of X')",
        "get_node":        "get full details for a specific node by label or ID",
        "graph_stats":     "graph size + edge type counts (introspection — run before queries on large graphs)",
        "list_prs":        "list open PRs (graphify PR-triage feature)",
        "get_pr_impact":   "analyze blast radius of a PR via the graph",
        "triage_prs":      "auto-triage PRs using graph context",
    },
}

# Server-level fallback for tools not in the above map
SERVER_TAGS = {
    "serena":              "[PREFERRED over builtin tools for code navigation/editing — LSP-aware]",
    "codebase-memory-mcp": "[PREFERRED over `grep` + `read` chain for project-wide queries — pre-indexed graph]",
    "graphify":            "[PREFERRED over `grep` for cross-module concept search — embedding-based, no grep equivalent]",
}


def patch():
    cache = json.loads(CACHE.read_text())
    total_patched = 0

    for server_name, data in cache["servers"].items():
        if server_name not in TOOL_TAGS:
            continue
        for tool in data.get("tools", []):
            tool_name = tool.get("name", "")
            original_desc = tool.get("description", "")
            if not original_desc:
                continue

            # Skip if already patched (idempotency)
            if "[PREFERRED" in original_desc[:30]:
                continue

            # Pick per-tool or server-level tag
            tag = TOOL_TAGS[server_name].get(tool_name, SERVER_TAGS[server_name])

            # Prepend "[PREFERRED over X — Y]" tag. Strip surrounding brackets from tag.
            tag_clean = tag.strip("[]")
            # Avoid "PREFERRED — PREFERRED — ..." double-up when tag starts with "PREFERRED"
            if tag_clean.startswith("PREFERRED"):
                new_desc = f"[{tag_clean}]. {original_desc}"
            else:
                new_desc = f"[PREFERRED — {tag_clean}]. {original_desc}"

            tool["description"] = new_desc
            total_patched += 1

    CACHE.write_text(json.dumps(cache, indent=2, ensure_ascii=False))
    print(f"✅ Patched {total_patched} tool descriptions across 3 servers")
    print(f"   Backup: {CACHE}.bak")


if __name__ == "__main__":
    patch()