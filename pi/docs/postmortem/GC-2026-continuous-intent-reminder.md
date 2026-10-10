# GC-2026-continuous-intent-reminder — Make intent reminder continuous until consumed

## What happened

GC-2026-122 (the immediately-preceding GC in this series) shipped a
`before_agent_start` reminder that surfaced pending `kind: "intent"`
tasks to the main LLM via system-prompt injection. The intent was
correct: the main LLM is the sole consumer, the transport reaches it
where `ctx.ui.notify` did not, and the call-to-action tells the LLM
exactly what to do (`decompose_task(...)` or chat-answer + `TaskUpdate`).

But the implementation was a **one-shot nudge**: the reminder tracked
a per-session `remindedIds: Set<string>` and returned `null` once an
intent had been listed once. The pre-fix design assumed the LLM would
act on the first reminder; the empirical reality (observed in this
session on the intent "了解一下当前仓库") is that the LLM can get
distracted, prioritize other work, or sit on a reminder that gets
swallowed by the next chunk of the conversation. Once the intent is
in `remindedIds`, no subsequent `before_agent_start` call will re-list
it until the next `session_start` — which the user cannot trigger on
demand.

The orphan path is real:
1. User runs `/tasks create "了解一下当前仓库"` → intent #1 in store,
   `remindedIds = {}`.
2. LLM thinks → `before_agent_start` injects reminder → `remindedIds =
   {#1}`. LLM gets distracted by an unrelated user message.
3. LLM thinks again → `before_agent_start` returns `null` (no new
   intents). #1 sits pending.
4. Repeat indefinitely. No agent owns the task. The widget shows a
   pending task with no consumer. The user has no recourse except
   `/tasks delete` or manual `TaskUpdate`.

The companion test (`intent-reminder-llm-injection.test.ts:84-92`)
**pinned the broken behavior**:

