---
name: orchestrator
description: Orchestrate multi-task workflows via decompose_task (linear chain from a user intent) or pi-tasks TaskCreate × N + TaskExecute (for the canonical Implement → Review ⇆ Fix → MergerAdvisor shape). Coordinates Developer / Reviewer / Fix / MergerAdvisor subagents; pi-tasks drives the cascade. Owns goal_contract_create + decompose_task + 4 subagent-control tools.
---

# Orchestrator — Workflow Coordinator

> **Removed in GC-2026-remove-workflow-run-prod (post the 3-GC removal
> 2026-Q4):** the `workflow_run` tool is gone. Use `decompose_task` for linear
> user-intent chains, or raw `TaskCreate` × N + `TaskExecute` for the canonical
> Implement → Review ⇆ Fix → MergerAdvisor shape. The Reviewer subagent's
> 4-state verdict (`CLEAN` / `NEEDS_WORK` / `NEEDS_REDESIGN` /
> `NEEDS_CLARIFICATION`) is a subagent-prompt feature, not a workflow_run
> feature — it's unchanged.

# Orchestrator — Workflow Coordinator

## Design intent (read this first)

Sages is built on one architectural claim: **complex work deserves a typed review gate, but not every task is complex work.** Three layers, each with one job:

| Layer | Package | Job |
|---|---|---|
| **Planning** | `pi-orchestrator` | Declare intent (`goal_contract_create`); run pipeline (`workflow_run`); break a user intent into a serial chain (`decompose_task`); control subagents in-flight |
| **Tracking** | `pi-tasks` | Hold the task graph; spawn agents per cascade; route both `workflow_run`'s static graph and `decompose_task`'s linear chain through the same dependency-driven dispatch; emit `workflow:phase-complete` events for `workflow_run` |
| **Executing** | `pi-subagents` | One agent = one task. 11 default types covering search, plan, code, review, fix, merge, advisors |

You (the orchestrator) own layer 1. Layers 2 and 3 are reactive.

**Nothing is mechanically blocked (soft mode).** Pick the path that matches the work shape.

## Choose your path

```text
Is the work a single trivial task (one-line edit, one function)?
  → YES: handle directly. No skill, no task graph, no tool calls.
  → NO: continue.

Is the work a USER-LEVEL intent (a chat message like "implement X" or
  "fix the README typo") that needs breaking into a serial chain of
  orchestrator tasks?
  → YES: decompose_task (GC-2026-task-feeding-and-decomposition).
          Linear chain T1 → T2 → … → TN. One R1 Reviewer audits the
          cumulative state. Runs in the host cwd on the active branch
          (no managed worktree per task).
  → NO: continue.

Does it fit Implement → Review ⇆ Fix → Merge?
  → YES: workflow_run (canonical). Review gate + auto-fix loop +
          worktree isolation + audit trail. Use this whenever the work
          produces production code that needs a review gate.
  → NO: continue.

Does the work need a custom DAG (diamond, fan-in, conditional,
  multi-package, no review gate)?
  → YES: raw TaskCreate × N + TaskExecute (escape hatch).
          You own the DAG; pi-tasks owns the store.
  → NO: continue.

Is the work a one-off Explore / Plan / dispatch?
  → YES: Agent tool directly. No task graph needed.
```

When unsure between `workflow_run` and `decompose_task`: the user
expressed it as a single goal → `workflow_run`. The user expressed it
as an open-ended intent (no goal_id yet) → `decompose_task` (or
first `goal_contract_create` + then `decompose_task` with
`user_task_id` linking). The escape hatch is for shapes neither
pipeline can represent — not for skipping the review gate on code
that should have one.

## Mode Indicator

```text
**Orchestrator Mode** (Soft mode — GC-2026-031)
- Main agent has full tool access (edit / write / aft_edit / apply_patch,
  unrestricted bash). Nothing is blocked.
- ≥2 items in active task list: drive via workflow_run (canonical) OR
  TaskCreate × N (escape hatch). ≤2 items: direct edit / write / bash.
- workflow_run emits workflow:start → pi-tasks drives cascade →
  workflow_run waits for workflow:phase-complete → returns
  WorkflowRunOutput.
- Reviewer verdict (4-state: CLEAN / NEEDS_WORK / NEEDS_REDESIGN /
  NEEDS_CLARIFICATION) drives the Fix / Redesign / Clarification
  branches; budget = max_fix_iterations.
- GC-2026-path-B-swap deleted the 1060-line state machine; orchestration
  is now event-driven.
```

