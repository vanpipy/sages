/**
 * planner-stale-metadata.test.ts — Tests that the Planner path handles
 * tasks created BEFORE GC-2026-121 (which lack the agentType stamp).
 *
 * Tasks on disk with `metadata.kind: "intent"` but no `agentType`
 * (i.e., created before GC-2026-121 changed inferKind) must still be
 * recognized as feedable. The spawn callback defaults the spawn type
 * to "Planner" for these.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";
import { isFeedableTask } from "../src/task-feeder.js";

describe("Planner handles stale intent tasks without agentType (GC-2026-121 follow-up)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("isFeedableTask returns true for kind=intent even without agentType", () => {
    // Simulate a task on disk created before GC-2026-121: kind=intent
    // was set, but agentType was NOT stamped (the old inferKind didn't
    // include that field).
    const stale = store.create("research X", "Investigate X.");
    // The post-fix inferKind stamps agentType=Planner — but a stale
    // task loaded from disk might have been written before this code.
    // Verify the predicate works for both the freshly-created case
    // and a hand-crafted stale shape.
    expect(isFeedableTask(stale)).toBe(true);
    expect(stale.metadata.kind).toBe("intent");
  });

  it("isFeedableTask returns true for hand-crafted stale intent tasks", () => {
    // Bypass inferKind by using a raw Task object representing a task
    // loaded from a pre-GC-2026-121 store file.
    const rawTask = {
      id: "stale-1",
      subject: "Pre-fix intent task",
      description: "Description.",
      status: "pending" as const,
      metadata: {
        created_by: "user",
        kind: "intent",
        requires_decomposition: true,
        // NOTE: no agentType — this is the stale shape
      },
      blocks: [],
      blockedBy: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(isFeedableTask(rawTask as any)).toBe(true);
  });

  it("isFeedableTask still rejects raw tasks without agentType AND without kind=intent", () => {
    const rawTask = {
      id: "raw-1",
      subject: "Truly manual",
      description: "Description.",
      status: "pending" as const,
      metadata: {
        created_by: "user",
        // No agentType, no kind=intent — truly orphaned
      },
      blocks: [],
      blockedBy: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(isFeedableTask(rawTask as any)).toBe(false);
  });

  it("inferKind stamps Planner for the legacy agentType-less path", () => {
    // Re-running inferKind on a metadata blob without kind/agentType
    // produces kind=intent + agentType=Planner. This is the live path
    // for new tasks. The fix here is the isFeedableTask fallback
    // for tasks written before this rule shipped.
    const t = store.create("research Y", "Investigate Y.");
    expect(t.metadata.kind).toBe("intent");
    expect(t.metadata.agentType).toBe("Planner");
  });
});