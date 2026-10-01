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

import { executeWorkflowRun, type WorkflowRunInput, type WorkflowRunOutput } from "../src/workflow-run.js";
// GC-2026-path-B-swap: WorkflowStartPayload is the contract that pi-tasks
// subscribes to. We import the type so the test pins the shape end-to-end.
import type { WorkflowStartPayload } from "../../pi-tasks/src/workflow-handler.js";

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
	run: (
		input: WorkflowRunInput,
	) => Promise<{ result: WorkflowRunOutput; emitted: CapturedChannel[]; handlers: Map<string, (data: unknown) => void | Promise<void>> }>;
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
	const run = (input: WorkflowRunInput) => {
		const result = executeWorkflowRun(input, {
			pi: pi as unknown as Parameters<typeof executeWorkflowRun>[1]["pi"],
			ctx: {} as Parameters<typeof executeWorkflowRun>[1]["ctx"],
			repoCwd,
			executeTool: undefined,
		});
		return { result, emitted, handlers };
	};

	return { repoCwd, goalPath, pi, emitted, subscribed, get unsubscribed() { return unsubscribed; }, run } as Harness;
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
