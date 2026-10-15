/**
 * phase-validation.ts — runtime validation of structured plans against
 * their declared intent_shape.
 *
 * The plan schema in `orchestrator-tool.ts` is STRUCTURED (intent_shape +
 * rationale + phases[]), but JSON Schema can only enforce per-field
 * types. The shape-specific RULES (e.g., "trivial → exactly 1 implement
 * phase", "standard → last phase is review") are runtime checks here.
 *
 * These rules are the load-bearing part of the orchestrator's planning
 * methodology: the LLM cannot satisfy the schema with a malformed plan.
 * Each rule returns a clear error message naming the violated rule + the
 * expected shape, so the LLM can fix the plan on retry.
 *
 * Source-of-truth role: this module is imported by `task_convert_intent`
 * in orchestrator-tool.ts. Tests in `convert-intent-tool.test.ts` exercise
 * each rule. Changes to the shape catalog here MUST be reflected in the
 * schema (orchestrator-tool.ts) and the SKILL.md reference table.
 */

import type { Static } from "typebox";
import type { ConvertIntentParams } from "./orchestrator-tool.js";

/** Mirrors the `intent_shape` union in `orchestrator-tool.ts`. */
export type IntentShape = Static<typeof ConvertIntentParams>["plan"]["intent_shape"];

/** Mirrors the `phase` union in `orchestrator-tool.ts`. */
export type Phase = Static<typeof ConvertIntentParams>["plan"]["phases"][number]["phase"];

/** Mirrors the `plan` object in `orchestrator-tool.ts`. */
export type PlanShape = Static<typeof ConvertIntentParams>["plan"];

/**
 * Thrown by the validators below. `rule` is a stable identifier the LLM
 * can match on; `message` is the human-readable explanation.
 */
export class PhaseValidationError extends Error {
	constructor(
		public readonly rule:
			| "rationale_too_short"
			| "rationale_too_long"
			| "phase_count_out_of_bounds"
			| "first_phase_mismatch"
			| "last_phase_mismatch"
			| "multiple_review_phases"
			| "trivial_shape_has_review"
			| "multi_track_too_few_implements"
			| "investigate_then_fix_no_implement"
			| "empty_phases",
		message: string,
	) {
		super(message);
		this.name = "PhaseValidationError";
	}
}

/** First phase required by each intent_shape. `"none"` = no constraint. */
const EXPECTED_FIRST_PHASE: Record<IntentShape, Phase | "none"> = {
	trivial: "implement",
	small: "implement",
	standard: "implement",
	"investigate-then-fix": "investigate",
	"multi-phase": "design",
	"multi-track": "implement",
};

/** Last phase required by each intent_shape. `"none"` = no constraint (multi-track defers the Reviewer to a separate intent). */
const EXPECTED_LAST_PHASE: Record<IntentShape, Phase | "none"> = {
	trivial: "implement",
	small: "review",
	standard: "review",
	"investigate-then-fix": "review",
	"multi-phase": "review",
	"multi-track": "none",
};

/** Min/max phase count required by each intent_shape. */
export const EXPECTED_PHASE_COUNT: Record<IntentShape, { min: number; max: number }> = {
	trivial: { min: 1, max: 1 },
	small: { min: 2, max: 2 },
	standard: { min: 2, max: 2 },
	"investigate-then-fix": { min: 3, max: 6 },
	"multi-phase": { min: 3, max: 8 },
	"multi-track": { min: 2, max: 10 },
};

/** Rationale length bounds. Mirrors the schema's minLength/maxLength. */
export const RATIONALE_MIN_LENGTH = 10;
export const RATIONALE_MAX_LENGTH = 500;

/**
 * Validate the rationale length. Throws PhaseValidationError with
 * `rule: "rationale_too_short"` or `"rationale_too_long"` on violation.
 *
 * Mirrors the schema's `minLength` / `maxLength` — defensive runtime
 * check that fires even when the schema isn't pre-validated (e.g., in
 * direct test calls that bypass the pi-coding-agent's validator).
 */
export function validateRationale(plan: PlanShape): void {
	const n = plan.rationale.length;
	if (n < RATIONALE_MIN_LENGTH) {
		throw new PhaseValidationError(
			"rationale_too_short",
			`Rationale MUST be ≥ ${RATIONALE_MIN_LENGTH} chars (one sentence justifying the chosen shape); got ${n}. ` +
				`Without a rationale the LLM hasn't committed to a shape choice — that's the bug.`,
		);
	}
	if (n > RATIONALE_MAX_LENGTH) {
		throw new PhaseValidationError(
			"rationale_too_long",
			`Rationale MUST be ≤ ${RATIONALE_MAX_LENGTH} chars (one sentence); got ${n}.`,
		);
	}
}

