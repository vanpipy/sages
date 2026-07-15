# pi-codebase-memory

[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) integration for [pi](https://github.com/badlogic/pi-mono/), shipped as a peer extension of [sages](https://github.com/vanpipy/sages).

> ⚠️ **v0.1.0**: full graph-based code intelligence via MCP. 14 first-class tools + proxy. Built on tree-sitter AST, 158 languages supported. Linux kernel (28M LOC) indexed in 3 minutes; queries < 1ms.

## What is this?

`pi-codebase-memory` is a thin local pi extension that:

1. Registers a curated `.mcp.json` template for `codebase-memory-mcp`
2. Promotes **14 MCP tools to first-class pi tools** (no need to `mcp({search: "..."})` first)
3. Ships `skills/codebase-memory-mcp/SKILL.md` so the LLM knows which tool to pick for which task
4. Adds lifecycle hooks (`session_start`) to surface binary + index status in sage workspaces

It does **not**:
- Re-implement codebase indexing (uses upstream binary, ~50MB)
- Run its own graph database (delegates to upstream's SQLite)
- Modify your source code (graph queries are read-only)

The `mcp` proxy tool comes from [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter), which is a separate global peer extension.

## Install

`pi-codebase-memory` is shipped alongside `sages` and installed by `pi/scripts/install.sh`:

```bash
./pi/scripts/install.sh   # installs sages + pi-memory + pi-codebase-memory + pi-mcp-adapter + pi-serena + pi-codebase-memory-mcp-binary
```

The install will:

1. **Copy** `pi-codebase-memory/` to `~/.pi/packages/pi-codebase-memory/`
2. **Register** via `pi install file:$HOME/.pi/packages/pi-codebase-memory`
3. **Download** `codebase-memory-mcp` binary to `~/.local/bin/` (≈50MB)
4. **Write** `~/.pi/agent/mcp.json` from `templates/mcp.json` (only if absent)

After install, restart pi. You should see 14 new tools starting with `mcp_`.

## What gets registered

### First-class tools (14)

All promoted directly so LLM sees them in system prompt:

| Tool | Purpose |
|------|---------|
| `mcp_list_projects` | List all indexed projects with counts |
| `mcp_index_status` | Check indexing status |
| `mcp_index_repository` | Build/rebuild the index |
| `mcp_delete_project` | Remove project + all graph data |
| `mcp_search_graph` | Structured symbol search (label/name/pattern/degree) |
| `mcp_search_code` | Full-text search within index |
| `mcp_trace_path` | **Call graph BFS traversal** — sage workflow's most-used |
| `mcp_detect_changes` | **git diff → affected symbols + blast radius** |
| `mcp_query_graph` | Cypher-like graph queries |
| `mcp_get_graph_schema` | Graph introspection |
| `mcp_get_code_snippet` | Read function body by qualified name |
| `mcp_get_architecture` | Codebase overview (packages/hotspots/ADRs) |
| `mcp_manage_adr` | CRUD Architecture Decision Records |
| `mcp_ingest_traces` | Runtime traces → validate HTTP_CALLS edges |

### Proxy tool (1)

| Tool | Purpose |
|------|---------|
| `mcp` | Universal gateway to MCP servers (when needed for non-first-class patterns) |

## Why a separate package?

- **Isolated versioning**: codebase-memory-mcp upgrades don't touch sages core
- **Optional install**: users who don't want the binary can skip
- **Match peer-extension pattern**: like pi-serena, pi-yunxiao, pi-memory
- **Lifecycle hooks scoped to this concern**: not bloated into sages core

## Integration with four sages

| Sage stage | Recommended codebase-memory-mcp usage |
|------------|---------------------------------------|
| **Fuxi (design)** | `mcp_get_architecture()` — auto codebase overview, no manual survey |
| **QiaoChui (decompose)** | `mcp_detect_changes({base: "main"})` — know task impact up front |
| **LuBan (execute)** | `mcp_trace_path({direction: "callers", depth: 2})` — see downstream before edit |
| **GaoYao (audit)** | `mcp_detect_changes` + `mcp_query_graph` — verify commit safety |

## Security constraints

| Constraint | Reason |
|------------|--------|
| `excludeTools: []` (empty) | Upstream is sandboxed graph-only — **no shell exec** |
| Tools can't modify source | Graph queries are read-only; only `index_*` / `manage_adr` write to `.pi-codebase.json` |
| `requestTimeoutMs: 120000` | First `index_repository` on big repo may take minutes |
| `outputGuard: 100KB / 3000 lines` | `get_architecture` on huge repos can be verbose |

## Project layout

```
pi-codebase-memory/
├── package.json              # pi extension + skills manifest
├── tsconfig.json
├── README.md
├── src/
│   └── index.ts              # extension entry + lifecycle hooks
├── skills/
│   └── codebase-memory-mcp/
│       └── SKILL.md          # LLM-facing skill (auto-injected)
└── templates/
    └── mcp.json              # sage-curated codebase-memory-mcp config
```

## First-session initialization

When entering a workspace for the first time:

1. **Detect**: `mcp_index_status({project: "."})` → "no index" if not yet built
2. **Build**: `mcp_index_repository({project: "."})` → big repo ~3min, small repo ~seconds
3. **Use**: now `mcp_trace_path`, `mcp_search_graph`, etc. work

The package's `session_start` lifecycle hook emits a warning notification when entering a sage workspace without an index.

## Testing

```bash
cd pi-codebase-memory
bun install
bun run typecheck
```

End-to-end smoke test (after install):

```bash
mcp_list_projects                    # should show current project after indexing
mcp_index_status({ project: "." })    # check index status
mcp_trace_path({ name: "main", direction: "callers" })   # try a trace
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `mcp_*` tool not in tool list | `pi-mcp-adapter` not installed | `pi install npm:pi-mcp-adapter` |
| `codebase-memory-mcp: command not found` | Binary not installed | `./pi/scripts/install.sh --force` |
| `command not found` but binary exists | `~/.local/bin` not in PATH | `export PATH="$HOME/.local/bin:$PATH"` |
| `mcp_index_repository` times out | Large repo first scan | Wait; check `mcp_index_status` |
| `mcp_*` returns empty | Project not indexed | `mcp_index_repository({project: "."})` |

## License

MIT