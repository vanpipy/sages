/**
 * orchestrator-sidebar-emit.test.ts — `registerOrchestratorTools` should
 * emit `sidebar:event` to pi.events at the lifecycle points the Sages
 * sidebar relies on:
 *
 *   1. `task_convert_intent` — `action: 'highlight'` with shape +
 *      phaseCount + planTaskIds. The highlight lets the sidebar jump
 *      to the new intent (and surface the freshly created plan tasks)
 *      the moment an intent → plan conversion lands.
 *   2. `task_consume` on a Reviewer task — `action: 'log'` with the
 *      parsed verdict + agentType. The sidebar event log shows what
 *      verdict landed for which task without re-querying the store.
 *
 * The handler in the sidebar fork (extensions/sidebar/sidebar-event-tool.ts)
 * already routes these actions; the orchestrator only owns the emits.
 *
 * Tests drive `registerOrchestratorTools` against a minimal mock pi
 * (tool capture + event-bus recorder) and assert the captured payload
 * shape: `{ action, target, data, ts }`.
 *
 * Run: `cd pi-orchestrator && bun test ./test/orchestrator-sidebar-emit.test.ts`
 */

import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskStore } from "@sages/pi-tasks/task-store";
import { orchestratorProjectTaskFile } from "@sages/pi-tasks/task-paths";
import { registerOrchestratorTools } from "../src/orchestrator-tool.js";

/** Captured sidebar:event payload. Mirrors the contract on the listener side. */
interface CapturedSidebarEvent {
	action: string;
	target?: string;
	data?: unknown;
	ts: number;
}

/**
 * Minimal mock of `ExtensionAPI` sufficient for `registerOrchestratorTools`:
 * the only surface the registration touches is `pi.registerTool` and
 * `pi.events.emit`. The recorder captures every emit so tests can
 * assert against the payload.
 */
function mockPi(): {
	pi: any;
	tools: Map<string, any>;
	emitted: CapturedSidebarEvent[];
} {
	const tools = new Map<string, any>();
	const emitted: CapturedSidebarEvent[] = [];
	const pi = {
		registerTool(def: any) {
			tools.set(def.name, def);
		},
		events: {
			emit(channel: string, data: unknown) {
				if (channel === "sidebar:event") {
					emitted.push(data as CapturedSidebarEvent);
				}
			},
		},
	};
	return { pi, tools, emitted };
}

/** Create an intent task directly via the store. */
function createIntent(scratch: string): string {
	const store = new TaskStore(orchestratorProjectTaskFile(scratch));
	return store.create("Add /login", "Full /login flow", undefined, undefined, "intent").id;
}

/** Build a minimal standard-shape plan (implement + review). */
function standardPlan() {
	return {
		intent_shape: "standard" as const,
		rationale: "Two-phase plan; one Reviewer at the end.",
		phases: [
			{
				phase: "implement" as const,
				subject: "Implement /login",
				description: "Add POST /login handler with TDD cycle.",
			},
			{
				phase: "review" as const,
				subject: "Review /login",
				description: "Read the Developer's metadata.result, emit verdict.",
			},
		],
	};
}

/** Stamp a Reviewer task as completed with a known verdict text. */
function completeReviewerWithVerdict(scratch: string, planTaskId: string, verdict: string) {
	const store = new TaskStore(orchestratorProjectTaskFile(scratch));
	const task = store.get(planTaskId);
	if (!task) throw new Error(`#${planTaskId} not found in store`);
	store.update(planTaskId, {
		status: "completed",
		metadata: {
			...task.metadata,
			agentType: "Reviewer",
			result: `Reviewer verdict: ${verdict}\nThe implementation passes the test gate.`,
		},
	});
}

