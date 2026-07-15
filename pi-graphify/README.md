# pi-graphify

[Graphify](https://github.com/safishamsi/graphify) MCP integration for [pi](https://github.com/badlogic/pi-mono/), shipped as a peer extension of [sages](https://github.com/vanpipy/sages).

> ⚠️ **v0.2.1**: Knowledge graph queries via MCP. 7 first-class tools (query/path/explain/god_nodes/etc.) + proxy. Handles mixed corpus (code + docs + papers + videos + images) — **complement** to codebase-memory-mcp, not replace it.

## What is this?

`pi-graphify` is a thin local pi extension that:

1. Registers a curated `.mcp.json` template for `graphify --mcp`
2. Promotes **7 read-only graph tools** to first-class pi tools
3. Ships `skills/graphify-mcp/SKILL.md` so the LLM knows which `mcp_graph_*` to pick (does NOT collide with user-level `graphify`)
4. Adds lifecycle hooks (`session_start`) to surface binary + graph state in sage workspaces

It does **not**:
- Re-implement the graphify algorithm
- Build graphs in the foreground (that's `bash({command: "graphify ."})` — batch, 5-10 min)
- Modify your codebase

The `mcp` proxy tool comes from [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter), which is a separate global peer extension.

## Install

`pi-graphify` is shipped alongside `sages` and installed by `pi/scripts/install.sh`:

```bash
./pi/scripts/install.sh   # installs sages + pi-memory + pi-codebase-memory + pi-mcp-adapter + pi-serena + pi-codebase-memory-mcp-binary + pi-graphify
```

The install will:

1. **Copy** `pi-graphify/` to `~/.pi/packages/pi-graphify/`
2. **Register** via `pi install file:$HOME/.pi/packages/pi-graphify`
3. **Install** `graphify` CLI with `[mcp]` extra via `uv tool install "graphifyy[mcp]"`
4. **Write** `graphify` entry to `~/.pi/agent/mcp.json` (only if absent)

After install, restart pi. You should see 7 new tools starting with `mcp_graph_`.

## What gets registered

### First-class tools (7)

| Tool | Purpose |
|------|---------|
| `mcp_graph_query` | Natural-language question → graph answer |
| `mcp_graph_shortest_path` | Path between two nodes |
| `mcp_graph_get_node` | Node details |
| `mcp_graph_get_neighbors` | Neighbors + relationships |
| `mcp_graph_get_community` | Node's community |
| `mcp_graph_god_nodes` | High-centrality hubs |
| `mcp_graph_graph_stats` | Graph statistics |

### Proxy tool (1)

| Tool | Purpose |
|------|---------|
| `mcp` | Universal gateway (for `list_prs`, `triage_prs`, `get_pr_impact`, etc.) |

## Build vs Query

**Two-phase workflow**:

1. **Build (BATCH, via bash)**: `graphify .` — scans the entire corpus, produces `graphify-out/`. Takes 5-10 min.
2. **Query (REAL-TIME, via MCP)**: `mcp_graph_query(...)` — fast (ms). Lazy-launched.

The package's `session_start` hook emits:
- **info** if `graphify-out/graph.json` exists (graph ready, MCP tools work)
- **warning** if not (need to build first via `bash({command: "graphify ."})`)

## Integration with four sages

| Sage stage | Recommended graphify usage |
|------------|---------------------------|
| **Fuxi (design)** | `mcp_graph_query` to explore design space; `mcp_graph_god_nodes` to find key modules |
| **QiaoChui (decompose)** | `mcp_graph_query` to understand task context; `mcp_graph_shortest_path` for dependency chains |
| **LuBan (execute)** | `mcp_graph_get_neighbors` to find callers before edit |
| **GaoYao (audit)** | `mcp_graph_query` to verify change implications |

## Security constraints

| Constraint | Reason |
|------------|--------|
| `excludeTools: []` (empty) | graphify MCP tools are read-only graph queries |
| `outputGuard: 50KB / 2000 lines` | `graph_stats` on huge graphs can be verbose |
| `idleTimeout: 10 min` | Graphify MCP server idle-disconnects, saves resources |
| `lazy` startup | First call has ~1s cold start, doesn't block session startup |

## Project layout

```
pi-graphify/
├── package.json              # pi extension + skills manifest
├── tsconfig.json
├── README.md
├── src/
│   └── index.ts              # extension entry + lifecycle hooks
├── skills/
│   └── graphify-mcp/
│       └── SKILL.md          # LLM-facing skill (name: graphify-mcp, NO collision with user-level `graphify`)
└── templates/
    └── mcp.json              # graphify MCP server config (7 first-class tools)
```

## First-time setup

For a new workspace:

1. **Install graphify with [mcp] extra**: `uv tool install "graphifyy[mcp]"` (or via sage install.sh)
2. **Build the graph** (BATCH): `bash({command: "graphify ."})` — 5-10 min
3. **Query via MCP**: `mcp_graph_query(...)` — ms response

The `session_start` hook walks you through these steps.

## Testing

```bash
cd pi-graphify
bun install
bun run typecheck
```

End-to-end smoke test (after install):

```bash
# After graphify . is run
mcp_graph_graph_stats          # shows node/edge counts
mcp_graph_query({ question: "How does auth work?" })
mcp_graph_god_nodes({ limit: 5 })
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `mcp_graph_*` tool not in tool list | graphify CLI missing `[mcp]` extra | `uv tool install --reinstall "graphifyy[mcp]"` |
| `graphify: command not found` | uv tool didn't install graphify | `uv tool install "graphifyy[mcp]"` |
| `mcp_graph_query` returns "no graph" | `graphify-out/` not built | `bash({command: "graphify ."})` |
| `mcp_graph_query` slow (> 1s) | Very large graph (>10k nodes) | Reduce corpus scope |
| First `mcp_graph_*` call has 1-2s delay | Cold start (lazy) | Normal, subsequent calls are fast |

## License

MIT