/**
 * pi-codebase-memory lifecycle hook tests
 *
 * Verifies:
 * - Extension loads without error
 * - session_start emits correct notification depending on binary + index state
 * - SKILL.md ships with the package
 * - mcp.json template exposes all 14 first-class tools + 0 excludeTools
 */

import { describe, it, expect, beforeEach } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PI_CODEBASE_MEMORY_ROOT = path.resolve(__dirname, "..", "..", "pi-codebase-memory");

class MockExtensionAPI {
	notifications: Array<{ text: string; type: string }> = [];
	private handlers = new Map<string, Function[]>();
	messages: any[] = [];
	ui = {
		notify: (text: string, type: string = "info") => {
			this.notifications.push({ text, type });
		},
	};
	// Stub all ExtensionAPI methods
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

describe("pi-codebase-memory: package structure", () => {
	it("package.json declares both pi.extensions and pi.skills", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(PI_CODEBASE_MEMORY_ROOT, "package.json"), "utf-8"),
		);
		expect(pkg.pi?.extensions).toContain("./src/index.ts");
		expect(pkg.pi?.skills).toContain("./skills");
	});

	it("SKILL.md exists at skills/codebase-memory-mcp/SKILL.md", () => {
		const skillPath = path.join(
			PI_CODEBASE_MEMORY_ROOT,
			"skills",
			"codebase-memory-mcp",
			"SKILL.md",
		);
		expect(fs.existsSync(skillPath)).toBe(true);
		const content = fs.readFileSync(skillPath, "utf-8");
		expect(content.length).toBeGreaterThan(500);
		// Should mention key tools
		for (const tool of [
			"mcp_trace_path",
			"mcp_detect_changes",
			"mcp_get_architecture",
			"mcp_get_code_snippet",
		]) {
			expect(content).toContain(tool);
		}
	});

	it("mcp.json template exposes 14 first-class tools with 0 excluded", () => {
		const mcp = JSON.parse(
			fs.readFileSync(path.join(PI_CODEBASE_MEMORY_ROOT, "templates", "mcp.json"), "utf-8"),
		);
		const cbm = mcp.mcpServers?.["codebase-memory-mcp"];
		expect(cbm).toBeDefined();
		expect(cbm.directTools?.length).toBe(14);
		expect(cbm.excludeTools?.length ?? 0).toBe(0);
		expect(cbm.command).toBe("codebase-memory-mcp");
		expect(cbm.lifecycle).toBe("eager");
	});

	it("mcp.json template includes the high-value sage tools", () => {
		const mcp = JSON.parse(
			fs.readFileSync(path.join(PI_CODEBASE_MEMORY_ROOT, "templates", "mcp.json"), "utf-8"),
		);
		const tools = mcp.mcpServers?.["codebase-memory-mcp"]?.directTools ?? [];
		// Core sage workflow tools (original upstream names; pi-mcp-adapter adds mcp_ prefix at runtime)
		expect(tools).toContain("trace_path");
		expect(tools).toContain("detect_changes");
		expect(tools).toContain("get_architecture");
		expect(tools).toContain("get_code_snippet");
	});
});

