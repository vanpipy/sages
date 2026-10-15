/**
 * @file tests/load-extension.test.ts — Sages-flavoured load-extension smoke test.
 *
 * Loads `../extensions/index.ts` against a mocked ExtensionAPI and confirms:
 *   1. The default export runs without throwing.
 *   2. Every registered tool name is present.
 *   3. Every registered slash-command name is present.
 *   4. Every lifecycle hook used by the extension (`session_start`,
 *      `agent_end`, `agent_settled`, `session_shutdown`, `input`,
 *      `tool_result`) was subscribed.
 *   5. The hot-reload cleanup function lands on `globalThis.__piRoutinesCleanup`
 *      so a subsequent `/reload` does not leak intervals.
 *
 * This is the single gate for the Sages fork PR — richer behaviour is
 * covered in the upstream's own `tests/` suite that ships via `pnpm check`.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import registerRoutinesExtension from "../extensions/index.ts";

interface CapturedTool {
	spec: unknown;
	handler: unknown;
}

interface CapturedCommand {
	spec: unknown;
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

const EXPECTED_TOOLS = [
	"RoutineCreate",
	"RoutineDelete",
	"RoutineList",
	"RoutinePause",
	"RoutineResume",
	"RoutineSetState",
] as const;

const EXPECTED_COMMANDS = [
	"routine",
	"routines",
	"routine-on",
	"routine-stop",
	"routine-install",
	"routine-export-cron",
	"routine-run-now",
	"routine-runs",
	"routine-server",
	"routine-token",
	"routine-pause",
	"routine-resume",
	"schedule",
] as const;

const EXPECTED_HOOKS = [
	"session_start",
	"agent_end",
	"agent_settled",
	"session_shutdown",
	"input",
	"tool_result",
] as const;

interface Capture {
	pi: ExtensionAPI;
	tools: Map<string, CapturedTool>;
	commands: Map<string, CapturedCommand>;
	hooks: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
}

function capturePi(): Capture {
	const tools = new Map<string, CapturedTool>();
	const commands = new Map<string, CapturedCommand>();
	const hooks = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();

	const pi = {
		registerTool(spec: { name: string }) {
			tools.set(spec.name, { spec, handler: undefined });
			return pi;
		},
		registerCommand(name: string, command: CapturedCommand) {
			commands.set(name, command);
		},
		on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
			const list = hooks.get(event) ?? [];
			list.push(handler);
			hooks.set(event, list);
			return () => {
				const idx = list.indexOf(handler);
				if (idx >= 0) list.splice(idx, 1);
			};
		},
	} as unknown as ExtensionAPI;

	return { pi, tools, commands, hooks };
}

const CLEANUP_KEY = "__piRoutinesCleanup";

describe("pi-routines extension load (Sages fork smoke)", () => {
	before(() => {
		// Belt-and-suspenders: clear any leftover cleanup from a previous
		// test run so we observe the NEW instance's registration.
		const g = globalThis as Record<string, unknown>;
		delete g[CLEANUP_KEY];
	});

	after(() => {
		// Invoke and clear cleanup so the test process exits cleanly.
		const g = globalThis as Record<string, unknown>;
		const cleanup = g[CLEANUP_KEY];
		if (typeof cleanup === "function") {
			(cleanup as () => void)();
			delete g[CLEANUP_KEY];
		}
	});

	it("registers without throwing", () => {
		const captured = capturePi();
		assert.doesNotThrow(() => registerRoutinesExtension(captured.pi));
	});

	it("registers every expected tool", () => {
		const captured = capturePi();
		registerRoutinesExtension(captured.pi);
		for (const name of EXPECTED_TOOLS) {
			assert.ok(captured.tools.has(name), `missing tool registration: ${name}`);
		}
	});

	it("registers every expected slash command", () => {
		const captured = capturePi();
		registerRoutinesExtension(captured.pi);
		for (const name of EXPECTED_COMMANDS) {
			assert.ok(captured.commands.has(name), `missing command registration: ${name}`);
		}
	});

	it("subscribes to the expected lifecycle hooks", () => {
		const captured = capturePi();
		registerRoutinesExtension(captured.pi);
		for (const event of EXPECTED_HOOKS) {
			const handlers = captured.hooks.get(event);
			assert.ok(handlers && handlers.length >= 1, `missing hook subscription: ${event}`);
		}
	});

	it("registers a hot-reload cleanup function on globalThis", () => {
		const captured = capturePi();
		registerRoutinesExtension(captured.pi);
		const g = globalThis as Record<string, unknown>;
		assert.equal(
			typeof g[CLEANUP_KEY],
			"function",
			`expected ${CLEANUP_KEY} to be a function on globalThis`,
		);
	});

	it("running the cleanup twice does not throw", async () => {
		const captured = capturePi();
		registerRoutinesExtension(captured.pi);
		const g = globalThis as Record<string, unknown>;
		const cleanup = g[CLEANUP_KEY] as () => void;
		// First invocation may schedule async teardown work; flush it before
		// the second run so we observe a clean state.
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				resolve();
			};
			setImmediate(finish);
			cleanup();
			setTimeout(finish, 50);
		});
		// The second run is best-effort and may warn — we only require no throw.
		assert.doesNotThrow(() => cleanup());
	});
});
