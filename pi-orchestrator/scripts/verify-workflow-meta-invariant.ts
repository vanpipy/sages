#!/usr/bin/env bun
/**
 * verify-workflow-meta-invariant.ts — GC-2026-118 F3
 *
 * The task-feeder's `cascadeSpawn` skips tasks with
 * `metadata.workflow_run_goal_id` set (GC-2026-115 partition:
 * feeder cascades user / decompose tasks; workflow-handler cascades
 * workflow tasks with prior-Review summary injection).
 *
 * If a workflow-task spec builder forgets to stamp
 * `workflow_run_goal_id`, the workflow task would be picked up by
 * the feeder's cascade — the workflow-handler's summary injection
 * would never run, and the cascade would stall on the first phase.
 *
 * This verifier asserts that every spec builder in
 * `pi-tasks/src/workflow-graph.ts` (`buildStaticWorkflowGraph`,
 * `buildFixTaskSpec`, `buildRedesignImplementTaskSpec`) emits specs
 * with `metadata.workflow_run_goal_id` set.
 *
 * Approach: jiti-import the module, call each builder with a
 * minimal input, walk the `metadata` field. Failure mode: exit 1
 * with a numbered report naming the offending builder.
 *
 * Why runtime (vs static regex): the spec builders compose their
 * metadata via spread (`{ ...meta, phase: "..." }`) or via
 * destructured args (`workflow_run_goal_id` as a function parameter
 * → metadata field). A regex that checks for "workflow_run_goal_id
 * appears in function body" would pass even if the field is
 * silently dropped on the way to metadata. The runtime check
 * verifies the actual returned shape.
 */

import { resolve } from "node:path";
import { createJiti } from "jiti/static";

const PI_TASKS_WORKFLOW_GRAPH = resolve(
  import.meta.dir,
  "..",
  "..",
  "pi-tasks",
  "src",
  "workflow-graph.ts",
);

interface Finding {
  builder: string;
  subject: string;
  reason: string;
}

interface MinimalGoal {
  id: string;
  title: string;
  scope: { include: string[]; exclude: string[] };
  anti_goals: string[];
  done_definition: string;
}

const GOAL: MinimalGoal = {
  id: "GC-2026-verify-fixture",
  title: "verifier fixture",
  scope: { include: [], exclude: [] },
  anti_goals: [],
  done_definition: "verifier fixture",
};

function checkStatic(): Finding[] {
  const jiti = createJiti(import.meta.url, { default: true });
  const mod = jiti(PI_TASKS_WORKFLOW_GRAPH) as {
    buildStaticWorkflowGraph: (input: {
      goal: MinimalGoal;
      max_fix_iterations: number;
      workflow_run_goal_id: string;
      worktreePath: string;
      branch: string;
    }) => Array<{ subject: string; metadata: Record<string, unknown> }>;
  };
  const specs = mod.buildStaticWorkflowGraph({
    goal: GOAL,
    max_fix_iterations: 2,
    workflow_run_goal_id: GOAL.id,
    worktreePath: "/tmp/verify-fixture",
    branch: "verify-fixture",
  });
  const findings: Finding[] = [];
  for (const spec of specs) {
    if (spec.metadata.workflow_run_goal_id !== GOAL.id) {
      findings.push({
        builder: "buildStaticWorkflowGraph",
        subject: spec.subject,
        reason: `metadata.workflow_run_goal_id = ${JSON.stringify(spec.metadata.workflow_run_goal_id)} (expected ${JSON.stringify(GOAL.id)})`,
      });
    }
  }
  return findings;
}

function checkFix(): Finding[] {
  const jiti = createJiti(import.meta.url, { default: true });
  const mod = jiti(PI_TASKS_WORKFLOW_GRAPH) as {
    buildFixTaskSpec: (args: {
      goal: MinimalGoal;
      iteration: number;
      worktreePath: string;
      branch: string;
      reviewTaskId: string;
      nextReviewId?: string;
      workflow_run_goal_id: string;
    }) => { subject: string; metadata: Record<string, unknown> };
  };
  const spec = mod.buildFixTaskSpec({
    goal: GOAL,
    iteration: 1,
    worktreePath: "/tmp/verify-fixture",
    branch: "verify-fixture",
    reviewTaskId: "review-fixture",
    workflow_run_goal_id: GOAL.id,
  });
  if (spec.metadata.workflow_run_goal_id !== GOAL.id) {
    return [
      {
        builder: "buildFixTaskSpec",
        subject: spec.subject,
        reason: `metadata.workflow_run_goal_id = ${JSON.stringify(spec.metadata.workflow_run_goal_id)} (expected ${JSON.stringify(GOAL.id)})`,
      },
    ];
  }
  return [];
}

function checkRedesign(): Finding[] {
  const jiti = createJiti(import.meta.url, { default: true });
  const mod = jiti(PI_TASKS_WORKFLOW_GRAPH) as {
    buildRedesignImplementTaskSpec: (args: {
      goal: MinimalGoal;
      redesignNumber: number;
      worktreePath: string;
      branch: string;
      reviewTaskId: string;
      workflow_run_goal_id: string;
    }) => { subject: string; metadata: Record<string, unknown> };
  };
  const spec = mod.buildRedesignImplementTaskSpec({
    goal: GOAL,
    redesignNumber: 1,
    worktreePath: "/tmp/verify-fixture",
    branch: "verify-fixture",
    reviewTaskId: "review-fixture",
    workflow_run_goal_id: GOAL.id,
  });
  if (spec.metadata.workflow_run_goal_id !== GOAL.id) {
    return [
      {
        builder: "buildRedesignImplementTaskSpec",
        subject: spec.subject,
        reason: `metadata.workflow_run_goal_id = ${JSON.stringify(spec.metadata.workflow_run_goal_id)} (expected ${JSON.stringify(GOAL.id)})`,
      },
    ];
  }
  return [];
}

function main(): void {
  const findings = [
    ...checkStatic(),
    ...checkFix(),
    ...checkRedesign(),
  ];
  if (findings.length === 0) {
    console.log(
      "verify:workflow-meta-invariant: PASS (every workflow spec builder stamps workflow_run_goal_id)",
    );
    process.exit(0);
  }
  console.error(
    `verify:workflow-meta-invariant: FAIL (${findings.length} spec(s) missing workflow_run_goal_id)`,
  );
  for (const f of findings) {
    console.error(`  ${f.builder} [${f.subject}]: ${f.reason}`);
  }
  process.exit(1);
}

main();