---

## Path A: `workflow_run` (canonical)

### What you get

A complete review-gated pipeline:

- ✅ 5-dim review gate (correctness, completeness, scope, anti-goal, documentation)
- ✅ Auto-spawned Fix iterations on NEEDS_WORK (capped by `max_fix_iterations`)
- ✅ Auto-spawned new Implement on NEEDS_REDESIGN (capped by `max_redesigns`)
- ✅ NEEDS_CLARIFICATION pause that surfaces the Reviewer's `open_question`
- ✅ `last-review-{goal_id}.md` evidence trail for downstream MergerAdvisor
- ✅ Managed worktree per task (`isolation: { goal_id, task_id, mode: "create" }`)
- ✅ `workflow-{goal_id}.yaml` state file (watchdog + session digest visibility)
- ✅ Advisor pairs (DeveloperAdvisor / ReviewerAdvisor / FixAdvisor) per primary task
- ✅ `workflow:phase-complete` event stream for live progress (`onUpdate` callback)

### How

```text
1. goal_contract_create → .pi/orchestrator/goal-{id}.yaml
                          (intent + SHA-256 lock)
2. workflow_run(goal_path: ".pi/orchestrator/goal-{id}.yaml")
   → blocks until pipeline completes
   → emits workflow:start → pi-tasks builds static graph
   → cascade: each subagents:completed spawns newly-unblocked tasks
   → workflow_run aggregates workflow:phase-complete events
   → resolves as status: success | blocked
3. Read WorkflowRunOutput JSON; report to user
```

### Goal contract schema

`goal_contract_create` accepts:

```yaml
id: "GC-XXXX-NNN"           # required, matches ^GC-[0-9a-zA-Z-]+$
title: "<≤120 chars>"        # required
rationale: "<why>"           # optional but recommended
anti_goals: ["..."]          # required (can be empty)
scope:
  include: ["..."]           # files / modules in scope
  exclude: ["..."]           # files / modules excluded
constraints:
  must_use_existing_patterns: <bool>
  max_dependency_additions: <int 0-100>
  test_coverage_min: <int 0-100>
  typecheck_required: <bool>
  lint_required: <bool>
done_definition: "<≥10 chars>"  # required
```

### Static graph

Default `max_fix_iterations=3` → 5-task static graph:

```text
Implement ─→ Review_1 ─→ Review_2 ─→ Review_3 ─→ Merge
```

Fix tasks are NOT in the static graph. They are dispatched on demand by
`pi-tasks/subscribeWorkflow` when a Review verdict is NEEDS_WORK
(capped by `max_fix_iterations`, default 3).

### Resolve conditions

| Condition | Status | `blocked_at` |
|---|---|---|
| Implement done + last Review CLEAN + Merge done | `success` | — |
| NEEDS_WORK iterations exhausted | `blocked` | `review` |
| NEEDS_REDESIGN dispatches exhausted | `blocked` | `review` |
| Last Review NEEDS_CLARIFICATION | `blocked` | `review` (with `open_question`) |
| Implement / Fix / Review / Merge phase fails | `blocked` | matching phase |

---

## Path C: `decompose_task` (linear chain)

### What you get

A serial task chain from a user intent (or a user-created task):

- ✅ Linear chain `T1 → T2 → ... → TN` (one blockedBy edge per step)
- ✅ One `R1` Reviewer sibling on T1 (top-level per R3) that audits the
  cumulative state after all chain tasks complete
- ✅ `R1`'s prompt contains every chain subject + description
- ✅ Optional `user_task_id` linkage: pass a user task (created via
  `/tasks create "<subject>"`) and every chain task carries
  `metadata.user_task_ref = <user_task_id>` for postmortem audit
- ✅ Audit file at `.pi/orchestrator/decompose-<id>.yaml`

### What you give up

