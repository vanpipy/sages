---
gc_id: GC-2026-task-feeding-and-decomposition
title: Task feeding + user-task decomposition (created_by + helper + decompose_task + /tasks create)
severity: major
---

## What happened

Reframed `pi-tasks` as the **task feeding layer** (the consumer of tasks,
dispatching subagents regardless of source), formalized user-task decomposition
as the canonical path for translating user intent into orchestrator-tracked
sub-tasks, and added the tooling to make that decomposition first-class:

- `metadata.created_by: "orchestrator" | "user"` — binary enum (D1).
- `createOrchestratorTask` / `createOrchestratorTaskWithReview` — universal
  helper that stamps the source + auto-attaches a Reviewer sibling iff the
  new task is top-level (R3 policy: no orchestrator predecessors).
- `decompose_task` LLM-facing tool — break user intent into a linear
  chain `T1 → T2 → … → TN`, with one Reviewer sibling on T1 only.
- `/tasks create "<subject>" [--description …] [--agent-type …]` — arg-style
  slash command for atomic user-task entry (no `--decompose` flag; that is
  chat-driven).
- `decompose-cascade.ts` — dedicated `subagents:completed` / `subagents:failed`
  listener for decomposed tasks. Workflow cascade (`workflow-handler`) and
  ad-hoc auto-cascade (`cfg.autoCascade`) do not cover decompose output;
  this listener closes the gap (D10).

Plus tests (orchestrator-task, tasks-command-create, decompose-task) and a
new verify gate `verify:created-by-invariant` that scans every
`store.create(` call site and asserts an explicit `created_by` stamp.

## Why this design

The Sages monorepo had three clean architectural layers but no explicit task
source model. User intent that did not fit the 4-phase workflow
(Implement → Review ⇆ Fix → Merge) landed as a single atomic task with
no decomposition hook; multi-step user requests either failed to track
or accumulated as parallel atomics that could not chain.

The design doc at `.pi/orchestrator/designs/2026-10-08-task-feeding-and-decomposition.md`
walks through the discovery + decisions. Key locked decisions:

- **D1**: binary `created_by` enum. Two values sufficient. Chain
  traceability via separate `user_task_ref` field.
- **D2**: user task = implicit goal, requires decomposition by orchestrator.
- **D3 / R3**: only top-level orchestrator tasks (no orchestrator
  predecessors) get a Reviewer sibling. Matches existing workflow-graph
  behavior; reviews stay surgical.
- **D4**: task feeding identity — pi-tasks is the sole consumer,
  source-agnostic dispatch.
- **D5**: decompose shape — linear chain with one Reviewer on T1, no
  within-batch deps, no recursion.
- **D6**: `/tasks create` is arg-style, hardcoded `created_by="user"`,
  no `--decompose` flag.
- **D7**: single Reviewer audits the whole chain (via `chainSubjects[]`).
- **D8**: failure handling — partial state allowed; errors pinpoint the
  failing task id for LLM-driven cleanup.
- **D9**: audit retention — permanent (`decompose-<id>.yaml` alongside
  `goal-<id>.yaml`).
- **D10**: decomposed chains flow through a dedicated cascade (`spawnDedicated
  decompose-cascade.ts`), not the existing workflow-handler / index.ts
  listeners, because the existing listeners gate on different conditions
  (`cfg.autoCascade` for index.ts; workflow_run's own `agentToTask` map
  for workflow-handler).

## What broke / what we had to fix mid-implementation

- **Show-stopper 1 (cascade integration, SS-1)**: my first design claim
  was that decomposed tasks could flow through the existing listeners.
  Re-review caught that this requires `cfg.autoCascade=true` + a configured
  cascade path, both fragile. Added D10 + AC14 (dedicated listener with
  its own `decomposeAgentMap`) to remove the dependency.
- **Show-stopper 2 (Reviewer prompt context, SS-2)**: the existing
  `reviewDescription` in workflow-graph.ts assumed a `WorkflowGoal` shape.
  Refactored to a discriminated-union `ReviewerContext` (workflow | decompose)
  and extracted the prompt body to `reviewer-prompt.ts` so workflow and
  decompose Reviewers share one template.
