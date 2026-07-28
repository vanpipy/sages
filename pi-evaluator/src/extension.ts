/**
 * pi-evaluator/src/extension.ts
 *
 * Default pi extension entrypoint. Loaded by pi when it resolves the
 * `@sages/pi-evaluator` package.
 *
 * Wires up:
 *   - The 2 reward mode tools (eval_score, eval_trend)
 *   - `session_start` event: read `~/.pi/agent/settings.json` and set mode
 *   - `before_agent_start` event: when mode is on, append the reward mode
 *     system-prompt augmentation to the original system prompt
 *
 * Mode is read ONCE per session (`session_start`) and is constant for the
 * session's lifetime. Hot-switch via `/reward` etc. is OUT OF SCOPE for T2
 * (explicit GC-2026-019 anti-goal).
 *
 * T3 will add event subscriptions (tool_call, agent_end, session_end) for
 * the signal engine. T2's job is the 2-tool skeleton + mode toggle.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import { readSagesRewardMode } from "./settings.ts";
import { REWARD_MODE_SYSTEM_PROMPT } from "./prompts.ts";
import { createEvalState } from "./state.ts";
import { registerEvalTools, type HistoricalReport } from "./tools/index.ts";

/**
 * Default pi extension entrypoint.
 *
 * Called by pi exactly once per session, with the ExtensionAPI. We:
 *   1. Create the state container (initially mode=off, no active workflow).
 *   2. Register the 2 eval tools (evaluator side).
 *   3. Subscribe to `session_start` to read the reward mode at session boot.
 *   4. Subscribe to `before_agent_start` to append the reward-mode prompt
 *      suffix when mode is on.
 *
 * T3 will extend step 3/4 to capture orchestration events.
 */
export default function registerEvaluatorExtension(pi: ExtensionAPI): void {
	const state = createEvalState();

	// T2 ships an empty historical feed. T3 will replace this with a disk
	// loader that reads `.pi/orchestrator/evals/report-*.json`.
	const historical: HistoricalReport[] = [];

	// Tool registration — order independent.
	registerEvalTools(pi, state, historical);

	// ── session_start: read mode exactly once per session ──────────────────
	pi.on("session_start", () => {
		state.mode = readSagesRewardMode() ? "on" : "off";
	});

	// ── before_agent_start: augment the system prompt when mode is on ───────
	// Returning a partial `BeforeAgentStartEventResult` from a handler is the
	// canonical way to extend the system prompt for one turn. pi chains
	// multiple extensions' results together.
	pi.on("before_agent_start", (event: any) => {
		if (state.mode !== "on") return;
		const original: string = typeof event?.systemPrompt === "string" ? event.systemPrompt : "";
		return {
			systemPrompt: `${original}\n\n${REWARD_MODE_SYSTEM_PROMPT}`,
		};
	});
}
