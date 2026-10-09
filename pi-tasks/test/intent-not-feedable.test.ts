/**
 * intent-not-feedable.test.ts — RED tests asserting that an intent task
 * without an explicit `agentType` is NOT feedable to the unified
 * task-feeder (GC-2026-122).
 *
 * GC-2026-121 follow-up made `isFeedableTask` return true for any
 * `kind: "intent"` task (even without agentType) so the feeder would
 * default-spawn a Planner. After GC-2026-122 the auto-spawn is gone,
 * so the predicate is tightened: a task is feedable iff it has an
 * explicit `agentType` (the only path the feeder should dispatch).
 *
 * The intent task stays in the store as data; the before_agent_start
 * reminder surfaces it to the main LLM.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";
import { isFeedableTask } from "../src/task-feeder.js";

describe("isFeedableTask — intent without agentType is NOT feedable (GC-2026-122)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("kind=intent (default user task) is NOT feedable", () => {
    const task = store.create("research X", "Investigate topic X deeply.");
    expect(task.metadata.kind).toBe("intent");
    expect(isFeedableTask(task)).toBe(false);
  });

  it("kind=intent with explicit agentType IS feedable (caller override)", () => {
    const task = store.create("investigate X", "Investigate X.", undefined, {
      created_by: "user",
      kind: "intent",
      agentType: "Explore",
    });
    expect(isFeedableTask(task)).toBe(true);
  });

  it("kind=actionable (with agentType) is feedable — no regression", () => {
    const task = store.create("fix typo", "Fix the typo.", undefined, {
      created_by: "user",
      agentType: "Developer",
    });
    expect(task.metadata.kind).toBe("actionable");
    expect(isFeedableTask(task)).toBe(true);
  });

  it("kind=step (orchestrator) is feedable — no regression", () => {
    const task = store.create("step", "Implement.", undefined, {
      created_by: "orchestrator",
      agentType: "Developer",
    });
    expect(task.metadata.kind).toBe("step");
    expect(isFeedableTask(task)).toBe(true);
  });

  it("task with no kind and no agentType is NOT feedable", () => {
    const task = store.create("misc", "details");
    expect(task.metadata.kind).toBe("intent");
    expect(isFeedableTask(task)).toBe(false);
  });

  it("kind=actionable with no agentType is NOT feedable (no dispatcher to feed)", () => {
    const task = store.create("actionable without agent", "Details.", undefined, {
      created_by: "user",
      kind: "actionable",
    });
    expect(isFeedableTask(task)).toBe(false);
  });
});
