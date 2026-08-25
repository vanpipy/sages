/**
 * sages_reminder tool tests — GC-2026-053
 *
 * Covers:
 *  - Tool registration: registerSagesReminderTool calls pi.registerTool with
 *    name "sages_reminder"
 *  - Valid types: each of the 6 reminder types invokes pi.appendEntry once
 *  - Unknown types: returns error content (no throw), structured details
 *  - Message override: when message is provided, it's used; when omitted,
 *    the default template is used
 *  - dag_id propagation: appears in payload when provided
 *  - Format: output text contains "[sages reminder: TYPE]" prefix
 *  - appendEntry failure: error returned (no throw)
 *  - Payload invariants: text always populated, timestamp is ISO 8601
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerSagesReminderTool,
  SAGES_REMINDER_TYPES,
  formatReminderText,
  buildReminderPayload,
  type SagesReminderInput,
  type SagesReminderType,
} from "@/sages-reminder.js";

interface MockEntry {
  customType: string;
  data: any;
}

interface MockPi {
  tools: Map<string, any>;
  entries: MockEntry[];
  registerTool: (def: any) => void;
  appendEntry: (customType: string, data: any) => void;
  on: (event: string, handler: (...args: any[]) => any) => void;
}

function makeMockPi(): MockPi {
  const tools = new Map<string, any>();
  const entries: MockEntry[] = [];
  return {
    tools,
    entries,
    registerTool(def: any) {
      tools.set(def.name, def);
    },
    appendEntry(customType: string, data: any) {
      entries.push({ customType, data });
    },
    on(_event: string, _handler: (...args: any[]) => any) {
      // orchestrator advisory handler registration — no-op in unit tests that
      // don't exercise the tool_call stream.
    },
  };
}

/** Invoke the tool's execute function with the given params. */
async function invokeTool(
  pi: MockPi,
  params: Record<string, unknown>,
): Promise<any> {
  const tool = pi.tools.get("sages_reminder");
  if (!tool) throw new Error("tool not registered");
  return tool.execute(
    "test-call-id",
    params,
    new AbortController().signal,
    () => {},
    { cwd: "/tmp" },
  );
}

describe("sages_reminder: tool registration (GC-2026-053 T2)", () => {
  it("T-RMD-01: registerSagesReminderTool registers a tool named 'sages_reminder'", () => {
    const pi = makeMockPi();
    registerSagesReminderTool(pi);
    expect(pi.tools.has("sages_reminder")).toBe(true);
  });

  it("T-RMD-02: registered tool has label, description, and parameters", () => {
    const pi = makeMockPi();
    registerSagesReminderTool(pi);
    const tool = pi.tools.get("sages_reminder");
    expect(typeof tool.label).toBe("string");
    expect(tool.label.length).toBeGreaterThan(0);
    expect(typeof tool.description).toBe("string");
    expect(tool.description).toContain("STALE_DAG");
    expect(tool.description).toContain("GENERIC");
    expect(tool.parameters).toBeDefined();
  });

  it("T-RMD-03: tool description lists all 6 types", () => {
    const pi = makeMockPi();
    registerSagesReminderTool(pi);
    const tool = pi.tools.get("sages_reminder");
    for (const t of SAGES_REMINDER_TYPES) {
      expect(tool.description).toContain(t);
    }
  });

  it("T-RMD-04: SAGES_REMINDER_TYPES has exactly 6 entries", () => {
    expect(SAGES_REMINDER_TYPES.length).toBe(6);
    expect(SAGES_REMINDER_TYPES).toEqual([
      "STALE_DAG",
      "MERGE_GATE",
      "COMPLETION_GATE",
      "GOAL_DRIFT",
      "RESUME_REQUIRED",
      "GENERIC",
    ]);
  });
});

