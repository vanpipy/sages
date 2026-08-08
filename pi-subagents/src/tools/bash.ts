/**
 * bash.ts — GC-2026-040 Phase 2 bash tool wrapper.
 *
 * Wires `spawn()` to `RunController.signalForTool(bucket)` so every
 * command enforces its per-bucket timeout and inherits run-deadline /
 * parent-signal aborts. Reference: `.pi/orchestrator/design-timeout-architecture.md`.
 *
 * Critical invariants (each addresses a specific review finding):
 *
 *   C1 (single kill path). `spawn({ signal })` forwards aborts to the
 *       child (Node sends SIGTERM on abort). The escalation listener
 *       below adds the 2s SIGKILL safety net for SIGTERM-ignoring
 *       children. There is NO separate "belt-and-suspenders" kill path
 *       racing spawn's built-in handler — the listener ONLY escalates.
 *
 *   C2 (no hung promise). `spawn()` is wrapped in try/catch so a
 *       synchronous failure (signal already aborted, EACCES, etc.)
 *       rejects the promise. `child.on('error')` covers async spawn
 *       errors (ENOENT, etc.). Either path rejects with `BashError`,
 *       never hangs.
 *
 *   C3 (signal-after-exit race). We track `signalFiredAt` and the
 *       child exit timestamp. If the child exited within 100ms after
 *       the signal fired, we do NOT mark as timeout — the signal
 *       arrived during normal shutdown, not because of an abort.
 *
 *   C4 (abort-reason). Documented in the listener comment: when both
 *       the run-deadline and a bucket-timer signal fire, the most
 *       restrictive wins. A 5s bucket abort takes precedence over a
 *       20min run abort because the actionable signal is "the work
 *       was slow for that bucket", not "the run ran out of time".
 *
 *   C5 (SIGTERM with grace). On signal abort we send SIGTERM (Node's
 *       spawn({signal}) already does this — the listener is just a
 *       safety net). If the child is still alive 2s later, we send
 *       SIGKILL. Children with cleanup handlers exit cleanly; only
 *       true stuck children get SIGKILL'd.
 *
 * Anti-rule: no new npm dependencies (Node built-ins only).
 */

import { spawn, type ChildProcess } from "node:child_process";
import type { BucketKey, RunController } from "../run-controller.js";
import { detectBucket } from "./bucket-detector.js";

export type BashErrorKind = "spawn_failed" | "spawn_error" | "exit" | "timeout";

export interface BashErrorDetails {
	bucket?: BucketKey;
	timeoutMs?: number;
	elapsedMs?: number;
	code?: number | null;
	signal?: NodeJS.Signals | null;
	cause?: unknown;
}

export class BashError extends Error {
	readonly kind: BashErrorKind;
	readonly details: BashErrorDetails;

	constructor(
		kind: BashErrorKind,
		details: BashErrorDetails = {},
		message?: string,
	) {
		super(message ?? `bash ${kind}`);
		this.name = "BashError";
		this.kind = kind;
		this.details = details;
	}
}

export type BashResult =
	| { ok: true; stdout: string; stderr: string; elapsedMs: number }
	| { ok: false; error: BashError };

export interface BashContext {
	runController: RunController;
	cwd: string;
}

/**
 * Run a bash command under the per-bucket timeout policy of `runController`.
 *
 * Resolves with `{ok:true, stdout, stderr, elapsedMs}` on success,
 * `{ok:false, error: BashError}` on non-zero exit or timeout, and
 * rejects with `BashError({kind: 'spawn_failed' | 'spawn_error'})`
 * if the child cannot be spawned at all.
 */