- ❌ No managed worktree per chain task (runs in cwd on the active
  branch; `R1` audits via `git log`)
- ❌ No NEEDS_REDESIGN / multiple `Implement` rerolls (one-shot chain
  only — if `R1` finds structural issues, you re-call `decompose_task`
  with a revised spec list)
- ❌ No auto-cascade from `cfg.autoCascade` (decompose chains use their
  own dedicated listener, not the ad-hoc auto-cascade path)

### When to use

- The user expressed a multi-step intent that doesn't fit the 4-phase
  pipeline (e.g. "investigate → write tests → fix → verify")
- The chain is naturally serial (no parallel branches)
- You want a single Reviewer to look at the cumulative diff at the end

### How

```text
1. (optional) goal_contract_create → writes the intent + SHA-256 lock
   (the chain's audit file references it for context)

2. decompose_task({
     user_task_id?: "<id of a /tasks create'd user task>",
     specs: [
       { subject: "T1 investigate", description: "..." },
       { subject: "T2 write tests",  description: "..." },
       { subject: "T3 verify",       description: "..." },
     ],
   })
   → RPC to pi-tasks's `tasks:rpc:decompose-materialize`
   → pi-tasks creates T1 + R1 (via createOrchestratorTaskWithReview),
     T2/T3/... (via createOrchestratorTask)
   → pi-tasks spawns T1 (the chain head)
   → unified task-feeder's `cascadeSpawn` walks pending tasks
     with satisfied blockers and spawns the next task
     (GC-2026-113; the dedicated decompose-cascade module was
     removed in GC-2026-117)
   → R1 audits the cumulative state at completion
   → returns { status: "success", tasks, reviewer_id, audit_path, ... }

3. Read the returned audit_path + the chain's task IDs. If R1
   emitted NEEDS_WORK, you can re-call decompose_task with a
   revised spec list (a new chain) — or use TaskUpdate to add a
   Fix task to the existing chain.
```

Schema (LLM-facing):

```ts
decompose_task({
  user_task_id?: string,    // optional link to a /tasks create'd task
  specs: [
    { subject: "<≤120 chars>", description: "<≥10 chars>", activeForm?: string },
    // 1 ≤ specs.length ≤ 20
  ],
})
```

---

## Path B: raw `TaskCreate` × N (escape hatch)

### What you give up

Going raw means `workflow_run` does not see this work. Concretely:

- ❌ No `workflow:start` / `workflow:phase-complete` events → no orchestrator state file
- ❌ NEEDS_WORK will NOT auto-spawn Fix (the `subscribeWorkflow` cascade only fires for tasks it created)
- ❌ NEEDS_REDESIGN will NOT auto-spawn a new Implement
- ❌ NEEDS_CLARIFICATION will NOT pause the workflow
- ❌ Advisor pairs will NOT run automatically (they only fire for tasks created by `buildStaticWorkflowGraph`, which sets `metadata.advisorAgentType`)
- ❌ `last-review-{goal_id}.md` and `verdict-{task_id}.md` will NOT be written → MergerAdvisor downstream won't see evidence
- ❌ `workflow-{goal_id}.yaml` will NOT be initialized → watchdog / session digest don't see this work

If you find yourself needing any of these for raw tasks, switch to
`workflow_run` or build the `workflow:start` event manually.

### When to use

Use this path when the work does NOT fit the canonical pipeline:

- **Multi-package coordination** that touches repos beyond the orchestrator's cwd
- **Conditional branches** (diamond DAG, if/else per phase result)
- **Parallel tracks** that converge later (Explore × N → Develop × N → Aggregate)
- **No review gate** (the work is tracking / investigation / doc-only)
- **Long-running fire-and-forget** that would block the orchestrator if it went through `workflow_run`

Do NOT use this path to skip the review gate on production code that
should have one — that's a misuse, not an escape hatch.

### How

