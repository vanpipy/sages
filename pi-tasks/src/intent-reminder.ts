/**
 * intent-reminder.ts — Composes the system-prompt reminder that nudges
 * the main LLM about pending `kind: "intent"` tasks.
 *
 * The reminder reaches the LLM via the `before_agent_start` handler's
 * return value (`{ systemPrompt: <existing> + <reminder> }`), not via
 * `ctx.ui.notify` (which is a UI-level toast the LLM does not see).
 * The pattern mirrors `pi-orchestrator/src/extension.ts`'s SYSTEM.md
 * injection. See `pi-tasks/src/index.ts:858-878` for the wiring.
 *
 * ## GC-2026-continuous-intent-reminder: continuous, not one-shot
 *
 * The pre-fix implementation tracked a per-session `remindedIds` set
 * and returned `null` once an intent had been listed once. The
 * "once-per-session" dedup left intent tasks silent whenever the main
 * LLM got distracted, forgot, or the prior `decompose_task` call
 * failed — the only way to get re-reminded was a `session_start`
 * reset, which the user cannot trigger on demand. Empirically
 * observed in the session that introduced this GC ("了解一下当前仓库"
 * sat pending across multiple LLM turns with no further push).
 *
 * The fix: drop the dedup state. The reminder now lists EVERY pending
 * `kind: "intent"` task on EVERY call. The intent naturally leaves the
 * reminder when its `status` flips off `pending`, which happens in two
 * places:
 *
 *   1. `materializeDecomposeChain` auto-completes the user task on
 *      successful chain materialization (`completed_via: "decomposition"`,
 *      GC-2026-120 AC3 / D2). Failure path: AC6 rolls the user task
 *      back to pending, so the reminder re-surfaces it next turn.
 *   2. The LLM explicitly marks it completed via `TaskUpdate` (the
 *      chat-answer path from the call-to-action for trivial intents).
 *
 * The main LLM is the sole consumer of intent tasks; this GC only
 * fixes the transport so the consumer is reached until it actually
 * consumes.
 */

import type { TaskStore } from "./task-store.js";

/**
 * Compose the reminder text for ALL currently-pending `kind: "intent"`
 * tasks in the store. Returns `null` when no intent task is pending
 * (the caller then leaves the system prompt untouched).
 *
 * The function is intentionally pure and stateless — the same store
 * snapshot always produces the same text. Caller-side state is not
 * needed: the reminder predicate is "status === 'pending' && kind ===
 * 'intent'", and the natural exit path is the task leaving `pending`
 * status (auto-complete via decomposition, or explicit TaskUpdate).
 */
export function composeIntentReminder(
  store: TaskStore,
  isOwned?: (taskId: string) => boolean,
): string | null {
  const intents = store.list().filter(
    (t) =>
      t.status === "pending" &&
      t.metadata?.kind === "intent" &&
      !(isOwned ? isOwned(t.id) : false),
  );
  if (intents.length === 0) return null;

  const lines: string[] = [
    `[fallback] ${intents.length} orphaned intent task(s) not yet seen by the IntentPump — call ` + "`decompose_task`" + ` or chat-answer + ` + "`TaskUpdate`" + `:`,
  ];
  for (const t of intents) {
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
 * handler should return. Returns `undefined` when no intent task is
 * pending (caller passes that through unchanged).
 *
 * The reminder is APPENDED to the existing system prompt with a `---`
 * separator, so existing overlays (e.g. pi-orchestrator's
 * `templates/SYSTEM.md`) are preserved above the reminder block.
 *
 * GC-2026-continuous-intent-reminder: the function is now pure and
 * stateless. The pre-fix signature took a per-session `state` object
 * to dedup reminded intents; that state was removed because the
 * reminder needs to keep firing on every call until the intent is
 * consumed.
 */
export function applyIntentReminderToSystemPrompt(
  store: TaskStore,
  existingSystemPrompt: string | undefined,
  isOwned?: (taskId: string) => boolean,
): { systemPrompt: string } | undefined {
  const reminder = composeIntentReminder(store, isOwned);
  if (!reminder) return undefined;
  const base = existingSystemPrompt ?? "";
  return {
    systemPrompt: base
      ? `${base}\n\n---\n\n${reminder}`
      : reminder,
  };
}
