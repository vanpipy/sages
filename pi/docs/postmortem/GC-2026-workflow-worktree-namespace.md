# GC-2026-workflow-worktree-namespace

**Severity**: minor
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main`

## What happened

Secondary audit (after the first audit's chat-stream surface bug) found the minimal workflow is silently broken at the **documentation / recording** layer: `workflow-run.ts` records a branch name with a stale `sages/` prefix that doesn't match the branch the agent actually creates via `git checkout -b`. The dispatch brief embedded in every phase's description carried a hardcoded `process.cwd()` for the worktree path (lying about the actual worktree location) and a goal-id-derived branch (correct, but only because it happened to match the agent's branch).

The first audit (GC-2026-workflow-chat-stream's audit notes) also claimed the system was largely broken because "Reviewer/Fix/Merger run in caller cwd, never see Implement's commits". The secondary audit verified this is technically true but operationally false: the agent's dispatch brief tells it to `cd ${worktreePath}` after the worktree is provisioned by AgentManager, so it ends up in the right place. The chat-stream GC, the path-B-swap GC, and the verdict-states GC all completed end-to-end with real commits on real branches — proving the system works in practice via the `cd` hint, even though the wiring is fragile.

## Root cause

Two places hardcoded values that drifted out of sync with each other and with AgentManager's actual provisioning:

1. `pi-orchestrator/src/workflow-run.ts:365` recorded `branch = sages/${goalId.toLowerCase()}-implement` in `workflow-{id}.yaml`. The dispatch brief (built by `pi-tasks/src/workflow-graph.ts:287`) used `${goal.id.toLowerCase()}-implement` (no `sages/` prefix), and the agent created THAT branch via `git checkout -b`. So the recorded value pointed at a non-existent ref.

2. `pi-tasks/src/workflow-graph.ts:288` hardcoded `worktreePath = process.cwd()`. This made the description's `## Workspace` section lie about the worktree location. The agent ignored the lie (because AgentManager had already placed it in the real worktree via `worktreeCwd = wt.path` in agent-manager.ts:537), so this never broke production — but every dispatch brief was internally inconsistent.

The bigger concern flagged in the secondary audit — that Reviewer/Fix/Merger don't have `isolation` set in the spawn wrapper at `pi-tasks/src/index.ts:324-334` — turns out to be **out of scope** for this GC. The agent's `cd` hint bridges the gap, and adding `isolation` for non-Developer types would require either:
- Adding a new "reuse with branch advancement" mode to pi-subagents's `reuseManagedWorktree` (worktree.ts:1246) — explicitly designed to refuse on branch advancement per the comment at line 1316
- Or passing `customCwd` to AgentManager to skip worktree provisioning entirely

Both are larger changes touching pi-subagents semantics and deserve their own GC with broader design discussion.

## Fix

Three commits on the branch (after orchestrator manual takeover — see "Lessons learned" below):

1. **`pi-tasks/src/workflow-graph.ts`** — `WorkflowGraphInput` gains `worktreePath: string` and `branch: string` as required parameters. The hardcoded `process.cwd()` and `${goal.id.toLowerCase()}-implement` defaults at lines 287-288 are deleted; the function destructures them from input. Every spec builder (`implementDescription`, `reviewDescription`, `fixDescription`, `mergeDescription`) was already accepting these as parameters — they were just being passed misleading values.

2. **`pi-tasks/src/workflow-handler.ts`** — adds a local `deriveBranch(goalId)` helper that returns `${goalId.toLowerCase()}-implement` (canonical, no `sages/` prefix). `onWorkflowStart` calls `buildStaticWorkflowGraph` with `worktreePath: payload.worktree_path, branch: deriveBranch(payload.goal_id)`. `dispatchFixForReview` and `dispatchRedesignForReview` use the same helper for their spec builders.

3. **`pi-orchestrator/src/workflow-run.ts`** — drops the `sages/` prefix from the recorded branch. Now `branch = ${goalId.toLowerCase()}-implement`, matching what `pi-tasks` derives and what the agent creates.

### Tests

- `pi-tasks/test/workflow-graph.test.ts`: 4 new tests covering Implement/Review/Merge description content + no-`process.cwd()`-leakage. `buildStaticWorkflowGraph` test helper updated to pass required `worktreePath`/`branch`.
- `pi-tasks/test/workflow-handler.test.ts`: 1 new test verifying the Implement dispatch brief embeds the payload's `worktree_path` and the canonical `Branch: <goal_id>-implement` (and rejects `sages/<goal_id>-implement`).
- `pi-orchestrator/test/workflow-run.test.ts`: 1 new test verifying `workflow-{id}.yaml` records `branch: <goal_id>-implement` (no `sages/` prefix) and `worktree_path` under `.pi/worktree/<goal_id>/implement/`.

Total: 12 workflow-graph tests pass (was 8), 24 workflow-handler tests pass (was 23, +1 new + 0 regressions; the 1 pre-existing failure on `subscribeWorkflow.spawnAgent marks the task active before dispatching` is documented in the test header comment as a separate GC), 14 workflow-run tests pass (was 13, +1 new + 0 regressions).

