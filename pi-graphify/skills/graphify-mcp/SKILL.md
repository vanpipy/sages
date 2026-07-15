---
name: graphify-mcp
description: "Use graphify MCP tools (mcp_graph_query, mcp_graph_shortest_path, mcp_graph_god_nodes, etc.) when graphify-out/graph.json exists in cwd — for natural-language knowledge graph queries over a built corpus (code, docs, papers, images, videos). Complementary to the canonical `graphify` skill (which covers the CLI itself)."
---

# graphify-mcp

> **Two-phase workflow**:
> 1. **Build (BATCH, via bash)**: `graphify .` — produces `graphify-out/` in cwd
> 2. **Query (REAL-TIME, via MCP)**: `mcp_graph_*` tools below
>
> The canonical `graphify` skill covers **CLI usage**. This skill covers **MCP tool usage in pi**.

## When to use `mcp_graph_*` vs other tools

| You want to… | Use |
|---|---|
| Natural-language question about the codebase → answer with graph context | `mcp_graph_query` |
| Find shortest path between two symbols/concepts | `mcp_graph_shortest_path` |
| Get details on a specific node | `mcp_graph_get_node` |
| Explore neighbors of a node | `mcp_graph_get_neighbors` |
| Find a community around a node | `mcp_graph_get_community` |
| Discover the most central / important nodes (hubs) | `mcp_graph_god_nodes` |
| Get graph statistics (size, density, community count) | `mcp_graph_graph_stats` |

## Decision tree

```
Need information from the codebase?
├── Already have node labels / symbols in mind?
│   ├── YES → mcp_graph_get_node or mcp_graph_get_neighbors
│   └── NO  → Natural-language question?
│       ├── YES → mcp_graph_query  (semantic search over graph)
│       └── NO  → Want graph overview?
│           ├── YES → mcp_graph_graph_stats + mcp_graph_god_nodes
│           └── NO  → Two specific endpoints?
│               └── YES → mcp_graph_shortest_path
└──
```

## Tool reference

### `mcp_graph_query`
**Natural-language question → graph answer.**
```
mcp_graph_query({ question: "How does LuBan execute tasks in TDD mode?" })
```
Use when: open-ended questions, semantic understanding.

### `mcp_graph_shortest_path`
**Path from node A to node B.**
```
mcp_graph_shortest_path({ source: "LuBan", target: "TDD" })
```
Use when: tracing relationships, dependency chains.

### `mcp_graph_get_node`
**Node metadata (type, attributes, properties).**
```
mcp_graph_get_node({ label: "LuBan" })
```
Use when: you know the node but need details.

### `mcp_graph_get_neighbors`
**Direct neighbors of a node.**
```
mcp_graph_get_neighbors({ node: "LuBan", depth: 1 })
```
Use when: exploring relationships of a known entity.

### `mcp_graph_get_community`
**Community (cluster) containing the node.**
```
mcp_graph_get_community({ node: "LuBan" })
```
Use when: finding related concepts/modules.

### `mcp_graph_god_nodes`
**Top-N nodes by centrality.**
```
mcp_graph_god_nodes({ limit: 10 })
```
Use when: discovering key concepts / hubs without prior knowledge.

### `mcp_graph_graph_stats`
**Graph overview (node count, edge count, community count, density).**
```
mcp_graph_graph_stats({})
```
Use when: orientation, "what's in this graph?"

## How tools are wired

This package ships:

| Layer | Provided by |
|---|---|
| Graphify CLI binary | `uv tool install "graphifyy[mcp]"` |
| MCP server config | `templates/mcp.json` (auto-merged into `~/.pi/agent/mcp.json`) |
| Tool registration | `pi-mcp-adapter` (peer dep) |
| First-class tools | 7 above (`mcp_graph_*` prefix from `directTools`) |
| Proxy for long-tail | `mcp({ tool: "graphify_xxx", args: ... })` |

## Pre-flight checks (lifecycle hook)

The package's `src/index.ts` warns at session_start if:
- `~/.local/bin/graphify` is missing → run `uv tool install "graphifyy[mcp]"`
- `[mcp]` extra is missing → run `uv tool install --reinstall "graphifyy[mcp]"`
- `graphify-out/graph.json` is missing → run `graphify .` (5-10 min)

## Cold-start note

First MCP call has ~1s cold start (server spawns). Subsequent calls are fast.

## Not for

- Code editing → use `serena_replace_symbol_body` (pi-serena)
- AST graph queries / git impact → use `mcp_trace_path` / `mcp_detect_changes` (pi-codebase-memory)
- File search → use `grep` / `glob`
- Quick file read → use `read`