/**
 * DAG Synthesizer Tool
 *
 * Stage 2 of orchestrator workflow: turn a goal contract into a TaskNode DAG.
 *
 * This tool does NOT generate the tasks — the LLM does, by:
 *   1. Reading the goal contract from .pi/orchestrator/goal-{id}.yaml
 *   2. Using aft_search / codebase_search to discover code structure
 *   3. Using ctx_search to query past experiences (if relevant)
 *   4. Proposing a DAG that covers every SC
 *
 * The tool validates the proposed DAG and writes it to disk.
 *
 * Hard validation rules:
 *   1. Every GoalContract.success_criterion MUST be covered by ≥1 TaskNode.acceptance.covers
 *   2. No circular dependencies (topological order exists)
 *   3. Batch numbers must form a contiguous sequence starting at 1
 *   4. depends_on references must exist in the task set
 *   5. Tasks within the same batch must have no inter-dependencies
 */

import { Type, type Static } from "typebox";
import * as yaml from "js-yaml";
import type { GoalContract, OrchestrationPlan, TaskNode } from "./types.js";
import {
  atomicWriteOrchestratorFile,
  isGoalContractState,
  isOrchestrationPlanState,
  loadYamlOrchestratorFile,
} from "./state-persistence.js";
import { renderTaskPrompt, validateTemplateParams } from "./template-loader.js";
import { knownSubagentIds } from "./subagent-registry.js";

export const TaskNodeSchema = Type.Object({
  id: Type.String({ description: "Semantic id like 'P1', 'P2.a'", pattern: "^[A-Z][0-9]+(\\.[a-z])?$" }),
  description: Type.String({ description: "What this task accomplishes", minLength: 5 }),
  plane: Type.Union([
    Type.Literal("Business"),
    Type.Literal("Data"),
    Type.Literal("Control"),
    Type.Literal("Foundation"),
    Type.Literal("Observation"),
    Type.Literal("Security"),
    Type.Literal("Evolution"),
  ]),
  priority: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
  depends_on: Type.Array(Type.String(), { description: "Task ids this depends on" }),
  files: Type.Array(Type.String(), { description: "Files this task touches" }),
  subagent_type: Type.String({ description: "Subagent role to dispatch to" }),
  batch: Type.Number({ description: "Concurrency group (1-based, contiguous)", minimum: 1 }),
  isolation: Type.Optional(Type.Union([
    Type.Literal("none"),
    Type.Literal("current-workspace"), // GC-2026-017: parent-cwd mode (no worktree)
    Type.Object({
      dag_id: Type.String(),
      task_id: Type.String(),
      worktree_id: Type.Optional(Type.String()),
      mode: Type.Union([Type.Literal("create"), Type.Literal("reuse")]),
    }),
  ])),
  tdd: Type.Union([Type.Literal("strict"), Type.Literal("none")]),
  /**
   * Optional per-task override for the dispatcher's `run_in_background`
   * policy. When omitted, the dispatcher derives a default from
   * `subagent_type` (Explore/Plan = foreground, developer/auditor =
   * background). Set this when a specific task needs the opposite
   * of its subagent-type default.
   */
  run_in_background: Type.Optional(Type.Boolean({ description: "Override the subagent-type default for run_in_background" })),
  /**
   * GC-2026-039: which HANDOFF.md template the developer uses on exit.
   * Only meaningful when `subagent_type === "developer"` — auditor /
   * Explore / Plan don't write HANDOFF.md, so the field is ignored.
   * The dispatcher defaults missing values to "standard".
   */
  handoff_template: Type.Optional(Type.Union([
    Type.Literal("standard"),
    Type.Literal("phase-gate"),
    Type.Literal("escalation"),
  ], { description: "Which HANDOFF.md template the developer uses (Standard / Phase Gate / Escalation). Defaults to 'standard' at dispatch time." })),
  prompt: Type.String({ description: "Detailed prompt for subagent", minLength: 20 }),
  /** Optional: reference to a template under skills/orchestrator/templates/prompts/ */
  task_template: Type.Optional(Type.String({
    description: "Template name (e.g. 'subagent-developer') — when set, dag_synthesizer renders prompt from template + task_params instead of using the prompt field directly",
  })),
  /** Parameters passed to the task_template renderer */
  task_params: Type.Optional(Type.Object({}, { additionalProperties: true })),
  /**
   * Upstream task inputs — at dispatch time, each upstream task's output is
   * read and embedded in the subagent's prompt.
   */
  inputs: Type.Optional(Type.Array(Type.Object({
    from_task: Type.String({ description: "Task id whose output to read" }),
    field: Type.String({ description: "Logical field name (e.g. 'findings', 'design')" }),
    embed: Type.Optional(Type.Union([Type.Literal("inline"), Type.Literal("summary")])),
  }), { description: "Upstream task outputs to inject into this task's prompt" })),
  output_schema: Type.Object({
    kind: Type.Union([
      Type.Literal("file_list"),
      Type.Literal("design_doc"),
      Type.Literal("code_changes"),
      Type.Literal("test_results"),
      Type.Literal("verdict"),
    ]),
    path: Type.Optional(Type.String()),
    fields: Type.Optional(Type.Array(Type.String())),
  }),
  acceptance: Type.Object({
    /**
     * SC ids this task covers. Required for tasks that satisfy goal
     * contract SCs (developer, auditor); Explore/Plan/research tasks
     * can omit this — they contribute to the workflow but don't
     * directly satisfy any SC. validateDAG still requires every SC
     * to be covered by at least one task that DOES declare covers.
     */
    covers: Type.Optional(Type.Array(Type.String(), { description: "SC ids this task covers" })),
    self_check_cmd: Type.Optional(Type.String()),
    auditor_check_cmd: Type.Optional(Type.String()),
  }),
});

