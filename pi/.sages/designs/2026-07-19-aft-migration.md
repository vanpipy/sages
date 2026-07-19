# Design: AFT Migration (serena → AFT, with built-in replacement)

**Date:** 2026-07-19
**Status:** Approved
**Scope:** `~/Project/sages/pi/` (the `@sages/pi-four-sages` package)

## Overview

Replace the serena-based semantic tool layer used by the four-sages workflow with an AFT-native sage wrapper layer. Serena is removed entirely; AFT replaces built-in `read`/`write`/`edit`/`grep`/`bash`. The result is a stable sage-facing API (`sages_*`) backed by AFT, with a clean two-layer separation that lets us swap AFT for another backend without churning sage prompts.

## Context

Sage tools (`fuxi_design`, `qiaochui_review`, `luban_execute_task`, `gaoyao_audit`) direct the LLM to use semantic tools. Today they say:

> "Use semantic tools (serena_create_text_file or serena_replace_symbol_body) to write the test file at …"

Serena is referenced in **9 distinct tool names** across:

- `templates/SYSTEM.md` — the global "Tool Priority" table the LLM reads at session start
- `src/tools/{fuxi-tools,luban/index,qiaochui/index}.ts` — `buildIntent` prompt strings
- `skills/{fuxi,qiaochui,luban,gaoyao}/SKILL.md` — per-phase prescribed tool lists
- `test/pi-serena-lifecycle.test.ts` — lifecycle mock for `pi-serena` MCP server
- `scripts/install.{sh,ps1,bat}` — install script that registers the pi-serena package and writes its mcp.json template

The A/B test on 2026-07-19 confirmed that AFT covers (and on several axes exceeds) serena's surface, with two material caveats:
1. `dry_run: true` is silently destructive on the production `aft-linux-x64` binary — confirmed via `pi/scripts/` lineage.
2. `aft_callgraph` needs 30–60s warm-up after `configure`.

## Decisions Resolved

| # | Decision | Resolution | Rationale |
|---|---|---|---|
| 1 | Migration scope | **Full serena removal** (strings, install, tests, mcp templates) | User direction: "Replace the serena totally." |
| 2 | Built-in tool layer | **AFT replaces built-ins** (`read`/`write`/`edit`/`grep`/`bash`); sage docs stop naming built-ins directly | User direction: "We will use the aft to replace the built-ins tools too." |
| 3 | Layering | **Two layers: `aft/` (AFT details) + `wrap/` (sage wrappers)** with `wrap → aft` dependency arrow | User correction: "the wrap to wrap the aft; same level, aft/ declares the aft detail and the wrap to use the aft" |
| 4 | Sage tool names | **`sages_*` prefix** (mirrors old `serena_*` shape; minimizes prompt diff) | Minimizes token drift in prompts |
| 5 | AFT binary resolution | **Auto-detect** with env override, all in `aft/binary.ts` | One place to find the binary; rest of code never sees the path |
| 6 | Callgraph warm-up | **Graceful degradation** with explicit retry hint returned from `sages_find_references` | Honest answer; LLM adapts |
| 7 | `insert_after_symbol` (AFT gap) | **Anchor-replace strategy** in `wrap/insert-after-symbol.ts` | AFT has no direct equivalent; `edit` find/replace from the closing `}` of the target symbol is functionally equivalent |
| 8 | `dry_run: true` is broken | **Always snapshot before write** in `wrap/write-file.ts` and `wrap/replace-symbol.ts`; never trust the flag | Bug confirmed via T5 in 2026-07-19 A/B test |
| 9 | Tests for the lifecycle | **Replace `test/pi-serena-lifecycle.test.ts` with `test/pi-aft-bridge.test.ts`** | Serena lifecycle test becomes irrelevant |
| 10 | Backup/undo convention | **Layered**: AFT's built-in backup (its `aft_safety`) handles per-write undo; our `aft/safety.ts` adds a top-level `.sages/snapshots/` copy that works even without the AFT plugin loaded (so tests can run without an AFT extension) |

## Requirements

