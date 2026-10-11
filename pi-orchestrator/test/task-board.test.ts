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

// Suppress unused-var lint — scratch is intentionally retained for
// readability (each beforeEach creates one).
void rmSync;