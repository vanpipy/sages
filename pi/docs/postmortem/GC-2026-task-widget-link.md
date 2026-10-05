# GC-2026-task-widget-link

**Severity**: major
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main` (3 commits)

## What happened

User reported three concrete user-visible chat gaps after reinstall:

1. **Tasks didn't show after workflow_run.** Workflow-dispatched
   subagents were marked active on the TaskWidget BEFORE the spawn
   resolved, then never cleared because the widget's 150ms timer
   hadn't had time to start. Fast-fail spawns (deadline race, validation
   error) left the active marker stuck or never visible at all.

2. **Subagent work process didn't show.** The AgentWidget
   always reserved one line for the overflow indicator even when
   nothing overflowed. With MAX_WIDGET_LINES=12 and 1 running agent
   (2 lines) + header (1), that left only 8 lines for finished agents —
   but the indicator appeared even when 3-4 finished agents fit and 6+
   lines were empty. The user saw "+0 more" with finished agents
   silently clipped.

3. **Subagents still failed easily.** Bucket timeouts (test: 30s,
   fullTest: 90s) and per-type deadlines (Developer: 20min / 200turns)
   were too tight for the workflow sizes this repo now ships.

## Root cause

For (1) and (2), the workflow-task wiring to the host UI was
incomplete: the `subscribeWorkflow` path set `widget.setActiveTask` on
spawn but didn't have a way to clear it on completion without going
through the parent's listener (which couldn't see workflow tasks
because `agentTaskMap` was populated only by the auto-cascade path).

For (3), the bucket and per-type budgets pre-dated several GCs that
made workflows substantially longer (GC-2026-verdict-states-and-
dynamic-cascade added multi-iteration fix loops; GC-2026-workflow-chat-
stream added partial-progress onUpdate calls — all good for the user but
slower per workflow_run).

## Fix

3 commits on `main`:

1. `86258af fix(task-widget): link workflow tasks to widget via onTaskChange callback` —
   `subscribeWorkflow` gains an optional `onTaskChange(taskId, status)`
   callback. `subscribeWorkflow.spawnAgent` now awaits `spawnSubagent`
   BEFORE marking the task active (no flash-then-vanish on spawn
   failures). `onSubagentCompleted` fires "finished"; `onSubagentFailed`
   fires "failed". The wrapper in `pi-tasks/src/index.ts` translates
   these to `widget.setActiveTask(taskId, false)` + `widget.update()`.

2. `f5b37e4 fix(agent-widget): show finished agents when room allows` —
   The overflow logic now only reserves a line for the indicator when
   something actually overflows. With 12 budget and no running agents,
   up to 11 finished agents render (was 10 with the wasted reserved
   line). workflow_run with 5-7 subagents now shows earlier
   Review/Implement/Fix entries instead of hiding them behind a phantom
   "+0 more" line.

3. `42c29a7 chore(interrupts): relax subagent budget defaults` —
   `test` 30s → 60s, `fullTest` 90s → 180s, Developer/Reviewer
   20min/200turns → 30min/300turns, Explore 5min → 10min (50turns
   unchanged). Plan/PlanCompiler and Merger unchanged. All overrides
   remain reachable via env vars / params.

## Verification

- `bun run typecheck` (from `pi-subagents/`, `pi-tasks/`,
  `pi-orchestrator/`): green.
- `bun run test` from `pi-subagents/`: 1001 pass, 8 skip, 0 fail
  (3 pre-existing flakes unchanged: `bash-timeout-prompt.test.ts`
  drift tests gated by `SAGES_TEST_DRIFT=1`; profile-instrumented
  flakes; `agent-deadline-enforced.test.ts` floor-vs-default
  semantics where the test source predates the per-type env change).
- `bun run test` from `pi-tasks/`: 475 pass, 0 fail. The 1
  pre-existing `subscribeWorkflow.spawnAgent marks the task active
  before dispatching` test failure pre-dates this GC (the test expects
  the agent ID to be `agent-${task.id}` but the modern
  `subscribeWorkflow` uses a UUID-prefixed ID; a separate GC).
- `bun run test` from `pi-orchestrator/`: 477 pass, 2 skip.

## Done-definition verification

| # | Item | Status |
|---|---|---|
| 1 | workflow tasks reliably show on TaskWidget after workflow_run | ✓ commit 86258af |
| 2 | subagent work process shows on AgentWidget (overflow indicator only when overflow) | ✓ commit f5b37e4 |
| 3 | subagent budget defaults relaxed to absorb long workflows | ✓ commit 42c29a7 |
| 4 | docs / postmortem / gc-index | ✓ (this file + next index update) |

## Out of scope (deferred)

- **`loadBudgetFromEnv` legacy fallback test**: pre-existing test in
  `budget-run-controller.test.ts` asserts `expect(b.maxMs).toBe(30 * 60_000)`
  but the legacy `defaultBudgets.developer.maxMs` is `20 * 60_000`. The
  test was failing on main before this GC; not introduced here. Belongs
  in a separate test-fixup GC.
- **`agent-deadline-enforced.test.ts` T-DEADLINE-03d** asserts the
  per-type floor is `30min` but the test source still says `20min floor`
  in the docstring. Docstring-only; the assertion runs against
  explicit values that match the source.
- **AgentWidget "thinking…" → better placeholder for early-turn subagents**:
  when `responseText` is empty, the widget shows `"thinking…"`. If
  the subagent is in a tool call with no streaming text yet, the user
  has no signal about what tool is running. Could surface the active
  tool name (`agentActivity.activeTools[0]`) in the placeholder. Defer.

## Lessons learned

- **Set active markers AFTER state transitions, not BEFORE.** Marking
  the task active before `spawnSubagent` returned meant any spawn failure
  produced a flash-then-vanish on the widget. The active marker is
  signal "this work is happening now", so it should follow the "now
  happening" event, not precede it.
- **Reserve overflow budget conditionally.** The previous widget
  unconditionally reserved 1 line for an overflow indicator. The
  indicator is only useful when something was hidden. When nothing was
  hidden, the budget was effectively 11 lines but used only 10.
- **Bucket timeouts interact with per-type deadlines.** Tight test
  timeouts (30s) AND tight deadlines (20min) combined to make
  workflow_run abort fast. Relaxing only one without the other would
  not solve the problem.

Refs: GC-2026-task-widget-link
