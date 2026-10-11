/**
 * task-board.test.ts — Unit tests for the TaskBoard domain class.
 *
 * `TaskBoard` composes `TaskStore` and owns the orchestrator's
 * sole-creator / sole-consumer role. Tests cover the verdict-parsing
 * helpers (the part with the most logic) and the basic shape of
 * `materializePlan` / `consume` against a stub in-memory TaskStore
 * (the same `TasksStoreLike` shape the orchestrator-tool tests use,
 * but here we go through the real `TaskStore` class so the lock +
 * round-trip path is exercised).
 */

import { describe, expect, it, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskBoard, TaskBoardConsumeError, type Verdict } from "../src/task-board.js";
import { TaskStore } from "@sages/pi-tasks/task-store";

describe("TaskBoard.parseVerdict", () => {
	it("extracts a bare CLEAN token on its own line", () => {
		// The Reviewer's standard output ends with the verdict on a line by
		// itself. Multi-line agent output is the norm.
		const board = new TaskBoard({ cwd: "/tmp/no-store" });
		expect(board.parseVerdict("All checks pass.\nCLEAN\n")).toBe("CLEAN");
		expect(board.parseVerdict("CLEAN")).toBe("CLEAN");
	});

	it("extracts NEEDS_WORK from a `verdict: NEEDS_WORK` line", () => {
		const board = new TaskBoard({ cwd: "/tmp/no-store" });
		expect(board.parseVerdict("Issue in tests.\nverdict: NEEDS_WORK\n")).toBe("NEEDS_WORK");
	});

	it("accepts `Verdict =` and other separators", () => {
		const board = new TaskBoard({ cwd: "/tmp/no-store" });
		expect(board.parseVerdict("Verdict = NEEDS_REDESIGN")).toBe("NEEDS_REDESIGN");
		expect(board.parseVerdict("verdict:NEEDS_CLARIFICATION")).toBe("NEEDS_CLARIFICATION");
	});

	it("is case-insensitive on the verdict token (prefixed form)", () => {
		const board = new TaskBoard({ cwd: "/tmp/no-store" });
		expect(board.parseVerdict("verdict: clean")).toBe("CLEAN");
		expect(board.parseVerdict("VERDICT: needs_work")).toBe("NEEDS_WORK");
	});

	it("returns undefined when no verdict token appears", () => {
		const board = new TaskBoard({ cwd: "/tmp/no-store" });
		expect(board.parseVerdict("The code looks good to me.")).toBeUndefined();
		expect(board.parseVerdict("")).toBeUndefined();
	});

	it("does not match verdict-like words that are not in the 4-state set", () => {
		// Defensive: NEARLY, UNSURE, FAIL etc. are not in the set.
		const board = new TaskBoard({ cwd: "/tmp/no-store" });
		expect(board.parseVerdict("verdict: NEARLY")).toBeUndefined();
		expect(board.parseVerdict("verdict: UNSURE")).toBeUndefined();
	});

	it("does not false-match on prose that mentions the words", () => {
		// 'clean' / 'work' as English words mid-line — the `verdict:` prefix
		// anchor AND the standalone-line anchor keep this from matching.
		const board = new TaskBoard({ cwd: "/tmp/no-store" });
		expect(board.parseVerdict("Let me clean up the code.")).toBeUndefined();
		expect(board.parseVerdict("The code is clean.")).toBeUndefined();
		expect(board.parseVerdict("Let me work on this.")).toBeUndefined();
	});
});

