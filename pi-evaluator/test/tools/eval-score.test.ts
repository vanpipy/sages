/**
 * pi-evaluator/test/tools/eval-score.test.ts
 *
 * RED-first: tests fail before src/tools/eval-score.ts exists, pass after.
 *
 * Strategy: split the tool into two layers for testability:
 *   1. `computeEvalScore(state)` — pure: state → EvalScoreOutput (no ToolDefinition)
 *   2. `makeEvalScoreTool(state)` — returns a ToolDefinition; its `execute()`
 *      calls `computeEvalScore` and wraps the result in the standard
 *      `{ content: [...], details }` shape.
 *
 * We test BOTH the pure compute and the execute() wrapper, so a bug in either
 * layer shows up clearly.
 *
 * Locked output shape (from GC-2026-019 spec):
 *   {
 *     status: "ok" | "blocked",
 *     intent: string,
 *     workflow_id: string | null,
 *     total_score: number,
 *     dimensions: { goal: {score, evidence}, dag: {…}, implement: {…}, audit: {…}, coordination: {…} }
 *   }
 *
 * Behaviors tested:
 *   - mode off → status="blocked", intent mentions mode-off
 *   - mode on + no active workflow → workflow_id null, all 5 dims score=0 evidence=[]
 *   - mode on + active workflow → returns state values verbatim
 *   - score-0 convention preserved (evidence non-empty when score is 0)
 *   - all 5 dimension keys present
 */

import { describe, expect, test } from "bun:test";

import { computeEvalScore, makeEvalScoreTool } from "../../src/tools/eval-score.ts";
import { createEvalState, type WorkflowScoreState } from "../../src/state.ts";

/** Helper: build a fully-populated active workflow for tests. */
function activeWorkflowFixture(): WorkflowScoreState {
	return {
		workflow_id: "GC-2026-018",
		started_at: "2026-07-25T10:00:00Z",
		total_score: 72,
		dimensions: {
			goal: { score: 95, evidence: [] },
			dag: {
				score: 60,
				evidence: [
					{ artifact: "dag-DAG-2026-018.yaml", location: "tasks[1]", note: "isolation: undefined" },
				],
			},
			implement: { score: 0, evidence: [] },
			audit: {
				score: 0,
				evidence: [{ artifact: "audit-A.md", location: "findings[0]", note: "all SCs failed" }],
			},
			coordination: { score: 50, evidence: [] },
		},
		signature: { sc_count: 4, task_count: 2, scope_dirs: ["src"], planes: ["core"] },
	};
}

describe("computeEvalScore", () => {
	test("returns blocked shape when mode is off", () => {
		const state = createEvalState(); // mode off, no workflow
		const out = computeEvalScore(state);
		expect(out.status).toBe("blocked");
		expect(out.intent).toContain("reward mode");
	});

	test("returns blocked even when mode is off AND workflow is active", () => {
		const state = createEvalState();
		state.active_workflow = activeWorkflowFixture();
		const out = computeEvalScore(state);
		expect(out.status).toBe("blocked");
	});

	test("returns all-zero dimensions + null workflow_id when mode on but no active workflow", () => {
		const state = createEvalState();
		state.mode = "on";
		const out = computeEvalScore(state);
		expect(out.status).toBe("ok");
		expect(out.workflow_id).toBeNull();
		expect(out.total_score).toBe(0);
		expect(out.dimensions.goal).toEqual({ score: 0, evidence: [] });
		expect(out.dimensions.dag).toEqual({ score: 0, evidence: [] });
		expect(out.dimensions.implement).toEqual({ score: 0, evidence: [] });
		expect(out.dimensions.audit).toEqual({ score: 0, evidence: [] });
		expect(out.dimensions.coordination).toEqual({ score: 0, evidence: [] });
	});

	test("returns all five dimension keys", () => {
		const state = createEvalState();
		state.mode = "on";
		const out = computeEvalScore(state);
		expect(Object.keys(out.dimensions).sort()).toEqual(
			["audit", "coordination", "dag", "goal", "implement"],
		);
	});

	test("returns active workflow's scores verbatim when mode on", () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();
		const out = computeEvalScore(state);
		expect(out.status).toBe("ok");
		expect(out.workflow_id).toBe("GC-2026-018");
		expect(out.total_score).toBe(72);
		expect(out.dimensions.goal.score).toBe(95);
		expect(out.dimensions.dag.score).toBe(60);
		expect(out.dimensions.coordination.score).toBe(50);
	});

	test("preserves non-empty evidence even when score is 0 (score-0 convention)", () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();
		const out = computeEvalScore(state);
		// audit has score=0 + evidence — must propagate both
		expect(out.dimensions.audit.score).toBe(0);
		expect(out.dimensions.audit.evidence).toHaveLength(1);
		expect(out.dimensions.audit.evidence[0]?.artifact).toBe("audit-A.md");
	});

	test("preserves non-empty evidence for non-zero scores", () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();
		const out = computeEvalScore(state);
		expect(out.dimensions.dag.evidence).toHaveLength(1);
		expect(out.dimensions.dag.evidence[0]?.location).toBe("tasks[1]");
	});

	test("intent is non-empty (success or blocked)", () => {
		const off = computeEvalScore(createEvalState());
		expect(off.intent.length).toBeGreaterThan(0);
		const on = computeEvalScore((() => {
			const s = createEvalState();
			s.mode = "on";
			return s;
		})());
		expect(on.intent.length).toBeGreaterThan(0);
	});
});

describe("makeEvalScoreTool", () => {
	test("returned tool definition has canonical shape", () => {
		const state = createEvalState();
		const tool = makeEvalScoreTool(state);
		expect(tool.name).toBe("eval_score");
		expect(typeof tool.label).toBe("string");
		expect(tool.label.length).toBeGreaterThan(0);
		expect(typeof tool.description).toBe("string");
		expect(tool.description.length).toBeGreaterThanOrEqual(100);
	});

	test("execute() wraps computeEvalScore in { content, details } envelope", async () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();

		const tool = makeEvalScoreTool(state);
		const result = await tool.execute("call-id", {} as never, undefined, undefined, {} as never);
		expect(result.content).toHaveLength(1);
		const first = result.content[0]!;
		expect(first.type).toBe("text");
		const text = (first as { type: "text"; text: string }).text;
		const parsed = JSON.parse(text);
		expect(parsed.status).toBe("ok");
		expect(parsed.workflow_id).toBe("GC-2026-018");
		expect(parsed.total_score).toBe(72);
	});
});