### Functional
1. All 9 sage tools (`sages_*`) are registered on the pi extension when the sages package loads
2. Each sage tool calls into `aft/bridge.ts` (NDJSON over stdio) and translates the AFT-shaped response into a sage-shaped response
3. `sages_write_file` and `sages_replace_symbol` always snapshot to `.sages/snapshots/<ts>-<hash>` before delegating to AFT, regardless of `dry_run`
4. `sages_find_references` returns `{ status: "building", retry_after_ms: 30000, hint: "…" }` when AFT reports `callgraph_building`
5. `templates/SYSTEM.md` "Tool Priority" table refers to `sages_*` only; no more `serena_*`; no more bare `read`/`write`/`edit`/`grep` (AFT is the layer underneath, transparent to the agent)
6. All skill docs and `buildIntent` prompt strings in the four sage tools refer to `sages_*`
7. `scripts/install.{sh,ps1,bat}`:
   - Removes all `install_pi_serena`, `install_serena_files`, `write_serena_mcp_config`, `is_pi_serena_installed` and inline serena logic
   - Adds `install_pi_aft` which runs `npx @cortexkit/aft@latest setup --harness pi` (idempotent)
   - Adds `is_pi_aft_installed` helper for idempotency
   - Updates `--sages-only`, `--system-only` help text to reference aft
   - On uninstall: also runs `npx @cortexkit/aft@latest uninstall` if AFT was installed

### Non-functional
- `wrap/` modules must NOT import anything from outside `aft/` and standard libraries; tests can mock `aft/` completely
- `aft/bridge.ts` is the only file that knows AFT tool names; renaming `aft_zoom` → `aft_inspect_symbol` only touches this file plus a constant in `aft/types.ts`
- The bridge spawns one long-lived AFT daemon per sage session (shared across all `sages_*` calls); uses the AFT BridgePool pattern per `cortexkit/aft` ARCHITECTURE.md
- All new code passes `tsc --noEmit` and the existing test suite (`bun test ./src ./test`) plus the new bridge + wrap suites
- Install scripts: keep the existing `--sages-only` and `--system-only` flags; don't change `REPO_URL` or `PKG_NAME`

## Architecture

### Dependency graph

```
┌──────────────────────────────────────────────────────────────┐
│                  SAGE PROMPTS (templates + SKILL.md)         │
│         "Use semantic tools (sages_read_file, …)"            │
└────────────────────────┬─────────────────────────────────────┘
                         │ tool calls
                         ▼
┌──────────────────────────────────────────────────────────────┐
│             pi/src/tools/wrap/   (sage-facing API)          │
│                                                              │
│   sages_read_file.ts    sages_write_file.ts                  │
│   sages_outline.ts      sages_find_symbol.ts                 │
│   sages_find_references.ts     sages_replace_symbol.ts       │
│   sages_insert_after_symbol.ts sages_search.ts               │
│   sages_diagnostics.ts  index.ts (registers all)             │
└────────────────────────┬─────────────────────────────────────┘
                         │ calls
                         ▼
┌──────────────────────────────────────────────────────────────┐
│             pi/src/tools/aft/    (AFT details)               │
│                                                              │
│   binary.ts (locate AFT binary)                              │
│   project.ts (configure + warm-up)                           │
│   warmup.ts (background callgraph pre-warming)               │
│   bridge.ts (NDJSON over stdio — the ONLY file              │
│             that knows AFT tool names)                       │
│   safety.ts (per-write snapshot + undo bookkeeping)          │
│   errors.ts (map AFT error codes → retry hints)              │
│   types.ts (AFT response shapes)                             │
│   index.ts (public API)                                      │
└────────────────────────┬─────────────────────────────────────┘
                         │ JSON-over-stdio
                         ▼
              ┌────────────────────────┐
              │   aft-linux-x64 binary │
              │   (Rust, ~77 MB)       │
              │   from npm or PATH     │
              └────────────────────────┘
```

### Why the split

- **Stable API**: `wrap/` exposes `sages_*` tools. AFT can rename `aft_zoom` → `aft_inspect_symbol` next release; only `aft/bridge.ts` and one constant in `aft/types.ts` change.
- **Backend portability**: If we ever swap AFT for another tool (e.g., upstream fixes never land, or a competitor arrives), only `aft/` is replaced; `wrap/` and every sage prompt stay stable.
- **Test layering**: bridge tests mock AFT responses; wrap tests mock `aft/`; integration tests run real AFT against `~/Project/aft-test/`.
- **Safety in one place**: the `dry_run` workaround (always-snapshot-before-write) lives in `wrap/write-file.ts` and `wrap/replace-symbol.ts`. When AFT fixes the bug upstream, two files get cleanups; nothing else changes.

## Components

### `pi/src/tools/aft/binary.ts`
Resolves which AFT binary to use. Lookup order:
1. `$AFT_BINARY` env var (escape hatch for tests / unusual installs)
2. `~/.pi/agent/npm/node_modules/@cortexkit/aft-linux-x64/bin/aft` (npm-bundled)
3. `which aft` (PATH)
4. `~/.cargo/bin/aft` (cargo-installed dev build)
5. Throw with a remediation message that mirrors the SKILL.md troubleshooting table

