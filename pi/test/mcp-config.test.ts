/**
 * MCP server config tests
 *
 * Per the user's MCP lifecycle requirement:
 *   - serena:            keep-alive (LSP-style server — expensive cold start, must not idle-shutdown,
 *                        must auto-reconnect on disconnect). See pi-mcp-adapter lifecycle.ts for the
 *                        3 modes: lazy / eager / keep-alive.
 *   - codebase-memory:   eager + idleTimeout: 0 (graph queries are cheap, no need for keep-alive;
 *                        just never idle-shutdown)
 *   - graphify:          lazy + idleTimeout: 10 (user explicitly wants on-demand connect; graphify CLI
 *                        is heavy to spin up but only used occasionally)
 *
 * These tests pin the templates in `pi-{serena,codebase-memory,graphify}/templates/mcp.json`
 * so future install.sh runs produce the correct config. The user's
 * `~/.pi/agent/mcp.json` is the actual active config; this test asserts
 * the template state.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PI_ROOT = path.resolve(__dirname, "..");

function loadMcpTemplate(rel: string): any {
	const p = path.join(PI_ROOT, "..", rel);
	const raw = fs.readFileSync(p, "utf-8");
	return JSON.parse(raw) as any;
}

describe("MCP server lifecycle config (templates)", () => {
	it("pi-serena/templates/mcp.json declares serena as keep-alive (LSP, expensive cold start)", () => {
		const cfg = loadMcpTemplate("pi-serena/templates/mcp.json");
		expect(cfg.mcpServers.serena).toBeDefined();
		expect(cfg.mcpServers.serena.lifecycle).toBe("keep-alive");
	});

	it("pi-codebase-memory/templates/mcp.json declares codebase-memory-mcp as eager + idleTimeout 0", () => {
		const cfg = loadMcpTemplate("pi-codebase-memory/templates/mcp.json");
		expect(cfg.mcpServers["codebase-memory-mcp"]).toBeDefined();
		expect(cfg.mcpServers["codebase-memory-mcp"].lifecycle).toBe("eager");
		expect(cfg.mcpServers["codebase-memory-mcp"].idleTimeout).toBe(0);
	});

	it("pi-graphify/templates/mcp.json keeps graphify as lazy + idleTimeout 10 (by design)", () => {
		const cfg = loadMcpTemplate("pi-graphify/templates/mcp.json");
		expect(cfg.mcpServers.graphify).toBeDefined();
		expect(cfg.mcpServers.graphify.lifecycle).toBe("lazy");
		expect(cfg.mcpServers.graphify.idleTimeout).toBe(10);
	});

	it("keep-alive servers must NOT have idleTimeout set (markKeepAlive + global 0 = always)", () => {
		// keep-alive mode implies never-idle-shutdown (markKeepAlive path bypasses the idle
		// timer entirely; idleTimeout must be omitted so the upstream `??` short-circuit
		// does NOT override the eager→0 default for non-keepAlive servers — see the
		// serena persistence gotcha lesson).
		const cfg = loadMcpTemplate("pi-serena/templates/mcp.json");
		expect((cfg.mcpServers.serena as any).idleTimeout).toBeUndefined();
	});

	it("lazy/eager servers with idleTimeout have sane value (>= 0)", () => {
		for (const rel of [
			"pi-codebase-memory/templates/mcp.json",
			"pi-graphify/templates/mcp.json",
		]) {
			const cfg = loadMcpTemplate(rel);
			for (const [_name, server] of Object.entries(cfg.mcpServers)) {
				const srv = server as any;
				expect(typeof srv.idleTimeout).toBe("number");
				expect(srv.idleTimeout).toBeGreaterThanOrEqual(0);
			}
		}
	});
});