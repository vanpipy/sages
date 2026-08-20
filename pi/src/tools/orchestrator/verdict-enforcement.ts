/**
 * verdict-enforcement.ts — GC-2026-058
 *
 * Machine-enforced gate: when `orchestrator_audit` returns REVISE or
 * REJECT, subsequent `task_dispatch` calls for the same DAG are
 * blocked until the LLM explicitly acknowledges the verdict.
 *
 * Before this GC, the LLM could ignore a REVISE verdict and proceed
 * with the next task_dispatch. The orchestrator_audit tool returned
 * its verdict, but the LLM had full agency to acknowledge and act on
 * it. This was a structural gap: the audit was informational, not
 * enforced.
 *
 * Mechanism:
 *   1. When audit completes, the verdict is recorded in a sidecar
 *      file `.pi/orchestrator/verdict-state-{dag_id}.yaml` (separate
 *      from `audit-state-{dag_id}.yaml` so audit state and verdict
 *      gate state stay decoupled).
 *   2. `task_dispatch` (or any orchestrator code path that wants to
 *      proceed) calls `checkVerdictGate(cwd, dagId)` before continuing.
 *      If the latest verdict is REVISE/REJECT and not acknowledged,
 *      the gate returns a structured error.
 *   3. The LLM acknowledges by either:
 *      a. Calling `acknowledgeVerdict(cwd, dagId, reason)` explicitly,
 *         OR
 *      b. Passing `acknowledge_verdict: true` (with a reason) to
 *         `task_dispatch` itself — the dispatcher calls the
 *         acknowledgement on the LLM's behalf.
 *
 * Acknowledgement is recorded in the same file with a timestamp and
 * reason. Subsequent reads see the acknowledgement and the gate
 * passes.
 *
 * Why a sidecar file and not in audit-state? Two reasons:
 *   - audit-state-* has a complex schema (lifecycle, findings, score)
 *     and is touched by every orchestrator_audit observation
 *   - verdict-state-* is the gate contract — it changes only at
 *     audit completion and acknowledgement. Decoupling makes the
 *     gate's invariants easier to reason about.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import * as yaml from "js-yaml";

export type Verdict = "PASS" | "REVISE" | "REJECT";

/** Single record — written to disk on every audit complete + acknowledgement. */
export interface VerdictRecord {
  dag_id: string;
  verdict: Verdict;
  score: number;
  /** Audit timestamp (ISO 8601). */
  audit_at: string;
  /** True when the LLM has acknowledged the verdict. */
  acknowledged: boolean;
  /** When acknowledged: the reason + timestamp. */
  acknowledged_at?: string;
  acknowledged_reason?: string;
}

const STATE_DIR = ".pi/orchestrator";

function verdictStatePath(cwd: string, dagId: string): string {
  return join(cwd, STATE_DIR, `verdict-state-${dagId}.yaml`);
}

function readState(cwd: string, dagId: string): VerdictRecord | null {
  const path = verdictStatePath(cwd, dagId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = yaml.load(raw) as VerdictRecord | null;
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeState(cwd: string, record: VerdictRecord): void {
  const path = verdictStatePath(cwd, record.dag_id);
  mkdirSync(dirname(path), { recursive: true });
  // Atomic write — temp file + rename, so partial writes don't corrupt
  // the gate state.
  const tmp = path + ".tmp";
  writeFileSync(tmp, yaml.dump(record, { indent: 2, lineWidth: 120 }), "utf-8");
  renameSync(tmp, path);
}

/**
 * Record a verdict. Called by orchestrator_audit on `complete` observation.
 * Replaces any prior record (most recent verdict wins).
 *
 * If the verdict is PASS, the record is still written — it provides
 * a positive signal that the audit was run. But the gate is open.
 */
export function recordVerdict(
  cwd: string,
  dagId: string,
  verdict: Verdict,
  score: number,
): VerdictRecord {
  if (!["PASS", "REVISE", "REJECT"].includes(verdict)) {
    throw new Error(`unknown verdict: ${verdict}`);
  }
  const record: VerdictRecord = {
    dag_id: dagId,
    verdict,
    score,
    audit_at: new Date().toISOString(),
    acknowledged: verdict === "PASS", // PASS is auto-acknowledged
  };
  writeState(cwd, record);
  return record;
}

/**
 * Mark the latest verdict as acknowledged. Called explicitly by the
 * LLM (via sages_reminder flow) or implicitly by task_dispatch
 * when `acknowledge_verdict: true` is set.
 */
export function acknowledgeVerdict(
  cwd: string,
  dagId: string,
  reason: string,
): VerdictRecord | null {
  const current = readState(cwd, dagId);
  if (!current) return null;
  if (current.acknowledged) return current;
  const updated: VerdictRecord = {
    ...current,
    acknowledged: true,
    acknowledged_at: new Date().toISOString(),
    acknowledged_reason: reason,
  };
  writeState(cwd, updated);
  return updated;
}

export interface VerdictGateResult {
  /** True if the gate is open (no REVISE/REJECT pending). */
  open: boolean;
  /** The latest verdict record, if any. */
  record: VerdictRecord | null;
  /** Why the gate is closed (when open=false). */
  reason?: string;
  /** When the gate is closed, the structured error message for the LLM. */
  errorMessage?: string;
}

/**
 * Check the verdict gate. Returns `{ open: true }` if the gate is
 * open (LLM may proceed) or `{ open: false, errorMessage }` if
 * blocked. The caller (e.g. task_dispatch) should treat `open=false`
 * as a hard error and surface `errorMessage` to the LLM.
 */
export function checkVerdictGate(cwd: string, dagId: string): VerdictGateResult {
  const current = readState(cwd, dagId);
  if (!current) {
    // No audit has run for this DAG — gate is open (nothing to enforce).
    return { open: true, record: null };
  }
  if (current.verdict === "PASS") {
    return { open: true, record: current };
  }
  // REVISE or REJECT
  if (current.acknowledged) {
    return { open: true, record: current };
  }
  return {
    open: false,
    record: current,
    reason: `latest audit verdict is ${current.verdict} and not yet acknowledged`,
    errorMessage:
      `[sages verdict gate] audit verdict for ${current.dag_id} is ${current.verdict} (score ${current.score}, audited at ${current.audit_at}); ` +
      "this DAG's task_dispatch is blocked until the verdict is acknowledged. " +
      "Either re-run orchestrator_audit to revise, or pass `acknowledge_verdict: { reason: '...' }` " +
      "to task_dispatch to proceed without re-running the audit.",
  };
}
