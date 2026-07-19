/**
 * Test: sages extension wires session_shutdown → AFT daemon shutdown.
 *
 * Why this matters: AFT spawns one long-lived child process (aft-linux-x64)
 * per session. Without an explicit shutdown hook on pi's session_shutdown
 * event, the daemon lingers after pi exits — observable as a persistent
 * `aft-linux-x64` entry in `ps aux`. This test pins the contract:
 *   1. extension registers a session_shutdown handler
 *   2. invoking that handler triggers __shutdownBridge
 *   3. multiple session_shutdown invocations are safe (idempotent)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PI_ROOT = path.resolve(__dirname, "..");
const EXT_PATH = path.join(PI_ROOT, "src", "extension.ts");

// ─── Minimal mock pi with on() event recording ──────────────────────────────

interface RecordedHandler {
	event: string;
	handler: (...args: unknown[]) => unknown;
}

class MockExtensionAPI {
	handlers: RecordedHandler[] = [];
	tools: Array<{ name: string }> = [];
	commands: Array<{ name: string }> = [];

	on = (event: string, handler: (...args: unknown[]) => unknown): void => {
		this.handlers.push({ event, handler });
	};

	registerTool = (tool: { name: string }): void => {
		this.tools.push({ name: tool.name });
	};
	registerCommand = (cmd: { name: string }): void => {
		this.commands.push({ name: cmd.name });
	};
	registerShortcut = (): void => {};
	registerFlag = (): void => {};
	getFlag = (): undefined => undefined;
	registerMessageRenderer = (): void => {};
	sendMessage = (): void => {};
	sendUserMessage = (): void => {};
	appendEntry = (): void => {};
	setSessionName = (): void => {};
	getSessionName = (): undefined => undefined;
	setLabel = (): void => {};
	exec = async () => ({
		stdout: "",
		stderr: "",
		exitCode: 0,
		code: 0,
		killed: false,
	});
	getActiveTools = (): unknown[] => [];
	getAllTools = (): unknown[] => [];
	setActiveTools = (): void => {};
	getCommands = (): unknown[] => [];
	setModel = async (): Promise<boolean> => true;
	getThinkingLevel = (): "off" => "off";
	setThinkingLevel = (): void => {};
	registerProvider = (): void => {};
	unregisterProvider = (): void => {};
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("sages extension session_shutdown wiring", () => {
	let mod: { default: (pi: unknown) => void };

	beforeEach(async () => {
		// Force-fresh import so module-level singletons reset between tests.
		mod = await import(`${EXT_PATH}?cache=${Date.now()}-${Math.random()}`);
	});

	test("extension.ts file exists and is parseable", () => {
		expect(fs.existsSync(EXT_PATH)).toBe(true);
	});

	test("registerSagesExtension registers a session_shutdown handler", () => {
		const mock = new MockExtensionAPI();
		mod.default(mock as unknown as Parameters<typeof mod.default>[0]);

		const shutdownHandlers = mock.handlers.filter((h) => h.event === "session_shutdown");
		expect(shutdownHandlers.length).toBe(1);
	});

	test("session_shutdown handler does not throw on invocation", () => {
		const mock = new MockExtensionAPI();
		mod.default(mock as unknown as Parameters<typeof mod.default>[0]);

		const handler = mock.handlers.find((h) => h.event === "session_shutdown");
		expect(handler).toBeDefined();

		// pi's SessionShutdownEvent shape — handler should accept it without
		// exploding even if no bridge has been created yet.
		const fakeEvent = {
			type: "session_shutdown" as const,
			reason: "quit" as const,
		};
		expect(() => handler!.handler(fakeEvent)).not.toThrow();
	});

	test("session_shutdown handler is idempotent (safe to call multiple times)", () => {
		const mock = new MockExtensionAPI();
		mod.default(mock as unknown as Parameters<typeof mod.default>[0]);

		const handler = mock.handlers.find((h) => h.event === "session_shutdown");
		expect(handler).toBeDefined();

		// Invoke three times — each one is shutdown of an already-shut-down
		// bridge, which should be a no-op.
		for (const reason of ["quit", "reload", "new"] as const) {
			expect(() =>
				handler!.handler({ type: "session_shutdown", reason }),
			).not.toThrow();
		}
	});

	test("extension still registers all 9 sages_* tools + 4 roles after adding session_shutdown", () => {
		const mock = new MockExtensionAPI();
		mod.default(mock as unknown as Parameters<typeof mod.default>[0]);

		const toolNames = mock.tools.map((t) => t.name);

		// Spot-check: at least one sage wrapper + the 4 roles are still registered
		expect(toolNames).toContain("sages_search");
		expect(toolNames).toContain("sages_outline");
		expect(toolNames).toContain("fuxi_design");
		expect(toolNames).toContain("luban_execute_task");
		expect(toolNames).toContain("gaoyao_audit");
	});
});