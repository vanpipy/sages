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
import { StepEfficiency } from "./step-efficiency.ts";
import { ArgumentCorrectness } from "./argument-correctness.ts";
import { PlanAdherence } from "./plan-adherence.ts";
import { GoalAccuracy } from "./goal-accuracy.ts";
import { TaskCompletion } from "./task-completion.ts";
import { PlanQuality } from "./plan-quality.ts";
import { ToolUse } from "./tool-use.ts";
import { setJudgeFn } from "./llm-judge/seam.ts";
import { defaultJudgeFn } from "./llm-judge/judge.ts";

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
 * Single entry point for "register everything we ship". Called once from
 * extension.ts on session_start. Idempotent (the underlying registry throws
 * on duplicate ids); tests that need a clean registry call `clearMetrics()`
 * first.
 *
 * Also installs the real LLM-judge function via the seam, so hybrid metrics
 * (Goal Accuracy, Task Completion) get real scores when the user opts in via
 * `with.from = 'llm'` in their coefficient override AND the provider's env
 * var is set (e.g. ANTHROPIC_API_KEY). If the env var is missing, the
 * `defaultJudgeFn` throws → seam returns `data_missing:true` → caller falls
 * back to the heuristic branch.
 */
export function registerBuiltinMetrics(): void {
	setJudgeFn(defaultJudgeFn);
	registerMetric(new StepEfficiency());
	registerMetric(new ArgumentCorrectness());
	registerMetric(new PlanAdherence());
	registerMetric(new GoalAccuracy());
	registerMetric(new TaskCompletion());
	registerMetric(new PlanQuality());
	registerMetric(new ToolUse());
}
