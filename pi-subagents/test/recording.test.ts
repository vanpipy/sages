/**
 * recording.test.ts — GC-2026-subagent-recording-no-budget
 *
 * Tests for the post-hoc tool-use recorder. Every tool execution by every
 * subagent is captured to a single JSONL log; this test fixture verifies
 * the file-level semantics (one row per tool execution, append-only,
 * no loss on multiple sessions) without going through the agent-runner.
 *
 * The recording layer has no enforcement — even if the writer fails (disk
 * full / permission denied), the test asserts the failure surfaces on the
 * `subagents:recording-error` event channel so the orchestrator can react
 * without crashing the run.
 */

import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ToolUseRecorder,
  type ToolUseRecord,
  RECORDING_PATH_DEFAULT,
} from "../src/recording.js";

// ── Test fixtures ─────────────────────────────────────────────────────

function makeRow(overrides: Partial<ToolUseRecord> = {}): ToolUseRecord {
  return {
    agentId: "agent-test-1",
    agentType: "developer",
    taskId: "impl",
    toolName: "read",
    inputKeys: ["path"],
    durationMs: 12,
    ts: Date.now(),
    ...overrides,
  };
}

class FakeEventBus {
  emitted: Array<{ channel: string; payload: unknown }> = [];
  emit(channel: string, payload: unknown) {
    this.emitted.push({ channel, payload });
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("ToolUseRecorder", () => {
  let dir: string;
  let jsonlPath: string;
  let recorder: ToolUseRecorder;
  let bus: FakeEventBus;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-subagents-recording-"));
    jsonlPath = join(dir, "subagent-tool-usage.jsonl");
    bus = new FakeEventBus();
    recorder = new ToolUseRecorder({
      jsonlPath,
      events: bus,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends one valid JSONL row per call", async () => {
    await recorder.append(makeRow({ toolName: "read" }));
    await recorder.append(makeRow({ toolName: "grep", agentType: "reviewer" }));
    expect(existsSync(jsonlPath)).toBe(true);
    const text = readFileSync(jsonlPath, "utf-8");
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(2);
    const row1 = JSON.parse(lines[0]) as ToolUseRecord;
    const row2 = JSON.parse(lines[1]) as ToolUseRecord;
    expect(row1.toolName).toBe("read");
    expect(row2.toolName).toBe("grep");
    expect(row2.agentType).toBe("reviewer");
  });

  it("row shape is stable and consumable downstream", async () => {
    await recorder.append(
      makeRow({
        agentId: "agent-x",
        agentType: "reviewer",
        taskId: "review-N",
        toolName: "aft_search",
        inputKeys: ["query", "topK"],
        durationMs: 87,
        ts: 1700000000000,
      }),
    );
    const row = JSON.parse(readFileSync(jsonlPath, "utf-8").trim()) as ToolUseRecord;
    expect(Object.keys(row).sort()).toEqual(
      ["agentId", "agentType", "taskId", "toolName", "inputKeys", "durationMs", "ts"].sort(),
    );
    expect(row.ts).toBe(1700000000000);
  });

  it("auto-creates parent directories when missing", async () => {
    const nestedPath = join(dir, "nested", "deeper", "subagent-tool-usage.jsonl");
    const r = new ToolUseRecorder({ jsonlPath: nestedPath, events: bus });
    await r.append(makeRow());
    expect(existsSync(nestedPath)).toBe(true);
  });

  it("serializes concurrent appends without interleaving rows", async () => {
    // Promise.all of 50 appends; each writes a unique toolName so we can
    // assert no row is corrupted by half-writes from concurrent flushes.
    const ROWS = 50;
    await Promise.all(
      Array.from({ length: ROWS }, (_, i) =>
        recorder.append(makeRow({ toolName: `tool-${String(i).padStart(3, "0")}` })),
      ),
    );
    const text = readFileSync(jsonlPath, "utf-8");
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(ROWS);
    const names = new Set(lines.map((l) => JSON.parse(l).toolName));
    expect(names.size).toBe(ROWS); // no duplicates from corrupted writes
  });

  it("write errors surface on subagents:recording-error channel and do not throw", async () => {
    const r = new ToolUseRecorder({
      jsonlPath: "/nonexistent-readonly/path/should/fail.jsonl",
      events: bus,
    });
    // The append swallows the error and re-emits on the channel.
    await r.append(makeRow());
    expect(bus.emitted.some((e) => e.channel === "subagents:recording-error")).toBe(true);
  });

  it("RECORDING_PATH_DEFAULT points at .pi/orchestrator/metrics/", () => {
    // Loose check: the constant is `.pi/orchestrator/metrics/subagent-tool-usage.jsonl`.
    // The exact prefix matches so downstream tools can derive the path from it.
    expect(RECORDING_PATH_DEFAULT.endsWith("subagent-tool-usage.jsonl")).toBe(true);
    expect(RECORDING_PATH_DEFAULT).toContain(".pi/orchestrator/metrics/");
  });

  it("append preserves ts + identity even if two rows have the same toolName", async () => {
    await recorder.append(makeRow({ ts: 1_700_000_000_001, toolName: "read" }));
    await recorder.append(makeRow({ ts: 1_700_000_000_002, toolName: "read" }));
    const rows = readFileSync(jsonlPath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as ToolUseRecord);
    expect(rows.length).toBe(2);
    expect(rows[0].ts).toBeLessThan(rows[1].ts);
    expect(rows[0].toolName).toBe(rows[1].toolName);
  });
});
