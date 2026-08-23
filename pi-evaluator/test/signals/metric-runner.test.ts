/**
 * test/signals/metric-runner.test.ts
 *
 * The runner is the seam between coefficients config (signal name) and
 * the metric registry. Tests:
 *   - unknown signal → data_missing=true, value=0, evidence points to coeffs
 *   - known signal → metric.compute() is called with signalCfg.with
 *   - signal result is forwarded verbatim (value, evidence, data_missing)
 */
import { afterEach, describe, expect, test } from "bun:test";
import { computeSignalValue } from "../../src/signals/metric-runner.ts";
import { clearMetrics, registerMetric } from "../../src/metrics/registry.ts";
import type { SignalConfig } from "../../src/engine/coefficients-schema.ts";
import type { Metric, MetricContext, MetricResult } from "../../src/metrics/types.ts";

afterEach(() => clearMetrics());

function makeMetric(id: string, value: number, dataMissing = false): Metric {
	return {
		id,
		dim: "goal",
		kind: "heuristic",
		description: `stub ${id}`,
		async compute(input, _ctx): Promise<MetricResult> {
			// Echo `with` into a known location so the test can assert it was forwarded.
			const payload = JSON.stringify(input);
			return {
				value,
				evidence: [{ artifact: "metric-input", location: payload, note: `stub ${id}` }],
				duration_ms: 1,
				data_missing: dataMissing,
			};
		},
	};
}

const baseCfg: SignalConfig = {
	weight: 0.5,
	norm: "ratio_0_1",
	direction: "higher_better",
};
const ctx: MetricContext = { cwd: "/tmp" };

describe("computeSignalValue (unknown signal)", () => {
	test("returns data_missing=true with value=0", async () => {
		const r = await computeSignalValue("missing", baseCfg, ctx);
		expect(r.data_missing).toBe(true);
		expect(r.value).toBe(0);
	});

	test("evidence points to coefficients.json with the missing name", async () => {
		const r = await computeSignalValue("missing", baseCfg, ctx);
		expect(r.evidence).toHaveLength(1);
		expect(r.evidence[0]?.artifact).toBe("coefficients.json");
		expect(r.evidence[0]?.location).toBe("missing");
	});
});

describe("computeSignalValue (known signal)", () => {
	test("metric.compute is called and result.value is forwarded", async () => {
		registerMetric(makeMetric("k", 0.73));
		const r = await computeSignalValue("k", baseCfg, ctx);
		expect(r.data_missing).toBe(false);
		expect(r.value).toBe(0.73);
	});

	test("signalCfg.with is forwarded into metric.compute input", async () => {
		let captured: unknown = undefined;
		const spy: Metric = {
			id: "spy",
			dim: "implement",
			kind: "heuristic",
			description: "spy",
			async compute(input) {
				captured = input;
				return { value: 0, evidence: [], duration_ms: 0, data_missing: false };
			},
		};
		registerMetric(spy);
		await computeSignalValue("spy", { ...baseCfg, with: { budgetPerTask: 30 } }, ctx);
		expect(captured).toEqual({ budgetPerTask: 30 });
	});

	test("missing with: defaults to empty object", async () => {
		let captured: unknown = "sentinel";
		const spy: Metric = {
			id: "spy2",
			dim: "coordination",
			kind: "heuristic",
			description: "spy2",
			async compute(input) {
				captured = input;
				return { value: 0, evidence: [], duration_ms: 0, data_missing: false };
			},
		};
		registerMetric(spy);
		await computeSignalValue("spy2", baseCfg, ctx);
		expect(captured).toEqual({});
	});

	test("metric returning data_missing=true propagates", async () => {
		registerMetric(makeMetric("mm", 0, true));
		const r = await computeSignalValue("mm", baseCfg, ctx);
		expect(r.data_missing).toBe(true);
		expect(r.value).toBe(0);
	});
});
