/**
 * Round 1: Orchestrator advisory — dag_resynth_loop
 *
 * Synthetic tool-call history: 3× dag_synthesize for the same goal.
 * Expected: orchestratorAdvisoryFor emits a `dag_resynth_loop` advisory
 * with severity `major`, fix-directive text mentioning "amend or revise".
 */

import { describe, it, expect } from "bun:test";
import {
  extractOrchestratorFindings,
  orchestratorAdvisoryFor,
  RULE_FIX_DIRECTIVES,
} from "@/orchestrator-advisory.js";

describe("Round 1: Orchestrator advisory — dag_resynth_loop", () => {
  it("fires when same goal is resynthesized > 2 times", () => {
    const history = [
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-TEST" }, timestamp: 1 },
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-TEST" }, timestamp: 2 },
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-TEST" }, timestamp: 3 },
    ];

    const findings = extractOrchestratorFindings(history);
    const rule = findings.find((f) => f.rule === "dag_resynth_loop");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("major");

    const advices = orchestratorAdvisoryFor(history);
    expect(advices.length).toBeGreaterThan(0);
    const text = advices[0];
    expect(text).toContain("dag_resynth_loop");
    expect(text).toContain("[orchestrator audit advisory");
    expect(text).toMatch(/1\/\d+/);

    // Per-rule fix-directive should be actionable
    expect(RULE_FIX_DIRECTIVES.dag_resynth_loop).toContain("amend");
  });

  it("does NOT fire when different goals are synthesized", () => {
    const history = [
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-A" }, timestamp: 1 },
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-B" }, timestamp: 2 },
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-C" }, timestamp: 3 },
    ];
    const findings = extractOrchestratorFindings(history);
    expect(findings.find((f) => f.rule === "dag_resynth_loop")).toBeUndefined();
  });

  it("does NOT fire on 2× calls (threshold is > 2)", () => {
    const history = [
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-TEST" }, timestamp: 1 },
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-TEST" }, timestamp: 2 },
    ];
    const findings = extractOrchestratorFindings(history);
    expect(findings.find((f) => f.rule === "dag_resynth_loop")).toBeUndefined();
  });

  it("does NOT fire when same goal is resynthesized with DIFFERENT args (refinement, GC-2026-059 chain-key)", () => {
    // The killer use case for chain-key: legitimate refinement.
    // Pre-GC-2026-059, the per-goal counter would fire here. With
    // chain-key, only identical-args repeats trigger.
    const history = [
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-TEST", refine: "iteration 1" }, timestamp: 1 },
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-TEST", refine: "iteration 2" }, timestamp: 2 },
      { toolName: "dag_synthesize", input: { goal_id: "GC-2026-TEST", refine: "iteration 3" }, timestamp: 3 },
    ];
    const findings = extractOrchestratorFindings(history);
    expect(findings.find((f) => f.rule === "dag_resynth_loop")).toBeUndefined();
  });
});