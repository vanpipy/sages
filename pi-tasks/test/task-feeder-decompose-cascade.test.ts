/**
 * task-feeder-decompose-cascade.test.ts — Cascade coverage for decompose-chain
 * tasks via the unified task feeder (GC-2026-117).
 *
 * Background:
 *   The pre-cleanup architecture had a dedicated `registerDecomposeCascade`
 *   module that owned its own `agentId → taskId` map + a pair of
 *   `subagents:completed` / `subagents:failed` listeners. After GC-2026-114
 *   FU3 unified every task type through `registerTaskFeeder`, the dedicated
 *   module became dead production code. This test exercises the unified
 *   feeder's handling of decompose-chain tasks directly, so the cascade
 *   contract is covered by the production path.
 *
 * Coverage:
 *   - Materialize a 3-spec chain (T1 + R1 via createOrchestratorTaskWithReview,
 *     T2 + T3 via createOrchestratorTask low-level).
 *   - Wire the feeder with a fake spawn RPC that records invocations.
 *   - Spawn T1 via feeder.maybeAutoSpawn (mirrors pi-tasks/src/index.ts:440).
 *   - Drive the cascade: emit subagents:completed for T1 → T2 + R1 spawn in
 *     parallel → T2 completes → T3 spawns → T3 + R1 complete → chain done.
 *   - Assert every spawn was via the feeder (not a dedicated cascade module —
 *     the test deliberately does NOT call registerDecomposeCascade, which no
 *     longer exists).
 *   - Verify R1's description contains all three chain subjects (D7 single
 *     Reviewer audits the chain).
 *   - Failure path: subagents:failed reverts the failed task to pending with
 *     lastError metadata; no cascade spawn.
 *   - Unsubscribe cleanly detaches the feeder's listeners.
 *
 * The chain runs serially: T2 blockedBy [T1], T3 blockedBy [T2]. R1 is
 * blockedBy [T1] (per createOrchestratorTaskWithReview's wiring).
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/types.js";
import {
  registerTaskFeeder,
  type TaskFeederHandle,
} from "../src/task-feeder.js";
import {
  createOrchestratorTask,
  createOrchestratorTaskWithReview,
} from "../src/orchestrator-task.js";

// ── Fake event bus ──────────────────────────────────────────────────────

interface FakeBus {
  on(channel: string, handler: (data: unknown) => void | Promise<void>): () => void;
  emit(channel: string, data: unknown): Promise<void>;
}

function fakeEvents(): FakeBus {
  const handlers = new Map<string, Set<(data: unknown) => void | Promise<void>>>();
  return {
    on(channel, handler) {
      if (!handlers.has(channel)) handlers.set(channel, new Set());
      handlers.get(channel)!.add(handler);
      return () => {
        handlers.get(channel)!.delete(handler);
      };
    },
    async emit(channel, data) {
      const set = handlers.get(channel);
      if (!set) return;
      // Run handlers serially in registration order so cascade is deterministic.
      for (const h of [...set]) {
        await h(data);
      }
    },
  };
}

// ── Test harness ────────────────────────────────────────────────────────

interface CascadeHarness {
  store: TaskStore;
  events: FakeBus;
  spawnCalls: Array<{ task: Task; agentId: string }>;
  agentTaskMap: Map<string, string>;
  feeder: TaskFeederHandle;
  /** Alias for `feeder.unsubscribe`; useful in afterEach. */
  unsubscribe: () => void;
}

function setupFeederCascade(): CascadeHarness {
  const store = new TaskStore();
  const events = fakeEvents();
  const spawnCalls: Array<{ task: Task; agentId: string }> = [];
  const agentTaskMap = new Map<string, string>();
  let counter = 0;

  const feeder = registerTaskFeeder({
    store,
    events,
    agentTaskMap,
    spawn: async (task: Task): Promise<string> => {
      counter += 1;
      const agentId = `agent-stub-${counter}`;
      spawnCalls.push({ task, agentId });
      return agentId;
    },
  });

  return {
    store,
    events,
    spawnCalls,
    agentTaskMap,
    feeder,
    unsubscribe: feeder.unsubscribe,
  };
}

