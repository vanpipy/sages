# GC-2026-advisor-pairs

**Severity**: minor
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main` (1 commit + 1 merge)

## What happened

The user's paired-programming design (post first-audit discussion) extends the existing `Merger + MergerAdvisor` pair (introduced in `GC-2026-merger-advisor-split`) to the other 3 phases of the workflow: Implement, Audit, and Verify. Each phase gets a primary agent + a paired advisor that audits the primary's output after it finishes.

Per the user's framing: "developer, developer-advitory 结对进行 implement 工作, review, review-advitory 结对进行审计工作, fix, fix-advitory 结对进行核对工作". The implementation does NOT do simultaneous pair-programming (both agents running concurrently on the same task); instead the advisor runs sequentially after the primary completes, reading the primary's report + evidence trail and emitting an audit verdict in a separate file. This is structurally simpler and matches the existing Merger/MergerAdvisor pattern (MergerAdvisor is advisory, not a co-implementer).

## Architecture (mirrors GC-2026-merger-advisor-split)

3 new agent types, each with its own prompt and config:
- **DeveloperAdvisor** (advisor of Implement phase) — reads primary's `task-{task_id}-report.md` + commit log + test output, writes `implement-advisor-{task_id}.md` with `verdict: VALIDATED | CONTESTED`
- **ReviewerAdvisor** (advisor of Audit phase) — reads primary's `verdict-{task_id}.md` + `last-review-{goal_id}.md` + 4-state verdict + scope/anti_goal checks, writes `review-advisor-{task_id}.md` with `verdict: VALIDATED | CONTESTED`
- **FixAdvisor** (advisor of Verify phase) — reads primary's commit log + originating Reviewer's `findings[]`, walks each finding and checks for a matching `fix(<scope>):` commit or valid deferral, writes `fix-advisor-{task_id}.md` with `verdict: VERIFIED | INCOMPLETE`

All 3 advisors share the same hard-prohibition structure as `MERGER_ADVISOR_PROMPT`:
- read-only on the worktree (no `edit` / `write` tools, only `READ_ONLY_TOOLS`)
- never spawns another `Agent` call (orchestrator handles the cascade)
- never modifies `.pi/orchestrator/` other than its single output file
- single output target file (the `<kind>-advisor-{task_id}.md`)

The dispatch is wired into `pi-tasks/src/workflow-handler.ts` as `dispatchAdvisorForTask`:
- Hooked into `onSubagentCompleted` (before the existing review verdict processing)
- Activates only when the completed task has `metadata.advisorAgentType` set
- Creates a sibling task with the same phase + iteration, `metadata.advisorOf: <primary_id>`, `blockedBy: [primary.id]`
- The next cascade tick picks it up automatically (the existing scan already iterates pending tasks whose blockedBy is fully completed)

The phase widget (`pi-orchestrator/src/ui/phase-widget.ts`) was updated to render advisor tasks as paired sub-rows: indent one more level, strip the `"Advisor: "` prefix from the subject, and sort advisor rows to follow their primary within a phase group.

## What was intentionally NOT done

- **workflow-graph.ts static spec** does NOT set `advisorAgentType` on the canonical Implement/Review/Fix tasks. The dispatch is wired and the test sets `advisorAgentType` manually. The full workflow_run integration (where the spec builder adds the field) is a follow-up. This GC closes the **prompt + dispatch + UI** layers; the spec-integration is straightforward (one `metadata.advisorAgentType: "DeveloperAdvisor"` line in the buildStaticWorkflowGraph spec builder for the Implement task; similar for Review and Fix) and lands separately.
- **advisor completion / phase-complete event** — advisor tasks are regular tasks; their completion fires `subagents:completed` which the existing handler consumes. No new event channel.
- **Advisor in workflow_run's WorkflowRunOutput** — the advisor tasks are part of the same TaskStore; LLM-facing output already shows them via `tasks.fix` and (after spec integration) the implied advisor task. No new field in WorkflowRunOutput.

## Tests

| File | New tests | Status |
|---|---|---|
| `pi-subagents/test/developer-advisor-prompt.test.ts` | 7 invariants (non-empty, identity, output target, no edit, no spawn, VALIDATED/CONTESTED, no reimplement) | 7/7 pass |
| `pi-subagents/test/reviewer-advisor-prompt.test.ts` | 7 invariants (non-empty, identity, output target, no re-run, VALIDATED/CONTESTED, last-review ref, 4-state verdict) | 7/7 pass |
| `pi-subagents/test/fix-advisor-prompt.test.ts` | 7 invariants (non-empty, identity, output target, no re-run, VERIFIED/INCOMPLETE, fix-commit mapping, no re-fix) | 7/7 pass |
| `pi-tasks/test/workflow-handler.test.ts` | 2 new tests (advisor dispatch on completion, no-op without advisorAgentType) | 2/2 pass |
| `pi-orchestrator/test/ui/phase-widget.test.ts` | 1 new test (renders advisor as paired sub-row, primary before advisor, indented) | 1/1 pass |

`bun run typecheck` green on all 3 packages. Pre-existing failures unchanged from main baseline (8+5+8 across the 3 packages).

## Verification

| # | Item | Status |
|---|---|---|
| 1 | 3 new advisor prompts (developer-advisor / reviewer-advisor / fix-advisor) | ✓ |
| 2 | 3 AgentConfig registered in default-agents.ts (read-only tools, maxConcurrent: 1, inheritContext: false) | ✓ |
| 3 | `dispatchAdvisorForTask` hook in workflow-handler (creates sibling blockedBy primary) | ✓ |
| 4 | Phase widget renders advisor rows with indent + "advisor:" prefix | ✓ |
| 5 | Phase widget sortPrimaryAdvisor puts primary before advisor within a phase group | ✓ |
| 6 | typecheck green on all 3 packages, no regressions | ✓ |

## Effect on the user

- The paired-programming design is now architecturally in place: every workflow phase (Implement / Audit / Verify) has an advisor agent registered, with a prompt, a config, a dispatch hook, and a UI rendering.
- For the user, when `workflow_run` is extended to use advisor pairs (follow-up GC), each phase will have two tasks shown in the phase widget — the primary and a paired advisor sub-row. The advisor emits a binary verdict (VALIDATED / CONTESTED or VERIFIED / INCOMPLETE) that the orchestrator can surface to the user.
- The architecture matches the existing `Merger + MergerAdvisor` pattern; future work (MergerAdvisor testing, DeveloperAdvisor prompt tuning, etc.) reuses the same hooks.

## Lessons learned

- **Reusing the merger-advisor pattern is the win.** Writing 3 advisor prompts + registrations + dispatch hooks + UI changes in one GC was tractable because the architectural shape was already proven by `GC-2026-merger-advisor-split`. The pattern (read-only on worktree + single output target + hard prohibitions anchored to `~/AGENTS.md`) is now a Sages-wide convention.
- **The dispatch hook is data-driven, not config-driven.** No new env var or config option. The cascade just looks at `task.metadata.advisorAgentType` and dispatches. Future phases can add advisors by setting that metadata — no code change to the dispatch logic. This is a small but useful architectural primitive.
- **Sequential pairing is much simpler than simultaneous pair-programming.** The original "developer + developer-advisor doing implement work together" framing implied parallel execution, but the implementation does sequential (advisor runs after primary finishes). This matches the existing cascade model (one agent at a time per task) and avoids the complexity of concurrent state-sharing. The user's design intent — second-opinion validation — is preserved.

Refs: GC-2026-advisor-pairs
