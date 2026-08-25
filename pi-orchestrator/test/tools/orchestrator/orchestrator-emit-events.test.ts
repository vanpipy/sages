/**
 * orchestrator-emit-events.test.ts — GC-2026-067 T1
 *
 * Pins the contract that the three orchestrator tools persist
 * `audit-state-{dag_id}.yaml` with `run/*` events so the watchdog and
 * session digest have signal to track.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";

import { registerGoalContractTool } from "@/goal-contract.js";
import { registerDAGSynthesizerTool } from "@/dag-synthesizer.js";
import { registerTaskDispatcherTool } from "@/task-dispatcher.js";

function makePiStub() {
	const calls: Array<{ key: string; value: any }> = [];
	let tool: any = null;
	return {
		_pi: calls,
		pi: {
			registerTool(t: any) {
				tool = t;
			},
		},
		getTool: () => tool,
	};
}

function makeGoalInput(id: string) {
	return {
		id,
		title: `GC test ${id}`,
		rationale: "unit test for emit",
		success_criteria: [
			{
				id: "SC1",
				criterion: "this criterion must run successfully",
				verification_cmd: "echo OK",
				severity: "blocker",
			},
		],
		anti_goals: [],
		scope: { include: ["x"], exclude: [] },
		constraints: { typecheck_required: true },
		done_definition: "Done when SC1 passes.",
		verbose: false,
	};
}

describe("orchestrator emit run/* events (GC-2026-067 T1)", () => {
	let tmp: string;
	let originalCwd: string;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "orchestrator-emit-"));
		// emitRunEvent resolves .pi/orchestrator relative to process.cwd().
		// chdir to the tmp dir so each test gets an isolated audit-state-{dag}.yaml.
		originalCwd = process.cwd();
		process.chdir(tmp);
	});

	afterEach(() => {
		try {
			process.chdir(originalCwd);
			rmSync(tmp, { recursive: true, force: true });
		} catch {
			// ignore
		}
	});

	function readAuditState(dagId: string): any {
		const path = join(tmp, ".pi", "orchestrator", `audit-state-${dagId}.yaml`);
		if (!existsSync(path)) return null;
		const text = readFileSync(path, "utf-8");
		return yaml.load(text);
	}

	it("(a) goal_contract_create writes audit-state-{goal_id}.yaml with run/goal_created event", async () => {
		const stub = makePiStub();
		registerGoalContractTool(stub.pi);
		const tool = stub.getTool()!;
		const input = makeGoalInput("GC-2026-T1-A");
		const result = await tool.execute(
			"call-a",
			input,
			undefined,
			() => {},
			{ cwd: tmp },
		);
		expect(result).toBeDefined();

		const state = readAuditState("GC-2026-T1-A");
		expect(state).not.toBeNull();
		const events = (state as any).events as Array<{ name: string; payload?: any }>;
		expect(events).toBeDefined();
		expect(events.length).toBeGreaterThanOrEqual(1);
		const created = events.find((e) => e.name === "run/goal_created");
		expect(created).toBeDefined();
		expect(created?.payload?.goal_id).toBe("GC-2026-T1-A");
	});

	it("(b) dag_synthesize writes run/dag_synthesized event", async () => {
		// First create the goal
		const gStub = makePiStub();
		registerGoalContractTool(gStub.pi);
		await gStub.getTool()!.execute("g", makeGoalInput("GC-2026-T1-B"), undefined, () => {}, { cwd: tmp });

		// Then synthesize the DAG
		const dStub = makePiStub();
		registerDAGSynthesizerTool(dStub.pi);
		const dInput = {
			id: "DAG-2026-T1-B",
			goal_id: "GC-2026-T1-B",
			strategy: "auto",
			tasks: [
				{
					id: "T1",
					description: "test task",
					plane: "Foundation",
					priority: "high",
					depends_on: [],
					files: ["x"],
					subagent_type: "developer",
					batch: 1,
					isolation: {
						dag_id: "DAG-2026-T1-B",
						task_id: "T1",
						mode: "create",
					},
					tdd: "strict",
					prompt: "do the test thing",
					output_schema: { kind: "code_changes", fields: ["files_changed"] },
					acceptance: { covers: ["SC1"], self_check_cmd: "echo OK" },
				},
			],
			verbose: false,
		};
		const result = await dStub.getTool()!.execute("d", dInput, undefined, () => {}, { cwd: tmp });
		expect(result).toBeDefined();

		const state = readAuditState("DAG-2026-T1-B");
		expect(state).not.toBeNull();
		const events = (state as any).events as Array<{ name: string; payload?: any }>;
		const synth = events.find((e) => e.name === "run/dag_synthesized");
		expect(synth).toBeDefined();
		expect(synth?.payload?.task_count).toBe(1);
		expect(synth?.payload?.goal_id).toBe("GC-2026-T1-B");
	});

	it("(c) task_dispatch writes run/dispatch_started event with strategy + counts", async () => {
		// Setup: create goal + DAG first
		const gStub = makePiStub();
		registerGoalContractTool(gStub.pi);
		await gStub.getTool()!.execute("g", makeGoalInput("GC-2026-T1-C"), undefined, () => {}, { cwd: tmp });

		const dStub = makePiStub();
		registerDAGSynthesizerTool(dStub.pi);
		await dStub.getTool()!.execute(
			"d",
			{
				id: "DAG-2026-T1-C",
				goal_id: "GC-2026-T1-C",
				strategy: "auto",
				tasks: [
					{
						id: "T1",
						description: "test task",
						plane: "Foundation",
						priority: "high",
						depends_on: [],
						files: ["x"],
						subagent_type: "developer",
						batch: 1,
						isolation: {
							dag_id: "DAG-2026-T1-C",
							task_id: "T1",
							mode: "create",
						},
						tdd: "strict",
						prompt: "do the test thing",
						output_schema: { kind: "code_changes", fields: ["files_changed"] },
						acceptance: { covers: ["SC1"], self_check_cmd: "echo OK" },
					},
				],
				verbose: false,
			},
			undefined,
			() => {},
			{ cwd: tmp },
		);

		// Then dispatch
		const tStub = makePiStub();
		registerTaskDispatcherTool(tStub.pi);
		const result = await tStub.getTool()!.execute(
			"t",
			{ dag_id: "DAG-2026-T1-C", strategy: "auto" },
			undefined,
			() => {},
			{ cwd: tmp },
		);
		expect(result).toBeDefined();

		const state = readAuditState("DAG-2026-T1-C");
		expect(state).not.toBeNull();
		const events = (state as any).events as Array<{ name: string; payload?: any }>;
		const dispatch = events.find((e) => e.name === "run/dispatch_started");
		expect(dispatch).toBeDefined();
		expect(dispatch?.payload?.strategy).toBe("auto");
		expect(dispatch?.payload?.task_count).toBe(1);
	});
});