describe("sages_reminder: formatReminderText (pure)", () => {
  it("T-FMT-01: prefix is [sages reminder: TYPE]", () => {
    expect(formatReminderText({ type: "STALE_DAG" })).toMatch(
      /^\[sages reminder: STALE_DAG\] /,
    );
  });

  it("T-FMT-02: dag_id appears in the prefix when provided", () => {
    const text = formatReminderText({ type: "STALE_DAG", dag_id: "GC-2026-053" });
    expect(text).toContain("(GC-2026-053)");
    expect(text.startsWith("[sages reminder: STALE_DAG (GC-2026-053)]")).toBe(true);
  });

  it("T-FMT-03: message override replaces the default template", () => {
    const text = formatReminderText({
      type: "STALE_DAG",
      message: "T3 has been stuck for 30 minutes.",
    });
    expect(text).toContain("T3 has been stuck for 30 minutes.");
    expect(text).not.toContain("DAG has not progressed");
  });

  it("T-FMT-04: default template used when message is omitted", () => {
    const text = formatReminderText({ type: "MERGE_GATE" });
    expect(text).toContain("REVISE");
    expect(text).toContain("re-run");
  });

  it("T-FMT-05: every type renders without throwing", () => {
    for (const t of SAGES_REMINDER_TYPES) {
      expect(() => formatReminderText({ type: t })).not.toThrow();
    }
  });

  it("T-FMT-06: GENERIC type uses the fixdirective (no specific command)", () => {
    const text = formatReminderText({ type: "GENERIC" });
    // GENERIC's fixdirective is a meta-instruction (no specific shell
    // command). The default template still serves as fallback.
    expect(text).toContain("no specific fixdirective");
    expect(text).toContain("[sages reminder: GENERIC]");
  });
});

