/**
 * dag-compile tests — GC-2026-061 todo→DAG compile bridge.
 *
 * Covers `compileDagFromTodos` / `dagToPlanYaml` / `writeCompiledDag`
 * (pi/src/tools/todo/dag-compile.ts):
 *  - task-level todos (kind 'task', depends_on present, or batch present)
 *    compile into TaskNodes with the documented defaults;
 *  - plain plan-level todos are excluded from the DAG;
 *  - batches auto-assign by depends_on topology (longest-path layering);
 *  - explicit batches are respected, and a topology conflict (dependency
 *    in a later batch) throws;
 *  - depends_on cycles throw with the offending path;
 *  - task ids normalize to /^[A-Z0-9]+(\.[a-z])?$/ and stay unique;
 *  - dagId is deterministic (goal-derived when a goalId is given);
 *  - round-trip: dagToPlanYaml → writeCompiledDag → loadPlan yields the
 *    same task ids / batches / descriptions;
 *  - writeCompiledDag writes <cwd>/.pi/orchestrator/dag-<id>.yaml.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan } from "@/tools/orchestrator/dag-synthesizer.js";
import {
  compileDagFromTodos,
  compiledDagPath,
  dagToPlanYaml,
  writeCompiledDag,
  type DagTodoItem,
} from "@/tools/todo/dag-compile.js";

const TASK_ID_RE = /^[A-Z0-9]+(\.[a-z])?$/;

/** Todo factory — structured extras are explicit so the default is a plain plan-level item. */
const todo = (content: string, extra: Partial<DagTodoItem> = {}): DagTodoItem => ({
  content,
  status: "pending",
  ...extra,
});

describe("compileDagFromTodos — structure detection", () => {
  it("compiles task-level todos into TaskNodes with the documented defaults", () => {
    const dag = compileDagFromTodos([
      todo("Implement the parser", {
        id: "P1",
        kind: "task",
        depends_on: [],
        files: ["pi/src/parser.ts"],
        prompt: "Write the parser with TDD.",
      }),
    ]);

    expect(dag.tasks).toHaveLength(1);
    const task = dag.tasks[0];
    expect(task.id).toBe("P1");
    expect(task.description).toBe("Implement the parser");
    expect(task.plane).toBe("Foundation");
    expect(task.priority).toBe("medium");
    expect(task.depends_on).toEqual([]);
    expect(task.files).toEqual(["pi/src/parser.ts"]);
    expect(task.subagent_type).toBe("developer");
    expect(task.batch).toBe(1);
    expect(task.tdd).toBe("none");
    expect(task.prompt).toBe("Write the parser with TDD.");
    expect(task.output_schema).toEqual({ kind: "code_changes" });
    expect(task.acceptance).toEqual({ covers: [], self_check_cmd: "", auditor_check_cmd: "" });
    expect(task.status).toBe("pending");
    expect(task.retry_count).toBe(0);
    expect(task.max_retries).toBe(2);
  });

  it("treats a todo with only depends_on or batch as structured too", () => {
    const dag = compileDagFromTodos([
      todo("Task A", { id: "A1", depends_on: [] }),
      todo("Task B", { id: "B1", batch: 2, depends_on: ["A1"] }),
    ]);
    expect(dag.tasks.map((t) => t.id).sort()).toEqual(["A1", "B1"]);
  });

  it("excludes plain plan-level todos (no kind, depends_on, or batch)", () => {
    const dag = compileDagFromTodos([
      todo("Remind me to update the README", { priority: "low" }),
      todo("Task A", { id: "A1", kind: "task" }),
      todo("Also a plan item"),
    ]);
    expect(dag.tasks.map((t) => t.id)).toEqual(["A1"]);
    expect(dag.tasks[0].description).toBe("Task A");
  });

  it("excludes kind 'plan' todos that carry no DAG structure", () => {
    const dag = compileDagFromTodos([
      todo("Plain plan action", { kind: "plan" }),
      todo("Real task", { id: "T1", kind: "task" }),
    ]);
    expect(dag.tasks.map((t) => t.id)).toEqual(["T1"]);
  });
});

