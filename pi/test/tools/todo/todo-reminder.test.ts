/**
 * todo-reminder tests — GC-2026-060 auto-todowrite reminder builder.
 *
 * Covers:
 *  - buildTodoBlock: header counts, in_progress/pending lines, completed
 *    counted-only, 5-pending cap with '+N more', 80-char truncation,
 *    empty list → "[sages todos: none]", optional diff change line
 *  - buildChangeHighlight: non-empty parts joined, null when nothing changed
 *  - buildTurnTodoBlock: ⚠ changed: prefix line + block (before_agent_start
 *    injection shape)
 *  - advanceStale: increment semantics, drop on leaving active set, reset
 *    on re-entry, content-identity keys, non-mutating
 *  - staleReminderFor: null / gentle / detailed, detailed wins, maxItems
 *    cap, custom thresholds, singular vs plural naming
 *  - resetStale: clears all increments
 */

import { describe, expect, it } from "bun:test";
import {
  buildTodoBlock,
  buildChangeHighlight,
  buildTurnTodoBlock,
  advanceStale,
  staleReminderFor,
  resetStale,
  type StaleTracker,
} from "@/tools/todo/todo-reminder.js";
import type { TodoDiff, TodoItem } from "@/tools/todo/todo-state.js";

const item = (content: string, status: TodoItem["status"] = "pending", id?: string): TodoItem =>
  id !== undefined ? { content, status, id } : { content, status };

const emptyDiff: TodoDiff = { added: [], removed: [], completed: [], reopened: [] };

describe("buildTodoBlock", () => {
  it("renders [sages todos: none] for an empty list", () => {
    expect(buildTodoBlock([])).toBe("[sages todos: none]");
  });

  it("renders header counts and in_progress/pending lines; completed are counted only", () => {
    const todos = [
      item("write tests", "in_progress"),
      item("implement tool", "pending"),
      item("done thing", "completed"),
      item("done thing 2", "completed"),
    ];
    expect(buildTodoBlock(todos)).toBe(
      "[sages todos: 1 pending | 1 in_progress | 2 completed]\n" +
        "- in_progress: write tests\n" +
        "- pending: implement tool",
    );
  });

  it("lists at most 5 pending items then '+N more'", () => {
    const todos = Array.from({ length: 7 }, (_, i) => item(`pending task ${i + 1}`, "pending"));
    const block = buildTodoBlock(todos);
    expect(block).toContain("[sages todos: 7 pending | 0 in_progress | 0 completed]");
    expect(block).toContain("- pending: pending task 5");
    expect(block).toContain("+2 more");
    const pendingLines = block.split("\n").filter((l) => l.startsWith("- pending:"));
    expect(pendingLines).toHaveLength(5);
  });

  it("truncates long content to ~80 chars", () => {
    const long = "a".repeat(100);
    const block = buildTodoBlock([item(long, "pending")]);
    expect(block).toContain(`- pending: ${"a".repeat(80)}…`);
  });

  it("appends a 'changed:' line when a non-empty diff is supplied", () => {
    const diff: TodoDiff = { ...emptyDiff, added: [item("new")] };
    const block = buildTodoBlock([item("x", "pending")], diff);
    expect(block).toBe(
      "[sages todos: 1 pending | 0 in_progress | 0 completed]\n" +
        "- pending: x\n" +
        "changed: +1 added",
    );
  });

  it("ignores an empty diff (no changed line)", () => {
    expect(buildTodoBlock([item("x", "pending")], emptyDiff)).toBe(
      "[sages todos: 1 pending | 0 in_progress | 0 completed]\n- pending: x",
    );
  });
});

describe("buildChangeHighlight", () => {
  it("joins only non-empty parts", () => {
    const diff: TodoDiff = {
      added: [item("a"), item("b")],
      removed: [],
      completed: [item("c", "completed")],
      reopened: [item("d", "pending")],
    };
    expect(buildChangeHighlight(diff)).toBe("+2 added · 1 completed · 1 reopened");
  });

  it("includes removed when present", () => {
    const diff: TodoDiff = { ...emptyDiff, removed: [item("gone", "completed")] };
    expect(buildChangeHighlight(diff)).toBe("+1 removed");
  });

  it("returns null when nothing changed", () => {
    expect(buildChangeHighlight(emptyDiff)).toBeNull();
  });
});

describe("buildTurnTodoBlock", () => {
  it("returns just the block when there is no diff", () => {
    const todos = [item("x", "pending")];
    expect(buildTurnTodoBlock(todos)).toBe(buildTodoBlock(todos));
  });

  it("prepends a '⚠ changed:' prefix line when diff is non-empty", () => {
    const todos = [item("x", "pending")];
    const diff: TodoDiff = { ...emptyDiff, added: [item("new")] };
    expect(buildTurnTodoBlock(todos, diff)).toBe(
      "⚠ changed: +1 added\n" +
        "[sages todos: 1 pending | 0 in_progress | 0 completed]\n" +
        "- pending: x",
    );
  });

  it("combines an empty list with a diff into prefix + none", () => {
    const diff: TodoDiff = { ...emptyDiff, added: [item("new")] };
    expect(buildTurnTodoBlock([], diff)).toBe("⚠ changed: +1 added\n[sages todos: none]");
  });
});

