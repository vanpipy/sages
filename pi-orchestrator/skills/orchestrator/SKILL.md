---
name: orchestrator
description: Soft-infrastructure layer for pi. Wires session_start (curates the tool allowlist), before_agent_start (prepends the orchestrator constitution), and tool_call (once-per-session soft-mode reminder). Owns one LLM-facing tool: `orchestrate(plan)` which materializes a multi-phase workflow as a task DAG in pi-tasks's shared task store. The LLM still drives raw `TaskCreate` × N + `TaskExecute` directly when it wants full control; `orchestrate` is the convenience path for whole-plan-at-once creation with automatic dependency wiring.
---

# Orchestrator — Soft Infrastructure

The orchestrator plays the **Task Orchestrator** role in the three-package
composition: the sole writer and sole consumer of the Task Board
(`pi-tasks/`). The Task Executor (`pi-subagents/`) is spawned through
it, never sees the Board, and reports results back through the event
bus. The boundary is enforced by the host tool allowlist, not by
convention. See [`AGENTS.md`](../../../AGENTS.md#the-three-packages-and-their-roles)
for the full role description.

These role names (Task Board / Task Orchestrator / Task Executor) are
descriptive shorthand; they appear in docs and conversation but not in
the packages' own code.

Post GC-2026-orchestrator-simplify + GC-2026-remove-workflow-run-prod +
GC-2026-decompose-task-removed + **chore/remove-goal-contract** the
orchestrator owns exactly **one** LLM-facing tool (`orchestrate`).
The orchestrator's other surface is a curating + advising layer.

## What the orchestrator does

| Concern | Mechanism |
|---|---|
| **Tool allowlist at session_start** | `pi.setActiveTools([...PI_TASKS, ...SUBAGENT, ...AFT, ...BASELINE])`. None of those tools are owned by the orchestrator (they come from pi-subagents, pi-tasks, @cortexkit/aft-pi, pi-coding-agent itself); the orchestrator only curates the allowlist. |
| **Constitution overlay at before_agent_start** | Prepends `templates/SYSTEM.md` to the LLM's system prompt. The system prompt is the orchestrator's only persistent instruction surface. |
| **Soft-mode reminder on first side-effecting call** | On the first `bash` / `edit` / `write` tool call per session, appends a reminder that recommends the pi-tasks workflow for active task lists of >2 items. Fires once per session; subsequent calls are silent. |
| **Post-tool advisory nudges** | On every tool call, the `repeat_call_chain` detector fires when the same `(tool, args)` pair is seen ≥3 times within 2s — a generic stuck-on-same-call detector. Findings are appended via `pi.appendEntry("system", ...)`. |
| **`orchestrate(plan)` tool** | The orchestrator's only LLM-facing tool. Materializes a multi-phase workflow as a task DAG in pi-tasks's shared task store (`<ORCHESTRATOR_WORKDIR>/<projectKey(cwd)>/tasks/tasks.json`, resolved via `pi-tasks/src/task-paths.ts:orchestratorProjectTaskFile`). For each phase, creates a task carrying `agentType` in metadata; phase-level `blockedBy` (by subject) is resolved to task IDs and wired into both sides of the edge. After the call, the standard cascade (via `TaskExecute` on the first ready task) drives the phases in dependency order. The LLM can still use raw `TaskCreate` × N + `TaskExecute` for full control; `orchestrate` is the convenience path for whole-plan-at-once creation with auto-wired dependencies. |
| **Brainstorming slash command** | `/brainstorm [request]` is registered separately via `skills/brainstorming/SKILL.md`; the orchestrator's own registration machinery is limited to the session hooks + advisory handlers above. |

## What the orchestrator no longer does

- It does **not** own `goal_contract_create`, `workflow_run`, or any other removed tool.
  (Note: `decompose_task` was retired earlier; `orchestrate` is its
  spiritual successor — same DAG-creation semantics, but driven by
  a single tool call rather than an RPC event chain.)
- It does **not** write any per-goal state file at the project root.
  The previous `.pi/orchestrator/goal-*.yaml`,
  `.pi/orchestrator/audit-state-*.yaml`, and `.pi/orchestrator/decompose-*.yaml`
  files are retired (see chore/orchestrator-workdir-tmpdir + chore/remove-goal-contract).
- It does **not** enforce any anti-patterns. The previous `goal_drift_detected`
  rule (which required an active goal contract) is removed along with the
  orchestrator-namespace ownership + loadGoalScope machinery.

## The LLM's responsibility

Multi-stage work is the LLM's job. The canonical 2-phase pattern:

```text
// raw TaskCreate × N + TaskExecute
TaskCreate({ subject: "Implement", agentType: "Developer", blocks: ["Review"] })
TaskCreate({ subject: "Review",    agentType: "Reviewer",  blockedBy: ["Implement"] })
TaskExecute  // auto-cascades through every phase

// or the same DAG via the orchestrate shortcut
orchestrate({
  intent: "Add feature X",
  phases: [
    { subject: "Implement", agentType: "Developer" },
    { subject: "Review",    agentType: "Reviewer", blockedBy: ["Implement"] },
  ],
})
```

The Reviewer reads the Implement task's `metadata.result` via `TaskOutput`
and emits one of CLEAN / NEEDS_WORK / NEEDS_REDESIGN /
NEEDS_CLARIFICATION as plain text in its own result. The orchestrator
(the main LLM) reads the verdict via `TaskOutput` and decides whether
to declare done or to spawn a follow-up Fix task (with
`agentType: "Developer"`, blockedBy the Review) by hand.

## Soft mode (unchanged)

> Nothing is mechanically blocked.
> Pick the path that matches the work shape.
> If the active task list has >2 items, the soft-mode reminder fires once
> at the first side-effecting call. It's a recommendation, not a rule.