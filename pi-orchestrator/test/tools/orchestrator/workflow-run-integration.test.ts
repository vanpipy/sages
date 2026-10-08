/**
 * workflow-run-integration.test.ts — R-INT for GC-2026-102.
 *
 * End-to-end integration test for the workflow_run ↔ subscribeWorkflow
 * event contract. The unit tests in `workflow-run.test.ts` drive the
 * orchestrator's phase aggregation loop with synthetic agent ids and a
 * locally-staged event log — they catch orchestrator-internal bugs but
 * not cascade-contract bugs. This test wires the REAL pi-tasks
 * subscribeWorkflow (loaded via the @sages/pi-tasks path alias added
 * by GC-2026-099 R5) to a fake pi.events bus and a mocked subagents
 * layer that returns real-format ids (randomUUID().slice(0,17)), and
 * asserts the full pipeline: Implement → Review_1 → Review_2 →
 * Review_3 → Merge.
 *
 * Why this matters: the cascade-agentid bug (GC-2026-pi-tasks-cascade-agentid)
 * was masked by the unit test's synthetic id shape. A test that drives
 * the production wiring (real subscribeWorkflow + real-format spawn
 * ids + real workflow:phase-complete events) would have caught the
 * pre-registration mismatch before it shipped. This file is the
 * regression-prevention layer.
 *
 * Driving the cascade: workflow_run's main Promise awaits
 * workflow:phase-complete events. Pi-tasks's onSubagentCompleted
 * handler is also async — it awaits spawnAgent (which awaits the
 * RPC reply) and then awaits the cascade scan. Between every spawn
 * the test must yield (via setImmediate) to let the cascade drain;
 * otherwise the test would race the awaited Promise and assert on
 * an incomplete state.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real pi-tasks types + subscribeWorkflow — the path alias was added
// in GC-2026-099 R5 (tsconfig.json `#paths["@sages/pi-tasks"]`).
import { subscribeWorkflow } from "@sages/pi-tasks/workflow-handler";
import { TaskStore } from "@sages/pi-tasks/task-store";
import type { Task } from "@sages/pi-tasks/types";

import { executeWorkflowRun } from "../../../src/workflow-run.js";

// ── Test helpers ────────────────────────────────────────────────────

const GOAL_ID = "GC-INT-TEST";
const WORKFLOW_ID = `wf-${GOAL_ID}`;

function makeGoalYaml(): string {
	return [
		`id: ${GOAL_ID}`,
		`title: Integration test goal`,
		`rationale: verification`,
		`scope:`,
		`  include: ["src/**"]`,
		`  exclude: ["dist/**"]`,
		`anti_goals: ["no new deps"]`,
		`done_definition: tests pass`,
	].join("\n");
}

/** Yield to the microtask queue so the async cascade can drain. */
function flush(): Promise<void> {
	return new Promise<void>((r) => setImmediate(r));
}

/**
 * Minimal pi.events bus with synchronous dispatch + emit history.
 * Tracks every emitted channel + data so the test can inspect what
 * workflow_run and pi-tasks communicated.
 */
function makeFakeEvents() {
	const handlers = new Map<string, Set<(data: unknown) => void | Promise<void>>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	return {
		handlers,
		emitted,
		on(channel: string, handler: (data: unknown) => void | Promise<void>) {
			if (!handlers.has(channel)) handlers.set(channel, new Set());
			handlers.get(channel)!.add(handler);
			return () => {
				const set = handlers.get(channel);
				if (set) set.delete(handler);
			};
		},
		emit(channel: string, data: unknown): Promise<void> {
			emitted.push({ channel, data });
			const set = handlers.get(channel);
			if (!set) return Promise.resolve();
			return (async () => {
				// Snapshot to allow handlers to unsubscribe themselves.
				for (const h of [...set]) await h(data);
			})();
		},
	};
}

type FakeEvents = ReturnType<typeof makeFakeEvents>;

/**
 * Mock the @tintinweb/pi-subagents RPC surface with REAL-format ids
 * (randomUUID().slice(0,17), the production shape). Records every
 * spawned agent's id so the test can fire subagents:completed for
 * each one when driving the cascade.
 */