```text
1. (optional) goal_contract_create → writes the intent + SHA-256 lock
   for downstream auditing. The lock is independent of the run path.

2. Decide on cascade. Default is OFF: pi-tasks WILL NOT auto-spawn
   unblocked tasks after a subagent completes. Either:
     a) Write <cwd>/.pi/tasks-config.json with {"autoCascade": true}
     b) Call TaskExecute per wave

3. TaskCreate × N — each task has:
   - subject, description (rich prompt; see "Subagent dispatch contract" below)
   - agentType: pick from the 11 default types (table below)
   - blockedBy: [task_id, ...]   (cascade prerequisite)
   - metadata.workflow_run_goal_id: goal.id   (optional — for tracking)

4. TaskExecute([first_task_id, ...])   # or one call per wave

5. TaskList / TaskGet / TaskUpdate / TaskOutput / TaskStop as needed

6. subagent_status / subagent_steer / subagent_abort / subagent_resume as needed
```

---

## The 11 default agent types

| Type | Mode | Writes to | Use for |
|---|---|---|---|
| `Explore` | foreground | nothing | Bounded read-only search ("where is X?") |
| `PlanCompiler` | foreground | nothing | Compile a Planning Brief into an ordered plan |
| `Developer` | background | production code (managed worktree) | RED → GREEN → REFACTOR + commit discipline |
| `Fix` | background | production code (managed worktree) | Lean post-Review patch; reads prior Review verdict from TaskGet |
| `Reviewer` | background | `.pi/orchestrator/verdict-{task_id}.md`, `last-review-{goal_id}.md` | 5-dim code review, emits 4-state verdict |
| `MergerAdvisor` | background | `.pi/orchestrator/merge-recommendation.md` | Single-workspace advisory merge — writes recommendation, NEVER executes `git merge` or `git push` |
| `Merger` | background | git (cross-workspace) | Cross-workspace merge commit + branch push (legacy DAG-synthesis path) |
| `DeveloperAdvisor` | background | `implement-advisor-{task_id}.md` | Audit peer for `Developer`; reads commit log + tests, never re-runs TDD |
| `ReviewerAdvisor` | background | `review-advisor-{task_id}.md` | Audit peer for `Reviewer`; reads verdict file, never re-runs review |
| `FixAdvisor` | background | `fix-advisor-{task_id}.md` | Audit peer for `Fix`; reads commit chain + findings, never re-applies changes |

**Notes:**

- The advisor agents fire automatically **only** when tasks are created via `workflow_run`'s static graph (which sets `advisorAgentType` on each task). If you use raw `TaskCreate`, advisors do NOT fire unless you stamp `metadata.advisorAgentType` yourself.
- For code-write tasks (`Developer`, `Fix`), `enforceDeveloperManagedIsolationPolicy` applies at spawn time. The dispatcher REJECTS the spawn if no worktree isolation is provided.
- `MergerAdvisor` is the agent `workflow_run`'s Merge phase dispatches. It is strictly advisory — it writes a recommendation file, never executes `git merge` or `git push` against protected branches (per `~/AGENTS.md` "Permission gate required"). Use `Merger` only for the legacy cross-workspace DAG-synthesis path.

---

## Subagent dispatch contract

