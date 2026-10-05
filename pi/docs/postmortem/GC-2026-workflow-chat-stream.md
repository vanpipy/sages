# GC-2026-workflow-chat-stream

**Severity**: major
**Date**: 2026-10-04
**Status**: ready-for-review
**Branch**: `main` (3 commits, 2 implementation + 1 merge)

## What happened

User reported: "workflow_run 没有和 task 建立显示链接 / chatting 时看不到任务进度和 subagent 的状态."

Audit found the root cause in `pi-orchestrator/src/workflow-run-tool.ts:46`: workflow_run destructured pi-coding-agent's streaming callback as `_onUpdate` (note the underscore — DestructuredArg prefix indicating "unused") and never invoked it. The host's `ToolDefinition.execute()` signature already includes an `onUpdate: AgentToolUpdateCallback<TDetails> | undefined` parameter specifically for streaming partial tool-result blocks. The TUI interactive mode renders these as `isPartial: true` blocks in the chat thread.

Result: workflow_run took minutes to complete while the chat appeared frozen. The user had zero feedback about progress.

## Root cause

A previous GC refactored `_onUpdate` (the existing parameter in the tool signature) into a destructured-and-discarded variable when adding the new tool wiring. The streaming channel was always there — nobody ever wired it up.

Secondary issues found in the same audit:
- `pi-tasks/src/index.ts:383` `subscribeWorkflow.spawnAgent` doesn't call `widget.setActiveTask(task.id)` — workflow tasks never animate the TaskWidget spinner during execution.
- `pi-subagents/src/ui/agent-widget.ts` shows the agent type but no workflow goal context — the user can't tell which workflow an agent serves.

## Fix

3 commits on `main` (post-merge):

1. `f78f1f2 feat(workflow-chat-stream): stream progress via onUpdate + wire workflow context` — 7 files, 212 insertions, 4 deletions:
   - `pi-orchestrator/src/workflow-run.ts`: `RunContext` gains `onUpdate?: (update: WorkflowProgressUpdate) => void`. New exported `WorkflowProgressUpdate` type with `partial: true` + `goal_id` + `current_phase` + `iteration` + `last_verdict` + `findings_count` + `fix_iterations_used` + `redesigns_used` + `tasks_done` + `tasks_total` + `elapsed_ms` + `open_question` + `summary`. `executeWorkflowRun` emits via onUpdate on every `workflow:phase-complete` (after state mutations so the payload reflects post-transition counters).
   - `pi-orchestrator/src/workflow-run-tool.ts`: destructure `onUpdate` properly (no more `_onUpdate`), forward to `executeWorkflowRun`. Updated tool description advertises the streaming channel.
   - `pi-tasks/src/index.ts`: `subscribeWorkflow.spawnAgent` now calls `widget.setActiveTask(task.id, true)` before spawning. Also forwards `workflowContext` via spawnOpts.
   - `pi-subagents/src/types.ts`: `AgentRecord` and `SpawnOptions` gain `workflowContext?: { goalId, phase, iteration }`.
   - `pi-subagents/src/agent-manager.ts`: thread `options.workflowContext` into `AgentRecord.workflowContext` at the record creation site.
   - `pi-subagents/src/cross-extension-rpc.ts`: add `workflowContext` to `RPC_SPAWN_OPTION_KEYS` so the cross-extension RPC forward path accepts the new key.
   - `pi-subagents/src/ui/agent-widget.ts`: renderFinishedLine + the active-line render add `(workflow: GC-X · Review 2)` between agent name and mode tag when workflowContext is set.

2. `3a403d6 test(workflow-chat-stream): cover onUpdate streaming + workflow task active marker` — 2 files, 203 insertions:
   - `pi-orchestrator/test/workflow-run.test.ts`: 4 new tests covering onUpdate payload shape, fix iteration counter, NEEDS_CLARIFICATION open_question, and the optional-callback path.
   - `pi-tasks/test/workflow-handler.test.ts`: 1 new test covering the workflow task active marker wiring.

3. `b12560c merge(GC-2026-workflow-chat-stream): ...` — branch merge into main.

## Verification

- `bun run typecheck` (from main) — green.
- `bun run test` (from main) — 999 + 475 + 473 + 25 = 1972 pass across all 3 packages; 10 skip (drift opt-in); 0 fail in newly added tests.
- Pre-existing failures (smoke tests, catalog tests) are unrelated to this GC; they exist on `main` prior to merge.

## Done-definition verification

| # | Item | Status |
|---|---|---|
| 1 | workflow_run emits onUpdate payload on every phase-complete with `partial: true` + structured fields | ✓ commit `f78f1f2` + 4 onUpdate tests |
| 2 | `executeWorkflowRun` accepts optional `onUpdate` callback | ✓ + typecheck green |
| 3 | `workflow-run-tool.ts` destructure onUpdate properly (no `_onUpdate`) | ✓ |
| 4 | TaskWidget gets workflow task active markers (`subscribeWorkflow.spawnAgent` calls `widget.setActiveTask`) | ✓ + 1 workflow-handler test |
| 5 | AgentWidget shows workflow context badge `(workflow: GC-X · Review 2)` | ✓ via `AgentRecord.workflowContext` + agent-widget.ts render |
| 6 | onUpdate payload includes open_question for NEEDS_CLARIFICATION | ✓ + test |
| 7 | Tests pass + postmortem + gc-index | ✓ (this file + gc-index update) |

## Effect on the user

When the LLM calls `workflow_run(goal)`:
- TUI shows the tool call appearing LIVE in the chat thread as each phase completes (Implement → Review 1 → Fix 1 → Review 2 → ... → Merge).
- TaskWidget animates each task's spinner as it transitions pending → in_progress → completed.
- AgentWidget labels each spawned agent with its workflow goal + phase so users see at a glance which agent serves which phase of which workflow.

## Lessons learned

- **`_onUpdate` was the smoking gun.** A destructured argument starting with `_` (or simply unused) is a code-review red flag — it's the linter-bypass convention for "we know we don't use this". For a streaming-channel parameter specifically, that convention silently disables a feature the host fully supports.
- **Audit surfaced the right primitive.** Re-confirming via `pi-coding-agent`'s `dist/core/extensions/types.d.ts` revealed `AgentToolUpdateCallback<TDetails>` — the streaming channel was already there. Adding `pi.appendEntry` messages would have been a workaround that pollutes the LLM's chat stream. The right primitive was always available.
- **Workflow context is a 3-layer concept.** It needs to flow: workflow-handler (tracking layer, knows goal+phase) → TaskWidget + AgentWidget (UI) → user. The cleanest path is via `metadata.workflow_run_goal_id` already on the Task, plumbed through spawnOpts → `AgentRecord.workflowContext`. No new event bus, no new state.

Refs: GC-2026-workflow-chat-stream
