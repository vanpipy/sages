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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import type { OrchestrationPlan, TaskNode } from "./types.js";
import { ORCHESTRATOR_DIR, dagPath } from "./types.js";
import { loadPlan } from "./dag-synthesizer.js";
import { atomicWriteOrchestratorFile, isOrchestrationPlanState } from "./state-persistence.js";
import { lookupSubagent } from "./subagent-registry.js";

export const TaskDispatchParams = Type.Object({
  dag_id: Type.String({ description: "DAG id like 'DAG-2025-001'" }),
  strategy: Type.Union([
    Type.Literal("auto"),       // dispatch all batches sequentially, auto-audit between
    Type.Literal("step"),       // dispatch one batch at a time, wait for explicit next-call
    Type.Literal("review"),     // dispatch + require user approval between batches
  ], { description: "How aggressively to dispatch" }),
  /** Optional override: max parallel agents per batch (defaults to 4) */
  max_concurrent: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 16,
      description:
        "Background concurrency cap for the dispatched batch. Default 6 matches the Sages-wide per-type cap budget (developer: 2 + auditor: 2 + Explore: 4 + Plan: 2 + merger: 1 + git-expert: 1 = 12 across types; 6 is the cross-type ceiling enforced by AgentManager).",
    }),
  ),
  /** Optional lifecycle observation. This records Agent results; it never spawns. */
  transition: Type.Optional(Type.Object({
    task_id: Type.String({ minLength: 1 }),
    status: Type.Union([Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("failed")]),
    agent_id: Type.Optional(Type.String({ minLength: 1 })),
    result: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
  })),
  /** Reset all task lifecycle fields before returning a fresh planner output. */
  force: Type.Optional(Type.Boolean()),
  /**
   * Return the full dispatch with task prompts. Default false returns a
   * compact summary (task_id/subagent_type/isolation/run_in_background/
   * prompt_preview).
   */
  verbose: Type.Optional(
    Type.Boolean({
      description:
        "Return full dispatch with task prompts. Default false returns a compact summary (task_id/subagent_type/isolation/run_in_background/prompt_preview).",
    }),
  ),
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
  /**
   * GC-2026-017 — isolation mode for the Agent tool. Main-agent dispatches
   * `developer` in three explicit modes:
   *
   *   - Worktree create / reuse object: the Agent dispatcher provisions a
   *     managed worktree (`mode: "create"` = new slot; `mode: "reuse"` =
   *     re-enter existing). `task_id` MUST match `DispatchTask.task_id`.
   *   - `"current-workspace"`: Agent tool runs the subagent in the
   *     parent's cwd with no worktree. Use for meta-files, single-line
   *     edits, and design-doc writes. The Agent tool enforces the
   *     policy; this layer only passes the literal through.
   *   - `undefined`: dispatched only for non-developer tasks. The
   *     developer's developer-special-case always assigns an explicit
   *     value (worktree-create default when the task omitted isolation,
   *     the object as-is when set, or `"current-workspace"` literally).
   *
   * `"none"` is preserved for backward compatibility with persisted DAGs
   * that use it (treated like omitted).
   */
  isolation?:
    | { dag_id: string; task_id: string; worktree_id?: string; mode: "create" | "reuse" }
    | "current-workspace"
    | "none";
  run_in_background: boolean;
  model?: string;
  thinking?: "low" | "medium" | "high" | "xhigh";
  /** How to wait for this task */
  wait_for: "completion" | "batch_completion" | "background";
  /** Where the report should be written */
  report_path: string;
}

/** Compact per-task summary returned by default (GC-2026-063). */
export interface DispatchTaskSummary {
  task_id: string;
  subagent_type: string;
  isolation: DispatchTask["isolation"];
  run_in_background: boolean;
  prompt_preview: string;
}

/** Compact dispatch plan returned by default (GC-2026-063). */
export interface DispatchPlanSummary {
  total_tasks: number;
  batches: Array<{
    batch: number;
    parallel_safe: boolean;
    tasks: DispatchTaskSummary[];
  }>;
}

const PROMPT_PREVIEW_CHARS = 120;

function previewPrompt(prompt: string): string {
  if (prompt.length <= PROMPT_PREVIEW_CHARS) return prompt;
  return prompt.slice(0, PROMPT_PREVIEW_CHARS) + "...";
}

/**
 * Reduce a full dispatch plan to a compact summary, dropping the full
 * task prompts (which the LLM already authored in dag_synthesize and are
 * persisted in .pi/orchestrator/dag-*.yaml).
 */
