/**
 * verdict-enforcement tests — GC-2026-058
 *
 * Covers:
 *  - recordVerdict: writes sidecar file, returns record
 *  - checkVerdictGate: open for PASS, closed for REVISE/REJECT, open
 *    after acknowledgement
 *  - acknowledgeVerdict: flips acknowledged flag, returns updated record
 *  - End-to-end: REVISE blocks dispatch, acknowledge unblocks
 *  - Edge cases: missing file, malformed YAML, multiple vericts (last
 *    wins)
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  recordVerdict,
  acknowledgeVerdict,
  checkVerdictGate,
  type VerdictRecord,
} from "@/verdict-enforcement.js";

let tmpDir: string;
const DAG_ID = "GC-2026-TEST";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sages-verdict-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("verdict-enforcement: recordVerdict (GC-2026-058)", () => {
  it("R-01: PASS verdict creates the sidecar file with acknowledged=true", () => {
    const r = recordVerdict(tmpDir, DAG_ID, "PASS", 95);
    expect(r.verdict).toBe("PASS");
    expect(r.score).toBe(95);
    expect(r.acknowledged).toBe(true);
    expect(r.dag_id).toBe(DAG_ID);
    expect(existsSync(join(tmpDir, ".pi/orchestrator", `verdict-state-${DAG_ID}.yaml`))).toBe(true);
  });

  it("R-02: REVISE verdict creates file with acknowledged=false", () => {
    const r = recordVerdict(tmpDir, DAG_ID, "REVISE", 60);
    expect(r.verdict).toBe("REVISE");
    expect(r.acknowledged).toBe(false);
  });

  it("R-03: REJECT verdict creates file with acknowledged=false", () => {
    const r = recordVerdict(tmpDir, DAG_ID, "REJECT", 20);
    expect(r.verdict).toBe("REJECT");
    expect(r.acknowledged).toBe(false);
  });

  it("R-04: re-recording replaces prior record (most recent wins)", () => {
    recordVerdict(tmpDir, DAG_ID, "REVISE", 60);
    const r2 = recordVerdict(tmpDir, DAG_ID, "PASS", 95);
    expect(r2.verdict).toBe("PASS");
    expect(r2.acknowledged).toBe(true);
  });

  it("R-05: unknown verdict throws", () => {
    expect(() => recordVerdict(tmpDir, DAG_ID, "MAYBE" as any, 50)).toThrow(/unknown verdict/);
  });
});

describe("verdict-enforcement: checkVerdictGate (GC-2026-058)", () => {
  it("G-01: no audit yet → gate open (nothing to enforce)", () => {
    const r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.open).toBe(true);
    expect(r.record).toBeNull();
    expect(r.errorMessage).toBeUndefined();
  });

  it("G-02: PASS verdict → gate open", () => {
    recordVerdict(tmpDir, DAG_ID, "PASS", 95);
    const r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.open).toBe(true);
    expect(r.record?.verdict).toBe("PASS");
  });

  it("G-03: REVISE verdict (unack) → gate closed with error message", () => {
    recordVerdict(tmpDir, DAG_ID, "REVISE", 60);
    const r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.open).toBe(false);
    expect(r.reason).toContain("REVISE");
    expect(r.reason).toContain("not yet acknowledged");
    expect(r.errorMessage).toContain("[sages verdict gate]");
    expect(r.errorMessage).toContain("REVISE");
    expect(r.errorMessage).toContain("acknowledge_verdict");
  });

  it("G-04: REJECT verdict (unack) → gate closed", () => {
    recordVerdict(tmpDir, DAG_ID, "REJECT", 20);
    const r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.open).toBe(false);
    expect(r.reason).toContain("REJECT");
  });

  it("G-05: REVISE verdict (acknowledged) → gate open", () => {
    recordVerdict(tmpDir, DAG_ID, "REVISE", 60);
    acknowledgeVerdict(tmpDir, DAG_ID, "Re-running the failing task");
    const r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.open).toBe(true);
    expect(r.record?.acknowledged).toBe(true);
    expect(r.record?.acknowledged_reason).toContain("Re-running");
  });

  it("G-06: most recent verdict wins (overrides prior PASS)", () => {
    recordVerdict(tmpDir, DAG_ID, "PASS", 95);
    recordVerdict(tmpDir, DAG_ID, "REVISE", 60); // re-audit found issues
    const r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.open).toBe(false);
    expect(r.record?.verdict).toBe("REVISE");
  });
});

describe("verdict-enforcement: acknowledgeVerdict (GC-2026-058)", () => {
  it("A-01: acknowledge flips the flag, returns updated record", () => {
    recordVerdict(tmpDir, DAG_ID, "REVISE", 60);
    const ack = acknowledgeVerdict(tmpDir, DAG_ID, "Will re-run");
    expect(ack?.acknowledged).toBe(true);
    expect(ack?.acknowledged_at).toBeDefined();
    expect(ack?.acknowledged_reason).toBe("Will re-run");
  });

  it("A-02: acknowledge on PASS is a no-op (already acked)", () => {
    recordVerdict(tmpDir, DAG_ID, "PASS", 95);
    const ack = acknowledgeVerdict(tmpDir, DAG_ID, "redundant");
    expect(ack?.acknowledged).toBe(true);
    // Reason should NOT be overwritten for already-acked PASS.
    expect(ack?.acknowledged_reason).toBeUndefined();
  });

  it("A-03: acknowledge on missing verdict returns null", () => {
    const ack = acknowledgeVerdict(tmpDir, DAG_ID, "x");
    expect(ack).toBeNull();
  });

  it("A-04: double-acknowledge is idempotent (no second reason overwrite)", () => {
    recordVerdict(tmpDir, DAG_ID, "REVISE", 60);
    acknowledgeVerdict(tmpDir, DAG_ID, "First reason");
    const second = acknowledgeVerdict(tmpDir, DAG_ID, "Second reason");
    expect(second?.acknowledged_reason).toBe("First reason");
  });
});

describe("verdict-enforcement: end-to-end anti-cheat (GC-2026-058)", () => {
  it("E-01: REVISE blocks dispatch → acknowledge unblocks → next dispatch proceeds", () => {
    // 1. Audit returns REVISE
    recordVerdict(tmpDir, DAG_ID, "REVISE", 60);

    // 2. task_dispatch checks the gate — closed
    let r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.open).toBe(false);

    // 3. LLM acknowledges
    acknowledgeVerdict(tmpDir, DAG_ID, "Re-running failing task");

    // 4. task_dispatch re-checks — open
    r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.open).toBe(true);
  });

  it("E-02: REJECT → acknowledge → re-audit PASS → gate stays open", () => {
    recordVerdict(tmpDir, DAG_ID, "REJECT", 20);
    acknowledgeVerdict(tmpDir, DAG_ID, "Will restructure");
    expect(checkVerdictGate(tmpDir, DAG_ID).open).toBe(true);
    // Re-audit finds things fixed
    recordVerdict(tmpDir, DAG_ID, "PASS", 95);
    expect(checkVerdictGate(tmpDir, DAG_ID).open).toBe(true);
  });

  it("E-03: error message format is LLM-actionable", () => {
    recordVerdict(tmpDir, DAG_ID, "REVISE", 60);
    const r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.errorMessage).toMatch(/\[sages verdict gate\]/);
    expect(r.errorMessage).toMatch(/REVISE/);
    expect(r.errorMessage).toMatch(/DAG/);
    expect(r.errorMessage).toMatch(/acknowledge_verdict/);
  });
});

describe("verdict-enforcement: malformed state recovery (GC-2026-058)", () => {
  it("M-01: corrupt YAML → readState returns null → gate open", () => {
    const path = join(tmpDir, ".pi/orchestrator", `verdict-state-${DAG_ID}.yaml`);
    require("node:fs").mkdirSync(join(tmpDir, ".pi/orchestrator"), { recursive: true });
    require("node:fs").writeFileSync(path, "{ not valid yaml :::", "utf-8");
    const r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.open).toBe(true);
    expect(r.record).toBeNull();
  });

  it("M-02: empty file → readState returns null → gate open", () => {
    const path = join(tmpDir, ".pi/orchestrator", `verdict-state-${DAG_ID}.yaml`);
    require("node:fs").mkdirSync(join(tmpDir, ".pi/orchestrator"), { recursive: true });
    require("node:fs").writeFileSync(path, "", "utf-8");
    const r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.open).toBe(true);
  });
});