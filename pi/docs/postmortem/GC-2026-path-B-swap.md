# GC-2026-path-B-swap — Postmortem

**Severity:** major
**Resolved:** 2026-10-01
**Goal yaml:** [.pi/orchestrator/goal-GC-2026-path-B-swap.yaml](../../.pi/orchestrator/goal-GC-2026-path-b-swap.yaml)

## What happened

Goal: replace path A's 1060-line in-process state machine in
`pi-orchestrator/src/workflow-run.ts` with a thin event-driven shim
that emits `workflow:start` and waits for `workflow:phase-complete`.

The work landed in 5 commits on the `sages/GC-2026-path-B-swap/implement`
branch:

1. `c12d2f6 wip: workflow-run.test slim emitter red` — Developer wrote
   296 lines of test code for the 5 contract cases
2. `e962f09 feat(pi-tasks): emit workflow:phase-complete for all phases` —
   extended path B's event contract (previously only Review phases
   emitted; now all 4 phase categories do)
3. `5e64ded feat(pi-orchestrator): slim workflow_run emits
   workflow:start + waits for phase-complete` — the actual swap
   (-1719 / +292 lines net)
4. `25b6f0d feat(pi-tasks): wire subscribeWorkflow into extension
   factory` — production wire-up so workflow_run calls actually drive
   the cascade
5. `6a8ad81 feat(subagents): add Fix Phase Behavior section to
   developer prompt` — teaches cascade-spawned Fix agents how to
   handle CLEAN (empty commit) vs NEEDS_WORK (address findings)

The literal `<repo>` placeholder bug in path A's workflow-run.ts is
gone for good — the new code uses `resolve(repoCwd, '.pi', 'worktree',
goalId, 'implement')`.

## Root cause

The GC-1 tracking layer (`buildStaticWorkflowGraph`, `parseReviewerVerdict`,
`subscribeWorkflow`) was complete, but the planning-layer tool that
should drive it (`workflow_run`) still ran an in-process state machine
that **duplicated the cascade logic**. Path A's state machine spawned
agents sequentially via the SubagentRegistry, ran verdict parsing
inline, and stored its own `workflow-{id}.yaml` schema — none of which
the new tracking layer knew about. The two layers fought for the
"right" implementation of the loop.

The `<repo>` placeholder bug was a symptom of a deeper issue: path A
treated the worktree path as a build-time template literal rather
than a runtime value, because it didn't trust the SubagentRegistry to
receive an absolute path through `pi.events.emit` plumbing.

## Fix

1. **Workflow contract rewrite**: `executeWorkflowRun` is now ~80 lines
   instead of 1060. It loads the goal, writes the state file, emits
   `workflow:start`, and subscribes to `workflow:phase-complete`. All
   looping logic moved to the tracking layer.

2. **Event contract extension**: pi-tasks's `subscribeWorkflow` now
   emits `workflow:phase-complete` for **every** phase (implement,
   review, fix, merge), not just review. Without this, the planning
   layer had no way to know when Implement or Merge completed — only
   polling the TaskStore, which it doesn't have access to. The
   existing test for "non-review completion emits no phase-complete
   event" was updated to expect 1 event with `phase: "implement"`
   and no verdict.

3. **Subagent dispatch via existing RPC**: the wiring reuses
   `spawnSubagent` (which goes through `subagents:rpc:spawn` to
   pi-subagents), so the actual agent lifecycle stays in the
   executing layer. The new handler keeps its own
   `agentToTask` map alongside pi-tasks's existing one — they coexist
   (workflow tasks vs ad-hoc TaskExecute tasks).

4. **Developer prompt section**: a new "Fix Phase Behavior" section
   teaches the cascade-spawned Fix agent to read the blockedBy
   Review task's `metadata.verdict` and either emit an empty commit
   (CLEAN) or address `findings[]` (NEEDS_WORK).

## Follow-ups

- **Path B still needs an end-to-end test** that exercises the full
  workflow_run → subscribeWorkflow → cascade → completion chain
  end-to-end. Will land in GC-2026-path-B-finalize. The two isolated
  test files (`workflow-run.test.ts` in pi-orchestrator,
  `workflow-handler.test.ts` in pi-tasks) cover their halves but
  nothing verifies the integration.

- **The deleted e2e test** (`test/tools/orchestrator/workflow-e2e.test.ts`)
  tested path A's full state machine with mocked subagents. It is
  intentionally dropped — path A's state machine no longer exists.
  The replacement should test the same scenarios (happy path, fix
  loop, max iterations, merge failure, pi-tasks graceful degradation)
  via the new event-driven flow.

- **`isolated: true` for Merge runs** — Merge currently runs in the
  orchestrator's cwd with no managed worktree. If the workflow
  executes from a different cwd than the main checkout (e.g. in a
  CI runner that has `cwd: <repo>`), the `git merge --no-ff` will
  operate in the wrong place. Worth a follow-up to inject
  `merge_cwd` into the WorkflowStartPayload.

- **No live `workflow_run` test in CI**. The integration test should
  be added in GC-2026-path-B-finalize alongside the postmortem.

## Lessons

1. **The orchestrator skill in SKILL.md was 4 stages out of date**
   (from the era when the orchestrator ran its own state machine).
   The post-GC-3 rewrite to a 3-layer model caught the rest of the
   drift.

2. **Developer dispatch for >2-item work is sound** but the prompt
   must explicitly enumerate the commit discipline. GC-1's first
   Developer agent was aborted at 60 turns without a commit; the
   first GC-2 Developer had the same issue and was manually steered
   into a single WIP commit before being aborted for budget reasons.
   The pattern that works: "(first action within 2 turns) write
   test stub + commit wip: red".

3. **Event contracts need a consumer to validate them**. The
   "non-review completion emits no phase-complete" test pinned the
   old contract; without someone needing the event for review
   completion *and* implement/merge completion, the contract would
   have stayed unnecessarily narrow.
