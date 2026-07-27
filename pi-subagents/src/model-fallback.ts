/**
 * model-fallback.ts — Agent dispatcher model-fallback policy.
 *
 * GC-2026-014 follow-up: when `resolveModel` returns an error string and
 * the input came from caller-supplied (`Agent({ model: "..." })`) params —
 * most commonly provider-specific fuzzy nicknames on a non-matching
 * registry — the dispatcher used to surface the raw error and abort the
 * spawn. That produced a noisy "Model not found: ..." result that blocked
 * every subsequent dispatch.
 *
 * The new policy is **warn + fall back** instead of error:
 *
 *   1. Settings.json default (when the registry has it) — preferred.
 *   2. The parent session's model — fallback when no settings default is
 *      available OR the registry doesn't have the settings default as a
 *      usable Model.
 *   3. undefined + no warning — when neither target exists, let the agent
 *      runner's standard inheritance kick in (no spinner, no toast).
 *
 * The dispatcher is a thin caller; this module owns the policy so the
 * behavior can be unit-tested without spinning up an Agent invocation.
 * The companion runtime read is in `settings-default-model.ts`; we
 * receive the already-parsed `{ provider, model } | undefined` to keep
 * this function synchronous and pure.
 *
 * Frontmatter-pinned unresolvable models are handled silently —
 * frontmatter is authoritative for the agent's identity (the user-installed
 * config wins over session defaults). Caller-supplied is the only path
 * that consults `settingsDefault`.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { SettingsDefaultModel } from "./settings-default-model.js";

/** Minimal registry interface — only `find` is exercised here. */
export interface ModelRegistryLite {
	find(provider: string, modelId: string): Model<any> | undefined;
}

/** Inputs to the fallback policy. */
export interface ResolveModelFallbackInputs {
	/** Result of `resolveModel(input, registry)` — a Model on hit, a string on miss. */
	resolved: Model<any> | string;
	/** The registry the resolver used. */
	registry: ModelRegistryLite;
	/** The parent session's model — the secondary fallback after settings. */
	parentModel: Model<any> | undefined;
	/** Settings.json default (already read via `getSettingsDefaultModel()`). */
	settingsDefault: SettingsDefaultModel | undefined;
	/**
	 * True when the model string came from caller-supplied `Agent({ model })`
	 * params; false when it came from the agent's frontmatter `model:` pin.
	 * Frontmatter pins are authoritative — they never trigger a warning.
	 */
	modelFromParams: boolean;
}

/** Where the chosen fallback came from, for the dispatcher's warning text. */
export type FallbackKind = "settings" | "parent" | "none";

/** The dispatcher's contract: spawn with this `model`, emit a warning iff `shouldWarn`. */
export interface ResolveModelFallbackDecision {
	/** Model to spawn with. `undefined` means "no override — let the agent runner inherit". */
	model: Model<any> | undefined;
	/** True iff the dispatcher should emit a `ctx.ui.notify(..., "warning")`. */
	shouldWarn: boolean;
	/** Diagnostic label so the dispatcher can word the warning precisely. */
	fallbackKind: FallbackKind;
}

/**
 * Resolve the Agent dispatcher's model-fallback policy.
 *
 * Decision matrix:
 *
 * | resolved | modelFromParams | result                                     |
 * |----------|-----------------|--------------------------------------------|
 * | Model    | any             | model = resolved, shouldWarn = false       |
 * | string   | true            | settings default → parent → undefined (warn on first two) |
 * | string   | false           | parent (silent) or undefined (silent)      |
 */
export function resolveDispatcherModelFallback(
	inputs: ResolveModelFallbackInputs,
): ResolveModelFallbackDecision {
	// Success path: resolver returned a usable Model — use it directly.
	if (typeof inputs.resolved !== "string") {
		return {
			model: inputs.resolved,
			shouldWarn: false,
			fallbackKind: "none",
		};
	}

	// Resolver returned an error string. Caller-supplied (LLM / orchestrator
	// made an explicit choice) → warn + fall back through settings → parent.
	// Frontmatter-pinned (agent author / installer made the choice) → silent
	// fallback to parent. The "fallbackKind: settings" case is the only one
	// where the user's operator-configured default overrides the live session
	// model — that's by design (the LLM got it wrong; the operator didn't).
	if (!inputs.modelFromParams) {
		return {
			model: inputs.parentModel,
			shouldWarn: false,
			fallbackKind: inputs.parentModel ? "parent" : "none",
		};
	}

	if (inputs.settingsDefault) {
		const fromRegistry = inputs.registry.find(
			inputs.settingsDefault.provider,
			inputs.settingsDefault.model,
		);
		if (fromRegistry) {
			return {
				model: fromRegistry,
				shouldWarn: true,
				fallbackKind: "settings",
			};
		}
		// Settings default is configured but the registry doesn't have it as
		// a usable Model (e.g. the provider isn't loaded). Fall through to
		// the parent — it's at least the live session's choice.
	}

	if (inputs.parentModel) {
		return {
			model: inputs.parentModel,
			shouldWarn: true,
			fallbackKind: "parent",
		};
	}

	// No target anywhere. Silent return — the agent runner will fall through
	// to its standard inheritance (resolveDefaultModel). A warning here would
	// generate a toast for every dispatch when the user has nothing
	// configured, which is too noisy.
	return {
		model: undefined,
		shouldWarn: false,
		fallbackKind: "none",
	};
}
