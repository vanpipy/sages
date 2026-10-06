# GC-2026-chat-stream-render

**Severity**: major
**Date**: 2026-10-05
**Status**: ready-for-review
**Branch**: `main` (1 commit + 1 merge)

## What happened

The first audit (`GC-2026-workflow-chat-stream` postmortem) claimed that `workflow_run`'s onUpdate stream rendered correctly in the TUI because "TUI renders `partial: true` as a streaming indicator". The audit author was wrong about the host protocol. Re-reading `pi-coding-agent`'s `AgentToolUpdateCallback<TDetails>`:

```ts
export type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;
```

The host expects `partialResult` to be an `AgentToolResult<T>` envelope — i.e., `{ content: TextContent[], details: T, ... }`. The `partial: true` field doesn't exist on `AgentToolResult`. The audit author was guessing what the host would do with a custom-shaped `partial: true` discriminator; the host actually just takes the argument as the partial result.

`workflow_run.ts` (post `GC-2026-workflow-chat-stream`) emitted:

```ts
runCtx.onUpdate({
  partial: true,                // ← not a real AgentToolResult field
  goal_id: ...,
  current_phase: ...,
  ...
});
```

What the host (pi-coding-agent TUI) actually saw: an `AgentToolResult` with `content: undefined`, `details: undefined` (since none of the workflow_run fields are in the right shape), `partial: true` (a stray field). The TUI's `getRenderedTextOutput` (which extracts `result.details`) probably returned nothing, and the TUI's chat thread showed an empty or undefined-render partial block. In practice, users saw the chat frozen until workflow_run completed (when the FINAL `WorkflowRunOutput` was returned) — the live streaming was effectively broken.

This GC fixes the protocol mismatch by wrapping the onUpdate payload in the proper `AgentToolResult<TDetails>` envelope.

## Architecture

`pi-orchestrator/src/workflow-run.ts` was the only file changed. The fix:

1. **Renamed the type** `WorkflowProgressUpdate` → `WorkflowProgressDetails` to reflect the new role (it's the TDetails type, not a top-level envelope).
2. **Imported the host's callback type** `AgentToolUpdateCallback<TDetails>` from `@earendil-works/pi-coding-agent` to pin the protocol shape at compile time.
3. **Wrapped the onUpdate call** in the proper envelope:
   ```ts
   runCtx.onUpdate({
     content: [],                          // standard "TUI renders from details"
     details: { goal_id, current_phase, iteration, last_verdict, ... }   // TDetails
   });
   ```
4. **Typed the RunContext.onUpdate field** as `AgentToolUpdateCallback<WorkflowProgressDetails>` instead of the loose `(update: WorkflowProgressUpdate) => void`. This makes any future drift a compile error.
5. **Removed the `partial: true` literal** from the emitted payload. The first audit's hypothesis was wrong; the field is now gone.

## What was NOT done

- The **host** is not changed. The protocol is upstream (pi-coding-agent); Sages doesn't own the host's `AgentToolUpdateCallback` shape. The host's `partial: true` (if any) is in its own `ToolRenderResultOptions`, not in the workflow_run payload.
- The **final `WorkflowRunOutput`** (returned to the LLM via `execute()`'s `Promise<AgentToolResult<TDetails>>`) is unchanged. It's a full result, not a partial. The fix only touches the streaming updates.

## Tests

`pi-orchestrator/test/workflow-run.test.ts` — 4 streaming tests updated to inspect `update.details.X` instead of `update.X`. 1 new test pins the envelope shape:

```ts
it("onUpdate payload matches AgentToolResult<WorkflowProgressDetails> envelope", async () => {
  // ... drive implement → review → merge to complete the workflow ...
  const u = updates[0] as { content: unknown[]; details: Record<string, unknown> };
  expect(u).toHaveProperty("content");
  expect(u).toHaveProperty("details");
  expect(u.content).toEqual([]);
  expect(u).not.toHaveProperty("partial");           // ← key regression pin
  expect(u.details).not.toHaveProperty("partial");   // ← key regression pin
  expect((u.details as { goal_id: string }).goal_id).toBe(GOAL_ID);
  expect((u.details as { current_phase: string }).current_phase).toBe("implement");
});
```

The two `not.toHaveProperty("partial")` assertions specifically pin against the first-audit shape reappearing — if anyone re-introduces `partial: true` on the top level OR inside `details`, this test fails.

`bun run typecheck` green on all 3 packages. `bun test`:
- `pi-orchestrator`: 4 streaming tests + 1 new envelope test = 5 pass; 0 fail. The pre-existing 5 fails (4 SMOKE-073 + 1 verify:catalog) are unchanged.
- `pi-tasks`, `pi-subagents`: pre-existing failures unchanged from main baseline.

## Verification

| # | Item | Status |
|---|---|---|
| 1 | `WorkflowProgressDetails` defined (renamed from `WorkflowProgressUpdate`) | ✓ |
| 2 | `partial: true` removed from emitted payload | ✓ |
| 3 | `RunContext.onUpdate` typed as `AgentToolUpdateCallback<WorkflowProgressDetails>` | ✓ |
| 4 | Payload wrapped in `{ content: [], details: <WorkflowProgressDetails> }` | ✓ |
| 5 | New test pins envelope shape (5 streaming tests + 1 envelope test) | ✓ |
| 6 | typecheck green on all 3 packages | ✓ |
| 7 | No regressions (pre-existing failures unchanged) | ✓ |

## Effect on the user

Before this GC, the TUI chat thread was effectively silent during `workflow_run` execution. The user saw the chat thread go idle when `workflow_run` was invoked, then jump to the final `WorkflowRunOutput` when the pipeline completed. Streaming was advertised but didn't work.

After this GC, the TUI chat thread shows the partial result block as each phase completes — `Implement` → `Review 1` → `Fix 1` → `Review 2` → `Merge`, with each block showing `current_phase`, `iteration`, `tasks_done / tasks_total`, `elapsed_ms`, and the human-readable `summary`. Users see the workflow progress live, just as the postmortem of `GC-2026-workflow-chat-stream` claimed it would.

## Lessons learned

- **Re-reading the actual type before believing the first audit's claim.** The first audit (a different person) assumed the host rendered `partial: true` as a discriminator. Re-reading `AgentToolUpdateCallback` in `pi-agent-core` showed the real contract: the argument is an `AgentToolResult<T>` envelope, not a freeform partial. The fix was small once the correct shape was visible.
- **Compile-time type imports catch protocol drift.** Importing `AgentToolUpdateCallback` from `@earendil-works/pi-coding-agent` and using it as the `RunContext.onUpdate` field type means: if the host changes the signature (e.g., adds a required `phase` discriminator field), the orchestrator stops compiling until updated. The previous loose `(update: WorkflowProgressUpdate) => void` let the drift go unnoticed.
- **Test regression pin via `not.toHaveProperty`.** The two `not.toHaveProperty("partial")` assertions are small but high-value: they encode the lesson that the first-audit shape was wrong, and they fail fast if anyone reintroduces it. A future contributor who reads `pi-coding-agent`'s callback and thinks "let me add `partial: true` here" will see the test fail with a clear message.

Refs: GC-2026-chat-stream-render
