/**
 * todo-reminder.ts — GC-2026-060 auto-todowrite reminder builder.
 *
 * Pure functions (no pi API dependency — unit-testable) that render the
 * per-turn todo block injected by `before_agent_start` and track how long
 * in_progress todos have been active without progress.
 *
 * The injection contract mirrors the deepseek-harness repeat-tool-reminder
 * shape: thresholds escalate gentle → detailed, and a user interjection
 * (`input` event) resets the counters via `resetStale`.
 *
 * Stale semantics (documented for the caller):
 *   - `advanceStale` keeps only currently-active (in_progress) items in
 *     the tracker. A key present in `state.increments` means "was active
 *     in the previous snapshot" — so an item active in both snapshots is
 *     incremented, while newly-active or re-entering items start at 0.
 *   - Counter value = consecutive active turns MINUS one (a fresh
 *     in_progress item starts at 0, so default gentle=3 / detailed=5 fire
 *     on the 4th / 6th consecutive active turn).
 */

import type { TodoDiff, TodoItem } from "./todo-state.js";

// ─── Per-turn block rendering ─────────────────────────────────────────────

const MAX_CONTENT_LEN = 80;
const MAX_PENDING_LISTED = 5;

/** Consecutive-turn activity tracker for stale-todo detection. */
export interface StaleTracker {
  /** Identity key (todo.id when present, else content) → consecutive active-turn count. */
  increments: Record<string, number>;
}

/**
 * Compact per-turn todo block:
 *
 *   [sages todos: 3 pending | 1 in_progress | 2 completed]
 *   - in_progress: <content>
 *   - pending: <content>
 *
 * completed items are counted, not listed; at most `MAX_PENDING_LISTED`
 * pending items are listed (then '+N more'); content is truncated to ~80
 * chars. An empty list renders `[sages todos: none]`.
 *
 * When a non-empty `diff` is supplied, a trailing `changed: <highlight>`
 * line is appended so the block is self-describing. The full
 * before_agent_start injection should use `buildTurnTodoBlock` instead
 * (it emits the `⚠ changed:` prefix line).
 */
export function buildTodoBlock(todos: TodoItem[], diff?: TodoDiff): string {
  const block = renderTodoList(todos);
  const highlight = diff === undefined ? null : buildChangeHighlight(diff);
  if (highlight === null) return block;
  return `${block}\nchanged: ${highlight}`;
}

/**
 * Change highlight for a whole-list replacement diff. Only non-empty
 * buckets are included and only the first carries a `+` count prefix:
 * `+2 added · 1 completed · 1 reopened`. Returns null when nothing
 * changed.
 */
export function buildChangeHighlight(diff: TodoDiff): string | null {
  const parts: string[] = [];
  if (diff.added.length > 0) parts.push(`${diff.added.length} added`);
  if (diff.removed.length > 0) parts.push(`${diff.removed.length} removed`);
  if (diff.completed.length > 0) parts.push(`${diff.completed.length} completed`);
  if (diff.reopened.length > 0) parts.push(`${diff.reopened.length} reopened`);
  return parts.length === 0 ? null : `+${parts.join(" · ")}`;
}

/**
 * The per-turn injection (what `before_agent_start` appends): the todo
 * block plus, when the diff is non-empty, a leading `⚠ changed:` prefix
 * line so added/completed/reopened items are highlighted at the start of
 * the next turn.
 */
export function buildTurnTodoBlock(todos: TodoItem[], diff?: TodoDiff): string {
  const highlight = diff === undefined ? null : buildChangeHighlight(diff);
  const block = buildTodoBlock(todos, undefined);
  if (highlight === null) return block;
  return `⚠ changed: ${highlight}\n${block}`;
}

function renderTodoList(todos: TodoItem[]): string {
  if (todos.length === 0) return "[sages todos: none]";

  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const t of todos) {
    if (t.status === "pending") pending++;
    else if (t.status === "in_progress") inProgress++;
    else completed++;
  }

  const lines = [`[sages todos: ${pending} pending | ${inProgress} in_progress | ${completed} completed]`];
  for (const t of todos) {
    if (t.status === "in_progress") lines.push(`- in_progress: ${truncate(t.content)}`);
  }
  const pendingListed = todos.filter((t) => t.status === "pending").slice(0, MAX_PENDING_LISTED);
  for (const t of pendingListed) lines.push(`- pending: ${truncate(t.content)}`);
  const pendingOmitted = pending - pendingListed.length;
  if (pendingOmitted > 0) lines.push(`+${pendingOmitted} more`);
  return lines.join("\n");
}

function truncate(content: string): string {
  return content.length > MAX_CONTENT_LEN ? `${content.slice(0, MAX_CONTENT_LEN)}…` : content;
}

// ─── Stale tracking ───────────────────────────────────────────────────────

/**
 * Advance the stale tracker by one turn. `activeIds` are the identity
 * strings (todo.id when present, else content) of the todos the caller
 * considers active (in_progress) this turn. Items active in both the
 * current and the previous snapshot are incremented; changed/newly-active
 * items reset to 0; items that left the active set are dropped. Returns a
 * new tracker — the input is never mutated.
 */
export function advanceStale(state: StaleTracker, todos: TodoItem[], activeIds: string[]): StaleTracker {
  const active = new Set(activeIds);
  const increments: Record<string, number> = {};
  for (const todo of todos) {
    if (todo.status !== "in_progress") continue;
    const key = todo.id ?? todo.content;
    if (!active.has(key)) continue;
    const prev = state.increments[key];
    increments[key] = prev === undefined ? 0 : prev + 1;
  }
  return { increments };
}

/**
 * Build a reminder when in_progress todos have been active for too long.
 * Returns null when nothing is stale; the gentle text when any active
 * todo crossed `gentle`; the detailed text (naming up to `maxItems` stale
 * todos, worst first) when any crossed `detailed`. Both thresholds are
 * configurable; defaults are gentle=3, detailed=5.
 */
export function staleReminderFor(
  tracker: StaleTracker,
  thresholds: { gentle: number; detailed: number },
  maxItems = 3,
): string | null {
  const stale = Object.entries(tracker.increments)
    .filter(([, turns]) => turns >= thresholds.gentle)
    .sort((a, b) => b[1] - a[1]);
  if (stale.length === 0) return null;

  const worst = stale[0][1];
  if (worst >= thresholds.detailed) {
    const names = stale
      .filter(([, turns]) => turns >= thresholds.detailed)
      .slice(0, maxItems)
      .map(([key]) => `"${key}"`);
    if (names.length === 1) {
      return (
        `Todo ${names[0]} has been in_progress for ${worst} turns without progress. ` +
        "Inspect the latest state and either finish it, split it, or re-scope it."
      );
    }
    return (
      `Todos ${names.join(", ")} have been in_progress for ${worst} turns without progress. ` +
      "Inspect the latest state and either finish them, split them, or re-scope them."
    );
  }

  return (
    "You have todos that have been in_progress for a while — " +
    "verify each is still advancing or mark it pending/complete."
  );
}

/**
 * Clear all stale counters (used when the user interjects — their
 * message resets the staleness clock, mirroring repeat-tool-reminder).
 */
export function resetStale(_tracker: StaleTracker): StaleTracker {
  return { increments: {} };
}
