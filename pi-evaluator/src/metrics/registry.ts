/**
 * pi-evaluator/src/metrics/registry.ts
 *
 * Module-scoped metric registry. `registerMetric` is called from each
 * metric's own module on import; `registerBuiltinMetrics` is called from
 * the extension on session_start and aggregates all imports in one place.
 *
 * Duplicate id registration throws — that's intentional, it surfaces typos
 * at startup. Tests use `clearMetrics` to reset between cases.
 */
import type { Metric } from "./types.ts";

const REGISTRY = new Map<string, Metric>();

export function registerMetric(m: Metric): void {
	if (REGISTRY.has(m.id)) {
		throw new Error(`metric already registered: ${m.id}`);
	}
	REGISTRY.set(m.id, m);
}

export function getMetric(id: string): Metric | undefined {
	return REGISTRY.get(id);
}

export function listMetricIds(): string[] {
	return [...REGISTRY.keys()].sort();
}

/** Test-only — clears the entire registry. Production code never calls this. */
export function clearMetrics(): void {
	REGISTRY.clear();
}

/**
 * Single entry point for "register everything we ship". T1 calls this with
 * no-op (no metrics ship in T1); T2-T6 extend this to import and register
 * their own metrics. The extension calls `registerBuiltinMetrics()` once on
 * `session_start`.
 */
export function registerBuiltinMetrics(): void {
	// T1 ships with zero metrics — the engine + runner alone. T2-T6 register
	// the 7 metrics (Step Efficiency, Argument Correctness, Plan Adherence,
	// Goal Accuracy, Task Completion, Plan Quality, Tool Use) here.
}
