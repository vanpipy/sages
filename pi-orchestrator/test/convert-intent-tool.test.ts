/**
 * convert-intent-tool.test.ts — `task_convert_intent(task_id, plan)`
 *
 * Plan shape: STRUCTURED object (intent_shape + rationale + phases[]).
 * The function validates phase count + ordering per shape (see
 * `src/phase-validation.ts`) and maps `phase → agentType` deterministically
 * via PHASE_AGENT_TYPE. LLM is the planner; the schema + runtime validation
 * enforce the methodology.
 *
 * Tests call `taskConvertIntent` directly with the inspect-tool pattern
 * (no mock pi / extension bootstrap needed — the function is a pure
 * store operation parameterized on `ctx.cwd`).
 *
 * Run: `cd pi-orchestrator && bun test ./test/convert-intent-tool.test.ts`
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TaskStore } from "@sages/pi-tasks/task-store";
import { orchestratorProjectTaskFile } from "@sages/pi-tasks/task-paths";
import {
	ConvertIntentError,
	PHASE_AGENT_TYPE,
	taskConvertIntent,
} from "../src/orchestrator-tool.js";
import {
	EXPECTED_PHASE_COUNT,
	RATIONALE_MAX_LENGTH,
	RATIONALE_MIN_LENGTH,
} from "../src/phase-validation.js";

/** Resolve the source-of-truth routine template (not the installed copy). */
const ROUTINE_TEMPLATE = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../templates/sages-routines/sages-board-watch.json",
);

/** Load the routine prompt string from the source template. */
function loadRoutinePrompt(): string {
	const json = JSON.parse(readFileSync(ROUTINE_TEMPLATE, "utf8"));
	return json.prompt as string;
}

/** Create an intent task directly via the store (the orchestrator's
 *  task_convert_intent reads from the same file-backed store). */
function createIntent(scratch: string, subject = "Add /login", description = "Full /login flow") {
	const store = new TaskStore(orchestratorProjectTaskFile(scratch));
	return store.create(subject, description, undefined, undefined, "intent").id;
}

/** Call the exported taskConvertIntent directly. */
function convert(scratch: string, task_id: string, plan: any) {
	return taskConvertIntent("call-1", { task_id, plan }, undefined, undefined, { cwd: scratch });
}

/**
 * Build a canonical structured plan for a given intent_shape.
 * Returns a minimal plan that satisfies the shape's first/last/count
 * rules — tests can then mutate it to exercise failure paths.
 */
