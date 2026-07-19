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

File operations (`read`/`write`/`edit`/`grep`/`bash`) are AFT-backed through `@cortexkit/aft-pi` (installed via `npx @cortexkit/aft@latest setup --harness pi`). Use them directly. For higher-level analysis prefer the semantic tools below.

| Task | First choice | Fallback | Why |
|------|--------------|----------|-----|
| Read file (path/content) | `read` | — | AFT-backed Rust reader, faster on large repos |
| Write/overwrite file | `write` | — | AFT atomic write + auto-format + backup |
| Edit (substring replace) | `edit` | — | AFT fuzzy-match, tolerates whitespace drift |
| Search project for pattern | `grep` | — | AFT trigram-indexed search |
| Shell command | `bash` | — | AFT subprocess runner |
| File structure overview | `aft_outline` | — | Tree-shaped, no scroll |
| Symbol-level inspection (with call-graph) | `aft_zoom` | — | Tree-sitter-validated, no false positives |
| Find all references to a symbol | `aft_callgraph` | — | Resolves imports & re-exports |
| Who calls function X (multi-hop BFS) | `codebase_memory_trace_path` | manual grep chain | Graph BFS vs O(n) grep |
| Repo architecture / package map | `codebase_memory_get_architecture` | `find` + `read` | Cross-package relations |
| `git diff` impact / blast radius | `codebase_memory_detect_changes` | `bash git diff` | Maps diff → affected callers |
| Find symbol by name pattern | `codebase_memory_search_graph` | `grep -r` | Qualified-name aware |
| Cross-module concept search | `graphify_query` / `graphify_shortest_path` | none | Embedding similarity |
| Code health report | `aft_inspect` | — | Duplicates + dead code + unused exports + TODOs |

**Rule**: Before reaching for shell `grep`/`find`/`cat`, ask: *"Is there an `aft_*` or `codebase_memory_*` that does this better?"* Use it instead.

## 1.5 Routing by question scale (decide THIS before picking a tool)

The tools cluster by **scope of reasoning**. Classify the question first — then reach for the matching tool family. Reaching for `aft_*` on a project-wide question is the most common mistake; reaching for `codebase_memory_*` on a single-file question is wasted overhead.

