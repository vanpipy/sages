/**
 * task-feeding-race-conditions.test.ts — Verify the FIXED behavior for
 * the race conditions that cause "task feeding, agent doesn't consume task":
 *
 * Pre-fix bug:
 *   - pi-subagents registers its RPC handlers in session_start, AFTER
 *     pi-tasks's extension factory runs. The first subagents:rpc:ping
 *     fires into the void.
 *   - If TaskCreate runs before subagents:ready fires, the spawn
 *     callback throws "subagents extension unavailable" synchronously.
 *   - The task is reverted to pending with that lastError — but no
 *     retry mechanism picks it up when subagents:ready later fires.
 *
 * Post-fix behavior (GC-2026-fix-pending-spawn-after-ready):
 *   - The spawn callback STILL throws synchronously (fast path).
 *   - When subagents:ready fires, the listener re-pings AND sweeps
 *     pending tasks whose lastError starts with the unavailability
 *     marker, re-spawning each.
 *
 * Run in cycles (N=10 by default) to catch intermittent failures.
 */

import { describe, expect, it, beforeEach } from "bun:test";
import initExtension from "../src/index.js";
import { flush, installSubagentsMock, mockCtx, mockPi } from "./helpers/mock-pi.js";
import { installTasksConfig, uninstallTasksConfig } from "./helpers/tasks-config-fixture.js";

const N_CYCLES = 10;

describe("task feeding race conditions (GC-2026-fix-pending-spawn-after-ready)", () => {
  beforeEach(() => {
    process.env.PI_TASKS = "off";
    installTasksConfig({});
  });

  it("SCENARIO A: TaskCreate before subagents:ready fails fast — task reverts to pending with lastError", async () => {
    // No mock installed. TaskCreate should throw synchronously (fast
    // path) leaving the task in pending with the unavailability marker.
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

    const create = await mock.executeTool("TaskCreate", {
      subject: "Pending intent",
      description: "Created before subagents is ready.",
    });

    const taskId = create.content[0].text.match(/Task #(\d+)/)![1];
    const after = await mock.executeTool("TaskGet", { taskId });
    const taskText = after.content[0].text;

    expect(taskText).toMatch(/Status: pending/);
    expect(taskText).toContain("subagents extension unavailable");
  });

  it("SCENARIO B (FIXED): late subagents:ready retries the pending task via the sweep", async () => {
    for (let cycle = 1; cycle <= N_CYCLES; cycle++) {
      const mock = mockPi();
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

      // TaskCreate before subagents is ready
      const create = await mock.executeTool("TaskCreate", {
        subject: `scenario-B-${cycle}`,
        description: `Cycle ${cycle}: spawn will fail initially, retry sweep picks it up.`,
      });
      const taskId = create.content[0].text.match(/Task #(\d+)/)![1];

      // Confirm the initial failure
      const failed = await mock.executeTool("TaskGet", { taskId });
      expect(failed.content[0].text).toMatch(/Status: pending/);
      expect(failed.content[0].text).toContain("subagents extension unavailable");

      // Now subagents comes online. Install the mock so the re-ping
      // (triggered by subagents:ready) gets answered.
      const rpc = installSubagentsMock(mock.pi);
      mock.emitEvent("subagents:ready", {});
      await flush();
      await flush(); // extra flush for the async retry sweep

      // Verify the retry sweep kicked in.
      expect(rpc.spawned.length).toBeGreaterThanOrEqual(1);
      const spawn = rpc.spawned[rpc.spawned.length - 1];
      expect(spawn.type).toBe("Planner");

      // Drive completion and verify the task is consumed.
      rpc.complete(spawn.id, "Planner succeeded on retry");
      await flush();

      const after = await mock.executeTool("TaskGet", { taskId });
      expect(after.content[0].text).toMatch(/Status: completed/);

      rpc.unsub();
    }
  });

  it("SCENARIO C: multiple pending failed tasks — sweep re-spawns ALL of them", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

    // Create 3 tasks before subagents is ready. Each fails fast.
    for (let i = 1; i <= 3; i++) {
      await mock.executeTool("TaskCreate", {
        subject: `pending-${i}`,
        description: `Pending task ${i} before subagents is ready.`,
      });
    }

    // Install subagents mock and fire ready. Sweep should re-spawn all 3.
    const rpc = installSubagentsMock(mock.pi);
    mock.emitEvent("subagents:ready", {});
    await flush();
    await flush();

    expect(rpc.spawned.length).toBe(3);

    rpc.unsub();
  });

  it("SCENARIO D: sweep only touches tasks with the unavailability marker", async () => {
    const mock = mockPi();
    initExtension(mock.pi as any);
    await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

    // Create a task with a DIFFERENT lastError (manual). The sweep
    // must skip it.
    const create = await mock.executeTool("TaskCreate", {
      subject: "Manual error",
      description: "Pre-existing error, not on the unavailability marker.",
    });
    const taskId = create.content[0].text.match(/Task #(\d+)/)![1];

    // Manually set a different lastError via TaskUpdate.
    await mock.executeTool("TaskUpdate", {
      taskId,
      metadata: { lastError: "Some other failure" },
    });

    // Install subagents mock and fire ready.
    const rpc = installSubagentsMock(mock.pi);
    mock.emitEvent("subagents:ready", {});
    await flush();
    await flush();

    // No spawn should happen — the task's lastError doesn't match the
    // marker.
    expect(rpc.spawned.length).toBe(0);

    rpc.unsub();
  });

  it("SCENARIO E: happy path — subagents ready at boot — TaskCreate spawns on first try", async () => {
    for (let cycle = 1; cycle <= N_CYCLES; cycle++) {
      const mock = mockPi();
      const rpc = installSubagentsMock(mock.pi);
      initExtension(mock.pi as any);
      await mock.fireLifecycle("session_start", { reason: "new" }, mockCtx());

      // Boot ping answered by mock → subagentsAvailable = true.
      // TaskCreate proceeds normally.
      const create = await mock.executeTool("TaskCreate", {
        subject: `happy-${cycle}`,
        description: `Cycle ${cycle}: subagents available from boot.`,
      });
      const taskId = create.content[0].text.match(/Task #(\d+)/)![1];

      await flush();
      expect(rpc.spawned.length).toBe(1);
      expect(rpc.spawned[0].type).toBe("Planner");

      const inProgress = await mock.executeTool("TaskGet", { taskId });
      expect(inProgress.content[0].text).toMatch(/Status: in_progress/);

      rpc.complete(rpc.spawned[0].id, "Done");
      await flush();
      const completed = await mock.executeTool("TaskGet", { taskId });
      expect(completed.content[0].text).toMatch(/Status: completed/);

      rpc.unsub();
    }
  });
});