/**
 * Validate the running list of phases against a DECLARED intent_shape.
 * Used by `task_add_phase` for per-add checks (catches immediately-wrong
 * adds at the boundary, before a plan task is materialized).
 *
 * This is more permissive than `validatePlanShape` — it only catches
 * adds that are wrong RIGHT NOW. Incomplete states (e.g. a `standard`
 * intent with 1 implement phase) are accepted; the close-time
 * validator (`validatePlanShape` on the accumulated list) catches the
 * final-state issues (last-phase mismatch, min-count, etc.).
 *
 * Per-shape rules enforced here:
 *   - empty: rejected (caller must add at least one phase).
 *   - cap: phases.length > max → `phase_count_out_of_bounds`.
 *   - first phase: must match `EXPECTED_FIRST_PHASE[shape]`
 *     (skipped for shapes with no first-phase requirement).
 *   - trivial: must not include a `review` phase.
 *   - at most one `review` phase across the running list.
 *   - multi-track: at length ≥ 2, ALL phases must be `implement`
 *     (defer the Reviewer to a second intent).
 *
 * Caller wraps in ConvertIntentError("shape_violation", err.message).
 */
export function validateCumulativePhases(
	shape: IntentShape,
	accumulated: ReadonlyArray<Phase>,
): void {
	if (accumulated.length === 0) {
		throw new PhaseValidationError(
			"empty_phases",
			`Cumulative phase list is empty; the running list must contain at least one phase.`,
		);
	}

	const { min, max } = EXPECTED_PHASE_COUNT[shape];
	if (accumulated.length > max) {
		throw new PhaseValidationError(
			"phase_count_out_of_bounds",
			`Intent shape '${shape}' allows ≤ ${max} phases; got ${accumulated.length}. ` +
				`Close the intent or reclassify to a shape with a higher cap.`,
		);
	}

	// Trivial MUST NOT include a review phase. Check BEFORE the
	// first-phase rule so the LLM sees the most actionable error.
	if (shape === "trivial" && accumulated.includes("review")) {
		throw new PhaseValidationError(
			"trivial_shape_has_review",
			`Intent shape 'trivial' MUST NOT include a review phase; trivial edits skip the Reviewer. ` +
				`Re-classify as 'small' / 'standard' if a Reviewer is needed.`,
		);
	}

	// At most one review phase across the running list.
	const reviewCount = accumulated.filter((p) => p === "review").length;
	if (reviewCount > 1) {
		throw new PhaseValidationError(
			"multiple_review_phases",
			`Cumulative list contains multiple review phases (${reviewCount}); at most one review phase is allowed per intent. ` +
				`For multi-track Reviewers, convert a SECOND intent for the join.`,
		);
	}

	// First phase matches the shape's expected entry point.
	const expectedFirst = EXPECTED_FIRST_PHASE[shape];
	if (expectedFirst !== "none" && accumulated[0] !== expectedFirst) {
		throw new PhaseValidationError(
			"first_phase_mismatch",
			`Intent shape '${shape}' requires first phase '${expectedFirst}'; got '${accumulated[0]}'.`,
		);
	}

	// Last phase check: when the running list reaches the shape's
	// MAX count, the plan is "complete" (no more adds allowed) and the
	// last phase must match the shape's expected exit. Catches
	// "completed a plan wrong" at the moment of completion.
	//   - For min==max shapes (trivial / small / standard) this fires
	//     as soon as the list is at the cap — equivalent to "complete".
	//   - For min<max shapes (investigate-then-fix / multi-phase) this
	//     fires only at the cap; below the cap the user may still add
	//     more phases, so last-phase is not yet determined.
	//   - multi-track has no last-phase requirement (Reviewer is
	//     deferred to a second intent).
	const expectedLast = EXPECTED_LAST_PHASE[shape];
	if (expectedLast !== "none" && accumulated.length === max) {
		const last = accumulated[accumulated.length - 1];
		if (last !== expectedLast) {
			throw new PhaseValidationError(
				"last_phase_mismatch",
				`Intent shape '${shape}' requires last phase '${expectedLast}'; got '${last}'.`,
			);
		}
	}

	// Multi-track: at length ≥ 2, every phase must be `implement`.
	// (Single-implement is allowed by the cumulative validator; the
	// close-time check rejects it as not parallel.)
	if (shape === "multi-track" && accumulated.length >= 2) {
		const allImplement = accumulated.every((p) => p === "implement");
		if (!allImplement) {
			throw new PhaseValidationError(
				"multi_track_too_few_implements",
				`Intent shape 'multi-track' requires ALL phases to be 'implement' (parallel tracks); ` +
					`got [${accumulated.join(", ")}].`,
			);
		}
	}
}

