/**
 * workflow-graph.test.ts — Unit tests for `buildStaticWorkflowGraph`.
 *
 * The static graph is the heart of path B's tracking layer:
 *   - GC-2026-verdict-states-and-dynamic-cascade: Implement + max_fix_iterations
 *     Reviews + Merge = (max_fix_iterations + 2) tasks. Fix tasks are NOT
 *     pre-created — the workflow handler creates them on demand when a
 *     Review emits NEEDS_WORK (capped by max_fix_iterations).
 *   - max_fix_iterations controls how many Review phases exist.
 *   - Every task gets `metadata.workflow_run_goal_id` + `metadata.phase`
 *   - `blocks` / `blockedBy` use placeholder IDs (`__implement__`,
 *     `__review_1__`, …, `__merge__`) which the workflow handler resolves
 *     to real task IDs after TaskCreate returns.
 *
 * Scope: this file tests the pure function only. The event-driven handler
 * (`workflow-handler.test.ts`) covers the placeholder→ID resolution step +
 * dynamic Fix/Implement dispatch.
 */

import { describe, expect, test } from "vitest";
import {
	buildFixTaskSpec,
	buildRedesignImplementTaskSpec,
	buildStaticWorkflowGraph,
	type WorkflowGraphInput,
} from "../src/workflow-graph.js";

const baseGoal = {
	id: "GC-TEST-001",
	title: "Add login rate limit",
	rationale: "Brute-force protection",
	scope: { include: ["src/auth/**"], exclude: ["src/admin/**"] },
	anti_goals: ["No new deps"],
	done_definition: "Login is rate-limited after 5 attempts/min",
};

// GC-2026-workflow-worktree-namespace: worktreePath + branch are now REQUIRED
// parameters threaded in from the planning layer (workflow-run.ts emits them
// in workflow:start payload). Removing the hardcoded `process.cwd()` and
// `${goal.id.toLowerCase()}-implement` defaults is the whole point of this GC.
function input(max_fix_iterations = 3): WorkflowGraphInput {
	return {
		goal: baseGoal,
		max_fix_iterations,
		workflow_run_goal_id: "GC-TEST-001",
		worktreePath: "/repo/.pi/worktree/GC-TEST-001/implement",
		branch: "gc-test-001-implement",
	};
}

