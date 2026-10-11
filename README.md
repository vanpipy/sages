# Sages

Three-layer multi-agent workflow system for [pi](https://pi.dev):

| Layer | Package | Job |
|---|---|---|
| **Planning** | `pi-orchestrator` | One LLM-facing tool (`orchestrate`) materializes a multi-phase plan as a task DAG; session hooks curate the tool allowlist + prepend a constitution + fire the once-per-session soft-mode reminder; `/brainstorm` slash command drives the 5-phase design flow |
| **Tracking** | `pi-tasks` | Holds the DAG (file-backed `TaskStore` with locking); drives cascade via `TaskExecute`; renders the persistent task widget above the editor; injects system-reminder nudges |
| **Executing** | `pi-subagents` | Spawns agents as detached pi sessions; `AgentManager` manages two concurrency pools (foreground / background), optional git-worktree isolation, mid-run steering, result collection; ships the script-based workflow runtime (`SubagentWorkflow`) |

The orchestrator owns **one** LLM-facing tool (`orchestrate`). It also
owns four subagent-control tools (`subagent_status`, `subagent_steer`,
`subagent_abort`, `subagent_resume`) that reach the same `AgentManager`
singleton that powers the `Agent` tool. The orchestrator curates the
tool allowlist at `session_start` but does not mediate the workflow —
pi-tasks owns "run the DAG", pi-subagents owns "run a single task", the
LLM in the main session is the only entity that decides shape.

## How it works

```text
LLM in main session (Task Orchestrator)
        │
        │ orchestrate(plan) OR raw TaskCreate × N
        ▼
pi-tasks TaskStore at <cwd>/.pi/tasks/tasks.json  (Task Board)
        │
        │ TaskExecute on first ready task
        ▼
pi.events subagents:rpc:spawn  (cross-extension RPC)
        │
        ▼
pi-subagents AgentManager        (Task Executor)
        ├─ pool: foreground | background (max 10 background)
        ├─ optional git worktree at /tmp/pi-agent-{id}-{uuid}
        └─ spawns detached pi session running the chosen agent type
                │
                │  (subagent runs TDD, edits files, runs tests)
                ▼
            subagent finishes
                │
                │ pi.events subagents:completed { id, result }
                ▼
pi-tasks subagents:completed listener
        ├─ store.update(taskId, { status: "completed", metadata: { result } })
        ├─ if autoCascade: find unblocked dependents with agentType, fan out
        └─ notify LLM via system-reminder injection
                │
                ▼
LLM in main session reads TaskOutput, decides next step
(creates more tasks, declares done, or spawns a Fix Developer)
```

### Soft mode policy (GC-2026-031)

Under soft mode the main agent has full tool access (`edit` / `write` /
`apply_patch`, plus unrestricted `bash`). Nothing is mechanically blocked.
Sages owns the orchestrator tool (`orchestrate`) and four
subagent-control tools; it nudges the main agent toward
`TaskCreate × N` + `TaskExecute` when the active todowrite has more
than 2 items, but never blocks.

## Quick start

```bash
# Install the orchestrator and subagent runtime
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi-orchestrator/scripts/install.sh | bash

# Open a pi session, then give the agent a task, for example:
# "Add rate limiting to the login endpoint."
```

The agent drives the work through `TaskCreate` × N + `TaskExecute`
(with `agentType: "Developer"` for Implement, `agentType: "Reviewer"`
for Review). For the standard 2-phase shape, `orchestrate(plan)`
collapses both TaskCreate calls into one. The Reviewer emits one of
CLEAN / NEEDS_WORK / NEEDS_REDESIGN / NEEDS_CLARIFICATION in its
result; the main LLM reads it via `TaskOutput` and decides next step.

## Repository layout

| Package | Purpose |
|---|---|
| `pi-orchestrator/` | Planning layer: `orchestrate` tool + 4 subagent-control tools; session hooks (`session_start` `setActiveTools`, `before_agent_start` prompt overlay, `tool_call` soft-mode reminder); `/brainstorm` slash command |
| `pi-tasks/` | Tracking layer: TaskStore with file locking + the persistent task widget + system-reminder cadence; 7 tools (`TaskCreate`/`TaskList`/`TaskGet`/`TaskUpdate`/`TaskOutput`/`TaskStop`/`TaskExecute`) |
| `pi-subagents/` | Executing layer: `AgentManager` (concurrency pools, lifecycle, worktree isolation, mid-run control); ships `Developer` + `Reviewer` as built-in defaults; script-based workflow runtime under `src/workflow/`; cross-extension RPC bridge to pi-tasks |
| `pi-codebase-memory/` | Code knowledge graph MCP server |
| `pi-evaluator/` | Evaluation metrics for cost, security, and text quality (currently path-A-shaped — see GC-2026-evaluator-path-B follow-up) |

## Where to learn more

- **Agent operational guide:** [AGENTS.md](AGENTS.md)
- **Agent tool description (LLM-visible):** [`pi-orchestrator/templates/agent-tool-description.md`](pi-orchestrator/templates/agent-tool-description.md)
  (installed to `~/.pi/agent/agent-tool-description.md`)
- **Workflow skill:** [`pi-orchestrator/skills/orchestrator/SKILL.md`](pi-orchestrator/skills/orchestrator/SKILL.md)

## Security and license

Sages runs in **soft mode**: no commands are mechanically blocked and
the main agent has full tool access. For production-code changes on
workflows with >2 items in the active todowrite, the recommended
pattern is `TaskCreate` × N + `TaskExecute` (or the `orchestrate`
shortcut for the standard Implement → Review shape) — this maintains
the TDD discipline, worktree isolation, and Reviewer evidence trail.
For ≤2-item workflows direct editing is also acceptable. See
[AGENTS.md § Red lines](AGENTS.md#red-lines) for the remaining
operational constraints.

`MIT` — see [LICENSE](LICENSE).

## History

Earlier versions used role-named tools inspired by the four sages of
Chinese mythology, plus an FSM-style orchestrator that mediated every
workflow via a goal-contract + workflow-runner pair. After the
2026-10-01 sweep (`chore/remove-goal-contract`,
`GC-2026-remove-workflow-run-prod`, `GC-2026-decompose-task-removed`)
the orchestrator owns one tool (`orchestrate`); workflow logic lives
in pi-tasks (the cascade) and pi-subagents (`AgentManager`), not in
the orchestrator.