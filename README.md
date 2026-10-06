# Sages

Three-layer multi-agent workflow system for [pi](https://pi.dev):

| Layer | Package | Job |
|---|---|---|
| **Planning** | `pi-orchestrator` | Declare intent (`goal_contract_create`); run pipeline (`workflow_run`); control subagents in-flight |
| **Tracking** | `pi-tasks` | Hold the task graph; spawn agents per cascade; emit `workflow:phase-complete` events |
| **Executing** | `pi-subagents` | One agent = one task. 5 default types: `Explore`, `PlanCompiler`, `Developer`, `Reviewer`, `Merger` |

After GC-2026-orchestrator-simplify the orchestrator lost the four
`dag_synthesize` / `task_dispatch` / `orchestrator_audit` /
`sages_reminder` tools. GC-2026-workflow-run added `workflow_run`;
GC-2026-path-B-swap replaced path A's in-process state machine with
this thin event-driven shim.

## How it works

```text
goal_contract_create → .pi/orchestrator/goal-{id}.yaml (with _lock_hash)
        ↓
workflow_run         → pi.events.emit('workflow:start', { workflow_id,
        ↓                    goal_id, goal, max_fix_iterations, worktree_path })
pi-tasks (subscribeWorkflow):
        ├─ buildStaticWorkflowGraph(goal, opts)  (Implement + N Reviews + (N-1) Fixes + Merge)
        ├─ store.create × K  (with metadata.workflow_run_goal_id)
        ├─ wire blockedBy edges with real IDs
        └─ taskExecute([implement_id])             (cascade begins)
                ↓
pi-subagents (5 default agents, one per task):
        Implement (Developer) → Review_1 (Reviewer) → Fix_1 (Developer) →
        Review_2 (Reviewer) → Fix_2 (Developer) → Review_3 (Reviewer) → Merge (Merger)
                ↓
pi-tasks subscribes to subagents:completed:
        ├─ mark task completed + parseReviewerVerdict (review tasks only)
        ├─ emit pi.events 'workflow:phase-complete' (all phases)
        └─ cascade: spawn newly-unblocked tasks
                ↓
workflow_run subscribes to 'workflow:phase-complete':
        ├─ aggregate phases
        └─ resolve WorkflowRunOutput when
              implement + last review CLEAN + merge all done → status: success
              or reviews exhausted max_fix_iterations on NEEDS_WORK → status: blocked
```

### Soft mode policy (GC-2026-031)

Under soft mode the main agent has full tool access (`edit` / `write` /
`aft_edit` / `apply_patch`, plus unrestricted `bash`). Nothing is
mechanically blocked. Sages owns the two workflow tools above
(`goal_contract_create`, `workflow_run`) and four subagent-control
tools (`subagent_status`, `subagent_steer`, `subagent_abort`,
`subagent_resume`); it nudges the main agent toward `workflow_run`
when the active todowrite has more than 2 items, but never blocks.

## Quick start

```bash
# Install the orchestrator and subagent runtime
curl -fsSL https://raw.githubusercontent.com/vanpipy/sages/main/pi-orchestrator/scripts/install.sh | bash

# Open a pi session, then give the agent a goal, for example:
# "Add rate limiting to the login endpoint."
```

The agent guides the work through `goal_contract_create` then either
`workflow_run(goal_path)` (canonical 4-phase pipeline: Implement → Review ⇆ Fix → Merge) or
`TaskCreate × N` + `TaskExecute([first_id])` (escape hatch for
non-standard shapes). Example goal contracts live in
`pi-orchestrator/skills/orchestrator/templates/goals/` (note: legacy
templates referencing the deleted DAG tools still exist there; the
schema is `done_definition`, not `success_criteria`).

## Repository layout

| Package | Purpose |
|---|---|
| `pi-orchestrator/` | Planning layer: `goal_contract_create` + `workflow_run` + 4 subagent-control tools; orchestrator advisory; session hooks (`session_start` `setActiveTools`, `before_agent_start` prompt overlay, `tool_call` soft-mode reminder) |
| `pi-tasks/` | Tracking layer: TaskStore + TaskCreate/List/Get/Update/Output/Stop/Execute; static workflow graph + cascade + `subscribeWorkflow` |
| `pi-subagents/` | Executing layer: agent lifecycle (5 default types), managed worktrees, background execution, result collection, `AgentManager` singleton |
| `pi-codebase-memory/` | Code knowledge graph MCP server |
| `pi-evaluator/` | Evaluation metrics for cost, security, and text quality (currently path-A-shaped — see GC-2026-evaluator-path-B follow-up) |

## Where to learn more

- **Agent operational guide:** [AGENTS.md](AGENTS.md)
- **Agent tool description (LLM-visible):** [`pi-orchestrator/templates/agent-tool-description.md`](pi-orchestrator/templates/agent-tool-description.md)
  (installed to `~/.pi/agent/agent-tool-description.md`)
- **Workflow skill:** [`pi-orchestrator/skills/orchestrator/SKILL.md`](pi-orchestrator/skills/orchestrator/SKILL.md)

## `.pi/orchestrator/` namespace ownership

| Role | May write |
|---|---|
| `Developer` | `task-{task_id}-report.md`, `handoff/{workspace_id}/{task_id}-handoff.md` |
| `Reviewer` | `last-review-{goal_id}.md` |
| Orchestrator | `goal-{id}.yaml`, `workflow-{goal_id}.yaml`, `audit-state-{id}.yaml` |

Cross-namespace overwrites prohibited. `Explore` and `PlanCompiler` are read-only.

## Security and license

Sages runs in **soft mode**: no commands are mechanically blocked and
the main agent has full tool access. For production-code changes on
workflows with >2 items in the active todowrite, the recommended
pattern is `goal_contract_create` → `workflow_run(goal_path)` (or
equivalently dispatching `Developer` with a managed worktree) — this
keeps the TDD discipline, worktree isolation, and 5-dim review
trail. For ≤2-item workflows direct editing is also acceptable. See
[AGENTS.md § Red lines](AGENTS.md#red-lines) for the remaining
operational constraints.

`MIT` — see [LICENSE](LICENSE).

## History

Earlier versions used four role-named tools inspired by the four sages
of Chinese mythology, plus an FSM-style orchestrator. After the
2026-10-01 GC-2026-path-B-swap, the runtime is two orchestrator tools
(`goal_contract_create`, `workflow_run`) + four subagent-control
tools; orchestration logic lives in `pi-tasks` (`subscribeWorkflow`),
not in the orchestrator. See `pi/docs/postmortem/GC-2026-path-B-*.md`
for the migration write-up.

