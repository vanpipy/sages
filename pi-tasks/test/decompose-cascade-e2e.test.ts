/**
 * decompose-cascade-e2e.test.ts — End-to-end test for the decomposed-chain
 * cascade listener (GC-2026-task-feeding-and-decomposition AC16).
 *
 * Coverage:
 *   - Materialize a 3-spec chain (T1 + R1 via createOrchestratorTaskWithReview,
 *     T2 + T3 via createOrchestratorTask low-level).
 *   - Register registerDecomposeCascade with a fake spawn RPC that records
 *     invocations and emits `decompose:spawn` (mirroring the production wiring
 *     in pi-tasks/src/index.ts:543-559).
 *   - Drive the cascade: emit subagents:completed for T1 -> T2 spawns ->
 *     T2 completes -> T3 spawns -> T3 completes -> R1 spawns -> R1 completes.
 *   - Assert every spawn was triggered by decompose-cascade.ts. This is
 *     structural: the test does NOT register subscribeWorkflow (workflow-handler)
 *     and does NOT enable cfg.autoCascade (auto-cascade). The only listener
 *     that can spawn in this test is decompose-cascade.ts. (Cf. R6 design
 *     doc.)
 *   - Assert R1's description contains all three chain subjects.
 *
 * The chain runs serially: T2 blockedBy [T1], T3 blockedBy [T2]. R1 is
 * blockedBy [T1] (per createOrchestratorTaskWithReview's wiring). Cascade
 * gate is `created_by === "orchestrator"` + `phase === "decomposition_chain"`.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/types.js";
import {
  createOrchestratorTask,
  createOrchestratorTaskWithReview,
} from "../src/orchestrator-task.js";
import {
  registerDecomposeCascade,
  DECOMPOSE_SPAWN_CHANNEL,
} from "../src/decompose-cascade.js";

interface FakeBus {
  on(channel: string, handler: (data: unknown) => void | Promise<void>): () => void;
  emit(channel: string, data: unknown): Promise<void>;
}

function fakeEvents(): FakeBus & { emitted: Array<{ channel: string; data: unknown }> } {
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
      // Run handlers serially in registration order so cascade is deterministic.
      for (const h of [...set]) {
        await h(data);
      }
    },
  };
}

interface CascadeHarness {
  store: TaskStore;
  events: ReturnType<typeof fakeEvents>;
  spawnCalls: Array<{ task: Task; agentId: string }>;
  unsubscribe: () => void;
}

function setupCascade(): CascadeHarness {
  const store = new TaskStore();
  const events = fakeEvents();
  const spawnCalls: Array<{ task: Task; agentId: string }> = [];
  let counter = 0;

  // Mirrors pi-tasks/src/index.ts:543-559 wiring:
  // - spawn issues the (mock) RPC and emits decompose:spawn so the listener
  //   can register the agentId for cascade tracking.
  const spawn = async (task: Task): Promise<string> => {
    counter += 1;
    const agentId = `agent-stub-${counter}`;
    await events.emit(DECOMPOSE_SPAWN_CHANNEL, { agentId, taskId: task.id });
    spawnCalls.push({ task, agentId });
    return agentId;
  };

  const unsubscribe = registerDecomposeCascade({
    events,
    store,
    spawn,
  });

  return { store, events, spawnCalls, unsubscribe };
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

describe("decompose-cascade e2e (GC-2026-task-feeding-and-decomposition AC16)", () => {
  let harness: CascadeHarness;

  beforeEach(() => {
    harness = setupCascade();
  });

  it("full chain: T1 -> T2 -> T3 -> R1 spawns serially via the cascade listener", async () => {
    const subjects = ["T1 investigate", "T2 apply fix", "T3 verify"];
    const { created, reviewer } = materializeChain(harness.store, subjects);
    const t1 = created[0];
    const t2 = created[1];
    const t3 = created[2];
    const r1 = reviewer!;

    // T1 is top-level (empty blockedBy) so it can be spawned immediately.
    // We mirror what pi-tasks/src/index.ts:552-553 does: emit
    // decompose:spawn for the first task, then mark in_progress.
    await harness.events.emit("decompose:spawn", { agentId: "t1-agent-stub", taskId: t1.id });
    harness.store.update(t1.id, { status: "in_progress", owner: "t1-agent-stub" });

    // T1 completes -> cascade should pick up T2 + R1 in parallel
    await completeTask(harness, "t1-agent-stub");
    expect(harness.spawnCalls).toHaveLength(2); // T2 + R1 spawned

    // Find the agentIds for the cascaded tasks (their order is store-list
    // order, not creation order — keep the lookup explicit).
    const findAgent = (taskId: string): string => {
      const call = harness.spawnCalls.find((c) => c.task.id === taskId);
      if (!call) throw new Error(`no spawn recorded for task ${taskId}`);
      return call.agentId;
    };
    const t2Agent = findAgent(t2.id);
    const r1Agent = findAgent(r1.id);

    // T2 completes -> cascade picks up T3 (R1 still running)
    await completeTask(harness, t2Agent);
    expect(harness.spawnCalls).toHaveLength(3); // T3 spawned

    const t3Agent = findAgent(t3.id);

    // T3 completes -> R1 already running; nothing new
    await completeTask(harness, t3Agent);
    expect(harness.spawnCalls).toHaveLength(3); // no new spawn

    // R1 completes -> chain done; no further spawns
    await completeTask(harness, r1Agent);
    expect(harness.spawnCalls).toHaveLength(3); // still 3

    // Verify spawn order: T1 was manually registered; after T1 completes,
    // T2 + R1 spawn in parallel; after T2 completes, T3 spawns; R1 may
    // already be running.
    //
    // Cascade spawn order is data-driven by blockedBy + status. Manual
    // registration of T1 is not a "spawn" — spawnCalls records only the
    // cascade's spawn() invocations.
    expect(harness.spawnCalls).toHaveLength(3);
    const spawnedIds = harness.spawnCalls.map((c) => c.task.id);
    // Final spawn list (order = store-list iteration order during cascade):
    //   T2 + R1 (spawned together after T1 completes)
    //   T3   (spawned after T2 completes)
    expect(spawnedIds).toContain(t2.id);
    expect(spawnedIds).toContain(t3.id);
    expect(spawnedIds).toContain(r1.id);

    // Final task states
    expect(harness.store.get(t1.id)?.status).toBe("completed");
    expect(harness.store.get(t2.id)?.status).toBe("completed");
    expect(harness.store.get(t3.id)?.status).toBe("completed");
    expect(harness.store.get(r1.id)?.status).toBe("completed");

    // Verify final task states
    expect(harness.store.get(t1.id)?.status).toBe("completed");
    expect(harness.store.get(t2.id)?.status).toBe("completed");
    expect(harness.store.get(t3.id)?.status).toBe("completed");
    expect(harness.store.get(r1.id)?.status).toBe("completed");

    // Cascade guard: verify only decompose-chain tasks were spawned.
    // (workflow-handler + auto-cascade are not registered in this test —
    // any spawn must be from decompose-cascade.)
    const spawnedPhases = harness.spawnCalls.map((c) => c.task.metadata.phase);
    expect(spawnedPhases.every((p) => p === "decomposition_chain")).toBe(true);
  });

  it("R1's description contains all three chain subjects (D7 single Reviewer audits the chain)", async () => {
    const subjects = ["Investigate README", "Fix typo", "Update docs"];
    const { reviewer } = materializeChain(harness.store, subjects);

    // R1's description is built by buildReviewerDescription({kind: "decompose", ...})
    // which lists every chain subject with a numbered prefix.
    expect(reviewer).toBeDefined();
    const desc = reviewer!.description;
    for (const s of subjects) {
      expect(desc).toContain(s);
    }
    expect(desc).toContain("Decompose-chain Review");
    expect(desc).toContain("chain has 3 tasks");
  });

  it("cascade does NOT spawn T2 before T1 completes", async () => {
    const subjects = ["T1", "T2"];
    const { created, reviewer } = materializeChain(harness.store, subjects);
    const t1 = created[0];

    await harness.events.emit("decompose:spawn", { agentId: "t1", taskId: t1.id });
    harness.store.update(t1.id, { status: "in_progress", owner: "t1" });

    // Before completing T1, no other spawns should have happened.
    expect(harness.spawnCalls).toHaveLength(0);

    // After T1 completes, T2 + R1 spawn in parallel (both blockedBy [T1.id]).
    await completeTask(harness, "t1");
    expect(harness.spawnCalls).toHaveLength(2);
    const spawnedSubjects = harness.spawnCalls.map((c) => c.task.subject).sort();
    expect(spawnedSubjects).toEqual(["T2", reviewer!.subject].sort());
  });

  it("subagent failure reverts the task to pending with lastError; no cascade", async () => {
    const subjects = ["T1", "T2"];
    const { created } = materializeChain(harness.store, subjects);
    const t1 = created[0];

    await harness.events.emit("decompose:spawn", { agentId: "t1", taskId: t1.id });
    harness.store.update(t1.id, { status: "in_progress", owner: "t1" });

    // Failure event fires
    await harness.events.emit("subagents:failed", {
      id: "t1",
      error: "boom",
      status: "error",
    });

    // Task reverted to pending; T2 NOT spawned
    expect(harness.store.get(t1.id)?.status).toBe("pending");
    expect(harness.store.get(t1.id)?.metadata.lastError).toBe("boom");
    expect(harness.spawnCalls).toHaveLength(0);
  });

  it("unsubscribe cleanly detaches all three listeners", async () => {
    const subjects = ["T1", "T2"];
    const { created } = materializeChain(harness.store, subjects);
    const t1 = created[0];

    // Register T1 BEFORE unsubscribe (decompose:spawn listener detached too).
    await harness.events.emit("decompose:spawn", { agentId: "t1", taskId: t1.id });
    harness.store.update(t1.id, { status: "in_progress", owner: "t1" });

    // Now unsubscribe — subagents:completed listener detached.
    harness.unsubscribe();

    // After unsubscribe: completing T1 should NOT mark it complete
    // (no listener), and T2 should NOT spawn.
    await harness.events.emit("subagents:completed", { id: "t1", result: "" });

    expect(harness.spawnCalls).toHaveLength(0);
    // T1 stays in_progress because the listener that would mark it
    // complete was unsubscribed.
    expect(harness.store.get(t1.id)?.status).toBe("in_progress");
  });
});