function planFor(
	shape: "trivial" | "small" | "standard" | "investigate-then-fix" | "multi-phase" | "multi-track",
	overrides: { rationale?: string; phases?: any[] } = {},
) {
	const defaults: Record<string, { rationale: string; phases: any[] }> = {
		trivial: {
			rationale: "Single-line typo fix; trivial shape.",
			phases: [
				{
					phase: "implement",
					subject: "Fix typo in user-facing string",
					description:
						"Change 'teh' to 'the' in src/welcome.ts line 42. Run bun test src/welcome.test.ts to confirm.",
				},
			],
		},
		small: {
			rationale: "One file, clear test, single TDD cycle; one Reviewer at the end.",
			phases: [
				{
					phase: "implement",
					subject: "Add login.test.ts scaffold",
					description:
						"Write the failing test first; describe what /login should accept + reject (200 / 401 / 400).",
				},
				{
					phase: "review",
					subject: "Review the scaffold",
					description:
						"Read the Developer's metadata.result. Verify the failing test commits cleanly. Emit verdict.",
				},
			],
		},
		standard: {
			rationale:
				"Multi-file within one package, full RED → GREEN → REFACTOR; one Reviewer at the end.",
			phases: [
				{
					phase: "implement",
					subject: "Implement /login endpoint",
					description:
						"Add POST /login handler in src/auth/login.ts: returns 200 + session cookie on valid creds, 401 on bad creds, 400 on missing fields. RED first: failing test in src/auth/login.test.ts. GREEN: minimum impl. REFACTOR: extract credential check.",
				},
				{
					phase: "review",
					subject: "Review /login implementation",
					description:
						"Read the Developer's metadata.result. Verify: bun test src/auth/ passes; passwords not logged; cookie is HttpOnly. Emit CLEAN / NEEDS_WORK / NEEDS_REDESIGN / NEEDS_CLARIFICATION.",
				},
			],
		},
		"investigate-then-fix": {
			rationale: "Unknown root cause; need a repro before the fix.",
			phases: [
				{
					phase: "investigate",
					subject: "Investigate race in findById",
					description:
						"Reproduce the race in test/race.test.ts (flaky on CI). Capture stack + concurrency window. metadata.result records repro commit SHA + a one-line hypothesis.",
				},
				{
					phase: "implement",
					subject: "Fix race in findById",
					description:
						"Apply the minimum change that makes test/race.test.ts pass deterministically across 1000 runs.",
				},
				{
					phase: "review",
					subject: "Review race fix",
					description:
						"Read the Investigate + Fix metadata.result. Verify repro test committed + 1000-repeat stress passes. Emit verdict.",
				},
			],
		},
		"multi-phase": {
			rationale: "Staged rollout; design first, then implement, test, review.",
			phases: [
				{
					phase: "design",
					subject: "Design new auth schema",
					description: "Draft schema in docs/auth-design.md; review with the team before implementing.",
				},
				{
					phase: "implement",
					subject: "Implement auth schema",
					description: "Add schema migration + adapter in src/auth/. RED first.",
				},
				{
					phase: "test",
					subject: "Write auth integration tests",
					description: "Cover happy path + 5 edge cases in src/auth/integration.test.ts.",
				},
				{
					phase: "review",
					subject: "Review auth rollout",
					description: "Read all three metadata.result entries. Verify design matches impl. Emit verdict.",
				},
			],
		},
		"multi-track": {
			rationale:
				"Three parallel migration tracks; Reviewer joins via a SECOND intent once tracks complete.",
			phases: [
				{
					phase: "implement",
					subject: "Migrate pi-orchestrator to v2",
					description: "Run the v2 migration on pi-orchestrator (managed worktree).",
				},
				{
					phase: "implement",
					subject: "Migrate pi-subagents to v2",
					description: "Run the v2 migration on pi-subagents (managed worktree).",
				},
				{
					phase: "implement",
					subject: "Migrate pi-codebase-memory to v2",
					description: "Run the v2 migration on pi-codebase-memory (managed worktree).",
				},
			],
		},
	};
	const d = defaults[shape];
	return {
		intent_shape: shape,
		rationale: overrides.rationale ?? d.rationale,
		phases: overrides.phases ?? d.phases,
	};
}

// ─── Single-shape conversions ───────────────────────────────────────────

describe("task_convert_intent — single-shape conversions", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-convert-"));
	});

	it("trivial: 1 implement phase, no Reviewer", async () => {
		const intentId = createIntent(scratch);
		const out: any = await convert(scratch, intentId, planFor("trivial"));

		expect(out.details.intent_shape).toBe("trivial");
		expect(out.details.rationale).toBeTruthy();
		expect(out.details.plan_task_ids).toHaveLength(1);

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const plan = store.get(out.details.plan_task_ids[0])!;
		expect(plan.type).toBe("plan");
		expect(plan.metadata?.agentType).toBe("Developer");
		expect(plan.metadata?.phase).toBe("implement");
		expect(plan.metadata?.source_intent).toBe(intentId);
	});

	it("small: implement + review (2 phases), Reviewer from review phase", async () => {
		const intentId = createIntent(scratch);
		const out: any = await convert(scratch, intentId, planFor("small"));

		expect(out.details.intent_shape).toBe("small");
		expect(out.details.plan_task_ids).toHaveLength(2);

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const [devId, revId] = out.details.plan_task_ids;
		expect(store.get(devId)?.metadata?.agentType).toBe("Developer");
		expect(store.get(devId)?.metadata?.phase).toBe("implement");
		expect(store.get(revId)?.metadata?.agentType).toBe("Reviewer");
		expect(store.get(revId)?.metadata?.phase).toBe("review");
	});

	it("standard: implement + review (2 phases)", async () => {
		const intentId = createIntent(scratch);
		const out: any = await convert(scratch, intentId, planFor("standard"));

		expect(out.details.intent_shape).toBe("standard");
		expect(out.details.plan_task_ids).toHaveLength(2);

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const phases = out.details.plan_task_ids.map(
			(id: string) => store.get(id)?.metadata?.phase,
		);
		expect(phases).toEqual(["implement", "review"]);
	});

	it("investigate-then-fix: investigate → implement → review (3 phases)", async () => {
		const intentId = createIntent(scratch);
		const out: any = await convert(scratch, intentId, planFor("investigate-then-fix"));

		expect(out.details.plan_task_ids).toHaveLength(3);
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const phases = out.details.plan_task_ids.map(
			(id: string) => store.get(id)?.metadata?.phase,
		);
		expect(phases).toEqual(["investigate", "implement", "review"]);
	});

	it("multi-phase: design → implement → test → review (4 phases)", async () => {
		const intentId = createIntent(scratch);
		const out: any = await convert(scratch, intentId, planFor("multi-phase"));

		expect(out.details.plan_task_ids).toHaveLength(4);
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const phases = out.details.plan_task_ids.map(
			(id: string) => store.get(id)?.metadata?.phase,
		);
		expect(phases).toEqual(["design", "implement", "test", "review"]);
	});

	it("multi-track: multiple implement phases, no review (deferred to second intent)", async () => {
		const intentId = createIntent(scratch);
		const out: any = await convert(scratch, intentId, planFor("multi-track"));

		expect(out.details.plan_task_ids).toHaveLength(3);
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		for (const id of out.details.plan_task_ids) {
			expect(store.get(id)?.metadata?.agentType).toBe("Developer");
			expect(store.get(id)?.metadata?.phase).toBe("implement");
		}
	});
});

