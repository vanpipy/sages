# GC-2026-path-B-audit-fixes — Postmortem

**Severity:** minor
**Resolved:** 2026-10-01
**Branch:** `gc-2026-path-B-audit-fixes`

## What happened

After GC-2026-path-B-swap replaced path A's 1060-line state machine
with a thin event-driven shim, an audit of the three Sages packages
found stale references scattered through docs, comments, agent
prompts, and templates. The audit produced a 4-tier priority list
(P0/P1/P2/P3) that this GC resolved in 7 commits.

The big-picture fix was doc + comment cleanup. No runtime behavior
changed; no new tools added; no schemas modified. The goal was to
make the codebase self-consistent with path B so a new contributor
or LLM does not trip over deleted-tool references.

## Root cause

Path B's three-layer architecture (planning/tracking/executing) was
new, but the doc strings, agent prompts, and templates predated the
refactor. After GC-2026-orchestrator-simplify (which removed the DAG
tools) and the rename GCs (Auditor → Reviewer, Plan → PlanCompiler,
Auditor alias removal), the code was correct but the prose still
described path A's 4-stage DAG pipeline.

The most common stale pattern: `dag_synthesize(...)` showing up in
orchestrator templates that no orchestrator tool ever called
anymore. The patterns fall into three buckets:

1. **User-facing docs** (`README.md`, `SKILL.md`, `agent-tool-description.md`):
   Highest blast radius — a new contributor reading the README would
   conclude the orchestrator owns 5 tools when it actually owns 2.
2. **LLM-facing prompts** (`developer.ts`, `reviewer.ts`, `merger.ts`):
   Subagent prompts taught the agents wrong things — that the
   auditor ran `verification_cmd`, that goal files were DAG tasks,
   etc.
3. **Templates** (`templates/dag/`, `templates/goals/*.yaml`,
   `templates/prompts/*.md`): Orphan files no one called, or
   templates using `success_criteria[]` fields that
   `goal_contract_create`'s validator would have rejected.

## Fix

7 commits, organized by blast radius (largest first):

1. `a3580ef docs(audit-fixes): batch 1` — README, AGENTS.md, SKILL.md
   adjacents (brainstorming, codebase-memory, standard.md prompt,
   agent-tool-description.md). One shot, one test, one commit.
2. `5b8cf0a fix(subagents): clean path-A references from agent prompts`
   — three agent prompts dropped verification_cmd + dag_synthesize
   references. developer-prompt and bash-timeout test suites still
   pass (51/51).
3. `eb0c4d8 fix(orchestrator): delete obsolete dag/ + subagent-auditor
   templates, rewrite goal templates to path B` — three template
   deletions + four template rewrites + template-loader.test.ts
   updates (4 cases skipped, 1 case inverted, 1 case rewritten, 1
   new case). 29/29 remaining template-loader tests pass + 2 skipped.
4. `6f8c5da refactor(orchestrator): rename observability/runner.ts
   dagId → goalId` — minimal scope rename. M15 (the same rename in
   pi-subagents worktree-contract) is deferred — it would break the
   LLM-facing ManagedWorktreeRequest.dag_id field.
5. `f148e55 docs(orchestrator): update stale comments after path B
   refactor` — five docstring updates (extension.ts,
   registered-tool-wrapper.ts, goal-contract.ts, types.ts,
   goal-lock.ts).
6. `96c2025 docs(subagents): mark deleted-tool refs in comments as
   historical context` — diagnostic.ts, subagent-info.ts comments
   clarify that orchestrator_audit and dag_synthesize references
   are historical context.
7. `96aba95 docs(orchestrator): mark template-loader.ts taskTemplate
   path as path-A-compat` — one docstring addition noting that the
   renderTaskPrompt machinery is path-A-compat (path B renders
   inline via pi-tasks/phase-prompts.ts).

## Follow-ups

These were identified by the audit but deferred to separate GCs:

- **B2 (pi-evaluator path-B rewrite)** — `pi-evaluator/src/metrics/*`,
  `engine/coefficients-defaults.ts`, `lib/artifact-reader.ts`,
  `types.ts`, `state.ts`, `extension.ts`, `tools/eval-{score,trend}.ts`,
  `skills/evaluator/SKILL.md`, `CHANGELOG.md` all reference
  `dag_synthesize` / `task_dispatch` / `orchestrator_audit` as task
  boundaries and define `success_criteria[]` types. Multi-day
  rewrite; surface as `GC-2026-evaluator-path-B` when ready.

- **M15 (pi-subagents dag_id → goal_id rename)** — would break the
  LLM-facing `ManagedWorktreeRequest.dag_id` field that every
  dispatcher passes. The path B semantic is goal_id, but the field
  name is historical. Rename needs a migration strategy (probably
  accept both names for one release, then deprecate).

- **M12 (personal_todowrite_progress rename)** — the personal
  todowrite tool in `pi-subagents/src/tools/personal-todowrite-tool.ts`
  has the same name as the deleted orchestrator DAG-view
  `todowrite_progress`. Different storage, different purpose, but the
  name collision is confusing for new contributors. Rename to
  `personal_todowrite_progress` (or similar) and update
  `developer.ts` and `default-agents.ts` defaults.

- **pi-subagents comments still referencing deleted tools**
  (`diagnostic.ts:412`, `agent-runner.ts:2249`,
  `settings.ts:497`, `types.ts:154`) — most are correctly labeled as
  historical context, but the layer could use a quick pass to
  tighten any remaining references.

## Lessons

1. **Audit after a big refactor is a discipline, not an afterthought.**
   The path B swap was tested and verified end-to-end, but its doc
   surface went un-audited for ~3 hours of focused work. Running an
   audit right after the swap (when the design is fresh) caught
   12 stale references across 20 files in 30 minutes.

2. **LLM-facing prompts are the highest-blast-radius doc surface.**
   Subagent prompts at `pi-subagents/src/agent-prompts/*.ts` are
   injected verbatim into every agent session. A wrong sentence
   there propagates to every Developer / Reviewer / Merger invocation
   until someone notices the model is confused. They should be the
   first thing audited after a rename.

3. **Templates accumulate cruft faster than prompts.** The
   `templates/dag/` and `templates/prompts/subagent-auditor.md`
   files were orphans with no caller but the template-loader test
   still asserted they existed. The fix was deletion + test skip —
   not a graceful migration — because the orphan status was clear.
   When in doubt, grep for callers before keeping a template.

4. **One rename can be a much bigger change than it looks.** M14
   (renaming `dagId` → `goalId` in a single file) is a 14-line diff.
   M15 (the same rename across `ManagedWorktreeRequest`,
   `WorktreeLease`, `worktree.ts`, `types.ts`, `worktree-contract.ts`)
   is a 200+ line diff that touches every dispatcher. Always
   separate "internal naming" from "API surface" before doing a
   rename.