function installRealIdSubagentsMock(events: FakeEvents) {
	const spawned = new Map<
		string,
		{ id: string; type: string }
	>();
	const spawnOrder: string[] = [];
	const completedIds = new Set<string>();

	// ping → reply
	events.handlers.set(
		"subagents:rpc:ping",
		new Set([
			(data: unknown) => {
				const { requestId } = data as { requestId: string };
				void events.emit(`subagents:rpc:ping:reply:${requestId}`, {
					success: true,
					data: { version: 2 },
				});
			},
		]),
	);

	// spawn → reply with real-format id
	events.handlers.set(
		"subagents:rpc:spawn",
		new Set([
			(data: unknown) => {
				const { requestId, type } = data as {
					requestId: string;
					type: string;
					prompt: string;
					options?: Record<string, unknown>;
				};
				// Mirror pi-subagents/agent-manager.ts:346: 17-char UUID prefix.
				const id = randomUUID().slice(0, 17);
				spawnOrder.push(id);
				spawned.set(id, { id, type });
				void events.emit(`subagents:rpc:spawn:reply:${requestId}`, {
					success: true,
					data: { id },
				});
			},
		]),
	);

	// stop → reply
	events.handlers.set(
		"subagents:rpc:stop",
		new Set([
			(data: unknown) => {
				const { requestId } = data as { requestId: string };
				void events.emit(`subagents:rpc:stop:reply:${requestId}`, {
					success: true,
				});
			},
		]),
	);

	// consume → reply
	events.handlers.set(
		"subagents:rpc:consume",
		new Set([
			(data: unknown) => {
				const { requestId } = data as { requestId: string };
				void events.emit(`subagents:rpc:consume:reply:${requestId}`, {
					success: true,
				});
			},
		]),
	);

	return {
		spawned,
		spawnOrder,
		/** Fire subagents:completed for the next spawned agent of the given type. */
		completeNext(type: string, result?: string) {
			const id = spawnOrder.find(
				(k) => spawned.get(k)?.type === type && !completedIds.has(k),
			);
			if (!id) throw new Error(`No spawned agent of type ${type} to complete`);
			completedIds.add(id);
			void events.emit("subagents:completed", {
				id,
				result: result ?? "ok",
			});
			return id;
		},
		/** Fire subagents:completed for the next spawned agent of the given type. */
		completeByIndex(idx: number, result?: string) {
			const id = spawnOrder[idx];
			if (!id) throw new Error(`No spawned agent at index ${idx}`);
			completedIds.add(id);
			void events.emit("subagents:completed", {
				id,
				result: result ?? "ok",
			});
			return id;
		},
	};
}

const cleanReviewResult = (iteration: number) =>
	"```yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\niteration: " + iteration + "\n```";

