/**
 * pi-evaluator/test/integration/scoring-pipeline.test.ts
 *
 * End-to-end scoring pipeline test. Loads the
 * `fixtures/workflow-scoring-1/.pi/orchestrator/` fixture and runs `scoreWorkflow`
 * with a custom coefficients config that enables only the 5 heuristic + hybrid
 * metrics (weight = 1) and disables the 2 LLM-only metrics (weight = 0). The
 * hybrid metrics fall back to their heuristic branches (the LLM judge is
 * installed but no API key is available in CI → seam returns data_missing →
 * heuristic branch wins).
 *
 * Expected scores (within ±5 tolerance):
 *   - coordination: ~11  (step_efficiency low — windows have 9 / 0 / 1 calls)
 *   - implement:    ~94  (argument_correctness 1/18 errors = 94)
 *   - dag:          ~100 (plan_adherence perfect)
 *   - audit:        ~100 (goal_accuracy heuristic — CERTIFIED + workflowReady)
 *
 * Implementation, Coordination dims: the dim-level score depends on the
 * per-signal mix. With only 1 signal enabled per dim and weight=1, the dim
 * score = the signal's value * 100.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { scoreWorkflow, globalScore } from "../../src/engine/scoring-engine.ts";
import type { CoefficientsConfig } from "../../src/engine/coefficients-schema.ts";
import { registerBuiltinMetrics } from "../../src/metrics/registry.ts";
import { setJudgeFn } from "../../src/metrics/llm-judge/seam.ts";

// Register all 7 metrics (3 heuristic + 2 hybrid + 2 LLM-only) once for the
// whole file. The judge is set to null so hybrid + LLM-only metrics fall back
// to their heuristic branches / data_missing respectively — the integration
// test then exercises only the heuristic paths.
beforeAll(() => {
	setJudgeFn(null);
	registerBuiltinMetrics();
});

const FIXTURE_PATH = resolve(
	import.meta.dir,
	"../../fixtures/workflow-scoring-1/.pi/orchestrator",
);

const cwd = FIXTURE_PATH;

/**
 * Coefficients config with ONLY the 5 heuristic/hybrid metrics enabled.
 * LLM-only metrics (plan_quality, tool_use) at weight 0.
 * Goal/dag/audit/coordination dims use existing structural signals at weight 0
 * so dim score = only the agentic metric contributes.
 */
function heuristicOnlyCoefficients(): CoefficientsConfig {
	const base = (norm: "ratio_0_1", direction: "higher_better", weight: number) => ({
		weight,
		norm,
		direction,
	});
	return {
		version: "0.3.0",
		global: {
			dimension_weights: {
				goal: 0.0,
				dag: 0.5,
				implement: 0.4,
				audit: 0.0,
				coordination: 0.1,
			},
			thresholds: { pass: 80, pass_with_gaps: 50 },
		},
		dimensions: {
			goal: {
				signals: {
					sc_verifiable_pct: { ...base("ratio_0_1", "higher_better", 1.0) },
				},
			},
			dag: {
				signals: {
					plan_adherence: { ...base("ratio_0_1", "higher_better", 1.0) },
				},
			},
			implement: {
				signals: {
					argument_correctness: {
						weight: 1.0,
						norm: "ratio_0_1",
						direction: "lower_better",
					},
				},
			},
			audit: {
				signals: {
					goal_accuracy: { ...base("ratio_0_1", "higher_better", 1.0) },
				},
			},
			coordination: {
				signals: {
					step_efficiency: { ...base("ratio_0_1", "higher_better", 1.0) },
				},
			},
		},
	};
}

beforeEach(() => setJudgeFn(null));
afterEach(() => setJudgeFn(null));