`bun run typecheck` + `bun test` green on both `pi-tasks` and `pi-orchestrator` (modulo the pre-existing failure).

## Verification

| # | Item | Status |
|---|---|---|
| 1 | `WorkflowGraphInput.worktreePath` + `branch` are required; the dispatch brief embeds them | ✓ `workflow-graph.test.ts` 4 new tests |
| 2 | `workflow-handler.ts` derives `branch` via `deriveBranch(goalId)` and threads `worktree_path` from payload | ✓ `workflow-handler.test.ts` 1 new test |
| 3 | `workflow-run.ts` records `branch = ${goalId.toLowerCase()}-implement` (no `sages/` prefix) | ✓ `workflow-run.test.ts` 1 new test |
| 4 | `bun run typecheck` green on pi-tasks + pi-orchestrator | ✓ |
| 5 | `bun test` green on pi-tasks (workflow-graph + workflow-handler) + pi-orchestrator (workflow-run) | ✓ modulo pre-existing failure |
| 6 | No catalog regen needed (catalog sources don't include workflow-graph/workflow-handler/workflow-run) | ✓ verified |

## Out of scope (deferred)

1. **Spawn wrapper change for Reviewer/Fix/Merger isolation** (`pi-tasks/src/index.ts:324-334`) — currently only `type === "developer"` triggers isolation. The audit flagged this as a fragility risk (agents rely on `cd` in the dispatch brief). Adding isolation for non-Developer types requires pi-subagents changes — either a new "reuse-with-advancement" mode or a `customCwd` short-circuit. Tracked as a follow-up GC.

2. **Orphaned worktrees from NEEDS_REDESIGN** (`workflow-handler.ts:333-375`) — when a Review emits NEEDS_REDESIGN, a new Implement task is created and a new worktree gets provisioned. The old Implement's worktree + branch stay on disk. Cosmetic; no correctness impact (Merger description names a single branch).

3. **Concurrent workflow_run race** (`workflow-handler.ts:131`) — `activeWorkflowId` is handler-instance singleton state. Two concurrent `workflow_run` calls would step on each other. Low probability in practice (orchestrator main agent awaits each before dispatching next). Tracked as a follow-up GC.

4. **`onUpdate` payload shape mismatch with host protocol** (covered by the first audit / GC-2026-workflow-chat-stream follow-up). Not fixed here — separate scope.

5. **NEEDS_CLARIFICATION auto-resume** — when the user re-dispatches with `options.clarification_answer`, the answer is recorded but the cascade doesn't auto-resume. Manual workflow-{id}.yaml edit required. Tracked as a follow-up GC.

## Effect on the user

- `workflow-{id}.yaml`'s `branch` field now correctly names the actual git branch the agent creates. Any tool or user inspecting the state file gets a valid ref.
- The dispatch brief in every phase's description now correctly names the worktree path. The agent's `cd ${worktreePath}` hint lands on a real directory.
- No behavioral change for already-working workflows (the chat-stream GC and earlier GCs continue to function because the agent ignored the misleading brief and followed the dispatch brief's `Branch:` line, which already had the right value).

## Lessons learned

- **orchestrator manual takeover triggered.** `workflow_run`'s cascade dispatched a Developer subagent twice; both times the Developer got ~60 tool uses in before being aborted with status `parent_aborted` (or `aborted` — the host's transcript didn't survive). After two aborts with no recoverable transcript, per AGENTS.md "Orchestrator manual takeover (soft-mode contract)", the orchestrator took over the in-flight task: created its own managed worktree (`sages/GC-2026-workflow-worktree-namespace/orchestrator`), wrote the failing tests first (RED), implemented the fix (GREEN), verified typecheck + tests pass. TDD discipline preserved.
- **Audit findings can be overstated.** The secondary audit claimed the minimal workflow was "silently broken" at the data-flow level. Operational evidence (chat-stream GC landed real commits) showed the system worked via a fragile but functional mechanism. The fix scope was narrowed accordingly: thread `worktreePath`/`branch` correctly through the planning → tracking → dispatch layer, defer the bigger "share a real worktree across phases" infra change.
- **Hardcoded constants drift.** `process.cwd()` and `${goal.id.toLowerCase()}-implement` lived in `workflow-graph.ts` for ~3 GCs without anyone checking they matched `workflow-run.ts`'s recorded values. Tests covered shape, not content. The fix adds content assertions to the dispatch brief tests so future drift gets caught.
- **`workflow-{id}.yaml` is a state file, not a config file.** It records what the planner INTENDED, but the agent's actual branch comes from the dispatch brief → `git checkout -b`. When these disagree, the state file lies silently. Future GC candidates should add an assertion in `releaseManagedWorktree` (or similar) that the worktree's on-disk branch matches the state file's recorded branch.

Refs: GC-2026-workflow-worktree-namespace
