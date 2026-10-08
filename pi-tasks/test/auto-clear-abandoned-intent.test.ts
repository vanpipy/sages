/**
 * auto-clear-abandoned-intent.test.ts — Tests the abandoned_intent cleanup
 * strategy in AutoClearManager (GC-2026-120 AC7).
 *
 * Tasks with `kind === "intent" && status === "pending" && now - createdAt > TTL`
 * are auto-deleted on `onTurnStart`. The TTL is opt-in via the
 * `abandonedIntentHours` constructor parameter (default 0 = disabled).
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { AutoClearManager } from "../src/auto-clear.js";
import { TaskStore } from "../src/task-store.js";

describe("auto-clear abandoned intent tasks (GC-2026-120 AC7)", () => {
  let store: TaskStore;
  let manager: AutoClearManager;

  beforeEach(() => {
    store = new TaskStore();
    manager = new AutoClearManager(
      () => store,
      () => "never",
      4, // clearDelayTurns (default)
      { abandonedIntentHours: 24 },
    );
  });

  it("does NOT clear intent task that is younger than the TTL", () => {
    const t = store.create("research X", "Investigate.");
    // Just created — createdAt = now. TTL is 24h.
    manager.onTurnStart(2);
    expect(store.get(t.id)).toBeDefined();
  });

  it("does NOT clear completed intent task (chain already materialized)", () => {
    const t = store.create("research X", "Investigate.");
    store.update(t.id, {
      status: "completed",
      metadata: {
        ...t.metadata,
        completed_via: "decomposition",
        completed_at: new Date().toISOString(),
      },
    });
    manager.onTurnStart(2);
    expect(store.get(t.id)).toBeDefined();
  });

  it("does NOT clear in_progress intent task (LLM already claimed)", () => {
    const t = store.create("research X", "Investigate.");
    store.update(t.id, { status: "in_progress" });
    manager.onTurnStart(2);
    expect(store.get(t.id)).toBeDefined();
  });

  it("does NOT clear non-intent task (kind=actionable with agentType)", () => {
    const t = store.create("fix typo", "Fix.", undefined, {
      created_by: "user",
      agentType: "Developer",
    });
    manager.onTurnStart(2);
    expect(store.get(t.id)).toBeDefined();
  });

  it("does NOT clear orchestrator-created task (kind=step)", () => {
    const t = store.create("step task", "Orchestrator step.", undefined, {
      created_by: "orchestrator",
      kind: "step",
      agentType: "Developer",
    });
    manager.onTurnStart(2);
    expect(store.get(t.id)).toBeDefined();
  });

  it("is disabled when abandonedIntentHours = 0 (default)", () => {
    // New store so the prior beforeEach doesn't leak state.
    const localStore = new TaskStore();
    const defaultManager = new AutoClearManager(
      () => localStore,
      () => "never",
      4,
      // No abandonedIntentHours option — defaults to 0/disabled.
    );
    const t = localStore.create("research X", "Investigate.");
    defaultManager.onTurnStart(2);
    expect(localStore.get(t.id)).toBeDefined();
  });

  it("clears abandoned intent task when createdAt is older than the TTL", () => {
    const t = store.create("research X", "Investigate.");
    // The store's update() doesn't expose createdAt directly, so we
    // poke the in-memory map to simulate aging.
    const internalTask = (store as any).tasks.get(t.id);
    internalTask.createdAt = Date.now() - 25 * 60 * 60 * 1000; // 25h ago
    manager.onTurnStart(2);
    expect(store.get(t.id)).toBeUndefined();
  });

  it("clears multiple abandoned intent tasks in one onTurnStart call", () => {
    const t1 = store.create("research X", "Investigate X.");
    const t2 = store.create("research Y", "Investigate Y.");
    const t3 = store.create("research Z", "Investigate Z.");
    for (const t of [t1, t2, t3]) {
      const internalTask = (store as any).tasks.get(t.id);
      internalTask.createdAt = Date.now() - 25 * 60 * 60 * 1000;
    }
    manager.onTurnStart(2);
    expect(store.list()).toHaveLength(0);
  });

  it("respects custom TTL (12h)", () => {
    const customManager = new AutoClearManager(
      () => store,
      () => "never",
      4,
      { abandonedIntentHours: 12 },
    );
    const t = store.create("research X", "Investigate.");
    const internalTask = (store as any).tasks.get(t.id);
    internalTask.createdAt = Date.now() - 13 * 60 * 60 * 1000; // 13h ago
    customManager.onTurnStart(2);
    expect(store.get(t.id)).toBeUndefined();
  });

  it("does NOT clear if TTL is negative", () => {
    const localStore = new TaskStore();
    const negativeManager = new AutoClearManager(
      () => localStore,
      () => "never",
      4,
      { abandonedIntentHours: -1 },
    );
    const t = localStore.create("research X", "Investigate.");
    const internalTask = (localStore as any).tasks.get(t.id);
    internalTask.createdAt = Date.now() - 100 * 60 * 60 * 1000; // 100h ago
    negativeManager.onTurnStart(2);
    expect(localStore.get(t.id)).toBeDefined();
  });
});