export const DAGParams = Type.Object({
  goal_id: Type.String({ description: "Goal contract id (e.g. 'GC-2025-001')" }),
  tasks: Type.Array(TaskNodeSchema, { description: "TaskNode[] forming the DAG", minItems: 1, maxItems: 30 }),
  parallelism_notes: Type.Optional(Type.String({ description: "Why this batch design maximizes parallelism" })),
  verbose: Type.Optional(Type.Boolean({ description: "Return the full plan (with task prompts). Default false returns a task summary." })),
});

export type DAGInput = Static<typeof DAGParams>;

interface DAGValidation {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate the proposed DAG against the goal contract.
 */
export function validateDAG(input: DAGInput, contract: GoalContract): DAGValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  const taskIds = new Set<string>();
  const referencedIds = new Set<string>();

  // 1. Duplicate task ids
  for (const t of input.tasks as any[]) {
    if (taskIds.has(t.id)) {
      errors.push(`duplicate task id '${t.id}'`);
    }
    taskIds.add(t.id);
  }

  // 2. depends_on references must exist
  for (const t of input.tasks as any[]) {
    for (const dep of t.depends_on) {
      referencedIds.add(dep);
      if (!taskIds.has(dep)) {
        errors.push(`task '${t.id}' depends on non-existent '${dep}'`);
      }
    }
  }

  // 3. Every SC must be covered by at least one task that declares
  //    acceptance.covers (tasks that omit covers are research-only and
  //    don't directly satisfy any SC).
  const coveredSCs = new Set<string>();
  for (const t of input.tasks as any[]) {
    if (Array.isArray(t.acceptance?.covers)) {
      for (const sc of t.acceptance.covers) {
        coveredSCs.add(sc);
      }
    }
  }
  for (const sc of contract.success_criteria) {
    if (!coveredSCs.has(sc.id)) {
      errors.push(`SC '${sc.id}' not covered by any task's acceptance.covers`);
    }
  }

  // 4. No circular dependencies (simple DFS cycle detection)
  const adj = new Map<string, string[]>();
  for (const t of input.tasks) adj.set(t.id, t.depends_on);
  if (hasCycle(adj)) {
    errors.push("DAG contains a cycle");
  }

  // 5. Batch numbers contiguous from 1
  const batches = new Set<number>();
  for (const t of input.tasks) batches.add(t.batch);
  const sortedBatches = [...batches].sort((a, b) => a - b);
  for (let i = 0; i < sortedBatches.length; i++) {
    if (sortedBatches[i] !== i + 1) {
      errors.push(`batch numbers must be contiguous starting at 1; got [${sortedBatches.join(", ")}]`);
      break;
    }
  }

