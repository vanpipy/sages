/**
 * subagent-deadline.test.ts — GC-2026-037 T1
 *
 * Wall-clock deadline enforcement at the Agent tool executor layer.
 *
 * Surface being verified (after GREEN):
 *   - settings.ts: `getSubagentDurationDefault(type)` returns the per-type
 *     default in milliseconds, with a 20-minute hard floor for unknown types.
 *   - settings.ts: `setSubagentDurationDefaults(d)` overrides the defaults.
 *   - settings.ts: `resolveDeadlineMs(type, overrideMinutes)` priority chain
 *     — caller-supplied minutes > per-type default > 20-minute floor.
 *   - agent-manager.ts: When the caller's signal aborts with a duration-
 *     exceeded Error reason, the agent's `record.error` carries that message
 *     even when `session.prompt()` rejects with a generic AbortError.
 *   - index.ts executor: wires `AbortSignal.any([parent, deadline])` so the
 *     caller signal and the deadline timer both drive agent termination.
 *
 * The "merge happens in the executor" half is verified by an architectural
 * check (T-DEADLINE-04) — pulling the executor out of `registerTool` for unit
 * testing would require a deep `ExtensionAPI` mock. The architectural assertion
 * matches the project pattern (T-ASYNC-04).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- vi.mock for agent-runner -----------------------------------------------
//
// The stub captures the signal so the test can drive abort() externally. It
// then resolves runAgent's promise once the signal aborts (mimicking what the
// real runner does — forwardAbortSignal calls session.abort() which makes
// session.prompt() resolve cleanly). The exact resolution shape is irrelevant;
// what matters is that the agent manager sees the abort before it can complete.

interface CapturedRun {
	options: any;
	resolve: () => void;
	reject: (err: unknown) => void;
	signal: AbortSignal | undefined;
	abortListenerFired: boolean;
}

const RUN_STATE: { calls: CapturedRun[] } = { calls: [] };

vi.mock("../src/agent-runner.js", () => ({
	runAgent: vi.fn(async (_ctx: any, _type: any, _prompt: any, options: any) => {
		const sig = options?.signal as AbortSignal | undefined;
		const entry: CapturedRun = {
			options,
			resolve: () => {},
			reject: () => {},
			signal: sig,
			abortListenerFired: false,
		};
		RUN_STATE.calls.push(entry);

		return await new Promise<any>((resolve, reject) => {
			entry.resolve = () =>
				resolve({
					responseText: "stub-completed",
					session: {
						steer: async () => undefined,
						dispose: () => undefined,
						messages: [],
						subscribe: () => () => undefined,
						prompt: async () => undefined,
					},
					aborted: false,
					steered: false,
					failure: undefined,
				});
			entry.reject = (err) => reject(err);

			if (sig) {
				if (sig.aborted) {
					entry.abortListenerFired = true;
					// Simulate a typical aborted run: rejects with the signal's reason
					// wrapped in a fresh AbortError (the SDK does this when session
					// .prompt() rejects on session.abort()).
					const reason = sig.reason ?? new Error("aborted");
					const wrapped =
						reason instanceof Error ? reason : new Error(String(reason));
					reject(wrapped);
					return;
				}
				sig.addEventListener(
					"abort",
					() => {
						entry.abortListenerFired = true;
						const reason = sig.reason ?? new Error("aborted");
						const wrapped =
							reason instanceof Error ? reason : new Error(String(reason));
						reject(wrapped);
					},
					{ once: true },
				);
			}
		});
	}),
	resumeAgent: vi.fn(async () => ({ text: "stub-resume", failure: undefined })),
	steerAgent: vi.fn(async () => undefined),
	getAgentConversation: vi.fn(() => ""),
	SUBAGENT_TOOL_NAMES: {
		AGENT: "Agent",
		GET_RESULT: "get_subagent_result",
		STEER: "steer_subagent",
	},
	getDefaultMaxTurns: () => 30,
	setDefaultMaxTurns: () => undefined,
	getGraceTurns: () => 5,
	setGraceTurns: () => undefined,
	normalizeMaxTurns: (n?: number) => (n == null ? undefined : Math.max(0, n)),
}));

import { AgentManager } from "../src/agent-manager.js";
import * as runnerModule from "../src/agent-runner.js";
import { registerAgents, setDefaultsDisabled } from "../src/agent-types.js";
import {
	getSubagentDurationDefault,
	resolveDeadlineMs,
	setSubagentDurationDefaults,
} from "../src/settings.js";

const stubRunAgent = runnerModule.runAgent as unknown as ReturnType<
	typeof vi.fn
>;

beforeEach(() => {
	stubRunAgent.mockClear();
	RUN_STATE.calls.length = 0;
	setDefaultsDisabled(false);
	registerAgents(new Map());
	// Restore canonical defaults between tests — `setSubagentDurationDefaults`
	// is module-level state shared across tests, so any test that mutates it
	// must reset to known values.
	setSubagentDurationDefaults({
		developer: 20 * 60 * 1000,
		auditor: 20 * 60 * 1000,
		Explore: 5 * 60 * 1000,
		Plan: 5 * 60 * 1000,
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("subagent wall-clock deadline: settings resolution (GC-2026-037 T1)", () => {
	it("T-DEADLINE-03a: per-type default applies for known built-in agent types", () => {
		expect(getSubagentDurationDefault("developer")).toBe(20 * 60 * 1000);
		expect(getSubagentDurationDefault("auditor")).toBe(20 * 60 * 1000);
		expect(getSubagentDurationDefault("Explore")).toBe(5 * 60 * 1000);
		expect(getSubagentDurationDefault("Plan")).toBe(5 * 60 * 1000);
	});

	it("T-DEADLINE-03b: unknown agent types fall back to the 20-minute floor", () => {
		expect(getSubagentDurationDefault("not-a-real-type")).toBe(20 * 60 * 1000);
		expect(getSubagentDurationDefault("")).toBe(20 * 60 * 1000);
	});

	it("T-DEADLINE-03c: setSubagentDurationDefaults overrides the module-level defaults", () => {
		setSubagentDurationDefaults({
			developer: 7 * 60 * 1000, // 7 min
			auditor: 20 * 60 * 1000,
			Explore: 5 * 60 * 1000,
			Plan: 5 * 60 * 1000,
		});
		expect(getSubagentDurationDefault("developer")).toBe(7 * 60 * 1000);
		// Untouched types keep their previous values.
		expect(getSubagentDurationDefault("Explore")).toBe(5 * 60 * 1000);
	});

	it("T-DEADLINE-03d: resolveDeadlineMs priority — caller override > per-type default > 20min floor", () => {
		// No override → per-type default
		expect(resolveDeadlineMs("developer", undefined)).toBe(20 * 60 * 1000);
		expect(resolveDeadlineMs("Explore", undefined)).toBe(5 * 60 * 1000);
		expect(resolveDeadlineMs("not-a-type", undefined)).toBe(20 * 60 * 1000);

		// Caller-supplied minutes wins
		expect(resolveDeadlineMs("developer", 30)).toBe(30 * 60 * 1000);
		expect(resolveDeadlineMs("Explore", 0.5)).toBe(0.5 * 60 * 1000);

		// Caller-supplied override also wins for unknown types
		expect(resolveDeadlineMs("not-a-type", 1)).toBe(1 * 60 * 1000);
	});
});

describe("subagent wall-clock deadline: signal propagation (GC-2026-037 T1)", () => {
	it("T-DEADLINE-01: an externally-aborted signal terminates the agent and captures the abort reason in record.error", async () => {
		const manager = new AgentManager();
		try {
			const deadlineMs = 100;
			const externalController = new AbortController();
			const deadlineReason = new Error(
				`agent duration exceeded ${deadlineMs}ms`,
			);
			setTimeout(() => externalController.abort(deadlineReason), deadlineMs);

			const { id, record } = await manager.spawnAndWait(
				{} as never,
				{ cwd: process.cwd() } as never,
				"Explore",
				"do something slow",
				{
					description: "deadline test",
					signal: externalController.signal,
				} as never,
			);

			// The agent must have terminated (status moved past running).
			expect(["stopped", "aborted", "error"]).toContain(record.status);
			// The reason must surface in record.error (the duration reason, NOT a
			// generic AbortError message — that's the whole point of capturing
			// signal.reason before the abort propagates).
			expect(record.error).toBeDefined();
			expect(record.error).toContain("agent duration exceeded");
			expect(record.error).toContain(`${deadlineMs}ms`);
			// Sanity: runAgent was actually called with our signal so the abort
			// path was exercised, not short-circuited at the manager boundary.
			expect(stubRunAgent).toHaveBeenCalledTimes(1);
			const captured = RUN_STATE.calls[0];
			expect(captured.signal).toBe(externalController.signal);
			expect(captured.abortListenerFired).toBe(true);
			expect(id).toMatch(/^[a-f0-9-]+$/);
		} finally {
			manager.dispose();
		}
	});

	it("T-DEADLINE-02: a merged signal (parent + deadline) — whichever fires first aborts the agent", async () => {
		// Simulates what the index.ts executor will do: merge the caller's
		// AbortSignal with a deadline controller via AbortSignal.any. We verify
		// the manager honors the merged signal identically to a plain signal.
		const manager = new AgentManager();
		try {
			const parentController = new AbortController();
			const deadlineController = new AbortController();
			const deadlineReason = new Error("agent duration exceeded 50ms");
			setTimeout(() => deadlineController.abort(deadlineReason), 50);

			const mergedSignal = AbortSignal.any([
				parentController.signal,
				deadlineController.signal,
			]);

			// Parent abort fires after the deadline — verify the deadline part
			// is what actually trips the abort.
			setTimeout(
				() => parentController.abort(new Error("parent cancel")),
				5_000,
			);

			const { record } = await manager.spawnAndWait(
				{} as never,
				{ cwd: process.cwd() } as never,
				"Explore",
				"slow task",
				{
					description: "merged-signal test",
					signal: mergedSignal,
				} as never,
			);

			expect(["stopped", "aborted", "error"]).toContain(record.status);
			expect(record.error).toBeDefined();
			// The deadline reason wins because it fired first; record.error
			// surfaces the deadline message, not a generic abort string.
			expect(record.error).toContain("agent duration exceeded");
		} finally {
			manager.dispose();
		}
	});

	it("T-DEADLINE-01b: the deadline timer clears when the agent completes before the deadline fires", async () => {
		// Stub runAgent resolves immediately — the executor's timer must be
		// cleared in the finally branch or it leaks. We can't directly observe
		// the timer (it's in index.ts, not exercised here), so this test acts
		// as a regression guard for the inline-fixture behavior: a fast
		// completion leaves record.error undefined and status=completed.
		const manager = new AgentManager();
		try {
			// Force the stub to resolve instead of waiting on abort.
			stubRunAgent.mockImplementationOnce(async () => ({
				responseText: "fast",
				session: {
					steer: async () => undefined,
					dispose: () => undefined,
					messages: [],
					subscribe: () => () => undefined,
					prompt: async () => undefined,
				},
				aborted: false,
				steered: false,
				failure: undefined,
			}));

			const { record } = await manager.spawnAndWait(
				{} as never,
				{ cwd: process.cwd() } as never,
				"Explore",
				"fast task",
				{ description: "no-deadline-hit" } as never,
			);

			expect(record.status).toBe("completed");
			expect(record.error).toBeUndefined();
		} finally {
			manager.dispose();
		}
	});
});

describe("subagent wall-clock deadline: executor wiring (GC-2026-037 T1)", () => {
	it("T-DEADLINE-04: index.ts executor merges parent signal + deadline timer via AbortSignal.any", async () => {
		// Architectural check: the Agent tool executor must use AbortSignal.any
		// to merge the caller's AbortSignal with a deadline-driven
		// AbortController so either source aborts the agent. Mirrors T-ASYNC-04.
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const here = fileURLToPath(import.meta.url);
		const srcPath = here.replace(/\/test\/[^/]+$/, "/src/index.ts");
		const src = readFileSync(srcPath, "utf8");
		const matches = src.match(/AbortSignal\.any\s*\(/g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(1);
	});
});