export function summarizeDispatch(dispatch: DispatchPlan): DispatchPlanSummary {
  return {
    total_tasks: dispatch.total_tasks,
    batches: dispatch.batches.map((batch) => ({
      batch: batch.batch,
      parallel_safe: batch.parallel_safe,
      tasks: batch.tasks.map((t) => ({
        task_id: t.task_id,
        subagent_type: t.subagent_type,
        isolation: t.isolation,
        run_in_background: t.run_in_background,
        prompt_preview: previewPrompt(t.prompt),
      })),
    })),
  };
}

/** Default dispatch policy comes from pi/subagents/registry.yaml. */
export function defaultRunInBackground(subagentType: string): boolean {
  const entry = lookupSubagent(subagentType);
  if (entry) return entry.run_in_background;
  // Unknown subagent: default to background to avoid surprises;
  // the LLM can always set run_in_background:false on the task.
  return true;
}

/** Build the dispatch plan from a loaded DAG. Injects upstream task outputs into each task's prompt. */
export function buildDispatchPlan(
  plan: OrchestrationPlan,
  strategy: "auto" | "step" | "review",
  maxConcurrent: number = 6,
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

    const dispatchTasks: DispatchTask[] = tasks.map(t => {
      // GC-2026-039: developer tasks declare which HANDOFF.md template
      // to use on exit. Render the choice into the prompt as a separate
      // line so the developer picks the right template. Non-developer
      // tasks ignore handoff_template (they don't write HANDOFF.md), so
      // we only inject for `subagent_type === "developer"`.
      const basePrompt = injectUpstreamOutputs(plan, taskById, t);
      const prompt =
        t.subagent_type === "developer"
          ? `${basePrompt}\n\nhandoff_template: ${t.handoff_template ?? "standard"}`
          : basePrompt;
      return {
        task_id: t.id,
        subagent_type: t.subagent_type,
        prompt,
      // GC-2026-017: developer-special-case resolution.
      //   1. `"current-workspace"` → pass the literal through (NEW).
      //   2. Object form → pass through as-is (covers both create + reuse).
      //   3. `"none"` / `undefined` / anything else → fall back to the
      //      worktree-create default so the Agent tool provisions a
      //      managed worktree.
      // Non-developer tasks leave isolation undefined; the Agent tool's
      // own policy decides what to do with no isolation for those roles.
      isolation:
        t.subagent_type === "developer"
          ? (t.isolation === "current-workspace"
              ? "current-workspace"
              : typeof t.isolation === "object" && t.isolation !== null
                ? t.isolation
                : { dag_id: plan.id, task_id: t.id, mode: "create" as const })
          : undefined,
      run_in_background: t.run_in_background ?? defaultRunInBackground(t.subagent_type),
      wait_for: tasks.length > 1 ? "batch_completion" : "completion",
      report_path: `.pi/orchestrator/task-${t.id}-report.md`,
      };
    });

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
      return executeTaskDispatch(params, { cwd: ctx.cwd });
    },
  });
}

function errorResponse(intent: string, errors: string[]): any {
  return { content: [{ type: "text", text: JSON.stringify({ status: "error", intent, validation: { errors } }) }] };
}

function savePlan(cwd: string, plan: OrchestrationPlan): string {
  return atomicWriteOrchestratorFile(
    cwd,
    `dag-${plan.id}.yaml`,
    yaml.dump(plan, { indent: 2, lineWidth: 120, noRefs: true }),
    { owner: "l3", validate: isOrchestrationPlanState },
  );
}

function resetTask(task: TaskNode): void {
  task.status = "pending";
  task.retry_count = 0;
  delete task.agent_id;
  delete task.result;
  delete task.output;
  delete task.output_path;
  delete task.error;
  delete task.started_at;
  delete task.completed_at;
  delete task.failed_at;
}

