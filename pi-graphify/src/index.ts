/**
 * pi-graphify: Graphify MCP integration for pi
 *
 * Responsibilities (v0.1.0):
 * - Ship the .mcp.json template (templates/mcp.json) for graphify's MCP server
 * - Register a SKILL.md so LLM knows which tool to pick for which query
 * - Lifecycle hooks: detect if graphify-out/ exists in cwd, hint at build if not
 *
 * Workflow:
 *   1. Build (BATCH, via bash): `graphify .` — produces graphify-out/ in cwd
 *   2. Query (REAL-TIME, via MCP): `mcp_graph_query`, `mcp_graph_shortest_path`, etc.
 *
 * Non-responsibilities:
 * - The graphify CLI itself is installed by sage's install.sh
 *   (`uv tool install graphifyy[mcp]`)
 * - The mcp binary is provided by pi-mcp-adapter
 *
 * @see https://github.com/safishamsi/graphify
 * @see https://github.com/nicobailon/pi-mcp-adapter
 */

import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const execFileAsync = promisify(execFile);

/**
 * Detect sage workspace.
 */
function isInSagesWorkspace(cwd: string): boolean {
	if (!cwd) return false;
	try {
		return fs.existsSync(path.join(cwd, ".sages", "workspace"));
	} catch {
		return false;
	}
}

/**
 * Detect if graphify-out/ exists in cwd (i.e., graph has been built).
 */
function graphExists(cwd: string): boolean {
	if (!cwd) return false;
	return fs.existsSync(path.join(cwd, "graphify-out", "graph.json"));
}

/**
 * Detect if graphify CLI is installed.
 */
function binaryInstalled(): boolean {
	const home = process.env.HOME || os.homedir();
	const candidates = [
		path.join(home, ".local", "bin", "graphify"),
		"/usr/local/bin/graphify",
		"/usr/bin/graphify",
	];
	return candidates.some((p) => fs.existsSync(p));
}

/**
 * Check if the graphify installation has the [mcp] extra (required for --mcp).
 */
async function hasMcpExtra(): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("graphify", ["--help"]);
		// If --mcp is listed in help, the [mcp] extra is installed
		return stdout.includes("--mcp");
	} catch {
		return false;
	}
}

export default function piGraphify(pi: ExtensionAPI): void {
	// ── Lifecycle: session_start ──────────────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		const cwd = ctx?.cwd || process.cwd();
		if (!isInSagesWorkspace(cwd)) return;

		const installed = binaryInstalled();
		if (!installed) {
			ctx.ui?.notify?.(
				`[pi-graphify] graphify CLI NOT installed. ` +
					`Run \`uv tool install "graphifyy[mcp]"\` then restart pi. ` +
					`Knowledge-graph tools (query/path/explain) unavailable until installed.`,
				"warning",
			);
			return;
		}

		// Check if [mcp] extra is installed (needed for --mcp server mode)
		const mcpReady = await hasMcpExtra();
		if (!mcpReady) {
			ctx.ui?.notify?.(
				`[pi-graphify] graphify CLI found but [mcp] extra missing. ` +
					`Run \`uv tool install --reinstall "graphifyy[mcp]" && exit && pi\`. ` +
					`MCP server tools will NOT work until [mcp] is installed.`,
				"warning",
			);
			return;
		}

		const built = graphExists(cwd);
		ctx.ui?.notify?.(
			`[pi-graphify] sage workspace detected. graphify ${built ? "graph READY" : "NOT built"}. ` +
				(built
					? `Use \`mcp_graph_query\` / \`mcp_graph_shortest_path\` / \`mcp_graph_explain\`.`
					: `Run \`graphify .\` (via bash) to build, then MCP tools become available.`) +
				` Lazy MCP start: first call has ~1s cold start.`,
			built ? "info" : "warning",
		);
	});

	// ── Lifecycle: session_shutdown ───────────────────────────────────
	pi.on("session_shutdown", async () => {
		// No state to flush; graphify-out/ persists.
	});
}