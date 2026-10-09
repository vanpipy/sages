/**
 * intent-reminder-llm-injection.test.ts — RED tests asserting the
 * `before_agent_start` reminder reaches the LLM via SYSTEM PROMPT
 * INJECTION (not `ctx.ui.notify`).
 *
 * Background: GC-2026-120 AC5 added `maybeFireDecompositionReminder` in
 * `pi-tasks/src/index.ts`, but it called `ctx.ui.notify(...)` — a
 * UI-level toast. The LLM does NOT see ui.notify calls; the reminder
 * was effectively a user-facing decoration while the LLM remained
 * unaware of the pending intent.
 *
 * GC-2026-122 fixes this: the reminder is composed into a string and
 * injected into the LLM's system prompt via the `before_agent_start`
 * handler's return value (mirroring `pi-orchestrator/src/extension.ts`'s
 * SYSTEM.md injection pattern). The text explicitly tells the main LLM
 * to call `decompose_task` directly (or chat-answer if the intent is
 * trivial), eliminating the silent pending-intent dead-end.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";
import {
  makeIntentReminderState,
  composeIntentReminder,
  applyIntentReminderToSystemPrompt,
  type IntentReminderState,
} from "../src/intent-reminder.js";

describe("composeIntentReminder (GC-2026-122)", () => {
  let store: TaskStore;
  let state: IntentReminderState;

  beforeEach(() => {
    store = new TaskStore();
    state = makeIntentReminderState();
  });

  it("returns null when there are no pending intent tasks", () => {
    expect(composeIntentReminder(store, state)).toBeNull();
  });

  it("returns null when intent tasks exist but are already completed", () => {
    const t = store.create("research X", "Investigate.");
    store.update(t.id, { status: "completed" });
    expect(composeIntentReminder(store, state)).toBeNull();
  });

  it("returns null for orchestrator step tasks (kind=step, not intent)", () => {
    store.create("step", "Implement.", undefined, {
      created_by: "orchestrator",
      kind: "step",
      agentType: "Developer",
    });
    expect(composeIntentReminder(store, state)).toBeNull();
  });

  it("returns text for a single pending intent task", () => {
    const t = store.create("research X", "Investigate topic X deeply.");
    const text = composeIntentReminder(store, state);
    expect(text).not.toBeNull();
    expect(text).toContain(`#${t.id}`);
    expect(text).toContain("research X");
    expect(text).toContain("Investigate topic X");
  });

  it("text includes the call-to-action: decompose_task OR chat-answer", () => {
    store.create("research X", "Investigate.");
    const text = composeIntentReminder(store, state);
    expect(text).toContain("decompose_task(user_task_id");
    // Explicit permission to chat-answer for trivial intents:
    expect(text).toMatch(/chat-?answer/i);
  });

  it("truncates long descriptions to keep the reminder compact", () => {
    const longDesc = "x".repeat(500);
    store.create("long", longDesc);
    const text = composeIntentReminder(store, state);
    // Should NOT include the full 500 chars; should include "..."
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThan(500);
    expect(text).toContain("...");
  });

  it("dedupes across calls (only NEW intents appear in subsequent calls)", () => {
    const t1 = store.create("first", "First intent task.");
    const first = composeIntentReminder(store, state);
    expect(first).not.toBeNull();
    expect(first).toContain(`#${t1.id}`);
    // Second call with no new intents → null
    const second = composeIntentReminder(store, state);
    expect(second).toBeNull();
  });

  it("emits reminder for newly-arrived intent tasks after the first call", () => {
    store.create("first", "First.");
    composeIntentReminder(store, state);
    // A new intent arrives later:
    const t2 = store.create("second", "Second.");
    const text = composeIntentReminder(store, state);
    expect(text).not.toBeNull();
    expect(text).toContain(`#${t2.id}`);
    expect(text).not.toContain("First");  // only NEW intents in this batch
  });

  it("fresh state (e.g. session restart) fires again for the same intents", () => {
    store.create("research X", "Investigate.");
    composeIntentReminder(store, state);
    const state2 = makeIntentReminderState();
    const text = composeIntentReminder(store, state2);
    expect(text).not.toBeNull();  // fresh dedup set → fires again
  });
});

describe("applyIntentReminderToSystemPrompt (GC-2026-122 — LLM injection)", () => {
  let store: TaskStore;
  let state: IntentReminderState;

  beforeEach(() => {
    store = new TaskStore();
    state = makeIntentReminderState();
  });

  it("returns undefined when no pending intent tasks", () => {
    const out = applyIntentReminderToSystemPrompt(store, state, "old prompt");
    expect(out).toBeUndefined();
  });

  it("returns { systemPrompt: <reminder> } when no existing system prompt", () => {
    store.create("research X", "Investigate.");
    const out = applyIntentReminderToSystemPrompt(store, state, undefined);
    expect(out).toBeDefined();
    expect(out!.systemPrompt).toContain("decompose_task");
  });

  it("appends reminder to existing system prompt with separator", () => {
    store.create("research X", "Investigate.");
    const out = applyIntentReminderToSystemPrompt(
      store,
      state,
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
    const out = applyIntentReminderToSystemPrompt(store, state, "base");
    expect(typeof out!.systemPrompt).toBe("string");
    expect(out!.systemPrompt.length).toBeGreaterThan(0);
  });
});
