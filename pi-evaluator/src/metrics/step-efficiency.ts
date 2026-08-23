/**
 * pi-evaluator/src/metrics/step-efficiency.ts
 *
 * Coordination-dim heuristic. Counts tool calls per task window in
 * session.jsonl, then normalizes each task's count against a soft budget.
 * Returns the average saturation across all observed task windows — 0 means
 * every task stayed under budget, 1 means every task saturated.
 *
 * "Task windows" are inferred from session.jsonl timestamps: a new task
 * starts when the assistant emits a message that contains a tool_call
 * named like one of the orchestrator tools (goal_contract_create /
 * dag_synthesize / task_dispatch / orchestrator_audit), and a task ends
 * when the next such tool_call appears. Tool calls in between belong to
 * the running task. Messages without tool_calls don't count.
 *
 * No regression vs v0.2.0: this metric is disabled by default (weight=0
 * placeholder in DEFAULT_COEFFICIENTS). Opt in via override.
 */
import { readSession } from "../lib/jsonl-reader.ts";
import type { Metric, MetricContext, MetricResult } from "./types.ts";

const ORCHESTRATOR_TOOLS = new Set([
	"goal_contract_create",
	"dag_synthesize",
	"task_dispatch",
	"orchestrator_audit",
]);

export interface StepEfficiencyInput {
	/** Per-task turn budget. Default 30 if omitted. */
	budgetPerTask?: number;
}

export class StepEfficiency implements Metric<StepEfficiencyInput> {
	readonly id = "step_efficiency" as const;
	readonly dim = "coordination" as const;
	readonly kind = "heuristic" as const;
	readonly description =
		"Tool calls per task window normalized to a soft budget (coordination)";

	async compute(
		input: StepEfficiencyInput,
		ctx: MetricContext,
	): Promise<MetricResult> {
		const t0 = performance.now();
		if (!ctx.workflowPath) {
			return { value: 1, evidence: [], duration_ms: 0, data_missing: true };
		}
		const budget = input.budgetPerTask ?? 30;
		const sessionPath = `${ctx.workflowPath}/session.jsonl`;

		let totalRatio = 0;
		let taskCount = 0;
		const evidence: MetricResult["evidence"] = [];
		try {
			const { entries } = await readSession(sessionPath);
			let currentTaskTools = 0;
			let taskIndex = 0;

			const closeWindow = () => {
				if (currentTaskTools > 0 || taskIndex > 0) {
					const ratio = Math.min(1, currentTaskTools / budget);
					totalRatio += ratio;
					taskCount += 1;
					if (currentTaskTools > budget) {
						evidence.push({
							artifact: "session.jsonl",
							location: `task ${taskIndex}: ${currentTaskTools}/${budget} tool calls`,
							note: "turn budget saturated",
						});
					}
				}
			};

			for (const e of entries) {
				if (e.type !== "message" || !e.message) continue;
				// Iterate content blocks within the message: an orchestrator toolCall
				// closes the previous window + starts a new one; any other toolCall
				// adds to the current window. (toolResult blocks don't count.)
				for (const b of e.message.content) {
					if (b.type !== "toolCall") continue;
					const name = (b as { name?: string }).name;
					if (typeof name === "string" && ORCHESTRATOR_TOOLS.has(name)) {
						closeWindow();
						taskIndex += 1;
						currentTaskTools = 0;
					} else {
						currentTaskTools += 1;
					}
				}
			}
			closeWindow();
			if (taskCount === 0) {
				return {
					value: 0,
					evidence: [],
					duration_ms: performance.now() - t0,
					data_missing: true,
				};
			}
			const value = totalRatio / taskCount;
			return {
				value,
				evidence,
				duration_ms: performance.now() - t0,
				data_missing: false,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				value: 1,
				evidence: [
					{
						artifact: "session.jsonl",
						location: sessionPath,
						note: `failed to read: ${message}; step_efficiency returns saturated value`,
					},
				],
				duration_ms: performance.now() - t0,
				data_missing: false,
			};
		}
	}
}
