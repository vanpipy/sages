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
 * Single entry point for "register everything we ship". The extension calls
 * `registerBuiltinMetrics()` once on `session_start`. T1 shipped with zero
 * built-ins; T2 registers 3 heuristic metrics; T3 registers 2 hybrid
 * metrics. T4 will add 2 LLM-only metrics.
 */
import { StepEfficiency } from "./step-efficiency.ts";
import { ArgumentCorrectness } from "./argument-correctness.ts";
import { PlanAdherence } from "./plan-adherence.ts";
import { GoalAccuracy } from "./goal-accuracy.ts";
import { TaskCompletion } from "./task-completion.ts";

export function registerBuiltinMetrics(): void {
	registerMetric(new StepEfficiency());
	registerMetric(new ArgumentCorrectness());
	registerMetric(new PlanAdherence());
	registerMetric(new GoalAccuracy());
	registerMetric(new TaskCompletion());
}
