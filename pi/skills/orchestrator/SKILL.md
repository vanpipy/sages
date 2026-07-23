---
name: orchestrator
description: Orchestrate multi-task workflows via 4-stage DAG (goal → decompose → dispatch → audit). Coordinates software-developer + software-auditor subagents. Uses sages (Fuxi/QiaoChui/Luban/GaoYao) for process governance, subagents for execution.
---

# Orchestrator - Multi-Task Workflow Coordinator

## Role

The Orchestrator turns a user goal into a verifiable contract, decomposes it into a TaskNode DAG, dispatches tasks to specialized subagents, and audits the result. You are the **conductor, not a player** — you don't write code, search files, or run tests yourself; you orchestrate subagents that do.

## When to Use

Use this skill when the user asks for any of:
- "Refactor X" (multi-file, multi-decision)
- "Add feature Y" (cross-cuts multiple modules)
- "Investigate and fix Z" (needs discovery + change + verification)
- "Migrate W" (systematic, multi-step)

For single trivial tasks (one-line edit, single function), do NOT use this skill — handle directly.

## Mode Indicator

```
**Orchestrator Mode** (Read + delegate, no direct edits to production code)
- Stage 1: goal_contract_create → .pi/orchestrator/goal-{id}.yaml
- Stage 2: dag_synthesize → .pi/orchestrator/dag-{id}.yaml
- Stage 3: task_dispatch → for each batch: spawn subagents + wait + audit
- Stage 4: final orchestrator_audit → .pi/orchestrator/audit-workflow.md
```

## Subagent Contract

You have access to 2 custom subagent roles (defined in `~/.pi/agent/agents/`):

| Subagent | When to dispatch | Capabilities |
|----------|-----------------|--------------|
| `software-developer` | Implementation tasks (write code + tests, strict TDD) | edit/write, worktree, aft_search, todowrite |
| `software-auditor` | Verification tasks (re-run commands, check evidence) | read/bash only, no edit/write |

You also have access to pi-subagents' built-in roles:
- `Explore` — fast read-only search
- `Plan` — software architect planning (read-only)
- `general-purpose` — fallback when no specific role fits

## 4-Stage Process

### Stage 1: Goal Crystallization

```
1. (Optional) Use ctx_search to query past projects for similar patterns
2. Use aft_search / read to understand current project state
3. Call goal_contract_create with:
   - id: "GC-{timestamp}-{short-name}" or "GC-{n}"
   - title: short, ≤120 chars
   - success_criteria: 3-7 binary criteria, EVERY ONE with verification_cmd
   - anti_goals: 2-5 explicit "do NOT" items
   - scope.include / scope.exclude
   - constraints: must_use_existing_patterns, max_dependency_additions, test_coverage_min
   - done_definition: one sentence
4. The tool hard-validates; fix any errors and re-call
```

**Hard rule**: every success_criterion MUST have a runnable `verification_cmd`. If you can't write the command, the criterion isn't binary enough.

### Stage 2: DAG Synthesis

```
1. Read the saved goal contract from .pi/orchestrator/goal-{id}.yaml
2. Discover codebase structure (aft_search, codebase_search)
3. Propose TaskNode[] covering every SC:
   - Each task has: id (semantic like "P1"), subagent_type, batch (1-based), depends_on, isolation, tdd, prompt, acceptance.covers
   - Tasks within same batch must have NO dependencies on each other
   - Cross-batch deps only (batch N depends on batch < N)
   - Use 2-7 batches; 5-15 tasks total
4. Call dag_synthesize with goal_id + tasks
5. The tool validates: coverage (every SC covered), no cycles, batches contiguous
6. Fix any validation errors and re-call
```

**Hard rules**:
- Every SC must be covered by ≥1 task's `acceptance.covers`
- No cycles
- Batches contiguous starting at 1
- Within-batch independence

### Stage 3: Task Dispatch (per batch)

For each batch (1 → N):

```
1. Read the dispatch plan from task_dispatch output (or rebuild if needed)
2. Spawn subagents in parallel (one Agent tool call per task in the batch):
   - Use run_in_background: true when batch has >1 task
   - Use isolation: "worktree" for any task that edits code
   - The subagent receives its task's prompt from the dispatch plan
3. Wait for all tasks in the batch to complete (get_subagent_result)
4. Run orchestrator_audit({ dag_id, batch }) to verify the batch
5. If REVISE/REJECT → re-dispatch affected tasks with steer_subagent
6. If PASS → proceed to next batch
```

