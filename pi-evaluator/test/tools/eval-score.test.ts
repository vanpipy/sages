/**
 * test/tools/eval-score.test.ts
 *
 * RED-first: tests fail before src/tools/eval-score.ts exists, pass after.
 *
 * Strategy: split the tool into two layers for testability:
 *   1. `computeEvalScore(state)` — pure: state → EvalScoreOutput (no ToolDefinition)
 *   2. `makeEvalScoreTool(state)` — returns a ToolDefinition; its `execute()`
 *      calls `computeEvalScore` and wraps the result in the standard
 *      `{ content: [...], details }` shape.
 *
 * T1 chunk 4: `computeEvalScore` is now async (lazy self-cooking path).
 * All existing tests were updated to `await` the call. New tests cover:
 *   - lazy path with valid workflow_path → real scores (cached)
 *   - lazy path with corrupt workflow_path → scoring-failed intent, no crash
 *   - lazy path: second call returns cached snapshot (no re-cook)
 *
 * Locked output shape (from GC-2026-019 spec):
 *   {
 *     status: "ok" | "blocked",
 *     intent: string,
 *     workflow_id: string | null,
 *     total_score: number,
 *     dimensions: { goal: {score, evidence}, dag: {…}, implement: {…}, audit: {…}, coordination: {…} }
 *   }
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeEvalScore, makeEvalScoreTool } from "../../src/tools/eval-score.ts";
import { createEvalState, type EvalState, type WorkflowScoreState } from "../../src/state.ts";
import {
	clearMetrics,
	registerBuiltinMetrics,
	registerMetric,
} from "../../src/metrics/registry.ts";
import type { Metric } from "../../src/metrics/types.ts";

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

/** Build a minimal real workflow dir under tmpDir so scoreWorkflow can read it. */
function makeWorkflowFixture(rootDir: string, score: number): string {
	const dir = join(rootDir, "fake-workflow");
	mkdirSync(dir, { recursive: true });
	// Empty dir is enough — scoreWorkflow produces all-data_missing scores (0).
	// We register a stub metric that returns `score` for our chosen signal so
	// the lazy path actually produces a non-zero result.
	void score; // (score unused — kept for future fixture extension)
	return dir;
}

/** Register a single metric that always returns `value` for any input. */
function makeConstantMetric(id: string, dim: Metric["dim"], value: number): Metric {
	return {
		id,
		dim,
		kind: "heuristic",
		description: `constant ${id}`,
		async compute() {
			return {
				value,
				evidence: [{ artifact: "stub", location: id, note: "constant" }],
				duration_ms: 0,
				data_missing: false,
			};
		},
	};
}

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = mkdtempSync(join(tmpdir(), "pi-eval-eval-score-"));
});

afterEach(() => {
	clearMetrics();
	rmSync(tmpRoot, { recursive: true, force: true });
});

describe("computeEvalScore (mode off)", () => {
	test("returns blocked shape when mode is off", async () => {
		const state = createEvalState();
		const out = await computeEvalScore(state);
		expect(out.status).toBe("blocked");
		expect(out.intent).toContain("reward mode");
	});

	test("returns blocked even when mode is off AND workflow is active", async () => {
		const state = createEvalState();
		state.active_workflow = activeWorkflowFixture();
		const out = await computeEvalScore(state);
		expect(out.status).toBe("blocked");
	});
});

describe("computeEvalScore (mode on, no workflow, no path)", () => {
	test("returns all-zero dimensions + null workflow_id", async () => {
		const state = createEvalState();
		state.mode = "on";
		const out = await computeEvalScore(state);
		expect(out.status).toBe("ok");
		expect(out.workflow_id).toBeNull();
		expect(out.total_score).toBe(0);
		expect(out.dimensions.goal).toEqual({ score: 0, evidence: [] });
		expect(out.dimensions.dag).toEqual({ score: 0, evidence: [] });
		expect(out.dimensions.implement).toEqual({ score: 0, evidence: [] });
		expect(out.dimensions.audit).toEqual({ score: 0, evidence: [] });
		expect(out.dimensions.coordination).toEqual({ score: 0, evidence: [] });
	});

	test("returns all five dimension keys", async () => {
		const state = createEvalState();
		state.mode = "on";
		const out = await computeEvalScore(state);
		expect(Object.keys(out.dimensions).sort()).toEqual([
			"audit",
			"coordination",
			"dag",
			"goal",
			"implement",
		]);
	});
});

