/**
 * evaluator-sidebar-emit.test.ts — `makeEvalScoreTool` should emit
 * `sidebar:event` with `action: 'log'` + the score + dimensions after
 * the score is computed. The sidebar uses this to render a score badge
 * without re-querying the evaluator.
 *
 * The contract: `registerEvalTools` passes an emit callback to the
 * tool factory. The factory invokes it once per `execute()` with the
 * payload shape `{ action: 'log', target: 'evaluator', data: { score,
 * dimensions }, ts }`. `dimensions` is the per-dimension score (a
 * `Record<Dimension, number>`), not the full `DimensionScore` (with
 * evidence arrays) — the sidebar badge only needs the score, not the
 * evidence.
 *
 * Run: `cd pi-evaluator && bun test test/tools/evaluator-sidebar-emit.test.ts`
 */

import { describe, expect, test } from "bun:test";
import { makeEvalScoreTool } from "../../src/tools/eval-score.ts";
import { createEvalState, type WorkflowScoreState } from "../../src/state.ts";
import { registerEvalTools, type HistoricalReport } from "../../src/tools/index.ts";

/** Captured sidebar:event payload. Mirrors the contract on the listener side. */
interface CapturedSidebarEvent {
	action: string;
	target?: string;
	data?: unknown;
	ts: number;
}

/** Helper: build a fully-populated active workflow for tests. */
function activeWorkflowFixture(): WorkflowScoreState {
	return {
		workflow_id: "GC-2026-eval-sidebar",
		started_at: "2026-07-25T10:00:00Z",
		total_score: 72,
		dimensions: {
			goal: { score: 95, evidence: [] },
			dag: { score: 60, evidence: [] },
			implement: { score: 0, evidence: [] },
			audit: { score: 0, evidence: [] },
			coordination: { score: 50, evidence: [] },
		},
		signature: { sc_count: 4, task_count: 2, scope_dirs: ["src"], planes: ["core"] },
	};
}

/** Minimal mock pi with `events.emit` recorder. */
function mockPi(): { pi: any; emitted: CapturedSidebarEvent[] } {
	const emitted: CapturedSidebarEvent[] = [];
	const pi = {
		registerTool(def: any) { /* capture */ },
		events: {
			emit(channel: string, data: unknown) {
				if (channel === "sidebar:event") {
					emitted.push(data as CapturedSidebarEvent);
				}
			},
		},
	};
	return { pi, emitted };
}

describe("makeEvalScoreTool — sidebar:event emit", () => {
	test("emits action:'log' with score + dimensions after a successful score", async () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();

		const { pi, emitted } = mockPi();
		registerEvalTools(pi, state, [] as HistoricalReport[]);

		// Re-build the tool from the same state so we can call execute()
		// directly — registerEvalTools consumed the tool, but we also want
		// to drive it manually with the emit wired up via registerEvalTools.
		// Easier: register via the public factory so the closure captures
		// the emit. Re-register through registerEvalTools and call execute
		// on the registered tool via the test's pi.registerTool capture.
		const captured: any[] = [];
		pi.registerTool = (def: any) => captured.push(def);
		registerEvalTools(pi, state, []);

		const scoreTool = captured.find((t) => t.name === "eval_score")!;
		expect(scoreTool).toBeTruthy();
		const result = await scoreTool.execute("call-id", {} as never, undefined, undefined, {} as never);
		expect(result.content).toHaveLength(1);

		const logs = emitted.filter((e) => e.action === "log");
		expect(logs.length).toBe(1);
		const log = logs[0]!;
		expect(log.target).toBe("evaluator");
		expect(typeof log.ts).toBe("number");
		expect(log.ts).toBeGreaterThan(0);
		const data = log.data as { score: number; dimensions: Record<string, number> };
		expect(data.score).toBe(72);
		expect(data.dimensions.goal).toBe(95);
		expect(data.dimensions.dag).toBe(60);
		expect(data.dimensions.implement).toBe(0);
		expect(data.dimensions.audit).toBe(0);
		expect(data.dimensions.coordination).toBe(50);
		// All 5 dimensions must be present.
		expect(Object.keys(data.dimensions).sort()).toEqual([
			"audit",
			"coordination",
			"dag",
			"goal",
			"implement",
		]);
	});

	test("still emits a sidebar log row when mode is off (score=0, blocked)", async () => {
		const state = createEvalState();
		// mode is "off" by default
		expect(state.mode).toBe("off");

		const { pi, emitted } = mockPi();
		const captured: any[] = [];
		pi.registerTool = (def: any) => captured.push(def);
		registerEvalTools(pi, state, []);

		const scoreTool = captured.find((t) => t.name === "eval_score")!;
		await scoreTool.execute("call-id", {} as never, undefined, undefined, {} as never);

		const logs = emitted.filter((e) => e.action === "log");
		expect(logs.length).toBe(1);
		const log = logs[0]!;
		expect(log.target).toBe("evaluator");
		const data = log.data as { score: number; dimensions: Record<string, number> };
		expect(data.score).toBe(0);
	});

	test("emit failure is swallowed — the tool returns its normal envelope even when emit throws", async () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();

		const emitted: CapturedSidebarEvent[] = [];
		const pi: any = {
			registerTool(_def: any) {},
			events: {
				emit(_channel: string, _data: unknown) {
					throw new Error("event bus down");
				},
			},
		};

		// Re-register so the closure captures the throwing emit.
		const captured: any[] = [];
		pi.registerTool = (def: any) => captured.push(def);
		registerEvalTools(pi, state, []);
		const scoreTool = captured.find((t) => t.name === "eval_score")!;

		// Should NOT throw — emit errors are defensive-swallowed.
		const result = await scoreTool.execute("call-id", {} as never, undefined, undefined, {} as never);
		expect(result.content).toHaveLength(1);
	});
});
