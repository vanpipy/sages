/**
 * File Gate — path-aware policy for main-agent file writes.
 *
 * The main orchestrator agent can directly write to Sages **meta-files**
 * (orchestrator state under `.pi/orchestrator/`, the Sages source tree
 * under `pi/`, root docs, package metadata, ignore files). It CANNOT
 * directly write to **production code** (user `src/`, `test/`, `lib/`,
 * any other user code); those must go through the `Agent` tool with
 * a `software-developer` subagent so the audit gate stays intact.
 *
 * Two tools are exposed:
 *   - `sages_write(path, content)`  full overwrite of a meta-file
 *   - `sages_edit(path, oldText, newText)`  targeted replace in a meta-file
 *
 * Both share `canMainAgentWrite(path)` for the allowlist check. A
 * rejected path returns `{ isError: true, content: [{ text: policyMessage(...) }] }`
 * so the LLM can see exactly why and what to do instead (dispatch
 * a software-developer task via the Agent tool).
 *
 * Read tools (`read`, `aft_read`, `aft_search`, `codebase_*`, `graphify_*`,
 * `bash` for read-only commands) are intentionally NOT gated — the
 * main agent still needs to read user code to understand context.
 *
 * The policy is enforced at the tool layer; the system prompt
 * (`pi/templates/SYSTEM.md §1`) carries the matching convention so
 * the LLM prefers `sages_edit` / `sages_write` over raw `edit` / `write`
 * even when the latter would technically succeed.
 */

import { Type, type Static } from "typebox";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

/** Patterns that match meta-paths the main agent may write. */
const META_WRITE_PATTERNS: RegExp[] = [
	// Orchestrator state (goals, dags, audits, designs, etc.)
	/^\.pi\//,
	// Sages own source tree
	/^pi\//,
	// Root meta files
	/^README\.md$/,
	/^AGENTS\.md$/,
	/^package\.json$/,
	/^tsconfig(\..+)?\.json$/,
	/^\.gitignore$/,
	/^\.graphifyignore$/,
	/^\.aft\.jsonc?$/,
	/^\.claude\//,
	/^\.codex\//,
];

/** Patterns that explicitly deny — production code & user source. */
const PRODUCTION_DENY_PATTERNS: RegExp[] = [
	// Common user source roots
	/^src\//,
	/^test\//,
	/^tests\//,
	/^lib\//,
	/^app\//,
	/^cmd\//,
	/^internal\//,
	/^pkg\//,
	// Compiled / interpreted source extensions at root
	/\.(ts|tsx|js|jsx|mjs|cjs|py|pyw|go|rs|java|rb|php|cs|cpp|cc|c|h|hpp|swift|kt)$/,
];

/**
 * Returns true iff the main agent may write to the given path.
 *
 * Deny rules (in order):
 *   1. Empty / null-byte / `..` / `~/` / absolute paths
 *   2. Production code patterns (user source roots + source extensions)
 *   3. Default deny (anything not explicitly allowlisted)
 *
 * Allow rules: matches `META_WRITE_PATTERNS`.
 */
export function canMainAgentWrite(path: string): boolean {
	if (!path) return false;
	if (path.includes("\0") || path.includes("..") || path.includes("~")) return false;
	if (isAbsolute(path)) return false;
	// Empty filename
	if (path.endsWith("/") || path.endsWith("\\")) return false;

	// Meta paths override production-deny (a path under pi/ is Sages own
	// source, NOT user code, even though it ends in .ts).
	for (const re of META_WRITE_PATTERNS) {
		if (re.test(path)) return true;
	}

	for (const re of PRODUCTION_DENY_PATTERNS) {
		if (re.test(path)) return false;
	}

	return false;
}

