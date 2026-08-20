/**
 * Round 4: L1 advisory — no_progress_no_audit
 *
 * 12+ tool calls without orchestrator_audit. Expected: major advisory.
 */

import { describe, it, expect } from "bun:test";
import {
  extractOrchestratorFindings,
  RULE_FIX_DIRECTIVES,
} from "@/tools/orchestrator/l1-advisory.js";

describe("Round 4: L1 advisory — no_progress_no_audit", () => {
  it("fires after 12 tool calls with no audit", () => {
    const history = Array.from({ length: 12 }, (_, i) => ({
      toolName: i % 2 === 0 ? "read" : "bash",
      input: { path: `/tmp/fake-${i}` },
      timestamp: i,
    }));
    const findings = extractOrchestratorFindings(history);
    const rule = findings.find((f) => f.rule === "no_progress_no_audit");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("major");
    // Fix directive is in Chinese — match the gist.
    expect(RULE_FIX_DIRECTIVES.no_progress_no_audit).toContain("orchestrator_audit");
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
});