// ─── Phase → agentType mapping (PHASE_AGENT_TYPE) ────────────────────────

describe("task_convert_intent — PHASE_AGENT_TYPE mapping", () => {
	it("maps every phase deterministically; review is the only Reviewer", () => {
		expect(PHASE_AGENT_TYPE.investigate).toBe("Developer");
		expect(PHASE_AGENT_TYPE.design).toBe("Developer");
		expect(PHASE_AGENT_TYPE.implement).toBe("Developer");
		expect(PHASE_AGENT_TYPE.test).toBe("Developer");
		expect(PHASE_AGENT_TYPE.review).toBe("Reviewer");
	});

	it("produces Developer agentType for every non-review phase in a multi-phase plan", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-orch-convert-"));
		const intentId = createIntent(scratch);
		const out: any = await convert(scratch, intentId, planFor("multi-phase"));
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));

		// First 3 phases (design / implement / test) → Developer
		for (let i = 0; i < 3; i++) {
			expect(store.get(out.details.plan_task_ids[i])?.metadata?.agentType).toBe("Developer");
		}
		// Last phase (review) → Reviewer
		expect(store.get(out.details.plan_task_ids[3])?.metadata?.agentType).toBe("Reviewer");
	});
});

// ─── Per-shape validation (schema-enforced methodology) ───────────────────

