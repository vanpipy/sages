---
name: orchestrator
description: "Soft-infrastructure layer for pi. Wires session_start (curates the tool allowlist), before_agent_start (prepends the orchestrator constitution), and tool_call (once-per-session soft-mode reminder). Owns three LLM-facing tools: `task_inspect` (read type+status+agentType so the LLM can route), `task_consume` (read+parse verdict for completed plan tasks), and `task_convert_intent` (the unique intent→plan converter). The LLM adds tasks via pi-tasks's `TaskCreate` (with `type` set to 'intent' or 'plan') and dispatches via `TaskExecute`. The orchestrator does not manage the task flow — it only reads and adds; convertIntent is its only state-changing write, and only within the intent→plan conversion path."
---

# Orchestrator — Soft Infrastructure

The orchestrator plays the **Task Orchestrator** role in the three-package
composition: a **consumer** of the Task Board (`pi-tasks/`), not its
manager. It adds tasks via pi-tasks's existing `TaskCreate` (with
`type` set to `'intent' | 'plan'`) and reads them via `task_inspect` /
`task_consume`. The Task Executor (`pi-subagents/`) is spawned by the
board via `TaskExecute`, never sees the board itself, and reports
results back through the event bus. The boundary is enforced by the
host tool allowlist, not by convention. See
[`AGENTS.md`](../../../AGENTS.md#the-three-packages-and-their-roles)
for the full role description.

These role names (Task Board / Task Orchestrator / Task Executor) are
descriptive shorthand; they appear in docs and conversation but not in
the packages' own code.

Post GC-2026-orchestrator-simplify + GC-2026-remove-workflow-run-prod +
GC-2026-decompose-task-removed + **chore/remove-goal-contract** +
**taskBoard-removed** the orchestrator owns exactly **three** LLM-facing
tools: `task_inspect` (route by type/status), `task_consume` (read+parse
verdict), and `task_convert_intent` (the unique intent→plan converter).
The orchestrator is a consumer — it does not manage the task flow.

## What the orchestrator does

| Concern | Mechanism |
|---|---|
| **Tool allowlist at session_start** | `pi.setActiveTools([...PI_TASKS, ...SUBAGENT, ...AFT, ...BASELINE])`. None of those tools are owned by the orchestrator (they come from pi-subagents, pi-tasks, @cortexkit/aft-pi, pi-coding-agent itself); the orchestrator only curates the allowlist. |
| **Constitution overlay at before_agent_start** | Prepends `templates/SYSTEM.md` to the LLM's system prompt. The system prompt is the orchestrator's only persistent instruction surface. |
| **Soft-mode reminder on first side-effecting call** | On the first `bash` / `edit` / `write` tool call per session, appends a reminder that recommends the pi-tasks workflow for active task lists of >2 items. Fires once per session; subsequent calls are silent. |
| **Post-tool advisory nudges** | On every tool call, the `repeat_call_chain` detector fires when the same `(tool, args)` pair is seen ≥3 times within 2s — a generic stuck-on-same-call detector. Findings are appended via `pi.appendEntry("system", ...)`. |
| **`task_inspect(task_id)` tool** | Read type+status+agentType. The LLM's first call on every task. Routes to `task_convert_intent` (intent), `TaskExecute` (plan pending), `TaskOutput(block=true)` (plan in_progress), or `task_consume` (plan completed). Lighter than `TaskGet`. |
| **`task_consume(task_id, include_transcript?)` tool** | Read a completed plan task in a structured way. Parses the Reviewer's 4-state verdict (`CLEAN` / `NEEDS_WORK` / `NEEDS_REDESIGN` / `NEEDS_CLARIFICATION`) from the result text and emits a verdict-tailored follow-up suggestion. Returns `{ id, subject, status, agentType, result, verdict?, read_at, follow_up_suggestion? }`. Pure read — does not mutate the store. Intent tasks throw `not_plan` — call `task_convert_intent` first. |
| **`task_convert_intent(intent_task_id, plan)` tool** | The orchestrator's unique intent → plan conversion operator. Reads an intent task (`type='intent'`), marks it converted (audit: `metadata.converted / metadata.converted_at`), creates a new plan task with `type='plan'`, `agentType` from the spec, and `metadata.source_intent` linking back to the intent. Refuses non-intent sources and already-converted intents. |
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

Multi-stage work is the LLM's job. The canonical flow is
**inspect → route**:

```text
// 1. /tasks create "Add /login endpoint" — user-facing intent task appears
2.   TaskList → [{ id: 1, subject: "Add /login endpoint", type: "intent" }]
3.   task_inspect({ task_id: 1 })
     → { id: 1, type: "intent", status: "pending", ... }
4.   // LLM thinks + plans: agentType=Developer, no blocks/blockedBy
5.   task_convert_intent({ intent_task_id: 1, plan: { agentType: "Developer" } })
     → plan task #2 created, intent #1 marked converted
7.   TaskExecute([2])  // dispatches the plan task to a subagent
8.   // subagent completes → orchestrator's next turn:
9.   task_inspect({ task_id: 2 })
     → { id: 2, type: "plan", status: "completed", agentType: "Developer", hasResult: true }
10.  task_consume({ task_id: 2 })
     → { id, subject, result, verdict?, follow_up_suggestion? }
```

The Reviewer emits one of CLEAN / NEEDS_WORK / NEEDS_REDESIGN /
NEEDS_CLARIFICATION as plain text in its own result. `task_consume`'s
verdict parser extracts it and `suggestFollowUp` emits a verdict-tailored
next-step hint (spawn Developer follow-up / spawn new Implement /
pause for user / move on).

The orchestrator's `task_inspect` is the LLM's first call on every
task — it sees the type without erroring, then routes explicitly.

## Soft mode (unchanged)

> Nothing is mechanically blocked.
> Pick the path that matches the work shape.
> If the active task list has >2 items, the soft-mode reminder fires once
> at the first side-effecting call. It's a recommendation, not a rule.