describe("buildStaticWorkflowGraph", () => {
	test("happy path: max_fix_iterations=1 returns 3 tasks (Implement + Review_1 + Merge)", () => {
		const tasks = buildStaticWorkflowGraph(input(1));

		expect(tasks).toHaveLength(3);
		expect(tasks.map(t => t.subject)).toEqual([
			"Implement: Add login rate limit",
			"Review 1: Add login rate limit",
			"Merge: Add login rate limit",
		]);

		// Review_1 blockedBy Implement, blocks Merge
		expect(tasks[1].blockedBy).toEqual(["__implement__"]);
		expect(tasks[1].blocks).toEqual(["__merge__"]);

		// Merge blockedBy Implement + Review_1, no downstream
		expect(tasks[2].blockedBy).toEqual(["__implement__", "__review_1__"]);
		expect(tasks[2].blocks).toEqual([]);

		// Implement is the root — no upstream, only Review_1 downstream
		expect(tasks[0].blockedBy).toEqual([]);
		expect(tasks[0].blocks).toEqual(["__review_1__"]);
	});

	test("default max=3: 5 tasks (Implement + 3 Reviews + Merge) — Fix is NOT pre-created", () => {
		// GC-2026-verdict-states-and-dynamic-cascade: the static graph no
		// longer pre-creates Fix tasks. 5 tasks total (not 7 as before).
		const tasks = buildStaticWorkflowGraph(input(3));

		expect(tasks).toHaveLength(5);
		expect(tasks.map(t => t.subject)).toEqual([
			"Implement: Add login rate limit",
			"Review 1: Add login rate limit",
			"Review 2: Add login rate limit",
			"Review 3: Add login rate limit",
			"Merge: Add login rate limit",
		]);

		// No fix phase in the static graph.
		expect(tasks.find(t => t.metadata.phase === "fix")).toBeUndefined();

		// Implement → Review_1
		expect(tasks[0].blocks).toEqual(["__review_1__"]);
		// Review_1 → Review_2, Merge
		expect(tasks[1].blockedBy).toEqual(["__implement__"]);
		expect(tasks[1].blocks).toEqual(["__review_2__", "__merge__"]);
		// Review_2 → Review_3, Merge
		expect(tasks[2].blockedBy).toEqual(["__review_1__"]);
		expect(tasks[2].blocks).toEqual(["__review_3__", "__merge__"]);
		// Review_3 → Merge (last iteration ends at Merge)
		expect(tasks[3].blockedBy).toEqual(["__review_2__"]);
		expect(tasks[3].blocks).toEqual(["__merge__"]);
		// Merge: blockedBy all Reviews + Implement, nothing downstream
		expect(tasks[4].blockedBy).toEqual([
			"__implement__",
			"__review_1__",
			"__review_2__",
			"__review_3__",
		]);
		expect(tasks[4].blocks).toEqual([]);
	});

	test("metadata.workflow_run_goal_id and metadata.phase are stamped on every task", () => {
		const tasks = buildStaticWorkflowGraph(input(3));

		expect(tasks.every(t => t.metadata.workflow_run_goal_id === "GC-TEST-001")).toBe(true);
		expect(tasks.every(t => typeof t.metadata.phase === "string")).toBe(true);
		expect(tasks.every(t => typeof t.metadata.agentType === "string")).toBe(true);

		// Phase values are limited to implement / review / merge — no fix.
		const phases = new Set(tasks.map(t => t.metadata.phase));
		expect(phases).toEqual(new Set(["implement", "review", "merge"]));

		// Iteration is stamped on review tasks only (Fix tasks don't exist
		// in the static graph).
		const review = tasks.find(t => t.metadata.phase === "review");
		expect(review?.metadata.iteration).toBe(1);
	});

	// GC-2026-advisor-spec-integration: each phase spec carries the
	// advisorAgentType that workflow-handler's dispatchAdvisorForTask
	// hook reads to spawn the paired advisor sibling after the primary
	// finishes. The Merge spec is excluded because MergerAdvisor is the
	// primary itself, not paired with another advisor.
	test("every task spec carries advisorAgentType (except Merge)", () => {
		const tasks = buildStaticWorkflowGraph(input(3));
		for (const t of tasks) {
			if (t.metadata.phase === "merge") {
				expect(t.metadata.advisorAgentType).toBeUndefined();
				continue;
			}
			const expected: Record<string, string> = {
				implement: "DeveloperAdvisor",
				review: "ReviewerAdvisor",
			};
			const expectedAdvisor = expected[t.metadata.phase as string];
			expect(t.metadata.advisorAgentType).toBe(expectedAdvisor);
		}
	});

	test("Fix spec carries advisorAgentType: FixAdvisor (dynamic, in buildFixTaskSpec)", () => {
		const spec = buildFixTaskSpec({
			goal: baseGoal,
			iteration: 1,
			worktreePath: "/abs/worktree",
			branch: "gc-test-001-implement",
			reviewTaskId: "review-1",
			nextReviewId: "review-2",
			workflow_run_goal_id: "GC-TEST-001",
		});
		expect(spec.metadata.advisorAgentType).toBe("FixAdvisor");
	});

	test("every task has an agentType matching its phase", () => {
		const tasks = buildStaticWorkflowGraph(input(3));

		const byPhase: Record<string, string> = {
			implement: "Developer",
			review: "Reviewer",
			merge: "MergerAdvisor",
		};
		for (const t of tasks) {
			expect(t.metadata.agentType).toBe(byPhase[t.metadata.phase]);
		}
	});

	test("max_fix_iterations=2 returns 4 tasks (Implement + 2 Reviews + Merge)", () => {
		const tasks = buildStaticWorkflowGraph(input(2));

		expect(tasks).toHaveLength(4);
		expect(tasks.map(t => t.subject)).toEqual([
			"Implement: Add login rate limit",
			"Review 1: Add login rate limit",
			"Review 2: Add login rate limit",
			"Merge: Add login rate limit",
		]);

		// Review_2 is the last review
		expect(tasks[2].blockedBy).toEqual(["__review_1__"]);
		expect(tasks[2].blocks).toEqual(["__merge__"]);

		// Merge collects all
		expect(tasks[3].blockedBy).toEqual([
			"__implement__",
			"__review_1__",
			"__review_2__",
		]);
	});
});

