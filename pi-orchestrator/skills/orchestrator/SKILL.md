---
name: orchestrator
description: Orchestrate multi-task workflows via workflow_run (canonical pipeline) or pi-tasks TaskCreate × N (escape hatch). Coordinates `Developer` / `Reviewer` subagents for execution; pi-tasks drives the cascade. After GC-2026-orchestrator-simplify + GC-2026-path-B-swap the orchestrator owns only `goal_contract_create` + `workflow_run` + 4 subagent-control tools.
---

# Orchestrator — Three-Layer Workflow Coordinator

## Role

Sages is a three-layer workflow system. Each layer has one job:

| Layer | Package | Job |
|---|---|---|
| **Planning** | `pi-orchestrator` | Declare intent (`goal_contract_create`); run pipeline (`workflow_run`); control subagents in-flight (`subagent_status`/`subagent_steer`/`subagent_abort`/`subagent_resume`) |
| **Tracking** | `pi-tasks` | Hold the task graph (`TaskStore`); spawn agents per cascade; emit `workflow:phase-complete` events |
| **Executing** | `pi-subagents` | One agent = one task. 5 default types: `Explore`, `PlanCompiler`, `Developer`, `Reviewer`, `Merger` |

**You (the orchestrator) own layer 1.** Layers 2 and 3 are reactive — they don't think, they execute.

You do NOT write code, search files, or run tests yourself. You delegate to subagents.

## When to Use

Use this skill when the user asks for any of:

- "Refactor X" (multi-file, multi-decision)
- "Add feature Y" (cross-cuts multiple modules)
- "Investigate and fix Z" (needs discovery + change + verification)
- "Migrate W" (systematic, multi-step)

For single trivial tasks (one-line edit, single function), handle directly. No skill needed.

## Mode Indicator

```
**Orchestrator Mode** (Soft mode — GC-2026-031)
- Main agent has full tool access (edit / write / aft_edit / apply_patch, unrestricted bash). Nothing is blocked.
- ≥2 items in active task list: drive via workflow_run (canonical) OR TaskCreate × N (escape hatch). ≤2 items: direct edit / write / bash.
- workflow_run emits workflow:start → pi-tasks drives cascade → workflow_run waits for workflow:phase-complete → returns WorkflowRunOutput.
- Reviewer verdict (CLEAN / NEEDS_WORK) drives Fix loop; budget = max_fix_iterations.
- GC-2026-path-B-swap deleted the 1060-line state machine; orchestration is now event-driven.
```

## The 5 subagents

| Type | Background | Use |
|---|---|---|
| `Explore` | foreground (short) | Bounded read-only search |
| `PlanCompiler` | foreground (short) | Compile a self-contained Planning Brief into an ordered plan |
| `Developer` | background | TDD implementation: RED → GREEN → REFACTOR + commit discipline |
| `Reviewer` | background | 5-dim review (correctness / completeness / scope / anti-goal / documentation); emits `verdict: CLEAN | NEEDS_WORK` |
| `Merger` | background | Cross-workspace merge commit + branch push |

`git-expert` was retired (GC-2026-091). `Auditor` was renamed to `Reviewer` (GC-2026-rename-auditor). `general-purpose` was removed (DAG-2026-011 Phase C).

`defaultRunInBackground()` in `pi-subagents/src/agent-manager.ts` is the source of truth for which agents run background by default.

## Workflow: canonical pipeline (`workflow_run`)

When the work fits the 5-phase pipeline (Implement → Review ⇆ Fix → Merge), use `workflow_run`:

```
1. goal_contract_create → .pi/orchestrator/goal-{id}.yaml (intent + SHA-256 lock)
2. workflow_run(goal_path: ".pi/orchestrator/goal-{id}.yaml") → blocks until pipeline completes
   - emits workflow:start → pi-tasks builds static graph (Implement + N Reviews + (N-1) Fixes + Merge)
   - pi-tasks TaskCreate × K + wires blockedBy edges + TaskExecute([implement])
   - cascade: each subagents:completed spawns newly-unblocked tasks
   - pi-tasks emits workflow:phase-complete for every phase (implement/review/fix/merge)
   - workflow_run aggregates events; resolves WorkflowRunOutput when:
     * implement + last review CLEAN + merge all completed → status: success
     * reviews exhausted max_fix_iterations on NEEDS_WORK → status: blocked
3. LLM reads the WorkflowRunOutput JSON; reports to user
```

