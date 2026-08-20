/**
 * sages_todo tool tests — GC-2026-060 auto-todowrite.
 *
 * Covers:
 *  - Registration on the root extension via MockPi (main-agent-toolset
 *    pattern) + end-to-end execution through the registered tool
 *  - sync: whole-list replacement, validation errors (missing todos,
 *    empty content, invalid status), persistence to temp state dir,
 *    diff summary on transitions
 *  - get: round-trip against the persisted store
 *  - auto-plan: derives batch-level todos from a fixture DAG in a temp
 *    .pi/orchestrator dir; audit-state override; no dag_id → no-op;
 *    unknown dag_id → error block (does not throw)
 *  - deriveDagTodos: pure helper returns expected todos WITHOUT writing
 *    anything to disk
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as yaml from "js-yaml";
import {
  registerSagesTodoTool,
  executeSagesTodo,
  deriveDagTodos,
  type SagesTodoInput,
  type SagesTodoResult,
} from "@/tools/todo/sages-todo-tool.js";
import { loadTodoState, todoStateDir, type TodoDiff, type TodoItem } from "@/tools/todo/todo-state.js";

/** Minimal pi extension mock capturing registerTool definitions. */
class MockPi {
  registeredTools: Array<{
    name: string;
    parameters?: unknown;
    execute?: (...args: any[]) => Promise<SagesTodoResult> | SagesTodoResult;
  }> = [];
  registerTool(def: {
    name: string;
    parameters?: unknown;
    execute?: (...args: any[]) => Promise<SagesTodoResult> | SagesTodoResult;
  }): void {
    this.registeredTools.push(def);
  }
}

const t1: TodoItem = { id: "P1", content: "Build the todo state manager", status: "pending" };
const t2: TodoItem = { id: "P2", content: "Build the sages_todo tool", status: "pending" };

/** Fixture DAG: batch 1 = P1, P2 (parallel); batch 2 = P3 (depends on P2). */
const FIXTURE_DAG = {
  id: "DAG-2026-060",
  goal_id: "GC-2026-060",
  title: "Auto-todowrite fixture",
  state: "approved",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  tasks: [
    {
      id: "P1",
      description: "Build the todo state manager",
      plane: "Foundation",
      priority: "high",
      depends_on: [],
      files: ["pi/src/tools/todo/todo-state.ts"],
      subagent_type: "developer",
      batch: 1,
      isolation: { dag_id: "GC-2026-060", task_id: "P1", mode: "create" },
      tdd: "strict",
      prompt: "Build the todo state manager with strict TDD.",
      output_schema: { kind: "code_changes" },
      acceptance: { covers: ["SC-1"] },
      status: "pending",
      retry_count: 0,
      max_retries: 2,
    },
    {
      id: "P2",
      description: "Build the sages_todo tool",
      plane: "Foundation",
      priority: "high",
      depends_on: ["P1"],
      files: ["pi/src/tools/todo/sages-todo-tool.ts"],
      subagent_type: "developer",
      batch: 1,
      isolation: { dag_id: "GC-2026-060", task_id: "P2", mode: "create" },
      tdd: "strict",
      prompt: "Build the sages_todo tool with strict TDD.",
      output_schema: { kind: "code_changes" },
      acceptance: { covers: ["SC-2"] },
      status: "pending",
      retry_count: 0,
      max_retries: 2,
    },
    {
      id: "P3",
      description: "Wire the todo reminder into the extension",
      plane: "Observation",
      priority: "medium",
      depends_on: ["P2"],
      files: ["pi/src/extension.ts"],
      subagent_type: "developer",
      batch: 2,
      isolation: { dag_id: "GC-2026-060", task_id: "P3", mode: "reuse" },
      tdd: "strict",
      prompt: "Wire the todo reminder into before_agent_start.",
      output_schema: { kind: "code_changes" },
      acceptance: { covers: ["SC-3"] },
      status: "pending",
      retry_count: 0,
      max_retries: 2,
    },
  ],
  prompts: {
    P1: "Build the todo state manager with strict TDD.",
    P2: "Build the sages_todo tool with strict TDD.",
    P3: "Wire the todo reminder into before_agent_start.",
  },
};

