---
id: GC-2026-pi-tasks-cascade-agentid
title: pi-tasks cascade: real agent-id tracking + subagents:failed listener
severity: blocker
date: 2026-10-02
audit_verdict: PASS
---

# GC-2026-pi-tasks-cascade-agentid — Postmortem

## What happened

Every `workflow_run` call stalled after the first phase. The
orchestrator emitted `workflow:start`; `subscribeWorkflow` in
`pi-tasks/src/workflow-handler.ts` built the 7-task graph, spawned
Implement, and then the cascade never advanced — Implement completed,
no `workflow:phase-complete` was emitted, and the LLM-facing
`workflow_run` Promise hung forever. Real production evidence at
`.pi/orchestrator/workflow-GC-2026-096.yaml`:

```yaml
phases: {
  "implement": {
    "id": "cf9f3e74-835c-4c4",   # ← real UUID prefix from randomUUID().slice(0,17)
    "agent_id": "cf9f3e74-835c-4c4",
    "status": "failed",
    "duration_ms": 271295
  }
}
current_phase: blocked
iterations_used: 0   # Review never ran
```

The GC-2026-096 case additionally surfaced a *second*, independent
stall path: when the Implement agent itself crashed (the `<repo>`
placeholder bug that GC-2026-096's postmortem already documented),
`workflow-handler.ts` had no `subagents:failed` subscriber, so the
failure was silently dropped.

## Root cause

**Three coupled bugs**, each individually sufficient to stall a
`workflow_run`:

1. **`pi-tasks/src/workflow-handler.ts:131` — synthetic agent-id
   pre-registration.** At `workflow:start` time the handler
   pre-populated `agentToTask` with synthetic keys
   `` `agent-${task.id}` `` for every task. The comment at line 126
   self-explains: *"The fake spawnAgent in tests returns
   `agent-${task.id}`; doing this here means the cascade test can
   drive any phase by emitting subagents:completed with the id it
   computed locally."* — the registration was tailored to the unit
   test fixture, not the production contract. `pi-subagents`/
   `agent-manager.ts:346` produces `randomUUID().slice(0, 17)`,
   yielding ids like `cf9f3e74-835c-4c4` — these never matched the
   pre-registered `agent-N` keys, so `agentToTask.get(data.id)` at
   `onSubagentCompleted` returned `undefined` and the cascade fell
   through.

2. **`pi-tasks/src/workflow-handler.ts` — no `subagents:failed`
   subscriber.** The handler subscribed to `subagents:completed` and
   `workflow:start` but nothing else. `subagents:failed` (the path
   `pi-subagents`/`agent-runner.ts` takes when the agent itself
   errors out) had no listener. The fallback "let the existing
   handler process it" at line 191 was wrong because the
   `agentTaskMap` it referenced lives in `pi-tasks/src/index.ts` and
   is never populated for workflow-spawned tasks — it covers ad-hoc
   `TaskExecute` invocations only.

3. **`pi-tasks/src/index.ts:387` — Developer spawn missing isolation.**
   The `spawnAgent` closure passed to `subscribeWorkflow` built
   `{ description, isBackground }` and nothing else. The
   `Developer` agent requires an explicit isolation choice
   (`pi-subagents`/`invocation-config.ts:251-258` —
   `enforceDeveloperManagedIsolationPolicy` rejects `undefined` with
   *"developer agent: an explicit isolation choice is required"*).
   The orchestrator's `workflow-run.ts` already computes the
   managed-worktree path (`<repoCwd>/.pi/worktree/<goal_id>/
   implement`) but never threaded it through to the spawn call.

All three bugs were shielded by the same unit-test architecture: the
fixture's `spawnAgent` returned `agent-${task.id}` (matching bug #1),
and the test only drove the cascade via the synthetic id shape, so
bug #1 was invisible to the test. The fix exposes the production
shape (real UUIDs) and adds the missing failure listener — both
behaviors the unit tests never exercised.

## Fix

Surgical changes, one per bug, plus orchestrator-side completion
handling:

| Bug | File | Change |
|---|---|---|
| #1 | `pi-tasks/src/workflow-handler.ts` | Drop the synthetic pre-registration loop; populate `agentToTask` with the real id returned by `spawnAgent` at the spawn call site (workflow:start + every cascade spawn). `WorkflowSpawnAgent` now takes an optional `{ worktreePath }` ctx so the caller can thread the orchestrator's path through. |
| #2 | `pi-tasks/src/workflow-handler.ts` | New `onSubagentFailed` listener: looks up the task by the real agent id, reverts it to `pending` with `lastError` metadata, and emits `workflow:phase-complete` with `status: "failed"` so `workflow_run` can resolve as blocked. |
| #3 | `pi-tasks/src/index.ts` | Build a `{ goal_id, task_id, mode: "create" }` managed-worktree object from `task.metadata.workflow_run_goal_id` and `ctx.worktreePath`; pass it as `isolation` to `spawnSubagent` for `Developer` phases only (`Reviewer` / `Merger` are policy-noop). |
| Cascading | `pi-orchestrator/src/workflow-run.ts` | Extend `PhaseCompleteEvent.status` to `"completed" \| "failed"`. On `"failed"`, set `state.current_phase = "blocked"`, unsubscribe, and resolve with `buildBlockedOutput(failedPhase, error)`. `WorkflowRunOutput.blocked_at` extended to `"implement" \| "review" \| "fix" \| "merge"`; `merge_error` carries the surface message. |

The fix follows the soft-mode takeover contract
(`~/AGENTS.md#orchestrator-manual-takeover`):

- TDD discipline applied: RED test fixtures driven by real-format
  ids written first; failing for the right reason (cascade stalled,
  task stayed `in_progress` on failure); GREEN as the smallest
  production change that makes them pass; existing test
  `Merge completes → all 7 tasks completed` had to be re-driven
  through the full pipeline because it was relying on bug #1 to
  make `agent-7` (the Merge id) valid before Merge had been spawned.
- Commits on the worker's managed-worktree branch
  (`.pi/worktree/GC-2026-pi-tasks-cascade-agentid/implement`),
  merged to main via the standard `git merge --no-ff` pattern.
- Production source synced to `~/.pi/packages/{pi-tasks,pi-orchestrator}/`
  manually because install.sh's `--force` rewrite is heavier than
  this GC warrants and the runtime pi session reads from those
  paths.

## Follow-ups

- **Install.sh `--force` flow.** The runtime fix-up here used direct
  `cp` of three files. The canonical install.sh path is
  `./pi-orchestrator/scripts/install.sh --force`, which reinstalls
  the full `pi-tasks` + `pi-orchestrator` subtree. A future GC
  should add a `--sync-only` mode that file-copies the modified
  files without re-running `bun install` (which would also
  reinstall `pi-subagents` from npm). Filed as
  `pi-orchestrator/scripts/install.sh` enhancement.
- **Vitest baseline drift in worktree.** `bun test` in
  `pi-subagents/test/` and certain `pi-tasks/test/` files hit
  `vi.hoisted is not a function` because the worktree's `bun.lock`
  resolves vitest to a build that doesn't expose the API. `bun x
  vitest run` (same project, vitest binary direct) passes 987/987
  on the worktree. The same drift exists on main. Pre-existing,
  unrelated to this GC; the verify gates (`bun run typecheck` +
  `bun test ./test --path-ignore-patterns dist/`) all green in both
  pi-tasks and pi-orchestrator. Future GC: align vitest version
  across workspaces.
- **Test fixture aliasing.** `pi-tasks/test/helpers/mock-pi.ts`:
  `installSubagentsMock` returns `agent-${++idCounter}` ids, which
  made the existing test suite green-by-accident under the bug.
  The new `path-b-e2e.test.ts` block intentionally uses a
  separate fixture returning real-format ids so the production
  contract is exercised; the old `installSubagentsMock` is kept
  for `TaskExecute` / RPC tests where the agent-id shape doesn't
  matter. Document this split in the fixture header.
- **Workflow-handler.ts test for the cascade fixture shape.** Several
  existing `workflow-handler.test.ts` cases fired `agent-${id}`
  events without first driving Implement to completion; they were
  passing under the bug. Updated to drive Implement → cascade →
  Review. A future test-discipline GC could add a guard test that
  asserts `agentToTask` is empty immediately after `workflow:start`
  and grows by exactly one entry per spawn — would catch a future
  regression of the same shape.

## Verification

```
$ cd pi-tasks && bun x vitest run
 Test Files  25 passed (25)
      Tests  442 passed (442)
   Duration  4.41s

$ cd pi-orchestrator && bun test ./test --path-ignore-patterns dist/
 532 pass
   2 skip
   0 fail
1084 expect() calls
   Duration  8.09s

$ cd pi-orchestrator && bun run verify:all
OK: 3 catalogues current
OK: no forbidden 'isolation: "worktree"' literals in source
OK: no orchestrator path references in subagent templates
OK: soft-mode mental model — runtime wiring present
OK: no goal contracts in .pi/orchestrator/; coverage trivially satisfied

$ cd pi-subagents && bun x vitest run
 Test Files  81 passed (81)
      Tests  987 passed (987)
```

Production fix-up: `cp` the three modified files to
`~/.pi/packages/{pi-tasks,pi-orchestrator}/src/` so the runtime pi
session sees them. (The install.sh --force rewrite is deferred to
the follow-up above.)

Commits:

- `fb4769b fix(pi-tasks): real agent-id tracking + subagents:failed listener` (467+/35-)
- `9251748 merge(GC-2026-pi-tasks-cascade-agentid): real agent-id tracking + subagents:failed listener`