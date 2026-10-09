/**
 * intent-reminder.ts — Composes the system-prompt reminder that nudges
 * the main LLM about pending `kind: "intent"` tasks (GC-2026-122).
 *
 * The previous implementation (GC-2026-120 AC5) called
 * `ctx.ui.notify(...)` to surface the reminder. `ctx.ui.notify` is a
 * UI-level toast — the LLM does NOT see it. The reminder was effectively
 * a user-facing decoration while the LLM remained unaware of the
 * pending intent task, so dropping the Planner auto-spawn would have
 * left intent tasks with NO consumer at all.
 *
 * GC-2026-122 fixes the transport: the reminder is composed into a
 * string and injected into the LLM's system prompt via the
 * `before_agent_start` handler's return value (mirroring
 * `pi-orchestrator/src/extension.ts`'s SYSTEM.md injection pattern).
 * The text explicitly tells the main LLM to call
 * `decompose_task(user_task_id="<id>", specs=[...])` directly, OR to
 * chat-answer the user if the intent is trivial. Either path consumes
 * the intent; it does not stay silently pending.
 *
 * Dedup: per-intent state (`remindedIds`) keeps the same intent from
 * being re-listed in the reminder on every `before_agent_start` fire.
 * The state should be reset on `session_start` (caller's responsibility;
 * see `pi-tasks/src/index.ts:836`).
 */

import type { TaskStore } from "./task-store.js";

export interface IntentReminderState {
  /** IDs of intent tasks already surfaced via the reminder. */
  remindedIds: Set<string>;
}

export function makeIntentReminderState(): IntentReminderState {
  return { remindedIds: new Set() };
}

/**
 * Compose the reminder text for currently-pending intent tasks that
 * have NOT been reminded before (per the supplied state).
 *
 * Returns `null` when there are no NEW pending intents (either no
 * intents at all, or every pending intent is already in
 * `state.remindedIds`). The state is mutated in place to add the
 * newly-reminded IDs.
 */
export function composeIntentReminder(
  store: TaskStore,
  state: IntentReminderState,
): string | null {
  const intents = store.list().filter(
    (t) =>
      t.status === "pending" &&
      t.metadata?.kind === "intent",
  );
  const newIntents = intents.filter((t) => !state.remindedIds.has(t.id));
  if (newIntents.length === 0) return null;
  for (const t of intents) state.remindedIds.add(t.id);

  const lines: string[] = [
    `[GC-2026-122] ${newIntents.length} pending intent task(s) awaiting your action — call \`decompose_task\` to materialize a chain, or chat-answer directly if the intent is trivial:`,
  ];
  for (const t of newIntents) {
    const desc = t.description.length > 80
      ? `${t.description.slice(0, 77)}...`
      : t.description;
    lines.push(`- #${t.id}: ${t.subject} — ${desc}`);
  }
  lines.push(
    `Call \`decompose_task(user_task_id="<id>", specs=[...])\` to materialize a chain. For trivial intents, chat-answer the user directly and mark the task completed via \`TaskUpdate\`. Do NOT leave the task pending.`,
  );
  return lines.join("\n");
}

/**
 * Build the `{ systemPrompt }` payload that the `before_agent_start`
 * handler should return. Returns `undefined` when there is no new
 * intent to remind about (caller passes that through unchanged).
 *
 * The reminder is APPENDED to the existing system prompt with a `---`
 * separator, so existing overlays (e.g. pi-orchestrator's
 * `templates/SYSTEM.md`) are preserved above the reminder block.
 */
export function applyIntentReminderToSystemPrompt(
  store: TaskStore,
  state: IntentReminderState,
  existingSystemPrompt: string | undefined,
): { systemPrompt: string } | undefined {
  const reminder = composeIntentReminder(store, state);
  if (!reminder) return undefined;
  const base = existingSystemPrompt ?? "";
  return {
    systemPrompt: base
      ? `${base}\n\n---\n\n${reminder}`
      : reminder,
  };
}
