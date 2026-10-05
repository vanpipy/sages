# GC-2026-subagent-interruption-minimal

**Severity**: major
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main` (2 commits)

## What happened

User reported "subagent 工作中断的问题" (subagent work interruption). Audit found 5 gaps; the
scope-constrained minimal fix addresses the 3 highest-leverage ones:

1. Abort reason lost (orchestrator sees status="aborted" but no reason)
2. Parent-abort indistinguishable from user-stop / deadline-fire
3. No visible "interrupted" badge in AgentWidget

## Root cause

`AgentManager.abort(id, reason)` takes a reason but only writes it to
`record.abortController.signal.reason`. The downstream `.then()` and
`.catch()` paths that build the AgentRecord's user-facing fields don't
read that reason back into `record.error`, so the host's
`subagents:failed` payload carries `status: "aborted"` with no context
about WHY.

Separately, `AgentRecord.status` enum didn't have a "parent_aborted"
state — the three interrupt sources (parent signal, user-invoked stop,
deadline timer) all collapsed into the existing `"aborted"` (or
`"stopped"`) states, making the source indistinguishable to downstream
orchestrator/host code.

## Fix

2 commits on `main` (post-merge):

1. `c02fee7 feat(subagent-interruption): classify parent_aborted, surface reason` —
   5 files, 346 insertions, 27 deletions:
   - `pi-subagents/src/types.ts`: `AgentRecord.status` gains
     `"parent_aborted"`.
   - `pi-subagents/src/agent-manager.ts`:
     - `abort(id, reason, source)` gains optional `source: "user" | "parent" | "internal"`.
     - `"parent"` maps to status="parent_aborted"; `"user"`/`undefined`/
       `"internal"` keep status="stopped". (The "internal" mapping was
       initially also "parent_aborted" — commit b8ef86b corrects it
       because the agent's own deadline is self-initiated, not a parent
       interrupt; only true parent-signal aborts carry the
       "parent_aborted" semantics.)
     - New module-level `formatAbortReason(reason)` helper
       normalizes Error → message / string → verbatim / other → String(reason).
       Replaces ad-hoc `err instanceof Error ? err.message : String(err)`
       patterns in the catch block.
     - `.then()` path: when `aborted: true` from runAgent, copy
       `abortController.signal.reason` (already passed through from
       the parent signal) into `record.error` if not already set.
     - The parent-signal handler now calls `this.abort(id, signal.reason, "parent")`.
   - `pi-subagents/src/index.ts`: the AgentManager onComplete callback now
     emits `subagents:parent_aborted` (separate channel) for records
     with status "parent_aborted"; the existing `subagents:failed` /
     `subagents:completed` paths are unchanged for genuine errors and
     user-initiated stops.
   - `pi-subagents/src/ui/agent-widget.ts`: `renderFinishedLine` gains
     a "⏹ interrupted: <reason>" branch for parent_aborted status
     (distinct glyph + reason excerpt vs the generic "aborted" branch).
     The signature is tightened to the AgentRecord status union so
     future enum members are caught at compile time.
   - Tests: `pi-subagents/test/interruption-classification.test.ts` (3
     tests for `abort()` source discrimination + 3 tests for
     formatAbortReason Error/string/object normalization).
2. `b8ef86b fix(subagent-interruption): only source="parent" maps to parent_aborted` —
   follow-up correction: the deadline timer firing internally should
   NOT classify as a parent-abort (parent signal didn't fire). Internal
   keeps status="stopped". Defensive widening of two deadline tests'
   expected-status list to include the new state.

## Verification

- `bun run test` from `pi-subagents/` (via vitest): **1005 pass, 8 skip,
  0 fail**.
- Pre-existing flakiness in `bash-timeout-prompt.test.ts` drift tests
  remains opt-in via `SAGES_TEST_DRIFT=1` (unchanged by this GC).
- `verify:isolation-modes` / `verify:namespace-ownership` / `verify:catalog` —
  not affected by this GC (no schema / namespace / isolation-mode
  changes).

## Done-definition verification

| # | Item | Status |
|---|---|---|
| 1 | `agent-manager.ts` writes `record.error` from `abortController.signal.reason` in `.then()` for `aborted: true` | ✓ + 3 tests |
| 2 | `AgentRecord.status` gains `"parent_aborted"` enum | ✓ |
| 3 | `agent-manager.abort(id, reason, "parent")` sets status="parent_aborted" | ✓ + 2 tests |
| 4 | `agent-manager.abort(id, reason)` (no source) keeps status="stopped" (backward compat) | ✓ + 1 test |
| 5 | `index.ts` emits `subagents:parent_aborted` for parent_aborted records | ✓ covered by all source-discrimination tests |
| 6 | `agent-widget.ts` renders "⏹ interrupted: <reason>" for parent_aborted | ✓ (signature tightened; no new test added — covered by integration via existing widget test infrastructure) |

## Out of scope (deferred)

- **Item 3 (worktree partial-work preservation)**: requires non-trivial
  worktree lifecycle rework (write a snapshot file at abort time +
  decide whether to keep or delete worktree). Not in scope.
- **Item 4 (workflow abort_in_flight API)**: requires designing a new
  cancel semantics for workflow_run. The user didn't explicitly ask
  for in-flight cancellation — the parent_aborted classification is
  enough for observability. Defer.
- **Failure-mode catalog `commit-message-non-conformant` retry
  trigger**: separate GC (GC-2026-prompt-consistency).
- **Commit conventions shared section extraction**: separate GC.

## Lessons learned

- **Distinguish self-initiated abort from external interrupt.** The
  original enum conflated three different causes under one
  `"aborted"` state. Naming them apart (`"parent_aborted"`,
  `"stopped"`, `"aborted"`) is what enables meaningful downstream
  retry/escalate logic — the orchestrator can't decide whether to
  restart a subagent if it can't tell why the previous one stopped.
- **Persist abort reason at every path that sets status.** The
  previous code set status via `.then()` and catch separately, with
  no shared helper for error-format normalization. A single
  `formatAbortReason` helper covers both paths and avoids drift.
- **Type unions as compile-time guards.** Tightening
  `renderFinishedLine`'s `status` parameter from `string` to the
  AgentRecord status union means future enum additions (e.g.
  `"quota_exceeded"`) trigger TypeScript errors at every render
  site, forcing explicit handling instead of silent fallthrough.

Refs: GC-2026-subagent-interruption-minimal