describe("TaskBoard.suggestFollowUp", () => {
	const verdicts: Verdict[] = [
		"CLEAN",
		"NEEDS_WORK",
		"NEEDS_REDESIGN",
		"NEEDS_CLARIFICATION",
	];

	it("returns a non-empty hint for every verdict in the 4-state set", () => {
		const board = new TaskBoard({ cwd: "/tmp/no-store" });
		for (const v of verdicts) {
			const hint = board.suggestFollowUp(v);
			expect(typeof hint).toBe("string");
			expect(hint.length).toBeGreaterThan(0);
		}
	});

	it("CLEAN hints at moving on, not at spawning follow-up work", () => {
		const board = new TaskBoard({ cwd: "/tmp/no-store" });
		const hint = board.suggestFollowUp("CLEAN");
		expect(hint.toLowerCase()).toContain("complete");
		expect(hint.toLowerCase()).not.toContain("follow-up task");
	});

	it("NEEDS_WORK hints at a Developer follow-up, with a blockedBy hint", () => {
		const board = new TaskBoard({ cwd: "/tmp/no-store" });
		const hint = board.suggestFollowUp("NEEDS_WORK");
		expect(hint.toLowerCase()).toContain("developer");
		expect(hint.toLowerCase()).toContain("blockedby");
	});

	it("NEEDS_REDESIGN hints at a new Implement task rather than a fix", () => {
		const board = new TaskBoard({ cwd: "/tmp/no-store" });
		const hint = board.suggestFollowUp("NEEDS_REDESIGN");
		expect(hint.toLowerCase()).toContain("implement");
		expect(hint.toLowerCase()).not.toContain("developer");
	});

	it("NEEDS_CLARIFICATION hints at pausing for the user", () => {
		const board = new TaskBoard({ cwd: "/tmp/no-store" });
		const hint = board.suggestFollowUp("NEEDS_CLARIFICATION");
		expect(hint.toLowerCase()).toContain("pause");
		expect(hint.toLowerCase()).toContain("user");
	});
});

describe("TaskBoard.materializePlan", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-task-board-"));
	});

	// Clean up scratch dirs at the end of each test by collecting them
	// in an afterEach — for brevity we just rely on tmpdir cleanup.
	// Bun's test runner runs in a single process so explicit cleanup
	// isn't required for correctness, just tidiness.

	it("creates one task per phase and wires blockedBy in both directions", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const board = new TaskBoard({ cwd: scratch, store });

		const out = board.materializePlan({
			intent: "Add feature X",
			phases: [
				{ subject: "Implement", agentType: "Developer" },
				{ subject: "Review", agentType: "Reviewer", blockedBy: ["Implement"] },
			],
		});

		expect(out.intent).toBe("Add feature X");
		expect(out.tasks).toHaveLength(2);

		const implement = out.tasks.find((t) => t.subject === "Implement")!;
		const review = out.tasks.find((t) => t.subject === "Review")!;
		expect(implement.agentType).toBe("Developer");
		expect(review.agentType).toBe("Reviewer");
		expect(implement.blockedBy).toEqual([]);
		expect(review.blockedBy).toEqual([implement.id]);
		// Bidirectional: the Implement task's `blocks` includes the Review.
		expect(implement.blocks).toEqual([review.id]);
		// And the Review task's `blocks` is empty (it's a leaf).
		expect(review.blocks).toEqual([]);
	});

	it("starts every task unblocked when no blockedBy is given", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const board = new TaskBoard({ cwd: scratch, store });

		const out = board.materializePlan({
			intent: "free",
			phases: [
				{ subject: "A", agentType: "Developer" },
				{ subject: "B", agentType: "Developer" },
			],
		});

		expect(out.tasks.every((t) => t.blockedBy.length === 0)).toBe(true);
	});

	it("wires a multi-edge dependency chain", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const board = new TaskBoard({ cwd: scratch, store });

		const out = board.materializePlan({
			intent: "4-phase pipeline",
			phases: [
				{ subject: "Implement", agentType: "Developer" },
				{ subject: "Review", agentType: "Reviewer", blockedBy: ["Implement"] },
				{ subject: "Fix", agentType: "Developer", blockedBy: ["Review"] },
				{ subject: "Merge", agentType: "Reviewer", blockedBy: ["Fix"] },
			],
		});

		const [implement, review, fix, merge] = out.tasks;
		expect(review.blockedBy).toEqual([implement.id]);
		expect(fix.blockedBy).toEqual([review.id]);
		expect(merge.blockedBy).toEqual([fix.id]);
		// Reverse edges: predecessor.blocks includes the dependent.
		expect(implement.blocks).toEqual([review.id]);
		expect(review.blocks).toEqual([fix.id]);
		expect(fix.blocks).toEqual([merge.id]);
		expect(merge.blocks).toEqual([]);
	});

	it("silently drops references to non-existent subjects", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const board = new TaskBoard({ cwd: scratch, store });

		const out = board.materializePlan({
			intent: "phantom dep",
			phases: [
				{ subject: "A", agentType: "Developer" },
				{
					subject: "B",
					agentType: "Developer",
					blockedBy: ["DoesNotExist", "A"],
				},
			],
		});

		const [, b] = out.tasks;
		// B depends only on A (the missing subject is dropped).
		expect(b?.blockedBy).toEqual([out.tasks[0].id]);
	});

	it("defaults each phase's detail to intent when omitted", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const board = new TaskBoard({ cwd: scratch, store });

		board.materializePlan({
			intent: "this becomes the detail of every phase",
			phases: [
				{ subject: "A", agentType: "Developer" },
				{ subject: "B", agentType: "Developer" },
			],
		});

		// detail defaults to intent — visible via `store.get(id).description`.
		const tasks = [store.get("1"), store.get("2")];
		for (const t of tasks) {
			expect(t?.description).toBe("this becomes the detail of every phase");
		}
	});
});

