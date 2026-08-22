/**
 * test/engine/scoring-engine.test.ts
 *
 * Pure tests for the scoring engine: per-dim weighted-sum, norm/direction
 * table, data_missing exclusion. Mocks the metric layer by registering
 * stub metrics whose `value` is deterministic per signal name.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { scoreDimension, scoreWorkflow, globalScore } from "../../src/engine/scoring-engine.ts";
import {
	clearMetrics,
	getMetric,
	registerBuiltinMetrics,
	registerMetric,
} from "../../src/metrics/registry.ts";
import type { Metric, MetricContext, MetricResult } from "../../src/metrics/types.ts";
import type { CoefficientsConfig } from "../../src/engine/coefficients-schema.ts";

afterEach(() => clearMetrics());

function makeMetric(id: string, value: number, dataMissing = false): Metric {
	return {
		id,
		dim: "implement",
		kind: "heuristic",
		description: `stub ${id}`,
		async compute(): Promise<MetricResult> {
			return { value, evidence: [], duration_ms: 0, data_missing: dataMissing };
		},
	};
}

const ctx: MetricContext = { cwd: "/tmp" };

describe("scoreDimension", () => {
	test("weighted sum of non-data_missing signals", async () => {
		// Two signals, weights 0.4 + 0.6, values 0.5 + 0.8. Expected score = round((0.5*0.4 + 0.8*0.6)/1.0 * 100) = 68.
		registerMetric(makeMetric("a", 0.5));
		registerMetric(makeMetric("b", 0.8));
		const dim = await scoreDimension(
			{
				a: { weight: 0.4, norm: "ratio_0_1", direction: "higher_better" },
				b: { weight: 0.6, norm: "ratio_0_1", direction: "higher_better" },
			},
			ctx,
		);
		expect(dim.score).toBe(68);
	});

	test("data_missing signals are excluded from weighted sum", async () => {
		// Three signals, weights 0.2 + 0.3 + 0.5. middle one is data_missing.
		// Expected: (0.0*0.2 + 0.7*0.5) / 0.7 = 0.5 → 50.
		registerMetric(makeMetric("a", 0.0));
		registerMetric(makeMetric("b", 0, true));
		registerMetric(makeMetric("c", 0.7));
		const dim = await scoreDimension(
			{
				a: { weight: 0.2, norm: "ratio_0_1", direction: "higher_better" },
				b: { weight: 0.3, norm: "ratio_0_1", direction: "higher_better" },
				c: { weight: 0.5, norm: "ratio_0_1", direction: "higher_better" },
			},
			ctx,
		);
		expect(dim.score).toBe(50);
	});

	test("all data_missing → score=0 with weightTotal=0", async () => {
		registerMetric(makeMetric("a", 0.5, true));
		const dim = await scoreDimension(
			{
				a: { weight: 1.0, norm: "ratio_0_1", direction: "higher_better" },
			},
			ctx,
		);
		expect(dim.score).toBe(0);
	});
});

describe("scoreWorkflow", () => {
	test("returns 5 dimensions, all keyed by name", async () => {
		const cfg: CoefficientsConfig = {
			version: "0.3.0",
			global: {
				dimension_weights: { goal: 0.2, dag: 0.2, implement: 0.3, audit: 0.2, coordination: 0.1 },
				thresholds: { pass: 80, pass_with_gaps: 50 },
			},
			dimensions: {
				goal: { signals: { a: { weight: 1, norm: "ratio_0_1", direction: "higher_better" } } },
				dag: { signals: { a: { weight: 1, norm: "ratio_0_1", direction: "higher_better" } } },
				implement: { signals: { a: { weight: 1, norm: "ratio_0_1", direction: "higher_better" } } },
				audit: { signals: { a: { weight: 1, norm: "ratio_0_1", direction: "higher_better" } } },
				coordination: { signals: { a: { weight: 1, norm: "ratio_0_1", direction: "higher_better" } } },
			},
		};
		const out = await scoreWorkflow("/x", cfg, "/tmp");
		expect(Object.keys(out).sort()).toEqual([
			"audit",
			"coordination",
			"dag",
			"goal",
			"implement",
		]);
	});

	test("direction=lower_better flips the value", async () => {
		// value=0.2 with lower_better → 1-0.2 = 0.8 → 80
		registerMetric(makeMetric("a", 0.2));
		const dim = await scoreDimension(
			{ a: { weight: 1, norm: "ratio_0_1", direction: "lower_better" } },
			ctx,
		);
		expect(dim.score).toBe(80);
	});

	test("norm=boolean maps <0.5 to 0, ≥0.5 to 1", async () => {
		registerMetric(makeMetric("yes", 0.7));
		registerMetric(makeMetric("no", 0.3));
		const yes = await scoreDimension(
			{ yes: { weight: 1, norm: "boolean", direction: "higher_better" } },
			ctx,
		);
		const no = await scoreDimension(
			{ no: { weight: 1, norm: "boolean", direction: "higher_better" } },
			ctx,
		);
		expect(yes.score).toBe(100);
		expect(no.score).toBe(0);
	});
});

describe("globalScore", () => {
	test("weighted sum of per-dim scores using global.dimension_weights", () => {
		const cfg: CoefficientsConfig = {
			version: "0.3.0",
			global: {
				dimension_weights: { goal: 0.2, dag: 0.2, implement: 0.3, audit: 0.2, coordination: 0.1 },
				thresholds: { pass: 80, pass_with_gaps: 50 },
			},
			dimensions: { goal: { signals: {} }, dag: { signals: {} }, implement: { signals: {} }, audit: { signals: {} }, coordination: { signals: {} } },
		};
		const dims = {
			goal: { score: 100, evidence: [] },
			dag: { score: 100, evidence: [] },
			implement: { score: 0, evidence: [] },
			audit: { score: 0, evidence: [] },
			coordination: { score: 0, evidence: [] },
		};
		// 100*(0.2+0.2+0) = 40
		expect(globalScore(dims, cfg)).toBe(40);
	});
});

// Quiet "unused import" if a test above is commented out
void getMetric;
void registerBuiltinMetrics;
