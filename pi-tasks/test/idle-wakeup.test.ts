/**
 * Idle wake-up: when the LLM ends a turn (text-only response, no tool calls)
 * but the task list still has unfinished work, the orchestrator should be
 * re-engaged via `sendUserMessage` rather than allowed to sit idle.
 *
 * This file pins the regression that motivated GC-2026-wakeup:
 * `~/.pi/agent/sessions/--home-leroy-Project-sages--/2026-10-17T02-44-48-…jsonl`
 * recorded the LLM going idle at idx 146 after a manual takeover that marked
 * task #4 completed. The cascade was supposed to dispatch #5 but couldn't
 * (stale `lastError`), so the LLM sat waiting for a wake-up that never
 * arrived — until a human typed "Continue" 56 s later. The wake-up machinery
 * is what should have re-engaged it inside that window.
 *
 * Pure-decision tests live alongside these — see `reminder-cadence.test.ts`
 * for the `shouldFireIdleWakeUp` invariants that drive the index.ts hook.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import initExtension from "../src/index.js";
import { installSubagentsMock, mockCtx, mockPi } from "./helpers/mock-pi.js";

// `setIdleWakeUpDebounceMs` is a test hook the production code may or may
// not export. The production wake-up behaviour is what we're testing — if
// the hook is absent, skip the wall-clock shortening and run with the full
// 5 s debounce so the test still exercises the real production timer.
const hooks = await import("../src/index.js");
const setIdleWakeUpDebounceMs: ((ms: number) => void) | undefined =
  (hooks as Record<string, unknown>).setIdleWakeUpDebounceMs as
    | ((ms: number) => void)
    | undefined;

// Config is mocked rather than written to <cwd>/.pi/tasks-config.json: writing the
// real file would clobber the user's project settings, and reading it would let the
// developer's global <agentDir>/tasks-config.json leak into the results.
const config = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock("../src/tasks-config.js", () => ({
  loadGlobalTasksConfig: () => ({ ...config.current }),
  loadTasksConfig: () => ({ ...config.current }),
  saveTasksConfig: () => {},
}));

const WAKE_UP_DEBOUNCE_MS = 50; // shorten the debounce so the test runs fast
// Production debounce is 5_000 ms in src/index.ts. Tests override it via the
// exported `setIdleWakeUpDebounceMs` hook so the suite doesn't add 30 s of
// wall-clock for six trivial waits.
const WAKE_UP_TIMEOUT_MS = WAKE_UP_DEBOUNCE_MS + 100;

describe("Idle wake-up (non-empty task list)", () => {
  let mock: ReturnType<typeof mockPi>;
  let rpc: ReturnType<typeof installSubagentsMock>;

  beforeEach(async () => {
    process.env.PI_TASKS = "off";
    config.current = { autoCascade: false, taskScope: "memory" };
    mock = mockPi();
    rpc = installSubagentsMock(mock.pi);
    initExtension(mock.pi as any);
    if (setIdleWakeUpDebounceMs) setIdleWakeUpDebounceMs(WAKE_UP_DEBOUNCE_MS);
    // The turn_end hook reads `latestCtx` lazily; fire turn_start once so the
    // internal hook doesn't fall back to `undefined`. (Without it the hook
    // still runs, but logs a warning — the assertion below is the real check.)
    await mock.fireLifecycle("turn_start", {}, mockCtx());
  });

  afterEach(() => {
    rpc.unsub();
    if (setIdleWakeUpDebounceMs) setIdleWakeUpDebounceMs(5_000); // restore
    delete process.env.PI_TASKS;
  });

  it("sends a wake-up message when the LLM ends a turn with an in_progress task and no live subagent", async () => {
    // One task in_progress (no live subagent), one task pending. The cascade
    // cannot fire on its own (autoCascade=false) and there is no subagent
    // running for the in_progress task, so the only path that re-engages the
    // LLM is the wake-up hook.
    await mock.executeTool("TaskCreate", { subject: "Active work", description: "Doing it" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });
    await mock.executeTool("TaskCreate", { subject: "Pending work", description: "Next up" });

    // Simulate the LLM ending a turn with a text-only response (no tool
    // calls). `end_turn` is the host's signal that the LLM is idle.
    await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("turn_end", {
      message: { role: "assistant", usage: { input: 1, output: 1 }, stopReason: "stop" },
    });

    // Wait past the production debounce window so the wake-up timer fires.
    await new Promise(resolve => setTimeout(resolve, WAKE_UP_TIMEOUT_MS));

    // The wake-up MUST have fired — that's the regression we're pinning.
    expect(mock.pi.sendUserMessage).toHaveBeenCalledTimes(1);
    const [content, options] = mock.pi.sendUserMessage.mock.calls[0];
    expect(content).toMatch(/task list/i);
    expect(options).toEqual({ deliverAs: "followUp" });
  });

  it("does not send a wake-up when the task list is empty", async () => {
    // No tasks — nothing to re-engage for.
    await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("turn_end", {
      message: { role: "assistant", usage: { input: 1, output: 1 }, stopReason: "stop" },
    });

    await new Promise(resolve => setTimeout(resolve, WAKE_UP_TIMEOUT_MS));

    expect(mock.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not send a wake-up when only completed tasks remain", async () => {
    // All completed → the board is settled, the LLM is genuinely done.
    await mock.executeTool("TaskCreate", { subject: "Already done", description: "x" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "completed" });

    await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("turn_end", {
      message: { role: "assistant", usage: { input: 1, output: 1 }, stopReason: "stop" },
    });

    await new Promise(resolve => setTimeout(resolve, WAKE_UP_TIMEOUT_MS));

    expect(mock.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not send a wake-up when the in_progress task still has a live subagent", async () => {
    // An agent-backed task with a live subagent — the agent's completion will
    // fire its own wake-up via the task-notification channel. Adding another
    // wake-up on top would race it.
    await mock.executeTool("TaskCreate", {
      subject: "Subagent work",
      description: "Run it",
      agentType: "general-purpose",
    });
    await mock.executeTool("TaskExecute", { task_ids: ["1"] });
    // Task #1 is now in_progress with a live owner in the agent map.
    expect(rpc.spawned).toHaveLength(1);

    await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("turn_end", {
      message: { role: "assistant", usage: { input: 1, output: 1 }, stopReason: "stop" },
    });

    await new Promise(resolve => setTimeout(resolve, WAKE_UP_TIMEOUT_MS));

    expect(mock.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("does not send a wake-up when the LLM ended the turn with a tool call", async () => {
    // The LLM is mid-work — it just dispatched a tool. Wait for the next turn
    // boundary to decide whether the LLM has actually gone idle.
    await mock.executeTool("TaskCreate", { subject: "Active work", description: "Doing it" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    // `tool_result` resets cadence — the LLM is mid-tool-call, not idle.
    await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("tool_result", { toolName: "read" });

    await new Promise(resolve => setTimeout(resolve, WAKE_UP_TIMEOUT_MS));

    expect(mock.pi.sendUserMessage).not.toHaveBeenCalled();
  });

  it("debounces: a second wake-up inside the debounce window does not fire", async () => {
    // First turn ends with unfinished work → wake-up fires.
    await mock.executeTool("TaskCreate", { subject: "Active work", description: "Doing it" });
    await mock.executeTool("TaskUpdate", { taskId: "1", status: "in_progress" });

    await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("turn_end", {
      message: { role: "assistant", usage: { input: 1, output: 1 }, stopReason: "stop" },
    });

    await new Promise(resolve => setTimeout(resolve, WAKE_UP_TIMEOUT_MS));
    expect(mock.pi.sendUserMessage).toHaveBeenCalledTimes(1);

    // A second turn_end immediately after — should NOT re-fire because the
    // debounce window hasn't elapsed since the last wake-up.
    await mock.fireLifecycle("turn_start", {}, mockCtx());
    await mock.fireLifecycle("turn_end", {
      message: { role: "assistant", usage: { input: 1, output: 1 }, stopReason: "stop" },
    });

    await new Promise(resolve => setTimeout(resolve, WAKE_UP_TIMEOUT_MS));
    expect(mock.pi.sendUserMessage).toHaveBeenCalledTimes(1);
  });
});
