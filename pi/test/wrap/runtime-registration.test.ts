/**
 * Runtime-registration test for the sages_* wrapper layer.
 *
 * Pins down the wiring gap identified in audit 2026-07-19: the 9 sages_*
 * tools (wrap/*.ts) compiled cleanly and `registerAllWrappers()` worked
 * when called manually, but nothing imported/called it and pi/package.json
 * advertised zero pi.extensions. This file asserts:
 *
 *   1. pi/package.json declares pi.extensions with the new entrypoint.
 *   2. pi/src/extension.ts exports a default function that:
 *        a. calls registerFuxiTools / registerQiaoChuiTools /
 *           registerLubanTools / registerGaoYaoTools
 *        b. calls registerAllWrappers
 *        c. registers exactly the 9 SAGE_TOOL_NAMES on a mock pi.
 *   3. The runtime copy at $HOME/.pi/packages/sages mirrors the same
 *      package.json + src/extension.ts shape (otherwise the live install
 *      is still broken even after a clean source build).
 *   4. post-tool-removal regression guard has been flipped: pi.extensions
 *      is now REQUIRED and must point at ./src/extension.ts.
 */

import { describe, it, expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PI_ROOT = path.resolve(__dirname, "..", "..");
const RUNTIME_PKG = path.join(os.homedir(), ".pi/packages/sages");

class MockExtensionAPI {
	tools: Array<{ name: string; description?: string }> = [];
	commands: Array<{ name: string }> = [];
	registerTool = (tool: { name: string; description?: string }) => {
		this.tools.push({ name: tool.name, description: tool.description });
	};
	registerCommand = (cmd: { name: string }) => {
		this.commands.push({ name: cmd.name });
	};
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
	exec = async () => ({
		stdout: "",
		stderr: "",
		exitCode: 0,
		code: 0,
		killed: false,
	});
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
}

describe("sages wrapper runtime wiring", () => {
	it("pi/package.json declares pi.extensions pointing at ./src/extension.ts", () => {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(PI_ROOT, "package.json"), "utf-8"),
		);
		expect(pkg.pi?.extensions).toBeDefined();
		expect(pkg.pi.extensions).toContain("./src/extension.ts");
	});

	it("pi/src/extension.ts exists and exports a default function", () => {
		const extPath = path.join(PI_ROOT, "src", "extension.ts");
		expect(fs.existsSync(extPath)).toBe(true);
		const content = fs.readFileSync(extPath, "utf-8");
		expect(content).toMatch(/export\s+default\s+function/);
	});

	it("pi/src/extension.ts registers all 4 role tools + all 9 sages_* wrappers", async () => {
		const mod = await import(path.join(PI_ROOT, "src", "extension.ts"));
		const mock = new MockExtensionAPI();
		mod.default(mock as unknown as Parameters<typeof mod.default>[0]);

		const toolNames = mock.tools.map((t) => t.name);

		for (const role of [
			"fuxi_design",
			"qiaochui_review",
			"qiaochui_decompose",
			"luban_execute_task",
			"gaoyao_audit",
			"gaoyao_observe",
			"gaoyao_finalize",
		]) {
			expect(toolNames).toContain(role);
		}

		const expected = [
			"sages_diagnostics",
			"sages_find_references",
			"sages_find_symbol",
			"sages_insert_after_symbol",
			"sages_outline",
			"sages_read_file",
			"sages_replace_symbol",
			"sages_search",
			"sages_write_file",
		];
		for (const t of expected) {
			expect(toolNames).toContain(t);
		}

		// Each wrapper tool name must appear EXACTLY ONCE (no double-registration)
		const counts = new Map<string, number>();
		for (const name of toolNames) {
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
		for (const t of expected) {
			expect(counts.get(t)).toBe(1);
		}
	});

	it("pi/src/extension.ts explicitly invokes registerAllWrappers", () => {
		const content = fs.readFileSync(
			path.join(PI_ROOT, "src", "extension.ts"),
			"utf-8",
		);
		// The function name must appear as an invoked call, not just a comment
		expect(content).toMatch(/registerAllWrappers\s*\(/);
	});

	it("pi/src/index.ts re-exports the new extension entrypoint", () => {
		const content = fs.readFileSync(
			path.join(PI_ROOT, "src", "index.ts"),
			"utf-8",
		);
		const reExportsDefault =
			/import\s+\{\s*default\s+as\s+\w+\s*\}\s+from\s+["']\.\/extension(?:\.js)?["']/.test(
				content,
			);
		const reExportsNamed = /export\s*\{[^}]*(?:registerSagesExtension|default)[^}]*\}\s*from\s*["']\.\/extension(?:\.js)?["']/.test(
			content,
		);
		expect(reExportsDefault || reExportsNamed).toBe(true);
	});
});

describe("sages runtime install mirrors source wiring", () => {
	const hasRuntime = fs.existsSync(RUNTIME_PKG);

	it("runtime package.json declares pi.extensions pointing at ./src/extension.ts", () => {
		if (!hasRuntime) return;
		const pkg = JSON.parse(
			fs.readFileSync(path.join(RUNTIME_PKG, "package.json"), "utf-8"),
		);
		expect(pkg.pi?.extensions).toBeDefined();
		expect(pkg.pi.extensions).toContain("./src/extension.ts");
	});

	it("runtime src/extension.ts exists and exports a default function", () => {
		if (!hasRuntime) return;
		const extPath = path.join(RUNTIME_PKG, "src", "extension.ts");
		expect(fs.existsSync(extPath)).toBe(true);
		const content = fs.readFileSync(extPath, "utf-8");
		expect(content).toMatch(/export\s+default\s+function/);
	});

	it("runtime src/extension.ts registers all 9 sages_* wrappers when invoked", async () => {
		if (!hasRuntime) return;
		const extModule = await import(
			path.join(RUNTIME_PKG, "src", "extension.ts")
		);
		const mock = new MockExtensionAPI();
		extModule.default(
			mock as unknown as Parameters<typeof extModule.default>[0],
		);
		const toolNames = mock.tools.map((t) => t.name);
		for (const expected of [
			"sages_read_file",
			"sages_outline",
			"sages_find_symbol",
			"sages_search",
			"sages_write_file",
			"sages_replace_symbol",
			"sages_insert_after_symbol",
			"sages_find_references",
			"sages_diagnostics",
		]) {
			expect(toolNames).toContain(expected);
		}
	});
});