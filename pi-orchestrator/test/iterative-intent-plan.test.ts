/**
 * iterative-intent-plan.test.ts — `task_plan_intent` + `task_add_phase` +
 * `task_close_intent` + `validateCumulativePhases`.
 *
 * Goal: support a todowrite-first intent flow where the LLM declares
 * shape + rationale first, then materializes ONE plan task per call,
 * then closes the intent with a full audit stamp. The 3 new tools are
 * additive — `task_convert_intent` keeps its atomic semantics for
 * backward compat (covered by `convert-intent-tool.test.ts`).
 *
 * Run: `cd pi-orchestrator && bun test ./test/iterative-intent-plan.test.ts`
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@sages/pi-tasks/task-store";
import { orchestratorProjectTaskFile } from "@sages/pi-tasks/task-paths";
import {
	ConvertIntentError,
	PHASE_AGENT_TYPE,
	taskCloseIntent,
	taskAddPhase,
	taskPlanIntent,
} from "../src/orchestrator-tool.js";
import {
	PhaseValidationError,
	type Phase,
	validateCumulativePhases,
} from "../src/phase-validation.js";

/** Create an intent task directly via the store. */
function createIntent(scratch: string, subject = "Add /login", description = "Full /login flow") {
	const store = new TaskStore(orchestratorProjectTaskFile(scratch));
	return store.create(subject, description, undefined, undefined, "intent").id;
}

function planIntent(
	scratch: string,
	task_id: string,
	plan: { intent_shape: string; rationale: string },
) {
	return taskPlanIntent("call-1", { task_id, plan }, undefined, undefined, { cwd: scratch });
}

function addPhase(
	scratch: string,
	intent_id: string,
	phase: { phase: Phase; subject: string; description: string; activeForm?: string; metadata?: Record<string, unknown> },
) {
	return taskAddPhase("call-1", { intent_id, phase }, undefined, undefined, { cwd: scratch });
}

function closeIntent(scratch: string, intent_id: string) {
	return taskCloseIntent("call-1", { intent_id }, undefined, undefined, { cwd: scratch });
}

// ─── validateCumulativePhases — per-add semantics ────────────────────────

