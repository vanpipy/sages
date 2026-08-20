/**
 * TodoStateManager tests — GC-2026-060 auto-todowrite foundation.
 *
 * Covers:
 *  - Whole-list replacement diff (added/removed/completed/reopened)
 *  - Content-based matching when items have no id
 *  - id-based matching (id-stable items survive content edits)
 *  - Counts + status getters
 *  - serialize/deserialize round-trip (owner + updatedAt preserved)
 *  - Non-root owner rejection (root-agent-only constraint)
 *  - saveTodoState / loadTodoState to a temp dir (atomic tmp+rename)
 *  - Corrupt / missing / wrong-owner file → loadTodoState returns null
 *  - applyDiff programmatic add/complete/remove by content or id
 *  - Path convention: <repo>/.pi/orchestrator/todo-state.json
 */

import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  TodoStateManager,
  saveTodoState,
  loadTodoState,
  todoStateDir,
  todoStatePath,
  resolveRepoRoot,
  type TodoItem,
} from "@/tools/todo/todo-state.js";

const pending = (content: string, extra: Partial<TodoItem> = {}): TodoItem => ({
  content,
  status: "pending",
  ...extra,
});

describe("TodoStateManager whole-list replacement diff", () => {
  it("classifies added/removed/completed/reopened in one apply", () => {
    const manager = new TodoStateManager([
      pending("a", { status: "pending" }),
      pending("b", { status: "in_progress" }),
      pending("c", { status: "completed" }),
      pending("e", { status: "completed" }),
    ]);

    const diff = manager.apply([
      pending("a", { status: "completed" }),
      pending("b", { status: "pending" }),
      pending("d", { status: "pending" }),
      pending("e", { status: "in_progress" }),
    ]);

    expect(diff.added).toEqual([pending("d", { status: "pending" })]);
    expect(diff.removed).toEqual([pending("c", { status: "completed" })]);
    expect(diff.completed).toEqual([pending("a", { status: "completed" })]);
    expect(diff.reopened).toEqual([pending("e", { status: "in_progress" })]);
    // b: in_progress → pending is a neutral status change — no diff bucket.
    expect(manager.getTodos()).toEqual([
      pending("a", { status: "completed" }),
      pending("b", { status: "pending" }),
      pending("d", { status: "pending" }),
      pending("e", { status: "in_progress" }),
    ]);
  });

  it("returns an empty diff when the snapshot is unchanged", () => {
    const manager = new TodoStateManager([pending("x")]);
    const diff = manager.apply([pending("x")]);
    expect(diff).toEqual({ added: [], removed: [], completed: [], reopened: [] });
  });
});

