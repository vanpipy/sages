/**
 * Tests for dag-synthesizer core validation logic.
 * Covers: cycle detection, batch contiguity, SC coverage,
 * cross-batch dependency direction, template whitelist, param validation.
 *
 * GC-2026-091: executeDAGSynthesize now auto-syncs the dag_id back to
 * the goal contract (D2) and auto-compiles the todowrite view (D1) so
 * the plan → DAG → todo chain is programmatically reliable. Tests for
 * that behavior live at the bottom of this file.
 */

import { afterEach, beforeEach, describe, it, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import * as yaml from "js-yaml";
import {
	buildPlan,
	executeDAGSynthesize,
	loadGoalContract,
	TaskNodeSchema,
	validateDAG,
} from "@/dag-synthesizer.js";
import { loadTodoFile } from "@/todo-sync.js";
import { buildGoalContract, buildLockedGoalContract } from "@/goal-contract.js";
import { computeGoalHash } from "@/goal-lock.js";
import {
	atomicWriteOrchestratorFile,
	isGoalContractState,
} from "@/state-persistence.js";
import type { GoalContract, OrchestrationPlan } from "@/types.js";

const baseContract: GoalContract = {
  id: "GC-2025-test",
  title: "Test goal",
  rationale: "for tests",
  success_criteria: [
    { id: "SC1", criterion: "typecheck passes", verification_cmd: "npm run typecheck" },
    { id: "SC2", criterion: "tests pass", verification_cmd: "npm test" },
  ],
  anti_goals: [],
  scope: { include: ["src/"], exclude: [] },
  constraints: {},
  done_definition: "tests pass",
  created_at: "2025-01-01T00:00:00Z",
};

function makeTask(id: string, batch: number, deps: string[] = [], opts: any = {}) {
  return {
    id,
    description: `task ${id}`,
    plane: "Business",
    priority: "medium",
    depends_on: deps,
    files: [],
    subagent_type: opts.subagent_type ?? "Explore",
    batch,
    isolation: "none",
    tdd: "none",
    prompt: opts.prompt ?? `prompt for ${id}`,
    acceptance: { covers: opts.covers ?? [] },
    ...opts,
  };
}

describe("validateDAG", () => {
  describe("happy path", () => {
    it("accepts a simple 3-task DAG", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 1, [], { covers: ["SC1"] }),
            makeTask("P2", 2, ["P1"], { covers: ["SC2"] }),
            makeTask("P3", 3, ["P2"]),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe("task id validation", () => {
    it("rejects duplicate task ids", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 1, [], { covers: ["SC1"] }),
            makeTask("P1", 2, [], { covers: ["SC2"] }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("duplicate"))).toBe(true);
    });
  });

  describe("depends_on validation", () => {
    it("rejects dependency on non-existent task", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 1, ["P99"], { covers: ["SC1"] }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("non-existent 'P99'"))).toBe(true);
    });
  });

  describe("SC coverage", () => {
    it("rejects when an SC is not covered by any task", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 1, [], { covers: ["SC1"] }),
            // SC2 missing!
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("SC2") && e.includes("not covered"))).toBe(true);
    });

    it("accepts when all SCs are covered", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 1, [], { covers: ["SC1"] }),
            makeTask("P2", 2, ["P1"], { covers: ["SC2"] }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("cycle detection", () => {
    it("rejects A → B → A cycle", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("A", 1, ["B"], { covers: ["SC1"] }),
            makeTask("B", 2, ["A"], { covers: ["SC2"] }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("cycle"))).toBe(true);
    });

    it("rejects self-loop", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("A", 1, ["A"], { covers: ["SC1"] }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("cycle"))).toBe(true);
    });
  });

  describe("batch contiguity", () => {
    it("rejects non-contiguous batches (1, 3, no 2)", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 1, [], { covers: ["SC1"] }),
            makeTask("P2", 3, ["P1"], { covers: ["SC2"] }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("contiguous"))).toBe(true);
    });

    it("rejects batches not starting at 1 (2, 3)", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 2, [], { covers: ["SC1"] }),
            makeTask("P2", 3, ["P1"], { covers: ["SC2"] }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("contiguous"))).toBe(true);
    });
  });

  describe("within-batch independence", () => {
    it("rejects when two tasks in same batch depend on each other", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 1, ["P2"], { covers: ["SC1"] }),
            makeTask("P2", 1, ["P1"], { covers: ["SC2"] }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("same batch"))).toBe(true);
    });

    it("accepts independent tasks in the same batch", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 1, [], { covers: ["SC1"] }),
            makeTask("P2", 1, [], { covers: ["SC2"] }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe("cross-batch dependency direction", () => {
    it("rejects when task in batch N depends on task in batch >= N", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 2, [], { covers: ["SC1"] }),
            makeTask("P2", 1, ["P1"], { covers: ["SC2"] }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("must depend on earlier batch"))).toBe(true);
    });
  });

  describe("task_template validation", () => {
    it("rejects unknown task_template", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 1, [], {
              covers: ["SC1"],
              task_template: "fake-template-xxx",
              task_params: {},
            }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("fake-template-xxx") && e.includes("not a known template"))).toBe(true);
    });

    it("accepts known task_template with valid params", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 1, [], {
              covers: ["SC1"],
              task_template: "subagent-developer",
              task_params: {
                task_id: "P1",
                task_title: "test",
                sc_list: "- SC1: x",
                upstream_outputs: "(none)",
                files_to_touch: "src/x.ts",
              },
            }),
            makeTask("P2", 2, ["P1"], { covers: ["SC2"] }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(true);
    });

    it("rejects known task_template with missing required param", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 1, [], {
              covers: ["SC1"],
              task_template: "subagent-developer",
              task_params: { task_id: "P1" },  // missing most required
            }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("missing required"))).toBe(true);
    });
  });

  describe("subagent_type warnings", () => {
    it("warns on unknown subagent_type but doesn't fail", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 1, [], {
              covers: ["SC1", "SC2"],
              subagent_type: "made-up-agent-xxx",
            }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(true);
      expect(result.warnings.some(w => w.includes("made-up-agent-xxx"))).toBe(true);
    });
  });

  describe("optional fields accepted", () => {
    it("accepts run_in_background at the task level (per-task override)", () => {
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            makeTask("P1", 1, [], { covers: ["SC1", "SC2"], run_in_background: false }),
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("accepts tasks with no acceptance.covers (Explore / Plan research tasks)", () => {
      // Build a task that omits acceptance.covers (research-only).
      const result = validateDAG(
        {
          goal_id: "GC-2025-test",
          tasks: [
            {
              id: "P1",
              description: "find things",
              plane: "Observation",
              priority: "medium",
              depends_on: [],
              files: [],
              subagent_type: "Explore",
              batch: 1,
              isolation: "none",
              tdd: "none",
              prompt: "find all the things (long enough prompt)",
              acceptance: {},
              output_schema: { kind: "file_list" },
            },
            {
              id: "P2",
              description: "satisfy SC1",
              plane: "Business",
              priority: "high",
              depends_on: ["P1"],
              files: [],
              subagent_type: "developer",
              batch: 2,
              isolation: { dag_id: "DAG-test", task_id: "P2", mode: "create" },
              tdd: "strict",
              prompt: "implement the things (long enough prompt)",
              acceptance: { covers: ["SC1", "SC2"] },
              output_schema: { kind: "code_changes" },
            },
          ],
        },
        baseContract,
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("shipped DAG templates validate as-is", () => {
    // These two tests guard against the C4 regression: shipped templates
    // MUST validate without manual edit. The TDD test is RED if a future
    // commit removes `plane` / `priority` / `prompt` from a task.
    const fs = require("node:fs");
    const path = require("node:path");
    const yaml = require("js-yaml");

    function loadDag(rel: string) {
      const raw = fs.readFileSync(
        path.join(__dirname, "..", "..", "..", rel),
        "utf-8",
      );
      return yaml.load(raw) as any;
    }

    function goalContract(scIds: string[]) {
      return {
        id: "GC-shipped-test",
        title: "t",
        success_criteria: scIds.map((id) => ({ id, criterion: "ok", verification_cmd: "true" })),
        anti_goals: [],
        scope: { include: [], exclude: [] },
        constraints: {},
        done_definition: "ok",
        created_at: "2025-01-01T00:00:00Z",
      };
    }

    it("dag-bug-fix.yaml passes validateDAG", () => {
      const dag = loadDag("skills/orchestrator/templates/dag/dag-bug-fix.yaml");
      // Normalize: templates use a string for acceptance (sometimes empty
      // object). validateDAG already handles that.
      const result = validateDAG(
        { goal_id: "GC-shipped-test", tasks: dag.tasks },
        goalContract(["SC1", "SC2", "SC3", "SC4", "SC5"]),
      );
      if (!result.valid) {
        throw new Error("dag-bug-fix.yaml must validate as-shipped: " + JSON.stringify(result.errors));
      }
      expect(result.valid).toBe(true);
    });

    it("dag-tdd-refactor.yaml passes validateDAG", () => {
      const dag = loadDag("skills/orchestrator/templates/dag/dag-tdd-refactor.yaml");
      const result = validateDAG(
        { goal_id: "GC-shipped-test", tasks: dag.tasks },
        goalContract(["SC1", "SC2", "SC3", "SC4", "SC5"]),
      );
      if (!result.valid) {
        throw new Error("dag-tdd-refactor.yaml must validate as-shipped: " + JSON.stringify(result.errors));
      }
      expect(result.valid).toBe(true);
    });
  });
});

describe("buildPlan", () => {
  it("renders task_template prompt when set", () => {
    const plan = buildPlan(
      {
        goal_id: "GC-2025-test",
        tasks: [
          makeTask("P1", 1, [], {
            covers: ["SC1"],
            task_template: "subagent-developer",
            task_params: {
              task_id: "P1",
              task_title: "Implement X",
              sc_list: "- SC1: typecheck",
              upstream_outputs: "(none)",
              files_to_touch: "src/x.ts",
              acceptance_cmd: "bun test",
            },
          }),
        ],
      },
      baseContract,
    );
    expect(plan.tasks[0].prompt).toContain("Implement X");
    expect(plan.tasks[0].prompt).toContain("- SC1: typecheck");
    expect(plan.tasks[0].prompt).toContain("src/x.ts");
    // TDD discipline lives in the agent identity, not the task prompt.
    expect(plan.tasks[0].prompt).not.toContain("STRICT TDD");
  });

  it("falls back to LLM-written prompt when no task_template", () => {
    const llmPrompt = "This is a custom prompt written by the LLM directly.";
    const plan = buildPlan(
      {
        goal_id: "GC-2025-test",
        tasks: [makeTask("P1", 1, [], { covers: ["SC1"], prompt: llmPrompt })],
      },
      baseContract,
    );
    expect(plan.tasks[0].prompt).toBe(llmPrompt);
  });

  it("defaults all tasks to pending status", () => {
    const plan = buildPlan(
      {
        goal_id: "GC-2025-test",
        tasks: [
          makeTask("P1", 1, [], { covers: ["SC1"] }),
          makeTask("P2", 2, ["P1"], { covers: ["SC2"] }),
        ],
      },
      baseContract,
    );
    expect(plan.tasks.every(t => t.status === "pending")).toBe(true);
    expect(plan.tasks.every(t => t.retry_count === 0 && t.max_retries === 2)).toBe(true);
  });
});

describe("TaskNodeSchema — handoff_template (GC-2026-039)", () => {
  // GC-2026-039: developer tasks declare which HANDOFF.md template to use
  // when writing `.pi/orchestrator/handoff/<ws>/<task>-handoff.md`:
  //   - "standard"   — Template A (default for most tasks)
  //   - "phase-gate" — Template B (workspace will be merged by merger)
  //   - "escalation" — Template C (after 2+ failures; next agent reads it)
  //
  // The schema is the gate: only these three literals are accepted.
  // The dispatcher defaults missing values to "standard" (back-compat).

  function baseNode(extra: any = {}) {
    return {
      id: "P1",
      description: "task P1",
      plane: "Business",
      priority: "medium",
      depends_on: [],
      files: [],
      subagent_type: "developer",
      batch: 1,
      isolation: "none",
      tdd: "strict",
      prompt: "a sufficiently long prompt for the task that satisfies minLength",
      // TaskNodeSchema requires output_schema; include it so the
      // Value.Check rejects/refuses for handoff_template reasons only.
      output_schema: { kind: "code_changes" },
      acceptance: { covers: ["SC1"] },
      ...extra,
    };
  }

  it("accepts a developer task with handoff_template: 'standard'", () => {
    const node = baseNode({ handoff_template: "standard" });
    expect(Value.Check(TaskNodeSchema, node)).toBe(true);
  });

  it("accepts a developer task with handoff_template: 'phase-gate'", () => {
    const node = baseNode({ handoff_template: "phase-gate" });
    expect(Value.Check(TaskNodeSchema, node)).toBe(true);
  });

  it("accepts a developer task with handoff_template: 'escalation'", () => {
    const node = baseNode({ handoff_template: "escalation" });
    expect(Value.Check(TaskNodeSchema, node)).toBe(true);
  });

  it("accepts a developer task with handoff_template omitted (defaulted by dispatcher to 'standard')", () => {
    const node = baseNode();
    expect(Value.Check(TaskNodeSchema, node)).toBe(true);
  });

  it("rejects a developer task with an unknown handoff_template value", () => {
    // The schema is a strict union; "custom" / "phase-gate-v2" / etc.
    // are not allowed. The dispatcher defaults missing values to
    // "standard", so authors either pick one of the three or omit it.
    const node = baseNode({ handoff_template: "custom" });
    expect(Value.Check(TaskNodeSchema, node)).toBe(false);
  });

  it("buildPlan preserves handoff_template from input to output (passes through the DAG)", () => {
    // The dispatcher reads `handoff_template` from the TaskNode, so
    // buildPlan must NOT drop it during the rendering pass.
    const plan = buildPlan(
      {
        goal_id: "GC-2025-test",
        tasks: [
          makeTask("P1", 1, [], {
            covers: ["SC1"],
            subagent_type: "developer",
            handoff_template: "phase-gate",
          }),
        ],
      },
      baseContract,
    );
    // Cast through `any` for the runtime check: the TaskNode interface
    // doesn't yet declare handoff_template (this is the RED test that
    // drives the schema + types.ts change). Once types.ts adds the
    // field, the cast is still valid (it's just a wider type) and the
    // assertion still locks the runtime behavior.
    expect((plan.tasks[0] as any).handoff_template).toBe("phase-gate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GC-2026-091: executeDAGSynthesize auto-syncs dag_id to goal contract (D2)
// and auto-compiles the todowrite view (D1) so the plan → DAG → todo
// chain is programmatically reliable.
// ─────────────────────────────────────────────────────────────────────────────

let gc091Cwd: string;

beforeEach(() => {
  gc091Cwd = mkdtempSync(join(tmpdir(), "dag-synthesizer-091-test-"));
});

afterEach(() => {
  if (existsSync(gc091Cwd)) rmSync(gc091Cwd, { recursive: true, force: true });
});

const GOAL_091_INPUT = {
  id: "GC-2026-091",
  title: "Reliable plan → DAG → todo chain",
  rationale: "Program-level reliability for orchestrator state handoff",
  success_criteria: [
    { id: "SC1", criterion: "goal.yaml gains dag_id after dag_synthesize", verification_cmd: "bun run check:all" },
    { id: "SC2", criterion: "todo file gains goal_id after todowrite_compile", verification_cmd: "bun run check:all" },
  ],
  anti_goals: ["do not change Magic Context internals"],
  scope: { include: ["pi-orchestrator/src/"], exclude: ["pi-orchestrator/src/services/"] },
  constraints: {},
  done_definition: "All SCs pass and lock hash recomputes on every write",
};

function writeGoal(cwd: string, goal: GoalContract & { _lock_hash?: string }): void {
  atomicWriteOrchestratorFile(cwd, `goal-${goal.id}.yaml`, yaml.dump(goal, { indent: 2, lineWidth: 120, noRefs: true }), {
    owner: "orchestrator",
    validate: isGoalContractState,
  });
}

function makeDagInput(id: string, goalId: string) {
  return {
    goal_id: goalId,
    tasks: [
      {
        id: "P1",
        description: "Implement goal_id field on TodoFile",
        plane: "Business" as const,
        priority: "high" as const,
        depends_on: [],
        files: ["pi-orchestrator/src/todowrite.ts"],
        subagent_type: "developer",
        batch: 1,
        isolation: "none" as const,
        tdd: "strict" as const,
        prompt: "Add `goal_id?: string` to TodoFile and populate from plan.goal_id in executeTodowriteCompile",
        acceptance: { covers: ["SC1", "SC2"] },
        output_schema: { kind: "code_changes" as const },
        status: "pending" as const,
        retry_count: 0,
        max_retries: 2,
      },
    ],
  };
}

describe("executeDAGSynthesize — GC-2026-091 plan → DAG → todo auto-sync", () => {
  it("D2-1: writes dag_id back to the goal contract after the DAG is persisted", async () => {
    const goal = buildGoalContract(GOAL_091_INPUT as any);
    writeGoal(gc091Cwd, goal);

    const result = await executeDAGSynthesize(
      makeDagInput("DAG-2026-091", "GC-2026-091") as any,
      { cwd: gc091Cwd },
    );
    expect(result.details).toBeTruthy();
    expect(result.details!.plan.id).toBe("DAG-2026-091");

    // The goal yaml on disk should now carry dag_id.
    const reloaded = loadGoalContract(gc091Cwd, "GC-2026-091");
    expect(reloaded).not.toBeNull();
    expect(reloaded!.dag_id).toBe("DAG-2026-091");
  });

  it("D2-2: recomputes _lock_hash on the goal contract when one was set", async () => {
    // Use the locked variant so we exercise the hash recomputation path.
    const goal = buildLockedGoalContract(GOAL_091_INPUT as any);
    const priorHash = goal._lock_hash;
    expect(priorHash).toBeTruthy();
    writeGoal(gc091Cwd, goal);

    await executeDAGSynthesize(
      makeDagInput("DAG-2026-091", "GC-2026-091") as any,
      { cwd: gc091Cwd },
    );

    // Read raw yaml to inspect the persisted _lock_hash directly —
    // loadGoalContract casts through GoalContract which doesn't expose
    // _lock_hash, but the writeback helper must have written it.
    const raw = readFileSync(join(gc091Cwd, ".pi/orchestrator/goal-GC-2026-091.yaml"), "utf8");
    const parsed = yaml.load(raw) as Record<string, unknown>;
    expect(parsed.dag_id).toBe("DAG-2026-091");
    expect(typeof parsed._lock_hash).toBe("string");
    // The new hash MUST equal computeGoalHash of the augmented goal
    // (with dag_id set) — which differs from the prior hash because
    // dag_id is now part of HASHED_FIELDS.
    const augmented = { ...goal, dag_id: "DAG-2026-091" };
    const expected = computeGoalHash(augmented as any);
    expect(parsed._lock_hash).toBe(expected);
    expect(parsed._lock_hash).not.toBe(priorHash);
  });

  it("D1-1: auto-compiles the todowrite view AFTER the DAG is persisted", async () => {
    const goal = buildGoalContract(GOAL_091_INPUT as any);
    writeGoal(gc091Cwd, goal);

    await executeDAGSynthesize(
      makeDagInput("DAG-2026-091", "GC-2026-091") as any,
      { cwd: gc091Cwd },
    );

    // The todo file should exist and carry both dag_id and goal_id.
    const todoPath = join(gc091Cwd, ".pi/orchestrator/todo-DAG-2026-091.yaml");
    expect(existsSync(todoPath)).toBe(true);
    const todo = loadTodoFile(gc091Cwd, "DAG-2026-091");
    expect(todo).not.toBeNull();
    expect(todo!.dag_id).toBe("DAG-2026-091");
    expect(todo!.goal_id).toBe("GC-2026-091");
    expect(todo!.items.length).toBe(1);
  });

  it("D1+D2 order: todo file's goal_id is set BEFORE the goal writeback so it doesn't dangle", async () => {
    // The spec mandates order: D1 (todowrite_compile) before D2
    // (goal writeback). Why: if D2 ran first, the todo file would be
    // missing goal_id even though the goal contract now points at it.
    // The order check is structural — we verify the artifacts at the
    // end of the call, but the ordering is encoded in executeDAGSynthesize.
    const goal = buildGoalContract(GOAL_091_INPUT as any);
    writeGoal(gc091Cwd, goal);

    await executeDAGSynthesize(
      makeDagInput("DAG-2026-091", "GC-2026-091") as any,
      { cwd: gc091Cwd },
    );

    const todo = loadTodoFile(gc091Cwd, "DAG-2026-091");
    expect(todo!.goal_id).toBe("GC-2026-091");
    const reloaded = loadGoalContract(gc091Cwd, "GC-2026-091");
    expect(reloaded!.dag_id).toBe("DAG-2026-091");
    // Both edges consistent: goal_id on todo matches the goal's id,
    // and the goal's dag_id matches the todo's dag_id.
    expect(todo!.goal_id).toBe(reloaded!.id);
    expect(reloaded!.dag_id).toBe(todo!.dag_id);
  });

  it("ToolResult still wraps the synthesis response (post-compile)", async () => {
    // Regression guard: the auto-sync additions must not change the
    // outer ToolResult shape returned by executeDAGSynthesize. The
    // call must still return `{ content: [{ type: "text", text: ... }] }`
    // and the JSON inside must include the same `summary` / `next_step`
    // fields that the LLM relies on.
    const goal = buildGoalContract(GOAL_091_INPUT as any);
    writeGoal(gc091Cwd, goal);

    const result = await executeDAGSynthesize(
      makeDagInput("DAG-2026-091", "GC-2026-091") as any,
      { cwd: gc091Cwd },
    );
    expect(Array.isArray(result.content)).toBe(true);
    const parsed = JSON.parse(result.content[0]!.text);
    expect(parsed.status).toBe("in_progress");
    expect(parsed.summary).toBeTruthy();
    expect(parsed.next_step).toContain("task_dispatch");
  });
});