describe("task_convert_intent — shape validation", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-convert-shape-"));
	});

	it("trivial rejects more than 1 phase", async () => {
		const intentId = createIntent(scratch);
		// Two implement phases — exceeds the trivial-shape count. Use
		// implement (not review) so the count rule fires, not the
		// trivial-no-review rule (which has its own dedicated test).
		const plan = {
			intent_shape: "trivial",
			rationale: "Trying to put two implement phases under trivial.",
			phases: [
				{
					phase: "implement",
					subject: "First fix",
					description: "First implementation phase — too many for trivial.",
				},
				{
					phase: "implement",
					subject: "Second fix",
					description: "Second implementation phase — too many for trivial.",
				},
			],
		};
		try {
			await convert(scratch, intentId, plan);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/trivial.*requires 1.*got 2/);
		}
	});

	it("trivial rejects 0 phases (caught earlier as empty_phases)", async () => {
		const intentId = createIntent(scratch);
		const plan = planFor("trivial", { phases: [] });
		try {
			await convert(scratch, intentId, plan);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("empty_phases");
		}
	});

	it("standard requires last phase = review", async () => {
		const intentId = createIntent(scratch);
		const plan = planFor("standard");
		plan.phases[plan.phases.length - 1] = {
			phase: "implement",
			subject: "Another implementation",
			description: "Just another impl without a review at the end.",
		};
		try {
			await convert(scratch, intentId, plan);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/last phase 'review'/);
		}
	});

	it("investigate-then-fix requires first phase = investigate", async () => {
		const intentId = createIntent(scratch);
		const plan = planFor("investigate-then-fix");
		plan.phases[0].phase = "implement";
		try {
			await convert(scratch, intentId, plan);
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/first phase 'investigate'/);
		}
	});

	it("multi-phase requires first phase = design", async () => {
		const intentId = createIntent(scratch);
		const plan = planFor("multi-phase");
		plan.phases[0].phase = "implement";
		try {
			await convert(scratch, intentId, plan);
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/first phase 'design'/);
		}
	});

	it("multi-track requires ≥ 2 implement phases", async () => {
		const intentId = createIntent(scratch);
		const plan = planFor("multi-track");
		plan.phases = [plan.phases[0]]; // only 1 implement — not parallel
		try {
			await convert(scratch, intentId, plan);
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/multi-track.*≥ 2 implement/);
		}
	});

	it("trivial rejects a review phase", async () => {
		const intentId = createIntent(scratch);
		const plan = {
			intent_shape: "trivial",
			rationale: "single-line fix with a review — but trivial should not allow it",
			phases: [
				{
					phase: "implement",
					subject: "Fix typo",
					description: "Change 'teh' to 'the' in src/welcome.ts line 42.",
				},
				{
					phase: "review",
					subject: "Review typo fix",
					description: "Verify the fix lands in the right file.",
				},
			],
		};
		try {
			await convert(scratch, intentId, plan);
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/trivial.*MUST NOT include a review phase/);
		}
	});

	it("plan with two review phases is rejected", async () => {
		const intentId = createIntent(scratch);
		const plan = planFor("multi-phase");
		plan.phases.push({
			phase: "review",
			subject: "Second review",
			description: "Verify everything again before merging.",
		});
		try {
			await convert(scratch, intentId, plan);
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/multiple review phases/i);
		}
	});

	it("investigate-then-fix rejects a plan with no implement phase", async () => {
		const intentId = createIntent(scratch);
		const plan = {
			intent_shape: "investigate-then-fix",
			rationale: "Investigation only, no fix — should fail shape validation.",
			phases: [
				{
					phase: "investigate",
					subject: "Investigate race",
					description: "Reproduce the race and capture the window.",
				},
				{
					phase: "review",
					subject: "Review investigation",
					description: "Read the investigation report.",
				},
			],
		};
		try {
			await convert(scratch, intentId, plan);
			expect.unreachable();
		} catch (err) {
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/≥ 1 implement phase/);
		}
	});

	it("phase_count_out_of_bounds catches both over- and under-decomposition", () => {
		// Pure unit check on the validator's table — pins the size bounds.
		expect(EXPECTED_PHASE_COUNT.trivial).toEqual({ min: 1, max: 1 });
		expect(EXPECTED_PHASE_COUNT.small).toEqual({ min: 2, max: 2 });
		expect(EXPECTED_PHASE_COUNT.standard).toEqual({ min: 2, max: 2 });
		expect(EXPECTED_PHASE_COUNT["investigate-then-fix"].min).toBe(3);
		expect(EXPECTED_PHASE_COUNT["multi-phase"].max).toBeLessThanOrEqual(8);
		expect(EXPECTED_PHASE_COUNT["multi-track"].max).toBeLessThanOrEqual(10);
	});
});

// ─── Rationale enforcement ───────────────────────────────────────────────

describe("task_convert_intent — rationale enforcement", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-convert-rationale-"));
	});

	it("rationale is stamped on the intent's audit metadata", async () => {
		const intentId = createIntent(scratch);
		const plan = planFor("standard");
		plan.rationale = "Custom rationale for this specific conversion.";
		const out: any = await convert(scratch, intentId, plan);

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const intent = store.get(intentId)!;
		expect(intent.metadata?.rationale).toBe("Custom rationale for this specific conversion.");
		expect(intent.metadata?.intent_shape).toBe("standard");
		expect(out.details.rationale).toBe("Custom rationale for this specific conversion.");
	});

	it(`runtime rejects rationale shorter than ${RATIONALE_MIN_LENGTH} chars`, async () => {
		const intentId = createIntent(scratch);
		const plan = planFor("standard", { rationale: "too short" }); // 9 chars
		try {
			await convert(scratch, intentId, plan);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/Rationale MUST be ≥ 10/);
		}
	});

	it(`runtime rejects rationale longer than ${RATIONALE_MAX_LENGTH} chars`, async () => {
		const intentId = createIntent(scratch);
		const plan = planFor("standard", { rationale: "x".repeat(RATIONALE_MAX_LENGTH + 1) });
		try {
			await convert(scratch, intentId, plan);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("shape_violation");
			expect((err as Error).message).toMatch(/Rationale MUST be ≤ 500/);
		}
	});

	it("rationale at exactly the min length boundary is accepted", async () => {
		const intentId = createIntent(scratch);
		const plan = planFor("standard", { rationale: "x".repeat(RATIONALE_MIN_LENGTH) });
		const out: any = await convert(scratch, intentId, plan);
		expect(out.details.rationale.length).toBe(RATIONALE_MIN_LENGTH);
	});
});

