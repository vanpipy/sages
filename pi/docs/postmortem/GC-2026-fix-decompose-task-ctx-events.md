---
id: GC-2026-fix-decompose-task-ctx-events
title: Fix decompose_task ctx.events undefined + add feeder status gate (re-dispatch loop)
severity: minor
date: 2026-10-08
---

# GC-2026-fix-decompose-task-ctx-events — Postmortem

## What happened

Two runtime bugs in the orchestrator + task-feeder collided in one
session and caused 6× re-dispatches of the same Planner subagent
against the same intent task.

**Bug #1 — `decompose_task` tool wrapper.** The wrapper at
`pi-orchestrator/src/decompose-task.ts:244-257` narrowed the host's
`ctx: unknown` (the `registerTool` boundary) into the shape
`executeDecomposeTask` requires. The narrowing used
`(ctx as { cwd, events }) ?? { cwd: process.cwd(), events: <no-op> }`.
The `??` operator only fires when the LHS is null or undefined, so
the fallback triggered when the host passed `ctx === undefined` or
`ctx === null`, but NOT when the host passed a `ctx` whose `events`
field was undefined. The TypeScript `as` cast silenced the type
error in that case. At runtime, `safeCtx.events.on(...)` then threw
`Cannot read properties of undefined (reading 'on')` and the
Promise rejected.

The bug had a documented predecessor at
`pi-orchestrator/src/decompose-task.ts:88-99` (comment from commit
`6055a71`) — the prior fix addressed the TDZ + orphan-timer symptom
of the same crash, not the root cause. The 6× hits in this session
were the surviving manifestation.

**Bug #2 — re-dispatch loop in `maybeAutoSpawn`.** The unified
task-feeder's `maybeAutoSpawn`
(`pi-tasks/src/task-feeder.ts:130-144`) did not check the task's
own status — only the `isFeedableTask` predicate + the
blockers-completed cascade gate. The contract pushed status-gating
onto every caller. `subagents:failed` reverts status to `pending`
when a subagent errors (`pi-tasks/src/task-feeder.ts:218-225`), so
after a Planner call to `decompose_task` failed (Bug #1), the
intent task was reverted to `pending` and the next event that
walked the store re-spawned a fresh Planner. T2 saw 5 spawns
(`decompose_task` retried 5x by the Planner), T1 / T3 / T4 saw 2
each, T5 saw 1. Same Planner dispatched against the same
sub-task each time, same runtime error, same orchestrator-side
notification storm.

## Root cause

Both bugs share a single underlying cause: **a defensive boundary
that was supposed to fall back on bad input was written against the
narrow case (`ctx` itself null) and not the broad one (`ctx.events`
undefined; `task.status` flipped by a sibling event)**.

The pre-fix `decompose_task` wrapper was written when the host's
`ExtensionToolContext` was assumed to always carry an `events` field
when present (the only "absent" case was the whole `ctx`). When the
host's actual contract loosened (or the wrapper was reused in a
context where the assumption didn't hold), the cast-only narrowing
silently failed at runtime.

The pre-fix `maybeAutoSpawn` was written when the only callers
(TaskCreate, TaskUpdate) gated on `status === "pending"` before
invoking. The contract comment documented this:
*"Calling on a task already `in_progress` will spawn again —
producers are responsible for gating on `status === 'pending'`."*
The `cascadeSpawn` cascade path also gates on pending status
(line 149), so the in-house callers were correctly behaved. The
problem was that `subagents:failed` does not respect the contract
— it reverts to `pending` and relies on the cascade to clean up.
When the cascade walked the store and the same task was still
`pending`, the loop reset.

## Fix

Two atomic commits on branch
`fix/gc-2026-decompose-task-ctx-events`:

1. **`fix(pi-orchestrator): decompose_task tool wrapper defaults ctx.events`** (`7776f6b`)
   - Extracted `buildSafeCtx(ctx: unknown): SafeDecomposeCtx` that
     defaults BOTH `cwd` and `events` independently, mirroring the
     `(_ctx as T | undefined) ?? { cwd: process.cwd() }` pattern in
     `wrapRegisteredTool` (`registered-tool-wrapper.ts:124`).
   - Extracted `executeDecomposeTaskTool(params, ctx)` so unit
     tests can exercise the wrapper logic without going through
     `pi.registerTool`. The `registerDecomposeTaskTool` body
     collapses to a one-liner that delegates.
   - `rpcTimeoutMs` is now passed through the safe-ctx so tests can
     force a quick rejection instead of waiting the default 30s.
   - 5 new tests in `pi-orchestrator/test/decompose-task.test.ts`
     cover the bug-trigger shape, the pass-through, and the
     end-to-end wrapper behavior.

2. **`fix(pi-tasks): task-feeder maybeAutoSpawn self-gates on status`** (`1b2ea95`)
   - Added a `status === "pending"` self-gate inside `maybeAutoSpawn`.
     The function now re-reads the latest task from the store (the
     in-memory object passed in can be stale after a previous spawn
     flipped status to `in_progress`).
   - Updated the contract comment to reflect that the function is
     self-gating, not caller-gated. The cascade in `cascadeSpawn`
     already gates on pending status (line 149), so the new check
     is a no-op for the cascade path — it only changes behavior for
     direct callers that previously had to remember to gate.
   - Updated the "idempotent contract" test (which previously
     asserted `second call WILL spawn`) to assert the new
     behavior: `second call does NOT spawn`.
   - 2 new tests cover the self-gate on `in_progress` and
     `completed` statuses.

Both packages' full test suites pass: 506/506 in pi-orchestrator
(was 501 pre-GC, +5 new), 570/570 + 20 skip in pi-tasks (was 568
pre-GC, +2 new). Typecheck clean in both.

## Follow-ups

1. **Audit other tool wrappers for the same `ctx as T ??` pattern.**
   `pi-orchestrator/src/goal-contract.ts` and
   `pi-orchestrator/src/workflow-run-tool.ts` both receive `ctx`
   through `pi.registerTool` and may have similar narrowing shapes.
   The defensive pattern is `(_ctx as T | undefined) ?? <defaults>`
   per `wrapRegisteredTool`. A targeted search + audit would catch
   any siblings of Bug #1 before they hit production. (Not done
   here — out of scope for this GC's anti-goals.)

2. **The `decompose_task` RPC contract is still loosely typed.**
   The `events: { emit, on }` interface in the safe-ctx is the
   minimum-viable shape; pi-coding-agent's actual `EventBus` has
   more methods. If a future caller needs them, the safe-ctx will
   need to grow. (Defer until a use case lands.)

3. **Catalog drift check.** The two `pi-orchestrator/catalogs/*.json`
   files had timestamp-only diffs at session start. These are
   regenerated by `bun run gen:catalog` and were not modified by
   this GC (no source files in the catalog `_source_files` list
   changed). Left as-is; next regen will pick up any actual drift.

4. **Workflow_run pipeline in this session failed to dispatch.**
   `workflow_run` hit its 10s watchdog because
   `pi-tasks` + `pi-subagents` extensions are not registered in
   the active session ("Fix: run pi-orchestrator/scripts/install.sh
   and restart pi"). Per the soft-mode contract, the orchestrator
   took over and did the work directly on a feature branch. This
   is the documented escape hatch, not a workaround — but it does
   mean the `workflow_run` tool is unreachable from sessions that
   don't have the extensions installed. Filing a separate GC to
   improve the watchdog's diagnostic or surface a clearer "session
   not bootstrapped" hint could prevent future operators from
   hitting the same dead-end.
