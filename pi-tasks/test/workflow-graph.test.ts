/**
 * workflow-graph.test.ts — Unit tests for `buildStaticWorkflowGraph`.
 *
 * The static graph is the heart of path B's tracking layer:
 *   - Implement → Review_1 → Fix_1 → Review_2 → Fix_2 → Review_3 → Merge (default max=3)
 *   - max_fix_iterations controls how many (Review_i, Fix_i) pairs exist
 *   - Every task gets `metadata.workflow_run_goal_id` + `metadata.phase`
 *   - `blocks` / `blockedBy` use placeholder IDs (`__implement__`, `__review_1__`,
 *     `__fix_1__`, …) which the workflow handler resolves to real task IDs
 *     after TaskCreate returns.
 *
 * Scope: this file tests the pure function only. The event-driven handler
 * (`workflow-handler.test.ts`) covers the placeholder→ID resolution step.
 */

import { describe, expect, test } from "vitest";
import { buildStaticWorkflowGraph, type WorkflowGraphInput } from "../src/workflow-graph.js";

const baseGoal = {
  id: "GC-TEST-001",
  title: "Add login rate limit",
  rationale: "Brute-force protection",
  scope: { include: ["src/auth/**"], exclude: ["src/admin/**"] },
  anti_goals: ["No new deps"],
  done_definition: "Login is rate-limited after 5 attempts/min",
};

function input(max_fix_iterations = 3): WorkflowGraphInput {
  return {
    goal: baseGoal,
    max_fix_iterations,
    workflow_run_goal_id: "GC-TEST-001",
  };
}

describe("buildStaticWorkflowGraph", () => {
  test("happy path: max_fix_iterations=1 returns 3 tasks (Implement + Review_1 + Merge)", () => {
    const tasks = buildStaticWorkflowGraph(input(1));

    expect(tasks).toHaveLength(3);
    expect(tasks.map(t => t.subject)).toEqual([
      "Implement: Add login rate limit",
      "Review 1: Add login rate limit",
      "Merge: Add login rate limit",
    ]);

    // Review_1 blockedBy Implement, blocks Merge
    expect(tasks[1].blockedBy).toEqual(["__implement__"]);
    expect(tasks[1].blocks).toEqual(["__merge__"]);

    // Merge blockedBy Implement + Review_1, no downstream
    expect(tasks[2].blockedBy).toEqual(["__implement__", "__review_1__"]);
    expect(tasks[2].blocks).toEqual([]);

    // Implement is the root — no upstream, only Review_1 downstream
    expect(tasks[0].blockedBy).toEqual([]);
    expect(tasks[0].blocks).toEqual(["__review_1__"]);
  });

  test("default max=3: 7 tasks with cascade chain Implement → Review_1 → Fix_1 → Review_2 → Fix_2 → Review_3 → Merge", () => {
    const tasks = buildStaticWorkflowGraph(input(3));

    expect(tasks).toHaveLength(7);
    expect(tasks.map(t => t.subject)).toEqual([
      "Implement: Add login rate limit",
      "Review 1: Add login rate limit",
      "Fix 1: Add login rate limit",
      "Review 2: Add login rate limit",
      "Fix 2: Add login rate limit",
      "Review 3: Add login rate limit",
      "Merge: Add login rate limit",
    ]);

    // Implement → Review_1
    expect(tasks[0].blocks).toEqual(["__review_1__"]);
    // Review_1 → Fix_1, Merge
    expect(tasks[1].blockedBy).toEqual(["__implement__"]);
    expect(tasks[1].blocks).toEqual(["__fix_1__", "__merge__"]);
    // Fix_1 → Review_2, Merge
    expect(tasks[2].blockedBy).toEqual(["__review_1__"]);
    expect(tasks[2].blocks).toEqual(["__review_2__", "__merge__"]);
    // Review_2 → Fix_2, Merge
    expect(tasks[3].blockedBy).toEqual(["__fix_1__"]);
    expect(tasks[3].blocks).toEqual(["__fix_2__", "__merge__"]);
    // Fix_2 → Review_3, Merge
    expect(tasks[4].blockedBy).toEqual(["__review_2__"]);
    expect(tasks[4].blocks).toEqual(["__review_3__", "__merge__"]);
    // Review_3 → Merge (no Fix_3 — last iteration ends at Merge)
    expect(tasks[5].blockedBy).toEqual(["__fix_2__"]);
    expect(tasks[5].blocks).toEqual(["__merge__"]);
    // Merge: blockedBy everything, nothing downstream
    expect(tasks[6].blockedBy).toEqual([
      "__implement__",
      "__review_1__",
      "__fix_1__",
      "__review_2__",
      "__fix_2__",
      "__review_3__",
    ]);
    expect(tasks[6].blocks).toEqual([]);
  });

  test("metadata.workflow_run_goal_id and metadata.phase are stamped on every task", () => {
    const tasks = buildStaticWorkflowGraph(input(3));

    expect(tasks.every(t => t.metadata.workflow_run_goal_id === "GC-TEST-001")).toBe(true);
    expect(tasks.every(t => typeof t.metadata.phase === "string")).toBe(true);
    expect(tasks.every(t => typeof t.metadata.agentType === "string")).toBe(true);

    // Phase values are one of the known phase strings
    const phases = new Set(tasks.map(t => t.metadata.phase));
    expect(phases).toEqual(new Set(["implement", "review", "fix", "merge"]));

    // Iteration is stamped on review / fix tasks only
    const review = tasks.find(t => t.metadata.phase === "review");
    const fix = tasks.find(t => t.metadata.phase === "fix");
    expect(review?.metadata.iteration).toBe(1);
    expect(fix?.metadata.iteration).toBe(1);
  });

  test("every task has an agentType matching its phase", () => {
    const tasks = buildStaticWorkflowGraph(input(3));

    const byPhase: Record<string, string> = {
      implement: "Developer",
      review: "Reviewer",
      fix: "Developer",
      merge: "Merger",
    };
    for (const t of tasks) {
      expect(t.metadata.agentType).toBe(byPhase[t.metadata.phase]);
    }
  });

  test("max_fix_iterations=2 returns 5 tasks (Implement + Review_1 + Fix_1 + Review_2 + Merge)", () => {
    const tasks = buildStaticWorkflowGraph(input(2));

    expect(tasks).toHaveLength(5);
    expect(tasks.map(t => t.subject)).toEqual([
      "Implement: Add login rate limit",
      "Review 1: Add login rate limit",
      "Fix 1: Add login rate limit",
      "Review 2: Add login rate limit",
      "Merge: Add login rate limit",
    ]);

    // Review_2 is the last review — no Fix_2
    expect(tasks[3].blockedBy).toEqual(["__fix_1__"]);
    expect(tasks[3].blocks).toEqual(["__merge__"]);

    // Merge collects all
    expect(tasks[4].blockedBy).toEqual([
      "__implement__",
      "__review_1__",
      "__fix_1__",
      "__review_2__",
    ]);
  });
});
