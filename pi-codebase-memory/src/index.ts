/**
 * pi-codebase-memory: codebase-memory-mcp integration for pi
 *
 * Responsibilities (v0.1.0):
 * - Ship the .mcp.json template (templates/mcp.json) for codebase-memory-mcp
 *   with sage-approved policy (all 15 tools promoted as first-class tools;
 *   no excludeTools because the upstream is sandboxed graph-only — no shell)
 * - Register a SKILL.md so LLM knows which tool to pick for which task
 * - Lifecycle hooks: detect sage workspace + suggest first-time indexing
 *
 * Non-responsibilities (delegated to other extensions):
 * - The `mcp` proxy tool itself comes from pi-mcp-adapter
 * - The codebase-memory-mcp binary itself is installed by sage's install.sh
 *   (see pi/scripts/install.sh → install_codebase_memory_mcp)
 *
 * @see https://github.com/DeusData/codebase-memory-mcp
 * @see https://github.com/nicobailon/pi-mcp-adapter
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Detect whether the current working directory is a sages workspace
 * (i.e., has a `.pi/orchestrator/` sibling — the orchestrator state
 * directory created by the Sages install).
 */
function isInSagesWorkspace(cwd: string): boolean {
	if (!cwd) return false;
	try {
		return fs.existsSync(path.join(cwd, ".pi", "orchestrator"));
	} catch {
		return false;
	}
}

/**
 * Detect whether codebase-memory-mcp has indexed the current workspace
 * (looks for `.pi-codebase.json` in cwd). Absence means first-time use → needs
 * an initial `codebase-memory-mcp` indexing run.
 */
function codebaseIndexExists(cwd: string): boolean {
	if (!cwd) return false;
	return fs.existsSync(path.join(cwd, ".pi-codebase.json"));
}

/**
 * Detect whether the upstream binary is installed.
 * Uses process.env.HOME (not os.homedir()) so tests can override.
 */
function binaryInstalled(): boolean {
	const home = process.env.HOME || os.homedir();
	const candidates = [
		path.join(home, ".local", "bin", "codebase-memory-mcp"),
		"/usr/local/bin/codebase-memory-mcp",
		"/usr/bin/codebase-memory-mcp",
	];
	return candidates.some((p) => fs.existsSync(p));
}

export default function piCodebaseMemory(pi: ExtensionAPI): void {
	// ── Lifecycle: session_start ──────────────────────────────────────
	// Emit a one-time hint when entering a sage workspace, so the agent
	// knows to either (a) index the codebase if not yet done, or (b) use
	// the graph tools directly.
	pi.on("session_start", async (_event, ctx) => {
		const cwd = ctx?.cwd || process.cwd();
		if (!isInSagesWorkspace(cwd)) return;

		const indexed = codebaseIndexExists(cwd);
		const installed = binaryInstalled();

		if (!installed) {
			ctx.ui?.notify?.(
				`[pi-codebase-memory] WARNING: codebase-memory-mcp binary NOT installed. ` +
					`Run ./pi/scripts/install.sh --force to install. ` +
					`Graph tools (trace_path, detect_changes, etc.) will NOT work until installed.`,
				"warning",
			);
			return;
		}

		ctx.ui?.notify?.(
			`[pi-codebase-memory] sage workspace detected. codebase-memory-mcp binary present. ` +
				(indexed
					? `Index found. Use \`search_graph\` / \`trace_path\` / \`get_architecture\`.`
					: `Index MISSING. Run \`index_repository\` (first time may take minutes).`) +
				` Use \`mcp({ search: "codebase" })\` to list all 15 tools.`,
			indexed ? "info" : "warning",
		);
	});

	// ── Lifecycle: session_shutdown ───────────────────────────────────
	// No state to flush; the upstream server persists `.pi-codebase.json`.
	pi.on("session_shutdown", async () => {
		// Future: cleanup tmp directories if any.
	});
}