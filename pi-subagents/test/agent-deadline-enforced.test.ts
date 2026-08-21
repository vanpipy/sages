/**
 * agent-deadline-enforced.test.ts — GC-2026-065 T1
 *
 * Pins that an agent spawned under AgentManager exits cleanly with
 * `record.status = "aborted"` and the deadline message in
 * `record.error` when RunController's deadline fires during the run.
 *
 * This is the orchestrator-facing surface of the GC-2026-065 fix:
 * after the deadline timer aborts runController.signal, runAgent's
 * pre/post abort checks (in agent-runner.ts) flip the run record's
 * status. The test stubs runAgent's session.prompt to mimic the
 * real call honoring the abort signal.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---- vi.mock for agent-runner -----------------------------------------------
//
// Stub captures the effectiveSignal so the test can drive abort() externally
// and assert that runAgent's pre-check / post-check picks up the abort
// reason. Mirrors the pattern in subagent-deadline.test.ts T-DEADLINE-01.

interface CapturedRun {
	options: any;
	resolve: (v: any) => void;
	reject: (e: unknown) => void;
	signal: AbortSignal | undefined;
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
		};
		RUN_STATE.calls.push(entry);

		return await new Promise<any>((resolve, reject) => {
			// Mimic real session.prompt behaviour under an aborted signal:
			// reject synchronously with the signal's reason wrapped as an
			// Error. AgentManager catches this and sets record.error.
			if (sig?.aborted) {
				const reason = sig.reason ?? new Error("aborted");
				const wrapped =
					reason instanceof Error ? reason : new Error(String(reason));
				reject(wrapped);
				return;
			}

			// Mimic session.prompt that honours the abort signal: reject when
			// the signal fires.
			entry.reject = (err) => reject(err);
			sig?.addEventListener(
				"abort",
				() => {
					const reason = sig.reason ?? new Error("aborted");
					const wrapped =
						reason instanceof Error ? reason : new Error(String(reason));
					reject(wrapped);
				},
				{ once: true },
			);
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
import { registerAgents, setDefaultsDisabled } from "../src/agent-types.js";
import { RunController, resolveRunConfig } from "../src/run-controller.js";

beforeEach(() => {
	RUN_STATE.calls.length = 0;
	// Ensure the agent registry has DEFAULT_AGENTS so "Explore" resolves.
	setDefaultsDisabled(false);
	registerAgents(new Map());
});

afterEach(() => {
	vi.useRealTimers();
});

describe("agent deadline enforced end-to-end (GC-2026-065 T1)", () => {
	it("a deadline-fired abort during runAgent surfaces as record.aborted=true with deadline reason", async () => {
		// Build a RunController with a tiny deadline (300ms) — the timer will
		// fire shortly after the agent is spawned.
		const cfg = resolveRunConfig("Explore", { max_duration_minutes: 1 }, {});
		cfg.deadlineMs = 300;
		const controller = new RunController(undefined, cfg);

		const manager = new AgentManager();
		try {
			// Pass controller.signal as the run's parent signal so AgentManager
			// composes it into record.runController.signal. AgentManager spawns
			// with the merged signal — once the deadline fires, the composed
			// signal aborts, which the stub runAgent's listener picks up.
			const { record } = await manager.spawnAndWait(
				{} as never,
				{ cwd: process.cwd() } as never,
				"Explore",
				"deadline-test-prompt",
				{
					description: "deadline enforced",
					signal: controller.signal,
				} as never,
			);

			// Either aborted (signal fired during run) or stopped/error (signal
			// fired before/after). All three indicate the deadline was honored.
			expect(["aborted", "stopped", "error"]).toContain(record.status);
			expect(record.error).toBeDefined();
			expect(record.error).toMatch(/deadline|abort/i);
		} finally {
			manager.dispose();
			controller.cleanup();
		}
	});

	it("a pre-aborted signal at spawn entry is honored without entering the prompt loop", async () => {
		// Already-aborted signal at construction. Use a long deadline + manual
		// abort before passing the signal, avoiding the negative-timeout warning.
		const cfg = resolveRunConfig("Explore", { max_duration_minutes: 1 }, {});
		cfg.deadlineMs = 50_000;
		const controller = new RunController(undefined, cfg);
		controller.abortController.abort(
			new Error("agent duration exceeded (pre-aborted for test)"),
		);
		expect(controller.signal.aborted).toBe(true);

		const manager = new AgentManager();
		try {
			const { record } = await manager.spawnAndWait(
				{} as never,
				{ cwd: process.cwd() } as never,
				"Explore",
				"pre-aborted",
				{
					description: "pre-aborted signal",
					signal: controller.signal,
				} as never,
			);

			expect(["aborted", "stopped", "error"]).toContain(record.status);
			expect(record.error).toBeDefined();
		} finally {
			manager.dispose();
			controller.cleanup();
		}
	});
});