describe("TaskBoard.consume", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-task-board-"));
	});

	it("returns a structured payload with verdict + follow-up for a CLEAN Reviewer", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const review = store.create(
			"Review",
			"audit the implementation",
			undefined,
			{ agentType: "Reviewer" },
		);
		store.update(review.id, {
			status: "completed",
			metadata: { result: "Looks good.\nverdict: CLEAN\n" },
		});

		const board = new TaskBoard({ cwd: scratch, store });
		const out = board.consume(review.id);
		expect(out.verdict).toBe("CLEAN");
		expect(out.follow_up_suggestion).toBeDefined();
		expect(out.consumed_at).toBeGreaterThan(0);

		// Audit trail: the metadata records the consume.
		const after = store.get(review.id)!;
		expect(after.metadata?.consumed).toBe(true);
		expect(after.metadata?.consumed_at).toBe(out.consumed_at);
	});

	it("throws TaskBoardConsumeError('not_found') for an unknown task id", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const board = new TaskBoard({ cwd: scratch, store });
		expect(() => board.consume("999")).toThrow(TaskBoardConsumeError);
		try {
			board.consume("999");
		} catch (err) {
			expect(err).toBeInstanceOf(TaskBoardConsumeError);
			expect((err as TaskBoardConsumeError).kind).toBe("not_found");
		}
	});

	it("throws TaskBoardConsumeError('not_completed') for a still-running task", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const t = store.create("Run me", "do the thing");
		// status stays 'pending'; consume() will refuse.
		const board = new TaskBoard({ cwd: scratch, store });
		expect(() => board.consume(t.id)).toThrow(TaskBoardConsumeError);
		try {
			board.consume(t.id);
		} catch (err) {
			expect((err as TaskBoardConsumeError).kind).toBe("not_completed");
		}
	});

	it("does not parse a verdict for a Developer task", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const t = store.create(
			"Implement",
			"write the code",
			undefined,
			{ agentType: "Developer" },
		);
		store.update(t.id, {
			status: "completed",
			metadata: { result: "Done. Cleaned up everything." },
		});
		const board = new TaskBoard({ cwd: scratch, store });
		const out = board.consume(t.id);
		expect(out.verdict).toBeUndefined();
		expect(out.follow_up_suggestion).toBeUndefined();
		expect(out.result).toContain("Cleaned up");
	});
});

