/**
 * Pure logic for pi-semantic-nudge.
 *
 * Exported so the test suite can drive it directly. The index.ts extension
 * is intentionally thin: it just wires the tool_call and before_agent_start
 * hooks to the helpers below.
 *
 * Why a separate module?
 *   1. Drift detection and nudge-text generation are pure functions — easy
 *      to unit-test without spinning up a mock ExtensionAPI.
 *   2. Keeps the extension entrypoint small and readable.
 *   3. Lets other extensions (or future sage packages) import the same
 *      semantic-set and nudge-text definitions.
 *
 * Semantic set policy (post-AFT migration, 2026-07-19):
 *   - sages_* tools (9) — primary semantic layer for sage workflows
 *   - codebase_memory_* (14) — cross-project graph queries, kept as fallback
 *   - graphify_* (10) — concept-graph traversal, kept as fallback
 *   - serena_* removed — serena was uninstalled in commit 08464ef
 *   - aft_* direct tools NOT included — they are exposed by the AFT
 *     extension itself, which adds its own [PREFERRED] hint via its
 *     own description prefix; double-counting would inflate the
 *     "no nudge needed" check.
 */

export const WINDOW_SIZE = 5;
export const DRIFT_THRESHOLD = 3; // ≥3 builtin calls in window triggers nudge
export const SUPPRESS_TURNS = 5; // don't nudge again for this many turns after a nudge

/**
 * Built-in tools that have a semantic-tool equivalent.
 *
 * `bash` is intentionally excluded — many tasks need raw shell, and a
 * `bash`-heavy session is not "drift".
 *
 * `write` and `edit` are also excluded — they have semantic equivalents
 * (sages_write_file, sages_replace_symbol) but most writes/edits are
 * legitimate end actions, not exploration.
 */
export const BUILTIN_DRIFT: ReadonlySet<string> = new Set([
	"grep",
	"read",
	"find",
	"ls",
]);

/**
 * The 9 sage wrapper tool names — kept in sync with
 * pi/src/tools/wrap/index.ts's SAGE_TOOL_NAMES array. Update both sides
 * when adding a new sages_* tool.
 */
export const SAGE_TOOL_NAMES: readonly string[] = [
	"sages_read_file",
	"sages_outline",
	"sages_find_symbol",
	"sages_search",
	"sages_write_file",
	"sages_replace_symbol",
	"sages_insert_after_symbol",
	"sages_find_references",
	"sages_diagnostics",
];

/**
 * Semantic tools that should be preferred over builtins.
 * If any of these appear in the recent window, no nudge needed.
 *
 * Sorted alphabetically for diff-friendly maintenance.
 */
export const SEMANTIC: ReadonlySet<string> = new Set([
	...SAGE_TOOL_NAMES,
	// codebase-memory-mcp
	"codebase_memory_detect_changes",
	"codebase_memory_get_architecture",
	"codebase_memory_get_code_snippet",
	"codebase_memory_query_graph",
	"codebase_memory_search_code",
	"codebase_memory_search_graph",
	"codebase_memory_trace_path",
	// graphify
	"graphify_get_community",
	"graphify_get_neighbors",
	"graphify_get_node",
	"graphify_god_nodes",
	"graphify_query",
	"graphify_query_graph",
	"graphify_shortest_path",
]);

export interface NudgeState {
	/** Counter incremented each `before_agent_start`, reset on nudge. */
	turnsSinceLastNudge: number;
	/**
	 * Sliding window of recent tool names (oldest first, newest last).
	 * Caller is responsible for trimming to WINDOW_SIZE.
	 * Lives on the state object so `recordTool` (extension-private) and
	 * `shouldNudge` (pure) can both share it without module-level globals.
	 */
	recentTools: string[];
}

/**
 * Pure: should the next `before_agent_start` inject a nudge?
 *
 * @param recentTools The last WINDOW_SIZE tool calls (oldest first, newest last).
 *                    Caller is responsible for trimming to WINDOW_SIZE.
 * @param state       Current suppression counter.
 */
export function shouldNudge(
	recentTools: readonly string[],
	state: NudgeState,
): boolean {
	if (state.turnsSinceLastNudge < SUPPRESS_TURNS) return false;
	if (recentTools.length < DRIFT_THRESHOLD) return false;

	let driftCount = 0;
	let semanticCount = 0;
	for (const t of recentTools) {
		if (BUILTIN_DRIFT.has(t)) driftCount += 1;
		else if (SEMANTIC.has(t)) semanticCount += 1;
	}

	return driftCount >= DRIFT_THRESHOLD && semanticCount === 0;
}

/**
 * Pure: the nudge text injected into the system prompt.
 *
 * Pinned shape (LLMs pattern-match the wording). If you change it,
 * update pi-semantic-nudge/skills/SKILL.md and test/nudge.test.ts.
 */
export function buildNudgeText(): string {
	return [
		"",
		"<nudge>",
		"Your last few tool calls have been builtins (`grep`/`read`/`find`/`ls`).",
		"For code navigation/editing, prefer `sages_*` (sage wrappers — AFT-backed + auto-snapshot).",
		"For cross-module concept search, use `graphify_query` / `graphify_shortest_path`.",
		"For callers/importers/multi-hop call graphs, use `codebase_memory_trace_path` / `codebase_memory_search_graph`.",
		"Cold-start cost is 3-5s and worth it. See the tool-priority table in your context.",
		"</nudge>",
		"",
	].join("\n");
}