const FIXTURE_GOAL = {
  id: "GC-2026-060",
  title: "Auto-todowrite fixture",
  scope: { include: ["pi/src/tools/todo/"], exclude: [] },
  success_criteria: [
    {
      id: "SC-1",
      description: "Todo state manager exists",
      verification_cmd: "bun test ./test/tools/todo/todo-state.test.ts",
    },
    {
      id: "SC-2",
      description: "sages_todo tool exists",
      verification_cmd: "bun test ./test/tools/todo/sages-todo-tool.test.ts",
    },
    {
      id: "SC-3",
      description: "Reminder builder exists",
      verification_cmd: "bun test ./test/tools/todo/todo-reminder.test.ts",
    },
  ],
  anti_goals: ["Subagent todo lists must not enter the root store"],
  done_definition: "All three gates pass with no regressions.",
};

/** Audit state with batch 1 fully completed and batch 2 in progress. */
const FIXTURE_AUDIT_STATE = {
  dag_id: "GC-2026-060",
  plan: { ...FIXTURE_DAG, state: "executing", tasks: [] },
  tasks: [
    { id: "P1", status: "completed", batch: 1, retry_count: 0, max_retries: 2 },
    { id: "P2", status: "completed", batch: 1, retry_count: 0, max_retries: 2 },
    { id: "P3", status: "in_progress", batch: 2, retry_count: 0, max_retries: 2 },
  ],
  findings: [],
  score: 0,
  depth: "fast",
  identity: { dag_id: "GC-2026-060", scope: "workflow", scope_key: "workflow", depth: "fast" },
  status: "recording",
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sages-todo-"));
  // resolveRepoRoot treats a directory containing .pi/orchestrator as the
  // repo root — creating it here keeps every test isolated from the real
  // sages repo (and from the findSagesRoot fallback).
  mkdirSync(join(tmp, ".pi", "orchestrator"), { recursive: true });
  writeYaml("dag-GC-2026-060.yaml", FIXTURE_DAG);
  writeYaml("goal-GC-2026-060.yaml", FIXTURE_GOAL);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writeYaml(name: string, value: unknown): void {
  writeFileSync(join(tmp, ".pi", "orchestrator", name), yaml.dump(value, { noRefs: true }));
}

describe("registerSagesTodoTool — registration", () => {
  it("registers the sages_todo tool with parameters + execute", () => {
    const mock = new MockPi();
    registerSagesTodoTool(mock as any);
    expect(mock.registeredTools.map((t) => t.name)).toContain("sages_todo");
    const def = mock.registeredTools.find((t) => t.name === "sages_todo")!;
    expect(def.parameters).toBeDefined();
    expect(typeof def.execute).toBe("function");
  });

  it("sync + get round-trip through the registered tool", async () => {
    const mock = new MockPi();
    registerSagesTodoTool(mock as any);
    const def = mock.registeredTools.find((t) => t.name === "sages_todo")!;
    const syncResult = await def.execute!("call-1", { action: "sync", todos: [t1, t2] }, undefined, undefined, { cwd: tmp });
    expect(syncResult.details.status).toBe("ok");
    const getResult = await def.execute!("call-2", { action: "get" }, undefined, undefined, { cwd: tmp });
    expect(getResult.details.status).toBe("ok");
    expect(getResult.details.todos).toEqual([t1, t2]);
  });
});

describe("executeSagesTodo — sync validation", () => {
  it("rejects sync without a todos array (error block, no throw)", async () => {
    const result = await executeSagesTodo({ action: "sync" }, { cwd: tmp });
    expect(result.details.status).toBe("error");
    expect(result.details.code).toBe("MISSING_TODOS");
    expect(result.content[0].text).toContain("requires a 'todos' array");
  });

  it("rejects a todo with empty content", async () => {
    const result = await executeSagesTodo(
      { action: "sync", todos: [{ content: "", status: "pending" }] },
      { cwd: tmp },
    );
    expect(result.details.status).toBe("error");
    expect(result.details.code).toBe("INVALID_TODO");
    expect(result.content[0].text).toContain("todos[0].content");
  });

  it("rejects a todo with an unknown status", async () => {
    // Deliberately-invalid payload — bypasses the SagesTodoInput static type.
    const params = { action: "sync", todos: [{ content: "x", status: "bogus" }] } as unknown as SagesTodoInput;
    const result = await executeSagesTodo(params, { cwd: tmp });
    expect(result.details.status).toBe("error");
    expect(result.details.code).toBe("INVALID_TODO");
    expect(result.content[0].text).toContain("todos[0].status");
    expect(result.content[0].text).toContain("pending, in_progress, completed");
  });

  it("rejects a non-object todo entry", async () => {
    // Deliberately-invalid payload — bypasses the SagesTodoInput static type.
    const params = { action: "sync", todos: ["not-an-object"] } as unknown as SagesTodoInput;
    const result = await executeSagesTodo(params, { cwd: tmp });
    expect(result.details.status).toBe("error");
    expect(result.details.code).toBe("INVALID_TODO");
  });
});

describe("executeSagesTodo — sync + get round-trip", () => {
  it("persists the whole list to the temp state dir and reads it back", async () => {
    const syncResult = await executeSagesTodo({ action: "sync", todos: [t1, t2] }, { cwd: tmp });
    expect(syncResult.details.status).toBe("ok");
    expect(syncResult.details.counts).toEqual({ pending: 2, inProgress: 0, completed: 0 });
    expect(syncResult.details.diff).toEqual({
      added: [t1, t2],
      removed: [],
      completed: [],
      reopened: [],
    });

    // Persisted to <repo>/.pi/orchestrator/todo-state.json
    expect(readdirSync(todoStateDir(tmp))).toContain("todo-state.json");
    const loaded = loadTodoState(todoStateDir(tmp));
    expect(loaded?.getTodos()).toEqual([t1, t2]);
    expect(loaded?.getCounts()).toEqual({ pending: 2, inProgress: 0, completed: 0 });

    const getResult = await executeSagesTodo({ action: "get" }, { cwd: tmp });
    expect(getResult.details.status).toBe("ok");
    expect(getResult.details.todos).toEqual([t1, t2]);
    expect(getResult.details.counts).toEqual({ pending: 2, inProgress: 0, completed: 0 });
  });

  it("sync reports transitions on whole-list replacement", async () => {
    await executeSagesTodo({ action: "sync", todos: [t1, t2] }, { cwd: tmp });
    const t1Done: TodoItem = { id: "P1", content: "Build the todo state manager", status: "completed" };
    const t3: TodoItem = { id: "P3", content: "Wire the reminder", status: "pending" };
    const result = await executeSagesTodo({ action: "sync", todos: [t1Done, t3] }, { cwd: tmp });
    expect(result.details.status).toBe("ok");
    const diff = result.details.diff as TodoDiff;
    expect(diff.completed).toEqual([t1Done]);
    expect(diff.added).toEqual([t3]);
    expect(diff.removed).toEqual([t2]);
    expect(result.details.counts).toEqual({ pending: 1, inProgress: 0, completed: 1 });
  });
});

describe("executeSagesTodo — auto-plan", () => {
  it("derives + applies batch-level todos from the fixture DAG", async () => {
    const result = await executeSagesTodo({ action: "auto-plan", dag_id: "GC-2026-060" }, { cwd: tmp });
    expect(result.details.status).toBe("ok");
    expect(result.details.dag_id).toBe("GC-2026-060");
    expect(result.details.derived).toEqual([
      { id: "P1", content: "Build the todo state manager", status: "in_progress" },
      { id: "P2", content: "Build the sages_todo tool", status: "in_progress" },
      { id: "P3", content: "Wire the todo reminder into the extension", status: "pending" },
    ]);
    expect(result.details.todos).toEqual(result.details.derived);
    expect(result.details.counts).toEqual({ pending: 1, inProgress: 2, completed: 0 });
    // Persisted
    expect(loadTodoState(todoStateDir(tmp))?.getCounts()).toEqual({
      pending: 1,
      inProgress: 2,
      completed: 0,
    });
  });

  it("uses audit-state task statuses when present (current batch = batch 2)", async () => {
    writeYaml("audit-state-GC-2026-060.yaml", FIXTURE_AUDIT_STATE);
    const result = await executeSagesTodo({ action: "auto-plan", dag_id: "GC-2026-060" }, { cwd: tmp });
    expect(result.details.status).toBe("ok");
    expect(result.details.derived).toEqual([
      { id: "P1", content: "Build the todo state manager", status: "completed" },
      { id: "P2", content: "Build the sages_todo tool", status: "completed" },
      { id: "P3", content: "Wire the todo reminder into the extension", status: "in_progress" },
    ]);
    expect(result.details.counts).toEqual({ pending: 0, inProgress: 1, completed: 2 });
  });

  it("is a no-op when dag_id is omitted (ad-hoc root workflows)", async () => {
    await executeSagesTodo({ action: "sync", todos: [t1] }, { cwd: tmp });
    const result = await executeSagesTodo({ action: "auto-plan" }, { cwd: tmp });
    expect(result.details.status).toBe("ok");
    expect(result.details.note).toContain("no-op");
    expect(result.details.todos).toEqual([t1]);
    expect(result.details.counts).toEqual({ pending: 1, inProgress: 0, completed: 0 });
  });

  it("returns an error block (does not throw) for an unknown dag_id", async () => {
    const result = await executeSagesTodo({ action: "auto-plan", dag_id: "GC-9999" }, { cwd: tmp });
    expect(result.details.status).toBe("error");
    expect(result.details.code).toBe("DAG_NOT_FOUND");
    expect(result.content[0].text).toContain("GC-9999");
  });
});

describe("deriveDagTodos — pure helper", () => {
  it("returns the expected batch-level todos without writing state", async () => {
    const before = readdirSync(todoStateDir(tmp));
    const todos = deriveDagTodos("GC-2026-060", tmp);
    expect(todos).toEqual([
      { id: "P1", content: "Build the todo state manager", status: "in_progress" },
      { id: "P2", content: "Build the sages_todo tool", status: "in_progress" },
      { id: "P3", content: "Wire the todo reminder into the extension", status: "pending" },
    ]);
    // No mutation: nothing written, repeated calls are stable.
    expect(readdirSync(todoStateDir(tmp))).toEqual(before);
    expect(deriveDagTodos("GC-2026-060", tmp)).toEqual(todos);
  });

  it("returns an empty list when the DAG does not exist", () => {
    expect(deriveDagTodos("GC-9999", tmp)).toEqual([]);
  });

  it("derives completed statuses from audit-state without an in_progress batch", async () => {
    writeYaml("audit-state-GC-2026-060.yaml", {
      ...FIXTURE_AUDIT_STATE,
      tasks: FIXTURE_AUDIT_STATE.tasks.map((t) => ({ ...t, status: "completed" })),
    });
    expect(deriveDagTodos("GC-2026-060", tmp)).toEqual([
      { id: "P1", content: "Build the todo state manager", status: "completed" },
      { id: "P2", content: "Build the sages_todo tool", status: "completed" },
      { id: "P3", content: "Wire the todo reminder into the extension", status: "completed" },
    ]);
  });
});
