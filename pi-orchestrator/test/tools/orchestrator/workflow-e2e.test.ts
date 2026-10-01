/**
 * workflow-e2e.test.ts — GC-2026-end-to-end-test
 *
 * End-to-end integration test for workflow_run. Sets up a real git
 * repo in a temp dir, writes a goal contract, runs executeWorkflowRun
 * with mocked subagents, and verifies the orchestration writes the
 * expected artifacts (workflow-{id}.yaml, branch, git worktree, merge
 * commit shape).
 *
 * Note: subagents are scripted (mocked) but the orchestrator's state
 * machine, persistence, pi-tasks integration, and result shape are all
 * real. This catches:
 *   - YAML read/write round-trips
 *   - State machine transitions across phases
 *   - pi-tasks TaskCreate / TaskUpdate calls
 *   - Verdict parsing
 *   - Resume from saved state
 *   - Final return shape contract
 *
 * It does NOT catch:
 *   - Real subagent behavior (Developer / Reviewer / Merger)
 *   - Real git worktree provisioning (the mock skips managedWorktree)
 *   - Real model API calls
 *   - Concurrent workflow_run invocations
 *
 * For "real" end-to-end tests, see `docs/e2e-real.md` (TODO: GC-3).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";

import {
	executeWorkflowRun,
	type WorkflowRunInput,
} from "../../../src/workflow-run.js";
import type { AgentRecord } from "@sages/pi-subagents/types";

// ───────────────────────────────────────────────────────────────────────
// Test workspace setup (real git repo)
// ───────────────────────────────────────────────────────────────────────

const TMP_ROOT = "/tmp/sages-workflow-e2e-test";

beforeEach(async () => {
	rmSync(TMP_ROOT, { recursive: true, force: true });
	mkdirSync(join(TMP_ROOT, ".pi", "orchestrator"), { recursive: true });
	// Initialize a git repo with a main branch and one initial commit so
	// the merger has something to merge into.
	const git = simpleGit(TMP_ROOT);
	await git.init();
	await git.addConfig("user.name", "Test User");
	await git.addConfig("user.email", "test@example.com");
	await git.checkoutLocalBranch("main");
	writeFileSync(join(TMP_ROOT, "README.md"), "# Test repo\n");
	await git.add("README.md");
	await git.commit("initial commit");
});

afterEach(() => {
	rmSync(TMP_ROOT, { recursive: true, force: true });
});

// ───────────────────────────────────────────────────────────────────────
// Scripted subagent registry (mock — see workflow-run.test.ts for the
// full comment on why mocks are needed and what they cover)
// ───────────────────────────────────────────────────────────────────────

interface ScriptedAgent {
	type: string;
	message: string;
	status: "completed" | "failed";
}

function installMockRegistry(script: ScriptedAgent[]) {
	const agents = new Map<string, AgentRecord>();
	const pendingScript = [...script];

	const registry = {
		spawn(
			_piRef: unknown,
			_ctx: unknown,
			type: string,
			_prompt: string,
			_options: Record<string, unknown>,
		): string {
			const id = `agent-${agents.size + 1}`;
			const next = pendingScript.shift() ?? {
				type,
				message: "ok",
				status: "completed" as const,
			};
			const record: AgentRecord = {
				id,
				type: type as AgentRecord["type"],
				description: `mock ${type}`,
				status: next.status,
				result: next.message,
				error: next.status === "failed" ? next.message : undefined,
				toolUses: 0,
				startedAt: Date.now(),
				completedAt: Date.now(),
			} as AgentRecord;
			agents.set(id, record);
			return id;
		},
		getRecord(id: string): AgentRecord | undefined {
			return agents.get(id);
		},
		waitForAll: async (): Promise<void> => {},
	};
	(globalThis as unknown as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] = registry;
	return { registry, agents };
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

function makeGoalYaml(id: string): string {
	return [
		`id: ${id}`,
		`title: Test goal ${id}`,
		`rationale: end-to-end test for workflow_run`,
		`anti_goals:`,
		`  - do not break the existing test suite`,
		`scope:`,
		`  include: ["src/test-file.ts"]`,
		`  exclude: ["node_modules/"]`,
		`constraints: {}`,
		`done_definition: "Test goal completion criteria here."`,
		`created_at: "2026-10-01T00:00:00Z"`,
		``,
	].join("\n");
}

function makeFakeExecuteTool(calls: { name: string; args: unknown }[]) {
	let nextId = 1;
	return {
		executeTool: async (name: string, args: unknown) => {
			calls.push({ name, args });
			if (name === "TaskCreate") {
				const id = String(nextId++);
				return { id, task: { id } };
			}
			if (name === "TaskUpdate") {
				return { id: "x" };
			}
			return undefined;
		},
	};
}

const runCtxBase = { pi: {} as never, ctx: {} as never, repoCwd: TMP_ROOT };

// ───────────────────────────────────────────────────────────────────────
// End-to-end scenarios
// ───────────────────────────────────────────────────────────────────────

describe("workflow_run end-to-end (mocked subagents)", () => {
	it("full happy path: writes goal.yaml, workflow state, creates 4 pi-tasks tasks, returns success", async () => {
		const goalId = "GC-e2e-happy";
		const goalPath = `.pi/orchestrator/goal-${goalId}.yaml`;
		writeFileSync(join(TMP_ROOT, goalPath), makeGoalYaml(goalId));

		const { agents } = installMockRegistry([
			{
				type: "Developer",
				message: 'Implementation done.\n```yaml\nstatus: completed\ncommits: ["abc123"]\n```',
				status: "completed",
			},
			{
				type: "Reviewer",
				message:
					"```yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\n```",
				status: "completed",
			},
			{
				type: "Merger",
				message: "```yaml\nmerge_commit: deadbeef1234```",
				status: "completed",
			},
		]);
		const calls: { name: string; args: unknown }[] = [];
		const ctx = { ...runCtxBase, executeTool: makeFakeExecuteTool(calls).executeTool };

		const result = await executeWorkflowRun({ goal_path: goalPath }, ctx);

		// 1. Result shape
		expect(result.status).toBe("success");
		expect(result.goal_id).toBe(goalId);
		expect(result.iterations_used).toBe(0);
		expect(result.tasks.implement.status).toBe("completed");
		expect(result.tasks.review.verdict).toBe("CLEAN");
		expect((result.tasks.merge as { merge_commit?: string } | undefined)?.merge_commit).toBe(
			"deadbeef1234",
		);

		// 2. pi-tasks integration: 4 TaskCreate + multiple TaskUpdate
		const creates = calls.filter((c) => c.name === "TaskCreate");
		expect(creates.length).toBe(4);
		const updates = calls.filter((c) => c.name === "TaskUpdate");
		expect(updates.length).toBeGreaterThan(0);
		// All pi-tasks tasks carry workflow_run_goal_id
		for (const c of creates) {
			const args = c.args as { metadata?: { workflow_run_goal_id?: string } };
			expect(args.metadata?.workflow_run_goal_id).toBe(goalId);
		}
		expect(result.pi_tasks.implement).toBeTruthy();
		expect(result.pi_tasks.review).toBeTruthy();
		expect(result.pi_tasks.fix).toBeTruthy();
		expect(result.pi_tasks.merge).toBeTruthy();

		// 3. workflow-{goal_id}.yaml persisted
		const stateFile = join(TMP_ROOT, ".pi", "orchestrator", `workflow-${goalId}.yaml`);
		expect(existsSync(stateFile)).toBe(true);

		// 4. Subagents were spawned in the right order
		const spawnOrder = Array.from(agents.values()).map((a) => a.type);
		expect(spawnOrder).toEqual(["Developer", "Reviewer", "Merger"]);
	});

	it("fix loop: NEEDS_WORK → Fix → re-review CLEAN → Merge → success with iterations_used=1", async () => {
		const goalId = "GC-e2e-fixloop";
		const goalPath = `.pi/orchestrator/goal-${goalId}.yaml`;
		writeFileSync(join(TMP_ROOT, goalPath), makeGoalYaml(goalId));

		const needWork =
			"```yaml\nverdict: NEEDS_WORK\nfindings:\n  - severity: major\n    issue: missing test\nscope_check: pass\nanti_goal_check: pass\n```";
		installMockRegistry([
			{ type: "Developer", message: "Implemented.", status: "completed" },
			{ type: "Reviewer", message: needWork, status: "completed" },
			{ type: "Developer", message: "Fix applied.", status: "completed" },
			{
				type: "Reviewer",
				message: "```yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\n```",
				status: "completed",
			},
			{ type: "Merger", message: "```yaml\nmerge_commit: caffee5678```", status: "completed" },
		]);
		const calls: { name: string; args: unknown }[] = [];
		const ctx = { ...runCtxBase, executeTool: makeFakeExecuteTool(calls).executeTool };

		const result = await executeWorkflowRun(
			{ goal_path: goalPath, options: { max_fix_iterations: 3 } },
			ctx,
		);

		expect(result.status).toBe("success");
		expect(result.iterations_used).toBe(1);
	});

	it("blocked at max iterations: writes workflow-{id}.yaml with current_phase=blocked", async () => {
		const goalId = "GC-e2e-blocked";
		const goalPath = `.pi/orchestrator/goal-${goalId}.yaml`;
		writeFileSync(join(TMP_ROOT, goalPath), makeGoalYaml(goalId));

		const needWork = "```yaml\nverdict: NEEDS_WORK\nfindings:\n  - severity: major\n    issue: x\nscope_check: pass\nanti_goal_check: pass\n```";
		installMockRegistry([
			{ type: "Developer", message: "Impl.", status: "completed" },
			{ type: "Reviewer", message: needWork, status: "completed" },
			{ type: "Developer", message: "Fix 1.", status: "completed" },
			{ type: "Reviewer", message: needWork, status: "completed" },
			{ type: "Developer", message: "Fix 2.", status: "completed" },
			{ type: "Reviewer", message: needWork, status: "completed" },
			{ type: "Developer", message: "Fix 3.", status: "completed" },
			{ type: "Reviewer", message: needWork, status: "completed" },
		]);
		const calls: { name: string; args: unknown }[] = [];
		const ctx = { ...runCtxBase, executeTool: makeFakeExecuteTool(calls).executeTool };

		const result = await executeWorkflowRun(
			{ goal_path: goalPath, options: { max_fix_iterations: 3 } },
			ctx,
		);

		expect(result.status).toBe("blocked");
		expect(result.blocked_at).toBe("review");
		expect(result.iterations_used).toBe(3);
		expect(result.unresolved_findings?.length).toBeGreaterThan(0);

		// workflow-{id}.yaml reflects the blocked state
		const stateFile = join(TMP_ROOT, ".pi", "orchestrator", `workflow-${goalId}.yaml`);
		const stateContent = require("node:fs").readFileSync(stateFile, "utf-8") as string;
		expect(stateContent).toContain("current_phase: blocked");
		expect(stateContent).toContain("iterations_used: 3");
	});

	it("resume: a previous run's state file is loaded; only missing phases run", async () => {
		const goalId = "GC-e2e-resume";
		const goalPath = `.pi/orchestrator/goal-${goalId}.yaml`;
		writeFileSync(join(TMP_ROOT, goalPath), makeGoalYaml(goalId));

		// Run 1: Implement completes, Review completes (CLEAN), Merge fails.
		{
			installMockRegistry([
				{
					type: "Developer",
					message: '```yaml\nstatus: completed\ncommits: ["a"]\n```',
					status: "completed",
				},
				{
					type: "Reviewer",
					message:
						"```yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\n```",
					status: "completed",
				},
				{ type: "Merger", message: "push failed", status: "failed" },
			]);
			await executeWorkflowRun({ goal_path: goalPath }, { ...runCtxBase, executeTool: makeFakeExecuteTool([]).executeTool });
		}

		// Run 2 (resume=true by default): Implement + Review are SKIPPED,
		// only the failed Merger re-runs and now succeeds.
		const { agents } = installMockRegistry([
			{ type: "Merger", message: "```yaml\nmerge_commit: resumed123```", status: "completed" },
		]);
		const calls: { name: string; args: unknown }[] = [];
		const ctx = { ...runCtxBase, executeTool: makeFakeExecuteTool(calls).executeTool };

		const result = await executeWorkflowRun({ goal_path: goalPath }, ctx);

		expect(result.status).toBe("success");
		expect((result.tasks.merge as { merge_commit?: string } | undefined)?.merge_commit).toBe(
			"resumed123",
		);
		// Only the Merger ran this time (Implement and Review were loaded from state).
		const spawnOrder = Array.from(agents.values()).map((a) => a.type);
		expect(spawnOrder).toEqual(["Merger"]);
		// pi-tasks setup re-runs TaskCreate calls but they should have
		// different IDs since the script doesn't track them.
		// The point is: at least 4 TaskCreate calls happened (the setup).
		const creates = calls.filter((c) => c.name === "TaskCreate");
		expect(creates.length).toBeGreaterThanOrEqual(4);
	});

	it("pi-tasks graceful degradation: works without executeTool", async () => {
		const goalId = "GC-e2e-noexecute";
		const goalPath = `.pi/orchestrator/goal-${goalId}.yaml`;
		writeFileSync(join(TMP_ROOT, goalPath), makeGoalYaml(goalId));

		installMockRegistry([
			{ type: "Developer", message: "Done.", status: "completed" },
			{
				type: "Reviewer",
				message: "```yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\n```",
				status: "completed",
			},
			{ type: "Merger", message: "```yaml\nmerge_commit: nope```", status: "completed" },
		]);
		// No executeTool passed — pipeline still completes.
		const result = await executeWorkflowRun({ goal_path: goalPath }, runCtxBase);

		expect(result.status).toBe("success");
		expect(result.pi_tasks.implement).toBe("");
		expect(result.pi_tasks.review).toBe("");
		expect(result.pi_tasks.fix).toBe("");
		expect(result.pi_tasks.merge).toBe("");
	});
});