describe("buildStaticWorkflowGraph — worktreePath + branch threading (GC-2026-workflow-worktree-namespace)", () => {
	const WT_PATH = "/repo/.pi/worktree/GC-TEST-001/implement";
	const BRANCH = "gc-test-001-implement";

	test("Implement description embeds the passed worktreePath + branch", () => {
		const tasks = buildStaticWorkflowGraph({
			goal: baseGoal,
			max_fix_iterations: 1,
			workflow_run_goal_id: "GC-TEST-001",
			worktreePath: WT_PATH,
			branch: BRANCH,
		});
		const implement = tasks.find(t => t.metadata.phase === "implement");
		expect(implement).toBeDefined();
		expect(implement!.description).toContain(WT_PATH);
		expect(implement!.description).toContain(BRANCH);
	});

	test("Review description embeds the passed worktreePath + branch", () => {
		const tasks = buildStaticWorkflowGraph({
			goal: baseGoal,
			max_fix_iterations: 2,
			workflow_run_goal_id: "GC-TEST-001",
			worktreePath: WT_PATH,
			branch: BRANCH,
		});
		const review = tasks.find(t => t.metadata.phase === "review");
		expect(review).toBeDefined();
		expect(review!.description).toContain(WT_PATH);
		expect(review!.description).toContain(BRANCH);
	});

	test("Merge description embeds the passed branch (and worktreePath)", () => {
		const tasks = buildStaticWorkflowGraph({
			goal: baseGoal,
			max_fix_iterations: 1,
			workflow_run_goal_id: "GC-TEST-001",
			worktreePath: WT_PATH,
			branch: BRANCH,
		});
		const merge = tasks.find(t => t.metadata.phase === "merge");
		expect(merge).toBeDefined();
		expect(merge!.description).toContain(BRANCH);
		expect(merge!.description).toContain(WT_PATH);
	});

	test("description does NOT embed process.cwd() (no caller-cwd leakage)", () => {
		const tasks = buildStaticWorkflowGraph({
			goal: baseGoal,
			max_fix_iterations: 1,
			workflow_run_goal_id: "GC-TEST-001",
			worktreePath: WT_PATH,
			branch: BRANCH,
		});
		for (const t of tasks) {
			expect(t.description).not.toMatch(/Worktree: .*\.pi\/orchestrator/);
			expect(t.description).not.toContain(`Branch: sages/${BRANCH}`);
		}
	});
});

describe("buildFixTaskSpec (GC-2026-verdict-states-and-dynamic-cascade)", () => {
	test("builds a Fix task spec with correct blockedBy + blocks", () => {
		const spec = buildFixTaskSpec({
			goal: baseGoal,
			iteration: 1,
			worktreePath: "/abs/worktree",
			branch: "gc-test-001-implement",
			reviewTaskId: "review-1",
			nextReviewId: "review-2",
			workflow_run_goal_id: "GC-TEST-001",
		});

		expect(spec.subject).toBe("Fix 1: Add login rate limit");
		expect(spec.agentType).toBe("Fix");
		expect(spec.metadata.phase).toBe("fix");
		expect(spec.metadata.iteration).toBe(1);
		// Fix is blockedBy the requesting review
		expect(spec.blockedBy).toEqual(["review-1"]);
		// Fix blocks the next review AND Merge
		expect(spec.blocks).toEqual(["review-2", "__merge__"]);
	});

	test("last-iteration Fix (no nextReviewId) only blocks Merge", () => {
		const spec = buildFixTaskSpec({
			goal: baseGoal,
			iteration: 3,
			worktreePath: "/abs/worktree",
			branch: "gc-test-001-implement",
			reviewTaskId: "review-3",
			nextReviewId: undefined, // last iteration
			workflow_run_goal_id: "GC-TEST-001",
		});

		expect(spec.blocks).toEqual(["__merge__"]);
	});
});

describe("buildRedesignImplementTaskSpec (GC-2026-verdict-states-and-dynamic-cascade)", () => {
	test("builds a redesign Implement with isRedesign=true metadata", () => {
		const spec = buildRedesignImplementTaskSpec({
			goal: baseGoal,
			redesignNumber: 1,
			worktreePath: "/abs/worktree",
			branch: "gc-test-001-implement",
			reviewTaskId: "review-1",
			workflow_run_goal_id: "GC-TEST-001",
		});

		expect(spec.subject).toBe("Implement (redesign 1): Add login rate limit");
		expect(spec.agentType).toBe("Developer");
		expect(spec.metadata.phase).toBe("implement");
		expect(spec.metadata.isRedesign).toBe(true);
		expect(spec.metadata.iteration).toBe(1);
		// Redesign is blockedBy the requesting review
		expect(spec.blockedBy).toEqual(["review-1"]);
		// Redesign blocks Review_1 (chain reset) + Merge
		expect(spec.blocks).toEqual(["__review_1__", "__merge__"]);
	});
});
