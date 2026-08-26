/**
 * GC-2026-053 smoke test — runtime wiring verification
 *
 * This is NOT a unit test. It exercises the actual module wiring that
 * pi's extension loader would use:
 *
 *   1. Register Sages extension on a mock pi runtime
 *   2. Verify all 5 orchestrator tools (4 existing + sages_reminder) are present
 *   3. Drive the Orchestrator advisory injector with synthetic tool-call history that
 *      triggers each of the 5 rules
 *   4. Invoke sages_reminder through the registered tool, observe appendEntry
 *
 * Run: `cd pi && bun test ./test/smoke/gc-2026-053.test.ts`
 *
 * For deployment verification outside the test framework:
 *   bun run ./scripts/smoke-gc-2026-053.ts
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PI_ROOT = join(__dirname, "..", "..");

// ─── Mock pi runtime ────────────────────────────────────────────────────────

interface RegisteredTool {
  name: string;
  description: string;
  label?: string;
  parameters: any;
  execute: (...args: any[]) => Promise<any>;
}

class MockPi {
  tools = new Map<string, RegisteredTool>();
  systemEntries: Array<{ customType: string; data: any }> = [];
  toolCallListeners: Array<(event: any, ctx: any) => any> = [];

  registerTool(def: RegisteredTool) {
    this.tools.set(def.name, def);
  }

  appendEntry(customType: string, data: any) {
    this.systemEntries.push({ customType, data });
  }

  /** Simulate the on("tool_call") event firing for a single tool invocation. */
  fireToolCall(event: { toolName: string; input: any; timestamp: number }) {
    for (const handler of this.toolCallListeners) {
      handler({ toolName: event.toolName, input: event.input }, { cwd: "/tmp" });
    }
  }

  on(event: string, handler: any) {
    if (event === "tool_call") {
      this.toolCallListeners.push(handler);
    }
  }
}

// ─── 1. Extension registration ──────────────────────────────────────────────

