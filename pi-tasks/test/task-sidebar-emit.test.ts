/**
 * task-sidebar-emit.test.ts — pi-tasks emits `sidebar:event` at the two
 * lifecycle points the Sages sidebar relies on:
 *
 *   1. `TaskExecute` success — `action: 'highlight'` on the plan task
 *      the moment it flips to in_progress and the subagent is spawned.
 *      The sidebar uses this to jump to the active task.
 *   2. `subagents:completed` listener — `action: 'log'` on the plan task
 *      once the agent finishes and the result lands in the store.
 *
 * The fork's `registerSidebarEventTool` already routes these actions to
 * `state.highlightedId` and `state.eventLog`; pi-tasks only owns the
 * emits. See `task-sidebar-emit.test.ts` for the shape contract.
 *
 * Run: `cd pi-tasks && bun test test/task-sidebar-emit.test.ts`
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import initExtension from "../src/index.js";
import { flush, installSubagentsMock, mockPi, type MockEventBus } from "./helpers/mock-pi.js";

beforeEach(() => { process.env.PI_TASKS = "off"; });
afterEach(() => { delete process.env.PI_TASKS; });

interface CapturedSidebarEvent {
  action: string;
  target?: string;
  data?: unknown;
  ts: number;
}

/**
 * Wrap a mock `pi.events` so every `sidebar:event` emit is recorded in
 * `captured`. The mock-pi in helpers/ only routes channel-specific
 * handlers; this wrapper sits alongside it and observes the bus.
 */
function captureSidebarEvents(events: MockEventBus): CapturedSidebarEvent[] {
  const captured: CapturedSidebarEvent[] = [];
  events.on("sidebar:event", (data) => {
    captured.push(data as CapturedSidebarEvent);
  });
  return captured;
}

describe("TaskExecute — sidebar:event emit on execution start", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;
  let sidebarEvents: CapturedSidebarEvent[];

  beforeEach(async () => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    sidebarEvents = captureSidebarEvents(mock.pi.events as MockEventBus);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Implement widget",
      description: "Wire the highlight emit on TaskExecute.",
      activeForm: "Wiring highlight",
      agentType: "general-purpose",
    });
  });

  afterEach(() => { rpc.unsub(); });

  it("emits action:'highlight' on the plan task the moment TaskExecute launches it", async () => {
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    await flush();

    const highlights = sidebarEvents.filter((e) => e.action === "highlight");
    expect(highlights).toHaveLength(1);
    const h = highlights[0];
    expect(h.target).toBe("task-1");
    expect(typeof h.ts).toBe("number");
    expect(h.ts).toBeGreaterThan(0);
    const data = h.data as { agentType: string; subject: string; activeForm?: string };
    expect(data.agentType).toBe("general-purpose");
    expect(data.subject).toBe("Implement widget");
    expect(data.activeForm).toBe("Wiring highlight");
  });

  it("emits one highlight per launched task — multi-task TaskExecute fans out", async () => {
    await mock.executeTool("TaskCreate", {
      subject: "Second task",
      description: "d",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1", "2"] });
    await flush();

    const highlights = sidebarEvents.filter((e) => e.action === "highlight");
    expect(highlights).toHaveLength(2);
    expect(highlights.map((h) => h.target).sort()).toEqual(["task-1", "task-2"]);
  });
});

describe("subagents:completed — sidebar:event emit on completion", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;
  let sidebarEvents: CapturedSidebarEvent[];

  beforeEach(async () => {
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    sidebarEvents = captureSidebarEvents(mock.pi.events as MockEventBus);
    initExtension(mock.pi as any);

    await mock.executeTool("TaskCreate", {
      subject: "Implement runner",
      description: "d",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    await flush();
    sidebarEvents.length = 0; // reset — only the completion emit matters here
  });

  afterEach(() => { rpc.unsub(); });

  it("emits action:'log' on the plan task once the subagent reports completion", async () => {
    rpc.complete("agent-1", "TASK_EXECUTE_AGENT_OK");
    await flush();

    const logs = sidebarEvents.filter((e) => e.action === "log");
    expect(logs).toHaveLength(1);
    const log = logs[0];
    expect(log.target).toBe("task-1");
    expect(typeof log.ts).toBe("number");
    expect(log.ts).toBeGreaterThan(0);
    const data = log.data as { status: string; durationMs?: number; tokens?: unknown };
    expect(data.status).toBe("completed");
  });

  it("does NOT emit a sidebar log row when TaskExecute fails to spawn (silent on the sidebar channel)", async () => {
    rpc.unsub();
    const failing = installSubagentsMock(mock.pi, { spawnError: "boom" });
    try {
      // Re-execute with the failing subagents mock.
      await mock.executeTool("TaskUpdate", { taskId: "1", status: "pending" });
      await mock.executeTool("TaskExecute", { task_ids: ["1"] });
      await flush();

      const logs = sidebarEvents.filter((e) => e.action === "log");
      expect(logs).toHaveLength(0);
    } finally {
      failing.unsub();
    }
  });
});
