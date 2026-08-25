/**
 * Extension → tool ownership map.
 *
 * The conductor's profile validator cross-checks `profile.tools`
 * (each key = a tool the LLM may call) against
 * `profile.extensions.installed` (the set of extensions expected
 * to be loaded). For the cross-check to be useful, the validator
 * needs to know which extension provides which tool. That mapping
 * lives here.
 *
 * Three sources of truth feed this map:
 *
 *   1. **Sage-owned extensions** — the tool registration site is
 *      in this monorepo, so we read it directly:
 *      - `pi-orchestrator/src/*.ts` — five registerTool calls
 *        (`goal_contract_create`, `dag_synthesize`, `task_dispatch`,
 *        `orchestrator_audit`, `sages_reminder`)
 *      - `pi-subagents/src/index.ts` — three tools from
 *        `SUBAGENT_TOOL_NAMES = { AGENT, GET_RESULT, STEER }`
 *      - `pi-evaluator/src/tools/index.ts` — `eval_score` +
 *        `eval_trend`
 *
 *   2. **3rd-party npm extensions** — the tool list is in the
 *      installed dist. Hard-coded here; update on upgrade:
 *      - `@cortexkit/aft-pi` — `aft_search`, `aft_outline`,
 *        `aft_zoom` (per dist/README "AFT tools" section)
 *      - `@cortexkit/pi-magic-context` — six tools (ctx_search,
 *        ctx_memory, ctx_note, ctx_expand, ctx_reduce, todowrite)
 *        per dist `registerTool` calls
 *
 *   3. **MCP-served tools** — the tool list is dynamic, defined
 *      in the MCP server's `directTools` array. For
 *      `@sages/pi-codebase-memory`, we read
 *      `pi-codebase-memory/templates/mcp.json` at validator time
 *      and prefix each tool with `codebase_memory_` (the
 *      `toolPrefix: "short"` setting). If the MCP server adds
 *      tools, update `mcp.json` and this list follows automatically.
 *
 * If a tool listed in `profile.tools` has no owner here, the
 * validator emits a warning — either the tool belongs to an
 * extension not declared in `extensions.installed`, or this map
 * is out of date. Both cases are actionable.
 */

/**
 * Hard-coded owner map for static tool lists.
 * Keyed by extension package name → list of tool names that
 * extension registers. The MCP-served tools for
 * `@sages/pi-codebase-memory` are NOT in this map — they are
 * loaded dynamically from mcp.json by `loadMcpToolsFor()`.
 */
export const STATIC_TOOL_OWNERS: Readonly<Record<string, readonly string[]>> = {
	"@sages/pi-orchestrator": [
		"goal_contract_create",
		"dag_synthesize",
		"task_dispatch",
		"orchestrator_audit",
		"sages_reminder",
	],
	"@sages/pi-subagents": ["Agent", "get_subagent_result", "steer_subagent"],
	"@sages/pi-evaluator": ["eval_score", "eval_trend"],
	"@cortexkit/aft-pi": ["aft_search", "aft_outline", "aft_zoom"],
	"@cortexkit/pi-magic-context": [
		"ctx_search",
		"ctx_memory",
		"ctx_note",
		"ctx_expand",
		"ctx_reduce",
		"todowrite",
	],
} as const;

/**
 * The single MCP-served extension the conductor knows about.
 * Reading its tool list dynamically is preferred over hard-coding
 * because the MCP server's `directTools` array is the actual
 * source of truth. If the extension ships new tools, only
 * `mcp.json` needs updating — the ownership map follows.
 *
 * If the file is missing (e.g. extension not installed locally),
 * the owner list collapses to empty and any `profile.tools`
 * reference to a `codebase_memory_*` tool becomes a warning —
 * which is the desired behavior (the user has a profile that
 * expects tools they can't actually call).
 */
export const MCP_SERVED_EXTENSIONS: Readonly<Record<string, {
	mcpJsonRelativePath: string;
	toolPrefix: string;
}>> = {
	"@sages/pi-codebase-memory": {
		// piRoot resolves to `pi/` (the conductor package root); the
		// codebase-memory sibling sits one level up.
		mcpJsonRelativePath: "../pi-codebase-memory/templates/mcp.json",
		toolPrefix: "codebase_memory_",
	},
} as const;

/**
 * Build the complete tool → owner map for cross-validation.
 * Combines static owners with dynamically-loaded MCP-served
 * owner lists. Returns a Set of tool names that ANY installed
 * extension provides (so the validator can detect tools listed
 * in `profile.tools` but owned by nobody, and tools that
 * `extensions.installed` declares but provides nothing).
 *
 * `piRoot` is the conductor package's directory; MCP path
 * resolution walks up from there.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface OwnershipEntry {
	tools: readonly string[];
}

export function loadToolOwnership(piRoot: string): ReadonlyMap<string, OwnershipEntry> {
	const result = new Map<string, OwnershipEntry>();
	for (const [pkg, tools] of Object.entries(STATIC_TOOL_OWNERS)) {
		result.set(pkg, { tools });
	}
	for (const [pkg, config] of Object.entries(MCP_SERVED_EXTENSIONS)) {
		const mcpPath = join(piRoot, config.mcpJsonRelativePath);
		const tools = readMcpDirectTools(mcpPath, config.toolPrefix);
		if (tools) result.set(pkg, { tools });
	}
	return result;
}

/**
 * Parse an MCP `directTools` array from a `templates/mcp.json` file
 * and prefix each name with the configured `toolPrefix`. Returns
 * null when the file is missing or malformed — callers treat that
 * as "owner provides no tools" (the extension isn't installed
 * locally, so its tools aren't available regardless).
 */
function readMcpDirectTools(
	mcpJsonPath: string,
	toolPrefix: string,
): readonly string[] | null {
	if (!existsSync(mcpJsonPath)) return null;
	try {
		const raw = readFileSync(mcpJsonPath, "utf-8");
		const json = JSON.parse(raw) as {
			mcpServers?: Record<string, { directTools?: string[] }>;
		};
		const servers = json.mcpServers ?? {};
		const tools: string[] = [];
		for (const server of Object.values(servers)) {
			for (const tool of server.directTools ?? []) {
				tools.push(`${toolPrefix}${tool}`);
			}
		}
		return tools;
	} catch {
		return null;
	}
}

/**
 * Resolve the conductor package root from a runtime path.
 * Walks up from `import.meta.url` (the file calling this) until
 * it finds the directory containing `src/`. Used to anchor MCP
 * path resolution when the validator is invoked from anywhere.
 */
export function resolvePiRoot(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	let dir = here;
	for (let depth = 0; depth < 5; depth++) {
		if (existsSync(join(dir, "src"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return here;
}