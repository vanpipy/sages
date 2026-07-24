/**
 * Tests for dag-synthesizer core validation logic.
 * Covers: cycle detection, batch contiguity, SC coverage,
 * cross-batch dependency direction, template whitelist, param validation.
 */

import { describe, it, expect } from "bun:test";
import { validateDAG, buildPlan } from "@/tools/orchestrator/dag-synthesizer.js";
import type { GoalContract } from "@/tools/orchestrator/types.js";

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
              task_template: "subagent-software-developer",
              task_params: {
                task_id: "P1",
                task_title: "test",
                sc_list: "- SC1: x",
                tdd_mode: "strict",
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
              task_template: "subagent-software-developer",
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
              subagent_type: "software-developer",
              batch: 2,
              isolation: "worktree",
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
            task_template: "subagent-software-developer",
            task_params: {
              task_id: "P1",
              task_title: "Implement X",
              sc_list: "- SC1: typecheck",
              tdd_mode: "strict",
              upstream_outputs: "(none)",
              files_to_touch: "src/x.ts",
            },
          }),
        ],
      },
      baseContract,
    );
    expect(plan.tasks[0].prompt).toContain("Implement X");
    expect(plan.tasks[0].prompt).toContain("STRICT TDD");
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