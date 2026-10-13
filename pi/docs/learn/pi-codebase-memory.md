# `pi-codebase-memory` — code-intelligence MCP bridge

> Source: `pi-codebase-memory/` (workspaces member; npm namespace
> `@sages/pi-codebase-memory`).
> File count: 1 source file (`src/index.ts`, 116 lines), plus
> `skills/codebase-memory-mcp/SKILL.md` and
> `templates/mcp.json`.

## Purpose

`pi-codebase-memory` is a thin local pi extension that integrates
[codebase-memory-mcp](https://github.com/DeusData/codebase-memory-mcp)
— a graph-based code-intelligence MCP server built on tree-sitter
(158 languages supported) — into the Sages runtime. The package
itself is intentionally small: it does not implement code indexing,
does not run a graph database, and does not modify source. Its job is
to:

1. Register a curated `templates/mcp.json` for `codebase-memory-mcp`
   (the Sages-curated allowlist of MCP tools).
2. Promote 14 MCP tools to first-class pi tools (no `mcp({...})`
   shim required at the call site).
3. Ship `skills/codebase-memory-mcp/SKILL.md` so the LLM knows which
   tool to pick for which task.
4. Wire `session_start` lifecycle hooks to surface binary presence
   and index status in Sages workspaces.

The `mcp` proxy tool itself comes from the upstream
[pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) peer
extension. The `codebase-memory-mcp` binary (~50 MB, ~3 min for the
Linux kernel index) is installed by
`pi-orchestrator/scripts/install.sh` into `~/.local/bin/`.

## Entry points

Per `pi-codebase-memory/package.json:27–34`:

```jsonc
"pi": {
  "extensions": [ "./src/index.ts" ],
  "skills":     [ "./skills" ]
}
```

The package's pi entry point is `src/index.ts`. It exports a default
function `piCodebaseMemory(pi)` (`pi-codebase-memory/src/index.ts:80`),
the only callable symbol in the package. There are no other module
exports; everything lives in the lifecycle hook bodies.

Files packaged for distribution (per `pi-codebase-memory/package.json:35–40`):
`src/`, `skills/`, `templates/`, `README.md`. Node engine
`>=20` (`:41–43`).

## Key symbols

The default export is the only runtime entry; the supporting helpers
are file-private.

1. **`piCodebaseMemory`** (default export) —
   `pi-codebase-memory/src/index.ts:80`. The pi extension factory.
   Registers two lifecycle hooks:
   - `session_start` (`pi-codebase-memory/src/index.ts:85`) — checks
     (a) Sages workspace (`isInSagesWorkspace`, `:31`), (b) binary
     presence (`binaryInstalled`, `:70`), (c) index existence
     (`codebaseIndexExists`, `:46`). Notifies accordingly:
     - Not a Sages workspace → no-op.
     - Binary missing → `"warning"` notification pointing the user
       at `./pi-orchestrator/scripts/install.sh --force`.
     - Binary present + index → `"info"` notification listing the
       first-class tool names.
     - Binary present + index missing → `"warning"` notification
       instructing the user to run `index_repository`.
   - `session_shutdown` (`pi-codebase-memory/src/index.ts:114`) —
     empty stub; reserved for future tmp-dir cleanup. The upstream
     server persists state to `~/.pi/memory/memory.db`, so there is
     nothing to flush.

2. **`isInSagesWorkspace(cwd)`** — `pi-codebase-memory/src/index.ts:31`.
   Returns `true` when `<cwd>/.pi/orchestrator` exists — the
   orchestrator's state directory, the marker that distinguishes a
   Sages install from a vanilla pi workspace. Cheap: one `existsSync`.

3. **`codebaseIndexExists(cwd)`** — `pi-codebase-memory/src/index.ts:46`.
   Shells out to `~/.local/bin/codebase-memory-mcp cli list_projects
   "{}"` (5 s timeout, stderr swallowed, stdout parsed as JSON). If
   any project in the response has `root_path === cwd`, the index
   exists. Any subprocess failure is swallowed and reported as
   not-indexed, so a broken binary cannot crash `session_start`.

4. **`binaryInstalled()`** — `pi-codebase-memory/src/index.ts:70`.
   Looks for the binary at:
   - `$HOME/.local/bin/codebase-memory-mcp` (primary install path)
   - `/usr/local/bin/codebase-memory-mcp`
   - `/usr/bin/codebase-memory-mcp`

5. **`templates/mcp.json`** — `pi-codebase-memory/templates/mcp.json`.
   The Sages-curated MCP config: promotes 14 tools to first-class
   pi tools and exposes the `mcp` proxy tool via `pi-mcp-adapter`.

6. **`skills/codebase-memory-mcp/SKILL.md`** — the LLM-facing skill
   file. Auto-injected by pi when the workspace detects the package.

## Dependencies

From `pi-codebase-memory/package.json`:

- **peerDependencies** (`:36–40`):
  `@earendil-works/pi-coding-agent *`,
  `@earendil-works/pi-ai *`,
  `@earendil-works/pi-tui *`.
- **dependencies**: `none`. The package is intentionally dependency-
  free at runtime — only `node:fs`, `node:os`, `node:path`,
  `node:child_process` from the standard library.
- **devDependencies** (`:42–45`):
  `@types/node ^20.10.0`, `typescript ^6.0.3`.

The `mcp` proxy tool is supplied by the peer extension
`pi-mcp-adapter` (also installed by `pi-orchestrator/scripts/install.sh`).
The `codebase-memory-mcp` binary itself is installed into
`~/.local/bin/` (or `/usr/local/bin` / `/usr/bin`) by the same script.

## Key flows

### First session in a Sages workspace

1. `pi` boots, loads the extension.
2. `session_start` fires → `piCodebaseMemory`'s `session_start` listener
   runs.
3. `isInSagesWorkspace(ctx.cwd)` → `true` because `.pi/orchestrator/`
   exists.
4. `binaryInstalled()` → `true` (the install.sh placed it at
   `~/.local/bin/codebase-memory-mcp`).
5. `codebaseIndexExists(ctx.cwd)` → calls
   `codebase-memory-mcp cli list_projects "{}"`.
6. If the project is in the response → the user sees an `info`
   notification: "Index found. Use `search_graph` / `trace_path` /
   `get_architecture`."
7. If the project is not in the response → the user sees a `warning`
   notification: "Index MISSING. Run `index_repository` (first time
   may take minutes)." The LLM is expected to follow up with
   `mcp_index_repository({ project: "." })`.

