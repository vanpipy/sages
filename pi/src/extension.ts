/**
 * Sages pi extension — the runtime entrypoint loaded by pi when it
 * resolves the @sages/pi package.
 *
 * The conductor (`@sages/pi`) is a thin profile-driven layer. The actual
 * orchestrator machinery (4-stage DAG workflow, L1 advisory, bash
 * classification, file-gate, observability, project analyzer) lives in
 * the sibling `@sages/pi-orchestrator` package.
 *
 * Conductor responsibilities:
 *   1. Load the active profile once at module load (`loadProfile()`).
 *   2. Apply the profile via three pi hooks in `applyProfile`:
 *      - `installCapabilityFilter` — block tools not in profile.tools
 *      - `installPromptComposer`   — prepend profile-driven system prompt
 *      - `installReminderInjector` — fire soft-mode reminder once on first bash
 *   3. Delegate to the orchestrator package: `registerOrchestratorTools(pi, runtimeDeps)`
 *      registers the 5 orchestrator tools + installs the L1 advisory
 *      pipeline. The runtime deps pass through the cwd-aware goal/dag
 *      loaders the orchestrator needs for its detectors.
 *
 * Soft mode (GC-2026-031) — the main agent has full tool access
 * (`edit`, `write`, `aft_edit`, `apply_patch`, unrestricted `bash`).
 * Nothing is stripped on `session_start` and no bash command is
 * blocked at the `tool_call` layer. The 4-stage DAG workflow is
 * RECOMMENDED for workflows whose todowrite item count exceeds
 * the active profile's `dag_threshold`; the agent decides whether
 * to dispatch. Drift is auto-steered via a one-shot
 * `pi.appendEntry("system", ...)` reminder — never blocked.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
	registerOrchestratorTools,
	loadGoalContract,
	loadPlan,
	type L1AdvisoryRuntimeDeps,
} from "../../pi-orchestrator/src/index.js";
import { loadProfile } from "./profile/loader.js";
import { applyProfile } from "./profile/applier.js";

// Load the active profile once at module load. Resolution order is
// documented in `profile.ts`; falls back to the `standard` built-in
// when no user override is present.
const PROFILE = loadProfile();

/**
 * Apply the profile's three pi hooks (capability filter + prompt
 * composer + reminder injector). The conductor does NOT register
 * orchestrator tools, write state, or install files — it only
 * configures how the LLM interacts with the existing tool surface
 * + system prompt.
 */
export function registerConductorOnly(pi: ExtensionAPI): void {
	const profile = loadProfile();
	applyProfile(pi, profile);
}

/**
 * Build the runtime deps the orchestrator's L1 advisory handler needs
 * to enrich its decisions. The orchestrator's no-op defaults return
 * `null` for goal/dag lookups; the conductor wires the real loaders
 * (which know how to read goal / plan YAML from disk).
 */
function buildL1RuntimeDeps(): L1AdvisoryRuntimeDeps {
	return {
		loadGoalScope: (goalId: string, cwd: string) => {
			const goal = loadGoalContract(cwd, goalId);
			if (!goal) return null;
			return {
				goal_id: goal.id,
				scope_include: goal.scope?.include ?? [],
				scope_exclude: goal.scope?.exclude ?? [],
			};
		},
		loadDagPlan: (dagId: string, cwd: string) => {
			const plan = loadPlan(cwd, dagId);
			if (!plan) return null;
			return {
				tasks: plan.tasks.map((t) => ({
					id: t.id,
					status: t.status,
					depends_on: t.depends_on ?? [],
				})),
			};
		},
	};
}

/**
 * Default pi extension entrypoint. pi calls this once on package load.
 */
export default function registerSagesExtension(pi: ExtensionAPI): void {
	registerConductorOnly(pi);
	registerOrchestratorTools(pi, buildL1RuntimeDeps());
}

// Exported for tests that want to assert which profile the extension
// booted under. Production code should treat PROFILE as immutable.
export { PROFILE };
