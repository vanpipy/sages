/**
 * goal-contract.test.ts — GC-2026-orchestrator-simplify
 *
 * Covers the simplified GoalContract (no success_criteria, no dag_id)
 * and the new `goal_contract_create` surface:
 *
 *   1. GoalContract round-trips with `_lock_hash` preserved
 *   2. goalContractToYaml omits optional rationale when absent
 *   3. buildGoalContract assigns created_at
 *   4. buildLockedGoalContract computes a 64-hex SHA-256
 *   5. loadGoalContract returns null when missing
 *   6. Validation: empty done_definition, empty id, empty title all reject
 *   7. Validation: missing rationale emits a soft warning, not an error
 *   8. Validation: empty scope.include emits a soft warning
 *   9. executeGoalContractCreate writes a valid yaml file + emits run/goal_created
 *  10. executeGoalContractCreate returns compact summary (no goal_contract unless verbose)
 * 11. next_step directs the LLM to workflow_run (canonical), not dag_synthesize or raw TaskCreate
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as yaml from "js-yaml";
import {
	buildGoalContract,
	buildLockedGoalContract,
	executeGoalContractCreate,
	goalContractToYaml,
	loadGoalContract,
} from "@/goal-contract.js";
import {
	atomicWriteOrchestratorFile,
	isGoalContractState,
	loadYamlOrchestratorFile,
} from "@/state-persistence.js";
import type { GoalContract } from "@/types.js";

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "goal-contract-test-"));
});

afterEach(() => {
	if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
});

const BASE_INPUT = {
	id: "GC-2026-orchestrator-simplify",
	title: "Drop 4 orchestrator tools and simplify goal schema",
	rationale: "Smaller surface area; orchestrator owns intent only",
	anti_goals: ["do not change pi-subagents or pi-tasks"],
	scope: { include: ["pi-orchestrator/src/"], exclude: ["pi-orchestrator/src/services/"] },
	constraints: { typecheck_required: true },
	done_definition: "All 8 SCs pass and typecheck is clean.",
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 — GoalContract interface has only the intent fields (no SCs, no dag_id)
// ─────────────────────────────────────────────────────────────────────────────

describe("GoalContract interface (GC-2026-orchestrator-simplify)", () => {
	it("T-1: buildGoalContract assigns created_at and copies intent fields", () => {
		const gc = buildGoalContract(BASE_INPUT as any);
		expect(gc.id).toBe(BASE_INPUT.id);
		expect(gc.title).toBe(BASE_INPUT.title);
		expect(gc.rationale).toBe(BASE_INPUT.rationale);
		expect(gc.anti_goals).toEqual(BASE_INPUT.anti_goals);
		expect(gc.scope).toEqual(BASE_INPUT.scope);
		expect(gc.constraints).toEqual(BASE_INPUT.constraints);
		expect(gc.done_definition).toBe(BASE_INPUT.done_definition);
		expect(typeof gc.created_at).toBe("string");
		expect(new Date(gc.created_at).toISOString()).toBe(gc.created_at);
	});

	it("T-2: buildGoalContract carries no success_criteria field (deleted)", () => {
		const gc = buildGoalContract(BASE_INPUT as any) as any;
		expect(gc.success_criteria).toBeUndefined();
	});

	it("T-3: buildGoalContract carries no dag_id field (deleted)", () => {
		const gc = buildGoalContract(BASE_INPUT as any) as any;
		expect(gc.dag_id).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 — goalContractToYaml emits intent fields + lock hash
// ─────────────────────────────────────────────────────────────────────────────

describe("goalContractToYaml (GC-2026-orchestrator-simplify)", () => {
	it("T-4: emits `_lock_hash` when present", () => {
		const locked = buildLockedGoalContract(BASE_INPUT as any);
		const serialized = goalContractToYaml(locked);
		expect(serialized).toMatch(/_lock_hash:/);
		const reparsed = yaml.load(serialized) as any;
		expect(reparsed._lock_hash).toBe(locked._lock_hash);
	});

	it("T-5: omits `_lock_hash` when absent", () => {
		const gc = buildGoalContract(BASE_INPUT as any);
		const serialized = goalContractToYaml(gc);
		expect(serialized).not.toMatch(/_lock_hash/);
	});

	it("T-6: round-trip preserves intent fields", () => {
		const gc = buildGoalContract(BASE_INPUT as any);
		const serialized = goalContractToYaml(gc);
		const reparsed = yaml.load(serialized) as GoalContract;
		expect(reparsed.id).toBe(gc.id);
		expect(reparsed.title).toBe(gc.title);
		expect(reparsed.rationale).toBe(gc.rationale);
		expect(reparsed.anti_goals).toEqual(gc.anti_goals);
		expect(reparsed.scope).toEqual(gc.scope);
		expect(reparsed.done_definition).toBe(gc.done_definition);
	});

	it("T-7: serialized yaml has NO success_criteria block (deleted)", () => {
		const gc = buildGoalContract(BASE_INPUT as any);
		const serialized = goalContractToYaml(gc);
		expect(serialized).not.toMatch(/^success_criteria:/m);
	});

	it("T-8: serialized yaml has NO dag_id line (deleted)", () => {
		const gc = buildGoalContract(BASE_INPUT as any);
		const serialized = goalContractToYaml(gc);
		expect(serialized).not.toMatch(/^dag_id:/m);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — Validators reject malformed input
// ─────────────────────────────────────────────────────────────────────────────

describe("validateGoalContract (GC-2026-orchestrator-simplify)", () => {
	it("T-9: missing done_definition is a hard error", () => {
		const r = (require("@/goal-contract.js") as typeof import("@/goal-contract.js")).validateGoalContract({
			...BASE_INPUT,
			done_definition: "",
		} as any);
		expect(r.valid).toBe(false);
		expect(r.errors.some((e: string) => e.includes("done_definition"))).toBe(true);
	});

	it("T-10: short done_definition (<10 chars) is a hard error", () => {
		const r = (require("@/goal-contract.js") as typeof import("@/goal-contract.js")).validateGoalContract({
			...BASE_INPUT,
			done_definition: "short",
		} as any);
		expect(r.valid).toBe(false);
		expect(r.errors.some((e: string) => e.includes("done_definition"))).toBe(true);
	});

	it("T-11: empty title is a hard error", () => {
		const r = (require("@/goal-contract.js") as typeof import("@/goal-contract.js")).validateGoalContract({
			...BASE_INPUT,
			title: "",
		} as any);
		expect(r.valid).toBe(false);
		expect(r.errors.some((e: string) => e.includes("title"))).toBe(true);
	});

	it("T-12: empty id is a hard error", () => {
		const r = (require("@/goal-contract.js") as typeof import("@/goal-contract.js")).validateGoalContract({
			...BASE_INPUT,
			id: "",
		} as any);
		expect(r.valid).toBe(false);
		expect(r.errors.some((e: string) => e.includes("id"))).toBe(true);
	});

	it("T-13: empty anti_goals is allowed (warning only)", () => {
		const r = (require("@/goal-contract.js") as typeof import("@/goal-contract.js")).validateGoalContract({
			...BASE_INPUT,
			anti_goals: [],
		} as any);
		expect(r.valid).toBe(true);
		expect(r.warnings.some((w: string) => w.includes("anti_goals"))).toBe(true);
	});

	it("T-14: missing rationale is allowed (warning only)", () => {
		const r = (require("@/goal-contract.js") as typeof import("@/goal-contract.js")).validateGoalContract({
			...BASE_INPUT,
			rationale: undefined,
		} as any);
		expect(r.valid).toBe(true);
		expect(r.warnings.some((w: string) => w.includes("rationale"))).toBe(true);
	});

	it("T-15: empty scope.include is allowed (warning only)", () => {
		const r = (require("@/goal-contract.js") as typeof import("@/goal-contract.js")).validateGoalContract({
			...BASE_INPUT,
			scope: { include: [], exclude: [] },
		} as any);
		expect(r.valid).toBe(true);
		expect(r.warnings.some((w: string) => w.includes("scope.include"))).toBe(true);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4 — loadGoalContract + persistence
// ─────────────────────────────────────────────────────────────────────────────

describe("loadGoalContract (GC-2026-orchestrator-simplify)", () => {
	it("T-16: returns null when file is missing", () => {
		expect(loadGoalContract(cwd, "GC-missing")).toBeNull();
	});

	it("T-17: loads a valid goal yaml (no dag_id, no success_criteria)", () => {
		const gc = buildGoalContract(BASE_INPUT as any);
		atomicWriteOrchestratorFile(cwd, `goal-${gc.id}.yaml`, yaml.dump(gc, { indent: 2, lineWidth: 120, noRefs: true }), {
			owner: "orchestrator",
			validate: isGoalContractState,
		});
		const loaded = loadGoalContract(cwd, gc.id);
		expect(loaded).not.toBeNull();
		expect(loaded!.id).toBe(gc.id);
		expect((loaded as any).success_criteria).toBeUndefined();
		expect((loaded as any).dag_id).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 5 — executeGoalContractCreate end-to-end
// ─────────────────────────────────────────────────────────────────────────────

describe("executeGoalContractCreate (GC-2026-orchestrator-simplify)", () => {
	it("T-18: writes the goal yaml file", async () => {
		const result = await executeGoalContractCreate(BASE_INPUT as any, { cwd });
		expect(result.details?.contract).toBeTruthy();
		const path = join(cwd, ".pi/orchestrator/goal-GC-2026-orchestrator-simplify.yaml");
		expect(existsSync(path)).toBe(true);
		const raw = readFileSync(path, "utf8");
		const parsed = yaml.load(raw) as any;
		expect(parsed.id).toBe(BASE_INPUT.id);
		expect(parsed.success_criteria).toBeUndefined();
		expect(parsed.dag_id).toBeUndefined();
	});

	it("T-19: returns compact summary by default (no goal_contract)", async () => {
		const result = await executeGoalContractCreate(BASE_INPUT as any, { cwd });
		const text = JSON.parse(result.content[0]!.text);
		expect(text.status).toBe("in_progress");
		expect(text.summary).toBeTruthy();
		expect(text.summary.id).toBe(BASE_INPUT.id);
		expect(text.goal_contract).toBeUndefined();
	});

	it("T-20: next_step directs the LLM to raw TaskCreate × N + TaskExecute (or decompose_task), NOT workflow_run (GC-2026-remove-workflow-run-prod)", async () => {
		const result = await executeGoalContractCreate(BASE_INPUT as any, { cwd });
		const text = JSON.parse(result.content[0]!.text);
		expect(text.next_step).toContain("TaskCreate");
		expect(text.next_step).toContain("decompose_task");
		expect(text.next_step).not.toContain("workflow_run");
		expect(text.next_step).not.toContain("dag_synthesize");
		// Post-GC-2026-remove-workflow-run-prod: next_step may mention
		// TaskExecute as part of the canonical 4-phase shape
		// (`TaskCreate × N + TaskExecute`); the old assertion that
		// excluded it was written when the only TaskCreate was the
		// raw escape-hatch path (no canonical shape).
		expect(text.next_step).toContain("TaskExecute");
	});

	it("T-21: verbose=true returns the full goal contract", async () => {
		const result = await executeGoalContractCreate(
			{ ...BASE_INPUT, verbose: true } as any,
			{ cwd },
		);
		const text = JSON.parse(result.content[0]!.text);
		expect(text.goal_contract).toBeTruthy();
		expect(text.goal_contract.id).toBe(BASE_INPUT.id);
	});

	it("T-22: validation errors return status='error' without writing", async () => {
		const result = await executeGoalContractCreate(
			{ ...BASE_INPUT, done_definition: "" } as any,
			{ cwd },
		);
		const text = JSON.parse(result.content[0]!.text);
		expect(text.status).toBe("error");
		expect(text.validation.errors.length).toBeGreaterThan(0);
		expect(existsSync(join(cwd, ".pi/orchestrator/goal-GC-2026-orchestrator-simplify.yaml"))).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — isGoalContractState accepts the simplified shape
// ─────────────────────────────────────────────────────────────────────────────

describe("isGoalContractState (GC-2026-orchestrator-simplify)", () => {
	it("T-23: accepts a simplified GoalContract (no success_criteria array)", () => {
		const gc = buildGoalContract(BASE_INPUT as any);
		expect(isGoalContractState(gc)).toBe(true);
	});

	it("T-24: rejects a value missing the intent fields", () => {
		expect(isGoalContractState({ id: "x" })).toBe(false);
		expect(isGoalContractState({})).toBe(false);
		expect(isGoalContractState(null)).toBe(false);
	});

	it("T-25: loadYamlOrchestratorFile loads a simplified goal yaml", () => {
		const gc = buildGoalContract(BASE_INPUT as any);
		atomicWriteOrchestratorFile(cwd, `goal-${gc.id}.yaml`, yaml.dump(gc, { indent: 2, lineWidth: 120, noRefs: true }), {
			owner: "orchestrator",
			validate: isGoalContractState,
		});
		const loaded = loadYamlOrchestratorFile(cwd, `goal-${gc.id}.yaml`, {
			owner: "orchestrator",
			validate: isGoalContractState,
		});
		expect(loaded).not.toBeNull();
		expect(loaded!.id).toBe(gc.id);
	});
});
