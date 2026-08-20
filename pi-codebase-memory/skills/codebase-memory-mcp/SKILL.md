---
description: codebase-memory-mcp integration for pi - full graph-based code intelligence (14 first-class tools + proxy)
---

# pi-codebase-memory - Knowledge Graph Code Intelligence

> Expose the 14 MCP tools of [codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp) as first-class pi tools with a proxy fallback. Built on tree-sitter ASTs, 158 languages, **Linux kernel (28M LOC) indexed in 3 minutes, queries < 1ms**.

## Workflow decision

```
User inputs natural language
  ↓
LLM reads SKILL.md
  ↓
┌─ "who calls X / callers of X / call chain"     → mcp_trace_path
├─ "what breaks if I change this function / git diff impact"    → mcp_detect_changes
├─ "what does the codebase look like / overall architecture / packages"          → mcp_get_architecture
├─ "read source by function name / get function body"            → mcp_get_code_snippet
├─ "find symbol / search symbol / find function"        → mcp_search_graph
├─ "how to query the graph / cypher / schema"         → mcp_query_graph / mcp_get_graph_schema
├─ "scan the whole project / grep-like / search code"          → mcp_search_code
├─ "is it indexed / index status / rebuild index"          → mcp_index_status / mcp_index_repository
└─ everything else (manage_adr, list_projects, delete_project, ingest_traces)
                                               → mcp({ tool: "..." })
```

## 14 first-class tools quick reference

> The LLM can pick directly from the system prompt without needing `mcp({search: "..."})` first.

### 🔍 Indexing

| Tool | Purpose | Typical call |
|------|------|---------|
| `mcp_list_projects` | List all indexed projects + node/edge counts | `mcp_list_projects()` |
| `mcp_index_status` | Check a project's index status | `mcp_index_status({ project: "." })` |
| `mcp_index_repository` | Create/rebuild an index (slow on first run; large repos may take minutes) | `mcp_index_repository({ project: "." })` |
| `mcp_delete_project` | Delete a project + all graph data | `mcp_delete_project({ project: "." })` |

### 🔎 Querying (high frequency in sage workflows)

| Tool | Purpose | Typical call |
|------|------|---------|
| `mcp_search_graph` | Structured search (label/name/pattern/degree + pagination) | `mcp_search_graph({ label: "Function", name_pattern: "execute.*", limit: 20 })` |
| `mcp_trace_path` | **Call-graph BFS traversal** — most used in sage | `mcp_trace_path({ name: "executeTask", direction: "callers", depth: 3 })` |
| `mcp_detect_changes` | **git diff → affected symbols + blast radius** | `mcp_detect_changes({ base: "main" })` |
| `mcp_get_code_snippet` | Get a function's full source by qualified name | `mcp_get_code_snippet({ name: "executeTask" })` |
| `mcp_get_architecture` | Codebase overview (languages/packages/routes/hotspots/clusters/ADRs) | `mcp_get_architecture()` |
| `mcp_query_graph` | Cypher-like graph queries (read-only) | `mcp_query_graph({ query: "MATCH (f:Function)-[:CALLS]->(g:Function) WHERE f.name='executeTask' RETURN g LIMIT 10" })` |
| `mcp_get_graph_schema` | Node/edge types + property definitions | `mcp_get_graph_schema()` |
| `mcp_search_code` | Full-text search within the index (faster than grep) | `mcp_search_code({ query: "TODO", regex: true })` |

### 📝 Advanced (rarely used, but there when needed)

| Tool | Purpose | Typical call |
|------|------|---------|
| `mcp_manage_adr` | CRUD Architecture Decision Records | `mcp_manage_adr({ action: "create", title: "...", content: "..." })` |
| `mcp_ingest_traces` | Ingest runtime traces into the graph (validates HTTP_CALLS edges) | `mcp_ingest_traces({ project: ".", trace_file: "..." })` |

## `mcp` proxy tool

