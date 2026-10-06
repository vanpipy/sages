/**
 * TaskExecute spawn boundary must emit SpawnOptions in the schema the receiving
 * subagent extension validates. SpawnOptions (pi-subagents/src/types.ts:328) is
 * snake_case (`max_turns`); TaskExecute's tool input is also snake_case
 * (`pi-tasks/src/index.ts:1108`). The pi-tasks → pi-subagents spawn boundary
 * must translate consistently — a `maxTurns` (camelCase) key would be rejected
 * by the subagent schema as "Unknown spawn option" and TaskExecute would
 * return `Skipped: spawn failed`.
 *
 * Regression guard for GC-2026-pi-tasks-task-execute-spawn-fix.
 *
 * Two paths under test:
 *   1. The initial spawn inside TaskExecute.execute (pi-tasks/src/index.ts:1155).
 *   2. The cascade re-spawn in the subagents:completed listener
 *      (pi-tasks/src/index.ts:272).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { flush, installSubagentsMock, mockCtx, mockPi } from "./helpers/mock-pi.js";

const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

describe("TaskExecute spawn options — snake_case boundary", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(async () => {
    delete process.env.PI_TASKS;
    config.current = { autoCascade: true, taskScope: "memory" };
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    // latestCtx is set by the lifecycle hook — without it the cascade silently
    // no-ops, so every cascade assertion would pass vacuously.
    await mock.fireLifecycle("turn_start", {}, mockCtx());
  });

  afterEach(() => { rpc.unsub(); });

  async function createAgentTask(subject: string) {
    const res = await mock.executeTool("TaskCreate", {
      subject,
      description: `do ${subject}`,
      agentType: "general-purpose",
    });
    return (res.content[0].text.match(/#(\d+)/) as RegExpMatchArray)[1];
  }

  it("emits max_turns (snake_case) on the initial TaskExecute spawn", async () => {
    await createAgentTask("Task A");
    const launch = await mock.executeTool("TaskExecute", { task_ids: ["1"], max_turns: 12 });

    // TaskExecute must have launched, not skipped.
    expect(launch.content[0].text).toContain("Launched 1 agent(s)");
    expect(launch.content[0].text).not.toContain("spawn failed");

    expect(rpc.spawned).toHaveLength(1);
    expect(rpc.spawned[0].options.max_turns).toBe(12);
    // The old, wrong key must not appear — the receiving schema would reject
    // it as "Unknown spawn option".
    expect(rpc.spawned[0].options.maxTurns).toBeUndefined();
  });

  it("propagates max_turns (snake_case) through the completion cascade", async () => {
    await createAgentTask("Task A");
    await createAgentTask("Task B");
    await mock.executeTool("TaskUpdate", { taskId: "2", addBlockedBy: ["1"] });

    await mock.executeTool("TaskExecute", { task_ids: ["1"], max_turns: 9 });
    mock.emitEvent("subagents:completed", { id: "agent-1", result: "done" });
    await flush();

    expect(rpc.spawned).toHaveLength(2);
    // Cascade re-spawn also emits snake_case.
    expect(rpc.spawned[1].options.max_turns).toBe(9);
    expect(rpc.spawned[1].options.maxTurns).toBeUndefined();
  });
});