  // 5b. Validate task_template references (if set, must be a known template).
  //
  // GC-2026-014: the canonical templates are `subagent-developer` and
  // `subagent-auditor`. The legacy `subagent-software-developer` and
  // `subagent-software-auditor` spellings are NOT advertised here — they
  // are rejected as unknown templates. Persisted DAGs that still carry
  // the legacy names fail validation.
  //
  // GC-2026-030: `subagent-git-expert` is added so DAGs can dispatch
  // the senior-git-operator subagent (read-only on production code;
  // writes only in `.pi/git-scratch-<task_id>-<suffix>/`). The legacy
  // subagent_type `git-expert` path is still available for ad-hoc
  // `Agent(...)` calls without going through this whitelist.
  const KNOWN_TEMPLATES = new Set([
    "subagent-developer",
    "subagent-auditor",
    "subagent-explore",
    "subagent-git-expert",
  ]);
  for (const t of input.tasks as any[]) {
    if (t.task_template && !KNOWN_TEMPLATES.has(t.task_template)) {
      errors.push(`task '${t.id}': task_template '${t.task_template}' is not a known template (allowed: ${[...KNOWN_TEMPLATES].join(", ")})`);
    }
    // Validate task_params if task_template is set
    if (t.task_template && KNOWN_TEMPLATES.has(t.task_template)) {
      const paramCheck = validateTemplateParams(t.task_template, t.task_params ?? {});
      if (!paramCheck.valid) {
        errors.push(`task '${t.id}': task_params invalid: ${paramCheck.errors.join("; ")}`);
      }
    }
  }

  // 6. Within-batch independence — no two tasks in the same batch can depend on each other
  const byBatch = new Map<number, TaskNode[]>();
  for (const t of input.tasks as any[]) {
    if (!byBatch.has(t.batch)) byBatch.set(t.batch, []);
    byBatch.get(t.batch)!.push(t);
  }
  for (const [batch, tasks] of byBatch) {
    const ids = new Set(tasks.map(t => t.id));
    for (const t of tasks) {
      for (const dep of t.depends_on) {
        if (ids.has(dep)) {
          errors.push(`batch ${batch}: task '${t.id}' depends on '${dep}' in same batch (must depend on earlier batch)`);
        }
      }
    }
  }

  // 7. Cross-batch dependency direction: a task in batch N can only depend on tasks in batch < N
  const taskToBatch = new Map<string, number>();
  for (const t of input.tasks as any[]) taskToBatch.set(t.id, t.batch);
  for (const t of input.tasks as any[]) {
    for (const dep of t.depends_on) {
      const depBatch = taskToBatch.get(dep);
      if (depBatch !== undefined && depBatch >= t.batch) {
        errors.push(`task '${t.id}' (batch ${t.batch}) depends on '${dep}' (batch ${depBatch}); must depend on earlier batch`);
      }
    }
  }

  // 8. Known subagent types come from pi/subagents/registry.yaml.
  const knownSubagents = knownSubagentIds();
  for (const t of input.tasks as any[]) {
    if (!knownSubagents.has(t.subagent_type)) {
      warnings.push(`task '${t.id}': subagent_type '${t.subagent_type}' is not a known role — verify ~/.pi/agent/agents/${t.subagent_type}.md exists`);
    }
  }

  // 9. Soft checks
  const totalBatches = sortedBatches.length;
  if (totalBatches > 10) {
    warnings.push(`${totalBatches} batches may slow orchestration; consider merging trivial tasks`);
  }

  return { valid: errors.length === 0, errors, warnings };
}

function hasCycle(adj: Map<string, string[]>): boolean {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const k of adj.keys()) color.set(k, WHITE);

  function dfs(node: string): boolean {
    color.set(node, GRAY);
    for (const dep of adj.get(node) || []) {
      const c = color.get(dep) ?? WHITE;
      if (c === GRAY) return true; // back edge
      if (c === WHITE && dfs(dep)) return true;
    }
    color.set(node, BLACK);
    return false;
  }

  for (const node of adj.keys()) {
    if (color.get(node) === WHITE) {
      if (dfs(node)) return true;
    }
  }
  return false;
}

/** Build OrchestrationPlan from input + contract. Renders task_template prompts when set. */
export function buildPlan(input: DAGInput, contract: GoalContract): OrchestrationPlan {
  const now = new Date().toISOString();
  const tasks: TaskNode[] = (input.tasks as any[]).map((t: any) => {
    // If task_template is set, render the prompt from template + params.
    // Otherwise use the LLM-written prompt field as-is.
    let prompt = t.prompt;
    if (t.task_template) {
      const rendered = renderTaskPrompt(t.task_template, t.task_params ?? {});
      if (rendered) {
        prompt = rendered;
      }
      // If template not found, fall back to LLM-written prompt with a warning
      // logged at validation time (see dag_synthesizer tool handler).
    }
    return {
      ...t,
      prompt,
      status: "pending",
      retry_count: 0,
      max_retries: 2,
    };
  });
  const prompts: Record<string, string> = {};
  for (const t of tasks) prompts[t.id] = t.prompt;

  return {
    id: `DAG-${input.goal_id.replace(/^GC-/, "")}`,
    goal_id: contract.id,
    title: contract.title,
    tasks,
    created_at: now,
    updated_at: now,
    state: "approved",
    prompts,
  };
}

