/**
 * Task Dispatcher Tool
 *
 * Stage 3 of orchestrator workflow: turn an approved DAG into a dispatch plan.
 *
 * This tool does NOT spawn subagents directly — subagent spawning requires the
 * pi-subagents extension, which registers the `Agent` tool. The orchestrator's
 * job here is to:
 *   1. Load the DAG
 *   2. Group tasks by batch
 *   3. Return a structured dispatch plan that the LLM follows
 *   4. The LLM then uses the Agent tool (one call per task per batch) to actually spawn
 *
 * Why not spawn directly? Because:
 *   - The Agent tool is the pi-subagents-provided tool; we don't reimplement it
 *   - The LLM must be able to react to failures between batches (retry, replan)
 *   - Mid-run steering requires the LLM to be in the loop
 *
 * The dispatch plan contains:
 *   - Per-batch list of Agent tool calls (subagent_type, prompt, isolation, model)
 *   - Wait/check instructions between batches
 *   - Audit hooks (after each batch, the LLM should run orchestrator_audit)
 */

import { Type, type Static } from "typebox";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import type { OrchestrationPlan, TaskNode } from "./types.js";
import { ORCHESTRATOR_DIR, dagPath } from "./types.js";
import { loadPlan } from "./dag-synthesizer.js";

export const TaskDispatchParams = Type.Object({
  dag_id: Type.String({ description: "DAG id like 'DAG-2025-001'" }),
  strategy: Type.Union([
    Type.Literal("auto"),       // dispatch all batches sequentially, auto-audit between
    Type.Literal("step"),       // dispatch one batch at a time, wait for explicit next-call
    Type.Literal("review"),     // dispatch + require user approval between batches
  ], { description: "How aggressively to dispatch" }),
  /** Optional override: max parallel agents per batch (defaults to 4) */
  max_concurrent: Type.Optional(Type.Number({ minimum: 1, maximum: 16 })),
  /** Optional: force a re-dispatch even if plan already in executing state */
  force: Type.Optional(Type.Boolean()),
});

export type TaskDispatchInput = Static<typeof TaskDispatchParams>;

/** What the tool returns — structured instructions for the LLM to follow. */
export interface DispatchPlan {
  dag_id: string;
  strategy: "auto" | "step" | "review";
  batches: DispatchBatch[];
  total_tasks: number;
  estimated_total_turns: number;
  next_actions: string[];
}

export interface DispatchBatch {
  batch: number;
  tasks: DispatchTask[];
  /** True if all tasks in this batch can run in parallel */
  parallel_safe: boolean;
  /** Whether to require orchestrator_audit after this batch */
  audit_after: boolean;
}

export interface DispatchTask {
  task_id: string;
  subagent_type: string;
  prompt: string;
  isolation: "worktree" | "none";
  run_in_background: boolean;
  model?: string;
  thinking?: "low" | "medium" | "high" | "xhigh";
  /** How to wait for this task */
  wait_for: "completion" | "batch_completion" | "background";
  /** Where the report should be written */
  report_path: string;
}

/** Build the dispatch plan from a loaded DAG. Injects upstream task outputs into each task's prompt. */
export function buildDispatchPlan(
  plan: OrchestrationPlan,
  strategy: "auto" | "step" | "review",
  maxConcurrent: number = 4,
): DispatchPlan {
  // Group tasks by batch
  const byBatch = new Map<number, TaskNode[]>();
  for (const t of plan.tasks) {
    if (!byBatch.has(t.batch)) byBatch.set(t.batch, []);
    byBatch.get(t.batch)!.push(t);
  }

  // Index tasks by id for input injection lookup
  const taskById = new Map<string, TaskNode>();
  for (const t of plan.tasks) taskById.set(t.id, t);

  const sortedBatches = [...byBatch.keys()].sort((a, b) => a - b);
  const totalTasks = plan.tasks.length;
  const batches: DispatchBatch[] = [];

  for (let i = 0; i < sortedBatches.length; i++) {
    const batchNum = sortedBatches[i];
    const tasks = byBatch.get(batchNum)!;
    const isLastBatch = i === sortedBatches.length - 1;

    const dispatchTasks: DispatchTask[] = tasks.map(t => ({
      task_id: t.id,
      subagent_type: t.subagent_type,
      // Inject upstream task outputs into the prompt
      prompt: injectUpstreamOutputs(plan, taskById, t),
      isolation: t.isolation,
      run_in_background: true,
      wait_for: tasks.length > 1 ? "batch_completion" : "completion",
      report_path: `.pi/orchestrator/task-${t.id}-report.md`,
    }));

    const parallelSafe = dispatchTasks.length <= maxConcurrent;

    const auditAfter =
      strategy === "auto" ? true :
      strategy === "step" ? isLastBatch :
      isLastBatch;

    batches.push({
      batch: batchNum,
      tasks: dispatchTasks,
      parallel_safe: parallelSafe,
      audit_after: auditAfter,
    });
  }

  const estimatedTotalTurns = batches.length * 3 + 1;

  return {
    dag_id: plan.id,
    strategy,
    batches,
    total_tasks: totalTasks,
    estimated_total_turns: estimatedTotalTurns,
    next_actions: buildNextActions(batches, strategy),
  };
}

