/**
 * pi-evaluator/src/metrics/tool-correctness.ts
 *
 * Implement-dim heuristic. For each task, compares the agent's actual
 * tool invocations (from session.jsonl) against the task's
 * `expected_tools: string[]` declaration (from dag-{id}.yaml). Returns
 * the average F1 across tasks. Per-task precision/recall/F1 surface in
 * evidence.
 *
 * Schema dependency (GC-2026-066 T1): TaskNode gains optional
 * `expected_tools?: string[]` and `acceptance_warnings?: string[]`. If no
 * task in the DAG declares expected_tools, this metric returns
 * `data_missing: true` (opt-in semantic — same as other pi-evaluator
 * metrics).
 *
 * Per-task window detection reuses the step-efficiency heuristic:
 * orchestrator tool calls (goal_contract_create / dag_synthesize /
 * task_dispatch / orchestrator_audit) mark task boundaries. Tool calls
 * between boundaries belong to the running task.
 *
 * F1 special cases:
 * - actual=0, expected=0 → P=0, R=0, F1=0 (no signal, but defined as 0)
 * - actual=0, expected>0 → P=0, R=0, F1=0 (agent used nothing — failed)
 * - actual>0, expected=0 → data_missing=true per task (DAG declares no
 *   expectation for this task — opt-in is opt-in)
 *
 * The metric returns data_missing=true at the metric level when
 * NO task in the DAG declares expected_tools. When some tasks declare
 * expected_tools and others don't, only the declared tasks contribute to
 * the score.
 */
import { readSession } from "../lib/jsonl-reader.ts";
import { readDag } from "../lib/artifact-reader.ts";
import type { DagArtifact, SessionEntry } from "../types.ts";
import type { Metric, MetricContext, MetricResult } from "./types.ts";
import {
	bucketToolsByTask,
	computePerTask,
	uniqueTools,
	type PerTaskResult,
} from "./tool-correctness-internals.ts";

const _ORCHESTRATOR_TOOLS = new Set([
	"goal_contract_create",
	"dag_synthesize",
	"task_dispatch",
	"orchestrator_audit",
]);

export interface ToolCorrectnessInput {
	/** Optional override: only consider tool calls within specific task ids. */
	taskFilter?: string[];
}

/**
 * Read dag-{id}.yaml and build a Map<taskId, expected_tools[]>. Tasks
 * without expected_tools are excluded from the map (opt-in).
 */
async function buildExpectedMap(
	dag: DagArtifact,
): Promise<Map<string, string[]>> {
	const map = new Map<string, string[]>();
	for (const task of dag.tasks ?? []) {
		const taskWithExpected = task as unknown as { expected_tools?: unknown };
		const expected = Array.isArray(taskWithExpected.expected_tools)
			? (taskWithExpected.expected_tools as string[])
			: undefined;
		if (expected && expected.length > 0) {
			map.set(task.id, expected);
		}
	}
	return map;
}

export class ToolCorrectness implements Metric<ToolCorrectnessInput> {
	readonly id = "tool_correctness" as const;
	readonly dim = "implement" as const;
	readonly kind = "heuristic" as const;
	readonly description =
		"Per-task F1 between expected_tools[] (dag-{id}.yaml) and actual tool invocations (session.jsonl)";

	async compute(
		input: ToolCorrectnessInput,
		ctx: MetricContext,
	): Promise<MetricResult> {
		const t0 = performance.now();
		if (!ctx.workflowPath) {
			return { value: 0, evidence: [], duration_ms: 0, data_missing: true };
		}
		const sessionPath = `${ctx.workflowPath}/session.jsonl`;

		let dag: DagArtifact;
		let entries: SessionEntry[];
		try {
			dag = await readDag(ctx.workflowPath);
			({ entries } = await readSession(sessionPath));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				value: 0,
				evidence: [
					{
						artifact: "dag/session",
						location: ctx.workflowPath,
						note: `failed to read artifacts: ${message}`,
					},
				],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}

		const expectedMap = await buildExpectedMap(dag);
		if (expectedMap.size === 0) {
			return {
				value: 0,
				evidence: [
					{
						artifact: "dag-*.yaml",
						location: "tasks",
						note: "no task declares expected_tools[] — opt-in: add `expected_tools: ['read','grep']` to a task to enable Tool Correctness scoring",
					},
				],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}

		const buckets = bucketToolsByTask(entries);
		const perTask: PerTaskResult[] = [];
		for (const bucket of buckets) {
			// Only score buckets whose taskId is in the expected map (opt-in).
			if (!expectedMap.has(bucket.taskId)) continue;
			if (input.taskFilter && !input.taskFilter.includes(bucket.taskId)) continue;
			const expected = expectedMap.get(bucket.taskId) ?? [];
			const actual = uniqueTools(bucket.toolCalls);
			perTask.push(computePerTask(bucket.taskId, actual, expected));
		}

		if (perTask.length === 0) {
			return {
				value: 0,
				evidence: [
					{
						artifact: "session.jsonl",
						location: "task windows",
						note: "expected_tools declared in DAG but no matching task windows found in session.jsonl",
					},
				],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}

		const avgF1 = perTask.reduce((s, r) => s + r.f1, 0) / perTask.length;

		const evidence: MetricResult["evidence"] = perTask.map((r) => ({
			artifact: "session.jsonl",
			location: `task ${r.taskId}`,
			note: `F1=${r.f1.toFixed(2)} (P=${r.precision.toFixed(2)} R=${r.recall.toFixed(2)}); actual=[${r.actual.join(",")}]; expected=[${r.expected.join(",")}]`,
		}));

		return {
			value: avgF1,
			evidence,
			duration_ms: performance.now() - t0,
			data_missing: false,
		};
	}
}