The tool description lives at `pi-orchestrator/templates/agent-tool-description.md` (installed as `~/.pi/agent/agent-tool-description.md`).

### Goal contract schema

`goal_contract_create` accepts:

```yaml
id: "GC-XXXX-NNN"          # required, matches ^GC-[0-9a-zA-Z-]+$
title: "<≤120 chars>"        # required
rationale: "<why>"           # optional but recommended for anti-cheat
anti_goals: ["...", "..."]    # required (can be empty)
scope:
  include: ["..."]          # files / modules in scope
  exclude: ["..."]          # files / modules excluded
constraints:
  must_use_existing_patterns: <bool>
  max_dependency_additions: <int 0-100>
  test_coverage_min: <int 0-100>
  typecheck_required: <bool>
  lint_required: <bool>
done_definition: "<≥10 chars>"  # required
```

After GC-2026-orchestrator-simplify, success_criteria[] / verification_cmd[] are gone. The Reviewer reads `done_definition` directly and judges against it.

## Workflow: escape hatch (pi-tasks TaskCreate × N)

For non-standard work (multi-package coordination, conditional branches, parallel tracks), bypass `workflow_run` and drive pi-tasks directly:

```
1. goal_contract_create → .pi/orchestrator/goal-{id}.yaml
2. TaskCreate × N — each task has:
   - subject, description (rich prompt)
   - agentType: "Developer" | "Reviewer" | "Merger" | "Explore" | "PlanCompiler"
   - blockedBy: [task_id, ...]   (cascade prerequisite)
   - metadata.workflow_run_goal_id: goal.id   (optional — for tracking)
3. TaskExecute([first_task_id]) — auto-cascade fires on each subagents:completed
4. TaskList → see live progress
5. subagent_status / subagent_steer / subagent_abort / subagent_resume as needed
```

This is what workflow_run does internally — emitting `workflow:start` is equivalent to `TaskCreate × K + TaskExecute([implement])`. The escape hatch exists for shapes that don't fit the 5-phase pipeline.

## Pipeline pattern (static graph + Fix-on-demand cascade)

Default `max_fix_iterations=3` produces a **5-task static graph** for the canonical pipeline:

```
Implement ─→ Review_1 ─→ Review_2 ─→ Review_3 ─→ Merge
```

For `max_fix_iterations=N`: the static graph is `Implement + N Reviews + Merge` = `N + 2` tasks. For `max_fix_iterations=1`: `Implement + Review_1 + Merge` (3 tasks).

**Fix tasks are created on demand**, not in the static graph. The cascade handler in `pi-tasks`'s `subscribeWorkflow` emits a `workflow:phase-complete` event with `phase: "fix"` whenever a Review verdict of `NEEDS_WORK` triggers a Fix dispatch (one Fix per NEEDS_WORK cycle, capped by `max_fix_iterations`). The orchestrator's `WorkflowRunOutput.tasks_total` in the streaming progress payload reports an **upper bound** (`1 + 2*max_fix_iterations + 1`) so the progress bar never hits 100% while Fix tasks are still queued.

Every Fix task reads its `blockedBy` Review task's `metadata.verdict` via `TaskGet`:
- `verdict === "CLEAN"` → no Fix needed; cascade moves on to the next Review (or Merge if last)
- `verdict === "NEEDS_WORK"` → address findings[] in severity order, then the next Review re-checks

Every Review_2+ reads the prior Fix task's commit to see what changed before re-reviewing. The empty-commit CLEAN path is gone — Fix dispatches happen on-demand via `pi-tasks`'s cascade, not via pre-allocated static graph slots.

- `verdict === "NEEDS_REDESIGN"` → the orchestrator dispatches a NEW Implement task wired to Review_1 (chain reset). Capped by `max_redesigns` (default 1).
- `verdict === "NEEDS_CLARIFICATION"` → the orchestrator PAUSES the workflow. The Reviewer's `open_question` is surfaced to the user via the LLM-facing `WorkflowRunOutput.open_question`. The cascade stops; the user re-dispatches `workflow_run` with `options.clarification_answer` after answering.

## Subagent dispatch contract

