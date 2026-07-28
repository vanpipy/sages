/**
 * pi-evaluator/src/tools/eval-score.ts
 *
 * `eval_score` tool — returns the running Sages workflow's score + 5-dimension
 * breakdown with evidence pointers.
 *
 * Two layers (tested independently):
 *   1. `computeEvalScore(state)` — pure: state → EvalScoreOutput.
 *      Used by unit tests + by the ToolDefinition's execute().
 *   2. `makeEvalScoreTool(state)` — returns a pi `ToolDefinition` whose
 *      `execute()` wraps the compute output in the standard
 *      `{ content: [{type:"text", text}], details }` envelope.
 *
 * Locked shape (GC-2026-019 spec — do not deviate):
 *   {
 *     status: "ok" | "blocked",
 *     intent: string,
 *     workflow_id: string | null,
 *     total_score: number,
 *     dimensions: { goal, dag, implement, audit, coordination: DimensionScore }
 *   }
 *
 * Behaviors:
 *   - mode off → blocked (regardless of active_workflow state)
 *   - mode on + no active workflow → all-zero dimensions + null workflow_id
 *   - mode on + active workflow → verbatim copy from state
 *   - score-0 + evidence-presence convention is preserved (caller decides whether
 *     `score=0, evidence=[]` means "not observed" or "truly zero")
 *
 * T2 note: this ships the shape and copy. T3 (signal engine) populates
 * `state.active_workflow` from orchestrator events.
 */

import { Type } from "typebox";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

import type { Dimension } from "../types.ts";
import { createEvalState, type DimensionScore, type EvalState, type EvidenceRef } from "../state.ts";

/** Empty parameter schema — this tool takes no input. */
export const EvalScoreParams = Type.Object({});

/** The locked output schema (GC-2026-019). */
export interface EvalScoreOutput {
	status: "ok" | "blocked";
	intent: string;
	workflow_id: string | null;
	total_score: number;
	dimensions: Record<Dimension, DimensionScore>;
}

/** Build the all-zero dimensions map (used when no active workflow). */
function emptyDimensions(): Record<Dimension, DimensionScore> {
	return {
		goal: { score: 0, evidence: [] },
		dag: { score: 0, evidence: [] },
		implement: { score: 0, evidence: [] },
		audit: { score: 0, evidence: [] },
		coordination: { score: 0, evidence: [] },
	};
}

/**
 * Pure compute: given the current `EvalState`, produce the locked EvalScoreOutput.
 *
 * This function is exported so tests can exercise the shape contract directly,
 * and so future tooling (e.g. a debug `eval-score --print`) can reuse it.
 */
export function computeEvalScore(state: EvalState): EvalScoreOutput {
	if (state.mode === "off") {
		return {
			status: "blocked",
			intent: "reward mode is off; set sages.rewardMode=true in ~/.pi/agent/settings.json to enable",
			workflow_id: null,
			total_score: 0,
			dimensions: emptyDimensions(),
		};
	}

	const wf = state.active_workflow;
	if (wf === null) {
		return {
			status: "ok",
			intent: "no active Sages workflow; all dimensions zero",
			workflow_id: null,
			total_score: 0,
			dimensions: emptyDimensions(),
		};
	}

	// Defensive copy: copy evidence arrays so callers can't mutate internal state.
	const dimensions: Record<Dimension, DimensionScore> = {
		goal: { score: wf.dimensions.goal.score, evidence: [...wf.dimensions.goal.evidence] },
		dag: { score: wf.dimensions.dag.score, evidence: [...wf.dimensions.dag.evidence] },
		implement: {
			score: wf.dimensions.implement.score,
			evidence: [...wf.dimensions.implement.evidence],
		},
		audit: { score: wf.dimensions.audit.score, evidence: [...wf.dimensions.audit.evidence] },
		coordination: {
			score: wf.dimensions.coordination.score,
			evidence: [...wf.dimensions.coordination.evidence],
		},
	};

	return {
		status: "ok",
		intent: `scored 5 dimensions for ${wf.workflow_id}: ${wf.total_score}/100`,
		workflow_id: wf.workflow_id,
		total_score: wf.total_score,
		dimensions,
	};
}

/**
 * Build the pi `ToolDefinition` for `eval_score`. The returned tool can be
 * registered with `pi.registerTool(...)`.
 *
 * The tool takes no parameters. Its `description` follows the GC-2026-019
 * 3-layer LLM-hint contract (tool description + skill file + system prompt).
 */
export function makeEvalScoreTool(state: EvalState): ToolDefinition<typeof EvalScoreParams> {
	const description = [
		"Return the running score and 5-dimension breakdown (goal, dag, implement, audit, coordination)",
		"for the currently active Sages workflow. Call with no arguments.",
		"Use this mid-workflow to self-check which dimension is weak; the `evidence` array points",
		"to the specific artifact and location to fix.",
		"Returns { status, intent, workflow_id, total_score, dimensions: { …score, evidence } }.",
		"When no workflow is active: workflow_id is null and every dimension is {score:0, evidence:[]}.",
		"The score-0 + empty-evidence convention means \"not yet observed\" (NOT truly zero);",
		"score 0 with non-empty evidence means the dimension was computed and is genuinely 0.",
	].join(" ");
	const stateRef = state;
	return {
		name: "eval_score",
		label: "Eval Score",
		description,
		parameters: EvalScoreParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			const data = computeEvalScore(stateRef);
			return {
				content: [{ type: "text", text: JSON.stringify(data) }],
				details: data,
			};
		},
	};
}

// Re-export so callers using `import {EvidenceRef} from 'pi-evaluator/tools/eval-score'`
// can do so without reaching into the state module explicitly.
export type { EvidenceRef };
// Keep createEvalState re-export as a courtesy (some tests import from here).
export { createEvalState };
