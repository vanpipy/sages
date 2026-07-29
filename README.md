# Sages

Multi-agent workflow system for [pi](https://pi.dev). Sages turns a goal into a
validated DAG, delegates implementation and verification to specialized agents,
and audits the result before declaring the workflow complete.

## How it works

```text
goal_contract_create → .pi/orchestrator/goal-{id}.yaml
        ↓
dag_synthesize       → .pi/orchestrator/dag-{id}.yaml
        ↓
task_dispatch        → Agent-call plan (the main agent executes it)
        ↓
developer / auditor  → /tmp/pi-subagents-.../tasks/<id>.output
        ↓
orchestrator_audit   → .pi/orchestrator/audit-workflow.md
```

The Sages extension owns the four workflow tools and a two-layer gate that
prevents the main agent from writing production code directly. `pi-subagents`
owns agent spawning, managed worktrees, background execution, and result
collection.

## Quick start

```bash
# Install the orchestrator and subagent runtime
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi/scripts/install.sh | bash

# Open a pi session, then give the agent a goal, for example:
# "Add rate limiting to the login endpoint."
```

The agent guides the work through goal → DAG → dispatch → audit. Example goal
contracts live in `pi/skills/orchestrator/templates/goals/` and are installed to
`~/.pi/agent/goals/`.

## Repository layout

| Package | Purpose |
|---|---|
| `pi/` | Main orchestrator: four-tool workflow and main-agent safety gates |
| `pi-subagents/` | Agent runtime: subagent lifecycle and managed worktrees |
| `pi-codebase-memory/` | Code knowledge graph MCP server |
| `pi-evaluator/` | Evaluation metrics for cost, security, and text quality |
| `pi-minimax/` | MiniMax AI integration |
| `pi-yunxiao/` | Alibaba Cloud DevOps integration |

## Where to learn more

- **Agent operational guide:** [AGENTS.md](AGENTS.md)
- **Subagent dispatch reference:** [`pi/templates/SUBAGENTS.md`](pi/templates/SUBAGENTS.md)
  (installed to `~/.pi/agent/SUBAGENTS.md`)
- **Workflow skill:** [`pi/skills/orchestrator/SKILL.md`](pi/skills/orchestrator/SKILL.md)

## `.pi/orchestrator/` namespace ownership

Developers may write `task-{task_id}-report.md` and
`handoff/{workspace_id}/{task_id}-handoff.md`; auditors may write
`audit-{task_id}.md`. L3 alone owns `goal-{id}.yaml`, DAG, audit-state, and
workflow rollup files. Cross-namespace overwrites are prohibited; Explore and
Plan remain read-only.

## Security and license

The main agent delegates production changes through managed worktrees rather
than writing them directly. See [AGENTS.md § Red lines](AGENTS.md#red-lines) for
the operational constraints.

`MIT` — see [LICENSE](LICENSE).

## History

Earlier versions used four role-named tools inspired by the four sages of
Chinese mythology, plus an FSM-style orchestrator. The current four-tool DAG
runtime replaced that design on 2026-07-24; migration notes live in
`pi/skills/audit-notes/`.
