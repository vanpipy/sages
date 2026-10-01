/**
 * workflow-run.test.ts — GC-2026-workflow-run
 *
 * Unit tests for the workflow_run state machine with a mocked
 * SubagentRegistry. Validates: happy path, fix loop, max iterations,
 * merge failure, resume, and verdict parsing.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
	executeWorkflowRun,
	parseReviewerVerdict,
	WorkflowRunInput,
} from "../../../src/workflow-run.js";
import type { AgentRecord } from "@sages/pi-subagents/types";

// ───────────────────────────────────────────────────────────────────────
// Mock SubagentRegistry
// ───────────────────────────────────────────────────────────────────────

interface MockAgentEntry {
	record: AgentRecord;
}

interface ScriptedAgent {
	type: string;
	message: string;
	status: "completed" | "failed";
}

function makeMockRegistry() {
	const agents = new Map<string, AgentRecord>();
	const script: ScriptedAgent[] = [];

	const takeNext = (type: string): ScriptedAgent | null => {
		// Find the first scripted entry matching this type.
		const idx = script.findIndex((s) => s.type === type);
		if (idx === -1) {
			// Default: completed, generic message.
			return { type, message: "ok", status: "completed" };
		}
		const [entry] = script.splice(idx, 1);
		return entry ?? { type, message: "ok", status: "completed" };
	};

	const registry = {
		spawn(
			_piRef: unknown,
			_ctx: unknown,
			type: string,
			_prompt: string,
			_options: Record<string, unknown>,
		): string {
			const id = `agent-${agents.size + 1}`;
			const scripted = takeNext(type);
			const record: AgentRecord = {
				id,
				type: type as AgentRecord["type"],
				description: `mock ${type}`,
				status: scripted?.status ?? "completed",
				result: scripted?.message ?? "ok",
				error: scripted?.status === "failed" ? scripted.message : undefined,
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
		waitForAll: async (): Promise<void> => {
			// No-op: agents are pre-completed at spawn time.
		},
		_script(entries: ScriptedAgent[]) {
			script.push(...entries);
		},
		_clearScript() {
			script.length = 0;
		},
		_agents(): AgentRecord[] {
			return Array.from(agents.values());
		},
	};
	(globalThis as Record<symbol, unknown>)[Symbol.for("pi-subagents:manager")] = registry;
	return registry;
}

// Install registry at module load.
const registry = makeMockRegistry();

// ───────────────────────────────────────────────────────────────────────
// Test workspace setup
// ───────────────────────────────────────────────────────────────────────

const TMP_ROOT = "/tmp/sages-workflow-run-test";
let goalPath: string;
let goalYamlRel: string;

function makeGoalYaml(id: string): string {
	return [
		`id: ${id}`,
		`title: Test goal ${id}`,
		`rationale: a test goal for workflow-run`,
		`anti_goals:`,
		`  - do not break the test suite`,
		`scope:`,
		`  include: ["src/test-file.ts"]`,
		`  exclude: ["node_modules/"]`,
		`constraints: {}`,
		`done_definition: "Test goal completion criteria here."`,
		`created_at: "2026-10-01T00:00:00Z"`,
		``,
	].join("\n");
}

beforeEach(() => {
	rmSync(TMP_ROOT, { recursive: true, force: true });
	mkdirSync(join(TMP_ROOT, ".pi", "orchestrator"), { recursive: true });
	const id = "GC-test";
	goalPath = join(TMP_ROOT, ".pi", "orchestrator", `goal-${id}.yaml`);
	goalYamlRel = `.pi/orchestrator/goal-${id}.yaml`;
	writeFileSync(goalPath, makeGoalYaml(id));
});

afterEach(() => {
	rmSync(TMP_ROOT, { recursive: true, force: true });
});

const runCtx = { pi: {} as never, ctx: {} as never, repoCwd: TMP_ROOT };

// ───────────────────────────────────────────────────────────────────────
// Verdict parsing
// ───────────────────────────────────────────────────────────────────────

describe("parseReviewerVerdict", () => {
	it("parses a CLEAN verdict block", () => {
		const msg = `Review complete. \`\`\`yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\n\`\`\``;
		const v = parseReviewerVerdict(msg);
		expect(v.verdict).toBe("CLEAN");
		expect(v.findings).toEqual([]);
	});

	it("parses a NEEDS_WORK verdict with findings", () => {
		const msg = [
			"```yaml",
			"verdict: NEEDS_WORK",
			"findings:",
			"  - severity: major",
			`    issue: "missing test coverage"`,
			"  - severity: minor",
			`    issue: "README not updated"`,
			"scope_check: pass",
			"anti_goal_check: pass",
			"```",
		].join("\n");
		const v = parseReviewerVerdict(msg);
		expect(v.verdict).toBe("NEEDS_WORK");
		expect(v.findings?.length).toBe(2);
		expect(v.findings?.[0]?.issue).toBe("missing test coverage");
	});

	it("returns NEEDS_WORK with empty findings when no block is present", () => {
		expect(parseReviewerVerdict(undefined)?.verdict).toBe("NEEDS_WORK");
		expect(parseReviewerVerdict("no verdict here")?.verdict).toBe("NEEDS_WORK");
	});
});

// ───────────────────────────────────────────────────────────────────────
// Pipeline execution (mocked registry)
// ───────────────────────────────────────────────────────────────────────

describe("executeWorkflowRun", () => {
	it("returns blocked when goal_path does not exist", async () => {
		const input: WorkflowRunInput = {
			goal_path: ".pi/orchestrator/goal-DOES-NOT-EXIST.yaml",
		};
		await expect(executeWorkflowRun(input, runCtx)).rejects.toThrow(/Goal file not found/);
	});

	it("happy path: implement → review (CLEAN) → merge → success", async () => {
		registry._script([
			{ type: "Developer", message: `Implementation done.\n\`\`\`yaml\nstatus: completed\ncommits: ["abc123"]\n\`\`\``, status: "completed" },
			{ type: "Reviewer", message: `Review complete. \`\`\`yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\n\`\`\``, status: "completed" },
			{ type: "Merger", message: `Merged. \`\`\`yaml\nmerge_commit: deadbeef1234\n\`\`\``, status: "completed" },
		]);

		const result = await executeWorkflowRun({ goal_path: goalYamlRel }, runCtx);
		expect(result.status).toBe("success");
		expect(result.tasks.implement.status).toBe("completed");
		expect(result.tasks.review.verdict).toBe("CLEAN");
		expect((result.tasks.merge as { merge_commit?: string } | undefined)?.merge_commit).toBe("deadbeef1234");
		expect(result.paths.merge_commit).toBe("deadbeef1234");
	});

	it("fix loop: review NEEDS_WORK → fix → re-review CLEAN → merge", async () => {
		registry._script([
			{ type: "Developer", message: "Implemented.", status: "completed" },
			{
				type: "Reviewer",
				message:
					"```yaml\nverdict: NEEDS_WORK\nfindings:\n  - severity: major\n    issue: missing test\nscope_check: pass\nanti_goal_check: pass\n```",
				status: "completed",
			},
			{ type: "Developer", message: "Fix applied.", status: "completed" },
			{
				type: "Reviewer",
				message:
					"```yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\n```",
				status: "completed",
			},
			{ type: "Merger", message: "```yaml\nmerge_commit: caffee5678```", status: "completed" },
		]);

		const result = await executeWorkflowRun(
			{ goal_path: goalYamlRel, options: { max_fix_iterations: 2 } },
			runCtx,
		);
		expect(result.status).toBe("success");
		expect(result.iterations_used).toBe(1);
	});

	it("max iterations: 3 NEEDS_WORK reviews → blocked with unresolved_findings", async () => {
		const needWork = "```yaml\nverdict: NEEDS_WORK\nfindings:\n  - severity: major\n    issue: still failing\nscope_check: pass\nanti_goal_check: pass\n```";
		registry._script([
			{ type: "Developer", message: "Implemented.", status: "completed" },
			{ type: "Reviewer", message: needWork, status: "completed" },
			{ type: "Developer", message: "Tried to fix 1.", status: "completed" },
			{ type: "Reviewer", message: needWork, status: "completed" },
			{ type: "Developer", message: "Tried to fix 2.", status: "completed" },
			{ type: "Reviewer", message: needWork, status: "completed" },
			{ type: "Developer", message: "Tried to fix 3.", status: "completed" },
			{ type: "Reviewer", message: needWork, status: "completed" },
		]);

		const result = await executeWorkflowRun(
			{ goal_path: goalYamlRel, options: { max_fix_iterations: 3 } },
			runCtx,
		);
		expect(result.status).toBe("blocked");
		expect(result.blocked_at).toBe("review");
		expect(result.iterations_used).toBe(3);
		expect(result.unresolved_findings?.length).toBeGreaterThan(0);
	});

	it("merge failure: review CLEAN but merge fails → blocked at merge", async () => {
		registry._script([
			{ type: "Developer", message: "Implemented.", status: "completed" },
			{
				type: "Reviewer",
				message:
					"```yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\n```",
				status: "completed",
			},
			{ type: "Merger", message: "push failed", status: "failed" },
		]);

		const result = await executeWorkflowRun({ goal_path: goalYamlRel }, runCtx);
		expect(result.status).toBe("blocked");
		expect(result.blocked_at).toBe("merge");
		expect(result.merge_error).toContain("push failed");
	});
});

// ───────────────────────────────────────────────────────────────────────
// Persistence: workflow-{goal_id}.yaml
// ───────────────────────────────────────────────────────────────────────

describe("workflow-{goal_id}.yaml persistence", () => {
	it("writes a state file on initial run", async () => {
		const stateFile = join(TMP_ROOT, ".pi", "orchestrator", "workflow-GC-test.yaml");
		registry._script([
			{ type: "Developer", message: "Impl done.", status: "completed" },
			{
				type: "Reviewer",
				message:
					"```yaml\nverdict: CLEAN\nfindings: []\nscope_check: pass\nanti_goal_check: pass\n```",
				status: "completed",
			},
			{ type: "Merger", message: "```yaml\nmerge_commit: 12345```", status: "completed" },
		]);

		await executeWorkflowRun({ goal_path: goalYamlRel }, runCtx);

		expect(existsSync(stateFile)).toBe(true);
		const { readFileSync } = require("node:fs");
		const content = readFileSync(stateFile, "utf-8") as string;
		expect(content).toContain("goal_id: GC-test");
		expect(content).toContain("current_phase: completed");
	});
});