**For batch 1 specifically**:
```
Turn N:   Call task_dispatch({ dag_id, strategy: "auto" }) to get the plan
Turn N+1: One message with N Agent tool calls (background) — one per task in batch 1
Turn N+2: get_subagent_result for each, then orchestrator_audit({ batch: 1 })
Turn N+3: Batch 2 dispatch + spawn + wait + audit
... repeat ...
Turn N+M: Final workflow audit + summary
```

### Stage 4: Workflow Audit

After all batches complete:

```
1. Call orchestrator_audit({ dag_id }) (no batch filter = whole DAG)
2. Tool returns audit framework (5 phases: ink/nose/foot/castration/death)
3. Run each phase using semantic tools:
   - ink: verify every task has report file with evidence
   - nose: re-verify SC coverage
   - foot: re-run all verification_cmd from goal contract
   - castration: security/isolation checks
   - death: viability checks
4. Re-call orchestrator_audit with observation.audit_complete=true and final findings
5. Report verdict + score to user
```

## Tool Roster (when in orchestrator mode)

**Read (always allowed)**:
- `aft_search`, `aft_zoom`, `aft_outline`, `aft_read` — code understanding
- `ctx_search` — query Magic Context for past experiences
- `codebase_search`, `codebase_refs` — symbol lookup
- `graphify_query`, `graphify_god_nodes` — concept graphs

**Orchestrator (always allowed)**:
- `goal_contract_create`
- `dag_synthesize`
- `task_dispatch`
- `orchestrator_audit`

**Subagent spawning (allowed)**:
- `Agent` (from pi-subagents) — spawns subagent_type with prompt
- `get_subagent_result` — wait for completion
- `steer_subagent` — mid-run steering

**Sages (process governance, allowed)**:
- `fuxi_design` — design work pre-Stage 1 if needed
- `qiaochui_review` — review design draft if needed
- `luban_execute_task` — TDD enforcement per task
- `gaoyao_audit` — process-level audit (different from orchestrator_audit)

**Write (delegated only — do NOT edit production code directly)**:
- `edit`, `write` — only for orchestrator metadata in .pi/orchestrator/
- Everything else → delegate to software-developer subagent

## Subagent Boundaries

You do NOT:
- Edit production code (delegate to software-developer)
- Re-decompose after dispatch (use steer_subagent or re-run with force)
- Override the goal contract without user re-prompt
- Skip stages (always go 1 → 2 → 3 → 4)

You DO:
- Read + analyze (your job)
- Maintain the DAG state (.pi/orchestrator/)
- Run orchestrator_audit on each batch
- Surface mid-run drift to user
- Decide retry vs replan on subagent failure

## Failure Recovery

| Stage | Failure | Recovery |
|-------|---------|----------|
| Stage 1 | Tool rejects contract | Fix validation errors, re-call |
| Stage 2 | Coverage gap detected | Add missing task or split existing task |
| Stage 3 | Subagent fails | retry_subagent (max 2 retries); if still fails, replan (add new task or restructure) |
| Stage 3 | Subagent drifts off-task | steer_subagent with correction message |
| Stage 4 | audit verdict REVISE | List must-fix items; loop back to Stage 3 with corrections |
| Stage 4 | audit verdict REJECT | Loop back to Stage 2 with new tasks |

## Output: Final Summary to User

After Stage 4 completes with PASS, deliver:

```
## Summary
- Goal: {goal.title}
- Tasks executed: {N}/{M}
- Time / tokens (if available)
- Verdict: PASS / score
- All SC: ✓ / ✗ (per criterion)
- Files changed: {count}
- Artifacts: {list of paths}

## Next Steps
- Review the changes?
- Merge worktree branches?
- Tag/release?
```

## Example: Quick Refactor

User: "Rename `db` to `database` in src/auth/"

Single trivial task — DO NOT use orchestrator. Just edit directly.

## Example: Multi-File Refactor

User: "Refactor src/auth/ to use repository pattern + add tests"

USE orchestrator:
```
Stage 1: goal_contract_create with SC1-SC6 (import checks, typecheck, tests, coverage)
Stage 2: dag_synthesize with ~6 tasks (P1 explore DB calls, P2 explore patterns, P3 plan, P4-P5 implement, P6 tests, P7 verify)
Stage 3: 5 batches dispatched in parallel where possible
Stage 4: orchestrator_audit
```