describe("GC-2026-053 smoke: extension registration (Step 1)", () => {
  it("SMOKE-1.1: registerOrchestratorTools registers 11 tools (9 from GC-2026-073 + 2 todowrite from GC-2026-074)", async () => {
    const registerOrchestratorTools = (await import("../../src/extension.js")).registerOrchestratorTools;
    const pi = new MockPi();
    registerOrchestratorTools(pi as any);
    const names = [...pi.tools.keys()].sort();
    expect(names).toEqual([
      "dag_synthesize",
      "goal_contract_create",
      "orchestrator_audit",
      "sages_reminder",
      "subagent_abort",
      "subagent_resume",
      "subagent_status",
      "subagent_steer",
      "task_dispatch",
      "todowrite_compile",
      "todowrite_progress",
    ]);
  });

  it("SMOKE-1.2: each tool has label, description, parameters, execute", async () => {
    const registerOrchestratorTools = (await import("../../src/extension.js")).registerOrchestratorTools;
    const pi = new MockPi();
    registerOrchestratorTools(pi as any);
    for (const tool of pi.tools.values()) {
      expect(typeof tool.name).toBe("string");
      expect(typeof tool.label).toBe("string");
      expect(typeof tool.description).toBe("string");
      expect(tool.parameters).toBeDefined();
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("SMOKE-1.3: sages_reminder tool description mentions all 6 types", async () => {
    const registerOrchestratorTools = (await import("../../src/extension.js")).registerOrchestratorTools;
    const pi = new MockPi();
    registerOrchestratorTools(pi as any);
    const t = pi.tools.get("sages_reminder")!;
    for (const ty of ["STALE_DAG", "MERGE_GATE", "COMPLETION_GATE", "GOAL_DRIFT", "RESUME_REQUIRED", "GENERIC"]) {
      expect(t.description).toContain(ty);
    }
  });
});

// ─── 2. orchestrator advisory: detector triggers ──────────────────────────────────────

describe("GC-2026-053 smoke: Orchestrator advisory detector triggers (Step 2)", () => {
  let pi: MockPi;
  beforeEach(async () => {
    pi = new MockPi();
    const ext = await import("../../src/extension.js");
    const registerOrchestratorTools = ext.registerOrchestratorTools;
    registerOrchestratorTools(pi as any);
  });

  function fireSequence(history: Array<{ toolName: string; input: any }>) {
    for (const { toolName, input } of history) {
      pi.fireToolCall({ toolName, input, timestamp: Date.now() });
    }
  }

  it("SMOKE-2.1: dag_synthesize × 3 → dag_resynth_loop advisory", () => {
    fireSequence([
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-053" } },
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-053" } },
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-053" } },
    ]);
    const advisories = pi.systemEntries.filter(
      (e) =>
        e.customType === "system" &&
        ((typeof e.data === "string" && e.data.includes("dag_resynth_loop")) ||
          (typeof e.data === "object" && e.data?.text?.includes("dag_resynth_loop"))),
    );
    expect(advisories.length).toBeGreaterThan(0);
    const advisoryText = typeof advisories[0].data === "string" ? advisories[0].data : advisories[0].data.text;
    expect(advisoryText).toMatch(/\[orchestrator audit advisory/);
  });

  it("SMOKE-2.2: task_dispatch without orchestrator_audit → dispatch_no_audit", () => {
    fireSequence([
      { toolName: "task_dispatch", input: { dag_id: "GC-2026-053" } },
    ]);
    const advisories = pi.systemEntries.filter((e) => {
      if (e.customType !== "system") return false;
      const text = typeof e.data === "string" ? e.data : e.data?.text;
      return typeof text === "string" && text.includes("dispatch_no_audit");
    });
    expect(advisories.length).toBeGreaterThan(0);
  });

  it("SMOKE-2.3: many tool calls without audit AND a chain at length >= 3 → no_progress_no_audit", () => {
    // GC-2026-059: the rule now requires a chain at length >= 3. Use
    // 9 distinct reads + 3 reads of the same path (chain length 3).
    fireSequence([
      ...Array.from({ length: 9 }, (_, i) => ({
        toolName: i % 2 === 0 ? "read" : "bash",
        input: { path: `/tmp/fake-${i}` },
      })),
      { toolName: "read", input: { path: "/tmp/looped.ts" } },
      { toolName: "read", input: { path: "/tmp/looped.ts" } },
      { toolName: "read", input: { path: "/tmp/looped.ts" } },
    ]);
    const advisories = pi.systemEntries.filter((e) => {
      if (e.customType !== "system") return false;
      const text = typeof e.data === "string" ? e.data : e.data?.text;
      return typeof text === "string" && text.includes("no_progress_no_audit");
    });
    expect(advisories.length).toBeGreaterThan(0);
  });

  it("SMOKE-2.4: single well-formed call sequence → no advisories", () => {
    fireSequence([
      { toolName: "goal_contract_create", input: { id: "GC-2026-053" } },
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-053" } },
      { toolName: "orchestrator_audit", input: { dag_id: "DAG-2026-053" } },
    ]);
    const advisories = pi.systemEntries.filter((e) => {
      if (e.customType !== "system") return false;
      const text = typeof e.data === "string" ? e.data : e.data?.text;
      return typeof text === "string" && text.includes("advisory");
    });
    expect(advisories.length).toBe(0);
  });

  it("SMOKE-2.5: advisory budget is per-severity (critical=∞, major=4)", () => {
    // 12 task_dispatch calls fire: dispatch_no_audit (critical) once +
    // no_progress_no_audit (major) once + repeat_call_chain (major) once.
    // Per-severity budget permits 1 critical + 2 major → 3 total.
    fireSequence(
      Array.from({ length: 12 }, () => ({ toolName: "task_dispatch", input: {} })),
    );
    const advisories = pi.systemEntries.filter((e) => {
      if (e.customType !== "system") return false;
      const text = typeof e.data === "string" ? e.data : e.data?.text;
      return typeof text === "string" && text.includes("advisory");
    });
    const critical = advisories.filter((a) => {
      const t = typeof a.data === "string" ? a.data : a.data?.text;
      return typeof t === "string" && /— critical/.test(t);
    });
    const major = advisories.filter((a) => {
      const t = typeof a.data === "string" ? a.data : a.data?.text;
      return typeof t === "string" && /— major/.test(t);
    });
    // Critical cap is ∞ (dedup is the gate); 1 critical = dispatch_no_audit
    // fired once. Major cap is 4; 2 major = no_progress + repeat_chain.
    expect(critical.length).toBeLessThanOrEqual(2);
    expect(major.length).toBeLessThanOrEqual(4);
    expect(advisories.length).toBe(3);
  });

  it("SMOKE-2.6: dedup — same rule doesn't fire twice in one dispatch", () => {
    fireSequence(
      Array.from({ length: 12 }, () => ({ toolName: "task_dispatch", input: {} })),
    );
    const advisories = pi.systemEntries.filter((e) => {
      if (e.customType !== "system") return false;
      const text = typeof e.data === "string" ? e.data : e.data?.text;
      return typeof text === "string" && text.includes("dispatch_no_audit");
    });
    expect(advisories.length).toBe(1);
  });
});

// ─── 3. sages_reminder tool: end-to-end invocation ──────────────────────────

describe("GC-2026-053 smoke: sages_reminder integration (Step 3)", () => {
  let pi: MockPi;
  beforeEach(async () => {
    pi = new MockPi();
    const ext = await import("../../src/extension.js");
    const registerOrchestratorTools = ext.registerOrchestratorTools;
    registerOrchestratorTools(pi as any);
  });

  it("SMOKE-3.1: sages_reminder(SALE_DAG) injects a system entry", async () => {
    const tool = pi.tools.get("sages_reminder")!;
    const result = await tool.execute(
      "call-1",
      { type: "STALE_DAG", dag_id: "GC-2026-053" },
      new AbortController().signal,
      () => {},
      { cwd: "/tmp" },
    );
    expect(result.details.status).toBe("ok");
    expect(pi.systemEntries.length).toBe(1);
    expect(pi.systemEntries[0].customType).toBe("system");
    expect(pi.systemEntries[0].data.type).toBe("STALE_DAG");
    expect(pi.systemEntries[0].data.dag_id).toBe("GC-2026-053");
  });

  it("SMOKE-3.2: message override replaces default template", async () => {
    const tool = pi.tools.get("sages_reminder")!;
    const result = await tool.execute(
      "call-2",
      { type: "MERGE_GATE", message: "Custom: do not merge yet" },
      new AbortController().signal,
      () => {},
      { cwd: "/tmp" },
    );
    expect(result.details.status).toBe("ok");
    expect(pi.systemEntries[0].data.message).toBe("Custom: do not merge yet");
    expect(pi.systemEntries[0].data.text).toContain("Custom: do not merge yet");
  });

  it("SMOKE-3.3: invalid type returns structured error (no throw)", async () => {
    const tool = pi.tools.get("sages_reminder")!;
    const result = await tool.execute(
      "call-3",
      { type: "BOGUS" },
      new AbortController().signal,
      () => {},
      { cwd: "/tmp" },
    );
    expect(result.details.status).toBe("error");
    expect(result.details.code).toBe("INVALID_TYPE");
    expect(pi.systemEntries.length).toBe(0);
  });

  it("SMOKE-3.4: appendEntry failure surfaces as structured error", async () => {
    const failingPi = new MockPi();
    const registerOrchestratorTools = (await import("../../src/extension.js")).registerOrchestratorTools;
    registerOrchestratorTools(failingPi as any);
    // Replace appendEntry with throwing impl
    failingPi.appendEntry = () => {
      throw new Error("session closed");
    };
    const tool = failingPi.tools.get("sages_reminder")!;
    const result = await tool.execute(
      "call-4",
      { type: "GENERIC" },
      new AbortController().signal,
      () => {},
      { cwd: "/tmp" },
    );
    expect(result.details.status).toBe("error");
    expect(result.details.code).toBe("APPEND_ENTRY_FAILED");
    expect(result.details.error).toContain("session closed");
  });

  it("SMOKE-3.5: response.text is human-readable + structured payload is parseable", async () => {
    const tool = pi.tools.get("sages_reminder")!;
    const result = await tool.execute(
      "call-5",
      { type: "RESUME_REQUIRED", dag_id: "GC-2026-053" },
      new AbortController().signal,
      () => {},
      { cwd: "/tmp" },
    );
    expect(result.details.text).toMatch(/\[sages reminder: RESUME_REQUIRED \(GC-2026-053\)\]/);
    const data = pi.systemEntries[0].data;
    expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data.tool).toBe("sages_reminder");
  });
});

describe("GC-2026-053 smoke: end-to-end (Step 5)", () => {
  it("SMOKE-5.1: all 3 reminder channels are reachable via the registered tool", async () => {
    const registerOrchestratorTools = (await import("../../src/extension.js")).registerOrchestratorTools;
    const pi = new MockPi();
    registerOrchestratorTools(pi as any);
    const t = pi.tools.get("sages_reminder")!;

    // Reach each of the 6 reminder types via the registered tool
    const types = ["STALE_DAG", "MERGE_GATE", "COMPLETION_GATE", "GOAL_DRIFT", "RESUME_REQUIRED", "GENERIC"];
    for (const type of types) {
      const result = await t.execute(
        `call-${type}`,
        { type, dag_id: "GC-2026-053" },
        new AbortController().signal,
        () => {},
        { cwd: "/tmp" },
      );
      expect(result.details.status).toBe("ok");
    }
    expect(pi.systemEntries.length).toBe(6);
    const seenTypes = new Set(pi.systemEntries.map((e) => e.data.type));
    expect(seenTypes.size).toBe(6);
  });

  it("SMOKE-5.2: orchestrator advisory and sages_reminder are independent channels", async () => {
    const ext = await import("../../src/extension.js");
    const registerOrchestratorTools = ext.registerOrchestratorTools;
    const pi = new MockPi();
    registerOrchestratorTools(pi as any);

    // Channel A: Orchestrator advisory (auto-fires on tool_call)
    pi.fireToolCall({ toolName: "task_dispatch", input: {}, timestamp: 1 });
    const l1Entries = pi.systemEntries.filter((e) => {
      if (e.customType !== "system") return false;
      const text = typeof e.data === "string" ? e.data : e.data?.text;
      return typeof text === "string" && text.includes("orchestrator audit advisory");
    });

    // Channel B: sages_reminder (explicit LLM call)
    const t = pi.tools.get("sages_reminder")!;
    await t.execute(
      "manual",
      { type: "STALE_DAG", dag_id: "X" },
      new AbortController().signal,
      () => {},
      { cwd: "/tmp" },
    );
    const reminderEntries = pi.systemEntries.filter((e) => {
      const text = typeof e.data === "string" ? e.data : e.data?.text;
      return typeof text === "string" && text.includes("sages reminder");
    });

    expect(l1Entries.length).toBeGreaterThan(0);
    expect(reminderEntries.length).toBe(1);
    const l1Text = typeof l1Entries[0].data === "string" ? l1Entries[0].data : l1Entries[0].data.text;
    const rText = typeof reminderEntries[0].data === "string" ? reminderEntries[0].data : reminderEntries[0].data.text;
    expect(l1Text).not.toBe(rText);
  });
});
