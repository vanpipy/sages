/**
 * workflow-run.test.ts — RED-form tests for the path B slim workflow_run.
 *
 * GC-2026-path-B-swap replaces the 1060-line in-process state machine
 * (path A) with an event-driven slim shim. After the swap:
 *
 *   executeWorkflowRun(input, runCtx)
 *     ├─ load goal contract
 *     ├─ write .pi/orchestrator/workflow-{goal_id}.yaml (status: pending)
 *     ├─ pi.events.emit("workflow:start", { workflow_id, goal_id, goal,
 *     │                                   max_fix_iterations, worktree_path })
 *     ├─ pi.events.on("workflow:phase-complete", handler)
 *     └─ resolve when all phase categories complete, or when
 *        max_fix_iterations NEEDS_WORK reviews exhaust the budget.
 *
 * These tests pin the LLM-facing contract of executeWorkflowRun in isolation,
 * with a fake `pi.events` bus and a temp dir for repoCwd so we never touch
 * the real `.pi/orchestrator/` directory.
 *
 * Status: RED. The current workflow-run.ts is path A (in-process state
 * machine); it does not emit "workflow:start" or subscribe to
 * "workflow:phase-complete", so all 5 cases fail for the right reason.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeWorkflowRun, type WorkflowRunInput, type WorkflowRunOutput } from "../../../src/workflow-run.js";
// GC-2026-path-B-swap: WorkflowStartPayload is the contract that pi-tasks
// subscribes to. We import the type so the test pins the shape end-to-end.
import type { WorkflowStartPayload } from "@sages/pi-tasks/workflow-handler";

// ── Fixtures ────────────────────────────────────────────────────────────

const GOAL_ID = "GC-TEST-WORKFLOW";
const GOAL_TITLE = "Add login rate limit";

function makeGoalYaml(): string {
	// GC-2026-goal-contract schema (after af4a47c removed success_criteria[] / verification_cmd).
	return [
		"# Goal Contract",
		`id: ${GOAL_ID}`,
		`title: "${GOAL_TITLE}"`,
		`rationale: "Brute-force protection"`,
		`created_at: "2026-01-01T00:00:00.000Z"`,
		``,
		`anti_goals:`,
		`  - "No new dependencies"`,
		``,
		`scope:`,
		`  include:`,
		`    - "src/auth/**"`,
		`  exclude:`,
		`    - "src/admin/**"`,
		``,
		`constraints: {}`,
		``,
		`done_definition: "Login endpoint rate-limits after 5 attempts/minute"`,
		``,
	].join("\n");
}

// ── Test harness ────────────────────────────────────────────────────────

interface FakePi {
	events: {
		emit: (channel: string, data: unknown) => Promise<void> | void;
		on: (channel: string, handler: (data: unknown) => void | Promise<void>) => () => void;
		off: (channel: string, handler: (data: unknown) => void | Promise<void>) => void;
	};
}

interface CapturedChannel {
	channel: string;
	handler?: (data: unknown) => void | Promise<void>;
	data?: unknown;
}

interface Harness {
	repoCwd: string;
	goalPath: string;
	pi: FakePi;
	emitted: CapturedChannel[];
	subscribed: CapturedChannel[];
	unsubscribed: number;
	// GC-2026-099 R4 (test moved into typecheck scope): `run` returns
	// the result Promise plus the live event-bus maps *synchronously*,
	// so the test can drive handlers mid-flight. The prior signature
	// claimed `Promise<{...}>` (matching the `result` field's Promise
	// type) — a real type mismatch that the `as Harness` cast hid.
	run: (
		input: WorkflowRunInput,
		onUpdate?: (u: unknown) => void,
	) => {
		result: Promise<WorkflowRunOutput>;
		emitted: CapturedChannel[];
		handlers: Map<string, (data: unknown) => void | Promise<void>>;
	};
}

function makeHarness(): Harness {
	const repoCwd = mkdtempSync(join(tmpdir(), "sages-workflow-run-"));
	const goalPath = join(repoCwd, ".pi", "orchestrator", `goal-${GOAL_ID}.yaml`);
	mkdirSync(join(repoCwd, ".pi", "orchestrator"), { recursive: true });
	writeFileSync(goalPath, makeGoalYaml(), "utf-8");

	const emitted: CapturedChannel[] = [];
	const subscribed: CapturedChannel[] = [];
	const handlers = new Map<string, (data: unknown) => void | Promise<void>>();
	let unsubscribed = 0;

	const pi: FakePi = {
		events: {
			emit: async (channel: string, data: unknown) => {
				emitted.push({ channel, data });
			},
			on: (channel: string, handler: (data: unknown) => void | Promise<void>) => {
				subscribed.push({ channel, handler });
				handlers.set(channel, handler);
				return () => {
					unsubscribed += 1;
					handlers.delete(channel);
				};
			},
			off: (_channel: string, handler: (data: unknown) => void | Promise<void>) => {
				unsubscribed += 1;
				if (handlers.get(_channel) === handler) handlers.delete(_channel);
			},
		},
	};

	// NB: run() returns the Promise WITHOUT awaiting — the test fires events
	// into the registered handlers to drive the workflow, then awaits the
	// Promise to read the result. This mirrors production: the LLM's tool
	// call awaits workflow_run while pi-tasks's cascade fires events from
	// background agents.
	const run = (input: WorkflowRunInput, onUpdate?: (u: unknown) => void) => {
		const result = executeWorkflowRun(input, {
			pi: pi as unknown as Parameters<typeof executeWorkflowRun>[1]["pi"],
			ctx: {} as Parameters<typeof executeWorkflowRun>[1]["ctx"],
			repoCwd,
			onUpdate,
		});
		return { result, emitted, handlers };
	};

	return { repoCwd, goalPath, pi, emitted, subscribed, get unsubscribed() { return unsubscribed; }, run };
}

afterEach(() => {
	// mkdtempSync dir is cleaned up explicitly per test via the harness
	// wrapper, so no global teardown needed here.
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("executeWorkflowRun (path B slim)", () => {
	let harness: Harness;

	beforeEach(() => {
		harness = makeHarness();
	});

	afterEach(() => {
		rmSync(harness.repoCwd, { recursive: true, force: true });
	});

	it("loads goal and emits workflow:start with correct payload", async () => {
		const { result: _result, emitted } = await harness.run({
			goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
			options: { max_fix_iterations: 3 },
		});

		const startEvents = emitted.filter(e => e.channel === "workflow:start");
		expect(startEvents).toHaveLength(1);
		const payload = startEvents[0].data as WorkflowStartPayload;
		expect(payload.goal_id).toBe(GOAL_ID);
		expect(payload.goal.title).toBe(GOAL_TITLE);
		expect(payload.max_fix_iterations).toBe(3);
		expect(payload.workflow_id).toBeTruthy();
		// The bug we are fixing: worktree_path must be an absolute path under
		// <repoCwd>/.pi/worktree/... — NOT a literal "<repo>" placeholder.
		expect(payload.worktree_path).not.toContain("<repo>");
		expect(payload.worktree_path.startsWith(harness.repoCwd)).toBe(true);
		expect(payload.worktree_path).toContain(`.pi/worktree/${GOAL_ID}`);
	});

	it("initializes workflow-{goal_id}.yaml with status: pending", async () => {
		await harness.run({
			goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
			options: { max_fix_iterations: 3 },
		});

		const statePath = join(
			harness.repoCwd,
			".pi",
			"orchestrator",
			`workflow-${GOAL_ID}.yaml`,
		);
		const text = readFileSync(statePath, "utf-8");
		expect(text).toContain(`goal_id: ${GOAL_ID}`);
		expect(text).toContain("current_phase: implement");
		expect(text).toContain("status: pending");
		expect(text).toContain("iterations_used: 0");
	});

	// GC-2026-workflow-worktree-namespace: the recorded branch must match
	// what the dispatch brief tells the agent to create (and what the
	// agent actually checks out via git checkout -b). The previous
	// implementation recorded `sages/GOAL_ID-implement` while the brief
	// used `goal_id_lower-implement` -- that disagreement made
	// workflow-{id}.yaml point at a non-existent ref.
	it("records branch WITHOUT the stale `sages/` prefix (GC-2026-workflow-worktree-namespace)", async () => {
		await harness.run({
			goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
			options: { max_fix_iterations: 1 },
		});

		const statePath = join(
			harness.repoCwd,
			".pi",
			"orchestrator",
			`workflow-${GOAL_ID}.yaml`,
		);
		const text = readFileSync(statePath, "utf-8");
		// Branch line must use the canonical format the dispatch brief uses
		// (no `sages/` prefix).
		expect(text).toMatch(new RegExp(`branch: ${GOAL_ID.toLowerCase()}-implement\\b`));
		expect(text).not.toContain(`branch: sages/${GOAL_ID.toLowerCase()}-implement`);
		// worktree_path remains under .pi/worktree/GOAL_ID/implement/.
		expect(text).toMatch(new RegExp(`worktree_path: .*\\.pi/worktree/${GOAL_ID}/implement`));
	});

	it("returns WorkflowRunOutput after all phase categories complete", async () => {
		const { result, emitted, handlers } = harness.run({
			goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
			options: { max_fix_iterations: 1 },
		});

		const phaseComplete = handlers.get("workflow:phase-complete");
		expect(phaseComplete).toBeTruthy();

		const startPayload = emitted.find(e => e.channel === "workflow:start")!
			.data as WorkflowStartPayload;

		await phaseComplete!({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "implement",
			status: "completed",
			task_id: "t-implement",
		});
		await phaseComplete!({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "review",
			iteration: 1,
			status: "completed",
			verdict: "CLEAN",
			findings_count: 0,
			task_id: "t-review-1",
		});
		await phaseComplete!({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "merge",
			status: "completed",
			task_id: "t-merge",
		});

		const output = await result;
		expect(output.status).toBe("success");
		expect(output.goal_id).toBe(GOAL_ID);
		expect(output.tasks.implement.id).toBeTruthy();
		expect(output.tasks.review.verdict).toBe("CLEAN");
		expect(output.tasks.merge).toBeTruthy();
	});

	it("GC-2026-097 H1: output.tasks.{implement,review,merge}.id reflect the real task_id from phase-complete events", async () => {
		// Regression for the audit finding that buildSuccessOutput /
		// buildBlockedOutput hardcoded "t-implement" / "t-review-final" /
		// "t-merge" as the output id, so production UUIDs from
		// pi-tasks's TaskStore.create() were masked. Pin the new
		// behavior: each phase's id in the output is the exact
		// task_id pi-tasks emitted on workflow:phase-complete.
		const IMPL_UUID = "uuid-implement-7f3a";
		const REVIEW_UUID = "uuid-review-c0c0";
		const MERGE_UUID = "uuid-merge-d3ad";

		const { result, emitted, handlers } = harness.run({
			goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
			options: { max_fix_iterations: 1 },
		});
		const phaseComplete = handlers.get("workflow:phase-complete")!;
		const startPayload = emitted.find(e => e.channel === "workflow:start")!
			.data as WorkflowStartPayload;

		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "implement", status: "completed", task_id: IMPL_UUID,
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "review", iteration: 1, status: "completed",
			verdict: "CLEAN", findings_count: 0, task_id: REVIEW_UUID,
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "merge", status: "completed", task_id: MERGE_UUID,
		});

		const output = await result;
		expect(output.status).toBe("success");
		expect(output.tasks.implement.id).toBe(IMPL_UUID);
		expect(output.tasks.review.id).toBe(REVIEW_UUID);
		expect(output.tasks.merge?.id).toBe(MERGE_UUID);
		// Sanity: must not be the old placeholder literals.
		expect(output.tasks.implement.id).not.toBe("t-implement");
		expect(output.tasks.review.id).not.toBe("t-review-final");
		expect(output.tasks.merge?.id).not.toBe("t-merge");
	});

	it("GC-2026-097 H1: blocked output also reflects real task_id from phase-complete events", async () => {
		// Same regression for the blocked path: blocked_at + per-phase ids
		// come from the phase-complete event stream, not hardcoded.
		const IMPL_UUID = "uuid-implement-1111";
		const REVIEW_UUID = "uuid-review-2222";
		const { result, emitted, handlers } = harness.run({
			goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
			options: { max_fix_iterations: 1 },
		});
		const phaseComplete = handlers.get("workflow:phase-complete")!;
		const startPayload = emitted.find(e => e.channel === "workflow:start")!
			.data as WorkflowStartPayload;

		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "implement", status: "completed", task_id: IMPL_UUID,
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "review", iteration: 1, status: "completed",
			verdict: "NEEDS_WORK", findings_count: 1, task_id: REVIEW_UUID,
		});

		const output = await result;
		expect(output.status).toBe("blocked");
		expect(output.tasks.implement.id).toBe(IMPL_UUID);
		expect(output.tasks.implement.id).not.toBe("t-implement");
		expect(output.tasks.review.id).toBe(REVIEW_UUID);
		expect(output.tasks.review.id).not.toBe("t-review-final");
	});

	it("returns status: blocked after max_fix_iterations NEEDS_WORK", async () => {
		const { result, emitted, handlers } = harness.run({
			goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
			options: { max_fix_iterations: 2 },
		});

		const phaseComplete = handlers.get("workflow:phase-complete");
		expect(phaseComplete).toBeTruthy();
		const startPayload = emitted.find(e => e.channel === "workflow:start")!
			.data as WorkflowStartPayload;

		await phaseComplete!({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "implement",
			status: "completed",
			task_id: "t-implement",
		});
		await phaseComplete!({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "review",
			iteration: 1,
			status: "completed",
			verdict: "NEEDS_WORK",
			findings_count: 1,
			task_id: "t-review-1",
		});
		await phaseComplete!({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "fix",
			iteration: 1,
			status: "completed",
			task_id: "t-fix-1",
		});
		await phaseComplete!({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "review",
			iteration: 2,
			status: "completed",
			verdict: "NEEDS_WORK",
			findings_count: 2,
			task_id: "t-review-2",
		});

		const output = await result;
		expect(output.status).toBe("blocked");
		expect(output.blocked_at).toBe("review");
		expect(output.iterations_used).toBe(2);
	});

	it("returns status: blocked when Implement phase fails (status: 'failed')", async () => {
		// GC-2026-pi-tasks-cascade-agentid: phase-complete events may carry
		// status: "failed" when the subagent itself crashes (the GC-2026-096
		// case). workflow_run must resolve immediately on failure instead of
		// hanging forever waiting for a completion that will never come.
		const { result, emitted, handlers } = harness.run({
			goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
			options: { max_fix_iterations: 3 },
		});

		const phaseComplete = handlers.get("workflow:phase-complete");
		expect(phaseComplete).toBeTruthy();
		const startPayload = emitted.find(e => e.channel === "workflow:start")!
			.data as WorkflowStartPayload;

		await phaseComplete!({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "implement",
			status: "failed",
			error: "SpawnOptions.cwd must be an absolute path",
			task_id: "t-implement",
		});

		const output = await result;
		expect(output.status).toBe("blocked");
		expect(output.blocked_at).toBe("implement");
		expect(output.merge_error).toContain("absolute path");
		// After resolving, workflow_run must unsubscribe so future events on
		// the same workflow_id don't bleed into this resolved output.
		expect(handlers.has("workflow:phase-complete")).toBe(false);
	});

	it("returns status: blocked when a Fix phase fails (status: 'failed')", async () => {
		// The failure path also covers fix_loop: a Review CLEAN + Fix that
		// crashes mid-iteration must resolve the workflow as blocked rather
		// than waiting for Review_N+1 that will never be spawned.
		const { result, emitted, handlers } = harness.run({
			goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
			options: { max_fix_iterations: 3 },
		});

		const phaseComplete = handlers.get("workflow:phase-complete");
		expect(phaseComplete).toBeTruthy();
		const startPayload = emitted.find(e => e.channel === "workflow:start")!
			.data as WorkflowStartPayload;

		await phaseComplete!({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "implement",
			status: "completed",
			task_id: "t-implement",
		});
		await phaseComplete!({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "review",
			iteration: 1,
			status: "completed",
			verdict: "NEEDS_WORK",
			findings_count: 1,
			task_id: "t-review-1",
		});
		await phaseComplete!({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "fix",
			iteration: 1,
			status: "failed",
			error: "Fix agent timed out after 10 min",
			task_id: "t-fix-1",
		});

		const output = await result;
		expect(output.status).toBe("blocked");
		expect(output.merge_error).toContain("timed out");
	});

	it("subscribes to workflow:phase-complete (and unsubscribes on completion)", async () => {
		const { result, emitted, handlers } = harness.run({
			goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
			options: { max_fix_iterations: 1 },
		});

		expect(handlers.has("workflow:phase-complete")).toBe(true);
		const phaseComplete = handlers.get("workflow:phase-complete")!;

		const startPayload = emitted.find(e => e.channel === "workflow:start")!
			.data as WorkflowStartPayload;
		await phaseComplete({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "implement",
			status: "completed",
			task_id: "t-implement",
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "review",
			iteration: 1,
			status: "completed",
			verdict: "CLEAN",
			findings_count: 0,
			task_id: "t-review-1",
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id,
			goal_id: GOAL_ID,
			phase: "merge",
			status: "completed",
			task_id: "t-merge",
		});

		await result;
		// After resolution the workflow_run should have called the unsub fn.
		expect(handlers.has("workflow:phase-complete")).toBe(false);
	});
});

// GC-2026-workflow-chat-stream: onUpdate streaming tests. workflow_run
// emits partial-progress payloads to the host via the onUpdate callback.
// Each call carries partial: true so the host's TUI renders it as a
// streaming tool-result block. Tests pin the shape, ordering, and that
// NEEDS_CLARIFICATION includes the open_question.
describe("executeWorkflowRun (path B slim) — onUpdate streaming (GC-2026-workflow-chat-stream)", () => {
	let harness: Harness;

	beforeEach(() => {
		harness = makeHarness();
	});

	afterEach(() => {
		rmSync(harness.repoCwd, { recursive: true, force: true });
	});

	it("emits an onUpdate partial payload for each phase transition (clean path)", async () => {
		const updates: unknown[] = [];
		const { result, emitted, handlers } = harness.run(
			{ goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`, options: { max_fix_iterations: 1 } },
			(u) => updates.push(u),
		);

		const startPayload = emitted.find(e => e.channel === "workflow:start")!
			.data as WorkflowStartPayload;
		const phaseComplete = handlers.get("workflow:phase-complete")!;

		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "implement", status: "completed", task_id: "t-implement",
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "review", iteration: 1, status: "completed",
			verdict: "CLEAN", findings_count: 0, task_id: "t-review-1",
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "merge", status: "completed", task_id: "t-merge",
		});
		await result;

		expect(updates.length).toBe(3);
		// GC-2026-chat-stream-render: payload is now wrapped in
		// AgentToolResult envelope (content + details). Tests inspect
		// `update.details.X` rather than `update.X`.
		const first = (updates[0] as { content: unknown[]; details: Record<string, unknown> });
		expect(first.content).toEqual([]);
		expect((first.details as { current_phase: string }).current_phase).toBe("implement");
		expect((first.details as { goal_id: string }).goal_id).toBe(GOAL_ID);
		expect((first.details as { tasks_done: number; tasks_total: number }).tasks_done).toBe(1);
		// GC-2026-097 H2: tasks_total is an upper bound (Implement +
		// max_fix_iterations Reviews + max_fix_iterations Fixes + Merge).
		// For max=1: 1 impl + 1 review + 1 fix + 1 merge = 4.
		expect((first.details as { tasks_total: number }).tasks_total).toBe(4);
		expect((first.details as { summary: string }).summary).toMatch(/Implement complete/);
		// Second update: review (CLEAN) → next review transition (last review → merge).
		const second = (updates[1] as { details: Record<string, unknown> }).details;
		expect((second as { current_phase: string }).current_phase).toBe("review");
		expect((second as { last_verdict: string }).last_verdict).toBe("CLEAN");
		expect((second as { findings_count: number }).findings_count).toBe(0);
		// Third update: merge.
		const third = (updates[2] as { details: Record<string, unknown> }).details;
		expect((third as { current_phase: string }).current_phase).toBe("merge");
		expect((third as { tasks_done: number }).tasks_done).toBe(3);
	});

	it("emits NEEDS_WORK fix iterations + findings_count in onUpdate payload", async () => {
		const updates: unknown[] = [];
		const { result, emitted, handlers } = harness.run(
			{ goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`, options: { max_fix_iterations: 3 } },
			(u) => updates.push(u),
		);

		const startPayload = emitted.find(e => e.channel === "workflow:start")!
			.data as WorkflowStartPayload;
		const phaseComplete = handlers.get("workflow:phase-complete")!;

		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "implement", status: "completed", task_id: "t-implement",
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "review", iteration: 1, status: "completed",
			verdict: "NEEDS_WORK", findings_count: 2, task_id: "t-review-1",
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "fix", iteration: 1, status: "completed", task_id: "t-fix-1",
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "review", iteration: 2, status: "completed",
			verdict: "CLEAN", findings_count: 0, task_id: "t-review-2",
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "merge", status: "completed", task_id: "t-merge",
		});
		await result;

		// 5 phase transitions: implement → review1 → fix1 → review2 → merge
		expect(updates.length).toBe(5);
		// GC-2026-097 H2: max=3 upper bound is 1 + 2*3 + 1 = 8.
		for (const u of updates) {
			expect(((u as { details: { tasks_total: number } }).details).tasks_total).toBe(8);
		}
		// After Review_1 NEEDS_WORK: payload carries findings_count=2 +
		// last_verdict=NEEDS_WORK + fix_iterations_used=1 (the counter ticks
		// when the Review phase branches on NEEDS_WORK).
		const review1Details = (updates[1] as { details: Record<string, unknown> }).details;
		expect((review1Details as { last_verdict: string }).last_verdict).toBe("NEEDS_WORK");
		expect((review1Details as { findings_count: number }).findings_count).toBe(2);
		expect((review1Details as { fix_iterations_used: number }).fix_iterations_used).toBe(1);
		// Fix_1 phase: payload carries fix_iterations_used=1.
		const fix1Details = (updates[2] as { details: Record<string, unknown> }).details;
		expect((fix1Details as { current_phase: string }).current_phase).toBe("fix");
		expect((fix1Details as { fix_iterations_used: number }).fix_iterations_used).toBe(1);
	});

	it("NEEDS_CLARIFICATION onUpdate payload includes open_question", async () => {
		const updates: unknown[] = [];
		const { result, emitted, handlers } = harness.run(
			{ goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`, options: { max_fix_iterations: 1 } },
			(u) => updates.push(u),
		);

		const startPayload = emitted.find(e => e.channel === "workflow:start")!
			.data as WorkflowStartPayload;
		const phaseComplete = handlers.get("workflow:phase-complete")!;

		// Drive implement → review → needs_clarification. The needs_clarification
		// event is what pauses the workflow, not anything before it. The handler
		// emits a partial onUpdate payload for the needs_clarification phase
		// before resolving the workflow-run Promise.
		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "implement", status: "completed", task_id: "t-implement",
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "review", iteration: 1, status: "needs_clarification",
			verdict: "NEEDS_CLARIFICATION",
			findings_count: 0,
			open_question: "snake_case or camelCase?",
			task_id: "t-review-1",
		});
		await result;

		const reviewDetails = (updates[1] as { details: Record<string, unknown> }).details;
		expect((reviewDetails as { current_phase: string }).current_phase).toBe("needs_clarification");
		expect((reviewDetails as { last_verdict: string }).last_verdict).toBe("NEEDS_CLARIFICATION");
		expect((reviewDetails as { open_question: string }).open_question).toBe("snake_case or camelCase?");
	});

	it("does NOT call onUpdate when the host omits the callback", async () => {
		// Caller can pass options without onUpdate — workflow_run should
		// silently skip the progress emit (defensive, since the type
		// marks it optional).
		const { result, handlers } = harness.run({
			goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
			options: { max_fix_iterations: 1 },
		});

		const phaseComplete = handlers.get("workflow:phase-complete")!;
		await phaseComplete({
			workflow_id: `wf-${GOAL_ID}`, goal_id: GOAL_ID,
			phase: "implement", status: "completed", task_id: "t-implement",
		});
		await phaseComplete({
			workflow_id: `wf-${GOAL_ID}`, goal_id: GOAL_ID,
			phase: "review", iteration: 1, status: "completed",
			verdict: "CLEAN", findings_count: 0, task_id: "t-review-1",
		});
		await phaseComplete({
			workflow_id: `wf-${GOAL_ID}`, goal_id: GOAL_ID,
			phase: "merge", status: "completed", task_id: "t-merge",
		});
		await result;
		// No throw = success; the onUpdate optional is honored silently.
	});

	// GC-2026-chat-stream-render: the onUpdate payload MUST conform to
	// the host's AgentToolResult<WorkflowProgressDetails> envelope. The
	// first audit (GC-2026-workflow-chat-stream) assumed a flat shape
	// with `partial: true`, which the host didn't read; this test pins
	// the corrected shape so a regression lands in CI.
	it("onUpdate payload matches AgentToolResult<WorkflowProgressDetails> envelope", async () => {
		const updates: unknown[] = [];
		const { result, emitted, handlers } = harness.run(
			{ goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`, options: { max_fix_iterations: 1 } },
			(u) => updates.push(u),
		);

		const startPayload = emitted.find(e => e.channel === "workflow:start")!
			.data as WorkflowStartPayload;
		const phaseComplete = handlers.get("workflow:phase-complete")!;

		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "implement", status: "completed", task_id: "t-implement",
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "review", iteration: 1, status: "completed",
			verdict: "CLEAN", findings_count: 0, task_id: "t-review-1",
		});
		await phaseComplete({
			workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
			phase: "merge", status: "completed", task_id: "t-merge",
		});
		await result;

		expect(updates.length).toBe(3);
		// Pick the first update (Implement) to assert the envelope shape.
		const u = updates[0] as { content: unknown[]; details: Record<string, unknown> };
		// Envelope: { content, details } — AgentToolResult<TDetails> shape
		expect(u).toHaveProperty("content");
		expect(u).toHaveProperty("details");
		expect(u.content).toEqual([]);
		// No literal `partial: true` field anywhere (would be a regression
		// to the GC-2026-workflow-chat-stream shape the first audit flagged)
		expect(u).not.toHaveProperty("partial");
		expect(u.details).not.toHaveProperty("partial");
		// Details carry the progress data
		expect((u.details as { goal_id: string }).goal_id).toBe(GOAL_ID);
		expect((u.details as { current_phase: string }).current_phase).toBe("implement");
	});

	// GC-2026-109 FU1a: workflow_run watchdog. When the active session has
	// no listener for workflow:start (e.g. pi-tasks / pi-subagents not
	// registered), the Promise previously hung until harness timeout. The
	// watchdog detects "no progress" within options.timeout_ms and rejects
	// with a clear, actionable error.
	describe("watchdog (GC-2026-109 FU1a)", () => {
		it("rejects with WorkflowRunStartTimeoutError when no workflow:phase-complete arrives within timeout_ms", async () => {
			const { result } = harness.run({
				goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
				options: { max_fix_iterations: 1, timeout_ms: 50 },
			});
			// No event fires; the watchdog should reject the Promise.
			await expect(result).rejects.toThrow(/workflow_run for goal/);
			await expect(result).rejects.toThrow(/pi-tasks/);
			await expect(result).rejects.toThrow(/install\.sh/);
		});

		it("does NOT fire the watchdog when a workflow:phase-complete arrives within the window", async () => {
			const { result, emitted, handlers } = harness.run({
				goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
				options: { max_fix_iterations: 1, timeout_ms: 200 },
			});
			// Drive the cascade normally: implement -> review -> merge.
			const startPayload = emitted.find(e => e.channel === "workflow:start")!
				.data as WorkflowStartPayload;
			const phaseComplete = handlers.get("workflow:phase-complete")!;
			await phaseComplete({
				workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
				phase: "implement", status: "completed", task_id: "t-impl",
			});
			await phaseComplete({
				workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
				phase: "review", iteration: 1, status: "completed",
				verdict: "CLEAN", findings_count: 0, task_id: "t-review-1",
			});
			await phaseComplete({
				workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
				phase: "merge", status: "completed", task_id: "t-merge",
			});
			const out = await result;
			expect(out.status).toBe("success");
		});

		it("timeout_ms: 0 disables the watchdog — late events still resolve", async () => {
			// With watchdog disabled, the Promise should NOT reject even if
			// no events fire within any "normal" window. We verify by
			// firing events well after a 50ms delay and confirming the
			// Promise resolves as success (not as the watchdog error).
			const { result, emitted, handlers } = harness.run({
				goal_path: `.pi/orchestrator/goal-${GOAL_ID}.yaml`,
				options: { max_fix_iterations: 1, timeout_ms: 0 },
			});
			// Wait 50ms (longer than the default 10s would-be-window's
			// early-detection — proves the watchdog is genuinely off).
			await new Promise((r) => setTimeout(r, 50));
			// Now fire all phases. With the watchdog disabled, the Promise
			// should resolve as success.
			const startPayload = emitted.find(e => e.channel === "workflow:start")!
				.data as WorkflowStartPayload;
			const phaseComplete = handlers.get("workflow:phase-complete")!;
			await phaseComplete({
				workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
				phase: "implement", status: "completed", task_id: "t-impl",
			});
			await phaseComplete({
				workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
				phase: "review", iteration: 1, status: "completed",
				verdict: "CLEAN", findings_count: 0, task_id: "t-review-1",
			});
			await phaseComplete({
				workflow_id: startPayload.workflow_id, goal_id: GOAL_ID,
				phase: "merge", status: "completed", task_id: "t-merge",
			});
			const out = await result;
			expect(out.status).toBe("success");
		});
	});
});
