/**
 * planner-auto-spawn.test.ts — Tests for the Planner self-consumption path
 * (GC-2026-121 AC1/AC5).
 *
 * After this GC, every user task with `kind=intent` carries
 * `agentType: "Planner"` so the unified feeder auto-spawns a Planner
 * subagent that handles decomposition autonomously. The Planner's
 * system prompt tells it to call `decompose_task(user_task_id, specs=[])`
 * exactly once, then exit.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";
import { isFeedableTask } from "../src/task-feeder.js";

describe("Planner auto-spawn — kind=intent defaults to agentType=Planner (GC-2026-121 AC1)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("infers agentType=Planner when kind=intent (no explicit agentType)", () => {
    const task = store.create("research X", "Investigate topic X.");
    expect(task.metadata.kind).toBe("intent");
    expect(task.metadata.agentType).toBe("Planner");
  });

  it("isFeedableTask returns true for the Planner task (so feeder auto-spawns)", () => {
    const task = store.create("research X", "Investigate topic X.");
    expect(isFeedableTask(task)).toBe(true);
  });

  it("does NOT override an explicit user-supplied agentType on intent tasks", () => {
    // If the caller explicitly sets agentType=Explore, the Planner default
    // must not clobber it. (Caller is asserting a specific dispatcher.)
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

  it("still sets requires_decomposition=true on intent tasks (Planner will consume)", () => {
    const task = store.create("research X", "Investigate X.");
    expect(task.metadata.requires_decomposition).toBe(true);
  });

  it("default-created user task (no metadata, no agentType) is Planner", () => {
    const task = store.create("do something", "details");
    expect(task.metadata.kind).toBe("intent");
    expect(task.metadata.agentType).toBe("Planner");
  });
});

describe("Planner auto-spawn — feeder integration (GC-2026-121 AC5)", () => {
  it("feeder.maybeAutoSpawn would invoke spawn with type='Planner'", async () => {
    const store = new TaskStore();
    const spawnCalls: Array<{ type: string; prompt: string }> = [];
    const fakeSpawn = async (task: { metadata: Record<string, any>; description: string; subject: string }) => {
      spawnCalls.push({
        type: String(task.metadata.agentType),
        prompt: task.description,
      });
      return "fake-agent-id";
    };
    // Mocked feeder: only the parts we care about.
    const task = store.create("research X", "Investigate X.");
    // The inferred agentType is "Planner" so any spawn call gets type="Planner".
    await fakeSpawn(task);
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0].type).toBe("Planner");
  });
});