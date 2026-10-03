---
id: GC-2026-dead-code-cleanup
title: Dead code cleanup — drop services/file-service + utils/analyzer + obsolete tests
severity: minor
date: 2026-10-02
audit_verdict: PASS
---

# GC-2026-dead-code-cleanup — Postmortem

## What happened

Audit identified two substantial dead-code clusters in `pi-orchestrator/`
totaling ~2,400 lines of source code (10 files) plus 7 test files plus
1 fixture directory — all from the path-A era. The orchestrator's
post-simplify surface didn't reference any of them, but they lingered
in the source tree.

A preliminary list also included `pi-tasks/src/process-tracker.ts`. The
audit was wrong about that one: `ProcessTracker` is actively used by
4 sites in `pi-tasks/src/index.ts` (the `TaskOutput` and `TaskStop`
tools for non-subagent, shell-spawned tasks). That deletion was
attempted, reverted on first failing test, and is **out of scope** for
this GC — see "Audit methodology lessons" below.

## Root cause

Path-A's `dag_synthesize` + `task_dispatch` + `orchestrator_audit`
+ `sages_reminder` pipeline was deleted wholesale by
GC-2026-orchestrator-simplify. Some surface features
that existed *only* for the DAG era weren't deleted at the same time:

1. **`FileService`** (256 lines) — a centralized file-ops abstraction
   with security validation. Was used by `dag-synthesizer.ts` and
   `task-dispatcher.ts` to safely read task-scoped files. With the
   DAG gone, nothing imports `FileService`.

2. **`utils/analyzer/`** (7 files, 2,138 lines) — project language
   detection (Python / Go / Java / TypeScript detectors + an
   orchestrator aggregator). Was used by the brainstorming command
   to ask "what languages are present" and tailor design suggestions.
   The brainstorming command still works without it (it never
   depended on this output for any LLM-facing flow).

3. **`process-tracker.ts`** (pi-tasks) — `ProcessTracker` class for
   shell-process-backed tasks (the `TaskOutput` / `TaskStop` /
   `TaskStop`'s underlying tooling). The class is **active** in
   `pi-tasks/src/index.ts:171, 1053, 1107, 1142`. The preliminary
   audit missed these references because the search scope was scoped
   to `src/*.ts` files only and `process-tracker.ts` itself was
   removed from the scope.

All three shipped with tests that existed only to cover their
respective modules. With the modules gone (or about to be), the
tests are dead code too.

## Fix

| Action | File | Lines removed |
|---|---|---|
| DELETE | `pi-orchestrator/src/services/file-service.ts` | 256 |
| DELETE | `pi-orchestrator/src/services/index.ts` (barrel) | 7 |
| DELETE | `pi-orchestrator/src/utils/analyzer/{base,go-detector,index,java-detector,orchestrator,python-detector,typescript-detector}.ts` | 2,138 |
| DELETE | `pi-orchestrator/test/file-service.test.ts` | (deleted) |
| DELETE | `pi-orchestrator/test/utils/analyzer/{base,go-detector,java-detector,orchestrator,python-detector,typescript-detector}.test.ts` | 6 files |
| DELETE | `pi-orchestrator/test/fixtures/go-with-cobra/` | 3 files |
| EDIT | `pi-orchestrator/src/index.ts` | -2 lines (removed `export * as ProjectAnalyzer` + `export * as FileService`) |
| **Total** | — | **~2,400 lines source + 7 test files + 1 fixture** |

The process-tracker deletion was attempted, reverted (after vitest
reported 10 failed test files), and is explicitly **out of scope**
for this GC.

## Audit methodology lessons

The preliminary audit used a `git grep` approach looking for exports
that no other file referenced. For most files this works well. The
process-tracker false-negative came from a different angle: the
search scope was the file's basename (`process-tracker`) but the
class file (`process-tracker.ts`) imports into `index.ts` using the
**module** form (`import { ProcessTracker } from "./process-tracker.js"`).
The search needed to look at both the file basename AND the imported
symbol names — the latter would have caught the 4 use sites in
`pi-tasks/src/index.ts`.

For future dead-code audits: always grep for both the file path AND
the exported symbol names. The "no consumers" test must check
symbol-level references, not just file-level imports.

## Verification

```
$ cd pi-orchestrator && bun test ./test --path-ignore-patterns dist/
 447 pass
   2 skip
   0 fail
 881 expect() calls
   Duration  8.23s

$ cd pi-tasks && bun x vitest run
 Test Files  24 passed (24)
      Tests  436 passed (436)
   Duration  5.35s

$ cd pi-subagents && bun x vitest run
 Test Files  82 passed (82)
      Tests  990 passed (990)

$ cd pi-orchestrator && bun run verify:all
[catalog]  OK
[gcdb]     OK
[isolation-modes] OK
[namespace-ownership] OK
[pi-universe] OK
[soft-mode-mental-model] OK

=== verify-all summary: 6/6 passed ===
```

Net test count change:

- pi-orchestrator: 518 → 447 (−71 tests deleted alongside the modules)
- pi-tasks: 436 → 436 (process-tracker reverted, no change)
- pi-subagents: 990 → 990 (no changes)

All 6 verify gates green. No `process-tracker` deletion in this GC.

## Follow-ups

- **`utils/analyzer` re-added as a separate package?** If a future
  brainstorming enhancement wants to detect project languages, the
  detection logic could be re-introduced as a Sages-tools package
  with its own tests. Out of scope for now.
- **`process-tracker.ts` audit**: `ProcessTracker` itself has a small
  surface area (only `getOutput`, `waitForCompletion`, `stop`,
  `getProcess`). It's tied to the shell-process-tool path that's
  deprecated in favor of the subagent runtime. A follow-up GC could
  decide whether to keep it (and why) or delete it alongside the
  shell-process tools. Filed as separate.
- **Test fixtures directory audit**: `pi-orchestrator/test/fixtures/`
  still has only the now-empty `go-with-cobra/` removed. Other fixture
  directories should be audited separately if they grow.

## Commits

- `chore(dead-code): drop services/file-service + utils/analyzer + obsolete tests`

Single commit. Cleanup is reversible via `git revert` if a future
GC needs any of the deleted files.

## Behavior change (deliberate)

`pi-orchestrator` no longer exports `FileService` or `ProjectAnalyzer`
namespace from its package entry. If a downstream consumer (the
runtime `pi-orchestrator` install at `~/.pi/packages/pi-orchestrator/`)
imported them, the import resolves to `undefined`. Verified via
`git grep -r 'FileService\|ProjectAnalyzer' pi-*/src/ pi-*/test/`
returning only historical comments and this postmortem's references
— no production consumers.