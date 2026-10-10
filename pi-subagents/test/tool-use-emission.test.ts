/**
 * tool-use-emission.test.ts — GC-2026-subagent-recording-no-budget
 *
 * Unit-level test for the `emitToolUse` helper: every subagent's tool
 * execution goes through this helper, which emits the
 * `subagents:tool-use` event with a stable record shape.
 *
 * The wiring into `agent-runner.ts`'s on-tool-execution handler is
 * integration-tested at the agent-runner level (manually verified in
 * this GC; the test pin is the channel name + the helper's payload
 * contract).
 */

import { describe, expect, it, beforeEach } from "bun:test";

import {
  SUBAGENTS_TOOL_USE,
  emitToolUse,
  type ToolUseRecord,
} from "../src/recording.js";

// ── Test fixtures ─────────────────────────────────────────────────────

class FakeBus {
  emitted: Array<{ channel: string; payload: unknown }> = [];
  emit(channel: string, payload: unknown) {
    this.emitted.push({ channel, payload });
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("emitToolUse", () => {
  let bus: FakeBus;

  beforeEach(() => {
    bus = new FakeBus();
  });

  it("exports the subagents:tool-use channel constant", () => {
    expect(SUBAGENTS_TOOL_USE).toBe("subagents:tool-use");
  });

  it("emits exactly one record per call on SUBAGENTS_TOOL_USE", () => {
    emitToolUse(bus, {
      agentId: "agent-1",
      agentType: "developer",
      taskId: "impl",
      toolName: "read",
      input: { path: "/tmp/x" },
      durationMs: 12,
    });
    expect(bus.emitted.length).toBe(1);
    expect(bus.emitted[0].channel).toBe("subagents:tool-use");
  });

  it("payload shape is the ToolUseRecord contract", () => {
    emitToolUse(bus, {
      agentId: "agent-1",
      agentType: "reviewer",
      taskId: "review-2",
      toolName: "grep",
      input: { pattern: "TODO", path: "/repo" },
      durationMs: 87,
      ts: 1700000000000,
    });
    const payload = bus.emitted[0].payload as ToolUseRecord;
    expect(Object.keys(payload).sort()).toEqual(
      ["agentId", "agentType", "taskId", "toolName", "inputKeys", "durationMs", "ts"].sort(),
    );
    expect(payload.agentId).toBe("agent-1");
    expect(payload.toolName).toBe("grep");
    expect(payload.durationMs).toBe(87);
    expect(payload.ts).toBe(1700000000000);
  });

  it("emits inputKeys sorted (deterministic downstream ordering)", () => {
    emitToolUse(bus, {
      agentId: "a",
      agentType: "developer",
      taskId: "t",
      toolName: "edit",
      input: { z: 1, a: 2, m: 3 },
      durationMs: 5,
    });
    const payload = bus.emitted[0].payload as ToolUseRecord;
    expect(payload.inputKeys).toEqual(["a", "m", "z"]);
  });

  it("never persists input VALUES — keys only", () => {
    emitToolUse(bus, {
      agentId: "a",
      agentType: "developer",
      taskId: "t",
      toolName: "bash",
      input: {
        command: "echo $SUPER_SECRET_TOKEN",
        env: { TOKEN: "sensitive-value" },
      },
      durationMs: 8,
    });
    const payload = bus.emitted[0].payload as ToolUseRecord;
    // Only the key set is captured; values are NEVER included.
    expect(payload.inputKeys).toEqual(["command", "env"]);
    const text = JSON.stringify(payload);
    expect(text).not.toContain("SUPER_SECRET_TOKEN");
    expect(text).not.toContain("sensitive-value");
  });

  it("clamps negative durationMs to zero (defensive)", () => {
    emitToolUse(bus, {
      agentId: "a",
      agentType: "developer",
      taskId: "t",
      toolName: "read",
      input: {},
      durationMs: -7,
    });
    const payload = bus.emitted[0].payload as ToolUseRecord;
    expect(payload.durationMs).toBe(0);
  });

  it("emits empty inputKeys when input is undefined or not an object", () => {
    emitToolUse(bus, {
      agentId: "a",
      agentType: "developer",
      taskId: "t",
      toolName: "noop",
      input: undefined,
      durationMs: 0,
    });
    const payload = bus.emitted[0].payload as ToolUseRecord;
    expect(payload.inputKeys).toEqual([]);
  });

  it("accepts an explicit inputKeys override (e.g. when input is wrapped)", () => {
    emitToolUse(bus, {
      agentId: "a",
      agentType: "developer",
      taskId: "t",
      toolName: "wrapped",
      input: { internal: "ignored" },
      inputKeys: ["user_path", "user_query"],
      durationMs: 1,
    });
    const payload = bus.emitted[0].payload as ToolUseRecord;
    expect(payload.inputKeys).toEqual(["user_path", "user_query"]);
  });

  it("swallows subscriber errors so the tool result delivery is never blocked", () => {
    const bad = {
      emit: () => {
        throw new Error("subscriber boom");
      },
    };
    // Should not throw; should not produce a result that crashes the agent.
    expect(() =>
      emitToolUse(bad, {
        agentId: "a",
        agentType: "developer",
        taskId: "t",
        toolName: "x",
        input: {},
        durationMs: 1,
      }),
    ).not.toThrow();
  });

  it("uses Date.now() when ts is omitted", () => {
    const before = Date.now();
    emitToolUse(bus, {
      agentId: "a",
      agentType: "developer",
      taskId: "t",
      toolName: "x",
      input: {},
      durationMs: 1,
    });
    const after = Date.now();
    const payload = bus.emitted[0].payload as ToolUseRecord;
    expect(payload.ts).toBeGreaterThanOrEqual(before);
    expect(payload.ts).toBeLessThanOrEqual(after);
  });
});