/** Materialize a 3-spec chain with T1 + R1 wired, T2/T3 chained. */
function materializeChain(store: TaskStore, subjects: string[]) {
  const created: Task[] = [];
  let reviewer: Task | undefined;
  const descs = subjects.map((s) => `${s} description.`);
  for (let i = 0; i < subjects.length; i++) {
    const baseMeta = {
      phase: "decomposition_chain",
      agentType: "Developer",
      created_by: "orchestrator",
    };
    if (i === 0) {
      const out = createOrchestratorTaskWithReview(
        store,
        {
          subject: subjects[i],
          description: descs[i],
          agentType: "Developer",
          blockedBy: [],
          metadata: baseMeta,
        },
        {
          kind: "decompose",
          parentSubject: subjects[i],
          parentDescription: descs[i],
          parentAgentType: "Developer",
          parentIteration: 1,
          chainSubjects: subjects,
          chainDescriptions: descs,
          branch: "",
        },
      );
      created.push(out.task);
      reviewer = out.reviewer;
    } else {
      const task = createOrchestratorTask(store, {
        subject: subjects[i],
        description: descs[i],
        agentType: "Developer",
        blockedBy: [created[i - 1].id],
        metadata: baseMeta,
      });
      created.push(task);
    }
  }
  return { created, reviewer };
}

async function completeTask(harness: CascadeHarness, agentId: string) {
  await harness.events.emit("subagents:completed", { id: agentId, result: "" });
}

