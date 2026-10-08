/**
 * task-feeder.test.ts — Unit tests for the unified task feeder.
 *
 * GC-2026-108: replace the three parallel cascade listeners with a single
 * task-feeder that owns spawn + cascade for ALL task types (workflow,
 * decompose, user, TaskExecute). The feeder exposes:
 *   - isFeedableTask(t) — predicate: !!t.metadata.agentType
 *   - registerTaskFeeder({...}) → { unsubscribe, maybeAutoSpawn }
 *
 * Coverage (~30 cases):
 *   - 5.1 isFeedableTask predicate (3)
 *   - 5.2 maybeAutoSpawn direct call (9)
 *   - 5.3 subagents:completed listener (4)
 *   - 5.4 subagents:failed listener (3)
 *   - 5.5 registration (2)
 *   - 5.6 cross-identity non-interference (3) — covers all three task identities
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/types.js";
import {
  registerTaskFeeder,
  isFeedableTask,
  type TaskFeederHandle,
} from "../src/task-feeder.js";

// ── Fake event bus ─────────────────────────────────────────────────────

interface FakeBus {
  on(channel: string, handler: (data: unknown) => void | Promise<void>): () => void;
  emit(channel: string, data: unknown): Promise<void>;
  emitted: Array<{ channel: string; data: unknown }>;
}

function fakeEvents(): FakeBus {
  const handlers = new Map<string, Set<(data: unknown) => void | Promise<void>>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    emitted,
    on(channel, handler) {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(handler);
      return () => {
        handlers.get(channel)!.delete(handler);
      };
    },
    async emit(channel, data) {
      emitted.push({ channel, data });
      const set = handlers.get(channel);
      if (!set) return;
      // Serial in registration order so cascade is deterministic.
      for (const h of [...set]) {
        await h(data);
      }
    },
  };
}

// ── Test harness ──────────────────────────────────────────────────────

interface Harness {
  store: TaskStore;
  events: FakeBus;
  spawnCalls: Array<{ task: Task; agentId: string }>;
  spawnError: Error | null;
  feeder: TaskFeederHandle;
  agentTaskMap: Map<string, string>;
  /** Alias for `feeder.unsubscribe`; useful in afterEach. */
  unsubscribe: () => void;
}

function setupFeeder(): Harness {
  const store = new TaskStore();
  const events = fakeEvents();
  const spawnCalls: Array<{ task: Task; agentId: string }> = [];
  const agentTaskMap = new Map<string, string>();
  let counter = 0;
  const harness: Harness = {
    store,
    events,
    spawnCalls,
    spawnError: null,
    feeder: undefined as unknown as TaskFeederHandle, // assigned below
    agentTaskMap,
    unsubscribe: () => {},
  } as unknown as Harness;
  // The spawn callback must be the one we record calls against.
  const feeder = registerTaskFeeder({
    store,
    events,
    agentTaskMap,
    spawn: async (task: Task) => {
      if (harness.spawnError) throw harness.spawnError;
      const agentId = `agent-${++counter}`;
      spawnCalls.push({ task, agentId });
      return agentId;
    },
  });
  harness.feeder = feeder;
  harness.unsubscribe = feeder.unsubscribe;
  return harness;
}

function mkTask(
  store: TaskStore,
  overrides: Partial<{
    subject: string;
    description: string;
    agentType: string;
    created_by: string;
    phase: string;
    blockedBy: string[];
    status: "pending" | "in_progress" | "completed";
  }> = {},
): Task {
  // blockedBy and status live on the Task, not in metadata.
  // Create the task with only metadata, then apply structural fields.
  const task = store.create(
    overrides.subject ?? "T",
    overrides.description ?? "D",
    undefined,
    {
      ...(overrides.agentType ? { agentType: overrides.agentType } : {}),
      ...(overrides.created_by ? { created_by: overrides.created_by } : {}),
      ...(overrides.phase ? { phase: overrides.phase } : {}),
    },
  );
  if (overrides.blockedBy && overrides.blockedBy.length > 0) {
    store.update(task.id, { addBlockedBy: overrides.blockedBy });
  }
  if (overrides.status && overrides.status !== "pending") {
    store.update(task.id, { status: overrides.status });
  }
  return store.get(task.id)!;
}