/**
 * Validate that a structured plan obeys its declared intent_shape's
 * phase count + ordering rules. Throws PhaseValidationError with a
 * clear `rule` + `message` on violation.
 *
 * Caller wraps in ConvertIntentError("shape_violation", err.message).
 */
export function validatePlanShape(plan: PlanShape): void {
	const { intent_shape: shape, phases } = plan;

	// Rule: trivial shape MUST NOT include a review phase. Check BEFORE the
	// generic count rule so the LLM gets the most actionable message
	// (the count rule would otherwise fire first with a less-specific
	// error).
	if (shape === "trivial" && phases.some((p) => p.phase === "review")) {
		throw new PhaseValidationError(
			"trivial_shape_has_review",
			`Intent shape 'trivial' MUST NOT include a review phase; trivial edits skip the Reviewer. ` +
				`Re-classify as 'small' / 'standard' if a Reviewer is needed.`,
		);
	}

	// Rule: multi-track MUST have ≥ 2 implement phases (else it's not
	// parallel — reclassify as 'small' or 'standard'). Check BEFORE the
	// generic count rule so the LLM sees the actual constraint.
	if (shape === "multi-track") {
		const implementCount = phases.filter((p) => p.phase === "implement").length;
		if (implementCount < 2) {
			throw new PhaseValidationError(
				"multi_track_too_few_implements",
				`Intent shape 'multi-track' requires ≥ 2 implement phases (parallel tracks); got ${implementCount}. ` +
					`Re-classify as 'small' or 'standard' if the work isn't actually parallel.`,
			);
		}
	}

	// Rule: investigate-then-fix MUST have ≥ 1 implement phase (the fix).
	if (shape === "investigate-then-fix") {
		const implementCount = phases.filter((p) => p.phase === "implement").length;
		if (implementCount < 1) {
			throw new PhaseValidationError(
				"investigate_then_fix_no_implement",
				`Intent shape 'investigate-then-fix' requires ≥ 1 implement phase after the investigate; got ${implementCount}. ` +
					`The shape's whole point is "investigate, then FIX" — without a fix it's just an investigation.`,
			);
		}
	}

	// Rule: at most one review phase per plan. (The "Reviewer in the middle
	// without a reason" anti-pattern, plus the "no review at all on
	// production code" rule which the shape's last-phase requirement
	// picks up implicitly.)
	const reviewCount = phases.filter((p) => p.phase === "review").length;
	if (reviewCount > 1) {
		throw new PhaseValidationError(
			"multiple_review_phases",
			`Plan contains multiple review phases (${reviewCount}); at most one review phase is allowed per plan. ` +
				`For multi-track Reviewers, convert a SECOND intent for the join.`,
		);
	}

	// Rule: phase count bounds (catches the "pass 1 spec for a multi-package
	// migration" anti-pattern AND the "5+ specs for a one-line fix"
	// anti-pattern in one shot).
	const { min, max } = EXPECTED_PHASE_COUNT[shape];
	if (phases.length < min || phases.length > max) {
		throw new PhaseValidationError(
			"phase_count_out_of_bounds",
			`Intent shape '${shape}' requires ${min}–${max} phases; got ${phases.length}. ` +
				`Re-classify the intent or adjust the phase sequence.`,
		);
	}

	// Rule: first phase matches the shape's expected entry point.
	const expectedFirst = EXPECTED_FIRST_PHASE[shape];
	if (expectedFirst !== "none" && phases[0].phase !== expectedFirst) {
		throw new PhaseValidationError(
			"first_phase_mismatch",
			`Intent shape '${shape}' requires first phase '${expectedFirst}'; got '${phases[0].phase}'.`,
		);
	}

	// Rule: last phase matches. multi-track defers review to a second
	// intent (the join), so it has no last-phase requirement.
	const expectedLast = EXPECTED_LAST_PHASE[shape];
	if (expectedLast !== "none" && phases[phases.length - 1].phase !== expectedLast) {
		throw new PhaseValidationError(
			"last_phase_mismatch",
			`Intent shape '${shape}' requires last phase '${expectedLast}'; got '${phases[phases.length - 1].phase}'. ` +
				(shape === "multi-track"
					? `For multi-track, defer the Reviewer to a second intent once the parallel tracks complete.`
					: ``),
		);
	}
}
