/**
 * GC-2026-073 smoke test — session-hooks wiring (post-conductor absorption)
 *
 * Verifies that the orchestrator's `extension.ts` default export wires
 * the three session-level hooks that used to live in the now-retired
 * `@sages/pi` conductor:
 *
 *   1. `session_start`        — `pi.setActiveTools([...])` + `pi.setStatus(...)`
 *   2. `before_agent_start`   — prepends `templates/SYSTEM.md` overlay
 *   3. `tool_call`            — fires `pi.appendEntry("system", SOFT_MODE_REMINDER)`
 *                              once per session on the first `bash` call
 *
 * Self-contained MockPi (no real pi runtime). Run:
 *   cd pi-orchestrator && bun test ./test/smoke/gc-2026-073.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PI_ORCH_ROOT = join(__dirname, "..", "..");

// ─── Mock pi runtime ────────────────────────────────────────────────────────

class MockPi {
  tools = new Map<string, { name: string; description: string; label?: string; parameters: any; execute: any }>();
  systemEntries: Array<{ customType: string; data: any }> = [];
  toolCallListeners: Array<(event: any, ctx: any) => any> = [];
  beforeAgentStartListeners: Array<(event: any, ctx: any) => any> = [];
  sessionStartListeners: Array<(event: any, ctx: any) => any> = [];

  // New session-hook surfaces (GC-2026-073)
  setActiveToolsCalls: string[][] = [];
  setStatusCalls: Array<{ id: string; text: string }> = [];
  activeTools: string[] | null = null;

  registerTool(def: any) {
    this.tools.set(def.name, def);
  }

  appendEntry(customType: string, data: any) {
    this.systemEntries.push({ customType, data });
  }

  setActiveTools(tools: string[]): void {
    this.activeTools = tools;
    this.setActiveToolsCalls.push(tools);
  }

  getActiveTools(): string[] {
    return this.activeTools ?? [];
  }

  // pi.setStatus is part of the ExtensionAPI surface — exposed as
  // a top-level method (matches reference ExtensionAPI shape).
  setStatus(id: string, text: string): void {
    this.setStatusCalls.push({ id, text });
  }

  on(event: string, handler: any): void {
    if (event === "tool_call") this.toolCallListeners.push(handler);
    else if (event === "before_agent_start") this.beforeAgentStartListeners.push(handler);
    else if (event === "session_start") this.sessionStartListeners.push(handler);
  }

  fireSessionStart(event: any = {}) {
    for (const h of this.sessionStartListeners) h(event, {});
  }

  fireBeforeAgentStart(event: any) {
    let result = event;
    for (const h of this.beforeAgentStartListeners) {
      const r = h(result, {});
      if (r) result = r;
    }
    return result;
  }

  fireToolCall(event: { toolName: string; input: any; timestamp?: number }) {
    for (const h of this.toolCallListeners) h({ toolName: event.toolName, input: event.input }, {});
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("GC-2026-073 smoke: orchestrator extension.ts default export", () => {
  let pi: MockPi;

  beforeEach(() => {
    pi = new MockPi();
  });

  it("SMOKE-073-1: default export registers 11 orchestrator tools (9 from GC-2026-073 + 2 todowrite from GC-2026-074)", async () => {
    const ext = await import("../../src/extension.js");
    expect(typeof ext.default).toBe("function");
    ext.default(pi as any);
    const toolNames = [...pi.tools.keys()].sort();
    expect(toolNames).toEqual([
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

  it("SMOKE-073-2: session_start calls setActiveTools with orchestrator + subagent + baseline tools", async () => {
    const ext = await import("../../src/extension.js");
    ext.default(pi as any);
    pi.fireSessionStart();
    expect(pi.setActiveToolsCalls.length).toBe(1);
    const tools = pi.setActiveToolsCalls[0].sort();
    expect(tools).toContain("goal_contract_create");
    expect(tools).toContain("dag_synthesize");
    expect(tools).toContain("task_dispatch");
    expect(tools).toContain("orchestrator_audit");
    expect(tools).toContain("sages_reminder");
    expect(tools).toContain("Agent");
    expect(tools).toContain("get_subagent_result");
    expect(tools).toContain("steer_subagent");
    expect(tools).toContain("bash");
    expect(tools).toContain("read");
    expect(tools).toContain("edit");
    expect(tools).toContain("write");
  });

  it("SMOKE-073-3: session_start calls setStatus with the orchestrator banner", async () => {
    const ext = await import("../../src/extension.js");
    ext.default(pi as any);
    pi.fireSessionStart();
    expect(pi.setStatusCalls.length).toBe(1);
    expect(pi.setStatusCalls[0].id).toBe("sages-orchestrator");
    expect(pi.setStatusCalls[0].text).toMatch(/orchestrator active/);
  });

  it("SMOKE-073-4: before_agent_start prepends templates/SYSTEM.md to systemPrompt", async () => {
    const ext = await import("../../src/extension.js");
    ext.default(pi as any);
    // Confirm the template exists at the expected location
    const templatePath = join(PI_ORCH_ROOT, "templates", "SYSTEM.md");
    expect(existsSync(templatePath)).toBe(true);
    const result = pi.fireBeforeAgentStart({ systemPrompt: "USER_PROMPT" });
    expect(result.systemPrompt).toContain("USER_PROMPT");
    // The overlay should mention orchestrator content (constitution)
    expect(result.systemPrompt).toMatch(/orchestrator|Soft mode|4-stage DAG/i);
  });

  it("SMOKE-073-5: first bash tool_call fires the soft-mode reminder via appendEntry", async () => {
    const ext = await import("../../src/extension.js");
    ext.default(pi as any);
    // GC-2026-087 SC2: use `echo` instead of `ls -la` so the new
    // codebase-search-nudge (which fires on `ls` / `tree` against source
    // paths) doesn't add a second system entry. The soft-mode reminder
    // is the only nudge that should fire here.
    pi.fireToolCall({ toolName: "bash", input: { command: "echo hello" } });
    expect(pi.systemEntries.length).toBe(1);
    expect(pi.systemEntries[0].customType).toBe("system");
    const data = pi.systemEntries[0].data;
    const text = typeof data === "string" ? data : data?.text;
    expect(typeof text).toBe("string");
    expect(text).toMatch(/SOFT MODE/);
    expect(text).toMatch(/subagent dispatch/i);
  });

  it("SMOKE-073-6: soft-mode reminder fires only once per session (subsequent bash → no new entry)", async () => {
    const ext = await import("../../src/extension.js");
    ext.default(pi as any);
    // GC-2026-087 SC2: use `echo` instead of `ls` / `cat foo.ts` / `rm foo.ts`
    // so the new nudges (codebase-search / ctx-search / aft-search) don't
    // add system entries. The smoke test asserts ONLY that the soft-mode
    // reminder is rate-limited per session; other nudges are out of scope.
    pi.fireToolCall({ toolName: "bash", input: { command: "echo one" } });
    pi.fireToolCall({ toolName: "bash", input: { command: "echo two" } });
    pi.fireToolCall({ toolName: "bash", input: { command: "echo three" } });
    expect(pi.systemEntries.length).toBe(1);
  });

  it("SMOKE-073-7: non-bash tool_call does NOT trigger the reminder", async () => {
    const ext = await import("../../src/extension.js");
    ext.default(pi as any);
    pi.fireToolCall({ toolName: "read", input: { path: "foo.ts" } });
    pi.fireToolCall({ toolName: "edit", input: { path: "foo.ts" } });
    expect(pi.systemEntries.length).toBe(0);
    // The reminder fires once we hit bash
    pi.fireToolCall({ toolName: "bash", input: { command: "echo x" } });
    expect(pi.systemEntries.length).toBe(1);
  });
});