// ──────────────────────────────────────────────────────────────────────
// 5.1 isFeedableTask predicate
// ──────────────────────────────────────────────────────────────────────

describe("task-feeder: isFeedableTask predicate", () => {
  it("returns true when agentType is set (regardless of phase/created_by)", () => {
    const t: Task = {
      id: "1",
      subject: "x",
      description: "y",
      status: "pending",
      metadata: { agentType: "Explore", created_by: "user", phase: "implement" },
      blocks: [],
      blockedBy: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(isFeedableTask(t)).toBe(true);
  });

  it("returns false when agentType is missing", () => {
    const t: Task = {
      id: "1",
      subject: "x",
      description: "y",
      status: "pending",
      metadata: { created_by: "user" },
      blocks: [],
      blockedBy: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(isFeedableTask(t)).toBe(false);
  });

  it("returns false when agentType is empty string", () => {
    const t: Task = {
      id: "1",
      subject: "x",
      description: "y",
      status: "pending",
      metadata: { agentType: "" },
      blocks: [],
      blockedBy: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(isFeedableTask(t)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5.2 maybeAutoSpawn direct call
// ──────────────────────────────────────────────────────────────────────

describe("task-feeder: maybeAutoSpawn direct call", () => {
  let h: Harness;
  beforeEach(() => {
    h = setupFeeder();
  });
  afterEach(() => h.unsubscribe());

  it("calls spawn when predicate matches + no blockers", async () => {
    const t = mkTask(h.store, { agentType: "Explore" });
    await h.feeder.maybeAutoSpawn(t);
    expect(h.spawnCalls.length).toBe(1);
    expect(h.spawnCalls[0].task.id).toBe(t.id);
    const updated = h.store.get(t.id);
    expect(updated?.status).toBe("in_progress");
    expect(updated?.owner).toBe("agent-1");
  });

  it("skips spawn when agentType is missing (raw predicate)", async () => {
    // GC-2026-121: store.create now always stamps agentType=Planner on
    // intent tasks, so this state is unreachable via the store. The pure
    // predicate `isFeedableTask` still rejects raw Task objects with no
    // agentType, so we exercise that path here.
    const rawTask: Task = {
      id: "raw-1",
      subject: "no-type",
      description: "D",
      status: "pending",
      metadata: { created_by: "user" }, // no agentType
      blocks: [],
      blockedBy: [],
      createdAt: 0,
      updatedAt: 0,
    };
    expect(isFeedableTask(rawTask)).toBe(false);
    await h.feeder.maybeAutoSpawn(rawTask);
    expect(h.spawnCalls.length).toBe(0);
  });

  it("skips spawn when blockers are not all completed", async () => {
    const blocker = mkTask(h.store, { agentType: "Explore", status: "pending" });
    const t = mkTask(h.store, { agentType: "Developer", blockedBy: [blocker.id] });
    await h.feeder.maybeAutoSpawn(t);
    expect(h.spawnCalls.length).toBe(0);
    expect(h.store.get(t.id)?.status).toBe("pending");
  });

  it("calls spawn when blockers are all completed", async () => {
    const blocker = mkTask(h.store, { agentType: "Explore", status: "completed" });
    const t = mkTask(h.store, { agentType: "Developer", blockedBy: [blocker.id] });
    await h.feeder.maybeAutoSpawn(t);
    expect(h.spawnCalls.length).toBe(1);
    expect(h.store.get(t.id)?.status).toBe("in_progress");
  });

  it("reverts to pending + lastError on spawn failure (Error instance)", async () => {
    h.spawnError = new Error("unknown agent type: FooBar");
    const t = mkTask(h.store, { agentType: "FooBar" });
    await h.feeder.maybeAutoSpawn(t);
    const updated = h.store.get(t.id);
    expect(updated?.status).toBe("pending");
    expect(updated?.metadata.lastError).toBe("unknown agent type: FooBar");
  });

  it("reverts to pending + lastError on spawn failure (non-Error throw)", async () => {
    h.spawnError = "string-error-not-an-error-object" as unknown as Error;
    const t = mkTask(h.store, { agentType: "FooBar" });
    await h.feeder.maybeAutoSpawn(t);
    const updated = h.store.get(t.id);
    expect(updated?.status).toBe("pending");
    expect(String(updated?.metadata.lastError)).toContain("string-error-not-an-error-object");
  });

  it("idempotent contract: producer must gate on status; second call WILL spawn", async () => {
    const t = mkTask(h.store, { agentType: "Explore" });
    await h.feeder.maybeAutoSpawn(t);
    // After first call, status is in_progress. Second call still spawns
    // (producer is responsible for only calling on pending).
    await h.feeder.maybeAutoSpawn(t);
    expect(h.spawnCalls.length).toBe(2);
  });

  it("fires for workflow task (phase=implement, created_by=orchestrator)", async () => {
    const t = mkTask(h.store, {
      agentType: "Developer",
      phase: "implement",
      created_by: "orchestrator",
    });
    await h.feeder.maybeAutoSpawn(t);
    expect(h.spawnCalls.length).toBe(1);
  });

  it("fires for decompose task (phase=decomposition_chain, created_by=orchestrator)", async () => {
    const t = mkTask(h.store, {
      agentType: "Developer",
      phase: "decomposition_chain",
      created_by: "orchestrator",
    });
    await h.feeder.maybeAutoSpawn(t);
    expect(h.spawnCalls.length).toBe(1);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5.3 subagents:completed listener
// ──────────────────────────────────────────────────────────────────────

describe("task-feeder: subagents:completed listener", () => {
  let h: Harness;
  beforeEach(() => {
    h = setupFeeder();
  });
  afterEach(() => h.unsubscribe());

  it("marks task completed when agentId is in the map", async () => {
    const t = mkTask(h.store, { agentType: "Explore" });
    await h.feeder.maybeAutoSpawn(t);
    await h.events.emit("subagents:completed", { id: "agent-1", result: "ok" });
    const updated = h.store.get(t.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.metadata.result).toBe("ok");
  });

  it("returns early when agentId is NOT in the map (not my task)", async () => {
    const t = mkTask(h.store, { agentType: "Explore" });
    await h.feeder.maybeAutoSpawn(t);
    // Emit a completion for a different agentId
    await h.events.emit("subagents:completed", { id: "stranger-agent", result: "ok" });
    // The original task should NOT be marked completed
    const updated = h.store.get(t.id);
    expect(updated?.status).toBe("in_progress");
  });

  it("cascades eligible dependents (blockedBy all completed) after completion", async () => {
    const t1 = mkTask(h.store, { agentType: "Explore" });
    const t2 = mkTask(h.store, { agentType: "Developer", blockedBy: [t1.id] });
    await h.feeder.maybeAutoSpawn(t1);
    // t2 should not spawn yet (t1 not completed)
    await h.feeder.maybeAutoSpawn(t2);
    expect(h.spawnCalls.length).toBe(1);
    expect(h.spawnCalls[0].task.id).toBe(t1.id);

    // Complete t1
    await h.events.emit("subagents:completed", { id: "agent-1", result: "ok" });

    // t2 should now have been spawned via cascade
    expect(h.spawnCalls.length).toBe(2);
    const t2Call = h.spawnCalls.find((c) => c.task.id === t2.id);
    expect(t2Call).toBeDefined();
    expect(t2Call?.agentId).toBe("agent-2");
    expect(h.store.get(t2.id)?.status).toBe("in_progress");
  });

  it("does NOT cascade dependents with unsatisfied blockers", async () => {
    const blocker = mkTask(h.store, { agentType: "Explore" });
    const t1 = mkTask(h.store, { agentType: "Developer", blockedBy: [blocker.id] });
    const t2 = mkTask(h.store, { agentType: "Developer", blockedBy: [t1.id] });
    await h.feeder.maybeAutoSpawn(t1); // blocked
    await h.feeder.maybeAutoSpawn(t2); // blocked
    expect(h.spawnCalls.length).toBe(0);

    // Complete a stranger agent
    await h.events.emit("subagents:completed", { id: "stranger", result: "x" });
    // No cascade triggered (none of t1, t2 should have spawned)
    expect(h.spawnCalls.length).toBe(0);
  });

  it("F5: cascade only spawns children of the just-completed task (not siblings)", async () => {
    // Topology: T1 → { T2, T3 }, T4 (blockedBy [X] — unrelated to T1)
    // After T1 completes, cascade should spawn T2 + T3 (children of T1)
    // and explicitly NOT consider T4 (T1 is not in T4.blockedBy).
    const x = mkTask(h.store, { agentType: "Explore" });
    const t1 = mkTask(h.store, { agentType: "Explore" });
    const t2 = mkTask(h.store, { agentType: "Developer", blockedBy: [t1.id] });
    const t3 = mkTask(h.store, { agentType: "Developer", blockedBy: [t1.id] });
    const t4 = mkTask(h.store, { agentType: "Developer", blockedBy: [x.id] });

    await h.feeder.maybeAutoSpawn(t1);
    await h.feeder.maybeAutoSpawn(t2); // blocked by T1 (pending)
    await h.feeder.maybeAutoSpawn(t3); // blocked by T1 (pending)
    await h.feeder.maybeAutoSpawn(t4); // blocked by X (pending)
    expect(h.spawnCalls.length).toBe(1); // only T1

    // Complete T1 → cascade should spawn T2 + T3 (children), NOT T4 (not a child)
    await h.events.emit("subagents:completed", { id: "agent-1", result: "ok" });

    const spawnedIds = h.spawnCalls.map((c) => c.task.id).sort();
    expect(spawnedIds).toContain(t2.id);
    expect(spawnedIds).toContain(t3.id);
    expect(spawnedIds).not.toContain(t4.id); // F5: T4 skipped at the children filter
    expect(h.store.get(t4.id)?.status).toBe("pending");
  });

  it("F5: cascade respects multi-parent blockers (only spawns when ALL parents completed)", async () => {
    // T1 + T2 are blockers for T3. Only T1 completes; T3 should NOT spawn
    // because T2 is still pending. The F5 filter on completedTaskId doesn't
    // break the maybeAutoSpawn blocker check.
    const t1 = mkTask(h.store, { agentType: "Explore" });
    const t2 = mkTask(h.store, { agentType: "Explore" });
    const t3 = mkTask(h.store, { agentType: "Developer", blockedBy: [t1.id, t2.id] });

    await h.feeder.maybeAutoSpawn(t1);
    await h.feeder.maybeAutoSpawn(t2);
    await h.feeder.maybeAutoSpawn(t3); // blocked by T1 + T2 (both pending)
    expect(h.spawnCalls.length).toBe(2); // T1 + T2

    // Complete T1 → cascade walks; T3 is in T1's children but blocked by T2 too
    await h.events.emit("subagents:completed", { id: "agent-1", result: "ok" });
    expect(h.spawnCalls.length).toBe(2); // no new spawn
    expect(h.store.get(t3.id)?.status).toBe("pending");

    // Complete T2 → cascade walks; T3 is in T2's children + all blockers met
    await h.events.emit("subagents:completed", { id: "agent-2", result: "ok" });
    expect(h.spawnCalls.length).toBe(3);
    expect(h.spawnCalls[2].task.id).toBe(t3.id);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5.4 subagents:failed listener
// ──────────────────────────────────────────────────────────────────────

describe("task-feeder: subagents:failed listener", () => {
  let h: Harness;
  beforeEach(() => {
    h = setupFeeder();
  });
  afterEach(() => h.unsubscribe());

  it("reverts to pending + lastError on real failure (status=error)", async () => {
    const t = mkTask(h.store, { agentType: "Explore" });
    await h.feeder.maybeAutoSpawn(t);
    await h.events.emit("subagents:failed", {
      id: "agent-1",
      error: "network drop",
      status: "error",
    });
    const updated = h.store.get(t.id);
    expect(updated?.status).toBe("pending");
    expect(updated?.metadata.lastError).toBe("network drop");
    // TaskStore.update deletes a key set to null (per existing convention
    // in pi-tasks/src/index.ts:286 comment). The `result` key is dropped.
    expect(updated?.metadata.result).toBeUndefined();
  });

  it("marks completed + preserves partial result on stopped", async () => {
    const t = mkTask(h.store, { agentType: "Explore" });
    await h.feeder.maybeAutoSpawn(t);
    await h.events.emit("subagents:failed", {
      id: "agent-1",
      result: "partial output",
      status: "stopped",
    });
    const updated = h.store.get(t.id);
    expect(updated?.status).toBe("completed");
    expect(updated?.metadata.result).toBe("partial output");
  });

  it("returns early on failure for stranger agentId", async () => {
    const t = mkTask(h.store, { agentType: "Explore" });
    await h.feeder.maybeAutoSpawn(t);
    await h.events.emit("subagents:failed", {
      id: "stranger",
      error: "x",
      status: "error",
    });
    expect(h.store.get(t.id)?.status).toBe("in_progress");
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5.5 Registration
// ──────────────────────────────────────────────────────────────────────

describe("task-feeder: registration", () => {
  it("unsub detaches all listeners", async () => {
    const h = setupFeeder();
    const t = mkTask(h.store, { agentType: "Explore" });
    await h.feeder.maybeAutoSpawn(t);
    h.unsubscribe();
    // After unsub, emit a completion; should NOT mark the task
    await h.events.emit("subagents:completed", { id: "agent-1", result: "ok" });
    expect(h.store.get(t.id)?.status).toBe("in_progress");
  });

  it("single map ownership: only one feeder can map an agentId at a time", async () => {
    const h = setupFeeder();
    const t = mkTask(h.store, { agentType: "Explore" });
    await h.feeder.maybeAutoSpawn(t);
    // The agentTaskMap inside the feeder now has agent-1 -> t.id.
    // Simulate completion; the feeder's listener should handle it.
    await h.events.emit("subagents:completed", { id: "agent-1", result: "ok" });
    expect(h.store.get(t.id)?.status).toBe("completed");
  });
});

// ──────────────────────────────────────────────────────────────────────
// 5.6 cross-identity non-interference
// ──────────────────────────────────────────────────────────────────────

describe("task-feeder: cross-identity non-interference", () => {
  it("handles user task (no phase, created_by=user)", async () => {
    const h = setupFeeder();
    const t = mkTask(h.store, { agentType: "Explore", created_by: "user" });
    await h.feeder.maybeAutoSpawn(t);
    expect(h.spawnCalls.length).toBe(1);
    h.unsubscribe();
  });

  it("handles workflow task (phase=implement, created_by=orchestrator)", async () => {
    const h = setupFeeder();
    const t = mkTask(h.store, {
      agentType: "Developer",
      phase: "implement",
      created_by: "orchestrator",
    });
    await h.feeder.maybeAutoSpawn(t);
    expect(h.spawnCalls.length).toBe(1);
    h.unsubscribe();
  });

  it("handles decompose task (phase=decomposition_chain, created_by=orchestrator)", async () => {
    const h = setupFeeder();
    const t = mkTask(h.store, {
      agentType: "Developer",
      phase: "decomposition_chain",
      created_by: "orchestrator",
    });
    await h.feeder.maybeAutoSpawn(t);
    expect(h.spawnCalls.length).toBe(1);
    h.unsubscribe();
  });
});
