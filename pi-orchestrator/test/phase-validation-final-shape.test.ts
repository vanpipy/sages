/**
 * phase-validation-final-shape.test.ts —
 *
 * Unit tests for the lower-level `validateFinalShape` helper. This
 * helper exists so `task_close_intent` can validate the accumulated
 * phase list (a `Phase[]`) without synthesizing placeholder
 * `subject`/`description` strings for the structured `PlanShape`
 * required by `validatePlanShape`.
 *
 * Contract parity: every rule `validatePlanShape` enforces on the
 * structured `PlanShape` MUST be duplicated here on the primitive
 * `Phase[] + rationale` shape. If a rule is added to
 * `validatePlanShape`, add it here too (or refactor `validatePlanShape`
 * to delegate here).
 */

import { describe, expect, it } from "bun:test";
import {
	PhaseValidationError,
	type Phase,
	validateFinalShape,
} from "../src/phase-validation.js";

const VALID_RATIONALE =
	"Standard Implement → Review shape; one Reviewer at the end of a multi-file change.";

describe("validateFinalShape", () => {
	describe("phase count bounds", () => {
		it("trivial: 1 phase passes", () => {
			expect(() => validateFinalShape("trivial", ["implement"], VALID_RATIONALE)).not.toThrow();
		});
		it("trivial: 0 phases fails (phase_count_out_of_bounds)", () => {
			try {
				validateFinalShape("trivial", [], VALID_RATIONALE);
				expect.unreachable();
			} catch (err) {
				expect((err as PhaseValidationError).rule).toBe("phase_count_out_of_bounds");
			}
		});
		it("trivial: 2 phases fails (phase_count_out_of_bounds)", () => {
			try {
				validateFinalShape("trivial", ["implement", "implement"], VALID_RATIONALE);
				expect.unreachable();
			} catch (err) {
				expect((err as PhaseValidationError).rule).toBe("phase_count_out_of_bounds");
			}
		});
		it("small: exactly 2 phases passes", () => {
			expect(() =>
				validateFinalShape("small", ["implement", "review"], VALID_RATIONALE),
			).not.toThrow();
		});
		it("small: 1 phase fails", () => {
			expect(() => validateFinalShape("small", ["implement"], VALID_RATIONALE)).toThrow(
				PhaseValidationError,
			);
		});
		it("investigate-then-fix: 3 phases passes", () => {
			expect(() =>
				validateFinalShape(
					"investigate-then-fix",
					["investigate", "implement", "review"],
					VALID_RATIONALE,
				),
			).not.toThrow();
		});
		it("investigate-then-fix: 2 phases fails (no minimum-fixes shape)", () => {
			expect(() =>
				validateFinalShape(
					"investigate-then-fix",
					["investigate", "review"],
					VALID_RATIONALE,
				),
			).toThrow(PhaseValidationError);
		});
	});

	describe("first-phase rule", () => {
		it("multi-phase: design-first passes", () => {
			expect(() =>
				validateFinalShape(
					"multi-phase",
					["design", "implement", "test", "review"],
					VALID_RATIONALE,
				),
			).not.toThrow();
		});
		it("multi-phase: implement-first fails (first_phase_mismatch)", () => {
			try {
				validateFinalShape(
					"multi-phase",
					["implement", "test", "design", "review"],
					VALID_RATIONALE,
				);
				expect.unreachable();
			} catch (err) {
				expect((err as PhaseValidationError).rule).toBe("first_phase_mismatch");
			}
		});
		it("investigate-then-fix: investigate-first is mandatory", () => {
			try {
				validateFinalShape(
					"investigate-then-fix",
					["implement", "implement", "review"],
					VALID_RATIONALE,
				);
				expect.unreachable();
			} catch (err) {
				expect((err as PhaseValidationError).rule).toBe("first_phase_mismatch");
			}
		});
	});

	describe("last-phase rule", () => {
		it("standard: review-last passes", () => {
			expect(() =>
				validateFinalShape(
					"standard",
					["implement", "review"],
					VALID_RATIONALE,
				),
			).not.toThrow();
		});
		it("standard: implement-last fails (last_phase_mismatch)", () => {
			try {
				validateFinalShape(
					"standard",
					["implement", "implement"],
					VALID_RATIONALE,
				);
				expect.unreachable();
			} catch (err) {
				expect((err as PhaseValidationError).rule).toBe("last_phase_mismatch");
			}
		});
		it("multi-track: any last-phase passes (no last-phase requirement)", () => {
			expect(() =>
				validateFinalShape(
					"multi-track",
					["implement", "implement", "implement"],
					VALID_RATIONALE,
				),
			).not.toThrow();
		});
	});

	describe("review-phase rules", () => {
		it("trivial: rejects any review phase (trivial_shape_has_review)", () => {
			try {
				validateFinalShape("trivial", ["review"], VALID_RATIONALE);
				expect.unreachable();
			} catch (err) {
				expect((err as PhaseValidationError).rule).toBe("trivial_shape_has_review");
			}
		});
		it("multi-phase: rejects 2+ review phases (multiple_review_phases)", () => {
			try {
				validateFinalShape(
					"multi-phase",
					["design", "review", "test", "review"],
					VALID_RATIONALE,
				);
				expect.unreachable();
			} catch (err) {
				expect((err as PhaseValidationError).rule).toBe("multiple_review_phases");
			}
		});
	});

	describe("multi-track implement-count rule", () => {
		it("multi-track: < 2 implements fails (multi_track_too_few_implements)", () => {
			try {
				validateFinalShape("multi-track", ["implement"], VALID_RATIONALE);
				expect.unreachable();
			} catch (err) {
				expect((err as PhaseValidationError).rule).toBe("multi_track_too_few_implements");
			}
		});
		it("multi-track: exactly 2 implements passes", () => {
			expect(() =>
				validateFinalShape(
					"multi-track",
					["implement", "implement"],
					VALID_RATIONALE,
				),
			).not.toThrow();
		});
	});

	describe("investigate-then-fix implement-count rule", () => {
		it("investigate-then-fix: 0 implements fails (investigate_then_fix_no_implement)", () => {
			// Hits the count rule first since 0 phases is too few, but with
			// the min count met (3) and zero implements the rule fires.
			try {
				validateFinalShape(
					"investigate-then-fix",
					["investigate", "test", "review"],
					VALID_RATIONALE,
				);
				expect.unreachable();
			} catch (err) {
				expect((err as PhaseValidationError).rule).toBe(
					"investigate_then_fix_no_implement",
				);
			}
		});
		it("investigate-then-fix: ≥ 1 implement passes", () => {
			expect(() =>
				validateFinalShape(
					"investigate-then-fix",
					["investigate", "implement", "test", "review"],
					VALID_RATIONALE,
				),
			).not.toThrow();
		});
	});

	describe("rationale length is delegated to validateRationale", () => {
		it("rationale_too_short: rationale < 10 chars fails", () => {
			try {
				validateFinalShape("standard", ["implement", "review"], "short");
				expect.unreachable();
			} catch (err) {
				expect((err as PhaseValidationError).rule).toBe("rationale_too_short");
			}
		});
		it("rationale_too_long: rationale > 500 chars fails", () => {
			try {
				validateFinalShape("standard", ["implement", "review"], "x".repeat(501));
				expect.unreachable();
			} catch (err) {
				expect((err as PhaseValidationError).rule).toBe("rationale_too_long");
			}
		});
	});

	describe("the helper accepts what callers actually have", () => {
		it("takes a primitive Phase[] (no subject / description required)", () => {
			// This is the bug-fix surface: previously `task_close_intent`
			// had to synthesize `{ phase, subject: '_', description: '_' }`
			// placeholders to call the structured `validatePlanShape`.
			const phases: Phase[] = ["implement", "review"];
			expect(() => validateFinalShape("standard", phases, VALID_RATIONALE)).not.toThrow();
		});
	});
});
