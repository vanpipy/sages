/**
 * todo-mirror.ts — GC-2026-067 T3 SC5.
 *
 * One-way mirror from the pi built-in `todowrite` LLM tool into the
 * Sages-owned `TodoStateManager` store.
 *
 * Why a separate module (and not the existing extension.ts hook):
 *
 *   The LLM-side `todowrite` tool keeps its list only in LLM context.
 *   Sages needs a durable, observable copy so that:
 *     - `before_agent_start` can inject the current list + change
 *       highlight every turn;
 *     - `turn_end` can advance the staleness tracker and surface
 *       gentle / detailed reminders;
 *     - session_start can resume the list across restarts.
 *
 *   The existing extension.ts hook called `todoState.apply(items)`
 *   directly, which collapsed mirror entries into the same id/content
 *   namespace as operator-authored `sages_todo` entries. That breaks
 *   two things SC5 cares about:
 *
 *     - Removal detection: when the LLM drops a TodoWrite entry, the
 *       direct-apply path silently removes it from the store. There is
 *       no audit trail, and the staleness tracker can't tell "the LLM
 *       stopped talking about X" from "the operator completed X".
 *     - Dag isolation: a parallel workflow's mirror entries can clobber
 *       the active workflow's mirror entries. Same content → same key.
 *
 *   This module fixes both by giving every mirror entry a distinct id
 *   namespace: `mirror:<dagId ?? 'session'>:<content>`. Removals are
 *   NOT delete operations — they become `[mirror-cancelled] <content>`
 *   completed entries so the lifecycle is observable after the fact.
 *
 * Keying:
 *
 *   key   = `${dagId ?? 'session'}:${content}`
 *   id    = `mirror:${key}`
 *
 * The dagId prefix lets parallel workflows coexist; the `session` default
 * covers ad-hoc / root-agent workflows that have no DAG.
 *
 * Conflict resolution (per SC5 anti-goal):
 *
 *   Last-write-wins. The LLM is the source of truth for what is on its
 *   TodoWrite list; this module translates that into store mutations.
 *   Concurrent manual edits via `sages_todo({action: "sync"})` use
 *   user-supplied ids (no `mirror:` prefix), so they live in a disjoint
 *   namespace and never collide with the mirror. If the operator does
 *   want to retire a mirror entry, calling `sages_todo({action: "sync",
 *   todos: [...]})` with their own id wins because whole-list
 *   replacement drops anything whose key is not in the snapshot.
 *
 * Filtering (per SC5 anti-goal):
 *
 *   - empty / whitespace-only content is dropped;
 *   - bracketed `[TODO_DONE]`-style markers (Sages-internal
 *     scaffolding) are dropped — only user-facing content persists;
 *   - non-pending/in_progress/completed statuses are dropped;
 *   - non-object entries are dropped silently.
 *
 * The mirror never throws: a malformed LLM input must never break the
 * agent's tool execution. Callers observe drops as `diff.added` /
 * `diff.removed` / `diff.completed` counts being smaller than the
 * incoming list length.
 */

import {
  TodoStateManager,
  type TodoDiff,
  type TodoItem,
} from "./todo-state.js";

/** Mirror-key prefix. Mirrored entries are easy to filter out of a
 *  store dump without changing the on-disk schema. */
export const MIRROR_ID_PREFIX = "mirror:";

/** Marker that prefixes the content of a cancelled mirror entry. */
export const MIRROR_CANCELLED_PREFIX = "[mirror-cancelled] ";

/** Statuses the mirror accepts from the LLM. Anything else is dropped. */
const MIRROR_STATUSES = new Set<TodoItem["status"]>(["pending", "in_progress", "completed"]);

export interface MirrorOptions {
  /**
   * Workflow namespace for the mirror key. Distinct dagIds keep
   * parallel workflows' mirror entries from clobbering each other
   * (e.g. `mirror:GC-2026-067:Build X` vs `mirror:GC-2026-068:Build X`).
   * When omitted (or empty) the mirror uses the `session` namespace —
   * the right default for ad-hoc root-agent workflows with no DAG.
   */
  dagId?: string | null;
}

