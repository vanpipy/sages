/**
 * Round 2: Orchestrator advisory — dispatch_no_audit
 *
 * task_dispatch called but orchestrator_audit never observed.
 * Expected: critical advisory — "audit not run, must call orchestrator_audit".
 */

import { describe, it, expect } from "bun:test";
import {
  extractOrchestratorFindings,
  RULE_FIX_DIRECTIVES,
} from "@/orchestrator-advisory.js";

describe("Round 2: Orchestrator advisory — dispatch_no_audit", () => {
  it("fires with critical severity when task_dispatch is called without audit", () => {
    const history = [
      { toolName: "task_dispatch", input: { dag_id: "DAG-2026-X" }, timestamp: 1 },
    ];
    const findings = extractOrchestratorFindings(history);
    const rule = findings.find((f) => f.rule === "dispatch_no_audit");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("critical");
    expect(RULE_FIX_DIRECTIVES.dispatch_no_audit).toContain("orchestrator_audit");
  });

  it("does NOT fire when task_dispatch is followed by orchestrator_audit", () => {
    const history = [
      { toolName: "task_dispatch", input: { dag_id: "DAG-2026-X" }, timestamp: 1 },
      { toolName: "orchestrator_audit", input: { dag_id: "DAG-2026-X" }, timestamp: 2 },
    ];
    const findings = extractOrchestratorFindings(history);
    expect(findings.find((f) => f.rule === "dispatch_no_audit")).toBeUndefined();
  });

  it("emits before lower-severity rules (critical sort)", () => {
    const history = [
      { toolName: "dag_synthesize", input: { goal_id: "GC-X" }, timestamp: 1 },
      { toolName: "dag_synthesize", input: { goal_id: "GC-X" }, timestamp: 2 },
      { toolName: "dag_synthesize", input: { goal_id: "GC-X" }, timestamp: 3 },
      { toolName: "task_dispatch", input: { dag_id: "DAG-X" }, timestamp: 4 },
    ];
    const findings = extractOrchestratorFindings(history);
    // critical first
    const critical = findings.find((f) => f.severity === "critical");
    const major = findings.find((f) => f.severity === "major");
    if (critical && major) {
      const cIdx = findings.indexOf(critical);
      const mIdx = findings.indexOf(major);
      expect(cIdx).toBeLessThan(mIdx);
    }
  });
});