/** Serialize plan to YAML using js-yaml (proper escaping). */
export function planToYaml(plan: OrchestrationPlan): string {
  // js-yaml.dump handles all escaping (strings with ", :, #, newlines, etc.)
  // Round-trip safe: dump → load → identical object.
  return yaml.dump(plan, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,  // preserve logical field order
  });
}

/** Load a goal contract from disk. */
export function loadGoalContract(cwd: string, goalId: string): GoalContract | null {
  return loadYamlOrchestratorFile(cwd, `goal-${goalId}.yaml`, {
    owner: "l3",
    validate: isGoalContractState as unknown as (value: unknown) => value is GoalContract,
  });
}

/** Parse a goal contract YAML, with a clean error if malformed. */
export function parseGoalContractYaml(raw: string): GoalContract {
  try {
    return yaml.load(raw) as GoalContract;
  } catch (err) {
    throw new Error(
      `Failed to parse goal contract YAML. ` +
      `Ensure the file was written by goal_contract_create. ` +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/** Load a plan from disk. Returns null if file is missing or malformed. */
export function loadPlan(cwd: string, dagId: string): OrchestrationPlan | null {
  return loadYamlOrchestratorFile(cwd, `dag-${dagId}.yaml`, {
    owner: "l3",
    validate: isOrchestrationPlanState as unknown as (value: unknown) => value is OrchestrationPlan,
  });
}

/**
 * GC-2026-063: compact summary of a plan for the default (non-verbose)
 * tool response. The full plan (incl. every task's `prompt`) is already
 * persisted to .pi/orchestrator/dag-{id}.yaml, so echoing it back to the
 * LLM is pure redundancy.
 */
export function summaryForPlan(plan: OrchestrationPlan) {
  return {
    id: plan.id,
    goal_id: plan.goal_id,
    batch_count: plan.tasks.reduce((max, t) => Math.max(max, t.batch), 0),
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      description: t.description,
      batch: t.batch,
      subagent_type: t.subagent_type,
      depends_on: t.depends_on,
      covers: t.acceptance?.covers ?? [],
    })),
  };
}

/**
 * Pure (well — file I/O only) entry point for dag_synthesize.
 * Extracted from the registered tool so it can be unit-tested directly
 * without going through pi.registerTool.
 */
export async function executeDAGSynthesize(
  params: DAGInput,
  ctx: { cwd: string },
): Promise<{ content: { type: "text"; text: string }[]; details?: { path: string; plan: OrchestrationPlan } }> {
  const cwd: string = ctx.cwd;

  // Load goal contract
  const contract = loadGoalContract(cwd, params.goal_id);
  if (!contract) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        intent: `Goal contract ${params.goal_id} not found. Run goal_contract_create first.`,
        validation: { errors: ["goal contract not found — create it with goal_contract_create"] },
      }) }],
    };
  }

  // Validate DAG
  const result = validateDAG(params, contract);
  if (!result.valid) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        intent: "Fix DAG errors and re-call.",
        validation: { errors: result.errors, warnings: result.warnings, files_required: [] },
      }) }],
    };
  }

  // Build plan and write
  const plan = buildPlan(params, contract);
  const path = atomicWriteOrchestratorFile(cwd, `dag-${plan.id}.yaml`, planToYaml(plan), {
    owner: "l3",
    validate: isOrchestrationPlanState,
  });

  const response: Record<string, unknown> = {
    status: "in_progress",
    intent: "DAG saved. Next: call task_dispatch with this dag_id to begin execution.",
    validation: {
      errors: [],
      warnings: result.warnings,
      files_required: [path],
    },
    summary: summaryForPlan(plan),
    plan_path: path,
    next_step: `task_dispatch({ dag_id: "${plan.id}", strategy: "auto" })`,
  };
  if (params.verbose === true) {
    response.plan = plan;
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response) }],
    details: { path, plan },
  };
}

/**
 * Tool registration.
 */
export function registerDAGSynthesizerTool(pi: any): void {
  pi.registerTool({
    name: "dag_synthesize",
    label: "DAG Synthesize",
    description: "Stage 2: decompose goal into TaskNode DAG. Hard-validates: every SC covered, no cycles, batches contiguous, cross-batch deps only. Writes .pi/orchestrator/dag-{id}.yaml.",
    parameters: DAGParams,

    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      return executeDAGSynthesize(params, { cwd: ctx.cwd });
    },
  });
}
