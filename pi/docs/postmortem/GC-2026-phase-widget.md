# GC-2026-phase-widget

**Severity**: minor
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main` (1 commit + 1 merge)

## What happened

The prompt-consistency audit + the user's iterative design exploration (paired-programming model → 3-state surfaces → "use pi-tasks task primitives") converged on a concrete missing surface: **pi-orchestrator had no UI for the workflow plan**.

Concretely, after the previous GCs:
- `pi-tasks` surfaces task state via `TaskWidget` + `TaskList` command
- `pi-subagents` surfaces sub-agent execution state via `AgentWidget` + `FleetList` + `subagent_status` command
- `pi-orchestrator` had **no widget at all**. The plan state lived only in `workflow-{goal_id}.yaml` (a file), `WorkflowProgressUpdate` (a chat partial stream — which the first audit found broken), and `WorkflowRunOutput` (an LLM-facing final view).

The user proposed: instead of building a parallel infrastructure, **use pi-tasks's task primitives as the data model**. Tasks for a workflow already exist in `pi-tasks`'s `TaskStore` (created by `subscribeWorkflow.onWorkflowStart` with `metadata.phase` + `metadata.workflow_run_goal_id` + `metadata.iteration` fields). A phase widget is a different VIEW of the same data — grouped by phase — not a new data model.

## Design decision

The user picked: **Option B primary + Option C supplement**.

- **Option B (primary)**: pi-orchestrator queries pi-tasks's `TaskStore` via a new cross-extension RPC endpoint (`tasks:rpc:list-by-metadata`). The widget reads the current `goal_id` from the most recent `workflow:start` event and issues `store.list().filter(t => t.metadata["workflow_run_goal_id"] === currentGoalId)`.
- **Option C (supplement)**: Workflow events (`workflow:start`, `workflow:phase-complete`, `subagents:completed`, `subagents:failed`) trigger refreshes. The widget maintains a small in-memory mirror populated by these events + the RPC query.

This keeps `TaskStore` as the single source of truth (no parallel task data) while giving the orchestrator a reactive, query-driven phase view. The cost is one new RPC handler (~24 lines) and one new widget class (~280 lines including tests).

## Fix

**pi-tasks side — new RPC endpoint** (`pi-tasks/src/index.ts:185-207`):

```ts
pi.events.on("tasks:rpc:list-by-metadata", (raw: unknown) => {
  const payload = raw as { requestId?: unknown; key?: unknown; value?: unknown };
  if (typeof payload.requestId !== "string" || typeof payload.key !== "string") return;
  const requestId = payload.requestId;
  const key = payload.key;
  const value = payload.value;
  const tasks = store.list().filter((t) => t.metadata?.[key] === value);
  pi.events.emit("tasks:rpc:list-by-metadata:reply:" + requestId, { success: true, data: tasks });
});
```

The envelope shape `{ success, data }` mirrors the existing `pi-subagents` RPC pattern (`subagents:rpc:spawn`, etc.). Malformed requests are silently dropped (no `requestId` to reply to).

**pi-orchestrator side — new widget** (`pi-orchestrator/src/ui/phase-widget.ts`):

- `PhaseWidget` class with `attach()` (subscribes to events), `getState()` (read-only), `render()` (returns `string[]`)
- Pure functions: `computePhasePlan({ max_fix_iterations, max_redesigns })` returns the static plan shape `[{ key: "implement" }, { key: "review", iteration: 1..N }, { key: "merge" }]`. `groupTasksByPhase(tasks)` groups by `(phase, iteration)`, preserving insertion order.
- RPC call: promise-wrapped `bus.emit("tasks:rpc:list-by-metadata", payload)` + listener on `tasks:rpc:list-by-metadata:reply:<id>`.

**Wiring in `installSessionHooks`** (`pi-orchestrator/src/extension.ts:209-249`): instantiate `PhaseWidget({ bus: pi.events })` if `pi.events` is exposed (production); skip silently in test mocks that don't have it. Capture `ctx.ui` on `tool_execution_start` (same pattern pi-tasks uses at `pi-tasks/src/index.ts:557`); register `ui.setWidget("workflow-plan", factory, { placement: "aboveEditor" })` once.

### Render output

```
Workflow Plan: GC-2026-phase-widget
Plan: Implement → Review 1 → Review 2 → Review 3 → Merge (max_fix_iterations=3)
  [Implement]
    ▷ Implement: Align plan/exec worktree namespace (agent abc12def)
  [Review 1]
    ☐ Review 1: Align plan/exec worktree namespace
  [Review 2]
    ☐ Review 2: Align plan/exec worktree namespace
  [Review 3]
    ☐ Review 3: Align plan/exec worktree namespace
  [Merge]
    ☐ Merge: Align plan/exec worktree namespace