/**
 * Inject upstream task outputs into this task's prompt.
 * For each `inputs[i]`:
 *   - Find upstream task
 *   - Read its `output_path` (if set) from disk
 *   - Append a section to the prompt under "## Context from upstream: {field}"
 *
 * If upstream output is missing or unreadable, append a "[not yet available]" marker
 * (don't silently drop — subagent should know).
 */
function injectUpstreamOutputs(
  plan: OrchestrationPlan,
  taskById: Map<string, TaskNode>,
  task: TaskNode,
): string {
  const inputs = task.inputs;
  if (!inputs || inputs.length === 0) return task.prompt;

  const sections: string[] = [];
  for (const input of inputs) {
    const upstream = taskById.get(input.from_task);
    if (!upstream) {
      sections.push(`### Context from ${input.from_task} (${input.field})\n[upstream task not found in DAG]`);
      continue;
    }
    const outputPath = upstream.output_path;
    let content: string | null = null;
    if (outputPath) {
      // Try the path as-is first, then relative to the orchestrator dir.
      try {
        if (existsSync(outputPath)) {
          content = readFileSync(outputPath, "utf-8");
        } else if (existsSync(join(ORCHESTRATOR_DIR, outputPath))) {
          content = readFileSync(join(ORCHESTRATOR_DIR, outputPath), "utf-8");
        }
      } catch {
        content = null;
      }
    }

    if (content === null) {
      sections.push(`### Context from ${input.from_task} (${input.field})\n[upstream output not yet available at ${outputPath ?? "<no path>"}]`);
      continue;
    }

    if (input.embed === "summary" && content.length > 500) {
      content = content.slice(0, 500) + "\n... [truncated; full output at " + outputPath + "]";
    }

    sections.push(`### Context from ${input.from_task} (${input.field})\n\n${content}`);
  }

  return task.prompt + "\n\n---\n\n## Context from Upstream Tasks\n\n" + sections.join("\n\n");
}

function buildNextActions(batches: DispatchBatch[], strategy: string): string[] {
  const actions: string[] = [];
  if (strategy === "auto") {
    actions.push(`Dispatch batch 1 (${batches[0]?.tasks.length ?? 0} tasks in parallel)`);
    actions.push("Wait for batch 1 completion");
    actions.push("Run orchestrator_audit on batch 1 results");
    actions.push("Repeat for batches 2..N");
    actions.push("Final summary report");
  } else if (strategy === "step") {
    actions.push(`Dispatch batch 1 (${batches[0]?.tasks.length ?? 0} tasks)`);
    actions.push("Wait for completion, return to user for next-step decision");
  } else {
    actions.push(`Present batch 1 plan to user for approval`);
    actions.push(`After approval, dispatch batch 1`);
    actions.push("After batch 1, present results to user for next-batch approval");
  }
  return actions;
}

/**
 * Tool registration.
 */
export function registerTaskDispatcherTool(pi: any): void {
  pi.registerTool({
    name: "task_dispatch",
    label: "Task Dispatch",
    description: "Stage 3: build dispatch plan from approved DAG. Returns Agent tool calls per batch — LLM executes them. Does NOT spawn subagents directly.",
    parameters: TaskDispatchParams,

    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      const cwd: string = ctx.cwd;

      // Load DAG
      const plan = loadPlan(cwd, params.dag_id);
      if (!plan) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            intent: `DAG ${params.dag_id} not found. Run dag_synthesize first.`,
            validation: { errors: [`no DAG at ${dagPath(cwd, params.dag_id)}`] },
          }) }],
        };
      }

      // State guard: refuse to dispatch a completed/failed plan unless --force
      if ((plan.state === "completed" || plan.state === "failed") && !params.force) {
        return {
          content: [{ type: "text", text: JSON.stringify({
            status: "error",
            intent: `DAG ${plan.id} is in terminal state '${plan.state}'. Pass force:true to re-dispatch (will reset task statuses).`,
            validation: { errors: [`terminal state ${plan.state}`] },
          }) }],
        };
      }

      // Update plan state to executing
      plan.state = "executing";
      plan.updated_at = new Date().toISOString();

      // Build dispatch plan
      const dispatch = buildDispatchPlan(plan, params.strategy, params.max_concurrent ?? 4);

      // Persist updated plan (unified YAML format — same as planToYaml)
      const planPath = dagPath(cwd, plan.id);
      writeFileSync(planPath, yaml.dump(plan, { indent: 2, lineWidth: 120, noRefs: true }), "utf-8");

      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "in_progress",
          intent: "Dispatch plan ready. Execute each batch's Agent tool calls as described. After each batch, run orchestrator_audit before continuing.",
          validation: {
            errors: [],
            warnings: dispatch.batches.some(b => !b.parallel_safe)
              ? ["some batches exceed max_concurrent; tasks within will serialize"]
              : [],
            files_required: [planPath],
          },
          dispatch,
          plan_state: plan.state,
          next_step: `For batch 1: call Agent tool ${dispatch.batches[0]?.tasks.length ?? 0} times in one turn (parallel background), then orchestrator_audit({ dag_id: "${plan.id}", batch: 1 }).`,
        }) }],
        details: { dispatch, plan_path: planPath },
      };
    },
  });
}