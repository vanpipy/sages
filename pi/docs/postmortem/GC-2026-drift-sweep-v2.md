# GC-2026-drift-sweep-v2

**Severity**: minor
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main` (1 commit + 1 merge)

## What happened

A second-round drift sweep after 3 GCs that touched prompt / spec / chat-stream layers (`GC-2026-advisor-pairs`, `GC-2026-advisor-spec-integration`, `GC-2026-chat-stream-render`). Same 5 categories from v1 plus 3 new patterns specific to the latest GCs:

- `partial: true` (the wrong shape from `GC-2026-workflow-chat-stream`)
- `advisorOf` (new metadata field for paired tasks)
- `MergerAdvisor | DeveloperAdvisor | ReviewerAdvisor | FixAdvisor` (4 advisor agent type names)

## What was found (v2 results)

Two new drift sites:

1. `README.md:67` — `workflow_run(goal_path) (canonical 5-phase pipeline)` — top-level repo description still says 5-phase. Should be 4-phase.
2. `pi-orchestrator/skills/orchestrator/templates/prompts/subagent-developer.md:31` — `findings[] on verdict=NEEDS_WORK` — 2-state description in a template doc. Should mention the 4-state defensive handling that `GC-2026-prompt-4-state-accuracy` added to `_fix.ts`.

Three categories were clean:

- `partial: true` — 0 hits. `GC-2026-chat-stream-render` removed the stray literal cleanly.
- `advisorOf` — 1 legitimate hit in `phase-widget.ts:347` (the only intended use). No false positives.
- `MergerAdvisor | DeveloperAdvisor | ReviewerAdvisor | FixAdvisor` — all 19 hits are in expected places (default-agents.ts AgentConfig + DEFAULT_AGENTS, SYSTEM.md Pipeline pattern, workflow-graph.ts spec, phase-widget.ts, advisor prompt files). No drift.

The 5 categories from v1 were also clean (the v1 GC already fixed the drift sites):

- 2-state verdict residue — 0 new hits (all 10 hits are pinned sections, postmortems, or pinned prompt branches).
- `Auditor` residue — same keep-list as v1 (namespace role, back-compat alias, postmortems).
- `dag_id` residue — same keep-list.
- `5-phase` residue — v1 fixed SKILL.md + SYSTEM.md. README.md was missed; this GC fixed it.
- `Never .pi/` consistency — both `SYSTEM.md` and `commit-conventions.ts` have the rule. v1 confirmed.

## Fix

Two edits:

1. `README.md:67` — `5-phase pipeline` → `4-phase pipeline: Implement → Review ⇆ Fix → Merge`.
2. `subagent-developer.md:31` — `(or 4-state defensive handling for NEEDS_REDESIGN / NEEDS_CLARIFICATION)` appended to the verdict description.

Both are 1-line doc comments. No source code change. No agent prompt change. No schema change.

## What was NOT done

- The v1 keep-list is preserved: `Auditor` in `namespace-ownership.ts` (namespace role) and `merge-recommendation.md` (audit file pattern) are kept; `dag_id` in `invocation-config.ts` / `worktree-contract.ts` / `agent-manager.ts` (back-compat alias) is kept; postmortem historical references are kept.
- `pi-orchestrator/skills/orchestrator/templates/goals/` (4 goal YAML templates) — these still use the old 4-task pipeline pattern (`TaskCreate(Fix, agentType="Developer", ...)`). They are example scaffolds for the brainstorming skill, not runtime templates. Their staleness is tracked separately.
- Catalog files (`catalogs/event.json`, `catalogs/namespace.json`, `catalogs/subagent.json`) — none of the GC-2026-drift-sweep-v2 changes touch their `_source_files`. The v1 `_source_hash` for `namespace.json` is already on the drift list (the namespace role "auditor" doesn't match "Reviewer"). Catalog regen would propagate the same drift; not in scope.

## Tests

No new tests (drift sweep is documentation-only). `bun run typecheck` green on all 3 packages. `bun test` shows pre-existing failures unchanged from main baseline (5 in pi-orchestrator: 4 SMOKE-073 + 1 verify:catalog; 8 in pi-tasks: TaskStore / projectKey / sessionTaskFile; etc).

## Verification

| # | Item | Status |
|---|---|---|
| 1 | `partial: true` residual grep | ✓ 0 hits |
| 2 | `advisorOf` false positive grep | ✓ 1 hit (legitimate in phase-widget.ts) |
| 3 | `MergerAdvisor | DeveloperAdvisor | ReviewerAdvisor | FixAdvisor` grep | ✓ 19 hits (all expected) |
| 4 | 2-state verdict grep | ✓ 0 new hits (all are pinned sections / postmortems) |
| 5 | `Auditor` / `dag_id` / `5-phase` grep | ✓ 2 new hits found, both fixed in this GC |
| 6 | `Never .pi/` consistency | ✓ both present |
| 7 | typecheck green, no regressions | ✓ |

## Effect on the user

Two minor doc comments fixed:
- Top-level README's description of `workflow_run` now matches the actual 4-phase pipeline (was 5-phase, post-Fix-dynamic).
- The subagent-developer template's Fix phase description now reflects the 4-state defensive handling that was added in `GC-2026-prompt-4-state-accuracy`.

## Lessons learned

- **Drift sweep rounds catch the previous round's misses, plus new drift introduced by the round's work.** This v2 found 2 sites v1 missed: `README.md` (top-level repo description, v1 didn't grep at this depth) and `subagent-developer.md` (template doc, v1 didn't grep inside the templates/prompts/ subdir). The sweep grows in coverage as it iterates.
- **3 new GCs each had the chance to introduce new drift but didn't** (the new grep patterns for `partial: true` and `advisorOf` came up clean). The prompts and spec changes were surgical and the file paths they touched didn't propagate stale text. This is the desired outcome of small-scoped GCs.
- **Top-level files (README.md, AGENTS.md) drift slowest** because they are not opened by per-GC scope work. The drift sweep is the only thing that catches them. A future GC candidate: a "top-level sweep" that runs every GC, scanning just `README.md` + `AGENTS.md` + top-level `*.json` / `*.md` for any new vocabulary.

Refs: GC-2026-drift-sweep-v2
