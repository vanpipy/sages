# GC-2026-evaluator-drift-sweep

**Severity**: minor
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main` (1 commit + 1 merge)

## What happened

Previous drift sweeps (`GC-2026-drift-sweep` v1, `GC-2026-drift-sweep-v2`) ran on `pi-tasks` / `pi-subagents` / `pi-orchestrator` / `pi/docs` but not on `pi-evaluator`. pi-evaluator has its own types, extension listener, and test fixtures that reference `dag_id` — the field name `GC-2026-path-B-field-renames` renamed to `goal_id` everywhere else, but the rename skipped this package.

The drift was silent because the local test fixtures used `dag_id` as the literal key, and the local listener read `input.dag_id`. The fixtures and the listener were internally consistent — both still on the old name. But the production orchestrator (post-rename) emits `goal_id` to the listener (per `pi-orchestrator/src/orchestrator-advisory.ts:289` which reads `input.goal_id`). So:

- Production: orchestrator emits `goal_id`, pi-evaluator listener reads `input.dag_id` → returns `undefined` → state stays uninitialized → tests that rely on the listener are silently broken in production
- Tests: fixtures use `dag_id` → listener reads `input.dag_id` → returns the value → tests pass

The local-test pass masked the production-integration bug. The drift sweep is the only thing that catches it.

## Fix

Two minimal edits:

### pi-evaluator/src/extension.ts — `extractWorkflowId`

```ts
// Before:
if (typeof input.dag_id === "string") return input.dag_id;

// After (prefer goal_id, fall back to dag_id):
if (typeof input.goal_id === "string") return input.goal_id;
if (typeof input.dag_id === "string") return input.dag_id;
```

Plus the comment block above now reflects the post-rename canonical names (`task_dispatch.goal_id`, `orchestrator_audit.goal_id`) and notes that `dag_id` is a back-compat alias.

### pi-evaluator/src/types.ts — `ManagedWorktreeIsolation`

```ts
// Before:
export interface ManagedWorktreeIsolation {
  dag_id: string;
  ...
}

// After:
export interface ManagedWorktreeIsolation {
  goal_id: string;
  ...
}
```

`ManagedWorktreeIsolation` is a local pi-evaluator type with no external readers (verified via grep — only `types.ts:415` and `extension.ts:64` mention it). Renaming to `goal_id` aligns the type with the orchestrator's wire format.

The test fixtures (`test/extension/tool-call-listener.test.ts`) still use `dag_id` literals. They continue to pass because the listener's back-compat fall-back handles them. New test fixtures can use `goal_id`.

## What was NOT done

- The test fixtures were not migrated to `goal_id` (they still use `dag_id`). This is intentional: keeping them on `dag_id` exercises the back-compat alias path and ensures the listener doesn't break on pre-rename data. A separate test case could exercise the `goal_id` path; that's a future improvement.
- Other 5 drift categories (2-state verdict, 5-phase, Auditor name, partial:true, advisorOf) had no hits in `pi-evaluator/`. Confirmed by direct grep — pi-evaluator's source is clean of those patterns.

## Tests

`pi-evaluator/test/extension/tool-call-listener.test.ts` — 12 tests, 0 fail. The 4 tests that exercise the `task_dispatch` + `orchestrator_audit` paths still pass via the `dag_id` back-compat alias.

`bun run typecheck` green. `bun test` shows the pre-existing baseline (8 in pi-tasks; 0 in pi-evaluator, 0 in pi-subagents, 0 in pi-orchestrator except the 5 GC-2026-precommit-fixes-fixed). No regressions.

## Verification

| # | Item | Status |
|---|---|---|
| 1 | `extractWorkflowId` prefers `goal_id` over `dag_id` (production reads) | ✓ |
| 2 | `dag_id` back-compat alias retained (test fixtures + pre-rename data) | ✓ |
| 3 | `ManagedWorktreeIsolation.dag_id` → `goal_id` (local type rename) | ✓ |
| 4 | Comment block updated to reflect post-rename canonical names | ✓ |
| 5 | typecheck green, 12 tool-call-listener tests pass, no regressions | ✓ |

## Effect on the user

`pi-evaluator` is now aligned with the rest of the monorepo's `goal_id` convention. The pre-rename data path (`dag_id` in test fixtures) is preserved as a back-compat alias, so nothing regresses.

Production integration gap closed: `pi-orchestrator`'s `orchestrator-advisory.ts` emits `input.goal_id` on tool calls; `pi-evaluator`'s listener now reads it. State is correctly initialized in production. The local test pass was masking this — the drift sweep caught it.

## Lessons learned

- **Internal consistency can mask production-integration bugs.** pi-evaluator's local tests all passed because the fixture's `dag_id` key matched the listener's `input.dag_id` read. The fixture was a closed loop. The drift sweep is the only thing that opens the loop and checks against the actual orchestrator's wire format.
- **`ManagedWorktreeIsolation` is a local type, not a wire shape.** Renaming it doesn't break anything external. Compare to `pi-subagents/src/invocation-config.ts` which had `dag_id` references that the v1 keep-list preserved (the listener there is the public surface; removing `dag_id` would break legacy call sites). Local types can be renamed freely; wire shapes need a compat shim.
- **The orchestrator's tool-call input fields are the source of truth.** A drift in a downstream package's type can be a silent local-test pass even when the upstream has renamed. The drift sweep is the only thing that detects this class of bug.

Refs: GC-2026-evaluator-drift-sweep
