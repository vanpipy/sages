/**
 * Summary-mode output tests for goal_contract_create + dag_synthesize.
 *
 * GC-2026-063: the two orchestrator tools used to JSON.stringify the FULL
 * payload (complete goal contract / complete DAG incl. every task's full
 * `prompt`) into content[0].text — redundantly echoing input the LLM just
 * supplied and that is already persisted to .pi/orchestrator/*.yaml.
 *
 * These tools now return a compact `summary` by default, with the full
 * payload (`goal_contract` / `plan`) opt-in via `verbose: true`.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";

import {
  executeGoalContractCreate,
  summaryForGoal,
} from "@/tools/orchestrator/goal-contract.js";
import {
  executeDAGSynthesize,
  summaryForPlan,
} from "@/tools/orchestrator/dag-synthesizer.js";
import type { GoalContract, OrchestrationPlan, TaskNode } from "@/tools/orchestrator/types.js";

// ─── fixtures ───────────────────────────────────────────────────────────

function makeContract(): GoalContract {
  return {
    id: "GC-2026-063",
    title: "Test goal",
    rationale: "for summary-mode tests",
    success_criteria: [
      { id: "SC1", criterion: "typecheck passes", verification_cmd: "bun run typecheck" },
      { id: "SC2", criterion: "tests pass", verification_cmd: "bun test" },
      { id: "SC3", criterion: "lint passes", verification_cmd: "bun run lint" },
    ],
    anti_goals: ["don't break x", "don't add deps"],
    scope: { include: ["src/a.ts", "src/b.ts"], exclude: ["dist/"] },
    constraints: {},
    done_definition: "all gates green",
    created_at: "2026-01-01T00:00:00Z",
  };
}

function makeTask(
  id: string,
  batch: number,
  dependsOn: string[] = [],
  covers: string[] = ["SC1"],
  subagentType = "developer",
): TaskNode {
  return {
    id,
    description: `task ${id}`,
    plane: "Business",
    priority: "medium",
    depends_on: dependsOn,
    files: [],
    subagent_type: subagentType,
    batch,
    isolation: "current-workspace",
    tdd: "strict",
    prompt: `a sufficiently long prompt for ${id} to satisfy the min length`,
    output_schema: { kind: "code_changes" },
    acceptance: { covers },
    status: "pending",
    retry_count: 0,
    max_retries: 2,
  };
}

function makePlan(): OrchestrationPlan {
  return {
    id: "DAG-2026-063",
    goal_id: "GC-2026-063",
    title: "Test goal",
    tasks: [
      makeTask("P1", 1, [], ["SC1"], "developer"),
      makeTask("P2", 1, [], ["SC2"], "auditor"),
      makeTask("P3", 2, ["P1", "P2"], ["SC3"], "developer"),
    ],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    state: "approved",
    prompts: {},
  };
}

function goalParams(extra: Record<string, unknown> = {}) {
  return {
    id: "GC-2026-063",
    title: "Test goal",
    rationale: "for summary-mode tests",
    success_criteria: [
      { id: "SC1", criterion: "typecheck passes", verification_cmd: "bun run typecheck" },
      { id: "SC2", criterion: "tests pass", verification_cmd: "bun test" },
    ],
    anti_goals: ["don't break x"],
    scope: { include: ["src/"], exclude: ["dist/"] },
    constraints: {},
    done_definition: "all gates green",
    ...extra,
  };
}

function dagParams(extra: Record<string, unknown> = {}) {
  return {
    goal_id: "GC-2026-063",
    tasks: [
      {
        id: "P1",
        description: "implement p1",
        plane: "Business",
        priority: "high",
        depends_on: [],
        files: [],
        subagent_type: "developer",
        batch: 1,
        isolation: "current-workspace",
        tdd: "strict",
        prompt: "a sufficiently long prompt for p1 to satisfy the min length",
        output_schema: { kind: "code_changes" },
        acceptance: { covers: ["SC1"] },
      },
      {
        id: "P2",
        description: "verify p2",
        plane: "Business",
        priority: "high",
        depends_on: ["P1"],
        files: [],
        subagent_type: "auditor",
        batch: 2,
        isolation: "current-workspace",
        tdd: "none",
        prompt: "a sufficiently long prompt for p2 to satisfy the min length",
        output_schema: { kind: "verdict" },
        acceptance: { covers: ["SC2"] },
      },
    ],
    ...extra,
  };
}

const parse = (r: any) => JSON.parse(r.content[0].text);

// ─── summaryForGoal ─────────────────────────────────────────────────────

describe("summaryForGoal", () => {
  it("returns compact counts for every summary field", () => {
    expect(summaryForGoal(makeContract())).toEqual({
      id: "GC-2026-063",
      title: "Test goal",
      success_criteria: 3,
      anti_goals: 2,
      scope_include: 2,
      scope_exclude: 1,
    });
  });
});

// ─── summaryForPlan ─────────────────────────────────────────────────────

describe("summaryForPlan", () => {
  it("returns one entry per task with compact fields and correct batch_count", () => {
    const summary = summaryForPlan(makePlan());
    expect(summary.id).toBe("DAG-2026-063");
    expect(summary.goal_id).toBe("GC-2026-063");
    // max batch across P1(1), P2(1), P3(2) → 2
    expect(summary.batch_count).toBe(2);
    expect(summary.tasks).toHaveLength(3);
    expect(summary.tasks[0]).toEqual({
      id: "P1",
      description: "task P1",
      batch: 1,
      subagent_type: "developer",
      depends_on: [],
      covers: ["SC1"],
    });
    expect(summary.tasks[2]).toEqual({
      id: "P3",
      description: "task P3",
      batch: 2,
      subagent_type: "developer",
      depends_on: ["P1", "P2"],
      covers: ["SC3"],
    });
  });

  it("does not leak the full prompt into the summary", () => {
    const summary = summaryForPlan(makePlan());
    for (const t of summary.tasks as any[]) {
      expect(t.prompt).toBeUndefined();
      expect(t.files).toBeUndefined();
      expect(t.isolation).toBeUndefined();
    }
  });
});

// ─── executeGoalContractCreate ──────────────────────────────────────────

describe("executeGoalContractCreate summary mode", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "sages-goal-summary-"));
    mkdirSync(join(cwd, ".pi/orchestrator"), { recursive: true });
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("returns a summary and omits goal_contract by default", async () => {
    const r = parse(await executeGoalContractCreate(goalParams() as any, { cwd }));
    expect(r.status).toBe("in_progress");
    expect(r.summary).toEqual({
      id: "GC-2026-063",
      title: "Test goal",
      success_criteria: 2,
      anti_goals: 1,
      scope_include: 1,
      scope_exclude: 1,
    });
    expect(r.goal_contract).toBeUndefined();
    expect(r.goal_contract_path).toContain("goal-GC-2026-063.yaml");
    expect(r.next_step).toContain("dag_synthesize");
  });

  it("includes the full goal_contract when verbose: true", async () => {
    const r = parse(await executeGoalContractCreate(goalParams({ verbose: true }) as any, { cwd }));
    expect(r.summary).toBeDefined();
    expect(r.goal_contract).toBeDefined();
    expect(r.goal_contract.id).toBe("GC-2026-063");
    expect(r.goal_contract.success_criteria).toHaveLength(2);
    expect(r.goal_contract.scope.include).toEqual(["src/"]);
  });
});

// ─── executeDAGSynthesize ───────────────────────────────────────────────

describe("executeDAGSynthesize summary mode", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "sages-dag-summary-"));
    mkdirSync(join(cwd, ".pi/orchestrator"), { recursive: true });
    // Two-SC contract matching the two tasks in dagParams() (SC1, SC2).
    const contract: GoalContract = {
      ...makeContract(),
      success_criteria: [
        { id: "SC1", criterion: "typecheck passes", verification_cmd: "bun run typecheck" },
        { id: "SC2", criterion: "tests pass", verification_cmd: "bun test" },
      ],
    };
    writeFileSync(
      join(cwd, ".pi/orchestrator/goal-GC-2026-063.yaml"),
      yaml.dump(contract, { indent: 2, lineWidth: 120, noRefs: true }),
      "utf8",
    );
  });
  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it("returns a summary and omits plan by default", async () => {
    const r = parse(await executeDAGSynthesize(dagParams() as any, { cwd }));
    expect(r.status).toBe("in_progress");
    expect(r.summary).toBeDefined();
    expect(r.summary.id).toBe("DAG-2026-063");
    expect(r.summary.goal_id).toBe("GC-2026-063");
    expect(r.summary.batch_count).toBe(2);
    expect(r.summary.tasks).toHaveLength(2);
    expect(r.summary.tasks[0].covers).toEqual(["SC1"]);
    expect(r.plan).toBeUndefined();
    expect(r.plan_path).toContain("dag-DAG-2026-063.yaml");
    expect(r.next_step).toContain("task_dispatch");
  });

  it("includes the full plan when verbose: true", async () => {
    const r = parse(await executeDAGSynthesize(dagParams({ verbose: true }) as any, { cwd }));
    expect(r.summary).toBeDefined();
    expect(r.plan).toBeDefined();
    expect(r.plan.id).toBe("DAG-2026-063");
    expect(r.plan.tasks).toHaveLength(2);
    // verbose includes the full prompt on each task
    expect(r.plan.tasks[0].prompt).toContain("p1");
  });
});