describe("validateCumulativePhases — per-add semantics", () => {
	it("rejects an empty list (caller must add at least one phase before close)", () => {
		expect(() => validateCumulativePhases("standard", [])).toThrow(PhaseValidationError);
		try {
			validateCumulativePhases("standard", []);
		} catch (err) {
			expect((err as PhaseValidationError).rule).toBe("empty_phases");
		}
	});

	it("standard: 1st add must be 'implement' (catches wrong first phase immediately)", () => {
		// Wrong first phase
		expect(() => validateCumulativePhases("standard", ["review"])).toThrow(PhaseValidationError);
		try {
			validateCumulativePhases("standard", ["review"]);
		} catch (err) {
			expect((err as PhaseValidationError).rule).toBe("first_phase_mismatch");
		}
		// Right first phase
		expect(() => validateCumulativePhases("standard", ["implement"])).not.toThrow();
	});

	it("standard: 2nd add must be 'review' (catches wrong last phase at cap)", () => {
		// OK at cap
		expect(() => validateCumulativePhases("standard", ["implement", "review"])).not.toThrow();
		// Wrong last at cap
		expect(() => validateCumulativePhases("standard", ["implement", "implement"])).toThrow(
			PhaseValidationError,
		);
		try {
			validateCumulativePhases("standard", ["implement", "implement"]);
		} catch (err) {
			expect((err as PhaseValidationError).rule).toBe("last_phase_mismatch");
		}
	});

	it("standard: 3rd add is REJECTED at the cap (phase_count_out_of_bounds)", () => {
		expect(() =>
			validateCumulativePhases("standard", ["implement", "review", "implement"]),
		).toThrow(PhaseValidationError);
		try {
			validateCumulativePhases("standard", ["implement", "review", "implement"]);
		} catch (err) {
			expect((err as PhaseValidationError).rule).toBe("phase_count_out_of_bounds");
		}
	});

	it("multi-phase: each prefix up to the cap is valid (design → implement → test → review)", () => {
		expect(() => validateCumulativePhases("multi-phase", ["design"])).not.toThrow();
		expect(() => validateCumulativePhases("multi-phase", ["design", "implement"])).not.toThrow();
		expect(() =>
			validateCumulativePhases("multi-phase", ["design", "implement", "test"]),
		).not.toThrow();
		expect(() =>
			validateCumulativePhases("multi-phase", ["design", "implement", "test", "review"]),
		).not.toThrow();
	});

	it("multi-phase: 9th add is REJECTED at the cap (max 8 per EXPECTED_PHASE_COUNT)", () => {
		// multi-phase allows 3–8 phases per the shape catalog; the
		// 9th add busts the cap.
		const nine = [
			"design",
			"implement",
			"test",
			"review",
			"implement",
			"test",
			"implement",
			"test",
			"review",
		] as Phase[];
		expect(() => validateCumulativePhases("multi-phase", nine)).toThrow(PhaseValidationError);
		try {
			validateCumulativePhases("multi-phase", nine);
		} catch (err) {
			expect((err as PhaseValidationError).rule).toBe("phase_count_out_of_bounds");
		}
	});

	it("multi-phase: at the cap (8), the last phase must be 'review'", () => {
		// 8 phases ending in 'implement' — wrong last phase at completion.
		const eight = [
			"design",
			"implement",
			"test",
			"test",
			"implement",
			"test",
			"implement",
			"implement",
		] as Phase[];
		expect(() => validateCumulativePhases("multi-phase", eight)).toThrow(PhaseValidationError);
		try {
			validateCumulativePhases("multi-phase", eight);
		} catch (err) {
			expect((err as PhaseValidationError).rule).toBe("last_phase_mismatch");
		}
	});

	it("multi-track: all phases must be 'implement' (parallel tracks)", () => {
		expect(() => validateCumulativePhases("multi-track", ["implement"])).not.toThrow();
		expect(() =>
			validateCumulativePhases("multi-track", ["implement", "implement"]),
		).not.toThrow();
		// Adding a 'review' to a multi-track is REJECTED (defer review to a 2nd intent).
		expect(() =>
			validateCumulativePhases("multi-track", ["implement", "implement", "review"]),
		).toThrow(PhaseValidationError);
	});

	it("multi-track: must not be a single 'implement' (reclassify as 'small' or 'standard')", () => {
		// single implement → not parallel → reject (the shape requires ≥ 2 implement).
		// Cumulative validator: at length 1 it's still under min; we only enforce all-implement
		// at length ≥ 2. So length=1 with 'implement' is fine — the close-time check rejects.
		expect(() => validateCumulativePhases("multi-track", ["implement"])).not.toThrow();
		// 2+ implements all-implement is fine
		expect(() =>
			validateCumulativePhases("multi-track", ["implement", "implement"]),
		).not.toThrow();
		// 2+ but mixed is rejected
		expect(() =>
			validateCumulativePhases("multi-track", ["implement", "design"]),
		).toThrow(PhaseValidationError);
	});

	it("trivial: rejects a 'review' phase (catches at the boundary)", () => {
		expect(() => validateCumulativePhases("trivial", ["review"])).toThrow(PhaseValidationError);
		try {
			validateCumulativePhases("trivial", ["review"]);
		} catch (err) {
			expect((err as PhaseValidationError).rule).toBe("trivial_shape_has_review");
		}
	});

	it("any shape: rejects 2+ review phases (board-wide rule)", () => {
		expect(() =>
			validateCumulativePhases("multi-phase", ["design", "review", "review"]),
		).toThrow(PhaseValidationError);
	});

	it("any shape: rejects any phase past the per-shape max (catches over-decomposition early)", () => {
		// small cap = 2
		expect(() => validateCumulativePhases("small", ["implement", "review", "test"])).toThrow(
			PhaseValidationError,
		);
		// investigate-then-fix cap = 6
		const seven = [
			"investigate",
			"implement",
			"test",
			"test",
			"implement",
			"test",
			"review",
		] as Phase[];
		expect(() => validateCumulativePhases("investigate-then-fix", seven)).toThrow(
			PhaseValidationError,
		);
	});
});

// ─── task_plan_intent — declare shape + rationale ─────────────────────────

