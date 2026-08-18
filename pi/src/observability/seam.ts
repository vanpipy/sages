/**
 * seam — extension hook event dispatcher.
 *
 * Each seam event fires registered callbacks. Callbacks receive the
 * optional payload and return a `Promise<void>`; the dispatcher awaits
 * all callbacks in registration order. If a callback throws, the
 * promise rejects with that error — the dispatcher does NOT swallow
 * exceptions.
 *
 * The registry is in-process state. It is intentionally NOT persisted
 * across sessions: a seam callback registered in session A does not
 * fire in session B. The extension that owns the seam re-registers
 * callbacks on every `session_start`. This keeps seam callbacks
 * composable and prevents stale registrations from a previously-killed
 * session from firing against the current one.
 *
 * Usage:
 *
 *   import { onSeam, emitSeamEvent, SeamEvent } from "./seam.js";
 *
 *   // At module load or session_start: register a callback.
 *   onSeam(SeamEvent.Preflight, async (payload) => { ... });
 *
 *   // At the seam boundary: fire the event.
 *   await emitSeamEvent(SeamEvent.Preflight, { dagId });
 */

import { SeamEvent, domainOf } from "./events.js";

/** A seam callback receives the optional payload and returns a promise. */
type SeamCallback = (payload?: Record<string, unknown>) => Promise<void>;

/**
 * Process-scoped callback registry. Keyed by `SeamEvent` so each seam
 * has its own independent FIFO of callbacks.
 */
const registry = new Map<SeamEvent, SeamCallback[]>();

/**
 * Register a callback for a seam event.
 *
 * Multiple callbacks may be registered for the same event; they fire
 * in registration order. Asserts that `event` is a `seam/*` member.
 */
export function onSeam(event: SeamEvent, callback: SeamCallback): void {
  if (domainOf(event) !== "seam") {
    throw new Error(`onSeam called with non-seam event: ${event}`);
  }
  const list = registry.get(event) ?? [];
  list.push(callback);
  registry.set(event, list);
}

/**
 * Fire a seam event. Awaits every registered callback in registration
 * order. If no callbacks are registered, this resolves immediately.
 *
 * Asserts that `event` is a `seam/*` member. The first callback that
 * throws causes the returned promise to reject; remaining callbacks
 * are NOT executed (fail-fast semantics, matching the orchestrator's
 * pass/fail gate).
 */
export async function emitSeamEvent(
  event: SeamEvent,
  payload?: Record<string, unknown>,
): Promise<void> {
  if (domainOf(event) !== "seam") {
    throw new Error(`emitSeamEvent called with non-seam event: ${event}`);
  }
  const callbacks = registry.get(event) ?? [];
  for (const cb of callbacks) {
    await cb(payload);
  }
}

/**
 * Clear registered callbacks. Test-only; production code should not
 * need this. Pass an `event` to clear only that event's callbacks;
 * omit to clear the whole registry.
 */
export function clearSeamCallbacks(event?: SeamEvent): void {
  if (event) {
    registry.delete(event);
  } else {
    registry.clear();
  }
}
