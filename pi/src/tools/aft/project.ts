/**
 * Per-session AFT project lifecycle.
 *
 * Sends `configure` once per (project_root, session_id) tuple; caches the
 * session_id so subsequent bridge calls can be authenticated.
 */

import { bridgeFor } from "./bridge.js";
import type { AftSessionState } from "./types.js";

const sessionState = new Map<string, AftSessionState>();

function key(projectRoot: string): string {
	return projectRoot;
}

/**
 * Configure AFT for this project. Idempotent — calling twice with the same root
 * returns the cached session_id without sending another `configure`.
 *
 * The `harness` is always `"pi"` because this binary runs in pi extensions.
 */
export async function ensureConfigured(projectRoot: string): Promise<AftSessionState> {
	const k = key(projectRoot);
	const cached = sessionState.get(k);
	if (cached) return cached;

	const bridge = bridgeFor();
	const result = await bridge.call({
		id: `cfg-${Date.now()}`,
		command: "configure",
		harness: "pi",
		project_root: projectRoot,
	});

	if (!result.success) {
		// Already-configured is fine (returns success with warnings)
		throw new Error(`AFT configure failed: ${result.code} ${result.message}`);
	}

	const state: AftSessionState = {
		session_id: String(result.session_id ?? `sess-${Date.now()}`),
		project_root: projectRoot,
		configure_warnings: [],
	};
	sessionState.set(k, state);
	return state;
}

/** Test-only: clear the session state cache. */
export function __clearSessionCache(): void {
	sessionState.clear();
}
