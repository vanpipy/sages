/**
 * task-kind-inference.test.ts — Unit tests for `kind` inference on TaskStore.create()
 * (GC-2026-120 AC1).
 *
 * The store stamps `metadata.kind` based on `created_by` + `agentType`:
 *   - created_by === "user" && agentType set     → "actionable"
 *   - created_by === "user" && !agentType          → "intent" + requires_decomposition=true
 *   - created_by === "orchestrator"               → "step"
 *
 * Callers may pass `kind` explicitly to override the inference (e.g.
 * orchestrator-task helpers that always stamp "step").
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";

describe("TaskStore.create kind inference (GC-2026-120 AC1)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("infers kind='actionable' for user task with agentType", () => {
    const task = store.create("fix README", "Fix typo.", undefined, {
      created_by: "user",
      agentType: "Developer",
    });
    expect(task.metadata.kind).toBe("actionable");
  });

  it("infers kind='intent' for user task without agentType", () => {
    const task = store.create("research X", "Investigate topic X deeply.");
    expect(task.metadata.kind).toBe("intent");
  });

  it("sets requires_decomposition=true when inferring kind='intent'", () => {
    const task = store.create("research X", "Investigate X.");
    expect(task.metadata.requires_decomposition).toBe(true);
  });

  it("does not set requires_decomposition for kind='actionable'", () => {
    const task = store.create("fix README", "Fix typo.", undefined, {
      created_by: "user",
      agentType: "Developer",
    });
    expect(task.metadata.requires_decomposition).toBeUndefined();
  });

  it("infers kind='step' for orchestrator-created task (created_by='orchestrator')", () => {
    const task = store.create("Step A", "Implement X.", undefined, {
      created_by: "orchestrator",
      agentType: "Developer",
    });
    expect(task.metadata.kind).toBe("step");
  });

  it("infers kind='step' for orchestrator-created task without agentType", () => {
    const task = store.create("Step A", "Implement X.", undefined, {
      created_by: "orchestrator",
    });
    expect(task.metadata.kind).toBe("step");
  });

  it("respects explicit kind override (does not re-infer)", () => {
    const task = store.create("research X", "Investigate X.", undefined, {
      created_by: "user",
      kind: "intent",
    });
    expect(task.metadata.kind).toBe("intent");
  });

  it("does not mutate existing metadata when inferring", () => {
    const task = store.create("research X", "Investigate X.", undefined, {
      created_by: "user",
      workflow_run_goal_id: "GC-2026-test",
    });
    expect(task.metadata.workflow_run_goal_id).toBe("GC-2026-test");
    expect(task.metadata.kind).toBe("intent");
  });

  it("stamps requires_decomposition only when kind=inferring from scratch", () => {
    // Caller passed requires_decomposition=false explicitly — store should not override
    const task = store.create("research X", "Investigate X.", undefined, {
      created_by: "user",
      requires_decomposition: false,
    });
    expect(task.metadata.requires_decomposition).toBe(false);
    expect(task.metadata.kind).toBe("intent");
  });

  it("default user task (no metadata) infers kind='intent'", () => {
    const task = store.create("do something", "details");
    expect(task.metadata.created_by).toBeUndefined();
    expect(task.metadata.kind).toBe("intent");
  });
});