/**
 * subagent-info.ts — Public surface that other pi extensions (notably
 * `sages/pi` orchestrator) consume to learn which subagents are
 * registered. Single source of truth lives in `default-agents.ts`; this
 * file is a thin re-export so external callers don't need to import the
 * full default-agents module (which pulls all six prompts).
 *
 * Why this exists:
 *   - The orchestrator (sages/pi) used to maintain its own
 *     `subagents/registry.yaml` duplicating agent metadata. Removed in
 *     favor of importing from pi-subagents (this file) so the canonical
 *     AgentConfig is the only place a new subagent needs to be added.
 *   - The orchestrator's `dag_synthesize` validator warns when a task's
 *     `subagent_type` is not in the registered set. The orchestrator's
 *     `defaultRunInBackground(subagentType)` looks up the canonical
 *     AgentConfig to choose between foreground and background.
 *
 * Adding a new subagent:
 *   1. Add an entry to `DEFAULT_AGENTS` in `default-agents.ts` (with a
 *      corresponding prompt under `agent-prompts/`).
 *   2. That's it — `KNOWN_SUBAGENT_IDS` is derived at module load.
 *   No update needed in sages/pi or any other consumer.
 */

import { DEFAULT_AGENTS } from "./default-agents.js";

/**
 * All subagent IDs registered by pi-subagents at module load.
 * Frozen array — consumers should treat as readonly.
 */
export const KNOWN_SUBAGENT_IDS: readonly string[] = Object.freeze(
	Array.from(DEFAULT_AGENTS.keys()).sort(),
);

/**
 * Look up the default `runInBackground` flag for a registered subagent.
 * Returns `true` (background) for unknown subagents — this is the
 * conservative default (background is safer for the orchestrator: it
 * doesn't block the LLM turn). The LLM can override per-task by
 * setting `run_in_background: false` on the task node.
 *
 * Mirrors the value stored on the canonical `AgentConfig` in
 * `default-agents.ts`. If the AgentConfig is undefined for an unknown
 * ID (e.g. user-added `.md` file that pi-subagents didn't ship), this
 * still returns `true` — same conservative default.
 */
export function defaultRunInBackground(subagentType: string): boolean {
	const entry = DEFAULT_AGENTS.get(subagentType);
	if (entry?.runInBackground !== undefined) return entry.runInBackground;
	return true;
}