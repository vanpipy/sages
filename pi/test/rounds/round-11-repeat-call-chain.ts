/**
 * Round 11: Orchestrator advisory — repeat_call_chain (chain-key detection)
 *
 * New rule in GC-2026-059. Fires when same (tool, args) called
 * 3+ times. General "stuck on same call" detector that mirrors
 * dsh's repeat-tool-reminder.
 *
 * Expected:
 *  - Fires on 3+ identical read of /tmp/x
 *  - Does NOT fire on 3 different reads (a/b/c)
 *  - Suppressed when worst chain is dag_synthesize (covered by
 *    dag_resynth_loop instead)
 *  - Arg key order does NOT matter (canonical form)
 */

import { describe, it, expect } from "bun:test";
import { extractOrchestratorFindings } from "@/orchestrator-advisory.js";

describe("Round 11: Orchestrator advisory — repeat_call_chain", () => {
  it("R11-01: fires on 3+ identical reads of the same path", () => {
    const history = Array.from({ length: 4 }, (_, i) => ({
      toolName: "read",
      input: { path: "/tmp/looped.ts" },
      timestamp: 1000 + i,
    }));
    const findings = extractOrchestratorFindings(history);
    const rule = findings.find((f) => f.rule === "repeat_call_chain");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("major");
  });

  it("R11-02: does NOT fire when 3 reads have different paths", () => {
    const history = [
      { toolName: "read", input: { path: "/tmp/a" }, timestamp: 1000 },
      { toolName: "read", input: { path: "/tmp/b" }, timestamp: 2000 },
      { toolName: "read", input: { path: "/tmp/c" }, timestamp: 3000 },
    ];
    const findings = extractOrchestratorFindings(history);
    expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeUndefined();
  });

  it("R11-03: does NOT fire on only 2 calls (need 3+)", () => {
    const history = [
      { toolName: "read", input: { path: "/tmp/x" }, timestamp: 1000 },
      { toolName: "read", input: { path: "/tmp/x" }, timestamp: 2000 },
    ];
    const findings = extractOrchestratorFindings(history);
    expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeUndefined();
  });

  it("R11-04: arg key order does NOT matter (canonical form)", () => {
    const history = [
      { toolName: "read", input: { path: "/tmp/x", encoding: "utf-8" }, timestamp: 1000 },
      { toolName: "read", input: { encoding: "utf-8", path: "/tmp/x" }, timestamp: 2000 },
      { toolName: "read", input: { path: "/tmp/x", encoding: "utf-8" }, timestamp: 3000 },
    ];
    const findings = extractOrchestratorFindings(history);
    expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeDefined();
  });

  it("R11-05: suppressed when worst chain is dag_synthesize (covered by dag_resynth_loop)", () => {
    // 3 identical dag_synthesize calls → dag_resynth_loop fires,
    // repeat_call_chain is suppressed (no double-fire for same chain).
    const history = Array.from({ length: 3 }, (_, i) => ({
      toolName: "dag_synthesize",
      input: { goal_id: "GC-1" },
      timestamp: 1000 + i,
    }));
    const findings = extractOrchestratorFindings(history);
    expect(findings.find((f) => f.rule === "dag_resynth_loop")).toBeDefined();
    expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeUndefined();
  });

  it("R11-06: fires on task_dispatch with same args 3+ times", () => {
    const history = [
      { toolName: "task_dispatch", input: { dag_id: "DAG-X", task_id: "T1" }, timestamp: 1000 },
      { toolName: "task_dispatch", input: { dag_id: "DAG-X", task_id: "T1" }, timestamp: 2000 },
      { toolName: "task_dispatch", input: { dag_id: "DAG-X", task_id: "T1" }, timestamp: 3000 },
    ];
    const findings = extractOrchestratorFindings(history);
    expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeDefined();
  });

  it("R11-07: false-positive reduction — refinement (different args) does NOT trigger", () => {
    // The killer use case: 3 dag_synthesize calls with DIFFERENT args
    // (refining the goal each time). Pre-GC-2026-059, this would
    // trigger dag_resynth_loop. With chain-key, it should NOT.
    const history = [
      { toolName: "dag_synthesize", input: { goal_id: "GC-1", refine: "iteration 1" }, timestamp: 1000 },
      { toolName: "dag_synthesize", input: { goal_id: "GC-1", refine: "iteration 2" }, timestamp: 2000 },
      { toolName: "dag_synthesize", input: { goal_id: "GC-1", refine: "iteration 3" }, timestamp: 3000 },
    ];
    const findings = extractOrchestratorFindings(history);
    expect(findings.find((f) => f.rule === "dag_resynth_loop")).toBeUndefined();
    expect(findings.find((f) => f.rule === "repeat_call_chain")).toBeUndefined();
  });
});