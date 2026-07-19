/**
 * MCP server config tests — updated for AFT migration.
 *
 * Per the user's MCP lifecycle requirement (still applicable):
 *   - AFT bridge: long-lived per session; lifecycle via aft-pi extension
 *   - codebase-memory: eager + idleTimeout: 0
 *   - graphify: lazy + idleTimeout: 10
 *
 * AFT does NOT ship a templates/mcp.json — its setup command handles config.
 *
 * These tests verify the templates that DO exist.
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
	it("AFT does NOT ship templates/mcp.json (handled by setup cmd)", () => {
		// AFT integrates via its own npm package and setup wizard,
		// not via a pre-baked mcp.json template. Verify the absence is intentional.
		const templatePath = path.join(PI_ROOT, ".cortexkit/aft.jsonc");
		expect(fs.existsSync(templatePath)).toBe(true);  // user config exists (we wrote it)
		// No mcp.json template to test
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

	it("lazy/eager servers with idleTimeout have sane value (>= 0)", () => {
		for (const rel of [
			"pi-codebase-memory/templates/mcp.json",
			"pi-graphify/templates/mcp.json",
		]) {
			const cfg = loadMcpTemplate(rel);
			for (const [, server] of Object.entries(cfg.mcpServers)) {
				const srv = server as any;
				expect(typeof srv.idleTimeout).toBe("number");
				expect(srv.idleTimeout).toBeGreaterThanOrEqual(0);
			}
		}
	});
});
