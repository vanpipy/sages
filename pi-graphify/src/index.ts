/**
 * pi-graphify: Graphify MCP integration for pi
 *
 * Responsibilities:
 * - Ship the .mcp.json template (templates/mcp.json) for graphify's MCP server
 * - Register a SKILL.md so LLM knows which tool to pick for which query
 * - Lifecycle hooks: detect graph status (missing/stale/fresh) and emit actionable guidance
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
import { execFile, execFileSync } from "node:child_process";
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
 * Detect if graphify-out/graph.json exists in cwd (i.e., graph has been built).
 */
function graphExists(cwd: string): boolean {
	if (!cwd) return false;
	return fs.existsSync(path.join(cwd, "graphify-out", "graph.json"));
}

/**
 * Detect if cwd is inside a git repo.
 */
function isGitRepo(cwd: string): boolean {
	try {
		execFileSync("git", ["rev-parse", "--git-dir"], {
			cwd,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Check git status — returns { dirty: bool, ahead: bool, lastCommitTime: number }.
 * Used to decide whether graph is stale.
 */
function gitStatus(cwd: string): {
	dirty: boolean;
	dirtyCount: number;
	lastCommitTime: number;
} {
	try {
		const porcelain = execFileSync("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const dirtyLines = porcelain
			.split("\n")
			.filter((l) => l.trim().length > 0);
		const ts = execFileSync(
			"git",
			["log", "-1", "--format=%ct"],
			{ cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
		).trim();
		return {
			dirty: dirtyLines.length > 0,
			dirtyCount: dirtyLines.length,
			lastCommitTime: parseInt(ts || "0", 10),
		};
	} catch {
		return { dirty: false, dirtyCount: 0, lastCommitTime: 0 };
	}
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
 * Check if the graphify installation has the [mcp] extra (required for MCP server).
 * In v0.8.33, graphify no longer has a `--mcp` flag — MCP server is launched via
 * `uv run --with graphifyy --with mcp -m graphify.serve <graph.json>`.
 */
async function hasMcpExtra(): Promise<boolean> {
	try {
		const { stdout } = await execFileAsync("uv", [
			"run",
			"--with", "graphifyy",
			"--with", "mcp",
			"python", "-c",
			"from graphify.serve import serve; print('ok')",
		]);
		return stdout.includes("ok");
	} catch {
		return false;
	}
}

/**
 * Compute graph freshness — returns one of:
 *   - "missing": no graph.json
 *   - "stale":   graph.json exists but is older than last git commit (or repo is dirty)
 *   - "fresh":   graph.json exists and is up-to-date
 *
 * Used to give the LLM a precise action.
 */
type GraphStatus = "missing" | "stale" | "fresh";

function checkGraphStatus(cwd: string): GraphStatus {
	if (!graphExists(cwd)) return "missing";

	if (!isGitRepo(cwd)) {
		// No git repo — can't compare; assume fresh
		return "fresh";
	}

	const graphMtime = fs.statSync(path.join(cwd, "graphify-out", "graph.json")).mtimeMs;
	const status = gitStatus(cwd);

	// If repo is dirty (uncommitted changes), graph is likely stale
	if (status.dirty) return "stale";

	// Compare graph mtime to last commit time
	if (status.lastCommitTime > 0) {
		const lastCommitMs = status.lastCommitTime * 1000;
		// graph is stale if last commit is newer than graph by > 60s (clock skew tolerance)
		if (lastCommitMs - graphMtime > 60_000) return "stale";
	}

	return "fresh";
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

		// Check if [mcp] extra is installed (needed for MCP server mode)
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

		const status = checkGraphStatus(cwd);

		if (status === "missing") {
			// Strong warning — no graph at all
			const dirtyInfo = isGitRepo(cwd)
				? ` Repo: ${gitStatus(cwd).dirtyCount} uncommitted change(s).`
				: "";
			ctx.ui?.notify?.(
				`[pi-graphify] sage workspace detected. graphify graph NOT built.${dirtyInfo}\n` +
					`  ACTION: Run \`graphify .\` (via bash, ~5-10 min) to build the graph.\n` +
					`  After build: mcp_graph_query / mcp_graph_shortest_path / etc. become available.\n` +
					`  Lazy MCP start: first call has ~1s cold start.`,
				"warning",
			);
			return;
		}

		if (status === "stale") {
			// Soft warning — graph exists but is out of date
			const dirtyCount = isGitRepo(cwd) ? gitStatus(cwd).dirtyCount : 0;
			const reason = dirtyCount > 0
				? `${dirtyCount} uncommitted change(s) since last build`
				: `new commits since last build`;
			ctx.ui?.notify?.(
				`[pi-graphify] graphify graph STALE — ${reason}.\n` +
					`  ACTION: Run \`graphify .\` (via bash, ~5-10 min) OR \`graphify . --update\` (faster, incremental) to rebuild.\n` +
					`  Existing queries still work but may miss recent changes.`,
				"warning",
			);
			return;
		}

		// fresh — silent OK
	});

	// ── Lifecycle: session_shutdown ───────────────────────────────────
	pi.on("session_shutdown", async () => {
		// No state to flush; graphify-out/ persists.
	});
}