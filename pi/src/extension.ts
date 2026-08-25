/**
 * Sages pi extension — the runtime entrypoint loaded by pi when it
 * resolves the @sages/pi package.
 *
 * The conductor (`@sages/pi`) is a thin profile-driven layer. The actual
 * orchestrator machinery (4-stage DAG workflow, Orchestrator advisory, bash
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
 *      registers the 5 orchestrator tools + installs the Orchestrator advisory
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

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

import {
	registerOrchestratorTools,
	loadGoalContract,
	loadPlan,
	type OrchestratorAdvisoryRuntimeDeps,
} from "../../pi-orchestrator/src/index.js";
import { loadProfile } from "./profile/loader.js";
import { applyProfile } from "./profile/applier.js";

/**
 * `@sages/pi-orchestrator` is a peer dep of `@sages/pi`
 * (see `pi/package.json#peerDependencies`). The relative-path import
 * above assumes the orchestrator package sits as a sibling under the
 * same parent directory — `pi/` and `pi-orchestrator/` in dev,
 * `~/.pi/packages/<conductor>/` and `~/.pi/packages/pi-orchestrator/`
 * in production installs done by
 * `pi/scripts/install.sh:install_pi_orchestrator_files`.
 *
 * When the sibling layout is broken (user installed the conductor
 * without the orchestrator, or moved one to a different parent), the
 * relative-path import throws a generic `Cannot find module`. This
 * pre-load check walks parents up to 5 levels looking for a sibling
 * `pi-orchestrator/src/` so the user gets an actionable error pointing
 * at the actual contract instead of an ESM-resolution dead-end.
 *
 * Bun loads TS directly (.ts) but a built install serves .js — accept
 * either.
 */
function assertOrchestratorSiblingPresent(): void {
	const here = dirname(fileURLToPath(import.meta.url));
	let dir = here;
	for (let depth = 0; depth < 5; depth++) {
		const srcDir = join(dir, "pi-orchestrator", "src");
		if (
			existsSync(join(srcDir, "index.ts")) ||
			existsSync(join(srcDir, "index.js"))
		) {
			return;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// Note: this fires only when the relative-path import above has
	// already resolved via a non-standard layout — e.g., node_modules
	// resolution or a workspace symlink. In the canonical dev/install
	// case the ESM import either succeeded (this check passes) or
	// failed at the import site above with the standard ESM error.
	throw new Error(
		"[sages] @sages/pi-orchestrator not found as a sibling of @sages/pi.\n" +
			"  The conductor (this package) requires @sages/pi-orchestrator as a\n" +
			"  peer dep — both packages must share a parent directory:\n" +
			"    - dev:           <repo>/pi/  +  <repo>/pi-orchestrator/\n" +
			"    - production:    ~/.pi/packages/<conductor>/  +  ~/.pi/packages/pi-orchestrator/\n" +
			"  Re-run `pi/scripts/install.sh` to deploy them together.",
	);
}

assertOrchestratorSiblingPresent();

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
 * Build the runtime deps the orchestrator's Orchestrator advisory handler needs
 * to enrich its decisions. The orchestrator's no-op defaults return
 * `null` for goal/dag lookups; the conductor wires the real loaders
 * (which know how to read goal / plan YAML from disk).
 */
function buildOrchestratorAdvisoryRuntimeDeps(): OrchestratorAdvisoryRuntimeDeps {
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
	registerOrchestratorTools(pi, buildOrchestratorAdvisoryRuntimeDeps());
}

// Exported for tests that want to assert which profile the extension
// booted under. Production code should treat PROFILE as immutable.
export { PROFILE };