function transitionTask(plan: OrchestrationPlan, transition: any): { task?: TaskNode; error?: string } {
  const task = plan.tasks.find((candidate) => candidate.id === transition.task_id);
  if (!task) return { error: `task '${transition.task_id}' not found` };
  const next = transition.status as TaskNode["status"];
  if (task.status === next) return { error: `duplicate transition: task '${task.id}' is already ${next}` };
  const now = new Date().toISOString();

  if (next === "in_progress") {
    if (task.status !== "pending") return { error: `invalid transition ${task.status} -> in_progress for task '${task.id}'` };
    if (!transition.agent_id?.trim()) return { error: `in_progress transition for task '${task.id}' requires agent_id` };
    task.status = "in_progress";
    task.agent_id = transition.agent_id;
    task.started_at = now;
    delete task.completed_at;
    delete task.failed_at;
    delete task.error;
  } else if (next === "completed") {
    if (task.status !== "in_progress") return { error: `invalid transition ${task.status} -> completed for task '${task.id}'` };
    if (typeof transition.result !== "string" || !transition.result.trim()) return { error: `completed transition for task '${task.id}' requires result` };
    task.status = "completed";
    task.result = transition.result;
    task.output = transition.result;
    task.completed_at = now;
    delete task.error;
    delete task.failed_at;
  } else if (next === "failed") {
    if (task.status !== "in_progress") return { error: `invalid transition ${task.status} -> failed for task '${task.id}'` };
    if (typeof transition.error !== "string" || !transition.error.trim()) return { error: `failed transition for task '${task.id}' requires error` };
    task.status = "failed";
    task.error = transition.error;
    task.failed_at = now;
    task.completed_at = now;
    task.retry_count += 1;
  } else {
    return { error: `unsupported task status '${next}'` };
  }

  if (plan.tasks.every((candidate) => candidate.status === "completed" || candidate.status === "skipped")) {
    plan.state = "completed";
  } else if (plan.tasks.some((candidate) => candidate.status === "failed")) {
    plan.state = "failed";
  } else {
    plan.state = "executing";
  }
  plan.updated_at = now;
  return { task };
}

/**
 * Execute Stage 3 planning or record an externally observed Agent transition.
 * No code path invokes Agent: callers execute the returned plan themselves.
 */
export async function executeTaskDispatch(params: TaskDispatchInput, ctx: { cwd: string }): Promise<any> {
  const cwd = ctx.cwd;
  let plan: OrchestrationPlan | null;
  try {
    plan = loadPlan(cwd, params.dag_id);
  } catch (error) {
    return errorResponse(`DAG ${params.dag_id} is malformed or unsafe.`, [error instanceof Error ? error.message : String(error)]);
  }
  if (!plan) {
    return errorResponse(`DAG ${params.dag_id} not found. Run dag_synthesize first.`, [`no DAG at ${dagPath(cwd, params.dag_id)}`]);
  }

  if (params.transition) {
    const transitioned = transitionTask(plan, params.transition);
    if (transitioned.error) return errorResponse("Task lifecycle transition rejected.", [transitioned.error]);
    const planPath = savePlan(cwd, plan);
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: plan.state === "failed" ? "failed" : plan.state === "completed" ? "complete" : "in_progress",
        intent: `Recorded task ${transitioned.task!.id} transition to ${transitioned.task!.status}.`,
        validation: { errors: [], files_required: [planPath] },
        task: transitioned.task,
        plan_state: plan.state,
      }) }],
      details: { task: transitioned.task, plan_path: planPath },
    };
  }

  if (params.force) {
    for (const task of plan.tasks) resetTask(task);
    plan.state = "approved";
  } else if (plan.state === "executing") {
    return errorResponse(`DAG ${plan.id} already has an active dispatch plan.`, ["duplicate dispatch rejected; use force:true for a real reset"]);
  } else if (plan.state === "completed" || plan.state === "failed") {
    return errorResponse(
      `DAG ${plan.id} is in terminal state '${plan.state}'. Pass force:true to reset all task lifecycle state.`,
      [`terminal state ${plan.state}`],
    );
  }

  plan.state = "executing";
  plan.updated_at = new Date().toISOString();
  const dispatch = buildDispatchPlan(plan, params.strategy, params.max_concurrent ?? 6);
  const planPath = savePlan(cwd, plan);
  const verbose = params.verbose === true;
  return {
    content: [{ type: "text", text: JSON.stringify({
      status: "in_progress",
      intent: "Dispatch plan ready. Execute each batch's Agent tool calls as described; task_dispatch does not spawn.",
      validation: {
        errors: [],
        warnings: dispatch.batches.some((batch) => !batch.parallel_safe) ? ["some batches exceed max_concurrent; tasks within will serialize"] : [],
        files_required: [planPath],
      },
      dispatch: verbose ? dispatch : summarizeDispatch(dispatch),
      plan_state: plan.state,
      next_step: `For batch 1: call Agent tool ${dispatch.batches[0]?.tasks.length ?? 0} times, then record each lifecycle transition with task_dispatch.`,
    }) }],
    details: { dispatch, plan_path: planPath },
  };
}