describe("compileDagFromTodos — task ids", () => {
  it("uses a valid explicit id as-is", () => {
    const dag = compileDagFromTodos([todo("x", { id: "P2.a", kind: "task" })]);
    expect(dag.tasks[0].id).toBe("P2.a");
  });

  it("normalizes an explicit id into the /^[A-Z0-9]+(\.[a-z])?$/ pattern", () => {
    const dag = compileDagFromTodos([
      todo("x", { id: "p1", kind: "task" }),
      todo("y", { id: "my-task-id", kind: "task" }),
    ]);
    expect(dag.tasks.map((t) => t.id)).toEqual(["P1", "MYTASKID"]);
    for (const t of dag.tasks) expect(t.id).toMatch(TASK_ID_RE);
  });

  it("derives a slug from content when no id is present", () => {
    const dag = compileDagFromTodos([
      todo("Implement the parser", { kind: "task" }),
      todo("Write unit tests", { kind: "task" }),
    ]);
    expect(dag.tasks[0].id).toBe("IMPLEMENT");
    expect(dag.tasks[1].id).toBe("WRITE");
    for (const t of dag.tasks) expect(t.id).toMatch(TASK_ID_RE);
  });

  it("falls back to a T<n> slug and keeps derived ids unique", () => {
    const dag = compileDagFromTodos([
      todo("###", { kind: "task" }),
      todo("IMPLEMENT", { kind: "task" }),
      todo("Write tests", { kind: "task" }),
    ]);
    const ids = dag.tasks.map((t) => t.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(TASK_ID_RE);
  });

  it("throws on duplicate explicit ids", () => {
    expect(() =>
      compileDagFromTodos([
        todo("x", { id: "P1", kind: "task" }),
        todo("y", { id: "p1", kind: "task" }),
      ]),
    ).toThrow(/duplicate task id/i);
  });
});

describe("compileDagFromTodos — batch assignment", () => {
  it("auto-assigns batches by depends_on topology (longest-path layering)", () => {
    const dag = compileDagFromTodos([
      todo("A", { id: "A1", kind: "task" }),
      todo("B", { id: "B1", kind: "task", depends_on: ["A1"] }),
      todo("C", { id: "C1", kind: "task", depends_on: ["A1"] }),
      todo("D", { id: "D1", kind: "task", depends_on: ["B1", "C1"] }),
    ]);
    const batchOf = new Map(dag.tasks.map((t) => [t.id, t.batch]));
    expect(batchOf.get("A1")).toBe(1);
    expect(batchOf.get("B1")).toBe(2);
    expect(batchOf.get("C1")).toBe(2);
    expect(batchOf.get("D1")).toBe(3);
  });

  it("layers a serial chain 1..N", () => {
    const dag = compileDagFromTodos([
      todo("T1", { id: "T1", kind: "task" }),
      todo("T2", { id: "T2", kind: "task", depends_on: ["T1"] }),
      todo("T3", { id: "T3", kind: "task", depends_on: ["T2"] }),
      todo("T4", { id: "T4", kind: "task", depends_on: ["T3"] }),
    ]);
    expect(dag.tasks.map((t) => t.batch)).toEqual([1, 2, 3, 4]);
  });

  it("respects explicit batches", () => {
    const dag = compileDagFromTodos([
      todo("A", { id: "A1", kind: "task", batch: 1 }),
      todo("B", { id: "B1", kind: "task", batch: 2, depends_on: ["A1"] }),
    ]);
    expect(dag.tasks.map((t) => t.batch)).toEqual([1, 2]);
  });

  it("throws when a dependency sits in a later batch than its dependent", () => {
    expect(() =>
      compileDagFromTodos([
        todo("A", { id: "A1", kind: "task", batch: 2 }),
        todo("B", { id: "B1", kind: "task", batch: 1, depends_on: ["A1"] }),
      ]),
    ).toThrow(/batch conflict/);
  });

  it("throws when a dependency shares its dependent's batch", () => {
    expect(() =>
      compileDagFromTodos([
        todo("A", { id: "A1", kind: "task", batch: 1 }),
        todo("B", { id: "B1", kind: "task", batch: 1, depends_on: ["A1"] }),
      ]),
    ).toThrow(/batch conflict/);
  });

  it("throws on a non-positive explicit batch", () => {
    expect(() =>
      compileDagFromTodos([todo("A", { id: "A1", kind: "task", batch: 0 })]),
    ).toThrow(/batch/i);
  });
});

describe("compileDagFromTodos — cycle detection", () => {
  it("throws with the offending path on a depends_on cycle", () => {
    expect(() =>
      compileDagFromTodos([
        todo("A", { id: "A1", kind: "task", depends_on: ["B1"] }),
        todo("B", { id: "B1", kind: "task", depends_on: ["A1"] }),
      ]),
    ).toThrow(/cycle detected in depends_on: A1 -> B1 -> A1/);
  });

  it("throws on a self-dependency", () => {
    expect(() =>
      compileDagFromTodos([todo("A", { id: "A1", kind: "task", depends_on: ["A1"] })]),
    ).toThrow(/cycle detected in depends_on/);
  });

  it("ignores depends_on refs to excluded plan-level todos (kept as declared)", () => {
    const dag = compileDagFromTodos([
      todo("plan item", { id: "PLAN1" }),
      todo("A", { id: "A1", kind: "task", depends_on: ["PLAN1"] }),
    ]);
    expect(dag.tasks).toHaveLength(1);
    expect(dag.tasks[0].depends_on).toEqual(["PLAN1"]);
    expect(dag.tasks[0].batch).toBe(1);
  });
});

describe("compileDagFromTodos — dagId", () => {
  it("derives DAG-<goalId> when a goalId is given (GC- stripped)", () => {
    const dag = compileDagFromTodos([todo("A", { id: "A1", kind: "task" })], {
      goalId: "GC-2026-061",
    });
    expect(dag.dagId).toBe("DAG-2026-061");
    expect(dag.goalId).toBe("GC-2026-061");
  });

  it("honors an explicit dagId", () => {
    const dag = compileDagFromTodos([todo("A", { id: "A1", kind: "task" })], {
      dagId: "DAG-custom",
    });
    expect(dag.dagId).toBe("DAG-custom");
  });

  it("is deterministic and stable for the same todos without a goal", () => {
    const todos = [
      todo("A", { id: "A1", kind: "task" }),
      todo("B", { id: "B1", kind: "task", depends_on: ["A1"] }),
    ];
    const first = compileDagFromTodos(todos);
    const second = compileDagFromTodos(todos);
    expect(second.dagId).toBe(first.dagId);
    expect(first.dagId).toMatch(/^DAG-[0-9A-F]{8}$/);
    expect(first.dagId).not.toBe(
      compileDagFromTodos([todo("A", { id: "A1", kind: "task" })]).dagId,
    );
  });
});

describe("dagToPlanYaml — round-trip via loadPlan", () => {
  it("serializes in the planToYaml shape and parses back with equal ids/batches", () => {
    const todos = [
      todo("Task A", { id: "P1", kind: "task" }),
      todo("Task B", { id: "P2", kind: "task", depends_on: ["P1"], files: ["pi/src/b.ts"] }),
      todo("plan item", { content: "not a task" }),
    ];
    const dag = compileDagFromTodos(todos, { goalId: "GC-2026-061" });
    const yamlText = dagToPlanYaml(dag);

    const dir = mkdtempSync(join(tmpdir(), "dag-compile-rt-"));
    try {
      const written = writeCompiledDag(yamlText, dir);
      expect(written).toBe(compiledDagPath(dir, dag.dagId));
      expect(existsSync(join(dir, ".pi", "orchestrator", `dag-${dag.dagId}.yaml`))).toBe(true);

      const plan = loadPlan(dir, dag.dagId);
      expect(plan).not.toBeNull();
      expect(plan!.id).toBe(dag.dagId);
      expect(plan!.goal_id).toBe("GC-2026-061");
      expect(plan!.tasks.map((t) => t.id)).toEqual(dag.tasks.map((t) => t.id));
      expect(plan!.tasks.map((t) => t.batch)).toEqual(dag.tasks.map((t) => t.batch));
      expect(plan!.tasks.map((t) => t.description)).toEqual(dag.tasks.map((t) => t.description));
      // plan-level todo must NOT appear in the serialized DAG
      expect(plan!.tasks.some((t) => t.description === "not a task")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("writeCompiledDag", () => {
  it("writes <cwd>/.pi/orchestrator/dag-<dagId>.yaml atomically and returns the path", () => {
    const dag = compileDagFromTodos([todo("A", { id: "A1", kind: "task" })], {
      dagId: "DAG-061-t1",
    });
    const dir = mkdtempSync(join(tmpdir(), "dag-compile-w-"));
    try {
      const path = writeCompiledDag(dagToPlanYaml(dag), dir);
      expect(path).toBe(compiledDagPath(dir, "DAG-061-t1"));
      const raw = readFileSync(path, "utf8");
      expect(raw).toContain("id: DAG-061-t1");
      expect(raw).toContain("A1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on YAML that is not a valid OrchestrationPlan", () => {
    const dir = mkdtempSync(join(tmpdir(), "dag-compile-bad-"));
    try {
      expect(() => writeCompiledDag("not: [valid", dir)).toThrow(/malformed/i);
      expect(() => writeCompiledDag("id: X\ngoal_id: Y\nstate: draft", dir)).toThrow(
        /not a valid OrchestrationPlan/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
