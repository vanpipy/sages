/**
 * Round 3: Orchestrator advisory — transition_skip_failed
 *
 * DAG state shows T1 in `failed` status; LLM calls task_dispatch for
 * T2 whose dep is T1. Expected: critical advisory.
 */

import { describe, it, expect } from "bun:test";
import {
  extractOrchestratorFindings,
  RULE_FIX_DIRECTIVES,
} from "@/orchestrator-advisory.js";

describe("Round 3: Orchestrator advisory — transition_skip_failed", () => {
  it("fires when dispatching T2 while T1 (dep) is failed", () => {
    // The detector scans for task_dispatch with a transition block.
    const history = [
      {
        toolName: "task_dispatch",
        input: {
          dag_id: "DAG-2026-X",
          transition: { task_id: "T2", status: "in_progress" },
        },
        timestamp: 1,
      },
    ];
    const fakePlan = {
      tasks: [
        { id: "T1", status: "failed" as const, depends_on: [] },
        { id: "T2", status: "in_progress" as const, depends_on: ["T1"] },
      ],
    };
    const findings = extractOrchestratorFindings(history, {
      loadDagPlan: () => fakePlan,
    });
    const rule = findings.find((f) => f.rule === "transition_skip_failed");
    expect(rule).toBeDefined();
    expect(rule?.severity).toBe("critical");
    // Fix directive is in Chinese — match the gist.
    expect(RULE_FIX_DIRECTIVES.transition_skip_failed).toContain("failed");
  });

  it("does NOT fire when deps are all completed", () => {
    const history = [
      {
        toolName: "task_dispatch",
        input: {
          dag_id: "DAG-Y",
          transition: { task_id: "T2", status: "in_progress" },
        },
        timestamp: 1,
      },
    ];
    const fakePlan = {
      tasks: [
        { id: "T1", status: "completed" as const, depends_on: [] },
        { id: "T2", status: "in_progress" as const, depends_on: ["T1"] },
      ],
    };
    const findings = extractOrchestratorFindings(history, {
      loadDagPlan: () => fakePlan,
    });
    expect(findings.find((f) => f.rule === "transition_skip_failed")).toBeUndefined();
  });
});