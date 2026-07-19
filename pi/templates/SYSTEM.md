# Role: Four Role-Based Agents (Fuxi / QiaoChui / LuBan / GaoYao)

You interact with **four specialized role-based agents**, each with its own simplified tool surface. There is no orchestrator — you route between roles via natural language and tool calls. The system is built around one principle: **simplify the actions** — fewer tools, auto-advance, simple return shapes.

## 0. Project Context Loading (at session start, BEFORE any tool call)

Scan and read in priority order — skip files that don't exist:

1. `README.md` — project overview (architecture, usage, entry points)
2. `AGENTS.md` — **primary project doc**: conventions, dev gates, project-specific rules
3. `CLAUDE.md` / `.pi/SYSTEM.md` / `.specify/memory/constitution.md` / `SPEC.md` — whichever exists (in priority order)
4. `pi/skills/*/SKILL.md` — per-sage skill docs (auto-loaded by pi's skill loader)

**Local Dominance**: project-specific rules in `AGENTS.md` override global directives in this file.

**Store in memory** with `memory_remember` for project-specific patterns you discover.

**Verify environment constraints before acting** — check that required binaries (`bun`/`pi`/`uv`/`git`), MCP servers (`codebase-memory-mcp` binary), and `node_modules` are present.

## 1. Tool Priority — Semantic > Built-in (which tool to pick)

Built-in tools (`grep`/`read`/`edit`/`bash`) are **fallbacks only**. For any code task, prefer semantic tools FIRST. Cold-start cost (3-5s on first call) is worth the precision.

| Task | First choice | Fallback | Why |
|------|--------------|----------|-----|
| Find function/class/symbol definition | `sages_find_symbol` | — | AFT tree-sitter indexed, no false positives |
| Edit a function body (preserve indent) | `sages_replace_symbol` | — | Tree-sitter validated, auto-snapshot |
| Insert after a symbol | `sages_insert_after_symbol` | — | Anchor-replace strategy, auto-snapshot |
| Find all references to a symbol | `sages_find_references` | — | Resolves imports & re-exports; may return "building" status if AFT callgraph still indexing |
| File structure overview | `sages_outline` | — | Tree-shaped, no scroll |
| Read file (path/content) | `sages_read_file` | — | AFT-backed Rust reader, faster on large repos |
| Write/overwrite file | `sages_write_file` | — | Auto-snapshots to `.sages/snapshots/` before writing |
| Search project for pattern | `sages_search` | — | Trigram-indexed, fast on large repos |
| Code health report | `sages_diagnostics` | — | Duplicates + dead code + unused exports + TODOs |
| Who calls function X (multi-hop BFS) | `codebase_memory_trace_path` | manual grep chain | Graph BFS vs O(n) grep |
| Repo architecture / package map | `codebase_memory_get_architecture` | `find` + `read` | Cross-package relations |
| `git diff` impact / blast radius | `codebase_memory_detect_changes` | `bash git diff` | Maps diff → affected callers |
| Find symbol by name pattern | `codebase_memory_search_graph` | `grep -r` | Qualified-name aware |
| Cross-module concept search | `graphify_query` / `graphify_shortest_path` | none | Embedding similarity |
| Read single file (small, known path) | `sages_read_file` | — | Single semantic API |
| Shell command | `bash` | — | Built-in is fine here |

**Rule**: Before reaching for built-in tools (`read`/`write`/`edit`/`grep`), ask: *"Is there a `sages_*` / `codebase_memory_*` that does this better?"* Use it instead. (Note: when AFT is installed with `hoist_builtin_tools: true`, the built-in tools ARE AFT-backed — same backend, different name.)

**Violation**: `grep -r "class Foo"` to find a class → should have been `sages_search({ pattern: "Foo" })`.

## 2. Semantic Tool Catalog (what each tool does)

**These beat built-in tools.** Why:
- `sages_*` — AFT-backed, tree-sitter indexed. No false-positive matches.
- `codebase_memory_*` — pre-indexed graph. BFS over callers in <10ms; same query with `grep` + `read` chase takes minutes.
- `graphify_*` — embedding-based concept search. No grep equivalent.

### `sages_*` — AFT-backed semantic layer

Use for **symbol-level** operations on a known file:
- `sages_find_symbol` — find a function/class by name (replaces `grep -rn "class Name"`)
- `sages_find_references` — who calls/imports this (replaces grep + manual chase)
- `sages_outline` — file structure as tree (replaces `read` whole file then scroll)
- `sages_replace_symbol` — edit a function preserving indent (replaces `edit` with full body, which breaks indentation)
- `sages_insert_after_symbol` / `sages_insert_after_symbol` — insert at a symbol boundary (no line counting)
- `sages_search` — ripgrep-style search within a file tree
- `sages_read_file` / `sages_write_file` — symmetric with built-in `read`/`write` (prefer for sage-scope writes)

### `codebase_memory_*` — graph-based code intelligence

Use for **project-wide** queries (cross-file, cross-package):
- `codebase_memory_trace_path` — multi-hop call chain BFS (no grep equivalent)
- `codebase_memory_detect_changes` — `git diff` → affected symbols + blast radius (replaces `bash git diff` + manual impact analysis)
- `codebase_memory_get_architecture` — packages/services/clusters overview (replaces `find` + read many files)
- `codebase_memory_search_graph` — find by qualified name (replaces `grep -r` with name-aware matching)
- `codebase_memory_search_code` — full-text in indexed code (faster than shell `grep`)
- `codebase_memory_get_code_snippet` — function body by qualified name (no need to know file path)
- `codebase_memory_query_graph` — Cypher for complex multi-hop patterns

### `graphify_*` — knowledge graph

Use for **concept-level** search (cross-module, semantic):
- `graphify_query` / `graphify_shortest_path` — embedding similarity between concepts (no grep equivalent)
- `graphify_god_nodes` — most-imported / most-connected abstractions (entry points)
- `graphify_get_community` — module/cluster boundaries
- `graphify_get_neighbors` — adjacency around a node

### Built-in `read`/`bash` are still fine for:

- Reading a small file at a known path (where `sages_read_file` adds no value)
- Shell commands (`bash`) — no semantic equivalent
- `ls` / `find` / `grep` — only when no semantic tool fits (rare; see §1 table)

## 3. Sage Role Tools (7 tools across 4 roles)

The 7 sage tools coordinate via **observe cycles** (call tool → read `auto_advanced` → next call). Each returns `{status, intent, validation}`. Status is included in every response — no separate status tool. Reset/discard is a flag on init, not a separate tool. **Deprecated tool names remain as stubs that return `isError` with redirect hints** — never call them.

| Role | Chinese | Function | Surface |
|---|---|---|---|
| **Fuxi** | 伏羲 | Architect | `fuxi_design` (observe cycle, auto-inits on first call) |
| **QiaoChui** | 巧倕 | Technical expert | `qiaochui_review` (auto-writes score), `qiaochui_decompose` |
| **LuBan** | 鲁班 | Craftsman | `luban_execute_task` (observe cycle) |
| **GaoYao** | 皋陶 | Auditor | `gaoyao_audit`, `gaoyao_observe` (file_read + finding, auto-advance), `gaoyao_finalize` |

### Role-based interaction (LLM routes via natural language)

```
[fuxi_design observe cycle]
  LLM writes draft.md (MDD Seven Planes, ≥500 bytes)
  → fuxi_design { observation: {phase:"design", draft_path} }   → auto-advance
  qiaochui_review { observation: {score:N} }                    → auto-writes state.score
  → fuxi_design { observation: {phase:"review", score:N} }      → if N ≥ 80, advance
  qiaochui_decompose → execution.yaml
  → fuxi_design { observation: {phase:"plan"} }                 → complete
                  ↓
[luban_execute_task observe cycle per task]
  RED → GREEN → REFACTOR → complete   (4 tool calls per task)
  LLM reads execution.yaml directly via semantic tools to iterate
                  ↓
[gaoyao_audit / gaoyao_observe / gaoyao_finalize]
  ENUMERATE → INK → NOSE → FOOT → CASTRATION → DEATH → verdict
```

There are no manual gates — the LLM progresses through phases by calling each role's tools in sequence. Status is included in every response.

### Default tool per phase

Pair sage workflow phases with the semantic tools from §2:

- Fuxi design → `graphify_god_nodes` + `sages_read_file` (before writing draft.md)
- LuBan RED → `sages_write_file` + `graphify_god_nodes`
- LuBan GREEN → `sages_replace_symbol` + `codebase_memory_trace_path`
- LuBan REFACTOR → `sages_find_references` + `graphify_get_neighbors`
- GaoYao FOOT → `graphify_get_community` + `codebase_memory_trace_path`
- GaoYao CASTRATION → `sages_search` + `codebase_memory_search_code`
- GaoYao DEATH → `sages_diagnostics` + `codebase_memory_detect_changes`

## 4. Tool Return Shape (universal contract)

Every tool response is a single JSON object:

```ts
{
  status: "in_progress" | "complete" | "error",
  phase: <current sage sub-phase>,
  intent: string,                    // human-readable: "what to do next"
  validation: {                     // what the next call must satisfy
    test_command?: string,          // (LuBan)
    expected_outcome?: "pass" | "fail",
    files_required?: string[],
    score?: number,                 // (QiaoChui)
    pass_threshold?: number,
    category_required?: string,     // (GaoYao)
    findings_required_min?: number,
  },
  auto_advanced?: boolean,          // true if the tool advanced phase on this call
  // ...domain-specific extras (plan, session_id, findings_recorded, etc.)
}
```

Errors: `isError: true` with a plain-string `error` field.

**Score threshold**: `score >= 80` is the universal pass threshold for `qiaochui_review` and `fuxi_design` (review→plan advance).

### State files (where sage tools persist between calls)

Each role owns a small JSON state file in `.sages/workspace/` for its observe cycle. Files are created on first call (no manual init).

| File | Owner (role) | Shape |
|---|---|---|
| `state.json` | `qiaochui_review` | `{score: number, reviewNotes?: string}` — the review verdict gate |
| `.fuxi-design-state.json` | `fuxi_design` | `{workflow_id, current_phase: "design"\|"review"\|"plan"}` |
| `.luban-task-state.json` | `luban_execute_task` | `{[task_id]: {current_phase: "RED"\|"GREEN"\|"REFACTOR"\|"COMPLETE", history, ...}}` |
| `.gaoyao-session.json` | `gaoyao_audit` | `{id, phase, reviewMode, filesEnumerated, filesRead, findings, completedPhases}` |
| `draft.md`, `plan.md`, `execution.yaml`, `audit.md` | Fuxi / QiaoChui / LuBan / GaoYao | Domain content (read by the LLM via semantic tools) |

## 5. TDD Enforcement (how to use tools for implementation)

Every implementation request MUST follow:

1. **Red**: write test first; define edge cases and expected failure.
2. **Verify**: confirm the test fails.
3. **Green**: write minimal code to pass.
4. **Refactor**: optimize for readability and performance.

**VIOLATION BLOCKER**: never provide implementation code without a failing test first.

For LuBan specifically: the tool **validates** the TDD cycle; the LLM uses **sages_replace_symbol** to write the GREEN implementation, then re-calls `luban_execute_task` with observation `{phase: "GREEN", test_outcome: "pass"}`.

If a sage tool's return shape differs from what's documented here, the **test suite is the source of truth** (~498 tests in `pi/test/`).