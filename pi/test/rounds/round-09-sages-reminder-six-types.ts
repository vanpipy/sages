/**
 * Round 9: sages_reminder — 6 types invoke correctly
 *
 * Register the tool. Invoke each of the 6 reminder types. Verify
 * pi.appendEntry is called with the right customType and a payload
 * containing the type, dag_id (where applicable), and a structured
 * reminder text.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  registerSagesReminderTool,
  SAGES_REMINDER_TYPES,
  SAGES_REMINDER_FIXDIRECTIVES,
} from "@/sages-reminder.js";

interface MockEntry { customType: string; data: any }

interface MockPi {
  tools: Map<string, any>;
  entries: MockEntry[];
  registerTool: (def: any) => void;
  appendEntry: (customType: string, data: any) => void;
}

function makeMockPi(): MockPi {
  const tools = new Map<string, any>();
  const entries: MockEntry[] = [];
  return {
    tools,
    entries,
    registerTool(def: any) { tools.set(def.name, def); },
    appendEntry(customType, data) { entries.push({ customType, data }); },
  };
}

async function invoke(pi: MockPi, params: Record<string, unknown>) {
  const tool = pi.tools.get("sages_reminder");
  return tool.execute(
    "test-call-id",
    params,
    new AbortController().signal,
    () => {},
    { cwd: "/tmp" },
  );
}

describe("Round 9: sages_reminder — 6 types invoke correctly", () => {
  let pi: MockPi;
  beforeEach(() => {
    pi = makeMockPi();
    registerSagesReminderTool(pi);
  });

  it("registers 6 reminder types in the schema (SAGES_REMINDER_TYPES)", () => {
    expect(SAGES_REMINDER_TYPES).toEqual([
      "STALE_DAG",
      "MERGE_GATE",
      "COMPLETION_GATE",
      "GOAL_DRIFT",
      "RESUME_REQUIRED",
      "GENERIC",
    ]);
  });

  it("each type has an actionable fix-directive (no prose-only templates)", () => {
    for (const t of SAGES_REMINDER_TYPES) {
      const d = SAGES_REMINDER_FIXDIRECTIVES[t];
      expect(d).toBeDefined();
      // GENERIC is a meta-instruction; other 5 types must have a shell command.
      if (t === "GENERIC") {
        // GENERIC is allowed to be a meta-instruction (no specific command).
        expect(d.length).toBeGreaterThan(20);
        continue;
      }
      // Actionable = shell command (backticks) or imperative verb
      const hasCommand = d.includes("`");
      const hasVerb = /\b(run|check|verify|re-run|cat|ls|grep|git)\b/i.test(d);
      expect(hasCommand || hasVerb).toBe(true);
    }
  });

  for (const type of SAGES_REMINDER_TYPES) {
    it(`STALE_DAG/${type} (well-formed invocation) → success result + system entry`, async () => {
      const result = await invoke(pi, { type, dag_id: "GC-2026-TEST" });
      expect(result.details.status).toBe("ok");
      expect(pi.entries.length).toBe(1);
      expect(pi.entries[0].customType).toBe("system");
      expect(pi.entries[0].data.type).toBe(type);
      expect(pi.entries[0].data.dag_id).toBe("GC-2026-TEST");
      expect(pi.entries[0].data.tool).toBe("sages_reminder");
      expect(pi.entries[0].data.text).toContain(`[sages reminder: ${type}`);
    });
  }

  it("message override replaces the fix-directive", async () => {
    await invoke(pi, { type: "STALE_DAG", dag_id: "X", message: "Custom override" });
    expect(pi.entries[0].data.text).toContain("Custom override");
    expect(pi.entries[0].data.text).not.toContain(SAGES_REMINDER_FIXDIRECTIVES.STALE_DAG.slice(0, 30));
  });

  it("invalid type returns structured error (no throw)", async () => {
    const result = await invoke(pi, { type: "BOGUS" });
    expect(result.details.status).toBe("error");
    expect(result.details.code).toBe("INVALID_TYPE");
    expect(pi.entries.length).toBe(0);
  });
});