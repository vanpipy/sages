/**
 * pi-serena lifecycle hook tests
 *
 * Verifies:
 * - Extension loads without error
 * - session_start emits notification when in sage workspace
 * - session_start is silent when not in sage workspace
 * - session_shutdown is a no-op (no throw)
 * - SKILL.md ships with the package
 */

import { describe, it, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PI_SERENA_ROOT = path.resolve(__dirname, "..", "..", "pi-serena");

class MockExtensionAPI {
	notifications: Array<{ text: string; type: string }> = [];
	private handlers = new Map<string, Function[]>();
	messages: any[] = [];
	ui = {
		notify: (text: string, type: string = "info") => {
			this.notifications.push({ text, type });
		},
	};
	// Stub all ExtensionAPI methods (we only test session_start/shutdown handlers)
	// Adding every method explicitly so TypeScript is happy without `as any`.
	registerTool = () => {};
	registerCommand = () => {};
	registerShortcut = () => {};
	registerFlag = () => {};
	getFlag = () => undefined;
	registerMessageRenderer = () => {};
	sendMessage = () => {};
	sendUserMessage = () => {};
	appendEntry = () => {};
	setSessionName = () => {};
	getSessionName = () => undefined;
	setLabel = () => {};
	exec = async () => ({ stdout: "", stderr: "", exitCode: 0, code: 0, killed: false });
	getActiveTools = () => [];
	getAllTools = () => [];
	setActiveTools = () => {};
	getCommands = () => [];
	setModel = async () => true;
	getThinkingLevel = () => "off" as const;
	setThinkingLevel = () => {};
	registerProvider = () => {};
	unregisterProvider = () => {};
	events = {
		listeners: new Map<string, Function[]>(),
		on: () => () => {},
		off: () => {},
		emit: () => {},
	};
	on(event: string, handler: Function) {
		const arr = this.handlers.get(event) || [];
		arr.push(handler);
		this.handlers.set(event, arr);
	}
	async trigger(event: string, payload: unknown, ctx: unknown) {
		const arr = this.handlers.get(event) || [];
		for (const h of arr) await h(payload, ctx);
	}
}

describe("pi-serena: package structure", () => {
	it("package.json declares both pi.extensions and pi.skills", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(PI_SERENA_ROOT, "package.json"), "utf-8"),
		);
		expect(pkg.pi?.extensions).toContain("./src/index.ts");
		expect(pkg.pi?.skills).toContain("./skills");
	});

	it("SKILL.md exists at skills/serena/SKILL.md", () => {
		const skillPath = path.join(PI_SERENA_ROOT, "skills", "serena", "SKILL.md");
		expect(fs.existsSync(skillPath)).toBe(true);
		const content = fs.readFileSync(skillPath, "utf-8");
		expect(content.length).toBeGreaterThan(500);
		// Should mention the 6 direct tools by name
		for (const tool of [
			"mcp_find_symbol",
			"mcp_replace_symbol_body",
			"mcp_insert_after_symbol",
			"mcp_find_referencing_symbols",
			"mcp_get_symbols_overview",
			"mcp_read_file",
		]) {
			expect(content).toContain(tool);
		}
	});

	it("mcp.json template is sage-curated (silent + whitelist + exclude)", () => {
		const mcp = JSON.parse(
			fs.readFileSync(path.join(PI_SERENA_ROOT, "templates", "mcp.json"), "utf-8"),
		);
		const serena = mcp.mcpServers?.serena;
		expect(serena).toBeDefined();
		expect(serena.args).toContain("--enable-web-dashboard");
		expect(serena.args[serena.args.indexOf("--enable-web-dashboard") + 1]).toBe("false");
		expect(serena.directTools?.length).toBe(6);
		expect(serena.excludeTools).toContain("execute_shell_command");
	});

	it("@modelcontextprotocol/sdk is NOT in dependencies (v0.2.0 moved to peer)", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(PI_SERENA_ROOT, "package.json"), "utf-8"),
		);
		expect(pkg.dependencies?.["@modelcontextprotocol/sdk"]).toBeUndefined();
	});
});

describe("pi-serena: lifecycle hooks", () => {
	let mockPi: MockExtensionAPI;
	let piSerenaModule: { default: (pi: MockExtensionAPI) => void };

	beforeEach(async () => {
		mockPi = new MockExtensionAPI();
		// Dynamic import so we always pick up the latest source
		piSerenaModule = await import("../../pi-serena/src/index.js");
	});

	it("extension loads without throwing", () => {
		expect(() => piSerenaModule.default(mockPi as any)).not.toThrow();
	});

	it("session_start in sage workspace emits 'configured' notification", async () => {
		// Create a temp dir with .sages/workspace/ structure
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-serena-test-"));
		fs.mkdirSync(path.join(tmpDir, ".sages", "workspace"), { recursive: true });
		// Simulate mcp.json being present
		fs.mkdirSync(path.join(tmpDir, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, ".pi", "agent", "mcp.json"),
			JSON.stringify({ mcpServers: { serena: {} } }),
		);

		piSerenaModule.default(mockPi as any);
		await mockPi.trigger("session_start", {}, { cwd: tmpDir, ui: mockPi.ui });

		const notif = mockPi.notifications.find((n) => n.text.includes("pi-serena"));
		expect(notif).toBeDefined();
		expect(notif?.type).toBe("info");
		expect(notif?.text).toContain("configured");
		expect(notif?.text).toContain("mcp({ search:");

		fs.rmSync(tmpDir, { recursive: true });
	});

	it("session_start in sage workspace WITHOUT mcp.json emits 'NOT configured' warning", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-serena-test-"));
		fs.mkdirSync(path.join(tmpDir, ".sages", "workspace"), { recursive: true });
		// No .pi/agent/mcp.json

		piSerenaModule.default(mockPi as any);
		await mockPi.trigger("session_start", {}, { cwd: tmpDir, ui: mockPi.ui });

		const notif = mockPi.notifications.find((n) => n.text.includes("pi-serena"));
		expect(notif).toBeDefined();
		expect(notif?.type).toBe("warning");
		expect(notif?.text).toContain("NOT configured");

		fs.rmSync(tmpDir, { recursive: true });
	});

	it("session_start in non-sage workspace is silent (no notification)", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-serena-test-"));
		// No .sages/workspace/ subdirectory

		piSerenaModule.default(mockPi as any);
		await mockPi.trigger("session_start", {}, { cwd: tmpDir, ui: mockPi.ui });

		const notif = mockPi.notifications.find((n) => n.text.includes("pi-serena"));
		expect(notif).toBeUndefined();

		fs.rmSync(tmpDir, { recursive: true });
	});

	it("session_shutdown is a no-op (does not throw)", async () => {
		piSerenaModule.default(mockPi as any);
		let threw = false;
		try {
			await mockPi.trigger("session_shutdown", {}, { cwd: "/tmp", ui: mockPi.ui });
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});
});