Progress: 0/5 planned phases complete
```

Per-phase tasks are listed under their phase row. The plan view shows phases that haven't started yet (no task), in_progress phases (with the spinner glyph), and completed phases. The `metadata.advisorAgentType` field is anticipated for GC-Y but not required for this GC.

### Tests

| File | Tests | Status |
|---|---|---|
| `pi-tasks/test/tasks-rpc-list-by-metadata.test.ts` | 4 tests (filter match, empty match, phase filter, envelope shape) | 4/4 pass |
| `pi-orchestrator/test/ui/phase-widget.test.ts` | 10 tests (`computePhasePlan` × 3, `groupTasksByPhase` × 2, `PhaseWidget` × 5) | 10/10 pass |
| `pi-orchestrator/test/phase-widget-wiring.test.ts` | 4 tests (render shape, event subscription, empty state, source import) | 4/4 pass |

`bun run typecheck` green on both `pi-tasks` and `pi-orchestrator`. Pre-existing failures unchanged from main baseline (8 errors in `pi-tasks` TaskStore list ID resolution + projectKey + sessionTaskFile; 1 error in `pi-orchestrator` catalog subprocess tests).

## Verification

| # | Item | Status |
|---|---|---|
| 1 | `tasks:rpc:list-by-metadata` handler returns filter-matched tasks with envelope | ✓ 4/4 tests |
| 2 | `PhaseWidget.computePhasePlan` matches workflow-graph.ts:280-336 phase shape | ✓ 3/3 tests |
| 3 | `PhaseWidget.groupTasksByPhase` groups by `(phase, iteration)`, preserves insertion order | ✓ 2/2 tests |
| 4 | `PhaseWidget` subscribes to 4 event channels on `attach()` | ✓ test: 4 listener counts |
| 5 | `PhaseWidget` queries pi-tasks via RPC on `workflow:phase-complete` | ✓ test: tasksByPhase populated |
| 6 | `PhaseWidget.render()` returns phase tree lines including goal id | ✓ 1/1 test |
| 7 | `installSessionHooks` registers the widget when `pi.events` is available | ✓ source check + extension-active-tools compatibility |
| 8 | Pre-existing test failures unchanged from main baseline | ✓ same 8 + 1 counts |
| 9 | typecheck green on both packages | ✓ |
| 10 | No catalog regen needed (new file not in any catalog's `_source_files`) | ✓ |
| 11 | postmortem + gc-index | ✓ this file + gc-index.md |

## Effect on the user

The orchestrator now has its own **planning state surface** alongside task and sub-agent state:

- **Task state** — `TaskWidget` (editor-above), `TaskList` command (pi-tasks)
- **Sub-agent execution state** — `AgentWidget`, `FleetList`, `subagent_status` command (pi-subagents)
- **Planning state** — `PhaseWidget` ("workflow-plan" panel, editor-above), reading from `TaskStore` via RPC (pi-orchestrator, this GC)

When a workflow starts, the user sees a phase tree populated with the Implement task, then progressively updated as Review / Fix / Merge tasks land. The widget sits above the editor alongside `TaskWidget` (which shows the same tasks flat) — together they give a phase-grouped view + a task-list view without data duplication.

## Lessons learned

- **Don't build a parallel data model for "missing surface" cases.** The audit phase identified pi-orchestrator's missing surface; the implementation phase reused pi-tasks's existing `TaskStore` as the data source. A new RPC endpoint (~24 lines) + a renderer (~280 lines) is much less than a parallel `WorkflowStateStore` would have been.
- **Cross-extension RPC envelope shape is the unwritten contract.** pi-subagents already established the `{ success, data }` envelope (see `pi-subagents/src/cross-extension-rpc.ts`). The new endpoint reuses it byte-for-byte, including the `requestId` reply channel pattern. Future RPC endpoints in any Sages package should follow the same shape.
- **Test mock fidelity matters.** The first extension.ts wiring attempt broke `extension-active-tools.test.ts` because the test's `MockPi` doesn't expose `pi.events`. The fix is a single-line `if (!eventsBus) return;` guard — the test was deliberately minimal (focused on `setActiveTools`), and the production wiring is best-effort.
- **Plan structure derivation is pure, not data-driven.** `computePhasePlan({ max_fix_iterations, max_redesigns })` is a 10-line pure function. The data-driven alternative (parse `workflow-{id}.yaml` for `current_phase` and look up plan structure) would have been brittle. Computing from the start-payload is correct because the plan shape is determined at workflow:start, not at any later point.

Refs: GC-2026-phase-widget