| Task shape | Subagent | `isolation` |
|---|---|---|
| Meta-file edits / design-doc writes | `Developer` (`tdd: "none"`) | `"current-workspace"` (no worktree) |
| Production-code TDD work | `Developer` | `{ dag_id, task_id, mode: "create" }` (managed worktree) |
| Serial follow-up in same workspace | `Developer` | `{ dag_id, task_id, mode: "reuse" }` |
| 5-dim code review | `Reviewer` | `{ dag_id, task_id, mode: "create" }` (read-only on worktree) |
| Cross-workspace merge | `Merger` | none (operates on the orchestrator's cwd) |
| Quick read-only search | `Explore` | none (built-in) |
| Planning Brief compilation | `PlanCompiler` | none (built-in) |

The legacy `isolation: "worktree"` string literal is **rejected** by the Agent dispatcher. `isolation: undefined` is also rejected; every dispatch must name one.

`isolated: true` disables Sages extension loading entirely — the subagent loses AFT / codebase-memory but gains extension-free bash. Rarely needed under soft mode.

## Parallel dispatch

Independent sub-tasks → **one message, multiple `Agent` calls** with `run_in_background: true`. Serialize when:

- The next task depends on the current task's output (commit SHA, test result, discovered bug)
- Tasks share mutable state (`.git/index`, `HEAD`, lockfile updates, same-file edits)

```
Agent({ subagent_type: "Explore", prompt: "...", run_in_background: true })
Agent({ subagent_type: "Developer", isolation: {...}, prompt: "...", run_in_background: true })
```

Foreground is the default for `Explore` / `PlanCompiler` (short helper tasks). Background is the default for `Developer` / `Reviewer` / `Merger` (5-10 min TDD / audit).

## Failure Recovery

| Stage | Failure | Recovery |
|-------|---------|----------|
| Stage 1 | `goal_contract_create` rejects contract | Fix validation errors, re-call |
| Stage 2 | workflow_run returns `status: "blocked"` | Read `unresolved_findings`; rerun with updated scope or escalate to user |
| Stage 3 | Subagent fails | `subagent_status` to inspect; `subagent_steer` to redirect; `subagent_abort` to kill; `subagent_resume` to re-enter terminal sessions |
| Stage 3 | Subagent drifts off-task | `subagent_steer` with correction message; check `subagent_status` to see current state |
| Stage 4 | Reviewer verdict NEEDS_WORK | The cascade auto-spawns Fix_i → Review_{i+1}; exhausts `max_fix_iterations` then blocks |
| Stage 4 | Reviewer verdict CLEAN but commit missing | `subagent_steer` Developer to commit empty + report done; otherwise Fix_i stalls the cascade |
| Stage 4 | Merge agent fails | workflow_run returns `status: "blocked"` with `blocked_at: "merge"`; read `merge_error` |

`subagent_status` is read-only. The other three (`subagent_steer` / `subagent_abort` / `subagent_resume`) mutate state — use with intent.

## `.pi/orchestrator/` Namespace Ownership

| Role | May write |
|---|---|
| Developer | `task-{task_id}-report.md`, `handoff/{workspace_id}/{task_id}-handoff.md` |
| Reviewer | `last-review-{goal_id}.md` |
| Orchestrator | `goal-{id}.yaml`, `workflow-{goal_id}.yaml`, `audit-state-{id}.yaml` |

Cross-namespace overwrites prohibited. `Explore` and `PlanCompiler` are read-only.

## Output: Final Summary to User

After `workflow_run` completes (status: success or blocked), deliver:

```
## Summary
- Goal: {goal.title}
- Status: success | blocked
- Iterations: {iterations_used} / max_fix_iterations={max}
- All SC: ✓ / ✗ (per done_definition assessment)
- Files changed: {count}
- Artifacts: .pi/orchestrator/goal-{id}.yaml, .pi/orchestrator/workflow-{id}.yaml

## Next Steps
- Review the changes?
- Merge to main?
- Tag/release?
```

## Examples

For full end-to-end examples, see the dag templates under `pi-orchestrator/skills/orchestrator/templates/dag/` (legacy — pre-path-B). For path B examples, see `pi-tasks/test/workflow-handler.test.ts` (cascade semantics) and `pi-orchestrator/test/workflow-run.test.ts` (slim emitter semantics).

For single trivial tasks (e.g. "rename `db` to `database` in `src/auth/`"), do **not** use the orchestrator — edit directly.
