/**
 * pi-evaluator/src/metrics/tool-use.ts
 *
 * implement/coordination-dim LLM-only metric. Subjective: was the agent's
 * tool usage efficient and correct?
 *
 * Reads session.jsonl, aggregates tool invocation patterns (per-tool call
 * count, error rate, common sequences, retries), builds an evidence
 * summary, and calls the installed JudgeFn.
 */
import { readSession } from "../lib/jsonl-reader.ts";
import type { SessionEntry } from "../types.ts";
import type { Metric, MetricContext, MetricResult } from "./types.ts";
import type { JudgeInput } from "./llm-judge/seam.ts";
import { judge } from "./llm-judge/seam.ts";

const TOOL_USE_CRITERIA = `Evaluate the agent's tool usage pattern on these dimensions:
- Appropriateness: were the right tools chosen for each step? (vs manual file edits when a tool existed)
- Argument correctness: were tool arguments correct on first attempt, or did it require retries?
- Error recovery: when a tool errored, did the agent diagnose and retry with a corrected argument?
- Coverage: did the agent use the available toolset, or did it bypass tools for ad-hoc workarounds?
- Loop avoidance: did the agent avoid infinite retry loops or redundant tool calls?
Score 0-1 based on overall tool-use quality.`;

export class ToolUse implements Metric {
	readonly id = "tool_use" as const;
	readonly dim = "coordination" as const;
	readonly kind = "llm_judge" as const;
	readonly description = "Tool usage quality (LLM-only, coordination+implement)";

	async compute(_input: unknown, ctx: MetricContext): Promise<MetricResult> {
		const t0 = performance.now();
		if (!ctx.workflowPath) {
			return { value: 0, evidence: [], duration_ms: 0, data_missing: true };
		}
		const sessionPath = `${ctx.workflowPath}/session.jsonl`;
		let entries;
		try {
			({ entries } = await readSession(sessionPath));
		} catch (err) {
			return {
				value: 0,
				evidence: [
					{
						artifact: "session.jsonl",
						location: sessionPath,
						note: `failed: ${err instanceof Error ? err.message : String(err)}`,
					},
				],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}
		const summary = summarizeToolUse(entries);
		if (summary.totalCalls === 0) {
			return { value: 0, evidence: [], duration_ms: performance.now() - t0, data_missing: true };
		}
		const judgeInput: JudgeInput = {
			criteria: TOOL_USE_CRITERIA,
			evidence: summary.text,
			from: "llm",
		};
		const r = await judge(judgeInput);
		return {
			value: r.value,
			evidence: [
				{
					artifact: "session.jsonl",
					location: `${summary.totalCalls} tool calls`,
					note: `LLM judge: ${r.evidence[0]?.note ?? "(no rationale)"}`,
				},
			],
			duration_ms: performance.now() - t0,
			data_missing: r.data_missing,
		};
	}
}

interface ToolUseSummary {
	totalCalls: number;
	text: string;
}

function summarizeToolUse(entries: SessionEntry[]): ToolUseSummary {
	const counts = new Map<string, { calls: number; errors: number }>();
	const sequences: string[] = [];
	let prev = "(none)";
	let totalCalls = 0;
	let totalErrors = 0;
	for (const e of entries) {
		if (e.type !== "message" || !e.message) continue;
		for (const b of e.message.content) {
			if (b.type === "toolCall" && typeof b.name === "string") {
				const name = b.name;
				const c = counts.get(name) ?? { calls: 0, errors: 0 };
				c.calls += 1;
				counts.set(name, c);
				totalCalls += 1;
				sequences.push(prev === name ? `[repeat:${name}]` : `${prev}→${name}`);
				prev = name;
			} else if (b.type === "toolResult" && typeof b.name === "string") {
				const c = counts.get(b.name);
				if (c && b.is_error === true) {
					c.errors += 1;
					totalErrors += 1;
				}
			}
		}
	}
	const lines: string[] = [];
	lines.push(`# Tool-Use Summary (${totalCalls} calls, ${totalErrors} errors)`);
	lines.push("");
	lines.push("## Per-tool counts (calls / errors)");
	const sorted = [...counts.entries()].sort((a, b) => b[1].calls - a[1].calls);
	for (const [name, c] of sorted) {
		const rate = c.calls === 0 ? 0 : (c.errors / c.calls).toFixed(2);
		lines.push(`- ${name}: ${c.calls} calls, ${c.errors} errors (${rate} error rate)`);
	}
	lines.push("");
	lines.push("## Sequence (most recent 30)");
	lines.push(sequences.slice(-30).join(" "));
	return { totalCalls, text: lines.join("\n") };
}