/** Result of one mirror pass. Same shape as `TodoDiff` (whole-list
 *  replacement semantics), so callers can feed it directly into the
 *  `lastTodoChange` slot the extension uses for the one-shot change
 *  highlight in `before_agent_start`. */
export type MirrorDiff = TodoDiff;

/** A raw entry as the LLM submits it. The mirror ignores user-supplied
 *  ids — mirror entries always get a deterministic `mirror:<key>` id —
 *  so the LLM's transient TodoWrite titles never collide with operator-
 *  authored todos. */
export interface LlmTodoEntry {
  content: string;
  status: TodoItem["status"];
  id?: string;
  priority?: TodoItem["priority"];
}

/**
 * Mirror a snapshot of LLM `todowrite` entries into the supplied
 * TodoStateManager. Returns the diff that was applied. Never throws.
 *
 * Semantics:
 *
 *   - The mirror key for an entry is `<dagId ?? 'session'>:<content>`.
 *     The persisted id is `mirror:<key>`.
 *   - Entries with content matching `^\[<text>\]$` (e.g. `[TODO_DONE]`,
 *     `[draft]`) are filtered out — these are Sages-internal /
 *     placeholder markers, not user-facing todos (SC5 anti-goal).
 *   - Empty / whitespace-only content is filtered out.
 *   - Statuses outside `pending | in_progress | completed` are filtered
 *     out (best-effort: never throws).
 *   - Re-mirroring the same key with a different status updates the
 *     existing entry in place (id preserved).
 *   - Mirror entries whose content disappears from the new snapshot
 *     are NOT removed from the store; they are marked completed with
 *     content `[mirror-cancelled] <original>` so the lifecycle is
 *     observable. This is the contract the staleness tracker relies
 *     on to know "the LLM stopped talking about X".
 *   - Manual (non-mirror) entries are left untouched — a parallel
 *     `sages_todo` sync from the operator survives a mirror.
 *
 * The returned diff is suitable for assignment to `lastTodoChange` so
 * `before_agent_start` can render the one-shot change highlight.
 */
export function mirrorLlmTodoWriteToSages(
  rawEntries: ReadonlyArray<unknown> | null | undefined,
  state: TodoStateManager,
  opts: MirrorOptions = {},
): MirrorDiff {
  const dagId = sanitizeDagId(opts.dagId);
  const namespacePrefix = `${MIRROR_ID_PREFIX}${dagId}:`;
  const accepted = filterMirrorEntries(rawEntries);

  // Build the new full snapshot by mutating only entries in OUR
  // namespace. Items in other mirror namespaces (parallel workflows)
  // and manual (non-mirror) entries are passed through unchanged.
  //
  // Whole-list replacement via state.apply() is the only mutation
  // surface, so we do exactly ONE apply at the end — never per-item.
  const before = state.getTodos();
  const acceptedByKey = new Map<string, TodoItem>(
    accepted.map((e) => [keyOf(dagId, e.content), e] as const),
  );

  const after: TodoItem[] = [];
  const seenKeys = new Set<string>();
  for (const todo of before) {
    if (!(todo.id ?? "").startsWith(namespacePrefix)) {
      // Manual entry, or another workflow's mirror — keep as-is.
      after.push(todo);
      continue;
    }
    const key = keyOf(dagId, todo.content);
    const incoming = acceptedByKey.get(key);
    if (incoming === undefined) {
      // LLM dropped this entry → cancel (idempotent: skip if already
      // cancelled, otherwise append the cancelled marker entry).
      if (todo.content.startsWith(MIRROR_CANCELLED_PREFIX) && todo.status === "completed") {
        after.push(todo);
        seenKeys.add(key);
      } else {
        after.push({
          id: todo.id,
          content: `${MIRROR_CANCELLED_PREFIX}${todo.content}`,
          status: "completed",
        });
        seenKeys.add(key);
      }
      continue;
    }
    // LLM still has this entry — preserve id, refresh status.
    after.push({ ...todo, status: incoming.status });
    seenKeys.add(key);
  }

  // Add brand-new entries (the LLM introduced something we hadn't seen).
  for (const incoming of accepted) {
    const key = keyOf(dagId, incoming.content);
    if (seenKeys.has(key)) continue;
    const item: TodoItem = {
      content: incoming.content,
      status: incoming.status,
      id: `${MIRROR_ID_PREFIX}${key}`,
    };
    if (incoming.priority !== undefined) item.priority = incoming.priority;
    after.push(item);
    seenKeys.add(key);
  }

  return state.apply(after);
}

