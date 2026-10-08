/**
 * decompose-reminder-multi.test.ts — Tests that the decomposition reminder
 * fires for EVERY new intent task, not just the first batch in a session.
 *
 * GC-2026-120 follow-up: the original "once-per-session" boolean gating
 * (`decompositionReminderFired`) missed any intent task added AFTER the
 * first reminder fired. This fixture pins the corrected behavior: track
 * the set of reminded task ids, fire on each NEW intent task.
 */

import { describe, expect, it } from "bun:test";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/types.js";

interface ReminderCtx {
  remindedIds: Set<string>;
  firedBatches: Task[][];
  reset(): void;
  maybeFireReminder(store: TaskStore): void;
}

function makeCtx(): ReminderCtx {
  const ctx: ReminderCtx = {
    remindedIds: new Set<string>(),
    firedBatches: [],
    reset() {
      this.remindedIds.clear();
      this.firedBatches = [];
    },
    maybeFireReminder(store) {
      const intents = store.list().filter(
        (t) =>
          t.status === "pending" &&
          t.metadata?.kind === "intent",
      );
      const newIntents = intents.filter((t) => !this.remindedIds.has(t.id));
      if (newIntents.length === 0) return;
      this.remindedIds = new Set(intents.map((t) => t.id));
      this.firedBatches.push(newIntents);
    },
  };
  return ctx;
}

describe("decomposition reminder — fires for every new intent task (GC-2026-120 follow-up)", () => {
  it("fires for the first intent task", () => {
    const store = new TaskStore();
    const ctx = makeCtx();
    store.create("research X", "Investigate.");
    ctx.maybeFireReminder(store);
    expect(ctx.firedBatches).toHaveLength(1);
    expect(ctx.firedBatches[0]).toHaveLength(1);
  });

  it("fires AGAIN when a second intent task is added after the first reminder", () => {
    const store = new TaskStore();
    const ctx = makeCtx();
    store.create("research X", "Investigate X.");
    ctx.maybeFireReminder(store);
    expect(ctx.firedBatches).toHaveLength(1);
    // Second intent task added after the first reminder fired.
    store.create("research Y", "Investigate Y.");
    ctx.maybeFireReminder(store);
    expect(ctx.firedBatches).toHaveLength(2);
    expect(ctx.firedBatches[1]).toHaveLength(1);
    expect(ctx.firedBatches[1][0].subject).toBe("research Y");
  });

  it("fires AGAIN when several intent tasks arrive in a batch", () => {
    const store = new TaskStore();
    const ctx = makeCtx();
    // First batch — fires once.
    store.create("research X", "Investigate X.");
    store.create("research Y", "Investigate Y.");
    ctx.maybeFireReminder(store);
    expect(ctx.firedBatches).toHaveLength(1);
    expect(ctx.firedBatches[0]).toHaveLength(2);
    // Second batch — fires again.
    store.create("research Z", "Investigate Z.");
    store.create("research W", "Investigate W.");
    ctx.maybeFireReminder(store);
    expect(ctx.firedBatches).toHaveLength(2);
    expect(ctx.firedBatches[1]).toHaveLength(2);
  });

  it("does not re-fire for the same task (idempotent)", () => {
    const store = new TaskStore();
    const ctx = makeCtx();
    store.create("research X", "Investigate.");
    ctx.maybeFireReminder(store);
    ctx.maybeFireReminder(store);
    ctx.maybeFireReminder(store);
    expect(ctx.firedBatches).toHaveLength(1);
  });

  it("fires after a previously-reminded task is decomposed (task leaves the pending-intent pool)", () => {
    const store = new TaskStore();
    const ctx = makeCtx();
    const t1 = store.create("research X", "Investigate.");
    ctx.maybeFireReminder(store);
    expect(ctx.firedBatches).toHaveLength(1);
    // Task #1 was decomposed — auto-completed by materializeDecomposeChain.
    store.update(t1.id, {
      status: "completed",
      metadata: { ...t1.metadata, completed_via: "decomposition" },
    });
    // A new intent task arrives.
    store.create("research Y", "Investigate Y.");
    ctx.maybeFireReminder(store);
    expect(ctx.firedBatches).toHaveLength(2);
    expect(ctx.firedBatches[1]).toHaveLength(1);
    expect(ctx.firedBatches[1][0].subject).toBe("research Y");
  });

  it("fires after session reset (simulating new session)", () => {
    const store = new TaskStore();
    const ctx = makeCtx();
    store.create("research X", "Investigate.");
    ctx.maybeFireReminder(store);
    expect(ctx.firedBatches).toHaveLength(1);
    expect(ctx.remindedIds.has("1")).toBe(true);
    ctx.reset(); // session_start clears remindedIds so the new session sees X as new
    expect(ctx.remindedIds.size).toBe(0);
    ctx.maybeFireReminder(store);
    expect(ctx.firedBatches).toHaveLength(1); // history is fresh post-reset
    expect(ctx.remindedIds.has("1")).toBe(true); // X is now re-reminded
  });

  it("does not fire when no intent tasks exist", () => {
    const store = new TaskStore();
    const ctx = makeCtx();
    ctx.maybeFireReminder(store);
    expect(ctx.firedBatches).toHaveLength(0);
  });
});