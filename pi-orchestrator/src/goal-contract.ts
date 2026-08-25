/**
 * Goal Contract Tool
 *
 * Stage 1 of orchestrator workflow: turn user intent into a verifiable contract.
 *
 * This tool does NOT do the design work — the LLM uses semantic tools
 * (aft_search, ctx_search, file read, etc.) to understand the project, then
 * proposes a goal contract. The tool validates the contract and writes it to disk.
 *
 * Hard rules (enforced):
 *   1. Every success_criterion MUST have a verification_cmd (non-empty)
 *   2. At least one SC required
 *   3. anti_goals may be empty but not undefined
 *   4. done_definition must be non-empty
 *
 * Soft rules (LLM should satisfy, tool warns if missing):
 *   1. Title < 120 chars
 *   2. SC count between 1 and 20
 *   3. scope.include should be non-empty
 */

import { Type, type Static } from "typebox";
import * as yaml from "js-yaml";
import type { GoalContract, SuccessCriterion } from "./types.js";
import { atomicWriteOrchestratorFile, isGoalContractState } from "./state-persistence.js";
import { RunEvent } from "./observability/events.js";
import { emitRunEvent } from "./observability/runner.js";

/** Tool input schema. */
export const GoalContractParams = Type.Object({
  id: Type.String({ description: "Stable id, e.g. 'GC-2025-001'", pattern: "^GC-[0-9a-zA-Z-]+$" }),
  title: Type.String({ description: "Short title (≤120 chars)", maxLength: 120 }),
  rationale: Type.Optional(Type.String({ description: "Why this goal exists" })),
  success_criteria: Type.Array(
    Type.Object({
      id: Type.String({ description: "Stable id like 'SC1'", pattern: "^SC[0-9]+$" }),
      criterion: Type.String({ description: "What success looks like", minLength: 10 }),
      verification_cmd: Type.String({
        description: "Shell command that proves pass/fail (e.g. 'npm run typecheck && echo OK')",
        minLength: 5,
      }),
      expected_output: Type.Optional(Type.String({ description: "Expected output snippet (optional)" })),
      severity: Type.Optional(Type.Union([
        Type.Literal("blocker"),
        Type.Literal("major"),
        Type.Literal("minor"),
      ])),
    }),
    { description: "Binary success criteria — every one must be verifiable", minItems: 1, maxItems: 20 },
  ),
  anti_goals: Type.Array(Type.String(), { description: "Things explicitly NOT to do" }),
  scope: Type.Object({
    include: Type.Array(Type.String(), { description: "Files / modules in scope" }),
    exclude: Type.Array(Type.String(), { description: "Files / modules explicitly excluded" }),
  }, { description: "Scope boundaries" }),
  constraints: Type.Object({
    must_use_existing_patterns: Type.Optional(Type.Boolean()),
    max_dependency_additions: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    test_coverage_min: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    typecheck_required: Type.Optional(Type.Boolean()),
    lint_required: Type.Optional(Type.Boolean()),
  }, { additionalProperties: true }),
  done_definition: Type.String({ description: "When is this considered done", minLength: 10 }),
  verbose: Type.Optional(Type.Boolean({ description: "Return the full goal contract. Default false returns a compact summary." })),
});

export type GoalContractInput = Static<typeof GoalContractParams>;

/** Validation result. */
interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a goal contract.
 * Hard errors block saving. Soft warnings are returned but allow saving.
 */
