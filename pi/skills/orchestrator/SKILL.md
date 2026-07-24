---
name: orchestrator
description: Orchestrate multi-task workflows via 4-stage DAG (goal → decompose → dispatch → audit). Coordinates software-developer + software-auditor subagents for execution.
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
  foreground      foreground      BACKGROUND                  BACKGROUND
```

| Stage | `subagent_type`     | Source                              | `run_in_background` | When to dispatch                                                                 |
|-------|----------------------|--------------------------------------|---------------------|----------------------------------------------------------------------------------|
| 1     | `Explore`            | **pi-subagents built-in**            | `false`             | "Where is X?" / "find all callers of Y" / pure codebase search                    |
| 2     | `Plan`               | **pi-subagents built-in**            | `false`             | Need a step-by-step implementation strategy before coding (architect concerns)   |
| 3     | `software-developer` | **shipped** (this repo)              | **`true`**          | Write production code + tests in a worktree, strict TDD                          |
| 4     | `software-auditor`   | **shipped** (this repo)              | **`true`**          | Certify Stage 3's work — re-run every verification_cmd, read-only on production   |

**Foreground vs background — verified 2026-07-24 default:**
- **Foreground** (Stages 1–2): the orchestrator's main context is locked for the subagent's duration. Used when the next stage's prompt depends on this one's output.
- **Background** (Stages 3–4): the orchestrator receives an agent id and keeps working. Use `get_subagent_result(agent_id)` to collect, `steer_subagent(agent_id, "...")` to redirect mid-run. Up to 4 concurrent default. Long-running TDD + verify work would serialize the entire pipeline if run synchronously.
- See `pi/templates/SUBAGENTS.md` for full rationale, code examples, and the "Don't duplicate work" rule.

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

### Stage 4: Workflow Audit (workflow-level rollup)

**A3 split**: per-task auditing is the **software-auditor subagent's** job (it
writes `.pi/orchestrator/audit-{task_id}.md`). The `orchestrator_audit` tool
focuses on **workflow-level** rollup, not per-task re-verification.

After all batches complete:

```
1. Call orchestrator_audit({ dag_id }) (no batch filter = whole DAG)
   - Default depth is "fast" (3 phases: ink/nose/foot) — covers ~90% of workflows
   - Pass depth: "full" for full 5-phase audit (adds castration/death)
2. Tool reads each task's audit-{id}.md and returns:
   - workflow_summary.workflowReady: true iff all tasks CERTIFIED
   - workflow_summary.blockingTasks: tasks that need re-audit
   - phase_guidance: workflow-level scope (cross-task, not per-task)
3. Run any blocking-tasks through software-auditor; then call again.
4. Collect workflow-level findings (cross-task consistency, integration SCs,
   coverage gaps). Submit in ONE batch call:
   orchestrator_audit({
     dag_id,
     observation: {
       findings: [
         { category: "nose", severity: "minor", issue: "SC4 has no audit", evidence: "..." },
         { category: "foot", severity: "critical", issue: "Integration test fails", evidence: "..." },
         // ... all workflow-level findings
       ],
       complete: { verdict, score, summary }
     }
   })
   - Batch submission avoids N round-trips (one call can hold all findings + complete)
5. Report verdict + score to user
```

**Why A3 split?** Per-task audit (re-run verification_cmd, inspect diff, check
TDD discipline) was duplicated 80% between `orchestrator_audit` and
`software-auditor`. Now: software-auditor = per-task expert; orchestrator_audit
= workflow-level aggregator. Zero overlap.

**Audit tool call count (fast depth, batched findings)**:
- 1× init (no observation)
- 1× record + complete (single call with `findings[]` + `complete`)
- Total: **2 tool calls** (was 5+ in the one-finding-per-call pattern)

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

**Process governance (built into orchestrator — no separate sage tools)**:
- Design → `dag_synthesize` (typed goal contracts + DAGs replace ad-hoc MDD drafts)
- Review → `goal_contract_create` (binary SC pass/fail replaces score-gating)
- TDD execution → delegated to `software-developer` subagent (see SUBAGENTS.md)
- Audit → `orchestrator_audit` (workflow-level rollup; A3 split — per-task detail handled by `software-auditor`)

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

### Response patterns (LLM composes inline, not from file)

For vague-goal confirmation, follow this structure:
1. Reframe the user's intent in one sentence
2. Propose draft goal with SCs (use `goal-{type}.yaml` for SC suggestions)
3. List anti-goals + clarifying questions
4. Ask user to confirm before Stage 1

For progress reports, follow this structure:
```
## Progress — Batch N/M
[✓/◐/⏸] tasks completed | tokens used | time elapsed

