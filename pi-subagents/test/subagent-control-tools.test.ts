/**
 * subagent-control-tools.test.ts — GC-2026-boundary-subagent-control
 *
 * Pins the contract that the 4 subagent control tools (subagent_status /
 * steer / abort / resume) are registered by the SAME package that owns the
 * AgentManager singleton. Before this GC the tools lived in
 * `pi-orchestrator/src/subagent-control.ts` and reached the manager via
 * `Symbol.for("pi-subagents:manager")`; after, `pi-subagents/src/index.ts`
 * calls `registerSubagentControlTools(pi, manager)` directly.
 *
 * RED phase: the test must fail before the move (subagent-control-tools.ts
 * does not exist; the index.ts factory does not call it). The test passes
 * after the move when both the file exists and index.ts registers the
 * tools with the same manager that the Agent tool uses.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentManager } from "../src/agent-manager.js";
import {
  registerSubagentControlTools,
  type SubagentControlManager,
} from "../src/subagent-control-tools.js";

// Minimal pi-coding-agent stand-in: just records registered tool names.
// Real pi runtime registers tools; here we model the surface the
// registration function uses.
interface FakePi {
  registered: Map<string, { label: string; execute: (...args: unknown[]) => unknown }>;
  registerTool(tool: { name: string; label: string; execute: (...args: unknown[]) => unknown }): void;
}

function makeFakePi(): FakePi {
  const registered = new Map<string, { label: string; execute: (...args: unknown[]) => unknown }>();
  return {
    registered,
    registerTool(tool) {
      registered.set(tool.name, tool);
    },
  };
}

function makeFakeManager(): SubagentControlManager {
  // The manager interface the 4 tools need is small. Build a real
  // AgentManager with no agents registered so listAgents() returns [].
  const cwd = mkdtempSync(join(tmpdir(), "subagent-control-tools-"));
  writeFileSync(join(cwd, "package.json"), "{}");
  const m = new AgentManager({
    cwd,
    pi: {} as never,
    ctx: { cwd } as never,
    agentsDir: cwd,
  });
  return m as unknown as SubagentControlManager;
}

describe("registerSubagentControlTools (GC-2026-boundary-subagent-control)", () => {
  it("registers all 4 control tools on the pi extension", () => {
    const pi = makeFakePi();
    const manager = makeFakeManager();
    registerSubagentControlTools(pi as never, manager);

    expect(pi.registered.has("subagent_status")).toBe(true);
    expect(pi.registered.has("subagent_steer")).toBe(true);
    expect(pi.registered.has("subagent_abort")).toBe(true);
    expect(pi.registered.has("subagent_resume")).toBe(true);
  });

  it("uses the manager passed in directly (no globalThis lookup)", async () => {
    // The whole point of this GC: the registration function should NOT
    // touch `globalThis[Symbol.for("pi-subagents:manager")]`. We verify
    // by passing a manager whose listAgents() returns a known sentinel
    // and asserting subagent_status echoes that sentinel.
    const pi = makeFakePi();
    const manager = makeFakeManager();

    // Pre-populate the global registry with a DIFFERENT manager. If the
    // tools ever did the global lookup, they'd hit this and the test
    // would catch the boundary violation.
    const SENTINEL_KEY = Symbol.for("pi-subagents:manager");
    const originalEntry = (globalThis as unknown as Record<symbol, unknown>)[SENTINEL_KEY];
    (globalThis as unknown as Record<symbol, unknown>)[SENTINEL_KEY] = {
      listAgents: () => "GLOBAL_REGISTRY_LEAKED",
      steer: () => false,
      abort: () => false,
      resume: async () => undefined,
      getRecord: () => undefined,
      spawn: () => "GLOBAL_REGISTRY_LEAKED",
      waitForAll: async () => undefined,
      hasRunning: () => false,
    };
    try {
      registerSubagentControlTools(pi as never, manager);
      // listAgents on the actual manager is empty — the global entry is
      // poisoned. If the tools read from the global entry, this would
      // throw because listAgents is mocked to return a string.
      const result = (await pi.registered.get("subagent_status")!.execute(
        "call-1",
        { limit: 50, verbose: false },
        undefined,
        undefined,
        { cwd: process.cwd() },
      )) as { details: { ok: boolean; agents: unknown[]; total: number } };
      // executeSubagentStatus is sync internally; toolText wraps the
      // plain JSON payload in content: [{type,text}] + details: <payload>.
      const parsed = result.details;
      expect(parsed.ok).toBe(true);
      expect(parsed.total).toBe(0);
      expect(parsed.agents).toEqual([]);
    } finally {
      if (originalEntry === undefined) {
        delete (globalThis as unknown as Record<symbol, unknown>)[SENTINEL_KEY];
      } else {
        (globalThis as unknown as Record<symbol, unknown>)[SENTINEL_KEY] = originalEntry;
      }
    }
  });

  it("is exported from pi-subagents/src/index.ts so the package's own extension factory wires it", async () => {
    // Verify the export exists; the wiring at index.ts line ~1160 is
    // exercised by the existing extension-via-first-spawn test.
    const indexMod = await import("../src/index.js");
    expect(typeof indexMod.registerSubagentControlTools).toBe("function");
  });
});