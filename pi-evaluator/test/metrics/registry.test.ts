/**
 * test/metrics/registry.test.ts
 *
 * Unit tests for the metric registry: register / get / list / clear /
 * duplicate-throws semantics. Each test uses `clearMetrics` to reset state
 * (registry is module-scoped).
 */
import { afterEach, describe, expect, test } from "bun:test";
import {
	clearMetrics,
	getMetric,
	listMetricIds,
	registerMetric,
} from "../../src/metrics/registry.ts";
import type { Metric, MetricContext, MetricResult } from "../../src/metrics/types.ts";

function makeStub(id: string, dim: Metric["dim"]): Metric {
	return {
		id,
		dim,
		kind: "heuristic",
		description: `stub ${id}`,
		async compute(_input, _ctx): Promise<MetricResult> {
			return { value: 0, evidence: [], duration_ms: 0, data_missing: true };
		},
	};
}

afterEach(() => clearMetrics());

describe("MetricRegistry", () => {
	test("registerMetric stores the metric; getMetric retrieves it", () => {
		const m = makeStub("alpha", "goal");
		registerMetric(m);
		expect(getMetric("alpha")).toBe(m);
	});

	test("getMetric returns undefined for unknown id", () => {
		expect(getMetric("nope")).toBeUndefined();
	});

	test("registerMetric throws on duplicate id", () => {
		registerMetric(makeStub("dup", "dag"));
		expect(() => registerMetric(makeStub("dup", "implement"))).toThrow(
			"metric already registered: dup",
		);
	});

	test("listMetricIds returns registered ids sorted", () => {
		registerMetric(makeStub("zeta", "audit"));
		registerMetric(makeStub("alpha", "goal"));
		registerMetric(makeStub("mid", "dag"));
		expect(listMetricIds()).toEqual(["alpha", "mid", "zeta"]);
	});

	test("clearMetrics empties the registry", () => {
		registerMetric(makeStub("a", "goal"));
		registerMetric(makeStub("b", "dag"));
		clearMetrics();
		expect(listMetricIds()).toEqual([]);
		expect(getMetric("a")).toBeUndefined();
	});

	test("registerBuiltinMetrics is a no-op (T1 ships zero built-ins)", () => {
		// Should not throw, should leave the registry empty.
		registerBuiltinMetrics();
		expect(listMetricIds()).toEqual([]);
	});
});

// Late import for the no-op test (avoids the import-at-top from being unused otherwise).
import { registerBuiltinMetrics } from "../../src/metrics/registry.ts";