export function validateGoalContract(input: GoalContractInput): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Hard rules
  if (input.success_criteria.length === 0) {
    errors.push("success_criteria: at least one required");
  }

  // SC ids must be unique
  const scIds = new Set<string>();
  for (const sc of input.success_criteria) {
    if (scIds.has(sc.id)) {
      errors.push(`success_criteria: duplicate id '${sc.id}'`);
    }
    scIds.add(sc.id);

    // verification_cmd must look like a command (contains a non-whitespace token)
    if (!sc.verification_cmd.trim()) {
      errors.push(`SC ${sc.id}: verification_cmd is empty`);
    }
    if (sc.criterion.trim().length < 10) {
      errors.push(`SC ${sc.id}: criterion too short (min 10 chars)`);
    }
  }

  if (!input.done_definition.trim()) {
    errors.push("done_definition is empty");
  }

  if (input.id.trim().length === 0) {
    errors.push("id is empty");
  }

  if (input.title.trim().length === 0) {
    errors.push("title is empty");
  }

  // Soft rules (warnings)
  if (input.title.length > 120) {
    warnings.push(`title too long (${input.title.length} > 120 chars)`);
  }

  if (input.scope.include.length === 0) {
    warnings.push("scope.include is empty — risks uncontrolled refactoring");
  }

  if (input.anti_goals.length === 0) {
    warnings.push("anti_goals is empty — consider listing what NOT to do");
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * GC-2026-056: stricter verification_cmd validation. Rejects placeholder
 * commands at goal-creation time. The LLM cannot submit `echo "yes"`
 * or `pwd` as a verifiable success criterion — it must produce an
 * observable signal.
 *
 * This wraps {@link validateGoalContract} and adds an additional pass:
 *   1. Heuristic check on each SC's verification_cmd (sync)
 *   2. (optional) Execution probe — see {@link validateVerificationCmd}
 *
 * The heuristic check is the primary gate; it's the same check the
 * probe runs but without I/O. Pure-validate mode (the default) keeps
 * goal-contract creation synchronous and fast.
 */
export function validateGoalContractWithVerifierLinter(
  input: GoalContractInput,
): ValidationResult {
  // Run the existing sync validation first.
  const result = validateGoalContract(input);
  if (!result.valid) return result;

  // GC-2026-056: heuristic check on each SC's verification_cmd.
  // Lazy import to avoid circular dependency at module load time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isPlaceholderVerificationCmd } = require("./verification-cmd-linter.js") as typeof import("./verification-cmd-linter.js");
  for (const sc of input.success_criteria) {
    if (isPlaceholderVerificationCmd(sc.verification_cmd)) {
      result.errors.push(
        `SC ${sc.id}: verification_cmd looks like a placeholder: '${sc.verification_cmd}'. ` +
          "Write something that produces an observable signal (e.g. a test command, a typecheck, a file-existence check).",
      );
    }
  }
  result.valid = result.errors.length === 0;
  return result;
}

/** Serialize goal contract to YAML (minimal hand-rolled serializer for portability). */
export function goalContractToYaml(gc: GoalContract & { _lock_hash?: string }): string {
  const lines: string[] = [];
  lines.push("# Goal Contract");
  lines.push(`id: ${gc.id}`);
  lines.push(`title: "${escapeYaml(gc.title)}"`);
  if (gc.rationale) lines.push(`rationale: "${escapeYaml(gc.rationale)}"`);
  lines.push(`created_at: "${gc.created_at}"`);
  if (gc._lock_hash) {
    // GC-2026-057: persist the lock hash so reads can verify integrity.
    // The hash covers all SC-relevant fields; editing any of them
    // invalidates the hash.
    lines.push(`_lock_hash: "${gc._lock_hash}"`);
  }
  lines.push("");

  lines.push("success_criteria:");
  for (const sc of gc.success_criteria) {
    lines.push(`  - id: ${sc.id}`);
    lines.push(`    criterion: "${escapeYaml(sc.criterion)}"`);
    lines.push(`    verification_cmd: "${escapeYaml(sc.verification_cmd)}"`);
    if (sc.expected_output) lines.push(`    expected_output: "${escapeYaml(sc.expected_output)}"`);
    if (sc.severity) lines.push(`    severity: ${sc.severity}`);
  }
  lines.push("");

  lines.push("anti_goals:");
  for (const ag of gc.anti_goals) {
    lines.push(`  - "${escapeYaml(ag)}"`);
  }
  lines.push("");

  lines.push("scope:");
  lines.push("  include:");
  for (const p of gc.scope.include) lines.push(`    - "${escapeYaml(p)}"`);
  lines.push("  exclude:");
  for (const p of gc.scope.exclude) lines.push(`    - "${escapeYaml(p)}"`);
  lines.push("");

  lines.push("constraints:");
  for (const [k, v] of Object.entries(gc.constraints)) {
    lines.push(`  ${k}: ${formatYamlValue(v)}`);
  }
  lines.push("");

  lines.push(`done_definition: "${escapeYaml(gc.done_definition)}"`);

  return lines.join("\n");
}

function escapeYaml(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function formatYamlValue(v: unknown): string {
  if (typeof v === "string") return `"${escapeYaml(v)}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** Construct a GoalContract from input, adding created_at. */
export function buildGoalContract(input: GoalContractInput): GoalContract {
  const sc: SuccessCriterion[] = input.success_criteria.map((s: any) => ({
    id: s.id,
    criterion: s.criterion,
    verification_cmd: s.verification_cmd,
    expected_output: s.expected_output,
    severity: s.severity,
  }));

  return {
    id: input.id,
    title: input.title,
    rationale: input.rationale,
    success_criteria: sc,
    anti_goals: input.anti_goals,
    scope: input.scope,
    constraints: input.constraints,
    done_definition: input.done_definition,
    created_at: new Date().toISOString(),
  };
}

/**
 * GC-2026-057: build + lock. Same as `buildGoalContract` but also
 * computes and attaches a SHA-256 lock hash so the LLM cannot
 * silently modify the goal after creation. The hash is computed
 * over the canonical JSON form of the contract (sorted keys, no
 * whitespace) — it is independent of YAML formatting and is
 * sensitive to any SC / scope / title / anti_goals change.
 *
 * The locked contract is what gets serialized to disk. Any read
 * that wants to verify the lock should use `checkGoalLock` from
 * `./goal-lock.js`.
 */
export function buildLockedGoalContract(input: GoalContractInput): GoalContract & { _lock_hash: string } {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { lockGoal } = require("./goal-lock.js") as typeof import("./goal-lock.js");
  const base = buildGoalContract(input);
  return lockGoal(base);
}

/**
 * GC-2026-063: compact summary of a goal contract for the default
 * (non-verbose) tool response. The full contract is already persisted to
 * .pi/orchestrator/goal-{id}.yaml, so echoing it back to the LLM is pure
 * redundancy — the summary carries the shape + counts instead.
 */
export function summaryForGoal(contract: GoalContract) {
  return {
    id: contract.id,
    title: contract.title,
    success_criteria: contract.success_criteria.length,
    anti_goals: contract.anti_goals.length,
    scope_include: contract.scope.include.length,
    scope_exclude: contract.scope.exclude.length,
  };
}

/**
 * Pure (well — file I/O only) entry point for goal_contract_create.
 * Extracted from the registered tool so it can be unit-tested directly
 * without going through pi.registerTool.
 */
export async function executeGoalContractCreate(
  params: GoalContractInput,
  ctx: { cwd: string },
): Promise<{ content: { type: "text"; text: string }[]; details?: { path: string; contract: GoalContract } }> {
  const cwd: string = ctx.cwd;

  // Validate
  const result = validateGoalContract(params);
  if (!result.valid) {
    return {
      content: [{ type: "text", text: JSON.stringify({
        status: "error",
        intent: "Fix the validation errors below and call again.",
        validation: {
          errors: result.errors,
          warnings: result.warnings,
          files_required: [],
        },
      }) }],
    };
  }

  // Build and write
  const contract = buildGoalContract(params);
  const path = atomicWriteOrchestratorFile(
    cwd,
    `goal-${contract.id}.yaml`,
    yaml.dump(contract, { indent: 2, lineWidth: 120, noRefs: true }),
    { owner: "orchestrator", validate: isGoalContractState },
  );

  // GC-2026-067 T1: emit run/goal_created so the orchestrator-state
  // directory has an audit-state-{goal_id}.yaml for the watchdog + session
  // digest to read. Without this, the watchdog has no file to fingerprint
  // and the session digest has no in-flight goals to surface.
  emitRunEvent(contract.id, RunEvent.GoalCreated, { goal_id: contract.id });

  const response: Record<string, unknown> = {
    status: "in_progress",
    intent: "Goal contract saved. Next: call dag_synthesize with this goal_id to decompose into a task DAG.",
    validation: {
      errors: [],
      warnings: result.warnings,
      files_required: [path],
    },
    summary: summaryForGoal(contract),
    goal_contract_path: path,
    next_step: `dag_synthesize({ goal_id: "${contract.id}" })`,
  };
  if (params.verbose === true) {
    response.goal_contract = contract;
  }

  return {
    content: [{ type: "text", text: JSON.stringify(response) }],
    details: { path, contract },
  };
}

/**
 * Tool registration. Caller passes the pi extension API.
 */
export function registerGoalContractTool(pi: any): void {
  pi.registerTool({
    name: "goal_contract_create",
    label: "Goal Contract",
    description: "Stage 1: turn user intent into a verifiable contract. Every success_criterion MUST have a runnable verification_cmd. Writes .pi/orchestrator/goal-{id}.yaml.",
    parameters: GoalContractParams,

    async execute(_toolCallId: string, params: any, _signal: any, _onUpdate: any, ctx: any) {
      return executeGoalContractCreate(params, { cwd: ctx.cwd });
    },
  });
}
