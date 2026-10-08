/**
 * workflow-run-integration-harness.ts — Shared harness for workflow_run
 * integration tests (R-INT for GC-2026-102 + B6/B7 for GC-2026-103).
 *
 * Wraps:
 *   - fake pi.events bus with synchronous dispatch + emit history
 *   - real-id subagent mock (randomUUID().slice(0,17), production shape)
 *   - real pi-tasks subscribeWorkflow + TaskStore
 *   - real workflow-run.ts executeWorkflowRun
 *
 * The unit tests in `workflow-run.test.ts` use synthetic agent ids and
 * a re-implemented local subscribeWorkflow — they catch orchestrator-
 * internal bugs but not cascade-contract bugs. This harness is the
 * regression-prevention layer for the real production wiring.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { subscribeWorkflow } from "@sages/pi-tasks/workflow-handler";
import { TaskStore } from "@sages/pi-tasks/task-store";
import type { Task } from "@sages/pi-tasks/types";

import { executeWorkflowRun } from "../../src/workflow-run.js";

/** Yield to the microtask queue so the async cascade can drain. */
export function flush(): Promise<void> {
	return new Promise<void>((r) => setImmediate(r));
}

/** Clean verdict result for driving Review → Review → ... → Merge cascades. */
export const cleanReviewResult = (iteration: number) =>
	"```yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\niteration: " + iteration + "\n```\n";

/**
 * NEEDS_WORK verdict result for driving Review → Fix → Review → ... cascades.
 * Each finding must have a category (regression | unresolved | new) so the
 * downstream Review can classify it.
 *
 * The result wraps a proper ```yaml ... ``` fence — the parser
 * (`pi-tasks/src/verdict-parser.ts`) looks for the LAST ```yaml fence and the
 * closing ```, so a missing close fence causes the parser to fall back to
 * NEEDS_WORK with empty findings. Always close the fence.
 */
export const needsWorkReviewResult = (iteration: number, opts: {
	findings: Array<{ severity: "minor" | "major" | "critical"; issue: string; category?: "regression" | "unresolved" | "new" }>;
}) =>
	"```yaml\nverdict: NEEDS_WORK\nfindings:\n" +
	opts.findings
		.map((f) => `  - severity: ${f.severity}\n    issue: ${f.issue}${f.category ? `\n    category: ${f.category}` : ""}`)
		.join("\n") +
	`\nscope_check: pass\nanti_goal_check: pass\niteration: ${iteration}\n` +
	"```";

/**
 * Minimal pi.events bus with synchronous dispatch + emit history.
 * Tracks every emitted channel + data so the test can inspect what
 * workflow_run and pi-tasks communicated.
 */
export function makeFakeEvents() {
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

export type FakeEvents = ReturnType<typeof makeFakeEvents>;

/**
 * Mock the @tintinweb/pi-subagents RPC surface with REAL-format ids
 * (randomUUID().slice(0,17), the production shape). Records every
 * spawned agent's id so the test can fire subagents:completed for
 * each one when driving the cascade.
 */
export function installRealIdSubagentsMock(events: FakeEvents) {
	const spawned = new Map<string, { id: string; type: string }>();
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

/**
 * Build a fresh test repo + harness:
 *   - creates a tmp repo dir with `.pi/orchestrator/goal-{GOAL_ID}.yaml`
 *   - wires pi-tasks's REAL subscribeWorkflow to the harness's pi.events
 *   - returns `pi`, `store`, `subagents`, `cleanup`, `repoCwd`
 *
 * Cleanup is the worktree's responsibility — call `harness.cleanup()` in
 * afterEach (it unsubscribes the workflow handler).
 */
export function makeWorkflowRunHarness() {
	const repoCwd = mkdtempSync(join(tmpdir(), "wf-int-"));
	mkdirSync(join(repoCwd, ".pi", "orchestrator"), { recursive: true });
	const pi = { events: makeFakeEvents() };
	const store = new TaskStore();
	const subagents = installRealIdSubagentsMock(pi.events);

	// GC-2026-114 FU3: subscribeWorkflow no longer takes a `spawnAgent`
	// callback. It now takes a `feed: { maybeAutoSpawn }` + a shared
	// `agentTaskMap`. The mock `feed.maybeAutoSpawn` performs the actual
	// subagents:rpc:spawn RPC and populates agentTaskMap (mirroring the
	// production feeder's behavior).
	const agentTaskMap = new Map<string, string>();
	const feed = {
		maybeAutoSpawn: async (task: Task) => {
			const requestId = randomUUID();
			const replyChannel = `subagents:rpc:spawn:reply:${requestId}`;
			const resultP = new Promise<{ id: string }>((resolve, reject) => {
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

	return { pi, store, subagents, cleanup, repoCwd };
}

/**
 * Helper: write a goal-{GOAL_ID}.yaml into a test repo.
 */
export function writeGoalYaml(repoCwd: string, goalId: string) {
	writeFileSync(
		join(repoCwd, ".pi", "orchestrator", `goal-${goalId}.yaml`),
		[
			`id: ${goalId}`,
			`title: Integration test goal`,
			`rationale: verification`,
			`scope:`,
			`  include: ["src/**"]`,
			`  exclude: ["dist/**"]`,
			`anti_goals: ["no new deps"]`,
			`done_definition: tests pass`,
		].join("\n"),
		"utf-8",
	);
}

/**
 * Run an `executeWorkflowRun` against the harness's pi.events. Returns
 * the promise so the caller can drive the cascade via
 * `harness.subagents.completeNext()` / `completeByIndex()`.
 */
export function startWorkflowRun(
	harness: ReturnType<typeof makeWorkflowRunHarness>,
	goalId: string,
	options: { max_fix_iterations?: number; clarification_answer?: string } = {},
) {
	const repoCwd = harness.repoCwd;
	writeGoalYaml(repoCwd, goalId);
	// Drain subagents:ready so pi-tasks can finish its initial setup.
	void harness.pi.events.emit("subagents:ready", {});
	return executeWorkflowRun(
		{
			goal_path: `.pi/orchestrator/goal-${goalId}.yaml`,
			options,
		},
		{
			pi: harness.pi,
			ctx: {},
			repoCwd,
		},
	);
}

/**
 * Clean up the test harness — call in `afterEach`.
 */
export function cleanupHarness(harness: ReturnType<typeof makeWorkflowRunHarness>) {
	if (harness) harness.cleanup();
	if (harness.repoCwd) rmSync(harness.repoCwd, { recursive: true, force: true });
}
