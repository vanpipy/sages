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

## Subagent Contract — The 4-Agent Pipeline

The orchestrator dispatches a **single canonical pipeline of 4 subagents**, one per stage. Stages 1-2 come from pi-subagents built-ins; Stages 3-4 are shipped by sages (installed to `~/.pi/agent/agents/` by `install.sh`). Full deployment reference + invocation recipes live in `~/.pi/agent/SUBAGENTS.md` (also installed by sages).

```
┌─────────┐     ┌──────┐     ┌────────────────────┐     ┌────────────────────┐
│ Stage 1 │ ──▶ │  S2  │ ──▶ │       Stage 3      │ ──▶ │       Stage 4      │
│ Explore │     │ Plan │     │ software-developer │     │ software-auditor   │
│ (find)  │     │(design)    │ (RED→GREEN→REFACTOR)  │   (evidence verify) │
└─────────┘     └──────┘     └────────────────────┘     └────────────────────┘
  read-only       read-only       worktree + edit              read-only
  haiku           sonnet          sonnet + thinking           sonnet + thinking
```

| Stage | `subagent_type`     | Source                              | When to dispatch                                                                 |
|-------|----------------------|--------------------------------------|----------------------------------------------------------------------------------|
| 1     | `Explore`            | **pi-subagents built-in**            | "Where is X?" / "find all callers of Y" / pure codebase search                    |
| 2     | `Plan`               | **pi-subagents built-in**            | Need a step-by-step implementation strategy before coding (architect concerns)   |
| 3     | `software-developer` | **shipped** (this repo)              | Write production code + tests in a worktree, strict TDD                          |
| 4     | `software-auditor`   | **shipped** (this repo)              | Certify Stage 3's work — re-run every verification_cmd, read-only on production   |

Fallback: `general-purpose` (built-in, full toolset) is for ad-hoc research that doesn't fit any specific role. Never use it as the implementation or verification path — Stages 3-4 are specialised on purpose.

### When each stage is required

| Task shape                                  | Required stages              |
|----------------------------------------------|------------------------------|
| Single trivial edit (one-line fix, typo)     | none — edit directly         |
| Pure research question ("where is X?")       | 1 (`Explore`)                |
| Architectural decision, no code change       | 1 → 2                        |
| Refactor with existing plan                  | 3 (skip 1+2)                 |
| New feature / multi-file / multi-decision    | 1 → 2 → 3 → 4                |

**Shortcuts** (skipping research/planning): only when the user provides explicit concrete requirements (file paths, exact change) — never guess what "the user means" in stage 1's place.

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

#### Subagent per task role — canonical mapping

Map each DAG task to the right `subagent_type` from the 4-agent pipeline (see Subagent Contract above). Role selection by *purpose*, not convenience:

| Task purpose                           | `subagent_type`       | `isolation` | Notes                                                             |
|----------------------------------------|-----------------------|-------------|-------------------------------------------------------------------|
| Codebase research ("where is X?")      | `Explore`             | none        | Read-only. Haiku — cheap.                                         |
| Architecture / step-by-step plan       | `Plan`                | none        | Read-only. Returns plan + Critical Files.                         |
| Edit production code (TDD: RED→GREEN)  | `software-developer`  | `worktree`  | Strict TDD discipline. Sonnet + high thinking.                    |
| Verify / certify prior work            | `software-auditor`    | none        | Read-only. Independent of implementer — fresh eyes.               |
| Catch-all fallback (use sparingly)     | `general-purpose`     | n/a         | Last resort. Don't use for plan/dev/audit — specialised roles win. |

The DAG's batch numbers should *roughly* follow the pipeline order, but batching is for parallelism within a stage, not across:
- Batch 1 (research): one or more `Explore` tasks in parallel — discover all the things you'll need before planning
- Batch 2 (planning): one or more `Plan` tasks, each consuming research outputs from Batch 1
- Batches 3+ (implementation): one or more `software-developer` tasks per batch (worktree-isolated, TDD)
- Final batch (verification): one or more `software-auditor` tasks, each auditing a discrete chunk of implementation

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
- `dag_synthesize`    ← supports `task_template` field for auto-rendered prompts
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

## Prompt Templates (auto-rendered)

The orchestrator can reference reusable prompt templates instead of writing every task prompt from scratch. Located at:

```
~/.pi/packages/sages/skills/orchestrator/templates/
├── prompts/    ← per-subagent-type task prompts
├── goals/      ← pre-filled goal-contract templates
├── dag/        ← pre-built DAG templates
└── responses/  ← orchestrator-to-user response templates
```

### Task prompt templates (used by `dag_synthesize`)

| Template | Subagent type | Notes |
|----------|--------------|-------|
| `subagent-software-developer` | software-developer | Includes First Action Protocol + STRICT TDD guidance + output contract |
| `subagent-software-auditor` | software-auditor | Default NEEDS WORK + 6-step audit + 5/3-phase depth |
| `subagent-explore` | Explore | Read-only enforcement + findings.json output schema |
| `subagent-general-purpose` | general-purpose | Fallback for tasks without a specific role |

### Goal templates (copy fields into `goal_contract_create`)

| Template | Use for |
|----------|---------|
| `goal-refactor` | Restructure existing code (no behavior change) |
| `goal-new-feature` | Add new module/endpoint |
| `goal-fix-bug` | Reproduce + fix bug with regression test |
| `goal-add-tests` | Add tests only (no production changes) |

### DAG templates (copy + edit tasks into `dag_synthesize`)

| Template | Workflow |
|----------|----------|
| `dag-tdd-refactor` | 7-task refactor pipeline: explore × 2 → plan → implement × 2 → test → audit |
| `dag-bug-fix` | 4-task bug-fix: explore × 2 → fix (RED+GREEN) → audit |

### Response templates (use when responding to user)

| Template | When |
|----------|------|
| `goal-intake` | User gave a vague goal — confirm understanding before Stage 1 |
| `progress-update` | Reporting batch completion to user |

### Using task_template in DAG

When defining a task in `dag_synthesize`, you can either:
- Write `prompt` directly (LLM composes)
- OR set `task_template: "subagent-software-developer"` + `task_params: {...}` → tool auto-renders

The auto-render path is preferred — templates encode the discipline (TDD, First Action Protocol, output contract) that the orchestrator wants every subagent to follow.

Template substitution uses `{{var}}` for variables and `{{#if var}}...{{else}}...{{/if}}` for conditionals. Variables not provided are rendered as `[varname]` placeholders.

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
Stage 2: dag_synthesize with ~6 tasks, mapped to 4-agent subagent pipeline:
        - Batch 1 (Explore):  P1 find DB call sites,  P2 find existing repo patterns
        - Batch 2 (Plan):     P3 design repo interface + migration steps
        - Batch 3 (developer): P4 scaffold repo module,  P5 port auth-service
        - Batch 4 (developer): P6 add integration tests
        - Batch 5 (auditor):   P7 certify: typecheck + lint + tests + SC re-verify
Stage 3: dispatch 5 batches, with Batches 3-4 in worktree isolation
Stage 4: orchestrator_audit (5 phases)
```