describe("task_plan_intent — declare shape + rationale on the intent", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-iter-plan-"));
	});

	it("stamps metadata.planning.{shape, rationale, phases_added, plan_task_ids} on the intent", async () => {
		const intentId = createIntent(scratch);
		const out: any = await planIntent(scratch, intentId, {
			intent_shape: "standard",
			rationale: "Multi-file within one package; one Reviewer at the end.",
		});

		expect(out.details.intent_shape).toBe("standard");
		expect(out.details.rationale).toMatch(/Multi-file/);
		expect(out.details.phases_added).toBe(0);
		expect(out.details.plan_task_ids).toEqual([]);

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const intent = store.get(intentId)!;
		expect(intent.metadata?.planning?.shape).toBe("standard");
		expect(intent.metadata?.planning?.rationale).toMatch(/Multi-file/);
		expect(intent.metadata?.planning?.phases_added).toBe(0);
		expect(intent.metadata?.planning?.plan_task_ids).toEqual([]);
		// intent stays pending — the close step flips it
		expect(intent.status).toBe("pending");
	});

	it("rejects an unknown intent id with intent_not_found", async () => {
		try {
			await planIntent(scratch, "999", {
				intent_shape: "standard",
				rationale: "Should not reach here.",
			});
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("intent_not_found");
		}
	});

	it("rejects a non-intent task with not_intent", async () => {
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const planId = store.create("Existing plan", "...", undefined, undefined, "plan").id;
		try {
			await planIntent(scratch, planId, {
				intent_shape: "standard",
				rationale: "Should not reach here either.",
			});
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("not_intent");
		}
	});

	it("rejects rationale shorter than 10 chars (rationale_too_short)", async () => {
		const intentId = createIntent(scratch);
		try {
			await planIntent(scratch, intentId, {
				intent_shape: "standard",
				rationale: "too short", // 9 chars
			});
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/Rationale MUST be ≥ 10/);
		}
	});

	it("rejects rationale longer than 500 chars (rationale_too_long)", async () => {
		const intentId = createIntent(scratch);
		try {
			await planIntent(scratch, intentId, {
				intent_shape: "standard",
				rationale: "x".repeat(501),
			});
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/≤ 500/);
		}
	});

	it("rejects an already-planned intent (must re-classify to a new intent if shape changes)", async () => {
		const intentId = createIntent(scratch);
		await planIntent(scratch, intentId, {
			intent_shape: "standard",
			rationale: "First declaration of shape and rationale.",
		});

		try {
			await planIntent(scratch, intentId, {
				intent_shape: "multi-phase",
				rationale: "Second declaration — should be rejected.",
			});
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("already_planned");
		}
	});
});

// ─── task_add_phase — one plan task per call, cumulative validation ──────

describe("task_add_phase — materialize one plan task per call", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-iter-add-"));
	});

	it("appends a plan task to the intent's plan_task_ids with metadata stamps", async () => {
		const intentId = createIntent(scratch);
		await planIntent(scratch, intentId, {
			intent_shape: "standard",
			rationale: "Standard Implement → Review shape; one Reviewer at the end.",
		});

		const out: any = await addPhase(scratch, intentId, {
			phase: "implement",
			subject: "Implement /login endpoint",
			description:
				"Add POST /login handler in src/auth/login.ts with 200/401/400 outcomes. RED first.",
		});
		expect(out.details.plan_task_id).toBeTruthy();
		expect(out.details.cumulative_phase_count).toBe(1);

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const plan = store.get(out.details.plan_task_id)!;
		expect(plan.type).toBe("plan");
		expect(plan.metadata?.source_intent).toBe(intentId);
		expect(plan.metadata?.phase).toBe("implement");
		expect(plan.metadata?.agentType).toBe("Developer");
		expect(plan.metadata?.cumulative_phase_count).toBe(1);

		// intent's planning state updated
		const intent = store.get(intentId)!;
		expect(intent.metadata?.planning?.phases_added).toBe(1);
		expect(intent.metadata?.planning?.plan_task_ids).toEqual([out.details.plan_task_id]);
	});

	it("review phase maps to Reviewer agentType (PHASE_AGENT_TYPE)", async () => {
		const intentId = createIntent(scratch);
		await planIntent(scratch, intentId, {
			intent_shape: "standard",
			rationale: "Standard Implement → Review shape; one Reviewer at the end.",
		});
		await addPhase(scratch, intentId, {
			phase: "implement",
			subject: "Implement",
			description: "x".repeat(40),
		});
		const out: any = await addPhase(scratch, intentId, {
			phase: "review",
			subject: "Review",
			description: "x".repeat(40),
		});

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const plan = store.get(out.details.plan_task_id)!;
		expect(plan.metadata?.agentType).toBe("Reviewer");
		expect(plan.metadata?.phase).toBe("review");
		expect(plan.metadata?.cumulative_phase_count).toBe(2);
	});

	it("rejects adding a phase before task_plan_intent (intent not yet planned)", async () => {
		const intentId = createIntent(scratch);
		try {
			await addPhase(scratch, intentId, {
				phase: "implement",
				subject: "Implement",
				description: "x".repeat(40),
			});
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("not_planned");
		}
	});

	it("rejects an add past the per-shape cap (catches over-decomposition at the boundary)", async () => {
		const intentId = createIntent(scratch);
		await planIntent(scratch, intentId, {
			intent_shape: "standard",
			rationale: "Standard shape; cap is 2 phases.",
		});
		await addPhase(scratch, intentId, {
			phase: "implement",
			subject: "Implement",
			description: "x".repeat(40),
		});
		await addPhase(scratch, intentId, {
			phase: "review",
			subject: "Review",
			description: "x".repeat(40),
		});

		// 3rd add must be rejected
		try {
			await addPhase(scratch, intentId, {
				phase: "implement",
				subject: "Third phase",
				description: "Should not fit a standard cap of 2.",
			});
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/phase_count_out_of_bounds|≤ 2/);
		}
	});

	it("rejects an add with a wrong first phase (e.g., 'review' first on a 'standard' intent)", async () => {
		const intentId = createIntent(scratch);
		await planIntent(scratch, intentId, {
			intent_shape: "standard",
			rationale: "Standard shape; first phase must be implement.",
		});
		try {
			await addPhase(scratch, intentId, {
				phase: "review",
				subject: "Review first",
				description: "Reviewing before implementing — shape mismatch.",
			});
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/first phase 'implement'/);
		}
	});

	it("rejects an add to an intent that has been closed (close is terminal)", async () => {
		const intentId = createIntent(scratch);
		await planIntent(scratch, intentId, {
			intent_shape: "standard",
			rationale: "Standard shape; one Reviewer at the end.",
		});
		await addPhase(scratch, intentId, {
			phase: "implement",
			subject: "Implement",
			description: "x".repeat(40),
		});
		await addPhase(scratch, intentId, {
			phase: "review",
			subject: "Review",
			description: "x".repeat(40),
		});
		await closeIntent(scratch, intentId);

		try {
			await addPhase(scratch, intentId, {
				phase: "implement",
				subject: "After close",
				description: "Adding more after close — should be rejected.",
			});
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("already_closed");
		}
	});
});