describe("TaskBoard end-to-end — the Task Feeding loop", () => {
	let scratch: string;

	beforeEach(() => {
		scratch = mkdtempSync(join(tmpdir(), "pi-orch-task-board-"));
	});

	/**
	 * Walk the full orchestrator loop on a real `TaskStore`:
	 *
	 *   1. CREATE  — `board.materializePlan({...})` writes the DAG
	 *   2. SIMULATE — a subagent runs Implement, completes it (the
	 *      orchestrator's `subagents:completed` listener would do this
	 *      in production; here we do it directly via the injected store
	 *      to keep pi's RPC stack out of the test)
	 *   3. CONSUME  — `board.consume(implement_id)` reads the result
	 *   4. SIMULATE — Reviewer runs Review, completes with `verdict: CLEAN`
	 *   5. CONSUME  — `board.consume(review_id)` extracts the verdict
	 *      and emits a verdict-tailored follow-up suggestion
	 *   6. VERIFY   — the task is marked consumed in metadata for
	 *      the audit trail
	 */
	it("create -> simulate -> consume loops through Implement + Review with a CLEAN verdict", () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const board = new TaskBoard({ cwd: scratch, store });

		// 1. CREATE
		const plan = board.materializePlan({
			intent: "Add login feature",
			phases: [
				{ subject: "Implement", agentType: "Developer" },
				{ subject: "Review", agentType: "Reviewer", blockedBy: ["Implement"] },
			],
		});
		expect(plan.tasks).toHaveLength(2);
		const implement = plan.tasks.find((t) => t.subject === "Implement")!;
		const review = plan.tasks.find((t) => t.subject === "Review")!;
		expect(implement.agentType).toBe("Developer");
		expect(review.agentType).toBe("Reviewer");
		expect(review.blockedBy).toEqual([implement.id]);
		expect(implement.blocks).toEqual([review.id]);

		// 2. SIMULATE executor running Implement
		store.update(implement.id, {
			status: "completed",
			metadata: { result: "Added POST /login with bcrypt + JWT. All unit tests pass." },
		});

		// 3. CONSUME Implement result — no verdict (Developer)
		const implOut = board.consume(implement.id);
		expect(implOut.id).toBe(implement.id);
		expect(implOut.result).toContain("All unit tests pass");
		expect(implOut.verdict).toBeUndefined();
		expect(implOut.follow_up_suggestion).toBeUndefined();
		expect(implOut.consumed_at).toBeGreaterThan(0);

		// 4. SIMULATE executor running Review (Reviewer emits verdict)
		store.update(review.id, {
			status: "completed",
			metadata: {
				result: [
					"Read every file. The implementation is solid.",
					"",
					"verdict: CLEAN",
				].join("\n"),
			},
		});

		// 5. CONSUME Review — verifier extracts CLEAN + suggestion
		const reviewOut = board.consume(review.id);
		expect(reviewOut.verdict).toBe("CLEAN");
		expect(reviewOut.follow_up_suggestion).toMatch(/phase complete|move on/i);
		// consumed_at is a wall-clock ms — back-to-back consume() calls can
		// land in the same millisecond, so accept >= rather than >.
		expect(reviewOut.consumed_at).toBeGreaterThanOrEqual(implOut.consumed_at);

		// 6. AUDIT TRAIL — consumed flag set on the review task
		const persistedReview = store.get(review.id)!;
		expect(persistedReview.metadata?.consumed).toBe(true);
		expect(persistedReview.metadata?.consumed_at).toBe(reviewOut.consumed_at);

		// 7. RAW ACCESS — `list()` still surfaces the consumed/audit tasks
		const all = board.list();
		expect(all).toHaveLength(2);
		expect(all.find((t) => t.id === review.id)?.metadata?.consumed).toBe(true);
	});

	it("drain() consumes 10 tasks in order; awaitNextConsumable() waits for the next one", async () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const board = new TaskBoard({ cwd: scratch, store });

		// 1. CREATE — materialize a 10-phase plan.
		const plan = board.materializePlan({
			intent: "10-task flow",
			phases: Array.from({ length: 10 }, (_, i) => ({
				subject: `T${i + 1}`,
				agentType: "Developer" as const,
			})),
		});
		expect(plan.tasks).toHaveLength(10);

		// 2. SIMULATE — all 10 tasks complete (executors can run in parallel).
		for (const t of plan.tasks) {
			store.update(t.id, {
				status: "completed",
				metadata: { result: `result for ${t.subject}` },
			});
		}

		// 3. DRAIN — the orchestrator's consumer loop picks up all 10.
		const drained = board.drain();
		expect(drained).toHaveLength(10);
		// FIFO by id ascending.
		expect(drained.map((d) => d.subject)).toEqual([
			"T1",
			"T2",
			"T3",
			"T4",
			"T5",
			"T6",
			"T7",
			"T8",
			"T9",
			"T10",
		]);
		// Each carries its own metadata + consumed_at.
		for (const out of drained) {
			expect(out.consumed_at).toBeGreaterThan(0);
			expect(out.status).toBe("completed");
			expect(out.result).toMatch(/^result for T\d+$/);
		}

		// 4. AUDIT — every task on the board is now `consumed`.
		const all = board.list();
		expect(all).toHaveLength(10);
		expect(all.every((t) => t.metadata?.consumed === true)).toBe(true);
		// Every consumed_at matches the corresponding drain entry.
		const consumedAtById = new Map(drained.map((d) => [d.id, d.consumed_at]));
		for (const t of all) {
			expect(t.metadata?.consumed_at).toBe(consumedAtById.get(t.id));
		}

		// 5. DRAIN AGAIN — empty: nothing left to consume.
		const drainedAgain = board.drain();
		expect(drainedAgain).toHaveLength(0);

		// 6. LISTEN — schedule a new completion, then await it.
		// This is the orchestrator's post-drain state: the consumer loop
		// gives up busy-polling and waits for the next completion event.
		setTimeout(() => {
			const late = store.create("LateArrival", "do the late thing");
			store.update(late.id, {
				status: "completed",
				metadata: { result: "I'm late" },
			});
		}, 150);

		const next = await board.awaitNextConsumable({
			timeoutMs: 5_000,
			pollIntervalMs: 50,
		});
		expect(next).toBeDefined();
		expect(next?.subject).toBe("LateArrival");

		// 7. CONSUME the late arrival — the loop continues.
		const lateOut = board.consume(next!.id);
		expect(lateOut.subject).toBe("LateArrival");
		expect(lateOut.result).toBe("I'm late");

		// 8. After consume, awaitNextConsumable would block again. Verify
		// with a short timeout that no new task arrives.
		const empty = await board.awaitNextConsumable({
			timeoutMs: 200,
			pollIntervalMs: 50,
		});
		expect(empty).toBeUndefined();
	});

	it("starts from an empty board, a single new task is created and consumed", async () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const board = new TaskBoard({ cwd: scratch, store });

		// 1. INITIAL STATE — empty board. The orchestrator's consumer
		// loop is in its listen phase: drain returns nothing,
		// findNextConsumable returns undefined.
		expect(board.list()).toHaveLength(0);
		expect(board.findNextConsumable()).toBeUndefined();
		expect(board.drain()).toHaveLength(0);

		// 2. NEW TASK ARRIVES — a single follow-up or ad-hoc task is
		// created (e.g. the LLM spawns a NEEDS_WORK Developer task after
		// a Reviewer verdict, or a brainstorming hand-off materializes a
		// single ad-hoc task outside a full plan).
		const created = board.create({
			subject: "Single new task",
			description: "the only task on the board",
			agentType: "Developer",
		});
		expect(board.list()).toHaveLength(1);
		expect(board.list()[0].id).toBe(created.id);
		// Created in `pending` — not consumable yet.
		expect(board.findNextConsumable()).toBeUndefined();

		// 3. EXECUTOR COMPLETES — the simulated subagent marks the task
		// completed with a result.
		store.update(created.id, {
			status: "completed",
			metadata: { result: "Done. Tests pass." },
		});

		// 4. ORCHESTRATOR WAKES UP — the next findNextConsumable() picks
		// up the new arrival. Drain consumes it in one go.
		const next = board.findNextConsumable();
		expect(next).toBeDefined();
		expect(next?.id).toBe(created.id);
		expect(next?.subject).toBe("Single new task");

		const drained = board.drain();
		expect(drained).toHaveLength(1);
		expect(drained[0].id).toBe(created.id);
		expect(drained[0].result).toBe("Done. Tests pass.");
		// Developer path: no verdict, no follow-up suggestion.
		expect(drained[0].verdict).toBeUndefined();
		expect(drained[0].follow_up_suggestion).toBeUndefined();

		// 5. AUDIT — the new task is now `consumed`.
		const after = store.get(created.id)!;
		expect(after.metadata?.consumed).toBe(true);
		expect(after.metadata?.consumed_at).toBe(drained[0].consumed_at);

		// 6. BOARD IS EMPTY AGAIN — second drain returns nothing, the
		// orchestrator is back to listening.
		expect(board.drain()).toHaveLength(0);
		expect(board.findNextConsumable()).toBeUndefined();
	});

	it("awaitNextConsumable picks up a single new arrival on an empty board", async () => {
		const store = new TaskStore(join(scratch, "tasks.json"));
		const board = new TaskBoard({ cwd: scratch, store });
		expect(board.list()).toHaveLength(0);

		// Schedule a single task to appear 100ms from now. In production
		// this would be the LLM calling board.create() or the
		// brainstorming hand-off materializing a task; the orchestrator
		// is in its listening branch and should pick it up immediately.
		setTimeout(() => {
			const t = board.create({
				subject: "Late arrival",
				description: "the only task on the board",
				agentType: "Developer",
			});
			store.update(t.id, {
				status: "completed",
				metadata: { result: "Done late." },
			});
		}, 100);

		const next = await board.awaitNextConsumable({
			timeoutMs: 1_000,
			pollIntervalMs: 25,
		});
		expect(next).toBeDefined();
		expect(next?.subject).toBe("Late arrival");

		// Consume it and verify the audit trail.
		const out = board.consume(next!.id);
		expect(out.result).toBe("Done late.");
		expect(store.get(next!.id)?.metadata?.consumed).toBe(true);
	});
});

// Suppress unused-var lint — scratch is intentionally retained for
// readability (each beforeEach creates one).
void rmSync;