function makeWorkflowRunHarness(repoCwd: string) {
	const pi = { events: makeFakeEvents() };
	const store = new TaskStore();
	const subagents = installRealIdSubagentsMock(pi.events);

	// Wire pi-tasks's REAL subscribeWorkflow to our fake events. GC-2026-114
	// FU3: subscribeWorkflow no longer takes a `spawnAgent` callback. It
	// now takes a `feed: { maybeAutoSpawn }` + a shared `agentTaskMap`.
	// The feed's maybeAutoSpawn calls subagents:rpc:spawn via the rpcCall
	// pattern, gets back an id, and populates agentTaskMap (mirroring
	// the production feeder's behavior).
	const agentTaskMap = new Map<string, string>();
	const feed = {
		maybeAutoSpawn: async (task: Task) => {
			const requestId = randomUUID();
			const resultP = new Promise<{ id: string }>((resolve, reject) => {
				const replyChannel = `subagents:rpc:spawn:reply:${requestId}`;
				const unsub = pi.events.on(replyChannel, (raw: unknown) => {
					unsub();
					const reply = raw as {
						success: boolean;
						data?: { id: string };
						error?: string;
					};
					if (reply.success && reply.data) {
						resolve(reply.data);
					} else {
						reject(new Error(reply.error ?? "spawn failed"));
					}
				});
			});
			void pi.events.emit("subagents:rpc:spawn", {
				requestId,
				type: String(task.metadata.agentType ?? task.subject),
				prompt: task.description,
				options: {},
			});
			const agentId = await resultP.then((d) => d.id);
			agentTaskMap.set(agentId, task.id);
			store.update(task.id, { status: "in_progress", owner: agentId });
		},
	};
	const cleanup = subscribeWorkflow(store, {
		events: { on: pi.events.on, emit: pi.events.emit },
		feed,
		agentTaskMap,
	});

	return { pi, store, subagents, cleanup };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("workflow_run ↔ subscribeWorkflow integration (GC-2026-102 R-INT)", () => {
	let repoCwd: string;
	let harness: ReturnType<typeof makeWorkflowRunHarness>;

	beforeEach(() => {
		repoCwd = mkdtempSync(join(tmpdir(), "wf-int-"));
		mkdirSync(join(repoCwd, ".pi", "orchestrator"), { recursive: true });
		writeFileSync(
			join(repoCwd, ".pi", "orchestrator", `goal-${GOAL_ID}.yaml`),
			makeGoalYaml(),
		);
		harness = makeWorkflowRunHarness(repoCwd);
		// Drain the subagents:ready event pi-tasks emits on subscribe.
		void harness.pi.events.emit("subagents:ready", {});
	});

	afterEach(() => {
		if (harness) harness.cleanup();
		if (repoCwd) rmSync(repoCwd, { recursive: true, force: true });
	});

	it("drives a happy-path 5-spawn workflow with real-format ids", async () => {
		const workflowRunP = executeWorkflowRun(
			{
				goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
				options: { max_fix_iterations: 3 },
			},
			{
				pi: harness.pi,
				ctx: {},
				repoCwd,
			},
		);

		// Implement spawned via the RPC layer (returns real-format id).
		await flush();
		// After Implement completion, cascade spawns ImplementAdvisor + Review_1.
		harness.subagents.completeByIndex(0, "ok"); // Implement
		await flush();
		await flush();

		// spawnOrder now: Implement, Review_1, ImplementAdvisor
		// After Review_1 completion (CLEAN), cascade spawns Review_2 + ReviewerAdvisor_1.
		harness.subagents.completeByIndex(1, cleanReviewResult(1)); // Review_1
		await flush();
		await flush();

		// spawnOrder now: Implement, Review_1, ImplementAdvisor, Review_2, ReviewerAdvisor_1
		harness.subagents.completeByIndex(3, cleanReviewResult(2)); // Review_2
		await flush();
		await flush();

		// spawnOrder now: Implement, Review_1, ImplementAdvisor, Review_2, ReviewerAdvisor_1, Review_3, ReviewerAdvisor_2
		harness.subagents.completeByIndex(5, cleanReviewResult(3)); // Review_3
		await flush();
		await flush();

		// After Review_3 completion (CLEAN), cascade spawns ReviewerAdvisor_3 + Merge.
		harness.subagents.completeByIndex(7); // MergerAdvisor (Merge)
		await flush();
		await flush();

		const result = (await workflowRunP) as {
			status: string;
			goal_id: string;
			tasks: Record<
				string,
				{ id: string; status: string; verdict?: string; agent_id?: string }
			>;
			paths: { worktree: string; branch: string; goal_yaml: string };
		};

		// 5 primary spawns total: Implement, Review_1, Review_2, Review_3, Merge.
		// Plus 4 advisor spawns (DeveloperAdvisor + 3 ReviewerAdvisor) = 9 total.
		const primarySpawns = harness.subagents.spawnOrder.filter(
			(id) => {
				const t = harness.subagents.spawned.get(id)?.type;
				return t === "Developer" || t === "Reviewer" || t === "MergerAdvisor";
			},
		);
		expect(primarySpawns).toHaveLength(5);
		expect(harness.subagents.spawnOrder).toHaveLength(9); // 5 primary + 4 advisors

		// Every spawned agent id is real-format (randomUUID().slice(0,17)).
		// The first 17 chars of a UUID v4 are "xxxxxxxx-xxxx-Mxxx" (8 hex
		// chars + dash + 4 hex + dash + 3 chars where M is the version nibble
		// "4" followed by 2 hex chars).
		for (const id of harness.subagents.spawnOrder) {
			expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3}$/);
			expect(id).toHaveLength(17);
			expect(id).not.toMatch(/^agent-/); // not the synthetic shape
		}

		expect(result.status).toBe("success");
		expect(result.goal_id).toBe(GOAL_ID);

		// GC-2026-097 H1: output.tasks.{implement,review,merge}.id reflect
		// the REAL task_ids (UUIDs from pi-tasks's TaskStore.create), not
		// hardcoded "t-implement" / "t-review-final" / "t-merge" literals.
		expect(result.tasks.implement.id).toMatch(/^\d+$/);
		expect(result.tasks.implement.id).not.toBe("t-implement");
		expect(result.tasks.implement.status).toBe("completed");
		expect(result.tasks.review.id).toMatch(/^\d+$/);
		expect(result.tasks.review.id).not.toBe("t-review-final");
		expect(result.tasks.review.verdict).toBe("CLEAN");
		expect(result.tasks.merge.id).toMatch(/^\d+$/);
		expect(result.tasks.merge.id).not.toBe("t-merge");
		expect(result.tasks.merge.status).toBe("completed");

		// workflow:start payload matches the documented WorkflowStartPayload
		// shape — pi-tasks/src/workflow-handler.ts:50.
		const startEvents = harness.pi.events.emitted.filter(
			(e) => e.channel === "workflow:start",
		);
		expect(startEvents).toHaveLength(1);
		const startPayload = startEvents[0]?.data as {
			workflow_id: string;
			goal_id: string;
			goal: { id: string; title: string };
			max_fix_iterations: number;
			max_redesigns?: number;
			worktree_path: string;
		};
		expect(startPayload.workflow_id).toBe(WORKFLOW_ID);
		expect(startPayload.goal_id).toBe(GOAL_ID);
		expect(startPayload.max_fix_iterations).toBe(3);
		expect(startPayload.worktree_path).toContain("/.pi/worktree/");

		// 5 phase-complete events were emitted (Implement + 3 Reviews + Merge).
		// Advisor tasks don't emit phase-complete (they write a sidecar
		// file instead — see pi-tasks/src/workflow-handler.ts:566-574).
		const phaseCompleteEvents = harness.pi.events.emitted.filter(
			(e) => e.channel === "workflow:phase-complete",
		);
		expect(phaseCompleteEvents).toHaveLength(5);
		const phases = phaseCompleteEvents.map((e) => (e.data as { phase: string }).phase);
		expect(phases).toEqual(["implement", "review", "review", "review", "merge"]);

		// Every review phase-complete carries verdict=CLEAN.
		const reviewEvents = phaseCompleteEvents.filter(
			(e) => (e.data as { phase: string }).phase === "review",
		);
		expect(reviewEvents).toHaveLength(3);
		for (const e of reviewEvents) {
			expect((e.data as { verdict?: string }).verdict).toBe("CLEAN");
		}
	});

	it("pauses on NEEDS_CLARIFICATION and the resume records the answer", async () => {
		const workflowRunP = executeWorkflowRun(
			{
				goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
				options: { max_fix_iterations: 1 },
			},
			{
				pi: harness.pi,
				ctx: {},
				repoCwd,
			},
		);
		await flush();

		// Implement → CLEAN.
		harness.subagents.completeNext("Developer");
		await flush();

		// Review_1 → NEEDS_CLARIFICATION with an open_question.
		harness.subagents.completeNext(
			"Reviewer",
			"```yaml\nverdict: NEEDS_CLARIFICATION\nopen_question: What is the auth scheme?\nscope_check: pass\nanti_goal_check: pass\n```",
		);
		// Two flushes: pi-tasks parses verdict, emits phase-complete, then
		// workflow-run's subscription resolves the Promise.
		await flush();
		await flush();

		const first = (await workflowRunP) as {
			status: string;
			open_question?: string;
		};
		expect(first.status).toBe("blocked");
		expect(first.open_question).toBe("What is the auth scheme?");

		// Inspect workflow-{id}.yaml: status=needs_clarification.
		const statePath = join(repoCwd, ".pi", "orchestrator", `workflow-${GOAL_ID}.yaml`);
		const stateBefore = readFileSync(statePath, "utf-8");
		expect(stateBefore).toContain("status: needs_clarification");

		// GC-2026-102 V5: re-dispatch with clarification_answer hits the
		// resume pathway. The previous paused run's state is loaded, the
		// answer is recorded, and the Promise resolves as success so the
		// orchestrator main agent can re-dispatch a fresh workflow_run
		// with the clarified goal in scope.
		const resumeRunP = executeWorkflowRun(
			{
				goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
				options: {
					max_fix_iterations: 1,
					clarification_answer: "JWT bearer tokens with HS256.",
				},
			},
			{
				pi: harness.pi,
				ctx: {},
				repoCwd,
			},
		);

		const resumed = (await resumeRunP) as {
			status: string;
			clarification_answer_recorded?: string;
		};
		expect(resumed.status).toBe("success");
		expect(resumed.clarification_answer_recorded).toBe("JWT bearer tokens with HS256.");

		// workflow-{id}.yaml now has status=needs_clarification_answered +
		// clarification_answer recorded.
		const stateAfter = readFileSync(statePath, "utf-8");
		expect(stateAfter).toContain("status: needs_clarification_answered");
		expect(stateAfter).toContain("clarification_answer: JWT bearer tokens with HS256.");
	});

	it("NEEDS_CLARIFICATION without answer does NOT trigger resume pathway", async () => {
		// Sanity check: without clarification_answer, the resume pathway
		// does NOT fire (regardless of state). We drive a paused run,
		// then re-dispatch WITHOUT clarification_answer and check the
		// state file: if the resume pathway fired, the status would be
		// "needs_clarification_answered". Without the resume pathway,
		// the function overwrites the state file with a fresh
		// "status: pending". (Drain the second run's Promise to avoid
		// hanging the test runner — the second run is paused on
		// NEEDS_CLARIFICATION by design.)
		const first = executeWorkflowRun(
			{
				goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
				options: { max_fix_iterations: 1 },
			},
			{ pi: harness.pi, ctx: {}, repoCwd },
		);
		await flush();
		harness.subagents.completeNext("Developer");
		await flush();
		harness.subagents.completeNext(
			"Reviewer",
			"```yaml\nverdict: NEEDS_CLARIFICATION\nopen_question: which API?\nscope_check: pass\nanti_goal_check: pass\n```",
		);
		await flush();
		await flush();
		const paused = (await first) as { status: string; open_question?: string };
		expect(paused.status).toBe("blocked");

		// Re-dispatch WITHOUT clarification_answer — must NOT take the
		// resume pathway. We can verify by checking the workflow-{id}.yaml
		// file: if the resume pathway fired, the status would be
		// "needs_clarification_answered". Without the resume pathway,
		// the function overwrites the state file with a fresh
		// "status: pending".
		const reRun = executeWorkflowRun(
			{
				goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
				options: { max_fix_iterations: 1 },
				// No clarification_answer → no resume
			},
			{ pi: harness.pi, ctx: {}, repoCwd },
		);
		await flush();
		const statePath = join(repoCwd, ".pi", "orchestrator", `workflow-${GOAL_ID}.yaml`);
		const stateAfterFresh = readFileSync(statePath, "utf-8");
		expect(stateAfterFresh).not.toContain("needs_clarification_answered");
		expect(stateAfterFresh).toContain("status: pending");
		// The fresh run is paused (waiting for NEEDS_CLARIFICATION or
		// cascade completion — doesn't matter for this assertion). Drain
		// by completing the new Implement so the workflow can progress.
		void reRun.catch(() => {});
	});
});
