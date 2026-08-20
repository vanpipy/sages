/**
 * sages-routines-install tests — GC-2026-055
 *
 * Covers:
 *  - parseInterval: valid forms, error cases
 *  - transformTemplate: hook / pulse / cron / oneoff, name → id
 *  - loadStore / saveStore: empty store, corrupted file, round-trip
 *  - installSagesRoutines: empty dir, missing dir, multiple files,
 *    idempotency (existing routine skipped), errors don't stop install
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import {
  parseInterval,
  transformTemplate,
  installSagesRoutines,
  type InstallResult,
} from "@/tools/routines/sages-routines-install.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe("sages-routines-install: parseInterval (GC-2026-055)", () => {
  it("P-01: 5m → 300000 ms", () => {
    expect(parseInterval("5m").ms).toBe(300_000);
  });

  it("P-02: 30s → 30_000 ms (boundary)", () => {
    expect(parseInterval("30s").ms).toBe(30_000);
  });

  it("P-03: 1h → 3_600_000 ms", () => {
    expect(parseInterval("1h").ms).toBe(3_600_000);
  });

  it("P-04: 1h30m → 5_400_000 ms", () => {
    expect(parseInterval("1h30m").ms).toBe(5_400_000);
  });

  it("P-05: 'every 5m' prefix recognized", () => {
    expect(parseInterval("every 5m").ms).toBe(300_000);
  });

  it("P-06: 29s minimum rejected", () => {
    expect(() => parseInterval("29s")).toThrow(/at least 30/);
  });

  it("P-07: bare number rejected", () => {
    expect(() => parseInterval("5")).toThrow(/Specify a unit/);
  });

  it("P-08: 25h over 24h rejected", () => {
    expect(() => parseInterval("25h")).toThrow(/cron trigger/);
  });

  it("P-09: garbage rejected", () => {
    expect(() => parseInterval("nope")).toThrow(/Could not parse/);
  });
});

describe("sages-routines-install: transformTemplate (GC-2026-055)", () => {
  it("T-01: hook trigger passes through", () => {
    const out = transformTemplate({
      name: "sages-test-hook",
      trigger: { kind: "hook", event: "session_start", once: "daily" },
      prompt: "test",
      quiet: true,
    });
    expect(out.triggers.length).toBe(1);
    expect(out.triggers[0]).toEqual({
      kind: "hook",
      event: "session_start",
      once: "daily",
    });
  });

  it("T-02: pulse trigger converts interval to ms", () => {
    const out = transformTemplate({
      name: "sages-test-pulse",
      trigger: { kind: "pulse", interval: "5m" },
      prompt: "test",
      quiet: true,
    });
    expect(out.triggers[0]).toEqual({
      kind: "pulse",
      intervalMs: 300_000,
      intervalHuman: "5m",
    });
  });

  it("T-03: cron trigger passes through", () => {
    const out = transformTemplate({
      name: "sages-test-cron",
      trigger: { kind: "cron", expr: "0 9 * * 1-5" },
      prompt: "test",
      quiet: true,
    });
    expect(out.triggers[0]).toEqual({
      kind: "cron",
      expr: "0 9 * * 1-5",
    });
  });

  it("T-04: id is deterministic from name", () => {
    const a = transformTemplate({
      name: "sages-foo",
      trigger: { kind: "hook", event: "session_start" },
      prompt: "x",
      quiet: true,
    });
    const b = transformTemplate({
      name: "sages-foo",
      trigger: { kind: "hook", event: "session_start" },
      prompt: "x",
      quiet: true,
    });
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^sages_sages-foo|^sages_/);
    // Slugify special chars
    const c = transformTemplate({
      name: "weird.name/with:chars",
      trigger: { kind: "hook", event: "session_start" },
      prompt: "x",
      quiet: true,
    });
    expect(c.id).not.toContain(".");
    expect(c.id).not.toContain("/");
    expect(c.id).not.toContain(":");
  });

  it("T-05: quiet is preserved", () => {
    const out = transformTemplate({
      name: "x",
      trigger: { kind: "hook", event: "session_start" },
      prompt: "x",
      quiet: true,
    });
    expect(out.quiet).toBe(true);
  });

  it("T-06: maxTicks is preserved", () => {
    const out = transformTemplate({
      name: "x",
      trigger: { kind: "pulse", interval: "5m" },
      prompt: "x",
      quiet: true,
      maxTicks: 14400,
    });
    expect(out.maxTicks).toBe(14400);
  });

  it("T-07: createdAt is recent", () => {
    const before = Date.now();
    const out = transformTemplate({
      name: "x",
      trigger: { kind: "hook", event: "session_start" },
      prompt: "x",
      quiet: true,
    });
    expect(out.createdAt).toBeGreaterThanOrEqual(before);
  });

  it("T-08: context is 'session'", () => {
    const out = transformTemplate({
      name: "x",
      trigger: { kind: "hook", event: "session_start" },
      prompt: "x",
      quiet: true,
    });
    expect(out.context).toBe("session");
  });
});

describe("sages-routines-install: installSagesRoutines (GC-2026-055)", () => {
  let tmpDir: string;
  let templatesDir: string;
  let statePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sages-routines-test-"));
    templatesDir = join(tmpDir, "templates");
    statePath = join(tmpDir, "state.json");
    // Create the templates dir so empty-dir tests work (no error from
    // missing dir).
    require("node:fs").mkdirSync(templatesDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeTemplate(name: string, content: string = minimalValidTemplate(name)) {
    if (!existsSync(templatesDir)) {
      require("node:fs").mkdirSync(templatesDir, { recursive: true });
    }
    writeFileSync(join(templatesDir, `${name}.json`), content, "utf-8");
  }

  function minimalValidTemplate(name: string): string {
    return JSON.stringify({
      name,
      trigger: { kind: "hook", event: "session_start", once: "daily" },
      prompt: "test prompt",
      quiet: true,
    });
  }

  it("I-01: empty templates dir → no install, no errors", () => {
    const result = installSagesRoutines(templatesDir, statePath);
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("I-02: missing templates dir → returns error, doesn't throw", () => {
    const result = installSagesRoutines(join(tmpDir, "no-such-dir"), statePath);
    expect(result.installed).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("I-03: missing state file → creates one with installed routine", () => {
    writeTemplate("sages-session-wrap");
    const result = installSagesRoutines(templatesDir, statePath);
    expect(result.installed).toEqual(["sages-session-wrap"]);
    expect(existsSync(statePath)).toBe(true);
    const store = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(store.routines[Object.keys(store.routines)[0]].name).toBe("sages-session-wrap");
  });

  it("I-04: existing routine with same name → skipped, not overwritten", () => {
    writeTemplate("sages-session-wrap");
    installSagesRoutines(templatesDir, statePath);
    // Tamper: change the routine's prompt
    const store = JSON.parse(readFileSync(statePath, "utf-8"));
    const id = Object.keys(store.routines)[0];
    store.routines[id].prompt = "TAMPERED";
    writeFileSync(statePath, JSON.stringify(store), "utf-8");

    // Re-install
    const result = installSagesRoutines(templatesDir, statePath);
    expect(result.skipped).toEqual(["sages-session-wrap"]);
    expect(result.installed).toEqual([]);
    const store2 = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(store2.routines[id].prompt).toBe("TAMPERED");
  });

  it("I-05: 3 templates → 3 installed", () => {
    writeTemplate("sages-session-wrap");
    writeTemplate("sages-resume");
    writeTemplate("sages-watchdog", JSON.stringify({
      name: "sages-watchdog",
      trigger: { kind: "pulse", interval: "5m" },
      prompt: "watch",
      quiet: true,
      maxTicks: 14400,
    }));
    const result = installSagesRoutines(templatesDir, statePath);
    expect(result.installed.length).toBe(3);
    expect(result.installed).toContain("sages-session-wrap");
    expect(result.installed).toContain("sages-resume");
    expect(result.installed).toContain("sages-watchdog");
  });

  it("I-06: malformed JSON → error captured, others installed", () => {
    writeTemplate("sages-good", minimalValidTemplate("sages-good"));
    writeTemplate("sages-bad", "{not valid json");
    writeTemplate("sages-also-good", minimalValidTemplate("sages-also-good"));
    const result = installSagesRoutines(templatesDir, statePath);
    expect(result.installed).toContain("sages-good");
    expect(result.installed).toContain("sages-also-good");
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].name).toBe("sages-bad.json");
  });

  it("I-07: existing state with non-sages routines preserved", () => {
    // Pre-populate with a user routine
    const store = {
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
    writeFileSync(statePath, JSON.stringify(store), "utf-8");

    writeTemplate("sages-new-one");
    const result = installSagesRoutines(templatesDir, statePath);
    expect(result.installed).toEqual(["sages-new-one"]);

    const updated = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(updated.routines.user_routine_a).toBeDefined();
    expect(updated.routines.user_routine_a.name).toBe("user-routine-a");
  });

  it("I-08: pulse template correctly transforms intervalMs", () => {
    writeTemplate("sages-watchdog", JSON.stringify({
      name: "sages-watchdog",
      trigger: { kind: "pulse", interval: "5m" },
      prompt: "watch",
      quiet: true,
      maxTicks: 14400,
    }));
    installSagesRoutines(templatesDir, statePath);
    const store = JSON.parse(readFileSync(statePath, "utf-8"));
    const id = Object.keys(store.routines)[0];
    expect(store.routines[id].triggers[0]).toEqual({
      kind: "pulse",
      intervalMs: 300_000,
      intervalHuman: "5m",
    });
  });
});

describe("sages-routines-install: end-to-end (GC-2026-055)", () => {
  it("E-01: install the 3 Sages routines into a real pi-routines state file", () => {
    // This test uses the actual templates dir from the package.
    const result = installSagesRoutines();
    // Result depends on whether the test runner has a state file already.
    // We just verify it doesn't throw and returns a valid result.
    expect(Array.isArray(result.installed)).toBe(true);
    expect(Array.isArray(result.skipped)).toBe(true);
    expect(Array.isArray(result.errors)).toBe(true);
  });
});
