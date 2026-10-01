/**
 * task-create-details.test.ts — Pins the TaskCreate details-payload contract.
 *
 * Until GC-2026-pi-tasks-extraction-fix, `textResult` hard-coded
 * `details: undefined`, leaving programmatic callers (e.g.
 * pi-orchestrator/workflow_run's piTasksCreate) to parse the new
 * task ID out of the text body. After the fix the structured
 * `details` carries `{ id, task }` so the runtime wrapper can
 * forward it directly through `AgentToolCallOutcome.result.details`.
 *
 * This test guards the contract so a future `details: undefined`
 * regression can't break the workflow_run pi-tasks integration again.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockCtx, mockPi } from "./helpers/mock-pi.js";

const cfg = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...cfg.current }),
  loadTasksConfig: () => ({ ...cfg.current }),
  saveTasksConfig: () => {},
}));

describe("TaskCreate structured details (programmatic-ID contract)", () => {
  let mock: ReturnType<typeof mockPi>;

  beforeEach(async () => {
    delete process.env.PI_TASKS;
    cfg.current = { taskScope: "memory" };
    mock = mockPi();
    const initExtension = (await import("../src/index.js")).default;
    initExtension(mock.pi as any);
    await mock.fireLifecycle("turn_start", {}, mockCtx());
  });

  it("returns { id, task } on the structured details field", async () => {
    const res = (await mock.executeTool("TaskCreate", {
      subject: "Implement",
      description: "do the thing",
    })) as { content: Array<{ type: "text"; text: string }>; details?: unknown };

    expect(res.details).toBeDefined();
    const d = res.details as { id?: string; task?: { id?: string; subject?: string } };
    expect(d.id).toBe("1");
    expect(d.task?.id).toBe("1");
    expect(d.task?.subject).toBe("Implement");
  });

  it("increments the id across successive creates", async () => {
    const r1 = (await mock.executeTool("TaskCreate", {
      subject: "A",
      description: "a",
    })) as { details: { id: string } };
    const r2 = (await mock.executeTool("TaskCreate", {
      subject: "B",
      description: "b",
    })) as { details: { id: string } };
    const r3 = (await mock.executeTool("TaskCreate", {
      subject: "C",
      description: "c",
    })) as { details: { id: string } };
    expect(r1.details.id).toBe("1");
    expect(r2.details.id).toBe("2");
    expect(r3.details.id).toBe("3");
  });

  it("still surfaces the text content (model-facing payload unchanged)", async () => {
    const res = (await mock.executeTool("TaskCreate", {
      subject: "Visible",
      description: "x",
    })) as { content: Array<{ type: "text"; text: string }>; details?: unknown };
    expect(res.content[0].text).toContain("Task #1 created successfully: Visible");
    // AND the structured details are present too — both transports work.
    expect((res.details as { id: string }).id).toBe("1");
  });
});