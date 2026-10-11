---
name: orchestrator
description: Soft-infrastructure layer for pi. Wires session_start (curates the tool allowlist), before_agent_start (prepends the orchestrator constitution), and tool_call (once-per-session soft-mode reminder). Post chore/remove-goal-contract the orchestrator owns zero tools of its own — the LLM is responsible for driving any multi-stage work via raw `TaskCreate` × N + `TaskExecute` directly, with `agentType` set to `"Developer"` / `"Reviewer"` / `"Fix"` / `"MergerAdvisor"` per phase. The orchestrator advisory pipeline emits informational nudges via `pi.appendEntry("system", ...)`.
---

# Orchestrator — Soft Infrastructure

Post GC-2026-orchestrator-simplify + GC-2026-remove-workflow-run-prod +
GC-2026-decompose-task-removed + **chore/remove-goal-contract** the
orchestrator owns **zero tools**. It exists as a curating + advising
layer only.

## What the orchestrator does

| Concern | Mechanism |
|---|---|
| **Tool allowlist at session_start** | `pi.setActiveTools([...PI_TASKS, ...SUBAGENT, ...AFT, ...BASELINE])`. None of those tools are owned by the orchestrator; they come from pi-subagents, pi-tasks, @cortexkit/aft-pi, and pi-coding-agent itself. |
| **Constitution overlay at before_agent_start** | Prepends `templates/SYSTEM.md` to the LLM's system prompt. The system prompt is the orchestrator's only persistent instruction surface. |
| **Soft-mode reminder on first side-effecting call** | On the first `bash` / `edit` / `write` tool call per session, appends a reminder that recommends the pi-tasks workflow for active task lists of >2 items. Fires once per session; subsequent calls are silent. |
| **Post-tool advisory nudges** | On every tool call, the `repeat_call_chain` detector fires when the same `(tool, args)` pair is seen ≥3 times within 2s — a generic stuck-on-same-call detector. Findings are appended via `pi.appendEntry("system", ...)`. |
| **Brainstorming slash command** | `/brainstorm [request]` is registered separately via `skills/brainstorming/SKILL.md`; the orchestrator's own registration machinery is limited to the session hooks + advisory handlers above. |

## What the orchestrator no longer does

- It does **not** own `goal_contract_create`, `decompose_task`, `workflow_run`, or any other tool.
- It does **not** write any per-goal state file. The previous `.pi/orchestrator/goal-*.yaml`,
  `.pi/orchestrator/audit-state-*.yaml`, and `.pi/orchestrator/decompose-*.yaml`
  files are retired (see chore/orchestrator-workdir-tmpdir + chore/remove-goal-contract).
- It does **not** enforce any anti-patterns. The previous `goal_drift_detected`
  rule (which required an active goal contract) is removed along with the
  orchestrator-namespace ownership + loadGoalScope machinery.

## The LLM's responsibility

Multi-stage work — anything that warrants a 4-phase shape — is the LLM's
job now. The canonical pattern:

```text
TaskCreate({ subject: "Implement", agentType: "Developer", blocks: ["Review"] })
TaskCreate({ subject: "Review",   agentType: "Reviewer", blockedBy: ["Implement"], blocks: ["Fix", "Merge"] })
TaskCreate({ subject: "Fix",      agentType: "Fix",      blockedBy: ["Review"] })
TaskCreate({ subject: "Merge",    agentType: "MergerAdvisor", blockedBy: ["Fix"] })
TaskExecute  // auto-cascades through every phase
```

The orchestrator's only support during this cascade is the `repeat_call_chain`
nudge if the LLM starts looping on `TaskCreate({...})` with identical args.

## Soft mode (unchanged)

> Nothing is mechanically blocked.
> Pick the path that matches the work shape.
> If the active task list has >2 items, the soft-mode reminder fires once
> at the first side-effecting call. It's a recommendation, not a rule.