// ─── task_close_intent — terminal audit stamp ─────────────────────────────

describe("task_close_intent — terminal audit stamp on the intent", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-iter-close-"));
	});

	it("flips intent to 'completed' and stamps converted / converted_at / plan_task_ids", async () => {
		const intentId = createIntent(scratch);
		await planIntent(scratch, intentId, {
			intent_shape: "standard",
			rationale: "Standard shape; one Reviewer at the end.",
		});
		const a = await addPhase(scratch, intentId, {
			phase: "implement",
			subject: "Implement",
			description: "x".repeat(40),
		});
		const b = await addPhase(scratch, intentId, {
			phase: "review",
			subject: "Review",
			description: "x".repeat(40),
		});

		const before = Date.now();
		const out: any = await closeIntent(scratch, intentId);
		const after = Date.now();

		expect(out.details.plan_task_ids).toEqual([
			(a as any).details.plan_task_id,
			(b as any).details.plan_task_id,
		]);
		expect(typeof out.details.closed_at).toBe("number");
		expect(out.details.closed_at).toBeGreaterThanOrEqual(before);
		expect(out.details.closed_at).toBeLessThanOrEqual(after);

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const intent = store.get(intentId)!;
		expect(intent.status).toBe("completed");
		expect(intent.metadata?.converted).toBe(true);
		expect(typeof intent.metadata?.converted_at).toBe("number");
		expect(intent.metadata?.plan_task_ids).toEqual([
			(a as any).details.plan_task_id,
			(b as any).details.plan_task_id,
		]);
		// planning state preserved for audit
		expect(intent.metadata?.planning?.shape).toBe("standard");
		expect(intent.metadata?.planning?.phases_added).toBe(2);
	});

	it("rejects close on a non-planned intent (must call task_plan_intent first)", async () => {
		const intentId = createIntent(scratch);
		try {
			await closeIntent(scratch, intentId);
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("not_planned");
		}
	});

	it("rejects close when accumulated phases violate the declared shape (e.g., multi-track with < 2 implements)", async () => {
		const intentId = createIntent(scratch);
		await planIntent(scratch, intentId, {
			intent_shape: "multi-track",
			rationale: "Multi-track — needs ≥ 2 implement phases.",
		});
		// Add only 1 implement (under the min for multi-track)
		await addPhase(scratch, intentId, {
			phase: "implement",
			subject: "Single track",
			description: "x".repeat(40),
		});

		try {
			await closeIntent(scratch, intentId);
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/multi-track/);
		}
	});

	it("rejects a second close on the same intent (close is idempotent-blocked)", async () => {
		const intentId = createIntent(scratch);
		await planIntent(scratch, intentId, {
			intent_shape: "standard",
			rationale: "Standard shape; one Reviewer at the end.",
		});
		await addPhase(scratch, intentId, {
			phase: "implement",
			subject: "Implement",
			description: "x".repeat(40),
		});
		await addPhase(scratch, intentId, {
			phase: "review",
			subject: "Review",
			description: "x".repeat(40),
		});
		await closeIntent(scratch, intentId);

		try {
			await closeIntent(scratch, intentId);
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("already_closed");
		}
	});
});

