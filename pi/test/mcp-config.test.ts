/**
 * MCP server config tests
 *
 * Per the user's MCP lifecycle requirement:
 *   - serena:            eager (auto-connect at session start)
 *   - codebase-memory:   eager (auto-connect at session start)
 *   - graphify:          lazy (connect on first tool call)
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
	it("pi-serena/templates/mcp.json declares serena as eager", () => {
		const cfg = loadMcpTemplate("pi-serena/templates/mcp.json");
		expect(cfg.mcpServers.serena).toBeDefined();
		expect(cfg.mcpServers.serena.lifecycle).toBe("eager");
	});

	it("pi-codebase-memory/templates/mcp.json declares codebase-memory-mcp as eager", () => {
		const cfg = loadMcpTemplate("pi-codebase-memory/templates/mcp.json");
		expect(cfg.mcpServers["codebase-memory-mcp"]).toBeDefined();
		expect(cfg.mcpServers["codebase-memory-mcp"].lifecycle).toBe("eager");
	});

	it("pi-graphify/templates/mcp.json keeps graphify as lazy (by design — connect on demand)", () => {
		const cfg = loadMcpTemplate("pi-graphify/templates/mcp.json");
		expect(cfg.mcpServers.graphify).toBeDefined();
		expect(cfg.mcpServers.graphify.lifecycle).toBe("lazy");
	});

	it("all templates have a sane idleTimeout (>= 0)", () => {
		for (const rel of [
			"pi-serena/templates/mcp.json",
			"pi-codebase-memory/templates/mcp.json",
			"pi-graphify/templates/mcp.json",
		]) {
			const cfg = loadMcpTemplate(rel);
			for (const [name, server] of Object.entries(cfg.mcpServers)) {
				expect(typeof (server as any).idleTimeout).toBe("number");
				expect((server as any).idleTimeout).toBeGreaterThanOrEqual(0);
			}
		}
	});
});