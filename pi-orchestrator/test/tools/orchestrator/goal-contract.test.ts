/**
 * goal-contract.test.ts — GC-2026-091
 *
 * Covers the structural link between a GoalContract and its synthesized DAG:
 *   1. GoalContract round-trips with the optional `dag_id` field (C step)
 *   2. GoalContractToYaml emits `dag_id` when present, omits otherwise (C step)
 *   3. Legacy goal YAMLs without `dag_id` still validate and load (B step)
 *   4. Writeback with new `dag_id` recomputes `_lock_hash` to keep the lock
 *      consistent with the augmented content (C step)
 *
 * These tests are the TDD RED gate for phases (A) + (B) + (C) of GC-2026-091 T1.
 * They are written against the contract in
 * `.pi/orchestrator/goal-GC-2026-091.yaml` (the orchestrator's binary
 * success criterion: "After dag_synthesize, the goal yaml contains
 * `dag_id:` and the persisted lock hash matches the recomputed value").
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
} from "@/goal-contract.js";
import { loadGoalContract } from "@/dag-synthesizer.js";
import { computeGoalHash, checkGoalLock } from "@/goal-lock.js";
import {
	atomicWriteOrchestratorFile,
	isGoalContractState,
	loadYamlOrchestratorFile,
} from "@/state-persistence.js";
import type { GoalContract } from "@/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

let cwd: string;

beforeEach(() => {
	cwd = mkdtempSync(join(tmpdir(), "goal-contract-test-"));
});

afterEach(() => {
	if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
});

const BASE_INPUT = {
	id: "GC-2026-091",
	title: "Reliable plan → DAG → todo chain",
	rationale: "Program-level reliability for orchestrator state handoff",
	success_criteria: [
		{ id: "SC1", criterion: "goal.yaml gains dag_id after dag_synthesize", verification_cmd: "bun run check:all" },
		{ id: "SC2", criterion: "todo file gains goal_id after todowrite_compile", verification_cmd: "bun run check:all" },
	],
	anti_goals: ["do not change Magic Context internals"],
	scope: { include: ["pi-orchestrator/src/"], exclude: ["pi-orchestrator/src/services/"] },
	constraints: { typecheck_required: true },
	done_definition: "All SCs pass and lock hash recomputes on every write",
};

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 (A) + 3 (C) — GoalContract interface has optional `dag_id`
// ─────────────────────────────────────────────────────────────────────────────

describe("GoalContract interface — GC-2026-091", () => {
	it("Type-1: GoalContract interface declares optional `dag_id?: string`", () => {
		// The compile-time check: a value typed as GoalContract may
		// carry dag_id without TypeScript error. We can't introspect
		// the interface at runtime, so we exercise the assignment shape
		// via buildGoalContract → spread → set dag_id. If the field
		// isn't on the interface, the cast would be redundant, but the
		// assignment itself must compile cleanly under strict mode.
		const gc = buildGoalContract(BASE_INPUT as any);
		const augmented: GoalContract = { ...gc, dag_id: "DAG-2026-091" };
		expect(augmented.dag_id).toBe("DAG-2026-091");
	});

	it("Type-2: GoalContract without dag_id is well-formed (dag_id is optional)", () => {
		const gc = buildGoalContract(BASE_INPUT as any);
		expect(gc.dag_id).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 (C) — goalContractToYaml emits `dag_id` when present
// ─────────────────────────────────────────────────────────────────────────────

describe("goalContractToYaml — GC-2026-091", () => {
	it("GCY-1: emits `dag_id: \"<id>\"` when present", () => {
		const gc: GoalContract = {
			...buildGoalContract(BASE_INPUT as any),
			dag_id: "DAG-2026-091",
		};
		const serialized = goalContractToYaml(gc);
		expect(serialized).toMatch(/^dag_id: "DAG-2026-091"/m);
	});

	it("GCY-2: omits `dag_id` line when absent (no empty / null placeholder)", () => {
		const gc = buildGoalContract(BASE_INPUT as any);
		const serialized = goalContractToYaml(gc);
		expect(serialized).not.toMatch(/^dag_id:/m);
	});

	it("GCY-3: round-trip — emitted YAML parses back with the same dag_id", () => {
		const original: GoalContract = {
			...buildGoalContract(BASE_INPUT as any),
			dag_id: "DAG-2026-091-T1",
		};
		const serialized = goalContractToYaml(original);
		const reparsed = yaml.load(serialized) as GoalContract;
		expect(reparsed.dag_id).toBe("DAG-2026-091-T1");
		expect(reparsed.id).toBe(original.id);
		expect(reparsed.success_criteria.length).toBe(original.success_criteria.length);
	});

	it("GCY-4: round-trip — emitted YAML preserves _lock_hash when present", () => {
		const locked = buildLockedGoalContract(BASE_INPUT as any);
		const withDag = { ...locked, dag_id: "DAG-2026-091-T1" };
		const serialized = goalContractToYaml(withDag);
		expect(serialized).toMatch(/_lock_hash:/);
		const reparsed = yaml.load(serialized) as any;
		expect(reparsed._lock_hash).toBe(locked._lock_hash);
	});

	it("GCY-5: emits dag_id AFTER done_definition in serialized YAML (interface ordering)", () => {
		// The GC-2026-091 spec puts dag_id after done_definition in the
		// interface; goalContractToYaml should not break that contract
		// by emitting dag_id before done_definition in the YAML.
		const gc: GoalContract = {
			...buildGoalContract(BASE_INPUT as any),
			dag_id: "DAG-2026-091",
		};
		const serialized = goalContractToYaml(gc);
		const doneIdx = serialized.indexOf("done_definition:");
		const dagIdx = serialized.indexOf("dag_id:");
		expect(doneIdx).toBeGreaterThan(0);
		expect(dagIdx).toBeGreaterThan(doneIdx);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2 (B) — Validators accept legacy goal YAMLs (no dag_id)
// ─────────────────────────────────────────────────────────────────────────────

describe("isGoalContractState — GC-2026-091 (legacy compatibility)", () => {
	it("VAL-1: accepts a legacy GoalContract value (no dag_id field)", () => {
		const gc = buildGoalContract(BASE_INPUT as any);
		const legacy = { ...gc };
		delete (legacy as { dag_id?: string }).dag_id;
		expect(isGoalContractState(legacy)).toBe(true);
	});

	it("VAL-2: accepts a GoalContract value with dag_id (forward compatibility)", () => {
		const gc: GoalContract = { ...buildGoalContract(BASE_INPUT as any), dag_id: "DAG-2026-091" };
		expect(isGoalContractState(gc)).toBe(true);
	});

	it("VAL-3: loadYamlOrchestratorFile loads a legacy goal.yaml without dag_id", () => {
		// Write a goal yaml that pre-dates GC-2026-091 (no dag_id).
		const legacy = buildGoalContract(BASE_INPUT as any);
		atomicWriteOrchestratorFile(cwd, `goal-${legacy.id}.yaml`, yaml.dump(legacy, { indent: 2, lineWidth: 120, noRefs: true }), {
			owner: "orchestrator",
			validate: isGoalContractState,
		});
		const loaded = loadYamlOrchestratorFile(cwd, `goal-${legacy.id}.yaml`, {
			owner: "orchestrator",
			validate: isGoalContractState,
		});
		expect(loaded).not.toBeNull();
		expect(loaded!.dag_id).toBeUndefined();
		expect(loaded!.id).toBe(legacy.id);
	});

	it("VAL-4: loadGoalContract returns the goal without dag_id for legacy yaml", () => {
		const legacy = buildGoalContract(BASE_INPUT as any);
		atomicWriteOrchestratorFile(cwd, `goal-${legacy.id}.yaml`, yaml.dump(legacy, { indent: 2, lineWidth: 120, noRefs: true }), {
			owner: "orchestrator",
			validate: isGoalContractState,
		});
		const loaded = loadGoalContract(cwd, legacy.id);
		expect(loaded).not.toBeNull();
		expect(loaded!.dag_id).toBeUndefined();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 (C) — Lock-hash recomputation when dag_id is added at writeback
// ─────────────────────────────────────────────────────────────────────────────

describe("lock-hash recomputation on dag_id writeback — GC-2026-091", () => {
	it("LH-1: writeback recomputes _lock_hash so the lock stays consistent", () => {
		// Simulate the dag_synthesizer writeback: take an existing
		// locked goal, set dag_id, recompute the lock hash.
		const locked = buildLockedGoalContract(BASE_INPUT as any);
		expect(locked._lock_hash).toBeTruthy();
		// Sanity: write the locked goal to disk as the prior state.
		atomicWriteOrchestratorFile(cwd, `goal-${locked.id}.yaml`, yaml.dump(locked, { indent: 2, lineWidth: 120, noRefs: true }), {
			owner: "orchestrator",
			validate: isGoalContractState,
		});

		// Read it back the way dag_synthesizer would.
		const prior = loadGoalContract(cwd, locked.id)!;
		// Now add dag_id and recompute the lock hash.
		const augmented: GoalContract & { _lock_hash?: string } = {
			...prior,
			dag_id: "DAG-2026-091",
		};
		const recomputed = computeGoalHash(augmented);
		augmented._lock_hash = recomputed;

		// Write back through goalContractToYaml (which must now emit
		// dag_id) and round-trip via loadGoalContract.
		const serialized = goalContractToYaml(augmented);
		atomicWriteOrchestratorFile(cwd, `goal-${locked.id}.yaml`, serialized, {
			owner: "orchestrator",
			validate: isGoalContractState,
		});
		const after = loadGoalContract(cwd, locked.id) as GoalContract & { _lock_hash?: string };
		expect(after.dag_id).toBe("DAG-2026-091");
		expect(after._lock_hash).toBe(recomputed);
		// Lock is intact after writeback.
		const check = checkGoalLock(after, { mode: "audit" });
		expect(check.intact).toBe(true);
	});

	it("LH-2: a prior locked goal (no dag_id) has a different hash than the dag_id-augmented version", () => {
		// This is the literal "adding dag_id invalidates a prior hash"
		// property from the spec. The hash can either be content-sensitive
		// (dag_id in HASHED_FIELDS) or the spec might just require
		// recompute-without-content-shift. Either way, after writeback the
		// stored _lock_hash MUST match the recomputed hash for the
		// augmented content. We check that the recomputed hash is the
		// canonical value for the augmented goal, which is what makes the
		// writeback self-consistent.
		const locked = buildLockedGoalContract(BASE_INPUT as any);
		const augmented = { ...locked, dag_id: "DAG-2026-091" };
		const recomputed = computeGoalHash(augmented);
		// The writeback MUST set _lock_hash to the recomputed value,
		// NOT keep the prior value.
		expect(recomputed).not.toBe(locked._lock_hash);
		// Specifically: the recomputed hash equals computeGoalHash of
		// the augmented goal (the contract for "recompute on writeback").
		expect(recomputed).toBe(computeGoalHash(augmented));
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end: executeGoalContractCreate still works without dag_id
// ─────────────────────────────────────────────────────────────────────────────

describe("executeGoalContractCreate — backward compatibility", () => {
	it("E2E-1: writes a goal.yaml without dag_id (legacy behavior preserved)", async () => {
		const result = await executeGoalContractCreate(BASE_INPUT as any, { cwd });
		expect(result.details?.contract).toBeTruthy();
		expect(result.details!.contract.dag_id).toBeUndefined();
		const path = join(cwd, ".pi/orchestrator/goal-GC-2026-091.yaml");
		expect(existsSync(path)).toBe(true);
		const raw = readFileSync(path, "utf8");
		const parsed = yaml.load(raw) as any;
		expect(parsed.dag_id).toBeUndefined();
		expect(parsed.id).toBe("GC-2026-091");
	});
});