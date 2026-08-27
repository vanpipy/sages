/**
 * registered-tool-shape.test.ts — GC-2026-089.
 *
 * Pins the canonical `ToolResult` shape (`{ content: [{ type: "text",
 * text: <string> }] }`) on every registered orchestrator tool that
 * LLM-agents call via `pi.setActiveTools(...)`. The renderer in
 * `pi-coding-agent/lib/.../render-utils.js:38 getTextOutput` reads
 * `result.content.filter((c) => c.type === "text")` — when the
 * registered execute returns a plain JS object (no `.content` array),
 * the renderer sees `undefined.filter` and pi exits with
 * `TypeError: Cannot read properties of undefined (reading 'filter')`.
 *
 * The pattern (mock `pi.registerTool`, invoke the captured tool's
 * execute, assert result shape) mirrors GC-2026-085's
 * `test/todowrite-tool-result.test.ts`. The integration gap that hid
 * the original bug — unit tests bypassed the registration boundary —
 * cannot recur if every registered tool has a test of this shape.
 *
 * Tools under test:
 *   - task_dispatch        (executeTaskDispatch)
 *   - dag_synthesize       (executeDAGSynthesize)
 *   - goal_contract_create (executeGoalContractCreate)
 *   - orchestrator_audit   (executeOrchestratorAudit)
 *   - subagent_status      (executeSubagentStatus)
 *   - subagent_steer       (executeSubagentSteer)
 *   - subagent_abort       (executeSubagentAbort)
 *   - subagent_resume      (executeSubagentResume)
 *
 * Run: cd pi-orchestrator && bun test ./test/tools/orchestrator/registered-tool-shape.test.ts
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";

import { registerTaskDispatcherTool } from "@/task-dispatcher.js";
import { registerDAGSynthesizerTool } from "@/dag-synthesizer.js";
import { registerGoalContractTool } from "@/goal-contract.js";
import { registerOrchestratorAuditTool } from "@/orchestrator-audit.js";
import {
	registerSubagentControlTools,
} from "@/subagent-control.js";
import type {
	GoalContract,
	OrchestrationPlan,
	TaskNode,
} from "@/types.js";

// ───────────────────────────────────────────────────────────────────────
// MockPi — captures every registerTool call so we can invoke the
// captured tool's `execute` directly. Mirrors the MockPi pattern from
// GC-2026-085's todowrite-tool-result.test.ts.
// ───────────────────────────────────────────────────────────────────────

interface RegisteredTool {
	name: string;
	label: string;
	description: string;
	parameters: unknown;
	execute: (
		_toolCallId: string,
		params: unknown,
		_signal: unknown,
		_onUpdate: unknown,
		_ctx: unknown,
	) => unknown;
}

function makeMockPi(): {
	pi: unknown;
	getRegistered: (name: string) => RegisteredTool | undefined;
} {
	const registered = new Map<string, RegisteredTool>();
	const pi = {
		registerTool: (tool: RegisteredTool) => {
			registered.set(tool.name, tool);
		},
	};
	return {
		pi,
		getRegistered: (name: string) => registered.get(name),
	};
}

// ───────────────────────────────────────────────────────────────────────
// Subagent registry fixture — the subagent_* tools read from the global
// `Symbol.for("pi-subagents:manager")` registry. Seed it with a tiny
// fake so the tools' execute paths can be exercised end-to-end.
// ───────────────────────────────────────────────────────────────────────

const MANAGER_KEY = Symbol.for("pi-subagents:manager") as unknown as symbol;

function setFakeRegistry(agents: Array<{
	id: string;
	status: "running" | "queued" | "completed" | "stopped";
	session?: unknown;
	pendingSteers?: string[];
	type?: string;
	isBackground?: boolean;
}>): void {
	const records = new Map<string, any>();
	for (const a of agents) {
		records.set(a.id, {
			id: a.id,
			type: a.type ?? "developer",
			description: "fake",
			status: a.status,
			toolUses: 0,
			startedAt: 1_700_000_000_000,
			completedAt: a.status === "completed" || a.status === "stopped" ? 1_700_000_001_000 : undefined,
			lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
			compactionCount: 0,
			isBackground: a.isBackground ?? true,
			session: a.session,
			pendingSteers: a.pendingSteers ?? [],
		});
	}
	const registry = {
		waitForAll: async () => {},
		hasRunning: () => [...records.values()].some((r: any) => r.status === "running" || r.status === "queued"),
		spawn: () => {
			throw new Error("spawn not used");
		},
		getRecord: (id: string) => records.get(id),
		steer: (id: string, message: string) => {
			const r = records.get(id);
			if (!r) return false;
			if (r.status !== "running" && r.status !== "queued") return false;
			if (r.session) {
				void (r.session as { steer: (m: string) => Promise<void> }).steer(message).catch(() => {});
				return true;
			}
			r.pendingSteers = r.pendingSteers ?? [];
			r.pendingSteers.push(message);
			return true;
		},
		abort: (id: string, reason?: unknown) => {
			const r = records.get(id);
			if (!r) return false;
			if (r.status === "queued" || r.status === "running") {
				r.status = "stopped";
				r.error = reason !== undefined ? String(reason) : undefined;
				return true;
			}
			return false;
		},
		resume: async (id: string, _prompt: string) => {
			const r = records.get(id);
			if (!r) return undefined;
			r.status = "running";
			return r;
		},
		listAgents: () => [...records.values()],
	};
	(globalThis as Record<symbol, unknown>)[MANAGER_KEY] = registry;
}

function clearFakeRegistry(): void {
	delete (globalThis as Record<symbol, unknown>)[MANAGER_KEY];
}

// ───────────────────────────────────────────────────────────────────────
// Fixtures — minimal valid goal/plan for the 4 orchestrator_* tools.
// ───────────────────────────────────────────────────────────────────────

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "registered-tool-shape-"));
});

afterEach(() => {
	if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
	clearFakeRegistry();
});

function makeTask(id: string, opts: Partial<TaskNode> = {}): TaskNode {
	return {
		id,
		description: `task ${id}`,
		plane: "Business",
		priority: "medium",
		depends_on: [],
		files: [],
		subagent_type: "developer",
		batch: 1,
		isolation: { dag_id: "GC-2026-089", task_id: id, mode: "create" },
		tdd: "strict",
		prompt: `prompt ${id}`,
		acceptance: { covers: ["SC1"] },
		output_schema: { kind: "code_changes" },
		status: "pending",
		retry_count: 0,
		max_retries: 2,
		...opts,
	} as TaskNode;
}

function makeGoalContract(): GoalContract {
	return {
		id: "GC-2026-089",
		title: "test goal",
		success_criteria: [
			{ id: "SC1", criterion: "typecheck passes", verification_cmd: "echo ok" },
		],
		anti_goals: [],
		scope: { include: [], exclude: [] },
		constraints: {},
		done_definition: "ok",
		created_at: "2025-01-01T00:00:00Z",
	};
}

function makePlan(id: string, tasks: TaskNode[]): OrchestrationPlan {
	return {
		id,
		goal_id: "GC-2026-089",
		title: `Plan ${id}`,
		tasks,
		created_at: "2025-01-01T00:00:00Z",
		updated_at: "2025-01-01T00:00:00Z",
		state: "approved",
		prompts: {},
	};
}

function writePlan(plan: OrchestrationPlan) {
	mkdirSync(join(cwd, ".pi", "orchestrator"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "orchestrator", `dag-${plan.id}.yaml`),
		yaml.dump(plan, { indent: 2, lineWidth: 120, noRefs: true }),
		"utf-8",
	);
}

function writeGoal(goal: GoalContract) {
	mkdirSync(join(cwd, ".pi", "orchestrator"), { recursive: true });
	writeFileSync(
		join(cwd, ".pi", "orchestrator", `goal-${goal.id}.yaml`),
		yaml.dump(goal, { indent: 2, lineWidth: 120, noRefs: true }),
		"utf-8",
	);
}

// ───────────────────────────────────────────────────────────────────────
// Helpers — ToolResult assertions
// ───────────────────────────────────────────────────────────────────────

interface ToolResultShape {
	content?: Array<{ type?: string; text?: string }>;
	details?: unknown;
}

function assertCanonicalShape(result: unknown): void {
	const r = result as ToolResultShape;
	expect(Array.isArray(r.content)).toBe(true);
	expect(r.content).toHaveLength(1);
	expect(r.content?.[0]?.type).toBe("text");
	expect(typeof r.content?.[0]?.text).toBe("string");
	// text must be parseable (the LLM will JSON.parse it)
	const text = r.content?.[0]?.text ?? "";
	expect(() => JSON.parse(text)).not.toThrow();
}

function parseResultText(result: unknown): unknown {
	const r = result as ToolResultShape;
	return JSON.parse(r.content?.[0]?.text ?? "{}");
}

// ───────────────────────────────────────────────────────────────────────
// 4 orchestrator_* registered tools — happy path shape
// ───────────────────────────────────────────────────────────────────────

describe("task_dispatch registered-tool shape (GC-2026-089)", () => {
	it("registered execute returns canonical ToolResult shape on success", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerTaskDispatcherTool(pi);
		const tool = getRegistered("task_dispatch");
		expect(tool).toBeDefined();

		const plan = makePlan("DAG-shape-task-dispatch", [makeTask("P1")]);
		writePlan(plan);

		const result = await tool!.execute(
			"id",
			{ dag_id: "DAG-shape-task-dispatch" },
			undefined,
			undefined,
			{ cwd },
		);
		assertCanonicalShape(result);
	});

	it("registered execute returns ToolResult shape on error path (DAG not found)", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerTaskDispatcherTool(pi);
		const tool = getRegistered("task_dispatch")!;

		const result = await tool!.execute(
			"id",
			{ dag_id: "DAG-NEVER-EXISTED" },
			undefined,
			undefined,
			{ cwd },
		);
		// Even the error path must be wrapped — the renderer must not
		// crash on `result.content` being undefined.
		assertCanonicalShape(result);
		const parsed = parseResultText(result) as { status?: string };
		expect(parsed.status).toBe("error");
	});
});

describe("dag_synthesize registered-tool shape (GC-2026-089)", () => {
	it("registered execute returns canonical ToolResult shape on success", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerDAGSynthesizerTool(pi);
		const tool = getRegistered("dag_synthesize");
		expect(tool).toBeDefined();

		writeGoal(makeGoalContract());
		const plan = makePlan("DAG-shape", [makeTask("P1")]);

		const result = await tool!.execute(
			"id",
			{
				goal_id: "GC-2026-089",
				goal_title: "x",
				goal_summary: "x",
				success_criteria: plan.tasks.map((t) => ({
					id: t.acceptance.covers?.[0] ?? "SC1",
					criterion: "x",
					verification_cmd: "echo ok",
				})),
				tasks: plan.tasks.map((t) => ({
					id: t.id,
					description: t.description,
					plane: t.plane,
					priority: t.priority,
					depends_on: t.depends_on,
					files: t.files,
					subagent_type: t.subagent_type,
					batch: t.batch,
					isolation: t.isolation,
					tdd: t.tdd,
					prompt: t.prompt,
					acceptance: t.acceptance,
					output_schema: t.output_schema,
				})),
			},
			undefined,
			undefined,
			{ cwd },
		);
		assertCanonicalShape(result);
	});

	it("registered execute returns ToolResult shape on error path (goal not found)", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerDAGSynthesizerTool(pi);
		const tool = getRegistered("dag_synthesize")!;

		const result = await tool!.execute(
			"id",
			{
				goal_id: "GC-NOPE",
				goal_title: "x",
				goal_summary: "x",
				success_criteria: [],
				tasks: [],
			},
			undefined,
			undefined,
			{ cwd },
		);
		assertCanonicalShape(result);
		const parsed = parseResultText(result) as { status?: string };
		expect(parsed.status).toBe("error");
	});
});

describe("goal_contract_create registered-tool shape (GC-2026-089)", () => {
	it("registered execute returns canonical ToolResult shape on success", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerGoalContractTool(pi);
		const tool = getRegistered("goal_contract_create");
		expect(tool).toBeDefined();

		const result = await tool!.execute(
			"id",
			{
				id: "GC-2026-089-new",
				title: "fix shape",
				success_criteria: [
					{ id: "SC1", criterion: "shape canonical", verification_cmd: "echo ok" },
				],
				anti_goals: [],
				scope: { include: [], exclude: [] },
				constraints: {},
				done_definition: "ok",
			},
			undefined,
			undefined,
			{ cwd },
		);
		assertCanonicalShape(result);
		const parsed = parseResultText(result) as { goal_contract_path?: string };
		expect(typeof parsed.goal_contract_path).toBe("string");
	});

	it("registered execute returns ToolResult shape on error path (invalid SC)", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerGoalContractTool(pi);
		const tool = getRegistered("goal_contract_create")!;

		// Missing verification_cmd — should fail validation, but the
		// registered execute must still wrap the error in ToolResult
		// shape rather than throwing.
		const result = await tool!.execute(
			"id",
			{
				id: "GC-bad",
				title: "bad contract",
				success_criteria: [{ id: "SC1", criterion: "no cmd", verification_cmd: "" }],
				anti_goals: [],
				scope: { include: [], exclude: [] },
				constraints: {},
				done_definition: "ok",
			},
			undefined,
			undefined,
			{ cwd },
		);
		assertCanonicalShape(result);
	});
});

describe("orchestrator_audit registered-tool shape (GC-2026-089)", () => {
	it("registered execute returns canonical ToolResult shape on success", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerOrchestratorAuditTool(pi);
		const tool = getRegistered("orchestrator_audit");
		expect(tool).toBeDefined();

		const plan = makePlan("DAG-shape-audit", [makeTask("P1")]);
		writePlan(plan);
		writeFileSync(
			join(cwd, ".pi", "orchestrator", "audit-P1.md"),
			"# Audit Report: P1\n\n## Final Verdict\n\n**CERTIFIED**\n\n",
			"utf-8",
		);

		const result = await tool!.execute(
			"id",
			{ dag_id: "DAG-shape-audit" },
			undefined,
			undefined,
			{ cwd },
		);
		assertCanonicalShape(result);
	});

	it("registered execute returns ToolResult shape on error path (DAG not found)", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerOrchestratorAuditTool(pi);
		const tool = getRegistered("orchestrator_audit")!;

		const result = await tool!.execute(
			"id",
			{ dag_id: "DAG-NEVER-EXISTED" },
			undefined,
			undefined,
			{ cwd },
		);
		assertCanonicalShape(result);
		const parsed = parseResultText(result) as { status?: string };
		expect(parsed.status).toBe("error");
	});
});

// ───────────────────────────────────────────────────────────────────────
// 4 subagent_* registered tools — happy path shape (these currently
// return plain {ok, ...} objects from the underlying functions; the
// wrapper is the only thing keeping the renderer alive).
// ───────────────────────────────────────────────────────────────────────

describe("subagent_status registered-tool shape (GC-2026-089)", () => {
	it("registered execute returns canonical ToolResult shape (wraps plain {ok,...} executeSubagentStatus)", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerSubagentControlTools(pi);
		const tool = getRegistered("subagent_status");
		expect(tool).toBeDefined();

		setFakeRegistry([
			{ id: "a", status: "running", type: "developer" },
			{ id: "b", status: "completed", type: "developer" },
		]);

		// subagent_* tools do not take cwd — pass a minimal ctx.
		// GC-2026-090: wrapRegisteredTool always returns a Promise (the
		// helper awaits the inner execute for pass-through detection),
		// so callers must await — even when the inner is sync.
		const result = await tool!.execute("id", {}, undefined, undefined, {});
		assertCanonicalShape(result);
		const parsed = parseResultText(result) as { ok?: boolean; total?: number };
		expect(parsed.ok).toBe(true);
		expect(parsed.total).toBe(2);
	});

	it("does NOT leak the underlying raw object shape at the top level", async () => {
		// Pre-fix: result.content was undefined and the top-level keys
		// were {ok, agents, total, ...}. Verify the wrapped shape wins.
		const { pi, getRegistered } = makeMockPi();
		registerSubagentControlTools(pi);
		const tool = getRegistered("subagent_status")!;
		setFakeRegistry([]);

		const result = await tool!.execute("id", {}, undefined, undefined, {});
		const r = result as Record<string, unknown>;
		// The TOP-level keys MUST be the canonical ToolResult keys —
		// { content, details?, isError? }. A raw `ok` field at the top
		// would mean the wrapper forgot to wrap (the original bug).
		expect(r.content).toBeDefined();
		expect(r.ok).toBeUndefined();
		expect(r.agents).toBeUndefined();
		expect(r.total).toBeUndefined();
	});
});

describe("subagent_steer registered-tool shape (GC-2026-089)", () => {
	it("registered execute returns canonical ToolResult shape", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerSubagentControlTools(pi);
		const tool = getRegistered("subagent_steer");
		expect(tool).toBeDefined();

		const fakeSession = { steer: () => Promise.resolve() };
		setFakeRegistry([
			{ id: "s", status: "running", session: fakeSession },
		]);

		const result = await tool!.execute(
			"id",
			{ agent_id: "s", message: "hi" },
			undefined,
			undefined,
			{},
		);
		assertCanonicalShape(result);
		const parsed = parseResultText(result) as { delivered?: boolean };
		expect(parsed.delivered).toBe(true);
	});

	it("registered execute returns ToolResult shape on unknown agent_id", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerSubagentControlTools(pi);
		const tool = getRegistered("subagent_steer")!;
		setFakeRegistry([]);

		const result = await tool!.execute(
			"id",
			{ agent_id: "ghost", message: "hi" },
			undefined,
			undefined,
			{},
		);
		assertCanonicalShape(result);
		const parsed = parseResultText(result) as { ok?: boolean };
		expect(parsed.ok).toBe(false);
	});
});

describe("subagent_abort registered-tool shape (GC-2026-089)", () => {
	it("registered execute returns canonical ToolResult shape", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerSubagentControlTools(pi);
		const tool = getRegistered("subagent_abort");
		expect(tool).toBeDefined();

		setFakeRegistry([{ id: "a", status: "running" }]);

		const result = await tool!.execute(
			"id",
			{ agent_id: "a", reason: "deadline" },
			undefined,
			undefined,
			{},
		);
		assertCanonicalShape(result);
		const parsed = parseResultText(result) as { stopped?: boolean };
		expect(parsed.stopped).toBe(true);
	});

	it("registered execute returns ToolResult shape on already-terminal agent", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerSubagentControlTools(pi);
		const tool = getRegistered("subagent_abort")!;
		setFakeRegistry([{ id: "done", status: "completed" }]);

		const result = await tool!.execute(
			"id",
			{ agent_id: "done" },
			undefined,
			undefined,
			{},
		);
		assertCanonicalShape(result);
		const parsed = parseResultText(result) as { stopped?: boolean };
		expect(parsed.stopped).toBe(false);
	});
});

describe("subagent_resume registered-tool shape (GC-2026-089)", () => {
	it("registered execute returns canonical ToolResult shape on success", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerSubagentControlTools(pi);
		const tool = getRegistered("subagent_resume");
		expect(tool).toBeDefined();

		const fakeSession = { steer: () => Promise.resolve() };
		setFakeRegistry([
			{ id: "x", status: "completed", session: fakeSession },
		]);

		const result = await tool!.execute(
			"id",
			{ agent_id: "x", prompt: "continue" },
			undefined,
			undefined,
			{},
		);
		assertCanonicalShape(result);
		const parsed = parseResultText(result) as { resumed?: boolean };
		expect(parsed.resumed).toBe(true);
	});

	it("registered execute returns ToolResult shape on refused resume", async () => {
		const { pi, getRegistered } = makeMockPi();
		registerSubagentControlTools(pi);
		const tool = getRegistered("subagent_resume")!;
		setFakeRegistry([{ id: "running", status: "running" }]);

		const result = await tool!.execute(
			"id",
			{ agent_id: "running", prompt: "go" },
			undefined,
			undefined,
			{},
		);
		assertCanonicalShape(result);
		const parsed = parseResultText(result) as { resumed?: boolean };
		expect(parsed.resumed).toBe(false);
	});
});

// ───────────────────────────────────────────────────────────────────────
// Integration pin — invoke ALL 8 registered tools and assert canonical
// shape in one sweep (catches future registration drift).
// ───────────────────────────────────────────────────────────────────────

describe("all 8 orchestrator tools return canonical ToolResult shape (integration pin, GC-2026-089)", () => {
	it("every tool that emits via pi.registerTool is wrapped in ToolResult", async () => {
		// Build a fresh mock pi, register ALL orchestrator families,
		// then invoke each registered tool's execute and assert shape.
		const { pi, getRegistered } = makeMockPi();
		registerGoalContractTool(pi);
		registerDAGSynthesizerTool(pi);
		registerTaskDispatcherTool(pi);
		registerOrchestratorAuditTool(pi);
		registerSubagentControlTools(pi);

		const tools = [
			"goal_contract_create",
			"dag_synthesize",
			"task_dispatch",
			"orchestrator_audit",
			"subagent_status",
			"subagent_steer",
			"subagent_abort",
			"subagent_resume",
		];
		for (const name of tools) {
			expect(getRegistered(name)).toBeDefined();
		}

		// Set up the minimum fixtures the orchestrator_* tools need.
		writeGoal(makeGoalContract());
		const plan = makePlan("DAG-pin", [makeTask("P1")]);
		writePlan(plan);
		setFakeRegistry([
			{ id: "x", status: "completed", session: { steer: () => Promise.resolve() } },
			{ id: "y", status: "running" },
		]);

		const calls: Array<() => unknown> = [
			() =>
				getRegistered("task_dispatch")!.execute(
					"id",
					{ dag_id: "DAG-pin" },
					undefined,
					undefined,
					{ cwd },
				),
			() =>
				getRegistered("dag_synthesize")!.execute(
					"id",
					{ dag_id: "DOES-NOT-EXIST-FOR-PIN" }, // error path
					undefined,
					undefined,
					{ cwd },
				),
			() =>
				getRegistered("goal_contract_create")!.execute(
					"id",
					{
						id: "GC-pin",
						title: "pin",
						success_criteria: [
							{ id: "SC1", criterion: "shape", verification_cmd: "echo ok" },
						],
						anti_goals: [],
						scope: { include: [], exclude: [] },
						constraints: {},
						done_definition: "ok",
					},
					undefined,
					undefined,
					{ cwd },
				),
			() =>
				getRegistered("orchestrator_audit")!.execute(
					"id",
					{ dag_id: "DAG-pin" },
					undefined,
					undefined,
					{ cwd },
				),
			() =>
				getRegistered("subagent_status")!.execute(
					"id",
					{},
					undefined,
					undefined,
					{},
				),
			() =>
				getRegistered("subagent_steer")!.execute(
					"id",
					{ agent_id: "x", message: "ping" },
					undefined,
					undefined,
					{},
				),
			() =>
				getRegistered("subagent_abort")!.execute(
					"id",
					{ agent_id: "y" },
					undefined,
					undefined,
					{},
				),
			() =>
				getRegistered("subagent_resume")!.execute(
					"id",
					{ agent_id: "x", prompt: "go" },
					undefined,
					undefined,
					{},
				),
		];

		const results = await Promise.all(calls.map((c) => c()));
		for (const result of results) {
			assertCanonicalShape(result);
		}
	});
});