| Question scale | Examples | Primary tool family | Why this family |
|---|---|---|---|
| **Per-file / per-symbol** | "read this file", "find this function body", "edit line 42", "diagnostics on this file" | **AFT** (`aft_read`, `aft_zoom`, `aft_search`, `aft_outline`, `aft_inspect`, `aft_callgraph`, `aft_import`) | Indexed Rust reader, sub-second, no graph dependency |
| **Cross-file within one package** | "all callers of X across `pi/src/tools/luban/`", "what does this module export" | **AFT** (multi-file is still AFT's strength; use `aft_search` + `aft_zoom`) | AFT resolves imports/re-exports; faster than graph for ≤1 package |
| **Cross-package / project-wide** | "who calls X across all packages", "what does my git diff affect", "project architecture / module boundaries", "find by qualified name" | **codebase-memory-mcp** (`codebase_memory_trace_path`, `codebase_memory_detect_changes`, `codebase_memory_get_architecture`, `codebase_memory_search_graph`, `codebase_memory_get_code_snippet`) | Multi-hop BFS, pre-indexed call graph, blast-radius from diff |
| **Cross-service / runtime topology** | "HTTP call from frontend → backend", "channel boundaries", "service dependencies" | **codebase-memory-mcp** `cross_service` mode or `get_architecture boundaries` | Only codebase-memory models HTTP_CALLS / ASYNC_CALLS / CHANNEL edges |
| **Concept / semantic** | "how does auth work across the codebase", "where is rate limiting implemented", "find by concept, not exact name" | **graphify** (`graphify_query`, `graphify_shortest_path`, `graphify_god_nodes`) or `codebase_memory_search_graph` with `semantic_query` | Embedding similarity bridges vocabulary gaps ("publish" → "send") |
| **Complexity / hotspot** | "where are O(n²) loops", "which functions are recursive", "what's the worst-case nested-loop depth" | **codebase-memory-mcp** `query_graph` with `complexity` / `loop_depth` / `transitive_loop_depth` properties | AFT inspect doesn't compute cyclomatic/cognitive complexity |
| **Cross-session memory** | "what did we decide about X", "where did Y live", "what did we change last week" | **Magic Context** (`ctx_search`, `ctx_expand`, `ctx_memory`, `ctx_note`) | Cross-session recall; AFT/graph only see current files |
| **Process-enforced workflow** | "I need design → review → execute → audit", "I want a score-gated plan", "I want a phased audit" | **Sages** (`fuxi_design`, `qiaochui_*`, `luban_*`, `gaoyao_*`) — **opt-in, see §3** | Enforces discipline; does not navigate |

### Escalation rule (when to climb the ladder)

```
                  ┌─ codebase-memory-mcp ──┐
                  │   (cross-package)      │
                  │                        │
   AFT ───────────┼────────────────────────┼──── graphify
   (per-file,     │                        │     (concept,
    ≤1 package)   │                        │      semantic)
                  │                        │
                  └────────────────────────┘
                              │
                              ↓
                    Magic Context (cross-session)
                              │
                              ↓
                    Sages (process, opt-in only)
```

- **Start at AFT** for any file-level question. If AFT finds it, stop.
- **Escalate to codebase-memory-mcp** when: the answer spans ≥2 packages, you need pre-/post-diff blast radius, or you need a call-graph BFS deeper than 2 hops.
- **Escalate to graphify** when: the question is concept-level ("how does X work"), or vocabulary gap blocks lexical search.
- **Reach for Magic Context** when: the answer might be in a previous session, decision history, or parked note — *not* in current files.
- **Reach for Sages** when: the user explicitly wants a 4-phase enforced loop (design → review → execute → audit). Do **not** use sages for free-form exploration — AFT + codebase-memory + Magic Context already cover that.

### Common mis-routes to avoid

| Tempting move | Why it's wrong | Correct move |
|---|---|---|
| `codebase_memory_search_graph` to find a symbol in one file | Graph round-trip slower than `aft_search` + `aft_zoom` | Use AFT |
| `aft_search` + `grep` chain to find cross-package callers | O(n) grep; misses re-exports | `codebase_memory_trace_path` |
| `git diff` + manual chase for blast radius | Manual, error-prone | `codebase_memory_detect_changes` |
| Reading 20 files to understand project structure | Slow, redundant | `codebase_memory_get_architecture` (one call) |
| `fuxi_design` for "fix this typo" | Sages add no value for trivial work | Use AFT directly |
| `bash grep` to search code | Unindexed, unranked | `aft_search` or `codebase_memory_search_code` |

## 2. Semantic Tool Catalog (what each tool does)

### `aft_*` — AFT-backed semantic layer (provided by `@cortexkit/aft-pi`)

Use for **symbol-level** operations on a known file or cross-file graph:
- `aft_outline` — file structure as tree (no scrolling)
- `aft_zoom` — symbol-level inspection with call-graph annotations
- `aft_callgraph` — multi-hop call graph: callers, call_tree, impact
- `aft_search` — semantic search (embeddings, ONNX or OpenAI-compatible)
- `aft_inspect` — code health: duplicates, dead code, unused exports, TODOs
- `aft_safety` — per-file undo, named checkpoints, restore
- `aft_import` — language-aware import add / remove / organize
- `aft_conflicts` — one-call merge conflict inspection

### `codebase_memory_*` — graph-based code intelligence

Use for **project-wide** queries (cross-file, cross-package):
- `codebase_memory_trace_path` — multi-hop call chain BFS
- `codebase_memory_detect_changes` — `git diff` → affected symbols + blast radius
- `codebase_memory_get_architecture` — packages/services/clusters overview
- `codebase_memory_search_graph` — find by qualified name
- `codebase_memory_search_code` — full-text in indexed code (faster than shell `grep`)
- `codebase_memory_get_code_snippet` — function body by qualified name
- `codebase_memory_query_graph` — Cypher for complex multi-hop patterns

### `graphify_*` — knowledge graph

Use for **concept-level** search (cross-module, semantic):
- `graphify_query` / `graphify_shortest_path` — embedding similarity between concepts
- `graphify_god_nodes` — most-imported / most-connected abstractions (entry points)
- `graphify_get_community` — module/cluster boundaries
- `graphify_get_neighbors` — adjacency around a node

### Built-in `read`/`bash` are fine for:

- Reading a small file at a known path
- Shell commands (`bash`) — no semantic equivalent
- `ls` / `find` / `grep` — only when no semantic tool fits (rare; see §1 table)

## 3. Sage Role Tools (7 tools across 4 roles) — opt-in for process-heavy work

> **When to use the sages:** only when the user wants a discipline-enforced loop (design → review → execute → audit) — e.g. for compliance, reproducibility, less-capable models, or explicit gate-based progression. For free-form exploration, bug fixes, code reading, or refactoring, **do not** invoke the sages by default — reach for AFT + codebase-memory-mcp + Magic Context directly (see §1.5). The sages coordinate *process*; they do not navigate *code*.

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

- Fuxi design → `graphify_god_nodes` + `read` (before writing draft.md)
- LuBan RED → `write` + `graphify_god_nodes`
- LuBan GREEN → `edit` + `codebase_memory_trace_path`
- LuBan REFACTOR → `aft_callgraph` + `graphify_get_neighbors`
- GaoYao FOOT → `graphify_get_community` + `codebase_memory_trace_path`
- GaoYao CASTRATION → `grep` + `codebase_memory_search_code`
- GaoYao DEATH → `aft_inspect` + `codebase_memory_detect_changes`

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

For LuBan specifically: the tool **validates** the TDD cycle; the LLM uses **`edit`** to write the GREEN implementation, then re-calls `luban_execute_task` with observation `{phase: "GREEN", test_outcome: "pass"}`.

If a sage tool's return shape differs from what's documented here, the **test suite is the source of truth** (~498 tests in `pi/test/`).