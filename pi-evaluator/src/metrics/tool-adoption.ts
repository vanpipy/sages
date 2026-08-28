/**
 * pi-evaluator/src/metrics/tool-adoption.ts
 *
 * Coordination-dim heuristic. Measures whether the LLM reaches for the
 * specialized tool families (aft_* / codebase_memory_* / ctx_*) instead
 * of defaulting to baseline tools (bash / read / edit / write / grep /
 * find / ls).
 *
 * Background: the Sages orchestrator's constitution pushes the LLM toward
 * AFT / codebase / ctx for code exploration, but real session data shows
 * baseline dominates ~88% of all tool calls (see GC-2026-087 design
 * notes). This metric makes the adoption rate observable — both per-run
 * and across runs (via `eval-trend`) — so a regression in tool-set
 * adoption is caught by the eval pipeline instead of being discovered
 * in postmortem.
 *
 * Algorithm:
 *   1. Read session.jsonl via `readSession`.
 *   2. Iterate `message.content` blocks; classify every `toolCall` by
 *      family (aft / codebase / ctx / subagent_control / orchestrator /
 *      baseline / other).
 *   3. Score = (aft + codebase + ctx) / (total - other). Higher = better
 *      adoption. Range [0, 1].
 *   4. Evidence: per-family breakdown (calls + ratio).
 *
 * Limitations:
 *   - Subagent tool calls are NOT in the parent's session.jsonl — only
 *     `custom` events with `customType: "subagents:*"` lifecycle
 *     markers exist there. This metric measures root-agent adoption only.
 *     Subagent adoption is captured separately via the
 *     `subagent_lifecycle` data (see GC-2026-087 follow-up).
 *   - Returns `data_missing: true` when no tool calls are seen (matches
 *     the convention in argument-correctness.ts).
 *
 * GC: GC-2026-087 follow-up; co-design with the orchestrator's
 * setActiveTools reorder + 3 nudges + family-mix reminder.
 */
import { readSession } from "../lib/jsonl-reader.ts";
import type { Metric, MetricContext, MetricResult } from "./types.ts";

/**
 * Tool family classification. Mirrors `orchestrator-advisory.ts`'s
 * `familyOf()` so the metric's per-family counts line up with what the
 * reminder sees. `other` = tool names the classifier doesn't recognize
 * (custom tools, vendor-specific, etc.) — these are excluded from the
 * denominator so they don't depress the adoption rate.
 */
export type ToolFamily =
	| "aft"
	| "codebase"
	| "ctx"
	| "subagent_control"
	| "orchestrator"
	| "baseline"
	| "other";

const SUBAGENT_TOOLS = new Set([
	"Agent",
	"get_subagent_result",
	"steer_subagent",
	"subagent_status",
	"subagent_steer",
	"subagent_abort",
	"subagent_resume",
]);

const ORCHESTRATOR_TOOLS = new Set([
	"goal_contract_create",
	"dag_synthesize",
	"task_dispatch",
	"orchestrator_audit",
	"sages_reminder",
	"todowrite_compile",
	"todowrite_progress",
]);

const BASELINE_TOOLS = new Set([
	"bash",
	"bash_status",
	"bash_watch",
	"bash_kill",
	"bash_write",
	"read",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"ast_grep_search",
	"ast_grep_replace",
]);

export function classifyToolFamily(toolName: string): ToolFamily {
	if (toolName.startsWith("aft_")) return "aft";
	if (toolName.startsWith("codebase_memory_")) return "codebase";
	if (toolName.startsWith("ctx_")) return "ctx";
	if (SUBAGENT_TOOLS.has(toolName)) return "subagent_control";
	if (ORCHESTRATOR_TOOLS.has(toolName)) return "orchestrator";
	if (BASELINE_TOOLS.has(toolName)) return "baseline";
	return "other";
}

/** Ordered list of recognized families (excludes "other"). Used for stable evidence rendering. */
export const TOOL_FAMILIES: readonly ToolFamily[] = [
	"aft",
	"codebase",
	"ctx",
	"subagent_control",
	"orchestrator",
	"baseline",
];

export class ToolAdoption implements Metric {
	readonly id = "tool_adoption" as const;
	readonly dim = "coordination" as const;
	readonly kind = "heuristic" as const;
	readonly description =
		"Fraction of tool calls that reach for specialized families (aft_*, codebase_memory_*, ctx_*) vs baseline (bash/read/edit/write/grep/find/ls). Higher = better adoption (coordination).";

	async compute(_input: unknown, ctx: MetricContext): Promise<MetricResult> {
		const t0 = performance.now();
		if (!ctx.workflowPath) {
			return { value: 0, evidence: [], duration_ms: 0, data_missing: true };
		}
		const sessionPath = `${ctx.workflowPath}/session.jsonl`;

		const counts: Record<ToolFamily, number> = {
			aft: 0,
			codebase: 0,
			ctx: 0,
			subagent_control: 0,
			orchestrator: 0,
			baseline: 0,
			other: 0,
		};

		try {
			const { entries } = await readSession(sessionPath);
			for (const e of entries) {
				if (e.type !== "message" || !e.message) continue;
				for (const b of e.message.content) {
					if (b.type !== "toolCall") continue;
					if (typeof b.name !== "string") continue;
					counts[classifyToolFamily(b.name)] += 1;
				}
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return {
				value: 0,
				evidence: [
					{
						artifact: "session.jsonl",
						location: sessionPath,
						note: `failed to read: ${message}`,
					},
				],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}

		const total = Object.values(counts).reduce((a, b) => a + b, 0);
		if (total === 0) {
			return {
				value: 0,
				evidence: [],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}

		// Adoption rate: specialized families / non-other calls. Excluding
		// `other` prevents unknown tools (vendor-specific, custom) from
		// depressing the score when the agent is otherwise adopting well.
		const recognizedTotal = total - counts.other;
		if (recognizedTotal === 0) {
			// Every call landed in `other` — surface that as missing data so
			// the scoring engine doesn't penalize a session we don't
			// recognize.
			return {
				value: 0,
				evidence: [
					{
						artifact: "session.jsonl",
						location: sessionPath,
						note: `all ${total} tool calls classified as 'other' (unrecognized tool names)`,
					},
				],
				duration_ms: performance.now() - t0,
				data_missing: true,
			};
		}

		const specialized = counts.aft + counts.codebase + counts.ctx;
		const adoptionRate = specialized / recognizedTotal;

		const evidence: MetricResult["evidence"] = [];
		for (const fam of TOOL_FAMILIES) {
			const n = counts[fam];
			if (n === 0) continue;
			const pct = (n / total) * 100;
			evidence.push({
				artifact: "session.jsonl",
				location: fam,
				note: `${n} calls (${pct.toFixed(1)}% of ${total})`,
			});
		}
		// Append the headline as the first evidence row so consumers see it first.
		evidence.unshift({
			artifact: "session.jsonl",
			location: `${specialized} specialized / ${recognizedTotal} recognized`,
			note: `adoption rate ${(adoptionRate * 100).toFixed(1)}%`,
		});

		return {
			value: adoptionRate,
			evidence,
			duration_ms: performance.now() - t0,
			data_missing: false,
		};
	}
}