describe("sages_reminder: buildReminderPayload (pure)", () => {
  it("T-PLD-01: payload has type, dag_id, message, timestamp, tool", () => {
    const payload = buildReminderPayload({
      type: "STALE_DAG",
      dag_id: "GC-2026-053",
      message: "test",
    });
    expect(payload.type).toBe("STALE_DAG");
    expect(payload.dag_id).toBe("GC-2026-053");
    expect(payload.message).toBe("test");
    expect(payload.tool).toBe("sages_reminder");
    expect(payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("T-PLD-02: default template fills in when message omitted", () => {
    const payload = buildReminderPayload({ type: "MERGE_GATE" });
    expect(payload.message).toContain("REVISE");
  });

  it("T-PLD-03: timestamp is ISO 8601 (new Date().toISOString())", () => {
    const before = Date.now();
    const payload = buildReminderPayload({ type: "GENERIC" });
    const after = Date.now();
    const ts = new Date(payload.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});

describe("sages_reminder: execute — valid types", () => {
  let pi: MockPi;
  beforeEach(() => {
    pi = makeMockPi();
    registerSagesReminderTool(pi);
  });

  for (const type of SAGES_REMINDER_TYPES) {
    it(`T-EXE-01[${type}]: invokes pi.appendEntry once with customType='system'`, async () => {
      const result = await invokeTool(pi, { type });
      expect(pi.entries.length).toBe(1);
      expect(pi.entries[0].customType).toBe("system");
      expect(pi.entries[0].data.type).toBe(type);
      expect(result.details.status).toBe("ok");
    });

    it(`T-EXE-02[${type}]: payload includes tool='sages_reminder' and ISO timestamp`, async () => {
      await invokeTool(pi, { type });
      const data = pi.entries[0].data;
      expect(data.tool).toBe("sages_reminder");
      expect(data.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it(`T-EXE-03[${type}]: rendered text contains [sages reminder: ${type}]`, async () => {
      const result = await invokeTool(pi, { type });
      expect(result.details.text).toContain(`[sages reminder: ${type}]`);
    });
  }

  it("T-EXE-04: dag_id propagates to payload", async () => {
    await invokeTool(pi, { type: "STALE_DAG", dag_id: "GC-2026-053" });
    expect(pi.entries[0].data.dag_id).toBe("GC-2026-053");
  });

  it("T-EXE-05: message override replaces default template", async () => {
    await invokeTool(pi, {
      type: "STALE_DAG",
      message: "Override text",
    });
    expect(pi.entries[0].data.message).toBe("Override text");
    expect(pi.entries[0].data.text).toContain("Override text");
  });

  it("T-EXE-06: result content is a non-empty text block", async () => {
    const result = await invokeTool(pi, { type: "GENERIC" });
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content.length).toBe(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text.length).toBeGreaterThan(0);
  });

  it("T-EXE-07: payload.text is human-readable, not just the raw type", async () => {
    await invokeTool(pi, { type: "MERGE_GATE" });
    expect(pi.entries[0].data.text).toContain("MERGE_GATE");
    expect(pi.entries[0].data.text.length).toBeGreaterThan(20);
  });
});

describe("sages_reminder: execute — invalid types", () => {
  let pi: MockPi;
  beforeEach(() => {
    pi = makeMockPi();
    registerSagesReminderTool(pi);
  });

  it("T-INV-01: unknown type returns structured error (no throw)", async () => {
    const result = await invokeTool(pi, { type: "BOGUS_TYPE" });
    expect(result.details.status).toBe("error");
    expect(result.details.code).toBe("INVALID_TYPE");
    expect(result.details.received).toBe("BOGUS_TYPE");
    expect(result.details.valid).toEqual(SAGES_REMINDER_TYPES);
    // No appendEntry was called
    expect(pi.entries.length).toBe(0);
  });

  it("T-INV-02: missing type returns invalid-type error", async () => {
    const result = await invokeTool(pi, {});
    expect(result.details.status).toBe("error");
    expect(result.details.code).toBe("INVALID_TYPE");
    expect(pi.entries.length).toBe(0);
  });

  it("T-INV-03: empty-string type returns invalid-type error", async () => {
    const result = await invokeTool(pi, { type: "" });
    expect(result.details.status).toBe("error");
    expect(pi.entries.length).toBe(0);
  });

  it("T-INV-04: error content mentions valid types", async () => {
    const result = await invokeTool(pi, { type: "WRONG" });
    const text = result.content[0].text;
    expect(text).toContain("WRONG");
    for (const t of SAGES_REMINDER_TYPES) {
      expect(text).toContain(t);
    }
  });

  it("T-INV-05: case-sensitivity — lowercase 'stale_dag' is invalid", async () => {
    const result = await invokeTool(pi, { type: "stale_dag" });
    expect(result.details.status).toBe("error");
    expect(pi.entries.length).toBe(0);
  });
});

describe("sages_reminder: execute — appendEntry failure", () => {
  it("T-FAIL-01: appendEntry throwing returns structured error", async () => {
    const pi = makeMockPi();
    // Override appendEntry to throw
    pi.appendEntry = () => {
      throw new Error("session is closed");
    };
    registerSagesReminderTool(pi);
    const result = await invokeTool(pi, { type: "STALE_DAG" });
    expect(result.details.status).toBe("error");
    expect(result.details.code).toBe("APPEND_ENTRY_FAILED");
    expect(result.details.error).toContain("session is closed");
  });

  it("T-FAIL-02: appendEntry throwing does NOT propagate to caller", async () => {
    const pi = makeMockPi();
    pi.appendEntry = () => {
      throw new Error("oops");
    };
    registerSagesReminderTool(pi);
    // Should NOT throw — defensive return
    const result = await invokeTool(pi, { type: "GENERIC" });
    expect(result).toBeDefined();
    expect(result.details.status).toBe("error");
  });
});

describe("sages_reminder: integration with orchestrator index", () => {
  it("T-INT-01: registerOrchestratorTools registers sages_reminder alongside the 4 orchestrator tools", async () => {
    const { registerOrchestratorTools } = await import(
      "@/index.js"
    );
    const pi = makeMockPi();
    registerOrchestratorTools(pi as any);
    expect(pi.tools.has("sages_reminder")).toBe(true);
    expect(pi.tools.has("goal_contract_create")).toBe(true);
    expect(pi.tools.has("dag_synthesize")).toBe(true);
    expect(pi.tools.has("task_dispatch")).toBe(true);
    expect(pi.tools.has("orchestrator_audit")).toBe(true);
  });
});
