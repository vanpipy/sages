---
id: GC-2026-decompose-task-retry
title: Add retry mechanism to decompose_task RPC (max 3 attempts on timeout)
severity: minor
date: 2026-10-08
---

# GC-2026-decompose-task-retry — Postmortem

## What happened

After GC-2026-fix-decompose-task-ctx-events landed (commit `7776f6b`,
fixed the `safeCtx.events` undefined TypeError), the next
manifestation of the same incident chain surfaced: a Planner
subagent's `decompose_task` call sat for 30 seconds and then
rejected with `tasks:rpc:decompose-materialize timeout after 30000ms`.
The previous symptom was a synchronous TypeError before the RPC
could even fire; the new symptom is a clean RPC request that goes
unanswered because no listener is attached on the
`tasks:rpc:decompose-materialize` channel.

The user (orchestrator) confirmed both the investigation and the
fix in one turn: 调查一下原因 新增重试机制 最多重试三次.

## Root cause

`decompose_task` is an RPC over the host's event bus. The shape:

```ts
function rpcCall<T>(api, channel, params, timeoutMs): Promise<T> {
  const requestId = randomUUID();
  const replyChannel = `${channel}:reply:${requestId}`;
  // ... setTimeout(timeoutMs) + api.on(replyChannel, handler) + api.emit(channel, {requestId, ...params})
}
```

For the call to resolve, two things must be true:

1. **A listener must be attached to the request channel** (the
   pi-tasks side registers a handler in
   `materializeDecomposeChain` that picks up the request,
   materializes the chain, and emits a reply on the templated
   `:reply:<requestId>` channel).
2. **The reply must reach the original caller** within `timeoutMs`.

In this session, neither was true: `pi-tasks` is not registered
(the same root cause as the `workflow_run` watchdog from earlier
in the session — see
`GC-2026-fix-decompose-task-ctx-events.md` follow-up #4). The
`api.emit` call returns immediately (no error), but the request
sits unhandled, and after 30s the timer fires and the Promise
rejects with `RpcTimeoutError`.

The pre-fix `executeDecomposeTask` had no retry — a single timeout
error surfaced to the LLM as a hard failure. The Planner's hard
rule "exactly one `decompose_task` call, no retry" propagated this
into a permanent dead end: the LLM could not recover without
manual intervention.

## Fix

Add a retry loop around `rpcCall` inside `executeDecomposeTask`.
Two new options on the ctx:

- `maxRetries?: number` — total attempts including the first
  (default `3`, per the user's 最多重试三次).
- `retryDelayMs?: number` — delay between attempts (default `0`;
  the per-attempt `rpcTimeoutMs` already provides natural
  spacing).

New error class `RpcTimeoutError` (exported) replaces the generic
`Error` for timeout cases so the retry loop can `instanceof`-check
and only retry on timeouts. Listener-side errors
(`success: false` envelopes) propagate immediately — they carry
domain-meaningful information that retrying would either mask
(transient rejection) or duplicate (transient success on a
side-effect the listener would normally reject).

```ts
let lastErr: unknown;
for (let attempt = 0; attempt < maxRetries; attempt += 1) {
  try {
    const inner = await rpcCall<...>(ctx.events, DECOMPOSE_REQUEST_CHANNEL, { params }, rpcTimeoutMs);
    const auditPath = writeAuditFile(ctx.cwd, params, inner);
    return { ... };  // success
  } catch (err) {
    lastErr = err;
    if (!(err instanceof RpcTimeoutError)) throw err;  // not retryable
    if (attempt < maxRetries - 1 && retryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }
}
throw lastErr;
```

Each retry generates a fresh `requestId` (because `rpcCall` calls
`randomUUID()` per invocation) and subscribes on a fresh
`:reply:<requestId>` channel. The old listener is unsubbed on
timeout by the existing `cleanup()` helper.

### Test coverage

Four new tests in `pi-orchestrator/test/decompose-task.test.ts`:

- `retries on timeout and succeeds on a later attempt` — first
  emit goes unanswered, second gets a reply, asserts
  `requestEmits === 2` and the result has `status: "success"`.
- `exhausts maxRetries and rejects with the last timeout error` —
  every attempt times out, asserts `requestEmits === 3` and the
  rejection matches `/timeout/`.
- `does not retry on non-timeout errors (listener-side failures
  propagate immediately)` — listener replies with
  `success: false, error: "listener rejected"`, asserts the error
  propagates after a single emit (no retry).
- `respects maxRetries=1 (no retry)` — explicit opt-out
  (`maxRetries: 1`), asserts `requestEmits === 1`.

Test pattern uses a `createRetryBus(failFirstNAttempts)` helper
that counts request-channel emits and selectively suppresses
replies. The "no listener at all" case (this session's actual
state) is `createRetryBus(Infinity)` — all emits go unanswered.

### Verified

- **pi-orchestrator**: 510/510 pass (was 506 pre-GC; +4 new tests).
  Typecheck clean. Pre-commit hook (`orchestrator:typecheck` +
  `orchestrator:test`) ran on commit.
- **pi-tasks**: 570/570 + 20 skip pass (no changes there, baseline
  maintained). Typecheck clean.

Single atomic commit on branch `fix/gc-2026-decompose-task-retry`
(merged to main via `--no-ff`).

## Follow-ups

1. **Idempotency on the pi-tasks side** (THE open issue). The
   retry loop is not safe under the "request reached the listener
   but reply did not make it back" race. The listener (in
   `pi-tasks/src/index.ts`'s `materializeDecomposeChain`) processes
   each request as if it were new, creating fresh chain tasks on
   every retry. A follow-up GC should:
   - Track processed `requestId`s in the listener (Map with TTL or
     a small LRU).
   - Or, equivalently, dedupe by `user_task_id` — if a previous
     `decompose_task(user_task_id=X, ...)` already produced a
     chain, return that chain (with whatever `requestId` matched
     the original call) instead of re-materializing.
   - Either fix should be in pi-tasks; the retry itself stays
     here in pi-orchestrator.
2. **Surface the "no listener" case in the error message.** When
   `pi-tasks` is genuinely not registered, retrying 3× just gives
   us 90s of waiting. A diagnostic that detects "this channel has
   never had a listener" (via `pi.events.listenerCount` or
   equivalent) and short-circuits with a clear
   `pi-tasks extension not registered — run install.sh and
   restart pi` would save 60s of wall-clock in the dead-end case.
   This was already flagged in
   `GC-2026-fix-decompose-task-ctx-events.md` follow-up #4; this
   GC's retry is a partial mitigation (it covers transient
   failure modes but not the deterministic "no listener" case).
3. **Backoff tuning.** `retryDelayMs` is exposed but defaults to
   0. In the general case the `rpcTimeoutMs` already provides
   spacing; if a future incident shows a transient listener race
   that the timeout can't recover from, exponential backoff (e.g.
   `50ms, 200ms, 500ms`) would be a small change in the loop.
   Defer until a use case lands.