| Task shape | Subagent | `isolation` |
|---|---|---|
| Meta-file / design-doc writes | `Developer` (`tdd: "none"`) | `"current-workspace"` (no worktree) |
| Production-code TDD (Implement) | `Developer` | `{ goal_id, task_id, mode: "create" }` |
| Post-Review patch | `Fix` | `{ goal_id, task_id, mode: "create" }` (same worktree as Implement) |
| Serial follow-up in same workspace | `Developer` or `Fix` | `{ goal_id, task_id, mode: "reuse" }` |
| 5-dim code review (read-only) | `Reviewer` | `{ goal_id, task_id, mode: "create" }` |
| Single-workspace merge advisory | `MergerAdvisor` | none (operates on the orchestrator's cwd) |
| Cross-workspace merge (DAG-synthesis) | `Merger` | none |
| Quick read-only search | `Explore` | none |
| Planning Brief compilation | `PlanCompiler` | none |
| Audit peer (read-only) | `*Advisor` | none |

The legacy `isolation: "worktree"` string literal is REJECTED.
`isolation: undefined` is REJECTED for any agent that writes code —
every dispatch must name an explicit choice.

`isolated: true` disables Sages extension loading entirely — the
subagent loses AFT / codebase-memory but gains extension-free bash.
Rarely needed under soft mode.

---

## Parallel dispatch

Independent sub-tasks → one message, multiple `Agent` calls with
`run_in_background: true`. Serialize when:

- The next task depends on the current task's output (commit SHA, test result, discovered bug)
- Tasks share mutable state (`.git/index`, `HEAD`, lockfile updates, same-file edits)

```text
Agent({ subagent_type: "Explore",   prompt: "...", run_in_background: true })
Agent({ subagent_type: "Developer", isolation: {...}, prompt: "...", run_in_background: true })
```

Foreground is default for `Explore` / `PlanCompiler` (short helper tasks).
Background is default for `Developer` / `Reviewer` / `Fix` / `Merger*` (5–10 min TDD / audit).

---

## Failure Recovery

| Stage | Failure | Recovery |
|---|---|---|
| Stage 1 | `goal_contract_create` rejects contract | Fix validation errors, re-call |
| Stage 2 | `workflow_run` returns `status: "blocked"` | Read `unresolved_findings` + `blocked_at`; rerun with updated scope or escalate |
| Stage 3 | Spawn fails (empty agent id returned) | `subagent_status` to see if agent exists; re-spawn manually. The cascade stalled because `agentToTask.set("", task.id)` left the task in_progress |
| Stage 3 | Subagent parent-aborted (parent signal fired) | Cascade stalls — `subagents:parent_aborted` is not handled by `subscribeWorkflow`. Re-dispatch the task manually or escalate |
| Stage 3 | Subagent fails | `subagent_status` to inspect; `subagent_steer` to redirect; `subagent_abort` to kill; `subagent_resume` to re-enter terminal sessions |
| Stage 3 | Subagent drifts off-task | `subagent_steer` with correction; check `subagent_status` |
| Stage 4 | Reviewer verdict NEEDS_WORK | Cascade auto-spawns Fix_i → Review_{i+1}; exhausts `max_fix_iterations` then blocks |
| Stage 4 | NEEDS_REDESIGN budget exhausted | workflow_run returns `status: "blocked"`; restart with a fresh goal or accept the block |
| Stage 4 | Reviewer NEEDS_CLARIFICATION | workflow_run returns `status: "blocked"` with `open_question`; answer the user, then re-dispatch with `options.clarification_answer` |
| Stage 4 | Merge fails | `status: "blocked"` with `blocked_at: "merge"` and `merge_error` |

`subagent_status` is read-only. `steer` / `abort` / `resume` mutate state — use with intent.

---

## `.pi/orchestrator/` Namespace Ownership

| Role | May write |
|---|---|
| Developer / Fix | `task-{task_id}-report.md`, `handoff/{workspace_id}/{task_id}-handoff.md` |
| Reviewer | `last-review-{goal_id}.md`, `verdict-{task_id}.md` |
| MergerAdvisor | `merge-recommendation.md` |
| `*Advisor` | `<phase>-advisor-{task_id}.md` |
| Orchestrator | `goal-{id}.yaml`, `workflow-{goal_id}.yaml`, `audit-state-{id}.yaml` |

Cross-namespace overwrites prohibited. `Explore` and `PlanCompiler` are read-only.

---

## Output: Final Summary to User

After `workflow_run` completes, deliver:

```text
## Summary
- Goal: {goal.title}
- Status: success | blocked
- Iterations: {iterations_used} / max_fix_iterations={max}
- Done definition: ✓ / ✗
- Files changed: {count}
- Artifacts: .pi/orchestrator/goal-{id}.yaml, .pi/orchestrator/workflow-{id}.yaml

## Next Steps
- Review the changes?
- Merge to main?
- Tag/release?
```

---

## Examples

For path A end-to-end, see `pi-tasks/test/workflow-handler.test.ts`
(cascade semantics) and `pi-orchestrator/test/workflow-run.test.ts`
(slim emitter semantics). For path B shapes (raw DAG with and without
auto-cascade), see `pi-tasks/test/subagent-integration.test.ts` and
`pi-tasks/test/auto-cascade.test.ts`.

For single trivial tasks (e.g. "rename `db` to `database` in `src/auth/`"),
do not use the orchestrator — edit directly.
