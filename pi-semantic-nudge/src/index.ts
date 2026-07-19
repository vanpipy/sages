/**
 * pi-semantic-nudge
 *
 * Goal: in long-running tasks, the LLM defaults to builtin `grep`/`read` because
 * those descriptions match user task wording better than the semantic tools.
 * This extension injects a SHORT nudge into the system prompt when recent
 * activity has skewed toward builtins without any semantic-tool use.
 *
 * Mechanism:
 *   - Hook `tool_call` to track a sliding window of recent tool names
 *   - Hook `before_agent_start` to optionally append a `<nudge>` block to systemPrompt
 *
 * Trigger rules (avoid noise):
 *   - Window: last 5 tool calls
 *   - Trigger if ≥3 of those are builtins (grep/read/find/ls) AND 0 are semantic
 *   - Suppress for 5 turns after a successful nudge (prevent repetition)
 *
 * Cost: ~10 tokens per nudge, fires at most ~once per 5 turns. Negligible.
 *
 * Why this works (from reasoning in SYSTEM.md design notes):
 *   - systemPrompt is re-read every turn by the LLM → high attention weight
 *   - Short tagged nudge (`<nudge>...</nudge>`) gets pattern-matched
 *   - Conditional trigger (only when drifting) avoids "reminder fatigue"
 *
 * Post-AFT migration (2026-07-19):
 *   - serena_* entries removed from SEMANTIC (serena uninstalled)
 *   - 9 sages_* tool names added to SEMANTIC (the new sage wrapper layer)
 *   - codebase_memory_* + graphify_* kept as fallbacks
 *   - the python patch_tool_descriptions.py script is gone — sages_* tools
 *     are registered directly via pi.registerTool with rich descriptions;
 *     salience is carried by sage SKILL.md + SYSTEM.md context, not by
 *     [PREFERRED] description prefixes.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
	WINDOW_SIZE,
	type NudgeState,
	buildNudgeText,
	shouldNudge,
} from "./nudge.js";

export default function piSemanticNudge(pi: ExtensionAPI): void {
	const state: NudgeState = { turnsSinceLastNudge: 5, recentTools: [] }; // start ready-to-nudge

	function recordTool(name: string): void {
		state.recentTools.push(name);
		if (state.recentTools.length > WINDOW_SIZE) {
			state.recentTools.shift();
		}
	}

	// Hook tool calls to track usage. Every tool (builtins + extension tools +
	// MCP direct tools) flows through here as `tool_call`, so we get a single
	// canonical name regardless of source.
	pi.on("tool_call", (event: { toolName?: string; tool?: { name?: string } }) => {
		const name = event.toolName ?? event.tool?.name ?? "";
		if (!name) return;
		recordTool(name);
	});

	// Inject nudge into system prompt when drift detected.
	pi.on("before_agent_start", (event: { systemPrompt?: string }) => {
		state.turnsSinceLastNudge += 1;

		if (!shouldNudge(state.recentTools, state)) return;

		const nudge = buildNudgeText();

		state.turnsSinceLastNudge = 0;
		state.recentTools = [];

		return { systemPrompt: (event.systemPrompt ?? "") + nudge };
	});
}

// Re-export the pure helpers so consumers (tests, downstream packages)
// can import them from the same place as the extension entrypoint.
export {
	BUILTIN_DRIFT,
	SEMANTIC,
	SAGE_TOOL_NAMES,
	WINDOW_SIZE,
	DRIFT_THRESHOLD,
	SUPPRESS_TURNS,
	buildNudgeText,
	shouldNudge,
	type NudgeState,
} from "./nudge.js";