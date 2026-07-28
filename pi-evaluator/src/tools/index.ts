/**
 * pi-evaluator/src/tools/index.ts
 *
 * Tool registration entry point — mirrors `pi/src/tools/orchestrator/index.ts`'s
 * `registerOrchestratorTools(pi)` shape, but for the reward mode tools.
 *
 * `registerEvalTools(pi, state, historical)` is called by `src/extension.ts`
 * on extension load. It registers both `eval_score` and `eval_trend` via the
 * pi extension API.
 *
 * The `state` and `historical` arguments are held by closure inside the tool
 * factories — they don't need to be re-supplied on each tool call.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import type { EvalState } from "../state.ts";
import { makeEvalScoreTool } from "./eval-score.ts";
import { makeEvalTrendTool, type HistoricalReport } from "./eval-trend.ts";

/**
 * Register both eval tools on the given pi extension API.
 *
 * @param pi The pi extension API. Reads/writes tool registry.
 * @param state Mutable EvalState. Both tools read from this closure.
 * @param historical Historical report snapshots for `eval_trend`.
 *                   May be empty for T2 (STUB); T3 will load from disk.
 */
export function registerEvalTools(
	pi: ExtensionAPI,
	state: EvalState,
	historical: HistoricalReport[] = [],
): void {
	pi.registerTool(makeEvalScoreTool(state));
	pi.registerTool(makeEvalTrendTool(state, historical));
}

// Re-exports for callers (extension.ts) that want both tools' types.
export { makeEvalScoreTool, type EvalScoreOutput } from "./eval-score.ts";
export { makeEvalTrendTool, type EvalTrendOutput, type HistoricalReport } from "./eval-trend.ts";
