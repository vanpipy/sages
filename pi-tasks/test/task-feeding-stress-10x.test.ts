/**
 * task-feeding-stress-10x.test.ts — 10-cycle stress verification of
 * task feeding → agent consumption. The user asked for 10 cycles to
 * validate connectivity. We run:
 *
 *   1. 10× TaskCreate (no agentType) → Planner auto-spawn → complete
 *   2. 10× TaskCreate (agentType=Developer) → Developer auto-spawn → complete
 *   3. 10× decompose_task with N=3 specs → chain spawned → each completes
 *   4. 10× late-subagents race: TaskCreate then subagents:ready → sweep re-spawns
 *   5. 10× TaskCreate + TaskExecute (separate spawn path) → complete
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { TASKS_RPC_DECOMPOSE_MATERIALIZE } from "../src/event-channels.js";
import initExtension from "../src/index.js";
import { flush, installSubagentsMock, mockCtx, mockPi } from "./helpers/mock-pi.js";
import { installTasksConfig, uninstallTasksConfig } from "./helpers/tasks-config-fixture.js";

const N_CYCLES = 10;

async function runCycles(name: string, body: (cycle: number) => Promise<void>) {
  for (let cycle = 1; cycle <= N_CYCLES; cycle++) {
    try {
      await body(cycle);
    } catch (err) {
      throw new Error(`cycle ${cycle} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

describe("task-feeding 10x stress verification", () => {
  beforeEach(() => {
    process.env.PI_TASKS = "off";
    installTasksConfig({});
  });

  it("10x: TaskCreate (kind=intent) → IntentPump → LLM TaskUpdate(completed) → complete", async () => {
    // GC-2026-main-agent-proactive-intent-pump replaces the
    // GC-2026-121 Planner auto-spawn. kind=intent now goes through the
    // IntentPump, NOT a subagent. Verify the pump path: no subagent
    // spawn, but the task is in_progress with the pump's synthetic
    // owner, and a simulated LLM TaskUpdate(completed) drives it to
    // completed.
    await runCycles("intent-pump", async (cycle) => {
      const mock = mockPi();
      const rpc = installSubagentsMock(mock.pi);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

      const create = await mock.executeTool("TaskCreate", {
        subject: `intent-${cycle}`,
        description: `Cycle ${cycle} intent task.`,
      });
      const taskId = create.content[0].text.match(/Task #(\d+)/)![1];
      await flush();

      // No subagent spawn — kind=intent goes to the pump
      expect(rpc.spawned.length).toBe(0);

      // Verify task is in_progress with the IntentPump's synthetic owner
      const t1 = await mock.executeTool("TaskGet", { taskId });
      expect(t1.content[0].text).toMatch(/Status: in_progress/);
      expect(t1.content[0].text).toMatch(/Owner: intent-pump:1/);

      // Simulate the LLM's TaskUpdate(completed) (the consumption turn)
      await mock.executeTool("TaskUpdate", { taskId, status: "completed" });
      await flush();
      const t2 = await mock.executeTool("TaskGet", { taskId });
      expect(t2.content[0].text).toMatch(/Status: completed/);

      rpc.unsub();
    });
  });

  it("10x: TaskCreate (agentType=Developer) → Developer auto-spawn → complete", async () => {
    await runCycles("dev-spawn", async (cycle) => {
      const mock = mockPi();
      const rpc = installSubagentsMock(mock.pi);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

      const create = await mock.executeTool("TaskCreate", {
        subject: `dev-${cycle}`,
        description: `Cycle ${cycle} dev task.`,
        agentType: "Developer",
      });
      const taskId = create.content[0].text.match(/Task #(\d+)/)![1];
      await flush();

      expect(rpc.spawned.length).toBe(1);
      expect(rpc.spawned[0].type).toBe("Developer");

      rpc.complete(rpc.spawned[0].id, "Developer done");
      await flush();
      const t = await mock.executeTool("TaskGet", { taskId });
      expect(t.content[0].text).toMatch(/Status: completed/);

      rpc.unsub();
    });
  });

  it("10x: late-subagents race — TaskCreate then subagents:ready → sweep re-spawns", async () => {
    // GC-2026-main-agent-proactive-intent-pump: pass agentType=Developer
    // so the task takes the SUBAGENT path. The IntentPump doesn't
    // depend on subagents:ready at all, so without an explicit
    // agentType the task would be in_progress via the pump and the
    // subagent-availability race wouldn't apply.
    await runCycles("race-sweep", async (cycle) => {
      const mock = mockPi();
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

      // TaskCreate before subagents ready
      const create = await mock.executeTool("TaskCreate", {
        subject: `race-${cycle}`,
        description: `Cycle ${cycle} race task.`,
        agentType: "Developer",
      });
      const taskId = create.content[0].text.match(/Task #(\d+)/)![1];

      // Verify initial failure
      const failed = await mock.executeTool("TaskGet", { taskId });
      expect(failed.content[0].text).toMatch(/Status: pending/);
      expect(failed.content[0].text).toContain("subagents extension unavailable");

      // Now subagents comes online
      const rpc = installSubagentsMock(mock.pi);
      mock.emitEvent("subagents:ready", {});
      await flush();
      await flush(); // extra flush for the async retry sweep

      // Verify sweep re-spawned
      expect(rpc.spawned.length).toBeGreaterThanOrEqual(1);
      const spawn = rpc.spawned[rpc.spawned.length - 1];
      expect(spawn.type).toBe("Developer");

      rpc.complete(spawn.id, "Developer retried");
      await flush();
      const done = await mock.executeTool("TaskGet", { taskId });
      expect(done.content[0].text).toMatch(/Status: completed/);

      rpc.unsub();
    });
  });

  it("10x: decompose_task with N=3 chain → cascade spawns T1, T2, T3 → each completes", async () => {
    for (let cycle = 1; cycle <= N_CYCLES; cycle++) {
      const mock = mockPi();
      const rpc = installSubagentsMock(mock.pi);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

      // Wire the decompose materialize RPC handler (normally in pi-tasks/index.ts)
      // Note: initExtension already registers this listener — just trigger it.
      const requestId = randomUUID();
      const replyChannel = `${TASKS_RPC_DECOMPOSE_MATERIALIZE}:reply:${requestId}`;

      const decomposePromise = new Promise<{ tasks: Array<{ task_id: string; subject: string; reviewer_id: string | undefined; is_top_level: boolean }>; first_task_spawned?: { task_id: string; agent_id: string } }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("decompose timeout")), 5000);
        const unsub = mock.pi.events.on(replyChannel, (data: unknown) => {
          unsub();
          clearTimeout(timer);
          const reply = data as { success: boolean; data?: any; error?: string };
          if (reply.success) resolve(reply.data);
          else reject(new Error(reply.error));
        });
      });

      mock.pi.events.emit(TASKS_RPC_DECOMPOSE_MATERIALIZE, {
        requestId,
        params: {
          specs: [
            { subject: `t1-${cycle}`, description: `Cycle ${cycle} T1 description text` },
            { subject: `t2-${cycle}`, description: `Cycle ${cycle} T2 description text` },
            { subject: `t3-${cycle}`, description: `Cycle ${cycle} T3 description text` },
          ],
        },
      });

      const result = await decomposePromise;
      expect(result.tasks.length).toBe(3);
      expect(result.first_task_spawned).toBeDefined();
      await flush();

      // T1 should have been spawned by the feeder (1 spawn so far)
      expect(rpc.spawned.length).toBeGreaterThanOrEqual(1);

      // Complete T1 → cascade spawns Reviewer (R1 sibling of T1) AND T2.
      // Both are blockedBy T1. Order between them is not guaranteed.
      const t1Agent = result.first_task_spawned!.agent_id;
      rpc.complete(t1Agent, "T1 done");
      await flush();

      // After T1 completes, expect 2 more spawns (Reviewer + T2).
      const typesAfterT1 = rpc.spawned.map((s) => s.type);
      expect(typesAfterT1.filter((t) => t === "Reviewer").length).toBeGreaterThanOrEqual(1);
      expect(typesAfterT1.filter((t) => t === "Developer").length).toBeGreaterThanOrEqual(2);

      // Complete ALL spawned agents (T2, Reviewer, T3 may be there).
      for (const s of rpc.spawned.slice(1)) {
        rpc.complete(s.id, `${s.type} done`);
      }
      await flush();

      // After completing the cascade, expect at least 4 total spawns
      // (T1 + Reviewer + T2 + T3).
      expect(rpc.spawned.length).toBeGreaterThanOrEqual(4);

      rpc.unsub();
    }
  });

  it("10x: TaskCreate then TaskExecute (separate spawn path) — TaskExecute succeeds when blockers satisfied", async () => {
    // Note: with auto-spawn on TaskCreate, TaskExecute is largely a no-op
    // for tasks that have already been spawned. This test verifies that
    // the path is wired correctly and doesn't crash.
    await runCycles("task-execute", async (cycle) => {
      const mock = mockPi();
      const rpc = installSubagentsMock(mock.pi);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

      // Create with explicit agentType (actionable) — auto-spawns on TaskCreate
      const create = await mock.executeTool("TaskCreate", {
        subject: `exec-${cycle}`,
        description: `Cycle ${cycle} exec task.`,
        agentType: "Developer",
      });
      const taskId = create.content[0].text.match(/Task #(\d+)/)![1];
      await flush();

      // Verify first spawn happened
      expect(rpc.spawned.length).toBe(1);
      const agentId = rpc.spawned[0].id;

      // Call TaskExecute on the already-spawned task — feeder's self-gate
      // should prevent a duplicate spawn.
      await mock.executeTool("TaskExecute", { task_ids: [taskId] });
      await flush();

      // Still 1 spawn — feeder's self-gate prevented re-dispatch
      expect(rpc.spawned.length).toBe(1);

      rpc.complete(agentId, "Done");
      await flush();
      const t = await mock.executeTool("TaskGet", { taskId });
      expect(t.content[0].text).toMatch(/Status: completed/);

      rpc.unsub();
    });
  });
});