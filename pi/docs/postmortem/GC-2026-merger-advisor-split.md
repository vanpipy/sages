# GC-2026-merger-advisor-split

**Severity**: major
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main` (3 commits + 1 merge)

## What happened

A prompt-consistency audit of `pi-orchestrator/`, `pi-tasks/`, and `pi-subagents/` surfaced two P0 issues at the workflow_run → Review ⇆ Fix → Merge boundary:

1. **The Merger prompt directly contradicted workflow_run's Merge-phase dispatch brief**. `pi-subagents/src/agent-prompts/merger.ts:34` taught the agent to "produce merge commits via git plumbing (git merge --no-ff)" and to "classify overlap as clean / disjoint-hunk / hunk-conflict" — the vocabulary of the DAG-synthesis cross-workspace merger. But workflow_run's Merge phase dispatches the same `Merger` agent with a brief that says "From the main checkout ... verify the source branch ... DO NOT execute git merge or push from this agent — these are side-effecting ops requiring a permission gate per ~/AGENTS.md". Same agent type, two completely different contracts, prompts contradicting each other.

2. **`review-{goal_id}-{iteration}.md` was a phantom file** referenced in 6 places (reviewer.ts:148, _fix.ts:78, SKILL.md:185, SYSTEM.md:71, README.md:96, GC-2026-prompt-parser-contract-cleanup.md:41) but never written or read by any code. The actual Reviewer evidence files are `verdict-{task_id}.md` (per-Review, parser fallback) and `last-review-{goal_id}.md` (overwritten each Review, consumed by Merger).

## Root cause

The two issues share a common ancestor: **one agent type ("Merger") was overloaded with two disjoint contracts** — the DAG-synthesis auto-merge contract (read both workspaces, classify overlap, run `git merge --no-ff` when feasible) and the workflow_run advisory contract (read Reviewer evidence, write `merge-recommendation.md`, never run `git merge`).

The DAG-synthesis contract was the original Merger (path A era). When path B introduced workflow_run, the merge phase needed a Merge agent but didn't add a new type — it reused `Merger` with a different brief. The prompt was never updated; only the brief was. An agent reading its system prompt first and dispatch brief second would be primed to auto-merge against a protected branch, violating `~/AGENTS.md` "Permission gate required".

The phantom file emerged from a documentation drift: the dispatch brief at `workflow-graph.ts:147` cited `review-{goal_id}-{iteration}.md` as the "durable evidence trail pattern" — a reference copied from `GC-2026-b7`'s design intent. The actual implementation in `workflow-handler.ts:387-407` chose a different file (`last-review-{goal_id}.md`, overwritten each Review) to satisfy GC-2026-b7's "Merger consumes Reviewer evidence" requirement. No one updated the brief to match the implementation; the implementation moved on; the phantom persisted across 4 subsequent GCs.

## Fix

**Merger split**: Two distinct agent types, each with its own narrowly-scoped prompt.

- **`Merger`** (existing, unchanged) — DAG-synthesis cross-workspace auto-merge. Lives at `pi-subagents/src/agent-prompts/merger.ts`, still exports `MERGER_PROMPT`. Used by future path-A-style orchestration (currently no caller after path-B; the type is preserved for backward compat with any future DAG-synthesis dispatch).
- **`MergerAdvisor`** (new) — workflow_run's Merge phase, advisory only. New file at `pi-subagents/src/agent-prompts/merger-advisor.ts` exports `MERGER_ADVISOR_PROMPT`. The prompt has hard prohibitions (`DO NOT execute git merge`, `DO NOT execute git push`, etc.) anchored to `~/AGENTS.md` "Permission gate required". Output target is `.pi/orchestrator/merge-recommendation.md`.

**Phantom file replacement**: 6 references to `review-{goal_id}-{iteration}.md` replaced with `.pi/orchestrator/last-review-{goal_id}.md` (the file that workflow-handler actually writes). Affected files:

- `pi-subagents/src/agent-prompts/reviewer.ts:148` — Reviewer writes evidence trail
- `pi-subagents/src/agent-prompts/_fix.ts:78` — Fix fallback path when verdict metadata missing
- `pi-tasks/src/workflow-graph.ts:147` — Review dispatch brief cites the pattern
- `pi-orchestrator/skills/orchestrator/SKILL.md:185` — namespace ownership table
- `pi-orchestrator/templates/SYSTEM.md:71` — namespace ownership table
- `README.md:96` — namespace ownership table

The historical postmortem `GC-2026-prompt-parser-contract-cleanup.md:41` keeps the original reference (it's a frozen historical artifact, not a runtime doc).

**Default agents registration**: `pi-subagents/src/default-agents.ts` adds `MERGER_ADVISOR_AGENT` alongside the existing `MERGER_AGENT`. Both registered in `DEFAULT_AGENTS` Map.

**Workflow graph wiring**: `pi-tasks/src/workflow-graph.ts` changes the Merge task's `agentType` from `"Merger"` to `"MergerAdvisor"`. The dispatch brief (`mergeDescription`) was already advisory-only; the change is consistent with the brief.

### Tests

- `pi-subagents/test/merger-prompt.test.ts`: 6 new tests covering MERGER_ADVISOR_PROMPT invariants — non-empty, identifies as advisory, names `merge-recommendation.md` as the single output target, forbids `git merge` / `git push`, does NOT carry DAG-synthesis auto-merge language, references `last-review-{goal_id}.md` (not the phantom). **33/33 pass.**
- `pi-subagents/test/default-agents.test.ts`: 3 new tests for `MergerAdvisor` registration — registered in `DEFAULT_AGENTS`, displayName "Merger (Advisor)", uses MERGER_ADVISOR_PROMPT (not MERGER_PROMPT). Plus existing test loop extended to cover the new type's `pi-subagents` exclude. **63/63 pass.**
- `pi-tasks/test/workflow-graph.test.ts`: existing `every task has an agentType matching its phase` updated to map `merge → MergerAdvisor`. **12/12 pass.**

Pre-existing failures in `pi-tasks` (12 tests in TaskStore list ID resolution, projectKey, sessionTaskFile, subscribeWorkflow active marker — all pre-GC failures documented elsewhere) are not introduced by this GC.

`bun run typecheck` green on pi-subagents + pi-tasks + pi-orchestrator.

## Verification

| # | Item | Status |
|---|---|---|
| 1 | `MERGER_ADVISOR_PROMPT` exported, advisory contract, forbids git merge/push, names output target, references real evidence file | ✓ merger-prompt.test.ts 6 tests |
| 2 | `MergerAdvisor` registered in `DEFAULT_AGENTS`, uses MERGER_ADVISOR_PROMPT, excludes `pi-subagents` | ✓ default-agents.test.ts 3 tests |
| 3 | workflow_run Merge task uses `agentType: "MergerAdvisor"` | ✓ workflow-graph.test.ts existing test updated |
| 4 | 6 phantom file references replaced with `last-review-{goal_id}.md` | ✓ grep clean (only intentional references remain: test assertions + postmortem) |
| 5 | typecheck green on all 3 packages | ✓ |
| 6 | pre-existing test failures unchanged (no regressions) | ✓ main baseline comparison |
| 7 | postmortem + gc-index | ✓ this file + gc-index.md |

## Out of scope (deferred)

1. **Reviewer prompt 2-state** + **Fix prompt review-{goal_id}-{iteration}.md path** + **agent-tool-description.md 4 stale references** + **SYSTEM.md "5-phase" stale claim** + **SYSTEM.md Fix agentType = "Developer"** + **SKILL.md NEEDS_REDESIGN/NEEDS_CLARIFICATION missing** — these are the rest of the prompt-consistency audit, deferred to `GC-2026-prompt-4-state-accuracy`.

2. **`commit-conventions.ts` "Never .pi/" rule** is currently only in SYSTEM.md (orchestrator's view), not in the shared Developer + Reviewer section. Adding it requires unlocking `sections-drift.test.ts` byte-identity pin. Deferred to `GC-2026-prompt-4-state-accuracy`.

3. **Test coverage gaps** (substring-match tests that don't pin the real invariant — `sections-drift.test.ts:113` substring test passes for both 2-state and 4-state FINAL_VERDICT_REVIEWER_SECTION). Deferred to `GC-2026-prompt-4-state-accuracy`.

4. **The remaining 6 phantom-file references** in `pi-subagents/src/agent-prompts/merger-advisor.ts:28` (a comment explaining what was replaced) and `pi-subagents/test/merger-prompt.test.ts:436-438` (test description + assertion verifying the fix). These are intentional historical references, not stale references.

## Effect on the user

- workflow_run's Merge phase now has a single agent type (`MergerAdvisor`) whose prompt + brief agree. The Merger will never attempt to auto-merge against a protected branch.
- The 6-layer documentation drift around `review-{goal_id}-{iteration}.md` is resolved; every reference now points at the file that actually exists.
- The DAG-synthesis Merger is preserved as a separate type for any future orchestration that needs cross-workspace auto-merge.

## Lessons learned

- **Same agent type, two contracts** is a dangerous pattern. The shared system prompt is always read first; the dispatch brief only fills in the gaps. When two callers use the same agent for different jobs, split the type.
- **Documentation drift on file paths is invisible until grep**. Six references to a phantom file accumulated over 4 GCs because no test verified the file actually existed. This GC adds a grep assertion to the merger-prompt test suite (`expect(MERGER_PROVISOR_PROMPT).not.toContain("review-{goal_id}-{iteration}")`) — the test fails if anyone reintroduces the phantom.
- **`git worktree remove` on a registered worktree doesn't remove the directory**. The orchestrator takeover pattern creates a worktree, but the cleanup step (`git worktree remove --force` after `git worktree prune`) only prunes the git metadata; the actual directory needs `rm -rf`. This GC's setup sequence demonstrates both.

Refs: GC-2026-merger-advisor-split
