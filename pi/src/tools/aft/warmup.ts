/**
 * Background callgraph pre-warming.
 *
 * On session_start, fire-and-forget a `configure` call so the callgraph
 * build starts immediately. wrap/find-references.ts then doesn't have to
 * wait 30s when the LLM first asks "where is this symbol used?".
 *
 * Errors are logged but never thrown — warmup failures shouldn't break
 * the agent's startup.
 */

import { ensureConfigured } from "./project.js";

/** Active warmup promises, keyed by projectRoot. */
const warmupsInFlight = new Map<string, Promise<void>>();

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

/** For tests: wait for any in-flight warmups to complete. */
export async function __waitForWarmups(): Promise<void> {
	await Promise.all(Array.from(warmupsInFlight.values()));
}

/** Test-only: clear warmup state. */
export function __clearWarmups(): void {
	warmupsInFlight.clear();
}