describe("registerOrchestratorTools — sidebar:event emit points", () => {
	let scratch: string;
	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-sidebar-"));
	});

	it("task_convert_intent emits a sidebar highlight for the new intent with shape + phaseCount + planTaskIds", async () => {
		const { pi, tools, emitted } = mockPi();
		registerOrchestratorTools(pi);
		const convert = tools.get("task_convert_intent");
		expect(convert).toBeTruthy();

		const intentId = createIntent(scratch);
		await convert.execute(
			"call-1",
			{ task_id: intentId, plan: standardPlan() },
			undefined,
			undefined,
			{ cwd: scratch },
		);

		// Find the highlight event for this intent. Multiple emit points
		// may share the channel; filter to the conversion highlight.
		const highlights = emitted.filter((e) => e.action === "highlight");
		expect(highlights.length).toBeGreaterThanOrEqual(1);

		const highlight = highlights.find((e) => e.target === `intent-${intentId}`);
		expect(highlight).toBeTruthy();
		expect(highlight!.target).toBe(`intent-${intentId}`);
		expect(typeof highlight!.ts).toBe("number");
		expect(highlight!.ts).toBeGreaterThan(0);
		const data = highlight!.data as { shape: string; phaseCount: number; planTaskIds: string[] };
		expect(data.shape).toBe("standard");
		expect(data.phaseCount).toBe(2);
		expect(Array.isArray(data.planTaskIds)).toBe(true);
		expect(data.planTaskIds).toHaveLength(2);
	});

	it("task_consume on a Reviewer task emits a sidebar log row with the parsed verdict + agentType", async () => {
		const { pi, tools, emitted } = mockPi();
		registerOrchestratorTools(pi);
		const convert = tools.get("task_convert_intent");
		const consume = tools.get("task_consume");
		expect(convert).toBeTruthy();
		expect(consume).toBeTruthy();

		// 1. Convert to create the plan tasks.
		const intentId = createIntent(scratch);
		const converted: any = await convert.execute(
			"call-1",
			{ task_id: intentId, plan: standardPlan() },
			undefined,
			undefined,
			{ cwd: scratch },
		);
		const reviewerPlanId = converted.details.plan_task_ids[1]; // review phase is index 1

		// 2. Mark the Reviewer plan as completed with a verdict.
		completeReviewerWithVerdict(scratch, reviewerPlanId, "CLEAN");

		// 3. Consume — should emit a sidebar log row.
		emitted.length = 0; // reset; we only care about the consume emit
		await consume.execute(
			"call-2",
			{ task_id: reviewerPlanId },
			undefined,
			undefined,
			{ cwd: scratch },
		);

		const logs = emitted.filter((e) => e.action === "log");
		expect(logs.length).toBe(1);
		const log = logs[0];
		expect(log.target).toBe(`task-${reviewerPlanId}`);
		expect(typeof log.ts).toBe("number");
		expect(log.ts).toBeGreaterThan(0);
		const data = log.data as { verdict: string; agentType: string };
		expect(data.agentType).toBe("Reviewer");
		expect(data.verdict).toBe("CLEAN");
	});

	it("task_consume on a Developer task does NOT emit a sidebar log row (only Reviewer verdicts surface)", async () => {
		const { pi, tools, emitted } = mockPi();
		registerOrchestratorTools(pi);
		const convert = tools.get("task_convert_intent");
		const consume = tools.get("task_consume");

		const intentId = createIntent(scratch);
		const converted: any = await convert.execute(
			"call-1",
			{ task_id: intentId, plan: standardPlan() },
			undefined,
			undefined,
			{ cwd: scratch },
		);
		const devPlanId = converted.details.plan_task_ids[0]; // implement phase

		// Mark the Developer plan as completed (no verdict to parse).
		const store = new TaskStore(orchestratorProjectTaskFile(scratch));
		const t = store.get(devPlanId)!;
		store.update(devPlanId, {
			status: "completed",
			metadata: { ...t.metadata, agentType: "Developer", result: "tests pass" },
		});

		emitted.length = 0;
		await consume.execute(
			"call-2",
			{ task_id: devPlanId },
			undefined,
			undefined,
			{ cwd: scratch },
		);

		const logs = emitted.filter((e) => e.action === "log");
		expect(logs.length).toBe(0);
	});

	it("task_convert_intent failure (intent_not_found) emits nothing — error paths are silent on the sidebar channel", async () => {
		const { pi, tools, emitted } = mockPi();
		registerOrchestratorTools(pi);
		const convert = tools.get("task_convert_intent");

		let threw = false;
		try {
			await convert.execute(
				"call-1",
				{ task_id: "999", plan: standardPlan() },
				undefined,
				undefined,
				{ cwd: scratch },
			);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
		expect(emitted.filter((e) => e.action === "highlight")).toHaveLength(0);
		expect(emitted.filter((e) => e.action === "log")).toHaveLength(0);
	});
});