### Completed
| task | status | outcome |

### Audit (if just ran)
- Verdict: PASS/REVISE/REJECT
- Score: N/100

### Next
- Batches N+1..M ready to dispatch
```

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

## Example: Multi-File Refactor (complete, with template rendering)

User: "Refactor src/auth/ to use repository pattern + add tests"

USE orchestrator. This example shows full templates, params, and inputs:

```typescript
// ── Stage 1: goal_contract_create ──
goal_contract_create({
  id: "GC-2025-001",
  title: "Refactor src/auth/ to use repository pattern",
  success_criteria: [
    { id: "SC1", criterion: "src/auth/service.ts no longer imports database",
      verification_cmd: "! grep -q 'from.*database' src/auth/service.ts" },
    { id: "SC2", criterion: "src/auth/login.ts no longer imports database",
      verification_cmd: "! grep -q 'from.*database' src/auth/login.ts" },
    { id: "SC3", criterion: "New UserRepository class exists",
      verification_cmd: "test -f src/auth/repository/UserRepository.ts" },
    { id: "SC4", criterion: "typecheck passes",
      verification_cmd: "npm run typecheck && echo OK" },
    { id: "SC5", criterion: "tests pass",
      verification_cmd: "npm test" },
    { id: "SC6", criterion: "coverage on src/auth/ >= 80%",
      verification_cmd: "npm run coverage -- --json | jq '.total.lines.pct'" },
  ],
  anti_goals: [
    "Do not introduce new dependencies",
    "Do not change login.ts business logic (only data layer)",
    "Do not modify src/users/ (reference pattern)",
  ],
  scope: { include: ["src/auth/", "test/auth/"], exclude: ["src/users/", "package.json"] },
  constraints: { must_use_existing_patterns: true, max_dependency_additions: 0, test_coverage_min: 80 },
  done_definition: "SC1-SC6 verified + orchestrator_audit PASS >= 90",
});

