/**
 * path-b-e2e.test.ts — Integration test for path B's event-driven flow.
 *
 * Pinned scenarios (each "it" is one scenario):
 *
 *   1. workflow:start → 7 tasks created + Implement spawned
 *   2. Implement completes → Review_1 spawned
 *   3. Review_1 CLEAN → Fix_1 spawned (no-op commit path)
 *   4. Fix_1 completes → Review_2 spawned
 *   5. Review_2 NEEDS_WORK → Fix_2 spawned
 *   6. Review_3 CLEAN → Merge spawned (final)
 *   7. Merge completes → all 7 tasks in completed status, all 4 phases emitted workflow:phase-complete
 *
 * The test uses a fake event bus + a spy spawnAgent. It does NOT spin
 * up real subagents — the executing layer's behavior is mocked. This is
 * the integration seam between planning (workflow_run, tested
 * separately in pi-orchestrator) and tracking (subscribeWorkflow, here).
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import { subscribeWorkflow } from "../src/workflow-handler.js";
import { TaskStore } from "../src/task-store.js";
import type { Task } from "../src/types.js";

// ── Fake event bus ─────────────────────────────────────────────────────

type Handler = (data: unknown) => void | Promise<void>;

function fakeEvents() {
	const handlers = new Map<string, Set<Handler>>();
	const emittedLog: Array<{ channel: string; data: unknown }> = [];
	return {
		emittedLog,
		on(channel: string, handler: Handler) {
			if (!handlers.has(channel)) handlers.set(channel, new Set());
			handlers.get(channel)!.add(handler);
			return () => { handlers.get(channel)?.delete(handler); };
		},
		emit(channel: string, data: unknown) {
			emittedLog.push({ channel, data });
			return (async () => {
				for (const h of [...(handlers.get(channel) ?? [])]) await h(data);
			})();
		},
	};
}

// ── Test fixture ───────────────────────────────────────────────────────

const GOAL_ID = "GC-TEST-PATH-B";
const WORKFLOW_ID = `wf-${GOAL_ID}`;

const goal = {
	id: GOAL_ID,
	title: "Add rate limit",
	rationale: "Brute-force protection",
	scope: { include: ["src/auth/**"], exclude: ["dist/**"] },
	anti_goals: ["no new deps"],
	done_definition: "Login rate-limited",
};

interface Harness {
	store: TaskStore;
	events: ReturnType<typeof fakeEvents>;
	spy: { spawnCalls: Task[] };
	cleanup: () => void;
	fire: (channel: string, data: unknown) => Promise<void>;
}

function setup(): Harness {
	const store = new TaskStore(); // in-memory
	const events = fakeEvents();
	const spawnCalls: Task[] = [];
	const spy = { spawnCalls };

	const spawnAgent = vi.fn(async (task: Task) => {
		spawnCalls.push(task);
		// Mirror real spawnAgent: agent id encodes task id so the cascade test
		// can drive any phase by emitting subagents:completed with that id.
		return `agent-${task.id}`;
	});

	cleanup_placeholder: void cleanup_placeholder;

	const cleanup = subscribeWorkflow(store, {
		events: { on: events.on, emit: events.emit },
		spawnAgent,
	});

	return {
		store,
		events,
		spy,
		cleanup,
		fire: async (channel, data) => {
			await events.emit(channel, data);
			// Drain microtasks so all async handlers settle before assertions.
			await new Promise<void>(resolve => setImmediate(resolve));
		},
	};
}

// (label-only to satisfy lint; cleanup is a no-op placeholder reference)
let cleanup_placeholder: unknown;

beforeEach(() => {
	cleanup_placeholder = undefined;
});

const startPayload = {
	workflow_id: WORKFLOW_ID,
	goal_id: GOAL_ID,
	goal,
	max_fix_iterations: 3,
	worktree_path: "/tmp/wf",
};

// ── Tests ──────────────────────────────────────────────────────────────

describe("path B end-to-end (mocked subagents)", () => {
	test("workflow:start creates 7 tasks + spawns Implement", async () => {
		const h = setup();

		await h.fire("workflow:start", startPayload);

		const tasks = h.store.list();
		expect(tasks).toHaveLength(7);
		expect(h.spy.spawnCalls).toHaveLength(1);
		expect(h.spy.spawnCalls[0].metadata.phase).toBe("implement");
	});

	test("Implement completes → Review_1 spawned (cascade advances)", async () => {
		const h = setup();
		await h.fire("workflow:start", startPayload);

		const implement = h.store.list().find(t => t.metadata.phase === "implement")!;
		h.spy.spawnCalls.length = 0; // reset

		await h.fire("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });

		expect(h.spy.spawnCalls).toHaveLength(1);
		expect(h.spy.spawnCalls[0].subject).toMatch(/Review 1:/);
	});

	test("Review_1 CLEAN → Fix_1 spawned (cascade advances to fix loop)", async () => {
		const h = setup();
		await h.fire("workflow:start", startPayload);

		const implement = h.store.list().find(t => t.metadata.phase === "implement")!;
		await h.fire("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });

		const review1 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
		h.spy.spawnCalls.length = 0;

		await h.fire("subagents:completed", {
			id: `agent-${review1.id}`,
			result: "```yaml\nverdict: CLEAN\nfindings: []\n```",
		});

		expect(h.spy.spawnCalls).toHaveLength(1);
		expect(h.spy.spawnCalls[0].subject).toMatch(/Fix 1:/);
	});

	test("Review_2 NEEDS_WORK → Fix_2 spawned (cascade continues the loop)", async () => {
		const h = setup();
		await h.fire("workflow:start", startPayload);

		// Drive: Implement → Review_1 → Fix_1 → Review_2
		const all = h.store.list();
		const implement = all.find(t => t.metadata.phase === "implement")!;
		await h.fire("subagents:completed", { id: `agent-${implement.id}`, result: "ok" });

		const review1 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
		await h.fire("subagents:completed", {
			id: `agent-${review1.id}`,
			result: "```yaml\nverdict: CLEAN\nfindings: []\n```",
		});

		const fix1 = h.store.list().find(t => t.metadata.phase === "fix" && t.metadata.iteration === 1)!;
		await h.fire("subagents:completed", { id: `agent-${fix1.id}`, result: "ok" });

		const review2 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 2)!;
		h.spy.spawnCalls.length = 0;

		await h.fire("subagents:completed", {
			id: `agent-${review2.id}`,
			result: "```yaml\nverdict: NEEDS_WORK\nfindings:\n  - severity: major\n    issue: missing test\n```",
		});

		expect(h.spy.spawnCalls).toHaveLength(1);
		expect(h.spy.spawnCalls[0].subject).toMatch(/Fix 2:/);
	});

	test("Review_3 CLEAN → Merge spawned (cascade finalizes)", async () => {
		const h = setup();
		await h.fire("workflow:start", startPayload);

		// Drive through every iteration (Implement + 3 Reviews + 2 Fixes + Merge)
		const order: Array<{ phase: string; iteration?: number; verdict?: string }> = [
			{ phase: "implement" },
			{ phase: "review", iteration: 1, verdict: "CLEAN" },
			{ phase: "fix", iteration: 1 },
			{ phase: "review", iteration: 2, verdict: "CLEAN" },
			{ phase: "fix", iteration: 2 },
			{ phase: "review", iteration: 3, verdict: "CLEAN" },
		];
		for (const step of order) {
			const t = h.store.list().find(x =>
				x.metadata.phase === step.phase &&
				(step.iteration === undefined || x.metadata.iteration === step.iteration),
			)!;
			const result = step.verdict
				? `\`\`\`yaml\nverdict: ${step.verdict}\nfindings: []\n\`\`\``
				: "ok";
			await h.fire("subagents:completed", { id: `agent-${t.id}`, result });
		}

		// Merge should be the last spawn
		const last = h.spy.spawnCalls[h.spy.spawnCalls.length - 1];
		expect(last.subject).toBe(`Merge: ${goal.title}`);
	});

	test("Merge completes → all 7 tasks in completed status + every phase emitted workflow:phase-complete", async () => {
		const h = setup();
		await h.fire("workflow:start", startPayload);

		// Drive the full pipeline (Implement + 3 Reviews + 2 Fixes + Merge = 7).
		// GC-2026-pi-tasks-cascade-agentid: the previous version of this test
		// fired only 3 events and relied on the synthetic pre-registration
		// to make every "agent-N" id valid. With the cascade id fix the
		// handler only knows about agents it has actually spawned, so we
		// must drive the cascade through every step.
		const order = [
			{ phase: "implement" },
			{ phase: "review", iteration: 1, verdict: "CLEAN" },
			{ phase: "fix", iteration: 1 },
			{ phase: "review", iteration: 2, verdict: "CLEAN" },
			{ phase: "fix", iteration: 2 },
			{ phase: "review", iteration: 3, verdict: "CLEAN" },
			{ phase: "merge" },
		];
		for (const step of order) {
			const t = h.store.list().find(x =>
				x.metadata.phase === step.phase &&
				(step.iteration === undefined || x.metadata.iteration === step.iteration),
			)!;
			const result = step.verdict
				? `\`\`\`yaml\nverdict: ${step.verdict}\nfindings: []\n\`\`\``
				: "ok";
			await h.fire("subagents:completed", { id: `agent-${t.id}`, result });
		}

		const tasks = h.store.list();
		const completed = tasks.filter(t => t.status === "completed");
		expect(completed).toHaveLength(7);

		const phaseCompleteEvents = h.events.emittedLog.filter(e => e.channel === "workflow:phase-complete");
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
		for (const e of reviewEvents) {
			expect((e.data as Record<string, unknown>).verdict).toBe("CLEAN");
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

		return { store, events, spawnCalls, fire, cleanup };
	}

	test("cascade advances when subagents:completed carries the real-format id (no synthetic pre-registration match)", async () => {
		const h = setupWithRealIds();
		await h.fire("workflow:start", startPayload);

		const implement = h.store.list().find(t => t.metadata.phase === "implement")!;
		const implementRealId = realIds.get(implement.id);
		expect(implementRealId).toBeDefined();
		expect(implementRealId).not.toMatch(/^agent-\d+$/); // not the synthetic scheme

		h.spawnCalls.length = 0;

		// Send the REAL id back via subagents:completed — this is what
		// pi-subagents emits. With the buggy pre-registration, the handler
		// misses this lookup and the cascade stalls.
		await h.fire("subagents:completed", { id: implementRealId, result: "ok" });

		expect(h.spawnCalls).toHaveLength(1);
		expect(h.spawnCalls[0].subject).toMatch(/Review 1:/);

		const review1 = h.store.list().find(t => t.metadata.phase === "review" && t.metadata.iteration === 1)!;
		expect(review1.status).toBe("in_progress");
		expect(review1.owner).toBe(realIds.get(review1.id));
	});

	test("subagents:failed emits workflow:phase-complete with status: 'failed' and does not stall", async () => {
		const h = setupWithRealIds();
		await h.fire("workflow:start", startPayload);

		const implement = h.store.list().find(t => t.metadata.phase === "implement")!;
		const implementRealId = realIds.get(implement.id)!;

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
		expect(h.spawnCalls).toHaveLength(1); // only the initial Implement spawn
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

	test("real-id cascade: full Implement → Review_1 → Fix_1 → Review_2 → Fix_2 → Review_3 → Merge", async () => {
		const h = setupWithRealIds();
		await h.fire("workflow:start", startPayload);

		// Drive every phase using real ids from the spawn map.
		const drive = async (phase: string, iteration: number | undefined, verdict?: "CLEAN" | "NEEDS_WORK") => {
			const t = h.store.list().find(x =>
				x.metadata.phase === phase &&
				(iteration === undefined || x.metadata.iteration === iteration),
			)!;
			const id = realIds.get(t.id);
			expect(id).toBeDefined();
			const result = verdict
				? `\`\`\`yaml\nverdict: ${verdict}\nfindings: []\n\`\`\``
				: "ok";
			await h.fire("subagents:completed", { id, result });
		};

		await drive("implement", undefined, undefined);
		await drive("review", 1, "CLEAN");
		await drive("fix", 1, undefined);
		await drive("review", 2, "CLEAN");
		await drive("fix", 2, undefined);
		await drive("review", 3, "CLEAN");

		// After Review_3 CLEAN, Merge should be the last spawned phase.
		const last = h.spawnCalls[h.spawnCalls.length - 1];
		expect(last.subject).toMatch(/Merge:/);

		// All 7 tasks completed after Merge runs
		await drive("merge", undefined, undefined);
		const completed = h.store.list().filter(t => t.status === "completed");
		expect(completed).toHaveLength(7);
	});
});
