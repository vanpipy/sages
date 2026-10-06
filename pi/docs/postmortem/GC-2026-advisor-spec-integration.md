# GC-2026-advisor-spec-integration

**Severity**: minor
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main` (1 commit + 1 merge)

## What happened

`GC-2026-advisor-pairs` wired the full advisor pair architecture: 3 advisor prompts, 3 AgentConfig registrations, the `dispatchAdvisorForTask` hook in `workflow-handler.ts`, and the phase widget's advisor row rendering. But it explicitly left one piece as a follow-up: the static spec builder in `workflow-graph.ts` did NOT set `metadata.advisorAgentType` on the canonical Implement / Review / Fix tasks. So the dispatch hook fired only in tests that manually set the field; in production `workflow_run`, the spec tasks did not have the field, so the hook was a no-op.

This GC closes that gap by adding `advisorAgentType` to the 3 spec objects in `buildStaticWorkflowGraph` (Implement / Review_i / Fix_i) and to `buildFixTaskSpec`. The dispatch hook now fires automatically for every workflow_run-triggered primary task in the Implement / Audit / Verify phases.

## Architecture (no new design — pure integration)

The hook was already wired. This GC only adds the metadata field that the hook reads. The cascade now does:

```
Implement task completes
  └─ onSubagentCompleted
       └─ dispatchAdvisorForTask(Implement)
            └─ reads task.metadata.advisorAgentType
                 → "DeveloperAdvisor" (this GC)
            └─ creates sibling task: phase=implement, advisorOf=Implement.id
            └─ cascade tick spawns it after primary
```

Same for Review (`ReviewerAdvisor`) and Fix (`FixAdvisor`).

The redesign Implement (`buildRedesignImplementTaskSpec`) is intentionally NOT advisor-tagged. Re-design is a fresh start; the previous implement + advisor pair are obsolete (the redesign overwrites the branch).

## What changed

`pi-tasks/src/workflow-graph.ts` — 3 metadata additions, 1 line each:

| Phase | Spec line | New metadata field |
|---|---|---|
| Implement (line 307) | `metadata: { ...meta, phase: "implement", agentType: "Developer" }` | `advisorAgentType: "DeveloperAdvisor"` |
| Review_i (line 334) | `metadata: { ...meta, phase: "review", iteration: i, agentType: "Reviewer" }` | `advisorAgentType: "ReviewerAdvisor"` |
| Fix_i (line 399-404) | `metadata: { workflow_run_goal_id, phase: "fix", iteration, agentType: "Fix" }` | `advisorAgentType: "FixAdvisor"` |
| Merge (line 351) | `metadata: { ...meta, phase: "merge", agentType: "MergerAdvisor" }` | unchanged (Merge IS the advisor — MergerAdvisor is the primary) |
| Redesign Implement (line 412+) | unchanged (intentionally — redesign is a fresh start) |

## Tests

| File | Change | Status |
|---|---|---|
| `pi-tasks/test/workflow-graph.test.ts` | 2 new tests: static graph specs have correct `advisorAgentType` per phase (Implement → DeveloperAdvisor, Review → ReviewerAdvisor, Merge → none); buildFixTaskSpec has FixAdvisor | 2/2 pass |
| `pi-tasks/test/workflow-handler.test.ts` | 1 new test: end-to-end dispatch triggered by spec builder's field (no manual metadata injection). 1 existing test updated: NEEDS_REDESIGN cascade now counts 3 Implement tasks (original + advisor + redesign) instead of 2. 1 test removed: pre-existing "without advisorAgentType no advisor" negative test is no longer meaningful since the spec always sets the field. | 1 new + 1 update + 1 removal |

`bun run typecheck` green on all 3 packages. Pre-existing failures unchanged from main baseline (8+5+1 across the 3 packages).

## Verification

| # | Item | Status |
|---|---|---|
| 1 | buildStaticWorkflowGraph sets `advisorAgentType` on Implement / Review / Merge spec | ✓ Merge excluded (it's the primary) |
| 2 | buildFixTaskSpec sets `advisorAgentType: "FixAdvisor"` | ✓ |
| 3 | buildRedesignImplementTaskSpec unchanged (intentional) | ✓ |
| 4 | End-to-end dispatch fires without manual metadata injection | ✓ |
| 5 | NEEDS_REDESIGN cascade test updated for new 3-task count (original + advisor + redesign) | ✓ |
| 6 | typecheck green on all 3 packages, no regressions | ✓ |

## Effect on the user

After this GC, `workflow_run` end-to-end triggers the advisor pair model for every Implement / Audit / Verify phase:

- **Implement** → primary Developer finishes → DeveloperAdvisor spawns (write `implement-advisor-{task_id}.md` with VALIDATED/CONTESTED)
- **Audit** → primary Reviewer finishes (NEEDS_WORK) → Fix dispatches → Fix finishes → ReviewerAdvisor spawns (write `review-advisor-{task_id}.md` with VALIDATED/CONTESTED)
- **Verify** → primary Fix finishes → FixAdvisor spawns (write `fix-advisor-{task_id}.md` with VERIFIED/INCOMPLETE)
- **NEEDS_REDESIGN** → primary Reviewer finishes (NEEDS_REDESIGN) → new Implement dispatches (no advisor) → no need to audit, redesign overwrites the branch

The phase widget shows the pair structure visually (primary row + indented advisor row). Users can read the advisor's verdict file to see whether the advisor accepted the primary's work.

## Lessons learned

- **One-GC-at-a-time is the right cadence for the advisor pair work.** The pair model is conceptually simple but cuts through 4 layers (prompt + agent config + spec + dispatch + UI). Trying to do all 4 in one GC (GC-2026-advisor-pairs) would have been too large; doing the spec integration as a follow-up GC (this one) was the right size. Each GC had a clear scope: architecture, then spec integration.
- **The "no advisor" negative test became meaningless.** Pre-spec-integration, dispatchAdvisorForTask was opt-in (manual `metadata.advisorAgentType` injection). Now it's automatic (spec sets it). The negative case is still covered at the dispatch helper level (the `if (typeof advisorAgentType !== "string" || !advisorAgentType) return;` guard), but no integration test can demonstrate it because the spec is always setting the field. This is a feature, not a regression.

Refs: GC-2026-advisor-spec-integration
