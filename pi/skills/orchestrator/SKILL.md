---
name: orchestrator
description: Orchestrate multi-task workflows via 4-stage DAG (goal → decompose → dispatch → audit). Coordinates `developer` (canonical) and `auditor` subagents for execution.
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
**Orchestrator Mode** (Soft mode — GC-2026-031)
- Main agent has full tool access (edit / write / aft_edit /
  apply_patch, unrestricted bash). Nothing is blocked.
- Subagent dispatch is RECOMMENDED for workflows with >2 items
  in the active todowrite; direct handling is acceptable for ≤2.
- Stage 1: goal_contract_create → .pi/orchestrator/goal-{id}.yaml
- Stage 2: dag_synthesize → .pi/orchestrator/dag-{id}.yaml
- Stage 3: task_dispatch → for each batch: spawn subagents + wait + audit
- Stage 4: final orchestrator_audit → .pi/orchestrator/audit-workflow.md
```

## Subagent Contract — The 4-Agent Pipeline

The main agent first understands and decides, including architecture, trade-offs,
scope, acceptance, and dependencies. It then passes a complete Planning Brief
to Plan for bounded compilation; the main agent reviews the result before
implementation dispatch.

| Stage | `subagent_type`     | Source                              | `run_in_background` | When to dispatch                                                                 |
|-------|----------------------|--------------------------------------|---------------------|----------------------------------------------------------------------------------|
| 1     | `Explore`            | **pi-subagents built-in**            | `false`             | "Where is X?" / "find all callers of Y" / pure codebase search                    |
| 2     | `Plan`               | **pi-subagents built-in**            | `false`             | Compiles the main agent's Planning Brief; bounded read-only helper, not an architecture stage. |
| 3     | `developer`         | **shipped** (pi-subagents built-in) | **`true`**          | Write production code + tests in a managed worktree, strict TDD                    |
| 4     | `auditor`   | **shipped** (this repo)              | **`true`**          | Certify Stage 3's work — re-run every verification_cmd, read-only on production   |
| Cross-workspace merge verification | `merger (pi-subagents built-in)` | **pi-subagents built-in** | **`true`**          | Dispatched by the orchestrator after DAG synthesis detects cross-workspace file overlap; reads both diffs, classifies, produces merge commit or escalates hunk-conflict. |
| Git inspection / archaeology | `git-expert (pi-subagents built-in)` | **pi-subagents built-in** | **`true`**          | Dispatch when `git worktree add` fails, conflict preview is needed before merger, a commit appears lost, a bisect is required, branch hygiene is requested, or another subagent needs a runnable git procedure (see "When to dispatch git-expert" below). Read-only on production code; writes confined to `.pi/git-scratch-<task_id>-<suffix>/`. |

`run_in_background` defaults are derived from `subagent_type` by `pi/src/tools/orchestrator/task-dispatcher.ts:defaultRunInBackground()` (single source of truth). The table is the canonical reference; see `pi/templates/SUBAGENTS.md` for full rationale and code examples.

> **DAG-2026-011 Phase C**: the `general-purpose` subagent was removed.
> Ad-hoc research that doesn't fit a specific role should be done in
> the main session (soft mode grants full tool access by default) or
> by combining Stages 1 (`Explore`) and 2 (`Plan`). The `developer`
> agent handles design-doc writes for design tasks; Stages 3-4 are
> specialised on purpose.

#Before dispatching Plan, the main agent must supply a self-contained Planning Brief containing Goal, chosen approach/decisions, scope/exclusions, critical files/symbols, acceptance/verification, dependencies/sequencing, and known risks/open questions. Plan compiles it; incomplete decisions remain with the main agent.

## When each stage is recommended

Under soft mode no stage is required. The table below is the
recommended routing, anchored to the profile's `dag_threshold`
(default `2` — DAG recommended when todowrite exceeds it):

| Task shape                                  | Recommended stages (for >2 todowrite items) |
|----------------------------------------------|------------------------------|
| Single trivial edit (one-line fix, typo)     | none — edit directly         |
| Pure research question ("where is X?")       | 1 (`Explore`)                |
| Architectural decision, no code change       | 1 → 2                        |
| Refactor with existing plan                  | 3 (skip 1+2)                 |
| New feature / multi-file / multi-decision    | 1 → 2 → 3 → 4                |

For workflows with **≤2 items** in the active todowrite you may
handle directly with `edit` / `write` / `bash` in the main
session — no DAG is required.

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
   - For `developer` tasks: use `isolation: { dag_id: DAG_ID, task_id: TASK_ID, mode: "create" }` (managed worktree object required by the Agent dispatcher)
   - For other subagents (`auditor` / `Explore` / `Plan`): no `isolation` field (operate in dispatcher cwd)
   - The subagent receives its task's prompt from the dispatch plan
3. Wait for all tasks in the batch to complete (get_subagent_result)
4. Run orchestrator_audit({ dag_id, batch }) to verify the batch
5. If REVISE/REJECT → re-dispatch affected tasks with steer_subagent
6. If PASS → proceed to next batch
```

