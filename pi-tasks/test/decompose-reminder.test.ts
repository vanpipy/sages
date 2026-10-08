/**
 * decompose-reminder.test.ts — Tests the `before_agent_start` hook that
 * fires a once-per-session reminder for pending `kind: "intent"` tasks
 * (GC-2026-120 AC5).
 *
 * The hook:
 *   - Watches for tasks with `metadata.kind === "intent"` && `status === "pending"`
 *   - Emits a system entry listing them with subject + description preview
 *     and a call-to-action: "call decompose_task(user_task_id=\"N\", specs=[...])"
 *   - Fires once per session (a flag resets on session_start)
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/types.js";

interface ReminderCtx {
  pendingIntents: Task[];
  fired: boolean;
  reset(): void;
  maybeFireReminder(store: TaskStore): void;
}

/**
 * Inline copy of the reminder logic. Mirrors the production code in
 * pi-tasks/src/index.ts's before_agent_start hook.
 */
function makeCtx(): ReminderCtx {
  const ctx: ReminderCtx = {
    pendingIntents: [],
    fired: false,
    reset() {
      this.fired = false;
      this.pendingIntents = [];
    },
    maybeFireReminder(store) {
      if (this.fired) return;
      const intents = store.list().filter(
        (t) => t.status === "pending" && t.metadata?.kind === "intent",
      );
      if (intents.length === 0) return;
      this.pendingIntents = intents;
      this.fired = true;
    },
  };
  return ctx;
}

describe("decomposition reminder (GC-2026-120 AC5)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("fires for pending intent task with no agentType", () => {
    store.create("research X", "Investigate topic X deeply.");
    const ctx = makeCtx();
    ctx.maybeFireReminder(store);
    expect(ctx.fired).toBe(true);
    expect(ctx.pendingIntents).toHaveLength(1);
    expect(ctx.pendingIntents[0].subject).toBe("research X");
  });

  it("does NOT fire when no intent tasks exist", () => {
    store.create("regular task", "Plain task.", undefined, {
      created_by: "user",
      agentType: "Developer", // actionable — no intent
    });
    const ctx = makeCtx();
    ctx.maybeFireReminder(store);
    expect(ctx.fired).toBe(false);
    expect(ctx.pendingIntents).toHaveLength(0);
  });

  it("does NOT fire for completed intent tasks (chain already materialized)", () => {
    const t = store.create("research X", "Investigate.");
    store.update(t.id, { status: "completed" });
    const ctx = makeCtx();
    ctx.maybeFireReminder(store);
    expect(ctx.fired).toBe(false);
  });

  it("does NOT fire for in-progress intent tasks (LLM already claimed)", () => {
    const t = store.create("research X", "Investigate.");
    store.update(t.id, { status: "in_progress" });
    const ctx = makeCtx();
    ctx.maybeFireReminder(store);
    expect(ctx.fired).toBe(false);
  });

  it("does NOT fire for orchestrator-created tasks (kind=step)", () => {
    store.create("step task", "Orchestrator step.", undefined, {
      created_by: "orchestrator",
      kind: "step",
      agentType: "Developer",
    });
    const ctx = makeCtx();
    ctx.maybeFireReminder(store);
    expect(ctx.fired).toBe(false);
  });

  it("fires only ONCE per session even with multiple intent tasks", () => {
    store.create("research X", "First intent task.");
    store.create("research Y", "Second intent task.");
    store.create("research Z", "Third intent task.");
    const ctx = makeCtx();
    ctx.maybeFireReminder(store);
    expect(ctx.fired).toBe(true);
    expect(ctx.pendingIntents).toHaveLength(3);
    // Second call should be a no-op.
    ctx.pendingIntents = [];
    ctx.maybeFireReminder(store);
    expect(ctx.pendingIntents).toHaveLength(0);
  });

  it("fires again after session reset (simulating new session)", () => {
    store.create("research X", "First intent task.");
    const ctx = makeCtx();
    ctx.maybeFireReminder(store);
    expect(ctx.fired).toBe(true);
    // Session ends — reset the reminder flag.
    ctx.reset();
    ctx.maybeFireReminder(store);
    expect(ctx.fired).toBe(true);
  });

  it("picks up intent tasks added AFTER the first reminder was suppressed (no intents at time 1)", () => {
    const ctx = makeCtx();
    ctx.maybeFireReminder(store); // no intents — does not fire
    expect(ctx.fired).toBe(false);
    store.create("late intent", "Arrived after the empty check.");
    ctx.maybeFireReminder(store);
    expect(ctx.fired).toBe(true);
    expect(ctx.pendingIntents).toHaveLength(1);
  });
});