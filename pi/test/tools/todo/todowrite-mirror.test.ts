/**
 * todowrite-mirror.test.ts — GC-2026-067 T3 (SC5).
 *
 * Pins the contract that LLM-native TodoWrite tool calls mirror their
 * items into the sages_todo store via the dedicated `todo-mirror`
 * module — with a distinct `mirror:` id prefix, dag-id-aware keying,
 * and TODO_DONE / empty-content filtering per the SC5 anti-goal.
 *
 * Why a separate module: the existing extension.ts `tool_call`
 * handler calls `todoState.apply(items)` directly, which collapses
 * mirror entries into the same id/content namespace as manual
 * `sages_todo` entries. SC5 requires a distinct `mirror:` namespace so
 * that:
 *   - the LLM's transient TodoWrite titles never collide with operator-
 *     authored todos;
 *   - the mirror can detect removals (LLM dropped an entry) and mark
 *     them `[mirror-cancelled]` completed, rather than silently wiping
 *     the store;
 *   - dag_id-keyed namespaces keep parallel workflows from clobbering
 *     each other's mirror entries.
 *
 * Scope (T3 SC5):
 *   - (a) Mirror adds entry with `mirror:` id prefix
 *   - (b) Re-mirror updates status only
 *   - (c) Empty content skipped (TODO_DONE / placeholder)
 *   - (d) Same content, different dagIds → distinct entries
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
  mirrorLlmTodoWriteToSages,
  type MirrorOptions,
} from "@/tools/todo/todo-mirror.js";
import { TodoStateManager, type TodoItem } from "@/tools/todo/todo-state.js";

// ─── (a) Mirror adds entry with mirror: id prefix

describe("mirrorLlmTodoWriteToSages — (a) mirror: id prefix", () => {
  let state: TodoStateManager;

  beforeEach(() => {
    state = new TodoStateManager();
  });

  it("adds an entry with id 'mirror:session:<content>' for a single todo", () => {
    const diff = mirrorLlmTodoWriteToSages(
      [{ content: "Build the state manager", status: "pending" }],
      state,
    );
    expect(diff.added).toHaveLength(1);
    expect(diff.added[0].id).toBe("mirror:session:Build the state manager");
    expect(diff.added[0].content).toBe("Build the state manager");
    expect(diff.added[0].status).toBe("pending");

    expect(state.getTodos()).toEqual([diff.added[0]]);
  });

  it("preserves the LLM's status verbatim (pending / in_progress / completed)", () => {
    mirrorLlmTodoWriteToSages(
      [
        { content: "A", status: "pending" },
        { content: "B", status: "in_progress" },
        { content: "C", status: "completed" },
      ],
      state,
    );
    const todos = state.getTodos();
    expect(todos.map((t) => t.status)).toEqual(["pending", "in_progress", "completed"]);
  });
});

// ─── (b) Re-mirror updates status only

describe("mirrorLlmTodoWriteToSages — (b) re-mirror updates status only", () => {
  let state: TodoStateManager;

  beforeEach(() => {
    state = new TodoStateManager();
  });

  it("re-mirroring the same content with a different status updates only the status", () => {
    mirrorLlmTodoWriteToSages(
      [{ content: "Build the state manager", status: "pending" }],
      state,
    );
    const first = state.getTodos()[0];

    const diff = mirrorLlmTodoWriteToSages(
      [{ content: "Build the state manager", status: "in_progress" }],
      state,
    );

    // Diff is empty under whole-list replacement (no add/remove) but
    // the in-memory state has updated.
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    const after = state.getTodos();
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(first.id);
    expect(after[0].status).toBe("in_progress");
    // No phantom completed/reopened: status flipped from pending → in_progress
    // (neither is the completed anchor).
    expect(diff.completed).toHaveLength(0);
    expect(diff.reopened).toHaveLength(0);
  });

  it("a transition pending → completed reports it in the diff.completed bucket", () => {
    mirrorLlmTodoWriteToSages(
      [{ content: "Wire the reminder", status: "pending" }],
      state,
    );
    const diff = mirrorLlmTodoWriteToSages(
      [{ content: "Wire the reminder", status: "completed" }],
      state,
    );
    expect(diff.completed).toHaveLength(1);
    expect(diff.completed[0].id).toBe("mirror:session:Wire the reminder");
    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
  });

  it("content that disappears from the mirror is marked [mirror-cancelled] completed (not removed)", () => {
    mirrorLlmTodoWriteToSages(
      [
        { content: "Build X", status: "pending" },
        { content: "Build Y", status: "in_progress" },
      ],
      state,
    );

    // LLM's next todowrite only mentions Build X — Y should be cancelled.
    const diff = mirrorLlmTodoWriteToSages(
      [{ content: "Build X", status: "completed" }],
      state,
    );

    // No `removed` bucket — the mirror contract never deletes; cancelled
    // mirror entries become `[mirror-cancelled] <content>` completed so
    // audit / debug can still see the lifecycle. The `completed` bucket
    // surfaces both transitions (Build X pending → completed AND the
    // cancel), so we filter the cancelled one out for clarity.
    expect(diff.removed).toHaveLength(0);
    const completedContents = diff.completed.map((t) => t.content).sort();
    expect(completedContents).toContain("[mirror-cancelled] Build Y");

    const todos = state.getTodos();
    expect(todos).toHaveLength(2);
    const cancelled = todos.find((t) => t.content === "[mirror-cancelled] Build Y");
    expect(cancelled).toBeDefined();
    expect(cancelled!.status).toBe("completed");
    expect(cancelled!.id).toBe("mirror:session:Build Y");
    // The completed Y entry is the cancelled marker, not a phantom
    // active todo.
    expect(state.getInProgress()).toHaveLength(0);
    // Build X kept its id and is now completed (the LLM's reported
    // transition, separate from the cancellation).
    const buildX = todos.find((t) => t.content === "Build X");
    expect(buildX!.id).toBe("mirror:session:Build X");
    expect(buildX!.status).toBe("completed");
  });

  it("a previously-cancelled mirror entry is idempotent on re-mirror (no duplicate cancelled entries)", () => {
    mirrorLlmTodoWriteToSages(
      [{ content: "Build Y", status: "in_progress" }],
      state,
    );
    mirrorLlmTodoWriteToSages([], state); // LLM dropped it → cancelled
    mirrorLlmTodoWriteToSages([], state); // dropped again — still no entry

    const cancelled = state.getTodos().filter((t) => t.content.startsWith("[mirror-cancelled]"));
    expect(cancelled).toHaveLength(1);
  });
});

// ─── (c) Empty content / TODO_DONE markers skipped

describe("mirrorLlmTodoWriteToSages — (c) empty content / TODO_DONE skipped", () => {
  let state: TodoStateManager;

  beforeEach(() => {
    state = new TodoStateManager();
  });

  it("empty content is dropped (no entry created, no error)", () => {
    const diff = mirrorLlmTodoWriteToSages(
      [{ content: "", status: "pending" }, { content: "   ", status: "pending" }],
      state,
    );
    expect(diff.added).toHaveLength(0);
    expect(state.getTodos()).toEqual([]);
  });

  it("non-object / non-string entries are dropped silently (best-effort)", () => {
    const diff = mirrorLlmTodoWriteToSages(
      // raw passthrough: simulates LLM-side quirks (a null entry, a
      // string entry). The mirror never throws — a malformed
      // todowrite input must not break the agent's tool execution.
      ["junk", null, { content: "Real", status: "pending" }] as unknown as TodoItem[],
      state,
    );
    expect(state.getTodos()).toEqual([
      { id: "mirror:session:Real", content: "Real", status: "pending" },
    ]);
    expect(diff.added).toHaveLength(1);
  });

  it("TODO_DONE-style bracketed markers are filtered (per SC5 anti-goal)", () => {
    // The Sages-internal marker convention is `<text>` wrapped in
    // brackets — e.g. `[TODO_DONE]`, `[draft]`. They are LLM-side
    // scaffolding, not user-facing todos. The mirror contract is to
    // persist only user-facing content.
    const diff = mirrorLlmTodoWriteToSages(
      [
        { content: "[TODO_DONE] internal placeholder", status: "pending" },
        { content: "[draft] not ready", status: "in_progress" },
        { content: "Real user-facing todo", status: "pending" },
      ],
      state,
    );
    expect(state.getTodos()).toEqual([
      { id: "mirror:session:Real user-facing todo", content: "Real user-facing todo", status: "pending" },
    ]);
    expect(diff.added).toHaveLength(1);
  });

  it("unrecognized statuses are dropped (mirror accepts only pending / in_progress / completed)", () => {
    // raw status that's not in the enum — mirror filters, never throws.
    const diff = mirrorLlmTodoWriteToSages(
      [
        { content: "Real", status: "pending" },
        { content: "Bogus", status: "todo" },
      ] as unknown as TodoItem[],
      state,
    );
    expect(state.getTodos()).toHaveLength(1);
    expect(diff.added).toHaveLength(1);
  });
});

// ─── (d) Same content, different dagIds → distinct entries

describe("mirrorLlmTodoWriteToSages — (d) dag_id-keyed namespaces", () => {
  let state: TodoStateManager;

  beforeEach(() => {
    state = new TodoStateManager();
  });

  it("same content under different dagIds produces distinct mirror entries", () => {
    const optsA: MirrorOptions = { dagId: "GC-2026-067" };
    const optsB: MirrorOptions = { dagId: "GC-2026-068" };

    mirrorLlmTodoWriteToSages(
      [{ content: "Build X", status: "pending" }],
      state,
      optsA,
    );
    mirrorLlmTodoWriteToSages(
      [{ content: "Build X", status: "in_progress" }],
      state,
      optsB,
    );

    const todos = state.getTodos();
    expect(todos).toHaveLength(2);
    expect(todos.map((t) => t.id).sort()).toEqual([
      "mirror:GC-2026-067:Build X",
      "mirror:GC-2026-068:Build X",
    ]);
  });

  it("with dagId undefined the mirror uses the session namespace", () => {
    mirrorLlmTodoWriteToSages(
      [{ content: "Build X", status: "pending" }],
      state,
      // opts.dagId deliberately undefined
    );
    expect(state.getTodos()[0].id).toBe("mirror:session:Build X");
  });

  it("cancellations are scoped to the dagId that produced them", () => {
    // Establish two namespaces; cancelling one must not touch the other.
    mirrorLlmTodoWriteToSages(
      [{ content: "Build X", status: "pending" }],
      state,
      { dagId: "GC-A" },
    );
    mirrorLlmTodoWriteToSages(
      [{ content: "Build X", status: "in_progress" }],
      state,
      { dagId: "GC-B" },
    );

    // GC-A cancels (LLM dropped Build X from its todowrite)
    mirrorLlmTodoWriteToSages([], state, { dagId: "GC-A" });

    const todos = state.getTodos();
    const aCancelled = todos.find(
      (t) => t.id === "mirror:GC-A:Build X" && t.status === "completed",
    );
    const bIntact = todos.find(
      (t) => t.id === "mirror:GC-B:Build X" && t.status === "in_progress",
    );
    expect(aCancelled).toBeDefined();
    expect(aCancelled!.content).toBe("[mirror-cancelled] Build X");
    expect(bIntact).toBeDefined();
  });
});

// ─── LLM-side smoke: integration with the existing store ────────────────

describe("mirrorLlmTodoWriteToSages — store integration", () => {
  it("whole-list replacement semantics: the resulting getTodos() mirrors the LLM's snapshot", () => {
    const state = new TodoStateManager([
      // Pre-existing manual entry the operator wrote via sages_todo
      // — the mirror must NOT clobber it (its id has no `mirror:`
      // prefix, so its identity key is unrelated to any mirror entry).
      { id: "manual-1", content: "manual operator todo", status: "pending" },
    ]);

    mirrorLlmTodoWriteToSages(
      [
        { content: "LLM A", status: "pending" },
        { content: "LLM B", status: "in_progress" },
      ],
      state,
    );

    const ids = state.getTodos().map((t) => t.id).sort();
    expect(ids).toEqual([
      "manual-1",
      "mirror:session:LLM A",
      "mirror:session:LLM B",
    ]);
  });

  it("the returned diff is a TodoDiff the caller can persist + inject", () => {
    const state = new TodoStateManager();
    const diff = mirrorLlmTodoWriteToSages(
      [{ content: "Build X", status: "pending" }],
      state,
    );
    // The shape matches TodoDiff — caller can pipe it into
    // `lastTodoChange = diff` and into buildTurnTodoBlock.
    expect(diff).toEqual({
      added: [{ id: "mirror:session:Build X", content: "Build X", status: "pending" }],
      removed: [],
      completed: [],
      reopened: [],
    });
  });
});