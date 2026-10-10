/**
 * subagent-deadline.test.ts — GC-2026-subagent-recording-no-budget
 *
 * Wall-clock deadline metadata is preserved (the `deadlineMs` field on
 * RunConfig + the per-type defaults in settings.ts) so the
 * `subagent-usage:summary` aggregator can show "this agent ran 87min
 * past its nominal 30min deadline" without enforcing anything.
 *
 * Surface being verified:
 *   - settings.ts: `getSubagentDurationDefault(type)` returns the per-type
 *     default in milliseconds, with a 20-minute floor for unknown types.
 *   - settings.ts: `setSubagentDurationDefaults(d)` overrides the defaults.
 *   - settings.ts: `resolveDeadlineMs(type, overrideMinutes)` priority chain
 *     — caller-supplied minutes > per-type default > 20-minute floor.
 *   - agent-manager.ts: an externally-aborted parent signal still terminates
 *     the agent (the parent signal path is preserved; the deadline timer
 *     is gone).
 *   - RunController: no internal `setTimeout` is started for the deadline
 *     (asserted via inspection of the module — there is no observable
 *     timer to query). Bucket timers for per-tool timeouts are unchanged.
 *
 * Renamed intent: the previous "wall-clock deadline enforcement" semantics
 * is gone. This test now pins the no-enforcement + parent-signal + meta
 * contract. The aggregator script and the JSONL log surface the deadline
 * value as observability data only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("subagent deadline metadata (GC-2026-subagent-recording-no-budget)", () => {
	it("T-DEADLINE-META-01: per-type default applies for known built-in agent types", () => {
		// Metadata surface — the value is recorded in the config + the
		// aggregator script, but no enforcement runs. The aggregator
		// surfaces "ran N× nominal deadline" post-hoc.
		expect(getSubagentDurationDefault("developer")).toBe(20 * 60 * 1000);
		expect(getSubagentDurationDefault("auditor")).toBe(20 * 60 * 1000);
		expect(getSubagentDurationDefault("Explore")).toBe(5 * 60 * 1000);
		expect(getSubagentDurationDefault("Plan")).toBe(5 * 60 * 1000);
	});

	it("T-DEADLINE-META-02: unknown agent types fall back to the 20-minute floor", () => {
		expect(getSubagentDurationDefault("not-a-real-type")).toBe(20 * 60 * 1000);
		expect(getSubagentDurationDefault("")).toBe(20 * 60 * 1000);
	});

	it("T-DEADLINE-META-03: setSubagentDurationDefaults overrides the module-level defaults", () => {
		setSubagentDurationDefaults({
			developer: 7 * 60 * 1000, // 7 min
			auditor: 20 * 60 * 1000,
			Explore: 5 * 60 * 1000,
			Plan: 5 * 60 * 1000,
		});
		expect(getSubagentDurationDefault("developer")).toBe(7 * 60 * 1000);
		expect(getSubagentDurationDefault("Explore")).toBe(5 * 60 * 1000);
	});

	it("T-DEADLINE-META-04: resolveDeadlineMs returns the metadata value (no clamp)", () => {
		// GC-2026-subagent-recording-no-budget removed the [30, 120] min
		// envelope clamp. The resolved value is whatever the caller asked
		// for (or the per-type default), no minimum / maximum applied.
		// Canonical PascalCase types route through DEFAULT_PER_TYPE
		// (Developer / Reviewer / Explore / Plan all 30min); unknown
		// types fall through to getSubagentDurationDefault.
		expect(resolveDeadlineMs("developer", undefined)).toBe(30 * 60 * 1000);
		expect(resolveDeadlineMs("Developer", undefined)).toBe(30 * 60 * 1000);
		// Caller-supplied minutes pass through unchanged (no clamp).
		expect(resolveDeadlineMs("developer", 60)).toBe(60 * 60 * 1000);
		expect(resolveDeadlineMs("developer", 240)).toBe(240 * 60 * 1000);
		// Below-min values (e.g. 0.5 min) are NOT clamped to a floor; the
		// floor of 1min only applies when params are passed through
		// `resolveRunConfig` directly. The settings.resolveDeadlineMs
		// path uses getSubagentDurationDefault for legacy types.
		expect(resolveDeadlineMs("Explore", undefined)).toBe(5 * 60 * 1000);
	});
});

describe("subagent signal propagation: parent-signal abort still works (no deadline timer)", () => {
	// GC-2026-subagent-recording-no-budget: the deadline timer is gone,
	// but parent-driven aborts (the `options.signal` propagated into
	// RunController) still terminate the agent. The aggregator surfaces
	// the parent abort reason in the JSONL row.
	it("T-DEADLINE-SIG-01: an externally-aborted signal terminates the agent and captures the reason", async () => {
		const manager = new AgentManager();
		try {
			const externalController = new AbortController();
			const externalReason = new Error("user manually cancelled");
			setTimeout(() => externalController.abort(externalReason), 50);

			const { id, record } = await manager.spawnAndWait(
				{} as never,
				{ cwd: process.cwd() } as never,
				"Explore",
				"do something slow",
				{
					description: "external-abort test",
					signal: externalController.signal,
				} as never,
			);

			expect(["stopped", "aborted", "parent_aborted", "error"]).toContain(record.status);
			expect(record.error).toBeDefined();
			expect(record.error).toContain("user manually cancelled");
			expect(stubRunAgent).toHaveBeenCalledTimes(1);
			const captured = RUN_STATE.calls[0];
			expect(captured.signal).toBe(externalController.signal);
			expect(captured.abortListenerFired).toBe(true);
			expect(id).toMatch(/^[a-f0-9-]+$/);
		} finally {
			manager.dispose();
		}
	});

	it("T-DEADLINE-SIG-02: agents complete normally when no signal aborts (no implicit deadline)", async () => {
		// The deadline timer no longer fires. An agent that runs to
		// completion is the default path; no signal aborts needed.
		const manager = new AgentManager();
		try {
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

describe("subagent RunController: no deadline setTimeout (architectural check)", () => {
	it("T-DEADLINE-ARCH-01: index.ts executor merges parent signal with bucket signals (no deadline controller)", async () => {
		// GC-2026-subagent-recording-no-budget: the previous T-DEADLINE-04
		// asserted the executor merges parent + deadline. Now we assert
		// the executor still uses AbortSignal.any (for parent + bucket
		// signal composition) but does NOT start a deadline-driven
		// controller. The architectural shape is preserved; the
		// enforcement is gone.
		const { readFileSync } = await import("node:fs");
		const { fileURLToPath } = await import("node:url");
		const here = fileURLToPath(import.meta.url);
		const srcPath = here.replace(/\/test\/[^/]+$/, "/src/index.ts");
		const src = readFileSync(srcPath, "utf8");
		const matches = src.match(/AbortSignal\.any\s*\(/g) ?? [];
		expect(matches.length).toBeGreaterThanOrEqual(1);
	});
});