describe("advanceStale", () => {
  const fresh: StaleTracker = { increments: {} };
  const todos = [item("build api", "in_progress", "P1")];

  it("starts newly-active items at 0", () => {
    expect(advanceStale(fresh, todos, ["P1"]).increments).toEqual({ P1: 0 });
  });

  it("increments items active in both current and previous snapshot", () => {
    const t1 = advanceStale(fresh, todos, ["P1"]);
    const t2 = advanceStale(t1, todos, ["P1"]);
    expect(t2.increments).toEqual({ P1: 1 });
  });

  it("drops items that leave the active set", () => {
    const t1 = advanceStale(fresh, todos, ["P1"]);
    const done = [item("build api", "completed", "P1")];
    expect(advanceStale(t1, done, []).increments).toEqual({});
  });

  it("resets re-entering items to 0", () => {
    const t1 = advanceStale(fresh, todos, ["P1"]);
    const paused = [item("build api", "pending", "P1")];
    const t2 = advanceStale(t1, paused, []);
    const back = advanceStale(t2, todos, ["P1"]);
    expect(back.increments).toEqual({ P1: 0 });
  });

  it("keys by content when the todo has no id", () => {
    const contentTodo = [item("review design", "in_progress")];
    const t1 = advanceStale(fresh, contentTodo, ["review design"]);
    expect(t1.increments).toEqual({ "review design": 0 });
    expect(advanceStale(t1, contentTodo, ["review design"]).increments).toEqual({
      "review design": 1,
    });
  });

  it("does not mutate the input tracker", () => {
    const input: StaleTracker = { increments: { P1: 0 } };
    const out = advanceStale(input, todos, ["P1"]);
    expect(input.increments).toEqual({ P1: 0 });
    expect(out.increments).toEqual({ P1: 1 });
    expect(out).not.toBe(input);
  });
});

describe("staleReminderFor", () => {
  it("returns null when nothing is stale", () => {
    expect(staleReminderFor({ increments: { P1: 2 } }, { gentle: 3, detailed: 5 })).toBeNull();
  });

  it("returns the gentle reminder when the gentle threshold is crossed", () => {
    const r = staleReminderFor({ increments: { P1: 3 } }, { gentle: 3, detailed: 5 });
    expect(r).toBe(
      "You have todos that have been in_progress for a while — verify each is still advancing or mark it pending/complete.",
    );
  });

  it("returns a detailed reminder naming the todo when the detailed threshold is crossed", () => {
    const r = staleReminderFor({ increments: { P1: 5 } }, { gentle: 3, detailed: 5 });
    expect(r).toBe(
      'Todo "P1" has been in_progress for 5 turns without progress. Inspect the latest state and either finish it, split it, or re-scope it.',
    );
  });

  it("detailed wins over gentle when both are present", () => {
    const r = staleReminderFor({ increments: { P1: 3, P2: 6 } }, { gentle: 3, detailed: 5 });
    expect(r).toContain('Todo "P2" has been in_progress for 6 turns');
  });

  it("names at most maxItems detailed items, worst first", () => {
    const r = staleReminderFor(
      { increments: { P1: 5, P2: 6, P3: 7, P4: 8 } },
      { gentle: 3, detailed: 5 },
      2,
    );
    expect(r).toContain('"P4"');
    expect(r).toContain('"P3"');
    expect(r).not.toContain('"P1"');
    expect(r).not.toContain('"P2"');
  });

  it("uses plural wording for multiple detailed items", () => {
    const r = staleReminderFor({ increments: { P1: 5, P2: 6 } }, { gentle: 3, detailed: 5 });
    expect(r).toBe(
      'Todos "P2", "P1" have been in_progress for 6 turns without progress. Inspect the latest state and either finish them, split them, or re-scope them.',
    );
  });

  it("honors custom thresholds", () => {
    expect(
      staleReminderFor({ increments: { P1: 2 } }, { gentle: 2, detailed: 4 }),
    ).toContain("You have todos that have been in_progress for a while");
    expect(
      staleReminderFor({ increments: { P1: 4 } }, { gentle: 2, detailed: 4 }),
    ).toContain('Todo "P1" has been in_progress for 4 turns');
  });
});

describe("resetStale", () => {
  it("clears all increments", () => {
    const reset = resetStale({ increments: { P1: 5, P2: 2 } });
    expect(reset.increments).toEqual({});
  });

  it("subsequent advance treats items as freshly active", () => {
    const reset = resetStale({ increments: { P1: 5 } });
    const todos = [item("build api", "in_progress", "P1")];
    expect(advanceStale(reset, todos, ["P1"]).increments).toEqual({ P1: 0 });
  });
});