/** Human-readable explanation returned to the LLM when a write is rejected. */
export function policyMessage(path: string): string {
	return [
		`main agent cannot directly edit "${path}".`,
		``,
		`Production code and user source files must be modified via the Agent tool —`,
		`dispatch a software-developer subagent with run_in_background: true.`,
		`Example:`,
		`  Agent({`,
		`    subagent_type: "software-developer",`,
		`    prompt: "Implement <change> in <path>. <context>...",`,
		`    run_in_background: true,`,
		`  })`,
		``,
		`Then run orchestrator_audit({ dag_id }) to verify.`,
		``,
		`Allowed direct writes from the main agent are limited to Sages meta-files:`,
		`  - .pi/orchestrator/*  (goal/dag/audit/state/designs)`,
		`  - pi/src/, pi/test/, pi/skills/, pi/templates/, pi/scripts/`,
		`  - README.md, AGENTS.md, package.json, tsconfig.json`,
		`  - .gitignore, .graphifyignore, .aft.jsonc`,
		`  - .claude/, .codex/`,
		``,
		`See SYSTEM.md §1 "Action Priority" for the policy.`,
	].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// Tool parameter schemas
// ─────────────────────────────────────────────────────────────────────────

export const SagesWriteParams = Type.Object({
	path: Type.String({ description: "Relative path within cwd (e.g. .pi/orchestrator/goal-GC-1.yaml)" }),
	content: Type.String({ description: "Full new file content" }),
});

export const SagesEditParams = Type.Object({
	path: Type.String({ description: "Relative path within cwd" }),
	oldText: Type.String({ description: "Exact substring to replace" }),
	newText: Type.String({ description: "Replacement content" }),
});

// ─────────────────────────────────────────────────────────────────────────
// Execute functions (exported for unit testing; the registered tool's
// execute() delegates to these)
// ─────────────────────────────────────────────────────────────────────────

export type ToolResponse = {
	content: { type: "text"; text: string }[];
	isError?: boolean;
};

/** Result of `executeSagesWrite` — a thin response wrapper for tests. */
export async function executeSagesWrite(
	params: Static<typeof SagesWriteParams>,
	ctx: { cwd: string },
): Promise<ToolResponse> {
	if (!canMainAgentWrite(params.path)) {
		return {
			isError: true,
			content: [{ type: "text", text: policyMessage(params.path) }],
		};
	}
	const fullPath = ctx.cwd.replace(/\/+$/, "") + "/" + params.path;
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, params.content, "utf-8");
	return {
		content: [{ type: "text", text: `wrote ${params.path} (${params.content.length} bytes)` }],
	};
}

export async function executeSagesEdit(
	params: Static<typeof SagesEditParams>,
	ctx: { cwd: string },
): Promise<ToolResponse> {
	if (!canMainAgentWrite(params.path)) {
		return {
			isError: true,
			content: [{ type: "text", text: policyMessage(params.path) }],
		};
	}
	const fullPath = ctx.cwd.replace(/\/+$/, "") + "/" + params.path;
	if (!existsSync(fullPath)) {
		return {
			isError: true,
			content: [{ type: "text", text: `sages_edit: file not found at ${params.path}` }],
		};
	}
	const original = readFileSync(fullPath, "utf-8");
	if (!original.includes(params.oldText)) {
		return {
			isError: true,
			content: [{
				type: "text",
				text: `sages_edit: oldText not found in ${params.path} (file may have changed; re-read first)`,
			}],
		};
	}
	const updated = original.replace(params.oldText, params.newText);
	mkdirSync(dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, updated, "utf-8");
	return {
		content: [{
			type: "text",
			text: `edited ${params.path} (${original.length} → ${updated.length} bytes)`,
		}],
	};
}

// ─────────────────────────────────────────────────────────────────────────
// Tool registration
// ─────────────────────────────────────────────────────────────────────────

/**
 * Register the path-gated `sages_edit` and `sages_write` tools on the
 * pi extension API. Call from `src/extension.ts` alongside
 * `registerOrchestratorTools`.
 */
export function registerFileGate(pi: any): void {
	pi.registerTool({
		name: "sages_write",
		label: "Sages Write (meta-file)",
		description: [
			"Overwrite a Sages meta-file with new content.",
			"Allowlisted paths only:",
			"  - .pi/orchestrator/*  (goal/dag/audit/state/designs)",
			"  - pi/src/, pi/test/, pi/skills/, pi/templates/, pi/scripts/",
			"  - README.md, AGENTS.md, package.json, tsconfig.json",
			"  - .gitignore, .graphifyignore, .aft.jsonc, .claude/, .codex/",
			"Production code (src/, test/, lib/, *.ts, *.py, ...) is REJECTED.",
			"Use the Agent tool with subagent_type=software-developer for those.",
		].join("\n"),
		parameters: SagesWriteParams,
		async execute(
			_toolCallId: string,
			params: any,
			_signal: any,
			_onUpdate: any,
			ctx: any,
		) {
			return await executeSagesWrite(params, { cwd: ctx.cwd });
		},
	});

	pi.registerTool({
		name: "sages_edit",
		label: "Sages Edit (meta-file)",
		description: [
			"Replace oldText with newText in a Sages meta-file.",
			"Allowlisted paths only (see sages_write description).",
			"Production code is REJECTED — use Agent + software-developer.",
		].join("\n"),
		parameters: SagesEditParams,
		async execute(
			_toolCallId: string,
			params: any,
			_signal: any,
			_onUpdate: any,
			ctx: any,
		) {
			return await executeSagesEdit(params, { cwd: ctx.cwd });
		},
	});
}