// ─── End-to-end: the todowrite-first flow (canonical use) ─────────────────

describe("iterative intent flow — canonical use case", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-iter-e2e-"));
	});

	it("plan_intent → add_phase × 2 → close_intent leaves a complete audit trail", async () => {
		const intentId = createIntent(scratch, "Add /login endpoint", "Full /login flow");

		// 1. Declare shape + rationale (todowrite step).
		const plan = await planIntent(scratch, intentId, {
			intent_shape: "standard",
			rationale: "Multi-file within one package; one Reviewer at the end.",
		});
		expect((plan as any).details.phases_added).toBe(0);

		// 2. Materialize the implement phase (todowrite item #1).
		const a = await addPhase(scratch, intentId, {
			phase: "implement",
			subject: "Implement /login",
			description:
				"Add POST /login in src/auth/login.ts: 200 + session cookie, 401, 400. RED first.",
		});
		expect((a as any).details.cumulative_phase_count).toBe(1);

		// 3. Materialize the review phase (todowrite item #2).
		const b = await addPhase(scratch, intentId, {
			phase: "review",
			subject: "Review /login",
			description:
				"Read Developer's metadata.result. Verify tests pass; cookie HttpOnly; emit verdict.",
		});
		expect((b as any).details.cumulative_phase_count).toBe(2);

		// 4. Close the intent (terminal audit).
		const close = await closeIntent(scratch, intentId);
		expect((close as any).details.plan_task_ids).toHaveLength(2);

		// Final state
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const intent = store.get(intentId)!;
		expect(intent.status).toBe("completed");
		expect(intent.metadata?.converted).toBe(true);
		expect(intent.metadata?.planning?.shape).toBe("standard");
		expect(intent.metadata?.planning?.phases_added).toBe(2);

		// Both plan tasks wired back to the intent with the right phase / agentType
		for (const id of (close as any).details.plan_task_ids) {
			const planTask = store.get(id)!;
			expect(planTask.type).toBe("plan");
			expect(planTask.metadata?.source_intent).toBe(intentId);
			expect(planTask.metadata?.agentType).toBeTruthy();
			expect(planTask.metadata?.phase).toBeTruthy();
		}
	});

	it("multi-phase intent: 4 phases, all distinct agent types via PHASE_AGENT_TYPE", async () => {
		const intentId = createIntent(scratch);
		await planIntent(scratch, intentId, {
			intent_shape: "multi-phase",
			rationale: "Staged rollout; design first, then implement, test, review.",
		});
		const a = await addPhase(scratch, intentId, {
			phase: "design",
			subject: "Design",
			description: "x".repeat(40),
		});
		const b = await addPhase(scratch, intentId, {
			phase: "implement",
			subject: "Implement",
			description: "x".repeat(40),
		});
		const c = await addPhase(scratch, intentId, {
			phase: "test",
			subject: "Test",
			description: "x".repeat(40),
		});
		const d = await addPhase(scratch, intentId, {
			phase: "review",
			subject: "Review",
			description: "x".repeat(40),
		});

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		expect(store.get((a as any).details.plan_task_id)?.metadata?.agentType).toBe("Developer");
		expect(store.get((b as any).details.plan_task_id)?.metadata?.agentType).toBe("Developer");
		expect(store.get((c as any).details.plan_task_id)?.metadata?.agentType).toBe("Developer");
		expect(store.get((d as any).details.plan_task_id)?.metadata?.agentType).toBe("Reviewer");

		await closeIntent(scratch, intentId);
	});
});

// ─── PHASE_AGENT_TYPE — still maps the same ───────────────────────────────

describe("PHASE_AGENT_TYPE mapping (unchanged)", () => {
	it("maps every phase deterministically; review is the only Reviewer", () => {
		expect(PHASE_AGENT_TYPE.investigate).toBe("Developer");
		expect(PHASE_AGENT_TYPE.design).toBe("Developer");
		expect(PHASE_AGENT_TYPE.implement).toBe("Developer");
		expect(PHASE_AGENT_TYPE.test).toBe("Developer");
		expect(PHASE_AGENT_TYPE.review).toBe("Reviewer");
	});
});