```ts
it("dedupes across calls (only NEW intents appear in subsequent calls)", () => {
  const t1 = store.create("first", "First intent task.");
  const first = composeIntentReminder(store, state);
  expect(first).toContain(`#${t1.id}`);
  const second = composeIntentReminder(store, state);
  expect(second).toBeNull();   // ← bug frozen in
});
```

## Root cause

The dedup state was inherited from a different architecture
(GC-2026-120 AC5's `decompositionReminderFired: boolean`, then
GC-2026-120 follow-up's per-intent `remindedIds`). Both pre-GC-122
implementations fired a **toast** (`ctx.ui.notify`) which the LLM
could not see, so dedup was an *acceptable* correctness choice: the
LLM was not the consumer, dedup avoided spamming the user.

GC-2026-122 changed the transport to system-prompt injection — the
LLM is now the consumer — but kept the dedup state. The dedup made
sense when the consumer was the user (one toast per intent per
session). Once the consumer became the LLM, dedup turned into a
sustainability bug: the LLM, like any consumer, may not act on the
first delivery (distraction, priority inversion, transient error).

The design tension was never articulated: the GC-2026-122 design
assumed a "fire-and-forget consumer", but the LLM is a
"continuous-poll consumer" — it needs to be re-prompted until it
actually processes the input. Treating the LLM as fire-and-forget is
the bug.

## Fix

Drop the per-session `remindedIds` state entirely. The reminder
becomes a pure function of the live store: it lists **every**
currently-pending `kind: "intent"` task on **every** call. The
intent naturally leaves the reminder when its `status` flips off
`pending`, which happens at exactly two exit points:

1. **`materializeDecomposeChain` auto-completes the user task on
   successful chain materialization** (GC-2026-120 AC3 / D2). Sets
   `status: "completed"` + `completed_via: "decomposition"`.
   Failure path: AC6 rolls the user task back to `pending` (the
   chain is deleted, the reviewer is deleted, prior metadata
   restored) — so a transient `decompose_task` failure does NOT
   strand the intent, the reminder just keeps firing until the LLM
   succeeds or the user takes a different action.
2. **The LLM explicitly marks the intent completed via `TaskUpdate`**
   (the chat-answer path for trivial intents). The reminder's own
   call-to-action tells the LLM to do this.

No new consumer, no new tool, no new LLM-side protocol. The LLM was
always the sole consumer; the only change is that the reminder now
keeps firing until the consumer actually consumes. This is the
*least invasive* possible fix and matches the Sages principle that
"complex work deserves a typed review gate, but not every task is
complex work" — the fix doesn't add ceremony, it just stops
quarantining the message after the first send.

### What changed (3 files, 183 insertions / 118 deletions)

- `pi-tasks/src/intent-reminder.ts` — rewrite: `composeIntentReminder(store)`
  (no state), `applyIntentReminderToSystemPrompt(store, existingSystemPrompt?)`
  (no state). Removed `IntentReminderState` interface + `makeIntentReminderState`
  factory. Module doc updated to document the new "continuous until consumed"
  contract and the two natural exit points.
- `pi-tasks/src/index.ts` — drop the `intentReminderState` variable (line
  773), the `session_start` reset (line 822), the import (lines 28-32),
  and the `state` argument from the `applyIntentReminderToSystemPrompt`
  call (line 868-872). Comments updated.
- `pi-tasks/test/intent-reminder-llm-injection.test.ts` — RED: inverted
  the "dedupes across calls" test to assert the SAME intent surfaces
  on every call; inverted the "emits reminder for newly-arrived intent
  tasks after the first call" test to assert the new intent JOINS the
  still-pending one; removed the "fresh state fires again" test (state
  is gone); added 3 new tests covering the exit paths
  (auto-completed-by-decompose, explicitly-completed-by-LLM,
  deleted-after-rollback). Added 1 idempotency test in the
  `applyIntentReminderToSystemPrompt` block to assert the same
  systemPrompt on every call while intent remains pending.

## What did NOT change

- `inferKind` in `pi-tasks/src/task-store.ts:127-163` — still stamps
  `kind: "intent"` for user tasks without agentType. The semantic
  marker is correct; only the reminder's behavior was wrong.
- `isFeedableTask` in `pi-tasks/src/task-feeder.ts:68-74` — still
  requires an explicit `agentType`. Intent tasks are still NOT
  auto-feedable; the main LLM is still the sole consumer.
- `materializeDecomposeChain` in `pi-tasks/src/index.ts:466-644` —
  AC3 auto-completion + AC6 rollback unchanged.
- `task-feeder.cascadeSpawn` in `pi-tasks/src/task-feeder.ts:177-201`
  — F5 child-walk optimization unchanged.
- `AutoClearManager` in `pi-tasks/src/auto-clear.ts:33-161` —
  `abandonedIntentHours` still defaults to 0, so no auto-delete path
  interferes with the reminder.
- `pi-tasks/test/decompose-reminder-multi.test.ts` — local-fixture
  test that does NOT import the production `composeIntentReminder`.
  Its `remindedIds` semantics live entirely in the test fixture and
  are an internal property of `ReminderCtx`, not the production
  reminder. Untouched (and explicitly out of scope per anti_goals).

## TDD evidence

3 atomic steps.

| Step | Test count | Note |
|---|---:|---|
| RED — flipped + new tests fail | 11 fail / 5 pass | All failures are `TypeError: undefined is not an object (evaluating 'state.remindedIds.has')` — production still has the dedup state, new signature is `composeIntentReminder(store)` |
| GREEN — production rewritten | 16 pass / 0 fail | All flipped + new tests pass; old tests that align with the new semantics still pass |
| REFACTOR — confirmed | 16 pass / 0 fail | Idempotency test added to `applyIntentReminderToSystemPrompt` block |

Full pi-tasks test run: **376 pass / 1 skip / 23 pre-existing fail / 14
pre-existing error** — 0 new regressions. The 23 pre-existing failures
are the environment-issues documented in GC-2026-122 follow-up #4
(missing `typebox` / `@earendil-works/pi-tui` / `@earendil-works/pi-coding-agent`
in the main repo's `node_modules`) + the expected failures of the 3
"GC-2026-121 follow-up" tests that pin the Planner auto-stamp behavior
GC-2026-122 correctly reversed.

Full pi-orchestrator test run: **531 pass / 0 fail / 1131 expect() calls
across 35 files**. The pre-commit hook (`orchestrator:typecheck` +
`orchestrator:test`) passes cleanly.

## Process notes

- `workflow_run` watchdog tripped on the entry point (10s
  `workflow:phase-complete` timeout — same recurring bug as
  GC-2026-120 / GC-2026-121 / GC-2026-122: pi-tasks + pi-subagents
  extensions not registered in the active session). The 10s watchdog
  added in GC-2026-109 caught the issue and surfaced a clear error
  message naming the actionable fix (`install.sh` + restart pi).
- Per `AGENTS.md` soft-mode manual-takeover contract, the orchestrator
  main agent implemented the 3-file change directly via `edit` /
  `write` / `bash` — TDD discipline preserved (RED → GREEN → REFACTOR
  with self-contained test fixtures). No worktree dispatch was
  attempted because the dispatch path was the very thing that
  tripped the watchdog.

## Follow-ups

- **Document the "continuous until consumed" contract** in
  `AGENTS.md` / `README.md` / `pi-orchestrator/skills/orchestrator/SKILL.md`.
  The postmortem + the new test headers are the source of truth for
  now; the broader docs are out of scope for this GC.
- **Cookbook entry** for the "intent reminder is a pure function of
  the live store" pattern — same shape as other stateless-pure
  reminders, but with the "consumer eventually consumes" exit
  semantics that other systems often miss. Defer until broader docs
  ship.
- **Audit for the same "fire-and-forget" antipattern elsewhere**.
  The same design tension (LLM treated as fire-and-forget consumer)
  could exist in other reminder / nudge / follow-up surfaces. A
  future GC could sweep the codebase for `remindedIds` /
  `notifiedIds` / `seenSet` patterns and verify each one is
  actually backed by a non-LLM consumer (UI, network) that
  justifies the dedup.
- **Pre-existing `bun test` failures in the main repo** (typebox /
  `@earendil-works/*` missing in `node_modules`, vitest
  incompatibilities) are environment issues; `bun install
  --frozen-lockfile` resolves them in a worktree but the main
  repo's install state is out of scope.
