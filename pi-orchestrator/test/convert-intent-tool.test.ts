/**
 * convert-intent-tool.test.ts — `task_convert_intent(task_id, plan[])`
 *
 * Multi-plan commit: one intent task can be decomposed by the caller
 * (the LLM) into N plan tasks in a single call. The function creates
 * each plan task, wires `blocks` / `blockedBy` edges, marks the intent
 * as converted, and returns all new task IDs.
 *
 * LLM is the decomposer — the function just commits. The intent audit
 * is one-way: once converted, the intent cannot be re-converted.
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
import { ConvertIntentError, taskConvertIntent } from "../src/orchestrator-tool.js";

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

describe("task_convert_intent — single plan (backward compatible)", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-convert-"));
	});

	it("converts an intent into one plan task and returns its id", async () => {
		const intentId = createIntent(scratch);

		const out: any = await convert(scratch, intentId, [{ agentType: "Developer" }]);

		expect(out.details.plan_task_ids).toHaveLength(1);
		expect(out.details.intent_task_id).toBe(intentId);
		expect(typeof out.details.converted_at).toBe("number");

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const plan = store.get(out.details.plan_task_ids[0]);
		expect(plan?.type).toBe("plan");
		expect(plan?.metadata?.source_intent).toBe(intentId);
		expect(plan?.metadata?.agentType).toBe("Developer");
	});

	it("defaults subject and description to the intent's when omitted", async () => {
		const intentId = createIntent(scratch, "My Feature", "My Description");

		const out: any = await convert(scratch, intentId, [{ agentType: "Developer" }]);

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const plan = store.get(out.details.plan_task_ids[0])!;
		expect(plan.subject).toBe("My Feature");
		expect(plan.description).toBe("My Description");
	});

	it("respects an explicit subject/description/activeForm on the spec", async () => {
		const intentId = createIntent(scratch);

		const out: any = await convert(scratch, intentId, [{
			subject: "Custom subject",
			description: "Custom description",
			activeForm: "Custom spinner",
			agentType: "Reviewer",
		}]);

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const plan = store.get(out.details.plan_task_ids[0])!;
		expect(plan.subject).toBe("Custom subject");
		expect(plan.description).toBe("Custom description");
		expect(plan.activeForm).toBe("Custom spinner");
		expect(plan.metadata?.agentType).toBe("Reviewer");
	});
});

describe("task_convert_intent — multi-plan decomposition", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-convert-"));
	});

	it("creates N plan tasks in one call and returns all ids in order", async () => {
		const intentId = createIntent(scratch);

		const out: any = await convert(scratch, intentId, [
			{ subject: "Design schema", agentType: "Developer" },
			{ subject: "Implement", agentType: "Developer" },
			{ subject: "Write tests", agentType: "Developer" },
			{ subject: "Review", agentType: "Reviewer" },
		]);

		expect(out.details.plan_task_ids).toHaveLength(4);
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		for (const id of out.details.plan_task_ids) {
			const t = store.get(id);
			expect(t?.type).toBe("plan");
			expect(t?.metadata?.source_intent).toBe(intentId);
		}
	});

	it("wires blockedBy / blocks edges to pre-existing task IDs", async () => {
		const upstream = new TaskStore(orchestratorProjectTaskFile(scratch));
		const t0 = upstream.create("Upstream", "Pre-existing", undefined, undefined, "plan");

		const intentId = createIntent(scratch);

		const out: any = await convert(scratch, intentId, [
			{ subject: "Step A", agentType: "Developer", blockedBy: [t0.id] },
			{ subject: "Step B", agentType: "Developer", blocks: [t0.id] },
		]);

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const [aId, bId] = out.details.plan_task_ids;
		const a = store.get(aId)!;
		const b = store.get(bId)!;
		expect(a.blockedBy).toContain(t0.id);
		expect(b.blocks).toContain(t0.id);
	});

	it("threads plan.metadata into each plan task's metadata alongside source_intent", async () => {
		const intentId = createIntent(scratch);

		const out: any = await convert(scratch, intentId, [
			{ agentType: "Developer", metadata: { priority: "high", tag: "alpha" } },
			{ agentType: "Reviewer", metadata: { priority: "low" } },
		]);

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const [aId, bId] = out.details.plan_task_ids;
		expect(store.get(aId)?.metadata?.priority).toBe("high");
		expect(store.get(aId)?.metadata?.tag).toBe("alpha");
		expect(store.get(aId)?.metadata?.agentType).toBe("Developer");
		expect(store.get(bId)?.metadata?.priority).toBe("low");
		expect(store.get(bId)?.metadata?.agentType).toBe("Reviewer");
	});
});

describe("task_convert_intent — error paths", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-convert-"));
	});

	it("rejects an empty plan array", async () => {
		const intentId = createIntent(scratch);

		try {
			await convert(scratch, intentId, []);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("empty_plan");
		}
	});

	it("throws not_intent when the source task is already a plan", async () => {
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		store.create("Existing plan", "...", undefined, undefined, "plan");

		try {
			await convert(scratch, "1", [{ agentType: "Developer" }]);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("not_intent");
		}
	});

	it("throws already_converted on a second call with the same intent", async () => {
		const intentId = createIntent(scratch);
		await convert(scratch, intentId, [{ agentType: "Developer" }]);

		try {
			await convert(scratch, intentId, [{ agentType: "Developer" }]);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("already_converted");
		}
	});

	it("throws intent_not_found for an unknown task id", async () => {
		try {
			await convert(scratch, "999", [{ agentType: "Developer" }]);
			expect.unreachable();
		} catch (err) {
			expect(err).toBeInstanceOf(ConvertIntentError);
			expect((err as ConvertIntentError).kind).toBe("intent_not_found");
		}
	});
});

describe("task_convert_intent — intent audit", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-convert-"));
	});

	it("stamps converted=true and converted_at on the intent; source_intent on every new plan", async () => {
		const intentId = createIntent(scratch);
		const before = Date.now();

		const out: any = await convert(scratch, intentId, [
			{ agentType: "Developer" },
			{ agentType: "Reviewer" },
		]);

		const after = Date.now();
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const intent = store.get(intentId)!;
		expect(intent.metadata?.converted).toBe(true);
		expect(intent.metadata?.converted_at).toBeGreaterThanOrEqual(before);
		expect(intent.metadata?.converted_at).toBeLessThanOrEqual(after);
		expect(intent.type).toBe("intent");

		for (const id of out.details.plan_task_ids) {
			expect(store.get(id)?.metadata?.source_intent).toBe(intentId);
		}
	});

	it("marks the intent as status='completed' after successful conversion", async () => {
		const intentId = createIntent(scratch);

		// Pre-condition: the freshly-created intent is pending.
		{
			const store = new TaskStore(orchestratorProjectTaskFile(scratch));
			expect(store.get(intentId)?.status).toBe("pending");
		}

		await convert(scratch, intentId, [
			{ agentType: "Developer" },
			{ agentType: "Reviewer" },
		]);

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const intent = store.get(intentId)!;
		// The intent is terminal once the conversion has materialized plan tasks.
		expect(intent.status).toBe("completed");
		// The audit fields are unchanged by the status flip.
		expect(intent.metadata?.converted).toBe(true);
		expect(intent.type).toBe("intent");
	});
});
describe("task_convert_intent — board-watch routine contract", () => {
	// These tests pin the contract that the `sages-board-watch` routine
	// (pi-orchestrator/templates/sages-routines/sages-board-watch.json)
	// depends on. The bug we're guarding against: the routine falls back to
	// raw `TaskUpdate` + `TaskCreate` when `task_convert_intent` is not in
	// its tool surface, and a LLM that splits the conversion into two
	// `TaskUpdate` calls (one for metadata, one for status) — or only
	// stamps metadata without flipping status — leaves the intent task
	// sitting at `status: "pending"` in the widget even after every
	// derived plan completes. See AGENTS.md / Sages — Orchestrator
	// Constitution, "Orchestrator manual takeover" + "Red lines".

	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-convert-routine-"));
	});

	it("lands ALL three halves (status flip + audit metadata + plan tasks) in one call — board-watch golden path", async () => {
		// The sages-board-watch routine expects the whole conversion to land
		// atomically: status flips to 'completed', audit metadata is stamped
		// in the same batch, AND the plan tasks are created. A regression in
		// any of the three halves breaks the widget. This test pins all
		// three in one assertion block so a partial fix is impossible to
		// ship without the test going red.

		const intentId = createIntent(scratch);

		const out: any = await convert(scratch, intentId, [
			{ agentType: "Developer" },
			{ agentType: "Reviewer" },
		]);

		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const intent = store.get(intentId)!;

		// Half 1 — status flipped to terminal in the same store.write.
		expect(intent.status).toBe("completed");

		// Half 2 — audit metadata stamped (types matter; see below).
		// `task_convert_intent` writes `converted` (boolean) + `converted_at`
		// (number, epoch ms). It does NOT write `converted_by` — that field
		// is a routine-layer convention only, never asserted by the
		// canonical contract. The sages-board-watch routine may add
		// `converted_by: "sages-board-watch"` on top of the audit shape
		// for observability, but it is not part of `task_convert_intent`'s
		// guarantee.
		expect(intent.metadata?.converted).toBe(true);
		expect(typeof intent.metadata?.converted_at).toBe("number");
		expect(typeof intent.metadata?.converted_at).not.toBe("string");
		expect(intent.type).toBe("intent");

		// Half 3 — plan tasks created and linked back to the intent.
		expect(out.details.plan_task_ids).toHaveLength(2);
		for (const id of out.details.plan_task_ids) {
			const plan = store.get(id);
			expect(plan?.type).toBe("plan");
			expect(plan?.metadata?.source_intent).toBe(intentId);
			expect(plan?.metadata?.agentType).toBeTruthy();
		}

		// Negative: the intent must NOT still look routable to a future
		// routine tick. If `metadata.converted` was stamped as the string
		// "true" (instead of the boolean `true`) — or worse, left undefined
		// because of a partial store.write — this trip wires.
		expect(intent.metadata?.converted).not.toBe("true");
		expect(intent.metadata?.converted).not.toBe(undefined);
		expect(intent.status).not.toBe("pending");
	});

	it("audit field types are strict: converted is the boolean true (not the string 'true'); converted_at is a number (not an ISO string)", () => {
		// Regression test for the EXACT bug introduced in the
		// sages-board-watch routine workaround: a raw `TaskUpdate`
		// payload of `{metadata: {converted: true, converted_at: "2026-..."}}`
		// stringified the boolean and changed the timestamp shape to an ISO
		// string when it round-tripped through the JSON file. The
		// `task_convert_intent` function avoids this by writing through
		// the store directly with strongly-typed values; the routine must
		// produce the same shape or downstream consumers break.

		const intentId = createIntent(scratch);
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));

		// Simulate the canonical-conversion end-state via store.update with
		// the same shape `task_convert_intent` would write.
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

		// Must be the boolean true — `toBe(true)` rejects the string "true".
		expect(intent.metadata?.converted).toBe(true);
		expect(typeof intent.metadata?.converted).toBe("boolean");

		// Must be a number (epoch ms), not an ISO string. JSON.load
		// round-trips numbers unchanged; an ISO string would survive too
		// but downstream `eval_score`-style consumers expect a number for
		// "is this route stale?" calculations.
		expect(typeof intent.metadata?.converted_at).toBe("number");
		expect(intent.metadata?.converted_at).toBe(convertedAtMs);
	});

	it("the audit-only workaround leaves the intent status='pending' (the bug; documents why the routine must flip status atomically)", () => {
		// This test DOCUMENTS the original bug. With a raw `TaskUpdate`
		// that only stamps metadata (no status flip), the intent's status
		// field never moves from 'pending'. A future contributor who is
		// tempted to "simplify" the sage-board-watch routine by skipping
		// the status flip will see this test and learn exactly what
		// regression they're signing up for.
		//
		// If a future enhancement teaches TaskStore to auto-flip
		// `type='intent'` to 'completed' the moment `metadata.converted`
		// becomes truthy (a reasonable server-side hardening), this test
		// should be REPLACED by one that exercises the auto-flip path —
		// do not just delete it.

		const intentId = createIntent(scratch);
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));

		// Pre-condition: the freshly-created intent is pending.
		expect(store.get(intentId)?.status).toBe("pending");

		// The EXACT sequence the original sage-board-watch workaround used
		// (without the fix): TaskUpdate metadata only. No status.
		store.update(intentId, {
			metadata: {
				converted: true,
				converted_at: Date.now(),
				converted_by: "test-routine-workaround",
				plan_task_ids: ["2", "3"],
			},
		});

		const intent = store.get(intentId)!;

		// The audit stamps cleanly — but the status did NOT flip. This is
		// the widget symptom the routine prompt guards against.
		expect(intent.metadata?.converted).toBe(true);
		expect(intent.status).toBe("pending");
	});

	it("routine prompt mandates TaskList on every tick — regression pin for the 'empty-then-skip' failure mode", () => {
		// This test pins the prompt-level contract: the routine MUST instruct
		// the LLM to call `TaskList` on every pulse tick, and MUST name the
		// failure mode (returning [~] without re-checking) so the prompt can
		// never silently drift back into the buggy shape that left an intent
		// task sitting unhandled for 7+ minutes across 9 successful ticks.
		const prompt = loadRoutinePrompt();

		// 1. Must-call language, with the specific tool name, on every tick.
		expect(prompt).toMatch(/every\s+(pulse\s+)?tick/i);
		expect(prompt).toMatch(/MUST\s+call\s+`?TaskList`?/i);

		// 2. The LLM must be told not to infer emptiness from a prior tick.
		expect(prompt).toMatch(/not\s+(infer|assume)\s+emptiness|no[nt]?\s+infer|do\s+NOT\s+infer/i);

		// 3. The specific failure mode must be named in the prompt itself,
		//    so the contributor who edits the prompt cannot delete the
		//    warning without seeing it.
		expect(prompt).toMatch(/failure\s+modes?\s+to\s+avoid/i);
		expect(prompt).toMatch(/Returning\s+\[~\]\s+without\s+calling/i);
	});
});
