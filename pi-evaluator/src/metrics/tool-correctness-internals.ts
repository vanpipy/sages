/**
 * pi-evaluator/src/metrics/tool-correctness-internals.ts
 *
 * Pure helper functions for the ToolCorrectness metric. Exported
 * separately so unit tests can drive them directly without constructing
 * the full Metric context (no file system reads, no MetricContext).
 */
import type { SessionEntry } from "../types.ts";

const ORCHESTRATOR_TOOLS = new Set([
	"goal_contract_create",
	"dag_synthesize",
	"task_dispatch",
	"orchestrator_audit",
]);

export interface PerTaskResult {
	taskId: string;
	actual: string[];
	expected: string[];
	precision: number;
	recall: number;
	f1: number;
}

export function uniqueTools(toolCalls: string[]): string[] {
	return [...new Set(toolCalls)].sort();
}

/**
 * Iterate session.jsonl entries and bucket tool calls into per-task
 * windows. Returns an ordered list of {taskId, toolCalls}.
 *
 * Algorithm: each orchestrator tool call is a window boundary. Tool calls
 * between boundaries belong to the running window. The initial window
 * (before the first boundary) has taskId="(unknown)" and is dropped from
 * scoring unless its taskId matches an expected_tools declaration.
 */
export function bucketToolsByTask(
	entries: SessionEntry[],
): Array<{ taskId: string; toolCalls: string[] }> {
	const buckets: Array<{ taskId: string; toolCalls: string[] }> = [];
	let current: { taskId: string; toolCalls: string[] } = {
		taskId: "(unknown)",
		toolCalls: [],
	};
	for (const e of entries) {
		if (e.type !== "message" || !e.message) continue;
		for (const block of e.message.content) {
			if (
				block.type === "toolCall" &&
				typeof (block as { name?: unknown }).name === "string"
			) {
				const name = (block as { name: string }).name;
				if (ORCHESTRATOR_TOOLS.has(name)) {
					buckets.push(current);
					current = { taskId: name, toolCalls: [] };
				} else {
					current.toolCalls.push(name);
				}
			}
		}
	}
	buckets.push(current);
	return buckets;
}

/**
 * Compute per-task precision/recall/F1 from actual + expected sets.
 * Standard F1 formula; both P and R are 0 when the corresponding
 * denominator is 0.
 */
export function computePerTask(
	taskId: string,
	actual: string[],
	expected: string[],
): PerTaskResult {
	const actualSet = new Set(actual);
	const expectedSet = new Set(expected);
	const intersection = [...actualSet].filter((t) => expectedSet.has(t));
	const p = actualSet.size === 0 ? 0 : intersection.length / actualSet.size;
	const r = expectedSet.size === 0 ? 0 : intersection.length / expectedSet.size;
	const f1 = p + r === 0 ? 0 : (2 * p * r) / (p + r);
	return {
		taskId,
		actual,
		expected,
		precision: p,
		recall: r,
		f1,
	};
}