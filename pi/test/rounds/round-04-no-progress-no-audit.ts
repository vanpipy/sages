/**
 * Round 4: L1 advisory — no_progress_no_audit
 *
 * 12+ tool calls without orchestrator_audit. Expected: major advisory.
 */

import { describe, it, expect } from "bun:test";
import {
  extractOrchestratorFindings,
  RULE_FIX_DIRECTIVES,
} from "@/l1-advisory.js";

describe("Round 4: L1 advisory — no_progress_no_audit", () => {
  it("fires after 12 tool calls AND a chain at length >= 3 (GC-2026-059 tightened rule)", () => {
    // GC-2026-059: tighten rule to require a chain at length >= 3.
    // 9 distinct reads + 3 reads of the same path (chain length 3).
    const history = [
      ...Array.from({ length: 9 }, (_, i) => ({
        toolName: i % 2 === 0 ? "read" : "bash",
        input: { path: `/tmp/fake-${i}` },
        timestamp: i,
      })),
      { toolName: "read", input: { path: "/tmp/looped.ts" }, timestamp: 9 },
      { toolName: "read", input: { path: "/tmp/looped.ts" }, timestamp: 10 },
      { toolName: "read", input: { path: "/tmp/looped.ts" }, timestamp: 11 },
    ];
    const findings = extractOrchestratorFindings(history);
    const rule = findings.find((f) => f.rule === "no_progress_no_audit");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("major");
    expect(RULE_FIX_DIRECTIVES.no_progress_no_audit).toContain("orchestrator_audit");
  });

  it("does NOT fire when all calls are distinct (no chain >= 3)", () => {
    // 12 distinct paths — no chain at length >= 3, even though total > 10
    const history = Array.from({ length: 12 }, (_, i) => ({
      toolName: i % 2 === 0 ? "read" : "bash",
      input: { path: `/tmp/fake-${i}` },
      timestamp: i,
    }));
    const findings = extractOrchestratorFindings(history);
    expect(findings.find((f) => f.rule === "no_progress_no_audit")).toBeUndefined();
  });

  it("does NOT fire when audit was called recently (within threshold)", () => {
    const history = [
      // 12 tool calls but audit was called at index 11 (the most recent)
      ...Array.from({ length: 11 }, (_, i) => ({
        toolName: "read",
        input: { path: `/tmp/fake-${i}` },
        timestamp: i,
      })),
      { toolName: "orchestrator_audit", input: { dag_id: "DAG-X" }, timestamp: 11 },
    ];
    const findings = extractOrchestratorFindings(history);
    expect(findings.find((f) => f.rule === "no_progress_no_audit")).toBeUndefined();
  });

  it("fires with the new contract — 12+ distinct calls + chain >= 3", () => {
    // 8 distinct + 4 reads of same path (chain length 4) = chain fires
    const history = [
      ...Array.from({ length: 8 }, (_, i) => ({
        toolName: "read",
        input: { path: `/tmp/distinct-${i}` },
        timestamp: i,
      })),
      { toolName: "read", input: { path: "/tmp/same" }, timestamp: 8 },
      { toolName: "read", input: { path: "/tmp/same" }, timestamp: 9 },
      { toolName: "read", input: { path: "/tmp/same" }, timestamp: 10 },
      { toolName: "read", input: { path: "/tmp/same" }, timestamp: 11 },
    ];
    const findings = extractOrchestratorFindings(history);
    // Both rules should fire: no_progress_no_audit (12 calls + chain) AND
    // repeat_call_chain (4 identical reads of /tmp/same).
    expect(findings.find((f) => f.rule === "no_progress_no_audit")).toBeDefined();
    expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeDefined();
  });
});