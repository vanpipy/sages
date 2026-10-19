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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
	// Sidebar emitter: `eval_score` writes a 'log' row to the sidebar's
	// event log on every compute. The fork's `registerSidebarEventTool`
	// (extensions/sidebar/sidebar-event-tool.ts) routes 'log' to
	// `state.eventLog` (FIFO at SIDEBAR_EVENT_LOG_MAX = 50). Wrapped in
	// a closure that swallows listener errors so a misbehaving sidebar
	// can't break the evaluator.
	const emitSidebarEvent: import("./eval-score.ts").SidebarEmitter = (payload) => {
		try {
			pi.events.emit("sidebar:event", payload);
		} catch {
			// Defensive.
		}
	};
	pi.registerTool(makeEvalScoreTool(state, emitSidebarEvent));
	pi.registerTool(makeEvalTrendTool(state, historical));
}

// Re-exports for callers (extension.ts) that want both tools' types.
export { makeEvalScoreTool, type EvalScoreOutput, type SidebarEmitter } from "./eval-score.ts";
export { makeEvalTrendTool, type EvalTrendOutput, type HistoricalReport } from "./eval-trend.ts";
