/**
 * Round 10: routine auto-install — idempotent
 *
 * Run installSagesRoutines() against a temp state file. Verify the
 * 3 routines are inserted. Re-run. Verify idempotent (skipped, not
 * overwritten). Verify a user-added routine survives the install.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseInterval,
  transformTemplate,
  installSagesRoutines,
} from "@/tools/routines/sages-routines-install.js";

let tmpDir: string;
let templatesDir: string;
let statePath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sages-routines-round-"));
  templatesDir = join(tmpDir, "templates");
  statePath = join(tmpDir, "state.json");
  require("node:fs").mkdirSync(templatesDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeTemplate(name: string, content: string) {
  writeFileSync(join(templatesDir, `${name}.json`), content, "utf-8");
}

function minimalHookTemplate(name: string, event: string, once: string) {
  return JSON.stringify({
    name,
    trigger: { kind: "hook", event, once },
    prompt: "test prompt",
    quiet: true,
  });
}

function minimalPulseTemplate(name: string, interval: string, maxTicks?: number) {
  return JSON.stringify({
    name,
    trigger: { kind: "pulse", interval },
    prompt: "test prompt",
    quiet: true,
    maxTicks,
  });
}

describe("Round 10: routine auto-install — idempotent", () => {
  it("parseInterval handles 5m, 30s, 1h boundaries", () => {
    expect(parseInterval("5m").ms).toBe(300_000);
    expect(parseInterval("30s").ms).toBe(30_000);
    expect(parseInterval("1h").ms).toBe(3_600_000);
    expect(() => parseInterval("29s")).toThrow();
    expect(() => parseInterval("25h")).toThrow();
  });

  it("transformTemplate converts hook + pulse correctly", () => {
    const hook = transformTemplate(JSON.parse(minimalHookTemplate("t1", "session_start", "daily")));
    expect(hook.triggers[0]).toEqual({ kind: "hook", event: "session_start", once: "daily" });
    expect(hook.quiet).toBe(true);

    const pulse = transformTemplate(JSON.parse(minimalPulseTemplate("t2", "5m", 14400)));
    expect(pulse.triggers[0]).toEqual({ kind: "pulse", intervalMs: 300_000, intervalHuman: "5m" });
    expect(pulse.maxTicks).toBe(14400);
  });

  it("installSagesRoutines: 3 templates → 3 installed; idempotent on re-run", () => {
    writeTemplate("sages-session-wrap", minimalHookTemplate("sages-session-wrap", "session_shutdown", "per_session"));
    writeTemplate("sages-resume", minimalHookTemplate("sages-resume", "session_start", "daily"));
    writeTemplate("sages-watchdog", minimalPulseTemplate("sages-watchdog", "5m", 14400));

    // First install
    const r1 = installSagesRoutines(templatesDir, statePath);
    expect(r1.installed.length).toBe(3);
    expect(r1.installed.sort()).toEqual(["sages-resume", "sages-session-wrap", "sages-watchdog"]);
    expect(r1.skipped).toEqual([]);
    expect(r1.errors).toEqual([]);

    // Verify state file has the 3 routines
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(Object.keys(state.routines).length).toBe(3);

    // Re-run — should be a no-op
    const r2 = installSagesRoutines(templatesDir, statePath);
    expect(r2.installed).toEqual([]);
    expect(r2.skipped.length).toBe(3);
    expect(r2.errors).toEqual([]);

    // Verify state unchanged
    const state2 = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(Object.keys(state2.routines).length).toBe(3);
  });

  it("preserves user-added routines across re-runs", () => {
    writeTemplate("sages-session-wrap", minimalHookTemplate("sages-session-wrap", "session_shutdown", "per_session"));

    // Pre-populate with a user routine
    const userState = {
      schemaVersion: 3,
      routines: {
        user_routine_a: {
          id: "user_routine_a",
          name: "user-routine-a",
          prompt: "user prompt",
          triggers: [{ kind: "hook", event: "session_start" }],
          context: "session" as const,
          quiet: true,
          paused: false,
          createdAt: Date.now(),
        },
      },
      tickState: {},
      deferredHooks: [],
    };
    writeFileSync(statePath, JSON.stringify(userState), "utf-8");

    // Install
    const r = installSagesRoutines(templatesDir, statePath);
    expect(r.installed.length).toBe(1);

    // Both should be present
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.routines.user_routine_a).toBeDefined();
    expect(state.routines.user_routine_a.name).toBe("user-routine-a");
    expect(Object.values(state.routines).filter((r: any) => r.name === "sages-session-wrap").length).toBe(1);
  });

  it("missing templates dir returns error (doesn't throw)", () => {
    const r = installSagesRoutines(join(tmpDir, "no-such-dir"), statePath);
    expect(r.installed).toEqual([]);
    expect(r.errors.length).toBeGreaterThan(0);
  });

  it("missing state file is created on first install", () => {
    writeTemplate("sages-session-wrap", minimalHookTemplate("sages-session-wrap", "session_shutdown", "per_session"));
    expect(existsSync(statePath)).toBe(false);
    installSagesRoutines(templatesDir, statePath);
    expect(existsSync(statePath)).toBe(true);
  });
});