describe("pi-codebase-memory: lifecycle hooks", () => {
	let mockPi: MockExtensionAPI;
	let extModule: { default: (pi: MockExtensionAPI) => void };

	beforeEach(async () => {
		mockPi = new MockExtensionAPI();
		extModule = await import("../../pi-codebase-memory/src/index.js");
	});

	it("extension loads without throwing", () => {
		expect(() => extModule.default(mockPi as any)).not.toThrow();
	});

	it("session_start in sage workspace WITH binary + index emits info", async () => {
		// Setup: sage workspace (detected via .pi/orchestrator/ marker) + fake binary + fake .pi-codebase.json
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codebase-mem-test-"));
		fs.mkdirSync(path.join(tmpDir, ".pi", "orchestrator"), { recursive: true });
		fs.writeFileSync(path.join(tmpDir, ".pi-codebase.json"), "{}");

		// Inject fake binary path via $HOME override
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-"));
		fs.mkdirSync(path.join(fakeHome, ".local", "bin"), { recursive: true });
		fs.writeFileSync(
			path.join(fakeHome, ".local", "bin", "codebase-memory-mcp"),
			"#!/bin/sh\nexit 0\n",
		);
		fs.chmodSync(path.join(fakeHome, ".local", "bin", "codebase-memory-mcp"), 0o755);
		const origHome = process.env.HOME;
		process.env.HOME = fakeHome;

		try {
			extModule.default(mockPi as any);
			await mockPi.trigger("session_start", {}, { cwd: tmpDir, ui: mockPi.ui });

			const notif = mockPi.notifications.find((n) => n.text.includes("pi-codebase-memory"));
			expect(notif).toBeDefined();
			expect(notif?.type).toBe("info");
			expect(notif?.text).toContain("Index found");
		} finally {
			process.env.HOME = origHome;
			fs.rmSync(tmpDir, { recursive: true });
			fs.rmSync(fakeHome, { recursive: true });
		}
	});

	it("session_start in sage workspace WITHOUT index emits warning", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codebase-mem-test-"));
		fs.mkdirSync(path.join(tmpDir, ".pi", "orchestrator"), { recursive: true });

		// Fake binary present
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-"));
		fs.mkdirSync(path.join(fakeHome, ".local", "bin"), { recursive: true });
		fs.writeFileSync(path.join(fakeHome, ".local", "bin", "codebase-memory-mcp"), "#!/bin/sh\nexit 0\n");
		fs.chmodSync(path.join(fakeHome, ".local", "bin", "codebase-memory-mcp"), 0o755);
		const origHome = process.env.HOME;
		process.env.HOME = fakeHome;

		try {
			extModule.default(mockPi as any);
			await mockPi.trigger("session_start", {}, { cwd: tmpDir, ui: mockPi.ui });

			const notif = mockPi.notifications.find((n) => n.text.includes("pi-codebase-memory"));
			expect(notif).toBeDefined();
			expect(notif?.type).toBe("warning");
			expect(notif?.text).toContain("Index MISSING");
		} finally {
			process.env.HOME = origHome;
			fs.rmSync(tmpDir, { recursive: true });
			fs.rmSync(fakeHome, { recursive: true });
		}
	});

	it("session_start WITHOUT binary emits warning to install", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codebase-mem-test-"));
		fs.mkdirSync(path.join(tmpDir, ".pi", "orchestrator"), { recursive: true });

		// Fake $HOME with no binary
		const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "fake-home-empty-"));
		const origHome = process.env.HOME;
		process.env.HOME = fakeHome;

		try {
			extModule.default(mockPi as any);
			await mockPi.trigger("session_start", {}, { cwd: tmpDir, ui: mockPi.ui });

			const notif = mockPi.notifications.find((n) => n.text.includes("pi-codebase-memory"));
			expect(notif).toBeDefined();
			expect(notif?.type).toBe("warning");
			expect(notif?.text).toContain("binary NOT installed");
		} finally {
			process.env.HOME = origHome;
			fs.rmSync(tmpDir, { recursive: true });
			fs.rmSync(fakeHome, { recursive: true });
		}
	});

	it("session_start in non-sage workspace is silent", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codebase-mem-test-"));
		// No .pi/orchestrator/ marker

		extModule.default(mockPi as any);
		await mockPi.trigger("session_start", {}, { cwd: tmpDir, ui: mockPi.ui });

		const notif = mockPi.notifications.find((n) => n.text.includes("pi-codebase-memory"));
		expect(notif).toBeUndefined();

		fs.rmSync(tmpDir, { recursive: true });
	});

	it("session_shutdown is a no-op", async () => {
		extModule.default(mockPi as any);
		let threw = false;
		try {
			await mockPi.trigger("session_shutdown", {}, { cwd: "/tmp", ui: mockPi.ui });
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
	});
});