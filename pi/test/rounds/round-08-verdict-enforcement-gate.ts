/**
 * Round 8: verdict enforcement — REVISE blocks dispatch
 *
 * Record a REVISE verdict. Verify checkVerdictGate returns open=false
 * with a structured errorMessage. Then acknowledge. Verify gate opens.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  recordVerdict,
  acknowledgeVerdict,
  checkVerdictGate,
} from "@/tools/orchestrator/verdict-enforcement.js";

let tmpDir: string;
const DAG_ID = "GC-2026-VERDICT-TEST";

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sages-verdict-round-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Round 8: verdict enforcement — REVISE blocks dispatch", () => {
  it("PASS verdict keeps gate open", () => {
    recordVerdict(tmpDir, DAG_ID, "PASS", 95);
    const r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.open).toBe(true);
  });

  it("REVISE verdict (unack) blocks dispatch", () => {
    recordVerdict(tmpDir, DAG_ID, "REVISE", 60);
    const r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.open).toBe(false);
    expect(r.errorMessage).toContain("[sages verdict gate]");
    expect(r.errorMessage).toContain("REVISE");
    expect(r.errorMessage).toContain("acknowledge_verdict");
  });

  it("REJECT verdict (unack) blocks dispatch", () => {
    recordVerdict(tmpDir, DAG_ID, "REJECT", 20);
    const r = checkVerdictGate(tmpDir, DAG_ID);
    expect(r.open).toBe(false);
    expect(r.errorMessage).toContain("REJECT");
  });

  it("acknowledgement unblocks dispatch", () => {
    recordVerdict(tmpDir, DAG_ID, "REVISE", 60);
    expect(checkVerdictGate(tmpDir, DAG_ID).open).toBe(false);
    acknowledgeVerdict(tmpDir, DAG_ID, "Re-running failing task");
    expect(checkVerdictGate(tmpDir, DAG_ID).open).toBe(true);
  });

  it("most recent verdict wins (REVISE after PASS blocks again)", () => {
    recordVerdict(tmpDir, DAG_ID, "PASS", 95);
    expect(checkVerdictGate(tmpDir, DAG_ID).open).toBe(true);
    recordVerdict(tmpDir, DAG_ID, "REVISE", 60); // re-audit found issues
    expect(checkVerdictGate(tmpDir, DAG_ID).open).toBe(false);
  });

  it("double-acknowledge is idempotent (first reason wins)", () => {
    recordVerdict(tmpDir, DAG_ID, "REVISE", 60);
    acknowledgeVerdict(tmpDir, DAG_ID, "First reason");
    const second = acknowledgeVerdict(tmpDir, DAG_ID, "Second reason");
    expect(second?.acknowledged_reason).toBe("First reason");
  });
});