### Graph query at runtime

The 14 first-class tools (per `README.md:50–69` and
`templates/mcp.json`) are all wired to the MCP server through
`pi-mcp-adapter`'s `mcp` proxy:

1. LLM calls e.g. `mcp_trace_path({ name: "main", direction:
   "callers" })`.
2. `pi-mcp-adapter` proxies the call to the configured MCP server
   (`codebase-memory-mcp`).
3. `codebase-memory-mcp` walks the SQLite-backed graph (sub-millisecond
   per query) and returns the BFS path.
4. The pi host renders the result on the LLM's next request.

The curated first-class tools (no `mcp({...})` shim required):

- `mcp_list_projects`, `mcp_index_status`, `mcp_index_repository`,
  `mcp_delete_project`, `mcp_search_graph`, `mcp_search_code`,
  `mcp_trace_path`, `mcp_detect_changes`, `mcp_query_graph`,
  `mcp_get_graph_schema`, `mcp_get_code_snippet`,
  `mcp_get_architecture`, `mcp_manage_adr`, `mcp_ingest_traces`.

The `mcp` proxy tool is kept available for tool calls that need to
construct runtime params not enumerated as first-class.

### Security constraints

Per `README.md:81–86` and the `templates/mcp.json`:

- `excludeTools: []` — the upstream is sandboxed graph-only with no
  shell exec, so all tools are safe to expose.
- `requestTimeoutMs: 120000` — the first `index_repository` on a big
  repo may take minutes.
- `outputGuard: 100 KB / 3000 lines` — `get_architecture` on a
  huge repo can be verbose.

Graph queries are read-only except for `index_*` / `manage_adr`,
which write to `.pi-codebase.json` only.

## Verification

- `cd pi-codebase-memory && bun install && bun run typecheck` — TS
  check.
- End-to-end smoke test (after install):
  - `mcp_list_projects` — should show current project after indexing.
  - `mcp_index_status({ project: "." })` — index status check.
  - `mcp_trace_path({ name: "main", direction: "callers" })` — graph
    traversal test.

## Where to learn more

- [`pi-orchestrator.md`](./pi-orchestrator.md) — the orchestrator's
  `install.sh` is what actually installs this package and the
  `codebase-memory-mcp` binary.
- `pi-codebase-memory/README.md` — package README with the full
  table of first-class tools.
- `pi-codebase-memory/skills/codebase-memory-mcp/SKILL.md` — the
  LLM-facing skill.
- `pi-codebase-memory/templates/mcp.json` — the curated MCP config.