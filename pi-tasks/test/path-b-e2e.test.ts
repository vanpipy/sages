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

		// Drive the full pipeline (single iteration for speed)
		const order = [
			{ phase: "implement", verdict: "" },
			{ phase: "review", iteration: 1, verdict: "CLEAN" },
			{ phase: "merge", verdict: "" },
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
		expect(completed).toHaveLength(3); // implement, review, merge (no fix because CLEAN)

		const phaseCompleteEvents = h.events.emittedLog.filter(e => e.channel === "workflow:phase-complete");
		expect(phaseCompleteEvents).toHaveLength(3);
		expect(phaseCompleteEvents.map(e => (e.data as Record<string, unknown>).phase)).toEqual([
			"implement",
			"review",
			"merge",
		]);
		// The review event should carry verdict
		const reviewEvent = phaseCompleteEvents.find(e => (e.data as Record<string, unknown>).phase === "review");
		expect((reviewEvent!.data as Record<string, unknown>).verdict).toBe("CLEAN");
	});
});
