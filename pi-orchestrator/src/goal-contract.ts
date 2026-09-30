/**
 * Goal Contract Tool
 *
 * Stage 1 of orchestrator workflow: turn user intent into a verifiable contract.
 *
 * After GC-2026-orchestrator-simplify this tool no longer requires
 * `success_criteria[]` or `verification_cmd` — the Reviewer agent reads
 * the goal intent (title / rationale / scope / anti_goals / done_definition)
 * directly and evaluates the Implementer's output against it. The
 * orchestrator's pipeline driver (pi-tasks, or future workflow_run)
 * picks up the contract and runs the Implement → Review → optional Fix →
 * Merge sequence.
 *
 * Hard rules (enforced):
 *   1. anti_goals may be empty but not undefined
 *   2. done_definition must be non-empty (≥ 10 chars)
 *   3. id format must match the GC-<id> pattern
 *
 * Soft rules (LLM should satisfy, tool warns if missing):
 *   1. Title < 120 chars
 *   2. scope.include should be non-empty
 *   3. rationale recommended for anti-cheat traceability
 */

import { Type, type Static } from "typebox";
import * as yaml from "js-yaml";
import type { GoalContract } from "./types.js";
import {
	atomicWriteOrchestratorFile,
	isGoalContractState,
	loadYamlOrchestratorFile,
} from "./state-persistence.js";
import { wrapRegisteredTool } from "./registered-tool-wrapper.js";
import { RunEvent } from "./observability/events.js";
import { emitRunEvent } from "./observability/runner.js";

/** Tool input schema. */
export const GoalContractParams = Type.Object({
	id: Type.String({ description: "Stable id, e.g. 'GC-2025-001'", pattern: "^GC-[0-9a-zA-Z-]+$" }),
	title: Type.String({ description: "Short title (≤120 chars)", maxLength: 120 }),
	rationale: Type.Optional(Type.String({ description: "Why this goal exists" })),
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

	if (!input.done_definition.trim()) {
		errors.push("done_definition is empty");
	}

	if (input.done_definition.trim().length < 10) {
		errors.push("done_definition too short (min 10 chars)");
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

	if (!input.rationale || input.rationale.trim().length === 0) {
		warnings.push("rationale is empty — recommended for anti-cheat traceability");
	}

	return { valid: errors.length === 0, errors, warnings };
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
		// The hash covers all intent-relevant fields; editing any of them
		// invalidates the hash.
		lines.push(`_lock_hash: "${gc._lock_hash}"`);
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
	return {
		id: input.id,
		title: input.title,
		rationale: input.rationale,
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
 * sensitive to any scope / title / anti_goals / done_definition change.
 *
 * The locked contract is what gets serialized to disk. Any read
 * that wants to verify the lock should use `checkGoalLock` from
 * `./goal-lock.js`.
 */
export function buildLockedGoalContract(input: GoalContractInput): GoalContract & { _lock_hash: string } {
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
		anti_goals: contract.anti_goals.length,
		scope_include: contract.scope.include.length,
		scope_exclude: contract.scope.exclude.length,
	};
}

/**
 * Load a goal contract from disk. Returns null if file is missing or
 * malformed. Used by Reviewer agent (and future workflow_run) to read
 * the active intent contract.
 */
export function loadGoalContract(cwd: string, goalId: string): GoalContract | null {
	return loadYamlOrchestratorFile(cwd, `goal-${goalId}.yaml`, {
		owner: "orchestrator",
		validate: isGoalContractState as unknown as (value: unknown) => value is GoalContract,
	});
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
		intent: "Goal contract saved. Use pi-tasks directly: create 4 tasks (Implement / Review / optional Fix / Merge) with TaskCreate, then TaskExecute([Implement.id]) to start the pipeline. GC-2 will add a one-shot workflow_run tool.",
		validation: {
			errors: [],
			warnings: result.warnings,
			files_required: [path],
		},
		summary: summaryForGoal(contract),
		goal_contract_path: path,
		next_step:
			`TaskCreate({ subject: "Implement ${contract.id}", agentType: "Developer", description: "<goal content + implementation brief>", blocks: ["review"] }); ` +
			`TaskCreate({ subject: "Review ${contract.id}", agentType: "Auditor", blockedBy: ["implement"], description: "<read goal.yaml + implement output, return CLEAN or NEEDS_WORK>" }); ` +
			`TaskCreate({ subject: "Fix ${contract.id}", agentType: "Developer", blockedBy: ["review"], description: "<apply Reviewer findings; no-op if CLEAN>" }); ` +
			`TaskCreate({ subject: "Merge ${contract.id}", agentType: "Merger", blockedBy: ["fix"] }); ` +
			`TaskExecute(["implement"])`,
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
		description: "Stage 1: turn user intent into a verifiable contract. Writes .pi/orchestrator/goal-{id}.yaml. After saving, drive the Implement → Review → optional Fix → Merge pipeline via pi-tasks (TaskCreate × 4 + TaskExecute).",
		parameters: GoalContractParams,

		execute: wrapRegisteredTool<GoalContractInput, ReturnType<typeof executeGoalContractCreate>>(
			"goal_contract_create",
			(params, ctx) => executeGoalContractCreate(params, ctx),
		),
	});
}
