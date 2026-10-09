/**
 * intent-no-planner-stamp.test.ts — RED tests asserting that
 * `TaskStore.create` does NOT auto-stamp `agentType: "Planner"` on
 * intent tasks (GC-2026-122).
 *
 * GC-2026-121 added the Planner auto-stamp so the unified feeder would
 * spawn a Planner subagent that calls `decompose_task` autonomously.
 * Empirically, the Planner conservatively BLOCKed on informational
 * intents (e.g. "了解一下当前仓库") because its prompt forbids any
 * repo exploration / context-aware reasoning — so the auto-spawn
 * produced a dead-end task.
 *
 * GC-2026-122 reverses that: intent tasks keep `kind: "intent"` +
 * `requires_decomposition: true` (semantic) but lose the auto-stamped
 * `agentType`. The main LLM is the sole consumer; the before_agent_start
 * reminder (in `pi-tasks/src/intent-reminder.ts`) surfaces pending
 * intents to the LLM via system-prompt injection.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";

describe("TaskStore.create does NOT auto-stamp agentType=Planner (GC-2026-122)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("default user task (no metadata) has kind=intent but no agentType", () => {
    const task = store.create("do something", "details");
    expect(task.metadata.kind).toBe("intent");
    expect(task.metadata.agentType).toBeUndefined();
  });

  it("user task with no agentType keeps kind=intent and no agentType", () => {
    const task = store.create("research X", "Investigate topic X deeply.");
    expect(task.metadata.kind).toBe("intent");
    expect(task.metadata.agentType).toBeUndefined();
  });

  it("still sets requires_decomposition=true (semantic intent marker)", () => {
    const task = store.create("research X", "Investigate X.");
    expect(task.metadata.requires_decomposition).toBe(true);
  });

  it("does NOT override an explicit user-supplied agentType on intent tasks", () => {
    // If the caller explicitly sets agentType=Explore, the store must
    // respect that (caller is asserting a specific dispatcher).
    const task = store.create("investigate X", "Investigate X deeply.", undefined, {
      created_by: "user",
      kind: "intent",
      agentType: "Explore",
    });
    expect(task.metadata.agentType).toBe("Explore");
  });

  it("does NOT change actionable task inference (kind=actionable keeps explicit agentType)", () => {
    const task = store.create("fix typo", "Fix the typo.", undefined, {
      created_by: "user",
      agentType: "Developer",
    });
    expect(task.metadata.kind).toBe("actionable");
    expect(task.metadata.agentType).toBe("Developer");
  });

  it("does NOT change orchestrator step inference (kind=step keeps explicit agentType)", () => {
    const task = store.create("step", "Implement.", undefined, {
      created_by: "orchestrator",
      agentType: "Developer",
    });
    expect(task.metadata.kind).toBe("step");
    expect(task.metadata.agentType).toBe("Developer");
  });

  it("explicit kind=actionable with no agentType is NOT demoted to intent", () => {
    // If a caller passes kind=actionable explicitly, store must honor
    // it even without an agentType. (Caller is asserting "this is
    // already decomposed enough to act on".)
    const task = store.create("actionable without agent", "Details.", undefined, {
      created_by: "user",
      kind: "actionable",
    });
    expect(task.metadata.kind).toBe("actionable");
  });
});