async function failTask(
  harness: CascadeHarness,
  agentId: string,
  error: string,
) {
  await harness.events.emit("subagents:failed", {
    id: agentId,
    error,
    status: "error",
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("task-feeder: decompose-chain cascade (replaces GC-2026-117)", () => {
  let harness: CascadeHarness;

  beforeEach(() => {
    harness = setupFeederCascade();
  });
  afterEach(() => harness.unsubscribe());

  it("full chain: T1 → T2 → T3 → R1 spawns serially via the unified feeder", async () => {
    const subjects = ["T1 investigate", "T2 apply fix", "T3 verify"];
    const { created, reviewer } = materializeChain(harness.store, subjects);
    const t1 = created[0];
    const t2 = created[1];
    const t3 = created[2];
    const r1 = reviewer!;

    // Mirror production: feeder.maybeAutoSpawn(T1) since T1 is top-level
    // (empty blockedBy). T1 spawns immediately.
    await harness.feeder.maybeAutoSpawn(t1);
    expect(harness.spawnCalls).toHaveLength(1);
    const t1Agent = harness.spawnCalls[0].agentId;
    expect(harness.store.get(t1.id)?.status).toBe("in_progress");
    expect(harness.store.get(t1.id)?.owner).toBe(t1Agent);

    // T1 completes → feeder cascade walks pending tasks. T2 (blockedBy
    // [T1]) and R1 (blockedBy [T1]) both have satisfied blockers; T3
    // (blockedBy [T2]) does not. Both spawn in parallel.
    await completeTask(harness, t1Agent);
    expect(harness.spawnCalls).toHaveLength(3); // T2 + R1 (T1 was already spawned)

    const findAgent = (taskId: string): string => {
      const call = harness.spawnCalls.find((c) => c.task.id === taskId);
      if (!call) throw new Error(`no spawn recorded for task ${taskId}`);
      return call.agentId;
    };
    const t2Agent = findAgent(t2.id);
    const r1Agent = findAgent(r1.id);

    // T2 completes → cascade picks up T3 (R1 still running, T3 unblocked).
    await completeTask(harness, t2Agent);
    expect(harness.spawnCalls).toHaveLength(4); // + T3

    const t3Agent = findAgent(t3.id);

    // T3 completes → R1 already running; nothing new.
    await completeTask(harness, t3Agent);
    expect(harness.spawnCalls).toHaveLength(4);

    // R1 completes → chain done; no further spawns.
    await completeTask(harness, r1Agent);
    expect(harness.spawnCalls).toHaveLength(4);

    // Final task states
    expect(harness.store.get(t1.id)?.status).toBe("completed");
    expect(harness.store.get(t2.id)?.status).toBe("completed");
    expect(harness.store.get(t3.id)?.status).toBe("completed");
    expect(harness.store.get(r1.id)?.status).toBe("completed");

    // Cascade guard: every spawned task is a decompose-chain task.
    const spawnedPhases = harness.spawnCalls.map((c) => c.task.metadata.phase);
    expect(spawnedPhases.every((p) => p === "decomposition_chain")).toBe(true);

    // agentTaskMap is in sync (no leaked entries).
    expect(harness.agentTaskMap.size).toBe(0);
  });

  it("R1's description contains all three chain subjects (D7 single Reviewer audits the chain)", () => {
    const subjects = ["Investigate README", "Fix typo", "Update docs"];
    const { reviewer } = materializeChain(harness.store, subjects);

    expect(reviewer).toBeDefined();
    const desc = reviewer!.description;
    for (const s of subjects) {
      expect(desc).toContain(s);
    }
    expect(desc).toContain("Decompose-chain Review");
    expect(desc).toContain("chain has 3 tasks");
  });

  it("cascade does NOT spawn T2 or R1 before T1 completes", async () => {
    const subjects = ["T1", "T2"];
    const { created, reviewer } = materializeChain(harness.store, subjects);
    const t1 = created[0];

    await harness.feeder.maybeAutoSpawn(t1);

    // Before completing T1, no other spawns.
    expect(harness.spawnCalls).toHaveLength(1);

    // After T1 completes, T2 + R1 spawn (both blockedBy [T1.id]).
    await completeTask(harness, harness.spawnCalls[0].agentId);
    expect(harness.spawnCalls).toHaveLength(3);
    const spawnedSubjects = harness.spawnCalls.map((c) => c.task.subject).sort();
    // T1's subject + T2 + R1 subject (which starts with "Review T1 (T2)")
    expect(spawnedSubjects).toContain("T1");
    expect(spawnedSubjects).toContain("T2");
    expect(spawnedSubjects).toContain(reviewer!.subject);
  });

  it("subagent failure reverts the task to pending with lastError; no cascade", async () => {
    const subjects = ["T1", "T2"];
    const { created } = materializeChain(harness.store, subjects);
    const t1 = created[0];

    await harness.feeder.maybeAutoSpawn(t1);
    const t1Agent = harness.spawnCalls[0].agentId;

    await failTask(harness, t1Agent, "boom");

    expect(harness.store.get(t1.id)?.status).toBe("pending");
    expect(harness.store.get(t1.id)?.metadata.lastError).toBe("boom");
    // No cascade spawn (T2 still pending, not yet runnable — T1 reverted).
    expect(harness.spawnCalls).toHaveLength(1); // only the initial T1 spawn
    expect(harness.spawnCalls[0].task.id).toBe(t1.id);

    // After retry: completing T1 again should spawn T2.
    await harness.feeder.maybeAutoSpawn(t1);
    expect(harness.spawnCalls).toHaveLength(2);
    expect(harness.store.get(t1.id)?.status).toBe("in_progress");
  });

  it("unsubscribe cleanly detaches subagents:completed + subagents:failed listeners", async () => {
    const subjects = ["T1", "T2"];
    const { created } = materializeChain(harness.store, subjects);
    const t1 = created[0];

    await harness.feeder.maybeAutoSpawn(t1);
    const t1Agent = harness.spawnCalls[0].agentId;

    // Unsubscribe before completing.
    harness.unsubscribe();

    // After unsubscribe: completing T1 should NOT mark it complete (no
    // listener), and T2 should NOT spawn.
    await completeTask(harness, t1Agent);

    expect(harness.spawnCalls).toHaveLength(1); // no new spawns
    // T1 stays in_progress because the listener that would mark it complete
    // was unsubscribed.
    expect(harness.store.get(t1.id)?.status).toBe("in_progress");
  });
});