describe("scoring pipeline (end-to-end)", () => {
	test("scoreWorkflow runs against the scoring-1 fixture without errors", async () => {
		const coefs = heuristicOnlyCoefficients();
		const scores = await scoreWorkflow(FIXTURE_PATH, coefs, cwd);
		expect(scores).toBeDefined();
		expect(scores.goal).toBeDefined();
		expect(scores.dag).toBeDefined();
		expect(scores.implement).toBeDefined();
		expect(scores.audit).toBeDefined();
		expect(scores.coordination).toBeDefined();
	});

	test("plan_adherence scores high (all task reports cover their SCs)", async () => {
		const coefs = heuristicOnlyCoefficients();
		const scores = await scoreWorkflow(FIXTURE_PATH, coefs, cwd);
		// T1 covers [SC1], T2 covers [SC2,SC3], T3 covers [SC1,SC2,SC3]
		// Each task report mentions every SC id in its covers.
		expect(scores.dag.score).toBeGreaterThanOrEqual(95);
	});

	test("goal_accuracy heuristic scores 100 on CERTIFIED + workflowReady:true", async () => {
		const coefs = heuristicOnlyCoefficients();
		const scores = await scoreWorkflow(FIXTURE_PATH, coefs, cwd);
		expect(scores.audit.score).toBe(100);
	});

	test("argument_correctness: 1/18 errors → high score (≈94, lower_better inverted)", async () => {
		const coefs = heuristicOnlyCoefficients();
		const scores = await scoreWorkflow(FIXTURE_PATH, coefs, cwd);
		// 1 error out of 18 toolResult blocks = 0.056 error rate.
		// After direction=lower_better: 1 - 0.056 = 0.944 → score 94.
		expect(scores.implement.score).toBeGreaterThanOrEqual(85);
		expect(scores.implement.score).toBeLessThanOrEqual(99);
	});

	test("step_efficiency: low (3 windows, 9/0/1 calls → low average saturation)", async () => {
		const coefs = heuristicOnlyCoefficients();
		const scores = await scoreWorkflow(FIXTURE_PATH, coefs, cwd);
		// 3 windows: ratio 0.3, 0, 0.033 → average ≈ 0.111 → score 11.
		// Direction=higher_better means lower score is WORSE — we want step efficiency
		// to be GOOD when turns are low, so the metric is inverted via norm.
		// T1 ships step_efficiency as "lower turns = better"; default direction=higher_better
		// means the engine treats LOW raw value as high score. Raw 0.111 (low) → score 11.
		expect(scores.coordination.score).toBeLessThanOrEqual(20);
	});

	test("globalScore aggregates per-dim scores with dimension_weights", async () => {
		const coefs = heuristicOnlyCoefficients();
		const scores = await scoreWorkflow(FIXTURE_PATH, coefs, cwd);
		const total = globalScore(scores, coefs);
		expect(total).toBeGreaterThanOrEqual(0);
		expect(total).toBeLessThanOrEqual(100);
	});

	test("evidence arrays are populated for metric observations", async () => {
		const coefs = heuristicOnlyCoefficients();
		const scores = await scoreWorkflow(FIXTURE_PATH, coefs, cwd);
		// argument_correctness emits per-tool evidence refs.
		// argument_correctness is in `implement` dim.
		expect(scores.implement.evidence.length).toBeGreaterThan(0);
	});
});

describe("scoring pipeline (lazy eval-score path)", () => {
	test("computeEvalScore self-cooks from active_workflow_path", async () => {
		// Lazy path test: set up EvalState with workflow_path but no workflow,
		// then call computeEvalScore. It should self-cook via scoreWorkflow.
		const { computeEvalScore } = await import("../../src/tools/eval-score.ts");
		const { createEvalState } = await import("../../src/state.ts");
		const state = createEvalState();
		state.mode = "on";
		state.coefficients = heuristicOnlyCoefficients(); // override DEFAULT so we see real scores
		state.active_workflow_path = FIXTURE_PATH;
		state.active_workflow_id = "GC-scoring-1";
		const out = await computeEvalScore(state);
		console.log("DEBUG lazy:", JSON.stringify(out.dimensions, null, 2));
		expect(out.status).toBe("ok");
		expect(out.workflow_id).toBe("GC-scoring-1");
		expect(out.total_score).toBeGreaterThan(0);
		expect(out.dimensions.audit.score).toBe(100); // goal_accuracy CERTIFIED heuristic
	});
});
