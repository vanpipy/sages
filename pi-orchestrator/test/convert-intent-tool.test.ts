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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "@sages/pi-tasks/task-store";
import { orchestratorProjectTaskFile } from "@sages/pi-tasks/task-paths";
import { ConvertIntentError, taskConvertIntent } from "../src/orchestrator-tool.js";

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
});