### `pi/src/tools/aft/project.ts`
Per-session AFT lifecycle. On first sage tool call:
1. `configure` with `harness: "pi"`, `project_root: cwd`
2. Track session_id (per AFT's multi-session model)

### `pi/src/tools/aft/warmup.ts`
On `pi.on("session_start")`:
1. Send `configure` (kicks off background callgraph build)
2. Return immediately; do not block the agent startup

### `pi/src/tools/aft/bridge.ts`
The only file that knows AFT protocol. Exposes typed methods like:
```ts
class AftBridge {
  async outline(file: string): Promise<OutlineResult>
  async zoom(file: string, symbol: string): Promise<ZoomResult>
  async callgraph(file: string, symbol: string, direction: "inbound" | "outbound"): Promise<CallgraphResult>
  async grep(pattern: string, path: string, options?: GrepOptions): Promise<GrepResult>
  async inspect(path: string): Promise<InspectResult>
  async read(path: string, options?: ReadOptions): Promise<string>
  async write(path: string, content: string): Promise<WriteResult>
  async edit(path: string, find: string, replace: string): Promise<EditResult>
  async undo(backupId: string): Promise<UndoResult>
}
```
Internally sends NDJSON, parses responses. AFT-specific errors map to typed exceptions in `errors.ts`.

### `pi/src/tools/aft/safety.ts`
Per-write snapshot helper. Always invoked by `wrap/write-file.ts` and `wrap/replace-symbol.ts` **before** calling `aft/bridge.ts`. Writes to `.sages/snapshots/<ISO timestamp>-<sha256(path).slice(0,8)>.bak`. Returns a snapshot id bundled into the sage tool response.

### `pi/src/tools/aft/errors.ts`
Translates AFT error codes:
| AFT code | Sage behavior |
|---|---|
| `callgraph_building` | wrap maps to `{ status: "building", retry_after_ms: 30000, hint: "AFT callgraph still indexing; call again in 30s" }` |
| `unknown_command` | rethrow with file:line from `aft/types.ts` so the LLM sees the exact typo |
| `not_configured` | retry once with `configure` before re-raising |
| All others | re-throw with the original AFT message prepended with `[AFT]` |

### `pi/src/tools/aft/types.ts`
TypeScript types matching AFT's response shapes (`OutlineResult`, `ZoomResult`, …). Single source of truth.

### `pi/src/tools/aft/index.ts`
Re-exports the public API. Has a `// SAGE-FACING ONLY AT THIS POINT — see ../wrap/` JSDoc tag to discourage non-wrap callers.

### `pi/src/tools/wrap/*.ts`
One file per `sages_*` tool. Each is a thin adapter:
```ts
pi.registerTool({
  name: "sages_read_file",
  parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number()), limit: Type.Optional(Type.Number()) }),
  async execute(_id, params, _sig, _onUpdate, ctx) {
    const aft = getAftBridge(ctx);
    const content = await aft.read(params.path, { offset: params.offset, limit: params.limit });
    return { content: [{ type: "text", text: content }] };
  },
});
```

### `pi/src/tools/wrap/index.ts`
Single `registerAllWrappers(pi)` entrypoint, called from `src/tools/{fuxi-tools,qiaochui/index,luban/index,gaoyao-tools}.ts`'s registration helpers. Updated alongside the `buildIntent` string changes.

## Data flow

### Read path (`sages_read_file`)
```
LLM → wrap/read-file.ts → aft/bridge.read → AFT outline file
                              ↓
                        safety.ts (no-op for read)
                              ↓
                        AFT rust reader
                              ↓
                       string content
                              ↓
              sage-shaped { content: [...] } response
```

### Write path (`sages_write_file`) — most safety-critical
```
LLM → wrap/write-file.ts:
  1. safety.ts.snapshot(file) → .sages/snapshots/<id>.bak
  2. aft/bridge.write(file, content) → AFT (which also creates its internal backup)
  3. Return { snapshot_path, aft_backup_id, undo_hint }
```
LLM sees both safety layers; either snapshot path can restore the file.

### `insert_after_symbol` path (gap workaround)
```
LLM says "insert after fooBar":
  1. aft/bridge.zoom(file, "fooBar") → body with end line
  2. Compute anchor text = last non-empty line of fooBar's body (typically "}" or return statement)
  3. aft/bridge.edit(file, anchor, anchor + "\n\n" + newCode)
```

## Error handling

| Where | Strategy |
|---|---|
| AFT returns `callgraph_building` | sage-shaped `building` response with retry hint; never throw to LLM |
| AFT throws because of broken pipe | `aft/bridge.ts` re-establishes; one retry, then propagate |
| `dry_run: true` requested (it doesn't honor anyway, but test safety) | ignore in `safety.ts`; always do the real snapshot |
| AFT binary missing | `binary.ts` throws with a SKILL.md-style remediation table |
| AFT version mismatch with `@cortexkit/aft-pi` plugin | `bridge.ts` falls back to checking `version` field; logs warning, continues |
| `.sages/snapshots/` not writable | degrades to AFT-only backup (AFT has its own `~/.local/share/cortexkit/aft/.../backups/`); logs warning |

## Testing strategy

Three layers, each focused:

### 1. Bridge unit tests (`test/aft/bridge.test.ts`)
Mock NDJSON responses from a fake AFT daemon. Verify:
- Param translation (`sages_x` params → AFT params)
- Response parsing (AFT shape → `OutlineResult`, etc.)
- Error mapping (AFT error code → sage error)
- Retry on `not_configured`

### 2. Wrap unit tests (`test/wrap/sages_*_file.test.ts`)
Mock the bridge module. Verify:
- `sages_write_file` calls `safety.snapshot` BEFORE the bridge
- `sages_find_references` translates `callgraph_building` to retry hint
- `sages_insert_after_symbol` uses the anchor strategy correctly (golden test against a known fixture file)

### 3. Integration test (`test/aft/integration.test.ts`)
Run real AFT against `~/Project/aft-test/` (the tmp repo we created during A/B). Verifies:
- `configure` succeeds
- `outline`, `zoom` work end-to-end
- `safety.snapshot` creates a real file in `.sages/snapshots/`
- Undo round-trip works

### 4. Install script tests (existing `test/install.test.sh`)
Updated to assert:
- AFT install runs (npm resolve succeeds)
- All previously-serenarelated strings are absent: `grep -l serena scripts/ templates/ src/ skills/` returns empty
- `install_pi_serena` and related functions are not defined
- `install_pi_aft` is defined and called in `main()`

## Open questions

None — all forks (C1, C2, C3) resolved during grilling.

## Acceptance criteria

- [ ] All `serena_*` strings removed from `pi/templates/SYSTEM.md`, `pi/src/tools/`, `pi/skills/`
- [ ] `pi/src/tools/aft/` and `pi/src/tools/wrap/` exist with the documented file layout
- [ ] `sages_*` tools registered when the sages package loads (verified by integration test that registers on a stub pi extension and asserts tool names)
- [ ] `sages_write_file` always snapshots before delegating to AFT (TDD test: write a file, assert `.sages/snapshots/<id>.bak` exists after the call)
- [ ] `sages_find_references` returns sage-shaped `building` response when AFT says `callgraph_building`
- [ ] `sages_insert_after_symbol` inserts text after a known anchor (golden test against `crates/aft-tokenizer/src/claude.rs` in the aft repo)
- [ ] `scripts/install.sh` no longer has any `serena`-named functions or strings; new `install_pi_aft` exists and is called
- [ ] `scripts/install.ps1` and `scripts/install.bat` updated symmetrically
- [ ] `test/pi-serena-lifecycle.test.ts` replaced by `test/pi-aft-bridge.test.ts`
- [ ] `bun run typecheck` passes; `bun test ./src ./test` passes
- [ ] Integration test passes against `~/Project/aft-test/` with real AFT binary
- [ ] `install.test.sh` updated: serializes the above acceptance as code

## Spec self-review

| Step | Check | Result |
|---|---|---|
| 1 | Placeholder scan | No "TBD", "TODO", incomplete sections. The two TODO strings in `accept_criteria` (`scripts/install.sh no longer …`, `scripts/install.ps1 and .bat updated`) are descriptive of what the criteria ARE, not placeholders for unfinished thoughts. |
| 2 | Internal consistency | Architecture diagram, dependency graph, and component descriptions all agree. Wrap never imports AFT directly; aft never imports wrap. |
| 3 | Scope check | This is a single coherent refactor of one package (`@sages/pi-four-sages`). Multiple subsystems (10 new files + 8 modified) but all serve the same goal. QiaoChui will decompose further into LuBan-able tasks at execution time. |
| 4 | Ambiguity check | "AFT-native" appears in decisions; clarified inline. "sages-facing API" defined in the Architectural diagram. The "AFT binary auto-detect" lookup order is enumerated. |

Status: Ready for QiaoChui review.
