/**
 * step — live step/* event emitter.
 *
 * step/* events are ephemeral signals emitted during a single
 * orchestration step. They are written ONLY to the active logger
 * (stdout via `console.log` by default; can be swapped for pino or
 * any structured logger without changing the call sites) and NEVER
 * to the audit-state file.
 *
 * Rationale: the audit trail captures run/* milestones, not every
 * step. Recording every step would double-write information that the
 * step-event consumer (the developer reading stdout / pino) already
 * sees live. Splitting the durability profile along the domain axis
 * keeps audit-state small and the live trace readable.
 */

import { StepEvent, domainOf } from "./events.js";

/**
 * Emit a step/* event to the logger. Asserts the event is a `step/*`
 * member (other domains are routed to their own emitter).
 *
 * The default implementation uses `console.log` so the emitter works
 * under both the bun runtime and the node runtime without pulling in
 * pino. To route to a different logger, replace this function's body
 * with a structured-logger call; the call sites depend only on the
 * export shape.
 */
export function emitStepEvent(event: StepEvent, payload?: Record<string, unknown>): void {
  if (domainOf(event) !== "step") {
    throw new Error(`emitStepEvent called with non-step event: ${event}`);
  }
  const ts = new Date().toISOString();
  // Ephemeral log line; not durable. Keeps the trace readable without
  // the structure overhead of a structured logger.
  console.log(`[step ${ts}] ${event}`, payload ?? "");
}
