/**
 * task-feeding-end-to-end.test.ts — End-to-end verification of task feeding
 * → agent consumption. Exercises the FULL pipeline:
 *
 *   1. TaskCreate via the registered tool
 *   2. store.create infers kind/agentType (GC-2026-121 AC1: kind=intent → Planner)
 *   3. feeder.maybeAutoSpawn is awaited
 *   4. spawn callback issues subagents:rpc:spawn with type=Planner
 *   5. Mock replies with id; feeder's spawnAndTrack sets task.status=in_progress
 *   6. subagents:completed fires; feeder's listener marks task completed
 *
 * Run in cycles (N=10 by default) to catch intermittent failures (race
 * conditions, timing issues, non-idempotent state).
 *
 * This test reproduces the user-reported bug: "After task creation, the
 * agent doesn't consume the task." If the wiring is correct, every cycle
 * leaves the task consumed (status=completed, owner=agent-N).
 */

import { describe, expect, it, beforeEach } from "bun:test";
import initExtension from "../src/index.js";
import { flush, installSubagentsMock, mockCtx, mockPi } from "./helpers/mock-pi.js";
import { installTasksConfig, uninstallTasksConfig } from "./helpers/tasks-config-fixture.js";

const N_CYCLES = 10;

describe("TaskCreate → feeder → subagent consumption end-to-end", () => {
  beforeEach(() => {
    process.env.PI_TASKS = "off";
    installTasksConfig({});
  });

  it("kind=intent (no agentType) auto-spawns a Planner and consumes it across N cycles", async () => {
    for (let cycle = 1; cycle <= N_CYCLES; cycle++) {
      // Fresh extension per cycle — simulates a clean session boot.
      const mock = mockPi();
      const rpc = installSubagentsMock(mock.pi);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

      // Create a user task WITHOUT agentType. GC-2026-121 AC1: this is a
      // kind=intent task that the store auto-stamps with agentType=Planner.
      const create = await mock.executeTool("TaskCreate", {
        subject: `cycle-${cycle} subject`,
        description: `Cycle ${cycle}: a high-level intent.`,
      });

      // 1. TaskCreate returned a task id
      const text = create.content[0].text;
      const idMatch = text.match(/Task #(\d+) created successfully/);
      expect(idMatch).not.toBeNull();
      const taskId = idMatch![1];

      // 2. The kind=intent hint is surfaced in the response (GC-2026-120 AC1)
      expect(text).toContain("intent task");

      // 3. The feeder has already called subagents:rpc:spawn exactly once.
      //    Allow a flush so any queued listener work completes.
      await flush();
      expect(rpc.spawned.length).toBe(1);
      const spawn = rpc.spawned[0];
      expect(spawn.type).toBe("Planner");
      expect(spawn.prompt).toContain(`Task ID: ${taskId}`);
      expect(spawn.prompt).toContain(`Subject: cycle-${cycle} subject`);

      // 4. The task is in_progress with owner set to the spawned agent.
      const afterSpawn = await mock.executeTool("TaskGet", { taskId });
      expect(afterSpawn.content[0].text).toMatch(/Status: in_progress/);
      expect(afterSpawn.content[0].text).toMatch(/Owner: agent-/);

      // 5. Simulate the Planner subagent completing normally. The feeder's
      //    subagents:completed listener should mark the task completed.
      rpc.complete(spawn.id, "Planner decided specs=[…]");
      await flush();

      const afterComplete = await mock.executeTool("TaskGet", { taskId });
      expect(afterComplete.content[0].text).toMatch(/Status: completed/);

      rpc.unsub();
    }
  });

  it("kind=actionable (with agentType=Developer) auto-spawns Developer and consumes it", async () => {
    for (let cycle = 1; cycle <= N_CYCLES; cycle++) {
      const mock = mockPi();
      const rpc = installSubagentsMock(mock.pi);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

      const create = await mock.executeTool("TaskCreate", {
        subject: `dev-task-${cycle}`,
        description: `Cycle ${cycle}: developer-implementable work.`,
        agentType: "Developer",
      });

      const text = create.content[0].text;
      const idMatch = text.match(/Task #(\d+) created successfully/);
      const taskId = idMatch![1];

      await flush();
      expect(rpc.spawned.length).toBe(1);
      expect(rpc.spawned[0].type).toBe("Developer");

      // Verify task is in_progress with owner set
      const afterSpawn = await mock.executeTool("TaskGet", { taskId });
      expect(afterSpawn.content[0].text).toMatch(/Status: in_progress/);

      // Drive completion
      rpc.complete(rpc.spawned[0].id, "Developer completed");
      await flush();

      const afterComplete = await mock.executeTool("TaskGet", { taskId });
      expect(afterComplete.content[0].text).toMatch(/Status: completed/);

      rpc.unsub();
    }
  });

  it("subagent failure reverts task to pending with lastError (the safety net)", async () => {
    const mock = mockPi();
    const rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

    const create = await mock.executeTool("TaskCreate", {
      subject: "Will fail",
      description: "An intent that the Planner cannot handle.",
    });
    const idMatch = create.content[0].text.match(/Task #(\d+) created successfully/);
    const taskId = idMatch![1];

    await flush();
    expect(rpc.spawned.length).toBe(1);
    const agentId = rpc.spawned[0].id;

    // Planner fails
    rpc.fail(agentId, "could not produce specs", "error");
    await flush();

    const failed = await mock.executeTool("TaskGet", { taskId });
    expect(failed.content[0].text).toMatch(/Status: pending/);
    expect(failed.content[0].text).toContain("could not produce specs");

    rpc.unsub();
  });

  it("TaskCreate → subagent RPC failure surfaces in task metadata (not silently dropped)", async () => {
    const mock = mockPi();
    installSubagentsMock(mock.pi, { spawnError: "spawn RPC refused" });
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

    const create = await mock.executeTool("TaskCreate", {
      subject: "RPC fail",
      description: "Subagent RPC will refuse this.",
      agentType: "Developer",
    });
    const idMatch = create.content[0].text.match(/Task #(\d+) created successfully/);
    const taskId = idMatch![1];

    // TaskCreate must NOT throw — the failure is captured in lastError
    expect(create.content[0].text).toContain(`Task #${taskId} created successfully`);

    // The task is back in pending (spawnAndTrack reverts on throw), with
    // lastError carrying the spawn error so the caller can diagnose.
    const failed = await mock.executeTool("TaskGet", { taskId });
    expect(failed.content[0].text).toMatch(/Status: pending/);
    expect(failed.content[0].text).toContain("spawn RPC refused");
  });
});