// ─── internals ──────────────────────────────────────────────────────────────

/** Sanitize the dagId for use in a mirror key. Anything falsy / non-string
 *  collapses to 'session'. Throws on illegal characters so a typo in
 *  the caller surfaces immediately (mirror keys are part of the id
 *  surface, and a `mirror:foo/bar:...` id would round-trip through the
 *  store as a corrupted identity). */
function sanitizeDagId(raw: unknown): string {
  if (raw === undefined || raw === null) return "session";
  if (typeof raw !== "string" || raw.length === 0) return "session";
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
    throw new Error(
      `mirror dagId must match [A-Za-z0-9_-]+ (got '${raw}') — ` +
        "mirror keys double as TodoItem ids and must round-trip through the store",
    );
  }
  return raw;
}

function keyOf(dagId: string, content: string): string {
  return `${dagId}:${content}`;
}

/** Filter raw entries into a clean TodoItem array. Drops empty /
 *  whitespace content, bracketed TODO_DONE markers, non-object
 *  entries, and unrecognized statuses. Never throws. */
function filterMirrorEntries(rawEntries: ReadonlyArray<unknown> | null | undefined): TodoItem[] {
  if (!Array.isArray(rawEntries)) return [];
  const out: TodoItem[] = [];
  for (const raw of rawEntries) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.content !== "string") continue;
    const content = entry.content.trim();
    if (content.length === 0) continue;
    // Sages-internal marker convention: `[<text>]` is treated as
    // scaffolding, not user-facing content. This filter is per the
    // SC5 anti-goal ("Do NOT capture LLM TodoWrite content that
    // contains content matching the Sages-internal TODO_DONE marker /
    // temporary state — only persist user-facing content").
    if (isInternalMarker(content)) continue;
    if (typeof entry.status !== "string") continue;
    if (!MIRROR_STATUSES.has(entry.status as TodoItem["status"])) continue;
    const item: TodoItem = {
      content,
      status: entry.status as TodoItem["status"],
    };
    if (entry.priority === "high" || entry.priority === "medium" || entry.priority === "low") {
      item.priority = entry.priority;
    }
    out.push(item);
  }
  return out;
}

/** True when content begins with a `[<token>] ` marker. The
 *  Sages-internal placeholder convention used for TODO_DONE-style
 *  scratch entries is `[<UPPER_TOKEN>] <rest>` (e.g. `[TODO_DONE]
 *  internal placeholder`, `[draft] not ready`). The leading
 *  bracket-token-prefix is treated as scaffolding, not user-facing
 *  content. Per the SC5 anti-goal: "Do NOT capture LLM TodoWrite
 *  content that contains content matching the Sages-internal
 *  TODO_DONE marker / temporary state — only persist user-facing
 *  content". We do NOT filter fully-bracketed content (e.g. `[X]`)
 *  with no trailing body — that pattern is too aggressive and would
 *  nuke legitimate short-form todos. */
function isInternalMarker(content: string): boolean {
  return /^\[[^\]]+\]\s/.test(content);
}