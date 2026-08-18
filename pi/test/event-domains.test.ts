/**
 * event-domains.test.ts — GC-2026-050 T4.2
 *
 * Tests the three event-domain isolation contracts defined in
 * `pi/src/observability/events.ts` + the matching emitters:
 *
 *   - run/* events are durable (written to audit-state-{dag}.yaml)
 *     and rejected by step/seam emitters.
 *   - step/* events are ephemeral (console.log only) and NEVER touch
 *     audit-state.
 *   - seam/* events are dispatched to a per-process callback FIFO; the
 *     dispatcher awaits callbacks in registration order.
 *
 * Each emitter asserts its own domain via `domainOf()` — these tests
 * pin that contract. The test DAG id is `TEST-DAG-event-domains`,
 * isolated from any real orchestrator state.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { readFileSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  RunEvent,
  StepEvent,
  SeamEvent,
  emitRunEvent,
  emitStepEvent,
  emitSeamEvent,
  onSeam,
  clearSeamCallbacks,
  domainOf,
} from "../src/observability/index.js";

const TEST_DAG = "TEST-DAG-event-domains";
const auditStatePath = (): string => join(".pi/orchestrator", `audit-state-${TEST_DAG}.yaml`);

describe("event domains — isolation", () => {
  beforeEach(() => {
    // Clean up any prior test state so each test starts fresh.
    const p = auditStatePath();
    if (existsSync(p)) rmSync(p);
    clearSeamCallbacks();
  });

  it("RunEvent values start with 'run/'", () => {
    for (const v of Object.values(RunEvent)) {
      expect(v).toMatch(/^run\//);
      expect(domainOf(v)).toBe("run");
    }
  });

  it("StepEvent values start with 'step/'", () => {
    for (const v of Object.values(StepEvent)) {
      expect(v).toMatch(/^step\//);
      expect(domainOf(v)).toBe("step");
    }
  });

  it("SeamEvent values start with 'seam/'", () => {
    for (const v of Object.values(SeamEvent)) {
      expect(v).toMatch(/^seam\//);
      expect(domainOf(v)).toBe("seam");
    }
  });

  it("emitRunEvent writes to audit-state-{dag}.yaml", () => {
    // Ensure the orchestrator dir exists before the emit so we exercise the
    // emitter's directory-ensure branch end-to-end.
    mkdirSync(".pi/orchestrator", { recursive: true });
    emitRunEvent(TEST_DAG, RunEvent.GoalCreated, { foo: "bar" });
    const path = auditStatePath();
    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, "utf-8");
    expect(raw).toContain("run/goal_created");
    expect(raw).toContain("foo: bar");
  });

  it("emitStepEvent does NOT write to audit-state", () => {
    // Suppress the console.log so the test runner output stays clean.
    const originalLog = console.log;
    console.log = () => {};
    try {
      emitStepEvent(StepEvent.Preflight, { foo: "bar" });
    } finally {
      console.log = originalLog;
    }
    // No prior emitRunEvent in this test, so audit-state should not exist.
    expect(existsSync(auditStatePath())).toBe(false);
  });

  it("emitRunEvent rejects non-run events", () => {
    expect(() => emitRunEvent(TEST_DAG, "step/spawn" as unknown as RunEvent)).toThrow();
    expect(() => emitRunEvent(TEST_DAG, "seam/preflight" as unknown as RunEvent)).toThrow();
  });

  it("emitStepEvent rejects non-step events", () => {
    expect(() => emitStepEvent("run/goal_created" as unknown as StepEvent)).toThrow();
  });

  it("onSeam + emitSeamEvent invokes registered callback", async () => {
    let called = false;
    onSeam(SeamEvent.Preflight, async () => {
      called = true;
    });
    await emitSeamEvent(SeamEvent.Preflight);
    expect(called).toBe(true);
  });

  it("onSeam + emitSeamEvent awaits multiple callbacks in order", async () => {
    const order: string[] = [];
    onSeam(SeamEvent.Preflight, async () => {
      order.push("first");
    });
    onSeam(SeamEvent.Preflight, async () => {
      order.push("second");
    });
    await emitSeamEvent(SeamEvent.Preflight);
    expect(order).toEqual(["first", "second"]);
  });

  it("domainOf returns null for unknown events", () => {
    expect(domainOf("unknown/event")).toBe(null);
    expect(domainOf("")).toBe(null);
  });
});