describe("content-based matching (no ids)", () => {
  it("tracks pending → completed by content", () => {
    const manager = new TodoStateManager([pending("write tests")]);
    const diff = manager.apply([pending("write tests", { status: "completed" })]);
    expect(diff.completed).toEqual([pending("write tests", { status: "completed" })]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(manager.getCounts()).toEqual({ pending: 0, inProgress: 0, completed: 1 });
  });

  it("tracks completed → pending (reopened) by content", () => {
    const manager = new TodoStateManager([pending("fix flaky test", { status: "completed" })]);
    const diff = manager.apply([pending("fix flaky test", { status: "pending" })]);
    expect(diff.reopened).toEqual([pending("fix flaky test", { status: "pending" })]);
    expect(diff.completed).toEqual([]);
  });
});

describe("id-based matching", () => {
  it("matches by id even when content changes (no false add/remove)", () => {
    const manager = new TodoStateManager([{ id: "t1", content: "alpha", status: "pending" }]);
    const diff = manager.apply([{ id: "t1", content: "alpha (renamed)", status: "in_progress" }]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.completed).toEqual([]);
    expect(diff.reopened).toEqual([]);
    expect(manager.getTodos()).toEqual([
      { id: "t1", content: "alpha (renamed)", status: "in_progress" },
    ]);
  });

  it("tracks completion by id while content stays stable", () => {
    const manager = new TodoStateManager([{ id: "t1", content: "alpha", status: "pending" }]);
    const diff = manager.apply([{ id: "t1", content: "alpha", status: "completed" }]);
    expect(diff.completed).toEqual([{ id: "t1", content: "alpha", status: "completed" }]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });
});

describe("counts and status getters", () => {
  it("returns counts and filtered lists", () => {
    const manager = new TodoStateManager([
      pending("p1"),
      pending("p2"),
      pending("i1", { status: "in_progress" }),
      pending("c1", { status: "completed" }),
      pending("c2", { status: "completed" }),
      pending("c3", { status: "completed" }),
    ]);
    expect(manager.getCounts()).toEqual({ pending: 2, inProgress: 1, completed: 3 });
    expect(manager.getPending().map((t) => t.content)).toEqual(["p1", "p2"]);
    expect(manager.getInProgress().map((t) => t.content)).toEqual(["i1"]);
    expect(manager.getCompleted().map((t) => t.content)).toEqual(["c1", "c2", "c3"]);
  });

  it("getTodos returns copies — mutating them does not corrupt state", () => {
    const manager = new TodoStateManager([pending("p1")]);
    const snapshot = manager.getTodos();
    snapshot[0].status = "completed";
    expect(manager.getTodos()[0].status).toBe("pending");
  });
});

describe("serialize / deserialize", () => {
  it("round-trips todos, owner and updatedAt", () => {
    const manager = new TodoStateManager([
      { id: "t1", content: "alpha", status: "in_progress", priority: "high" },
      pending("beta", { status: "completed" }),
    ]);
    const serialized = manager.serialize();
    expect(serialized.owner).toBe("root");

    const json = JSON.stringify(serialized);
    const restored = TodoStateManager.deserialize(JSON.parse(json));
    expect(restored.getTodos()).toEqual(manager.getTodos());
    expect(restored.serialize().owner).toBe("root");
    expect(restored.serialize().updatedAt).toBe(serialized.updatedAt);
  });

  it("accepts a JSON string directly", () => {
    const manager = new TodoStateManager([pending("x")]);
    const restored = TodoStateManager.deserialize(JSON.stringify(manager.serialize()));
    expect(restored.getTodos()).toEqual([pending("x")]);
  });

  it("exposes the root-only OWNER constant", () => {
    expect(TodoStateManager.OWNER).toBe("root");
  });
});

describe("root-agent-only ownership constraint", () => {
  it("rejects a non-root owner", () => {
    expect(() =>
      TodoStateManager.deserialize({ owner: "subagent", todos: [pending("x")] }),
    ).toThrow(/root/i);
    expect(() =>
      TodoStateManager.deserialize({ owner: "root", todos: [{ content: "x", status: "wat" }] }),
    ).toThrow(/status/i);
  });
});

describe("saveTodoState / loadTodoState", () => {
  it("writes <dir>/todo-state.json and round-trips", () => {
    const dir = mkdtempSync(join(tmpdir(), "sages-todo-"));
    try {
      const manager = new TodoStateManager([
        { id: "t1", content: "alpha", status: "in_progress" },
        pending("beta"),
      ]);
      const written = saveTodoState(dir, manager);
      expect(written).toBe(join(dir, "todo-state.json"));
      expect(existsSync(join(dir, "todo-state.json"))).toBe(true);

      const onDisk = JSON.parse(readFileSync(join(dir, "todo-state.json"), "utf8"));
      expect(onDisk.owner).toBe("root");
      expect(onDisk.todos).toEqual(manager.serialize().todos);

      const loaded = loadTodoState(dir);
      expect(loaded).not.toBeNull();
      expect(loaded!.getTodos()).toEqual(manager.getTodos());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates the directory if missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "sages-todo-"));
    const nested = join(dir, "a", "b");
    try {
      saveTodoState(nested, new TodoStateManager([pending("x")]));
      expect(existsSync(join(nested, "todo-state.json"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for missing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "sages-todo-"));
    try {
      expect(loadTodoState(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for corrupt JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "sages-todo-"));
    try {
      writeFileSync(join(dir, "todo-state.json"), "{ not json !!!", "utf8");
      expect(loadTodoState(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null for a wrong-owner file (subagent list must never load)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sages-todo-"));
    try {
      writeFileSync(
        join(dir, "todo-state.json"),
        JSON.stringify({ owner: "developer", todos: [pending("x")] }),
        "utf8",
      );
      expect(loadTodoState(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applyDiff programmatic updates", () => {
  it("adds items defaulting to pending", () => {
    const manager = new TodoStateManager([pending("existing")]);
    const diff = manager.applyDiff({ add: [pending("new"), { content: "also-new", status: "in_progress" }] });
    expect(diff.added).toEqual([pending("new"), { content: "also-new", status: "in_progress" }]);
    expect(manager.getCounts()).toEqual({ pending: 2, inProgress: 1, completed: 0 });
  });

  it("add is idempotent for already-present items", () => {
    const manager = new TodoStateManager([pending("existing")]);
    const diff = manager.applyDiff({ add: [pending("existing"), pending("other")] });
    expect(diff.added).toEqual([pending("other")]);
    expect(manager.getCounts().pending).toBe(2);
  });

  it("completes by content string", () => {
    const manager = new TodoStateManager([pending("alpha"), pending("beta")]);
    const diff = manager.applyDiff({ complete: ["alpha"] });
    expect(diff.completed).toEqual([pending("alpha", { status: "completed" })]);
    expect(manager.getCounts()).toEqual({ pending: 1, inProgress: 0, completed: 1 });
  });

  it("completes by id string and by full item", () => {
    const manager = new TodoStateManager([
      { id: "t1", content: "alpha", status: "pending" },
      { id: "t2", content: "beta", status: "pending" },
    ]);
    const diff = manager.applyDiff({ complete: ["t1", { id: "t2", content: "beta" }] });
    expect(diff.completed.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("removes by content and by id", () => {
    const manager = new TodoStateManager([
      pending("alpha"),
      { id: "t2", content: "beta", status: "pending" },
    ]);
    const diff = manager.applyDiff({ remove: ["alpha", "t2"] });
    expect(diff.removed.map((t) => t.content)).toEqual(["alpha", "beta"]);
    expect(manager.getTodos()).toEqual([]);
  });

  it("throws on unknown refs instead of silently ignoring", () => {
    const manager = new TodoStateManager([pending("alpha")]);
    expect(() => manager.applyDiff({ complete: ["ghost"] })).toThrow(/ghost/);
    expect(() => manager.applyDiff({ remove: ["ghost"] })).toThrow(/ghost/);
  });
});

describe("path convention", () => {
  it("derives the state dir from ORCHESTRATOR_DIR", () => {
    expect(todoStateDir("/repo")).toBe("/repo/.pi/orchestrator");
    expect(todoStatePath("/repo")).toBe("/repo/.pi/orchestrator/todo-state.json");
  });

  it("resolveRepoRoot walks up to the repo containing .pi/orchestrator", () => {
    const root = mkdtempSync(join(tmpdir(), "sages-repo-"));
    try {
      mkdirSync(join(root, ".pi", "orchestrator"), { recursive: true });
      const nested = join(root, "a", "b", "c");
      mkdirSync(nested, { recursive: true });
      expect(resolveRepoRoot(nested)).toBe(root);
      expect(resolveRepoRoot(join(root, ".pi", "orchestrator"))).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveRepoRoot falls back to the explicit cwd when nothing matches", () => {
    // Use homedir(), not tmpdir(): /tmp carries an ambient .pi/orchestrator
    // on this box, which the walk-up legitimately treats as a repo marker.
    const dir = mkdtempSync(join(homedir(), "sages-norepo-"));
    try {
      expect(resolveRepoRoot(dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
