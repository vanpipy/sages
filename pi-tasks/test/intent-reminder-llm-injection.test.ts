/**
 * intent-reminder-llm-injection.test.ts — GC-2026-122 + GC-2026-continuous-intent-reminder.
 *
 * The reminder reaches the LLM via SYSTEM PROMPT INJECTION (the
 * `before_agent_start` handler returns `{ systemPrompt: ... }`), not
 * `ctx.ui.notify`. The LLM therefore sees a continuous nudge for every
 * pending `kind: "intent"` task.
 *
 * GC-2026-continuous-intent-reminder (this GC): the pre-fix
 * `composeIntentReminder` tracked a per-session `remindedIds` set and
 * returned `null` once an intent had been listed once. The
 * "once-per-session" dedup left intent tasks silent whenever the main
 * LLM got distracted (or the prior `decompose_task` call failed) — the
 * only way to get re-reminded was a `session_start` reset, which the
 * user cannot trigger on demand.
 *
 * The fix: drop the dedup state. The reminder now lists EVERY pending
 * intent on EVERY call. The intent naturally leaves the reminder when
 * its `status` flips off `pending` — which happens in two places:
 *   1. `materializeDecomposeChain` auto-completes the user task on
 *      successful chain materialization (GC-2026-120 AC3 / D2).
 *   2. The LLM explicitly marks it completed via `TaskUpdate` (the
 *      chat-answer path from the call-to-action).
 *
 * No new consumer, no new tool — the LLM was always the sole consumer;
 * the only change is that the reminder keeps firing until the consumer
 * actually consumes.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  applyIntentReminderToSystemPrompt,
  composeIntentReminder,
} from "../src/intent-reminder.js";
import { TaskStore } from "../src/task-store.js";

describe("composeIntentReminder (GC-2026-continuous-intent-reminder)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("returns null when there are no pending intent tasks", () => {
    expect(composeIntentReminder(store)).toBeNull();
  });

  it("returns null when intent tasks exist but are already completed", () => {
    const t = store.create("research X", "Investigate.");
    store.update(t.id, { status: "completed" });
    expect(composeIntentReminder(store)).toBeNull();
  });

  it("returns null for orchestrator step tasks (kind=step, not intent)", () => {
    store.create("step", "Implement.", undefined, {
      created_by: "orchestrator",
      kind: "step",
      agentType: "Developer",
    });
    expect(composeIntentReminder(store)).toBeNull();
  });

  it("returns text for a single pending intent task", () => {
    const t = store.create("research X", "Investigate topic X deeply.");
    const text = composeIntentReminder(store);
    expect(text).not.toBeNull();
    expect(text).toContain(`#${t.id}`);
    expect(text).toContain("research X");
    expect(text).toContain("Investigate topic X");
  });

  it("text includes the call-to-action: decompose_task OR chat-answer", () => {
    store.create("research X", "Investigate.");
    const text = composeIntentReminder(store);
    expect(text).toContain("decompose_task(user_task_id");
    // Explicit permission to chat-answer for trivial intents:
    expect(text).toMatch(/chat-?answer/i);
  });

  it("truncates long descriptions to keep the reminder compact", () => {
    const longDesc = "x".repeat(500);
    store.create("long", longDesc);
    const text = composeIntentReminder(store);
    // Should NOT include the full 500 chars; should include "..."
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThan(500);
    expect(text).toContain("...");
  });

  // ── GC-2026-continuous-intent-reminder: surface the SAME pending intent
  // on every call until it is consumed. The pre-fix behavior deduped
  // after the first surface and returned null on subsequent calls —
  // leaving the intent orphaned if the LLM did not act on the first
  // reminder (e.g. got distracted, or the prior decompose_task RPC
  // failed and the user task was reverted to pending via AC6 rollback).
  it("surfaces the same pending intent on every call (no once-per-session dedup)", () => {
    const t1 = store.create("first", "First intent task.");
    const first = composeIntentReminder(store);
    expect(first).not.toBeNull();
    expect(first).toContain(`#${t1.id}`);
    // Second call with no new intents: the same pending intent must
    // still be listed. The reminder is a continuous nudge, not a
    // one-shot notification.
    const second = composeIntentReminder(store);
    expect(second).not.toBeNull();
    expect(second).toContain(`#${t1.id}`);
    // And a third call, to make the "continuous" semantics explicit:
    const third = composeIntentReminder(store);
    expect(third).not.toBeNull();
    expect(third).toContain(`#${t1.id}`);
  });

  it("lists a newly-arrived intent alongside the still-pending one", () => {
    const t1 = store.create("first", "First.");
    const first = composeIntentReminder(store);
    expect(first).not.toBeNull();
    expect(first).toContain(`#${t1.id}`);
    // A new intent arrives later — it joins the still-pending first one
    // in the same reminder. No "new only" filtering.
    const t2 = store.create("second", "Second.");
    const text = composeIntentReminder(store);
    expect(text).not.toBeNull();
    expect(text).toContain(`#${t1.id}`); // still pending
    expect(text).toContain(`#${t2.id}`); // newly arrived
  });

  // ── GC-2026-continuous-intent-reminder: an intent stops appearing in
  // the reminder as soon as its `status` flips off `pending`. The two
  // natural exit paths are:
  //   (a) `materializeDecomposeChain` auto-completes the user task
  //       (`completed_via: "decomposition"`, GC-2026-120 AC3);
  //   (b) the LLM explicitly `TaskUpdate`s the task to completed
  //       (the chat-answer path for trivial intents).
  // Both produce the same observable signal: `status !== "pending"`.
  it("stops surfacing an intent after the user task is auto-completed by decompose", () => {
    const t = store.create("research X", "Investigate.");
    // Simulate GC-2026-120 AC3's auto-complete on successful chain
    // materialization. The exact metadata (`completed_via`,
    // `completed_at`) is not part of the reminder predicate; only
    // `status` matters.
    store.update(t.id, {
      status: "completed",
      metadata: {
        ...t.metadata,
        completed_via: "decomposition",
        completed_at: new Date().toISOString(),
      },
    });
    expect(composeIntentReminder(store)).toBeNull();
  });

  it("stops surfacing an intent after the LLM explicitly marks it completed", () => {
    const t = store.create("trivial question", "User asked a quick question.");
    // First call: still pending.
    expect(composeIntentReminder(store)).toContain(`#${t.id}`);
    // LLM chat-answers and marks the task completed via TaskUpdate.
    store.update(t.id, { status: "completed" });
    expect(composeIntentReminder(store)).toBeNull();
  });

  it("stops surfacing an intent after a failed decompose is rolled back to deleted", () => {
    const t = store.create("research X", "Investigate.");
    expect(composeIntentReminder(store)).toContain(`#${t.id}`);
    // Simulate the user deleting the intent (e.g. gave up on it).
    store.delete(t.id);
    expect(composeIntentReminder(store)).toBeNull();
  });
});

describe("applyIntentReminderToSystemPrompt (GC-2026-continuous-intent-reminder)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("returns undefined when no pending intent tasks", () => {
    const out = applyIntentReminderToSystemPrompt(store, "old prompt");
    expect(out).toBeUndefined();
  });

  it("returns { systemPrompt: <reminder> } when no existing system prompt", () => {
    store.create("research X", "Investigate.");
    const out = applyIntentReminderToSystemPrompt(store, undefined);
    expect(out).toBeDefined();
    expect(out!.systemPrompt).toContain("decompose_task");
  });

  it("appends reminder to existing system prompt with separator", () => {
    store.create("research X", "Investigate.");
    const out = applyIntentReminderToSystemPrompt(
      store,
      "Existing system prompt from pi-orchestrator.",
    );
    expect(out).toBeDefined();
    expect(out!.systemPrompt).toContain("Existing system prompt from pi-orchestrator.");
    expect(out!.systemPrompt).toContain("decompose_task");
    // Separator present
    expect(out!.systemPrompt).toContain("---");
  });

  it("returns a string-shaped result (the LLM contract is { systemPrompt: string })", () => {
    store.create("research X", "Investigate.");
    const out = applyIntentReminderToSystemPrompt(store, "base");
    expect(typeof out!.systemPrompt).toBe("string");
    expect(out!.systemPrompt.length).toBeGreaterThan(0);
  });

  it("returns the same systemPrompt on every call while intent remains pending (continuous nudge)", () => {
    store.create("research X", "Investigate.");
    const a = applyIntentReminderToSystemPrompt(store, "base");
    const b = applyIntentReminderToSystemPrompt(store, "base");
    const c = applyIntentReminderToSystemPrompt(store, "base");
    expect(a!.systemPrompt).toBe(b!.systemPrompt);
    expect(b!.systemPrompt).toBe(c!.systemPrompt);
  });
});
