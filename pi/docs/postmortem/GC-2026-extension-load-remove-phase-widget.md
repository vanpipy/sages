---
gc_id: GC-2026-extension-load-remove-phase-widget
title: Remove orphaned phase plan widget (workflow_run-only UI)
severity: minor
---

## What happened

The "Workflow Plan: (no active workflow)" widget that rendered above
the chat input was a leftover from the `workflow_run`-only era. After
GC-2026-task-feeding-and-decomposition, tasks enter through multiple paths
(`workflow_run`'s static graph, `decompose_task`'s linear chains,
`/tasks create`'s atomic user tasks). The phase plan widget tracked
ONLY the `workflow_run` pipeline via
`metadata.workflow_run_goal_id` — it could not see `decompose_task`
chains, decompose R1 Reviewers, or `/tasks create` user tasks. The
visible "(no active workflow)" placeholder was the empty state of a
surface that no longer matched the actual task topology.

The widget was rendered by `pi-orchestrator/src/ui/phase-widget.ts`,
registered in `extension.ts` as `ui.setWidget("workflow-plan", ...)`,
and queried pi-tasks via the `tasks:rpc:list-by-metadata` RPC
(`pi-tasks/src/index.ts:189-208`). After task feeding shipped, the widget
had no consumer — the user would only see the empty-state line.

## What was deleted

- `pi-orchestrator/src/ui/phase-widget.ts` — the widget class itself
  (`PhaseWidget`, `computePhasePlan`, `groupTasksByPhase`).
- `pi-orchestrator/test/ui/phase-widget.test.ts` — 10 unit tests for
  `computePhasePlan`, `groupTasksByPhase`, and `PhaseWidget`.
- `pi-orchestrator/test/phase-widget-wiring.test.ts` — 4 wiring tests
  (render shape, event subscription, source-import assertion).
- The `if (eventsBus) { ... }` block in `extension.ts` that
  instantiated `PhaseWidget` and called `ui.setWidget("workflow-plan", ...)`.
- The `pi.events.on("tasks:rpc:list-by-metadata", ...)` handler in
  `pi-tasks/src/index.ts` (and its `tasks-rpc-list-by-metadata.test.ts`).
  No other consumer existed for this RPC after the widget's removal.

## What stays

`TaskWidget` (pi-tasks) continues to render the full task state in
the panel below the input. `AgentWidget` (pi-subagents) covers
sub-agent lifecycle. Together they cover every task feeding path
(user-created / orchestrator-created / workflow-graph / decompose-chain).
No replacement widget is needed — the user's mental model
("tasks on the left, agents on the right, plan above") simplifies to
"tasks + agents; the plan IS the task list".

## Follow-ups

- **`orchestrator:advisory` narrative**: the orchestrator's soft-mode
  reminder (`extension.ts:281-289`) still references "the pi-tasks
  workflow" — should be reworded to reference task feeding rather
  than a specific pipeline. Deferred to a doc follow-up.
- **SKILL.md / AGENTS.md**: any reference to the phase widget or
  "workflow-plan" panel should be removed. Same doc follow-up.