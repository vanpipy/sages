/**
 * pi-serena: Serena MCP integration for pi
 *
 * Responsibilities (v0.2.0):
 * - Ship the .mcp.json template (templates/mcp.json) with sage-approved policy:
 *   - Silent mode (no browser pop-ups, no GUI log window)
 *   - directTools whitelist (6 high-frequency tools only)
 *   - excludeTools: execute_shell_command (LLM cannot bypass sage bash sandbox)
 * - Register a SKILL.md so LLM knows when to use mcp tools
 * - Lifecycle hooks: detect sage workspace on session_start, cleanup on shutdown
 *
 * Non-responsibilities (delegated to other extensions):
 * - The `mcp` proxy tool itself comes from pi-mcp-adapter (separate global peer)
 * - sage-specific tool registration comes from pi/ (sages core)
 *
 * @see https://github.com/oraios/serena
 * @see https://github.com/nicobailon/pi-mcp-adapter
 */

import * as path from "node:path";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/**
 * Detect whether the current working directory is a sages workspace
 * (i.e., has a `.sages/workspace/` sibling). Used to enrich the
 * mcp({}) status output with sage context.
 */
function isInSagesWorkspace(cwd: string): boolean {
	if (!cwd) return false;
	try {
		return fs.existsSync(path.join(cwd, ".sages", "workspace"));
	} catch {
		return false;
	}
}

export default function piSerena(pi: ExtensionAPI): void {
	// ── Lifecycle: session_start ──────────────────────────────────────
	// When a session starts, surface the mcp + serena status if the user
	// is in a sage workspace. This is a low-noise hint, not a blocker.
	pi.on("session_start", async (_event, ctx) => {
		const cwd = ctx?.cwd || process.cwd();
		if (!isInSagesWorkspace(cwd)) return;

		// mcp.json is written to ~/.pi/agent/mcp.json (global pi config),
		// NOT to cwd/.pi/agent/. PI_DIR env var controls the home, with
		// ~/.pi as the default.
		const piHome = process.env.PI_DIR || path.join(require("node:os").homedir(), ".pi");
		const mcpJsonPath = path.join(piHome, "agent", "mcp.json");
		const mcpConfigured = fs.existsSync(mcpJsonPath);

		ctx.ui?.notify?.(
			`[pi-serena] sage workspace detected. serena MCP ${
				mcpConfigured ? "configured" : "NOT configured (run install.sh)"
			}. ` +
				`Use \`mcp({ search: "serena" })\` to discover tools.`,
			mcpConfigured ? "info" : "warning",
		);
	});

	// ── Lifecycle: session_shutdown ───────────────────────────────────
	// Idempotent cleanup. serena itself is lazy and idle-disconnects after
	// 10 min, so we just emit a goodbye so the user knows we shut down cleanly.
	pi.on("session_shutdown", async () => {
		// No state to flush (v0.2.0 is config-only). Hook present for future
		// "save active serena memories" use cases.
	});
}
