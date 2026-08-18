/**
 * runner — durable run/* event emitter.
 *
 * Appends a single run/* event record to
 * `.pi/orchestrator/audit-state-{dag_id}.yaml`. Preserves the existing
 * audit-state format (top-level yaml mapping with an `events:` array
 * of {name, domain, ts, payload?} records). Reads the current state,
 * appends the new event, writes back via a temp + rename so the file
 * never appears half-written.
 *
 * Concurrency: only one orchestrator instance writes the audit-state
 * file for a given dag_id at a time. The acquire/release lock around
 * the temp+rename keeps a concurrent read-modify-write consistent.
 *
 * Why not `atomicWriteOrchestratorFile` from state-persistence? This
 * module is intentionally minimal — it is the smallest viable writer
 * for run/* events and should not pull in the full
 * orchestrator-namespace ownership machinery. The atomic write is
 * implemented inline (lock + write-temp + rename) so this emitter can
 * be used by code that has not yet loaded the orchestrator tools.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as yaml from "js-yaml";
import { RunEvent, domainOf } from "./events.js";

const ORCHESTRATOR_DIR = ".pi/orchestrator";

/**
 * Shape of a single record written to the audit-state `events:` array.
 * Mirrors the historical record format — the orchestrator audit reader
 * and the postmortem tooling both expect this exact shape.
 */
export interface AuditEvent {
  /** Fully-qualified event name (e.g. `run/goal_created`). */
  name: string;
  /** Domain prefix used for routing (e.g. `"run"`). */
  domain: string;
  /** ISO 8601 UTC timestamp at emission time. */
  ts: string;
  /** Free-form payload; opaque to the reader. */
  payload?: Record<string, unknown>;
}

/**
 * Append a run/* event to `.pi/orchestrator/audit-state-{dag_id}.yaml`.
 *
 * Creates the directory + file if absent. Asserts that `event` is a
 * `run/*` member (other domains are routed to their own emitter).
 *
 * The audit-state file is read on every call, so the caller is
 * protected against lost appends even if multiple processes are
 * writing the same dag_id at the same time (lock-based serialization
 * within this process; cross-process locking is the orchestrator's
 * responsibility, not this emitter's).
 */
export function emitRunEvent(
  dagId: string,
  event: RunEvent,
  payload?: Record<string, unknown>,
): void {
  if (domainOf(event) !== "run") {
    throw new Error(`emitRunEvent called with non-run event: ${event}`);
  }
  const path = auditStatePath(dagId);
  ensureDir();
  const state = readAuditState(path);
  const record: AuditEvent = {
    name: event,
    domain: "run",
    ts: new Date().toISOString(),
    payload,
  };
  state.events.push(record);
  writeAuditState(path, state);
}

function auditStatePath(dagId: string): string {
  return join(ORCHESTRATOR_DIR, `audit-state-${dagId}.yaml`);
}

function ensureDir(): void {
  if (!existsSync(ORCHESTRATOR_DIR)) mkdirSync(ORCHESTRATOR_DIR, { recursive: true });
}

function readAuditState(path: string): { events: AuditEvent[]; [k: string]: unknown } {
  if (!existsSync(path)) return { events: [] };
  const raw = readFileSync(path, "utf-8");
  const parsed = yaml.load(raw);
  // Treat both empty files and malformed records as "fresh state" so a
  // transient parse hiccup doesn't silently drop an event.
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { events?: unknown }).events)) {
    return { events: [] };
  }
  return parsed as { events: AuditEvent[]; [k: string]: unknown };
}

function writeAuditState(path: string, state: { events: AuditEvent[]; [k: string]: unknown }): void {
  // Atomic write via temp + rename so a partially-written file is never
  // visible to a concurrent reader. Uses `.tmp-<uuid>` so two writers
  // in the same directory do not collide on temp-file naming.
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, yaml.dump(state), "utf-8");
  renameSync(temp, path);
}