#### Subagent dispatch contract

When dispatching via the `Agent` tool, pick the right subagent type:

| Task | Subagent | `isolation` |
|--- |--- |--- |
| Meta-file edits / design-doc writes (no code) | `developer` (with `tdd: none`) | `"current-workspace"` (no worktree; agent operates in dispatcher's cwd) — OR `{ dag_id, task_id, mode: "create" }` if a worktree is genuinely needed (e.g. parallel batch isolation) |
| Production-code TDD work | `developer` (legacy alias: `developer`) | `{ dag_id, task_id, mode: "create" }` (managed worktree) |
| Serial follow-up in same workspace (multi-task DAG) | `developer` | `{ dag_id, task_id, mode: "reuse" }` (reuses the prior slot) |
| Audit / evidence collection | `auditor` (alias: `auditor`) | none |
| Quick read-only search | `Explore` | none (built-in) |
| Planning Brief compilation | `Plan` | none (built-in) |
| Git inspection / backtrack / cross-subagent recipe | `git-expert` | none (read-only on production code; writes in `.pi/git-scratch-<task_id>-<suffix>/`) |

The legacy `isolation: "worktree"` string literal is **rejected** by the current Agent dispatcher. The `developer` agent now accepts three explicit isolation modes: `{ dag_id, task_id, mode: "create" }` (fresh worktree, default for production code), `{ dag_id, task_id, mode: "reuse" }` (re-enter existing worktree for serial follow-ups), or `"current-workspace"` (no worktree, agent runs in dispatcher's cwd — the explicit opt-out for meta-file edits and design-doc writes). `isolation: undefined` is rejected; every dispatch must name one.

#### When to dispatch `git-expert`

Dispatch `git-expert` whenever the orchestrator would otherwise accumulate
ad-hoc Git reasoning in chat. Concretely:

| Symptom | Without git-expert | With git-expert |
|---|---|---|
| `git worktree add` failed for any reason (path collision, branch already checked-out, missing `.git` pointer, bare-repo format) | Retry / fallback / punt to user | `scenario: worktree-broken` — diagnosis + recommended action |
| Predicting merge conflict shape before dispatching `merger` | Blind dispatch; discover only at audit | `scenario: merge-conflict-preview` — independent conflict classification |
| "Commit X is missing" / ref appears broken after a rebase / reset / branch delete | No procedure | `scenario: lost-commit` — fsck + reflog + recovery plan inside scratch |
| "When did bug Y appear?" / "find the first bad commit" | Main agent does ad-hoc `git log -S` | `scenario: bisect` — runnable `git bisect run` script returned |
| Periodic prune review (stale branches, orphaned worktrees, unreferenced tags) | Skip | `scenario: branch-hygiene` — prune candidate list (orchestrator executes deletes) |
| Another subagent (`developer`, `merger`) needs a step-by-step git procedure | Inline hand-waving in dispatch prompt | `scenario: git-recipe-for-<role>` — format-pinned recipe with pre-conditions / steps / failure modes / verify / forbidden |

`git-expert` is read-only on production code (no `edit` / `write` tools; all
writes happen via `bash` inside `.pi/git-scratch-<task_id>-<suffix>/`,
which is gitignored). The agent returns `BLOCKED: missing <field>` when
the brief omits `task_id`, `scenario`, or `repo_root` — fill the gap,
don't guess. For DAG dispatch, set `task_template: "subagent-git-expert"`
(in the `KNOWN_TEMPLATES` whitelist as of GC-2026-030); for ad-hoc dispatch,
use `subagent_type: "git-expert"`. Full brief format and recognized
scenarios in `pi/templates/SUBAGENTS.md` § "Git Expert".

> **Note**: `isolated: true` disables Sages extension loading entirely. The subagent loses AFT / codebase-memory / magic-context but gains extension-free bash. Under soft mode the bash-guard no longer blocks, so `isolated: true` is rarely needed; it remains available for subagents that explicitly require extension-free execution. `general-purpose` was removed in DAG-2026-011 Phase C — for ad-hoc shell work, handle directly in the main session (soft mode grants full tool access) or use the `auditor` agent with `isolated: true`.

### Parallelism

When dispatching multiple sub-tasks for a single workflow stage:

```ts
// ✓ one message, multiple background calls
Agent({ subagent_type: "Explore", prompt: "...", run_in_background: true })
Agent({ subagent_type: "Explore", prompt: "...", run_in_background: true })
Agent({ subagent_type: "developer", isolation: {...}, prompt: "...", run_in_background: true })
```

Don't serialize when tasks are independent. Foreground is the default for `Explore`/`Plan` because the system expects these to be short helper tasks where the result feeds the next decision — use it deliberately for that case.

Background is the default for `developer`/`auditor` (5-10 min TDD / audit) — collect results via notification or `get_subagent_result()`.

### When NOT to parallelize

The principle: **parallelize independent tasks; serialize dependent ones**. Don't parallelize:
- Multiple `git commit`s (share `.git/index` and `HEAD`; each needs previous SHA as parent)
- Multiple edits to the **same file** (working tree race)
- Lockfile updates (`package-lock.json`, `Cargo.lock`)
- `npm install` / `cargo build` (shared build artifacts)

The orchestrator's recent commit chain was all serial foreground — and that was correct. See commit history `0b7827d` → `91d5cfd` → ... → `9cd121a` for examples.


**Dispatch patterns**

```ts
// Meta-file edit / design-doc write (developer in current workspace, no worktree)
Agent({
  subagent_type: "developer",
  isolation: "current-workspace",
  tdd: "none",
  prompt: "Edit AGENTS.md to add Z. Read first, edit, report diff.",
  run_in_background: true,
})

// Meta-file edit that needs worktree isolation (e.g. parallel batch)
Agent({ subagent_type: "developer", isolation: { dag_id, task_id, mode: "create" }, tdd: "none", prompt: "Write .pi/orchestrator/task-P3-design.md ...", run_in_background: true })

// Production-code TDD (developer + worktree)
Agent({
  subagent_type: "developer",
  isolation: { dag_id: <dag-id>, task_id: <task-id>, mode: "create" },
  prompt: "...",
  run_in_background: true,
})

// Serial follow-up in same workspace (reuse existing worktree)
Agent({
  subagent_type: "developer",
  isolation: { dag_id: <dag-id>, task_id: <task-id>, mode: "reuse" },
  prompt: "...",
  run_in_background: true,
})

// Audit (auditor)
Agent({ subagent_type: "auditor", prompt: "...", run_in_background: true })

// Git inspection / archaeology / cross-subagent recipe (git-expert)
// Brief must carry task_id + scenario + repo_root; git-expert returns
// BLOCKED if any are missing. Read-only on production code; writes
// happen only inside `.pi/git-scratch-<task_id>-<suffix>/` (gitignored).
Agent({
  subagent_type: "git-expert",
  prompt: [
    "task_id: GC-2026-031",
    "scenario: merge-conflict-preview",
    "repo_root: /home/leroy/Project/sages",
    "symptom: P2 developer reports 'push fails, non-fast-forward' on DAG-2026-031/P1; we want to classify the upcoming conflict shape BEFORE dispatching merger.",
  ].join("\n"),
  description: "Preview merge conflict before dispatching merger",
  run_in_background: true,
})
```


The DAG's batch numbers should *roughly* follow the pipeline order, but batching is for parallelism within a stage, not across:
- Batch 1 (research): one or more `Explore` tasks in parallel — discover all the things you'll need before planning
- Batch 2 (planning): one or more `Plan` tasks, each consuming research outputs from Batch 1
- Batches 3+ (implementation): one or more `developer` tasks per batch (managed-worktree-isolated, TDD)
- Final batch (verification): one or more `auditor` tasks, each auditing a discrete chunk of implementation

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

**A3 split**: per-task auditing is the **auditor subagent's** job (it
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
   - validation.findings_required_min: 1 (fast) or 3 (full) — minimum
     findings you must submit before `complete` is accepted
3. Run any blocking-tasks through auditor; then call again.
4. Collect workflow-level findings (cross-task consistency, integration SCs,
   coverage gaps) and submit them, then complete — either in one call or two:

   // ── 2-call pattern (explicit, recommended) ─────────────────────
   orchestrator_audit({
     dag_id,
     observation: { findings: [
       { category: "nose", severity: "minor", issue: "SC4 has no audit", evidence: "..." },
       { category: "foot", severity: "critical", issue: "Integration test fails", evidence: "..." },
     ] }
   })
   orchestrator_audit({
     dag_id,
     observation: { complete: { verdict, score, summary } }
   })

   // ── 1-call pattern (also supported) ─────────────────────────────
   orchestrator_audit({
     dag_id,
     observation: {
       findings: [/* ... */],
       complete: { verdict, score, summary },
     }
   })

5. Report verdict + score to user
```

**Evidence gate (cannot be bypassed)**: when the LLM calls `complete` with
`verdict: "PASS"`, the tool auto-downgrades to `REVISE` if either:
- `findings.length < validation.findings_required_min` (so a "PASS with no
  findings" rubber-stamp is rejected), or
- `workflowReady === false` (so un-certified blocking tasks force a REVISE
  even when the LLM claims PASS).

The error message identifies which condition failed.

**Path contract**: when you call with `task_id: "P1"`, the tool writes
`audit-P1.md` and returns its path. With `batch: 1`, it writes `audit-1.md`.
With no filter, it writes `audit-workflow.md`. The path returned in
`report_path` is the path the file was actually written to — no longer
diverges from the result.

**Why A3 split?** Per-task audit (re-run verification_cmd, inspect diff, check
TDD discipline) was duplicated 80% between `orchestrator_audit` and
`auditor`. Now: auditor = per-task expert; orchestrator_audit
= workflow-level aggregator. Zero overlap.

**Audit tool call count (fast depth, batched findings)**:
- 1× init (no observation)
- 1× record (batched findings)
- 1× complete
- Total: **3 tool calls** (one-finding-per-call was 5+)

## Workspace + Handoff + Merger

The workflow uses three coordinated sub-protocols: workspace semantics,
HANDOFF.md-based session continuity, and dedicated cross-workspace merging.
The canonical protocol is reproduced below:

```markdown
## Workspace semantics
A worktree is a **workspace**, not just an isolation boundary. One workspace
hosts a sequence of related developer tasks that build on each other's commits.

- Workspace identity = batch id (one workspace per DAG batch by default).
- Tasks sharing a workspace_id run **sequentially** on the same branch
  `sages/<dag>/<workspace_id>` — they never run in parallel within one workspace.
- Within a workspace, predecessor commits + HANDOFF.md carry forward to
  successor tasks.

## Handoff protocol (HANDOFF.md)
A workspace is preserved across developer sessions via HANDOFF.md:

- **Writing HANDOFF (on exit)**. The developer writes
  `.pi/orchestrator/handoff/<workspace_id>/<task_id>-handoff.md`
  containing:
  (a) one-paragraph task summary;
  (b) files left in modified state;
  (c) TODOs for successor + which files need follow-up;
  (d) test status (passing / failing / pending);
  (e) any open questions to relay forward.

- **Reading HANDOFF (on entry)**. The developer's First Action Protocol extends
  to read every `<task_id>-handoff.md` under
  `.pi/orchestrator/handoff/<workspace_id>/` ordered by task_id.
  Skipping this is an automatic audit failure.

## Cross-workspace merging
When two workspaces edit the same files (detected at DAG synthesis), the
orchestrator dispatches the dedicated `merger` sub-agent:

- reads both diffs (`git diff base..ws-A` and `git diff base..ws-B`),
- classifies overlap as **clean / disjoint-hunk / hunk-conflict**,
- produces a merge commit when feasible; escalates hunk-conflicts back to the
  orchestrator (NOT auto-resolved — hunk-conflict on the same lines cannot be
  safely machine-resolved),
- verifies the merged result with typecheck + lint + the merged test suite
  (not per-workspace tests).

The `auditor` continues to verify **per-task** commits; the `merger` verifies
the **cross-workspace** merge result.
```

This canonical text is mirrored byte-for-byte in
`pi-subagents/src/agent-prompts/developer.ts` and
`pi-subagents/src/agent-prompts/merger.ts`.

**Read (always allowed)**:
- `aft_search`, `aft_zoom`, `aft_outline`, `aft_read` — code understanding
- `ctx_search` — query Magic Context for past experiences
- `codebase_search`, `codebase_refs` — symbol lookup

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
- TDD execution → delegated to `developer` subagent (see SUBAGENTS.md)
- Audit → `orchestrator_audit` (workflow-level rollup; A3 split — per-task detail handled by `auditor`)

**Write (delegated only — do NOT edit production code directly)**:
- `edit`, `write` — only for orchestrator metadata in .pi/orchestrator/
- Everything else → delegate to `developer` subagent

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
| `subagent-developer` (canonical) | developer | Includes First Action Protocol + STRICT TDD guidance + output contract |
| `subagent-developer` (Phase A alias — warns) | developer | Same shape as canonical; use `subagent-developer` for new authoring |
| `subagent-auditor` | auditor | Default NEEDS WORK + 6-step audit + 5/3-phase depth |
| `subagent-explore` | Explore | Read-only enforcement + findings.json output schema |

(`subagent-general-purpose` was removed in DAG-2026-011 Phase C. The
canonical `auditor` template is `subagent-auditor`; the
alias `subagent-auditor` is the Phase B canonical name.)

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
- OR set `task_template: "subagent-developer"` + `task_params: {...}` → tool auto-renders (legacy `subagent-developer` still resolves with a deprecation warning)

The auto-render path is preferred — templates encode the discipline (TDD, First Action Protocol, output contract) that the orchestrator wants every subagent to follow.

Template substitution uses `{{var}}` for variables and `{{#if var}}...{{else}}...{{/if}}` for conditionals. Variables not provided are rendered as `[varname]` placeholders.

## Subagent Boundaries

Under soft mode these are guidelines, not hard rules. The
recommended pattern remains the 4-stage DAG workflow for
>2-item workflows.

You do NOT (recommended):
- Edit production code directly when your active todowrite has
  >2 items (dispatch `developer` with managed worktree instead)
- Re-decompose after dispatch (use steer_subagent or re-run with force)
- Override the goal contract without user re-prompt
- Skip stages when complexity warrants (recommended: 1 → 2 → 3 → 4)

You DO:
- Read + analyze (your job)
- Maintain the DAG state (.pi/orchestrator/)
- Run orchestrator_audit on each batch
- Surface mid-run drift to user
- Decide retry vs replan on subagent failure

For ≤2-item workflows, direct `edit` / `write` / `bash` in the main
session is also acceptable. Nothing is blocked.

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

## `.pi/orchestrator/` namespace ownership

Developers may write only `task-{task_id}-report.md` and
`handoff/{workspace_id}/{task_id}-handoff.md`; auditors may write only
`audit-{task_id}.md`. L3 owns `goal-{id}.yaml`, DAG, audit-state, and workflow
rollup files. Cross-namespace overwrites are prohibited; Explore and Plan stay
read-only.

## Examples

For full end-to-end examples (multi-file refactor, new feature, etc.) see the DAG templates under `~/.pi/packages/sages/skills/orchestrator/templates/dag/` (`dag-tdd-refactor.yaml`, `dag-bug-fix.yaml`). They are the canonical reference and are regression-guarded against drift by `pi/test/tools/orchestrator/template-loader.test.ts`.

For single trivial tasks (e.g. "rename `db` to `database` in src/auth/"), do **not** use the orchestrator — edit directly.