// ── Stage 2: dag_synthesize (uses task_template for auto-rendered prompts) ──
dag_synthesize({
  goal_id: "GC-2025-001",
  tasks: [
    {
      id: "P1", description: "Find all DB calls in src/auth/",
      subagent_type: "Explore", batch: 1, depends_on: [], isolation: "none", tdd: "none",
      task_template: "subagent-explore",
      task_params: { task_id: "P1", task_title: "Find DB calls in src/auth/",
                     sc_list: "Find sites that directly call db/query/exec/pool",
                     files_to_touch: "src/auth/" },
      acceptance: { covers: [] },
      output_schema: { kind: "file_list", path: ".pi/orchestrator/task-P1-findings.json" },
    },
    {
      id: "P2", description: "Find existing repository pattern to mirror",
      subagent_type: "Explore", batch: 1, depends_on: [], isolation: "none", tdd: "none",
      task_template: "subagent-explore",
      task_params: { task_id: "P2", task_title: "Find existing repository pattern",
                     sc_list: "Find existing Repository class + test patterns",
                     files_to_touch: "src/users/" },
      acceptance: { covers: [] },
      output_schema: { kind: "file_list", path: ".pi/orchestrator/task-P2-findings.json" },
    },
    {
      id: "P3", description: "Design new repository interface",
      subagent_type: "Plan", batch: 2, depends_on: ["P1", "P2"], isolation: "none", tdd: "none",
      task_template: "subagent-general-purpose",
      task_params: { task_id: "P3", task_title: "Design new repository interface",
                     sc_list: "(design task)", upstream_outputs: "(from P1, P2)",
                     files_to_touch: "" },
      inputs: [
        { from_task: "P1", field: "findings", embed: "summary" },
        { from_task: "P2", field: "findings", embed: "inline" },
      ],
      acceptance: { covers: [] },
      output_schema: { kind: "design_doc", path: ".pi/orchestrator/task-P3-design.md" },
    },
    {
      id: "P4", description: "Implement UserRepository per design",
      subagent_type: "software-developer", batch: 3, depends_on: ["P3"], isolation: "worktree", tdd: "strict",
      task_template: "subagent-software-developer",
      task_params: { task_id: "P4", task_title: "Implement UserRepository",
                     sc_list: "- SC3: UserRepository class exists",
                     tdd_mode: "strict", upstream_outputs: "(from P3 design)",
                     files_to_touch: "src/auth/repository/UserRepository.ts" },
      inputs: [{ from_task: "P3", field: "design", embed: "inline" }],
      acceptance: { covers: ["SC3"], self_check_cmd: "npm run typecheck" },
      output_schema: { kind: "code_changes", path: "src/auth/repository/UserRepository.ts" },
    },
    {
      id: "P5", description: "Refactor service.ts to use UserRepository",
      subagent_type: "software-developer", batch: 3, depends_on: ["P3"], isolation: "worktree", tdd: "strict",
      task_template: "subagent-software-developer",
      task_params: { task_id: "P5", task_title: "Refactor service.ts",
                     sc_list: "- SC1: no database import\n- SC2: no database import",
                     tdd_mode: "strict", upstream_outputs: "(from P3 design + P4 code)",
                     files_to_touch: "src/auth/service.ts" },
      inputs: [
        { from_task: "P3", field: "design", embed: "summary" },
        { from_task: "P4", field: "code", embed: "summary" },
      ],
      acceptance: { covers: ["SC1", "SC2"], self_check_cmd: "! grep -q 'from.*database' src/auth/service.ts" },
      output_schema: { kind: "code_changes", path: "src/auth/service.ts" },
    },
    {
      id: "P6", description: "Add unit tests for refactored boundary",
      subagent_type: "software-developer", batch: 4, depends_on: ["P5"], isolation: "worktree", tdd: "strict",
      task_template: "subagent-software-developer",
      task_params: { task_id: "P6", task_title: "Add unit tests",
                     sc_list: "- SC5: tests pass\n- SC6: coverage >= 80%",
                     tdd_mode: "strict", upstream_outputs: "(from P5 refactor)",
                     files_to_touch: "test/auth/" },
      inputs: [{ from_task: "P5", field: "code", embed: "summary" }],
      acceptance: { covers: ["SC5", "SC6"], self_check_cmd: "npm test" },
      output_schema: { kind: "code_changes", path: "test/auth/" },
    },
    {
      id: "P7", description: "Audit full refactor",
      subagent_type: "software-auditor", batch: 5, depends_on: ["P6"], isolation: "none", tdd: "none",
      task_template: "subagent-software-auditor",
      task_params: { task_id: "P7", task_title: "Audit refactor result",
                     sc_list: "(all 6 SCs)", depth: "full",
                     task_report_path: ".pi/orchestrator/task-P6-report.md",
                     isolation: "worktree" },
      acceptance: { covers: ["SC1", "SC2", "SC3", "SC4", "SC5", "SC6"] },
      output_schema: { kind: "verdict", path: ".pi/orchestrator/audit-P7.md" },
    },
  ],
});

// ── Stage 3: task_dispatch({ dag_id: "DAG-2025-001", strategy: "auto" }) ──
//   (LLM receives 5 batches of Agent tool calls to execute in order)

// ── Stage 4: orchestrator_audit({ dag_id: "DAG-2025-001" }) ──
```

Each `task_template` field auto-renders the prompt at `dag_synthesize` time, injecting TDD discipline + First Action Protocol + output contract. The `inputs` field tells `task_dispatch` to read upstream task outputs from disk and append them as context.