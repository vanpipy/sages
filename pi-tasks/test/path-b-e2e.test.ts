/**
 * path-b-e2e.test.ts — End-to-end tests for the path B event-driven workflow.
 *
 * The handler subscribes to two events:
 *
 *   1. `workflow:start` — emitted by pi-orchestrator/workflow_run. The handler
 *      builds the static task graph (Implement + max_fix_iterations Reviews +
 *      Merge — Fix tasks are NOT pre-created, GC-2026-verdict-states-and-dynamic-cascade),
 *      creates the tasks, wires blockedBy edges, then spawns the Implement task.
 *
 *   2. `subagents:completed` — drives the cascade.
 *
 * GC-2026-verdict-states-and-dynamic-cascade: the graph has only 5 tasks
 * static (Implement + 3 Reviews + Merge for max_fix_iterations=3). Fix tasks
 * are created on demand when a Review reports NEEDS_WORK. With all-CLEAN
 * reviews, only 5 task spawns happen. With NEEDS_WORK on Reviews 1+2,
 * 2 additional Fix spawns fire (7 total) before Merge.
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/types.js";
import type { WorkflowStartPayload } from "../src/workflow-handler.js";
import { subscribeWorkflow } from "../src/workflow-handler.js";

const GOAL_ID = "GC-2026-path-B-E2E";
const WORKFLOW_ID = "wf-e2e-1";

const goal = {
	id: GOAL_ID,
	title: "Path B E2E goal",
	rationale: "verification",
	scope: { include: ["src/**"], exclude: ["dist/**"] },
	anti_goals: ["no new deps"],
	done_definition: "tests pass",
};

const cleanReviewYaml = "verdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass";
const needsWorkReviewYaml = [
	"verdict: NEEDS_WORK",
	"findings:",
	"  - severity: major",
	"    issue: missing test",
	"scope_check: pass",
	"anti_goal_check: pass",
].join("\n");

interface Harness {
	store: TaskStore;
	events: ReturnType<typeof fakeEvents>;
	spy: { spawnCalls: Task[] };
	fire: (channel: string, data: unknown) => Promise<void>;
}

function fakeEvents() {
	const handlers = new Map<string, Set<(data: unknown) => void | Promise<void>>>();
	const emittedLog: Array<{ channel: string; data: unknown }> = [];
	return {
		on(channel: string, handler: (data: unknown) => void | Promise<void>) {
			if (!handlers.has(channel)) handlers.set(channel, new Set());
			handlers.get(channel)!.add(handler);
			return () => { handlers.get(channel)?.delete(handler); };
		},
		emit(channel: string, data: unknown): Promise<void> {
			emittedLog.push({ channel, data });
			const set = handlers.get(channel);
			if (!set) return Promise.resolve();
			return (async () => {
				for (const h of [...set]) await h(data);
			})();
		},
		emittedLog,
	};
}

function setup(): Harness {
	const store = new TaskStore();
	const events = fakeEvents();
	const spawnCalls: Task[] = [];
	const spawnAgent = vi.fn(async (task: Task) => {
		spawnCalls.push(task);
		return `agent-${task.id}`;
	});

	subscribeWorkflow(store, {
		events: { on: events.on, emit: events.emit },
		spawnAgent,
	});

	const fire = async (channel: string, data: unknown) => {
		await events.emit(channel, data);
		await new Promise<void>(resolve => setImmediate(resolve));
	};

	return { store, events, spy: { spawnCalls }, fire, primarySpawnCalls: () => spawnCalls.filter(t => !t.metadata.advisorOf) };
}

const startPayload: WorkflowStartPayload = {
	workflow_id: WORKFLOW_ID,
	goal_id: GOAL_ID,
	goal,
	max_fix_iterations: 3,
	worktree_path: "/tmp/wf",
};

// ── Tests ──────────────────────────────────────────────────────────────

describe("path B end-to-end (GC-2026-verdict-states-and-dynamic-cascade)", () => {
	beforeEach(() => {});

	test("workflow:start creates 5 static tasks (no Fix pre-created) + spawns Implement", async () => {
		const h = setup();

		await h.fire("workflow:start", startPayload);

		const tasks = h.store.list();
		// GC-2026-verdict-states-and-dynamic-cascade: Implement + 3 Reviews +
		// Merge = 5. Fix tasks are NOT pre-created.
		expect(tasks).toHaveLength(5);
		expect(h.primarySpawnCalls()).toHaveLength(1);
		expect(h.primarySpawnCalls()[0].metadata.phase).toBe("implement");

		const byPhase = (phase: string) => tasks.filter(t => t.metadata.phase === phase);
		expect(byPhase("implement")).toHaveLength(1);
		expect(byPhase("review")).toHaveLength(3);
		expect(byPhase("fix")).toHaveLength(0); // dynamic, not pre-created
		expect(byPhase("merge")).toHaveLength(1);
	});

	test("Implement completes → Review_1 spawned (cascade advances)", async () => {
		const h = setup();
		await h.fire("workflow:start", startPayload);

		const implement = h.store.list().find(t => t.metadata.phase === "implement")!;
		h.spy.spawnCalls.length = 0;

		await h.fire("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });

		expect(h.primarySpawnCalls()).toHaveLength(1);
		expect(h.primarySpawnCalls()[0].subject).toMatch(/Review 1:/);
	});

	test("Review_1 CLEAN → Review_2 spawned (no Fix dispatched)", async () => {
		// GC-2026-verdict-states-and-dynamic-cascade: clean reviews cascade
		// Review → Review directly; Fix is only created when NEEDS_WORK.
		const h = setup();
		await h.fire("workflow:start", startPayload);

		const implement = h.store.list().find(t => t.metadata.phase === "implement")!;
		await h.fire("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });

		const review1 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
		h.spy.spawnCalls.length = 0;

		await h.fire("subagents:completed", {
			id: `agent-${review1.id}`,
			result: "```yaml\n" + cleanReviewYaml + "\n```",
		});

		// No Fix was spawned; Review_2 is next.
		expect(h.primarySpawnCalls()).toHaveLength(1);
		expect(h.primarySpawnCalls()[0].subject).toMatch(/Review 2:/);
		expect(h.store.list().find(t => t.metadata.phase === "fix")).toBeUndefined();
	});

	test("Review_1 NEEDS_WORK → Fix_1 spawned dynamically + Review_2 waits", async () => {
		const h = setup();
		await h.fire("workflow:start", startPayload);

		const implement = h.store.list().find(t => t.metadata.phase === "implement")!;
		await h.fire("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });

		const review1 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
		h.spy.spawnCalls.length = 0;

		await h.fire("subagents:completed", {
			id: `agent-${review1.id}`,
			result: "```yaml\n" + needsWorkReviewYaml + "\n```",
		});

		// Fix_1 was created and spawned.
		expect(h.primarySpawnCalls()).toHaveLength(1);
		expect(h.primarySpawnCalls()[0].subject).toMatch(/Fix 1:/);
		// Review_2 was NOT spawned (waiting for Fix_1).
		const review2 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 2);
		expect(review2).toBeDefined();
		expect(h.store.get(review2!.id)?.status).toBe("pending");
	});

	test("Fix_1 completes → Review_2 spawned (NEEDS_WORK → Fix → Review loop)", async () => {
		const h = setup();
		await h.fire("workflow:start", startPayload);

		const implement = h.store.list().find(t => t.metadata.phase === "implement")!;
		await h.fire("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });

		const review1 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
		await h.fire("subagents:completed", {
			id: `agent-${review1.id}`,
			result: "```yaml\n" + needsWorkReviewYaml + "\n```",
		});

		const fix1 = h.store.list().find(t => t.metadata.phase === "fix" && t.metadata.iteration === 1)!;
		h.spy.spawnCalls.length = 0;
		await h.fire("subagents:completed", { id: `agent-${fix1.id}`, result: "ok" });

		// Review_2 spawned.
		expect(h.primarySpawnCalls()).toHaveLength(1);
		expect(h.primarySpawnCalls()[0].subject).toMatch(/Review 2:/);
	});

	test("Review_2 NEEDS_WORK → Fix_2 spawned dynamically", async () => {
		const h = setup();
		await h.fire("workflow:start", startPayload);

		// Drive: Implement → Review_1 (NEEDS_WORK) → Fix_1 → Review_2
		const implement = h.store.list().find(t => t.metadata.phase === "implement")!;
		await h.fire("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });

		const review1 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
		await h.fire("subagents:completed", {
			id: `agent-${review1.id}`,
			result: "```yaml\n" + needsWorkReviewYaml + "\n```",
		});

		const fix1 = h.store.list().find(t => t.metadata.phase === "fix" && t.metadata.iteration === 1)!;
		await h.fire("subagents:completed", { id: `agent-${fix1.id}`, result: "ok" });

		const review2 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 2)!;
		h.spy.spawnCalls.length = 0;

		await h.fire("subagents:completed", {
			id: `agent-${review2.id}`,
			result: "```yaml\n" + needsWorkReviewYaml + "\n```",
		});

		// Fix_2 spawned dynamically.
		expect(h.primarySpawnCalls()).toHaveLength(1);
		expect(h.primarySpawnCalls()[0].subject).toMatch(/Fix 2:/);
	});

	test("Review_3 CLEAN → Merge spawned (cascade finalizes)", async () => {
		const h = setup();
		await h.fire("workflow:start", startPayload);

		// Drive all-CLEAN path: Implement → Review_1 → Review_2 → Review_3 → Merge
		const implement = h.store.list().find(t => t.metadata.phase === "implement")!;
		await h.fire("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });

		const review1 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
		await h.fire("subagents:completed", {
			id: `agent-${review1.id}`,
			result: "```yaml\n" + cleanReviewYaml + "\n```",
		});

		const review2 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 2)!;
		await h.fire("subagents:completed", {
			id: `agent-${review2.id}`,
			result: "```yaml\n" + cleanReviewYaml + "\n```",
		});

		const review3 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 3)!;
		h.spy.spawnCalls.length = 0;

		await h.fire("subagents:completed", {
			id: `agent-${review3.id}`,
			result: "```yaml\n" + cleanReviewYaml + "\n```",
		});

		// Merge is the last spawn.
		expect(h.primarySpawnCalls()).toHaveLength(1);
		expect(h.primarySpawnCalls()[0].subject).toBe(`Merge: ${goal.title}`);
	});

	test("Merge completes → 5 static + 2 dynamic = 7 tasks in completed status, every phase emitted workflow:phase-complete", async () => {
		// Worst-case scenario: all 3 Reviews NEEDS_WORK → max 2 Fixes
		// dispatched (per max_fix_iterations=3; Review_3 NEEDS_WORK doesn't
		// dispatch Fix because iterations_used=3 hits the cap and is the
		// last iteration; workflow-run resolves as blocked). With the loop
		// staying healthy, we drive NEEDS_WORK on Reviews 1+2, then CLEAN
		// on Review_3.
		const h = setup();
		await h.fire("workflow:start", startPayload);

		const drive = async (phase: string, iteration: number | undefined, verdictYaml?: string) => {
			const t = h.store.list().find(x =>
				x.metadata.phase === phase &&
				(iteration === undefined || x.metadata.iteration === iteration),
			)!;
			const result = verdictYaml ? `\`\`\`yaml\n${verdictYaml}\n\`\`\`` : "ok";
			await h.fire("subagents:completed", { id: `agent-${t.id}`, result });
		};

		await drive("implement", undefined);
		await drive("review", 1, needsWorkReviewYaml); // → Fix_1
		await drive("fix", 1);
		await drive("review", 2, needsWorkReviewYaml); // → Fix_2
		await drive("fix", 2);
		await drive("review", 3, cleanReviewYaml);
		await drive("merge", undefined);

		const tasks = h.store.list();
		const completed = tasks.filter(t => t.status === "completed");
		// GC-2026-advisor-spec-integration: every primary task has a paired
		// advisor sibling. Implement + 3× Review + Merge = 5 primaries;
		// plus 2 dynamic Fixes (each with a FixAdvisor). Advisors are 6
		// (no MergeAdvisor): 1 DeveloperAdvisor + 3 ReviewerAdvisor + 2
		// FixAdvisor. Total tasks = 5 + 2 + 6 = 13. (Pre-GC: 7.)
		const primaries = tasks.filter(t => !t.metadata.advisorOf);
		const advisors = tasks.filter(t => t.metadata.advisorOf);
		expect(tasks).toHaveLength(13);
		expect(primaries).toHaveLength(7);  // 5 static + 2 dynamic
		expect(advisors).toHaveLength(6);  // 1 + 3 + 2
		expect(completed).toHaveLength(7);  // only primaries complete; advisors stay in_progress
		// Every completed primary must have triggered workflow:phase-complete.
		// Advisors don't emit phase-complete (they write the
		// {kind}-advisor-{task_id}.md file instead, which is the orchestrator's
		// downstream consumption, not an event for it).
		expect(completed.filter(t => primaries.includes(t))).toHaveLength(7);
		for (const t of primaries) {
			expect(completed).toContain(t);
		}

		const phaseCompleteEvents = h.events.emittedLog.filter(e => e.channel === "workflow:phase-complete");
		// 7 phase-complete events (one per primary task). 6 advisor tasks
		// do NOT emit phase-complete.
		expect(phaseCompleteEvents).toHaveLength(7);
		expect(phaseCompleteEvents.map(e => (e.data as Record<string, unknown>).phase)).toEqual([
			"implement",
			"review",
			"fix",
			"review",
			"fix",
			"review",
			"merge",
		]);

		// The review events should carry verdict
		const reviewEvents = phaseCompleteEvents.filter(e => (e.data as Record<string, unknown>).phase === "review");
		expect(reviewEvents).toHaveLength(3);
		for (const e of reviewEvents) {
			expect((e.data as Record<string, unknown>).verdict).toBeDefined();
		}
	});
});

// ─────────────────────────────────────────────────────────────────────
// GC-2026-pi-tasks-cascade-agentid: real-id spawn path
//
// The existing suite uses a fake spawnAgent that returns "agent-${task.id}" to
// match the synthetic IDs the handler pre-registered in workflow:start. Production
// spawn (pi-subagents/agent-manager.ts:346) returns real UUID prefixes
// (randomUUID().slice(0,17)) — these never match the pre-registration, so the
// cascade stalls. These tests pin the new contract: the spawn id is opaque to the
// handler, and the cascade must still advance when the handler sees the same id
// back from subagents:completed.
// ─────────────────────────────────────────────────────────────────────

describe("subscribeWorkflow — real-id spawn path (production wiring)", () => {
	let idCounter = 0;
	const realIds = new Map<string, string>(); // taskId → real-format id

	function setupWithRealIds() {
		const store = new TaskStore();
		const events = fakeEvents();
		const spawnCalls: Task[] = [];

		const spawnAgent = vi.fn(async (task: Task) => {
			spawnCalls.push(task);
			// Mirror pi-subagents/agent-manager.ts:346: 17-char UUID prefix.
			// Distinct from "agent-${task.id}" — this is the production shape.
			const realId = `cf9f3e74-835c-4c${++idCounter}`.slice(0, 17);
			realIds.set(task.id, realId);
			return realId;
		});

		const cleanup = subscribeWorkflow(store, {
			events: { on: events.on, emit: events.emit },
			spawnAgent,
		});

		const fire = async (channel: string, data: unknown) => {
			await events.emit(channel, data);
			await new Promise<void>(resolve => setImmediate(resolve));
		};

		return {
			store,
			events,
			spawnCalls,
			fire,
			cleanup,
			realIds,
			primarySpawnCalls: () => spawnCalls.filter(t => !t.metadata.advisorOf),
		};
	}

	test("cascade advances when subagents:completed carries the real-format id (no synthetic pre-registration match)", async () => {
		const h = setupWithRealIds();
		await h.fire("workflow:start", startPayload);

		const implement = h.store.list().find(t => t.metadata.phase === "implement")!;
		const implementRealId = h.realIds.get(implement.id);
		expect(implementRealId).toBeDefined();
		expect(implementRealId).not.toMatch(/^agent-\d+$/); // not the synthetic scheme

		h.spawnCalls.length = 0;

		// Send the REAL id back via subagents:completed — this is what
		// pi-subagents emits. With the buggy pre-registration, the handler
		// misses this lookup and the cascade stalls.
		await h.fire("subagents:completed", { id: implementRealId, result: "ok" });

		expect(h.primarySpawnCalls()).toHaveLength(1);
		expect(h.primarySpawnCalls()[0].subject).toMatch(/Review 1:/);

		const review1 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
		expect(review1.status).toBe("in_progress");
		expect(review1.owner).toBe(h.realIds.get(review1.id));
	});

	test("subagents:failed emits workflow:phase-complete with status: 'failed' and does not stall", async () => {
		const h = setupWithRealIds();
		await h.fire("workflow:start", startPayload);

		const implement = h.store.list().find(t => t.metadata.phase === "implement")!;
		const implementRealId = h.realIds.get(implement.id)!;

		// Simulate the implement agent failing (the GC-2026-096 scenario)
		await h.fire("subagents:failed", {
			id: implementRealId,
			error: "SpawnOptions.cwd must be an absolute path",
			status: "error",
		});

		// task must be reverted to pending with lastError metadata
		const after = h.store.get(implement.id);
		expect(after?.status).toBe("pending");
		expect(after?.metadata.lastError).toContain("absolute path");

		// workflow:phase-complete MUST be emitted with status: "failed" so
		// workflow_run can resolve as blocked instead of hanging
		const failed = h.events.emittedLog.filter(
			e => e.channel === "workflow:phase-complete" && (e.data as any).status === "failed",
		);
		expect(failed).toHaveLength(1);
		const ev = failed[0].data as Record<string, unknown>;
		expect(ev.phase).toBe("implement");
		expect(ev.task_id).toBe(implement.id);
		expect(ev.error).toContain("absolute path");

		// No additional spawns after the failed Implement — workflow_run will
		// resolve as blocked from the phase-complete event
		expect(h.primarySpawnCalls()).toHaveLength(1); // only the initial Implement spawn
	});

	test("subagents:failed for a non-workflow id is ignored (not a regression on the ad-hoc path)", async () => {
		const h = setupWithRealIds();
		await h.fire("workflow:start", startPayload);

		const initialPhaseCompleteCount = h.events.emittedLog.filter(
			e => e.channel === "workflow:phase-complete",
		).length;

		// A non-workflow agent id (no agentToTask entry) — must NOT emit
		// workflow:phase-complete and must NOT crash.
		await h.fire("subagents:failed", {
			id: "ghost-agent",
			error: "boom",
			status: "error",
		});

		const finalCount = h.events.emittedLog.filter(
			e => e.channel === "workflow:phase-complete",
		).length;
		expect(finalCount).toBe(initialPhaseCompleteCount);
	});

	test("real-id cascade: full Implement → Review_1 → Review_2 → Review_3 → Merge (all CLEAN, 5 spawns)", async () => {
		// GC-2026-verdict-states-and-dynamic-cascade: with all-CLEAN path
		// only 5 tasks are spawned (Implement + 3 Reviews + Merge). Fix
		// tasks are NEVER created.
		const h = setupWithRealIds();
		await h.fire("workflow:start", startPayload);

		const drive = async (phase: string, iteration: number | undefined, verdict?: "CLEAN" | "NEEDS_WORK") => {
			// Filter to primary tasks (not advisors): the advisor has the
			// same phase metadata so a plain .find() can return the wrong
			// row when both primary and advisor exist.
			const t = h.store.list().find(x =>
				!x.metadata.advisorOf &&
				x.metadata.phase === phase &&
				(iteration === undefined || x.metadata.iteration === iteration),
			)!;
			const id = h.realIds.get(t.id);
			expect(id).toBeDefined();
			const result = verdict
				? `\`\`\`yaml\nverdict: ${verdict}\nfindings: []\n\`\`\``
				: "ok";
			await h.fire("subagents:completed", { id, result });
		};

		await drive("implement", undefined);
		await drive("review", 1, "CLEAN");
		await drive("review", 2, "CLEAN");
		await drive("review", 3, "CLEAN");

		// After Review_3 CLEAN, Merge should be the last spawned phase.
		const last = h.primarySpawnCalls()[h.primarySpawnCalls().length - 1];
		expect(last.subject).toBe(`Merge: ${goal.title}`);

		// Only 5 spawns total (no Fixes for all-CLEAN path).
		expect(h.primarySpawnCalls()).toHaveLength(5);

		// 5 tasks completed after Merge runs.
		await drive("merge", undefined);
		const completed = h.store.list().filter(t => t.status === "completed");
		expect(completed).toHaveLength(5);
	});

	test("real-id cascade: Implement → Review_1 (NEEDS_WORK) → Fix_1 → Review_2 (NEEDS_WORK) → Fix_2 → Review_3 (CLEAN) → Merge (7 spawns)", async () => {
		const h = setupWithRealIds();
		await h.fire("workflow:start", startPayload);

		const drive = async (phase: string, iteration: number | undefined, verdict?: "CLEAN" | "NEEDS_WORK") => {
			const t = h.store.list().find(x =>
				!x.metadata.advisorOf &&
				x.metadata.phase === phase &&
				(iteration === undefined || x.metadata.iteration === iteration),
			)!;
			const id = h.realIds.get(t.id);
			expect(id).toBeDefined();
			const result = verdict
				? `\`\`\`yaml\nverdict: ${verdict}\nfindings: []\n\`\`\``
				: "ok";
			await h.fire("subagents:completed", { id, result });
		};

		await drive("implement", undefined);
		await drive("review", 1, "NEEDS_WORK"); // → Fix_1 spawned dynamically
		await drive("fix", 1);
		await drive("review", 2, "NEEDS_WORK"); // → Fix_2 spawned dynamically
		await drive("fix", 2);
		await drive("review", 3, "CLEAN"); // → Merge spawned
		await drive("merge", undefined);

		expect(h.primarySpawnCalls()).toHaveLength(7);
		const completed = h.store.list().filter(t => t.status === "completed");
		expect(completed).toHaveLength(7);
	});
});