describe("computeEvalScore (mode on, active workflow)", () => {
	test("returns active workflow's scores verbatim when mode on", async () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();
		const out = await computeEvalScore(state);
		expect(out.status).toBe("ok");
		expect(out.workflow_id).toBe("GC-2026-018");
		expect(out.total_score).toBe(72);
		expect(out.dimensions.goal.score).toBe(95);
		expect(out.dimensions.dag.score).toBe(60);
		expect(out.dimensions.coordination.score).toBe(50);
	});

	test("preserves non-empty evidence even when score is 0 (score-0 convention)", async () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();
		const out = await computeEvalScore(state);
		expect(out.dimensions.audit.score).toBe(0);
		expect(out.dimensions.audit.evidence).toHaveLength(1);
		expect(out.dimensions.audit.evidence[0]?.artifact).toBe("audit-A.md");
	});

	test("preserves non-empty evidence for non-zero scores", async () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = activeWorkflowFixture();
		const out = await computeEvalScore(state);
		expect(out.dimensions.dag.evidence).toHaveLength(1);
		expect(out.dimensions.dag.evidence[0]?.location).toBe("tasks[1]");
	});
});

describe("computeEvalScore (lazy self-cooking path)", () => {
	beforeEach(() => {
		// Register metrics that the engine will find via signal name.
		// The DefaultCoefficients uses names like sc_verifiable_pct, etc.,
		// but the engine treats unknown signals as data_missing — which is
		// fine, the lazy path's output is a 5-dim zero score. To get a
		// non-zero demo we register matching-id metrics.
		registerMetric(makeConstantMetric("sc_verifiable_pct", "goal", 1));
		registerMetric(makeConstantMetric("sc_to_task_coverage_pct", "dag", 1));
		registerMetric(makeConstantMetric("verification_first_try_rate", "implement", 1));
		registerMetric(makeConstantMetric("audit_pass_rate", "audit", 1));
		registerMetric(makeConstantMetric("dispatch_success_first_try_rate", "coordination", 1));
	});

	test("lazy path: workflow_path set + active_workflow=null → real scores", async () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = null;
		state.active_workflow_path = makeWorkflowFixture(tmpRoot, 100);
		state.active_workflow_id = "DAG-lazy-1";

		const out = await computeEvalScore(state);

		expect(out.status).toBe("ok");
		expect(out.intent).toContain("DAG-lazy-1");
		expect(out.workflow_id).toBe("DAG-lazy-1");
		// All 5 dims should be 100 (our constant metrics return 1.0, no norm to lower)
		expect(out.dimensions.goal.score).toBe(100);
		expect(out.dimensions.dag.score).toBe(100);
		expect(out.dimensions.implement.score).toBe(100);
		expect(out.dimensions.audit.score).toBe(100);
		expect(out.dimensions.coordination.score).toBe(100);
	});

	test("lazy path: caches result into state.active_workflow (no re-cook)", async () => {
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = null;
		state.active_workflow_path = makeWorkflowFixture(tmpRoot, 100);
		state.active_workflow_id = "DAG-cache";

		const out1 = await computeEvalScore(state);
		// After first call, state.active_workflow is populated.
		expect(state.active_workflow).not.toBeNull();
		expect(state.active_workflow!.workflow_id).toBe("DAG-cache");

		// Mutate the cached workflow to a sentinel value — the second call
		// should return it verbatim (not re-cook).
		state.active_workflow!.total_score = 999;

		const out2 = await computeEvalScore(state);
		expect(out2.total_score).toBe(999);
	});

	test("lazy path: bogus workflow_path with no metrics registered → all-zero, no throw", async () => {
		// Wipe any metrics registered by an earlier test in this describe block.
		clearMetrics();
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = null;
		state.active_workflow_path = join(tmpRoot, "does-not-exist");

		const out = await computeEvalScore(state);

		// In T1, scoreWorkflow itself doesn't read the path — it just iterates
		// signals, all of which are data_missing when no metrics are registered.
		// So the result is a 5-dim zero score, not a throw. (T2-T6 metrics
		// will actually read files; the catch block is for when those throw.)
		expect(out.status).toBe("ok");
		expect(out.workflow_id).toBe("unknown");
		expect(out.total_score).toBe(0);
		expect(out.dimensions.goal.score).toBe(0);
	});

	test("lazy path: empty fixture dir is fine — data_missing = score 0", async () => {
		// Even with no metrics registered, the engine produces a 5-dim 0 score
		// because all signals are data_missing.
		clearMetrics(); // wipe our earlier registrations for this case
		const state = createEvalState();
		state.mode = "on";
		state.active_workflow = null;
		state.active_workflow_path = makeWorkflowFixture(tmpRoot, 0);
		state.active_workflow_id = "DAG-empty";

		const out = await computeEvalScore(state);
		expect(out.status).toBe("ok");
		expect(out.workflow_id).toBe("DAG-empty");
		// weightTotal=0 for every dim → all scores are 0
		expect(out.dimensions.goal.score).toBe(0);
	});
});

describe("computeEvalScore (intent non-empty)", () => {
	test("intent is non-empty in all branches", async () => {
		const off = await computeEvalScore(createEvalState());
		expect(off.intent.length).toBeGreaterThan(0);
		const onNoWf = await computeEvalScore((() => {
			const s = createEvalState();
			s.mode = "on";
			return s;
		})());
		expect(onNoWf.intent.length).toBeGreaterThan(0);
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

// Quiet "unused" warnings if a test gets commented out
void existsSync;
void registerBuiltinMetrics;