// ─── Per-phase metadata passthrough ──────────────────────────────────────

describe("task_convert_intent — per-phase metadata", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-convert-meta-"));
	});

	it("threads plan.metadata into each plan task's metadata alongside source_intent + phase", async () => {
		const intentId = createIntent(scratch);
		const plan = planFor("standard");
		plan.phases[0].metadata = { priority: "high", tag: "alpha" };
		plan.phases[1].metadata = { priority: "low" };

		const out: any = await convert(scratch, intentId, plan);
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const [aId, bId] = out.details.plan_task_ids;

		expect(store.get(aId)?.metadata?.priority).toBe("high");
		expect(store.get(aId)?.metadata?.tag).toBe("alpha");
		expect(store.get(aId)?.metadata?.agentType).toBe("Developer");
		expect(store.get(aId)?.metadata?.phase).toBe("implement");
		expect(store.get(aId)?.metadata?.source_intent).toBe(intentId);

		expect(store.get(bId)?.metadata?.priority).toBe("low");
		expect(store.get(bId)?.metadata?.agentType).toBe("Reviewer");
		expect(store.get(bId)?.metadata?.phase).toBe("review");
	});

	it("source_intent + phase + agentType are auto-stamped; user metadata doesn't overwrite them", async () => {
		const intentId = createIntent(scratch);
		const plan = planFor("standard");
		// Attempt to forge source_intent / agentType in user metadata — should be ignored.
		plan.phases[0].metadata = { source_intent: "999", agentType: "Reviewer", phase: "review" };

		const out: any = await convert(scratch, intentId, plan);
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const task = store.get(out.details.plan_task_ids[0])!;

		// The function spreads user metadata FIRST, then writes its own
		// audit fields LAST — so audit wins on conflict.
		expect(task.metadata?.source_intent).toBe(intentId);
		expect(task.metadata?.agentType).toBe("Developer");
		expect(task.metadata?.phase).toBe("implement");
	});
});

// ─── Error paths ─────────────────────────────────────────────────────────

describe("task_convert_intent — error paths", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-convert-errors-"));
	});

	it("rejects an empty phases array with kind='empty_phases'", async () => {
		const intentId = createIntent(scratch);
		const plan = planFor("standard", { phases: [] });
		try {
			await convert(scratch, intentId, plan);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("empty_phases");
		}
	});

	it("throws not_intent when the source task is already a plan", async () => {
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		store.create("Existing plan", "...", undefined, undefined, "plan");

		try {
			await convert(scratch, "1", planFor("standard"));
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("not_intent");
		}
	});

	it("throws already_converted on a second call with the same intent", async () => {
		const intentId = createIntent(scratch);
		await convert(scratch, intentId, planFor("standard"));

		try {
			await convert(scratch, intentId, planFor("standard"));
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("already_converted");
		}
	});

	it("throws intent_not_found for an unknown task id", async () => {
		try {
			await convert(scratch, "999", planFor("standard"));
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("intent_not_found");
		}
	});
});

// ─── Intent audit ────────────────────────────────────────────────────────

describe("task_convert_intent — intent audit", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-convert-audit-"));
	});

	it("stamps converted=true, intent_shape, rationale, and converted_at on the intent; source_intent + phase on every new plan", async () => {
		const intentId = createIntent(scratch);
		const before = Date.now();

		const out: any = await convert(scratch, intentId, planFor("standard"));

		const after = Date.now();
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const intent = store.get(intentId)!;
		expect(intent.metadata?.converted).toBe(true);
		expect(intent.metadata?.intent_shape).toBe("standard");
		expect(typeof intent.metadata?.rationale).toBe("string");
		expect(intent.metadata?.converted_at).toBeGreaterThanOrEqual(before);
		expect(intent.metadata?.converted_at).toBeLessThanOrEqual(after);
		expect(intent.type).toBe("intent");

		for (const id of out.details.plan_task_ids) {
			const plan = store.get(id);
			expect(plan?.type).toBe("plan");
			expect(plan?.metadata?.source_intent).toBe(intentId);
			expect(typeof plan?.metadata?.phase).toBe("string");
		}
	});

	it("marks the intent as status='completed' after successful conversion", async () => {
		const intentId = createIntent(scratch);
		{
			const store = new TaskStore(orchestratorProjectTaskFile(scratch));
			expect(store.get(intentId)?.status).toBe("pending");
		}

		await convert(scratch, intentId, planFor("standard"));

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const intent = store.get(intentId)!;
		expect(intent.status).toBe("completed");
		expect(intent.metadata?.converted).toBe(true);
		expect(intent.type).toBe("intent");
	});
});

