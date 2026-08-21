/**
 * sages-todo-persistence.test.ts — GC-2026-067 T3 (SC4).
 *
 * Pins the contract that `sages_todo({action: "sync", todos: [...]})`
 * writes the new list to `.pi/orchestrator/todo-state.json` BEFORE
 * returning, and that the persisted file round-trips through
 * `loadTodoState` to a TodoStateManager whose contents match the
 * submitted snapshot.
 *
 * Why this file exists separately from `sages-todo-tool.test.ts`:
 * SC4 (the SC this test pins) is a hard requirement on the
 * `before return → file exists on disk` boundary. The existing test
 * suite asserts round-trip behavior, but the SC4 wording is "the file
 * exists after sync, before return" — so this file wires a focused
 * pre-/post-return existence assertion through both the registered
 * tool (`registerSagesTodoTool(...).execute(...)`) and the direct
 * `executeSagesTodo` entry point, and asserts the persisted state
 * matches the submitted snapshot through a fresh `loadTodoState`.
 *
 * Scope (T3 SC4):
 *   - (a) registerSagesTodoTool(...).execute(...sync...) writes
 *         <repo>/.pi/orchestrator/todo-state.json
 *   - (b) round-trip via loadTodoState preserves the submitted items
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  executeSagesTodo,
  registerSagesTodoTool,
  type SagesTodoInput,
  type SagesTodoResult,
} from "@/tools/todo/sages-todo-tool.js";
import {
  loadTodoState,
  saveTodoState,
  todoStateDir,
  todoStatePath,
  type TodoItem,
} from "@/tools/todo/todo-state.js";

/** Minimal pi extension mock — same shape as sages-todo-tool.test.ts. */
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
const t2: TodoItem = { id: "P2", content: "Build the sages_todo tool", status: "in_progress" };
const t3: TodoItem = { id: "P3", content: "Wire the reminder", status: "completed" };

let tmp: string;

beforeEach(() => {
  // resolveRepoRoot treats a dir containing .pi/orchestrator as the
  // repo root — creating it here isolates every test from the real
  // sages repo and from the findSagesRoot fallback.
  tmp = mkdtempSync(join(tmpdir(), "sages-todo-persist-"));
  mkdirSync(join(tmp, ".pi", "orchestrator"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ─── (a) registerSagesTodoTool(...).execute(...sync...) writes todo-state.json

describe("sages_todo sync persistence (GC-2026-067 T3 SC4)", () => {
  it("(a) registerSagesTodoTool(...).execute(...sync...) writes todo-state.json", async () => {
    const mock = new MockPi();
    registerSagesTodoTool(mock as any);
    const def = mock.registeredTools.find((t) => t.name === "sages_todo")!;
    expect(def).toBeDefined();
    expect(typeof def.execute).toBe("function");

    const stateFile = todoStatePath(tmp);
    expect(existsSync(stateFile)).toBe(false);

    const result = await def.execute!(
      "call-1",
      { action: "sync", todos: [t1, t2, t3] },
      undefined,
      undefined,
      { cwd: tmp },
    );

    expect(result.details.status).toBe("ok");

    // Pre-condition: file must exist on disk AFTER sync returns.
    expect(existsSync(stateFile)).toBe(true);
    expect(existsSync(todoStateDir(tmp))).toBe(true);

    // The persisted payload must be valid JSON + locked to owner=root.
    const onDisk = JSON.parse(readFileSync(stateFile, "utf-8"));
    expect(onDisk.owner).toBe("root");
    expect(Array.isArray(onDisk.todos)).toBe(true);
    expect(onDisk.todos).toEqual([t1, t2, t3]);
    expect(typeof onDisk.updatedAt).toBe("string");
  });

  it("(a2) executeSagesTodo (direct entry) also persists before return", async () => {
    // Direct entry point bypasses registerTool, so the persistence
    // contract has to hold here independently of the registration
    // wrapper (which would mask a regression in executeSagesTodo
    // itself).
    const stateFile = todoStatePath(tmp);
    expect(existsSync(stateFile)).toBe(false);

    const result = await executeSagesTodo(
      { action: "sync", todos: [t1, t2] } as SagesTodoInput,
      { cwd: tmp },
    );

    expect(result.details.status).toBe("ok");
    expect(existsSync(stateFile)).toBe(true);
  });

  it("(a3) a sync that fails validation does NOT create a partial file", async () => {
    // Defense against "sync writes then bails" — a validation error
    // must surface as an error block without a half-written state file
    // (the prior state file, if any, must be untouched).
    const stateFile = todoStatePath(tmp);
    // Seed a known-good baseline so we can assert it survives.
    saveTodoState(todoStateDir(tmp), { owner: "root", updatedAt: "2026-01-01T00:00:00.000Z", todos: [t1] });
    const baselineSnapshot = readFileSync(stateFile, "utf-8");

    const result = await executeSagesTodo(
      { action: "sync", todos: [{ content: "", status: "pending" }] } as unknown as SagesTodoInput,
      { cwd: tmp },
    );

    expect(result.details.status).toBe("error");
    // Baseline preserved.
    expect(readFileSync(stateFile, "utf-8")).toBe(baselineSnapshot);
  });
});

// ─── (b) round-trip via loadTodoState preserves the items

describe("sages_todo sync persistence — round-trip (GC-2026-067 T3 SC4)", () => {
  it("(b) round-trip via loadTodoState preserves the items exactly", async () => {
    const result = await executeSagesTodo(
      { action: "sync", todos: [t1, t2, t3] } as SagesTodoInput,
      { cwd: tmp },
    );
    expect(result.details.status).toBe("ok");

    const loaded = loadTodoState(todoStateDir(tmp));
    expect(loaded).not.toBeNull();
    expect(loaded!.getTodos()).toEqual([t1, t2, t3]);
    expect(loaded!.getCounts()).toEqual({ pending: 1, inProgress: 1, completed: 1 });
  });

  it("(b2) a re-sync overwrites the persisted list (whole-list replacement, not append)", async () => {
    await executeSagesTodo({ action: "sync", todos: [t1, t2, t3] } as SagesTodoInput, { cwd: tmp });
    const t1Done: TodoItem = { id: "P1", content: "Build the todo state manager", status: "completed" };
    const t4: TodoItem = { id: "P4", content: "Add session_start digest", status: "pending" };
    await executeSagesTodo({ action: "sync", todos: [t1Done, t4] } as SagesTodoInput, { cwd: tmp });

    const loaded = loadTodoState(todoStateDir(tmp));
    expect(loaded!.getTodos()).toEqual([t1Done, t4]);
    expect(loaded!.getCounts()).toEqual({ pending: 1, inProgress: 0, completed: 1 });
  });

  it("(b3) the persisted payload round-trips through a fresh TodoStateManager (deserialize)", async () => {
    await executeSagesTodo({ action: "sync", todos: [t1, t2] } as SagesTodoInput, { cwd: tmp });
    // Fresh load — this is the contract session_start relies on.
    const loaded = loadTodoState(todoStateDir(tmp))!;
    // Mutate the in-memory copy; the persisted file must NOT change
    // (loadTodoState returns an isolated snapshot — defense against
    // accidental cross-process bleed).
    loaded.getTodos().push({ content: "rogue", status: "pending" });
    const reloaded = loadTodoState(todoStateDir(tmp))!;
    expect(reloaded.getTodos()).toEqual([t1, t2]);
  });
});