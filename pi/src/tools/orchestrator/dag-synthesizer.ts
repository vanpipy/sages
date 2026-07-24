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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import type { GoalContract, OrchestrationPlan, TaskNode } from "./types.js";
import { ORCHESTRATOR_DIR, dagPath, goalContractPath } from "./types.js";
import { renderTaskPrompt, validateTemplateParams } from "./template-loader.js";

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
  isolation: Type.Union([Type.Literal("worktree"), Type.Literal("none")]),
  tdd: Type.Union([Type.Literal("strict"), Type.Literal("none")]),
  prompt: Type.String({ description: "Detailed prompt for subagent", minLength: 20 }),
  /** Optional: reference to a template under skills/orchestrator/templates/prompts/ */
  task_template: Type.Optional(Type.String({
    description: "Template name (e.g. 'subagent-software-developer') — when set, dag_synthesizer renders prompt from template + task_params instead of using the prompt field directly",
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
    covers: Type.Array(Type.String(), { description: "SC ids this task covers", minItems: 1 }),
    self_check_cmd: Type.Optional(Type.String()),
    auditor_check_cmd: Type.Optional(Type.String()),
  }),
});

export const DAGParams = Type.Object({
  goal_id: Type.String({ description: "Goal contract id (e.g. 'GC-2025-001')" }),
  tasks: Type.Array(TaskNodeSchema, { description: "TaskNode[] forming the DAG", minItems: 1, maxItems: 30 }),
  parallelism_notes: Type.Optional(Type.String({ description: "Why this batch design maximizes parallelism" })),
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

  // 3. Every SC must be covered
  const coveredSCs = new Set<string>();
  for (const t of input.tasks as any[]) {
    for (const sc of t.acceptance.covers) {
      coveredSCs.add(sc);
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

  // 5b. Validate task_template references (if set, must be a known template)
  const KNOWN_TEMPLATES = new Set([
    "subagent-software-developer",
    "subagent-software-auditor",
    "subagent-general-purpose",
    "subagent-explore",
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

  // 8. Subagent type referenced (soft check — warn if unknown)
  const knownSubagents = new Set([
    "general-purpose",
    "Explore",
    "Plan",
    "software-developer",
    "software-auditor",
  ]);
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
  const path = goalContractPath(cwd, goalId);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  return parseGoalContractYaml(raw);
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
  const path = dagPath(cwd, dagId);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  try {
    return yaml.load(raw) as OrchestrationPlan;
  } catch {
    return null;
  }
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
      const path = dagPath(cwd, plan.id);
      const dir = join(cwd, ORCHESTRATOR_DIR);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

      writeFileSync(path, planToYaml(plan), "utf-8");

      return {
        content: [{ type: "text", text: JSON.stringify({
          status: "in_progress",
          intent: "DAG saved. Next: call task_dispatch with this dag_id to begin execution.",
          validation: {
            errors: [],
            warnings: result.warnings,
            files_required: [path],
          },
          plan: plan,
          plan_path: path,
          next_step: `task_dispatch({ dag_id: "${plan.id}", strategy: "auto" })`,
        }) }],
        details: { path, plan },
      };
    },
  });
}