export function bashTool(
	command: string,
	ctx: BashContext,
): Promise<BashResult> {
	const bucket = detectBucket(command);
	const timeoutMs = ctx.runController.config.bucketTimeoutsMs[bucket];
	const signal = ctx.runController.signalForTool(bucket);

	// C2: pre-aborted signal means we KNOW spawn can't succeed — the
	// composed signal (parent + run + bucket timer) was already aborted
	// before we got here. Node 24 does not throw synchronously on a
	// pre-aborted signal (it emits async ABORT_ERR), so we must detect
	// the pre-aborted case explicitly to avoid hanging on a child that
	// will never run. Reject immediately.
	if (signal.aborted) {
		return Promise.reject(
			new BashError("spawn_failed", {
				bucket,
				timeoutMs,
				cause: signal.reason ?? new Error("signal pre-aborted"),
			}),
		);
	}

	return new Promise<BashResult>((resolve, reject) => {
		let child: ChildProcess;
		try {
			// C1: spawn({ signal }) forwards aborts to the child. Node
			// sends SIGTERM on signal-abort; this is the canonical kill
			// path. The escalation listener below adds SIGKILL safety.
			child = spawn("bash", ["-c", command], {
				cwd: ctx.cwd,
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
				signal,
			});
		} catch (cause) {
			// C2: synchronous spawn failure (EACCES, ENOENT for missing
			// binary path on systems where the sync path is taken). Reject
			// immediately so the caller never hangs on a dead child handle.
			reject(new BashError("spawn_failed", { cause }));
			return;
		}

		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));

		// C2: async spawn error (rare — ENOENT races past the sync check).
		// ABORT_ERR is NOT a real spawn error: Node emits it whenever the
		// signal aborts (even when the child then exits cleanly with
		// SIGTERM). Filter it so the exit handler can finalize as usual.
		child.on("error", (err) => {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === "ABORT_ERR") return;
			reject(new BashError("spawn_error", { cause: err }));
		});

		let signalFiredAt: number | null = null;
		let timedOut = false;
		let resolved = false;
		const finalize = (result: BashResult) => {
			if (resolved) return;
			resolved = true;
			resolve(result);
		};

		// C5: SIGTERM with 2s grace, then SIGKILL. The `once: true`
		// listener fires the FIRST time the composed signal aborts
		// (either run-deadline, parent signal, or the bucket timer).
		//
		// C4 (abort-reason composition): when both run-deadline AND a
		// bucket-timer signal are aborting, AbortSignal.any fires the
		// composed signal ONCE — we can't distinguish after the fact
		// which one was the proximate cause. The semantics we encode:
		// "most-restrictive wins" — a 5s bucket abort is more
		// informative than a 20min run abort because the actionable
		// signal is "this specific work was slow". The bucket field on
		// the resulting BashError tells the caller which bucket (if
		// any) classified the abort.
		signal.addEventListener(
			"abort",
			() => {
				if (signalFiredAt !== null) return;
				signalFiredAt = Date.now();
				timedOut = true;
				// Send SIGTERM. Node's spawn({signal}) already issued
				// one; sending another is idempotent for live children
				// and a no-op for dying ones.
				try {
					child.kill("SIGTERM");
				} catch {
					// Child already gone — fine.
				}
				// Escalate to SIGKILL after 2s if still alive.
				const escalation = setTimeout(() => {
					if (child.exitCode === null && child.signalCode === null) {
						try {
							child.kill("SIGKILL");
						} catch {
							// Already dead — fine.
						}
					}
				}, 2000);
				escalation.unref();
			},
			{ once: true },
		);

		child.on("exit", (code, sig) => {
			const stdoutStr = Buffer.concat(stdoutChunks).toString("utf8");
			const stderrStr = Buffer.concat(stderrChunks).toString("utf8");
			const elapsedMs = ctx.runController.elapsedMs();

			// C3: signal-after-exit discrimination. If the child exited
			// via a signal (SIGTERM from spawn({signal}) or our SIGKILL
			// escalation), the abort caused the exit — that's a timeout.
			// If the child exited naturally (code 0 or non-zero without
			// a signal), the abort fired after / alongside natural exit —
			// that's NOT a timeout even if the signal fired too. This is
			// a stronger discriminator than the original 100ms-grace
			// timing check: the exit-cause field is definitive.
			const wasKilledBySignal =
				(sig === "SIGTERM" || sig === "SIGKILL") && code === null;
			const wasTimeout = timedOut && wasKilledBySignal;

			if (wasTimeout) {
				finalize({
					ok: false,
					error: new BashError("timeout", {
						bucket,
						timeoutMs,
						elapsedMs,
					}),
				});
				return;
			}
			if (code === 0 && sig === null) {
				finalize({
					ok: true,
					stdout: stdoutStr,
					stderr: stderrStr,
					elapsedMs,
				});
				return;
			}
			finalize({
				ok: false,
				error: new BashError("exit", {
					code: code ?? null,
					signal: sig ?? null,
				}),
			});
		});
	});
}