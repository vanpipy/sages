/**
 * pi-semantic-nudge
 *
 * Goal: in long-running tasks, the LLM defaults to builtin `grep`/`read` because
 * those descriptions match user task wording better than `serena_find_symbol` etc.
 * This extension injects a SHORT nudge into the system prompt when recent activity
 * has skewed toward builtins without any semantic-tool use.
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
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

// Built-in tools that have a semantic-tool equivalent (the "drift" set).
// `bash` is intentionally excluded — many tasks need raw shell.
const BUILTIN_DRIFT = new Set(["grep", "read", "find", "ls"]);

// Semantic tools that should be preferred over builtins.
// If any of these appear in the recent window, no nudge needed.
const SEMANTIC = new Set<string>([
	"serena_find_symbol",
	"serena_find_referencing_symbols",
	"serena_get_symbols_overview",
	"serena_replace_symbol_body",
	"serena_insert_after_symbol",
	"serena_insert_before_symbol",
	"serena_read_file",
	"serena_create_text_file",
	"serena_search_for_pattern",
	"codebase_memory_trace_path",
	"codebase_memory_detect_changes",
	"codebase_memory_get_architecture",
	"codebase_memory_search_graph",
	"codebase_memory_search_code",
	"codebase_memory_get_code_snippet",
	"codebase_memory_query_graph",
	"graphify_query",
	"graphify_query_graph",
	"graphify_shortest_path",
	"graphify_god_nodes",
	"graphify_get_community",
	"graphify_get_neighbors",
	"graphify_get_node",
]);

const WINDOW_SIZE = 5;
const DRIFT_THRESHOLD = 3; // ≥3 builtin calls in window triggers nudge
const SUPPRESS_TURNS = 5;  // don't nudge again for this many turns after a nudge

interface State {
	recentTools: string[];
	turnsSinceLastNudge: number;
}

export default function piSemanticNudge(pi: ExtensionAPI): void {
	const state: State = { recentTools: [], turnsSinceLastNudge: SUPPRESS_TURNS };

	// Re-patch mcp-cache.json on session_start so the [PREFERRED] tags survive
	// cache regeneration (configHash change or 7-day TTL). The script is idempotent.
	function ensurePatched(): void {
		const cachePath = join(homedir(), ".pi/agent/mcp-cache.json");
		if (!existsSync(cachePath)) return; // not yet bootstrapped
		try {
			const cache = JSON.parse(readFileSync(cachePath, "utf-8"));
			let needsPatch = false;
			for (const serverName of ["serena", "codebase-memory-mcp", "graphify"]) {
				const tools = cache?.servers?.[serverName]?.tools ?? [];
				for (const t of tools) {
					if (!String(t.description ?? "").startsWith("[PREFERRED")) {
						needsPatch = true;
						break;
					}
				}
				if (needsPatch) break;
			}
			if (!needsPatch) return;
			// Run the patch script (idempotent)
			const scriptPath = join(homedir(), ".pi/packages/pi-semantic-nudge/scripts/patch_tool_descriptions.py");
			if (!existsSync(scriptPath)) return;
			const result = spawnSync("python3", [scriptPath], { stdio: "pipe" });
			if (result.status !== 0) {
				console.error("[pi-semantic-nudge] patch failed:", result.stderr?.toString().slice(0, 200));
			}
		} catch (e) {
			// Silent failure — never block session start
		}
	}

	// Run on session_start to ensure cache is patched before pi registers tools.
	// pi-mcp-adapter registers direct tools at module-load time using the cached
	// descriptions, so we patch BEFORE the first registration.
	// Since pi extensions are loaded in order, and pi-semantic-nudge is registered
	// in settings.json, we patch on import.
	ensurePatched();

	function recordTool(name: string): void {
		state.recentTools.push(name);
		if (state.recentTools.length > WINDOW_SIZE) {
			state.recentTools.shift();
		}
	}

	function shouldNudge(): boolean {
		if (state.turnsSinceLastNudge < SUPPRESS_TURNS) return false;
		if (state.recentTools.length < DRIFT_THRESHOLD) return false;
		const driftCount = state.recentTools.filter((t) => BUILTIN_DRIFT.has(t)).length;
		const semanticCount = state.recentTools.filter((t) => SEMANTIC.has(t)).length;
		return driftCount >= DRIFT_THRESHOLD && semanticCount === 0;
	}

	// Hook tool calls to track usage.
	// pi-mcp-adapter registers tools with `pi.registerTool`; builtins (`grep`/`read`/
	// `find`/`ls`) emit `GrepToolCallEvent`/`ReadToolCallEvent`/etc. We listen to
	// the generic `tool_call` event and filter by toolName.
	pi.on("tool_call", (event: any) => {
		const name = event.toolName ?? event.tool?.name ?? "";
		if (!name) return;
		recordTool(name);
	});

	// Inject nudge into system prompt when drift detected.
	pi.on("before_agent_start", (event: any) => {
		state.turnsSinceLastNudge += 1;

		if (!shouldNudge()) return;

		// Build a short, pattern-matchable nudge. Tagged with `<nudge>` so the
		// LLM can recognize it as a soft system hint (vs main system content).
		const nudge = [
			"",
			"<nudge>",
			"Your last few tool calls have been builtins (`grep`/`read`/`find`/`ls`).",
			"For code navigation/editing, prefer `serena_*` (LSP) or `codebase_memory_*` (graph).",
			"Cold-start cost is 3-5s and worth it. See §0 of SYSTEM.md for the priority table.",
			"</nudge>",
			"",
		].join("\n");

		state.turnsSinceLastNudge = 0;
		state.recentTools = [];

		return { systemPrompt: (event.systemPrompt ?? "") + nudge };
	});
}