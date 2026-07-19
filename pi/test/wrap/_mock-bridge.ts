/**
 * Shared mock-bridge harness for wrap functional tests.
 *
 * Lets each test:
 *   1. Script the bridge to return specific data for specific calls
 *   2. Inspect what was sent to the bridge (params, command, call order)
 *   3. Inject the mock via `__setBridgeForTesting` — no `mock.module()`
 *      needed, so test files don't pollute each other
 *
 * Pattern:
 *
 *   import { installMockBridge } from "./_mock-bridge.js";
 *   import {
	__setBridgeForTesting,
	__setEnsureReadyForTesting,
} from "../../src/tools/aft/index.js";
 *
 *   const bridge = installMockBridge();
 *   bridge.on("grep", async (req) => ({ success: true, text: "..." }));
 *
 *   // After this call, bridgeFor() in wrap tools returns our mock
 *   const { registerSagesSearch } = await import("../../src/tools/wrap/search.js");
 *   registerSagesSearch(pi);
 *   await pi.tools["sages_search"].execute("call-1", { pattern: "TODO" });
 *
 *   expect(bridge.calls[0].command).toBe("grep");
 *
 *   // Cleanup
 *   bridge.uninstall();
 */

import {
	__setBridgeForTesting,
	__setEnsureReadyForTesting,
} from "../../src/tools/aft/index.js";

export interface MockCall {
	command: string;
	params: Record<string, unknown>;
	timestamp: number;
}

type ScriptedHandler = (req: Record<string, unknown>) => Promise<unknown> | unknown;

export class MockBridge {
	calls: MockCall[] = [];
	private handlers = new Map<string, ScriptedHandler>();
	private installed = false;

	on(command: string, handler: ScriptedHandler): void {
		this.handlers.set(command, handler);
	}

	install(): void {
		if (this.installed) return;
		__setBridgeForTesting(
			this.bridge() as unknown as Parameters<typeof __setBridgeForTesting>[0],
		);
		__setEnsureReadyForTesting(async () => {
			/* no-op: tests assume AFT is already configured */
		});
		this.installed = true;
	}

	uninstall(): void {
		if (!this.installed) return;
		__setBridgeForTesting(undefined);
		__setEnsureReadyForTesting(undefined);
		this.installed = false;
	}

	reset(): void {
		this.calls = [];
		this.handlers.clear();
	}

	/** Build the bridge object — must satisfy AftBridge's typed-helper shape. */
	private bridge(): Record<string, unknown> {
		const self = this;
		const make = (methodName: string) => async (...args: unknown[]) => {
			// Capture all positional args as a flat record; if the last arg
			// is a plain object, merge its keys into the top-level params so
			// tests can assert `params.max` rather than `params.options.max`.
			const positional: Record<string, unknown> = {};
			const paramNames = this.paramNamesFor(methodName);
			for (let i = 0; i < args.length; i++) {
				const name = paramNames[i] ?? `arg${i}`;
				const value = args[i];
				positional[name] = value;
				if (
					i === args.length - 1 &&
					value !== null &&
					typeof value === "object" &&
					!Array.isArray(value)
				) {
					for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
						positional[k] = v;
					}
				}
			}
			self.calls.push({
				command: methodName,
				params: positional,
				timestamp: Date.now(),
			});
			const handler = self.handlers.get(methodName);
			if (!handler) {
				throw new Error(
					`MockBridge: no handler for "${methodName}". ` +
						`Add one with bridge.on("${methodName}", () => ({...}))`,
				);
			}
			return handler({ command: methodName, ...positional });
		};

		return {
			grep: make("grep"),
			read: make("read"),
			write: make("write"),
			edit: make("edit"),
			outline: make("outline"),
			zoom: make("zoom"),
			callgraph: make("callgraph"),
			inspect: make("inspect"),
		};
	}

	private paramNamesFor(command: string): string[] {
		switch (command) {
			case "grep":
				return ["pattern", "path", "options"];
			case "read":
				return ["file", "options"];
			case "write":
				return ["file", "content"];
			case "edit":
				return ["file", "find", "replace"];
			case "outline":
				return ["file", "options"];
			case "zoom":
				return ["file", "symbol", "options"];
			case "callgraph":
				return ["file", "symbol", "direction"];
			case "inspect":
				return ["path"];
			default:
				return [];
		}
	}
}

/**
 * One-shot helper: install the mock, return it. Caller is responsible for
 * `bridge.uninstall()` after the test (typically in afterEach).
 */
export function installMockBridge(): MockBridge {
	const bridge = new MockBridge();
	bridge.install();
	return bridge;
}

// ─── Mock pi for registerTool() testing ─────────────────────────────────────

export interface RegisteredTool {
	name: string;
	label?: string;
	description?: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: unknown;
		isError?: boolean;
	}>;
}

export class MockPi {
	tools: Record<string, RegisteredTool> = {};

	registerTool = (tool: RegisteredTool): void => {
		this.tools[tool.name] = tool;
	};
}