// ─── Board-watch routine contract ────────────────────────────────────────

describe("task_convert_intent — board-watch routine contract", () => {
	// The board-watch routine (sages-board-watch.json) depends on
	// task_convert_intent's atomic contract: a single call lands the
	// status flip + audit metadata + plan tasks. If any of these break,
	// the widget symptom returns (intent sitting at 'pending' forever).

	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-convert-routine-"));
	});

	it("lands ALL halves (status flip + audit metadata + plan tasks) in one call — board-watch golden path", async () => {
		const intentId = createIntent(scratch);
		const out: any = await convert(scratch, intentId, planFor("standard"));

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const intent = store.get(intentId)!;

		// Half 1 — status flipped to terminal.
		expect(intent.status).toBe("completed");

		// Half 2 — audit metadata stamped (converted: boolean, converted_at: number).
		expect(intent.metadata?.converted).toBe(true);
		expect(typeof intent.metadata?.converted_at).toBe("number");
		expect(intent.type).toBe("intent");

		// Half 3 — plan tasks created and linked back to the intent.
		expect(out.details.plan_task_ids.length).toBeGreaterThanOrEqual(2);
		for (const id of out.details.plan_task_ids) {
			const plan = store.get(id);
			expect(plan?.type).toBe("plan");
			expect(plan?.metadata?.source_intent).toBe(intentId);
			expect(plan?.metadata?.agentType).toBeTruthy();
			expect(plan?.metadata?.phase).toBeTruthy();
		}

		// Negative: the intent must NOT still look routable to a future tick.
		expect(intent.metadata?.converted).not.toBe("true");
		expect(intent.metadata?.converted).not.toBe(undefined);
		expect(intent.status).not.toBe("pending");
	});

	it("audit field types are strict: converted is the boolean true; converted_at is a number", () => {
		const intentId = createIntent(scratch);
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));

		const convertedAtMs = Date.now();
		store.update(intentId, {
			status: "completed",
			metadata: {
				converted: true,
				converted_at: convertedAtMs,
				converted_by: "test-routine-contract",
			},
		});

		const intent = store.get(intentId)!;
		expect(intent.status).toBe("completed");
		expect(intent.metadata?.converted).toBe(true);
		expect(typeof intent.metadata?.converted).toBe("boolean");
		expect(typeof intent.metadata?.converted_at).toBe("number");
		expect(intent.metadata?.converted_at).toBe(convertedAtMs);
	});

	it("the audit-only workaround leaves the intent status='pending' (the bug; documents why the routine must flip status atomically)", () => {
		const intentId = createIntent(scratch);
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));

		expect(store.get(intentId)?.status).toBe("pending");

		// Simulate the buggy workaround: TaskUpdate metadata only.
		store.update(intentId, {
			metadata: {
				converted: true,
				converted_at: Date.now(),
				converted_by: "test-routine-workaround",
				plan_task_ids: ["2", "3"],
			},
		});

		const intent = store.get(intentId)!;
		expect(intent.metadata?.converted).toBe(true);
		expect(intent.status).toBe("pending");
	});

	it("routine prompt mandates TaskList on every tick — regression pin for the 'empty-then-skip' failure mode", () => {
		const prompt = loadRoutinePrompt();

		expect(prompt).toMatch(/every\s+(pulse\s+)?tick/i);
		expect(prompt).toMatch(/MUST\s+call\s+`?TaskList`?/i);
		expect(prompt).toMatch(/not\s+(infer|assume)\s+emptiness|no[nt]?\s+infer|do\s+NOT\s+infer/i);
		expect(prompt).toMatch(/failure\s+modes?\s+to\s+avoid/i);
		expect(prompt).toMatch(/Returning\s+\[~\]\s+without\s+calling/i);
	});
});