Non-first-class edge cases go through the proxy:

```js
mcp({ search: "codebase" })                              // list all 14 first-class tool names
mcp({ describe: "mcp_trace_path" })                       // inspect the parameter schema
mcp({ tool: "mcp_index_repository", args: '{"project":"."}' })  // invoke a specific tool
```

## ⚠️ When to use serena vs codebase-memory-mcp

| Scenario | Use | Why |
|------|-----|------|
| **Quickly find a function body** (< 100 file project) | **codebase-memory-mcp** (`mcp_get_code_snippet`) | < 1ms after indexing |
| **Quickly edit a function body** | **pi-serena** (`mcp_replace_symbol_body`) | LSP maintains indentation |
| **Find callers in a large project** (> 1k files) | **codebase-memory-mcp** (`mcp_trace_path`) | graph traversal vs grep |
| **See impact after changing code** | **codebase-memory-mcp** (`mcp_detect_changes`) | git diff → automatic blast radius |
| **Precise edits (keep syntax correct)** | **pi-serena** (`mcp_replace_symbol_body`) | AST-aware edits |
| **Architecture understanding / cross-package analysis** | **codebase-memory-mcp** (`mcp_get_architecture`) | cross-package overview |
| **LSP semantics (types/inheritance)** | **pi-serena** (`mcp_find_symbol`) | real LSP, not regex |

## Working with orchestrator workflows

| Orchestrator stage | Recommended codebase-memory-mcp usage |
|----------|----------------------------------|
| **Goal (1. goal_contract_create)** | `mcp_get_architecture()` — get the codebase overview automatically, skip manual research |
| **DAG (2. dag_synthesize)** | `mcp_detect_changes({base: "main"})` — know the task's blast radius up front |
| **Dispatch (3. task_dispatch)** | `mcp_trace_path({direction: "callers", depth: 2})` — see downstream before changing |
| **Audit (4. orchestrator_audit)** | `mcp_detect_changes` + `mcp_query_graph` — verify the commit is safe |

## First use (first-session initialization)

When entering a new workspace:

1. **Detect**: `mcp_index_status({project: "."})` → a "no index" result means you need to build one
2. **Build the index**: `mcp_index_repository({project: "."})` → large repos take ~minutes, small repos seconds
3. **Start using**: `mcp_search_graph`, `mcp_trace_path`, ...

> Note: upstream `codebase-memory-mcp` is a standalone process (C + thin Go wrapper); the first mcp call triggers process startup (~1s cold start).

## Safety constraints

| Constraint | Reason |
|------|------|
| `excludeTools: []` (empty) | upstream is pure graph operations — no shell exec / no file writes (except `index_*` / `manage_adr`) |
| Tool calls sandboxed | codebase-memory-mcp only reads the graph; **cannot modify your code** |
| Write operations require explicit calls | `index_repository` / `delete_project` / `manage_adr` are standalone tools; nothing triggers them accidentally |

## Troubleshooting

| Symptom | Cause | Fix |
|------|------|------|
| `mcp_*` tool not found | `pi-mcp-adapter` not installed | `pi install npm:pi-mcp-adapter` |
| `codebase-memory-mcp: command not found` | binary not installed | `./pi/scripts/install.sh --force` |
| `mcp_index_repository` times out (>2 min) | first scan of a large project | wait; check status with `mcp_index_status` |
| `mcp_*` returns empty results | project not indexed | `mcp_index_repository({project: "."})` |
| `command not found` with binary in PATH | binary installed to `~/.local/bin/` but PATH doesn't include it | `export PATH="$HOME/.local/bin:$PATH"` |

## More info

- upstream: https://github.com/DeusData/codebase-memory-mcp
- paper: [Codebase-Memory: Tree-Sitter-Based Knowledge Graphs for LLM Code Exploration via MCP](https://arxiv.org/abs/2603.27277)
- pi-mcp-adapter: https://github.com/nicobailon/pi-mcp-adapter