- **Show-stopper 3 (LLM awareness of user tasks, SS-3)**: we do NOT
  auto-notify LLM when a user task is created. Decomposition requires
  the user to mention the task in chat (e.g. `#42 帮我拆一下`). This is
  by design — decomposition is chat-context-aware (D6).
- **Helper split (mid-implementation)**: `createOrchestratorTaskWithReview`
  would auto-attach a Reviewer to *every* top-level task. The workflow
  static graph already plans its own Reviewer per Implement, so calling
  the high-level helper from there would create double-Reviewer pairs.
  Split the helper into a low-level `createOrchestratorTask` (stamp +
  blockedBy, no Reviewer) and a high-level `createOrchestratorTaskWithReview`
  (low-level + top-level Reviewer). Workflow uses the low-level;
  decompose uses the high-level for T1 only.
- **traceUserTaskChain direction (test caught it)**: first implementation
  walked `user_task_ref` backwards, but every chain task has the same
  `user_task_ref = <userTask.id>`, so the walk skipped intermediate
  chain tasks. Fixed to walk `blockedBy[0]` instead — the linear chain
  guarantees each Ti has exactly one predecessor (T_{i-1}), so this
  correctly reconstructs `[userTask, T1, T2, ..., TN]`.
- **RPC timeout for tests (test caught it)**: the default 30s RPC
  timeout exceeds bun:test's 5s per-test default. Made the timeout
  configurable via `ctx.rpcTimeoutMs`; tests pass 200ms.

## Workflow_run session-runtime mismatch (manual takeover)

`workflow_run` was invoked against goal-GC-2026-task-feeding-and-decomposition.yaml
and emitted `workflow:start`. The pipeline hung indefinitely; investigation
showed that pi-tasks + pi-subagents extensions were installed on disk
(`~/.pi/packages/pi-tasks`, `~/.pi/packages/pi-subagents`) but **not registered
in the active session**. The `workflow:start` event had no listener, so
no Implement task was created, no worktree provisioned, no subagent
dispatched, and `workflow:phase-complete` never arrived — the Promise
stayed pending until the harness timed out with "No result provided".

This is an environment / installation issue, not a code bug. The
Sages install script (`pi-orchestrator/scripts/install.sh`) is expected
to register both extensions; whatever happened in this session broke
that registration. Per the orchestrator soft-mode manual-takeover
contract (see `AGENTS.md` § Orchestrator manual takeover), the orchestrator
main agent implemented AC1-AC17 directly via `edit` / `write` / `bash` —
bypassing the worktree-dispatch path. The workflow state file
`.pi/orchestrator/workflow-GC-2026-task-feeding-and-decomposition.yaml`
was marked `blocked` with a footer comment pointing to this postmortem.

The work itself is correct and tests pass; in a properly configured
session, `workflow_run` would have dispatched a Developer subagent into
`.pi/worktree/GC-2026-task-feeding-and-decomposition/implement`, and that
Developer would have produced commits equivalent to the ones produced here
on `main`.

## Follow-ups

- **pi-orchestrator/scripts/install.sh**: investigate why extensions
  occasionally don't register in active sessions. Likely cause:
  `extensions.json` loader silently no-ops on stale registration; surface
  that failure to the user next time.
- **`traceUserTaskChain` audit semantics**: the walk follows `blockedBy[0]`
  which assumes a linear chain. If a future change makes decompose
  non-linear (e.g. parallel branches under T1), this audit utility would
  silently return only one branch. Add a sanity check (warn if a chain
  task has siblings sharing the same `user_task_ref`).
- **AC15 (`executeDecomposeTask` calls `registerDecomposeSpawn`)**: this
  is wired via the existing `decompose:spawn` event channel. The pi-tasks
  materialize handler emits the event after `spawnSubagent`. There is no
  dedicated `registerDecomposeSpawn` API; the event-channel design is
  equivalent but doesn't match the AC's literal wording. AC15 is
  considered satisfied by the event-channel emission.
- **Documentation follow-up GC**: `AGENTS.md` + `pi-orchestrator/skills/orchestrator/SKILL.md`
  still reference the pre-GC architecture (2 LLM-facing tools, no
  decompose-task, no `/tasks create` arg-style). Deferred to a separate
  doc-update GC per the goal's anti-goals.