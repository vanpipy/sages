/**
 * pi-evaluator/test/state.test.ts
 *
 * RED-first: these tests fail before src/state.ts exists, pass after.
 *
 * State container for the reward mode engine (engine-internal). Two pieces:
 *   1. createEvalState() — fresh state with mode=off and no active workflow
 *   2. DimensionScore / EvidenceRef / WorkflowScoreState — the structural types
 *      used by the eval_score tool output
 *
 * Why these structural tests? T3 (signal engine) will mutate the state; T2 must
 * lock its shape so the contract between T2 and T3 is executable.
 */

import { describe, expect, test } from "bun:test";

import {
	createEvalState,
	type DimensionScore,
	type EvidenceRef,
	type EvalState,
	type WorkflowScoreState,
} from "../src/state.ts";

describe("createEvalState", () => {
	test("starts with mode off", () => {
		const state = createEvalState();
		expect(state.mode).toBe("off");
	});

	test("starts with no active workflow", () => {
		const state = createEvalState();
		expect(state.active_workflow).toBeNull();
	});

	test("returns the EvalState shape", () => {
		const state: EvalState = createEvalState();
		expect(typeof state).toBe("object");
		// Mutability is implicit but verified by assignment below.
		state.mode = "on";
		expect(state.mode).toBe("on");
	});

	test("two fresh states are independent (no shared mutation surface)", () => {
		const a = createEvalState();
		const b = createEvalState();
		a.mode = "on";
		expect(b.mode).toBe("off");
	});
});

describe("EvidenceRef shape", () => {
	test("carries artifact / location / note strings", () => {
		const ref: EvidenceRef = {
			artifact: "goal-GC-2026-018.yaml",
			location: "SC1",
			note: "missing verification_cmd",
		};
		expect(ref.artifact).toBe("goal-GC-2026-018.yaml");
		expect(ref.location).toBe("SC1");
		expect(ref.note).toBe("missing verification_cmd");
	});
});

describe("DimensionScore shape", () => {
	test("zero score with empty evidence array = not yet observed", () => {
		const d: DimensionScore = { score: 0, evidence: [] };
		expect(d.score).toBe(0);
		expect(d.evidence).toHaveLength(0);
	});

	test("zero score with non-empty evidence = truly zero", () => {
		const d: DimensionScore = {
			score: 0,
			evidence: [{ artifact: "audit-A.md", location: "findings[0]", note: "all SCs failed" }],
		};
		expect(d.score).toBe(0);
		expect(d.evidence).toHaveLength(1);
	});
});

describe("WorkflowScoreState shape", () => {
	test("carries workflow_id + score + dimensions map", () => {
		const ws: WorkflowScoreState = {
			workflow_id: "GC-2026-018",
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
		expect(ws.workflow_id).toBe("GC-2026-018");
		expect(ws.total_score).toBe(72);
		expect(ws.dimensions.goal.score).toBe(95);
		expect(ws.dimensions.implement.score).toBe(0);
		expect(ws.dimensions.implement.evidence).toEqual([]);
	});
});
