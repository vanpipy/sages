/**
 * Background callgraph pre-warming + awaited warmup for wrap tools.
 *
 * Two related but distinct entrypoints:
 *
 *   - `warmupCallgraph(projectRoot)` — fire-and-forget. Used at session start
 *     so the callgraph build starts immediately; wrap/find-references.ts
 *     doesn't have to wait 30s when the LLM first asks "where is this
 *     symbol used?". Errors are logged but never thrown.
 *
 *   - `ensureReady(projectRoot)` — AWAITED. Used by wrap tools before their
 *     first request so AFT is guaranteed to be `configure`d for the current
 *     project_root. Single-flight (concurrent callers share one promise),
 *     idempotent (ready=true short-circuits subsequent calls), and resets
 *     state on failure so the next call retries.
 *
 * Errors are logged but never thrown — warmup failures shouldn't break
 * the agent's startup.
 */

import { ensureConfigured } from "./project.js";

/** Active warmup promises, keyed by projectRoot. */
const warmupsInFlight = new Map<string, Promise<void>>();

/** Per-project ready flag: true once configure has succeeded. */
const ready = new Map<string, boolean>();

/** Per-project in-flight ensureReady promise (single-flight). */
const ensureInFlight = new Map<string, Promise<void>>();

export function warmupCallgraph(projectRoot: string): Promise<void> {
	const existing = warmupsInFlight.get(projectRoot);
	if (existing) return existing;

	const p = (async () => {
		try {
			await ensureConfigured(projectRoot);
			// Bridge.sendStatusChanged events will tell us when the callgraph is ready
		} catch (err) {
			// Don't propagate — warmup failures aren't fatal
			console.warn(`[AFT/warmup] ${projectRoot}: ${(err as Error).message}`);
		}
	})();

	warmupsInFlight.set(projectRoot, p);
	return p;
}

/**
 * Awaits AFT readiness for the given project root. Idempotent and
 * single-flight: the first call performs `ensureConfigured`; concurrent
 * callers share the same in-flight promise; subsequent calls return
 * immediately when ready=true.
 *
 * On failure: the ready flag is cleared so the next call retries from
 * scratch. The error propagates to the caller — wrap tools should surface
 * it as `{isError:true, content:[…]}` rather than letting it crash the
 * tool pipeline.
 */
export async function ensureReady(projectRoot: string): Promise<void> {
	if (ready.get(projectRoot) === true) return;

	const inflight = ensureInFlight.get(projectRoot);
	if (inflight) return inflight;

	const p = (async () => {
		try {
			await ensureConfigured(projectRoot);
			ready.set(projectRoot, true);
		} catch (err) {
			// Clear ready flag so the next call retries; re-throw so the
			// caller knows AFT is not usable right now.
			ready.delete(projectRoot);
			throw err;
		} finally {
			ensureInFlight.delete(projectRoot);
		}
	})();

	ensureInFlight.set(projectRoot, p);
	return p;
}

/** For tests: wait for any in-flight warmups to complete. */
export async function __waitForWarmups(): Promise<void> {
	await Promise.all([
		...Array.from(warmupsInFlight.values()),
		...Array.from(ensureInFlight.values()),
	]);
}

/** Test-only: clear warmup state. */
export function __clearWarmups(): void {
	warmupsInFlight.clear();
}

/** Test-only: clear ensureReady state (ready flags + in-flight promises). */
export function __resetReadyState(): void {
	ready.clear();
	ensureInFlight.clear();
}
